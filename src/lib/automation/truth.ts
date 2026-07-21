import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { getAiUsage, getAllAutomationJobs, getAutomationControl, publicAutomationJob } from './store';
import { listRecentRuntimeRoleConflicts, listRuntimeRoleLeases, type RuntimeRoleConflict, type RuntimeRoleLease } from './runtimeRoles';
import type { AiUsageRecord, AutomationControlState, AutomationJob } from './types';
import { AUTOMATION_TIMEZONE, vietnamDayKey } from './timezone';
import { getDailyBusinessUsage, type DailyBusinessUsage } from './businessUsage';

export type AutomationTruthStatus = 'HEALTHY' | 'DEGRADED' | 'INCONSISTENT' | 'INACTIVE';
export type TruthSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AutomationInconsistency {
  code: string;
  severity: TruthSeverity;
  message: string;
  evidence: Record<string, unknown>;
  detectedAt: string;
}

export interface AutomationTruthInput {
  now: number;
  settings: { enabled: boolean; intervalHours: number; maxItemsPerDay: number };
  control: AutomationControlState;
  leases: RuntimeRoleLease[];
  conflicts: RuntimeRoleConflict[];
  jobs: AutomationJob[];
  usage: AiUsageRecord;
  businessUsage?: DailyBusinessUsage;
}

const HEARTBEAT_FRESH_MS = 90_000;
const WORKER_HEARTBEAT_FRESH_MS = 45_000;

function parsed(value?: string): number | null {
  const result = Date.parse(value || '');
  return Number.isFinite(result) ? result : null;
}

function newest(values: Array<string | undefined>): string | null {
  const ordered = values.filter((value): value is string => parsed(value) !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return ordered[0] || null;
}

function inconsistency(code: string, severity: TruthSeverity, message: string, evidence: Record<string, unknown>, now: number): AutomationInconsistency {
  return { code, severity, message, evidence, detectedAt: new Date(now).toISOString() };
}

export function buildAutomationTruth(input: AutomationTruthInput) {
  const { now, settings, control, jobs, usage } = input;
  const schedulerLeases = input.leases.filter(item => item.role === 'SCHEDULER' && item.status === 'ACTIVE');
  const workerLeases = input.leases.filter(item => item.role === 'WORKER' && item.status === 'ACTIVE');
  const schedulerLease = [...schedulerLeases].sort((a, b) => b.fencingToken - a.fencingToken)[0];
  const schedulerLeaseFresh = Boolean(schedulerLease && parsed(schedulerLease.leaseExpiresAt) !== null && parsed(schedulerLease.leaseExpiresAt)! > now);
  // A control-store heartbeat cannot make an existing stale lease healthy.
  // It remains a diagnostic fallback only when no lease is present; ACTIVE
  // still requires the lease below.
  const schedulerHeartbeatAt = schedulerLease?.heartbeatAt || control.schedulerHeartbeatAt || null;
  const schedulerHeartbeatFresh = parsed(schedulerHeartbeatAt || undefined) !== null && now - parsed(schedulerHeartbeatAt || undefined)! <= HEARTBEAT_FRESH_MS;
  const schedulerHeartbeatAgeMs = parsed(schedulerHeartbeatAt || undefined) === null
    ? null : Math.max(0, now - parsed(schedulerHeartbeatAt || undefined)!);
  const schedulerHeartbeatSource = schedulerLease?.heartbeatAt ? 'role_lease'
    : control.schedulerHeartbeatAt ? 'control_store' : 'none';
  const lastTickAt = control.schedulerLastRunAt || null;
  const nextRunAt = control.schedulerNextRunAt || null;
  const tickRecent = parsed(lastTickAt || undefined) !== null && now - parsed(lastTickAt || undefined)! <= Math.max(2 * 60 * 60_000, settings.intervalHours * 2 * 60 * 60_000);
  const nextRunValid = parsed(nextRunAt || undefined) !== null && parsed(nextRunAt || undefined)! >= now - HEARTBEAT_FRESH_MS;
  const schedulerStartedAt = parsed(schedulerLease?.processStartedAt || schedulerLease?.acquiredAt) || 0;
  const recentSchedulerConflict = input.conflicts.some(item => item.role === 'SCHEDULER'
    && Date.parse(item.observedAt) >= Math.max(now - 5 * 60_000, schedulerStartedAt)
    && (!schedulerLease?.instanceId || item.activeInstanceId === schedulerLease.instanceId));
  const fencingValid = Boolean(schedulerLease && Number.isInteger(schedulerLease.fencingToken) && schedulerLease.fencingToken > 0);
  const schedulerActive = settings.enabled && !control.schedulerPaused && schedulerLeaseFresh && schedulerHeartbeatFresh
    && fencingValid && Boolean(schedulerLease?.ownerId) && !recentSchedulerConflict && schedulerLeases.length === 1;

  const freshWorkers = workerLeases.filter(lease => parsed(lease.leaseExpiresAt) !== null && parsed(lease.leaseExpiresAt)! > now
    && parsed(lease.heartbeatAt) !== null && now - parsed(lease.heartbeatAt)! <= WORKER_HEARTBEAT_FRESH_MS
    && Number.isInteger(lease.fencingToken) && lease.fencingToken > 0);
  const staleWorkers = workerLeases.filter(lease => !freshWorkers.includes(lease));
  const controlWorkerFresh = parsed(control.workerHeartbeatAt) !== null && now - parsed(control.workerHeartbeatAt)! <= WORKER_HEARTBEAT_FRESH_MS;
  const activeWorkers = freshWorkers.length || (workerLeases.length === 0 && controlWorkerFresh ? 1 : 0);
  const workerHeartbeatAt = newest([...workerLeases.map(item => item.heartbeatAt), control.workerHeartbeatAt]);
  const workerHeartbeatAgeMs = parsed(workerHeartbeatAt || undefined) === null
    ? null : Math.max(0, now - parsed(workerHeartbeatAt || undefined)!);
  const workerHeartbeatSource = freshWorkers[0]?.heartbeatAt || workerLeases[0]?.heartbeatAt ? 'role_lease'
    : control.workerHeartbeatAt ? 'control_store' : 'none';

  const pending = jobs.filter(job => job.status === 'PENDING').length;
  const running = jobs.filter(job => job.status === 'RUNNING').length;
  const retrying = jobs.filter(job => job.status === 'RETRY_SCHEDULED').length;
  const failed = jobs.filter(job => job.status === 'FAILED').length;
  const deadLetter = jobs.filter(job => job.status === 'FAILED' && Boolean(job.deadLetterReason)).length;
  const recentWindow = now - 24 * 60 * 60_000;
  const completedRecent = jobs.filter(job => job.status === 'SUCCEEDED' && (parsed(job.completedAt) || parsed(job.updatedAt) || 0) >= recentWindow).length;
  const oldestPendingAt = newest(jobs.filter(job => job.status === 'PENDING').map(job => job.createdAt).sort().slice(0, 1));
  const inconsistencies: AutomationInconsistency[] = [];

  if (settings.enabled && !control.schedulerPaused && !schedulerActive) inconsistencies.push(inconsistency(
    'SCHEDULE_ENABLED_RUNTIME_INACTIVE', 'CRITICAL', 'Lịch được bật nhưng runtime scheduler chưa chứng minh ACTIVE.',
    { leaseFresh: schedulerLeaseFresh, heartbeatFresh: schedulerHeartbeatFresh, fencingValid }, now));
  if (!control.schedulerPaused && schedulerLeaseFresh && schedulerHeartbeatFresh && !tickRecent && !nextRunValid) inconsistencies.push(inconsistency(
    'SCHEDULER_NO_RECENT_TICK', 'WARNING', 'Scheduler có lease nhưng tick gần nhất và lịch kế tiếp đều không hợp lệ.', { lastTickAt, nextRunAt }, now));
  if (!control.schedulerPaused && parsed(nextRunAt || undefined) !== null && parsed(nextRunAt || undefined)! < now - HEARTBEAT_FRESH_MS) inconsistencies.push(inconsistency(
    'NEXT_RUN_OVERDUE', 'WARNING', 'nextRunAt đã ở quá khứ quá ngưỡng cho phép.', { nextRunAt, overdueMs: now - parsed(nextRunAt || undefined)! }, now));
  if ((pending + retrying) > 0 && activeWorkers === 0) inconsistencies.push(inconsistency(
    'QUEUE_PENDING_WORKER_INACTIVE', 'CRITICAL', 'Hàng đợi có việc nhưng không có worker ACTIVE.', { pending, retrying }, now));
  if (schedulerLeases.length > 1) inconsistencies.push(inconsistency(
    'DUPLICATE_ACTIVE_SCHEDULER_LEASE', 'CRITICAL', 'Có nhiều scheduler lease ACTIVE.', { owners: schedulerLeases.map(item => item.ownerId).slice(0, 10) }, now));
  if (recentSchedulerConflict) inconsistencies.push(inconsistency(
    'SCHEDULER_OWNER_CONFLICT', 'CRITICAL', 'Có owner conflict scheduler chưa hết cửa sổ kiểm tra.', { conflictCount: input.conflicts.filter(item => item.role === 'SCHEDULER').length }, now));
  const duplicateFence = input.leases.some((lease, index, all) => all.some((other, otherIndex) => otherIndex !== index && other.role === lease.role && other.fencingToken === lease.fencingToken && other.ownerId !== lease.ownerId));
  if (duplicateFence) inconsistencies.push(inconsistency('FENCING_TOKEN_CONFLICT', 'CRITICAL', 'Một fencing token đang gắn với nhiều owner.', {}, now));
  const completedStillRunning = jobs.filter(job => job.status === 'RUNNING' && Boolean(job.completedAt));
  if (completedStillRunning.length) inconsistencies.push(inconsistency(
    'COMPLETED_JOB_STILL_RUNNING', 'CRITICAL', 'Job đã có completedAt nhưng vẫn mang trạng thái RUNNING.', { jobIds: completedStillRunning.map(item => item.id).slice(0, 10) }, now));
  const latestSchedulerJob = [...jobs].filter(job => job.requestedBy === 'scheduler').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (settings.enabled && !control.schedulerPaused && latestSchedulerJob && parsed(latestSchedulerJob.updatedAt) !== null
    && now - parsed(latestSchedulerJob.updatedAt)! > Math.max(2, settings.intervalHours * 2) * 60 * 60_000) inconsistencies.push(inconsistency(
      'SCHEDULE_RUN_STALE', 'WARNING', 'Lần chạy scheduler gần nhất cũ hơn nhiều so với chu kỳ cấu hình.', { latestRunAt: latestSchedulerJob.updatedAt, intervalHours: settings.intervalHours }, now));
  if (usage.day !== vietnamDayKey(now)) inconsistencies.push(inconsistency(
    'DAILY_USAGE_DAY_MISMATCH', 'WARNING', 'Bản ghi hạn mức không thuộc ngày Việt Nam hiện tại.', { usageDay: usage.day, expectedDay: vietnamDayKey(now) }, now));

  const sorted = [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const latestStartedAt = newest(jobs.map(job => job.startedAt));
  const latestCompletedAt = newest(jobs.map(job => job.completedAt));
  const latestSuccessfulAt = newest(jobs.filter(job => job.status === 'SUCCEEDED').map(job => job.completedAt || job.updatedAt));
  const latestFailedAt = newest(jobs.filter(job => job.status === 'FAILED').map(job => job.completedAt || job.updatedAt));
  const processedToday = input.businessUsage?.id === vietnamDayKey(now) ? input.businessUsage.productsReviewed : 0;
  const latestSafeJob = sorted.find(job => job.type === 'AUTO_PILOT' && job.dryRun);
  const safeRunStatus = latestSafeJob ? latestSafeJob.status === 'PENDING' || latestSafeJob.status === 'RETRY_SCHEDULED' ? 'QUEUED'
    : latestSafeJob.status === 'RUNNING' ? 'RUNNING'
      : latestSafeJob.status === 'SUCCEEDED' ? 'SUCCEEDED'
        : latestSafeJob.status === 'FAILED' ? 'FAILED' : 'SKIPPED' : null;
  const overall: AutomationTruthStatus = inconsistencies.some(item => item.severity === 'CRITICAL') ? 'INCONSISTENT'
    : inconsistencies.length ? 'DEGRADED'
      : schedulerActive || activeWorkers > 0 ? 'HEALTHY' : 'INACTIVE';

  return {
    status: overall,
    checkedAt: new Date(now).toISOString(),
    timezone: AUTOMATION_TIMEZONE,
    scheduler: {
      state: schedulerActive ? 'ACTIVE' : control.schedulerPaused ? 'PAUSED' : settings.enabled ? 'INACTIVE' : 'DISABLED',
      runtimeState: schedulerActive ? 'ACTIVE' : control.schedulerPaused ? 'PAUSED' : settings.enabled ? 'INACTIVE' : 'DISABLED',
      scheduleState: control.schedulerPaused ? 'PAUSED' : !settings.enabled ? 'DISABLED'
        : parsed(nextRunAt || undefined) === null ? 'UNVERIFIED'
          : !nextRunValid ? 'OVERDUE' : 'HEALTHY',
      ownerId: schedulerLease?.ownerId || null,
      heartbeatAt: schedulerHeartbeatAt,
      heartbeatAgeMs: schedulerHeartbeatAgeMs,
      heartbeatSource: schedulerHeartbeatSource,
      staleAgeMs: schedulerHeartbeatAgeMs !== null && schedulerHeartbeatAgeMs > HEARTBEAT_FRESH_MS
        ? schedulerHeartbeatAgeMs - HEARTBEAT_FRESH_MS : null,
      leaseExpiresAt: schedulerLease?.leaseExpiresAt || null,
      releaseId: schedulerLease?.releaseId || null,
      fencingToken: schedulerLease?.fencingToken || null,
      nextRunAt,
      lastTickAt,
      active: schedulerActive,
    },
    worker: {
      state: activeWorkers > 0 ? 'ACTIVE' : control.workerPaused ? 'PAUSED' : 'INACTIVE',
      ownerIds: freshWorkers.map(item => item.ownerId).slice(0, 20),
      latestHeartbeatAt: workerHeartbeatAt,
      heartbeatAgeMs: workerHeartbeatAgeMs,
      heartbeatSource: workerHeartbeatSource,
      staleAgeMs: workerHeartbeatAgeMs !== null && workerHeartbeatAgeMs > WORKER_HEARTBEAT_FRESH_MS
        ? workerHeartbeatAgeMs - WORKER_HEARTBEAT_FRESH_MS : null,
      releaseIds: [...new Set(freshWorkers.map(item => item.releaseId).filter((value): value is string => Boolean(value)))],
      activeWorkers,
      staleWorkers: staleWorkers.length,
    },
    queue: { pending, running, retrying, failed, deadLetter, completedRecent, oldestPendingAt },
    runs: {
      latestStartedAt, latestCompletedAt, latestSuccessfulAt, latestFailedAt,
      recent: sorted.slice(0, 20).map(job => publicAutomationJob(job)),
      latestSafeRun: latestSafeJob ? {
        jobId: latestSafeJob.id,
        createdAt: latestSafeJob.createdAt,
        queuedAt: latestSafeJob.queuedAt || latestSafeJob.scheduledAt,
        startedAt: latestSafeJob.startedAt || null,
        completedAt: latestSafeJob.completedAt || null,
        status: safeRunStatus,
        result: {
          claimed: Number(latestSafeJob.result?.claimed) || 0,
          succeeded: Number(latestSafeJob.result?.succeeded) || 0,
          failed: Number(latestSafeJob.result?.failed) || 0,
          skipped: Number(latestSafeJob.result?.skipped) || 0,
        },
        error: latestSafeJob.lastErrorMessage || latestSafeJob.lastErrorCode || null,
      } : null,
    },
    dailyUsage: {
      day: vietnamDayKey(now), processed: processedToday, limit: settings.maxItemsPerDay,
      remaining: Math.max(0, settings.maxItemsPerDay - processedToday),
    },
    inconsistencies,
  };
}

export async function getAutomationTruth(now = Date.now()) {
  const [settings, control, leases, conflicts, jobs, usage, businessUsage] = await Promise.all([
    getAutomationSettings(), getAutomationControl(), listRuntimeRoleLeases(),
    listRecentRuntimeRoleConflicts(now - 24 * 60 * 60_000), getAllAutomationJobs(), getAiUsage(now),
    getDailyBusinessUsage(now),
  ]);
  return buildAutomationTruth({ now, settings, control, leases, conflicts, jobs, usage, businessUsage });
}
