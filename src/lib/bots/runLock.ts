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

async function writeLock(data: RunLockData | null): Promise<void> {
  await ensureDataDir();
  if (!data) {
    // Write an unlocked state
    const content = JSON.stringify({ locked: false }, null, 2);
    await fs.writeFile(LOCK_FILE, content, 'utf-8');
  } else {
    const content = JSON.stringify(data, null, 2);
    await fs.writeFile(LOCK_FILE, content, 'utf-8');
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
 * Try to acquire the run lock.
 * If another run is active and not expired, returns acquired=false.
 * If lock is expired (stale), overwrites it.
 */
export async function acquireRunLock(
  mode: string,
  trigger: string,
): Promise<AcquireLockResult> {
  const existing = await readLock();

  // Check if there is an active, non-expired lock
  if (existing && existing.locked && !isLockExpired(existing)) {
    return {
      acquired: false,
      runId: '',
      existingLock: existing,
      reason: `AutoPilot đang chạy (runId: ${existing.runId.slice(0, 8)}…, mode: ${existing.mode}). Vui lòng đợi hoàn tất.`,
    };
  }

  // Stale lock or no lock — acquire
  const runId = generateId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  const lock: RunLockData = {
    locked: true,
    runId,
    mode,
    trigger,
    startedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await writeLock(lock);

  return { acquired: true, runId };
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
      await writeLock(null);
    }
    // If lock belongs to another run, don't touch it
  } catch (err) {
    console.error('[RunLock] Failed to release lock:', err instanceof Error ? err.message : String(err));
    // Never crash — lock will expire by TTL
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
