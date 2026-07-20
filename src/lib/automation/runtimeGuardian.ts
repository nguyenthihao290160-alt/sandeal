import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectCriticalStorage, type CriticalStorageInspection } from '@/lib/autonomous/backupManager';
import { getDataDir, readCollection, runTransaction } from '@/lib/storage/adapter';
import { DEFAULT_CONTROL, getAllAutomationJobs, getAutomationControl, updateAutomationControl } from './store';
import { listRecentRuntimeRoleConflicts, listRuntimeRoleLeases } from './runtimeRoles';
import { applyAutomationErrorBudget } from './sloErrorBudget';

const HEALTH_COLLECTION = 'runtime-health';
export const RUNTIME_GUARDIAN_RULE_VERSION = 'runtime-guardian-v1';

export type WebHealthStatus = 'alive' | 'ready' | 'unhealthy' | 'build_missing';
export type WorkerHealthStatus = 'active' | 'paused' | 'stale' | 'missing' | 'crashed' | 'unverified';
export type SchedulerHealthStatus = 'active' | 'paused' | 'disabled' | 'stale' | 'missing' | 'crashed' | 'unverified';
export type ProviderHealthStatus = 'not_configured' | 'configured' | 'adapter_unavailable' | 'ready' | 'degraded' | 'circuit_open' | 'rate_limited' | 'invalid_credential' | 'quota_exhausted' | 'last_check_failed';

export interface RuntimeHealthSnapshot {
  schemaVersion: number;
  id: string;
  ruleVersion: string;
  web: { status: WebHealthStatus; buildAvailable: boolean; publicRouteHealthy: boolean | null };
  worker: { status: WorkerHealthStatus; holderId?: string; heartbeatAt?: string };
  scheduler: { status: SchedulerHealthStatus; holderId?: string; heartbeatAt?: string };
  providers: Record<string, ProviderHealthStatus>;
  queue: { pending: number; running: number; stuck: number; staleJobs: number };
  storage: { status: 'healthy' | 'degraded' | 'blocked'; staleLocks: number; freeBytes: number | null; criticalCollections: CriticalStorageInspection };
  duplicateRoles: string[];
  publishSafe: boolean;
  reasons: string[];
  recommendation: { pausePublish: boolean; pauseIngestion: false; effectiveMode?: 'SHADOW' | 'CANARY' };
  checkedAt: string;
}

function roleStatus(input: {
  role: 'WORKER' | 'SCHEDULER'; paused: boolean; enabled?: boolean; lease?: { status: string; holderId: string; heartbeatAt: string; leaseExpiresAt: string };
  controlHeartbeat?: string; now: number;
}): WorkerHealthStatus | SchedulerHealthStatus {
  if (input.role === 'SCHEDULER' && input.enabled === false) return 'disabled';
  if (input.paused) return 'paused';
  const leaseFresh = input.lease?.status === 'ACTIVE' && Date.parse(input.lease.leaseExpiresAt) > input.now;
  if (leaseFresh) return 'active';
  if (input.lease?.status === 'ACTIVE') return 'stale';
  const controlHeartbeat = Date.parse(input.controlHeartbeat || '');
  if (Number.isFinite(controlHeartbeat)) return input.now - controlHeartbeat > 90_000 ? 'stale' : 'unverified';
  return input.lease ? 'crashed' : 'missing';
}

async function inspectStorage(now: number): Promise<RuntimeHealthSnapshot['storage']> {
  const dataDir = getDataDir();
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const [names, criticalCollections] = await Promise.all([fs.readdir(dataDir), inspectCriticalStorage(dataDir, undefined, now)]);
    let staleLocks = 0;
    for (const name of names.filter(item => item.endsWith('.lock'))) {
      try { if (now - (await fs.stat(path.join(dataDir, name))).mtimeMs > 2 * 60_000) staleLocks += 1; } catch { /* lock changed during inspection */ }
    }
    let freeBytes: number | null = null;
    try { const stats = await fs.statfs(dataDir); freeBytes = stats.bavail * stats.bsize; } catch { /* statfs is not available on every runtime */ }
    const lowDisk = freeBytes !== null && freeBytes < 256 * 1024 * 1024;
    const status = criticalCollections.status === 'blocked' ? 'blocked'
      : criticalCollections.status === 'degraded' || staleLocks || lowDisk ? 'degraded' : 'healthy';
    return { status, staleLocks, freeBytes, criticalCollections };
  } catch {
    return {
      status: 'blocked', staleLocks: 0, freeBytes: null,
      criticalCollections: {
        status: 'blocked', collections: [], healthy: [], freshEmpty: [], recoverable: [], blocked: ['storage-root'], checkedAt: new Date(now).toISOString(),
      },
    };
  }
}

export function providerHealth(input: { configured: boolean; adapterAvailable: boolean; ready?: boolean; failure?: ProviderHealthStatus }): ProviderHealthStatus {
  if (!input.configured) return 'not_configured';
  if (!input.adapterAvailable) return 'adapter_unavailable';
  if (input.failure) return input.failure;
  return input.ready ? 'ready' : 'configured';
}

export async function runRuntimeGuardian(options: {
  apply?: boolean;
  now?: number;
  webAlive?: boolean;
  publicRouteHealthy?: boolean;
  schedulerEnabled?: boolean;
  providers?: Record<string, ProviderHealthStatus>;
} = {}): Promise<RuntimeHealthSnapshot> {
  const now = options.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  const storage = await inspectStorage(now);
  const [control, jobs, roles, conflicts] = await Promise.all([
    getAutomationControl().catch(() => ({ ...DEFAULT_CONTROL })),
    getAllAutomationJobs().catch(() => []),
    listRuntimeRoleLeases().catch(() => []),
    listRecentRuntimeRoleConflicts(now - 2 * 60_000).catch(() => []),
  ]);
  let buildAvailable = false;
  try { await fs.access(path.join(process.cwd(), '.next', 'BUILD_ID')); buildAvailable = true; } catch { /* development/test runtime */ }
  const workerLease = roles.find(item => item.role === 'WORKER');
  const schedulerLease = roles.find(item => item.role === 'SCHEDULER');
  const workerStatus = roleStatus({ role: 'WORKER', paused: control.workerPaused, lease: workerLease, controlHeartbeat: control.workerHeartbeatAt, now }) as WorkerHealthStatus;
  const schedulerStatus = roleStatus({ role: 'SCHEDULER', paused: control.schedulerPaused, enabled: options.schedulerEnabled, lease: schedulerLease, controlHeartbeat: control.schedulerHeartbeatAt, now }) as SchedulerHealthStatus;
  const webStatus: WebHealthStatus = !buildAvailable && process.env.NODE_ENV === 'production' ? 'build_missing'
    : options.webAlive === false || options.publicRouteHealthy === false ? 'unhealthy'
      : options.webAlive === true && options.publicRouteHealthy === true ? 'ready' : 'alive';
  const staleJobs = jobs.filter(job => job.status === 'RUNNING' && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now)).length;
  const stuck = jobs.filter(job => ['PENDING', 'RETRY_SCHEDULED'].includes(job.status) && now - Date.parse(job.updatedAt) > 30 * 60_000).length;
  const currentConflicts = conflicts.filter(conflict => {
    const lease = roles.find(item => item.role === conflict.role);
    const processStartedAt = Date.parse(lease?.processStartedAt || lease?.acquiredAt || '');
    return (!Number.isFinite(processStartedAt) || Date.parse(conflict.observedAt) >= processStartedAt)
      && (!lease?.instanceId || conflict.activeInstanceId === lease.instanceId);
  });
  const duplicateRoles = [...new Set(currentConflicts.map(item => item.role))];
  const reasons: string[] = [];
  if (!['active', 'paused'].includes(workerStatus)) reasons.push(`WORKER_${workerStatus.toUpperCase()}`);
  if (!['active', 'paused', 'disabled'].includes(schedulerStatus)) reasons.push(`SCHEDULER_${schedulerStatus.toUpperCase()}`);
  if (webStatus === 'unhealthy' || webStatus === 'build_missing') reasons.push(`WEB_${webStatus.toUpperCase()}`);
  if (storage.status !== 'healthy') reasons.push(`STORAGE_${storage.status.toUpperCase()}`);
  if (staleJobs) reasons.push('STALE_JOB');
  if (stuck) reasons.push('QUEUE_STUCK');
  if (duplicateRoles.length) reasons.push('DUPLICATE_PROCESS_ROLE');
  if ((workerLease?.takeoverCount || 0) >= 3 || (schedulerLease?.takeoverCount || 0) >= 3) reasons.push('REPEATED_PROCESS_RESTART');
  if (Object.values(options.providers || {}).some(status => ['degraded', 'circuit_open', 'rate_limited', 'invalid_credential', 'quota_exhausted', 'last_check_failed'].includes(status))) reasons.push('PROVIDER_DEGRADED');
  const publishSafe = reasons.length === 0;
  const snapshot: RuntimeHealthSnapshot = {
    schemaVersion: 1, id: `runtime-health:${Math.floor(now / 30_000)}`, ruleVersion: RUNTIME_GUARDIAN_RULE_VERSION,
    web: { status: webStatus, buildAvailable, publicRouteHealthy: options.publicRouteHealthy ?? null },
    worker: { status: workerStatus, holderId: workerLease?.holderId, heartbeatAt: workerLease?.heartbeatAt || control.workerHeartbeatAt },
    scheduler: { status: schedulerStatus, holderId: schedulerLease?.holderId, heartbeatAt: schedulerLease?.heartbeatAt || control.schedulerHeartbeatAt },
    providers: options.providers || {},
    queue: { pending: jobs.filter(job => job.status === 'PENDING').length, running: jobs.filter(job => job.status === 'RUNNING').length, stuck, staleJobs },
    storage, duplicateRoles, publishSafe, reasons,
    recommendation: { pausePublish: !publishSafe, pauseIngestion: false, effectiveMode: !publishSafe ? 'SHADOW' : undefined },
    checkedAt,
  };
  await runTransaction<RuntimeHealthSnapshot>(HEALTH_COLLECTION, items => [...items.filter(item => item.id !== snapshot.id).slice(-499), snapshot]);
  if (options.apply !== false) {
    await updateAutomationControl({ guardianHeartbeatAt: checkedAt }, 'runtime-guardian');
    // The guardian snapshot is the durable runtime input for the SLO controller.
    // That controller measures persisted telemetry and owns ladder degradation;
    // caller-provided health numbers cannot directly change the mode.
    await applyAutomationErrorBudget({ now, actor: 'runtime-guardian' });
  }
  return snapshot;
}

export async function getLatestRuntimeHealth(): Promise<RuntimeHealthSnapshot | null> {
  const items = await readCollection<RuntimeHealthSnapshot>(HEALTH_COLLECTION);
  return items.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0] || null;
}
