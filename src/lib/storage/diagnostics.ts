export interface StorageDiagnosticsSnapshot {
  fullCollectionReadCount: number;
  fullCollectionReadsByCollection: Record<string, number>;
  scanCollectionCount: number;
  boundedReadCount: number;
  lockAcquisitionCount: number;
  lockWaitCount: number;
  totalLockWaitMs: number;
  maximumLockWaitMs: number;
  lockHoldCount: number;
  totalLockHoldMs: number;
  maximumLockHoldMs: number;
  staleLockRecoveryCount: number;
  staleLockRecoveriesByReason: Record<string, number>;
  fileLockHeartbeatCount: number;
  fileLockHeartbeatFailureCount: number;
  totalFileLockHeartbeatMs: number;
  maximumFileLockHeartbeatMs: number;
  jobLeaseRenewalCount: number;
  jobLeaseRenewalFailureCount: number;
  totalJobLeaseRenewalMs: number;
  maximumJobLeaseRenewalMs: number;
  roleHeartbeatRenewalCount: number;
  roleHeartbeatRenewalFailureCount: number;
  totalRoleHeartbeatRenewalMs: number;
  maximumRoleHeartbeatRenewalMs: number;
  fencingRejectionCount: number;
  lastOperationAt: string | null;
}

const counters = {
  fullCollectionReadCount: 0,
  fullCollectionReadsByCollection: Object.create(null) as Record<string, number>,
  scanCollectionCount: 0,
  boundedReadCount: 0,
  lockAcquisitionCount: 0,
  lockWaitCount: 0,
  totalLockWaitMs: 0,
  maximumLockWaitMs: 0,
  lockHoldCount: 0,
  totalLockHoldMs: 0,
  maximumLockHoldMs: 0,
  staleLockRecoveryCount: 0,
  staleLockRecoveriesByReason: Object.create(null) as Record<string, number>,
  fileLockHeartbeatCount: 0,
  fileLockHeartbeatFailureCount: 0,
  totalFileLockHeartbeatMs: 0,
  maximumFileLockHeartbeatMs: 0,
  jobLeaseRenewalCount: 0,
  jobLeaseRenewalFailureCount: 0,
  totalJobLeaseRenewalMs: 0,
  maximumJobLeaseRenewalMs: 0,
  roleHeartbeatRenewalCount: 0,
  roleHeartbeatRenewalFailureCount: 0,
  totalRoleHeartbeatRenewalMs: 0,
  maximumRoleHeartbeatRenewalMs: 0,
  fencingRejectionCount: 0,
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

export function recordLockWait(durationMs: number): void {
  const bounded = Math.max(0, Math.min(24 * 60 * 60_000, Math.floor(durationMs)));
  counters.lockWaitCount += 1;
  counters.totalLockWaitMs += bounded;
  counters.maximumLockWaitMs = Math.max(counters.maximumLockWaitMs, bounded);
  touch();
}

export function recordLockHold(durationMs: number): void {
  const bounded = Math.max(0, Math.min(24 * 60 * 60_000, Math.floor(durationMs)));
  counters.lockHoldCount += 1;
  counters.totalLockHoldMs += bounded;
  counters.maximumLockHoldMs = Math.max(counters.maximumLockHoldMs, bounded);
  touch();
}

export function recordStaleLockRecovery(reasonCode: string): void {
  counters.staleLockRecoveryCount += 1;
  const key = typeof reasonCode === 'string' && reasonCode.length <= 96 ? reasonCode : '__unknown__';
  const knownKeys = Object.keys(counters.staleLockRecoveriesByReason);
  if (Object.prototype.hasOwnProperty.call(counters.staleLockRecoveriesByReason, key) || knownKeys.length < 32) {
    counters.staleLockRecoveriesByReason[key] = (counters.staleLockRecoveriesByReason[key] || 0) + 1;
  } else {
    counters.staleLockRecoveriesByReason.__other__ = (counters.staleLockRecoveriesByReason.__other__ || 0) + 1;
  }
  touch();
}

function recordLatency(
  kind: 'fileLock' | 'jobLease' | 'roleHeartbeat',
  durationMs: number,
  succeeded: boolean,
): void {
  const bounded = Math.max(0, Math.min(24 * 60 * 60_000, Math.floor(durationMs)));
  const countKey = `${kind}HeartbeatCount` as keyof typeof counters;
  const failureKey = `${kind}HeartbeatFailureCount` as keyof typeof counters;
  const totalKey = `total${kind === 'fileLock' ? 'FileLock' : kind === 'jobLease' ? 'JobLease' : 'RoleHeartbeat'}Ms` as keyof typeof counters;
  const maximumKey = `maximum${kind === 'fileLock' ? 'FileLock' : kind === 'jobLease' ? 'JobLease' : 'RoleHeartbeat'}Ms` as keyof typeof counters;
  const numericCounters = counters as unknown as Record<string, number>;
  numericCounters[countKey] = numericCounters[countKey] + 1;
  if (!succeeded) numericCounters[failureKey] = numericCounters[failureKey] + 1;
  numericCounters[totalKey] = numericCounters[totalKey] + bounded;
  numericCounters[maximumKey] = Math.max(numericCounters[maximumKey], bounded);
  touch();
}

export function recordFileLockHeartbeat(durationMs: number, succeeded: boolean): void {
  recordLatency('fileLock', durationMs, succeeded);
}

export function recordJobLeaseRenewal(durationMs: number, succeeded: boolean): void {
  recordLatency('jobLease', durationMs, succeeded);
}

export function recordRoleHeartbeatRenewal(durationMs: number, succeeded: boolean): void {
  recordLatency('roleHeartbeat', durationMs, succeeded);
}

export function recordFencingRejection(): void {
  counters.fencingRejectionCount += 1;
  touch();
}

export function getStorageDiagnosticsSnapshot(): StorageDiagnosticsSnapshot {
  return {
    ...counters,
    fullCollectionReadsByCollection: { ...counters.fullCollectionReadsByCollection },
    staleLockRecoveriesByReason: { ...counters.staleLockRecoveriesByReason },
  };
}

export function resetStorageDiagnostics(): void {
  counters.fullCollectionReadCount = 0;
  counters.fullCollectionReadsByCollection = Object.create(null) as Record<string, number>;
  counters.scanCollectionCount = 0;
  counters.boundedReadCount = 0;
  counters.lockAcquisitionCount = 0;
  counters.lockWaitCount = 0;
  counters.totalLockWaitMs = 0;
  counters.maximumLockWaitMs = 0;
  counters.lockHoldCount = 0;
  counters.totalLockHoldMs = 0;
  counters.maximumLockHoldMs = 0;
  counters.staleLockRecoveryCount = 0;
  counters.staleLockRecoveriesByReason = Object.create(null) as Record<string, number>;
  counters.fileLockHeartbeatCount = 0;
  counters.fileLockHeartbeatFailureCount = 0;
  counters.totalFileLockHeartbeatMs = 0;
  counters.maximumFileLockHeartbeatMs = 0;
  counters.jobLeaseRenewalCount = 0;
  counters.jobLeaseRenewalFailureCount = 0;
  counters.totalJobLeaseRenewalMs = 0;
  counters.maximumJobLeaseRenewalMs = 0;
  counters.roleHeartbeatRenewalCount = 0;
  counters.roleHeartbeatRenewalFailureCount = 0;
  counters.totalRoleHeartbeatRenewalMs = 0;
  counters.maximumRoleHeartbeatRenewalMs = 0;
  counters.fencingRejectionCount = 0;
  counters.lastOperationAt = null;
}
