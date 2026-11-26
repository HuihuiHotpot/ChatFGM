import type { DatabaseSync } from 'node:sqlite';
import { StorageError, errorMessage, isWriteDeniedSqliteError } from './errors';

export interface Migration {
  version: number;
  name: string;
  /** Table rebuilds preserve dependent rows with FK enforcement restored after commit. */
  rebuildsReferencedTables?: boolean;
  up(database: DatabaseSync): void;
}

/**
 * Every migration is small and self-contained. New schema must be appended
 * here; changing an already released migration is not allowed.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'window-state',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS window_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          content_width INTEGER NOT NULL,
          content_height INTEGER NOT NULL,
          maximized INTEGER NOT NULL CHECK (maximized IN (0, 1)),
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 2,
    name: 'projects-and-entries',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          path_key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          toolbox_id TEXT,
          created_at TEXT NOT NULL,
          last_opened_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS project_entries (
          project_id TEXT NOT NULL
            REFERENCES projects(id) ON DELETE CASCADE,
          entry_id TEXT PRIMARY KEY,
          parent_entry_id TEXT,
          name TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          relative_path_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
          UNIQUE (project_id, relative_path_key)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS project_entries_project_parent
          ON project_entries(project_id, parent_entry_id);
      `);
    },
  },
  {
    version: 3,
    name: 'workspace-and-recovery',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspace_layout (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS project_workspace (
          project_id TEXT PRIMARY KEY
            REFERENCES projects(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- Recovery drafts deliberately reference projects, not
        -- project_entries. A disk rescan may remove a missing file's identity
        -- row; the unsaved text must remain recoverable.
        CREATE TABLE IF NOT EXISTS recovery_drafts (
          project_id TEXT NOT NULL
            REFERENCES projects(id) ON DELETE CASCADE,
          file_identity TEXT NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, file_identity)
        ) STRICT;
      `);
    },
  },
  {
    version: 4,
    name: 'preserved-workspace-records',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspace_preserved_records (
          project_id TEXT NOT NULL
            REFERENCES projects(id) ON DELETE CASCADE,
          record_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, record_key)
        ) STRICT;
      `);
    },
  },
  {
    version: 5,
    name: 'saved-file-versions',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS saved_file_versions (
          project_id TEXT NOT NULL
            REFERENCES projects(id) ON DELETE CASCADE,
          file_identity TEXT NOT NULL,
          version TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, file_identity)
        ) STRICT;
      `);
    },
  },
  {
    version: 6,
    name: 'settings-and-secrets',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS settings_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS settings_service_secrets (
          service_id TEXT PRIMARY KEY,
          encrypted_key TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
      database
        .prepare(
          `INSERT OR IGNORE INTO settings_config
             (id, revision, payload, updated_at)
           VALUES (1, 0, ?, ?)`,
        )
        .run(
          JSON.stringify({
            version: 1,
            cli: { path: '' },
            models: {
              mode: 'chatgpt',
              activeServiceId: null,
              services: [],
            },
            toolboxes: { environments: [] },
          }),
          new Date().toISOString(),
        );
    },
  },
  {
    version: 7,
    name: 'chat-conversations-and-runs',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_chat_state (
          project_id TEXT PRIMARY KEY
            REFERENCES projects(id) ON DELETE CASCADE,
          active_conversation_id TEXT,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS chat_conversations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL
            REFERENCES projects(id) ON DELETE CASCADE,
          service_id TEXT NOT NULL,
          service_name TEXT,
          thread_id TEXT,
          account_identity_hash TEXT,
          title TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_label TEXT,
          effort_id TEXT,
          effort_label TEXT,
          permission_id TEXT NOT NULL,
          permission_label TEXT,
          draft TEXT NOT NULL,
          references_json TEXT NOT NULL,
          ui_json TEXT NOT NULL,
          summary_revision INTEGER NOT NULL CHECK (summary_revision >= 0),
          state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
          history_status TEXT NOT NULL CHECK (
            history_status IN ('unverified', 'ready', 'error')
          ),
          history_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS chat_conversations_project_updated
          ON chat_conversations(project_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL
            REFERENCES chat_conversations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          text TEXT NOT NULL,
          format TEXT NOT NULL CHECK (format IN ('text', 'markdown')),
          order_index INTEGER NOT NULL CHECK (order_index >= 0),
          created_at INTEGER NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          references_json TEXT NOT NULL DEFAULT '[]',
          run_id TEXT,
          turn_id TEXT,
          item_id TEXT,
          submission_id TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS chat_messages_conversation_order
          ON chat_messages(conversation_id, order_index, created_at);

        CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_conversation_item
          ON chat_messages(conversation_id, item_id)
          WHERE item_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS chat_runs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL
            REFERENCES chat_conversations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL,
          submission_id TEXT,
          turn_id TEXT,
          status TEXT NOT NULL CHECK (
            status IN ('running', 'completed', 'failed', 'stopped', 'unknown')
          ),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          settings_json TEXT NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          summary TEXT,
          tools_json TEXT,
          steps_json TEXT,
          last_error TEXT,
          runtime_instance_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS chat_runs_conversation_submission
          ON chat_runs(conversation_id, submission_id)
          WHERE submission_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS chat_runs_conversation_status
          ON chat_runs(conversation_id, status);

        CREATE TABLE IF NOT EXISTS chat_submissions (
          project_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL
            REFERENCES chat_conversations(id) ON DELETE CASCADE,
          submission_id TEXT NOT NULL,
          stage TEXT NOT NULL CHECK (
            stage IN (
              'prepared',
              'sending',
              'accepted',
              'finished',
              'unknown',
              'not-sent',
              'rejected'
            )
          ),
          input_json TEXT NOT NULL,
          digest TEXT NOT NULL,
          thread_id TEXT,
          turn_id TEXT,
          user_message_id TEXT,
          run_id TEXT,
          receipt_json TEXT,
          verification TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, conversation_id, submission_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS chat_submissions_conversation
          ON chat_submissions(conversation_id, stage, updated_at);

        CREATE TABLE IF NOT EXISTS chat_attachments (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL
            REFERENCES chat_conversations(id) ON DELETE CASCADE,
          original_name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (
            kind IN ('file', 'image', 'screenshot')
          ),
          mime TEXT NOT NULL,
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
          sha256 TEXT NOT NULL,
          storage_name TEXT NOT NULL,
          width INTEGER,
          height INTEGER,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS chat_attachments_conversation
          ON chat_attachments(conversation_id, created_at);
      `);
    },
  },
  {
    version: 8,
    name: 'chat-approvals-and-execution',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS chat_approvals (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL
            REFERENCES chat_conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          thread_id TEXT,
          item_id TEXT,
          method TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (
            kind IN ('command', 'file-change', 'permissions')
          ),
          request_key TEXT,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')
          ),
          runtime_instance_id TEXT,
          connection_generation INTEGER,
          created_at INTEGER NOT NULL,
          decided_at INTEGER
        ) STRICT;

        CREATE INDEX IF NOT EXISTS chat_approvals_conversation
          ON chat_approvals(conversation_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS chat_approvals_pending
          ON chat_approvals(status, conversation_id);
      `);
      // Actual execution facts. They belong to the run because a later turn in
      // the same conversation may use another environment or permission.
      database.exec(`
        ALTER TABLE chat_runs ADD COLUMN toolbox_name TEXT;
        ALTER TABLE chat_runs ADD COLUMN execution_cwd TEXT;
        ALTER TABLE chat_runs ADD COLUMN environment_path TEXT;
        ALTER TABLE chat_runs ADD COLUMN interpreter_path TEXT;
        ALTER TABLE chat_runs ADD COLUMN interpreter_version TEXT;
        ALTER TABLE chat_runs ADD COLUMN sandbox TEXT;
      `);
    },
  },
  {
    version: 9,
    name: 'project-path-ownership-history',
    rebuildsReferencedTables: true,
    up(database) {
      database.exec(`
        CREATE TABLE projects_next (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          path_key TEXT NOT NULL,
          name TEXT NOT NULL,
          toolbox_id TEXT,
          created_at TEXT NOT NULL,
          last_opened_at TEXT NOT NULL,
          retired_at TEXT
        ) STRICT;
        INSERT INTO projects_next
          (id,path,path_key,name,toolbox_id,created_at,last_opened_at)
          SELECT id,path,path_key,name,toolbox_id,created_at,last_opened_at FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_next RENAME TO projects;
        CREATE UNIQUE INDEX projects_current_path ON projects(path_key)
          WHERE retired_at IS NULL;
      `);
    },
  },
  {
    version: 10,
    name: 'confirmed-project-resource-cleanup',
    up(database) {
      // No history is removed by migration. These exact-file intents are
      // inserted only in an explicitly confirmed replacement transaction.
      database.exec(`
        CREATE TABLE project_resource_cleanup (
          replacement_project_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          storage_name TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          last_error TEXT,
          PRIMARY KEY (project_id, conversation_id, storage_name)
        ) STRICT;
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (latest, migration) => Math.max(latest, migration.version),
  0,
);

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  appliedVersions: readonly number[];
}

function assertMigrationPlan(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= previous
    ) {
      throw new StorageError(
        'migration-failed',
        '数据库迁移定义必须使用严格递增的整数版本。',
      );
    }
    previous = migration.version;
  }
}

export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as
    | { user_version?: unknown }
    | undefined;
  const value = row?.user_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new StorageError(
      'database-corrupt',
      '数据库 schema 版本不可读。',
    );
  }
  return value;
}

/**
 * Applies all pending migrations in one transaction. A failure rolls back the
 * bookkeeping table and every schema change, leaving the database at its
 * previous version instead of a half-migrated state.
 */
export function runMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  assertMigrationPlan(migrations);
  if (database.isTransaction) {
    throw new StorageError(
      'migration-failed',
      '数据库迁移不能在已打开的事务中执行。',
    );
  }

  const latestVersion = migrations.reduce(
    (latest, migration) => Math.max(latest, migration.version),
    0,
  );
  const fromVersion = readSchemaVersion(database);
  if (fromVersion > latestVersion) {
    throw new StorageError(
      'database-version-unsupported',
      `数据库 schema 版本 ${fromVersion} 高于当前应用支持的 ${latestVersion}，已停止启动以避免破坏数据。`,
    );
  }

  const pending = migrations.filter(
    (migration) => migration.version > fromVersion,
  );
  if (pending.length === 0) {
    return {
      fromVersion,
      toVersion: fromVersion,
      appliedVersions: [],
    };
  }

  let transactionOpen = false;
  const rebuild = pending.some((migration) => migration.rebuildsReferencedTables);
  const foreignKeys = (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  try {
    // SQLite cannot change foreign_keys inside a transaction. Rebuilding the
    // parent table with enforcement enabled would cascade-delete its children.
    if (rebuild) database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    for (const migration of pending) {
      migration.up(database);
      database
        .prepare(
          'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        )
        .run(
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
    }

    database.exec(`PRAGMA user_version = ${latestVersion}`);
    const storedVersion = readSchemaVersion(database);
    if (storedVersion !== latestVersion) {
      throw new Error(
        `迁移后 schema 版本为 ${storedVersion}，预期 ${latestVersion}。`,
      );
    }
    if (rebuild && database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('迁移后的项目外键检查失败。');
    }
    database.exec('COMMIT');
    transactionOpen = false;
    return {
      fromVersion,
      toVersion: latestVersion,
      appliedVersions: pending.map((migration) => migration.version),
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original migration error.
      }
    }
    if (error instanceof StorageError) throw error;
    if (isWriteDeniedSqliteError(error)) {
      throw new StorageError(
        'database-write-failed',
        `数据库不可写：${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw new StorageError(
      'migration-failed',
      `数据库迁移失败，已回滚：${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    if (rebuild) database.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}
