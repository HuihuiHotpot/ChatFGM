import { createHash } from 'node:crypto';
import type {
  ProjectAvailability,
  ProjectSnapshot,
  ProjectTreeUpdate,
  ProjectTreeUpdateListener,
} from '../ipc/capabilities';
import type { Logger } from '../platform/log';
import type { ProjectService } from '../projects/service';

export interface ProjectSyncFailure {
  projectId: string;
  message: string;
}

export type ProjectSyncFailureListener = (failure: ProjectSyncFailure) => void;

interface SyncWaiter {
  /** Request sequence that this waiter needs a scan for. */
  target: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SyncState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  dirty: boolean;
  waiters: SyncWaiter[];
  lastTreeHash: string;
  lastFailure: string | null;
  /** Monotonic finalize request sequence. */
  requestSequence: number;
}

const COALESCE_MS = 700;

function treeHash(tree: ProjectSnapshot['tree']): string {
  return createHash('sha256').update(JSON.stringify(tree)).digest('hex');
}

function failureError(projectId: string, message: string): Error {
  return new Error(`项目「${projectId}」最终文件同步失败：${message}`);
}

/**
 * Coalesces Agent-caused disk changes into one project rescan. There is at most
 * one scan per project and at most one scheduled follow-up; repeated output
 * cannot build a request backlog. A finalize waiter is tied to the scan
 * request sequence and is never settled by a scan that started before its
 * request. A failed scan rejects the waiters that depended on it.
 */
export class ProjectFileSyncService {
  private readonly states = new Map<string, SyncState>();
  private readonly listeners = new Set<ProjectTreeUpdateListener>();
  private readonly failureListeners = new Set<ProjectSyncFailureListener>();
  private disposed = false;

  constructor(
    private readonly projectService: ProjectService,
    private readonly logger: Logger,
  ) {}

  subscribe(listener: ProjectTreeUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Background failures are visible; they are not silently swallowed. */
  subscribeFailures(listener: ProjectSyncFailureListener): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  /** Schedules a bounded, coalesced rescan for a project. */
  schedule(projectId: string): void {
    if (this.disposed || !projectId) return;
    if (!this.projectService.isProjectCurrent(projectId)) return;
    if (this.isDirectoryMissing(projectId)) return;
    const state = this.state(projectId);
    if (state.running) {
      state.dirty = true;
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.run(projectId).catch(() => undefined);
    }, COALESCE_MS);
    state.timer.unref?.();
  }

  /**
   * Requests a final scan after a run ended. The returned promise settles only
   * after a scan that started at or after this request has completed (or
   * failed). A scan already in flight cannot satisfy a later request; a
   * follow-up is required.
   */
  finalize(projectId: string): Promise<void> {
    if (this.disposed || !projectId) {
      return Promise.reject(
        new Error('文件同步服务已停止，无法完成最终核对。'),
      );
    }
    // A retired identity has no disk tree to flush. Never recreate its scan
    // state or inspect the path now owned by another project.
    if (!this.projectService.isProjectCurrent(projectId)) {
      this.forgetProject(projectId);
      return Promise.resolve();
    }
    const availability = this.readAvailability(projectId);
    if (availability?.directoryState === 'missing') {
      // The registered project lost its directory. There is nothing to flush,
      // and repeating the path error would bury the close/retry controls.
      this.forgetProject(projectId);
      return Promise.resolve();
    }
    if (availability?.directoryState === 'unreadable') {
      return Promise.reject(
        failureError(
          projectId,
          availability.message ?? '项目目录暂时无法读取，请稍后重试。',
        ),
      );
    }
    const state = this.state(projectId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const target = ++state.requestSequence;
    const promise = new Promise<void>((resolve, reject) => {
      state.waiters.push({ target, resolve, reject });
    });
    if (state.running) {
      state.dirty = true;
    } else {
      void this.run(projectId).catch(() => undefined);
    }
    return promise;
  }

  async flushAll(): Promise<void> {
    const ids = [...this.states.keys()];
    const results = await Promise.allSettled(
      ids.map((id) => this.finalize(id)),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }

  forgetProject(projectId: string): void {
    const state = this.states.get(projectId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    for (const waiter of state.waiters.splice(0)) waiter.resolve();
    this.states.delete(projectId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      const waiters = state.waiters.splice(0);
      const error = new Error('文件同步服务已停止，最终同步未完成。');
      for (const waiter of waiters) waiter.reject(error);
    }
    this.states.clear();
    this.listeners.clear();
    this.failureListeners.clear();
  }

  private state(projectId: string): SyncState {
    let state = this.states.get(projectId);
    if (!state) {
      state = {
        timer: null,
        running: false,
        dirty: false,
        waiters: [],
        lastTreeHash: '',
        lastFailure: null,
        requestSequence: 0,
      };
      this.states.set(projectId, state);
    }
    return state;
  }

  /** Missing is distinguishable from temporarily unreadable; only the former
   * means "there is no disk state left to synchronize". */
  private isDirectoryMissing(projectId: string): boolean {
    return this.readAvailability(projectId)?.directoryState === 'missing';
  }

  private readAvailability(projectId: string): ProjectAvailability | null {
    try {
      return this.projectService.getProjectAvailability(projectId);
    } catch {
      return null;
    }
  }

  private notifyFailure(projectId: string, message: string): void {
    for (const listener of [...this.failureListeners]) {
      try {
        listener({ projectId, message });
      } catch (error) {
        this.logger.warn('project-file-sync-failure-listener-failed', {
          message:
            error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      }
    }
  }

  private settleWaiters(
    state: SyncState,
    scanStartedAt: number,
    failure: Error | null,
  ): void {
    const remaining: SyncWaiter[] = [];
    for (const waiter of state.waiters) {
      // A request made while this scan was already in flight requires the next
      // scan, even if this scan happened to observe the same disk state.
      if (waiter.target > scanStartedAt) {
        remaining.push(waiter);
        continue;
      }
      if (failure) waiter.reject(failure);
      else waiter.resolve();
    }
    state.waiters = remaining;
  }

  private async run(projectId: string): Promise<void> {
    const state = this.state(projectId);
    if (state.running) {
      state.dirty = true;
      return;
    }
    state.running = true;
    state.dirty = false;
    const scanStartedAt = state.requestSequence;
    let failure: Error | null = null;
    try {
      const availability = this.readAvailability(projectId);
      if (availability?.directoryState === 'missing') {
        // Nothing on disk to scan. Waiters resolve below; no failure notice is
        // emitted for a directory that is gone for good.
        return;
      }
      if (availability?.directoryState === 'unreadable') {
        throw new Error(
          availability.message ?? '项目目录暂时无法读取，请稍后重试。',
        );
      }
      const result = await this.projectService.rescanProject(projectId);
      if (this.states.get(projectId) !== state || !this.projectService.isProjectCurrent(projectId)) return;
      const hash = treeHash(result.snapshot.tree);
      // The first scan establishes the baseline and is also published so a
      // caller that missed the open snapshot can reconcile once.
      const treeChanged =
        state.lastTreeHash === '' || state.lastTreeHash !== hash;
      state.lastTreeHash = hash;
      state.lastFailure = null;
      if (
        treeChanged ||
        result.changedFileIdentities.length > 0 ||
        result.deletedFileIdentities.length > 0
      ) {
        const update: ProjectTreeUpdate = {
          projectId,
          revision: result.revision,
          tree: result.snapshot.tree,
          changedFileIdentities: [...result.changedFileIdentities],
          deletedFileIdentities: [...result.deletedFileIdentities],
        };
        for (const listener of [...this.listeners]) {
          try {
            listener(update);
          } catch (error) {
            this.logger.warn('project-file-sync-listener-failed', {
              message:
                error instanceof Error ? error.message.slice(0, 200) : 'unknown',
            });
          }
        }
      }
    } catch (error) {
      if (this.states.get(projectId) !== state || !this.projectService.isProjectCurrent(projectId)) return;
      const message =
        error instanceof Error ? error.message.slice(0, 500) : 'unknown';
      failure = failureError(projectId, message);
      state.lastFailure = failure.message;
      this.logger.warn('project-file-sync-failed', { message });
      this.notifyFailure(projectId, failure.message);
    } finally {
      state.running = false;
      this.settleWaiters(state, scanStartedAt, failure);
      const needFollowUp =
        !this.disposed && this.states.get(projectId) === state &&
        (state.waiters.length > 0 || state.dirty);
      state.dirty = false;
      if (needFollowUp) {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          void this.run(projectId).catch(() => undefined);
        }, 0);
        state.timer.unref?.();
      }
    }
  }
}
