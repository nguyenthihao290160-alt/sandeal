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

type StorageDiagnosticsCounters = StorageDiagnosticsSnapshot;

type NumericCounterKey = {
  [Key in keyof StorageDiagnosticsCounters]:
  StorageDiagnosticsCounters[Key] extends number ? Key : never;
}[keyof StorageDiagnosticsCounters];

type LatencyMetricKind = 'fileLock' | 'jobLease' | 'roleHeartbeat';

interface LatencyMetricKeys {
  count: NumericCounterKey;
  failure: NumericCounterKey;
  total: NumericCounterKey;
  maximum: NumericCounterKey;
}

const MAX_DIAGNOSTIC_DURATION_MS = 24 * 60 * 60_000;
const MAX_COLLECTION_KEYS = 64;
const MAX_STALE_LOCK_REASON_KEYS = 32;
const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;

const LATENCY_METRIC_KEYS: Readonly<
    Record<LatencyMetricKind, Readonly<LatencyMetricKeys>>
> = Object.freeze({
  fileLock: Object.freeze({
    count: 'fileLockHeartbeatCount',
    failure: 'fileLockHeartbeatFailureCount',
    total: 'totalFileLockHeartbeatMs',
    maximum: 'maximumFileLockHeartbeatMs',
  }),
  jobLease: Object.freeze({
    count: 'jobLeaseRenewalCount',
    failure: 'jobLeaseRenewalFailureCount',
    total: 'totalJobLeaseRenewalMs',
    maximum: 'maximumJobLeaseRenewalMs',
  }),
  roleHeartbeat: Object.freeze({
    count: 'roleHeartbeatRenewalCount',
    failure: 'roleHeartbeatRenewalFailureCount',
    total: 'totalRoleHeartbeatRenewalMs',
    maximum: 'maximumRoleHeartbeatRenewalMs',
  }),
});

function createCounterMap(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function createCounters(): StorageDiagnosticsCounters {
  return {
    fullCollectionReadCount: 0,
    fullCollectionReadsByCollection: createCounterMap(),
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
    staleLockRecoveriesByReason: createCounterMap(),
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
    lastOperationAt: null,
  };
}

const counters = createCounters();

function touch(): void {
  counters.lastOperationAt = new Date().toISOString();
}

function normalizeDurationMs(durationMs: number): number {
  const parsed = Number(durationMs);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(
      0,
      Math.min(MAX_DIAGNOSTIC_DURATION_MS, Math.floor(parsed)),
  );
}

function normalizedDimensionKey(
    value: unknown,
    maximumLength: number,
): string {
  if (typeof value !== 'string') return '__unknown__';

  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength
      ? normalized
      : '__unknown__';
}

function saturatingAdd(current: number, amount: number): number {
  const normalizedAmount = Math.max(0, Math.floor(amount));
  if (
      current >= MAX_COUNTER_VALUE
      || normalizedAmount >= MAX_COUNTER_VALUE - current
  ) {
    return MAX_COUNTER_VALUE;
  }
  return current + normalizedAmount;
}

function incrementDimension(
    target: Record<string, number>,
    key: string,
    maximumKeys: number,
): void {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    target[key] = saturatingAdd(target[key], 1);
    return;
  }

  // Reserve one bounded slot for the overflow bucket so high-cardinality
  // collection/reason input cannot grow diagnostics memory without limit.
  const maximumNamedKeys = Math.max(0, maximumKeys - 1);
  if (Object.keys(target).length < maximumNamedKeys) {
    target[key] = 1;
    return;
  }

  target.__other__ = saturatingAdd(target.__other__ || 0, 1);
}

function setNumericCounter(
    key: NumericCounterKey,
    value: number,
): void {
  counters[key] = value;
}

function incrementNumericCounter(key: NumericCounterKey): void {
  setNumericCounter(key, saturatingAdd(counters[key], 1));
}

function addNumericCounter(
    key: NumericCounterKey,
    amount: number,
): void {
  setNumericCounter(key, saturatingAdd(counters[key], amount));
}

function updateMaximumCounter(
    key: NumericCounterKey,
    value: number,
): void {
  setNumericCounter(
      key,
      Math.max(counters[key], Math.max(0, Math.floor(value))),
  );
}

export function recordFullCollectionRead(collection?: string): void {
  incrementNumericCounter('fullCollectionReadCount');
  incrementDimension(
      counters.fullCollectionReadsByCollection,
      normalizedDimensionKey(collection, 96),
      MAX_COLLECTION_KEYS,
  );
  touch();
}

export function recordScanCollection(): void {
  incrementNumericCounter('scanCollectionCount');
  touch();
}

export function recordBoundedRead(): void {
  incrementNumericCounter('boundedReadCount');
  touch();
}

export function recordLockAcquisition(): void {
  incrementNumericCounter('lockAcquisitionCount');
  touch();
}

export function recordLockWait(durationMs: number): void {
  const bounded = normalizeDurationMs(durationMs);
  incrementNumericCounter('lockWaitCount');
  addNumericCounter('totalLockWaitMs', bounded);
  updateMaximumCounter('maximumLockWaitMs', bounded);
  touch();
}

export function recordLockHold(durationMs: number): void {
  const bounded = normalizeDurationMs(durationMs);
  incrementNumericCounter('lockHoldCount');
  addNumericCounter('totalLockHoldMs', bounded);
  updateMaximumCounter('maximumLockHoldMs', bounded);
  touch();
}

export function recordStaleLockRecovery(reasonCode: string): void {
  incrementNumericCounter('staleLockRecoveryCount');
  incrementDimension(
      counters.staleLockRecoveriesByReason,
      normalizedDimensionKey(reasonCode, 96),
      MAX_STALE_LOCK_REASON_KEYS,
  );
  touch();
}

function recordLatency(
    kind: LatencyMetricKind,
    durationMs: number,
    succeeded: boolean,
): void {
  const bounded = normalizeDurationMs(durationMs);
  const keys = LATENCY_METRIC_KEYS[kind];

  incrementNumericCounter(keys.count);
  if (!succeeded) incrementNumericCounter(keys.failure);
  addNumericCounter(keys.total, bounded);
  updateMaximumCounter(keys.maximum, bounded);
  touch();
}

export function recordFileLockHeartbeat(
    durationMs: number,
    succeeded: boolean,
): void {
  recordLatency('fileLock', durationMs, succeeded);
}

export function recordJobLeaseRenewal(
    durationMs: number,
    succeeded: boolean,
): void {
  recordLatency('jobLease', durationMs, succeeded);
}

export function recordRoleHeartbeatRenewal(
    durationMs: number,
    succeeded: boolean,
): void {
  recordLatency('roleHeartbeat', durationMs, succeeded);
}

export function recordFencingRejection(): void {
  incrementNumericCounter('fencingRejectionCount');
  touch();
}

export function getStorageDiagnosticsSnapshot(): StorageDiagnosticsSnapshot {
  return {
    ...counters,
    fullCollectionReadsByCollection: {
      ...counters.fullCollectionReadsByCollection,
    },
    staleLockRecoveriesByReason: {
      ...counters.staleLockRecoveriesByReason,
    },
  };
}

export function resetStorageDiagnostics(): void {
  Object.assign(counters, createCounters());
}
