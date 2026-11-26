export type StorageErrorCode =
  | 'data-directory-unavailable'
  | 'database-open-failed'
  | 'database-write-failed'
  | 'database-corrupt'
  | 'database-version-unsupported'
  | 'migration-failed'
  | 'transaction-failed'
  | 'database-closed';

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isCorruptSqliteError(error: unknown): boolean {
  const message = errorMessage(error);
  return /not a database|malformed|corrupt|SQLITE_NOTADB|disk image/i.test(
    message,
  );
}

export function isWriteDeniedSqliteError(error: unknown): boolean {
  const message = errorMessage(error);
  return /readonly|read-only|permission|EACCES|EPERM|SQLITE_READONLY|unable to open database file|SQLITE_CANTOPEN/i.test(
    message,
  );
}
