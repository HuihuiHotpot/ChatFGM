import { randomUUID } from 'node:crypto';
import type { ApplicationDatabase } from '../storage/database';
import type { DiskNode } from '../filesystem/types';

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  pathKey: string;
  toolboxId: string | null;
  createdAt: string;
  lastOpenedAt: string;
  retiredAt: string | null;
}

export interface EntryRecord {
  projectId: string;
  entryId: string;
  parentEntryId: string | null;
  name: string;
  relativePath: string;
  relativePathKey: string;
  kind: 'file' | 'folder';
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  path_key: string;
  toolbox_id: string | null;
  created_at: string;
  last_opened_at: string;
  retired_at: string | null;
}

interface EntryRow {
  project_id: string;
  entry_id: string;
  parent_entry_id: string | null;
  name: string;
  relative_path: string;
  relative_path_key: string;
  kind: 'file' | 'folder';
}

export function keyForPath(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

function relativePathKey(value: string): string {
  return keyForPath(value.replace(/\\+$/, ''));
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    pathKey: row.path_key,
    toolboxId: row.toolbox_id,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    retiredAt: row.retired_at,
  };
}

function entryFromRow(row: EntryRow): EntryRecord {
  return {
    projectId: row.project_id,
    entryId: row.entry_id,
    parentEntryId: row.parent_entry_id,
    name: row.name,
    relativePath: row.relative_path,
    relativePathKey: row.relative_path_key,
    kind: row.kind,
  };
}

export class ProjectStore {
  private readonly database: ApplicationDatabase;

  constructor(database: ApplicationDatabase) {
    this.database = database;
  }

  findProjectByPathKey(pathKey: string): ProjectRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM projects WHERE path_key = ? AND retired_at IS NULL',
      )
      .get(pathKey) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  listProjectsByPathKey(pathKey: string): ProjectRecord[] {
    return (this.database.prepare(
      'SELECT * FROM projects WHERE path_key=? ORDER BY retired_at IS NOT NULL, id',
    ).all(pathKey) as unknown as ProjectRow[]).map(projectFromRow);
  }
  getProject(projectId: string): ProjectRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM projects WHERE id = ?',
      )
      .get(projectId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  listRecent(limit = 12): ProjectRecord[] {
    const rows = this.database
      .prepare(
        'SELECT * FROM projects WHERE retired_at IS NULL ORDER BY last_opened_at DESC, id LIMIT ?',
      )
      .all(limit) as unknown as ProjectRow[];
    return rows.map(projectFromRow);
  }

  createProject(input: {
    id?: string;
    name: string;
    path: string;
    pathKey: string;
    toolboxId: string | null;
    now?: string;
  }): ProjectRecord {
    const now = input.now ?? new Date().toISOString();
    const project: ProjectRecord = {
      id: input.id ?? randomUUID(),
      name: input.name,
      path: input.path,
      pathKey: input.pathKey,
      toolboxId: input.toolboxId,
      createdAt: now,
      lastOpenedAt: now,
      retiredAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO projects
           (id, name, path, path_key, toolbox_id, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.path,
        project.pathKey,
        project.toolboxId,
        project.createdAt,
        project.lastOpenedAt,
      );
    return project;
  }

  recordSavedVersion(
    projectId: string,
    fileIdentity: string,
    version: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO saved_file_versions
           (project_id, file_identity, version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, file_identity) DO UPDATE SET
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, fileIdentity, version, new Date().toISOString());
  }

  deleteProject(projectId: string): void {
    this.database
      .prepare('DELETE FROM projects WHERE id = ?')
      .run(projectId);
  }

  retireProject(projectId: string): void {
    const result = this.database.prepare(
      'UPDATE projects SET retired_at = ? WHERE id = ? AND retired_at IS NULL',
    ).run(new Date().toISOString(), projectId);
    if (Number(result.changes) !== 1) throw new Error('项目路径归属已经改变，请重新选择。');
  }

  touchProject(projectId: string, now = new Date().toISOString()): void {
    this.database
      .prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?')
      .run(now, projectId);
  }

  /** Binds an unbound project without touching its last-opened timestamp. */
  setToolboxId(projectId: string, toolboxId: string): void {
    const result = this.database
      .prepare(
        'UPDATE projects SET toolbox_id = ? WHERE id = ? AND (toolbox_id IS NULL OR toolbox_id = \'\')',
      )
      .run(toolboxId, projectId);
    if (Number(result.changes) !== 1) {
      throw new Error('project toolbox is already bound');
    }
  }

  listEntries(projectId: string): EntryRecord[] {
    const rows = this.database
      .prepare(
        `SELECT project_id, entry_id, parent_entry_id, name,
                relative_path, relative_path_key, kind
           FROM project_entries
          WHERE project_id = ?
          ORDER BY relative_path_key`,
      )
      .all(projectId) as unknown as EntryRow[];
    return rows.map(entryFromRow);
  }

  getEntry(projectId: string, entryId: string): EntryRecord | null {
    const row = this.database
      .prepare(
        `SELECT project_id, entry_id, parent_entry_id, name,
                relative_path, relative_path_key, kind
           FROM project_entries
          WHERE project_id = ? AND entry_id = ?`,
      )
      .get(projectId, entryId) as EntryRow | undefined;
    return row ? entryFromRow(row) : null;
  }

  findEntryByRelativePath(
    projectId: string,
    relativePath: string,
  ): EntryRecord | null {
    const row = this.database
      .prepare(
        `SELECT project_id, entry_id, parent_entry_id, name,
                relative_path, relative_path_key, kind
           FROM project_entries
          WHERE project_id = ? AND relative_path_key = ?`,
      )
      .get(projectId, relativePathKey(relativePath)) as EntryRow | undefined;
    return row ? entryFromRow(row) : null;
  }

  /**
   * Reconciles the persisted identity map against the current disk tree. Paths
   * are only evidence for reconnect; an app rename/move must call
   * moveEntryTree first so identities are retained.
   */
  syncDiskTree(projectId: string, nodes: readonly DiskNode[], inTransaction = false): EntryRecord[] {
    const reconcile = () => {
      const existingRows = this.database
        .prepare(
          `SELECT project_id, entry_id, parent_entry_id, name,
                  relative_path, relative_path_key, kind
             FROM project_entries WHERE project_id = ?`,
        )
        .all(projectId) as unknown as EntryRow[];
      const existingByPath = new Map(
        existingRows.map((row) => [row.relative_path_key, row]),
      );
      const seen = new Set<string>();
      const records: EntryRecord[] = [];

      const visit = (
        list: readonly DiskNode[],
        parentEntryId: string | null,
      ): void => {
        for (const node of list) {
          const pathKey = relativePathKey(node.relativePath);
          seen.add(pathKey);
          const existing = existingByPath.get(pathKey);
          const record: EntryRecord = {
            projectId,
            entryId: existing?.entry_id ?? randomUUID(),
            parentEntryId,
            name: node.name,
            relativePath: node.relativePath,
            relativePathKey: pathKey,
            kind: node.kind,
          };
          if (existing) {
            this.database
              .prepare(
                `UPDATE project_entries
                    SET parent_entry_id = ?, name = ?, relative_path = ?,
                        relative_path_key = ?, kind = ?
                  WHERE project_id = ? AND entry_id = ?`,
              )
              .run(
                record.parentEntryId,
                record.name,
                record.relativePath,
                record.relativePathKey,
                record.kind,
                projectId,
                record.entryId,
              );
          } else {
            this.database
              .prepare(
                `INSERT INTO project_entries
                   (project_id, entry_id, parent_entry_id, name,
                    relative_path, relative_path_key, kind)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                record.projectId,
                record.entryId,
                record.parentEntryId,
                record.name,
                record.relativePath,
                record.relativePathKey,
                record.kind,
              );
          }
          records.push(record);
          visit(node.children, record.entryId);
        }
      };
      visit(nodes, null);

      for (const row of existingRows) {
        if (seen.has(row.relative_path_key)) continue;
        this.database
          .prepare(
            'DELETE FROM project_entries WHERE project_id = ? AND entry_id = ?',
          )
          .run(projectId, row.entry_id);
      }
      return records;
    };
    return inTransaction ? reconcile() : this.database.runInTransaction(reconcile);
  }

  /**
   * Updates the root and every descendant in one transaction. It is called
   * before the post-operation scan so the new paths reuse the old identities.
   */
  moveEntryTree(input: {
    projectId: string;
    entryId: string;
    newName: string;
    newRelativePath: string;
    newParentEntryId: string | null;
  }): EntryRecord[] {
    return this.database.runInTransaction(() => {
      const rows = this.database
        .prepare(
          `SELECT project_id, entry_id, parent_entry_id, name,
                  relative_path, relative_path_key, kind
             FROM project_entries WHERE project_id = ?`,
        )
        .all(input.projectId) as unknown as EntryRow[];
      const root = rows.find((row) => row.entry_id === input.entryId);
      if (!root) throw new Error('目录项身份不存在。');
      const oldPrefix = root.relative_path_key;
      const newPrefix = relativePathKey(input.newRelativePath);
      const affected = rows.filter(
        (row) =>
          row.relative_path_key === oldPrefix ||
          row.relative_path_key.startsWith(`${oldPrefix}\\`),
      );
      for (const row of affected) {
        const suffix = row.relative_path_key.slice(oldPrefix.length);
        const nextRelativePath =
          row.entry_id === root.entry_id
            ? input.newRelativePath
            : `${input.newRelativePath}${suffix}`;
        const nextPathKey = `${newPrefix}${suffix}`;
        const nextName =
          row.entry_id === root.entry_id ? input.newName : row.name;
        const nextParent =
          row.entry_id === root.entry_id
            ? input.newParentEntryId
            : row.parent_entry_id;
        this.database
          .prepare(
            `UPDATE project_entries
                SET parent_entry_id = ?, name = ?, relative_path = ?,
                    relative_path_key = ?
              WHERE project_id = ? AND entry_id = ?`,
          )
          .run(
            nextParent,
            nextName,
            nextRelativePath,
            nextPathKey,
            input.projectId,
            row.entry_id,
          );
      }
      return affected.map((row) => {
        const suffix = row.relative_path_key.slice(oldPrefix.length);
        return {
          ...entryFromRow(row),
          parentEntryId:
            row.entry_id === root.entry_id
              ? input.newParentEntryId
              : row.parent_entry_id,
          name: row.entry_id === root.entry_id ? input.newName : row.name,
          relativePath:
            row.entry_id === root.entry_id
              ? input.newRelativePath
              : `${input.newRelativePath}${suffix}`,
          relativePathKey: `${newPrefix}${suffix}`,
        };
      });
    });
  }

  deleteEntryTree(projectId: string, entryId: string): EntryRecord[] {
    return this.database.runInTransaction(() => {
      const rows = this.database
        .prepare(
          `SELECT project_id, entry_id, parent_entry_id, name,
                  relative_path, relative_path_key, kind
             FROM project_entries WHERE project_id = ?`,
        )
        .all(projectId) as unknown as EntryRow[];
      const root = rows.find((row) => row.entry_id === entryId);
      if (!root) throw new Error('目录项身份不存在。');
      const prefix = root.relative_path_key;
      const affected = rows.filter(
        (row) =>
          row.relative_path_key === prefix ||
          row.relative_path_key.startsWith(`${prefix}\\`),
      );
      const statement = this.database.prepare(
        'DELETE FROM project_entries WHERE project_id = ? AND entry_id = ?',
      );
      for (const row of affected) {
        statement.run(projectId, row.entry_id);
      }
      return affected.map(entryFromRow);
    });
  }
}

