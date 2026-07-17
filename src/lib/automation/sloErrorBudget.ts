import { createHash } from 'node:crypto';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { Product } from '@/lib/types';
import {
  advanceCanaryWaveAfterHealthyEvaluation,
  applyCanarySafetyDecision,
  getCanaryState,
  type CanaryState,
} from './canaryController';
import type { RuntimeHealthSnapshot } from './runtimeGuardian';
import { getAutomationControl, updateAutomationControl } from './store';
import type { AutomationControlState, AutomationJob } from './types';

const SNAPSHOT_COLLECTION = 'automation-slo-snapshots';
const JOB_COLLECTION = 'automation-jobs';
const RUNTIME_COLLECTION = 'runtime-health';
const PUBLICATION_AUDIT_COLLECTION = 'publication-audit';
const OUTBOUND_COLLECTION = 'automation-outbound-events';
const PRODUCT_COLLECTION = 'products';

export const SLO_ERROR_BUDGET_RULE_VERSION = 'automation-slo-error-budget-v1';
export const DEFAULT_SLO_WINDOW_MS = 24 * 60 * 60_000;
export const DEFAULT_SLO_MINIMUM_SAMPLES = 5;
export const DEFAULT_RUNTIME_FRESHNESS_MS = 2 * 60_000;

type MetricStatus = 'PASS' | 'BREACH' | 'NO_DATA';
type EvaluationStatus = 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA';

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
  sampleSize: number;
  status: MetricStatus;
  target: string;
}

export interface AutomationSloMeasurement {
  schemaVersion: number;
  id: string;
  ruleVersion: string;
  dataStatus: 'MEASURED' | 'INSUFFICIENT_DATA';
  windowStartedAt: string;
  windowEndedAt: string;
  minimumSamples: number;
  sampleSize: number;
  sourceCounts: {
    jobs: number;
    terminalJobs: number;
    monitorOutcomes: number;
    runtimeSnapshots: number;
    publicationAttempts: number;
    outboundEvents: number;
    publicProducts: number;
  };
  workerHeartbeatFresh: boolean | null;
  schedulerHeartbeatFresh: boolean | null;
  pickupLatencyP95Ms: number | null;
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
  evidenceHash: string;
  measuredAt: string;
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
  evaluatedAt: string;
}

export interface AppliedErrorBudget {
  measurement: AutomationSloMeasurement;
  evaluation: ErrorBudgetEvaluation;
  applied: boolean;
  previousEffectiveMode: AutomationControlState['effectiveMode'];
  control: AutomationControlState;
  canary: CanaryState;
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

function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function booleanMetric(key: SloMetric['key'], value: boolean | null, target: string): SloMetric {
  return { key, value, sampleSize: value === null ? 0 : 1, status: value === null ? 'NO_DATA' : value ? 'PASS' : 'BREACH', target };
}

function upperBoundMetric(key: SloMetric['key'], value: number | null, sampleSize: number, maximum: number, target: string, minimumSamples = 1): SloMetric {
  return {
    key,
    value,
    sampleSize,
    status: value === null || sampleSize < minimumSamples ? 'NO_DATA' : value <= maximum ? 'PASS' : 'BREACH',
    target,
  };
}

function lowerBoundMetric(key: SloMetric['key'], value: number | null, sampleSize: number, minimum: number, target: string, minimumSamples = 1): SloMetric {
  return {
    key,
    value,
    sampleSize,
    status: value === null || sampleSize < minimumSamples ? 'NO_DATA' : value >= minimum ? 'PASS' : 'BREACH',
    target,
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

function isZeroTouchJob(job: AutomationJob): boolean {
  if (!['AUTO_PILOT', 'PROCESS_CANDIDATE', 'AUTO_SAFE_PUBLISH', 'POST_PUBLISH_MONITOR', 'RECONCILE_AUTOMATION'].includes(job.type)) return false;
  if (job.approvalStatus !== 'NOT_REQUIRED' || job.manualTaskId || job.executionMode === 'MANUAL_INPUT') return false;
  return !/(?:owner|dashboard|manual|client|user)/i.test(job.requestedBy);
}

function countDuplicateKeys(keys: string[]): number {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

async function readPersistedTelemetry<T>(collection: string): Promise<T[]> {
  try { return await readCollection<T>(collection); }
  catch { return []; }
}

export async function measureAutomationSlo(options: MeasureAutomationSloOptions = {}): Promise<AutomationSloMeasurement> {
  const now = options.now ?? Date.now();
  const windowMs = Math.max(60_000, options.windowMs ?? DEFAULT_SLO_WINDOW_MS);
  const minimumSamples = Math.max(1, options.minimumSamples ?? DEFAULT_SLO_MINIMUM_SAMPLES);
  const runtimeFreshnessMs = Math.max(30_000, options.runtimeFreshnessMs ?? DEFAULT_RUNTIME_FRESHNESS_MS);
  const startedAt = now - windowMs;
  const [allJobs, runtimeSnapshots, allAudits, allEvents, allProducts] = await Promise.all([
    readPersistedTelemetry<AutomationJob>(JOB_COLLECTION),
    readPersistedTelemetry<RuntimeHealthSnapshot>(RUNTIME_COLLECTION),
    readPersistedTelemetry<PublicationAuditRecord>(PUBLICATION_AUDIT_COLLECTION),
    readPersistedTelemetry<OutboundPublicationEvent>(OUTBOUND_COLLECTION),
    readPersistedTelemetry<Product>(PRODUCT_COLLECTION),
  ]);

  const jobs = allJobs.filter(job => inWindow(jobObservationTime(job), startedAt, now) && (validTimestamp(job.scheduledAt) || 0) <= now + 60_000);
  const terminals = jobs.filter(terminalJob);
  const pickupLatencies = jobs.flatMap(job => {
    const created = validTimestamp(job.createdAt);
    const claimed = validTimestamp(job.claimedAt);
    return created !== null && claimed !== null && claimed >= created ? [claimed - created] : [];
  });
  const failed = terminals.filter(job => ['FAILED', 'BLOCKED'].includes(job.status));
  const monitorOutcomes = terminals.filter(job => job.type === 'POST_PUBLISH_MONITOR' && ['HEALTHY', 'TEMPORARY_FAILURE', 'CONFIRMED_BROKEN'].includes(String(job.result?.outcome)));
  const healthyMonitorOutcomes = monitorOutcomes.filter(job => job.result?.outcome === 'HEALTHY');
  const zeroTouchJobs = terminals.filter(isZeroTouchJob);
  const zeroTouchCompleted = zeroTouchJobs.filter(job => job.status === 'SUCCEEDED');
  const storageLockTimeoutCount = terminals.filter(job => /(?:STORAGE_LOCK_TIMEOUT|storage lock timeout)/i.test(`${job.lastErrorCode || ''} ${job.lastErrorMessage || ''}`)).length;

  const audits = allAudits.filter(item => inWindow(item.timestamp, startedAt, now));
  const publicationAttempts = audits.filter(item => ['published', 'rolled_back', 'publish_blocked'].includes(String(item.action)));
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

  const runtimeWindow = runtimeSnapshots.filter(snapshot => inWindow(snapshot.checkedAt, startedAt, now));
  const latestRuntime = runtimeWindow
    .sort((a, b) => (validTimestamp(b.checkedAt) || 0) - (validTimestamp(a.checkedAt) || 0))[0];
  const runtimeAge = latestRuntime ? now - (validTimestamp(latestRuntime.checkedAt) || 0) : Number.POSITIVE_INFINITY;
  const runtimeObserved = Boolean(latestRuntime);
  const workerHeartbeatAge = latestRuntime?.worker.heartbeatAt ? now - (validTimestamp(latestRuntime.worker.heartbeatAt) || 0) : Number.POSITIVE_INFINITY;
  const schedulerHeartbeatAge = latestRuntime?.scheduler.heartbeatAt ? now - (validTimestamp(latestRuntime.scheduler.heartbeatAt) || 0) : Number.POSITIVE_INFINITY;
  const workerHeartbeatFresh = !latestRuntime ? null
    : runtimeAge <= runtimeFreshnessMs && workerHeartbeatAge <= runtimeFreshnessMs && latestRuntime.worker.status === 'active';
  const schedulerHeartbeatFresh = !latestRuntime ? null
    : runtimeAge <= runtimeFreshnessMs && schedulerHeartbeatAge <= runtimeFreshnessMs && latestRuntime.scheduler.status === 'active';
  const publicRouteHealthy = latestRuntime?.web.publicRouteHealthy === null || latestRuntime?.web.publicRouteHealthy === undefined
    ? null
    : latestRuntime.web.publicRouteHealthy === true && !['unhealthy', 'build_missing'].includes(latestRuntime.web.status);
  const runtimePublishSafe = latestRuntime ? latestRuntime.publishSafe === true : null;
  const runtimeReasons = latestRuntime ? [...new Set(latestRuntime.reasons || [])].slice(0, 20) : [];

  const pickupLatencyP95Ms = p95(pickupLatencies);
  const terminalOutcomeRate = ratio(terminals.length, jobs.length);
  const errorRate = ratio(failed.length, terminals.length);
  const healthPassRate = ratio(healthyMonitorOutcomes.length, monitorOutcomes.length);
  const rollbackRate = ratio(rollbacks.length, publicationAttempts.length);
  const zeroTouchRate = ratio(zeroTouchCompleted.length, zeroTouchJobs.length);
  const metrics: SloMetric[] = [
    booleanMetric('worker_heartbeat_fresh', workerHeartbeatFresh, 'true within 120 seconds'),
    booleanMetric('scheduler_heartbeat_fresh', schedulerHeartbeatFresh, 'true within 120 seconds'),
    upperBoundMetric('job_pickup_latency_p95_ms', pickupLatencyP95Ms, pickupLatencies.length, 30_000, '<= 30000 ms'),
    lowerBoundMetric('terminal_outcome_rate', terminalOutcomeRate, jobs.length, 0.95, '>= 0.95', minimumSamples),
    upperBoundMetric('terminal_error_rate', errorRate, terminals.length, 0.05, '<= 0.05', minimumSamples),
    lowerBoundMetric('post_publish_health_pass_rate', healthPassRate, monitorOutcomes.length, 0.9, '>= 0.90'),
    upperBoundMetric('duplicate_publish_count', duplicatePublishCount, events.length + publishedAudits.length, 0, '= 0'),
    upperBoundMetric('unsafe_publish_count', unsafeProducts.length, publicProducts.length, 0, '= 0'),
    upperBoundMetric('storage_lock_timeout_count', storageLockTimeoutCount, terminals.length, 0, '= 0'),
    upperBoundMetric('rollback_rate', rollbackRate, publicationAttempts.length, 0.02, '<= 0.02'),
    lowerBoundMetric('zero_touch_completion_rate', zeroTouchRate, zeroTouchJobs.length, 0.9, '>= 0.90', minimumSamples),
    booleanMetric('runtime_publish_safe', runtimePublishSafe, 'true'),
    booleanMetric('public_route_healthy', publicRouteHealthy, 'true'),
  ];
  const dataStatus: AutomationSloMeasurement['dataStatus'] = terminals.length >= minimumSamples
    && runtimeObserved
    && publicRouteHealthy !== null
    && publicationAttempts.length > 0
    && monitorOutcomes.length > 0
      ? 'MEASURED'
      : 'INSUFFICIENT_DATA';
  const measuredAt = new Date(now).toISOString();
  const evidence = {
    sourceCounts: [jobs.length, terminals.length, monitorOutcomes.length, runtimeWindow.length, publicationAttempts.length, events.length, publicProducts.length],
    values: metrics.map(metric => [metric.key, metric.value, metric.sampleSize, metric.status]),
    unsafeProductIds: unsafeProducts.map(product => product.id).sort(),
    windowStartedAt: new Date(startedAt).toISOString(),
    windowEndedAt: measuredAt,
  };
  const evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  return {
    schemaVersion: 1,
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
      monitorOutcomes: monitorOutcomes.length,
      runtimeSnapshots: runtimeWindow.length,
      publicationAttempts: publicationAttempts.length,
      outboundEvents: events.length,
      publicProducts: publicProducts.length,
    },
    workerHeartbeatFresh,
    schedulerHeartbeatFresh,
    pickupLatencyP95Ms,
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
    evidenceHash,
    measuredAt,
  };
}

export function evaluateAutomationErrorBudget(measurement: AutomationSloMeasurement): ErrorBudgetEvaluation {
  const reasons: string[] = [];
  const reasonForMetric: Partial<Record<SloMetric['key'], string>> = {
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
  const status: EvaluationStatus = uniqueReasons.length
    ? 'BREACH'
    : measurement.dataStatus === 'MEASURED' ? 'PASS' : 'INSUFFICIENT_DATA';
  const evaluatedAt = measurement.measuredAt;
  const idHash = createHash('sha256').update(JSON.stringify({ measurementId: measurement.id, status, reasons: uniqueReasons })).digest('hex').slice(0, 12);
  return {
    schemaVersion: 1,
    id: `error-budget:${Math.floor(Date.parse(evaluatedAt) / 60_000)}:${idHash}`,
    ruleVersion: SLO_ERROR_BUDGET_RULE_VERSION,
    measurementId: measurement.id,
    status,
    dataStatus: measurement.dataStatus,
    sampleSize: measurement.sampleSize,
    reasons: uniqueReasons,
    severeReasons,
    evaluatedAt,
  };
}

async function persistMeasurement(measurement: AutomationSloMeasurement, evaluation: ErrorBudgetEvaluation): Promise<void> {
  await runTransaction<StoredSloSnapshot>(SNAPSHOT_COLLECTION, items => {
    const existing = items.find(item => item.id === measurement.id);
    return [
      ...items.filter(item => item.id !== measurement.id).slice(-499),
      { ...measurement, evaluation, application: existing?.application },
    ];
  });
}

async function claimControlApplication(measurementId: string, evaluation: ErrorBudgetEvaluation): Promise<boolean> {
  let claimed = false;
  await runTransaction<StoredSloSnapshot>(SNAPSHOT_COLLECTION, items => {
    const record = items.find(item => item.id === measurementId);
    if (!record || record.application) return undefined;
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
  previousEffectiveMode: AutomationControlState['effectiveMode'],
  nextEffectiveMode: AutomationControlState['effectiveMode'],
  publishPaused: boolean,
  appliedAt: string,
): Promise<void> {
  await runTransaction<StoredSloSnapshot>(SNAPSHOT_COLLECTION, items => {
    const record = items.find(item => item.id === measurementId);
    if (!record?.application) return undefined;
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

function degradedMode(mode: AutomationControlState['effectiveMode']): AutomationControlState['effectiveMode'] {
  if (mode === 'AUTONOMOUS') return 'CANARY';
  if (mode === 'CANARY') return 'SHADOW';
  return mode;
}

export async function applyAutomationErrorBudget(options: MeasureAutomationSloOptions & { actor?: string } = {}): Promise<AppliedErrorBudget> {
  const measurement = await measureAutomationSlo(options);
  const evaluation = evaluateAutomationErrorBudget(measurement);
  await persistMeasurement(measurement, evaluation);
  let previous = await getAutomationControl();
  let control = previous;
  let canary = await getCanaryState();
  let publishPausedByBudget = false;
  let applied = false;

  if (evaluation.status === 'BREACH') {
    const claimed = await claimControlApplication(measurement.id, evaluation);
    if (claimed) {
      previous = await getAutomationControl();
      const nextMode = degradedMode(previous.effectiveMode);
      publishPausedByBudget = evaluation.severeReasons.length > 0 || nextMode === 'SHADOW';
      control = await updateAutomationControl({
        effectiveMode: nextMode,
        publishPaused: previous.publishPaused || publishPausedByBudget,
        degradedAt: evaluation.evaluatedAt,
        degradedReason: evaluation.reasons.join(','),
        reason: evaluation.reasons.join(','),
      }, options.actor || 'error-budget-controller');
      if (publishPausedByBudget) {
        canary = await applyCanarySafetyDecision({
          pause: true,
          reasons: evaluation.reasons,
          evaluatedAt: evaluation.evaluatedAt,
          evaluationId: evaluation.id,
        });
      }
      applied = nextMode !== previous.effectiveMode || publishPausedByBudget && !previous.publishPaused;
      await completeControlApplication(measurement.id, previous.effectiveMode, control.effectiveMode, control.publishPaused, evaluation.evaluatedAt);
    } else {
      control = await getAutomationControl();
      canary = await getCanaryState();
    }
  } else if (evaluation.status === 'PASS') {
    canary = await advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: evaluation.id,
      status: evaluation.status,
      dataStatus: evaluation.dataStatus,
      sampleSize: evaluation.sampleSize,
      evaluatedAt: evaluation.evaluatedAt,
    });
  }

  return {
    measurement,
    evaluation,
    applied,
    previousEffectiveMode: previous.effectiveMode,
    control,
    canary,
    publishPausedByBudget,
    ingestionAvailable: !control.ingestionPaused,
  };
}

export async function getLatestSloMeasurement(): Promise<(AutomationSloMeasurement & { evaluation?: ErrorBudgetEvaluation; application?: ErrorBudgetControlApplication }) | null> {
  const items = await readCollection<AutomationSloMeasurement & { evaluation?: ErrorBudgetEvaluation; application?: ErrorBudgetControlApplication }>(SNAPSHOT_COLLECTION);
  return items.sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))[0] || null;
}
