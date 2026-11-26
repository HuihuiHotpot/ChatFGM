import {
  clipboard,
  dialog,
  shell,
  type BrowserWindow,
  type OpenDialogOptions,
} from 'electron';
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import type {
  BindProjectToolboxInput,
  CreateProjectInput,
  DeleteEntryInput,
  FileChange,
  FileTreeEntry,
  FolderSelection,
  OpenProjectInput,
  PasteEntryInput,
  ProjectAvailability,
  ProjectSnapshot,
  ReadFileInput,
  ReadFileResult,
  RenameEntryInput,
  ResolveProjectFileLinkInput,
  RevealPathInput,
  SaveFileAsInput,
  SaveFileAsResult,
  SaveFileInput,
  SaveFileResult,
  ToolboxOption,
  TreeEntryInput,
  TreeMutationResult,
} from '../ipc/capabilities';
import type { RecentProject } from '../ipc/project-types';
import { PROJECT_PATH_HAN_ERROR, projectPathContainsHan } from '../ipc/project-creation-path';
import type { Logger } from '../platform/log';
import type { ApplicationDatabase } from '../storage/database';
import {
  scanToolboxes,
  ToolboxError,
  type LoadedToolbox,
  type ToolboxDefinition,
} from '../toolboxes/registry';
import { ToolboxCatalog } from '../toolboxes/cache';
import { ProjectResourceCleanup } from './resource-cleanup';
import { ProjectCreation, pendingCreationTargets } from './creation';
import { ProjectStore, type EntryRecord, type ProjectRecord } from './store';
import {
  assertExistingDirectory,
  assertNoLinks,
  assertPathInside,
  canonicalExistingPath,
  isDirectoryEmpty,
  isPathInside,
  normalizePathKey,
  PathPolicyError,
  validateEntryName,
} from '../filesystem/path-policy';
import {
  copyPath,
  createDirectory,
  createEmptyFile,
  pathExists,
  removePath,
  renamePath,
} from '../filesystem/operations';
import { scanDiskTree } from '../filesystem/tree';
import type { DiskNode } from '../filesystem/types';
import {
  currentVersion,
  decodeTextFile,
  encodeText,
  TextFileError,
  writeFileAtomically,
} from '../filesystem/text';

export interface ProjectServiceOptions {
  database: ApplicationDatabase;
  attachmentRoot?: string;
  appPath: string;
  logger: Logger;
  getMainWindow: () => BrowserWindow | undefined;
  /** Shared in-process toolbox cache; tests may inject a counting reader. */
  toolboxCatalog?: ToolboxCatalog;
}

export class ProjectServiceError extends Error {
  readonly code: string;
  readonly existingProjectId?: string;
  readonly existingProjectIds?: readonly string[];
  readonly treeResult?: TreeMutationResult;
  readonly partial?: boolean;
  /** Latest disk version when a save conflicts with an external change. */
  readonly currentVersion?: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & {
      existingProjectId?: string;
      existingProjectIds?: readonly string[];
      treeResult?: TreeMutationResult;
      partial?: boolean;
      currentVersion?: string;
    },
  ) {
    super(message, options);
    this.name = 'ProjectServiceError';
    this.code = code;
    this.existingProjectId = options?.existingProjectId;
    this.existingProjectIds = options?.existingProjectIds;
    this.treeResult = options?.treeResult;
    this.partial = options?.partial;
    this.currentVersion = options?.currentVersion;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function projectInfo(project: ProjectRecord): ProjectSnapshot['project'] {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    pathKey: project.pathKey,
    ...(project.toolboxId ? { toolboxId: project.toolboxId } : {}),
  };
}

function treeFromNodes(
  nodes: readonly DiskNode[],
  records: ReadonlyMap<string, EntryRecord>,
): FileTreeEntry[] {
  return nodes.map((node) => {
    const record = records.get(normalizePathKey(node.relativePath));
    if (!record) {
      throw new ProjectServiceError(
        'tree-identity-missing',
        `目录项身份缺失：${node.relativePath}`,
      );
    }
    return {
      id: record.entryId,
      name: node.name,
      path: node.absolutePath,
      kind: node.kind,
      ...(node.kind === 'file' ? { fileIdentity: record.entryId } : {}),
      ...(node.kind === 'folder'
        ? { children: treeFromNodes(node.children, records) }
        : {}),
    };
  });
}

function absolutePathFor(
  project: ProjectRecord,
  entry: EntryRecord,
): string {
  return path.join(project.path, entry.relativePath);
}

function normalizeUserPath(value: string): string {
  return normalizePathKey(path.resolve(value));
}

function assertProjectPathWithoutHan(value: string): void {
  if (projectPathContainsHan(value)) {
    throw new ProjectServiceError(PROJECT_PATH_HAN_ERROR.code, PROJECT_PATH_HAN_ERROR.message);
  }
}

/**
 * On a case-insensitive volume pathExists(target) is also true for a
 * case-only rename of the same entry. Resolve both paths so a genuinely
 * different entry that collides on Windows is still rejected.
 */
function sameExistingEntry(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

function changeFor(
  project: ProjectRecord,
  entry: EntryRecord,
  newRelativePath: string,
  kind: FileChange['kind'],
  newName?: string,
): FileChange {
  return {
    kind,
    identity: entry.entryId,
    name: newName ?? entry.name,
    path: path.join(project.path, newRelativePath),
    previousPath: absolutePathFor(project, entry),
  };
}

function changesUnder(
  project: ProjectRecord,
  entries: readonly EntryRecord[],
  rootEntryId: string,
  newRelativeRoot: string,
  newRootName: string,
  kind: FileChange['kind'],
): FileChange[] {
  const root = entries.find((entry) => entry.entryId === rootEntryId);
  if (!root) return [];
  const oldPrefix = root.relativePathKey;
  return entries
    .filter(
      (entry) =>
        entry.kind === 'file' &&
        (entry.relativePathKey === oldPrefix ||
          entry.relativePathKey.startsWith(`${oldPrefix}\\`)),
    )
    .map((entry) => {
      const suffix = entry.relativePathKey.slice(oldPrefix.length);
      return changeFor(
        project,
        entry,
        `${newRelativeRoot}${suffix}`,
        kind,
        entry.entryId === rootEntryId ? newRootName : undefined,
      );
    });
}

function assertToolboxOutsideTarget(
  toolbox: ToolboxDefinition,
  target: string,
): void {
  if (
    isPathInside(toolbox.standardCasePath, target) ||
    isPathInside(target, toolbox.standardCasePath)
  ) {
    throw new ProjectServiceError(
      'template-overlaps-target',
      '项目目标目录不能位于工具箱模板内，也不能包含工具箱模板。',
    );
  }
}

export class ProjectService {
  private readonly store: ProjectStore;
  private readonly database: ApplicationDatabase;
  private readonly resourceCleanup: ProjectResourceCleanup;
  private recreationGuard: (projectId: string) => Promise<() => void> = async () => () => undefined;
  private readonly retirementListeners = new Set<(projectId: string) => void>();
  private readonly appPath: string;
  private readonly logger: Logger;
  private readonly getMainWindow: () => BrowserWindow | undefined;
  private readonly toolboxCatalog: ToolboxCatalog;
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Last known stat signature per project/file identity. It is the basis for
   * reporting external content changes; it never replaces the on-disk read.
   */
  private readonly fileSignatures = new Map<string, Map<string, string>>();
  /**
   * Content/deletion changes observed by an internal mutation scan but not yet
   * published to file-sync listeners. Mutation scans may update the tree and
   * identity registry, but they must not silently consume an unrelated external
   * change before rescanProject can publish it.
   */
  private readonly pendingFileChanges = new Map<
    string,
    { changed: Set<string>; deleted: Set<string> }
  >();
  private readonly fileSyncRevisions = new Map<string, number>();
  /**
   * Cleanup warnings produced by the startup journal scan. The journal is
   * consumed before the user opens a project, so the warning must be kept
   * until that project's snapshot is returned to the renderer.
   */
  private readonly pendingCleanupWarnings = new Map<string, string>();

  constructor(options: ProjectServiceOptions) {
    this.store = new ProjectStore(options.database);
    this.database = options.database;
    this.resourceCleanup = new ProjectResourceCleanup(options.database, options.attachmentRoot);
    this.appPath = options.appPath;
    this.logger = options.logger;
    this.getMainWindow = options.getMainWindow;
    this.toolboxCatalog =
      options.toolboxCatalog ?? new ToolboxCatalog(options.appPath);
  }

  async listToolboxes(): Promise<ToolboxOption[]> {
    try {
      return scanToolboxes(this.appPath).toolboxes.map((toolbox) => ({
        id: toolbox.name,
        label: toolbox.name,
        ...(toolbox.error ? { error: toolbox.error } : {}),
      }));
    } catch (error) {
      throw this.wrap('toolbox-scan-failed', error);
    }
  }

  async loadRecentProjects(): Promise<RecentProject[]> {
    // An interrupted first creation may have no project row/recent entry and
    // its target may be between renames. Restore those filesystem intents
    // before presenting the picker. This never changes database registration.
    const journalRoot = path.join(
      path.dirname(this.database.databasePath),
      'project-initializations',
    );
    for (const target of pendingCreationTargets(journalRoot)) {
      this.rememberCreationWarning(target, this.recoverCreation(target));
    }
    return this.store.listRecent().map((project) => ({
      ...projectInfo(project),
      opened: this.formatOpened(project.lastOpenedAt),
    }));
  }

  async pickProjectFolder(
    purpose: 'create' | 'open',
  ): Promise<FolderSelection | null> {
    if (purpose !== 'create' && purpose !== 'open') {
      throw new ProjectServiceError(
        'invalid-arguments',
        '文件夹选择用途无效。',
      );
    }
    const parent = this.getMainWindow();
    const dialogOptions: OpenDialogOptions = {
      title: purpose === 'create' ? '选择新项目文件夹' : '打开项目文件夹',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: purpose === 'create' ? '选择此文件夹' : '打开',
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length !== 1) return null;
    const selected = result.filePaths[0];
    if (
      purpose === 'create' &&
      (projectPathContainsHan(selected) || projectPathContainsHan(canonicalExistingPath(selected)))
    ) {
      return {
        path: selected,
        pathKey: normalizeUserPath(selected),
        name: path.basename(selected) || selected,
        pathContainsHan: true,
      };
    }
    const canonical = assertExistingDirectory(selected);
    const pathKey = normalizePathKey(canonical);
    let directoryEmpty: boolean | undefined;
    let existingProjectId: string | undefined;
    let existingProjectIds: string[] | undefined;
    if (purpose === 'create') {
      try {
        directoryEmpty = isDirectoryEmpty(canonical);
      } catch {
        // A directory that disappeared between the picker and this check is
        // reported again by createProject, which revalidates the selection.
        directoryEmpty = false;
      }
      const existing = this.store.listProjectsByPathKey(pathKey);
      existingProjectId = existing[0]?.id;
      existingProjectIds = existing.map((project) => project.id);
    }
    return {
      path: canonical,
      pathKey,
      name: path.basename(canonical) || canonical,
      ...(directoryEmpty !== undefined ? { directoryEmpty } : {}),
      ...(existingProjectId ? { existingProjectId } : {}),
      ...(existingProjectIds && existingProjectIds.length > 0
        ? { existingProjectIds }
        : {}),
    };
  }

  setRecreationGuard(guard: (projectId: string) => Promise<() => void>): void {
    this.recreationGuard = guard;
  }

  subscribeRetired(listener: (projectId: string) => void): () => void {
    this.retirementListeners.add(listener);
    return () => this.retirementListeners.delete(listener);
  }

  isProjectCurrent(projectId: string): boolean {
    const project = this.store.getProject(projectId);
    return Boolean(project && project.retiredAt === null);
  }

  /**
   * Task queries and stop requests must keep working after the project
   * directory disappeared. They only need the registration, never the disk.
   */
  requireRegisteredProject(projectId: string): ProjectRecord {
    if (typeof projectId !== 'string' || !projectId) {
      throw new ProjectServiceError('invalid-arguments', '项目标识无效。');
    }
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new ProjectServiceError('project-not-found', '项目不存在。');
    }
    if (project.retiredAt !== null) {
      throw new ProjectServiceError(
        'project-retired',
        '该项目已退出此路径的当前归属，历史记录仍保留，请重新打开当前项目。',
      );
    }
    return project;
  }

  /**
   * Distinguishes a permanently removed project directory from one that exists
   * but is temporarily unreadable (locked, permissions, replaced by a file).
   * Closing a project may skip saving only for the removed case; unreadable
   * directories keep their error and retry path.
   */
  getProjectAvailability(projectId: string): ProjectAvailability {
    const project = this.requireRegisteredProject(projectId);
    const base = {
      projectId: project.id,
      name: project.name,
      path: project.path,
    };
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(project.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ...base, directoryState: 'missing' };
      }
      return {
        ...base,
        directoryState: 'unreadable',
        message: `无法读取项目目录：${errorMessage(error)}`,
      };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        ...base,
        directoryState: 'unreadable',
        message: `项目路径已不是可读取的文件夹：${project.path}`,
      };
    }
    try {
      accessSync(project.path, constants.R_OK);
      readdirSync(project.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ...base, directoryState: 'missing' };
      }
      return {
        ...base,
        directoryState: 'unreadable',
        message: `无法读取项目目录：${errorMessage(error)}`,
      };
    }
    return { ...base, directoryState: 'available' };
  }

  private creationFor(folderPath: string): ProjectCreation {
    return new ProjectCreation(folderPath,
      path.join(path.dirname(this.database.databasePath), 'project-initializations'), this.logger);
  }

  private recoverCreation(folderPath: string): string | undefined {
    return this.creationFor(folderPath).recover((id) => {
      const project = this.store.getProject(id);
      return project?.retiredAt === null && project.pathKey === normalizePathKey(folderPath);
    });
  }

  /** Journal recovery only knows the target path; associate its warning with
   * the committed project so a later open can surface the backup location. */
  private rememberCreationWarning(
    folderPath: string,
    warning: string | undefined,
  ): void {
    if (!warning) return;
    const project = this.store.findProjectByPathKey(
      normalizePathKey(path.resolve(folderPath)),
    );
    if (project) this.pendingCleanupWarnings.set(project.id, warning);
  }

  private attachPendingCleanupWarning(
    snapshot: ProjectSnapshot,
  ): ProjectSnapshot {
    const warning = this.pendingCleanupWarnings.get(snapshot.project.id);
    if (!warning) return snapshot;
    this.pendingCleanupWarnings.delete(snapshot.project.id);
    snapshot.cleanupWarning = snapshot.cleanupWarning
      ? `${warning}；${snapshot.cleanupWarning}`
      : warning;
    return snapshot;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSnapshot> {
    assertProjectPathWithoutHan(input.folder.path);
    const folderPath = path.resolve(input.folder.path);
    assertProjectPathWithoutHan(folderPath);
    const pathKey = normalizePathKey(folderPath);
    return this.runQueued(`create:${pathKey}`, async () => {
      // An interrupted initialization may have moved the target aside. In that
      // case the real parent is the part that can still be resolved before recovery.
      const existingPath = lstatSync(folderPath, { throwIfNoEntry: false })
        ? folderPath
        : path.dirname(folderPath);
      assertProjectPathWithoutHan(canonicalExistingPath(existingPath));
      if (normalizePathKey(input.folder.pathKey) !== pathKey) {
        throw new ProjectServiceError('path-key-mismatch', '项目路径与路径键不一致，请重新选择文件夹。');
      }
      this.recoverCreation(folderPath);
      const validateTarget = () => {
        assertProjectPathWithoutHan(canonicalExistingPath(folderPath));
        const canonical = assertExistingDirectory(folderPath);
        assertProjectPathWithoutHan(canonical);
        if (normalizePathKey(canonical) !== pathKey) {
          throw new ProjectServiceError('path-key-mismatch', '项目文件夹身份已改变，请重新选择。');
        }
        return canonical;
      };
      const canonical = validateTarget();
      const existing = this.store.findProjectByPathKey(pathKey);
      return this.runQueued(`project:${existing?.id ?? pathKey}`, async () => {
        validateTarget();
        const toolbox = this.loadToolboxForCreate(input.toolboxId);
        assertToolboxOutsideTarget(toolbox, canonical);
        const directoryEmpty = isDirectoryEmpty(canonical);
        const owner = this.store.findProjectByPathKey(pathKey);
        const previous = this.store.listProjectsByPathKey(pathKey);
        const ids = previous.map((project) => project.id);
        const confirmed = [...(input.replaceProjectIds ?? [])].sort();
        if (ids.length > 0 && (input.replaceProjectId !== ids[0] ||
          JSON.stringify(confirmed) !== JSON.stringify([...ids].sort()))) {
          throw new ProjectServiceError('project-recreate-confirmation-required',
            '该路径存在旧项目记录。重新创建将清除旧项目的对话、草稿及恢复状态，并初始化全新项目。是否继续？',
            { existingProjectId: ids[0], existingProjectIds: ids });
        }
        if (ids.length === 0 && (input.replaceProjectId || confirmed.length > 0)) {
          throw new ProjectServiceError('project-owner-changed', '项目路径归属已改变，请重新选择并确认。');
        }
        const confirmedOverwrite = input.confirmOverwrite === true;
        if (!directoryEmpty && !confirmedOverwrite) {
          throw this.overwriteConfirmationError(canonical, ids);
        }
        // A recreate-only confirmation clears old records but never the
        // directory contents. Only an explicit overwrite confirmation may
        // rebuild a non-empty directory.
        const replacing = confirmedOverwrite;
        const releases: Array<() => void> = [];
        try {
          for (const id of ids) releases.push(await this.recreationGuard(id));
          validateTarget();
        } catch (error) {
          for (const release of releases) release();
          throw error;
        }
        const creation = this.creationFor(canonical);
        let snapshot: ProjectSnapshot;
        try {
          if (JSON.stringify(this.store.listProjectsByPathKey(pathKey).map((project) => project.id)) !== JSON.stringify(ids)) {
            throw new Error('项目路径归属已改变，请重新选择并确认。');
          }
          if (!isDirectoryEmpty(canonical) && !confirmedOverwrite) {
            throw this.overwriteConfirmationError(canonical, ids);
          }
          const id = creation.initialize(toolbox.standardCasePath, undefined, {
            replaceExisting: replacing,
          });
          snapshot = this.database.runInTransaction(() => {
            if (owner) this.store.retireProject(owner.id);
            const project = this.store.createProject({ id,
              name: path.basename(canonical) || canonical, path: canonical,
              pathKey, toolboxId: toolbox.name });
            const nodes = scanDiskTree(canonical, this.logger);
            const records = this.store.syncDiskTree(project.id, nodes, true);
            this.resourceCleanup.plan(ids, id);
            for (const previousId of ids) this.store.deleteProject(previousId);
            for (const previousId of ids) this.pendingCleanupWarnings.delete(previousId);
            return { project: projectInfo(project), tree: treeFromNodes(nodes,
              new Map(records.map((record) => [record.relativePathKey, record]))) };
          });
        } catch (error) {
          try { this.recoverCreation(canonical); }
          catch (recoveryError) {
            throw new ProjectServiceError('project-create-recovery-failed',
              `${errorMessage(error)}；恢复失败：${errorMessage(recoveryError)}`, { cause: error });
          }
          // The directory became non-empty between the submit check and the
          // guarded publish. Files were preserved; ask for the overwrite
          // confirmation instead of reporting an opaque failure.
          if (
            (error as { code?: string }).code === 'directory-became-nonempty'
          ) {
            throw this.overwriteConfirmationError(canonical, ids);
          }
          throw this.wrap('project-create-failed', error);
        } finally {
          for (const release of releases) release();
        }
        // Commit is the ownership boundary. Cleanup failure must not report a
        // committed project as uncreated; the durable intent can finish on open.
        try {
          const cleanupWarning = this.recoverCreation(canonical);
          if (cleanupWarning) {
            snapshot.cleanupWarning = `新项目已创建，但${cleanupWarning}`;
          }
        } catch (error) {
          snapshot.cleanupWarning = `新项目已创建，初始化辅助文件清理尚未完成：${errorMessage(error)}`;
        }
        for (const previousId of ids) for (const listener of this.retirementListeners) listener(previousId);
        snapshot.replacedProjectIds = ids;
        return this.withCleanupStatus(snapshot);
      });
    });
  }

  private overwriteConfirmationError(
    canonical: string,
    ids: readonly string[],
  ): ProjectServiceError {
    return new ProjectServiceError(
      'project-overwrite-confirmation-required',
      `所选文件夹「${canonical}」不是空文件夹。继续将移除该目录的全部旧内容，并用所选 Flamelet 类型的完整模板重建整个项目目录。` +
        (ids.length > 0
          ? '该路径已有旧项目记录，对应的旧对话、草稿及恢复状态也会被清除。'
          : ''),
      { existingProjectId: ids[0], existingProjectIds: ids },
    );
  }

  private withCleanupStatus(snapshot: ProjectSnapshot): ProjectSnapshot {
    const existing = snapshot.cleanupWarning;
    try {
      const warning = this.resourceCleanup.flush(snapshot.project.id);
      if (warning) {
        snapshot.cleanupWarning = existing
          ? `${existing}；${warning}`
          : warning;
      }
    } catch (error) {
      const warning = `新项目可用，旧资源清理尚未完成：${errorMessage(error)}`;
      snapshot.cleanupWarning = existing
        ? `${existing}；${warning}`
        : warning;
    }
    return snapshot;
  }

  async openProject(input: OpenProjectInput): Promise<ProjectSnapshot> {
    const recoveryWarning = this.recoverCreation(path.resolve(input.path));
    this.rememberCreationWarning(input.path, recoveryWarning);
    const canonical = assertExistingDirectory(input.path);
    const pathKey = normalizePathKey(canonical);
    if (normalizePathKey(input.pathKey) !== pathKey) {
      throw new ProjectServiceError(
        'path-key-mismatch',
        '项目路径与路径键不一致，请重新选择文件夹。',
      );
    }
    let project = this.store.findProjectByPathKey(pathKey);
    let created = false;
    if (!project) {
      project = this.store.createProject({
        name: path.basename(canonical) || canonical,
        path: canonical,
        pathKey,
        toolboxId: null,
      });
      created = true;
    }
    const projectId = project.id;
    return this.runQueued(`project:${projectId}`, async () => {
      try {
        const current = this.store.getProject(projectId);
        if (!current || current.retiredAt !== null) {
          throw new ProjectServiceError(
            'project-missing',
            '项目登记已不存在，请重新选择文件夹。',
          );
        }
        if (current.toolboxId) {
          // Load the bound toolbox before exposing the project. A broken or
          // missing toolbox is reported here and never silently replaced by
          // another discovered toolbox.
          this.loadBoundToolbox(current.toolboxId);
        }
        const snapshot = await this.scanProject(current);
        // Commit the recent-open timestamp only after the project snapshot
        // was successfully produced. A failed scan must not reorder recents.
        this.store.touchProject(projectId);
        return this.withCleanupStatus(
          this.attachPendingCleanupWarning(snapshot),
        );
      } catch (error) {
        if (created) {
          try {
            this.store.deleteProject(projectId);
          } catch {
            // Preserve the original open error.
          }
        }
        throw this.wrap('project-open-failed', error);
      }
    });
  }

  /**
   * Binds an unbound project to a discovered toolbox folder. Only the type is
   * stored: no standardCase files are created or overwritten.
   */
  async bindProjectToolbox(
    input: BindProjectToolboxInput,
  ): Promise<ProjectSnapshot> {
    const { project } = this.resolveProject(input.projectId);
    if (typeof input.toolboxId !== 'string' || !input.toolboxId) {
      throw new ProjectServiceError(
        'toolbox-not-found',
        '请选择要绑定的 Flamelet 工具箱。',
      );
    }
    if (project.toolboxId) {
      throw new ProjectServiceError(
        'toolbox-already-bound',
        `项目已绑定工具箱「${project.toolboxId}」，本阶段不支持更换项目类型。`,
      );
    }
    const toolbox = this.loadToolboxForBind(input.toolboxId);
    return this.runQueued(`project:${project.id}`, async () => {
      try {
        this.store.setToolboxId(project.id, toolbox.name);
      } catch (error) {
        throw this.wrap('project-bind-failed', error);
      }
      return this.scanProject({ ...project, toolboxId: toolbox.name });
    });
  }

  /**
   * Re-reads the complete project tree after external (Agent) file changes.
   * The scan is serialized per project with the other tree operations.
   */
  async rescanProject(projectId: string): Promise<{
    snapshot: ProjectSnapshot;
    revision: number;
    changedFileIdentities: readonly string[];
    deletedFileIdentities: readonly string[];
  }> {
    return this.runQueued(`project:${projectId}`, async () => {
      const { project } = this.resolveProject(projectId);
      const before = this.store.listEntries(projectId);
      const scanned = await this.scanProjectInternal(project, before, true, {});
      const revision = (this.fileSyncRevisions.get(projectId) ?? 0) + 1;
      this.fileSyncRevisions.set(projectId, revision);
      return {
        snapshot: scanned.snapshot,
        revision,
        changedFileIdentities: scanned.changedFileIdentities,
        deletedFileIdentities: scanned.deletedFileIdentities,
      };
    });
  }

  /**
   * Project toolbox as loaded for this application run. The first call reads
   * and caches the toolbox resources; later calls, other projects and chat
   * turns reuse the same object instead of rescanning the disk.
   */
  getProjectToolbox(projectId: string): LoadedToolbox | null {
    const { project } = this.resolveProject(projectId);
    if (!project.toolboxId) return null;
    return this.loadBoundToolbox(project.toolboxId);
  }

  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    const { project, entry } = this.resolveEntry(
      input.projectId,
      input.fileIdentity,
    );
    if (entry.kind !== 'file') {
      throw new ProjectServiceError(
        'not-a-file',
        '所选目录项不是文件。',
      );
    }
    const absolute = absolutePathFor(project, entry);
    assertNoLinks(project.path, absolute);
    try {
      return decodeTextFile(absolute);
    } catch (error) {
      throw this.wrap('file-read-failed', error);
    }
  }

  /** A null result means the file exists and needs to be indexed by project sync. */
  resolveProjectFileLink(
    input: ResolveProjectFileLinkInput,
  ): FileTreeEntry | null {
    const { project } = this.resolveProject(input.projectId);
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(input.href.split(/[?#]/, 1)[0]);
    } catch {
      throw new ProjectServiceError(
        'invalid-file-link',
        '文件链接包含无效的 URL 编码。',
      );
    }
    if (path.win32.isAbsolute(relativePath)) {
      throw new ProjectServiceError(
        'path-outside-project',
        '文件链接必须使用项目内的相对路径。',
      );
    }
    if (!relativePath || relativePath.includes(':') || relativePath.includes('\u0000')) {
      throw new ProjectServiceError('invalid-file-link', '文件链接路径无效。');
    }

    const absolute = path.resolve(project.path, relativePath);
    assertNoLinks(project.path, absolute);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProjectServiceError(
          'entry-missing',
          '链接目标文件不存在或已删除。',
        );
      }
      throw this.wrap('file-link-unavailable', error);
    }
    if (!stat.isFile()) {
      throw new ProjectServiceError('not-a-file', '链接目标不是文件。');
    }

    const indexed = this.store.findEntryByRelativePath(
      project.id,
      path.relative(project.path, absolute),
    );
    if (indexed?.kind !== 'file') return null;
    const resolved = this.resolveFileEntry(project.id, indexed.entryId);
    return {
      id: resolved.entry.entryId,
      fileIdentity: resolved.entry.entryId,
      name: resolved.entry.name,
      path: resolved.absolute,
      kind: 'file',
    };
  }

  /**
   * Authoritative file lookup for the Step 3 resource readers. It deliberately
   * reuses the same project/identity/path/link checks as text reads rather than
   * accepting a renderer-supplied path.
   */
  resolveFileEntry(
    projectId: string,
    fileIdentity: string,
  ): { project: ProjectRecord; entry: EntryRecord; absolute: string } {
    const { project, entry } = this.resolveEntry(projectId, fileIdentity);
    if (entry.kind !== 'file') {
      throw new ProjectServiceError(
        'not-a-file',
        '所选目录项不是文件。',
      );
    }
    const absolute = absolutePathFor(project, entry);
    assertNoLinks(project.path, absolute);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      throw this.wrap('entry-missing', error);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProjectServiceError(
        'not-a-file',
        '所选目录项不是普通文件。',
      );
    }
    return { project, entry, absolute };
  }

  async saveFile(input: SaveFileInput): Promise<SaveFileResult> {
    return this.runQueued(`project:${input.projectId}`, async () => {
      const { project, entry } = this.resolveEntry(
        input.projectId,
        input.fileIdentity,
      );
      const absolute = absolutePathFor(project, entry);
      if (entry.kind !== 'file') {
        throw new ProjectServiceError('not-a-file', '所选目录项不是文件。');
      }
      if (normalizeUserPath(input.path) !== normalizeUserPath(absolute)) {
        throw new ProjectServiceError(
          'path-mismatch',
          '保存路径与文件身份不一致，已拒绝写入。',
        );
      }
      if (!input.expectedVersion) {
        throw new ProjectServiceError(
          'version-required',
          '保存请求缺少文件版本，已拒绝覆盖。',
        );
      }
      assertNoLinks(project.path, absolute);
      try {
        let decoded: ReturnType<typeof decodeTextFile>;
        try {
          decoded = decodeTextFile(absolute, { strictTrailing: true });
        } catch (error) {
          throw this.wrap('file-save-failed', error);
        }
        if (decoded.version !== input.expectedVersion) {
          // `force` is an explicit user confirmation for the exact version the
          // conflict dialog saw. Any newer external change produces a fresh
          // conflict instead of being overwritten.
          throw new ProjectServiceError(
            'version-conflict',
            input.force
              ? '文件在确认覆盖前再次被外部修改，保存已取消；编辑内容仍保留。'
              : '文件已被外部修改，保存已取消；编辑内容仍保留。',
            { currentVersion: decoded.version },
          );
        }
        // The file keeps the encoding it was read with. BOM and newline
        // choices are explicit renderer overrides when provided.
        const bom =
          decoded.encoding === 'utf-8' ? (input.bom ?? decoded.bom) : decoded.bom;
        const newline = input.newline ?? decoded.newline;
        const bytes = encodeText(input.content, {
          encoding: decoded.encoding,
          bom,
          newline,
        });
        const beforeWrite = currentVersion(absolute);
        if (beforeWrite !== input.expectedVersion) {
          throw new ProjectServiceError(
            'version-conflict',
            '文件在保存期间被外部修改，保存已取消；编辑内容仍保留。',
            { currentVersion: beforeWrite },
          );
        }
        writeFileAtomically(absolute, bytes);
        const version = currentVersion(absolute);
        try {
          this.store.recordSavedVersion(
            project.id,
            entry.entryId,
            version,
          );
        } catch (markerError) {
          this.logger.error('saved-version-marker-failed', {
            message: errorMessage(markerError),
          });
        }
        return { version };
      } catch (error) {
        if (error instanceof ProjectServiceError) throw error;
        throw this.wrap('file-save-failed', error);
      }
    });
  }

  /**
   * Preserves a document whose original file disappeared (or whose rename
   * cannot be confirmed) under a new name in the project root. It never
   * overwrites an existing file.
   */
  async saveFileAs(input: SaveFileAsInput): Promise<SaveFileAsResult> {
    return this.runQueued(`project:${input.projectId}`, async () => {
      const { project } = this.resolveProject(input.projectId);
      const name = validateEntryName(input.name);
      const target = path.join(project.path, name);
      assertPathInside(project.path, target);
      assertNoLinks(project.path, target, false);
      if (pathExists(target)) {
        throw new ProjectServiceError(
          'already-exists',
          '项目根目录已存在同名文件，未覆盖；请换一个名称。',
        );
      }
      if (typeof input.content !== 'string') {
        throw new ProjectServiceError('invalid-arguments', '保存内容无效。');
      }
      const bytes = encodeText(input.content, {
        encoding: 'utf-8',
        bom: false,
        newline: '\n',
      });
      try {
        writeFileAtomically(target, bytes);
      } catch (error) {
        throw this.wrap('file-save-as-failed', error);
      }
      let snapshot: ProjectSnapshot;
      try {
        snapshot = await this.scanProject(project);
      } catch (error) {
        throw this.wrap(
          'file-save-as-reconcile-failed',
          new Error(
            `文件已写入，但目录树刷新失败：${errorMessage(error)}。请重新打开项目核对。`,
          ),
        );
      }
      const entry = this.findEntryByAbsolute(snapshot.tree, target);
      if (!entry) {
        throw new ProjectServiceError(
          'file-save-as-reconcile-failed',
          '文件已写入，但目录树中没有找到该文件；请重新打开项目核对。',
        );
      }
      return {
        tree: snapshot.tree,
        fileIdentity: entry.id,
        path: entry.path,
        version: currentVersion(target),
      };
    });
  }

  async createEntry(input: TreeEntryInput): Promise<TreeMutationResult> {
    return this.runQueued(`project:${input.projectId}`, async () => {
      const { project } = this.resolveProject(input.projectId);
      const parent = input.parentId
        ? this.resolveEntryPath(project, input.parentId)
        : { absolute: project.path, relative: '' };
      if (input.parentId && !this.isFolderEntry(project.id, input.parentId)) {
        throw new ProjectServiceError(
          'not-a-folder',
          '只能在文件夹中新建项目。',
        );
      }
      const name = validateEntryName(input.name);
      const target = path.join(parent.absolute, name);
      assertPathInside(project.path, target);
      assertNoLinks(project.path, target, false);
      if (pathExists(target)) {
        throw new ProjectServiceError(
          'already-exists',
          '同一位置已存在同名项目。',
        );
      }
      try {
        if (input.kind === 'file') createEmptyFile(target);
        else createDirectory(target);
        const snapshot = await this.scanProject(project);
        const targetEntry = this.findEntryByAbsolute(
          snapshot.tree,
          target,
        );
        return {
          tree: snapshot.tree,
          changes: [],
          ...(targetEntry ? { targetEntryId: targetEntry.id } : {}),
        };
      } catch (error) {
        if (pathExists(target)) {
          try {
            removePath(target);
          } catch {
            // Preserve the operation error.
          }
        }
        throw this.wrap('entry-create-failed', error);
      }
    });
  }

  async renameEntry(input: RenameEntryInput): Promise<TreeMutationResult> {
    return this.runQueued(`project:${input.projectId}`, async () => {
      const { project, entry } = this.resolveEntry(
        input.projectId,
        input.entryId,
      );
      const name = validateEntryName(input.name);
      const parent = path.dirname(absolutePathFor(project, entry));
      const target = path.join(parent, name);
      const oldAbsolute = absolutePathFor(project, entry);
      if (oldAbsolute === target) {
        const snapshot = await this.scanProject(project);
        return {
          tree: snapshot.tree,
          changes: [],
          targetEntryId: entry.entryId,
        };
      }
      const caseOnly = normalizeUserPath(oldAbsolute) === normalizeUserPath(target);
      assertPathInside(project.path, target);
      assertNoLinks(project.path, target, false);
      if (pathExists(target) && !(caseOnly && sameExistingEntry(oldAbsolute, target))) {
        throw new ProjectServiceError(
          'already-exists',
          '同一位置已存在同名项目。',
        );
      }
      const oldEntries = this.store.listEntries(project.id);
      const oldRelative = entry.relativePath;
      const newRelative = path.join(path.dirname(oldRelative), name);
      try {
        // A case-only rename resolves to the same entry on Windows, so the
        // generic target-exists guard must be bypassed for this explicit
        // spelling change.
        renamePath(oldAbsolute, target, { allowSameEntry: caseOnly });
      } catch (error) {
        throw this.wrap('entry-rename-failed', error);
      }
      let databaseMoved = false;
      try {
        this.store.moveEntryTree({
          projectId: project.id,
          entryId: entry.entryId,
          newName: name,
          newRelativePath: newRelative,
          newParentEntryId: entry.parentEntryId,
        });
        databaseMoved = true;
        const snapshot = await this.scanProject(project, {
          localFileIdentities: [entry.entryId],
        });
        return {
          tree: snapshot.tree,
          changes: changesUnder(
            project,
            oldEntries,
            entry.entryId,
            newRelative,
            name,
            'renamed',
          ),
          targetEntryId: entry.entryId,
        };
      } catch (error) {
        return this.recoverMoveFailure({
          project,
          entry,
          oldEntries,
          oldName: entry.name,
          oldRelative,
          oldParentEntryId: entry.parentEntryId,
          oldAbsolute,
          newName: name,
          newRelative,
          newParentEntryId: entry.parentEntryId,
          newAbsolute: target,
          databaseMoved,
          kind: 'renamed',
          operation: '重命名',
          error,
        });
      }
    });
  }

  async deleteEntry(input: DeleteEntryInput): Promise<TreeMutationResult> {
    return this.runQueued(`project:${input.projectId}`, async () => {
      const { project, entry } = this.resolveEntry(
        input.projectId,
        input.entryId,
      );
      const absolute = absolutePathFor(project, entry);
      if (normalizeUserPath(absolute) === normalizeUserPath(project.path)) {
        throw new ProjectServiceError(
          'cannot-delete-root',
          '不能删除项目根目录。',
        );
      }
      const oldEntries = this.store.listEntries(project.id);
      let removeError: unknown;
      try {
        removePath(absolute);
      } catch (error) {
        removeError = error;
      }

      // Whether the recursive remove fully failed or only partially removed
      // children, re-read the disk before touching the identity map. This is
      // the authority for what actually remains.
      let snapshot: ProjectSnapshot;
      const deletedIds = oldEntries
        .filter(
          (candidate) =>
            candidate.entryId === entry.entryId ||
            candidate.relativePathKey.startsWith(
              `${entry.relativePathKey}\\`,
            ),
        )
        .map((candidate) => candidate.entryId);
      try {
        snapshot = await this.scanProject(project, {
          localDeletedIdentities: deletedIds,
        });
      } catch (error) {
        throw this.wrap(
          'entry-delete-reconcile-failed',
          new Error(
            removeError
              ? `删除请求失败，且磁盘/项目登记复核失败：${errorMessage(
                  error,
                )}。请重新打开项目核对；不要假定磁盘未发生变化。`
              : `磁盘内容已删除，但项目登记或目录树更新失败：${errorMessage(
                  error,
                )}。请重新打开项目核对；不要假定登记已更新。`,
          ),
        );
      }

      const remainingIds = new Set(
        this.collectEntryIds(snapshot.tree),
      );
      const oldPrefix = entry.relativePathKey;
      const removedEntries = oldEntries.filter(
        (item) =>
          (item.relativePathKey === oldPrefix ||
            item.relativePathKey.startsWith(`${oldPrefix}\\`)) &&
          !remainingIds.has(item.entryId),
      );
      // File changes drive tab semantics; directory removals must not be
      // smuggled into FileChange just to decide whether anything changed.
      const deletedFiles = removedEntries.filter(
        (item) => item.kind === 'file',
      );
      const deletedDirectories = removedEntries.filter(
        (item) => item.kind === 'folder',
      );
      const changes = deletedFiles.map((item) =>
        changeFor(project, item, item.relativePath, 'deleted'),
      );
      const targetEntry = this.findEntryByAbsolute(snapshot.tree, absolute);
      const treeResult: TreeMutationResult = {
        tree: snapshot.tree,
        changes,
        ...(targetEntry ? { targetEntryId: targetEntry.id } : {}),
      };

      if (!removeError) {
        // All physical content was removed; the rescan also committed the
        // corresponding identity deletions.
        return treeResult;
      }
      if (removedEntries.length === 0) {
        throw new ProjectServiceError(
          'entry-delete-failed',
          `未删除任何内容，原项目内容保持不变：${errorMessage(
            removeError,
          )}`,
          { cause: removeError },
        );
      }

      const remainingNames =
        targetEntry && targetEntry.kind === 'folder'
          ? this.remainingNames(absolute)
          : [];
      const summary =
        remainingNames.length > 0
          ? `，剩余：${remainingNames.slice(0, 8).join('、')}${
              remainingNames.length > 8 ? '…' : ''
            }`
          : '';
      const removedParts: string[] = [];
      if (deletedDirectories.length > 0) {
        removedParts.push(`${deletedDirectories.length} 个文件夹`);
      }
      if (deletedFiles.length > 0) {
        removedParts.push(`${deletedFiles.length} 个文件`);
      }
      throw new ProjectServiceError(
        'entry-delete-partial',
        `删除仅完成一部分：已删除 ${removedParts.join('、')}${summary}。` +
          ' 目录树和条目身份已按磁盘实际结果更新。' +
          (deletedFiles.length > 0
            ? ' 未保存的已删除文件内容若仍保留在标签中，请注意其文件已不存在。'
            : ''),
        {
          cause: removeError,
          treeResult,
          partial: true,
        },
      );
    });
  }

  async pasteEntry(input: PasteEntryInput): Promise<TreeMutationResult> {
    return this.runQueued(`project:${input.projectId}`, async () => {
      const { project, entry: source } = this.resolveEntry(
        input.projectId,
        input.sourceEntryId,
      );
      if (input.mode !== 'cut' && input.mode !== 'copy') {
        throw new ProjectServiceError('invalid-arguments', '粘贴模式无效。');
      }
      const sourceAbsolute = absolutePathFor(project, source);
      const targetFolder = input.targetFolderId
        ? this.resolveEntryPath(project, input.targetFolderId)
        : { absolute: project.path, relative: '' };
      if (input.targetFolderId) {
        const targetEntry = this.store.getEntry(
          project.id,
          input.targetFolderId,
        );
        if (!targetEntry || targetEntry.kind !== 'folder') {
          throw new ProjectServiceError('not-a-folder', '目标不是文件夹。');
        }
      }
      const target = path.join(targetFolder.absolute, source.name);
      assertPathInside(project.path, target);
      assertNoLinks(project.path, target, false);
      if (
        isPathInside(sourceAbsolute, target) ||
        normalizeUserPath(sourceAbsolute) === normalizeUserPath(target)
      ) {
        throw new ProjectServiceError(
          'move-into-self',
          '不能把文件夹移动到自身或其后代中。',
        );
      }
      if (pathExists(target)) {
        throw new ProjectServiceError(
          'already-exists',
          '目标位置已存在同名项目。',
        );
      }
      if (input.mode === 'copy') {
        try {
          copyPath(sourceAbsolute, target);
          const snapshot = await this.scanProject(project);
          const targetEntry = this.findEntryByAbsolute(snapshot.tree, target);
          return {
            tree: snapshot.tree,
            changes: [],
            ...(targetEntry ? { targetEntryId: targetEntry.id } : {}),
          };
        } catch (error) {
          if (pathExists(target)) {
            try {
              removePath(target);
            } catch {
              // Preserve the operation error.
            }
          }
          throw this.wrap('entry-copy-failed', error);
        }
      }

      const oldEntries = this.store.listEntries(project.id);
      const targetRelative = path.join(
        targetFolder.relative,
        source.name,
      );
      const targetParentId = input.targetFolderId;
      try {
        renamePath(sourceAbsolute, target);
      } catch (error) {
        throw this.wrap('entry-move-failed', error);
      }
      let databaseMoved = false;
      try {
        this.store.moveEntryTree({
          projectId: project.id,
          entryId: source.entryId,
          newName: source.name,
          newRelativePath: targetRelative,
          newParentEntryId: targetParentId,
        });
        databaseMoved = true;
        const snapshot = await this.scanProject(project, {
          localFileIdentities: [source.entryId],
        });
        return {
          tree: snapshot.tree,
          changes: changesUnder(
            project,
            oldEntries,
            source.entryId,
            targetRelative,
            source.name,
            'moved',
          ),
          targetEntryId: source.entryId,
        };
      } catch (error) {
        return this.recoverMoveFailure({
          project,
          entry: source,
          oldEntries,
          oldName: source.name,
          oldRelative: source.relativePath,
          oldParentEntryId: source.parentEntryId,
          oldAbsolute: sourceAbsolute,
          newName: source.name,
          newRelative: targetRelative,
          newParentEntryId: targetParentId,
          newAbsolute: target,
          databaseMoved,
          kind: 'moved',
          operation: '移动',
          error,
        });
      }
    });
  }

  async revealPath(input: RevealPathInput): Promise<void> {
    const { project } = this.resolveProject(input.projectId);
    const absolute = path.resolve(input.path);
    assertPathInside(project.path, absolute);
    assertNoLinks(project.path, absolute);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      throw this.wrap('path-unavailable', error);
    }
    try {
      if (stat.isDirectory()) {
        const error = await shell.openPath(absolute);
        if (error) throw new Error(error);
      } else {
        shell.showItemInFolder(absolute);
      }
    } catch (error) {
      throw this.wrap('reveal-failed', error);
    }
  }

  async copyText(text: string): Promise<void> {
    if (typeof text !== 'string') {
      throw new ProjectServiceError('invalid-arguments', '复制内容无效。');
    }
    clipboard.writeText(text);
  }

  listRunningTasks(): [] {
    return [];
  }

  stopTask(): never {
    throw new ProjectServiceError(
      'task-not-found',
      '当前没有可停止的任务。',
    );
  }

  /**
   * Chat owns no filesystem authorization of its own. These methods reuse the
   * same project/entry identity checks as the file APIs.
   */
  getProjectRoot(projectId: string): string {
    return this.resolveProject(projectId).project.path;
  }

  describeEntry(
    projectId: string,
    entryId: string,
  ): {
    absolutePath: string;
    relativePath: string;
    name: string;
    kind: 'file' | 'folder';
  } {
    const { project, entry } = this.resolveEntry(projectId, entryId);
    return {
      absolutePath: absolutePathFor(project, entry),
      relativePath: entry.relativePath,
      name: entry.name,
      kind: entry.kind,
    };
  }

  listDirectoryEntries(
    projectId: string,
    entryId: string,
    limit: number,
  ): Array<{ name: string; kind: 'file' | 'folder'; relativePath: string }> {
    const { project, entry } = this.resolveEntry(projectId, entryId);
    if (entry.kind !== 'folder') {
      throw new ProjectServiceError(
        'entry-not-folder',
        '对话目录引用必须指向文件夹。',
      );
    }
    const directory = absolutePathFor(project, entry);
    const results: Array<{
      name: string;
      kind: 'file' | 'folder';
      relativePath: string;
    }> = [];
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const child of entries) {
      if (results.length >= limit) break;
      if (!child.isFile() && !child.isDirectory()) continue;
      const absolute = path.join(directory, child.name);
      try {
        const info = lstatSync(absolute);
        if (info.isSymbolicLink()) continue;
        results.push({
          name: child.name,
          kind: child.isDirectory() ? 'folder' : 'file',
          relativePath: `${entry.relativePath}\\${child.name}`,
        });
      } catch {
        // A child that disappears during listing is simply skipped.
      }
    }
    return results;
  }

  private loadToolboxForCreate(name: string): LoadedToolbox {
    try {
      return this.toolboxCatalog.load(name);
    } catch (error) {
      throw this.mapToolboxLoadError(
        error,
        {
          code: 'toolbox-not-found',
          message:
            '所选 Flamelet 工具箱文件夹不存在；工具箱类型由 toolboxes/ 下的文件夹名决定。',
        },
        'toolbox-scan-failed',
      );
    }
  }

  private loadToolboxForBind(name: string): LoadedToolbox {
    try {
      return this.toolboxCatalog.load(name);
    } catch (error) {
      throw this.mapToolboxLoadError(
        error,
        {
          code: 'toolbox-not-found',
          message: `工具箱文件夹「${name}」不存在。`,
        },
        'toolbox-scan-failed',
      );
    }
  }

  private loadBoundToolbox(name: string): LoadedToolbox {
    try {
      return this.toolboxCatalog.load(name);
    } catch (error) {
      throw this.mapToolboxLoadError(
        error,
        {
          code: 'toolbox-missing',
          message: `项目绑定的工具箱「${name}」已不存在或已改名；不会自动绑定其他工具箱。请在 toolboxes/ 下恢复该文件夹，或新建项目。`,
        },
        'toolbox-load-failed',
      );
    }
  }

  private mapToolboxLoadError(
    error: unknown,
    missing: { code: string; message: string },
    fallbackCode: string,
  ): ProjectServiceError | ToolboxError {
    if (error instanceof ToolboxError) {
      if (error.code === 'toolbox-missing') {
        return new ProjectServiceError(missing.code, missing.message, {
          cause: error,
        });
      }
      if (error.code === 'toolbox-invalid') {
        return new ProjectServiceError('toolbox-invalid', error.message, {
          cause: error,
        });
      }
      return error;
    }
    return this.wrap(fallbackCode, error);
  }

  private resolveProject(projectId: string): {
    project: ProjectRecord;
  } {
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new ProjectServiceError('project-not-found', '项目不存在。');
    }
    if (project.retiredAt !== null) {
      throw new ProjectServiceError('project-retired', '该项目已退出此路径的当前归属，历史记录仍保留，请重新打开当前项目。');
    }
    assertExistingDirectory(project.path);
    return { project };
  }

  private resolveEntry(
    projectId: string,
    entryId: string,
  ): { project: ProjectRecord; entry: EntryRecord } {
    const { project } = this.resolveProject(projectId);
    const entry = this.store.getEntry(projectId, entryId);
    if (!entry) {
      throw new ProjectServiceError(
        'entry-not-found',
        '目录项身份不存在或已失效。',
      );
    }
    const absolute = absolutePathFor(project, entry);
    assertPathInside(project.path, absolute);
    assertNoLinks(project.path, absolute);
    try {
      lstatSync(absolute);
    } catch (error) {
      throw this.wrap('entry-missing', error);
    }
    return { project, entry };
  }

  private resolveEntryPath(
    project: ProjectRecord,
    entryId: string,
  ): { absolute: string; relative: string } {
    const entry = this.store.getEntry(project.id, entryId);
    if (!entry) {
      throw new ProjectServiceError(
        'entry-not-found',
        '目录项身份不存在或已失效。',
      );
    }
    const absolute = absolutePathFor(project, entry);
    assertPathInside(project.path, absolute);
    assertNoLinks(project.path, absolute);
    return { absolute, relative: entry.relativePath };
  }

  private isFolderEntry(projectId: string, entryId: string): boolean {
    return this.store.getEntry(projectId, entryId)?.kind === 'folder';
  }

  private async recoverMoveFailure(input: {
    project: ProjectRecord;
    entry: EntryRecord;
    oldEntries: readonly EntryRecord[];
    oldName: string;
    oldRelative: string;
    oldParentEntryId: string | null;
    oldAbsolute: string;
    newName: string;
    newRelative: string;
    newParentEntryId: string | null;
    newAbsolute: string;
    databaseMoved: boolean;
    kind: 'renamed' | 'moved';
    operation: string;
    error: unknown;
  }): Promise<never> {
    let diskOld = pathExists(input.oldAbsolute);
    let diskNew = pathExists(input.newAbsolute);
    let databaseAtNew = input.databaseMoved;
    const compensationErrors: string[] = [];

    // Prefer returning the disk to its original path, then restore the
    // identity map. This keeps the frontend's cached tab/path state valid.
    if (databaseAtNew && diskNew && !diskOld) {
      try {
        renamePath(input.newAbsolute, input.oldAbsolute);
        diskOld = true;
        diskNew = false;
      } catch (error) {
        compensationErrors.push(`磁盘回滚失败：${errorMessage(error)}`);
      }
    }
    if (!databaseAtNew && diskNew && !diskOld) {
      try {
        renamePath(input.newAbsolute, input.oldAbsolute);
        diskOld = true;
        diskNew = false;
      } catch (error) {
        compensationErrors.push(`磁盘回滚失败：${errorMessage(error)}`);
      }
    }
    if (databaseAtNew && diskOld && !diskNew) {
      try {
        this.store.moveEntryTree({
          projectId: input.project.id,
          entryId: input.entry.entryId,
          newName: input.oldName,
          newRelativePath: input.oldRelative,
          newParentEntryId: input.oldParentEntryId,
        });
        databaseAtNew = false;
      } catch (error) {
        compensationErrors.push(`数据库身份回滚失败：${errorMessage(error)}`);
      }
    }
    if (!databaseAtNew && diskNew && !diskOld) {
      try {
        this.store.moveEntryTree({
          projectId: input.project.id,
          entryId: input.entry.entryId,
          newName: input.newName,
          newRelativePath: input.newRelative,
          newParentEntryId: input.newParentEntryId,
        });
        databaseAtNew = true;
      } catch (error) {
        compensationErrors.push(`数据库身份校正失败：${errorMessage(error)}`);
      }
    }

    if (!databaseAtNew && diskOld && !diskNew) {
      throw this.wrap(
        'entry-move-failed',
        new Error(
          `${input.operation}失败，磁盘路径和身份映射已恢复到原位置：${errorMessage(
            input.error,
          )}`,
        ),
      );
    }

    if (databaseAtNew && diskNew && !diskOld) {
      // The filesystem and identity map are consistent at the new path even
      // though the original request failed. Re-scan once so the renderer can
      // at least receive the truthful current tree.
      let treeResult: TreeMutationResult | undefined;
      const affectedIds = input.oldEntries
        .filter(
          (entry) =>
            entry.entryId === input.entry.entryId ||
            entry.relativePathKey.startsWith(
              `${input.entry.relativePathKey}\\`,
            ),
        )
        .map((entry) => entry.entryId);
      try {
        const snapshot = await this.scanProject(input.project, {
          localFileIdentities: affectedIds,
        });
        treeResult = {
          tree: snapshot.tree,
          changes: changesUnder(
            input.project,
            input.oldEntries,
            input.entry.entryId,
            input.newRelative,
            input.newName,
            input.kind,
          ),
          targetEntryId: input.entry.entryId,
        };
      } catch (error) {
        // A fault may prevent the reconciliation write while the identity
        // rows already point at the new path. A read-only tree build still
        // gives the renderer the truthful current disk tree.
        try {
          const snapshot = this.snapshotFromDisk(input.project);
          treeResult = {
            tree: snapshot.tree,
            changes: changesUnder(
              input.project,
              input.oldEntries,
              input.entry.entryId,
              input.newRelative,
              input.newName,
              input.kind,
            ),
            targetEntryId: input.entry.entryId,
          };
          compensationErrors.push(`目录树登记刷新失败：${errorMessage(error)}`);
        } catch (buildError) {
          compensationErrors.push(
            `目录树刷新失败：${errorMessage(error)}；${errorMessage(
              buildError,
            )}`,
          );
        }
      }
      throw new ProjectServiceError(
        'entry-move-recovered-new',
        `${input.operation}请求失败，但磁盘和文件身份已一致地处于新路径，目录树${treeResult ? '已' : '未能'}刷新：${errorMessage(
          input.error,
        )}${compensationErrors.length ? `；${compensationErrors.join('；')}` : ''}`,
        {
          cause: input.error,
          ...(treeResult ? { treeResult, partial: true } : {}),
        },
      );
    }

    throw this.wrap(
      'entry-move-inconsistent',
      new Error(
        `${input.operation}失败且补偿未完成；实际状态：${
          diskOld ? '原路径存在' : '原路径不存在'
        }，${diskNew ? '新路径存在' : '新路径不存在'}，${
          databaseAtNew ? '数据库记录在新路径' : '数据库记录在原路径'
        }。${compensationErrors.join('；')}`,
      ),
    );
  }

  private snapshotFromDisk(project: ProjectRecord): ProjectSnapshot {
    const nodes = scanDiskTree(project.path, this.logger);
    const byPath = new Map(
      this.store
        .listEntries(project.id)
        .map((record) => [record.relativePathKey, record]),
    );
    return {
      project: projectInfo(project),
      tree: treeFromNodes(nodes, byPath),
    };
  }

  private async scanProject(
    project: ProjectRecord,
    options: {
      /** Entries written intentionally by this operation; not external news. */
      localFileIdentities?: readonly string[];
      /** Entries removed intentionally by this operation. */
      localDeletedIdentities?: readonly string[];
    } = {},
  ): Promise<ProjectSnapshot> {
    const previous = this.store.listEntries(project.id);
    return (
      await this.scanProjectInternal(project, previous, false, options)
    ).snapshot;
  }

  private async scanProjectInternal(
    project: ProjectRecord,
    previousEntries: readonly EntryRecord[],
    publishChanges: boolean,
    options: {
      localFileIdentities?: readonly string[];
      localDeletedIdentities?: readonly string[];
    },
  ): Promise<{
    snapshot: ProjectSnapshot;
    changedFileIdentities: string[];
    deletedFileIdentities: string[];
  }> {
    const nodes = scanDiskTree(project.path, this.logger);
    const records = this.store.syncDiskTree(project.id, nodes);
    const byPath = new Map(
      records.map((record) => [record.relativePathKey, record]),
    );
    const signatures = new Map<string, string>();
    const collect = (list: readonly DiskNode[]): void => {
      for (const node of list) {
        if (node.kind === 'file') {
          const record = byPath.get(normalizePathKey(node.relativePath));
          if (record) {
            signatures.set(
              record.entryId,
              `${node.mtimeMs ?? 0}:${node.byteSize ?? 0}`,
            );
          }
        }
        if (node.children.length > 0) collect(node.children);
      }
    };
    collect(nodes);
    const previousSignatures =
      this.fileSignatures.get(project.id) ?? new Map<string, string>();
    const previousFiles = new Set(
      previousEntries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.entryId),
    );
    const localFiles = new Set(options.localFileIdentities ?? []);
    const localDeleted = new Set(options.localDeletedIdentities ?? []);
    const changedFileIdentities: string[] = [];
    const deletedFileIdentities: string[] = [];
    for (const identity of previousFiles) {
      if (!signatures.has(identity) && !localDeleted.has(identity)) {
        deletedFileIdentities.push(identity);
      }
    }
    for (const [identity, signature] of signatures) {
      const previousSignature = previousSignatures.get(identity);
      if (
        previousSignature !== undefined &&
        previousSignature !== signature &&
        !localFiles.has(identity)
      ) {
        changedFileIdentities.push(identity);
      }
    }
    this.fileSignatures.set(project.id, signatures);
    if (!publishChanges) {
      if (changedFileIdentities.length > 0 || deletedFileIdentities.length > 0) {
        let pending = this.pendingFileChanges.get(project.id);
        if (!pending) {
          pending = { changed: new Set(), deleted: new Set() };
          this.pendingFileChanges.set(project.id, pending);
        }
        for (const identity of deletedFileIdentities) {
          pending.deleted.add(identity);
          pending.changed.delete(identity);
        }
        for (const identity of changedFileIdentities) {
          if (!pending.deleted.has(identity)) pending.changed.add(identity);
        }
      }
      return {
        snapshot: {
          project: projectInfo(project),
          tree: treeFromNodes(nodes, byPath),
        },
        changedFileIdentities,
        deletedFileIdentities,
      };
    }
    const pending = this.pendingFileChanges.get(project.id);
    this.pendingFileChanges.delete(project.id);
    const changed = new Set(pending?.changed ?? []);
    const deleted = new Set(pending?.deleted ?? []);
    for (const identity of deletedFileIdentities) {
      deleted.add(identity);
      changed.delete(identity);
    }
    for (const identity of changedFileIdentities) {
      if (!deleted.has(identity)) changed.add(identity);
    }
    return {
      snapshot: {
        project: projectInfo(project),
        tree: treeFromNodes(nodes, byPath),
      },
      changedFileIdentities: [...changed],
      deletedFileIdentities: [...deleted],
    };
  }

  private findEntryByAbsolute(
    tree: readonly FileTreeEntry[],
    absolute: string,
  ): FileTreeEntry | null {
    const key = normalizeUserPath(absolute);
    const visit = (
      entries: readonly FileTreeEntry[],
    ): FileTreeEntry | null => {
      for (const entry of entries) {
        if (normalizeUserPath(entry.path) === key) return entry;
        if (entry.children) {
          const found = visit(entry.children);
          if (found) return found;
        }
      }
      return null;
    };
    return visit(tree);
  }

  private collectEntryIds(
    tree: readonly FileTreeEntry[],
  ): string[] {
    const ids: string[] = [];
    const visit = (entries: readonly FileTreeEntry[]) => {
      for (const entry of entries) {
        ids.push(entry.id);
        if (entry.children) visit(entry.children);
      }
    };
    visit(tree);
    return ids;
  }

  private remainingNames(directory: string): string[] {
    try {
      return readdirSync(directory).slice(0, 12);
    } catch {
      return [];
    }
  }

  private formatOpened(value: string): string {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return '刚刚';
    const elapsed = Date.now() - time;
    if (elapsed >= 0 && elapsed < 60_000) return '刚刚';
    return new Date(time).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private runQueued<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  private wrap(code: string, error: unknown): ProjectServiceError {
    if (error instanceof ProjectServiceError) return error;
    if (
      error instanceof PathPolicyError ||
      error instanceof TextFileError
    ) {
      return new ProjectServiceError(error.code, error.message, {
        cause: error,
      });
    }
    return new ProjectServiceError(code, errorMessage(error), {
      cause: error,
    });
  }
}
