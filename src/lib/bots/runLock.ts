// ===========================================
// Run Lock — Prevents concurrent AutoPilot runs
// File-based lock for PM2/VPS compatibility
// ===========================================

import { promises as fs } from 'fs';
import path from 'path';
import { ensureDataDir, generateId } from '../storage/adapter';

const DATA_DIR = path.join(process.cwd(), '.data');
const LOCK_FILE = path.join(DATA_DIR, 'autopilot-lock.json');

/** Lock TTL: 25 minutes. If older, lock is considered stale. */
const LOCK_TTL_MS = 25 * 60 * 1000;

export interface RunLockData {
  locked: boolean;
  runId: string;
  mode: string;
  trigger: string;
  startedAt: string;
  expiresAt: string;
}

export interface AcquireLockResult {
  acquired: boolean;
  runId: string;
  existingLock?: RunLockData;
  reason?: string;
}

async function readLock(): Promise<RunLockData | null> {
  try {
    const raw = await fs.readFile(LOCK_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.locked) {
      return data as RunLockData;
    }
    return null;
  } catch {
    return null;
  }
}

function isLockExpired(lock: RunLockData): boolean {
  try {
    const expiresAt = new Date(lock.expiresAt).getTime();
    return Date.now() > expiresAt;
  } catch {
    return true; // Corrupt date = expired
  }
}


/**
 * Try to acquire the run lock atomically.
 * Uses fs.open with 'wx' flag to prevent race conditions.
 */
export async function acquireRunLock(
  mode: string,
  trigger: string,
): Promise<AcquireLockResult> {
  await ensureDataDir();

  // Try to create the lock file atomically
  const runId = generateId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  const lockData: RunLockData = {
    locked: true,
    runId,
    mode,
    trigger,
    startedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const lockContent = JSON.stringify(lockData, null, 2);

  try {
    const fd = await fs.open(LOCK_FILE, 'wx');
    await fd.writeFile(lockContent, 'utf-8');
    await fd.close();
    return { acquired: true, runId };
  } catch (err: any) {
    // EEXIST means the file is locked by someone else (or a stale lock)
    if (err.code !== 'EEXIST') {
      console.error('[RunLock] Unexpected error acquiring lock:', err);
      return { acquired: false, runId: '', reason: 'Lỗi hệ thống khi tạo lock.' };
    }
  }

  // Lock exists. We need to check if it's stale.
  const existing = await readLock();

  if (existing && existing.locked && !isLockExpired(existing)) {
    return {
      acquired: false,
      runId: '',
      existingLock: existing,
      reason: `AutoPilot đang chạy (runId: ${existing.runId.slice(0, 8)}…, mode: ${existing.mode}). Vui lòng đợi hoàn tất.`,
    };
  }

  // Lock is stale or corrupt. Force release it, then retry.
  try {
    await fs.unlink(LOCK_FILE);
  } catch {
    // Ignore errors during unlink, someone else might have deleted it
  }

  // Retry acquiring once after cleaning up stale lock
  try {
    const fd = await fs.open(LOCK_FILE, 'wx');
    await fd.writeFile(lockContent, 'utf-8');
    await fd.close();
    return { acquired: true, runId, reason: 'Recovered from stale lock.' };
  } catch {
    return { acquired: false, runId: '', reason: 'AutoPilot đang chạy, vui lòng thử lại sau.' };
  }
}

/**
 * Release the run lock.
 * Only releases if the current lock belongs to the given runId.
 * Never crashes on failure.
 */
export async function releaseRunLock(runId: string): Promise<void> {
  try {
    const existing = await readLock();
    if (existing && existing.runId === runId) {
      await fs.unlink(LOCK_FILE);
    }
  } catch (err) {
    if ((err as any).code !== 'ENOENT') {
      console.error('[RunLock] Failed to release lock:', err instanceof Error ? err.message : String(err));
    }
    // Never crash — lock will expire by TTL or is already deleted
  }
}

/**
 * Get current lock status (safe for dashboard display).
 */
export async function getRunLockStatus(): Promise<{
  isLocked: boolean;
  lock: RunLockData | null;
  isExpired: boolean;
}> {
  const lock = await readLock();

  if (!lock || !lock.locked) {
    return { isLocked: false, lock: null, isExpired: false };
  }

  const expired = isLockExpired(lock);
  return { isLocked: !expired, lock, isExpired: expired };
}

/**
 * Force-release an expired/stale lock.
 * Only releases if the lock is actually expired (past TTL).
 * Dashboard admin utility — never releases an active lock.
 * Returns true if a stale lock was released.
 */
export async function forceReleaseExpiredLock(): Promise<{
  released: boolean;
  reason: string;
}> {
  try {
    const existing = await readLock();

    if (!existing || !existing.locked) {
      return { released: false, reason: 'Không có lock nào đang hoạt động.' };
    }

    if (!isLockExpired(existing)) {
      return {
        released: false,
        reason: `Lock đang hoạt động (runId: ${existing.runId.slice(0, 8)}…). Không thể force-release lock chưa hết hạn.`,
      };
    }

    await fs.unlink(LOCK_FILE);
    return {
      released: true,
      reason: `Đã giải phóng lock kẹt (runId: ${existing.runId.slice(0, 8)}…, started: ${existing.startedAt}).`,
    };
  } catch (err) {
    console.error('[RunLock] Force release failed:', err instanceof Error ? err.message : String(err));
    return { released: false, reason: 'Lỗi khi giải phóng lock.' };
  }
}
