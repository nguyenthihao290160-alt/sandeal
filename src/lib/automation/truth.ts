import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { getAiUsage, getAllAutomationJobs, getAutomationControl, publicAutomationJob } from './store';
import { listRecentRuntimeRoleConflicts, listRuntimeRoleLeases, type RuntimeRoleConflict, type RuntimeRoleLease } from './runtimeRoles';
import type { AiUsageRecord, AutomationControlState, AutomationJob } from './types';
import { AUTOMATION_TIMEZONE, vietnamDayKey } from './timezone';

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
}

const HEARTBEAT_FRESH_MS = 90_000;

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
  const lastTickAt = control.schedulerLastRunAt || null;
  const nextRunAt = control.schedulerNextRunAt || null;
  const tickRecent = parsed(lastTickAt || undefined) !== null && now - parsed(lastTickAt || undefined)! <= Math.max(2 * 60 * 60_000, settings.intervalHours * 2 * 60 * 60_000);
  const nextRunValid = parsed(nextRunAt || undefined) !== null && parsed(nextRunAt || undefined)! >= now - HEARTBEAT_FRESH_MS;
  const recentSchedulerConflict = input.conflicts.some(item => item.role === 'SCHEDULER' && now - Date.parse(item.observedAt) <= 5 * 60_000);
  const fencingValid = Boolean(schedulerLease && Number.isInteger(schedulerLease.fencingToken) && schedulerLease.fencingToken > 0);
  const schedulerActive = settings.enabled && !control.schedulerPaused && schedulerLeaseFresh && schedulerHeartbeatFresh
    && fencingValid && Boolean(schedulerLease?.ownerId) && (tickRecent || nextRunValid) && !recentSchedulerConflict && schedulerLeases.length === 1;

  const freshWorkers = workerLeases.filter(lease => parsed(lease.leaseExpiresAt) !== null && parsed(lease.leaseExpiresAt)! > now
    && parsed(lease.heartbeatAt) !== null && now - parsed(lease.heartbeatAt)! <= HEARTBEAT_FRESH_MS
    && Number.isInteger(lease.fencingToken) && lease.fencingToken > 0);
  const staleWorkers = workerLeases.filter(lease => !freshWorkers.includes(lease));
  const controlWorkerFresh = parsed(control.workerHeartbeatAt) !== null && now - parsed(control.workerHeartbeatAt)! <= HEARTBEAT_FRESH_MS;
  const activeWorkers = freshWorkers.length || (workerLeases.length === 0 && controlWorkerFresh ? 1 : 0);

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
    { leaseFresh: schedulerLeaseFresh, heartbeatFresh: schedulerHeartbeatFresh, fencingValid, tickRecent, nextRunValid }, now));
  if (schedulerLeaseFresh && schedulerHeartbeatFresh && !tickRecent && !nextRunValid) inconsistencies.push(inconsistency(
    'SCHEDULER_NO_RECENT_TICK', 'WARNING', 'Scheduler có lease nhưng tick gần nhất và lịch kế tiếp đều không hợp lệ.', { lastTickAt, nextRunAt }, now));
  if (parsed(nextRunAt || undefined) !== null && parsed(nextRunAt || undefined)! < now - HEARTBEAT_FRESH_MS) inconsistencies.push(inconsistency(
    'NEXT_RUN_OVERDUE', 'CRITICAL', 'nextRunAt đã ở quá khứ quá ngưỡng cho phép.', { nextRunAt, overdueMs: now - parsed(nextRunAt || undefined)! }, now));
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
  if (settings.enabled && latestSchedulerJob && parsed(latestSchedulerJob.updatedAt) !== null
    && now - parsed(latestSchedulerJob.updatedAt)! > Math.max(2, settings.intervalHours * 2) * 60 * 60_000) inconsistencies.push(inconsistency(
      'SCHEDULE_RUN_STALE', 'WARNING', 'Lần chạy scheduler gần nhất cũ hơn nhiều so với chu kỳ cấu hình.', { latestRunAt: latestSchedulerJob.updatedAt, intervalHours: settings.intervalHours }, now));
  if (usage.day !== vietnamDayKey(now)) inconsistencies.push(inconsistency(
    'DAILY_USAGE_DAY_MISMATCH', 'WARNING', 'Bản ghi hạn mức không thuộc ngày Việt Nam hiện tại.', { usageDay: usage.day, expectedDay: vietnamDayKey(now) }, now));

  const sorted = [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const latestStartedAt = newest(jobs.map(job => job.startedAt));
  const latestCompletedAt = newest(jobs.map(job => job.completedAt));
  const latestSuccessfulAt = newest(jobs.filter(job => job.status === 'SUCCEEDED').map(job => job.completedAt || job.updatedAt));
  const latestFailedAt = newest(jobs.filter(job => job.status === 'FAILED').map(job => job.completedAt || job.updatedAt));
  const processedToday = jobs.filter(job => job.status === 'SUCCEEDED' && vietnamDayKey(parsed(job.completedAt || job.updatedAt) || 0) === vietnamDayKey(now)).length;
  const overall: AutomationTruthStatus = inconsistencies.some(item => item.severity === 'CRITICAL') ? 'INCONSISTENT'
    : inconsistencies.length ? 'DEGRADED'
      : schedulerActive || activeWorkers > 0 ? 'HEALTHY' : 'INACTIVE';

  return {
    status: overall,
    checkedAt: new Date(now).toISOString(),
    timezone: AUTOMATION_TIMEZONE,
    scheduler: {
      state: schedulerActive ? 'ACTIVE' : control.schedulerPaused ? 'PAUSED' : settings.enabled ? 'INACTIVE' : 'DISABLED',
      ownerId: schedulerLease?.ownerId || null,
      heartbeatAt: schedulerHeartbeatAt,
      leaseExpiresAt: schedulerLease?.leaseExpiresAt || null,
      fencingToken: schedulerLease?.fencingToken || null,
      nextRunAt,
      lastTickAt,
      active: schedulerActive,
    },
    worker: {
      state: activeWorkers > 0 ? 'ACTIVE' : control.workerPaused ? 'PAUSED' : 'INACTIVE',
      ownerIds: freshWorkers.map(item => item.ownerId).slice(0, 20),
      latestHeartbeatAt: newest([...workerLeases.map(item => item.heartbeatAt), control.workerHeartbeatAt]),
      activeWorkers,
      staleWorkers: staleWorkers.length,
    },
    queue: { pending, running, retrying, failed, deadLetter, completedRecent, oldestPendingAt },
    runs: {
      latestStartedAt, latestCompletedAt, latestSuccessfulAt, latestFailedAt,
      recent: sorted.slice(0, 20).map(job => publicAutomationJob(job)),
    },
    dailyUsage: {
      day: vietnamDayKey(now), processed: processedToday, limit: settings.maxItemsPerDay,
      remaining: Math.max(0, settings.maxItemsPerDay - processedToday),
    },
    inconsistencies,
  };
}

export async function getAutomationTruth(now = Date.now()) {
  const [settings, control, leases, conflicts, jobs, usage] = await Promise.all([
    getAutomationSettings(), getAutomationControl(), listRuntimeRoleLeases(),
    listRecentRuntimeRoleConflicts(now - 24 * 60 * 60_000), getAllAutomationJobs(), getAiUsage(now),
  ]);
  return buildAutomationTruth({ now, settings, control, leases, conflicts, jobs, usage });
}
