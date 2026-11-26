import type {
  ProjectWorkspaceRecord,
  ProjectWorkspaceSnapshot,
  SaveWorkspaceLayoutInput,
  SaveWorkspaceResult,
  WorkspaceLayoutRecord,
} from '../ipc/workspace';
import type { Logger } from '../platform/log';
import type { ApplicationDatabase } from '../storage/database';
import { WorkspaceStore, WorkspaceStoreError } from './store';
import {
  parseLayoutSnapshot,
  parseLoadProjectInput,
  parseProjectWorkspace,
  parseRevision,
} from './validate';

export class WorkspaceService {
  private readonly store: WorkspaceStore;
  private readonly logger: Logger;
  private readonly projectQueues = new Map<string, Promise<unknown>>();
  private layoutQueue: Promise<unknown> = Promise.resolve();

  constructor(database: ApplicationDatabase, logger: Logger) {
    this.store = new WorkspaceStore(database);
    this.logger = logger;
  }

  loadLayout(): WorkspaceLayoutRecord {
    return this.store.loadLayout();
  }

  saveLayout(input: SaveWorkspaceLayoutInput): Promise<SaveWorkspaceResult> {
    const snapshot = parseLayoutSnapshot(input?.snapshot);
    const expectedRevision = parseRevision(
      input?.expectedRevision,
      'expectedRevision',
    );
    return this.enqueueLayout(async () => {
      const revision = this.store.saveLayout(snapshot, expectedRevision);
      return { revision };
    });
  }

  loadProjectWorkspace(projectId: string): ProjectWorkspaceRecord {
    return this.store.loadProject(parseLoadProjectInput({ projectId }));
  }

  saveProjectWorkspace(input: {
    projectId: string;
    snapshot: ProjectWorkspaceSnapshot;
    expectedRevision: number;
  }): Promise<SaveWorkspaceResult> {
    const projectId = parseLoadProjectInput(input);
    const snapshot = parseProjectWorkspace(input.snapshot);
    const expectedRevision = parseRevision(
      input.expectedRevision,
      'expectedRevision',
    );
    return this.enqueueProject(projectId, async () => {
      const revision = this.store.saveProject(
        projectId,
        snapshot,
        expectedRevision,
      );
      return { revision };
    });
  }

  logFailure(operation: string, error: unknown): void {
    if (error instanceof WorkspaceStoreError) {
      this.logger.warn('workspace-operation-failed', {
        operation,
        code: error.code,
      });
      return;
    }
    this.logger.error('workspace-operation-failed', {
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private enqueueProject<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.projectQueues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.projectQueues.set(projectId, next.catch(() => undefined));
    return next;
  }

  private enqueueLayout<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.layoutQueue.catch(() => undefined).then(operation);
    this.layoutQueue = next.catch(() => undefined);
    return next;
  }
}
