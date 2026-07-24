import { randomBytes, randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { storageErrorCode } from './storageErrors';
import type { StorageAdapter, StoragePageOptions, StorageTransaction } from './types';

function getDataDir(): string {
  return process.env.SANDEAL_DATA_DIR || path.join(process.cwd(), '.data');
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.access(getDataDir());
  } catch {
    await fs.mkdir(getDataDir(), { recursive: true });
  }
}

function getFilePath(collection: string): string {
  return path.join(getDataDir(), `${collection}.json`);
}

interface FileLockMetadata {
  token: string;
  pid: number;
  hostname: string;
  processStartedAt: string;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

const FILE_LOCK_LEASE_MS = Math.max(15_000, Number(process.env.SANDEAL_FILE_LOCK_LEASE_MS) || 60_000);
const FILE_LOCK_WAIT_MS = Math.max(5_000, Number(process.env.SANDEAL_FILE_LOCK_WAIT_MS) || 30_000);
const FILE_LOCK_HEARTBEAT_MS = Math.max(2_000, Math.min(10_000, Math.floor(FILE_LOCK_LEASE_MS / 3)));
const BACKUP_REFRESH_MS = Math.max(60_000, Number(process.env.SANDEAL_FILE_BACKUP_REFRESH_MS) || 5 * 60_000);
const TMP_STALE_MS = Math.max(5 * 60_000, Number(process.env.SANDEAL_FILE_TMP_STALE_MS) || 60 * 60_000);
const hostname = os.hostname();
const processStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString();

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLockMetadata(lockPath: string): Promise<FileLockMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Partial<FileLockMetadata>;
    if (!parsed.token || !parsed.createdAt || !parsed.expiresAt) return null;
    return parsed as FileLockMetadata;
  } catch {
    return null;
  }
}

async function cleanupStaleTempFiles(collection: string): Promise<void> {
  const prefix = `${collection}.json.tmp.`;
  const now = Date.now();
  const entries = await fs.readdir(getDataDir(), { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(async entry => {
      const target = path.join(getDataDir(), entry.name);
      const stat = await fs.stat(target).catch(() => null);
      if (stat && now - stat.mtimeMs >= TMP_STALE_MS) await fs.unlink(target).catch(() => undefined);
    }));
}

async function recoverStaleLock(lockPath: string, metadata: FileLockMetadata | null): Promise<boolean> {
  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat) return true;
  const now = Date.now();
  const sameHostOwnerAlive = metadata?.hostname === hostname && processIsAlive(Number(metadata.pid));
  if (sameHostOwnerAlive) return false;

  const expiry = Date.parse(metadata?.expiresAt || '');
  const expired = Number.isFinite(expiry)
    ? expiry <= now
    : now - stat.mtimeMs >= FILE_LOCK_LEASE_MS;
  if (!expired) return false;

  const recoveryToken = metadata?.token || `unknown-${Math.floor(stat.mtimeMs)}`;
  const stalePath = `${lockPath}.stale.${recoveryToken.slice(0, 36)}`;
  try {
    await fs.rename(lockPath, stalePath);
    await fs.unlink(stalePath).catch(() => undefined);
    console.warn(JSON.stringify({
      type: 'storage_lock_recovered',
      collection: path.basename(lockPath, '.json.lock'),
      reasonCode: metadata ? 'LOCK_OWNER_GONE_OR_LEASE_EXPIRED' : 'LOCK_METADATA_INVALID_AND_LEASE_EXPIRED',
      ownerPid: metadata?.pid,
      ownerHost: metadata?.hostname,
      recoveredAt: new Date(now).toISOString(),
    }));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function acquireCollectionFileLock(collection: string): Promise<() => Promise<void>> {
  await ensureDataDir();
  const lockPath = `${getFilePath(collection)}.lock`;
  const startedAt = Date.now();
  let delayMs = 25;

  while (Date.now() - startedAt < FILE_LOCK_WAIT_MS) {
    const token = randomUUID();
    const now = Date.now();
    const metadata: FileLockMetadata = {
      token,
      pid: process.pid,
      hostname,
      processStartedAt,
      createdAt: new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + FILE_LOCK_LEASE_MS).toISOString(),
    };
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let lockCreated = false;
    try {
      handle = await fs.open(lockPath, 'wx');
      lockCreated = true;
      await handle.writeFile(JSON.stringify(metadata), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await cleanupStaleTempFiles(collection);

      let heartbeatInFlight: Promise<void> = Promise.resolve();
      const renewLock = async (): Promise<void> => {
        const current = await readLockMetadata(lockPath);
        if (current?.token !== token) return;
        const heartbeatAt = Date.now();
        await fs.writeFile(lockPath, JSON.stringify({
          ...current,
          heartbeatAt: new Date(heartbeatAt).toISOString(),
          expiresAt: new Date(heartbeatAt + FILE_LOCK_LEASE_MS).toISOString(),
        }), 'utf8');
      };
      const heartbeat = setInterval(() => {
        // Track renewal work so release cannot unlink the lock and then have an
        // already-running timer callback recreate it with writeFile.
        heartbeatInFlight = heartbeatInFlight
          .catch(() => undefined)
          .then(renewLock)
          .catch(() => undefined);
      }, FILE_LOCK_HEARTBEAT_MS);
      heartbeat.unref();

      return async () => {
        clearInterval(heartbeat);
        await heartbeatInFlight.catch(() => undefined);
        const current = await readLockMetadata(lockPath);
        if (current?.token === token) await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (lockCreated) {
        const current = await readLockMetadata(lockPath);
        if (!current || current.token === token) await fs.unlink(lockPath).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await readLockMetadata(lockPath);
      if (await recoverStaleLock(lockPath, current)) continue;
      await new Promise(resolve => setTimeout(resolve, delayMs + Math.floor(Math.random() * Math.max(10, delayMs / 2))));
      delayMs = Math.min(500, Math.ceil(delayMs * 1.6));
    }
  }

  const error = new Error(`Storage lock timeout: ${collection}`) as Error & { code?: string };
  error.code = 'STORAGE_LOCK_TIMEOUT';
  throw error;
}

async function readCollectionUnlocked<T>(collection: string): Promise<T[]> {
  await ensureDataDir();
  const filePath = getFilePath(collection);
  let originalError: unknown;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('collection_root_must_be_array');
    return parsed as T[];
  } catch (error) {
    originalError = error;
  }

  for (const backupPath of [`${filePath}.bak`, `${filePath}.bak.2`]) {
    try {
      const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
      if (Array.isArray(backup)) return backup as T[];
    } catch {
      // Try the next rollback snapshot.
    }
  }
  if ((originalError as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
  throw new Error(`Cannot read collection ${collection}: ${originalError instanceof Error ? originalError.message : 'invalid_json'}`);
}

async function readCollection<T>(collection: string): Promise<T[]> {
  return readCollectionUnlocked<T>(collection);
}

async function readCollectionPage<T>(collection: string, options: StoragePageOptions) {
  let items = await readCollectionUnlocked<T>(collection);
  for (const [field, expected] of Object.entries(options.filters || {})) {
    items = items.filter((item) => (
      item !== null
      && typeof item === 'object'
      && String((item as Record<string, unknown>)[field] ?? '') === expected
    ));
  }
  if (options.sort) {
    const { field, direction } = options.sort;
    const multiplier = direction === 'desc' ? -1 : 1;
    items.sort((left, right) => {
      const leftValue = left !== null && typeof left === 'object'
        ? String((left as Record<string, unknown>)[field] ?? '')
        : '';
      const rightValue = right !== null && typeof right === 'object'
        ? String((right as Record<string, unknown>)[field] ?? '')
        : '';
      return leftValue.localeCompare(rightValue) * multiplier;
    });
  }
  const totalItems = items.length;
  const start = (options.page - 1) * options.pageSize;
  return {
    items: items.slice(start, start + options.pageSize),
    totalItems,
    queryCount: 1,
  };
}

async function refreshBackup(filePath: string): Promise<void> {
  const current = await fs.stat(filePath).catch(() => null);
  if (!current) return;
  const backupPath = `${filePath}.bak`;
  const backup = await fs.stat(backupPath).catch(() => null);
  if (backup && Date.now() - backup.mtimeMs < BACKUP_REFRESH_MS) return;

  const backupTwoPath = `${filePath}.bak.2`;
  if (backup) {
    await fs.unlink(backupTwoPath).catch(() => undefined);
    await fs.rename(backupPath, backupTwoPath).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  await fs.copyFile(filePath, backupPath);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some Windows filesystems. The file itself
    // has already been synced, so keep the atomic rename path operational.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Write and fsync a compact snapshot, then atomically replace the collection. */
async function writeCollectionUnlocked<T>(collection: string, data: T[]): Promise<void> {
  if (!Array.isArray(data)) throw new Error(`Invalid collection payload: ${collection}`);
  await ensureDataDir();
  const filePath = getFilePath(collection);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  const content = JSON.stringify(data);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tmpPath, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const stat = await fs.stat(tmpPath);
    if (stat.size !== Buffer.byteLength(content, 'utf8') || (data.length > 0 && stat.size < 2)) {
      throw new Error('atomic_write_validation_failed');
    }
    await refreshBackup(filePath);
    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

const collectionLocks = new Map<string, Promise<void>>();

async function withCollectionLock<T>(collection: string, work: () => Promise<T>): Promise<T> {
  const previous = collectionLocks.get(collection) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  collectionLocks.set(collection, tail);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    await previous.catch(() => undefined);
    releaseFileLock = await acquireCollectionFileLock(collection);
    return await work();
  } finally {
    if (releaseFileLock) await releaseFileLock();
    release();
    if (collectionLocks.get(collection) === tail) collectionLocks.delete(collection);
  }
}

async function writeCollection<T>(collection: string, data: T[]): Promise<void> {
  await withCollectionLock(collection, () => writeCollectionUnlocked(collection, data));
}

async function backupCollection(collection: string, label: string): Promise<string> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'manual';
  return withCollectionLock(collection, async () => {
    const filePath = getFilePath(collection);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.backup.${safeLabel}.${timestamp}`;
    await fs.copyFile(filePath, backupPath);
    const handle = await fs.open(backupPath, 'r');
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(String(code))) throw error;
      // Some Windows filesystems reject fsync on a read-only backup handle.
      // copyFile has completed; keep the durable atomic source snapshot.
    } finally {
      await handle.close();
    }
    const prefix = `${collection}.json.backup.${safeLabel}.`;
    const backups = (await fs.readdir(getDataDir(), { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const old of backups.slice(3)) await fs.unlink(path.join(getDataDir(), old.name)).catch(() => undefined);
    return backupPath;
  });
}

async function runTransaction<T>(collection: string, fn: StorageTransaction<T>): Promise<void> {
  await withCollectionLock(collection, async () => {
    const items = await readCollectionUnlocked<T>(collection);
    const updated = await fn(items);
    if (updated !== undefined) await writeCollectionUnlocked(collection, updated);
  });
}

async function checkHealth() {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const stat = await fs.stat(getDataDir());
    if (!stat.isDirectory()) throw new Error('not_a_directory');
    await fs.access(getDataDir(), fsConstants.R_OK | fsConstants.W_OK);
    return {
      driver: 'file' as const,
      configured: true,
      reachable: true,
      healthy: true,
      latencyMs: Date.now() - startedAt,
      checkedAt,
    };
  } catch (error) {
    return {
      driver: 'file' as const,
      configured: true,
      reachable: false,
      healthy: false,
      latencyMs: Date.now() - startedAt,
      checkedAt,
      errorCode: storageErrorCode(error, 'FILE_STORAGE_UNREACHABLE'),
    };
  }
}

export const fileStorageAdapter: StorageAdapter = {
  driver: 'file',
  getDataDir,
  ensureDataDir,
  readCollection,
  readCollectionPage,
  writeCollection,
  backupCollection,
  runTransaction,
  checkHealth,
};
