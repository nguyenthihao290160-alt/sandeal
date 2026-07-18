import { isStorageError, storageError } from './storageErrors';

export interface FileStorageConfig {
  readonly driver: 'file';
}

export interface MongoStorageConfig {
  readonly driver: 'mongo';
  readonly database: string;
}

export type StorageConfig = FileStorageConfig | MongoStorageConfig;

function assertServerRuntime(): void {
  if (typeof window !== 'undefined') {
    throw storageError('STORAGE_CONFIG_SERVER_ONLY');
  }
}

function validateMongoUri(uri: string | undefined): void {
  if (uri === undefined || uri.trim() === '') throw storageError('MONGO_URI_REQUIRED');
  const trimmed = uri.trim();
  try {
    const parsed = new URL(trimmed);
    const validProtocol = parsed.protocol === 'mongodb:' || parsed.protocol === 'mongodb+srv:';
    const validSrv = parsed.protocol !== 'mongodb+srv:' || (parsed.port === '' && !parsed.hostname.includes(','));
    if (
      trimmed.length > 4_096
      || /[\u0000-\u001f\u007f\s]/.test(trimmed)
      || !validProtocol
      || parsed.hostname === ''
      || !validSrv
    ) {
      throw storageError('MONGO_URI_INVALID');
    }
  } catch (error) {
    if (isStorageError(error)) throw error;
    throw storageError('MONGO_URI_INVALID');
  }
}

function mongoDatabaseName(value: string | undefined): string {
  const database = value === undefined ? 'sandeal' : value.trim();
  if (
    database === ''
    || Buffer.byteLength(database, 'utf8') > 63
    || /[\x00/\\."$*<>:|?]/.test(database)
  ) {
    throw storageError('MONGO_DATABASE_INVALID');
  }
  return database;
}

export function getStorageConfig(): StorageConfig {
  assertServerRuntime();
  const configuredDriver = process.env.SANDEAL_STORAGE_DRIVER;
  const driver = configuredDriver === undefined ? 'file' : configuredDriver.trim();

  if (driver === 'file') return { driver };
  if (driver !== 'mongo') throw storageError('INVALID_STORAGE_DRIVER');

  validateMongoUri(process.env.MONGODB_URI);
  return { driver, database: mongoDatabaseName(process.env.MONGODB_DATABASE) };
}
