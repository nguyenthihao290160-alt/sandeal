import { getAllProducts } from '@/lib/storage/products';
import { listProductSources } from '@/lib/storage/productSources';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { buildOperationsOnboarding } from '@/lib/operations/onboarding';
import { AUTOMATION_POLICY_VERSION, listAutomationPolicies } from './policyRegistry';
import {
  getAiUsage,
  getAllAutomationJobs,
  getAutomationControl,
  getAutomationQueueStats,
  getCircuit,
  listAutomationAudit,
  publicAutomationJob,
} from './store';

export type DashboardRange = 'today' | '7d' | '30d';

function rangeStart(range: DashboardRange, now = Date.now()): number {
  if (range === 'today') {
    const local = new Date(now + 7 * 60 * 60_000).toISOString().slice(0, 10);
    return Date.parse(`${local}T00:00:00+07:00`);
  }
  return now - (range === '7d' ? 7 : 30) * 24 * 60 * 60_000;
}

function jobDuration(startedAt?: string, completedAt?: string): number | null {
  if (!startedAt || !completedAt) return null;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export async function buildAutomationDashboard(range: DashboardRange) {
  const [jobs, products, sources, control, queue, usage, autopilotCircuit, geminiCircuit, audit, settings] = await Promise.all([
    getAllAutomationJobs(), getAllProducts(), listProductSources(), getAutomationControl(), getAutomationQueueStats(),
    getAiUsage(), getCircuit('autopilot'), getCircuit('gemini'), listAutomationAudit(1, 20), getAutomationSettings(),
  ]);
  const start = rangeStart(range);
  const onboarding = await buildOperationsOnboarding();
  const current = jobs.filter(job => Date.parse(job.createdAt) >= start);
  const terminal = current.filter(job => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(job.status));
  const completed = current.filter(job => job.status === 'SUCCEEDED' && job.outcomeStatus !== 'PARTIALLY_COMPLETED');
  const workerHeartbeatMs = control.workerHeartbeatAt ? Date.parse(control.workerHeartbeatAt) : Number.NaN;
  const workerFresh = Number.isFinite(workerHeartbeatMs) && Date.now() - workerHeartbeatMs < 45_000;
  const schedulerHeartbeatMs = control.schedulerHeartbeatAt ? Date.parse(control.schedulerHeartbeatAt) : Number.NaN;
  const schedulerFresh = Number.isFinite(schedulerHeartbeatMs) && Date.now() - schedulerHeartbeatMs < 90_000;

  const activityMap = new Map<string, { label: string; completed: number; failed: number; retried: number; blocked: number; scanned: number }>();
  for (const job of current) {
    const date = new Date(Date.parse(job.updatedAt) + 7 * 60 * 60_000);
    const label = range === 'today' ? `${String(date.getUTCHours()).padStart(2, '0')}:00` : `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = activityMap.get(label) || { label, completed: 0, failed: 0, retried: 0, blocked: 0, scanned: 0 };
    if (job.status === 'SUCCEEDED') bucket.completed += 1;
    if (job.status === 'FAILED') bucket.failed += 1;
    if (job.status === 'RETRY_SCHEDULED') bucket.retried += 1;
    if (job.status === 'BLOCKED') bucket.blocked += 1;
    if (typeof job.result?.inspected === 'number') bucket.scanned += job.result.inspected;
    activityMap.set(label, bucket);
  }

  const sourceMap = new Map<string, { name: string; total: number; valid: number }>();
  for (const product of products) {
    const name = product.source || 'other';
    const source = sourceMap.get(name) || { name, total: 0, valid: 0 };
    source.total += 1;
    if (product.status === 'approved' || product.status === 'published') source.valid += 1;
    sourceMap.set(name, source);
  }

  return {
    updatedAt: new Date().toISOString(), range,
    kpis: {
      productsProcessed: products.length,
      running: queue.RUNNING,
      waiting: queue.PENDING + queue.RETRY_SCHEDULED + queue.WAITING_FOR_MANUAL_INPUT + queue.WAITING_CHILDREN,
      waitingApproval: queue.WAITING_APPROVAL,
      completionRate: terminal.length ? Math.round((completed.length / terminal.length) * 100) : null,
      systemErrors: queue.FAILED,
    },
    activity: [...activityMap.values()],
    sourcePerformance: [...sourceMap.values()].sort((a, b) => b.valid - a.valid).slice(0, 6).map(item => ({ ...item, rate: item.total ? Math.min(100, Math.round(item.valid / item.total * 100)) : 0 })),
    queue,
    worker: {
      status: control.workerPaused ? 'paused' : workerFresh ? 'active' : control.workerHeartbeatAt ? 'stale' : 'unverified',
      heartbeatAt: control.workerHeartbeatAt || null,
      workerId: control.workerId || null,
      currentJobId: control.workerCurrentJobId || null,
    },
    scheduler: {
      status: control.schedulerPaused ? 'paused' : !settings.enabled ? 'not_configured' : schedulerFresh ? 'active' : control.schedulerHeartbeatAt ? 'stale' : 'unverified',
      lastRunAt: control.schedulerLastRunAt || null,
      nextRunAt: control.schedulerNextRunAt || null,
      timezone: control.timezone,
    },
    aiUsage: { ...usage, freeOnly: settings.freeOnly },
    policy: {
      version: AUTOMATION_POLICY_VERSION,
      safeMode: true,
      freeOnly: settings.freeOnly,
      safePublish: settings.safePublish,
      allowPaidAi: settings.allowPaidAi,
      capabilities: listAutomationPolicies().map(item => ({
        capability: item.capability,
        jobType: item.jobType,
        autonomousAllowed: item.autonomousAllowed,
        approvalMode: item.approvalMode,
        publishPermission: item.publishPermission,
        budgetClass: item.budgetClass,
        handlerVersion: item.handlerVersion,
      })),
    },
    circuits: [autopilotCircuit, geminiCircuit],
    control: { mode: control.mode, effectiveMode: control.effectiveMode, publishPaused: control.publishPaused, ingestionPaused: control.ingestionPaused, workerPaused: control.workerPaused, schedulerPaused: control.schedulerPaused, killSwitch: control.killSwitch, reason: control.reason || null },
    sources: { configured: sources.length, products: products.length },
    zeroData: !onboarding.hasOperationalData,
    onboarding,
    groups: {
      workItems: { waitingApproval: queue.WAITING_APPROVAL, waitingManual: queue.WAITING_FOR_MANUAL_INPUT, failed: queue.FAILED, openAlerts: onboarding.facts.openAlerts },
      dataReadiness: { products: onboarding.facts.products, enabledSources: onboarding.facts.sources, pendingSources: onboarding.facts.pendingSources, unscored: onboarding.facts.unscored },
      qualityContent: { scored: onboarding.facts.scored, drafts: onboarding.facts.drafts, editorialChecked: onboarding.facts.editorialChecked },
      botOperations: { running: queue.RUNNING, waiting: queue.PENDING + queue.RETRY_SCHEDULED + queue.WAITING_CHILDREN, waitingManual: queue.WAITING_FOR_MANUAL_INPUT },
      growth: { published: onboarding.facts.published, outboundEvents: onboarding.facts.outboundEvents, openAlerts: onboarding.facts.openAlerts },
    },
    recentActivity: jobs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 10).map(job => ({
      ...publicAutomationJob(job), durationMs: jobDuration(job.startedAt, job.completedAt), payload: undefined,
    })),
    audit: audit.items,
  };
}
