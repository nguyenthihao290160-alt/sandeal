import { createHash, randomUUID } from 'crypto';

import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { readBoundedCollectionSnapshot, runTransaction } from '@/lib/storage/adapter';
import type {
  AutomationJobListProjection,
  AutomationJobStatus,
  AutomationJobStatusProjection,
  AutomationJobType,
} from './types';

const jobListProjectionCollection = 'automation-job-list-projections-v2';
const jobStatusProjectionCollection = 'automation-job-projections';
const healthSummaryCollection = 'automation-job-health-summary-v1';
const projectionManifestCollection = 'automation-job-projection-manifest-v1';
const HEALTH_SUMMARY_ID = 'automation-job-health-summary';
const PROJECTION_MANIFEST_ID = 'automation-job-projection-manifest';
const ACTIVE_STATUSES = new Set<AutomationJobStatus>([
  'PENDING',
  'WAITING_APPROVAL',
  'WAITING_FOR_MANUAL_INPUT',
  'WAITING_CHILDREN',
  'RUNNING',
  'RETRY_SCHEDULED',
  'PAUSED',
]);
const PENDING_STATUSES = new Set<AutomationJobStatus>(['PENDING', 'RETRY_SCHEDULED']);
const ALL_STATUSES: AutomationJobStatus[] = [
  'PENDING',
  'WAITING_APPROVAL',
  'WAITING_FOR_MANUAL_INPUT',
  'WAITING_CHILDREN',
  'RUNNING',
  'RETRY_SCHEDULED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
  'PAUSED',
];
const STATUS_SET = new Set<string>(ALL_STATUSES);
const MAX_RUNNING_ENTRIES = 100;
const MAX_PENDING_ENTRIES = 500;
const MAX_RECENT_ENTRIES = 50;
const MAX_PICKUP_SAMPLES = 500;
const PICKUP_WINDOW_MS = 24 * 60 * 60_000;
const ACTIVE_SUMMARY_FRESHNESS_MS = 2 * 60_000;
const IDLE_SUMMARY_FRESHNESS_MS = 24 * 60 * 60_000;
const STUCK_PENDING_MS = 30 * 60_000;
const PROJECTION_MAXIMUM_BYTES = 16 * 1024 * 1024;
const SUMMARY_MAXIMUM_BYTES = 512 * 1024;

export const AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION = 2;
export const AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION = 2;
export const AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION = 2;
export const AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION = 2;
export const AUTOMATION_JOB_PROJECTION_VERSION = 'automation-job-projection-v3';
export const AUTOMATION_JOB_PROJECTION_NAME = 'automation-job-health';
export const AUTOMATION_JOB_PROJECTION_SOURCE_SCHEMA_VERSION = 1;

export type AutomationJobProjectionStorageSlot = 'LEGACY' | 'A' | 'B';

export interface AutomationJobProjectionStorageCollections {
  list: string;
  status: string;
  summary: string;
}

export interface AutomationJobProjectionCandidateStorageRef {
  slot: Exclude<AutomationJobProjectionStorageSlot, 'LEGACY'>;
  repairFence: number;
}

const PROJECTION_STORAGE_COLLECTIONS: Readonly<Record<AutomationJobProjectionStorageSlot, AutomationJobProjectionStorageCollections>> = {
  LEGACY: {
    list: jobListProjectionCollection,
    status: jobStatusProjectionCollection,
    summary: healthSummaryCollection,
  },
  A: {
    list: `${jobListProjectionCollection}-generation-a`,
    status: `${jobStatusProjectionCollection}-generation-a`,
    summary: `${healthSummaryCollection}-generation-a`,
  },
  B: {
    list: `${jobListProjectionCollection}-generation-b`,
    status: `${jobStatusProjectionCollection}-generation-b`,
    summary: `${healthSummaryCollection}-generation-b`,
  },
};

export function automationJobProjectionStorageCollections(
  slot: AutomationJobProjectionStorageSlot,
  repairFence?: number,
): AutomationJobProjectionStorageCollections {
  const base = PROJECTION_STORAGE_COLLECTIONS[slot];
  if (slot === 'LEGACY' || !Number.isInteger(repairFence) || Number(repairFence) <= 0) {
    return { ...base };
  }
  const suffix = `-repair-${Math.floor(Number(repairFence))}`;
  return {
    list: `${base.list}${suffix}`,
    status: `${base.status}${suffix}`,
    summary: `${base.summary}${suffix}`,
  };
}

export type AutomationJobProjectionRepairPhase =
  | 'SCHEDULED'
  | 'CLAIMED'
  | 'REBUILDING'
  | 'CATCHING_UP'
  | 'VALIDATING'
  | 'PUBLISHING'
  | 'COMPLETED'
  | 'RETRY_WAIT'
  | 'FAILED'
  | 'SUPERSEDED';

export interface AutomationJobProjectionSourceBoundary {
  schemaVersion: typeof AUTOMATION_JOB_PROJECTION_SOURCE_SCHEMA_VERSION;
  highWatermark: number;
  sourceFingerprint: string | null;
}

export interface AutomationJobProjectionSyncOperation {
  token: string;
  sequence: number;
  targetGeneration: number;
  targetSlot: AutomationJobProjectionStorageSlot;
  targetRepairFence?: number;
  startedAt: string;
}

export interface AutomationJobProjectionRepairLease {
  repairId: string;
  rebuildToken: string;
  repairFence: number;
  ownerId: string;
  ownerInstanceId: string;
  workerFencingToken: number;
  claimTokenHash: string;
  attemptNumber: number;
  phase: AutomationJobProjectionRepairPhase;
  startedAt: string;
  updatedAt: string;
  targetGeneration: number;
  targetSlot: Exclude<AutomationJobProjectionStorageSlot, 'LEGACY'>;
  startBoundary: AutomationJobProjectionSourceBoundary;
  candidateBoundary: AutomationJobProjectionSourceBoundary | null;
  catchUpPasses: number;
  catchUpPending: boolean;
  lastFailureReason: string | null;
}

export function getAutomationJobProjectionLimit(): number {
  return Math.min(
    10_000,
    Math.max(500, Number(process.env.SANDEAL_JOB_PROJECTION_LIMIT) || 2_000),
  );
}

export interface AutomationHealthJobReference {
  id: string;
  type: AutomationJobType;
  status: AutomationJobStatus;
  requestedBy: string;
  priority: number;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  runnableAt?: string;
  claimedAt?: string;
  claimedBy?: string;
  startedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  executionCritical?: boolean;
  lastErrorCode?: string;
}

export interface AutomationPickupLatencySample {
  id: string;
  jobId: string;
  jobType: AutomationJobType;
  attemptNumber: number;
  runnableAt: string;
  claimedAt: string;
  latencyMs: number;
}

export type ProjectionEvidenceClassification = 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';

export interface AutomationJobProjectionObservedRange {
  earliestCreatedAt: string | null;
  latestCreatedAt: string | null;
  earliestUpdatedAt: string | null;
  latestUpdatedAt: string | null;
}

export interface AutomationJobProjectionRetentionBoundary {
  field: 'updatedAt';
  oldestRetainedAt: string;
}

export interface AutomationJobProjectionEvidence {
  evidenceClassification: ProjectionEvidenceClassification;
  source: 'job-list-projection-v2' | 'job-status-projection-v1';
  collectionPresent: boolean;
  currentStateComplete: boolean;
  historyComplete: boolean;
  truncated: boolean;
  observedRange: AutomationJobProjectionObservedRange;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  manifestRebuiltAt: string | null;
  manifestReleaseId: string | null;
  manifestUpdatedAt: string | null;
  projectionVersion: typeof AUTOMATION_JOB_PROJECTION_VERSION | null;
  sourceRevision: string | null;
  summaryRevision: string | null;
  projectionFingerprint: string | null;
  generatedAt: string | null;
  recordCounts: {
    durable: number | null;
    active: number | null;
    retained: number | null;
    retainedTerminal: number | null;
    list: number | null;
    status: number | null;
  };
  completeness: {
    baselineEstablished: boolean;
    currentStateComplete: boolean;
    historyComplete: boolean;
    truncated: boolean;
  };
}

export interface AutomationJobProjectionManifest {
  schemaVersion: typeof AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION;
  id: typeof PROJECTION_MANIFEST_ID;
  listProjectionSchemaVersion: typeof AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION;
  statusProjectionSchemaVersion: typeof AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION;
  projectionVersion: typeof AUTOMATION_JOB_PROJECTION_VERSION;
  releaseId: string;
  sourceRevision: string;
  summaryRevision: string | null;
  projectionFingerprint: string;
  generatedAt: string;
  observedRange: AutomationJobProjectionObservedRange;
  recordCounts: {
    durable: number;
    active: number;
    retained: number;
    retainedTerminal: number;
    list: number;
    status: number;
  };
  completeness: {
    baselineEstablished: boolean;
    currentStateComplete: boolean;
    historyComplete: boolean;
    truncated: boolean;
  };
  projectionCapacity: number;
  durableJobCount: number;
  activeJobCount: number;
  retainedJobCount: number;
  retainedTerminalCount: number;
  listProjectionCount: number;
  statusProjectionCount: number;
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  listProjectionContentFingerprint: string;
  statusProjectionContentFingerprint: string;
  baselineEstablished: boolean;
  currentStateComplete: boolean;
  historyComplete: boolean;
  truncated: boolean;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  sourceUpdatedAt: string | null;
  rebuiltAt: string | null;
  lastRebuildStatus: 'NEVER' | 'SUCCEEDED' | 'FAILED';
  lastRebuildFailureAt: string | null;
  rebuildToken?: string;
  mutationDuringRebuild: boolean;
  inFlightSyncTokens: string[];
  syncFailureCountSinceRebuild: number;
  /** Additive M3.1.2 protocol fields; absence means a valid M3.1/M3.1.1 legacy generation. */
  repairProtocolVersion?: 2;
  activeGeneration?: number;
  activeSlot?: AutomationJobProjectionStorageSlot;
  activeStorageRepairFence?: number;
  nextMutationSequence?: number;
  sourceHighWatermark?: number;
  sourceFingerprint?: string | null;
  inFlightSyncOperations?: AutomationJobProjectionSyncOperation[];
  repairFence?: number;
  activeRepair?: AutomationJobProjectionRepairLease;
  lastSuccessfulRepairAt?: string | null;
  legacyMirrorPending?: boolean;
  staleCandidateStorage?: AutomationJobProjectionCandidateStorageRef[];
  updatedAt: string;
}

export interface AutomationJobHealthSummary {
  schemaVersion: typeof AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION;
  projectionSchemaVersion: typeof AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION;
  projectionVersion: typeof AUTOMATION_JOB_PROJECTION_VERSION;
  id: typeof HEALTH_SUMMARY_ID;
  sourceRevision: string;
  summaryRevision: string;
  projectionFingerprint: string;
  generatedAt: string;
  observedRange: AutomationJobProjectionObservedRange;
  recordCounts: AutomationJobProjectionEvidence['recordCounts'];
  completeness: AutomationJobProjectionManifest['completeness'];
  statusCounts: Record<AutomationJobStatus, number>;
  activeTypeCounts: Partial<Record<AutomationJobType, number>>;
  totalProjectedJobs: number;
  projectionCapacity: number;
  projectionEvidence: AutomationJobProjectionEvidence;
  coverageComplete: boolean;
  legacyProjectionCount: number;
  invalidProjectionCount: number;
  runningJobs: AutomationHealthJobReference[];
  pendingJobs: AutomationHealthJobReference[];
  recentJobs: AutomationHealthJobReference[];
  latestSuccess: AutomationHealthJobReference | null;
  latestFailure: AutomationHealthJobReference | null;
  latestSchedulerSuccess: AutomationHealthJobReference | null;
  oldestPendingAt: string | null;
  pickupLatency: {
    windowStartedAt: string;
    windowEndedAt: string;
    sampleCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    insufficientEvidenceCount: number;
    samples: AutomationPickupLatencySample[];
  };
  sourceUpdatedAt: string | null;
  releaseId: string;
  updatedAt: string;
}

export interface AutomationJobHealthView extends AutomationJobHealthSummary {
  availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
  source: 'summary' | 'previous_valid_summary' | 'bounded_projection_fallback' | 'empty_fallback';
  projectionStatus:
    | 'VALID'
    | 'STALE'
    | 'INVALID'
    | 'REBUILD_SCHEDULED'
    | 'REBUILD_RUNNING'
    | 'REBUILD_FAILED'
    | 'UNKNOWN';
  previousValidProjectionAvailable: boolean;
  previousValidProjectionGeneratedAt: string | null;
  stale: boolean;
  reasonCodes: string[];
  evidenceClassification: ProjectionEvidenceClassification;
  currentStateComplete: boolean;
  historyComplete: boolean;
  truncated: boolean;
  collectionPresent: boolean;
  observedRange: AutomationJobProjectionObservedRange;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  staleRunningCount: number;
  stuckPendingCount: number;
  oldestPendingAgeMs: number | null;
  activeProjectionGeneration: number | null;
  activeProjectionSlot: AutomationJobProjectionStorageSlot | null;
  /** The authoritative serving generation, derived from the promoted manifest pointer. */
  currentServingProjectionValid: boolean;
  currentServingProjectionFingerprint: string | null;
  currentServingProjectionSourceRevision: string | null;
  pendingProjectionGeneration: number | null;
  pendingProjectionSlot: Exclude<AutomationJobProjectionStorageSlot, 'LEGACY'> | null;
  currentSourceBoundary: AutomationJobProjectionSourceBoundary | null;
  lastSuccessfulRepairAt: string | null;
  activeRepairId: string | null;
  repairOwnerId: string | null;
  repairOwnerInstanceId: string | null;
  repairFencingToken: number | null;
  repairWorkerFencingToken: number | null;
  repairStartedAt: string | null;
  /** Last fenced repair-progress update. It is not a substitute for the Worker job heartbeat. */
  repairLastHeartbeatAt: string | null;
  repairPhase: AutomationJobProjectionRepairPhase | null;
  repairAttemptNumber: number | null;
  lastRepairFailureReason: string | null;
  nextRepairRetryAt: string | null;
  catchUpPending: boolean;
  previousValidProjectionServing: boolean;
  legacyMirrorPending: boolean;
}

export interface BoundedAutomationJobProjectionRead {
  items: AutomationJobListProjection[];
  availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
  reasonCodes: string[];
  evidenceClassification: ProjectionEvidenceClassification;
  source: 'job-list-projection-v2';
  collectionPresent: boolean;
  currentStateComplete: boolean;
  historyComplete: boolean;
  truncated: boolean;
  observedRange: AutomationJobProjectionObservedRange;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  manifestRebuiltAt: string | null;
  manifestReleaseId: string | null;
  manifestUpdatedAt: string | null;
  projectionVersion: typeof AUTOMATION_JOB_PROJECTION_VERSION | null;
  sourceRevision: string | null;
  summaryRevision: string | null;
  projectionFingerprint: string | null;
  generatedAt: string | null;
  recordCounts: AutomationJobProjectionEvidence['recordCounts'];
  completeness: AutomationJobProjectionEvidence['completeness'];
  coverageComplete: boolean;
  invalidProjectionCount: number;
  legacyProjectionCount: number;
}

export interface BoundedAutomationJobStatusRead {
  items: AutomationJobStatusProjection[];
  availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
  reasonCodes: string[];
  evidenceClassification: ProjectionEvidenceClassification;
  source: 'job-status-projection-v1';
  collectionPresent: boolean;
  currentStateComplete: boolean;
  historyComplete: boolean;
  truncated: boolean;
  observedRange: AutomationJobProjectionObservedRange;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  manifestRebuiltAt: string | null;
  manifestReleaseId: string | null;
  manifestUpdatedAt: string | null;
  projectionVersion: typeof AUTOMATION_JOB_PROJECTION_VERSION | null;
  sourceRevision: string | null;
  summaryRevision: string | null;
  projectionFingerprint: string | null;
  generatedAt: string | null;
  recordCounts: AutomationJobProjectionEvidence['recordCounts'];
  completeness: AutomationJobProjectionEvidence['completeness'];
  coverageComplete: boolean;
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : null;
}

function newestTimestamp(values: Array<string | undefined>): string | null {
  const parsed = values
    .map(value => ({ value, parsed: timestamp(value) }))
    .filter((item): item is { value: string; parsed: number } => item.value !== undefined && item.parsed !== null)
    .sort((left, right) => right.parsed - left.parsed);
  return parsed[0]?.value || null;
}

function oldestTimestamp(values: Array<string | undefined>): string | null {
  const parsed = values
    .map(value => ({ value, parsed: timestamp(value) }))
    .filter((item): item is { value: string; parsed: number } => item.value !== undefined && item.parsed !== null)
    .sort((left, right) => left.parsed - right.parsed);
  return parsed[0]?.value || null;
}

function observedRange(
  items: Array<Pick<AutomationJobListProjection, 'createdAt' | 'updatedAt'>>,
): AutomationJobProjectionObservedRange {
  return {
    earliestCreatedAt: oldestTimestamp(items.map(item => item.createdAt)),
    latestCreatedAt: newestTimestamp(items.map(item => item.createdAt)),
    earliestUpdatedAt: oldestTimestamp(items.map(item => item.updatedAt)),
    latestUpdatedAt: newestTimestamp(items.map(item => item.updatedAt)),
  };
}

function retentionBoundary(
  range: AutomationJobProjectionObservedRange,
  truncated: boolean,
): AutomationJobProjectionRetentionBoundary | null {
  return truncated && range.earliestUpdatedAt
    ? { field: 'updatedAt', oldestRetainedAt: range.earliestUpdatedAt }
    : null;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function statusCounts(): Record<AutomationJobStatus, number> {
  return Object.fromEntries(ALL_STATUSES.map(status => [status, 0])) as Record<AutomationJobStatus, number>;
}

export function automationJobProjectionFingerprint(
  items: Array<Pick<AutomationJobListProjection, 'id' | 'status' | 'updatedAt'>>,
): string {
  return createHash('sha256')
    .update(canonicalProjectionSerialization(
      [...items]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(item => ({ id: item.id, status: item.status, updatedAt: item.updatedAt })),
    ))
    .digest('hex');
}

export function automationJobProjectionContentFingerprint(items: unknown[]): string {
  const normalized = items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const {
      heartbeatAt: _heartbeatAt,
      leaseExpiresAt: _leaseExpiresAt,
      projectionSourceVersion: _projectionSourceVersion,
      ...stable
    } = item as Record<string, unknown>;
    void _heartbeatAt;
    void _leaseExpiresAt;
    void _projectionSourceVersion;
    return stable;
  });
  return deterministicProjectionFingerprint(
    [...normalized].sort((left, right) => {
      const leftId = left && typeof left === 'object'
        ? String((left as { id?: unknown }).id || '')
        : '';
      const rightId = right && typeof right === 'object'
        ? String((right as { id?: unknown }).id || '')
        : '';
      return leftId.localeCompare(rightId)
        || canonicalProjectionSerialization(left).localeCompare(canonicalProjectionSerialization(right));
    }),
  );
}

function canonicalProjectionValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : canonicalProjectionValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right))
        .filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, canonicalProjectionValue((value as Record<string, unknown>)[key])]),
    );
  }
  return null;
}

export function canonicalProjectionSerialization(value: unknown): string {
  return JSON.stringify(canonicalProjectionValue(value));
}

export function deterministicProjectionFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalProjectionSerialization(value)).digest('hex');
}

function revisionHash(value: unknown): string {
  return deterministicProjectionFingerprint(value);
}

function projectionFingerprint(input: {
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  listProjectionContentFingerprint: string;
  statusProjectionContentFingerprint: string;
  listProjectionCount: number;
  statusProjectionCount: number;
}): string {
  return revisionHash({
    list: input.listProjectionFingerprint,
    status: input.statusProjectionFingerprint,
    listContent: input.listProjectionContentFingerprint,
    statusContent: input.statusProjectionContentFingerprint,
    listCount: input.listProjectionCount,
    statusCount: input.statusProjectionCount,
  });
}

export function automationJobCombinedProjectionFingerprint(
  input: Parameters<typeof projectionFingerprint>[0],
): string {
  return projectionFingerprint(input);
}

function projectionSourceRevision(input: {
  releaseId: string;
  projectionFingerprint: string;
  durableJobCount: number;
  activeJobCount: number;
  retainedJobCount: number;
  sourceUpdatedAt: string | null;
}): string {
  return revisionHash({
    projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
    releaseId: input.releaseId,
    projectionFingerprint: input.projectionFingerprint,
    durableJobCount: input.durableJobCount,
    activeJobCount: input.activeJobCount,
    retainedJobCount: input.retainedJobCount,
    sourceUpdatedAt: input.sourceUpdatedAt,
  });
}

export function automationJobProjectionSourceRevision(
  input: Parameters<typeof projectionSourceRevision>[0],
): string {
  return projectionSourceRevision(input);
}

function healthSummaryRevision(summary: Omit<AutomationJobHealthSummary, 'summaryRevision'>): string {
  return revisionHash({
    schemaVersion: summary.schemaVersion,
    projectionVersion: summary.projectionVersion,
    sourceRevision: summary.sourceRevision,
    projectionFingerprint: summary.projectionFingerprint,
    releaseId: summary.releaseId,
    statusCounts: summary.statusCounts,
    activeTypeCounts: summary.activeTypeCounts,
    totalProjectedJobs: summary.totalProjectedJobs,
    sourceUpdatedAt: summary.sourceUpdatedAt,
    runningJobs: summary.runningJobs.map(job => [job.id, job.status, job.updatedAt]),
    pendingJobs: summary.pendingJobs.map(job => [job.id, job.status, job.updatedAt]),
    recentJobs: summary.recentJobs.map(job => [job.id, job.status, job.updatedAt]),
    pickupLatency: {
      windowStartedAt: summary.pickupLatency.windowStartedAt,
      windowEndedAt: summary.pickupLatency.windowEndedAt,
      sampleCount: summary.pickupLatency.sampleCount,
      p50Ms: summary.pickupLatency.p50Ms,
      p95Ms: summary.pickupLatency.p95Ms,
      insufficientEvidenceCount: summary.pickupLatency.insufficientEvidenceCount,
    },
    completeness: summary.completeness,
    recordCounts: summary.recordCounts,
  });
}

function emptyProjectionEvidence(
  source: AutomationJobProjectionEvidence['source'],
  classification: ProjectionEvidenceClassification = 'INCOMPLETE',
): AutomationJobProjectionEvidence {
  return {
    evidenceClassification: classification,
    source,
    collectionPresent: false,
    currentStateComplete: false,
    historyComplete: false,
    truncated: false,
    observedRange: observedRange([]),
    retentionBoundary: null,
    manifestRebuiltAt: null,
    manifestReleaseId: null,
    manifestUpdatedAt: null,
    projectionVersion: null,
    sourceRevision: null,
    summaryRevision: null,
    projectionFingerprint: null,
    generatedAt: null,
    recordCounts: {
      durable: null,
      active: null,
      retained: null,
      retainedTerminal: null,
      list: null,
      status: null,
    },
    completeness: {
      baselineEstablished: false,
      currentStateComplete: false,
      historyComplete: false,
      truncated: false,
    },
  };
}

function emptyProjectionManifest(now = Date.now()): AutomationJobProjectionManifest {
  const measuredAt = new Date(now).toISOString();
  const emptyFingerprint = automationJobProjectionFingerprint([]);
  const emptyContentFingerprint = automationJobProjectionContentFingerprint([]);
  const combinedFingerprint = projectionFingerprint({
    listProjectionFingerprint: emptyFingerprint,
    statusProjectionFingerprint: emptyFingerprint,
    listProjectionContentFingerprint: emptyContentFingerprint,
    statusProjectionContentFingerprint: emptyContentFingerprint,
    listProjectionCount: 0,
    statusProjectionCount: 0,
  });
  const releaseId = getReleaseIdentity().releaseId;
  return {
    schemaVersion: AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION,
    id: PROJECTION_MANIFEST_ID,
    listProjectionSchemaVersion: AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
    statusProjectionSchemaVersion: AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION,
    projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
    releaseId,
    sourceRevision: projectionSourceRevision({
      releaseId,
      projectionFingerprint: combinedFingerprint,
      durableJobCount: 0,
      activeJobCount: 0,
      retainedJobCount: 0,
      sourceUpdatedAt: null,
    }),
    summaryRevision: null,
    projectionFingerprint: combinedFingerprint,
    generatedAt: measuredAt,
    observedRange: observedRange([]),
    recordCounts: {
      durable: 0,
      active: 0,
      retained: 0,
      retainedTerminal: 0,
      list: 0,
      status: 0,
    },
    completeness: {
      baselineEstablished: false,
      currentStateComplete: false,
      historyComplete: false,
      truncated: false,
    },
    projectionCapacity: getAutomationJobProjectionLimit(),
    durableJobCount: 0,
    activeJobCount: 0,
    retainedJobCount: 0,
    retainedTerminalCount: 0,
    listProjectionCount: 0,
    statusProjectionCount: 0,
    listProjectionFingerprint: emptyFingerprint,
    statusProjectionFingerprint: emptyFingerprint,
    listProjectionContentFingerprint: emptyContentFingerprint,
    statusProjectionContentFingerprint: emptyContentFingerprint,
    baselineEstablished: false,
    currentStateComplete: false,
    historyComplete: false,
    truncated: false,
    retentionBoundary: null,
    sourceUpdatedAt: null,
    rebuiltAt: null,
    lastRebuildStatus: 'NEVER',
    lastRebuildFailureAt: null,
    mutationDuringRebuild: false,
    inFlightSyncTokens: [],
    syncFailureCountSinceRebuild: 0,
    repairProtocolVersion: 2,
    activeGeneration: 0,
    activeSlot: 'LEGACY',
    activeStorageRepairFence: 0,
    nextMutationSequence: 0,
    sourceHighWatermark: 0,
    sourceFingerprint: null,
    inFlightSyncOperations: [],
    repairFence: 0,
    lastSuccessfulRepairAt: null,
    legacyMirrorPending: false,
    staleCandidateStorage: [],
    updatedAt: measuredAt,
  };
}

function validStorageSlot(value: unknown): value is AutomationJobProjectionStorageSlot {
  return value === 'LEGACY' || value === 'A' || value === 'B';
}

function validCandidateStorageRef(value: unknown): value is AutomationJobProjectionCandidateStorageRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<AutomationJobProjectionCandidateStorageRef>;
  return (ref.slot === 'A' || ref.slot === 'B')
    && Number.isInteger(ref.repairFence)
    && Number(ref.repairFence) > 0;
}

function appendStaleCandidateStorage(
  current: AutomationJobProjectionCandidateStorageRef[] | undefined,
  candidate: AutomationJobProjectionCandidateStorageRef | null,
): AutomationJobProjectionCandidateStorageRef[] {
  const refs = candidate ? [...(current || []), candidate] : [...(current || [])];
  const unique = new Map(refs.map(ref => [`${ref.slot}:${ref.repairFence}`, ref]));
  if (unique.size > 64) throw new Error('JOB_PROJECTION_CANDIDATE_CLEANUP_CAPACITY_EXCEEDED');
  return [...unique.values()];
}

function validSourceBoundary(value: unknown): value is AutomationJobProjectionSourceBoundary {
  if (!value || typeof value !== 'object') return false;
  const boundary = value as Partial<AutomationJobProjectionSourceBoundary>;
  return boundary.schemaVersion === AUTOMATION_JOB_PROJECTION_SOURCE_SCHEMA_VERSION
    && Number.isInteger(boundary.highWatermark)
    && Number(boundary.highWatermark) >= 0
    && (boundary.sourceFingerprint === null
      || (typeof boundary.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(boundary.sourceFingerprint)));
}

function validSyncOperation(value: unknown): value is AutomationJobProjectionSyncOperation {
  if (!value || typeof value !== 'object') return false;
  const operation = value as Partial<AutomationJobProjectionSyncOperation>;
  return typeof operation.token === 'string'
    && operation.token.length > 0
    && operation.token.length <= 100
    && Number.isInteger(operation.sequence)
    && Number(operation.sequence) > 0
    && Number.isInteger(operation.targetGeneration)
    && Number(operation.targetGeneration) >= 0
    && validStorageSlot(operation.targetSlot)
    && (operation.targetRepairFence === undefined
      || (Number.isInteger(operation.targetRepairFence) && Number(operation.targetRepairFence) >= 0))
    && timestamp(operation.startedAt) !== null;
}

function validRepairLease(value: unknown): value is AutomationJobProjectionRepairLease {
  if (!value || typeof value !== 'object') return false;
  const repair = value as Partial<AutomationJobProjectionRepairLease>;
  return typeof repair.repairId === 'string'
    && repair.repairId.length > 0
    && repair.repairId.length <= 160
    && typeof repair.rebuildToken === 'string'
    && repair.rebuildToken.length > 0
    && repair.rebuildToken.length <= 100
    && Number.isInteger(repair.repairFence)
    && Number(repair.repairFence) > 0
    && typeof repair.ownerId === 'string'
    && repair.ownerId.length > 0
    && typeof repair.ownerInstanceId === 'string'
    && repair.ownerInstanceId.length > 0
    && Number.isInteger(repair.workerFencingToken)
    && Number(repair.workerFencingToken) >= 0
    && typeof repair.claimTokenHash === 'string'
    && /^[a-f0-9]{64}$/.test(repair.claimTokenHash)
    && Number.isInteger(repair.attemptNumber)
    && Number(repair.attemptNumber) > 0
    && [
      'SCHEDULED', 'CLAIMED', 'REBUILDING', 'CATCHING_UP', 'VALIDATING',
      'PUBLISHING', 'COMPLETED', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED',
    ].includes(String(repair.phase))
    && timestamp(repair.startedAt) !== null
    && timestamp(repair.updatedAt) !== null
    && Number.isInteger(repair.targetGeneration)
    && Number(repair.targetGeneration) > 0
    && (repair.targetSlot === 'A' || repair.targetSlot === 'B')
    && validSourceBoundary(repair.startBoundary)
    && (repair.candidateBoundary === null || validSourceBoundary(repair.candidateBoundary))
    && Number.isInteger(repair.catchUpPasses)
    && Number(repair.catchUpPasses) >= 0
    && typeof repair.catchUpPending === 'boolean'
    && (repair.lastFailureReason === null || typeof repair.lastFailureReason === 'string');
}

function projectionProtocolFieldsValid(manifest: Partial<AutomationJobProjectionManifest>): boolean {
  if (manifest.repairProtocolVersion === undefined) return true;
  return manifest.repairProtocolVersion === 2
    && Number.isInteger(manifest.activeGeneration)
    && Number(manifest.activeGeneration) >= 0
    && validStorageSlot(manifest.activeSlot)
    && (manifest.activeStorageRepairFence === undefined
      || (Number.isInteger(manifest.activeStorageRepairFence)
        && Number(manifest.activeStorageRepairFence) >= 0))
    && Number.isInteger(manifest.nextMutationSequence)
    && Number(manifest.nextMutationSequence) >= 0
    && Number.isInteger(manifest.sourceHighWatermark)
    && Number(manifest.sourceHighWatermark) >= 0
    && Number(manifest.sourceHighWatermark) <= Number(manifest.nextMutationSequence)
    && (manifest.sourceFingerprint === null
      || (typeof manifest.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(manifest.sourceFingerprint)))
    && Array.isArray(manifest.inFlightSyncOperations)
    && manifest.inFlightSyncOperations.every(validSyncOperation)
    && Number.isInteger(manifest.repairFence)
    && Number(manifest.repairFence) >= 0
    && (manifest.activeRepair === undefined || validRepairLease(manifest.activeRepair))
    && (manifest.lastSuccessfulRepairAt === null || timestamp(manifest.lastSuccessfulRepairAt) !== null)
    && typeof manifest.legacyMirrorPending === 'boolean'
    && (manifest.staleCandidateStorage === undefined
      || (Array.isArray(manifest.staleCandidateStorage)
        && manifest.staleCandidateStorage.length <= 64
        && manifest.staleCandidateStorage.every(validCandidateStorageRef)));
}

function withProjectionProtocol(
  manifest: AutomationJobProjectionManifest,
): AutomationJobProjectionManifest {
  if (manifest.repairProtocolVersion === 2) return manifest;
  const operations = manifest.inFlightSyncTokens.map((token, index) => ({
    token,
    sequence: index + 1,
    targetGeneration: 0,
    targetSlot: 'LEGACY' as const,
    targetRepairFence: 0,
    startedAt: manifest.updatedAt,
  }));
  return {
    ...manifest,
    repairProtocolVersion: 2,
    activeGeneration: 0,
    activeSlot: 'LEGACY',
    activeStorageRepairFence: 0,
    nextMutationSequence: operations.length,
    sourceHighWatermark: 0,
    sourceFingerprint: null,
    inFlightSyncOperations: operations,
    repairFence: 0,
    lastSuccessfulRepairAt: manifest.rebuiltAt,
    legacyMirrorPending: false,
    staleCandidateStorage: [],
  };
}

function isProjectionManifest(value: unknown): value is AutomationJobProjectionManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<AutomationJobProjectionManifest>;
  return manifest.id === PROJECTION_MANIFEST_ID
    && manifest.schemaVersion === AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION
    && manifest.listProjectionSchemaVersion === AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION
    && manifest.statusProjectionSchemaVersion === AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION
    && manifest.projectionVersion === AUTOMATION_JOB_PROJECTION_VERSION
    && typeof manifest.releaseId === 'string'
    && manifest.releaseId.length > 0
    && manifest.releaseId.length <= 160
    && typeof manifest.sourceRevision === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.sourceRevision)
    && (
      manifest.summaryRevision === null
      || (typeof manifest.summaryRevision === 'string' && /^[a-f0-9]{64}$/.test(manifest.summaryRevision))
    )
    && typeof manifest.projectionFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.projectionFingerprint)
    && timestamp(manifest.generatedAt) !== null
    && manifest.observedRange !== null
    && typeof manifest.observedRange === 'object'
    && [
      manifest.observedRange.earliestCreatedAt,
      manifest.observedRange.latestCreatedAt,
      manifest.observedRange.earliestUpdatedAt,
      manifest.observedRange.latestUpdatedAt,
    ].every(value => value === null || timestamp(value) !== null)
    && manifest.recordCounts !== null
    && typeof manifest.recordCounts === 'object'
    && [
      manifest.recordCounts.durable,
      manifest.recordCounts.active,
      manifest.recordCounts.retained,
      manifest.recordCounts.retainedTerminal,
      manifest.recordCounts.list,
      manifest.recordCounts.status,
    ].every(value => Number.isInteger(value) && Number(value) >= 0)
    && manifest.completeness !== null
    && typeof manifest.completeness === 'object'
    && typeof manifest.completeness.baselineEstablished === 'boolean'
    && typeof manifest.completeness.currentStateComplete === 'boolean'
    && typeof manifest.completeness.historyComplete === 'boolean'
    && typeof manifest.completeness.truncated === 'boolean'
    && Number.isInteger(manifest.projectionCapacity)
    && Number(manifest.projectionCapacity) > 0
    && Number.isInteger(manifest.durableJobCount)
    && Number(manifest.durableJobCount) >= 0
    && Number.isInteger(manifest.activeJobCount)
    && Number(manifest.activeJobCount) >= 0
    && Number.isInteger(manifest.retainedJobCount)
    && Number(manifest.retainedJobCount) >= 0
    && Number.isInteger(manifest.retainedTerminalCount)
    && Number(manifest.retainedTerminalCount) >= 0
    && Number.isInteger(manifest.listProjectionCount)
    && Number(manifest.listProjectionCount) >= 0
    && Number.isInteger(manifest.statusProjectionCount)
    && Number(manifest.statusProjectionCount) >= 0
    && typeof manifest.listProjectionFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.listProjectionFingerprint)
    && typeof manifest.statusProjectionFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.statusProjectionFingerprint)
    && typeof manifest.listProjectionContentFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.listProjectionContentFingerprint)
    && typeof manifest.statusProjectionContentFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.statusProjectionContentFingerprint)
    && typeof manifest.baselineEstablished === 'boolean'
    && typeof manifest.currentStateComplete === 'boolean'
    && typeof manifest.historyComplete === 'boolean'
    && typeof manifest.truncated === 'boolean'
    && (
      manifest.retentionBoundary === null
      || (
        manifest.retentionBoundary?.field === 'updatedAt'
        && timestamp(manifest.retentionBoundary.oldestRetainedAt) !== null
      )
    )
    && (manifest.sourceUpdatedAt === null || timestamp(manifest.sourceUpdatedAt) !== null)
    && (manifest.rebuiltAt === null || timestamp(manifest.rebuiltAt) !== null)
    && ['NEVER', 'SUCCEEDED', 'FAILED'].includes(String(manifest.lastRebuildStatus))
    && (manifest.lastRebuildFailureAt === null || timestamp(manifest.lastRebuildFailureAt) !== null)
    && (
      manifest.rebuildToken === undefined
      || (typeof manifest.rebuildToken === 'string' && manifest.rebuildToken.length <= 100)
    )
    && typeof manifest.mutationDuringRebuild === 'boolean'
    && Array.isArray(manifest.inFlightSyncTokens)
    && manifest.inFlightSyncTokens.every(token => typeof token === 'string' && token.length > 0)
    && Number.isInteger(manifest.syncFailureCountSinceRebuild)
    && Number(manifest.syncFailureCountSinceRebuild) >= 0
    && timestamp(manifest.updatedAt) !== null
    && manifest.recordCounts.durable === manifest.durableJobCount
    && manifest.recordCounts.active === manifest.activeJobCount
    && manifest.recordCounts.retained === manifest.retainedJobCount
    && manifest.recordCounts.retainedTerminal === manifest.retainedTerminalCount
    && manifest.recordCounts.list === manifest.listProjectionCount
    && manifest.recordCounts.status === manifest.statusProjectionCount
    && manifest.completeness.baselineEstablished === manifest.baselineEstablished
    && manifest.completeness.currentStateComplete === manifest.currentStateComplete
    && manifest.completeness.historyComplete === manifest.historyComplete
    && manifest.completeness.truncated === manifest.truncated
    && manifest.projectionFingerprint === projectionFingerprint({
      listProjectionFingerprint: manifest.listProjectionFingerprint,
      statusProjectionFingerprint: manifest.statusProjectionFingerprint,
      listProjectionContentFingerprint: manifest.listProjectionContentFingerprint,
      statusProjectionContentFingerprint: manifest.statusProjectionContentFingerprint,
      listProjectionCount: manifest.listProjectionCount,
      statusProjectionCount: manifest.statusProjectionCount,
    })
    && manifest.sourceRevision === projectionSourceRevision({
      releaseId: manifest.releaseId,
      projectionFingerprint: manifest.projectionFingerprint,
      durableJobCount: manifest.durableJobCount,
      activeJobCount: manifest.activeJobCount,
      retainedJobCount: manifest.retainedJobCount,
      sourceUpdatedAt: manifest.sourceUpdatedAt ?? null,
    })
    && projectionProtocolFieldsValid(manifest);
}

function manifestValidationReasonCodes(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['JOB_PROJECTION_MANIFEST_INVALID'];
  const manifest = value as Partial<AutomationJobProjectionManifest>;
  const reasons = [
    ...(manifest.schemaVersion !== AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION
      ? ['JOB_PROJECTION_MANIFEST_SCHEMA_MISMATCH']
      : []),
    ...(manifest.listProjectionSchemaVersion !== AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION
      || manifest.statusProjectionSchemaVersion !== AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION
      ? ['JOB_PROJECTION_MANIFEST_PROJECTION_SCHEMA_MISMATCH']
      : []),
    ...(manifest.projectionVersion !== AUTOMATION_JOB_PROJECTION_VERSION
      ? ['JOB_PROJECTION_MANIFEST_VERSION_MISMATCH']
      : []),
    ...(!/^[a-f0-9]{64}$/.test(String(manifest.sourceRevision || ''))
      ? ['JOB_PROJECTION_MANIFEST_SOURCE_REVISION_INVALID']
      : []),
    ...(
      manifest.summaryRevision !== null
      && !/^[a-f0-9]{64}$/.test(String(manifest.summaryRevision || ''))
        ? ['JOB_PROJECTION_MANIFEST_SUMMARY_REVISION_INVALID']
        : []
    ),
    ...(!/^[a-f0-9]{64}$/.test(String(manifest.projectionFingerprint || ''))
      ? ['JOB_PROJECTION_MANIFEST_FINGERPRINT_INVALID']
      : []),
    ...(
      !/^[a-f0-9]{64}$/.test(String(manifest.listProjectionContentFingerprint || ''))
      || !/^[a-f0-9]{64}$/.test(String(manifest.statusProjectionContentFingerprint || ''))
        ? ['JOB_PROJECTION_MANIFEST_CONTENT_FINGERPRINT_INVALID']
        : []
    ),
    ...(!manifest.generatedAt || timestamp(manifest.generatedAt) === null
      ? ['JOB_PROJECTION_MANIFEST_GENERATED_AT_INVALID']
      : []),
  ];
  if (
    typeof manifest.listProjectionFingerprint === 'string'
    && typeof manifest.statusProjectionFingerprint === 'string'
    && typeof manifest.listProjectionContentFingerprint === 'string'
    && typeof manifest.statusProjectionContentFingerprint === 'string'
    && Number.isInteger(manifest.listProjectionCount)
    && Number.isInteger(manifest.statusProjectionCount)
    && typeof manifest.projectionFingerprint === 'string'
    && manifest.projectionFingerprint !== projectionFingerprint({
      listProjectionFingerprint: manifest.listProjectionFingerprint,
      statusProjectionFingerprint: manifest.statusProjectionFingerprint,
      listProjectionContentFingerprint: manifest.listProjectionContentFingerprint,
      statusProjectionContentFingerprint: manifest.statusProjectionContentFingerprint,
      listProjectionCount: Number(manifest.listProjectionCount),
      statusProjectionCount: Number(manifest.statusProjectionCount),
    })
  ) {
    reasons.push('JOB_PROJECTION_MANIFEST_FINGERPRINT_MISMATCH');
  }
  if (
    typeof manifest.releaseId === 'string'
    && typeof manifest.projectionFingerprint === 'string'
    && Number.isInteger(manifest.durableJobCount)
    && Number.isInteger(manifest.activeJobCount)
    && Number.isInteger(manifest.retainedJobCount)
    && (manifest.sourceUpdatedAt === null || typeof manifest.sourceUpdatedAt === 'string')
    && typeof manifest.sourceRevision === 'string'
    && manifest.sourceRevision !== projectionSourceRevision({
      releaseId: manifest.releaseId,
      projectionFingerprint: manifest.projectionFingerprint,
      durableJobCount: Number(manifest.durableJobCount),
      activeJobCount: Number(manifest.activeJobCount),
      retainedJobCount: Number(manifest.retainedJobCount),
      sourceUpdatedAt: manifest.sourceUpdatedAt ?? null,
    })
  ) {
    reasons.push('JOB_PROJECTION_MANIFEST_SOURCE_REVISION_MISMATCH');
  }
  return [...new Set(reasons)];
}

export function validateAutomationJobProjectionManifest(value: unknown): {
  valid: boolean;
  reasonCodes: string[];
} {
  const valid = isProjectionManifest(value);
  return {
    valid,
    reasonCodes: valid
      ? []
      : ['JOB_PROJECTION_MANIFEST_INVALID', ...manifestValidationReasonCodes(value)],
  };
}

async function readProjectionManifest(): Promise<{
  manifest: AutomationJobProjectionManifest | null;
  collectionPresent: boolean;
  reasonCodes: string[];
}> {
  try {
    const snapshot = await readBoundedCollectionSnapshot<AutomationJobProjectionManifest>(
      projectionManifestCollection,
      { maximumItems: 1, maximumBytes: SUMMARY_MAXIMUM_BYTES },
    );
    if (!snapshot.metadata.collectionPresent) {
      return { manifest: null, collectionPresent: false, reasonCodes: ['JOB_PROJECTION_MANIFEST_MISSING'] };
    }
    if (snapshot.items.length !== 1 || !isProjectionManifest(snapshot.items[0])) {
      return {
        manifest: null,
        collectionPresent: true,
        reasonCodes: [
          'JOB_PROJECTION_MANIFEST_INVALID',
          ...manifestValidationReasonCodes(snapshot.items[0]),
        ],
      };
    }
    return {
      manifest: withProjectionProtocol(snapshot.items[0]),
      collectionPresent: true,
      reasonCodes: [],
    };
  } catch {
    return { manifest: null, collectionPresent: false, reasonCodes: ['JOB_PROJECTION_MANIFEST_UNAVAILABLE'] };
  }
}

export async function getAutomationJobProjectionManifestForMaintenance(): Promise<AutomationJobProjectionManifest | null> {
  return (await readProjectionManifest()).manifest;
}

export async function getAutomationJobActiveProjectionStorage(): Promise<{
  manifest: AutomationJobProjectionManifest | null;
  collections: AutomationJobProjectionStorageCollections;
}> {
  const manifest = (await readProjectionManifest()).manifest;
  const slot = manifest?.activeSlot || 'LEGACY';
  return {
    manifest,
    collections: automationJobProjectionStorageCollections(slot, manifest?.activeStorageRepairFence),
  };
}

export interface AutomationJobProjectionMutationHandle extends AutomationJobProjectionSyncOperation {
  /** Ephemeral versions assigned inside the authoritative JOBS transaction. */
  jobSourceVersions?: Readonly<Record<string, number>>;
}

export async function beginAutomationJobProjectionMutation(
  now = Date.now(),
): Promise<AutomationJobProjectionMutationHandle> {
  const token = randomUUID();
  const measuredAt = new Date(now).toISOString();
  let output: AutomationJobProjectionMutationHandle | undefined;
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    const current = isProjectionManifest(items[0])
      ? withProjectionProtocol(items[0])
      : emptyProjectionManifest(now);
    const existingOperations = current.inFlightSyncOperations || [];
    if (existingOperations.length >= 100) {
      throw new Error('JOB_PROJECTION_MUTATION_CAPACITY_EXCEEDED');
    }
    const sequence = (current.nextMutationSequence || 0) + 1;
    const operation: AutomationJobProjectionMutationHandle = {
      token,
      sequence,
      targetGeneration: current.activeGeneration || 0,
      targetSlot: current.activeSlot || 'LEGACY',
      targetRepairFence: current.activeSlot === 'LEGACY'
        ? 0
        : current.activeStorageRepairFence || 0,
      startedAt: measuredAt,
    };
    output = operation;
    return [{
      ...current,
      repairProtocolVersion: 2,
      nextMutationSequence: sequence,
      inFlightSyncOperations: [...existingOperations, operation],
      inFlightSyncTokens: [...current.inFlightSyncTokens, token],
      updatedAt: measuredAt,
    }];
  });
  if (!output) throw new Error('JOB_PROJECTION_MUTATION_RESERVATION_FAILED');
  return output;
}

/** Compatibility entrypoint for legacy callers that only persist the token. */
export async function beginAutomationJobProjectionSync(now = Date.now()): Promise<string> {
  return (await beginAutomationJobProjectionMutation(now)).token;
}

export interface AutomationJobProjectionSyncResult {
  success: boolean;
  inserted: boolean;
  listProjectionCount: number;
  statusProjectionCount: number;
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  listProjectionContentFingerprint: string;
  statusProjectionContentFingerprint: string;
  activeJobCount: number;
  retainedTerminalCount: number;
  retentionLimitReached: boolean;
  currentStateTruncated: boolean;
  sourceUpdatedAt: string | null;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  sourceAffected?: boolean;
  projectionChanged?: boolean;
  insertedCount?: number;
  removedCount?: number;
}

export async function abortAutomationJobProjectionMutation(
  handleOrToken: AutomationJobProjectionMutationHandle | string,
  now = Date.now(),
): Promise<void> {
  const token = typeof handleOrToken === 'string' ? handleOrToken : handleOrToken.token;
  const measuredAt = new Date(now).toISOString();
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) return undefined;
    const current = withProjectionProtocol(items[0]);
    if (!current.inFlightSyncTokens.includes(token)) return undefined;
    return [{
      ...current,
      inFlightSyncTokens: current.inFlightSyncTokens.filter(value => value !== token),
      inFlightSyncOperations: (current.inFlightSyncOperations || [])
        .filter(operation => operation.token !== token),
      updatedAt: measuredAt,
    }];
  });
}

export async function finishAutomationJobProjectionSync(
  handleOrToken: AutomationJobProjectionMutationHandle | string,
  result: AutomationJobProjectionSyncResult,
  now = Date.now(),
): Promise<void> {
  const token = typeof handleOrToken === 'string' ? handleOrToken : handleOrToken.token;
  const measuredAt = new Date(now).toISOString();
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) throw new Error('JOB_PROJECTION_MUTATION_MANIFEST_INVALID');
    const current = withProjectionProtocol(items[0]);
    if (!current.inFlightSyncTokens.includes(token)) {
      throw new Error('JOB_PROJECTION_MUTATION_SUPERSEDED');
    }
    const operation = (current.inFlightSyncOperations || [])
      .find(candidate => candidate.token === token);
    if (
      operation
      && (operation.targetGeneration !== current.activeGeneration
        || operation.targetSlot !== current.activeSlot)
    ) {
      throw new Error('JOB_PROJECTION_MUTATION_GENERATION_SUPERSEDED');
    }
    const inFlightSyncTokens = current.inFlightSyncTokens.filter(value => value !== token);
    const inFlightSyncOperations = (current.inFlightSyncOperations || [])
      .filter(value => value.token !== token);
    const sourceAffected = result.sourceAffected !== false;
    const operationSequence = operation?.sequence
      || (typeof handleOrToken === 'string' ? current.nextMutationSequence || 0 : handleOrToken.sequence);
    const sourceHighWatermark = sourceAffected
      ? Math.max(current.sourceHighWatermark || 0, operationSequence)
      : current.sourceHighWatermark || 0;
    const syncFailureCountSinceRebuild = current.syncFailureCountSinceRebuild + (result.success ? 0 : 1);
    if (!sourceAffected && !result.projectionChanged && result.success) {
      return [{
        ...current,
        inFlightSyncTokens,
        inFlightSyncOperations,
        updatedAt: measuredAt,
      }];
    }
    if (!result.success) {
      return [{
        ...current,
        sourceHighWatermark,
        sourceFingerprint: sourceAffected ? null : current.sourceFingerprint || null,
        summaryRevision: null,
        baselineEstablished: false,
        currentStateComplete: false,
        completeness: {
          ...current.completeness,
          baselineEstablished: false,
          currentStateComplete: false,
        },
        mutationDuringRebuild: current.mutationDuringRebuild || Boolean(current.activeRepair),
        inFlightSyncTokens,
        inFlightSyncOperations,
        syncFailureCountSinceRebuild,
        updatedAt: measuredAt,
      }];
    }
    const sameProjectionCount = result.listProjectionCount === result.statusProjectionCount;
    const sameProjectionIdentity = result.listProjectionFingerprint === result.statusProjectionFingerprint;
    const baselineEstablished = current.baselineEstablished
      && result.success
      && sameProjectionCount
      && sameProjectionIdentity
      && !result.currentStateTruncated
      && syncFailureCountSinceRebuild === 0;
    const truncated = current.truncated || result.retentionLimitReached;
    const historyComplete = baselineEstablished
      && current.historyComplete
      && !truncated
      && result.listProjectionCount < getAutomationJobProjectionLimit();
    const currentStateComplete = baselineEstablished
      && inFlightSyncTokens.length === 0
      && result.activeJobCount <= getAutomationJobProjectionLimit();
    const releaseId = getReleaseIdentity().releaseId;
    const combinedFingerprint = projectionFingerprint(result);
    const durableJobCount = Math.max(
      0,
      current.durableJobCount
        + (sourceAffected ? result.insertedCount ?? (result.inserted ? 1 : 0) : 0)
        - (sourceAffected ? result.removedCount || 0 : 0),
    );
    const retainedJobCount = Math.min(result.listProjectionCount, result.statusProjectionCount);
    const sourceUpdatedAt = newestTimestamp([
      current.sourceUpdatedAt || undefined,
      result.sourceUpdatedAt || undefined,
    ]);
    const sourceRevision = projectionSourceRevision({
      releaseId,
      projectionFingerprint: combinedFingerprint,
      durableJobCount,
      activeJobCount: result.activeJobCount,
      retainedJobCount,
      sourceUpdatedAt,
    });
    const updatedRange: AutomationJobProjectionObservedRange = {
      earliestCreatedAt: current.observedRange.earliestCreatedAt,
      latestCreatedAt: current.observedRange.latestCreatedAt,
      earliestUpdatedAt: result.retentionBoundary?.oldestRetainedAt
        || current.observedRange.earliestUpdatedAt,
      latestUpdatedAt: sourceUpdatedAt,
    };
    return [{
      ...current,
      projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
      releaseId,
      sourceRevision,
      summaryRevision: null,
      sourceHighWatermark,
      sourceFingerprint: null,
      projectionFingerprint: combinedFingerprint,
      generatedAt: measuredAt,
      observedRange: updatedRange,
      recordCounts: {
        durable: durableJobCount,
        active: result.activeJobCount,
        retained: retainedJobCount,
        retainedTerminal: result.retainedTerminalCount,
        list: result.listProjectionCount,
        status: result.statusProjectionCount,
      },
      completeness: {
        baselineEstablished,
        currentStateComplete,
        historyComplete,
        truncated,
      },
      projectionCapacity: getAutomationJobProjectionLimit(),
      durableJobCount,
      activeJobCount: result.activeJobCount,
      retainedJobCount,
      retainedTerminalCount: result.retainedTerminalCount,
      listProjectionCount: result.listProjectionCount,
      statusProjectionCount: result.statusProjectionCount,
      listProjectionFingerprint: result.listProjectionFingerprint,
      statusProjectionFingerprint: result.statusProjectionFingerprint,
      listProjectionContentFingerprint: result.listProjectionContentFingerprint,
      statusProjectionContentFingerprint: result.statusProjectionContentFingerprint,
      baselineEstablished,
      currentStateComplete,
      historyComplete,
      truncated,
      retentionBoundary: result.retentionBoundary || current.retentionBoundary,
      sourceUpdatedAt,
      inFlightSyncTokens,
      inFlightSyncOperations,
      mutationDuringRebuild: current.mutationDuringRebuild || Boolean(current.activeRepair),
      syncFailureCountSinceRebuild,
      updatedAt: measuredAt,
    }];
  });
}

/** Mark a committed source write fail-closed when its read-model delta was not applied. */
export async function invalidateAutomationJobProjectionMutation(
  handle: AutomationJobProjectionMutationHandle,
  now = Date.now(),
): Promise<void> {
  const emptyFingerprint = automationJobProjectionFingerprint([]);
  const emptyContentFingerprint = automationJobProjectionContentFingerprint([]);
  await finishAutomationJobProjectionSync(handle, {
    success: false,
    inserted: false,
    insertedCount: 0,
    sourceAffected: true,
    projectionChanged: false,
    listProjectionCount: 0,
    statusProjectionCount: 0,
    listProjectionFingerprint: emptyFingerprint,
    statusProjectionFingerprint: emptyFingerprint,
    listProjectionContentFingerprint: emptyContentFingerprint,
    statusProjectionContentFingerprint: emptyContentFingerprint,
    activeJobCount: 0,
    retainedTerminalCount: 0,
    retentionLimitReached: false,
    currentStateTruncated: false,
    sourceUpdatedAt: null,
    retentionBoundary: null,
  }, now);
}

const ACTIVE_REPAIR_MAX_AGE_MS = 30 * 60_000;
const STALE_SYNC_OPERATION_AGE_MS = 2 * 60_000;

export interface AutomationJobProjectionRepairOwnerInput {
  repairId: string;
  ownerId: string;
  ownerInstanceId: string;
  workerFencingToken: number;
  claimToken: string;
  attemptNumber: number;
  supersede?: boolean;
}

export interface AutomationJobProjectionRepairContext {
  repairId: string;
  rebuildToken: string;
  repairFence: number;
  targetGeneration: number;
  targetSlot: Exclude<AutomationJobProjectionStorageSlot, 'LEGACY'>;
  startBoundary: AutomationJobProjectionSourceBoundary;
  ownerId: string;
  ownerInstanceId: string;
  workerFencingToken: number;
  claimTokenHash: string;
  attemptNumber: number;
  startedAt: string;
}

function repairContext(repair: AutomationJobProjectionRepairLease): AutomationJobProjectionRepairContext {
  return {
    repairId: repair.repairId,
    rebuildToken: repair.rebuildToken,
    repairFence: repair.repairFence,
    targetGeneration: repair.targetGeneration,
    targetSlot: repair.targetSlot,
    startBoundary: repair.startBoundary,
    ownerId: repair.ownerId,
    ownerInstanceId: repair.ownerInstanceId,
    workerFencingToken: repair.workerFencingToken,
    claimTokenHash: repair.claimTokenHash,
    attemptNumber: repair.attemptNumber,
    startedAt: repair.startedAt,
  };
}

function repairMatches(
  repair: AutomationJobProjectionRepairLease | undefined,
  context: AutomationJobProjectionRepairContext,
): repair is AutomationJobProjectionRepairLease {
  return Boolean(
    repair
    && repair.repairId === context.repairId
    && repair.rebuildToken === context.rebuildToken
    && repair.repairFence === context.repairFence
    && repair.ownerId === context.ownerId
    && repair.ownerInstanceId === context.ownerInstanceId
    && repair.workerFencingToken === context.workerFencingToken
    && repair.claimTokenHash === context.claimTokenHash
    && repair.targetGeneration === context.targetGeneration
    && repair.targetSlot === context.targetSlot,
  );
}

export async function beginAutomationJobProjectionRebuild(
  owner: AutomationJobProjectionRepairOwnerInput,
  now = Date.now(),
): Promise<AutomationJobProjectionRepairContext> {
  const token = randomUUID();
  const measuredAt = new Date(now).toISOString();
  let output: AutomationJobProjectionRepairContext | undefined;
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    const current = isProjectionManifest(items[0])
      ? withProjectionProtocol(items[0])
      : emptyProjectionManifest(now);
    const existing = current.activeRepair;
    if (existing?.repairId === owner.repairId
      && existing.ownerId === owner.ownerId
      && existing.ownerInstanceId === owner.ownerInstanceId
      && existing.workerFencingToken === owner.workerFencingToken
      && existing.claimTokenHash === createHash('sha256').update(owner.claimToken).digest('hex')
      && !['FAILED', 'SUPERSEDED', 'COMPLETED'].includes(existing.phase)) {
      output = repairContext(existing);
      return undefined;
    }
    const existingAge = now - (timestamp(existing?.updatedAt) ?? Number.NEGATIVE_INFINITY);
    const existingAuthoritative = existing
      && !['FAILED', 'SUPERSEDED', 'COMPLETED'].includes(existing.phase)
      && existingAge <= ACTIVE_REPAIR_MAX_AGE_MS;
    if (existingAuthoritative && !owner.supersede) {
      throw new Error('JOB_PROJECTION_REPAIR_ALREADY_ACTIVE');
    }
    const supersededCandidate = existing
      && !(current.activeSlot === existing.targetSlot
        && current.activeStorageRepairFence === existing.repairFence)
      ? { slot: existing.targetSlot, repairFence: existing.repairFence }
      : null;

    const operations = current.inFlightSyncOperations || [];
    const liveOperations = operations.filter(operation => (
      now - (timestamp(operation.startedAt) ?? 0) <= STALE_SYNC_OPERATION_AGE_MS
    ));
    const staleOperations = operations.filter(operation => !liveOperations.includes(operation));
    const conservativeHighWatermark = staleOperations.reduce(
      (maximum, operation) => Math.max(maximum, operation.sequence),
      current.sourceHighWatermark || 0,
    );
    const activeSlot = current.activeSlot || 'LEGACY';
    const targetSlot: Exclude<AutomationJobProjectionStorageSlot, 'LEGACY'> = activeSlot === 'A' ? 'B' : 'A';
    const repairFence = (current.repairFence || 0) + 1;
    const startBoundary: AutomationJobProjectionSourceBoundary = {
      schemaVersion: AUTOMATION_JOB_PROJECTION_SOURCE_SCHEMA_VERSION,
      highWatermark: conservativeHighWatermark,
      sourceFingerprint: current.sourceFingerprint || null,
    };
    const repair: AutomationJobProjectionRepairLease = {
      repairId: owner.repairId.slice(0, 160),
      rebuildToken: token,
      repairFence,
      ownerId: owner.ownerId.slice(0, 160),
      ownerInstanceId: owner.ownerInstanceId.slice(0, 160),
      workerFencingToken: Math.max(0, Math.floor(owner.workerFencingToken)),
      claimTokenHash: createHash('sha256').update(owner.claimToken).digest('hex'),
      attemptNumber: Math.max(1, Math.floor(owner.attemptNumber)),
      phase: 'CLAIMED',
      startedAt: measuredAt,
      updatedAt: measuredAt,
      targetGeneration: (current.activeGeneration || 0) + 1,
      targetSlot,
      startBoundary,
      candidateBoundary: null,
      catchUpPasses: 0,
      catchUpPending: liveOperations.length > 0,
      lastFailureReason: null,
    };
    output = repairContext(repair);
    return [{
      ...current,
      repairProtocolVersion: 2,
      repairFence,
      activeRepair: repair,
      rebuildToken: token,
      mutationDuringRebuild: liveOperations.length > 0,
      sourceHighWatermark: conservativeHighWatermark,
      sourceFingerprint: staleOperations.length ? null : current.sourceFingerprint || null,
      inFlightSyncOperations: liveOperations,
      inFlightSyncTokens: liveOperations.map(operation => operation.token),
      staleCandidateStorage: appendStaleCandidateStorage(
        current.staleCandidateStorage,
        supersededCandidate,
      ),
      updatedAt: measuredAt,
    }];
  });
  if (!output) throw new Error('JOB_PROJECTION_REPAIR_CLAIM_FAILED');
  return output;
}

const REPAIR_PHASE_TRANSITIONS: Readonly<Record<AutomationJobProjectionRepairPhase, readonly AutomationJobProjectionRepairPhase[]>> = {
  SCHEDULED: ['CLAIMED', 'SUPERSEDED', 'FAILED'],
  CLAIMED: ['REBUILDING', 'SUPERSEDED', 'FAILED'],
  REBUILDING: ['CATCHING_UP', 'VALIDATING', 'SUPERSEDED', 'FAILED'],
  CATCHING_UP: ['CATCHING_UP', 'VALIDATING', 'RETRY_WAIT', 'SUPERSEDED', 'FAILED'],
  VALIDATING: ['PUBLISHING', 'RETRY_WAIT', 'SUPERSEDED', 'FAILED'],
  PUBLISHING: ['COMPLETED', 'RETRY_WAIT', 'SUPERSEDED', 'FAILED'],
  RETRY_WAIT: ['CATCHING_UP', 'VALIDATING', 'SUPERSEDED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  SUPERSEDED: [],
};

export async function transitionAutomationJobProjectionRepair(
  context: AutomationJobProjectionRepairContext,
  phase: AutomationJobProjectionRepairPhase,
  input: {
    candidateBoundary?: AutomationJobProjectionSourceBoundary | null;
    catchUpPasses?: number;
    catchUpPending?: boolean;
    lastFailureReason?: string | null;
  } = {},
  now = Date.now(),
): Promise<AutomationJobProjectionRepairLease> {
  const measuredAt = new Date(now).toISOString();
  let output: AutomationJobProjectionRepairLease | undefined;
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) throw new Error('JOB_PROJECTION_REPAIR_MANIFEST_INVALID');
    const current = withProjectionProtocol(items[0]);
    if (!repairMatches(current.activeRepair, context)) {
      throw new Error('JOB_PROJECTION_REPAIR_FENCING_REJECTED');
    }
    if (!REPAIR_PHASE_TRANSITIONS[current.activeRepair.phase].includes(phase)) {
      throw new Error(`JOB_PROJECTION_REPAIR_INVALID_TRANSITION:${current.activeRepair.phase}:${phase}`);
    }
    output = {
      ...current.activeRepair,
      phase,
      candidateBoundary: input.candidateBoundary === undefined
        ? current.activeRepair.candidateBoundary
        : input.candidateBoundary,
      catchUpPasses: input.catchUpPasses ?? current.activeRepair.catchUpPasses,
      catchUpPending: input.catchUpPending ?? current.activeRepair.catchUpPending,
      lastFailureReason: input.lastFailureReason === undefined
        ? current.activeRepair.lastFailureReason
        : input.lastFailureReason,
      updatedAt: measuredAt,
    };
    return [{
      ...current,
      activeRepair: output,
      mutationDuringRebuild: output.catchUpPending,
      updatedAt: measuredAt,
    }];
  });
  if (!output) throw new Error('JOB_PROJECTION_REPAIR_TRANSITION_FAILED');
  return output;
}

export interface AutomationJobProjectionRebuildResult {
  durableJobCount: number;
  activeJobCount: number;
  retainedJobCount: number;
  retainedTerminalCount: number;
  listProjectionCount: number;
  statusProjectionCount: number;
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  listProjectionContentFingerprint: string;
  statusProjectionContentFingerprint: string;
  truncated: boolean;
  sourceUpdatedAt: string | null;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  observedRange?: AutomationJobProjectionObservedRange;
  summaryRevision: string;
  sourceBoundary: AutomationJobProjectionSourceBoundary;
}

export async function finishAutomationJobProjectionRebuild(
  context: AutomationJobProjectionRepairContext,
  result: AutomationJobProjectionRebuildResult,
  now = Date.now(),
): Promise<AutomationJobProjectionManifest> {
  const measuredAt = new Date(now).toISOString();
  let output = emptyProjectionManifest(now);
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    const current = isProjectionManifest(items[0])
      ? withProjectionProtocol(items[0])
      : emptyProjectionManifest(now);
    if (!repairMatches(current.activeRepair, context) || current.rebuildToken !== context.rebuildToken) {
      throw new Error('JOB_PROJECTION_REPAIR_FENCING_REJECTED');
    }
    if (!['VALIDATING', 'PUBLISHING'].includes(current.activeRepair.phase)) {
      throw new Error(`JOB_PROJECTION_REPAIR_INVALID_TRANSITION:${current.activeRepair.phase}:PUBLISHING`);
    }
    const concurrentMutation = current.inFlightSyncTokens.length > 0
      || current.sourceHighWatermark !== result.sourceBoundary.highWatermark;
    const validResult = Boolean(
      result.listProjectionCount === result.statusProjectionCount
      && result.retainedJobCount === result.listProjectionCount
      && result.listProjectionFingerprint === result.statusProjectionFingerprint
      && /^[a-f0-9]{64}$/.test(result.summaryRevision)
      && validSourceBoundary(result.sourceBoundary)
      && result.sourceBoundary.sourceFingerprint !== null
      && current.activeRepair.candidateBoundary?.highWatermark === result.sourceBoundary.highWatermark
      && current.activeRepair.candidateBoundary.sourceFingerprint === result.sourceBoundary.sourceFingerprint
    );
    if (!validResult) throw new Error('JOB_PROJECTION_REBUILD_CANDIDATE_INVALID');
    if (concurrentMutation) throw new Error('JOB_PROJECTION_REPAIR_BOUNDARY_CHANGED');
    const atCapacity = Boolean(result && result.retainedJobCount >= getAutomationJobProjectionLimit());
    const baselineEstablished = true;
    const currentStateComplete = Number(result.activeJobCount || 0) <= getAutomationJobProjectionLimit();
    const historyComplete = !result.truncated && !atCapacity;
    const truncated = Boolean(result.truncated || atCapacity);
    const releaseId = getReleaseIdentity().releaseId;
    const combinedFingerprint = projectionFingerprint(result);
    const sourceRevision = projectionSourceRevision({
      releaseId,
      projectionFingerprint: combinedFingerprint,
      durableJobCount: result.durableJobCount,
      activeJobCount: result.activeJobCount,
      retainedJobCount: result.retainedJobCount,
      sourceUpdatedAt: result.sourceUpdatedAt,
    });
    const rebuiltObservedRange = result.observedRange || {
      earliestCreatedAt: null,
      latestCreatedAt: null,
      earliestUpdatedAt: result.retentionBoundary?.oldestRetainedAt || null,
      latestUpdatedAt: result.sourceUpdatedAt,
    };
    const previousCandidateStorage = (current.activeSlot === 'A' || current.activeSlot === 'B')
      && Number(current.activeStorageRepairFence) > 0
      ? {
          slot: current.activeSlot,
          repairFence: Number(current.activeStorageRepairFence),
        }
      : null;
    output = {
      ...current,
      projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
      releaseId,
      sourceRevision,
      summaryRevision: result.summaryRevision,
      projectionFingerprint: combinedFingerprint,
      generatedAt: measuredAt,
      observedRange: rebuiltObservedRange,
      recordCounts: {
        durable: result.durableJobCount,
        active: result.activeJobCount,
        retained: result.retainedJobCount,
        retainedTerminal: result.retainedTerminalCount,
        list: result.listProjectionCount,
        status: result.statusProjectionCount,
      },
      completeness: {
        baselineEstablished,
        currentStateComplete,
        historyComplete,
        truncated,
      },
      projectionCapacity: getAutomationJobProjectionLimit(),
      durableJobCount: result.durableJobCount,
      activeJobCount: result.activeJobCount,
      retainedJobCount: result.retainedJobCount,
      retainedTerminalCount: result.retainedTerminalCount,
      listProjectionCount: result.listProjectionCount,
      statusProjectionCount: result.statusProjectionCount,
      listProjectionFingerprint: result.listProjectionFingerprint,
      statusProjectionFingerprint: result.statusProjectionFingerprint,
      listProjectionContentFingerprint: result.listProjectionContentFingerprint,
      statusProjectionContentFingerprint: result.statusProjectionContentFingerprint,
      baselineEstablished,
      currentStateComplete,
      historyComplete,
      truncated,
      retentionBoundary: result.retentionBoundary || null,
      sourceUpdatedAt: result.sourceUpdatedAt || null,
      rebuiltAt: measuredAt,
      lastRebuildStatus: 'SUCCEEDED',
      lastRebuildFailureAt: current.lastRebuildFailureAt,
      rebuildToken: undefined,
      mutationDuringRebuild: false,
      syncFailureCountSinceRebuild: 0,
      activeGeneration: context.targetGeneration,
      activeSlot: context.targetSlot,
      activeStorageRepairFence: context.repairFence,
      sourceHighWatermark: result.sourceBoundary.highWatermark,
      sourceFingerprint: result.sourceBoundary.sourceFingerprint,
      activeRepair: {
        ...current.activeRepair,
        phase: 'PUBLISHING',
        candidateBoundary: result.sourceBoundary,
        catchUpPending: false,
        updatedAt: measuredAt,
      },
      legacyMirrorPending: true,
      staleCandidateStorage: appendStaleCandidateStorage(
        current.staleCandidateStorage,
        previousCandidateStorage,
      ),
      updatedAt: measuredAt,
    };
    return [output];
  });
  return output;
}

export async function completeAutomationJobProjectionRepair(
  context: AutomationJobProjectionRepairContext,
  input: {
    legacyMirrored: boolean;
    expectedSourceRevision?: string;
    expectedSummaryRevision?: string;
    expectedHighWatermark?: number;
  },
  now = Date.now(),
): Promise<AutomationJobProjectionManifest> {
  const measuredAt = new Date(now).toISOString();
  let output = emptyProjectionManifest(now);
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) throw new Error('JOB_PROJECTION_REPAIR_MANIFEST_INVALID');
    const current = withProjectionProtocol(items[0]);
    if (!repairMatches(current.activeRepair, context)) {
      throw new Error('JOB_PROJECTION_REPAIR_FENCING_REJECTED');
    }
    if (current.activeRepair.phase !== 'PUBLISHING') {
      throw new Error(`JOB_PROJECTION_REPAIR_INVALID_TRANSITION:${current.activeRepair.phase}:COMPLETED`);
    }
    if (input.legacyMirrored && (
      current.inFlightSyncTokens.length > 0
      || current.sourceRevision !== input.expectedSourceRevision
      || current.summaryRevision !== input.expectedSummaryRevision
      || current.sourceHighWatermark !== input.expectedHighWatermark
    )) {
      throw new Error('JOB_PROJECTION_LEGACY_MIRROR_BOUNDARY_CHANGED');
    }
    const mirroredCandidateStorage = input.legacyMirrored
      ? { slot: context.targetSlot, repairFence: context.repairFence }
      : null;
    output = {
      ...current,
      activeSlot: input.legacyMirrored ? 'LEGACY' : current.activeSlot,
      activeRepair: undefined,
      rebuildToken: undefined,
      mutationDuringRebuild: false,
      lastSuccessfulRepairAt: measuredAt,
      legacyMirrorPending: !input.legacyMirrored,
      staleCandidateStorage: appendStaleCandidateStorage(
        current.staleCandidateStorage,
        mirroredCandidateStorage,
      ),
      updatedAt: measuredAt,
    };
    return [output];
  });
  return output;
}

export async function failAutomationJobProjectionRepair(
  context: AutomationJobProjectionRepairContext,
  reasonCode: string,
  now = Date.now(),
): Promise<AutomationJobProjectionManifest> {
  const measuredAt = new Date(now).toISOString();
  let output = emptyProjectionManifest(now);
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) return undefined;
    const current = withProjectionProtocol(items[0]);
    if (!repairMatches(current.activeRepair, context)) {
      const failedCandidateStorage = current.activeSlot === context.targetSlot
        && current.activeStorageRepairFence === context.repairFence
        ? null
        : { slot: context.targetSlot, repairFence: context.repairFence };
      output = failedCandidateStorage
        ? {
            ...current,
            staleCandidateStorage: appendStaleCandidateStorage(
              current.staleCandidateStorage,
              failedCandidateStorage,
            ),
            updatedAt: measuredAt,
          }
        : current;
      return failedCandidateStorage ? [output] : undefined;
    }
    const safeReason = reasonCode.replace(/[^A-Z0-9_:-]/gi, '_').toUpperCase().slice(0, 120);
    const failedCandidateStorage = current.activeSlot === context.targetSlot
      && current.activeStorageRepairFence === context.repairFence
      ? null
      : { slot: context.targetSlot, repairFence: context.repairFence };
    output = {
      ...current,
      rebuildToken: undefined,
      mutationDuringRebuild: false,
      lastRebuildStatus: current.activeGeneration === context.targetGeneration ? 'SUCCEEDED' : 'FAILED',
      lastRebuildFailureAt: measuredAt,
      activeRepair: {
        ...current.activeRepair,
        phase: 'FAILED',
        catchUpPending: false,
        lastFailureReason: safeReason,
        updatedAt: measuredAt,
      },
      staleCandidateStorage: appendStaleCandidateStorage(
        current.staleCandidateStorage,
        failedCandidateStorage,
      ),
      updatedAt: measuredAt,
    };
    return [output];
  });
  return output;
}

export async function acknowledgeAutomationJobProjectionCandidateCleanup(
  cleaned: AutomationJobProjectionCandidateStorageRef[],
  now = Date.now(),
): Promise<void> {
  if (!cleaned.length) return;
  const keys = new Set(cleaned.map(ref => `${ref.slot}:${ref.repairFence}`));
  const measuredAt = new Date(now).toISOString();
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) return undefined;
    const current = withProjectionProtocol(items[0]);
    const retained = (current.staleCandidateStorage || []).filter(ref => {
      const isActive = current.activeSlot === ref.slot
        && current.activeStorageRepairFence === ref.repairFence;
      return isActive || !keys.has(`${ref.slot}:${ref.repairFence}`);
    });
    if (retained.length === (current.staleCandidateStorage || []).length) return undefined;
    return [{ ...current, staleCandidateStorage: retained, updatedAt: measuredAt }];
  });
}

function isProjection(value: unknown): value is AutomationJobListProjection {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AutomationJobListProjection>;
  return typeof item.id === 'string'
    && typeof item.type === 'string'
    && typeof item.status === 'string'
    && STATUS_SET.has(item.status)
    && typeof item.requestedBy === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}

function projectionCompatibility(value: AutomationJobListProjection): 'CURRENT' | 'LEGACY' | 'INVALID' {
  if (value.projectionSchemaVersion === AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION) return 'CURRENT';
  if (value.projectionSchemaVersion === undefined) return 'LEGACY';
  return 'INVALID';
}

function statusProjectionCompatibility(
  value: AutomationJobStatusProjection,
): 'CURRENT' | 'LEGACY' | 'INVALID' {
  if (value.projectionSchemaVersion === AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION) return 'CURRENT';
  if (value.projectionSchemaVersion === undefined) return 'LEGACY';
  return 'INVALID';
}

function projectionEvidence(input: {
  source: AutomationJobProjectionEvidence['source'];
  collectionPresent: boolean;
  items: Array<Pick<AutomationJobListProjection, 'id' | 'status' | 'createdAt' | 'updatedAt'>>;
  rawCount: number;
  invalidCount: number;
  legacyCount: number;
  manifest: AutomationJobProjectionManifest | null;
  manifestReasonCodes: string[];
}): { evidence: AutomationJobProjectionEvidence; reasonCodes: string[] } {
  const range = observedRange(input.items);
  const atCapacity = input.rawCount >= getAutomationJobProjectionLimit();
  const expectedCount = input.source === 'job-list-projection-v2'
    ? input.manifest?.listProjectionCount
    : input.manifest?.statusProjectionCount;
  const expectedFingerprint = input.source === 'job-list-projection-v2'
    ? input.manifest?.listProjectionFingerprint
    : input.manifest?.statusProjectionFingerprint;
  const expectedContentFingerprint = input.source === 'job-list-projection-v2'
    ? input.manifest?.listProjectionContentFingerprint
    : input.manifest?.statusProjectionContentFingerprint;
  const actualFingerprint = automationJobProjectionFingerprint(input.items);
  const actualContentFingerprint = automationJobProjectionContentFingerprint(input.items);
  const releaseMatches = input.manifest?.releaseId === getReleaseIdentity().releaseId;
  const countMatches = expectedCount === input.rawCount;
  const fingerprintMatches = expectedFingerprint === actualFingerprint;
  const contentFingerprintMatches = expectedContentFingerprint === actualContentFingerprint;
  const manifestReady = Boolean(
    input.manifest
    && input.manifest.baselineEstablished
    && input.manifest.rebuildToken === undefined
    && input.manifest.inFlightSyncTokens.length === 0
    && input.manifest.syncFailureCountSinceRebuild === 0,
  );
  const currentStateComplete = Boolean(
    input.collectionPresent
    && manifestReady
    && input.manifest?.currentStateComplete
    && releaseMatches
    && countMatches
    && fingerprintMatches
    && contentFingerprintMatches
    && input.invalidCount === 0
    && input.legacyCount === 0,
  );
  const truncated = Boolean(atCapacity || input.manifest?.truncated);
  const historyComplete = Boolean(
    currentStateComplete
    && input.manifest?.historyComplete
    && !truncated,
  );
  const evidenceClassification: ProjectionEvidenceClassification = currentStateComplete && historyComplete
    ? 'COMPLETE'
    : 'INCOMPLETE';
  const boundary = truncated
    ? (input.manifest?.retentionBoundary || retentionBoundary(range, true))
    : null;
  const reasonCodes = [
    ...input.manifestReasonCodes,
    ...(!input.collectionPresent ? ['JOB_PROJECTION_COLLECTION_MISSING'] : []),
    ...(input.collectionPresent && input.rawCount === 0 && !currentStateComplete
      ? ['JOB_PROJECTION_EMPTY_UNVERIFIED']
      : []),
    ...(input.manifest && !releaseMatches ? ['JOB_PROJECTION_MANIFEST_RELEASE_MISMATCH'] : []),
    ...(input.manifest && !countMatches ? ['JOB_PROJECTION_MANIFEST_COUNT_MISMATCH'] : []),
    ...(input.manifest && (!fingerprintMatches || !contentFingerprintMatches)
      ? ['JOB_PROJECTION_MANIFEST_FINGERPRINT_MISMATCH']
      : []),
    ...(input.manifest?.rebuildToken ? ['JOB_PROJECTION_REBUILD_IN_PROGRESS'] : []),
    ...(input.manifest?.lastRebuildStatus === 'FAILED' ? ['JOB_PROJECTION_REBUILD_LAST_FAILED'] : []),
    ...(input.manifest?.inFlightSyncTokens.length ? ['JOB_PROJECTION_SYNC_IN_PROGRESS'] : []),
    ...(input.manifest?.syncFailureCountSinceRebuild ? ['JOB_PROJECTION_SYNC_FAILED_SINCE_REBUILD'] : []),
    ...(input.legacyCount ? ['JOB_PROJECTION_SCHEMA_LEGACY'] : []),
    ...(input.invalidCount ? ['JOB_PROJECTION_INVALID_ITEMS'] : []),
    ...(!currentStateComplete ? ['JOB_PROJECTION_CURRENT_STATE_INCOMPLETE'] : []),
    ...(!historyComplete ? ['JOB_PROJECTION_HISTORY_BOUNDED'] : []),
    ...(truncated ? ['JOB_PROJECTION_RETENTION_LIMIT_REACHED'] : []),
  ];
  return {
    evidence: {
      evidenceClassification,
      source: input.source,
      collectionPresent: input.collectionPresent,
      currentStateComplete,
      historyComplete,
      truncated,
      observedRange: range,
      retentionBoundary: boundary,
      manifestRebuiltAt: input.manifest?.rebuiltAt || null,
      manifestReleaseId: input.manifest?.releaseId || null,
      manifestUpdatedAt: input.manifest?.updatedAt || null,
      projectionVersion: input.manifest?.projectionVersion || null,
      sourceRevision: input.manifest?.sourceRevision || null,
      summaryRevision: input.manifest?.summaryRevision || null,
      projectionFingerprint: input.manifest?.projectionFingerprint || null,
      generatedAt: input.manifest?.generatedAt || null,
      recordCounts: input.manifest?.recordCounts || {
        durable: null,
        active: null,
        retained: input.rawCount,
        retainedTerminal: null,
        list: input.source === 'job-list-projection-v2' ? input.rawCount : null,
        status: input.source === 'job-status-projection-v1' ? input.rawCount : null,
      },
      completeness: {
        baselineEstablished: input.manifest?.baselineEstablished === true,
        currentStateComplete,
        historyComplete,
        truncated,
      },
    },
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function jobReference(job: AutomationJobListProjection): AutomationHealthJobReference {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    requestedBy: job.requestedBy,
    priority: Math.max(0, Number(job.priority) || 0),
    attemptCount: Math.max(0, Number(job.attemptCount) || 0),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    runnableAt: job.runnableAt,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    heartbeatAt: job.heartbeatAt,
    leaseExpiresAt: job.leaseExpiresAt,
    executionCritical: job.executionCritical,
    lastErrorCode: job.lastErrorCode,
  };
}

function runnableAt(job: AutomationJobListProjection): number | null {
  return timestamp(job.runnableAt)
    ?? timestamp(job.nextRetryAt)
    ?? timestamp(job.scheduledAt)
    ?? timestamp(job.queuedAt)
    ?? timestamp(job.createdAt);
}

function pickupSample(job: AutomationJobListProjection): AutomationPickupLatencySample | null {
  // Pickup SLO evidence requires attempt-specific timestamps. Falling back to
  // createdAt/startedAt can turn an old scheduled job completed recently into
  // a fictitious multi-day pickup latency.
  const runnable = timestamp(job.runnableAt);
  const claimed = timestamp(job.claimedAt);
  if (runnable === null || claimed === null || claimed < runnable) return null;
  return {
    id: `${job.id}:attempt:${Math.max(1, Number(job.attemptCount) || 1)}`,
    jobId: job.id,
    jobType: job.type,
    attemptNumber: Math.max(1, Number(job.attemptCount) || 1),
    runnableAt: new Date(runnable).toISOString(),
    claimedAt: new Date(claimed).toISOString(),
    latencyMs: claimed - runnable,
  };
}

function normalizeExistingSamples(
  summary: AutomationJobHealthSummary | undefined,
  windowStartedAt: number,
  now: number,
): AutomationPickupLatencySample[] {
  if (!summary || !Array.isArray(summary.pickupLatency?.samples)) return [];
  return summary.pickupLatency.samples.filter(sample => {
    const claimed = timestamp(sample.claimedAt);
    return typeof sample.id === 'string'
      && typeof sample.jobId === 'string'
      && Number.isFinite(sample.latencyMs)
      && sample.latencyMs >= 0
      && claimed !== null
      && claimed >= windowStartedAt
      && claimed <= now + 60_000;
  });
}

function emptySummary(now = Date.now()): AutomationJobHealthSummary {
  const measuredAt = new Date(now).toISOString();
  const projectionEvidence = emptyProjectionEvidence('job-list-projection-v2', 'UNAVAILABLE');
  const manifest = emptyProjectionManifest(now);
  return {
    schemaVersion: AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION,
    projectionSchemaVersion: AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
    projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
    id: HEALTH_SUMMARY_ID,
    sourceRevision: manifest.sourceRevision,
    summaryRevision: revisionHash({ empty: true, sourceRevision: manifest.sourceRevision, measuredAt }),
    projectionFingerprint: manifest.projectionFingerprint,
    generatedAt: measuredAt,
    observedRange: manifest.observedRange,
    recordCounts: manifest.recordCounts,
    completeness: manifest.completeness,
    statusCounts: statusCounts(),
    activeTypeCounts: {},
    totalProjectedJobs: 0,
    projectionCapacity: getAutomationJobProjectionLimit(),
    projectionEvidence,
    coverageComplete: false,
    legacyProjectionCount: 0,
    invalidProjectionCount: 0,
    runningJobs: [],
    pendingJobs: [],
    recentJobs: [],
    latestSuccess: null,
    latestFailure: null,
    latestSchedulerSuccess: null,
    oldestPendingAt: null,
    pickupLatency: {
      windowStartedAt: new Date(now - PICKUP_WINDOW_MS).toISOString(),
      windowEndedAt: measuredAt,
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      insufficientEvidenceCount: 0,
      samples: [],
    },
    sourceUpdatedAt: null,
    releaseId: getReleaseIdentity().releaseId,
    updatedAt: measuredAt,
  };
}

export function buildAutomationJobHealthSummary(
  projections: AutomationJobListProjection[],
  options: {
    now?: number;
    previous?: AutomationJobHealthSummary;
    evidence?: AutomationJobProjectionEvidence;
  } = {},
): AutomationJobHealthSummary {
  const now = options.now ?? Date.now();
  const current: AutomationJobListProjection[] = [];
  let legacyProjectionCount = 0;
  let invalidProjectionCount = 0;
  for (const projection of projections) {
    if (!isProjection(projection)) {
      invalidProjectionCount += 1;
      continue;
    }
    const compatibility = projectionCompatibility(projection);
    if (compatibility === 'INVALID') {
      invalidProjectionCount += 1;
      continue;
    }
    if (compatibility === 'LEGACY') legacyProjectionCount += 1;
    current.push(projection);
  }

  const counts = statusCounts();
  const activeTypeCounts: Partial<Record<AutomationJobType, number>> = {};
  for (const job of current) {
    counts[job.status] += 1;
    if (ACTIVE_STATUSES.has(job.status)) {
      activeTypeCounts[job.type] = (activeTypeCounts[job.type] || 0) + 1;
    }
  }

  const newestFirst = [...current].sort(
    (left, right) => (timestamp(right.updatedAt) || 0) - (timestamp(left.updatedAt) || 0),
  );
  const pending = current
    .filter(job => PENDING_STATUSES.has(job.status))
    .sort((left, right) => (runnableAt(left) || 0) - (runnableAt(right) || 0));
  const running = current
    .filter(job => job.status === 'RUNNING')
    .sort((left, right) => (timestamp(left.startedAt) || 0) - (timestamp(right.startedAt) || 0));
  const latestSuccess = newestFirst.find(job => job.status === 'SUCCEEDED');
  const latestFailure = newestFirst.find(job => job.status === 'FAILED' || job.status === 'BLOCKED');
  const latestSchedulerSuccess = newestFirst.find(
    job => job.requestedBy === 'scheduler' && job.status === 'SUCCEEDED',
  );

  const windowStartedAt = now - PICKUP_WINDOW_MS;
  const samples = new Map<string, AutomationPickupLatencySample>();
  for (const sample of normalizeExistingSamples(options.previous, windowStartedAt, now)) {
    samples.set(sample.id, sample);
  }
  for (const job of current) {
    const sample = pickupSample(job);
    const claimed = timestamp(sample?.claimedAt);
    if (sample && claimed !== null && claimed >= windowStartedAt && claimed <= now + 60_000) {
      samples.set(sample.id, sample);
    }
  }
  const rollingSamples = [...samples.values()]
    .sort((left, right) => (timestamp(right.claimedAt) || 0) - (timestamp(left.claimedAt) || 0))
    .slice(0, MAX_PICKUP_SAMPLES);
  const latencies = rollingSamples.map(sample => sample.latencyMs);
  const insufficientEvidenceCount = current.filter(job => {
    const claimed = timestamp(job.claimedAt) ?? timestamp(job.startedAt);
    return claimed !== null
      && claimed >= windowStartedAt
      && claimed <= now + 60_000
      && pickupSample(job) === null;
  }).length;
  const projectionCapacity = getAutomationJobProjectionLimit();
  const measuredAt = new Date(now).toISOString();
  const evidence = options.evidence || {
    ...emptyProjectionEvidence('job-list-projection-v2'),
    collectionPresent: true,
    observedRange: observedRange(current),
    truncated: projections.length >= projectionCapacity,
    retentionBoundary: retentionBoundary(observedRange(current), projections.length >= projectionCapacity),
  };
  const currentFingerprint = evidence.projectionFingerprint
    || projectionFingerprint({
      listProjectionFingerprint: automationJobProjectionFingerprint(current),
      statusProjectionFingerprint: automationJobProjectionFingerprint(current),
      listProjectionContentFingerprint: automationJobProjectionContentFingerprint(current),
      statusProjectionContentFingerprint: automationJobProjectionContentFingerprint(current),
      listProjectionCount: current.length,
      statusProjectionCount: current.length,
    });
  const sourceRevision = evidence.sourceRevision || projectionSourceRevision({
    releaseId: getReleaseIdentity().releaseId,
    projectionFingerprint: currentFingerprint,
    durableJobCount: evidence.recordCounts.durable ?? current.length,
    activeJobCount: evidence.recordCounts.active
      ?? current.filter(job => ACTIVE_STATUSES.has(job.status)).length,
    retainedJobCount: current.length,
    sourceUpdatedAt: newestTimestamp(current.map(job => job.updatedAt)),
  });
  const summaryWithoutRevision: Omit<AutomationJobHealthSummary, 'summaryRevision'> = {
    schemaVersion: AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION,
    projectionSchemaVersion: AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
    projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
    id: HEALTH_SUMMARY_ID,
    sourceRevision,
    projectionFingerprint: currentFingerprint,
    generatedAt: measuredAt,
    observedRange: evidence.observedRange,
    recordCounts: {
      durable: evidence.recordCounts.durable,
      active: evidence.recordCounts.active,
      retained: evidence.recordCounts.retained ?? current.length,
      retainedTerminal: evidence.recordCounts.retainedTerminal
        ?? current.filter(job => !ACTIVE_STATUSES.has(job.status)).length,
      list: evidence.recordCounts.list ?? current.length,
      status: evidence.recordCounts.status,
    },
    completeness: {
      baselineEstablished: evidence.completeness.baselineEstablished,
      currentStateComplete: evidence.currentStateComplete,
      historyComplete: evidence.historyComplete,
      truncated: evidence.truncated,
    },
    statusCounts: counts,
    activeTypeCounts,
    totalProjectedJobs: current.length,
    projectionCapacity,
    projectionEvidence: evidence,
    coverageComplete: evidence.currentStateComplete && evidence.historyComplete,
    legacyProjectionCount,
    invalidProjectionCount,
    runningJobs: running.slice(0, MAX_RUNNING_ENTRIES).map(jobReference),
    pendingJobs: pending.slice(0, MAX_PENDING_ENTRIES).map(jobReference),
    recentJobs: newestFirst.slice(0, MAX_RECENT_ENTRIES).map(jobReference),
    latestSuccess: latestSuccess ? jobReference(latestSuccess) : null,
    latestFailure: latestFailure ? jobReference(latestFailure) : null,
    latestSchedulerSuccess: latestSchedulerSuccess ? jobReference(latestSchedulerSuccess) : null,
    oldestPendingAt: pending[0]
      ? new Date(runnableAt(pending[0]) || timestamp(pending[0].createdAt) || now).toISOString()
      : null,
    pickupLatency: {
      windowStartedAt: new Date(windowStartedAt).toISOString(),
      windowEndedAt: measuredAt,
      sampleCount: rollingSamples.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      insufficientEvidenceCount,
      samples: rollingSamples,
    },
    sourceUpdatedAt: newestTimestamp(current.map(job => job.updatedAt)),
    releaseId: getReleaseIdentity().releaseId,
    updatedAt: measuredAt,
  };
  const summaryRevision = healthSummaryRevision(summaryWithoutRevision);
  return {
    ...summaryWithoutRevision,
    projectionEvidence: {
      ...summaryWithoutRevision.projectionEvidence,
      summaryRevision,
    },
    summaryRevision,
  };
}

function isHealthReference(value: unknown): value is AutomationHealthJobReference {
  if (!value || typeof value !== 'object') return false;
  const reference = value as Partial<AutomationHealthJobReference>;
  return typeof reference.id === 'string'
    && reference.id.length > 0
    && typeof reference.type === 'string'
    && typeof reference.status === 'string'
    && STATUS_SET.has(reference.status)
    && typeof reference.requestedBy === 'string'
    && Number.isFinite(reference.priority)
    && Number.isFinite(reference.attemptCount)
    && timestamp(reference.createdAt) !== null
    && timestamp(reference.updatedAt) !== null;
}

function isHealthSummary(value: unknown): value is AutomationJobHealthSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<AutomationJobHealthSummary>;
  return summary.id === HEALTH_SUMMARY_ID
    && summary.schemaVersion === AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION
    && summary.projectionSchemaVersion === AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION
    && summary.projectionVersion === AUTOMATION_JOB_PROJECTION_VERSION
    && typeof summary.sourceRevision === 'string'
    && /^[a-f0-9]{64}$/.test(summary.sourceRevision)
    && typeof summary.summaryRevision === 'string'
    && /^[a-f0-9]{64}$/.test(summary.summaryRevision)
    && typeof summary.projectionFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(summary.projectionFingerprint)
    && timestamp(summary.generatedAt) !== null
    && summary.observedRange !== null
    && typeof summary.observedRange === 'object'
    && [
      summary.observedRange.earliestCreatedAt,
      summary.observedRange.latestCreatedAt,
      summary.observedRange.earliestUpdatedAt,
      summary.observedRange.latestUpdatedAt,
    ].every(item => item === null || timestamp(item) !== null)
    && summary.recordCounts !== null
    && typeof summary.recordCounts === 'object'
    && [
      summary.recordCounts.durable,
      summary.recordCounts.active,
      summary.recordCounts.retained,
      summary.recordCounts.retainedTerminal,
      summary.recordCounts.list,
      summary.recordCounts.status,
    ].every(item => item === null || (Number.isInteger(item) && Number(item) >= 0))
    && summary.completeness !== null
    && typeof summary.completeness === 'object'
    && typeof summary.completeness.baselineEstablished === 'boolean'
    && typeof summary.completeness.currentStateComplete === 'boolean'
    && typeof summary.completeness.historyComplete === 'boolean'
    && typeof summary.completeness.truncated === 'boolean'
    && summary.statusCounts !== null
    && typeof summary.statusCounts === 'object'
    && summary.projectionEvidence !== null
    && typeof summary.projectionEvidence === 'object'
    && ['COMPLETE', 'INCOMPLETE', 'UNAVAILABLE'].includes(String(summary.projectionEvidence.evidenceClassification))
    && typeof summary.projectionEvidence.currentStateComplete === 'boolean'
    && typeof summary.projectionEvidence.historyComplete === 'boolean'
    && typeof summary.projectionEvidence.truncated === 'boolean'
    && typeof summary.projectionEvidence.collectionPresent === 'boolean'
    && summary.projectionEvidence.projectionVersion === summary.projectionVersion
    && summary.projectionEvidence.sourceRevision === summary.sourceRevision
    && summary.projectionEvidence.summaryRevision === summary.summaryRevision
    && summary.projectionEvidence.projectionFingerprint === summary.projectionFingerprint
    && summary.completeness.currentStateComplete === summary.projectionEvidence.currentStateComplete
    && summary.completeness.historyComplete === summary.projectionEvidence.historyComplete
    && summary.completeness.truncated === summary.projectionEvidence.truncated
    && (
      summary.projectionEvidence.manifestUpdatedAt === null
      || timestamp(summary.projectionEvidence.manifestUpdatedAt) !== null
    )
    && summary.projectionEvidence.observedRange !== null
    && typeof summary.projectionEvidence.observedRange === 'object'
    && Array.isArray(summary.runningJobs)
    && summary.runningJobs.length <= MAX_RUNNING_ENTRIES
    && summary.runningJobs.every(isHealthReference)
    && Array.isArray(summary.pendingJobs)
    && summary.pendingJobs.length <= MAX_PENDING_ENTRIES
    && summary.pendingJobs.every(isHealthReference)
    && Array.isArray(summary.recentJobs)
    && summary.recentJobs.length <= MAX_RECENT_ENTRIES
    && summary.recentJobs.every(isHealthReference)
    && Array.isArray(summary.pickupLatency?.samples)
    && summary.pickupLatency.samples.length <= MAX_PICKUP_SAMPLES
    && summary.pickupLatency.samples.every(sample => (
      sample
      && typeof sample.id === 'string'
      && typeof sample.jobId === 'string'
      && timestamp(sample.runnableAt) !== null
      && timestamp(sample.claimedAt) !== null
      && Number.isFinite(sample.latencyMs)
      && sample.latencyMs >= 0
    ))
    && Number.isInteger(summary.pickupLatency?.sampleCount)
    && Number.isInteger(summary.pickupLatency?.insufficientEvidenceCount)
    && ALL_STATUSES.every(status => Number.isInteger(summary.statusCounts?.[status])
      && Number(summary.statusCounts?.[status]) >= 0)
    && typeof summary.releaseId === 'string'
    && summary.releaseId.length > 0
    && timestamp(summary.updatedAt) !== null
    && (() => {
      const { summaryRevision, ...withoutRevision } = summary as AutomationJobHealthSummary;
      return summaryRevision === healthSummaryRevision(withoutRevision);
    })();
}

export function validateAutomationJobHealthSummary(value: unknown): value is AutomationJobHealthSummary {
  return isHealthSummary(value);
}

export async function readBoundedAutomationJobProjections(): Promise<BoundedAutomationJobProjectionRead> {
  try {
    const manifestRead = await readProjectionManifest();
    const collections = automationJobProjectionStorageCollections(
      manifestRead.manifest?.activeSlot || 'LEGACY',
      manifestRead.manifest?.activeStorageRepairFence,
    );
    const snapshot = await readBoundedCollectionSnapshot<AutomationJobListProjection>(collections.list, {
      maximumItems: getAutomationJobProjectionLimit(),
      maximumBytes: PROJECTION_MAXIMUM_BYTES,
    });
    const raw = snapshot.items;
    const items: AutomationJobListProjection[] = [];
    let invalidProjectionCount = 0;
    let incompatibleProjectionCount = 0;
    let legacyProjectionCount = 0;
    for (const item of raw) {
      if (!isProjection(item)) {
        invalidProjectionCount += 1;
        continue;
      }
      if (projectionCompatibility(item) === 'INVALID') {
        invalidProjectionCount += 1;
        incompatibleProjectionCount += 1;
        continue;
      }
      if (projectionCompatibility(item) === 'LEGACY') legacyProjectionCount += 1;
      items.push(item);
    }
    const evaluated = projectionEvidence({
      source: 'job-list-projection-v2',
      collectionPresent: snapshot.metadata.collectionPresent,
      items,
      rawCount: raw.length,
      invalidCount: invalidProjectionCount,
      legacyCount: legacyProjectionCount,
      manifest: manifestRead.manifest,
      manifestReasonCodes: manifestRead.reasonCodes,
    });
    const reasonCodes = [
      ...evaluated.reasonCodes,
      ...(incompatibleProjectionCount ? ['JOB_PROJECTION_SCHEMA_INCOMPATIBLE'] : []),
    ];
    return {
      items,
      availability: reasonCodes.length ? 'DEGRADED' : 'AVAILABLE',
      reasonCodes: [...new Set(reasonCodes)],
      ...evaluated.evidence,
      source: 'job-list-projection-v2',
      coverageComplete: evaluated.evidence.evidenceClassification === 'COMPLETE',
      invalidProjectionCount,
      legacyProjectionCount,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message.includes('LIMIT_EXCEEDED')
      ? 'JOB_PROJECTION_BOUND_EXCEEDED'
      : 'JOB_PROJECTION_UNAVAILABLE';
    return {
      items: [],
      availability: 'UNAVAILABLE',
      reasonCodes: [reason],
      ...emptyProjectionEvidence('job-list-projection-v2', 'UNAVAILABLE'),
      source: 'job-list-projection-v2',
      coverageComplete: false,
      invalidProjectionCount: 0,
      legacyProjectionCount: 0,
    };
  }
}

export async function readBoundedAutomationJobStatuses(): Promise<BoundedAutomationJobStatusRead> {
  try {
    const manifestRead = await readProjectionManifest();
    const collections = automationJobProjectionStorageCollections(
      manifestRead.manifest?.activeSlot || 'LEGACY',
      manifestRead.manifest?.activeStorageRepairFence,
    );
    const snapshot = await readBoundedCollectionSnapshot<AutomationJobStatusProjection>(collections.status, {
      maximumItems: getAutomationJobProjectionLimit(),
      maximumBytes: PROJECTION_MAXIMUM_BYTES,
    });
    const raw = snapshot.items;
    const items: AutomationJobStatusProjection[] = [];
    let invalidCount = 0;
    let legacyCount = 0;
    let incompatibleCount = 0;
    for (const item of raw) {
      if (
        !item
        || typeof item !== 'object'
        || typeof item.id !== 'string'
        || typeof item.type !== 'string'
        || typeof item.status !== 'string'
        || !STATUS_SET.has(item.status)
        || typeof item.createdAt !== 'string'
        || typeof item.updatedAt !== 'string'
      ) {
        invalidCount += 1;
        continue;
      }
      const compatibility = statusProjectionCompatibility(item);
      if (compatibility === 'INVALID') {
        invalidCount += 1;
        incompatibleCount += 1;
        continue;
      }
      if (compatibility === 'LEGACY') legacyCount += 1;
      items.push(item);
    }
    const evaluated = projectionEvidence({
      source: 'job-status-projection-v1',
      collectionPresent: snapshot.metadata.collectionPresent,
      items,
      rawCount: raw.length,
      invalidCount,
      legacyCount,
      manifest: manifestRead.manifest,
      manifestReasonCodes: manifestRead.reasonCodes,
    });
    const reasonCodes = [
      ...evaluated.reasonCodes.map(code => code.replace(/^JOB_PROJECTION_/, 'JOB_STATUS_PROJECTION_')),
      ...(incompatibleCount ? ['JOB_STATUS_PROJECTION_SCHEMA_INCOMPATIBLE'] : []),
    ];
    return {
      items,
      availability: reasonCodes.length ? 'DEGRADED' : 'AVAILABLE',
      reasonCodes: [...new Set(reasonCodes)],
      ...evaluated.evidence,
      source: 'job-status-projection-v1',
      coverageComplete: evaluated.evidence.evidenceClassification === 'COMPLETE',
    };
  } catch (error) {
    return {
      items: [],
      availability: 'UNAVAILABLE',
      reasonCodes: [
        error instanceof Error && error.message.includes('LIMIT_EXCEEDED')
          ? 'JOB_STATUS_PROJECTION_BOUND_EXCEEDED'
          : 'JOB_STATUS_PROJECTION_UNAVAILABLE',
      ],
      ...emptyProjectionEvidence('job-status-projection-v1', 'UNAVAILABLE'),
      source: 'job-status-projection-v1',
      coverageComplete: false,
    };
  }
}

export async function refreshAutomationJobHealthSummary(now = Date.now()): Promise<AutomationJobHealthSummary> {
  const projections = await readBoundedAutomationJobProjections();
  if (projections.availability === 'UNAVAILABLE') {
    throw new Error(projections.reasonCodes[0] || 'JOB_PROJECTION_UNAVAILABLE');
  }
  const active = await getAutomationJobActiveProjectionStorage();
  if (
    !active.manifest
    || active.manifest.sourceRevision !== projections.sourceRevision
    || active.manifest.projectionFingerprint !== projections.projectionFingerprint
  ) {
    throw new Error('JOB_HEALTH_SUMMARY_SOURCE_REVISION_CHANGED');
  }
  let output: AutomationJobHealthSummary | undefined;
  await runTransaction<AutomationJobHealthSummary>(active.collections.summary, items => {
    const previous = isHealthSummary(items[0]) ? items[0] : undefined;
    const candidate = buildAutomationJobHealthSummary(projections.items, {
      now,
      previous,
      evidence: {
        evidenceClassification: projections.evidenceClassification,
        source: projections.source,
        collectionPresent: projections.collectionPresent,
        currentStateComplete: projections.currentStateComplete,
        historyComplete: projections.historyComplete,
        truncated: projections.truncated,
        observedRange: projections.observedRange,
        retentionBoundary: projections.retentionBoundary,
        manifestRebuiltAt: projections.manifestRebuiltAt,
        manifestReleaseId: projections.manifestReleaseId,
        manifestUpdatedAt: projections.manifestUpdatedAt,
        projectionVersion: projections.projectionVersion,
        sourceRevision: projections.sourceRevision,
        summaryRevision: projections.summaryRevision,
        projectionFingerprint: projections.projectionFingerprint,
        generatedAt: projections.generatedAt,
        recordCounts: projections.recordCounts,
        completeness: projections.completeness,
      },
    });
    const previousSourceAt = timestamp(previous?.sourceUpdatedAt);
    const candidateSourceAt = timestamp(candidate.sourceUpdatedAt);
    const previousUpdatedAt = timestamp(previous?.updatedAt);
    const candidateUpdatedAt = timestamp(candidate.updatedAt);
    const sourceRegressed = previousSourceAt !== null
      && (candidateSourceAt === null || candidateSourceAt < previousSourceAt);
    const generatedAtRegressed = previousUpdatedAt !== null
      && candidateUpdatedAt !== null
      && candidateUpdatedAt < previousUpdatedAt;
    const sameSourceRevision = previous?.sourceRevision === candidate.sourceRevision;
    if (previous && sameSourceRevision && (sourceRegressed || generatedAtRegressed)) {
      output = previous;
      return undefined;
    }
    output = candidate;
    return [candidate];
  });
  if (!output) throw new Error('JOB_HEALTH_SUMMARY_REFRESH_FAILED');
  let linked = false;
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) return undefined;
    const current = withProjectionProtocol(items[0]);
    if (
      current.sourceRevision !== output!.sourceRevision
      || current.projectionFingerprint !== output!.projectionFingerprint
      || current.rebuildToken
      || current.inFlightSyncTokens.length > 0
      || current.activeGeneration !== active.manifest!.activeGeneration
      || current.activeSlot !== active.manifest!.activeSlot
    ) {
      return undefined;
    }
    linked = true;
    if (current.summaryRevision === output!.summaryRevision) return undefined;
    return [{
      ...current,
      summaryRevision: output!.summaryRevision,
      updatedAt: new Date(now).toISOString(),
    }];
  });
  if (!linked) throw new Error('JOB_HEALTH_SUMMARY_SOURCE_REVISION_CHANGED');
  return output;
}

function healthView(
  summary: AutomationJobHealthSummary,
  input: {
    now: number;
    availability: AutomationJobHealthView['availability'];
    source: AutomationJobHealthView['source'];
    reasonCodes: string[];
    manifest?: AutomationJobProjectionManifest | null;
    previousValidProjectionAvailable?: boolean;
    previousValidProjectionGeneratedAt?: string | null;
    projectionStatus?: AutomationJobHealthView['projectionStatus'];
  },
): AutomationJobHealthView {
  const hasActiveJobs = ALL_STATUSES.some(status => ACTIVE_STATUSES.has(status) && summary.statusCounts[status] > 0);
  const staleRunningCount = summary.runningJobs.filter(job => {
    const lease = timestamp(job.leaseExpiresAt);
    const heartbeat = timestamp(job.heartbeatAt);
    return lease === null
      || lease <= input.now
      || heartbeat === null
      || heartbeat > input.now + 60_000
      || input.now - heartbeat > ACTIVE_SUMMARY_FRESHNESS_MS;
  }).length;
  const freshnessTimestamp = hasActiveJobs
    ? Math.max(
        timestamp(summary.sourceUpdatedAt) ?? Number.NEGATIVE_INFINITY,
        ...summary.runningJobs.map(job => timestamp(job.heartbeatAt) ?? Number.NEGATIVE_INFINITY),
      )
    : timestamp(summary.updatedAt);
  const summaryAge = freshnessTimestamp === null ? Number.POSITIVE_INFINITY : input.now - freshnessTimestamp;
  const stale = !Number.isFinite(summaryAge)
    || summaryAge < -60_000
    || summaryAge > (hasActiveJobs ? ACTIVE_SUMMARY_FRESHNESS_MS : IDLE_SUMMARY_FRESHNESS_MS)
    || staleRunningCount > 0;
  const stuckPendingCount = summary.pendingJobs.filter(job => {
    const eligibleAt = timestamp(job.runnableAt) ?? timestamp(job.createdAt);
    return eligibleAt !== null && eligibleAt <= input.now && input.now - eligibleAt > STUCK_PENDING_MS;
  }).length;
  const oldestPending = timestamp(summary.oldestPendingAt);
  const reasonCodes = [
    ...input.reasonCodes,
    ...(stale ? ['JOB_HEALTH_SUMMARY_STALE'] : []),
    ...(!summary.projectionEvidence.currentStateComplete ? ['JOB_HEALTH_CURRENT_STATE_INCOMPLETE'] : []),
    ...(!summary.projectionEvidence.historyComplete ? ['JOB_HEALTH_HISTORY_BOUNDED'] : []),
    ...(summary.projectionEvidence.truncated ? ['JOB_HEALTH_RETENTION_LIMIT_REACHED'] : []),
    ...(summary.releaseId !== getReleaseIdentity().releaseId ? ['JOB_HEALTH_SUMMARY_RELEASE_MISMATCH'] : []),
    ...(summary.invalidProjectionCount ? ['JOB_HEALTH_SUMMARY_INVALID_PROJECTIONS'] : []),
  ];
  const requestedProjectionStatus = input.projectionStatus
    || (input.availability === 'UNAVAILABLE'
      ? 'UNKNOWN'
      : input.source === 'summary' && summary.projectionEvidence.currentStateComplete
        ? 'VALID'
        : 'INVALID');
  const projectionStatus = requestedProjectionStatus === 'VALID' && stale
    ? 'STALE'
    : requestedProjectionStatus;
  const projectionUsable = projectionStatus === 'VALID' || projectionStatus === 'STALE';
  const protocolManifest = input.manifest ? withProjectionProtocol(input.manifest) : null;
  const activeRepair = protocolManifest?.activeRepair;
  return {
    ...summary,
    availability: input.availability === 'AVAILABLE' && reasonCodes.length ? 'DEGRADED' : input.availability,
    source: input.source,
    projectionStatus,
    previousValidProjectionAvailable: input.previousValidProjectionAvailable === true,
    previousValidProjectionGeneratedAt: input.previousValidProjectionGeneratedAt || null,
    stale,
    reasonCodes: [...new Set(reasonCodes)],
    evidenceClassification: projectionUsable
      ? summary.projectionEvidence.evidenceClassification
      : projectionStatus === 'UNKNOWN' ? 'UNAVAILABLE' : 'INCOMPLETE',
    currentStateComplete: projectionUsable && summary.projectionEvidence.currentStateComplete,
    historyComplete: projectionUsable && summary.projectionEvidence.historyComplete,
    truncated: summary.projectionEvidence.truncated,
    collectionPresent: summary.projectionEvidence.collectionPresent,
    observedRange: summary.projectionEvidence.observedRange,
    retentionBoundary: summary.projectionEvidence.retentionBoundary,
    staleRunningCount,
    stuckPendingCount,
    oldestPendingAgeMs: oldestPending === null || oldestPending > input.now
      ? null
      : input.now - oldestPending,
    activeProjectionGeneration: protocolManifest?.activeGeneration ?? null,
    activeProjectionSlot: protocolManifest?.activeSlot || null,
    currentServingProjectionValid: projectionStatus === 'VALID' || projectionStatus === 'STALE',
    currentServingProjectionFingerprint: protocolManifest?.projectionFingerprint || null,
    currentServingProjectionSourceRevision: protocolManifest?.sourceRevision || null,
    pendingProjectionGeneration: activeRepair?.targetGeneration ?? null,
    pendingProjectionSlot: activeRepair?.targetSlot || null,
    currentSourceBoundary: protocolManifest
      ? {
          schemaVersion: AUTOMATION_JOB_PROJECTION_SOURCE_SCHEMA_VERSION,
          highWatermark: protocolManifest.sourceHighWatermark || 0,
          sourceFingerprint: protocolManifest.sourceFingerprint || null,
        }
      : null,
    lastSuccessfulRepairAt: protocolManifest?.lastSuccessfulRepairAt || null,
    activeRepairId: activeRepair?.repairId || null,
    repairOwnerId: activeRepair?.ownerId || null,
    repairOwnerInstanceId: activeRepair?.ownerInstanceId || null,
    repairFencingToken: activeRepair?.repairFence ?? null,
    repairWorkerFencingToken: activeRepair?.workerFencingToken ?? null,
    repairStartedAt: activeRepair?.startedAt || null,
    repairLastHeartbeatAt: activeRepair?.updatedAt || null,
    repairPhase: activeRepair?.phase || null,
    repairAttemptNumber: activeRepair?.attemptNumber || null,
    lastRepairFailureReason: activeRepair?.lastFailureReason || null,
    nextRepairRetryAt: null,
    catchUpPending: activeRepair?.catchUpPending === true,
    previousValidProjectionServing: input.source === 'previous_valid_summary'
      || Boolean(
        activeRepair
        && (activeRepair.phase === 'FAILED' || activeRepair.phase === 'SUPERSEDED')
        && protocolManifest?.activeGeneration !== activeRepair.targetGeneration,
      ),
    legacyMirrorPending: protocolManifest?.legacyMirrorPending === true,
  };
}

function summaryMatchesManifest(
  summary: AutomationJobHealthSummary,
  manifest: AutomationJobProjectionManifest,
): boolean {
  return summary.releaseId === manifest.releaseId
    && summary.projectionVersion === manifest.projectionVersion
    && summary.projectionSchemaVersion === manifest.listProjectionSchemaVersion
    && summary.sourceRevision === manifest.sourceRevision
    && summary.summaryRevision === manifest.summaryRevision
    && summary.projectionFingerprint === manifest.projectionFingerprint
    && summary.totalProjectedJobs === manifest.listProjectionCount
    && canonicalProjectionSerialization(summary.recordCounts)
      === canonicalProjectionSerialization(manifest.recordCounts)
    && canonicalProjectionSerialization(summary.completeness)
      === canonicalProjectionSerialization(manifest.completeness)
    && canonicalProjectionSerialization(summary.observedRange)
      === canonicalProjectionSerialization(manifest.observedRange)
    && summary.projectionEvidence.projectionVersion === manifest.projectionVersion
    && summary.projectionEvidence.sourceRevision === manifest.sourceRevision
    && summary.projectionEvidence.summaryRevision === manifest.summaryRevision
    && summary.projectionEvidence.projectionFingerprint === manifest.projectionFingerprint
    && summary.projectionEvidence.generatedAt === manifest.generatedAt
    && manifest.baselineEstablished
    && manifest.currentStateComplete
    && manifest.rebuildToken === undefined
    && manifest.inFlightSyncTokens.length === 0
    && manifest.syncFailureCountSinceRebuild === 0;
}

export async function getAutomationJobHealthView(now = Date.now()): Promise<AutomationJobHealthView> {
  let stored: AutomationJobHealthSummary[] = [];
  let storedReason: string | undefined;
  const manifestRead = await readProjectionManifest();
  const collections = automationJobProjectionStorageCollections(
    manifestRead.manifest?.activeSlot || 'LEGACY',
    manifestRead.manifest?.activeStorageRepairFence,
  );
  const [summaryRead, projectionRead] = await Promise.all([
    readBoundedCollectionSnapshot<AutomationJobHealthSummary>(collections.summary, {
      maximumItems: 1,
      maximumBytes: SUMMARY_MAXIMUM_BYTES,
    }).then(snapshot => ({ snapshot })).catch((error: unknown) => ({ error })),
    readBoundedAutomationJobProjections(),
  ]);
  if ('snapshot' in summaryRead) {
    const snapshot = summaryRead.snapshot;
    stored = snapshot.items;
    if (!snapshot.metadata.collectionPresent) storedReason = 'JOB_HEALTH_SUMMARY_MISSING';
  } else {
    const error = summaryRead.error;
    storedReason = error instanceof Error && error.message.includes('LIMIT_EXCEEDED')
      ? 'JOB_HEALTH_SUMMARY_BOUND_EXCEEDED'
      : 'JOB_HEALTH_SUMMARY_UNAVAILABLE';
  }
  if (isHealthSummary(stored[0])) {
    const summary = stored[0];
    const releaseMatches = summary.releaseId === getReleaseIdentity().releaseId;
    const coherent = Boolean(
      releaseMatches
      && manifestRead.manifest
      && summaryMatchesManifest(summary, manifestRead.manifest)
      && projectionRead.availability !== 'UNAVAILABLE'
      && projectionRead.currentStateComplete
      && projectionRead.projectionVersion === summary.projectionVersion
      && projectionRead.sourceRevision === summary.sourceRevision
      && projectionRead.summaryRevision === summary.summaryRevision
      && projectionRead.projectionFingerprint === summary.projectionFingerprint
      && projectionRead.manifestReleaseId === summary.releaseId
      && projectionRead.items.length === summary.totalProjectedJobs
      && projectionRead.recordCounts.list === summary.recordCounts.list
      && projectionRead.recordCounts.status === summary.recordCounts.status
      && projectionRead.historyComplete === summary.projectionEvidence.historyComplete
      && projectionRead.truncated === summary.projectionEvidence.truncated,
    );
    if (coherent) {
      return healthView(summary, {
        now,
        availability: 'AVAILABLE',
        source: 'summary',
        reasonCodes: [],
        manifest: manifestRead.manifest,
        previousValidProjectionAvailable: true,
        previousValidProjectionGeneratedAt: summary.generatedAt,
        projectionStatus: 'VALID',
      });
    }
    const rebuildRunning = Boolean(manifestRead.manifest?.rebuildToken);
    return healthView(summary, {
      now,
      availability: 'DEGRADED',
      source: 'previous_valid_summary',
      manifest: manifestRead.manifest,
      previousValidProjectionAvailable: true,
      previousValidProjectionGeneratedAt: summary.generatedAt,
      projectionStatus: rebuildRunning ? 'REBUILD_RUNNING' : 'INVALID',
      reasonCodes: [
        ...(storedReason ? [storedReason] : []),
        ...manifestRead.reasonCodes,
        ...projectionRead.reasonCodes,
        ...(!releaseMatches ? ['JOB_HEALTH_SUMMARY_RELEASE_MISMATCH'] : []),
        ...(releaseMatches && !manifestRead.manifest ? ['JOB_HEALTH_SUMMARY_MANIFEST_UNAVAILABLE'] : []),
        ...(releaseMatches && manifestRead.manifest && !coherent
          ? ['JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH']
          : []),
        ...(rebuildRunning ? ['JOB_PROJECTION_REBUILD_IN_PROGRESS'] : []),
      ],
    });
  }

  if (projectionRead.availability !== 'UNAVAILABLE') {
    const fallback = buildAutomationJobHealthSummary(projectionRead.items, {
      now,
      evidence: {
        evidenceClassification: projectionRead.evidenceClassification,
        source: projectionRead.source,
        collectionPresent: projectionRead.collectionPresent,
        currentStateComplete: projectionRead.currentStateComplete,
        historyComplete: projectionRead.historyComplete,
        truncated: projectionRead.truncated,
        observedRange: projectionRead.observedRange,
        retentionBoundary: projectionRead.retentionBoundary,
        manifestRebuiltAt: projectionRead.manifestRebuiltAt,
        manifestReleaseId: projectionRead.manifestReleaseId,
        manifestUpdatedAt: projectionRead.manifestUpdatedAt,
        projectionVersion: projectionRead.projectionVersion,
        sourceRevision: projectionRead.sourceRevision,
        summaryRevision: projectionRead.summaryRevision,
        projectionFingerprint: projectionRead.projectionFingerprint,
        generatedAt: projectionRead.generatedAt,
        recordCounts: projectionRead.recordCounts,
        completeness: projectionRead.completeness,
      },
    });
    return healthView(fallback, {
      now,
      availability: 'DEGRADED',
      source: 'bounded_projection_fallback',
      manifest: manifestRead.manifest,
      previousValidProjectionAvailable: false,
      previousValidProjectionGeneratedAt: null,
      projectionStatus: 'INVALID',
      reasonCodes: [
        storedReason || (stored.length ? 'JOB_HEALTH_SUMMARY_SCHEMA_INVALID' : 'JOB_HEALTH_SUMMARY_MISSING'),
        ...manifestRead.reasonCodes,
        ...projectionRead.reasonCodes,
      ],
    });
  }

  return healthView(emptySummary(now), {
    now,
    availability: 'UNAVAILABLE',
    source: 'empty_fallback',
    manifest: manifestRead.manifest,
    previousValidProjectionAvailable: false,
    previousValidProjectionGeneratedAt: null,
    projectionStatus: 'UNKNOWN',
    reasonCodes: [
      storedReason || (stored.length ? 'JOB_HEALTH_SUMMARY_SCHEMA_INVALID' : 'JOB_HEALTH_SUMMARY_MISSING'),
      ...manifestRead.reasonCodes,
      ...projectionRead.reasonCodes,
    ],
  });
}

export function applyAutomationJobProjectionMaintenanceState(
  view: AutomationJobHealthView,
  maintenance: {
    repairState: 'IDLE' | 'SCHEDULED' | 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED' | 'EXHAUSTED';
    outcomeReasonCode?: string | null;
    nextRetryAt?: string | null;
    lastFailureReason?: string | null;
  } | null | undefined,
): AutomationJobHealthView {
  if (!maintenance || view.projectionStatus === 'VALID' || view.projectionStatus === 'STALE') return view;
  const projectionStatus: AutomationJobHealthView['projectionStatus'] = maintenance.repairState === 'SCHEDULED'
    ? 'REBUILD_SCHEDULED'
    : maintenance.repairState === 'RUNNING'
      ? 'REBUILD_RUNNING'
      : ['RETRY_SCHEDULED', 'FAILED', 'EXHAUSTED'].includes(maintenance.repairState)
        ? 'REBUILD_FAILED'
        : view.projectionStatus;
  return {
    ...view,
    projectionStatus,
    nextRepairRetryAt: maintenance.nextRetryAt || view.nextRepairRetryAt,
    lastRepairFailureReason: maintenance.lastFailureReason
      || maintenance.outcomeReasonCode
      || view.lastRepairFailureReason,
    reasonCodes: [...new Set([
      ...view.reasonCodes,
      ...(maintenance.outcomeReasonCode ? [maintenance.outcomeReasonCode] : []),
    ])],
  };
}

export function publicAutomationJobHealthView(view: AutomationJobHealthView) {
  const { pickupLatency, runningJobs, pendingJobs, recentJobs, ...safe } = view;
  return {
    ...safe,
    runningJobs: runningJobs.slice(0, 20).map(job => ({
      id: job.id,
      type: job.type,
      status: job.status,
      priority: job.priority,
      startedAt: job.startedAt || null,
      heartbeatAt: job.heartbeatAt || null,
      leaseExpiresAt: job.leaseExpiresAt || null,
      executionCritical: job.executionCritical === true,
    })),
    pendingJobs: pendingJobs.slice(0, 20).map(job => ({
      id: job.id,
      type: job.type,
      status: job.status,
      priority: job.priority,
      runnableAt: job.runnableAt || job.createdAt,
    })),
    recentJobs: recentJobs.slice(0, 20).map(job => ({
      id: job.id,
      type: job.type,
      status: job.status,
      priority: job.priority,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt || null,
      lastErrorCode: job.lastErrorCode || null,
    })),
    pickupLatency: {
      windowStartedAt: pickupLatency.windowStartedAt,
      windowEndedAt: pickupLatency.windowEndedAt,
      sampleCount: pickupLatency.sampleCount,
      p50Ms: pickupLatency.p50Ms,
      p95Ms: pickupLatency.p95Ms,
      insufficientEvidenceCount: pickupLatency.insufficientEvidenceCount,
    },
  };
}
