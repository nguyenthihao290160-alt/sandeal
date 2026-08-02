export interface StorageDiagnosticsSnapshot {
  fullCollectionReadCount: number;
  fullCollectionReadsByCollection: Record<string, number>;
  scanCollectionCount: number;
  boundedReadCount: number;
  lockAcquisitionCount: number;
  lockHoldCount: number;
  totalLockHoldMs: number;
  maximumLockHoldMs: number;
  lastOperationAt: string | null;
}

const counters = {
  fullCollectionReadCount: 0,
  fullCollectionReadsByCollection: Object.create(null) as Record<string, number>,
  scanCollectionCount: 0,
  boundedReadCount: 0,
  lockAcquisitionCount: 0,
  lockHoldCount: 0,
  totalLockHoldMs: 0,
  maximumLockHoldMs: 0,
  lastOperationAt: null as string | null,
};

function touch(): void {
  counters.lastOperationAt = new Date().toISOString();
}

export function recordFullCollectionRead(collection?: string): void {
  counters.fullCollectionReadCount += 1;
  const key = typeof collection === 'string' && collection.length <= 96 ? collection : '__unknown__';
  const knownKeys = Object.keys(counters.fullCollectionReadsByCollection);
  if (Object.prototype.hasOwnProperty.call(counters.fullCollectionReadsByCollection, key) || knownKeys.length < 64) {
    counters.fullCollectionReadsByCollection[key] = (counters.fullCollectionReadsByCollection[key] || 0) + 1;
  } else {
    counters.fullCollectionReadsByCollection.__other__ = (counters.fullCollectionReadsByCollection.__other__ || 0) + 1;
  }
  touch();
}

export function recordScanCollection(): void {
  counters.scanCollectionCount += 1;
  touch();
}

export function recordBoundedRead(): void {
  counters.boundedReadCount += 1;
  touch();
}

export function recordLockAcquisition(): void {
  counters.lockAcquisitionCount += 1;
  touch();
}

export function recordLockHold(durationMs: number): void {
  const bounded = Math.max(0, Math.min(24 * 60 * 60_000, Math.floor(durationMs)));
  counters.lockHoldCount += 1;
  counters.totalLockHoldMs += bounded;
  counters.maximumLockHoldMs = Math.max(counters.maximumLockHoldMs, bounded);
  touch();
}

export function getStorageDiagnosticsSnapshot(): StorageDiagnosticsSnapshot {
  return {
    ...counters,
    fullCollectionReadsByCollection: { ...counters.fullCollectionReadsByCollection },
  };
}

export function resetStorageDiagnostics(): void {
  counters.fullCollectionReadCount = 0;
  counters.fullCollectionReadsByCollection = Object.create(null) as Record<string, number>;
  counters.scanCollectionCount = 0;
  counters.boundedReadCount = 0;
  counters.lockAcquisitionCount = 0;
  counters.lockHoldCount = 0;
  counters.totalLockHoldMs = 0;
  counters.maximumLockHoldMs = 0;
  counters.lastOperationAt = null;
}
