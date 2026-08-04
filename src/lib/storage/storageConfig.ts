import { createHash } from 'node:crypto';

import { isStorageError, storageError } from './storageErrors';

export interface FileStorageConfig {
  readonly driver: 'file';
}

export interface MongoStorageConfig {
  readonly driver: 'mongo';
  readonly database: string;
  /**
   * Non-secret identity of the validated connection string. Existing callers
   * may omit this field, while getStorageConfig always supplies it so adapter
   * caches are invalidated when the effective MongoDB URI changes.
   */
  readonly connectionFingerprint?: string;
}

export type StorageConfig = FileStorageConfig | MongoStorageConfig;

function assertServerRuntime(): void {
  if (typeof window !== 'undefined') {
    throw storageError('STORAGE_CONFIG_SERVER_ONLY');
  }
}

function validatedMongoUri(uri: string | undefined): string {
  if (uri === undefined || uri.trim() === '') {
    throw storageError('MONGO_URI_REQUIRED');
  }

  const trimmed = uri.trim();
  if (
      trimmed.length > 4_096
      || /[\u0000-\u001f\u007f\s]/.test(trimmed)
  ) {
    throw storageError('MONGO_URI_INVALID');
  }

  try {
    const parsed = new URL(trimmed);
    const validProtocol =
        parsed.protocol === 'mongodb:'
        || parsed.protocol === 'mongodb+srv:';
    const validSrv =
        parsed.protocol !== 'mongodb+srv:'
        || (parsed.port === '' && !parsed.hostname.includes(','));

    if (
        !validProtocol
        || parsed.hostname === ''
        || parsed.hash !== ''
        || !validSrv
    ) {
      throw storageError('MONGO_URI_INVALID');
    }
  } catch (error) {
    if (isStorageError(error)) throw error;
    throw storageError('MONGO_URI_INVALID');
  }

  return trimmed;
}

function mongoConnectionFingerprint(uri: string): string {
  return createHash('sha256')
      .update(uri, 'utf8')
      .digest('hex');
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
  const driver = configuredDriver === undefined
      ? 'file'
      : configuredDriver.trim();

  if (driver === 'file') {
    return { driver: 'file' };
  }
  if (driver !== 'mongo') {
    throw storageError('INVALID_STORAGE_DRIVER');
  }

  const uri = validatedMongoUri(process.env.MONGODB_URI);
  return {
    driver: 'mongo',
    database: mongoDatabaseName(process.env.MONGODB_DATABASE),
    connectionFingerprint: mongoConnectionFingerprint(uri),
  };
}
