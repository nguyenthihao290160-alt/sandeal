import { createHash } from 'node:crypto';
import { readBoundedCollectionSnapshot, readCollection, runTransaction } from '@/lib/storage/adapter';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import type { Product } from '@/lib/types';
import {
  advanceCanaryWaveAfterHealthyEvaluation,
  applyCanarySafetyDecision,
  getCanaryState,
  type CanaryState,
} from './canaryController';
import type { RuntimeHealthSnapshot } from './runtimeGuardian';
import { getFeatureRolloutState, type FeatureRolloutMode } from './featureRollout';
import { isCriticalAutomationJob } from './executionPolicy';
import { readBoundedAutomationJobStatuses } from './jobHealthSummary';
import {
  advanceRuntimeReasonRecoveryState,
  confirmRuntimeRecoveryClosed,
  getRuntimeRecoveryPolicy,
  type RuntimeRecoveryEvidenceSummary,
  type RuntimeRecoveryMeasurementState,
  type RuntimeRecoveryState,
} from './runtimeRecoveryState';
import {
  applyRuntimePublishBlock,
  appendAutomationAuditOnce,
  clearRuntimePublishReasons,
  flushRuntimeControlApplicationAudits,
  getAutomationControl,
} from './store';
import type { AutomationControlState, AutomationJob, AutomationJobAttempt } from './types';

const SNAPSHOT_COLLECTION = 'automation-slo-snapshots';
const JOB_ATTEMPT_COLLECTION = 'automation-job-attempts';
const RUNTIME_COLLECTION = 'runtime-health';
const PUBLICATION_AUDIT_COLLECTION = 'publication-audit';
const OUTBOUND_COLLECTION = 'automation-outbound-events';
const PRODUCT_COLLECTION = 'products';

export const SLO_ERROR_BUDGET_RULE_VERSION = 'automation-slo-error-budget-v3';
export const DEFAULT_SLO_WINDOW_MS = 24 * 60 * 60_000;
export const DEFAULT_SLO_MINIMUM_SAMPLES = 5;
export const DEFAULT_RUNTIME_FRESHNESS_MS = 2 * 60_000;

type MetricStatus = 'PASS' | 'BREACH' | 'NO_DATA' | 'NOT_APPLICABLE';
type EvaluationStatus = 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA';

export type AutomationPickupPriorityClass = 'CRITICAL' | 'NORMAL' | 'UNCLASSIFIED';

export interface AutomationPickupPriorityLatency {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface AutomationPickupLatencyByPriorityClass {
  current: Record<AutomationPickupPriorityClass, AutomationPickupPriorityLatency>;
  historical: Record<AutomationPickupPriorityClass, AutomationPickupPriorityLatency>;
}

export interface SloMetric {
  key:
    | 'worker_heartbeat_fresh'
    | 'scheduler_heartbeat_fresh'
    | 'job_pickup_latency_p95_ms'
    | 'terminal_outcome_rate'
    | 'terminal_error_rate'
    | 'post_publish_health_pass_rate'
    | 'duplicate_publish_count'
    | 'unsafe_publish_count'
    | 'storage_lock_timeout_count'
    | 'rollback_rate'
    | 'zero_touch_completion_rate'
    | 'runtime_publish_safe'
    | 'public_route_healthy';
  value: number | boolean | null;
  observedValue: number | boolean | null;
  sampleSize: number;
  qualifyingSampleCount: number;
  excludedSampleCount: number;
  status: MetricStatus;
  evaluationStatus: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA' | 'NOT_APPLICABLE';
  measurementState: RuntimeRecoveryMeasurementState;
  stateReason: string;
  reasonCode: string;
  target: string;
  threshold: string;
  windowStart: string;
  windowEnd: string;
  measurementSemantics: string;
  evidenceSufficiency: 'SUFFICIENT' | 'INSUFFICIENT' | 'NOT_APPLICABLE';
  rawNumerator: number | null;
  rawDenominator: number | null;
}

export interface AutomationSloMeasurement {
  schemaVersion: number;
  id: string;
  ruleVersion: string;
  dataStatus: RuntimeRecoveryMeasurementState;
  windowStartedAt: string;
  windowEndedAt: string;
  minimumSamples: number;
  sampleSize: number;
  sourceCounts: {
    jobs: number;
    terminalJobs: number;
    pickupAttempts: number;
    retryPickupAttempts: number;
    neverClaimedPending: number;
    monitorOutcomes: number;
    pendingMonitorTargets: number;
    runtimeSnapshots: number;
    publicationAttempts: number;
    publishBlockedDecisions: number;
    outboundEvents: number;
    publicProducts: number;
    zeroTouchEligible: number;
    zeroTouchSucceeded: number;
    zeroTouchBlocked: number;
    zeroTouchFailed: number;
    zeroTouchPartial: number;
    pickupCreatedAtAttempts: number;
    pickupScheduledAttempts: number;
    pickupRetryAttempts: number;
    pickupCarriedIntoWindow: number;
    pickupHistoricalSamples: number;
    pickupCurrentSamples: number;
    pickupExcludedLegacySamples: number;
    pickupInsufficientTimestampSamples: number;
  };
  jobProjection: {
    availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
    evidenceClassification: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';
    source: 'job-status-projection-v1';
    collectionPresent: boolean;
    currentStateComplete: boolean;
    historyComplete: boolean;
    windowComplete: boolean;
    windowStartedAt: string;
    truncated: boolean;
    coverageComplete: boolean;
    reasonCodes: string[];
    observedRange: {
      earliestCreatedAt: string | null;
      latestCreatedAt: string | null;
      earliestUpdatedAt: string | null;
      latestUpdatedAt: string | null;
    };
    retentionBoundary: { field: 'updatedAt'; oldestRetainedAt: string } | null;
  };
  sourceAvailability: {
    jobAttempts: boolean;
    runtimeSnapshots: boolean;
    publicationAudits: boolean;
    outboundEvents: boolean;
    products: boolean;
  };
  sourceCompleteness: {
    jobAttemptsWindow: boolean;
    runtimeWindow: boolean;
    publicationAuditWindow: boolean;
    outboundEventWindow: boolean;
    currentProducts: boolean;
    reasonCodes: string[];
  };
  workerHeartbeatFresh: boolean | null;
  schedulerHeartbeatFresh: boolean | null;
  pickupLatencyP50Ms: number | null;
  pickupLatencyP95Ms: number | null;
  pickupLatencyLegacyP95Ms: number | null;
  pickupLatencyRunnableAtP95Ms: number | null;
  pickupLatencyHistoricalP50Ms: number | null;
  pickupLatencyHistoricalP95Ms: number | null;
  pickupLatencyHistoricalSampleCount: number;
  pickupLatencyCurrentP50Ms: number | null;
  pickupLatencyCurrentP95Ms: number | null;
  pickupLatencyCurrentSampleCount: number;
  pickupLatencyExcludedLegacyCount: number;
  pickupLatencyInsufficientTimestampCount: number;
  pickupLatencyByPriorityClass: AutomationPickupLatencyByPriorityClass;
  pickupLatencyMeasurementSemantics: {
    historical: 'LEGACY_CREATED_AT';
    current: 'EXPLICIT_RUNNABLE_AT_CURRENT_RELEASE';
  };
  pickupLatencyRolloutBoundary: {
    cohort: string;
    startedAt: string | null;
  };
  pickupLatencyReleaseBoundary: {
    releaseId: string;
    startedAt: string | null;
  };
  retryPickupLatencyP95Ms: number | null;
  pickupLatencyMode: 'LEGACY_CREATED_AT' | 'RUNNABLE_AT';
  pickupLatencyFeatureMode: FeatureRolloutMode;
  pendingQueueAgeMs: number | null;
  pendingQueueCount: number;
  terminalOutcomeRate: number | null;
  errorRate: number | null;
  healthPassRate: number | null;
  duplicatePublishCount: number;
  unsafePublishCount: number;
  unsafeProductIds: string[];
  storageLockTimeoutCount: number;
  rollbackRate: number | null;
  zeroTouchRate: number | null;
  runtimePublishSafe: boolean | null;
  runtimeReasons: string[];
  publicRouteHealthy: boolean | null;
  metrics: SloMetric[];
  metricEvidence: SloMetricEvidence[];
  releaseIdentity: string;
  evidenceHash: string;
  measuredAt: string;
}

export interface SloMetricEvidence {
  metricKey: SloMetric['key'];
  source:
    | 'runtime-health-current'
    | 'current-job-state'
    | 'job-attempt-history'
    | 'bounded-job-history'
    | 'publication-history'
    | 'current-products';
  observedAt: string | null;
  complete: boolean;
  releaseIdentity: string;
  reasonCodes: string[];
  references: string[];
}

export interface ErrorBudgetEvaluation {
  schemaVersion: number;
  id: string;
  ruleVersion: string;
  measurementId: string;
  status: EvaluationStatus;
  dataStatus: AutomationSloMeasurement['dataStatus'];
  sampleSize: number;
  reasons: string[];
  severeReasons: string[];
  blockingMetrics: Array<{ metricKey: SloMetric['key']; reasonCode: string; sampleSize: number }>;
  unavailableMetrics: Array<{ metricKey: SloMetric['key']; reasonCode: string; sampleSize: number }>;
  evaluatedAt: string;
}

export interface AppliedErrorBudget {
  measurement: AutomationSloMeasurement;
  evaluation: ErrorBudgetEvaluation;
  applied: boolean;
  previousEffectiveMode: AutomationControlState['effectiveMode'];
  control: AutomationControlState;
  canary: CanaryState;
  recovery: RuntimeRecoveryState;
  recoveryFeatureMode: FeatureRolloutMode;
  publishPausedByBudget: boolean;
  ingestionAvailable: boolean;
}

export interface ErrorBudgetControlApplication {
  status: 'CLAIMED' | 'APPLIED';
  evaluationId: string;
  previousEffectiveMode?: AutomationControlState['effectiveMode'];
  nextEffectiveMode?: AutomationControlState['effectiveMode'];
  publishPaused?: boolean;
  claimedAt: string;
  appliedAt?: string;
}

type StoredSloSnapshot = AutomationSloMeasurement & {
  evaluation: ErrorBudgetEvaluation;
  application?: ErrorBudgetControlApplication;
};

interface PublicationAuditRecord {
  runId?: string;
  productId?: string;
  action?: string;
  timestamp?: string;
}

interface OutboundPublicationEvent {
  effectKey?: string;
  productId?: string;
  eventType?: string;
  createdAt?: string;
}

export interface MeasureAutomationSloOptions {
  now?: number;
  windowMs?: number;
  minimumSamples?: number;
  runtimeFreshnessMs?: number;
}

function validTimestamp(value: unknown): number | null {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : null;
}

function inWindow(value: unknown, start: number, end: number): boolean {
  const parsed = validTimestamp(value);
  return parsed !== null && parsed >= start && parsed <= end + 60_000;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

function latestIsoTimestamp(values: unknown[]): string | null {
  const latest = values
    .map(validTimestamp)
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0];
  return latest === undefined ? null : new Date(latest).toISOString();
}

function oldestTimestamp(values: unknown[]): string | null {
  const earliest = values
    .map(validTimestamp)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0];
  return earliest === undefined ? null : new Date(earliest).toISOString();
}

function p50(values: number[]): number | null {
  return percentile(values, 0.5);
}

function p95(values: number[]): number | null {
  return percentile(values, 0.95);
}

export interface RunnableAtContext {
  runnableAt: number;
  runnableReason: AutomationJobAttempt['runnableReason'];
}

type RunnableAtSource = Pick<AutomationJob, 'createdAt' | 'scheduledAt' | 'runnableAt' | 'runnableReason' | 'nextRetryAt'>
  | Pick<AutomationJobAttempt, 'createdAt' | 'scheduledAt' | 'runnableAt' | 'runnableReason' | 'retryEligibleAt'>;

export interface PickupLatencyObservation {
  runnableAt: number;
  claimedAt: number;
  latencyMs: number;
  runnableReason: AutomationJobAttempt['runnableReason'];
  retryAttempt: boolean;
}

export function deriveRunnableAt(source: RunnableAtSource): RunnableAtContext | null {
  const explicitRunnableAt = validTimestamp(source.runnableAt);
  if (explicitRunnableAt !== null && source.runnableReason) {
    return {
      runnableAt: explicitRunnableAt,
      runnableReason: source.runnableReason,
    };
  }

  const retrySource = 'retryEligibleAt' in source
    ? source.retryEligibleAt
    : 'nextRetryAt' in source
      ? source.nextRetryAt
      : undefined;
  const retryEligibleAt = validTimestamp(retrySource);
  if (retryEligibleAt !== null) {
    return {
      runnableAt: retryEligibleAt,
      runnableReason: 'RETRY_ELIGIBLE_AT',
    };
  }

  const createdAt = validTimestamp(source.createdAt);
  const scheduledAt = validTimestamp(source.scheduledAt);
  if (scheduledAt !== null && (createdAt === null || scheduledAt > createdAt)) {
    return {
      runnableAt: scheduledAt,
      runnableReason: 'SCHEDULED_AT',
    };
  }
  return createdAt === null
    ? null
    : {
        runnableAt: createdAt,
        runnableReason: 'CREATED_AT',
      };
}

export function derivePickupLatencyObservation(
  source: RunnableAtSource & { claimedAt?: string },
  windowStartedAt: number,
  windowEndedAt: number,
): PickupLatencyObservation | null {
  const runnable = deriveRunnableAt(source);
  const claimedAt = validTimestamp(source.claimedAt);
  if (!runnable || claimedAt === null || claimedAt < runnable.runnableAt) return null;
  const runnableInsideWindow = runnable.runnableAt >= windowStartedAt && runnable.runnableAt <= windowEndedAt;
  const claimInsideWindow = claimedAt >= windowStartedAt && claimedAt <= windowEndedAt;
  if (!runnableInsideWindow && !claimInsideWindow) return null;
  return {
    runnableAt: runnable.runnableAt,
    claimedAt,
    latencyMs: claimedAt - runnable.runnableAt,
    runnableReason: runnable.runnableReason,
    retryAttempt: runnable.runnableReason === 'RETRY_ELIGIBLE_AT',
  };
}

export function deriveExplicitPickupLatencyObservation(
  source: RunnableAtSource & { claimedAt?: string },
  windowStartedAt: number,
  windowEndedAt: number,
): PickupLatencyObservation | null {
  const runnableAt = validTimestamp(source.runnableAt);
  const claimedAt = validTimestamp(source.claimedAt);
  if (
    runnableAt === null
    || !source.runnableReason
    || claimedAt === null
    || claimedAt < runnableAt
  ) {
    return null;
  }
  const runnableInsideWindow = runnableAt >= windowStartedAt && runnableAt <= windowEndedAt;
  const claimInsideWindow = claimedAt >= windowStartedAt && claimedAt <= windowEndedAt;
  if (!runnableInsideWindow && !claimInsideWindow) return null;
  return {
    runnableAt,
    claimedAt,
    latencyMs: claimedAt - runnableAt,
    runnableReason: source.runnableReason,
    retryAttempt: source.runnableReason === 'RETRY_ELIGIBLE_AT',
  };
}

function fixedPriorityClass(type: AutomationJob['type']): AutomationPickupPriorityClass {
  if (type === 'RUNTIME_GUARDIAN' || type === 'POST_PUBLISH_MONITOR') return 'CRITICAL';
  // A legacy reconcile record does not retain its maintenance payload. Do not
  // guess whether it was a projection repair; surface it as incomplete data.
  if (type === 'RECONCILE_AUTOMATION') return 'UNCLASSIFIED';
  return 'NORMAL';
}

/**
 * Classify immutable claim telemetry without re-reading durable job history.
 * New attempts carry a claim-time class; older attempts are only classified
 * where their job type is unambiguous.
 */
export function classifyAutomationPickupPriority(
  input: Pick<AutomationJobAttempt, 'jobType' | 'priorityClass'>
    | Pick<AutomationJob, 'type' | 'payload' | 'executionCritical'>,
): AutomationPickupPriorityClass {
  if ('jobType' in input) {
    if (input.priorityClass === 'CRITICAL' || input.priorityClass === 'NORMAL') return input.priorityClass;
    return fixedPriorityClass(input.jobType);
  }
  if (typeof input.executionCritical === 'boolean') {
    return input.executionCritical ? 'CRITICAL' : 'NORMAL';
  }
  return isCriticalAutomationJob(input) ? 'CRITICAL' : fixedPriorityClass(input.type);
}

function summarizePickupPriority(
  records: Array<{ observation: PickupLatencyObservation; priorityClass: AutomationPickupPriorityClass }>,
  priorityClass: AutomationPickupPriorityClass,
): AutomationPickupPriorityLatency {
  const values = records
    .filter(record => record.priorityClass === priorityClass)
    .map(record => record.observation.latencyMs);
  return {
    sampleCount: values.length,
    p50Ms: p50(values),
    p95Ms: p95(values),
  };
}

function pickupPriorityBreakdown(
  current: Array<{ observation: PickupLatencyObservation; priorityClass: AutomationPickupPriorityClass }>,
  historical: Array<{ observation: PickupLatencyObservation; priorityClass: AutomationPickupPriorityClass }>,
): AutomationPickupLatencyByPriorityClass {
  const classes: AutomationPickupPriorityClass[] = ['CRITICAL', 'NORMAL', 'UNCLASSIFIED'];
  const summarize = (records: typeof current) => Object.fromEntries(
    classes.map(priorityClass => [priorityClass, summarizePickupPriority(records, priorityClass)]),
  ) as Record<AutomationPickupPriorityClass, AutomationPickupPriorityLatency>;
  return { current: summarize(current), historical: summarize(historical) };
}

function booleanMetric(key: SloMetric['key'], value: boolean | null, target: string): SloMetric {
  const sufficient = value !== null;
  return {
    key,
    value,
    observedValue: value,
    sampleSize: value === null ? 0 : 1,
    qualifyingSampleCount: value === null ? 0 : 1,
    excludedSampleCount: 0,
    status: value === null ? 'NO_DATA' : value ? 'PASS' : 'BREACH',
    evaluationStatus: value === null ? 'INSUFFICIENT_DATA' : value ? 'PASS' : 'BREACH',
    measurementState: value === null ? 'INSUFFICIENT_DATA' : 'MEASURED',
    stateReason: value === null ? 'METRIC_EVIDENCE_MISSING' : 'METRIC_MEASURED',
    reasonCode: value === null ? 'METRIC_EVIDENCE_MISSING' : 'METRIC_MEASURED',
    target,
    threshold: target,
    windowStart: '',
    windowEnd: '',
    measurementSemantics: 'CURRENT_AUTHORITATIVE_STATE',
    evidenceSufficiency: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    rawNumerator: value === null ? null : value ? 1 : 0,
    rawDenominator: value === null ? null : 1,
  };
}

function upperBoundMetric(key: SloMetric['key'], value: number | null, sampleSize: number, maximum: number, target: string, minimumSamples = 1): SloMetric {
  const sufficient = value !== null && sampleSize >= minimumSamples;
  return {
    key,
    value,
    observedValue: value,
    sampleSize,
    qualifyingSampleCount: sufficient ? sampleSize : 0,
    excludedSampleCount: 0,
    status: value === null || sampleSize < minimumSamples ? 'NO_DATA' : value <= maximum ? 'PASS' : 'BREACH',
    evaluationStatus: value === null || sampleSize < minimumSamples
      ? 'INSUFFICIENT_DATA'
      : value <= maximum ? 'PASS' : 'BREACH',
    measurementState: value === null || sampleSize < minimumSamples ? 'INSUFFICIENT_DATA' : 'MEASURED',
    stateReason: value === null || sampleSize < minimumSamples ? 'METRIC_MINIMUM_SAMPLE_NOT_MET' : 'METRIC_MEASURED',
    reasonCode: value === null || sampleSize < minimumSamples ? 'METRIC_MINIMUM_SAMPLE_NOT_MET' : 'METRIC_MEASURED',
    target,
    threshold: target,
    windowStart: '',
    windowEnd: '',
    measurementSemantics: 'BOUNDED_WINDOW',
    evidenceSufficiency: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    rawNumerator: null,
    rawDenominator: sampleSize,
  };
}

function lowerBoundMetric(key: SloMetric['key'], value: number | null, sampleSize: number, minimum: number, target: string, minimumSamples = 1): SloMetric {
  const sufficient = value !== null && sampleSize >= minimumSamples;
  return {
    key,
    value,
    observedValue: value,
    sampleSize,
    qualifyingSampleCount: sufficient ? sampleSize : 0,
    excludedSampleCount: 0,
    status: value === null || sampleSize < minimumSamples ? 'NO_DATA' : value >= minimum ? 'PASS' : 'BREACH',
    evaluationStatus: value === null || sampleSize < minimumSamples
      ? 'INSUFFICIENT_DATA'
      : value >= minimum ? 'PASS' : 'BREACH',
    measurementState: value === null || sampleSize < minimumSamples ? 'INSUFFICIENT_DATA' : 'MEASURED',
    stateReason: value === null || sampleSize < minimumSamples ? 'METRIC_MINIMUM_SAMPLE_NOT_MET' : 'METRIC_MEASURED',
    reasonCode: value === null || sampleSize < minimumSamples ? 'METRIC_MINIMUM_SAMPLE_NOT_MET' : 'METRIC_MEASURED',
    target,
    threshold: target,
    windowStart: '',
    windowEnd: '',
    measurementSemantics: 'BOUNDED_WINDOW',
    evidenceSufficiency: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    rawNumerator: null,
    rawDenominator: sampleSize,
  };
}

function notApplicableMetric(metric: SloMetric, stateReason: string): SloMetric {
  return {
    ...metric,
    status: 'NOT_APPLICABLE',
    evaluationStatus: 'NOT_APPLICABLE',
    measurementState: 'NOT_APPLICABLE',
    stateReason,
    reasonCode: stateReason,
    qualifyingSampleCount: 0,
    evidenceSufficiency: 'NOT_APPLICABLE',
  };
}

function unavailableMetric(metric: SloMetric, stateReason: string): SloMetric {
  return {
    ...metric,
    status: 'NO_DATA',
    evaluationStatus: 'INSUFFICIENT_DATA',
    measurementState: 'INSUFFICIENT_DATA',
    stateReason,
    reasonCode: stateReason,
    qualifyingSampleCount: 0,
    evidenceSufficiency: 'INSUFFICIENT',
  };
}

function hasUnsafePublicState(product: Product): boolean {
  const price = Number(product.salePrice || product.price || 0);
  const httpUrl = (value?: string) => /^https?:\/\//i.test(String(value || ''));
  const healthy = (value?: string) => ['ok', 'healthy', 'redirect_ok', 'redirected'].includes(String(value || ''));
  return product.recordType !== 'PRODUCT'
    || product.kind !== 'product'
    || product.riskLevel !== 'low'
    || product.verifiedSource !== true && product.sourceVerified !== true
    || !Number.isFinite(price) || price <= 0
    || product.currency !== 'VND'
    || !httpUrl(product.originalUrl) || !httpUrl(product.affiliateUrl) || !httpUrl(product.imageUrl)
    || !healthy(product.linkHealthStatus || product.productHealthStatus)
    || !healthy(product.affiliateHealthStatus)
    || !healthy(product.imageHealthStatus)
    || product.duplicateStatus !== 'CLEAR'
    || product.claimValidationStatus !== 'VERIFIED'
    || Number(product.evidenceCoverage || 0) < 0.8
    || Number(product.confidences?.publish || 0) < 0.85
    || product.autoPublishEligible !== true;
}

function terminalJob(job: AutomationJob): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(job.status);
}

function jobObservationTime(job: AutomationJob): string {
  return job.completedAt || job.updatedAt || job.createdAt;
}

function isZeroTouchEligibleJob(job: AutomationJob): boolean {
  if (!['AUTO_PILOT', 'PROCESS_CANDIDATE', 'AUTO_SAFE_PUBLISH', 'POST_PUBLISH_MONITOR'].includes(job.type)) return false;
  if (
    job.approvalStatus !== 'NOT_REQUIRED'
    || job.manualTaskId
    || job.executionMode === 'MANUAL_INPUT'
    || job.requestedExecutionMode === 'MANUAL_ONLY'
    || job.dryRun
  ) return false;
  const triggerIdentity = [
    job.requestedBy,
    job.sourceMetadata?.producer,
    job.sourceMetadata?.trigger,
  ].filter(Boolean).join(':');
  return !/(?:owner|dashboard|manual|client|user)/i.test(triggerIdentity);
}

function autoPilotChildOutcome(
  job: AutomationJob,
): 'SUCCEEDED' | 'BLOCKED' | 'FAILED' | 'PARTIAL' | null {
  const childSummary = job.result?.childSummary;
  if (!childSummary || typeof childSummary !== 'object') return null;
  const summary = childSummary as {
    total?: unknown;
    byStatus?: Record<string, unknown>;
  };
  if (!summary.byStatus || typeof summary.byStatus !== 'object') return 'PARTIAL';
  const count = (status: string) => Math.max(0, Number(summary.byStatus?.[status]) || 0);
  if (count('FAILED') > 0 || count('CANCELLED') > 0) return 'FAILED';
  if (count('BLOCKED') > 0 || count('WAITING_FOR_MANUAL_INPUT') > 0) return 'BLOCKED';
  const total = Math.max(0, Number(summary.total) || 0);
  const succeeded = count('SUCCEEDED');
  return total > 0 && succeeded === total ? 'SUCCEEDED' : 'PARTIAL';
}

function isSuccessfulZeroTouchOutcome(job: AutomationJob): boolean {
  if (
    job.status !== 'SUCCEEDED'
    || job.outcomeStatus === 'PARTIALLY_COMPLETED'
    || (job.checkpoint?.pendingSteps.length || 0) > 0
    || (job.disclosure?.pendingSteps.length || 0) > 0
  ) return false;
  if (job.type === 'AUTO_SAFE_PUBLISH') {
    return job.result?.published === true
      && job.result?.evidenceVerified === true
      && typeof job.result?.productId === 'string';
  }
  if (job.type === 'POST_PUBLISH_MONITOR') {
    return job.result?.outcome === 'HEALTHY';
  }
  if (job.type === 'PROCESS_CANDIDATE') {
    return job.result?.candidateStatus === 'completed'
      && typeof job.result?.productId === 'string';
  }
  if (job.type === 'AUTO_PILOT') {
    const executionStatus = String(job.result?.executionStatus || '');
    const summary = job.result?.summary;
    const childOutcome = autoPilotChildOutcome(job);
    return ['COMPLETED_WITH_LOCAL_RULES', 'COMPLETED_WITH_LOCAL_TEMPLATE', 'COMPLETED_WITH_API'].includes(executionStatus)
      && summary !== null
      && typeof summary === 'object'
      && Number((summary as { failed?: unknown }).failed) === 0
      && (childOutcome === null || childOutcome === 'SUCCEEDED');
  }
  return false;
}

type ZeroTouchOutcomeClass = 'SUCCEEDED' | 'BLOCKED' | 'FAILED' | 'PARTIAL';

function classifyZeroTouchOutcome(job: AutomationJob): ZeroTouchOutcomeClass {
  const childOutcome = job.type === 'AUTO_PILOT' ? autoPilotChildOutcome(job) : null;
  if (childOutcome === 'FAILED') return 'FAILED';
  if (job.status === 'BLOCKED' || childOutcome === 'BLOCKED') return 'BLOCKED';
  if (
    job.outcomeStatus === 'PARTIALLY_COMPLETED'
    || (job.checkpoint?.pendingSteps.length || 0) > 0
    || (job.disclosure?.pendingSteps.length || 0) > 0
    || childOutcome === 'PARTIAL'
  ) return 'PARTIAL';
  if (
    (job.type === 'AUTO_SAFE_PUBLISH' && job.result?.published === false)
    || (job.type === 'PROCESS_CANDIDATE'
      && ['needs_review', 'discarded'].includes(String(job.result?.candidateStatus || '')))
  ) return 'BLOCKED';
  if (isSuccessfulZeroTouchOutcome(job)) return 'SUCCEEDED';
  return 'FAILED';
}

function countDuplicateKeys(keys: string[]): number {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

interface PersistedTelemetryRead<T> {
  items: T[];
  available: boolean;
  collectionPresent: boolean;
  atCapacity: boolean;
  maximumItems: number;
  reasonCodes: string[];
}

async function readPersistedTelemetry<T>(
  collection: string,
  maximumItems: number,
  maximumBytes: number,
): Promise<PersistedTelemetryRead<T>> {
  try {
    const snapshot = await readBoundedCollectionSnapshot<T>(collection, {
      maximumItems,
      maximumBytes,
    });
    const collectionPresent = snapshot.metadata.collectionPresent;
    return {
      items: snapshot.items,
      available: collectionPresent,
      collectionPresent,
      atCapacity: snapshot.items.length >= maximumItems,
      maximumItems,
      reasonCodes: collectionPresent ? [] : ['TELEMETRY_COLLECTION_MISSING'],
    };
  } catch (error) {
    const code = error instanceof Error && /LIMIT_EXCEEDED/.test(error.message)
      ? 'TELEMETRY_RETENTION_BOUND_EXCEEDED'
      : 'TELEMETRY_COLLECTION_UNAVAILABLE';
    return {
      items: [],
      available: false,
      collectionPresent: false,
      atCapacity: false,
      maximumItems,
      reasonCodes: [code],
    };
  }
}

function retainedWindowComplete<T>(
  read: PersistedTelemetryRead<T>,
  windowStartedAt: number,
  observedAt: (item: T) => unknown,
): boolean {
  if (!read.available) return false;
  if (!read.atCapacity) return true;
  const earliest = read.items
    .map(item => validTimestamp(observedAt(item)))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0];
  return earliest !== undefined && earliest <= windowStartedAt;
}

export async function measureAutomationSlo(options: MeasureAutomationSloOptions = {}): Promise<AutomationSloMeasurement> {
  const now = options.now ?? Date.now();
  const windowMs = Math.max(60_000, options.windowMs ?? DEFAULT_SLO_WINDOW_MS);
  const minimumSamples = Math.max(1, options.minimumSamples ?? DEFAULT_SLO_MINIMUM_SAMPLES);
  const runtimeFreshnessMs = Math.max(30_000, options.runtimeFreshnessMs ?? DEFAULT_RUNTIME_FRESHNESS_MS);
  const startedAt = now - windowMs;
  const releaseIdentity = getReleaseIdentity().releaseId;
  const [jobProjection, attemptsRead, runtimeRead, auditsRead, eventsRead, productsRead] = await Promise.all([
    readBoundedAutomationJobStatuses(),
    readPersistedTelemetry<AutomationJobAttempt>(JOB_ATTEMPT_COLLECTION, 10_000, 16 * 1024 * 1024),
    readPersistedTelemetry<RuntimeHealthSnapshot>(RUNTIME_COLLECTION, 500, 8 * 1024 * 1024),
    readPersistedTelemetry<PublicationAuditRecord>(PUBLICATION_AUDIT_COLLECTION, 1_000, 8 * 1024 * 1024),
    readPersistedTelemetry<OutboundPublicationEvent>(OUTBOUND_COLLECTION, 5_000, 16 * 1024 * 1024),
    readPersistedTelemetry<Product>(PRODUCT_COLLECTION, 5_000, 32 * 1024 * 1024),
  ]);
  const allAttempts = attemptsRead.items;
  const runtimeSnapshots = runtimeRead.items;
  const allAudits = auditsRead.items;
  const allEvents = eventsRead.items;
  const allProducts = productsRead.items;
  const allJobs = jobProjection.items;
  const attemptWindowComplete = retainedWindowComplete(
    attemptsRead,
    startedAt,
    attempt => attempt.claimedAt,
  );
  const runtimeWindowComplete = retainedWindowComplete(
    runtimeRead,
    startedAt,
    snapshot => snapshot.checkedAt,
  );
  const publicationAuditWindowComplete = retainedWindowComplete(
    auditsRead,
    startedAt,
    audit => audit.timestamp,
  );
  const outboundEventWindowComplete = retainedWindowComplete(
    eventsRead,
    startedAt,
    event => event.createdAt,
  );

  const jobs = allJobs.filter(job => inWindow(jobObservationTime(job), startedAt, now) && (validTimestamp(job.scheduledAt) || 0) <= now + 60_000);
  const terminals = jobs.filter(terminalJob);
  const legacyPickupLatencies = jobs.flatMap(job => {
    const created = validTimestamp(job.createdAt);
    const claimed = validTimestamp(job.claimedAt);
    return created !== null && claimed !== null && claimed >= created ? [claimed - created] : [];
  });
  const persistedAttemptKeys = new Set(allAttempts.map(attempt => `${attempt.jobId}:${attempt.attemptNumber}`));
  const attemptPickupObservations = allAttempts.flatMap(attempt => {
    const observation = derivePickupLatencyObservation(attempt, startedAt, now);
    return observation ? [observation] : [];
  });
  const legacyJobPickupObservations = allJobs.flatMap(job => {
    if (persistedAttemptKeys.has(`${job.id}:${job.attemptCount}`)) return [];
    const observation = derivePickupLatencyObservation(job, startedAt, now);
    return observation ? [observation] : [];
  });
  const pickupObservations = [...attemptPickupObservations, ...legacyJobPickupObservations];
  const explicitAttemptRecords = allAttempts.flatMap(attempt => {
    const observation = deriveExplicitPickupLatencyObservation(attempt, startedAt, now);
    return observation ? [{
      observation,
      releaseId: attempt.releaseId || '',
      rolloutCohort: attempt.rolloutCohort || '',
      observedId: attempt.id,
      boundaryAt: attempt.createdAt,
      priorityClass: classifyAutomationPickupPriority(attempt),
    }] : [];
  });
  const explicitJobRecords = allJobs.flatMap(job => {
    if (persistedAttemptKeys.has(`${job.id}:${job.attemptCount}`)) return [];
    const observation = deriveExplicitPickupLatencyObservation(job, startedAt, now);
    return observation ? [{
      observation,
      releaseId: job.releaseId || '',
      rolloutCohort: job.rolloutCohort || '',
      observedId: `${job.id}:attempt:${job.attemptCount}`,
      boundaryAt: job.createdAt,
      priorityClass: classifyAutomationPickupPriority(job),
    }] : [];
  });
  const explicitPickupRecords = [...explicitAttemptRecords, ...explicitJobRecords];
  const runnableAtPickupLatencies = pickupObservations.map(observation => observation.latencyMs);
  const retryPickupLatencies = pickupObservations
    .filter(observation => observation.retryAttempt)
    .map(observation => observation.latencyMs);
  const runnableQueueEntries = allJobs.flatMap(job => {
    if (!['PENDING', 'RETRY_SCHEDULED'].includes(job.status)) return [];
    const runnable = deriveRunnableAt(job);
    if (!runnable || runnable.runnableAt > now) return [];
    return [{
      ageMs: now - runnable.runnableAt,
      neverClaimed: job.attemptCount === 0,
    }];
  });
  const pendingQueueAges = runnableQueueEntries.map(entry => entry.ageMs);
  const neverClaimedPending = runnableQueueEntries.filter(entry => entry.neverClaimed).length;
  const pickupLatencyFeature = getFeatureRolloutState('SLO_RUNNABLE_AT_V2');
  const currentRolloutCohort = `SLO_RUNNABLE_AT_V2:${pickupLatencyFeature.mode}`;
  const currentPickupRecords = explicitPickupRecords.filter(record =>
    record.releaseId === releaseIdentity
    && record.rolloutCohort === currentRolloutCohort);
  const historicalPickupRecords = explicitPickupRecords.filter(record =>
    record.releaseId !== releaseIdentity
    || record.rolloutCohort !== currentRolloutCohort);
  const currentPickupLatencies = currentPickupRecords.map(record => record.observation.latencyMs);
  const pickupLatencyByPriorityClass = pickupPriorityBreakdown(
    currentPickupRecords,
    historicalPickupRecords,
  );
  const pickupExcludedLegacyCount = explicitPickupRecords.length - currentPickupRecords.length;
  const pickupInsufficientTimestampCount = [
    ...allAttempts.filter(attempt =>
      inWindow(attempt.claimedAt, startedAt, now)
      && deriveExplicitPickupLatencyObservation(attempt, startedAt, now) === null),
    ...allJobs.filter(job =>
      !persistedAttemptKeys.has(`${job.id}:${job.attemptCount}`)
      && inWindow(job.claimedAt || job.startedAt, startedAt, now)
      && deriveExplicitPickupLatencyObservation(job, startedAt, now) === null),
  ].length;
  const currentReleaseBoundaryAt = oldestTimestamp([
    ...allAttempts
      .filter(attempt => attempt.releaseId === releaseIdentity)
      .map(attempt => attempt.createdAt),
    ...allJobs
      .filter(job => job.releaseId === releaseIdentity)
      .map(job => job.createdAt),
  ]);
  const currentRolloutBoundaryAt = oldestTimestamp([
    ...allAttempts
      .filter(attempt => attempt.releaseId === releaseIdentity
        && attempt.rolloutCohort === currentRolloutCohort)
      .map(attempt => attempt.createdAt),
    ...allJobs
      .filter(job => job.releaseId === releaseIdentity
        && job.rolloutCohort === currentRolloutCohort)
      .map(job => job.createdAt),
  ]);
  const pickupLatencyMode: AutomationSloMeasurement['pickupLatencyMode'] =
    pickupLatencyFeature.mode === 'ACTIVE' ? 'RUNNABLE_AT' : 'LEGACY_CREATED_AT';
  const pickupLatencies = pickupLatencyMode === 'RUNNABLE_AT'
    ? runnableAtPickupLatencies
    : legacyPickupLatencies;
  const failed = terminals.filter(job => ['FAILED', 'BLOCKED'].includes(job.status));
  const monitorOutcomes = terminals.filter(job => job.type === 'POST_PUBLISH_MONITOR' && ['HEALTHY', 'TEMPORARY_FAILURE', 'CONFIRMED_BROKEN'].includes(String(job.result?.outcome)));
  // Active work is current state, not windowed history. An old still-pending
  // monitor must remain visible to recovery even if it was created before the
  // SLO observation window.
  const pendingMonitorTargets = allJobs.filter(job =>
    job.type === 'POST_PUBLISH_MONITOR' && !terminalJob(job));
  const healthyMonitorOutcomes = monitorOutcomes.filter(job => job.result?.outcome === 'HEALTHY');
  const zeroTouchJobs = terminals.filter(isZeroTouchEligibleJob);
  const zeroTouchOutcomes = new Map(zeroTouchJobs.map(job => [job.id, classifyZeroTouchOutcome(job)]));
  const zeroTouchCompleted = zeroTouchJobs.filter(job => zeroTouchOutcomes.get(job.id) === 'SUCCEEDED');
  const zeroTouchPartial = zeroTouchJobs.filter(job => zeroTouchOutcomes.get(job.id) === 'PARTIAL');
  const zeroTouchBlocked = zeroTouchJobs.filter(job => zeroTouchOutcomes.get(job.id) === 'BLOCKED');
  const zeroTouchFailed = zeroTouchJobs.filter(job => zeroTouchOutcomes.get(job.id) === 'FAILED');
  const storageLockTimeoutCount = terminals.filter(job => /(?:STORAGE_LOCK_TIMEOUT|storage lock timeout)/i.test(`${job.lastErrorCode || ''} ${job.lastErrorMessage || ''}`)).length;

  const audits = allAudits.filter(item => inWindow(item.timestamp, startedAt, now));
  const publicationDecisions = audits.filter(item => ['published', 'rolled_back', 'publish_blocked'].includes(String(item.action)));
  const publicationAttempts = publicationDecisions.filter(item => ['published', 'rolled_back'].includes(String(item.action)));
  const publishBlockedDecisions = publicationDecisions.filter(item => item.action === 'publish_blocked');
  const rollbacks = publicationAttempts.filter(item => item.action === 'rolled_back');
  const publishedAudits = publicationAttempts.filter(item => item.action === 'published');
  const events = allEvents.filter(item => item.eventType === 'PRODUCT_PUBLISHED' && inWindow(item.createdAt, startedAt, now));
  const duplicateEventCount = countDuplicateKeys(events.map(item => String(item.effectKey || '')).filter(Boolean));
  const duplicateAuditCount = countDuplicateKeys(publishedAudits.map(item => `${item.runId || ''}:${item.productId || ''}`).filter(key => key !== ':'));
  const duplicatePublishCount = duplicateEventCount + duplicateAuditCount;
  const recentlyPublishedIds = new Set([
    ...events.map(item => item.productId).filter((item): item is string => typeof item === 'string'),
    ...publishedAudits.map(item => item.productId).filter((item): item is string => typeof item === 'string'),
  ]);
  const publicProducts = allProducts.filter(product => product.status === 'published' && product.publicHidden === false
    && (inWindow(product.publishedAt, startedAt, now) || recentlyPublishedIds.has(product.id)));
  const unsafeProducts = publicProducts.filter(hasUnsafePublicState);

  const runtimeWindow = runtimeSnapshots.filter(snapshot => {
    const checkedAt = validTimestamp(snapshot.checkedAt);
    return checkedAt !== null && checkedAt >= startedAt && checkedAt <= now;
  });
  const latestRuntime = runtimeWindow
    .sort((a, b) => (validTimestamp(b.checkedAt) || 0) - (validTimestamp(a.checkedAt) || 0))[0];
  const latestRuntimeCheckedAt = validTimestamp(latestRuntime?.checkedAt);
  const runtimeAge = latestRuntimeCheckedAt === null ? Number.POSITIVE_INFINITY : now - latestRuntimeCheckedAt;
  const runtimeObserved = Boolean(latestRuntime);
  const workerHeartbeatAt = validTimestamp(latestRuntime?.worker.heartbeatAt);
  const schedulerHeartbeatAt = validTimestamp(latestRuntime?.scheduler.heartbeatAt);
  const workerHeartbeatAge = workerHeartbeatAt === null || workerHeartbeatAt > now
    ? Number.POSITIVE_INFINITY
    : now - workerHeartbeatAt;
  const schedulerHeartbeatAge = schedulerHeartbeatAt === null || schedulerHeartbeatAt > now
    ? Number.POSITIVE_INFINITY
    : now - schedulerHeartbeatAt;
  const workerHeartbeatFresh = !latestRuntime ? null
    : runtimeAge <= runtimeFreshnessMs && workerHeartbeatAge <= runtimeFreshnessMs && latestRuntime.worker.status === 'active';
  const schedulerHeartbeatFresh = !latestRuntime ? null
    : runtimeAge <= runtimeFreshnessMs && schedulerHeartbeatAge <= runtimeFreshnessMs && latestRuntime.scheduler.status === 'active';
  const publicRouteHealthy = latestRuntime?.web.publicRouteHealthy === null || latestRuntime?.web.publicRouteHealthy === undefined
    ? null
    : latestRuntime.web.publicRouteHealthy === true && !['unhealthy', 'build_missing'].includes(latestRuntime.web.status);
  const runtimePublishSafe = latestRuntime ? latestRuntime.publishSafe === true : null;
  const runtimeReasons = latestRuntime ? [...new Set(latestRuntime.reasons || [])].slice(0, 20) : [];

  const pickupLatencyP50Ms = p50(pickupLatencies);
  const pickupLatencyP95Ms = p95(pickupLatencies);
  const pickupLatencyHistoricalP50Ms = p50(legacyPickupLatencies);
  const pickupLatencyHistoricalP95Ms = p95(legacyPickupLatencies);
  const pickupLatencyCurrentP50Ms = p50(currentPickupLatencies);
  const pickupLatencyCurrentP95Ms = p95(currentPickupLatencies);
  const pickupLatencyLegacyP95Ms = p95(legacyPickupLatencies);
  const pickupLatencyRunnableAtP95Ms = p95(runnableAtPickupLatencies);
  const retryPickupLatencyP95Ms = p95(retryPickupLatencies);
  const pendingQueueAgeMs = pendingQueueAges.length ? Math.max(...pendingQueueAges) : null;
  const terminalOutcomeRate = ratio(terminals.length, jobs.length);
  const errorRate = ratio(failed.length, terminals.length);
  const healthPassRate = ratio(healthyMonitorOutcomes.length, monitorOutcomes.length);
  const rollbackRate = ratio(rollbacks.length, publicationAttempts.length);
  const zeroTouchRate = ratio(zeroTouchCompleted.length, zeroTouchJobs.length);
  const pickupCreatedAtAttempts = pickupObservations.filter(item => item.runnableReason === 'CREATED_AT').length;
  const pickupScheduledAttempts = pickupObservations.filter(item => item.runnableReason === 'SCHEDULED_AT').length;
  const pickupRetryAttempts = pickupObservations.filter(item => item.runnableReason === 'RETRY_ELIGIBLE_AT').length;
  const pickupCarriedIntoWindow = pickupObservations.filter(item =>
    item.runnableAt < startedAt && item.claimedAt >= startedAt).length;
  const noLegitimateMonitorTarget = publicProducts.length === 0
    && monitorOutcomes.length === 0
    && pendingMonitorTargets.length === 0;
  const noPublicationActivity = publicationAttempts.length === 0
    && events.length === 0
    && publicProducts.length === 0;
  const currentJobStateAvailable = jobProjection.availability !== 'UNAVAILABLE'
    && jobProjection.currentStateComplete;
  const retentionBoundaryAt = validTimestamp(jobProjection.retentionBoundary?.oldestRetainedAt);
  const jobHistoryWindowComplete = currentJobStateAvailable && (
    jobProjection.historyComplete
    || (jobProjection.truncated
      && retentionBoundaryAt !== null
      && retentionBoundaryAt <= startedAt)
  );
  const jobHistoryAvailable = jobHistoryWindowComplete;
  const pickupEvidenceAvailable = attemptWindowComplete
    && currentPickupRecords.length > 0;
  const verifiedIdleQueue = currentJobStateAvailable
    && pendingQueueAges.length === 0
    && pickupObservations.length === 0;
  const metrics: SloMetric[] = [
    booleanMetric('worker_heartbeat_fresh', workerHeartbeatFresh, 'true within 120 seconds'),
    booleanMetric('scheduler_heartbeat_fresh', schedulerHeartbeatFresh, 'true within 120 seconds'),
    verifiedIdleQueue
      ? notApplicableMetric(
          upperBoundMetric('job_pickup_latency_p95_ms', null, 0, 30_000, '<= 30000 ms'),
          'VERIFIED_IDLE_QUEUE_NO_PICKUP_SAMPLE',
        )
      : pickupEvidenceAvailable
      ? upperBoundMetric(
          'job_pickup_latency_p95_ms',
          pickupLatencyCurrentP95Ms,
          currentPickupLatencies.length,
          30_000,
          '<= 30000 ms',
        )
      : unavailableMetric(
          upperBoundMetric('job_pickup_latency_p95_ms', null, 0, 30_000, '<= 30000 ms'),
          attemptsRead.available ? 'PICKUP_HISTORY_INCOMPLETE' : 'JOB_ATTEMPT_TELEMETRY_UNAVAILABLE',
        ),
    jobHistoryAvailable
      ? lowerBoundMetric('terminal_outcome_rate', terminalOutcomeRate, jobs.length, 0.95, '>= 0.95', minimumSamples)
      : unavailableMetric(
          lowerBoundMetric('terminal_outcome_rate', null, 0, 0.95, '>= 0.95', minimumSamples),
          'JOB_STATUS_PROJECTION_INCOMPLETE',
        ),
    jobHistoryAvailable
      ? upperBoundMetric('terminal_error_rate', errorRate, terminals.length, 0.05, '<= 0.05', minimumSamples)
      : unavailableMetric(
          upperBoundMetric('terminal_error_rate', null, 0, 0.05, '<= 0.05', minimumSamples),
          'JOB_STATUS_PROJECTION_INCOMPLETE',
        ),
    !jobHistoryAvailable || !productsRead.available || productsRead.atCapacity
      ? unavailableMetric(
          lowerBoundMetric('post_publish_health_pass_rate', null, 0, 0.9, '>= 0.90'),
          !jobHistoryAvailable
            ? 'JOB_STATUS_PROJECTION_INCOMPLETE'
            : productsRead.atCapacity
              ? 'PRODUCT_CURRENT_STATE_BOUNDED'
              : 'PRODUCT_TELEMETRY_UNAVAILABLE',
        )
      : noLegitimateMonitorTarget
      ? notApplicableMetric(
          lowerBoundMetric('post_publish_health_pass_rate', null, 0, 0.9, '>= 0.90'),
          'NO_PUBLIC_PRODUCT_OR_LEGITIMATE_MONITOR_TARGET',
        )
      : lowerBoundMetric('post_publish_health_pass_rate', healthPassRate, monitorOutcomes.length, 0.9, '>= 0.90'),
    !publicationAuditWindowComplete || !outboundEventWindowComplete
      ? unavailableMetric(
          upperBoundMetric('duplicate_publish_count', null, 0, 0, '= 0'),
          'PUBLICATION_TELEMETRY_UNAVAILABLE',
        )
      : noPublicationActivity
      ? notApplicableMetric(
          upperBoundMetric('duplicate_publish_count', null, 0, 0, '= 0'),
          'NO_PUBLICATION_ACTIVITY_IN_WINDOW',
        )
      : upperBoundMetric('duplicate_publish_count', duplicatePublishCount, events.length + publishedAudits.length, 0, '= 0'),
    !productsRead.available || productsRead.atCapacity
      ? unavailableMetric(
          upperBoundMetric('unsafe_publish_count', null, 0, 0, '= 0'),
          productsRead.atCapacity ? 'PRODUCT_CURRENT_STATE_BOUNDED' : 'PRODUCT_TELEMETRY_UNAVAILABLE',
        )
      : publicProducts.length === 0
      ? notApplicableMetric(
          upperBoundMetric('unsafe_publish_count', null, 0, 0, '= 0'),
          'NO_PUBLIC_PRODUCTS_IN_WINDOW',
        )
      : upperBoundMetric('unsafe_publish_count', unsafeProducts.length, publicProducts.length, 0, '= 0'),
    jobHistoryAvailable
      ? upperBoundMetric('storage_lock_timeout_count', storageLockTimeoutCount, terminals.length, 0, '= 0')
      : unavailableMetric(
          upperBoundMetric('storage_lock_timeout_count', null, 0, 0, '= 0'),
          'JOB_STATUS_PROJECTION_INCOMPLETE',
        ),
    !publicationAuditWindowComplete
      ? unavailableMetric(
          upperBoundMetric('rollback_rate', null, 0, 0.02, '<= 0.02'),
          'PUBLICATION_AUDIT_UNAVAILABLE',
        )
      : publicationAttempts.length === 0
      ? notApplicableMetric(
          upperBoundMetric('rollback_rate', null, 0, 0.02, '<= 0.02'),
          'NO_PUBLICATION_ATTEMPTS_IN_WINDOW',
        )
      : upperBoundMetric('rollback_rate', rollbackRate, publicationAttempts.length, 0.02, '<= 0.02'),
    jobHistoryAvailable
      ? lowerBoundMetric('zero_touch_completion_rate', zeroTouchRate, zeroTouchJobs.length, 0.9, '>= 0.90', minimumSamples)
      : unavailableMetric(
          lowerBoundMetric('zero_touch_completion_rate', null, 0, 0.9, '>= 0.90', minimumSamples),
          'JOB_STATUS_PROJECTION_INCOMPLETE',
        ),
    booleanMetric('runtime_publish_safe', runtimePublishSafe, 'true'),
    booleanMetric('public_route_healthy', publicRouteHealthy, 'true'),
  ];
  const metricWindowStart = new Date(startedAt).toISOString();
  const metricWindowEnd = new Date(now).toISOString();
  for (const metric of metrics) {
    metric.windowStart = metricWindowStart;
    metric.windowEnd = metricWindowEnd;
    metric.reasonCode = metric.evaluationStatus === 'BREACH'
      ? SLO_REASON_FOR_METRIC[metric.key]
      : metric.evaluationStatus === 'PASS'
        ? 'METRIC_PASS'
        : metric.stateReason;
    if (metric.key === 'job_pickup_latency_p95_ms') {
      metric.qualifyingSampleCount = currentPickupRecords.length;
      metric.excludedSampleCount = pickupExcludedLegacyCount + pickupInsufficientTimestampCount;
      metric.measurementSemantics = 'EXPLICIT_RUNNABLE_AT_CURRENT_RELEASE';
      metric.rawDenominator = currentPickupRecords.length;
    } else if (metric.key === 'zero_touch_completion_rate') {
      metric.measurementSemantics = 'AUTONOMOUS_TERMINAL_OUTCOMES_ONLY';
      metric.rawNumerator = zeroTouchCompleted.length;
      metric.rawDenominator = zeroTouchJobs.length;
      metric.qualifyingSampleCount = zeroTouchJobs.length;
      metric.excludedSampleCount = Math.max(0, terminals.length - zeroTouchJobs.length);
    } else if (['worker_heartbeat_fresh', 'scheduler_heartbeat_fresh'].includes(metric.key)) {
      metric.measurementSemantics = 'CURRENT_ROLE_HEARTBEAT_FRESHNESS';
    } else if ([
      'post_publish_health_pass_rate',
      'duplicate_publish_count',
      'rollback_rate',
      'unsafe_publish_count',
    ].includes(metric.key)) {
      metric.measurementSemantics = 'REAL_PUBLICATION_OR_MONITOR_EVIDENCE';
    }
  }
  const allApplicableMetricsMeasured = metrics.every(metric =>
    metric.measurementState === 'MEASURED' || metric.measurementState === 'NOT_APPLICABLE');
  const measurementComplete = terminals.length >= minimumSamples
    && runtimeObserved
    && publicRouteHealthy !== null
    && allApplicableMetricsMeasured;
  const dataStatus: AutomationSloMeasurement['dataStatus'] = measurementComplete
    ? noLegitimateMonitorTarget ? 'RECOVERY' : 'MEASURED'
    : runtimeObserved || terminals.length > 0 ? 'INSUFFICIENT_DATA' : 'BOOTSTRAP';
  const measuredAt = new Date(now).toISOString();
  const productionReleaseEvidenceRequired = process.env.NODE_ENV === 'production';
  const runtimeReleaseReasons = [
    ...(!latestRuntime?.web.releaseId ? ['RUNTIME_WEB_RELEASE_ID_MISSING'] : []),
    ...(latestRuntime?.web.releaseId && latestRuntime.web.releaseId !== releaseIdentity
      ? ['RUNTIME_WEB_RELEASE_MISMATCH']
      : []),
    ...(!latestRuntime?.worker.releaseId ? ['RUNTIME_WORKER_RELEASE_ID_MISSING'] : []),
    ...(latestRuntime?.worker.releaseId && latestRuntime.worker.releaseId !== releaseIdentity
      ? ['RUNTIME_WORKER_RELEASE_MISMATCH']
      : []),
    ...(!latestRuntime?.scheduler.releaseId ? ['RUNTIME_SCHEDULER_RELEASE_ID_MISSING'] : []),
    ...(latestRuntime?.scheduler.releaseId && latestRuntime.scheduler.releaseId !== releaseIdentity
      ? ['RUNTIME_SCHEDULER_RELEASE_MISMATCH']
      : []),
    ...(productionReleaseEvidenceRequired && latestRuntime?.web.releaseMatchesBuild !== true
      ? ['RUNTIME_BUILD_RELEASE_UNVERIFIED']
      : []),
  ];
  const runtimeReferences = latestRuntime?.id ? [latestRuntime.id] : [];
  const jobObservedAt = latestIsoTimestamp(terminals.map(jobObservationTime));
  const pickupObservedAt = latestIsoTimestamp(
    currentPickupRecords.map(item => new Date(item.observation.claimedAt).toISOString()),
  );
  const publicationObservedAt = latestIsoTimestamp([
    ...audits.map(item => item.timestamp),
    ...events.map(item => item.createdAt),
  ]) || measuredAt;
  const productObservedAt = latestIsoTimestamp(allProducts.map(product => product.updatedAt)) || measuredAt;
  const jobReferences = terminals.slice(-10).map(job => job.id);
  const pickupReferences = currentPickupRecords.slice(-10).map(item => item.observedId);
  const publicationReferences = [
    ...audits.slice(-5).flatMap(item => item.runId || []),
    ...events.slice(-5).flatMap(item => item.effectKey || []),
  ];
  const productReferences = allProducts.slice(-10).map(product => product.id);
  const metricEvidence: SloMetricEvidence[] = metrics.map(metric => {
    if (['worker_heartbeat_fresh', 'scheduler_heartbeat_fresh', 'runtime_publish_safe', 'public_route_healthy'].includes(metric.key)) {
      const observedAt = metric.key === 'worker_heartbeat_fresh'
        ? latestRuntime?.worker.heartbeatAt || null
        : metric.key === 'scheduler_heartbeat_fresh'
          ? latestRuntime?.scheduler.heartbeatAt || null
          : latestRuntime?.checkedAt || null;
      const metricReleaseReasons = metric.key === 'worker_heartbeat_fresh'
        ? runtimeReleaseReasons.filter(reason =>
            reason.startsWith('RUNTIME_WEB_') || reason.startsWith('RUNTIME_WORKER_'))
        : metric.key === 'scheduler_heartbeat_fresh'
          ? runtimeReleaseReasons.filter(reason =>
              reason.startsWith('RUNTIME_WEB_') || reason.startsWith('RUNTIME_SCHEDULER_'))
          : runtimeReleaseReasons;
      const evidenceReleaseIdentity = metric.key === 'worker_heartbeat_fresh'
        ? latestRuntime?.worker.releaseId || ''
        : metric.key === 'scheduler_heartbeat_fresh'
          ? latestRuntime?.scheduler.releaseId || ''
          : latestRuntime?.web.releaseId || '';
      return {
        metricKey: metric.key,
        source: 'runtime-health-current',
        observedAt,
        complete: runtimeRead.available
          && runtimeObserved
          && metricReleaseReasons.length === 0
          && validTimestamp(observedAt) !== null,
        releaseIdentity: evidenceReleaseIdentity,
        reasonCodes: [
          ...metricReleaseReasons,
          ...(!runtimeRead.available ? ['RUNTIME_HEALTH_COLLECTION_UNAVAILABLE'] : []),
          ...(!runtimeObserved ? ['RUNTIME_HEALTH_CURRENT_OBSERVATION_MISSING'] : []),
        ],
        references: runtimeReferences,
      };
    }
    if (metric.key === 'job_pickup_latency_p95_ms') {
      return {
        metricKey: metric.key,
        source: verifiedIdleQueue ? 'current-job-state' : 'job-attempt-history',
        observedAt: verifiedIdleQueue ? latestRuntime?.checkedAt || null : pickupObservedAt,
        complete: verifiedIdleQueue || (pickupEvidenceAvailable && currentPickupRecords.length > 0),
        releaseIdentity,
        reasonCodes: [
          ...(!attemptsRead.available ? ['JOB_ATTEMPT_TELEMETRY_UNAVAILABLE'] : []),
          ...(!verifiedIdleQueue && currentPickupRecords.length === 0
            ? ['CURRENT_RELEASE_PICKUP_OBSERVATION_MISSING']
            : []),
          ...(!attemptWindowComplete ? ['PICKUP_HISTORY_BOUNDED_SAMPLE'] : []),
          ...(verifiedIdleQueue ? ['VERIFIED_IDLE_QUEUE_NO_PICKUP_SAMPLE'] : []),
          ...(pickupExcludedLegacyCount ? ['LEGACY_PICKUP_SAMPLES_EXCLUDED_FROM_RECOVERY'] : []),
          ...(pickupInsufficientTimestampCount ? ['PICKUP_TIMESTAMP_EVIDENCE_INSUFFICIENT'] : []),
        ],
        references: pickupReferences,
      };
    }
    if ([
      'terminal_outcome_rate',
      'terminal_error_rate',
      'storage_lock_timeout_count',
      'zero_touch_completion_rate',
      'post_publish_health_pass_rate',
    ].includes(metric.key)) {
      return {
        metricKey: metric.key,
        source: 'bounded-job-history',
        observedAt: jobObservedAt,
        complete: jobHistoryAvailable && jobObservedAt !== null,
        releaseIdentity: '',
        reasonCodes: [...jobProjection.reasonCodes, 'HISTORICAL_EVIDENCE_RELEASE_UNATTRIBUTED'],
        references: jobReferences,
      };
    }
    if (['duplicate_publish_count', 'rollback_rate'].includes(metric.key)) {
      return {
        metricKey: metric.key,
        source: 'publication-history',
        observedAt: publicationObservedAt,
        complete: publicationAuditWindowComplete && outboundEventWindowComplete,
        releaseIdentity: '',
        reasonCodes: [
          ...(!auditsRead.available ? ['PUBLICATION_AUDIT_UNAVAILABLE'] : []),
          ...(!eventsRead.available ? ['PUBLICATION_EVENT_TELEMETRY_UNAVAILABLE'] : []),
          ...(!publicationAuditWindowComplete ? ['PUBLICATION_AUDIT_WINDOW_INCOMPLETE'] : []),
          ...(!outboundEventWindowComplete ? ['OUTBOUND_EVENT_WINDOW_INCOMPLETE'] : []),
          'HISTORICAL_EVIDENCE_RELEASE_UNATTRIBUTED',
        ],
        references: publicationReferences,
      };
    }
    return {
      metricKey: metric.key,
      source: 'current-products',
      observedAt: productObservedAt,
      complete: productsRead.available && !productsRead.atCapacity,
      // This is a direct bounded read of current state performed by this
      // release, not a historical event being re-attributed to a release.
      releaseIdentity,
      reasonCodes: [
        ...(!productsRead.available ? ['PRODUCT_TELEMETRY_UNAVAILABLE'] : []),
        ...(productsRead.atCapacity ? ['PRODUCT_CURRENT_STATE_BOUNDED'] : []),
      ],
      references: productReferences,
    };
  });
  const evidence = {
    sourceCounts: [
      jobs.length,
      terminals.length,
      pickupObservations.length,
      retryPickupLatencies.length,
      neverClaimedPending,
      monitorOutcomes.length,
      runtimeWindow.length,
      publicationAttempts.length,
      publishBlockedDecisions.length,
      events.length,
      publicProducts.length,
      zeroTouchJobs.length,
      zeroTouchCompleted.length,
      zeroTouchBlocked.length,
      zeroTouchFailed.length,
      zeroTouchPartial.length,
      pickupCreatedAtAttempts,
      pickupScheduledAttempts,
      pickupRetryAttempts,
      pickupCarriedIntoWindow,
      legacyPickupLatencies.length,
      currentPickupRecords.length,
      pickupExcludedLegacyCount,
      pickupInsufficientTimestampCount,
    ],
    sourceAvailability: {
      jobAttempts: attemptsRead.available,
      runtimeSnapshots: runtimeRead.available,
      publicationAudits: auditsRead.available,
      outboundEvents: eventsRead.available,
      products: productsRead.available,
    },
    sourceCompleteness: {
      jobAttemptsWindow: attemptWindowComplete,
      runtimeWindow: runtimeWindowComplete,
      publicationAuditWindow: publicationAuditWindowComplete,
      outboundEventWindow: outboundEventWindowComplete,
      currentProducts: productsRead.available && !productsRead.atCapacity,
    },
    pickupLatency: {
      mode: pickupLatencyMode,
      featureMode: pickupLatencyFeature.mode,
      p50Ms: pickupLatencyP50Ms,
      p95Ms: pickupLatencyP95Ms,
      legacyP95Ms: pickupLatencyLegacyP95Ms,
      runnableAtP95Ms: pickupLatencyRunnableAtP95Ms,
      retryP95Ms: retryPickupLatencyP95Ms,
      pendingQueueAgeMs,
      historicalP50Ms: pickupLatencyHistoricalP50Ms,
      historicalP95Ms: pickupLatencyHistoricalP95Ms,
      historicalSampleCount: legacyPickupLatencies.length,
      currentP50Ms: pickupLatencyCurrentP50Ms,
      currentP95Ms: pickupLatencyCurrentP95Ms,
      currentSampleCount: currentPickupRecords.length,
      excludedLegacyCount: pickupExcludedLegacyCount,
      insufficientTimestampCount: pickupInsufficientTimestampCount,
      byPriorityClass: pickupLatencyByPriorityClass,
      rolloutBoundary: {
        cohort: currentRolloutCohort,
        startedAt: currentRolloutBoundaryAt,
      },
      releaseBoundary: {
        releaseId: releaseIdentity,
        startedAt: currentReleaseBoundaryAt,
      },
    },
    values: metrics.map(metric => [
      metric.key,
      metric.value,
      metric.sampleSize,
      metric.status,
      metric.evaluationStatus,
      metric.measurementState,
      metric.stateReason,
      metric.qualifyingSampleCount,
      metric.excludedSampleCount,
      metric.evidenceSufficiency,
    ]),
    unsafeProductIds: unsafeProducts.map(product => product.id).sort(),
    metricEvidence,
    releaseIdentity,
    windowStartedAt: new Date(startedAt).toISOString(),
    windowEndedAt: measuredAt,
  };
  const evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  return {
    schemaVersion: 3,
    id: `automation-slo:${Math.floor(now / 60_000)}`,
    ruleVersion: SLO_ERROR_BUDGET_RULE_VERSION,
    dataStatus,
    windowStartedAt: new Date(startedAt).toISOString(),
    windowEndedAt: measuredAt,
    minimumSamples,
    sampleSize: terminals.length,
    sourceCounts: {
      jobs: jobs.length,
      terminalJobs: terminals.length,
      pickupAttempts: pickupObservations.length,
      retryPickupAttempts: retryPickupLatencies.length,
      neverClaimedPending,
      monitorOutcomes: monitorOutcomes.length,
      pendingMonitorTargets: pendingMonitorTargets.length,
      runtimeSnapshots: runtimeWindow.length,
      publicationAttempts: publicationAttempts.length,
      publishBlockedDecisions: publishBlockedDecisions.length,
      outboundEvents: events.length,
      publicProducts: publicProducts.length,
      zeroTouchEligible: zeroTouchJobs.length,
      zeroTouchSucceeded: zeroTouchCompleted.length,
      zeroTouchBlocked: zeroTouchBlocked.length,
      zeroTouchFailed: zeroTouchFailed.length,
      zeroTouchPartial: zeroTouchPartial.length,
      pickupCreatedAtAttempts,
      pickupScheduledAttempts,
      pickupRetryAttempts,
      pickupCarriedIntoWindow,
      pickupHistoricalSamples: legacyPickupLatencies.length,
      pickupCurrentSamples: currentPickupRecords.length,
      pickupExcludedLegacySamples: pickupExcludedLegacyCount,
      pickupInsufficientTimestampSamples: pickupInsufficientTimestampCount,
    },
    jobProjection: {
      availability: jobProjection.availability,
      evidenceClassification: jobProjection.evidenceClassification,
      source: jobProjection.source,
      collectionPresent: jobProjection.collectionPresent,
      currentStateComplete: jobProjection.currentStateComplete,
      historyComplete: jobProjection.historyComplete,
      windowComplete: jobHistoryWindowComplete,
      windowStartedAt: new Date(startedAt).toISOString(),
      truncated: jobProjection.truncated,
      coverageComplete: jobProjection.coverageComplete,
      reasonCodes: jobProjection.reasonCodes,
      observedRange: jobProjection.observedRange,
      retentionBoundary: jobProjection.retentionBoundary,
    },
    sourceAvailability: {
      jobAttempts: attemptsRead.available,
      runtimeSnapshots: runtimeRead.available,
      publicationAudits: auditsRead.available,
      outboundEvents: eventsRead.available,
      products: productsRead.available,
    },
    sourceCompleteness: {
      jobAttemptsWindow: attemptWindowComplete,
      runtimeWindow: runtimeWindowComplete,
      publicationAuditWindow: publicationAuditWindowComplete,
      outboundEventWindow: outboundEventWindowComplete,
      currentProducts: productsRead.available && !productsRead.atCapacity,
      reasonCodes: [...new Set([
        ...attemptsRead.reasonCodes,
        ...runtimeRead.reasonCodes,
        ...auditsRead.reasonCodes,
        ...eventsRead.reasonCodes,
        ...productsRead.reasonCodes,
        ...(!attemptWindowComplete ? ['JOB_ATTEMPT_WINDOW_INCOMPLETE'] : []),
        ...(!runtimeWindowComplete ? ['RUNTIME_WINDOW_INCOMPLETE'] : []),
        ...(!publicationAuditWindowComplete ? ['PUBLICATION_AUDIT_WINDOW_INCOMPLETE'] : []),
        ...(!outboundEventWindowComplete ? ['OUTBOUND_EVENT_WINDOW_INCOMPLETE'] : []),
        ...(productsRead.atCapacity ? ['PRODUCT_CURRENT_STATE_BOUNDED'] : []),
      ])],
    },
    workerHeartbeatFresh,
    schedulerHeartbeatFresh,
    pickupLatencyP50Ms,
    pickupLatencyP95Ms,
    pickupLatencyLegacyP95Ms,
    pickupLatencyRunnableAtP95Ms,
    pickupLatencyHistoricalP50Ms,
    pickupLatencyHistoricalP95Ms,
    pickupLatencyHistoricalSampleCount: legacyPickupLatencies.length,
    pickupLatencyCurrentP50Ms,
    pickupLatencyCurrentP95Ms,
    pickupLatencyCurrentSampleCount: currentPickupRecords.length,
    pickupLatencyExcludedLegacyCount: pickupExcludedLegacyCount,
    pickupLatencyInsufficientTimestampCount: pickupInsufficientTimestampCount,
    pickupLatencyByPriorityClass,
    pickupLatencyMeasurementSemantics: {
      historical: 'LEGACY_CREATED_AT',
      current: 'EXPLICIT_RUNNABLE_AT_CURRENT_RELEASE',
    },
    pickupLatencyRolloutBoundary: {
      cohort: currentRolloutCohort,
      startedAt: currentRolloutBoundaryAt,
    },
    pickupLatencyReleaseBoundary: {
      releaseId: releaseIdentity,
      startedAt: currentReleaseBoundaryAt,
    },
    retryPickupLatencyP95Ms,
    pickupLatencyMode,
    pickupLatencyFeatureMode: pickupLatencyFeature.mode,
    pendingQueueAgeMs,
    pendingQueueCount: pendingQueueAges.length,
    terminalOutcomeRate,
    errorRate,
    healthPassRate,
    duplicatePublishCount,
    unsafePublishCount: unsafeProducts.length,
    unsafeProductIds: unsafeProducts.map(product => product.id).sort().slice(0, 100),
    storageLockTimeoutCount,
    rollbackRate,
    zeroTouchRate,
    runtimePublishSafe,
    runtimeReasons,
    publicRouteHealthy,
    metrics,
    metricEvidence,
    releaseIdentity,
    evidenceHash,
    measuredAt,
  };
}

export const SLO_REASON_FOR_METRIC: Record<SloMetric['key'], string> = {
  worker_heartbeat_fresh: 'WORKER_HEARTBEAT_STALE',
  scheduler_heartbeat_fresh: 'SCHEDULER_HEARTBEAT_STALE',
  job_pickup_latency_p95_ms: 'JOB_PICKUP_LATENCY_SLO_FAILED',
  terminal_outcome_rate: 'TERMINAL_OUTCOME_SLO_FAILED',
  terminal_error_rate: 'ERROR_BUDGET_EXCEEDED',
  post_publish_health_pass_rate: 'HEALTH_SLO_FAILED',
  duplicate_publish_count: 'DUPLICATE_PUBLISH',
  unsafe_publish_count: 'UNSAFE_PUBLISH',
  storage_lock_timeout_count: 'STORAGE_LOCK_TIMEOUT',
  rollback_rate: 'ROLLBACK_BUDGET_EXCEEDED',
  zero_touch_completion_rate: 'ZERO_TOUCH_SLO_FAILED',
  runtime_publish_safe: 'RUNTIME_GUARDIAN_UNSAFE',
  public_route_healthy: 'PUBLIC_ROUTE_UNHEALTHY',
};

export function evaluateAutomationErrorBudget(measurement: AutomationSloMeasurement): ErrorBudgetEvaluation {
  const reasons: string[] = [];
  const reasonForMetric = SLO_REASON_FOR_METRIC;
  for (const metric of measurement.metrics) {
    if (metric.status === 'BREACH') reasons.push(reasonForMetric[metric.key] || metric.key.toUpperCase());
  }
  const uniqueReasons = [...new Set(reasons)];
  const severeSet = new Set([
    'WORKER_HEARTBEAT_STALE',
    'SCHEDULER_HEARTBEAT_STALE',
    'DUPLICATE_PUBLISH',
    'UNSAFE_PUBLISH',
    'STORAGE_LOCK_TIMEOUT',
    'ROLLBACK_BUDGET_EXCEEDED',
    'RUNTIME_GUARDIAN_UNSAFE',
    'PUBLIC_ROUTE_UNHEALTHY',
  ]);
  const severeReasons = uniqueReasons.filter(reason => severeSet.has(reason));
  const blockingMetrics = measurement.metrics
    .filter(metric => metric.evaluationStatus === 'BREACH')
    .map(metric => ({
      metricKey: metric.key,
      reasonCode: reasonForMetric[metric.key] || metric.key.toUpperCase(),
      sampleSize: metric.sampleSize,
    }));
  const unavailableMetrics = measurement.metrics
    .filter(metric => metric.evaluationStatus === 'INSUFFICIENT_DATA')
    .map(metric => ({
      metricKey: metric.key,
      reasonCode: metric.stateReason,
      sampleSize: metric.sampleSize,
    }));
  const status: EvaluationStatus = uniqueReasons.length
    ? 'BREACH'
    : ['MEASURED', 'RECOVERY'].includes(measurement.dataStatus) ? 'PASS' : 'INSUFFICIENT_DATA';
  const evaluatedAt = measurement.measuredAt;
  const blockingMetricKeys = new Set(blockingMetrics.map(item => item.metricKey));
  const identityMetricKeys = status === 'BREACH'
    ? blockingMetricKeys
    : new Set(measurement.metrics.map(metric => metric.key));
  const evaluationEvidenceIdentity = {
    measurementMinute: measurement.id,
    status,
    reasons: uniqueReasons,
    metrics: measurement.metrics
      .filter(metric => identityMetricKeys.has(metric.key))
      .map(metric => [
      metric.key,
      metric.value,
      metric.sampleSize,
      metric.evaluationStatus,
      metric.stateReason,
    ]),
    evidence: measurement.metricEvidence
      .filter(item => identityMetricKeys.has(item.metricKey))
      .map(item => [
      item.metricKey,
      item.observedAt,
      item.complete,
      item.releaseIdentity,
      item.references,
    ]),
  };
  const idHash = createHash('sha256')
    .update(JSON.stringify(evaluationEvidenceIdentity))
    .digest('hex')
    .slice(0, 16);
  return {
    schemaVersion: 2,
    id: `error-budget:${Math.floor(Date.parse(evaluatedAt) / 60_000)}:${idHash}`,
    ruleVersion: SLO_ERROR_BUDGET_RULE_VERSION,
    measurementId: measurement.id,
    status,
    dataStatus: measurement.dataStatus,
    sampleSize: measurement.sampleSize,
    reasons: uniqueReasons,
    severeReasons,
    blockingMetrics,
    unavailableMetrics,
    evaluatedAt,
  };
}

async function persistMeasurement(measurement: AutomationSloMeasurement, evaluation: ErrorBudgetEvaluation): Promise<void> {
  await runTransaction<StoredSloSnapshot>(SNAPSHOT_COLLECTION, items => {
    const existing = items.find(item => item.id === measurement.id);
    return [
      ...items.filter(item => item.id !== measurement.id).slice(-499),
      {
        ...measurement,
        evaluation,
        application: existing?.application?.evaluationId === evaluation.id
          ? existing.application
          : undefined,
      },
    ];
  });
}

async function claimControlApplication(measurementId: string, evaluation: ErrorBudgetEvaluation): Promise<boolean> {
  let claimed = false;
  await runTransaction<StoredSloSnapshot>(SNAPSHOT_COLLECTION, items => {
    const record = items.find(item => item.id === measurementId);
    if (!record) return undefined;
    if (record.application?.evaluationId === evaluation.id) {
      claimed = record.application.status === 'CLAIMED';
      return undefined;
    }
    record.application = {
      status: 'CLAIMED',
      evaluationId: evaluation.id,
      claimedAt: evaluation.evaluatedAt,
    };
    claimed = true;
    return items;
  });
  return claimed;
}

async function completeControlApplication(
  measurementId: string,
  evaluationId: string,
  previousEffectiveMode: AutomationControlState['effectiveMode'],
  nextEffectiveMode: AutomationControlState['effectiveMode'],
  publishPaused: boolean,
  appliedAt: string,
): Promise<void> {
  await runTransaction<StoredSloSnapshot>(SNAPSHOT_COLLECTION, items => {
    const record = items.find(item => item.id === measurementId);
    if (!record?.application || record.application.evaluationId !== evaluationId) return undefined;
    record.application = {
      ...record.application,
      status: 'APPLIED',
      previousEffectiveMode,
      nextEffectiveMode,
      publishPaused,
      appliedAt,
    };
    return items;
  });
}

function recoveryEvidenceSummary(
  measurement: AutomationSloMeasurement,
  evaluation: ErrorBudgetEvaluation,
): RuntimeRecoveryEvidenceSummary {
  const noDataReasons = measurement.metrics
    .filter(metric => metric.measurementState !== 'MEASURED' && metric.measurementState !== 'NOT_APPLICABLE')
    .map(metric => metric.stateReason);
  return {
    measurementState: measurement.dataStatus,
    evaluationStatus: evaluation.status,
    evaluatedAt: evaluation.evaluatedAt,
    maximumEvidenceAgeMs: getRuntimeRecoveryPolicy().maximumEvidenceAgeMs,
    reasonCodes: [...new Set([
      ...evaluation.reasons,
      ...noDataReasons,
      ...(measurement.dataStatus === 'RECOVERY' ? ['ZERO_PUBLIC_PRODUCT_RECOVERY_EVIDENCE'] : []),
    ])],
    terminalJobSamples: measurement.sourceCounts.terminalJobs,
    pickupLatencyP95Ms: measurement.pickupLatencyCurrentP95Ms,
    pendingQueueAgeMs: measurement.pendingQueueAgeMs,
    publicationAttempts: measurement.sourceCounts.publicationAttempts,
    monitorOutcomes: measurement.sourceCounts.monitorOutcomes,
    publicProducts: measurement.sourceCounts.publicProducts,
  };
}

const CURRENT_RUNTIME_RECOVERABLE_REASON_CODES = new Set([
  'WORKER_STALE',
  'WORKER_MISSING',
  'WORKER_CRASHED',
  'WORKER_UNVERIFIED',
  'SCHEDULER_STALE',
  'SCHEDULER_MISSING',
  'SCHEDULER_CRASHED',
  'SCHEDULER_UNVERIFIED',
  'WEB_UNHEALTHY',
  'WEB_BUILD_MISSING',
  'WEB_BUILD_MISMATCH',
  'RELEASE_MISMATCH',
  'WORKER_RELEASE_ID_MISSING',
  'SCHEDULER_RELEASE_ID_MISSING',
  'WORKER_RELEASE_MISMATCH',
  'SCHEDULER_RELEASE_MISMATCH',
  'STORAGE_DEGRADED',
  'STORAGE_BLOCKED',
  'JOB_HEALTH_SUMMARY_UNAVAILABLE',
  'JOB_HEALTH_SUMMARY_STALE',
  'JOB_HEALTH_SUMMARY_COVERAGE_BOUNDED',
  'JOB_HEALTH_CURRENT_STATE_INCOMPLETE',
  'STALE_JOB',
  'QUEUE_STUCK',
  'DUPLICATE_PROCESS_ROLE',
  'REPEATED_PROCESS_RESTART',
  'PROVIDER_DEGRADED',
]);

function deriveRuntimeReasonObservations(input: {
  measurement: AutomationSloMeasurement;
  evaluation: ErrorBudgetEvaluation;
  control: AutomationControlState;
  activeReasons: string[];
}): Array<{
  reasonCode: string;
  metricKey: string;
  measurement: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA' | 'NOT_APPLICABLE';
  qualifyingStatus: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA';
  observedAt?: string;
  releaseIdentity?: string;
  qualificationReasons: string[];
  evidenceReferences: string[];
  evidenceRevision: string;
}> {
  const { measurement, control } = input;
  const metricForReason = (reasonCode: string): SloMetric | undefined => {
    const exact = measurement.metrics.find(item => SLO_REASON_FOR_METRIC[item.key] === reasonCode);
    if (exact) return exact;
    if (/^WORKER_(?:STALE|MISSING|CRASHED|UNVERIFIED)$/.test(reasonCode)) {
      return measurement.metrics.find(item => item.key === 'worker_heartbeat_fresh');
    }
    if (/^SCHEDULER_(?:STALE|MISSING|CRASHED|UNVERIFIED)$/.test(reasonCode)) {
      return measurement.metrics.find(item => item.key === 'scheduler_heartbeat_fresh');
    }
    return undefined;
  };

  return input.activeReasons.map(reasonCode => {
    const metric = metricForReason(reasonCode);
    const directEvidence = metric
      ? measurement.metricEvidence.find(item => item.metricKey === metric.key)
      : undefined;
    const runtimeSafeMetric = measurement.metrics.find(item => item.key === 'runtime_publish_safe');
    const runtimeSafeEvidence = measurement.metricEvidence.find(item =>
      item.metricKey === 'runtime_publish_safe');
    const evidence = directEvidence || runtimeSafeEvidence;
    const evidenceReleaseCompatible = evidence?.releaseIdentity === measurement.releaseIdentity;
    const metricPass = metric?.evaluationStatus === 'PASS'
      && directEvidence?.complete === true
      && directEvidence.releaseIdentity === measurement.releaseIdentity;
    const currentRuntimeReasonRecovery = !metric
      && CURRENT_RUNTIME_RECOVERABLE_REASON_CODES.has(reasonCode)
      && !measurement.runtimeReasons.includes(reasonCode)
      && runtimeSafeMetric?.evaluationStatus === 'PASS'
      && runtimeSafeEvidence?.complete === true
      && runtimeSafeEvidence.releaseIdentity === measurement.releaseIdentity;
    const reasonEvidencePass = metricPass || currentRuntimeReasonRecovery;
    const explicitBreach = metric?.evaluationStatus === 'BREACH'
      || measurement.runtimeReasons.includes(reasonCode);
    const observedAt = evidence?.observedAt || undefined;
    const evidenceReferences = [...new Set([
      measurement.id,
      measurement.evidenceHash,
      ...(evidence?.references || []),
    ])].slice(0, 20);
    const evidenceRevision = createHash('sha256').update(JSON.stringify({
      reasonCode,
      metricKey: metric?.key || reasonCode,
      metricValue: metric?.value ?? null,
      metricSamples: metric?.sampleSize ?? 0,
      metricStatus: metric?.evaluationStatus || 'INSUFFICIENT_DATA',
      observedAt,
      releaseIdentity: evidence?.releaseIdentity || '',
      references: evidence?.references || [],
      currentRuntimeReasonRecovery,
    })).digest('hex');
    const qualificationReasons = [
      ...(!reasonEvidencePass ? ['RUNTIME_RECOVERY_REASON_EVIDENCE_NOT_PASS'] : []),
      ...(!evidence?.complete ? ['RUNTIME_RECOVERY_REASON_EVIDENCE_INCOMPLETE'] : []),
      ...(!evidenceReleaseCompatible
        ? ['RUNTIME_RECOVERY_EVIDENCE_RELEASE_UNATTRIBUTED_OR_MISMATCHED']
        : []),
      ...(metric?.evaluationStatus === 'INSUFFICIENT_DATA'
        ? ['RUNTIME_RECOVERY_METRIC_INSUFFICIENT_DATA']
        : []),
      ...(metric?.evaluationStatus === 'NOT_APPLICABLE'
        ? ['RUNTIME_RECOVERY_METRIC_NOT_APPLICABLE']
        : []),
      ...(currentRuntimeReasonRecovery ? ['CURRENT_RUNTIME_REASON_ABSENT'] : []),
      ...(currentRuntimeReasonRecovery ? ['DEDICATED_CURRENT_RECOVERY_PROOF'] : []),
      ...(evidence?.reasonCodes || []),
      ...(control.publishBlockedByPolicy ? ['POLICY_BLOCK_PRESERVED_SEPARATELY'] : []),
      ...(control.publishPausedByOperator ? ['OPERATOR_PAUSE_PRESERVED_SEPARATELY'] : []),
    ];
    const qualifyingPass = !explicitBreach
      && reasonEvidencePass
      && evidence?.complete === true
      && evidenceReleaseCompatible;
    return {
      reasonCode,
      metricKey: metric?.key || reasonCode,
      measurement: explicitBreach
        ? 'BREACH'
        : qualifyingPass
          ? 'PASS'
          : metric?.evaluationStatus || 'INSUFFICIENT_DATA',
      qualifyingStatus: explicitBreach
        ? 'BREACH'
        : qualifyingPass ? 'PASS' : 'INSUFFICIENT_DATA',
      observedAt,
      releaseIdentity: measurement.releaseIdentity,
      qualificationReasons,
      evidenceReferences,
      evidenceRevision,
    };
  });
}

async function appendRecoveryTransitionAudit(input: {
  evaluationId: string;
  operationType: 'RUNTIME_BLOCK_APPLIED' | 'RUNTIME_HEALTHY_STREAK_ADVANCED' | 'RUNTIME_REASON_CLEARED' | 'RUNTIME_CLEAR_REJECTED_INSUFFICIENT_DATA';
  reasonCode: string;
  actor: string;
  result: Record<string, unknown>;
}): Promise<void> {
  await appendAutomationAuditOnce({
    correlationId: input.evaluationId,
    operationId: `${input.evaluationId}:${input.operationType}:${input.reasonCode}`,
    operationType: input.operationType,
    actor: input.actor,
    target: input.reasonCode,
    risk: 'HIGH',
    result: input.result,
    reasons: [input.reasonCode],
    dryRun: false,
    attempts: 1,
  });
}

export async function applyAutomationErrorBudget(options: MeasureAutomationSloOptions & { actor?: string } = {}): Promise<AppliedErrorBudget> {
  const now = options.now ?? Date.now();
  const measurement = await measureAutomationSlo(options);
  const evaluation = evaluateAutomationErrorBudget(measurement);
  const recoveryFeature = getFeatureRolloutState('RUNTIME_RECOVERY_V2');
  await persistMeasurement(measurement, evaluation);
  let previous = await getAutomationControl();
  let control = previous;
  let canary = await getCanaryState();
  let publishPausedByBudget = false;
  let applied = false;
  const actor = options.actor || 'error-budget-controller';
  // Repair a durable audit intent left by an interrupted previous invocation
  // before applying or clearing any additional runtime-control state.
  await flushRuntimeControlApplicationAudits();

  if (evaluation.status === 'BREACH') {
    const claimed = await claimControlApplication(measurement.id, evaluation);
    if (claimed) {
      publishPausedByBudget = true;
      const blockResult = await applyRuntimePublishBlock({
        reasonCodes: evaluation.reasons,
        evaluationId: evaluation.id,
        evaluatedAt: evaluation.evaluatedAt,
        degradeMode: true,
      }, actor);
      previous = {
        ...blockResult.control,
        effectiveMode: blockResult.previousEffectiveMode,
      };
      control = blockResult.control;
      canary = await applyCanarySafetyDecision({
        pause: true,
        reasons: evaluation.reasons,
        evaluatedAt: evaluation.evaluatedAt,
        evaluationId: evaluation.id,
      });
      applied = blockResult.status === 'APPLIED';
      for (const reasonCode of blockResult.addedReasons) {
        await appendRecoveryTransitionAudit({
          evaluationId: evaluation.id,
          operationType: 'RUNTIME_BLOCK_APPLIED',
          reasonCode,
          actor,
          result: { publicationOccurred: false, runtimeBlockActive: true },
        });
      }
      await flushRuntimeControlApplicationAudits();
      await completeControlApplication(
        measurement.id,
        evaluation.id,
        blockResult.previousEffectiveMode,
        blockResult.nextEffectiveMode,
        control.publishPaused,
        evaluation.evaluatedAt,
      );
    } else {
      control = await getAutomationControl();
      canary = await getCanaryState();
    }
  } else if (evaluation.status === 'PASS') {
    const canaryEvidenceComplete = measurement.metrics
      .filter(metric => metric.evaluationStatus !== 'NOT_APPLICABLE')
      .every(metric => {
        const evidence = measurement.metricEvidence.find(item => item.metricKey === metric.key);
        return evidence?.complete === true
          && evidence.releaseIdentity === measurement.releaseIdentity;
      });
    canary = await advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: evaluation.id,
      status: evaluation.status,
      dataStatus: evaluation.dataStatus,
      sampleSize: evaluation.sampleSize,
      evaluatedAt: evaluation.evaluatedAt,
      evidenceComplete: canaryEvidenceComplete,
      releaseIdentity: measurement.releaseIdentity,
      requiredReleaseIdentity: getReleaseIdentity().releaseId,
    });
  }

  control = await getAutomationControl();
  const activeRuntimeReasons = [...new Set([
    ...(control.publishBlockedByRuntime ? control.publishRuntimeReasons || [] : []),
    ...evaluation.reasons,
    ...(control.publishBlockedByRuntime && !(control.publishRuntimeReasons || []).length
      ? ['RUNTIME_BLOCK_REASON_UNATTRIBUTED']
      : []),
  ])];
  const observations = deriveRuntimeReasonObservations({
    measurement,
    evaluation,
    control,
    activeReasons: activeRuntimeReasons,
  });
  const recoveryTransition = await advanceRuntimeReasonRecoveryState({
    evaluationId: evaluation.id,
    observations,
    activeReasons: activeRuntimeReasons,
    evidenceSummary: recoveryEvidenceSummary(measurement, evaluation),
    featureMode: recoveryFeature.mode,
    requiredReleaseIdentity: measurement.releaseIdentity,
    nowMs: now,
  });
  let recovery = recoveryTransition.state;
  for (const reasonCode of recoveryTransition.advancedReasons) {
    const progress = recovery.reasonProgress.find(item => item.reasonCode === reasonCode);
    const observation = observations.find(item => item.reasonCode === reasonCode);
    await appendRecoveryTransitionAudit({
      evaluationId: evaluation.id,
      operationType: 'RUNTIME_HEALTHY_STREAK_ADVANCED',
      reasonCode,
      actor,
      result: {
        consecutiveHealthyCount: progress?.consecutiveHealthyCount || recovery.requiredHealthyCount,
        requiredHealthyCount: recovery.requiredHealthyCount,
        observedAt: observation?.observedAt,
        releaseIdentity: observation?.releaseIdentity,
        evidenceReferences: observation?.evidenceReferences || [],
        qualificationReasons: observation?.qualificationReasons || [],
      },
    });
  }
  for (const reasonCode of recoveryTransition.insufficientReasons) {
    const observation = observations.find(item => item.reasonCode === reasonCode);
    await appendRecoveryTransitionAudit({
      evaluationId: evaluation.id,
      operationType: 'RUNTIME_CLEAR_REJECTED_INSUFFICIENT_DATA',
      reasonCode,
      actor,
      result: {
        runtimeBlockActive: true,
        evidenceStatus: 'INSUFFICIENT_DATA',
        observedAt: observation?.observedAt,
        releaseIdentity: observation?.releaseIdentity,
        evidenceReferences: observation?.evidenceReferences || [],
        qualificationReasons: observation?.qualificationReasons || [],
      },
    });
  }

  if (recoveryTransition.clearedReasons.length > 0) {
    const clearResult = await clearRuntimePublishReasons({
      reasonCodes: recoveryTransition.clearedReasons,
      expectedChangedAt: control.changedAt,
      expectedRuntimeReasons: control.publishRuntimeReasons || [],
      reason: recovery.currentApplicableReasons.length
        ? 'RUNTIME_RECOVERY_REASONS_PARTIALLY_CLEARED'
        : 'RUNTIME_RECOVERY_REQUIRED_EVIDENCE_CONFIRMED',
      evaluationId: evaluation.id,
    }, actor);
    control = clearResult.control;
    if (
      clearResult.status !== 'CLEARED'
      || clearResult.clearedReasons.length !== recoveryTransition.clearedReasons.length
    ) {
      const currentReasons = control.publishBlockedByRuntime
        ? control.publishRuntimeReasons || ['RUNTIME_BLOCK_REASON_UNATTRIBUTED']
        : [];
      const conflictEvaluationId = `${evaluation.id}:control-conflict`;
      const conflictTransition = await advanceRuntimeReasonRecoveryState({
        evaluationId: conflictEvaluationId,
        observations: currentReasons.map(reasonCode => ({
          reasonCode,
          metricKey: reasonCode,
          measurement: 'INSUFFICIENT_DATA',
          qualifyingStatus: 'INSUFFICIENT_DATA',
          observedAt: measurement.measuredAt,
          releaseIdentity: measurement.releaseIdentity,
          qualificationReasons: ['RUNTIME_RECOVERY_CONTROL_STATE_CONFLICT'],
          evidenceReferences: [measurement.id, measurement.evidenceHash],
        })),
        activeReasons: currentReasons,
        evidenceSummary: recoveryEvidenceSummary(measurement, {
          ...evaluation,
          status: 'INSUFFICIENT_DATA',
        }),
        featureMode: recoveryFeature.mode,
        requiredReleaseIdentity: measurement.releaseIdentity,
        nowMs: now,
      });
      recovery = conflictTransition.state;
      await appendRecoveryTransitionAudit({
        evaluationId: evaluation.id,
        operationType: 'RUNTIME_CLEAR_REJECTED_INSUFFICIENT_DATA',
        reasonCode: 'RUNTIME_RECOVERY_CONTROL_STATE_CONFLICT',
        actor,
        result: {
          publicationOccurred: false,
          runtimeBlockActive: control.publishBlockedByRuntime === true,
          controlClearStatus: clearResult.status,
        },
      });
    } else {
      const remainingReasons = control.publishRuntimeReasons || [];
      for (const reasonCode of clearResult.clearedReasons) {
        const observation = observations.find(item => item.reasonCode === reasonCode);
        await appendRecoveryTransitionAudit({
          evaluationId: evaluation.id,
          operationType: 'RUNTIME_REASON_CLEARED',
          reasonCode,
          actor,
          result: {
            publicationOccurred: false,
            remainingRuntimeReasons: remainingReasons,
            policyBlockPreserved: control.publishBlockedByPolicy === true,
            operatorPausePreserved: control.publishPausedByOperator === true,
            observedAt: observation?.observedAt,
            releaseIdentity: observation?.releaseIdentity,
            evidenceReferences: observation?.evidenceReferences || [],
          },
        });
      }
      if (remainingReasons.length === 0) {
        recovery = await confirmRuntimeRecoveryClosed({
          expectedStateVersion: recovery.stateVersion,
          nowMs: now,
          evidenceSummary: recovery.evidenceSummary,
        });
      }
      applied = true;
    }
  }
  publishPausedByBudget = control.publishBlockedByRuntime === true;

  return {
    measurement,
    evaluation,
    applied,
    previousEffectiveMode: previous.effectiveMode,
    control,
    canary,
    recovery,
    recoveryFeatureMode: recoveryFeature.mode,
    publishPausedByBudget,
    ingestionAvailable: !control.ingestionPaused,
  };
}

export async function getLatestSloMeasurement(): Promise<(AutomationSloMeasurement & { evaluation?: ErrorBudgetEvaluation; application?: ErrorBudgetControlApplication }) | null> {
  const items = await readCollection<AutomationSloMeasurement & { evaluation?: ErrorBudgetEvaluation; application?: ErrorBudgetControlApplication }>(SNAPSHOT_COLLECTION);
  return items.sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))[0] || null;
}
