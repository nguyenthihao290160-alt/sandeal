import { randomBytes, randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { applyStorageBulkMutations } from './bulkMutation';
import { storageErrorCode } from './storageErrors';
import {
  recordBoundedRead,
  recordFileLockHeartbeat,
  recordFullCollectionRead,
  recordLockAcquisition,
  recordLockHold,
  recordLockWait,
  recordScanCollection,
  recordStaleLockRecovery,
} from './diagnostics';
import {
  STORAGE_MAX_BOUNDED_BYTES,
  STORAGE_MAX_BOUNDED_ITEMS,
  STORAGE_MAX_PAGE_SIZE,
} from './types';
import type {
  StorageAdapter,
  StorageBulkMutation,
  StorageBulkResult,
  StorageBoundedCollectionOptions,
  StorageBoundedCollectionResult,
  StoragePageOptions,
  StorageScanResult,
  StorageStreamingTransaction,
  StorageStreamingTransactionOptions,
  StorageTransaction,
  StorageTransactionOptions,
} from './types';

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

function validateFileCollectionName(collection: string): string {
  if (
      typeof collection !== 'string'
      || collection.length === 0
      || collection.length > 160
      || collection.trim() !== collection
      || collection === '.'
      || collection === '..'
      || /[\\/\u0000]/.test(collection)
  ) {
    const error = new Error('INVALID_STORAGE_COLLECTION') as Error & { code?: string };
    error.code = 'INVALID_STORAGE_COLLECTION';
    throw error;
  }
  return collection;
}

function getFilePath(collection: string): string {
  const safeCollection = validateFileCollectionName(collection);
  const dataDir = path.resolve(getDataDir());
  const target = path.resolve(dataDir, `${safeCollection}.json`);
  if (path.dirname(target) !== dataDir) {
    const error = new Error('INVALID_STORAGE_COLLECTION') as Error & { code?: string };
    error.code = 'INVALID_STORAGE_COLLECTION';
    throw error;
  }
  return target;
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

interface CollectionFileLockHandle {
  assertHeld: () => Promise<void>;
  release: () => Promise<void>;
}

function boundedEnvironmentDuration(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

const FILE_LOCK_LEASE_MS = boundedEnvironmentDuration(
    process.env.SANDEAL_FILE_LOCK_LEASE_MS,
    60_000,
    15_000,
    5 * 60_000,
);
const FILE_LOCK_WAIT_MS = boundedEnvironmentDuration(
    process.env.SANDEAL_FILE_LOCK_WAIT_MS,
    30_000,
    5_000,
    2 * 60_000,
);
const FILE_LOCK_HEARTBEAT_MS = Math.max(
    2_000,
    Math.min(10_000, Math.floor(FILE_LOCK_LEASE_MS / 3)),
);
const FILE_LOCK_SAFETY_MARGIN_MS = Math.max(
    1_000,
    Math.min(10_000, Math.floor(FILE_LOCK_LEASE_MS / 6)),
);
const BACKUP_REFRESH_MS = boundedEnvironmentDuration(
    process.env.SANDEAL_FILE_BACKUP_REFRESH_MS,
    5 * 60_000,
    60_000,
    24 * 60 * 60_000,
);
const TMP_STALE_MS = boundedEnvironmentDuration(
    process.env.SANDEAL_FILE_TMP_STALE_MS,
    60 * 60_000,
    5 * 60_000,
    7 * 24 * 60 * 60_000,
);
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
  const sameHost = metadata?.hostname === hostname;
  const sameHostOwnerAlive = sameHost && processIsAlive(Number(metadata?.pid));
  if (sameHostOwnerAlive) return false;
  const sameHostOwnerGone = sameHost && Number.isInteger(Number(metadata?.pid)) && Number(metadata?.pid) > 0;

  const expiry = Date.parse(metadata?.expiresAt || '');
  const expired = Number.isFinite(expiry)
      ? expiry <= now
      : now - stat.mtimeMs >= FILE_LOCK_LEASE_MS;
  // A conclusively dead same-host owner cannot release its lock, even when
  // the lease timestamp has not caught up. A live owner is never stolen;
  // hosts whose PID cannot be verified still require lease expiry.
  if (!sameHostOwnerGone && !expired) return false;

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
    recordStaleLockRecovery(metadata ? 'LOCK_OWNER_GONE_OR_LEASE_EXPIRED' : 'LOCK_METADATA_INVALID_AND_LEASE_EXPIRED');
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function acquireCollectionFileLock(
    collection: string,
): Promise<CollectionFileLockHandle> {
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
      recordLockWait(Date.now() - startedAt);

      let lost = false;
      let knownExpiresAtMs = Date.parse(metadata.expiresAt);
      let heartbeatInFlight: Promise<void> | undefined;

      const renewLock = async (): Promise<void> => {
        const renewalStartedAt = Date.now();
        try {
          const current = await readLockMetadata(lockPath);
          if (
              !current
              || current.token !== token
              || Date.parse(current.expiresAt) <= Date.now()
          ) {
            lost = true;
            recordFileLockHeartbeat(Date.now() - renewalStartedAt, false);
            return;
          }

          const heartbeatAt = Date.now();
          const next: FileLockMetadata = {
            ...current,
            heartbeatAt: new Date(heartbeatAt).toISOString(),
            expiresAt: new Date(heartbeatAt + FILE_LOCK_LEASE_MS).toISOString(),
          };

          // Never use a path-based write that can recreate a lock after it was
          // recovered or released. Opening r+ requires the lock to still exist.
          const renewalHandle = await fs.open(lockPath, 'r+');
          try {
            const latestRaw = await renewalHandle.readFile('utf8');
            const latest = JSON.parse(latestRaw) as Partial<FileLockMetadata>;
            if (latest.token !== token) {
              lost = true;
              recordFileLockHeartbeat(Date.now() - renewalStartedAt, false);
              return;
            }
            const encodedNext = JSON.stringify(next);
            await renewalHandle.truncate(0);
            await renewalHandle.write(encodedNext, 0, 'utf8');
            await renewalHandle.truncate(Buffer.byteLength(encodedNext, 'utf8'));
            await renewalHandle.sync();
          } finally {
            await renewalHandle.close().catch(() => undefined);
          }

          const confirmed = await readLockMetadata(lockPath);
          if (!confirmed || confirmed.token !== token) {
            lost = true;
            recordFileLockHeartbeat(Date.now() - renewalStartedAt, false);
            return;
          }

          knownExpiresAtMs = Date.parse(confirmed.expiresAt);
          recordFileLockHeartbeat(Date.now() - renewalStartedAt, true);
        } catch {
          recordFileLockHeartbeat(Date.now() - renewalStartedAt, false);
          if (Date.now() + FILE_LOCK_SAFETY_MARGIN_MS >= knownExpiresAtMs) {
            lost = true;
          }
        }
      };

      const heartbeat = setInterval(() => {
        if (heartbeatInFlight || lost) return;
        heartbeatInFlight = renewLock().finally(() => {
          heartbeatInFlight = undefined;
        });
        void heartbeatInFlight.catch(() => undefined);
      }, FILE_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();

      const assertHeld = async (): Promise<void> => {
        if (
            lost
            || Date.now() + FILE_LOCK_SAFETY_MARGIN_MS >= knownExpiresAtMs
        ) {
          lost = true;
          const error = new Error(`Storage lock lost: ${collection}`) as Error & { code?: string };
          error.code = 'STORAGE_LOCK_LOST';
          throw error;
        }

        const current = await readLockMetadata(lockPath);
        if (
            !current
            || current.token !== token
            || Date.parse(current.expiresAt) <= Date.now()
        ) {
          lost = true;
          const error = new Error(`Storage lock lost: ${collection}`) as Error & { code?: string };
          error.code = 'STORAGE_LOCK_LOST';
          throw error;
        }

        knownExpiresAtMs = Date.parse(current.expiresAt);
      };

      return {
        assertHeld,
        release: async () => {
          clearInterval(heartbeat);
          await heartbeatInFlight?.catch(() => undefined);
          const current = await readLockMetadata(lockPath);
          if (current?.token === token) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (lockCreated) {
        const current = await readLockMetadata(lockPath);
        if (!current || current.token === token) {
          await fs.unlink(lockPath).catch(() => undefined);
        }
      }

      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const current = await readLockMetadata(lockPath);
      if (await recoverStaleLock(lockPath, current)) continue;

      await new Promise(resolve => setTimeout(
          resolve,
          delayMs + Math.floor(Math.random() * Math.max(10, delayMs / 2)),
      ));
      delayMs = Math.min(500, Math.ceil(delayMs * 1.6));
    }
  }

  recordLockWait(Date.now() - startedAt);
  const error = new Error(`Storage lock timeout: ${collection}`) as Error & { code?: string };
  error.code = 'STORAGE_LOCK_TIMEOUT';
  throw error;
}

async function readCollectionUnlocked<T>(collection: string): Promise<T[]> {
  recordFullCollectionRead(collection);
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

/**
 * Stream one JSON-array member at a time. Durable SanDeal collections are
 * arrays of JSON objects; tracking string/nesting state avoids retaining the
 * raw file or parsed collection while keeping crash recovery fail-closed.
 */
async function* iterateJsonArrayMemberTexts(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let started = false;
  let closed = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let itemText = '';
  let primitive = false;
  let hasItem = false;
  let afterComma = false;
  const takeItem = (): string => {
    const text = itemText.trim();
    if (!text) throw new Error('collection_item_empty');
    itemText = '';
    primitive = false;
    depth = 0;
    inString = false;
    escaped = false;
    return text;
  };

  for await (const chunk of stream) {
    const text = String(chunk);
    for (let offset = 0; offset < text.length; offset += 1) {
      const character = text[offset];
      if (!started) {
        if (/\s/.test(character)) continue;
        if (character !== '[') throw new Error('collection_root_must_be_array');
        started = true;
        continue;
      }
      if (closed) {
        if (/\s/.test(character)) continue;
        throw new Error('collection_trailing_data');
      }
      if (!itemText) {
        if (/\s/.test(character)) continue;
        if (character === ',') {
          if (!hasItem || afterComma) throw new Error('collection_delimiter_invalid');
          afterComma = true;
          continue;
        }
        if (character === ']') {
          if (afterComma) throw new Error('collection_trailing_delimiter');
          closed = true;
          continue;
        }
        itemText = character;
        hasItem = true;
        afterComma = false;
        if (character === '{' || character === '[') depth = 1;
        else primitive = true;
        inString = character === '"';
        escaped = false;
        continue;
      }

      if (primitive) {
        if (!inString && (character === ',' || character === ']')) {
          yield takeItem();
          if (character === ']') closed = true;
          else afterComma = true;
          continue;
        }
        itemText += character;
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
        } else if (character === '"') inString = true;
        continue;
      }

      itemText += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{' || character === '[') {
        depth += 1;
      } else if (character === '}' || character === ']') {
        depth -= 1;
        if (depth < 0) throw new Error('collection_item_nesting_invalid');
        if (depth === 0) {
          yield takeItem();
          // The delimiter belongs to the item when it closes an object/array;
          // the outer closing bracket is processed by the empty-item branch.
        }
      }
    }
  }
  if (!started || !closed || itemText.trim() || inString || depth !== 0) {
    throw new Error('collection_json_incomplete');
  }
}

async function scanJsonArrayFile<T>(
    filePath: string,
    visitor: (item: T, index: number) => Promise<void> | void,
): Promise<number> {
  let itemIndex = 0;
  for await (const raw of iterateJsonArrayMemberTexts(filePath)) {
    const item = JSON.parse(raw) as T;
    await visitor(item, itemIndex);
    itemIndex += 1;
  }
  return itemIndex;
}

type FileTransactionFailurePhase =
    | 'COLLECTION_LOCK'
    | 'PREPARATION'
    | 'BEFORE_COMMIT'
    | 'RUNTIME_COMMIT_AUTHORITY'
    | 'RUNTIME_AUTHORITY_VALIDATION'
    | 'ATOMIC_COMMIT';

interface FileTransactionTiming {
  startedAt: number;
  collectionLockAcquiredAt?: number;
  preparationCompletedAt?: number;
  authorityWaitStartedAt?: number;
  authorityAcquiredAt?: number;
  atomicCommitStartedAt?: number;
  atomicCommitCompletedAt?: number;
  completedAt?: number;
  failurePhase?: FileTransactionFailurePhase;
}

type FileStorageTransactionTestPhase =
    | 'COLLECTION_LOCK_WAIT_STARTED'
    | 'COLLECTION_LOCK_ACQUIRED'
    | 'PREPARED_BEFORE_COMMIT_AUTHORITY';

type FileStorageTransactionTestHook = (input: {
  phase: FileStorageTransactionTestPhase;
  collection: string;
  operationCategory: string;
}) => Promise<void> | void;

let transactionTestHook: FileStorageTransactionTestHook | undefined;

export function setFileStorageTransactionTestHookForTests(
    hook: FileStorageTransactionTestHook | undefined,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('FILE_STORAGE_TEST_HOOK_FORBIDDEN');
  }
  transactionTestHook = hook;
}

async function invokeTransactionTestHook(
    phase: FileStorageTransactionTestPhase,
    collection: string,
    options: StorageTransactionOptions,
): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || !transactionTestHook) return;
  await transactionTestHook({
    phase,
    collection,
    operationCategory: safeOperationCategory(options.operationCategory),
  });
}

function safeOperationCategory(value: string | undefined): string {
  const normalized = String(value || 'uncategorized').trim();
  return /^[a-zA-Z0-9._:-]{1,80}$/.test(normalized)
      ? normalized
      : 'uncategorized';
}

function safeTransactionReasonCode(error: unknown): string {
  const explicit = error && typeof error === 'object'
      && typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code: string }).code)
      : '';
  if (/^[A-Z][A-Z0-9_]{1,95}$/.test(explicit)) return explicit;
  const message = error instanceof Error ? error.message : String(error || '');
  for (const reason of [
    'WORKER_FENCING_REJECTED',
    'ROLE_FENCE_LOCK_TIMEOUT',
    'ROLE_FENCE_LOST',
    'JOB_CLAIM_TOKEN_MISMATCH',
    'JOB_WORKER_MISMATCH',
    'JOB_FENCING_MISMATCH',
    'JOB_ATTEMPT_MISMATCH',
    'JOB_RELEASE_MISMATCH',
    'JOB_LEASE_EXPIRED',
    'STORAGE_COMMIT_GUARD_DID_NOT_COMMIT',
  ]) {
    if (message.includes(reason)) return reason;
  }
  return 'FILE_STORAGE_TRANSACTION_FAILED';
}

function inferFileTransactionFailurePhase(
    timing: FileTransactionTiming,
): FileTransactionFailurePhase {
  if (timing.failurePhase) return timing.failurePhase;
  if (!timing.collectionLockAcquiredAt) return 'COLLECTION_LOCK';
  if (timing.atomicCommitStartedAt) return 'ATOMIC_COMMIT';
  if (timing.authorityAcquiredAt) return 'RUNTIME_AUTHORITY_VALIDATION';
  if (timing.authorityWaitStartedAt) return 'RUNTIME_COMMIT_AUTHORITY';
  return 'PREPARATION';
}

function logFileTransactionTiming(
    collection: string,
    options: StorageTransactionOptions,
    timing: FileTransactionTiming,
    error?: unknown,
    changed = true,
): void {
  const completedAt = timing.completedAt || Date.now();
  const lockAcquiredAt = timing.collectionLockAcquiredAt || completedAt;
  const preparationCompletedAt = timing.preparationCompletedAt || completedAt;
  const authorityWaitStartedAt = timing.authorityWaitStartedAt || preparationCompletedAt;
  const authorityAcquiredAt = timing.authorityAcquiredAt || authorityWaitStartedAt;
  const atomicCommitStartedAt = timing.atomicCommitStartedAt || authorityAcquiredAt;
  const atomicCommitCompletedAt = timing.atomicCommitCompletedAt || atomicCommitStartedAt;
  const totalMs = Math.max(0, completedAt - timing.startedAt);

  // Successful fast transactions stay silent. Slow work and every failure are
  // emitted once per transaction, with no payload or unbounded dimensions.
  if (!error && totalMs < 250) return;
  const output = {
    type: 'file_storage_transaction_timing',
    collection,
    operationCategory: safeOperationCategory(options.operationCategory),
    status: error ? 'FAILED' : changed ? 'COMMITTED' : 'NO_CHANGE',
    phase: error ? inferFileTransactionFailurePhase(timing) : 'COMPLETED',
    collectionLockWaitMs: Math.max(0, lockAcquiredAt - timing.startedAt),
    preparationMs: Math.max(0, preparationCompletedAt - lockAcquiredAt),
    runtimeCommitAuthorityWaitMs: options.withCommitGuard
        ? Math.max(0, authorityAcquiredAt - authorityWaitStartedAt)
        : 0,
    runtimeCommitAuthorityHoldMs: options.withCommitGuard
        ? Math.max(0, completedAt - authorityAcquiredAt)
        : 0,
    atomicCommitMs: Math.max(0, atomicCommitCompletedAt - atomicCommitStartedAt),
    totalMs,
    ...(error ? { reasonCode: safeTransactionReasonCode(error) } : {}),
  };
  (error ? console.error : console.info)(JSON.stringify(output));
}

async function commitPreparedFile(
    collection: string,
    targetPath: string,
    tmpPath: string,
    options: StorageTransactionOptions,
    timing: FileTransactionTiming | undefined,
    assertLockHeld?: () => Promise<void>,
): Promise<void> {
  try {
    await options.beforeCommit?.();
  } catch (error) {
    if (timing) timing.failurePhase = 'BEFORE_COMMIT';
    throw error;
  }
  await assertLockHeld?.();
  if (timing) {
    timing.preparationCompletedAt = Date.now();
    timing.authorityWaitStartedAt = timing.preparationCompletedAt;
  }
  await invokeTransactionTestHook(
      'PREPARED_BEFORE_COMMIT_AUTHORITY',
      collection,
      options,
  );

  let commitCalls = 0;
  const authorityAcquired = (): void => {
    if (timing && timing.authorityAcquiredAt === undefined) {
      timing.authorityAcquiredAt = Date.now();
    }
  };
  const commit = async (): Promise<void> => {
    commitCalls += 1;
    if (commitCalls !== 1) throw new Error('STORAGE_COMMIT_GUARD_MULTIPLE_COMMIT');
    authorityAcquired();
    await assertLockHeld?.();
    if (timing) timing.atomicCommitStartedAt = Date.now();
    await renameAtomicWithRetry(tmpPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
    if (timing) timing.atomicCommitCompletedAt = Date.now();
  };

  if (options.withCommitGuard) {
    await options.withCommitGuard(commit, { authorityAcquired });
    if (commitCalls !== 1) throw new Error('STORAGE_COMMIT_GUARD_DID_NOT_COMMIT');
  } else {
    await commit();
  }
}

async function transformJsonArrayFile<T>(
    filePath: string,
    collection: string,
    visitor: StorageStreamingTransaction<T>,
    options: StorageStreamingTransactionOptions<T> = {},
    assertLockHeld?: () => Promise<void>,
    timing?: FileTransactionTiming,
): Promise<{ changed: boolean; itemCount: number }> {
  const tmpPath = `${getFilePath(collection)}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let changed = false;
  let itemCount = 0;
  try {
    handle = await fs.open(tmpPath, 'wx');
    await handle.writeFile('[', 'utf8');
    let first = true;
    for await (const raw of iterateJsonArrayMemberTexts(filePath)) {
      const item = JSON.parse(raw) as T;
      const itemChanged = await visitor(item, itemCount);
      changed ||= itemChanged === true;
      const encoded = JSON.stringify(item);
      if (encoded === undefined) throw new Error('collection_item_unserializable');
      if (!first) await handle.writeFile(',', 'utf8');
      await handle.writeFile(encoded, 'utf8');
      first = false;
      itemCount += 1;
    }
    for (const item of options.appendItems?.() || []) {
      const encoded = JSON.stringify(item);
      if (encoded === undefined) throw new Error('collection_item_unserializable');
      if (!first) await handle.writeFile(',', 'utf8');
      await handle.writeFile(encoded, 'utf8');
      first = false;
      itemCount += 1;
      changed = true;
    }
    await handle.writeFile(']', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!changed) {
      await fs.unlink(tmpPath).catch(() => undefined);
      return { changed: false, itemCount };
    }
    const stat = await fs.stat(tmpPath);
    if (stat.size < 2) throw new Error('atomic_streaming_write_validation_failed');
    if (!isTransientProjectionCandidateCollection(collection)) await refreshBackup(getFilePath(collection));
    await commitPreparedFile(
        collection,
        getFilePath(collection),
        tmpPath,
        options,
        timing,
        assertLockHeld,
    );
    return { changed: true, itemCount };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Append to a validated JSON array without parsing or reserializing its
 * existing members. The copied temporary file is still fsynced and atomically
 * promoted, so a crash leaves either the old file or the complete new file.
 */
async function appendJsonArrayFile<T>(
    sourcePath: string,
    collection: string,
    appended: T[],
    sourceItemCount: number,
    options: StorageTransactionOptions,
    assertLockHeld?: () => Promise<void>,
    timing?: FileTransactionTiming,
): Promise<{ changed: boolean; itemCount: number }> {
  if (!appended.length) return { changed: false, itemCount: sourceItemCount };
  const targetPath = getFilePath(collection);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await fs.copyFile(sourcePath, tmpPath);
    const sourceStat = await fs.stat(sourcePath);
    const tailLength = Math.min(4_096, sourceStat.size);
    handle = await fs.open(tmpPath, 'r+');
    const tail = Buffer.alloc(tailLength);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, sourceStat.size - tailLength);
    let closingBracket = -1;
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const byte = tail[index];
      if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) {
        // Locate the ASCII array terminator in byte space. Using a decoded
        // string here would turn UTF-8 character offsets into invalid file
        // positions for Vietnamese or other multibyte durable fields.
        closingBracket = byte === 0x5d ? index : -1;
        break;
      }
    }
    if (closingBracket < 0) throw new Error('atomic_append_source_not_json_array');
    const closingOffset = sourceStat.size - tailLength + closingBracket;
    const encoded = JSON.stringify(appended);
    if (!encoded || encoded[0] !== '[' || encoded[encoded.length - 1] !== ']') {
      throw new Error('collection_item_unserializable');
    }
    const inner = encoded.slice(1, -1);
    const suffix = `${sourceItemCount > 0 ? ',' : ''}${inner}]`;
    await handle.truncate(closingOffset);
    await handle.write(suffix, closingOffset, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await refreshBackup(targetPath);
    await commitPreparedFile(collection, targetPath, tmpPath, options, timing, assertLockHeld);
    return { changed: true, itemCount: sourceItemCount + appended.length };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

async function scanCollection<T>(
    collection: string,
    visitor: (item: T, index: number) => Promise<void> | void,
): Promise<StorageScanResult> {
  recordScanCollection();
  await ensureDataDir();
  const primary = getFilePath(collection);
  const paths = [primary, `${primary}.bak`, `${primary}.bak.2`];
  let originalError: unknown;
  let callbackError: unknown;

  for (const filePath of paths) {
    const stat = await fs.stat(filePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;

    try {
      const itemCount = await scanJsonArrayFile<T>(filePath, async (item, index) => {
        try {
          await visitor(item, index);
        } catch (error) {
          callbackError = error;
          throw error;
        }
      });
      return { itemCount, observedBytes: stat.size, queryCount: 1 };
    } catch (error) {
      if (callbackError !== undefined) throw callbackError;
      originalError = error;
      // A visitor may already have observed earlier members. Falling back to a
      // backup after a partial primary scan would replay those side effects and
      // make a repair non-deterministic. Full collection reads retain their
      // existing backup recovery path; streaming scans fail closed instead.
      break;
    }
  }

  if (originalError) {
    throw new Error(
        `Cannot scan collection ${collection}: ${
            originalError instanceof Error ? originalError.message : 'invalid_json'
        }`,
    );
  }
  return { itemCount: 0, observedBytes: 0, queryCount: 1 };
}

function boundedCollectionError(code: string, collection: string): Error {
  const error = new Error(`${code}:${collection}`) as Error & { code?: string };
  error.code = code;
  return error;
}

function validateBoundedCollectionOptions(
    collection: string,
    options: StorageBoundedCollectionOptions,
): { maximumItems: number; maximumBytes: number } {
  if (
      !Number.isFinite(options.maximumItems)
      || !Number.isInteger(options.maximumItems)
      || options.maximumItems <= 0
      || options.maximumItems > STORAGE_MAX_BOUNDED_ITEMS
      || !Number.isFinite(options.maximumBytes)
      || !Number.isInteger(options.maximumBytes)
      || options.maximumBytes <= 0
      || options.maximumBytes > STORAGE_MAX_BOUNDED_BYTES
  ) {
    throw boundedCollectionError('BOUNDED_COLLECTION_OPTIONS_INVALID', collection);
  }
  return {
    maximumItems: options.maximumItems,
    maximumBytes: options.maximumBytes,
  };
}

/**
 * Compact projections use this path so an unexpectedly large or corrupt read
 * model cannot turn an interactive request into a full-history parse. Unlike
 * durable collection recovery, normal read-model reads never consult backups.
 */
async function readBoundedCollectionSnapshot<T>(
    collection: string,
    options: StorageBoundedCollectionOptions,
): Promise<StorageBoundedCollectionResult<T>> {
  recordBoundedRead();
  const { maximumItems, maximumBytes } = validateBoundedCollectionOptions(collection, options);
  await ensureDataDir();
  const filePath = getFilePath(collection);
  const stat = await fs.stat(filePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) {
    return {
      items: [],
      metadata: {
        driver: 'file',
        collectionPresent: false,
        itemCount: 0,
        observedBytes: 0,
        maximumItems,
        maximumBytes,
        truncated: false,
        queryCount: 1,
      },
    };
  }
  if (stat.size > maximumBytes) {
    throw boundedCollectionError('BOUNDED_COLLECTION_BYTE_LIMIT_EXCEEDED', collection);
  }
  const raw = await fs.readFile(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > maximumBytes) {
    throw boundedCollectionError('BOUNDED_COLLECTION_BYTE_LIMIT_EXCEEDED', collection);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw boundedCollectionError('BOUNDED_COLLECTION_INVALID_JSON', collection);
  }
  if (!Array.isArray(parsed)) {
    throw boundedCollectionError('BOUNDED_COLLECTION_INVALID_ROOT', collection);
  }
  if (parsed.length > maximumItems) {
    throw boundedCollectionError('BOUNDED_COLLECTION_ITEM_LIMIT_EXCEEDED', collection);
  }
  return {
    items: parsed as T[],
    metadata: {
      driver: 'file',
      collectionPresent: true,
      itemCount: parsed.length,
      observedBytes: Buffer.byteLength(raw, 'utf8'),
      maximumItems,
      maximumBytes,
      truncated: false,
      queryCount: 1,
    },
  };
}

async function readBoundedCollection<T>(
    collection: string,
    options: StorageBoundedCollectionOptions,
): Promise<T[]> {
  return (await readBoundedCollectionSnapshot<T>(collection, options)).items;
}

const SAFE_PAGE_FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function validatePageOptions(options: StoragePageOptions): void {
  const filterFields = Object.keys(options.filters || {});
  const filterValues = Object.values(options.filters || {});
  if (
      !Number.isInteger(options.page)
      || options.page < 1
      || !Number.isInteger(options.pageSize)
      || options.pageSize < 1
      || options.pageSize > STORAGE_MAX_PAGE_SIZE
      || options.page > Math.floor(Number.MAX_SAFE_INTEGER / options.pageSize)
      || filterFields.some(field => !SAFE_PAGE_FIELD.test(field))
      || filterValues.some(value => typeof value !== 'string')
      || (options.sort?.field && !SAFE_PAGE_FIELD.test(options.sort.field))
      || (
          options.sort
          && ((options.page - 1) * options.pageSize + options.pageSize)
          > STORAGE_MAX_BOUNDED_ITEMS
      )
  ) {
    throw boundedCollectionError('INVALID_STORAGE_QUERY', 'page');
  }
}

async function readCollectionPage<T>(collection: string, options: StoragePageOptions) {
  recordBoundedRead();
  validatePageOptions(options);
  await ensureDataDir();
  const primary = getFilePath(collection);
  const stat = await fs.stat(primary).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const sourcePath = stat ? primary : (
      await fs.stat(`${primary}.bak`).then(() => `${primary}.bak`).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return fs.stat(`${primary}.bak.2`).then(() => `${primary}.bak.2`).catch(error2 => {
          if ((error2 as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error2;
        });
      })
  );
  if (!sourcePath) return { items: [] as T[], totalItems: 0, queryCount: 1 };

  const pageStart = (options.page - 1) * options.pageSize;
  const retainedLimit = options.sort
      ? pageStart + options.pageSize
      : options.pageSize;
  const matches: Array<{ item: T; order: number }> = [];
  let totalItems = 0;
  await scanJsonArrayFile<T>(sourcePath, (item, order) => {
    const matchesFilters = Object.entries(options.filters || {}).every(([field, expected]) => (
        item !== null
        && typeof item === 'object'
        && String((item as unknown as Record<string, unknown>)[field] ?? '') === expected
    ));
    if (!matchesFilters) return;
    totalItems += 1;
    if (!options.sort) {
      if (totalItems > pageStart && matches.length < options.pageSize) matches.push({ item, order });
      return;
    }
    matches.push({ item, order });
    if (matches.length > retainedLimit) {
      const { field, direction } = options.sort;
      const multiplier = direction === 'desc' ? -1 : 1;
      matches.sort((left, right) => {
        const leftValue = left.item !== null && typeof left.item === 'object'
            ? String((left.item as unknown as Record<string, unknown>)[field] ?? '')
            : '';
        const rightValue = right.item !== null && typeof right.item === 'object'
            ? String((right.item as unknown as Record<string, unknown>)[field] ?? '')
            : '';
        return (leftValue.localeCompare(rightValue) * multiplier) || left.order - right.order;
      });
      matches.pop();
    }
  });
  if (options.sort) {
    const { field, direction } = options.sort;
    const multiplier = direction === 'desc' ? -1 : 1;
    matches.sort((left, right) => {
      const leftValue = left.item !== null && typeof left.item === 'object'
          ? String((left.item as unknown as Record<string, unknown>)[field] ?? '')
          : '';
      const rightValue = right.item !== null && typeof right.item === 'object'
          ? String((right.item as unknown as Record<string, unknown>)[field] ?? '')
          : '';
      return (leftValue.localeCompare(rightValue) * multiplier) || left.order - right.order;
    });
  }
  const start = (options.page - 1) * options.pageSize;
  return {
    items: matches.slice(start, start + options.pageSize).map(({ item }) => item),
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

async function renameAtomicWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code || '');
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(160, 10 * (2 ** attempt))));
    }
  }
}

function isTransientProjectionCandidateCollection(collection: string): boolean {
  return /^(automation-job-projections|automation-job-list-projections-v2|automation-job-health-summary-v1)-generation-[ab]-repair-[1-9][0-9]*$/
      .test(collection);
}

/** Write and fsync a compact snapshot, then atomically replace the collection. */
async function writeCollectionUnlocked<T>(
    collection: string,
    data: T[],
    options: StorageTransactionOptions = {},
    assertLockHeld?: () => Promise<void>,
    timing?: FileTransactionTiming,
): Promise<void> {
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
    // Each fenced repair candidate has a unique collection and is reproducible
    // from durable jobs. Backing it up would retain another large stale copy
    // after cleanup; the active legacy projection keeps normal rollback backups.
    if (!isTransientProjectionCandidateCollection(collection)) await refreshBackup(filePath);
    await commitPreparedFile(collection, filePath, tmpPath, options, timing, assertLockHeld);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

const collectionLocks = new Map<string, Promise<void>>();

async function withCollectionLock<T>(
    collection: string,
    work: (assertLockHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const safeCollection = validateFileCollectionName(collection);
  const previous = collectionLocks.get(safeCollection) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  collectionLocks.set(safeCollection, tail);

  let fileLock: CollectionFileLockHandle | undefined;
  let lockStartedAt = 0;
  try {
    await previous.catch(() => undefined);
    fileLock = await acquireCollectionFileLock(safeCollection);
    lockStartedAt = Date.now();
    recordLockAcquisition();
    return await work(fileLock.assertHeld);
  } finally {
    if (lockStartedAt) recordLockHold(Date.now() - lockStartedAt);
    await fileLock?.release();
    release();
    if (collectionLocks.get(safeCollection) === tail) {
      collectionLocks.delete(safeCollection);
    }
  }
}

async function writeCollection<T>(collection: string, data: T[]): Promise<void> {
  await withCollectionLock(collection, assertLockHeld =>
      writeCollectionUnlocked(collection, data, {}, assertLockHeld));
}

async function backupCollection(collection: string, label: string): Promise<string> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'manual';
  return withCollectionLock(collection, async assertLockHeld => {
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
    await assertLockHeld();
    const prefix = `${collection}.json.backup.${safeLabel}.`;
    const backups = (await fs.readdir(getDataDir(), { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
        .sort((left, right) => right.name.localeCompare(left.name));
    for (const old of backups.slice(3)) await fs.unlink(path.join(getDataDir(), old.name)).catch(() => undefined);
    return backupPath;
  });
}

async function runTransaction<T>(
    collection: string,
    fn: StorageTransaction<T>,
    options: StorageTransactionOptions = {},
): Promise<void> {
  const timing: FileTransactionTiming = { startedAt: Date.now() };
  let changed = false;
  try {
    await invokeTransactionTestHook('COLLECTION_LOCK_WAIT_STARTED', collection, options);
    await withCollectionLock(collection, async assertLockHeld => {
      timing.collectionLockAcquiredAt = Date.now();
      await invokeTransactionTestHook('COLLECTION_LOCK_ACQUIRED', collection, options);
      const items = await readCollectionUnlocked<T>(collection);
      const updated = await fn(items);
      if (updated !== undefined) {
        await writeCollectionUnlocked(collection, updated, options, assertLockHeld, timing);
        changed = true;
      }
    });
    timing.completedAt = Date.now();
    logFileTransactionTiming(collection, options, timing, undefined, changed);
  } catch (error) {
    timing.completedAt = Date.now();
    logFileTransactionTiming(collection, options, timing, error);
    throw error;
  }
}

async function runStreamingTransaction<T>(
    collection: string,
    fn: StorageStreamingTransaction<T>,
    options: StorageStreamingTransactionOptions<T> = {},
): Promise<{ changed: boolean; itemCount: number }> {
  const timing: FileTransactionTiming = { startedAt: Date.now() };
  try {
    await invokeTransactionTestHook('COLLECTION_LOCK_WAIT_STARTED', collection, options);
    const result = await withCollectionLock(collection, async assertLockHeld => {
      timing.collectionLockAcquiredAt = Date.now();
      await invokeTransactionTestHook('COLLECTION_LOCK_ACQUIRED', collection, options);
      await ensureDataDir();
      const filePath = getFilePath(collection);
      const source = [filePath, `${filePath}.bak`, `${filePath}.bak.2`];
      let sourcePath: string | undefined;
      for (const candidate of source) {
        const stat = await fs.stat(candidate).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (stat) {
          sourcePath = candidate;
          break;
        }
      }
      if (!sourcePath) {
        await options.beforeMutation?.();
        const appended = options.appendItems?.() || [];
        if (!appended.length) return { changed: false, itemCount: 0 };
        await writeCollectionUnlocked(collection, appended, options, assertLockHeld, timing);
        return { changed: true, itemCount: appended.length };
      }
      let preparedItemCount = 0;
      if (options.prepare || options.appendOnly) {
        preparedItemCount = await scanJsonArrayFile<T>(sourcePath, async (item, index) => {
          await options.prepare?.(item, index);
        });
      }
      await options.beforeMutation?.();
      if (options.appendOnly) {
        return appendJsonArrayFile(
            sourcePath,
            collection,
            options.appendItems?.() || [],
            preparedItemCount,
            options,
            assertLockHeld,
            timing,
        );
      }
      return transformJsonArrayFile<T>(
          sourcePath,
          collection,
          fn,
          options,
          assertLockHeld,
          timing,
      );
    });
    timing.completedAt = Date.now();
    logFileTransactionTiming(collection, options, timing, undefined, result.changed);
    return result;
  } catch (error) {
    timing.completedAt = Date.now();
    logFileTransactionTiming(collection, options, timing, error);
    throw error;
  }
}

async function bulkMutateCollection<T extends { id: string }>(
    collection: string,
    mutations: StorageBulkMutation<T>[],
): Promise<StorageBulkResult> {
  let output!: StorageBulkResult;
  await runTransaction<T>(collection, items => {
    const applied = applyStorageBulkMutations(items, mutations);
    output = {
      schemaVersion: 1,
      driver: 'file',
      mode: 'FILE_ATOMIC_REVISION',
      requested: mutations.length,
      applied: applied.applied,
      failed: applied.failed,
      results: applied.results,
    };
    return applied.applied > 0 ? applied.items : undefined;
  });
  return output;
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
  capabilities: {
    schemaVersion: 1,
    driver: 'file',
    transactions: true,
    atomicCollectionRevision: true,
    boundedBulkMutation: true,
    partialFailureReporting: true,
    nativeBulkWrite: false,
    maximumBulkItems: 100,
  },
  getDataDir,
  ensureDataDir,
  readCollection,
  scanCollection,
  readBoundedCollection,
  readBoundedCollectionSnapshot,
  readCollectionPage,
  writeCollection,
  backupCollection,
  runTransaction,
  runStreamingTransaction,
  bulkMutateCollection,
  checkHealth,
};
