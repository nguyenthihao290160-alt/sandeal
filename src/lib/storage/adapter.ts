// Compatibility facade. Keep existing imports pointed at this module while
// storage implementations are selected behind the adapter factory.

import { getFeatureRolloutState } from '@/lib/automation/featureRollout';
import { getStorageAdapter } from './storageFactory';
import type {
  StorageBulkMutation,
  StorageBulkResult,
  StorageBoundedCollectionOptions,
  StorageBoundedCollectionResult,
  StorageCapabilities,
  StoragePage,
  StoragePageOptions,
  StorageScanResult,
  StorageStreamingTransaction,
  StorageStreamingTransactionOptions,
  StorageTransaction,
  StorageTransactionOptions,
} from './types';

export {
  getStorageDiagnosticsSnapshot,
  resetStorageDiagnostics,
} from './diagnostics';

export function getDataDir(): string {
  return getStorageAdapter().getDataDir();
}

export function ensureDataDir(): Promise<void> {
  return getStorageAdapter().ensureDataDir();
}

export function getStorageCapabilities(): StorageCapabilities {
  return { ...getStorageAdapter().capabilities };
}

export function bulkMutateCollection<T extends { id: string }>(
    collection: string,
    mutations: StorageBulkMutation<T>[],
    environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StorageBulkResult> {
  const adapter = getStorageAdapter();
  if (!adapter.bulkMutateCollection) {
    throw new Error(`STORAGE_BULK_UNSUPPORTED:${adapter.driver}`);
  }

  const optimized = adapter.driver === 'mongo'
      && getFeatureRolloutState('MONGO_BULK_WRITE', environment).mode === 'ACTIVE';

  return adapter.bulkMutateCollection(collection, mutations, { optimized });
}

export function readCollection<T>(collection: string): Promise<T[]> {
  return getStorageAdapter().readCollection<T>(collection);
}

export function scanCollection<T>(
    collection: string,
    visitor: (item: T, index: number) => Promise<void> | void,
): Promise<StorageScanResult> {
  return getStorageAdapter().scanCollection<T>(collection, visitor);
}

export function readBoundedCollection<T>(
    collection: string,
    options: StorageBoundedCollectionOptions,
): Promise<T[]> {
  return getStorageAdapter().readBoundedCollection<T>(collection, options);
}

export function readBoundedCollectionSnapshot<T>(
    collection: string,
    options: StorageBoundedCollectionOptions,
): Promise<StorageBoundedCollectionResult<T>> {
  return getStorageAdapter().readBoundedCollectionSnapshot<T>(
      collection,
      options,
  );
}

export function readCollectionPage<T>(
    collection: string,
    options: StoragePageOptions,
): Promise<StoragePage<T>> {
  return getStorageAdapter().readCollectionPage<T>(collection, options);
}

export function writeCollection<T>(
    collection: string,
    data: T[],
): Promise<void> {
  return getStorageAdapter().writeCollection(collection, data);
}

export function backupCollection(
    collection: string,
    label: string,
): Promise<string> {
  const adapter = getStorageAdapter();
  if (!adapter.backupCollection) {
    throw new Error(`STORAGE_BACKUP_UNSUPPORTED:${adapter.driver}`);
  }
  return adapter.backupCollection(collection, label);
}

export function runTransaction<T>(
    collection: string,
    fn: StorageTransaction<T>,
    options?: StorageTransactionOptions,
): Promise<void> {
  return getStorageAdapter().runTransaction(collection, fn, options);
}

export function runStreamingTransaction<T>(
    collection: string,
    fn: StorageStreamingTransaction<T>,
    options?: StorageStreamingTransactionOptions<T>,
): Promise<{ changed: boolean; itemCount: number }> {
  return getStorageAdapter().runStreamingTransaction(collection, fn, options);
}

/**
 * Find an item without materializing the entire collection in an additional
 * array at this facade layer. The selected adapter remains responsible for
 * bounded-memory scanning and diagnostics.
 */
export async function findById<T extends { id: string }>(
    collection: string,
    id: string,
): Promise<T | null> {
  let found: T | null = null;
  await scanCollection<T>(collection, item => {
    if (found === null && item.id === id) found = item;
  });
  return found;
}

export async function insertOne<T extends { id: string }>(
    collection: string,
    item: T,
): Promise<T> {
  await runTransaction<T>(collection, items => {
    items.push(item);
    return items;
  });
  return item;
}

export async function updateOne<T extends { id: string }>(
    collection: string,
    id: string,
    updates: Partial<T>,
): Promise<T | null> {
  let updatedItem: T | null = null;

  await runTransaction<T>(collection, items => {
    const index = items.findIndex(item => item.id === id);
    if (index === -1) return undefined;

    // The durable identity is selected by the function argument. Do not allow
    // a partial update payload to silently rename the record.
    const { id: _ignoredId, ...safeUpdates } = updates;
    void _ignoredId;

    items[index] = {
      ...items[index],
      ...safeUpdates,
      id,
      updatedAt: new Date().toISOString(),
    } as T;
    updatedItem = items[index];
    return items;
  });

  return updatedItem;
}

export async function deleteOne<T extends { id: string }>(
    collection: string,
    id: string,
): Promise<boolean> {
  let deleted = false;

  await runTransaction<T>(collection, items => {
    const filtered = items.filter(item => item.id !== id);
    if (filtered.length === items.length) return undefined;
    deleted = true;
    return filtered;
  });

  return deleted;
}

/** Generate a simple unique ID while preserving the established ID format. */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
