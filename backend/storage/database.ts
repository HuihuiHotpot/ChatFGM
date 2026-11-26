import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  StorageError,
  errorMessage,
  isCorruptSqliteError,
  isWriteDeniedSqliteError,
} from './errors';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  readSchemaVersion,
  runMigrations,
  type Migration,
  type MigrationResult,
} from './migrations';
import type { WindowStateRecord } from './window-state';

export interface OpenDatabaseOptions {
  databasePath: string;
  migrations?: readonly Migration[];
}

interface WindowStateRow {
  x: number;
  y: number;
  content_width: number;
  content_height: number;
  maximized: number;
}

function latestVersionOf(migrations: readonly Migration[]): number {
  return migrations.reduce(
    (latest, migration) => Math.max(latest, migration.version),
    0,
  );
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ':memory:') return;
  try {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  } catch (error) {
    throw new StorageError(
      'data-directory-unavailable',
      `无法创建数据库目录 ${path.dirname(databasePath)}：${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function runIntegrityCheck(database: DatabaseSync): void {
  try {
    const rows = database.prepare('PRAGMA quick_check').all() as Array<
      Record<string, unknown>
    >;
    const first = rows[0] ? Object.values(rows[0])[0] : undefined;
    if (first !== 'ok') {
      throw new StorageError(
        'database-corrupt',
        `数据库完整性检查失败：${String(first ?? '无结果')}`,
      );
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (isCorruptSqliteError(error)) {
      throw new StorageError(
        'database-corrupt',
        `数据库文件损坏：${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw new StorageError(
      'database-open-failed',
      `数据库完整性检查无法执行：${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function configureWritableDatabase(database: DatabaseSync): void {
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    database.prepare('PRAGMA journal_mode = WAL').get();
    database.exec('PRAGMA synchronous = NORMAL');
    // A rolled-back write transaction proves that the file and its directory
    // can accept writes before any migration is attempted.
    database.exec('BEGIN IMMEDIATE');
    database.exec('ROLLBACK');
  } catch (error) {
    if (isWriteDeniedSqliteError(error)) {
      throw new StorageError(
        'database-write-failed',
        `应用数据目录或数据库不可写：${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw new StorageError(
      'database-open-failed',
      `数据库初始化失败：${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * The single owner of the SQLite connection. All access stays in the main
 * process; the renderer only receives startup facts through the desktop
 * bridge.
 */
export class ApplicationDatabase {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly schemaVersionValue: number;
  private transactionOpen = false;
  private closed = false;

  private constructor(
    databasePath: string,
    database: DatabaseSync,
    schemaVersion: number,
  ) {
    this.databasePath = databasePath;
    this.database = database;
    this.schemaVersionValue = schemaVersion;
  }

  static open(options: OpenDatabaseOptions): {
    database: ApplicationDatabase;
    migration: MigrationResult;
  } {
    const migrations = options.migrations ?? MIGRATIONS;
    const supportedVersion = latestVersionOf(migrations);
    ensureDatabaseDirectory(options.databasePath);

    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(options.databasePath, {
        timeout: 5000,
      });
    } catch (error) {
      if (isWriteDeniedSqliteError(error)) {
        throw new StorageError(
          'database-write-failed',
          `无法打开应用数据库（不可写或路径无效）：${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw new StorageError(
        'database-open-failed',
        `无法打开应用数据库：${errorMessage(error)}`,
        { cause: error },
      );
    }

    try {
      runIntegrityCheck(database);
      const version = readSchemaVersion(database);
      if (version > supportedVersion) {
        throw new StorageError(
          'database-version-unsupported',
          `数据库 schema 版本 ${version} 高于当前应用支持的 ${supportedVersion}，已停止启动以避免破坏数据。`,
        );
      }
      configureWritableDatabase(database);
      const migration = runMigrations(database, migrations);
      const schemaVersion = readSchemaVersion(database);
      if (schemaVersion !== supportedVersion) {
        throw new StorageError(
          'migration-failed',
          `数据库 schema 版本 ${schemaVersion} 与当前应用期望的 ${supportedVersion} 不一致。`,
        );
      }
      return {
        database: new ApplicationDatabase(
          options.databasePath,
          database,
          schemaVersion,
        ),
        migration,
      };
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the original startup error.
      }
      if (error instanceof StorageError) throw error;
      if (isCorruptSqliteError(error)) {
        throw new StorageError(
          'database-corrupt',
          `数据库文件损坏：${errorMessage(error)}`,
          { cause: error },
        );
      }
      throw new StorageError(
        'database-open-failed',
        `应用数据库初始化失败：${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  get schemaVersion(): number {
    return this.schemaVersionValue;
  }

  /** Main-process-only access for domain stores; never exposed to renderer. */
  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.requireOpen().prepare(sql);
  }

  get isOpen(): boolean {
    return !this.closed && this.database.isOpen;
  }

  readWindowState(): WindowStateRecord | null {
    const database = this.requireOpen();
    let row: WindowStateRow | undefined;
    try {
      row = database
        .prepare(
          'SELECT x, y, content_width, content_height, maximized FROM window_state WHERE id = 1',
        )
        .get() as WindowStateRow | undefined;
    } catch (error) {
      throw new StorageError(
        'database-open-failed',
        `读取窗口状态失败：${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!row) return null;
    const values = [
      row.x,
      row.y,
      row.content_width,
      row.content_height,
    ];
    if (
      values.some(
        (value) =>
          typeof value !== 'number' || !Number.isSafeInteger(value),
      ) ||
      (row.maximized !== 0 && row.maximized !== 1)
    ) {
      throw new StorageError(
        'database-corrupt',
        '窗口状态记录格式无效。',
      );
    }
    return {
      x: row.x,
      y: row.y,
      contentWidth: row.content_width,
      contentHeight: row.content_height,
      maximized: row.maximized === 1,
    };
  }

  writeWindowState(state: WindowStateRecord): void {
    const database = this.requireOpen();
    try {
      database
        .prepare(
          `INSERT INTO window_state
            (id, x, y, content_width, content_height, maximized, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             x = excluded.x,
             y = excluded.y,
             content_width = excluded.content_width,
             content_height = excluded.content_height,
             maximized = excluded.maximized,
             updated_at = excluded.updated_at`,
        )
        .run(
          state.x,
          state.y,
          state.contentWidth,
          state.contentHeight,
          state.maximized ? 1 : 0,
          new Date().toISOString(),
        );
    } catch (error) {
      throw new StorageError(
        'database-write-failed',
        `保存窗口状态失败：${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  runInTransaction<T>(operation: () => T): T {
    const database = this.requireOpen();
    if (this.transactionOpen || database.isTransaction) {
      throw new StorageError(
        'transaction-failed',
        '不支持嵌套数据库事务。',
      );
    }
    this.transactionOpen = true;
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the original operation error.
        }
        if (error instanceof StorageError) throw error;
        throw new StorageError(
          'transaction-failed',
          `数据库事务失败，已回滚：${errorMessage(error)}`,
          { cause: error },
        );
      }
    } finally {
      this.transactionOpen = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.database.isOpen) {
      try {
        this.database.close();
      } catch (error) {
        throw new StorageError(
          'database-open-failed',
          `关闭数据库失败：${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
  }

  private requireOpen(): DatabaseSync {
    if (!this.isOpen) {
      throw new StorageError('database-closed', '数据库已关闭。');
    }
    return this.database;
  }
}

export { LATEST_SCHEMA_VERSION };
