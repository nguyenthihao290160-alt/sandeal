import { getGeminiProviderReadiness } from '@/lib/ai/geminiProviderStatus';
import { deriveSystemCapabilityStatus } from '@/lib/health/systemCapability';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';
import { buildAutomationOperationalHealth } from './operationalHealth';
import { getAutomationJobHealthView, publicAutomationJobHealthView } from './jobHealthSummary';
import { getLatestRuntimeHealth, providerHealth } from './runtimeGuardian';
import { listRuntimeRoleLeases } from './runtimeRoles';
import { DEFAULT_CONTROL, getAiUsage, getAutomationControl, getCircuit } from './store';

export type AutomationHealthComponentStatus =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'insufficient_data';

export interface AutomationHealthComponent {
  status: AutomationHealthComponentStatus;
  checkedAt: string;
  stale: boolean;
  reasonCode: string;
}

export interface AutomationHealthDependencies {
  getSummary: typeof getAutomationJobHealthView;
  getSettings: typeof getAutomationSettings;
  getControl: typeof getAutomationControl;
  getRuntime: typeof getLatestRuntimeHealth;
  getLeases: typeof listRuntimeRoleLeases;
  getUsage: typeof getAiUsage;
  getCircuit: typeof getCircuit;
  getGeminiReadiness: typeof getGeminiProviderReadiness;
  getAccessTradeCredential: () => ReturnType<typeof getPrimaryCredential>;
  buildOperational: typeof buildAutomationOperationalHealth;
}

const DEFAULT_DEPENDENCIES: AutomationHealthDependencies = {
  getSummary: getAutomationJobHealthView,
  getSettings: getAutomationSettings,
  getControl: getAutomationControl,
  getRuntime: getLatestRuntimeHealth,
  getLeases: listRuntimeRoleLeases,
  getUsage: getAiUsage,
  getCircuit,
  getGeminiReadiness: getGeminiProviderReadiness,
  getAccessTradeCredential: () => getPrimaryCredential('accesstrade'),
  buildOperational: buildAutomationOperationalHealth,
};

interface ComponentResult<T> {
  meta: AutomationHealthComponent;
  value?: T;
}

function safeReasonCode(value: string): string {
  return value.replace(/[^A-Z0-9_:-]/gi, '_').toUpperCase().slice(0, 120) || 'COMPONENT_UNAVAILABLE';
}

function jobEvidenceReason(input: {
  evidenceClassification: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';
  reasonCodes: string[];
}): string {
  return input.reasonCodes[0]
    || (input.evidenceClassification === 'COMPLETE'
      ? 'OK'
      : input.evidenceClassification === 'UNAVAILABLE'
        ? 'JOB_READ_MODEL_UNAVAILABLE'
        : 'JOB_READ_MODEL_INCOMPLETE');
}

async function component<T>(
  name: string,
  timeoutMs: number,
  work: () => Promise<T>,
  options: {
    classify?: (value: T) => Pick<AutomationHealthComponent, 'status' | 'stale' | 'reasonCode'>;
  } = {},
): Promise<ComponentResult<T>> {
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('COMPONENT_TIMEOUT')), timeoutMs);
      }),
    ]);
    const classified = options.classify?.(value) || {
      status: 'available' as const,
      stale: false,
      reasonCode: 'OK',
    };
    const meta = { ...classified, checkedAt };
    console.info(JSON.stringify({
      type: 'automation_health_component',
      component: name,
      status: meta.status,
      durationMs: Math.round(performance.now() - startedAt),
      reasonCode: meta.reasonCode,
    }));
    return { meta, value };
  } catch (error) {
    const reasonCode = error instanceof Error && error.message === 'COMPONENT_TIMEOUT'
      ? 'COMPONENT_TIMEOUT'
      : 'COMPONENT_UNAVAILABLE';
    console.warn(JSON.stringify({
      type: 'automation_health_component',
      component: name,
      status: 'unavailable',
      durationMs: Math.round(performance.now() - startedAt),
      reasonCode,
    }));
    return {
      meta: {
        status: 'unavailable',
        checkedAt,
        stale: false,
        reasonCode: safeReasonCode(reasonCode),
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function roleStatus(
  role: 'WORKER' | 'SCHEDULER',
  input: {
    paused: boolean;
    enabled?: boolean;
    runtimeStatus?: string;
    lease?: Awaited<ReturnType<typeof listRuntimeRoleLeases>>[number];
    heartbeatAt?: string;
    now: number;
  },
): string {
  if (input.paused) return 'paused';
  if (role === 'SCHEDULER' && input.enabled === false) return 'disabled';
  const activeLease = input.lease?.status === 'ACTIVE'
    && Date.parse(input.lease.leaseExpiresAt || input.lease.expiresAt || '') > input.now;
  if (activeLease && input.runtimeStatus === 'active') return 'active';
  if (input.runtimeStatus === 'crashed') return 'crashed';
  if (input.lease?.heartbeatAt || input.heartbeatAt) return 'stale';
  return 'unverified';
}

function heartbeatAge(value: string | undefined, now: number): number | null {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

function failClosedCore(generatedAt: string) {
  const control = {
    ...DEFAULT_CONTROL,
    publishBlockedByRuntime: true,
    publishRuntimeReasons: ['APP_HEALTH_CORE_UNAVAILABLE'],
    publishPaused: true,
    reason: 'APP_HEALTH_CORE_UNAVAILABLE',
    updatedAt: generatedAt,
  };
  const worker = {
    status: 'unverified',
    heartbeatAt: null,
    heartbeatAgeMs: null,
    heartbeatSource: 'unavailable',
    staleAgeMs: null,
    releaseId: null,
    workerId: null,
    currentJobId: null,
  };
  const scheduler = {
    status: 'unverified',
    heartbeatAt: null,
    heartbeatAgeMs: null,
    heartbeatSource: 'unavailable',
    staleAgeMs: null,
    releaseId: null,
    lastRunAt: null,
    nextRunAt: null,
    timezone: 'Asia/Ho_Chi_Minh',
    scheduleState: 'UNVERIFIED',
    scheduleWarning: 'APP_HEALTH_CORE_UNAVAILABLE',
  };
  const release = getReleaseIdentity();
  const capabilities = deriveSystemCapabilityStatus({
    web: { status: 'unhealthy' },
    worker,
    scheduler,
    queue: { pending: 0, running: 0, stuck: 1, staleJobs: 0 },
    control,
    runtime: null,
    release,
    ai: { providerStatus: 'unavailable', budgetAvailable: false, policyAllowed: false },
  });
  return {
    release,
    web: { status: 'unhealthy', buildAvailable: false, publicRouteHealthy: null },
    readiness: 'paused',
    capabilities,
    operationalStatus: capabilities.operationalStatus,
    publishingStatus: capabilities.publishingStatus,
    aiStatus: capabilities.aiStatus,
    emergencyStatus: capabilities.emergencyStatus,
    overallStatus: capabilities.overallStatus,
    overallLabel: capabilities.overallLabel,
    worker,
    scheduler,
    queue: {
      PENDING: 0,
      RUNNING: 0,
      RETRY_SCHEDULED: 0,
      WAITING_APPROVAL: 0,
      WAITING_FOR_MANUAL_INPUT: 0,
      WAITING_CHILDREN: 0,
      PAUSED: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      CANCELLED: 0,
      BLOCKED: 0,
    },
    aiUsage: { requests: 0, requestLimit: 0, tokens: 0, tokenLimit: 0, blocked: 0 },
    circuits: [],
    policy: { safeMode: true, freeOnly: true, safePublish: false, allowPaidAi: false },
    providers: { gemini: 'unavailable', accessTrade: 'unavailable' },
    providerDetails: { gemini: null },
    runtime: null,
    operational: null,
    control,
    killSwitch: control.killSwitch,
    updatedAt: generatedAt,
    jobReadModel: null,
  };
}

export async function buildAutomationHealthResponse(
  options: {
    now?: number;
    dependencies?: Partial<AutomationHealthDependencies>;
    budgets?: { coreMs?: number; providerMs?: number; operationalMs?: number };
  } = {},
) {
  const now = options.now ?? Date.now();
  const generatedAt = new Date(now).toISOString();
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const coreMs = Math.max(100, options.budgets?.coreMs ?? 3_000);
  const providerMs = Math.max(100, options.budgets?.providerMs ?? 1_500);
  const operationalMs = Math.max(100, options.budgets?.operationalMs ?? 1_200);

  const geminiPromise = component('provider_gemini', providerMs, dependencies.getGeminiReadiness);
  const accessTradePromise = component('provider_accesstrade', providerMs, dependencies.getAccessTradeCredential);
  const core = await component('core_runtime', coreMs, async () => {
    const [summary, settings, control, runtime, leases, usage, autopilotCircuit, geminiCircuit] = await Promise.all([
      dependencies.getSummary(now),
      dependencies.getSettings(),
      dependencies.getControl(),
      dependencies.getRuntime(),
      dependencies.getLeases(),
      dependencies.getUsage(now),
      dependencies.getCircuit('autopilot'),
      dependencies.getCircuit('gemini'),
    ]);
    return { summary, settings, control, runtime, leases, usage, autopilotCircuit, geminiCircuit };
  });
  const [gemini, accessTrade] = await Promise.all([geminiPromise, accessTradePromise]);

  const components: Record<string, AutomationHealthComponent> = {
    core: core.meta,
    historySummary: core.value
      ? {
          status: core.value.summary.evidenceClassification === 'COMPLETE'
            ? 'available'
            : core.value.summary.evidenceClassification === 'UNAVAILABLE' ? 'unavailable' : 'degraded',
          checkedAt: generatedAt,
          stale: core.value.summary.stale,
          reasonCode: jobEvidenceReason(core.value.summary),
        }
      : core.meta,
    providerGemini: gemini.meta,
    providerAccessTrade: accessTrade.meta,
  };

  if (!core.value) {
    return {
      generatedAt,
      partial: true,
      components,
      ...failClosedCore(generatedAt),
    };
  }

  const { summary, settings, control, runtime, leases, usage, autopilotCircuit, geminiCircuit } = core.value;
  const runtimeCheckedAtMs = Date.parse(runtime?.checkedAt || '');
  const runtimeFromFuture = Number.isFinite(runtimeCheckedAtMs) && runtimeCheckedAtMs > now + 60_000;
  const runtimeAgeMs = Number.isFinite(runtimeCheckedAtMs)
    ? now - runtimeCheckedAtMs
    : Number.POSITIVE_INFINITY;
  const runtimeFresh = Boolean(runtime)
    && !runtimeFromFuture
    && Number.isFinite(runtimeAgeMs)
    && runtimeAgeMs <= 3 * 60_000;
  components.runtime = {
    status: runtimeFresh ? 'available' : runtime ? 'degraded' : 'unavailable',
    checkedAt: runtime?.checkedAt || generatedAt,
    stale: Boolean(runtime && !runtimeFresh),
    reasonCode: runtime
      ? runtimeFromFuture
        ? 'RUNTIME_HEALTH_SNAPSHOT_FUTURE'
        : runtimeFresh ? 'OK' : 'RUNTIME_HEALTH_SNAPSHOT_STALE'
      : 'RUNTIME_HEALTH_SNAPSHOT_MISSING',
  };
  const operational = await component('operational_health', operationalMs, () => dependencies.buildOperational(now, {
    summary,
    settings,
    control,
    runtime,
    leases,
  }));
  components.operational = operational.meta;
  components.slo = operational.value?.slo
    ? {
        status: operational.value.slo.dataStatus === 'MEASURED' || operational.value.slo.dataStatus === 'RECOVERY'
          ? 'available'
          : 'insufficient_data',
        checkedAt: operational.value.slo.windowEndedAt,
        stale: false,
        reasonCode: operational.value.slo.dataStatus === 'MEASURED' || operational.value.slo.dataStatus === 'RECOVERY'
          ? 'OK'
          : 'SLO_DATA_INSUFFICIENT',
      }
    : {
        status: 'insufficient_data',
        checkedAt: generatedAt,
        stale: false,
        reasonCode: 'SLO_MEASUREMENT_MISSING',
      };

  const workerLease = leases.find(item => item.role === 'WORKER');
  const schedulerLease = leases.find(item => item.role === 'SCHEDULER');
  const workerHeartbeat = workerLease?.heartbeatAt || control.workerHeartbeatAt;
  const schedulerHeartbeat = schedulerLease?.heartbeatAt || control.schedulerHeartbeatAt;
  const worker = {
    status: roleStatus('WORKER', {
      paused: control.workerPaused,
      runtimeStatus: runtimeFresh ? runtime?.worker.status : undefined,
      lease: workerLease,
      heartbeatAt: workerHeartbeat,
      now,
    }),
    heartbeatAt: workerHeartbeat || null,
    heartbeatAgeMs: heartbeatAge(workerHeartbeat, now),
    heartbeatSource: workerLease?.heartbeatAt ? 'role_lease' : control.workerHeartbeatAt ? 'control_state' : 'missing',
    staleAgeMs: heartbeatAge(workerHeartbeat, now),
    releaseId: workerLease?.releaseId || null,
    workerId: control.workerId || workerLease?.holderId || null,
    currentJobId: control.workerCurrentJobId || null,
  };
  const scheduler = {
    status: roleStatus('SCHEDULER', {
      paused: control.schedulerPaused,
      enabled: settings.enabled,
      runtimeStatus: runtimeFresh ? runtime?.scheduler.status : undefined,
      lease: schedulerLease,
      heartbeatAt: schedulerHeartbeat,
      now,
    }),
    heartbeatAt: schedulerHeartbeat || null,
    heartbeatAgeMs: heartbeatAge(schedulerHeartbeat, now),
    heartbeatSource: schedulerLease?.heartbeatAt ? 'role_lease' : control.schedulerHeartbeatAt ? 'control_state' : 'missing',
    staleAgeMs: heartbeatAge(schedulerHeartbeat, now),
    releaseId: schedulerLease?.releaseId || null,
    lastRunAt: control.schedulerLastRunAt || null,
    nextRunAt: control.schedulerNextRunAt || null,
    timezone: control.timezone,
    scheduleState: settings.enabled && !control.schedulerPaused ? 'ENABLED' : 'PAUSED',
    scheduleWarning: null,
  };
  const queue = { ...summary.statusCounts };
  const accessTradeConfigured = Boolean(accessTrade.value && accessTrade.value.status !== 'disabled')
    || Boolean(process.env.ACCESS_TRADE_API_KEY?.trim());
  const runtimeGemini = runtimeFresh ? runtime?.providers.gemini : undefined;
  const geminiStatus = gemini.value
    ? gemini.value.status === 'ready'
      && ['circuit_open', 'rate_limited', 'quota_exhausted', 'last_check_failed'].includes(String(runtimeGemini || ''))
      ? 'degraded'
      : gemini.value.status
    : 'unavailable';
  const providers = {
    gemini: geminiStatus,
    accessTrade: (runtimeFresh ? runtime?.providers.accessTrade : undefined)
      || (accessTrade.meta.status === 'unavailable'
        ? 'unavailable'
        : providerHealth({ configured: accessTradeConfigured, adapterAvailable: true })),
  };
  const release = getReleaseIdentity();
  const healthEvidenceReasons = [
    ...(summary.currentStateComplete
      ? []
      : [summary.evidenceClassification === 'UNAVAILABLE'
        ? 'JOB_READ_MODEL_UNAVAILABLE'
        : 'JOB_READ_MODEL_INCOMPLETE']),
    ...(runtimeFresh
      ? []
      : [runtime
          ? runtimeFromFuture ? 'RUNTIME_HEALTH_SNAPSHOT_FUTURE' : 'RUNTIME_HEALTH_SNAPSHOT_STALE'
          : 'RUNTIME_HEALTH_SNAPSHOT_MISSING']),
  ];
  const capabilityControl = healthEvidenceReasons.length
    ? {
        ...control,
        publishBlockedByRuntime: true,
        publishRuntimeReasons: [...new Set([
          ...(control.publishRuntimeReasons || []),
          ...healthEvidenceReasons,
        ])],
      }
    : control;
  const capabilities = deriveSystemCapabilityStatus({
    web: runtimeFresh ? runtime?.web : undefined,
    worker,
    scheduler,
    queue: {
      pending: queue.PENDING + queue.RETRY_SCHEDULED,
      running: queue.RUNNING,
      stuck: Number(runtime?.queue.stuck || 0) || (summary.stuckPendingCount > 0 ? 1 : 0),
      staleJobs: Math.max(runtime?.queue.staleJobs || 0, summary.staleRunningCount),
    },
    control: capabilityControl,
    runtime: runtimeFresh ? runtime : null,
    release,
    ai: {
      providerStatus: providers.gemini,
      budgetAvailable: usage.requests < usage.requestLimit && usage.tokens < usage.tokenLimit,
      policyAllowed: settings.freeOnly || settings.allowPaidAi,
    },
  });
  const partial = Object.values(components).some(item => item.status !== 'available');
  const readiness = capabilities.overallStatus === 'OPERATIONAL' && !partial
    ? 'active'
    : capabilities.overallStatus === 'EMERGENCY_STOP' || capabilities.overallStatus === 'PAUSED'
      ? 'paused'
      : 'degraded';

  return {
    generatedAt,
    partial,
    components,
    release,
    web: runtimeFresh
      ? runtime?.web
      : { status: 'alive', buildAvailable: process.env.NODE_ENV !== 'production', publicRouteHealthy: null },
    readiness,
    capabilities,
    operationalStatus: capabilities.operationalStatus,
    publishingStatus: capabilities.publishingStatus,
    aiStatus: capabilities.aiStatus,
    emergencyStatus: capabilities.emergencyStatus,
    overallStatus: capabilities.overallStatus,
    overallLabel: capabilities.overallLabel,
    worker,
    scheduler,
    queue,
    aiUsage: usage,
    circuits: [autopilotCircuit, geminiCircuit],
    policy: {
      safeMode: true,
      freeOnly: settings.freeOnly,
      safePublish: settings.safePublish,
      allowPaidAi: settings.allowPaidAi,
    },
    providers,
    providerDetails: { gemini: gemini.value || null },
    runtime: runtime ? {
      dataStatus: runtimeFresh ? 'CURRENT' : 'STALE',
      publishSafe: runtime.publishSafe,
      reasons: [...new Set([
        ...(operational.value?.currentActiveReasons || runtime.reasons),
        ...healthEvidenceReasons,
      ])],
      currentReasons: [...new Set([
        ...(operational.value?.currentActiveReasons || runtime.reasons),
        ...healthEvidenceReasons,
      ])],
      historicalReasons: operational.value?.historicalAuditReasons || runtime.historicalReasons || [],
      restart: runtime.restart || null,
      storage: runtime.storage,
      duplicateRoles: runtime.duplicateRoles,
      checkedAt: runtime.checkedAt,
    } : null,
    operational: operational.value || null,
    control,
    killSwitch: control.killSwitch,
    updatedAt: generatedAt,
    jobReadModel: publicAutomationJobHealthView(summary),
    healthEvidence: {
      publishingBlocked: healthEvidenceReasons.length > 0,
      reasonCodes: healthEvidenceReasons,
    },
  };
}
