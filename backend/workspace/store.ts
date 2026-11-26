import { createHash } from 'node:crypto';
import type {
  ProjectWorkspaceRecord,
  ProjectWorkspaceSnapshot,
  WorkspaceLayoutRecord,
  WorkspaceLayoutSnapshot,
  WorkspaceTabDraft,
} from '../ipc/workspace';
import type { ApplicationDatabase } from '../storage/database';
import {
  WorkspaceStoreError,
  parseDraftPayload,
  parseLayoutSnapshot,
  parseProjectWorkspace,
  parseProjectWorkspaceLenient,
  parseRevision,
  type CorruptWorkspaceTab,
} from './validate';

interface LayoutRow {
  revision: number;
  payload: string;
}

interface ProjectWorkspaceRow {
  revision: number;
  payload: string;
}

interface DraftRow {
  file_identity: string;
  payload: string;
  updated_at: string;
}

interface EntryRow {
  entry_id: string;
  kind: 'file' | 'folder';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStored<T>(
  payload: string,
  label: string,
  parser: (value: unknown) => T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new WorkspaceStoreError(
      'workspace-corrupt',
      `${label}不是有效的工作区记录，已保留原数据库内容。`,
      { cause: error },
    );
  }
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof WorkspaceStoreError) {
      throw new WorkspaceStoreError(
        'workspace-corrupt',
        `${label}校验失败，已保留原数据库内容：${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function tabPayload(snapshot: ProjectWorkspaceSnapshot): unknown {
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => ({
      identity: tab.identity,
      name: tab.name,
      path: tab.path,
      viewerKind: tab.viewerKind,
      view: tab.view,
    })),
  };
}

export class WorkspaceStore {
  private readonly database: ApplicationDatabase;

  constructor(database: ApplicationDatabase) {
    this.database = database;
  }

  loadLayout(): WorkspaceLayoutRecord {
    const row = this.database
      .prepare(
        'SELECT revision, payload FROM workspace_layout WHERE id = 1',
      )
      .get() as LayoutRow | undefined;
    if (!row) return { snapshot: null, revision: 0 };
    const revision = parseRevision(row.revision, 'layout revision');
    const snapshot = parseStored(
      row.payload,
      '布局状态',
      parseLayoutSnapshot,
    );
    return { snapshot, revision };
  }

  saveLayout(
    snapshot: WorkspaceLayoutSnapshot,
    expectedRevision: number,
  ): number {
    const parsed = parseLayoutSnapshot(snapshot);
    const expected = parseRevision(expectedRevision, 'expectedRevision');
    try {
      return this.database.runInTransaction(() => {
        const row = this.database
          .prepare(
            'SELECT revision, payload FROM workspace_layout WHERE id = 1',
          )
          .get() as LayoutRow | undefined;
        const current = row ? row.revision : 0;
        if (current !== expected) {
          throw new WorkspaceStoreError(
            'workspace-revision-conflict',
            '布局状态已被更新的快照替换，本次写入已拒绝。',
          );
        }
        const next = current + 1;
        this.database
          .prepare(
            `INSERT INTO workspace_layout (id, revision, payload, updated_at)
             VALUES (1, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               revision = excluded.revision,
               payload = excluded.payload,
               updated_at = excluded.updated_at`,
          )
          .run(next, JSON.stringify(parsed), new Date().toISOString());
        return next;
      });
    } catch (error) {
      if (error instanceof WorkspaceStoreError) throw error;
      if (
        error instanceof Error &&
        error.cause instanceof WorkspaceStoreError
      ) {
        throw error.cause;
      }
      throw new WorkspaceStoreError(
        'workspace-save-failed',
        `布局状态保存失败，上一份有效记录已保留：${errorText(error)}`,
        { cause: error },
      );
    }
  }

  loadProject(projectId: string): ProjectWorkspaceRecord {
    const project = this.database
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as { id: string } | undefined;
    if (!project) {
      throw new WorkspaceStoreError(
        'workspace-project-not-found',
        '项目不存在，无法读取工作区状态。',
      );
    }
    const entryNames = new Map(
      (
        this.database
          .prepare(
            'SELECT entry_id, name FROM project_entries WHERE project_id = ?',
          )
          .all(projectId) as unknown as Array<{
          entry_id: string;
          name: string;
        }>
      ).map((row) => [row.entry_id, row.name]),
    );
    const resolveIdentityName = (identity: string): string | null =>
      entryNames.get(identity) ?? null;
    const row = this.database
      .prepare(
        'SELECT revision, payload FROM project_workspace WHERE project_id = ?',
      )
      .get(projectId) as ProjectWorkspaceRow | undefined;
    if (!row) return { snapshot: null, revision: 0 };
    const revision = parseRevision(row.revision, 'workspace revision');
    let snapshot: ProjectWorkspaceSnapshot;
    let corruptTabIds: string[] = [];
    let corruptTabCount = 0;
    try {
      snapshot = parseStored(
        row.payload,
        '项目工作区',
        parseProjectWorkspace,
      );
    } catch (error) {
      let raw: unknown;
      try {
        raw = JSON.parse(row.payload);
      } catch {
        throw new WorkspaceStoreError(
          'workspace-corrupt',
          '项目工作区不是有效 JSON，原记录已保留；无法安全恢复。',
          { cause: error },
        );
      }
      try {
        const lenient = parseProjectWorkspaceLenient(
          raw,
          resolveIdentityName,
        );
        snapshot = lenient.snapshot;
        corruptTabIds = lenient.corruptTabIds;
        corruptTabCount = lenient.corruptTabCount;
      } catch (lenientError) {
        throw new WorkspaceStoreError(
          'workspace-corrupt',
          '项目工作区结构损坏，原记录已保留；无法安全恢复。',
          { cause: lenientError },
        );
      }
    }
    const draftRows = this.database
      .prepare(
        'SELECT file_identity, payload FROM recovery_drafts WHERE project_id = ? ORDER BY file_identity',
      )
      .all(projectId) as unknown as DraftRow[];
    const drafts = new Map<string, WorkspaceTabDraft>();
    const corruptDraftIds: string[] = [];
    for (const draftRow of draftRows) {
      try {
        const parsed = parseDraftPayload(
          JSON.parse(draftRow.payload) as unknown,
        );
        drafts.set(draftRow.file_identity, parsed);
      } catch {
        // Keep this row untouched. A later healthy save must not delete it.
        corruptDraftIds.push(draftRow.file_identity);
      }
    }
    const savedVersionRows = this.database
      .prepare(
        'SELECT file_identity, version FROM saved_file_versions WHERE project_id = ?',
      )
      .all(projectId) as unknown as Array<{
      file_identity: string;
      version: string;
    }>;
    const savedVersions = Object.fromEntries(
      savedVersionRows.map((row) => [row.file_identity, row.version]),
    );
    return {
      revision,
      ...(corruptTabIds.length > 0 ? { corruptTabIds } : {}),
      ...(corruptTabCount > 0 ? { corruptTabCount } : {}),
      ...(corruptDraftIds.length > 0 ? { corruptDraftIds } : {}),
      ...(savedVersionRows.length > 0 ? { savedVersions } : {}),
      snapshot: {
        ...snapshot,
        tabs: snapshot.tabs.map((tab) => {
          const draft = drafts.get(tab.identity);
          return draft ? { ...tab, draft } : tab;
        }),
      },
    };
  }

  saveProject(
    projectId: string,
    snapshot: ProjectWorkspaceSnapshot,
    expectedRevision: number,
  ): number {
    const parsed = parseProjectWorkspace(snapshot);
    const expected = parseRevision(expectedRevision, 'expectedRevision');
    try {
      return this.database.runInTransaction(() => {
        const project = this.database
          .prepare('SELECT id FROM projects WHERE id = ?')
          .get(projectId) as { id: string } | undefined;
        if (!project) {
          throw new WorkspaceStoreError(
            'workspace-project-not-found',
            '项目不存在，无法保存工作区状态。',
          );
        }
        this.assertProjectOwnership(projectId, parsed);
        const row = this.database
          .prepare(
            'SELECT revision, payload FROM project_workspace WHERE project_id = ?',
          )
          .get(projectId) as ProjectWorkspaceRow | undefined;
        const current = row ? row.revision : 0;
        if (current !== expected) {
          throw new WorkspaceStoreError(
            'workspace-revision-conflict',
            '项目工作区已被更新的快照替换，本次写入已拒绝。',
          );
        }
        let currentLenient: ReturnType<
          typeof parseProjectWorkspaceLenient
        > | null = null;
        if (row && !this.isStrictSnapshot(row.payload)) {
          let currentRaw: unknown;
          try {
            currentRaw = JSON.parse(row.payload);
          } catch (error) {
            throw new WorkspaceStoreError(
              'workspace-corrupt',
              '项目工作区不是有效 JSON，原记录已保留；本次写入已拒绝。',
              { cause: error },
            );
          }
          try {
            currentLenient = parseProjectWorkspaceLenient(
              currentRaw,
              this.entryNameResolver(projectId),
            );
          } catch (error) {
            throw new WorkspaceStoreError(
              'workspace-corrupt',
              '项目工作区结构损坏，原记录已保留；本次写入已拒绝。',
              { cause: error },
            );
          }
          // Keep the corrupted original snapshot traceable while the user
          // continues with the healthy subset. It is intentionally not the
          // active read row anymore.
          this.database
            .prepare(
              `INSERT OR IGNORE INTO workspace_preserved_records
                 (project_id, record_key, payload, updated_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(
              projectId,
              `snapshot:${current}`,
              row.payload,
              new Date().toISOString(),
            );
        }
        const oldDrafts = this.database
          .prepare(
            `SELECT file_identity, payload, updated_at
               FROM recovery_drafts WHERE project_id = ?`,
          )
          .all(projectId) as unknown as DraftRow[];
        const nextDraftIds = new Set(
          parsed.tabs
            .filter((tab) => Boolean(tab.draft))
            .map((tab) => tab.identity),
        );
        const preservedCorruptDrafts = oldDrafts.filter(
          (draft) =>
            !nextDraftIds.has(draft.file_identity) &&
            !this.isValidDraft(draft.payload),
        );
        const protectedDrafts = new Map<
          string,
          {
            reason: string;
            tab: unknown;
            relatedTabs: unknown[];
          }
        >();
        for (const draft of oldDrafts) {
          if (!this.isValidDraft(draft.payload)) {
            protectedDrafts.set(draft.file_identity, {
              reason: 'draft-payload-invalid',
              tab: null,
              relatedTabs: [],
            });
          }
        }
        if (currentLenient) {
          const skipped = currentLenient.corruptTabs.filter(
            (tab) => !tab.recovered,
          );
          const skippedByIdentity = new Map<
            string,
            CorruptWorkspaceTab
          >();
          for (const tab of skipped) {
            if (tab.identity && !tab.collision) {
              skippedByIdentity.set(tab.identity, tab);
            }
          }
          const unidentified = skipped.some((tab) => !tab.identity);
          const relatedTabs = currentLenient.corruptTabs
            .filter(
              (tab) => tab.collision || !tab.recovered || !tab.identity,
            )
            .map((tab) => tab.raw);
          const healthyIdentities = new Set(
            currentLenient.snapshot.tabs.map((tab) => tab.identity),
          );
          const ambiguousIdentity =
            currentLenient.identityCollision || unidentified;
          for (const draft of oldDrafts) {
            if (!this.isValidDraft(draft.payload)) continue;
            const skippedTab = skippedByIdentity.get(draft.file_identity);
            if (skippedTab) {
              protectedDrafts.set(draft.file_identity, {
                reason: 'tab-metadata-unrecovered',
                tab: skippedTab.raw,
                relatedTabs: [],
              });
            } else if (
              ambiguousIdentity &&
              !healthyIdentities.has(draft.file_identity)
            ) {
              protectedDrafts.set(draft.file_identity, {
                reason: currentLenient.identityCollision
                  ? 'identity-collision-unresolved'
                  : 'unidentified-tab-metadata',
                tab: null,
                relatedTabs,
              });
            }
          }
        }
        const now = new Date().toISOString();
        for (const draft of oldDrafts) {
          const protection = protectedDrafts.get(draft.file_identity);
          if (!protection) continue;
          this.archiveUnrestoredDraft(
            projectId,
            draft,
            current,
            protection.reason,
            protection.tab,
            protection.relatedTabs,
            now,
          );
        }
        const next = current + 1;
        const encoded = JSON.stringify(tabPayload(parsed));
        if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024 * 1024) {
          throw new WorkspaceStoreError(
            'invalid-workspace',
            '项目工作区超过大小限制。',
          );
        }
        this.database
          .prepare(
            `INSERT INTO project_workspace
               (project_id, revision, payload, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               revision = excluded.revision,
               payload = excluded.payload,
               updated_at = excluded.updated_at`,
          )
          .run(projectId, next, encoded, now);
        this.database
          .prepare('DELETE FROM recovery_drafts WHERE project_id = ?')
          .run(projectId);
        const insertDraft = this.database.prepare(
          `INSERT INTO recovery_drafts
             (project_id, file_identity, payload, updated_at)
           VALUES (?, ?, ?, ?)`,
        );
        for (const draft of preservedCorruptDrafts) {
          insertDraft.run(
            projectId,
            draft.file_identity,
            draft.payload,
            draft.updated_at,
          );
        }
        for (const tab of parsed.tabs) {
          if (!tab.draft) continue;
          const payload = JSON.stringify(tab.draft);
          if (
            Buffer.byteLength(payload, 'utf8') >
            2 * 32 * 1024 * 1024
          ) {
            throw new WorkspaceStoreError(
              'invalid-workspace',
              '恢复副本超过大小限制。',
            );
          }
          insertDraft.run(projectId, tab.identity, payload, now);
        }
        return next;
      });
    } catch (error) {
      if (error instanceof WorkspaceStoreError) throw error;
      if (
        error instanceof Error &&
        error.cause instanceof WorkspaceStoreError
      ) {
        throw error.cause;
      }
      throw new WorkspaceStoreError(
        'workspace-save-failed',
        `项目工作区保存失败，上一份有效记录已保留：${errorText(error)}`,
        { cause: error },
      );
    }
  }

  private entryNameResolver(
    projectId: string,
  ): (identity: string) => string | null {
    const names = new Map(
      (
        this.database
          .prepare(
            'SELECT entry_id, name FROM project_entries WHERE project_id = ?',
          )
          .all(projectId) as unknown as Array<{
          entry_id: string;
          name: string;
        }>
      ).map((row) => [row.entry_id, row.name]),
    );
    return (identity) => names.get(identity) ?? null;
  }

  private archiveUnrestoredDraft(
    projectId: string,
    draft: DraftRow,
    sourceRevision: number,
    reason: string,
    tab: unknown,
    relatedTabs: unknown[],
    archivedAt: string,
  ): void {
    let parsedDraft: WorkspaceTabDraft | null = null;
    try {
      parsedDraft = parseDraftPayload(
        JSON.parse(draft.payload) as unknown,
      );
    } catch {
      // rawDraft below still preserves an invalid body in full.
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          projectId,
          fileIdentity: draft.file_identity,
          reason,
          tab,
          relatedTabs,
          rawDraft: draft.payload,
        }),
      )
      .digest('hex')
      .slice(0, 24);
    const recordKey = `unrestored-draft:${draft.file_identity}:${digest}`;
    const payload = JSON.stringify({
      version: 1,
      kind: 'unrestored-recovery-draft',
      projectId,
      fileIdentity: draft.file_identity,
      reason,
      sourceRevision,
      archivedAt,
      tab: tab ?? null,
      relatedTabs,
      draft: parsedDraft,
      rawDraft: draft.payload,
    });
    this.database
      .prepare(
        `INSERT OR IGNORE INTO workspace_preserved_records
           (project_id, record_key, payload, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, recordKey, payload, archivedAt);
  }

  private isStrictSnapshot(payload: string): boolean {
    try {
      parseProjectWorkspace(JSON.parse(payload) as unknown);
      return true;
    } catch {
      return false;
    }
  }

  private isValidDraft(payload: string): boolean {
    try {
      parseDraftPayload(JSON.parse(payload) as unknown);
      return true;
    } catch {
      return false;
    }
  }

  private assertProjectOwnership(
    projectId: string,
    snapshot: ProjectWorkspaceSnapshot,
  ): void {
    const rows = this.database
      .prepare(
        'SELECT entry_id, kind FROM project_entries WHERE project_id = ?',
      )
      .all(projectId) as unknown as EntryRow[];
    const entries = new Map(rows.map((row) => [row.entry_id, row.kind]));
    for (const id of snapshot.expandedIds) {
      if (entries.get(id) !== 'folder') {
        throw new WorkspaceStoreError(
          'invalid-workspace',
          '展开目录不属于当前项目或不是目录。',
        );
      }
    }
    if (snapshot.selectedId !== null && !entries.has(snapshot.selectedId)) {
      throw new WorkspaceStoreError(
        'invalid-workspace',
        '选中的目录项不属于当前项目。',
      );
    }
    for (const tab of snapshot.tabs) {
      const kind = entries.get(tab.identity);
      if (kind === undefined) {
        if (!tab.draft) {
          throw new WorkspaceStoreError(
            'invalid-workspace',
            '干净文件标签不属于当前项目。',
          );
        }
        // A missing file with an unsaved recovery draft is intentionally
        // allowed; the database must not cascade it away with the entry.
        continue;
      }
      if (kind !== 'file') {
        throw new WorkspaceStoreError(
          'invalid-workspace',
          '标签身份不是文件。',
        );
      }
    }
  }
}

export { WorkspaceStoreError };
