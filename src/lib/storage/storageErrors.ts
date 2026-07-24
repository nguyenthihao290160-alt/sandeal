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
  | 'INVALID_STORAGE_QUERY'
  | 'INVALID_STORAGE_PAYLOAD'
  | 'FILE_STORAGE_UNREACHABLE';

const SAFE_MESSAGES: Record<StorageErrorCode, string> = {
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
  INVALID_STORAGE_QUERY: 'Storage collection query is invalid.',
  INVALID_STORAGE_PAYLOAD: 'Storage collection payload is not safely serializable.',
  FILE_STORAGE_UNREACHABLE: 'File storage directory is not reachable.',
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, options: { cause?: unknown } = {}) {
    super(SAFE_MESSAGES[code], options);
    this.name = 'StorageError';
    this.code = code;
  }
}

export function storageError(code: StorageErrorCode, cause?: unknown): StorageError {
  return new StorageError(code, cause === undefined ? {} : { cause });
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

export function storageErrorCode(error: unknown, fallback: StorageErrorCode): StorageErrorCode {
  return isStorageError(error) ? error.code : fallback;
}
