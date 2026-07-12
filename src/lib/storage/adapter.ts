// ===========================================
// Storage Adapter — JSON File-based storage
// ===========================================
// This provides a clean abstraction so the backend
// can be swapped to MongoDB or PostgreSQL later.

import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

export function getDataDir(): string {
  return process.env.SANDEAL_DATA_DIR || path.join(process.cwd(), '.data');
}

export async function ensureDataDir(): Promise<void> {
  try {
    await fs.access(getDataDir());
  } catch {
    await fs.mkdir(getDataDir(), { recursive: true });
  }
}

function getFilePath(collection: string): string {
  return path.join(getDataDir(), `${collection}.json`);
}

export async function readCollection<T>(collection: string): Promise<T[]> {
  await ensureDataDir();
  const filePath = getFilePath(collection);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('collection_root_must_be_array');
    return parsed as T[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Cannot read collection ${collection}: ${error instanceof Error ? error.message : 'invalid_json'}`);
  }
}

/**
 * Atomic write — writes to a temp file then renames.
 * Prevents corruption if process crashes during write.
 */
export async function writeCollection<T>(collection: string, data: T[]): Promise<void> {
  if (!Array.isArray(data)) throw new Error(`Invalid collection payload: ${collection}`);
  await ensureDataDir();
  const filePath = getFilePath(collection);
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, content, 'utf-8');
  try {
    const verified = JSON.parse(await fs.readFile(tmpPath, 'utf-8'));
    if (!Array.isArray(verified) || verified.length !== data.length) throw new Error('atomic_write_validation_failed');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

const collectionLocks = new Map<string, Promise<void>>();

export async function runTransaction<T>(
  collection: string,
  fn: (items: T[]) => Promise<T[] | undefined> | T[] | undefined
): Promise<void> {
  const previous = collectionLocks.get(collection) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  collectionLocks.set(collection, previous.then(() => current));
  try {
    await previous;
    const items = await readCollection<T>(collection);
    const updated = await fn(items);
    if (updated !== undefined) {
      await writeCollection(collection, updated);
    }
  } finally {
    release();
  }
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

/** Generate a simple unique ID */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
