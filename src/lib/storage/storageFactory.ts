import {
  getStorageConfig,
  type MongoStorageConfig,
} from './storageConfig';
import type { StorageAdapter } from './types';
import { getSandealRuntime } from '../runtime/config';
import { DomainStorageError, type DomainStorage } from './domainStorage';
import { createRuntimeStorage, currentStorageScope, RuntimeStorageError, type StorageDependencies } from './runtimeStorage';
import { createD1StorageAdapter } from './d1/d1StorageAdapter';
export { withStorageAdapter } from './runtimeStorage';

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

function createLegacyStorage(): StorageAdapter {
  const config = getStorageConfig();
  if (config.driver === 'file') {
    // Legacy-only dependencies are never loaded while constructing D1 storage.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./fileStorageAdapter') as typeof import('./fileStorageAdapter')).fileStorageAdapter;
  }
  return loadMongoAdapter(config);
}

export function createStorage(dependencies: StorageDependencies): StorageAdapter {
  return createRuntimeStorage({ ...dependencies, createD1: dependencies.createD1 || createD1StorageAdapter }, createLegacyStorage);
}

export function getStorageAdapter(): StorageAdapter {
  const runtime = getSandealRuntime();
  const scoped = currentStorageScope();
  if (scoped) {
    if (runtime === 'cloudflare' && scoped.driver !== 'd1') throw new RuntimeStorageError('CLOUDFLARE_STORAGE_CAPABILITY_MISMATCH');
    return scoped;
  }
  return createStorage({ runtime });
}

export function getDomainStorage(): DomainStorage {
  const domain = getStorageAdapter().domain;
  if (!domain) throw new DomainStorageError('DOMAIN_STORAGE_UNSUPPORTED');
  return domain;
}
