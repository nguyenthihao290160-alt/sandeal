import { getAllProducts } from '@/lib/storage/products';
import { listProductSources } from '@/lib/storage/productSources';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { buildOperationsOnboarding } from '@/lib/operations/onboarding';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { listOutboundEvents } from '@/lib/product-intelligence/growth';
import { AUTOMATION_POLICY_VERSION, listAutomationPolicies } from './policyRegistry';
import { getLatestRuntimeHealth } from './runtimeGuardian';
import { listRecentRuntimeRoleConflicts, listRuntimeRoleLeases, type RuntimeRole, type RuntimeRoleLease } from './runtimeRoles';
import {
  getAiUsage,
  getAllAutomationJobs,
  getAutomationControl,
  getAutomationQueueStats,
  getCircuit,
  listAutomationAudit,
  publicAutomationJob,
} from './store';
import type { AutomationJob } from './types';
import { buildLaunchInventoryOverview } from './launchInventory';

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metric(value: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const parsed = Number(value[key]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function reasonList(job: AutomationJob): string[] {
  const result = record(job.result);
  const candidates = [job.lastErrorCode, job.lastErrorMessage, result.reason, result.blockReason];
  for (const key of ['reasons', 'readinessReasons', 'quarantineReasons', 'limitations']) {
    if (Array.isArray(result[key])) candidates.push(...result[key] as unknown[]);
  }
  return [...new Set(candidates.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.slice(0, 240)))].slice(0, 8);
}

function jobDiagnostic(job?: AutomationJob) {
  if (!job) return null;
  return {
    id: job.id, type: job.type, status: job.status, outcomeStatus: job.outcomeStatus || null,
    updatedAt: job.updatedAt, nextRetryAt: job.nextRetryAt || null,
    lastErrorCode: job.lastErrorCode || null, lastErrorCategory: job.lastErrorCategory || null,
    lastErrorMessage: job.lastErrorMessage || null, retryable: job.retryable ?? null,
    deadLetterReason: job.deadLetterReason || null,
    reasons: reasonList(job), schemaVersion: job.schemaVersion,
    policyVersion: job.policyVersion, handlerVersion: job.handlerVersion,
  };
}

function roleDiagnostic(role: RuntimeRole, lease: RuntimeRoleLease | undefined, processStatus: string, now: number) {
  const expiresAtMs = Date.parse(lease?.expiresAt || lease?.leaseExpiresAt || '');
  const acquiredAtMs = Date.parse(lease?.acquiredAt || lease?.startedAt || '');
  const active = lease?.status === 'ACTIVE' && Number.isFinite(expiresAtMs) && expiresAtMs > now;
  return {
    role,
    status: processStatus,
    processStatus,
    activeRole: active,
    roleState: active ? 'active' : lease?.status === 'ACTIVE' ? 'stale' : lease ? 'standby' : 'unverified',
    owner: lease?.ownerId || lease?.holderId || null,
    instanceId: lease?.instanceId || null,
    pid: lease?.pid || null,
    heartbeatAt: lease?.heartbeatAt || null,
    acquiredAt: lease?.acquiredAt || lease?.startedAt || null,
    leaseAgeMs: Number.isFinite(acquiredAtMs) ? Math.max(0, now - acquiredAtMs) : null,
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    fencingToken: lease?.fencingToken || null,
    takeoverCount: lease?.takeoverCount || 0,
  };
}

export async function buildAutomationDashboard(range: DashboardRange) {
  const now = Date.now();
  const [jobs, products, sources, control, queue, usage, autopilotCircuit, geminiCircuit, audit, settings, runtimeHealth, roleLeases, roleConflicts, outboundEvents, inventory] = await Promise.all([
    getAllAutomationJobs(), getAllProducts(), listProductSources(), getAutomationControl(), getAutomationQueueStats(),
    getAiUsage(), getCircuit('autopilot'), getCircuit('gemini'), listAutomationAudit(1, 20), getAutomationSettings(),
    getLatestRuntimeHealth(), listRuntimeRoleLeases(), listRecentRuntimeRoleConflicts(now - 24 * 60 * 60_000), listOutboundEvents(),
    buildLaunchInventoryOverview(),
  ]);
  const start = rangeStart(range);
  const onboarding = await buildOperationsOnboarding();
  const current = jobs.filter(job => Date.parse(job.createdAt) >= start);
  const terminal = current.filter(job => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(job.status));
  const completed = current.filter(job => job.status === 'SUCCEEDED' && job.outcomeStatus !== 'PARTIALLY_COMPLETED');
  const workerHeartbeatMs = control.workerHeartbeatAt ? Date.parse(control.workerHeartbeatAt) : Number.NaN;
  const workerFresh = Number.isFinite(workerHeartbeatMs) && now - workerHeartbeatMs < 45_000;
  const schedulerHeartbeatMs = control.schedulerHeartbeatAt ? Date.parse(control.schedulerHeartbeatAt) : Number.NaN;
  const schedulerFresh = Number.isFinite(schedulerHeartbeatMs) && now - schedulerHeartbeatMs < 90_000;

  const pipeline = {
    sourceRequests: 0, sourceFound: 0, candidateQueued: 0, duplicateRejected: 0,
    validationRejected: 0, productCreated: 0, productUpdated: 0,
    publishEligible: 0, publishBlocked: 0, quarantined: 0, failed: 0, durationMs: 0,
  };
  for (const job of current) {
    const result = record(job.result);
    const summary = Object.keys(record(result.summary)).length ? record(result.summary) : result;
    pipeline.sourceRequests += metric(summary, 'sourceRequests');
    pipeline.sourceFound += metric(summary, 'sourceFound', 'found');
    pipeline.candidateQueued += metric(summary, 'candidateQueued', 'queued');
    pipeline.duplicateRejected += metric(summary, 'duplicateRejected', 'duplicate');
    pipeline.validationRejected += metric(summary, 'validationRejected', 'rejected') + metric(summary, 'discarded') + metric(summary, 'claimValidationFailed');
    pipeline.productCreated += metric(summary, 'productCreated', 'created');
    pipeline.productUpdated += metric(summary, 'productUpdated', 'updated');
    pipeline.publishEligible += metric(summary, 'publishEligible', 'seoReady');
    pipeline.publishBlocked += metric(summary, 'publishBlocked', 'seoBlocked');
    pipeline.failed += metric(summary, 'failed');
    pipeline.durationMs += jobDuration(job.startedAt, job.completedAt) || metric(result, 'durationMs');
    if (job.status === 'FAILED' && metric(summary, 'failed') === 0) pipeline.failed += 1;
  }
  pipeline.quarantined = products.filter(product => product.lifecycleState === 'QUARANTINED' && Date.parse(product.lifecycleUpdatedAt || product.updatedAt || '') >= start).length;

  const sortedJobs = [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const latestByType = (type: AutomationJob['type']) => sortedJobs.find(job => job.type === type);
  const latestError = sortedJobs.find(job => job.status === 'FAILED' || job.status === 'BLOCKED' || Boolean(job.lastErrorCode));
  const latestSchedulerJob = sortedJobs.find(job => job.requestedBy === 'scheduler');
  const latestSchedulerSuccess = sortedJobs.find(job => job.requestedBy === 'scheduler' && job.status === 'SUCCEEDED');
  const workerLease = roleLeases.find(item => item.role === 'WORKER');
  const schedulerLease = roleLeases.find(item => item.role === 'SCHEDULER');
  const latestSchedulerConflict = [...roleConflicts].filter(item => item.role === 'SCHEDULER').sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  const workerLeaseFresh = workerLease?.status === 'ACTIVE' && Date.parse(workerLease.leaseExpiresAt) > now;
  const schedulerLeaseFresh = schedulerLease?.status === 'ACTIVE' && Date.parse(schedulerLease.leaseExpiresAt) > now;
  const nextRunMs = Date.parse(control.schedulerNextRunAt || '');
  const schedulerNextRunOverdue = Number.isFinite(nextRunMs) && now - nextRunMs > 90_000;
  const workerRuntimeStatus = control.workerPaused ? 'paused'
    : workerLeaseFresh || workerFresh ? 'active'
      : workerLease || control.workerHeartbeatAt ? 'stale'
        : runtimeHealth?.worker.status === 'crashed' ? 'crashed' : 'unverified';
  const schedulerRuntimeStatus = control.schedulerPaused ? 'paused'
    : !settings.enabled ? 'disabled'
      : schedulerNextRunOverdue ? 'stale'
        : schedulerLeaseFresh || schedulerFresh ? 'active'
          : schedulerLease || control.schedulerHeartbeatAt ? 'stale'
            : runtimeHealth?.scheduler.status === 'crashed' ? 'crashed' : 'unverified';
  const schedulerBlockReason = schedulerRuntimeStatus === 'stale'
    ? schedulerNextRunOverdue ? 'NEXT_RUN_OVERDUE' : 'HEARTBEAT_OR_LEASE_STALE'
    : schedulerRuntimeStatus === 'paused' ? 'SCHEDULER_PAUSED'
      : schedulerRuntimeStatus === 'disabled' ? 'SCHEDULER_DISABLED' : null;
  const providerNames = new Set(['accessTrade', 'gemini', ...Object.keys(runtimeHealth?.providers || {})]);
  const providers = [...providerNames].map(id => {
    const stored = runtimeHealth?.providers[id] || runtimeHealth?.providers[id.toLowerCase()] || 'unverified';
    const configured = stored === 'unverified' ? null : stored !== 'not_configured';
    return {
      id, status: stored, configured, ready: stored === 'ready',
      degraded: ['degraded', 'circuit_open', 'rate_limited', 'invalid_credential', 'quota_exhausted', 'last_check_failed'].includes(stored),
      checkedAt: runtimeHealth?.checkedAt || null,
    };
  });
  const publishBlockReasons = [
    !settings.safePublish ? 'safe_publish_disabled' : '',
    !settings.launchEnabled ? 'launch_not_enabled' : '',
    control.killSwitch ? 'kill_switch_active' : '',
    control.publishPaused ? 'publish_paused' : '',
    !['CANARY', 'AUTONOMOUS'].includes(control.effectiveMode) ? 'effective_mode_not_publishable' : '',
  ].filter(Boolean);
  const brokenLinkStatuses = new Set(['broken', 'not_found', 'forbidden', 'affiliate_error', 'product_unavailable', 'server_error', 'error']);

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
    runtime: {
      web: { status: runtimeHealth?.web.status || 'unverified', checkedAt: runtimeHealth?.checkedAt || null },
      worker: roleDiagnostic('WORKER', workerLease, workerRuntimeStatus, now),
      scheduler: {
        ...roleDiagnostic('SCHEDULER', schedulerLease, schedulerRuntimeStatus, now),
        lastContenderState: latestSchedulerConflict ? 'rejected' : 'none',
        rejectedOwner: latestSchedulerConflict?.rejectedHolderId || null,
        rejectedAt: latestSchedulerConflict?.observedAt || null,
        lastSuccessfulTickAt: control.schedulerLastRunAt || null,
        nextRunAt: control.schedulerNextRunAt || null,
        blockReason: schedulerBlockReason,
        lastJobCreatedAt: latestSchedulerJob?.createdAt || null,
        lastSuccessAt: latestSchedulerSuccess?.completedAt || latestSchedulerSuccess?.updatedAt || null,
        backlog: queue.PENDING + queue.RETRY_SCHEDULED + queue.WAITING_FOR_MANUAL_INPUT + queue.WAITING_CHILDREN,
        errorRate: terminal.length ? Number((terminal.filter(job => job.status === 'FAILED').length / terminal.length).toFixed(4)) : null,
      },
      guardianCheckedAt: runtimeHealth?.checkedAt || null,
      reasons: runtimeHealth?.reasons || [],
    },
    worker: {
      status: workerRuntimeStatus,
      heartbeatAt: control.workerHeartbeatAt || null,
      workerId: control.workerId || null,
      currentJobId: control.workerCurrentJobId || null,
    },
    scheduler: {
      status: schedulerRuntimeStatus,
      lastRunAt: control.schedulerLastRunAt || null,
      nextRunAt: control.schedulerNextRunAt || null,
      timezone: control.timezone,
      blockReason: schedulerBlockReason,
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
    control: {
      mode: control.mode, effectiveMode: control.effectiveMode, publishPaused: control.publishPaused,
      ingestionPaused: control.ingestionPaused, workerPaused: control.workerPaused,
      schedulerPaused: control.schedulerPaused, killSwitch: control.killSwitch,
      launchEnabled: settings.launchEnabled, reason: control.reason || null,
      safePublish: { state: publishBlockReasons.length ? 'blocked' : 'ready', reasons: publishBlockReasons },
    },
    pipeline,
    jobs: {
      productScan: jobDiagnostic(latestByType('PRODUCT_SCAN')),
      autoPilot: jobDiagnostic(latestByType('AUTO_PILOT')),
      runtimeGuardian: jobDiagnostic(latestByType('RUNTIME_GUARDIAN')),
      latestError: jobDiagnostic(latestError),
    },
    providers,
    inventory,
    business: {
      publicProducts: products.filter(isPublicSafeProduct).length,
      freshPrice: products.filter(product => product.priceTruthState === 'FRESH').length,
      stalePrice: products.filter(product => ['STALE', 'CONFLICTED', 'ANOMALOUS', 'UNAVAILABLE'].includes(product.priceTruthState || '')).length,
      healthyAffiliateLinks: products.filter(product => ['ok', 'redirect_ok'].includes(product.affiliateHealthStatus || '') || product.offers?.some(offer => offer.affiliateHealth === 'HEALTHY')).length,
      brokenLinks: products.filter(product => brokenLinkStatuses.has(product.linkHealthStatus || '') || brokenLinkStatuses.has(product.affiliateHealthStatus || '')).length,
      outboundClicks: outboundEvents.filter(event => event.eventType === 'click' || event.eventType === 'OUTBOUND_CLICK').length,
      degradedProviders: providers.filter(provider => provider.degraded).map(provider => provider.id),
    },
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
    recentActivity: sortedJobs.slice(0, 10).map(job => ({
      ...publicAutomationJob(job), durationMs: jobDuration(job.startedAt, job.completedAt), payload: undefined,
    })),
    audit: audit.items,
  };
}
