import { fileStorageAdapter } from './fileStorageAdapter';
import { getStorageConfig } from './storageConfig';
import type { MongoStorageConfig } from './storageConfig';
import type { StorageAdapter } from './types';

let mongoAdapter: StorageAdapter | undefined;
let mongoDatabase: string | undefined;

function loadMongoAdapter(config: MongoStorageConfig): StorageAdapter {
  if (mongoAdapter && mongoDatabase === config.database) return mongoAdapter;

  // Keep the MongoDB driver outside the default file-driver module path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createMongoStorageAdapter } = require('./mongoStorageAdapter') as typeof import('./mongoStorageAdapter');
  mongoAdapter = createMongoStorageAdapter(config);
  mongoDatabase = config.database;
  return mongoAdapter;
}

export function getStorageAdapter(): StorageAdapter {
  const config = getStorageConfig();
  return config.driver === 'file' ? fileStorageAdapter : loadMongoAdapter(config);
}
