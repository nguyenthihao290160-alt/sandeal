export type StorageErrorCode =
    | 'INVALID_STORAGE_DRIVER'
    | 'STORAGE_CONFIG_SERVER_ONLY'
    | 'MONGO_URI_REQUIRED'
    | 'MONGO_URI_INVALID'
    | 'MONGO_DATABASE_INVALID'
    | 'MONGO_CONNECTION_FAILED'
    | 'MONGO_OPERATION_FAILED'
    | 'MONGO_TRANSACTION_FAILED'
    | 'MONGO_TRANSACTION_CONFLICT'
    | 'MONGO_SCHEMA_VERSION_MISMATCH'
    | 'INVALID_COLLECTION_NAME'
    | 'INVALID_STORAGE_COLLECTION'
    | 'INVALID_STORAGE_QUERY'
    | 'INVALID_STORAGE_PAYLOAD'
    | 'FILE_STORAGE_UNREACHABLE'
    | 'STORAGE_LOCK_TIMEOUT'
    | 'STORAGE_LOCK_LOST';

const SAFE_MESSAGES: Readonly<Record<StorageErrorCode, string>> = Object.freeze({
  INVALID_STORAGE_DRIVER: 'Invalid storage driver; expected "file" or "mongo".',
  STORAGE_CONFIG_SERVER_ONLY: 'Storage configuration is available only in the server runtime.',
  MONGO_URI_REQUIRED: 'Mongo storage requires MONGODB_URI.',
  MONGO_URI_INVALID: 'Mongo storage URI is invalid.',
  MONGO_DATABASE_INVALID: 'Mongo database name is invalid.',
  MONGO_CONNECTION_FAILED: 'Mongo storage connection failed.',
  MONGO_OPERATION_FAILED: 'Mongo storage operation failed.',
  MONGO_TRANSACTION_FAILED: 'Mongo storage transaction failed.',
  MONGO_TRANSACTION_CONFLICT: 'Mongo storage transaction detected a revision conflict.',
  MONGO_SCHEMA_VERSION_MISMATCH: 'Mongo storage schema version does not match the expected version.',
  INVALID_COLLECTION_NAME: 'Storage collection name is invalid.',
  INVALID_STORAGE_COLLECTION: 'File storage collection name or path is invalid.',
  INVALID_STORAGE_QUERY: 'Storage collection query is invalid.',
  INVALID_STORAGE_PAYLOAD: 'Storage collection payload is not safely serializable.',
  FILE_STORAGE_UNREACHABLE: 'File storage directory is not reachable.',
  STORAGE_LOCK_TIMEOUT: 'Storage collection lock acquisition timed out.',
  STORAGE_LOCK_LOST: 'Storage collection lock ownership was lost.',
});

const STORAGE_ERROR_CODES = new Set<StorageErrorCode>(
    Object.keys(SAFE_MESSAGES) as StorageErrorCode[],
);

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, options: { cause?: unknown } = {}) {
    super(SAFE_MESSAGES[code], options);
    this.name = 'StorageError';
    this.code = code;

    // Preserve instanceof behavior when this class is emitted through older
    // CommonJS/transpilation targets used by deterministic script tests.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function storageError(
    code: StorageErrorCode,
    cause?: unknown,
): StorageError {
  return new StorageError(
      code,
      cause === undefined ? {} : { cause },
  );
}

export function isStorageErrorCode(
    value: unknown,
): value is StorageErrorCode {
  return typeof value === 'string'
      && STORAGE_ERROR_CODES.has(value as StorageErrorCode);
}

export function isStorageError(error: unknown): error is StorageError {
  if (error instanceof StorageError) return true;

  // Accept a safely shaped StorageError crossing a module/cache boundary while
  // still requiring a known code. Callers only rely on name, message, and code.
  return Boolean(
      error
      && typeof error === 'object'
      && 'name' in error
      && (error as { name?: unknown }).name === 'StorageError'
      && 'code' in error
      && isStorageErrorCode((error as { code?: unknown }).code),
  );
}

export function storageErrorCode(
    error: unknown,
    fallback: StorageErrorCode,
): StorageErrorCode {
  if (isStorageError(error)) return error.code;

  // FileStorage lock errors intentionally carry a stable code without being
  // wrapped, so fencing and health diagnostics can preserve the root reason.
  if (
      error
      && typeof error === 'object'
      && 'code' in error
      && isStorageErrorCode((error as { code?: unknown }).code)
  ) {
    return (error as { code: StorageErrorCode }).code;
  }

  return fallback;
}
