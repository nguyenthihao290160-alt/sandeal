import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { createAutomationJob, createAutomationJobsBatch, getAutomationControl, updateAutomationControl } from './store';
import { getAutomationPolicy } from './policyRegistry';
import { heartbeatRuntimeRole, isRuntimeRoleOwner, type RuntimeRoleOwnership } from './runtimeRoles';
import type { AutomationJobType } from './types';
import { getProductProcessingCapacity } from './businessUsage';
import { withAutomationCycleReadModel } from './cycleReadModel';
import { getStorageDiagnosticsSnapshot } from '@/lib/storage/adapter';

export interface SchedulerTickResult {
  status: 'paused' | 'killed' | 'disabled' | 'ingestion_paused' | 'worker_stale' | 'limit_reached' | 'scheduled' | 'duplicate' | 'not_due';
  jobId?: string;
  nextRunAt?: string;
}

function bucketKey(now: number, intervalHours: number): string {
  const bucketMs = intervalHours * 60 * 60_000;
  return String(Math.floor(now / bucketMs));
}

type ScheduledProductIntelligenceJobType = Extract<
  AutomationJobType,
  | 'RECHECK_PRODUCT_HEALTH'
  | 'SCORE_PRODUCTS'
  | 'CAPTURE_PRICE_HISTORY'
  | 'EVALUATE_ALERTS'
  | 'AGGREGATE_GROWTH_METRICS'
>;

export interface ProductIntelligenceSchedulerTickResult {
  status: 'paused' | 'killed' | 'disabled' | 'worker_stale' | 'scheduled' | 'duplicate';
  scheduled: number;
  duplicates: number;
  jobs: Array<{
    type: ScheduledProductIntelligenceJobType;
    jobId: string;
    created: boolean;
  }>;
}

const PRODUCT_INTELLIGENCE_SCHEDULES: ReadonlyArray<{
  type: ScheduledProductIntelligenceJobType;
  intervalHours: number;
  priority: number;
}> = [
  { type: 'RECHECK_PRODUCT_HEALTH', intervalHours: 1, priority: 70 },
  { type: 'EVALUATE_ALERTS', intervalHours: 1, priority: 65 },
  { type: 'SCORE_PRODUCTS', intervalHours: 6, priority: 55 },
  { type: 'CAPTURE_PRICE_HISTORY', intervalHours: 6, priority: 50 },
  { type: 'AGGREGATE_GROWTH_METRICS', intervalHours: 24, priority: 40 },
];

export async function runProductIntelligenceSchedulerTick(
  now = Date.now(),
): Promise<ProductIntelligenceSchedulerTickResult> {
  const emptyResult = (status: 'paused' | 'killed' | 'disabled' | 'worker_stale'): ProductIntelligenceSchedulerTickResult => ({
    status,
    scheduled: 0,
    duplicates: 0,
    jobs: [],
  });
  const timestamp = new Date(now).toISOString();
  await updateAutomationControl({ schedulerHeartbeatAt: timestamp }, 'scheduler');
  const control = await getAutomationControl();
  if (control.killSwitch) return emptyResult('killed');
  if (control.schedulerPaused) return emptyResult('paused');
  const settings = await getAutomationSettings();
  if (!settings.enabled) return emptyResult('disabled');
  const workerHeartbeat = Date.parse(control.workerHeartbeatAt || '');
  if (!Number.isFinite(workerHeartbeat) || now - workerHeartbeat > 90_000) return emptyResult('worker_stale');

  const jobs: ProductIntelligenceSchedulerTickResult['jobs'] = [];

  const batch = await createAutomationJobsBatch(PRODUCT_INTELLIGENCE_SCHEDULES.map(schedule => {
    const policy = getAutomationPolicy(schedule.type);
    const bucket = bucketKey(now, schedule.intervalHours);
    return {
      type: schedule.type,
      payload: {
        limit: settings.maxItemsPerRun,
        scheduleIntervalHours: schedule.intervalHours,
        scheduleBucket: bucket,
      },
      priority: schedule.priority,
      idempotencyKey: `scheduler:intelligence:${schedule.type.toLowerCase()}:${bucket}`,
      requestedBy: 'scheduler',
      riskLevel: policy.defaultRisk,
      dryRun: false,
      maxAttempts: policy.retryPolicy.maxAttempts,
    };
  }));
  batch.forEach((created, index) => jobs.push({
    type: PRODUCT_INTELLIGENCE_SCHEDULES[index].type,
    jobId: created.job.id,
    created: created.created,
  }));

  const scheduled = jobs.filter((job) => job.created).length;
  const duplicates = jobs.length - scheduled;
  await updateAutomationControl({ schedulerHeartbeatAt: timestamp, schedulerLastRunAt: timestamp }, 'scheduler');
  return {
    status: scheduled > 0 ? 'scheduled' : 'duplicate',
    scheduled,
    duplicates,
    jobs,
  };
}

export async function runAutomationSchedulerTick(now = Date.now()): Promise<SchedulerTickResult> {
  await updateAutomationControl({ schedulerHeartbeatAt: new Date(now).toISOString() }, 'scheduler');
  const control = await getAutomationControl();
  if (control.killSwitch) return { status: 'killed' };
  if (control.schedulerPaused) return { status: 'paused' };
  if (control.ingestionPaused) return { status: 'ingestion_paused' };
  const settings = await getAutomationSettings();
  if (!settings.enabled) return { status: 'disabled' };
  const workerHeartbeat = Date.parse(control.workerHeartbeatAt || '');
  if (!Number.isFinite(workerHeartbeat) || now - workerHeartbeat > 90_000) return { status: 'worker_stale' };
  const intervalMs = settings.intervalHours * 60 * 60_000;
  if (control.schedulerNextRunAt && Date.parse(control.schedulerNextRunAt) > now) return { status: 'not_due', nextRunAt: control.schedulerNextRunAt };
  const capacity = await getProductProcessingCapacity(settings.maxItemsPerDay, now);
  if (capacity.remaining <= 0) return { status: 'limit_reached' };

  const nextRunAt = new Date(now + intervalMs).toISOString();
  const scheduleBucket = bucketKey(now, settings.intervalHours);
  const policy = getAutomationPolicy('AUTO_PILOT');
  const created = await createAutomationJob({
    type: 'AUTO_PILOT',
    payload: { mode: settings.mode, autonomousMode: control.effectiveMode, source: settings.source, limit: Math.min(settings.maxItemsPerRun, capacity.remaining), scheduleBucket },
    priority: 60,
    idempotencyKey: `scheduler:auto:${scheduleBucket}`,
    requestedBy: 'scheduler',
    riskLevel: policy.defaultRisk,
    dryRun: control.effectiveMode === 'OBSERVE',
    maxAttempts: policy.retryPolicy.maxAttempts,
  });
  await updateAutomationControl({ schedulerHeartbeatAt: new Date(now).toISOString(), schedulerLastRunAt: new Date(now).toISOString(), schedulerNextRunAt: nextRunAt }, 'scheduler');
  return { status: created.created ? 'scheduled' : 'duplicate', jobId: created.job.id, nextRunAt };
}

export interface RuntimeControlSchedulerTickResult {
  status: 'scheduled' | 'duplicate';
  jobId: string;
}

export interface OwnedSchedulerCycleResult {
  status: 'completed' | 'role_lost';
  /** True when a timer fired while the previous cycle was still running. */
  skippedOverlap?: boolean;
  guardian?: RuntimeControlSchedulerTickResult;
  automation?: SchedulerTickResult;
  intelligence?: ProductIntelligenceSchedulerTickResult;
}

let ownedSchedulerFlight: Promise<OwnedSchedulerCycleResult> | undefined;

/**
 * Runtime scheduler entrypoint. Every durable enqueue is preceded by a
 * persisted ownership check so a rejected or fenced process cannot tick.
 */
export async function runOwnedSchedulerCycle(
  ownership: RuntimeRoleOwnership,
  now = Date.now(),
): Promise<OwnedSchedulerCycleResult> {
  if (ownedSchedulerFlight) return { status: 'completed', skippedOverlap: true };
  const storageBefore = getStorageDiagnosticsSnapshot();
  const flight = withAutomationCycleReadModel(async (): Promise<OwnedSchedulerCycleResult> => {
    const startedAt = Date.now();
    if (!await heartbeatRuntimeRole('SCHEDULER', ownership, undefined, now)) return { status: 'role_lost' };
    const guardian = await runRuntimeControlSchedulerTick(now);
    if (!await isRuntimeRoleOwner('SCHEDULER', ownership, now)) return { status: 'role_lost', guardian };
    const automation = await runAutomationSchedulerTick(now);
    if (!await isRuntimeRoleOwner('SCHEDULER', ownership, now)) return { status: 'role_lost', guardian, automation };
    const intelligence = await runProductIntelligenceSchedulerTick(now);
    const storageAfter = getStorageDiagnosticsSnapshot();
    const fullReadsByCollection: Record<string, number> = {};
    for (const [collection, count] of Object.entries(storageAfter.fullCollectionReadsByCollection)) {
      const delta = count - (storageBefore.fullCollectionReadsByCollection[collection] || 0);
      if (delta > 0) fullReadsByCollection[collection] = delta;
    }
    console.info(JSON.stringify({
      type: 'automation_scheduler_cycle',
      durationMs: Math.max(0, Date.now() - startedAt),
      guardian: guardian.status,
      automation: automation.status,
      intelligence: intelligence.status,
      scheduled: (automation.status === 'scheduled' ? 1 : 0) + intelligence.scheduled,
      duplicateCount: intelligence.duplicates + (automation.status === 'duplicate' ? 1 : 0),
      fullDurableCollectionReads: storageAfter.fullCollectionReadCount - storageBefore.fullCollectionReadCount,
      fullDurableCollectionReadsByCollection: fullReadsByCollection,
      boundedReads: storageAfter.boundedReadCount - storageBefore.boundedReadCount,
      lockWaitCount: storageAfter.lockWaitCount - storageBefore.lockWaitCount,
      totalLockWaitMs: storageAfter.totalLockWaitMs - storageBefore.totalLockWaitMs,
      maximumLockWaitMs: storageAfter.maximumLockWaitMs,
      maximumLockHoldMs: storageAfter.maximumLockHoldMs,
      staleLockRecoveries: storageAfter.staleLockRecoveryCount - storageBefore.staleLockRecoveryCount,
      roleHeartbeatRenewals: storageAfter.roleHeartbeatRenewalCount - storageBefore.roleHeartbeatRenewalCount,
      roleHeartbeatRenewalFailures: storageAfter.roleHeartbeatRenewalFailureCount - storageBefore.roleHeartbeatRenewalFailureCount,
      fencingRejections: storageAfter.fencingRejectionCount - storageBefore.fencingRejectionCount,
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
    }));
    return { status: 'completed', guardian, automation, intelligence };
  });
  ownedSchedulerFlight = flight;
  try {
    return await flight;
  } finally {
    if (ownedSchedulerFlight === flight) ownedSchedulerFlight = undefined;
  }
}

export async function runRuntimeControlSchedulerTick(now = Date.now()): Promise<RuntimeControlSchedulerTickResult> {
  const timestamp = new Date(now).toISOString();
  await updateAutomationControl({ schedulerHeartbeatAt: timestamp }, 'scheduler');
  const policy = getAutomationPolicy('RUNTIME_GUARDIAN');
  const bucket = Math.floor(now / 60_000);
  const created = await createAutomationJob({
    type: 'RUNTIME_GUARDIAN',
    payload: { scheduleBucket: bucket },
    priority: 100,
    idempotencyKey: `scheduler:runtime-guardian:${bucket}`,
    requestedBy: 'scheduler',
    riskLevel: policy.defaultRisk,
    dryRun: false,
    maxAttempts: policy.retryPolicy.maxAttempts,
  });
  return { status: created.created ? 'scheduled' : 'duplicate', jobId: created.job.id };
}
