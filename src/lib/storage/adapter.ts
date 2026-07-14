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

const FILE_LOCK_STALE_MS = 2 * 60_000;
const FILE_LOCK_WAIT_MS = 10_000;

async function acquireCollectionFileLock(collection: string): Promise<() => Promise<void>> {
  await ensureDataDir();
  const lockPath = `${getFilePath(collection)}.lock`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < FILE_LOCK_WAIT_MS) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ createdAt: new Date().toISOString() }), 'utf-8');
      return async () => {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
  }

  throw new Error(`Storage lock timeout: ${collection}`);
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
    try {
      const backup = JSON.parse(await fs.readFile(`${filePath}.bak`, 'utf-8'));
      if (Array.isArray(backup)) return backup as T[];
    } catch {
      // Surface the original corruption error when no usable backup exists.
    }
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
    await fs.copyFile(filePath, `${filePath}.bak`).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
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
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    await previous;
    releaseFileLock = await acquireCollectionFileLock(collection);
    const items = await readCollection<T>(collection);
    const updated = await fn(items);
    if (updated !== undefined) {
      await writeCollection(collection, updated);
    }
  } finally {
    if (releaseFileLock) await releaseFileLock();
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
