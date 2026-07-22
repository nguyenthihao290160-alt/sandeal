// Compatibility facade. Keep existing imports pointed at this module while
// storage implementations are selected behind the adapter factory.

import { getStorageAdapter } from './storageFactory';
import type { StorageTransaction } from './types';

export function getDataDir(): string {
  return getStorageAdapter().getDataDir();
}

export function ensureDataDir(): Promise<void> {
  return getStorageAdapter().ensureDataDir();
}

export function readCollection<T>(collection: string): Promise<T[]> {
  return getStorageAdapter().readCollection<T>(collection);
}

export function writeCollection<T>(collection: string, data: T[]): Promise<void> {
  return getStorageAdapter().writeCollection(collection, data);
}

export function backupCollection(collection: string, label: string): Promise<string> {
  const adapter = getStorageAdapter();
  if (!adapter.backupCollection) throw new Error(`STORAGE_BACKUP_UNSUPPORTED:${adapter.driver}`);
  return adapter.backupCollection(collection, label);
}

export function runTransaction<T>(
  collection: string,
  fn: StorageTransaction<T>
): Promise<void> {
  return getStorageAdapter().runTransaction(collection, fn);
}

export async function findById<T extends { id: string }>(collection: string, id: string): Promise<T | null> {
  const items = await readCollection<T>(collection);
  return items.find(item => item.id === id) ?? null;
}

export async function insertOne<T extends { id: string }>(collection: string, item: T): Promise<T> {
  await runTransaction<T>(collection, (items) => {
    items.push(item);
    return items;
  });
  return item;
}

export async function updateOne<T extends { id: string }>(
  collection: string,
  id: string,
  updates: Partial<T>
): Promise<T | null> {
  let updatedItem: T | null = null;
  await runTransaction<T>(collection, (items) => {
    const index = items.findIndex(item => item.id === id);
    if (index === -1) return undefined;
    items[index] = { ...items[index], ...updates, updatedAt: new Date().toISOString() } as T;
    updatedItem = items[index];
    return items;
  });
  return updatedItem;
}

export async function deleteOne<T extends { id: string }>(collection: string, id: string): Promise<boolean> {
  let deleted = false;
  await runTransaction<T>(collection, (items) => {
    const filtered = items.filter(item => item.id !== id);
    if (filtered.length === items.length) return undefined;
    deleted = true;
    return filtered;
  });
  return deleted;
}

/** Generate a simple unique ID. */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
