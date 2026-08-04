import { fileStorageAdapter } from './fileStorageAdapter';
import {
  getStorageConfig,
  type MongoStorageConfig,
} from './storageConfig';
import type { StorageAdapter } from './types';

let mongoAdapter: StorageAdapter | undefined;
let mongoAdapterConfigKey: string | undefined;

/**
 * Cache Mongo adapters only when the complete effective configuration matches.
 * Caching by database name alone can incorrectly reuse an adapter after a URI,
 * credential, option, or deployment target changes while the database name
 * remains the same.
 */
function mongoConfigKey(config: MongoStorageConfig): string {
  return JSON.stringify(
      Object.entries(config)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, value ?? null]),
  );
}

function loadMongoAdapter(config: MongoStorageConfig): StorageAdapter {
  const configKey = mongoConfigKey(config);
  if (mongoAdapter && mongoAdapterConfigKey === configKey) {
    return mongoAdapter;
  }

  // Keep the MongoDB driver outside the default file-driver module path so the
  // production FileStorage path does not eagerly load the MongoDB dependency.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createMongoStorageAdapter } = require(
      './mongoStorageAdapter'
  ) as typeof import('./mongoStorageAdapter');

  const adapter = createMongoStorageAdapter(config);
  if (adapter.driver !== 'mongo') {
    throw new Error(`STORAGE_ADAPTER_DRIVER_MISMATCH:${adapter.driver}`);
  }

  mongoAdapter = adapter;
  mongoAdapterConfigKey = configKey;
  return adapter;
}

export function getStorageAdapter(): StorageAdapter {
  const config = getStorageConfig();
  if (config.driver === 'file') return fileStorageAdapter;
  return loadMongoAdapter(config);
}
