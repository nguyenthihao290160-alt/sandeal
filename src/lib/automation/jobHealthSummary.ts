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
export const AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION = 1;

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
}

export interface AutomationJobProjectionManifest {
  schemaVersion: typeof AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION;
  id: typeof PROJECTION_MANIFEST_ID;
  listProjectionSchemaVersion: typeof AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION;
  statusProjectionSchemaVersion: typeof AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION;
  releaseId: string;
  projectionCapacity: number;
  durableJobCount: number;
  activeJobCount: number;
  retainedJobCount: number;
  retainedTerminalCount: number;
  listProjectionCount: number;
  statusProjectionCount: number;
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  baselineEstablished: boolean;
  currentStateComplete: boolean;
  historyComplete: boolean;
  truncated: boolean;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  sourceUpdatedAt: string | null;
  rebuiltAt: string | null;
  rebuildToken?: string;
  mutationDuringRebuild: boolean;
  inFlightSyncTokens: string[];
  syncFailureCountSinceRebuild: number;
  updatedAt: string;
}

export interface AutomationJobHealthSummary {
  schemaVersion: typeof AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION;
  projectionSchemaVersion: typeof AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION;
  id: typeof HEALTH_SUMMARY_ID;
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
  source: 'summary' | 'bounded_projection_fallback' | 'empty_fallback';
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
    .update(JSON.stringify(
      [...items]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(item => ({ id: item.id, status: item.status, updatedAt: item.updatedAt })),
    ))
    .digest('hex');
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
  };
}

function emptyProjectionManifest(now = Date.now()): AutomationJobProjectionManifest {
  const measuredAt = new Date(now).toISOString();
  return {
    schemaVersion: AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION,
    id: PROJECTION_MANIFEST_ID,
    listProjectionSchemaVersion: AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
    statusProjectionSchemaVersion: AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION,
    releaseId: getReleaseIdentity().releaseId,
    projectionCapacity: getAutomationJobProjectionLimit(),
    durableJobCount: 0,
    activeJobCount: 0,
    retainedJobCount: 0,
    retainedTerminalCount: 0,
    listProjectionCount: 0,
    statusProjectionCount: 0,
    listProjectionFingerprint: automationJobProjectionFingerprint([]),
    statusProjectionFingerprint: automationJobProjectionFingerprint([]),
    baselineEstablished: false,
    currentStateComplete: false,
    historyComplete: false,
    truncated: false,
    retentionBoundary: null,
    sourceUpdatedAt: null,
    rebuiltAt: null,
    mutationDuringRebuild: false,
    inFlightSyncTokens: [],
    syncFailureCountSinceRebuild: 0,
    updatedAt: measuredAt,
  };
}

function isProjectionManifest(value: unknown): value is AutomationJobProjectionManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<AutomationJobProjectionManifest>;
  return manifest.id === PROJECTION_MANIFEST_ID
    && manifest.schemaVersion === AUTOMATION_JOB_PROJECTION_MANIFEST_SCHEMA_VERSION
    && manifest.listProjectionSchemaVersion === AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION
    && manifest.statusProjectionSchemaVersion === AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION
    && typeof manifest.releaseId === 'string'
    && manifest.releaseId.length > 0
    && manifest.releaseId.length <= 160
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
    && (
      manifest.rebuildToken === undefined
      || (typeof manifest.rebuildToken === 'string' && manifest.rebuildToken.length <= 100)
    )
    && typeof manifest.mutationDuringRebuild === 'boolean'
    && Array.isArray(manifest.inFlightSyncTokens)
    && manifest.inFlightSyncTokens.every(token => typeof token === 'string' && token.length > 0)
    && Number.isInteger(manifest.syncFailureCountSinceRebuild)
    && Number(manifest.syncFailureCountSinceRebuild) >= 0
    && timestamp(manifest.updatedAt) !== null;
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
      return { manifest: null, collectionPresent: true, reasonCodes: ['JOB_PROJECTION_MANIFEST_INVALID'] };
    }
    return { manifest: snapshot.items[0], collectionPresent: true, reasonCodes: [] };
  } catch {
    return { manifest: null, collectionPresent: false, reasonCodes: ['JOB_PROJECTION_MANIFEST_UNAVAILABLE'] };
  }
}

export async function beginAutomationJobProjectionSync(now = Date.now()): Promise<string> {
  const token = randomUUID();
  const measuredAt = new Date(now).toISOString();
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    const current = isProjectionManifest(items[0]) ? items[0] : emptyProjectionManifest(now);
    const tokens = [...new Set([...current.inFlightSyncTokens, token])].slice(-100);
    const releaseMatches = current.releaseId === getReleaseIdentity().releaseId;
    return [{
      ...current,
      releaseId: getReleaseIdentity().releaseId,
      baselineEstablished: current.baselineEstablished && releaseMatches,
      currentStateComplete: false,
      historyComplete: current.historyComplete && releaseMatches,
      mutationDuringRebuild: current.mutationDuringRebuild || Boolean(current.rebuildToken),
      inFlightSyncTokens: tokens,
      syncFailureCountSinceRebuild: tokens.includes(token)
        ? current.syncFailureCountSinceRebuild + (releaseMatches ? 0 : 1)
        : current.syncFailureCountSinceRebuild + 1,
      updatedAt: measuredAt,
    }];
  });
  return token;
}

export interface AutomationJobProjectionSyncResult {
  success: boolean;
  inserted: boolean;
  listProjectionCount: number;
  statusProjectionCount: number;
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  activeJobCount: number;
  retainedTerminalCount: number;
  retentionLimitReached: boolean;
  currentStateTruncated: boolean;
  sourceUpdatedAt: string | null;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
}

export async function finishAutomationJobProjectionSync(
  token: string,
  result: AutomationJobProjectionSyncResult,
  now = Date.now(),
): Promise<void> {
  const measuredAt = new Date(now).toISOString();
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    if (!isProjectionManifest(items[0])) return undefined;
    const current = items[0];
    if (!current.inFlightSyncTokens.includes(token)) return undefined;
    const inFlightSyncTokens = current.inFlightSyncTokens.filter(value => value !== token);
    const syncFailureCountSinceRebuild = current.syncFailureCountSinceRebuild + (result.success ? 0 : 1);
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
      && !current.rebuildToken
      && !current.mutationDuringRebuild
      && result.activeJobCount <= getAutomationJobProjectionLimit();
    return [{
      ...current,
      projectionCapacity: getAutomationJobProjectionLimit(),
      durableJobCount: current.durableJobCount + (result.success && result.inserted ? 1 : 0),
      activeJobCount: result.activeJobCount,
      retainedJobCount: Math.min(result.listProjectionCount, result.statusProjectionCount),
      retainedTerminalCount: result.retainedTerminalCount,
      listProjectionCount: result.listProjectionCount,
      statusProjectionCount: result.statusProjectionCount,
      listProjectionFingerprint: result.listProjectionFingerprint,
      statusProjectionFingerprint: result.statusProjectionFingerprint,
      baselineEstablished,
      currentStateComplete,
      historyComplete,
      truncated,
      retentionBoundary: result.retentionBoundary || current.retentionBoundary,
      sourceUpdatedAt: newestTimestamp([
        current.sourceUpdatedAt || undefined,
        result.sourceUpdatedAt || undefined,
      ]),
      inFlightSyncTokens,
      syncFailureCountSinceRebuild,
      updatedAt: measuredAt,
    }];
  });
}

export async function beginAutomationJobProjectionRebuild(now = Date.now()): Promise<string> {
  const token = randomUUID();
  const measuredAt = new Date(now).toISOString();
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    const current = isProjectionManifest(items[0]) ? items[0] : emptyProjectionManifest(now);
    return [{
      ...current,
      releaseId: getReleaseIdentity().releaseId,
      baselineEstablished: false,
      currentStateComplete: false,
      historyComplete: false,
      rebuildToken: token,
      mutationDuringRebuild: current.inFlightSyncTokens.length > 0,
      updatedAt: measuredAt,
    }];
  });
  return token;
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
  truncated: boolean;
  sourceUpdatedAt: string | null;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
}

export async function finishAutomationJobProjectionRebuild(
  token: string,
  result: AutomationJobProjectionRebuildResult | null,
  now = Date.now(),
): Promise<AutomationJobProjectionManifest> {
  const measuredAt = new Date(now).toISOString();
  let output = emptyProjectionManifest(now);
  await runTransaction<AutomationJobProjectionManifest>(projectionManifestCollection, items => {
    const current = isProjectionManifest(items[0]) ? items[0] : emptyProjectionManifest(now);
    if (current.rebuildToken !== token) {
      output = current;
      return undefined;
    }
    const concurrentMutation = current.mutationDuringRebuild || current.inFlightSyncTokens.length > 0;
    const validResult = Boolean(
      result
      && result.listProjectionCount === result.statusProjectionCount
      && result.retainedJobCount === result.listProjectionCount
      && result.listProjectionFingerprint === result.statusProjectionFingerprint
    );
    const atCapacity = Boolean(result && result.retainedJobCount >= getAutomationJobProjectionLimit());
    const baselineEstablished = validResult && !concurrentMutation;
    output = {
      ...current,
      releaseId: getReleaseIdentity().releaseId,
      projectionCapacity: getAutomationJobProjectionLimit(),
      durableJobCount: result?.durableJobCount || 0,
      activeJobCount: result?.activeJobCount || 0,
      retainedJobCount: result?.retainedJobCount || 0,
      retainedTerminalCount: result?.retainedTerminalCount || 0,
      listProjectionCount: result?.listProjectionCount || 0,
      statusProjectionCount: result?.statusProjectionCount || 0,
      listProjectionFingerprint: result?.listProjectionFingerprint || automationJobProjectionFingerprint([]),
      statusProjectionFingerprint: result?.statusProjectionFingerprint || automationJobProjectionFingerprint([]),
      baselineEstablished,
      currentStateComplete: baselineEstablished
        && Number(result?.activeJobCount || 0) <= getAutomationJobProjectionLimit(),
      historyComplete: baselineEstablished && !result?.truncated && !atCapacity,
      truncated: Boolean(result?.truncated || atCapacity),
      retentionBoundary: result?.retentionBoundary || null,
      sourceUpdatedAt: result?.sourceUpdatedAt || null,
      rebuiltAt: baselineEstablished ? measuredAt : null,
      rebuildToken: undefined,
      mutationDuringRebuild: false,
      syncFailureCountSinceRebuild: baselineEstablished ? 0 : current.syncFailureCountSinceRebuild + 1,
      updatedAt: measuredAt,
    };
    return [output];
  });
  return output;
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
  const actualFingerprint = automationJobProjectionFingerprint(input.items);
  const releaseMatches = input.manifest?.releaseId === getReleaseIdentity().releaseId;
  const countMatches = expectedCount === input.rawCount;
  const fingerprintMatches = expectedFingerprint === actualFingerprint;
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
    ...(input.manifest && !fingerprintMatches ? ['JOB_PROJECTION_MANIFEST_FINGERPRINT_MISMATCH'] : []),
    ...(input.manifest?.rebuildToken ? ['JOB_PROJECTION_REBUILD_IN_PROGRESS'] : []),
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
  return {
    schemaVersion: AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION,
    projectionSchemaVersion: AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
    id: HEALTH_SUMMARY_ID,
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
  return {
    schemaVersion: AUTOMATION_JOB_HEALTH_SUMMARY_SCHEMA_VERSION,
    projectionSchemaVersion: AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
    id: HEALTH_SUMMARY_ID,
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
    && summary.statusCounts !== null
    && typeof summary.statusCounts === 'object'
    && summary.projectionEvidence !== null
    && typeof summary.projectionEvidence === 'object'
    && ['COMPLETE', 'INCOMPLETE', 'UNAVAILABLE'].includes(String(summary.projectionEvidence.evidenceClassification))
    && typeof summary.projectionEvidence.currentStateComplete === 'boolean'
    && typeof summary.projectionEvidence.historyComplete === 'boolean'
    && typeof summary.projectionEvidence.truncated === 'boolean'
    && typeof summary.projectionEvidence.collectionPresent === 'boolean'
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
    && timestamp(summary.updatedAt) !== null;
}

export async function readBoundedAutomationJobProjections(): Promise<BoundedAutomationJobProjectionRead> {
  try {
    const [snapshot, manifestRead] = await Promise.all([
      readBoundedCollectionSnapshot<AutomationJobListProjection>(jobListProjectionCollection, {
        maximumItems: getAutomationJobProjectionLimit(),
        maximumBytes: PROJECTION_MAXIMUM_BYTES,
      }),
      readProjectionManifest(),
    ]);
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
    const [snapshot, manifestRead] = await Promise.all([
      readBoundedCollectionSnapshot<AutomationJobStatusProjection>(jobStatusProjectionCollection, {
        maximumItems: getAutomationJobProjectionLimit(),
        maximumBytes: PROJECTION_MAXIMUM_BYTES,
      }),
      readProjectionManifest(),
    ]);
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
  let output: AutomationJobHealthSummary | undefined;
  await runTransaction<AutomationJobHealthSummary>(healthSummaryCollection, items => {
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
    if (previous && (sourceRegressed || generatedAtRegressed)) {
      output = previous;
      return undefined;
    }
    output = candidate;
    return [candidate];
  });
  if (!output) throw new Error('JOB_HEALTH_SUMMARY_REFRESH_FAILED');
  return output;
}

function healthView(
  summary: AutomationJobHealthSummary,
  input: {
    now: number;
    availability: AutomationJobHealthView['availability'];
    source: AutomationJobHealthView['source'];
    reasonCodes: string[];
  },
): AutomationJobHealthView {
  const hasActiveJobs = ALL_STATUSES.some(status => ACTIVE_STATUSES.has(status) && summary.statusCounts[status] > 0);
  const freshnessTimestamp = hasActiveJobs
    ? timestamp(summary.sourceUpdatedAt)
    : timestamp(summary.updatedAt);
  const summaryAge = freshnessTimestamp === null ? Number.POSITIVE_INFINITY : input.now - freshnessTimestamp;
  const stale = !Number.isFinite(summaryAge)
    || summaryAge < -60_000
    || summaryAge > (hasActiveJobs ? ACTIVE_SUMMARY_FRESHNESS_MS : IDLE_SUMMARY_FRESHNESS_MS);
  const staleRunningCount = summary.runningJobs.filter(job => {
    const lease = timestamp(job.leaseExpiresAt);
    const heartbeat = timestamp(job.heartbeatAt);
    return lease === null || lease <= input.now || (heartbeat !== null && input.now - heartbeat > ACTIVE_SUMMARY_FRESHNESS_MS);
  }).length;
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
  return {
    ...summary,
    availability: input.availability === 'AVAILABLE' && reasonCodes.length ? 'DEGRADED' : input.availability,
    source: input.source,
    stale,
    reasonCodes: [...new Set(reasonCodes)],
    evidenceClassification: summary.projectionEvidence.evidenceClassification,
    currentStateComplete: summary.projectionEvidence.currentStateComplete,
    historyComplete: summary.projectionEvidence.historyComplete,
    truncated: summary.projectionEvidence.truncated,
    collectionPresent: summary.projectionEvidence.collectionPresent,
    observedRange: summary.projectionEvidence.observedRange,
    retentionBoundary: summary.projectionEvidence.retentionBoundary,
    staleRunningCount,
    stuckPendingCount,
    oldestPendingAgeMs: oldestPending === null || oldestPending > input.now
      ? null
      : input.now - oldestPending,
  };
}

export async function getAutomationJobHealthView(now = Date.now()): Promise<AutomationJobHealthView> {
  let stored: AutomationJobHealthSummary[] = [];
  let storedReason: string | undefined;
  let projectionRead: BoundedAutomationJobProjectionRead | undefined;
  try {
    const snapshot = await readBoundedCollectionSnapshot<AutomationJobHealthSummary>(healthSummaryCollection, {
      maximumItems: 1,
      maximumBytes: SUMMARY_MAXIMUM_BYTES,
    });
    stored = snapshot.items;
    if (!snapshot.metadata.collectionPresent) storedReason = 'JOB_HEALTH_SUMMARY_MISSING';
  } catch (error) {
    storedReason = error instanceof Error && error.message.includes('LIMIT_EXCEEDED')
      ? 'JOB_HEALTH_SUMMARY_BOUND_EXCEEDED'
      : 'JOB_HEALTH_SUMMARY_UNAVAILABLE';
  }
  if (isHealthSummary(stored[0]) && stored[0].releaseId === getReleaseIdentity().releaseId) {
    projectionRead = await readBoundedAutomationJobProjections();
    const expectedManifestUpdatedAt = stored[0].projectionEvidence.manifestUpdatedAt;
    const projectionMatches = projectionRead.availability !== 'UNAVAILABLE'
      && projectionRead.currentStateComplete
      && stored[0].projectionEvidence.currentStateComplete
      && projectionRead.manifestUpdatedAt === expectedManifestUpdatedAt
      && projectionRead.manifestReleaseId === stored[0].releaseId
      && projectionRead.items.length === stored[0].totalProjectedJobs
      && projectionRead.historyComplete === stored[0].projectionEvidence.historyComplete
      && projectionRead.truncated === stored[0].projectionEvidence.truncated;
    if (projectionMatches) {
      return healthView(stored[0], {
        now,
        availability: 'AVAILABLE',
        source: 'summary',
        reasonCodes: projectionRead.reasonCodes,
      });
    }
    storedReason = projectionRead.availability === 'UNAVAILABLE'
      ? 'JOB_HEALTH_SUMMARY_PROJECTION_UNAVAILABLE'
      : 'JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH';
  }

  const projection = projectionRead || await readBoundedAutomationJobProjections();
  if (projection.availability !== 'UNAVAILABLE') {
    const fallback = buildAutomationJobHealthSummary(projection.items, {
      now,
      evidence: {
        evidenceClassification: projection.evidenceClassification,
        source: projection.source,
        collectionPresent: projection.collectionPresent,
        currentStateComplete: projection.currentStateComplete,
        historyComplete: projection.historyComplete,
        truncated: projection.truncated,
        observedRange: projection.observedRange,
        retentionBoundary: projection.retentionBoundary,
        manifestRebuiltAt: projection.manifestRebuiltAt,
        manifestReleaseId: projection.manifestReleaseId,
        manifestUpdatedAt: projection.manifestUpdatedAt,
      },
    });
    return healthView(fallback, {
      now,
      availability: 'DEGRADED',
      source: 'bounded_projection_fallback',
      reasonCodes: [
        storedReason || (
          stored.length && isHealthSummary(stored[0])
            ? 'JOB_HEALTH_SUMMARY_RELEASE_MISMATCH'
            : stored.length
              ? 'JOB_HEALTH_SUMMARY_SCHEMA_INVALID'
              : 'JOB_HEALTH_SUMMARY_MISSING'
        ),
        ...projection.reasonCodes,
      ],
    });
  }

  return healthView(emptySummary(now), {
    now,
    availability: 'UNAVAILABLE',
    source: 'empty_fallback',
    reasonCodes: [
      storedReason || (stored.length ? 'JOB_HEALTH_SUMMARY_SCHEMA_INVALID' : 'JOB_HEALTH_SUMMARY_MISSING'),
      ...projection.reasonCodes,
    ],
  });
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
