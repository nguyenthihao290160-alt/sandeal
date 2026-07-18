import { promises as fs } from 'node:fs';
import { inspectCriticalStorage } from '@/lib/autonomous/backupManager';
import { buildAutomationDashboard } from '@/lib/automation/dashboard';
import { getDataDir } from '@/lib/storage/adapter';

type CheckStatus = 'PASS' | 'WARNING' | 'CRITICAL';

interface ReadinessCheck {
  status: CheckStatus;
  code: string;
  message: string;
  observed?: number | string | boolean | null;
}

function check(status: CheckStatus, code: string, message: string, observed?: ReadinessCheck['observed']): ReadinessCheck {
  return { status, code, message, observed };
}

export async function buildReadinessReport() {
  const [dashboard, storage] = await Promise.all([
    buildAutomationDashboard('today'),
    inspectCriticalStorage(getDataDir()),
  ]);
  let freeBytes: number | null = null;
  try {
    const stats = await fs.statfs(getDataDir());
    freeBytes = stats.bavail * stats.bsize;
  } catch { /* statfs is unavailable on some filesystems */ }

  const backlog = Number(dashboard.runtime.scheduler.backlog || 0);
  const schedulerStatus = String(dashboard.scheduler.status || 'unverified');
  const workerStatus = String(dashboard.worker.status || 'unverified');
  const sourceStatus = String(dashboard.inventory.diagnostic.sourceStatus || 'SOURCE_DEGRADED');
  const checks: ReadinessCheck[] = [
    check(storage.status === 'blocked' ? 'CRITICAL' : storage.status === 'degraded' ? 'WARNING' : 'PASS', 'STORAGE', `Critical storage is ${storage.status}.`, storage.status),
    check(freeBytes !== null && freeBytes < 256 * 1024 * 1024 ? 'CRITICAL' : freeBytes === null ? 'WARNING' : 'PASS', 'DISK', freeBytes === null ? 'Free disk space could not be measured.' : 'Free disk space measured.', freeBytes),
    check(['active', 'paused'].includes(workerStatus) ? 'PASS' : backlog > 0 ? 'CRITICAL' : 'WARNING', 'WORKER', `Worker runtime is ${workerStatus}.`, workerStatus),
    check(['active', 'paused', 'disabled'].includes(schedulerStatus) ? 'PASS' : 'CRITICAL', 'SCHEDULER', `Scheduler runtime is ${schedulerStatus}.`, schedulerStatus),
    check(backlog >= 100 ? 'CRITICAL' : backlog >= 25 ? 'WARNING' : 'PASS', 'QUEUE', `${backlog} durable jobs are waiting.`, backlog),
    check(sourceStatus === 'SOURCE_READY' ? 'PASS' : dashboard.inventory.diagnostic.totalProductRecords > 0 ? 'WARNING' : 'CRITICAL', 'SOURCE', `Source readiness is ${sourceStatus}.`, sourceStatus),
    check(dashboard.runtime.web.status === 'ready' || dashboard.runtime.web.status === 'alive' ? 'PASS' : 'WARNING', 'PUBLIC_ROUTE', `Stored public route status is ${dashboard.runtime.web.status}.`, dashboard.runtime.web.status),
    check(dashboard.control.killSwitch ? 'WARNING' : 'PASS', 'KILL_SWITCH', dashboard.control.killSwitch ? 'Kill switch is active; write lanes remain stopped.' : 'Kill switch is inactive.', dashboard.control.killSwitch),
  ];
  const status: CheckStatus = checks.some(item => item.status === 'CRITICAL') ? 'CRITICAL'
    : checks.some(item => item.status === 'WARNING') ? 'WARNING' : 'PASS';
  return {
    status,
    checks,
    runtime: dashboard.runtime,
    queue: dashboard.queue,
    source: { status: sourceStatus, publicProducts: dashboard.business.publicProducts },
    timestamp: new Date().toISOString(),
  };
}
