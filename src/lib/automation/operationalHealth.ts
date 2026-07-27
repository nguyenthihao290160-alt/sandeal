import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { listFeatureRolloutStates, type FeatureRolloutMode } from './featureRollout';
import { isCriticalAutomationJob } from './executionPolicy';
import { getRuntimeRecoveryCanaryPolicy, listRuntimeRecoveryCanaryPermits } from './runtimeRecoveryCanary';
import { getRuntimeRecoveryState, type RuntimeRecoveryState } from './runtimeRecoveryState';
import { getLatestRuntimeHealth } from './runtimeGuardian';
import { listRuntimeRoleLeases } from './runtimeRoles';
import { getLatestSloMeasurement, type AutomationSloMeasurement } from './sloErrorBudget';
import { getAllAutomationJobs, getAutomationControl } from './store';

const CURRENT_RUNTIME_MAX_AGE_MS = 3 * 60_000;

export interface AutomationOperationalHealth {
  generatedAt: string;
  currentActiveReasons: string[];
  historicalAuditReasons: string[];
  recovery: RuntimeRecoveryState | null;
  canary: {
    featureMode: FeatureRolloutMode;
    activeCount: number;
    maximumActive: number;
    latest: {
      permitId: string;
      status: string;
      issuedAt: string;
      expiresAt: string;
      outcomeReasonCode: string | null;
    } | null;
  };
  slo: {
    dataStatus: AutomationSloMeasurement['dataStatus'];
    evaluationStatus: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA' | null;
    windowStartedAt: string;
    windowEndedAt: string;
    pickupLatencyP50Ms: number | null;
    pickupLatencyP95Ms: number | null;
    pendingQueueAgeMs: number | null;
    pendingQueueCount: number;
    pickupLatencyMode: AutomationSloMeasurement['pickupLatencyMode'];
    pickupLatencyFeatureMode: FeatureRolloutMode;
  } | null;
  workerPool: {
    featureMode: FeatureRolloutMode;
    maximumSlots: number;
    activeSlots: number;
    availableSlots: number;
    criticalReservedCapacity: number;
    activeCriticalSlots: number;
    activeNormalSlots: number;
    capacityExceeded: boolean;
  };
  release: {
    embeddedReleaseId: string;
    runtimeReleaseId: string;
    gitCommitSha: string | null;
    publicBuildId: string;
    workerReleaseId: string | null;
    schedulerReleaseId: string | null;
    matchStatus: 'MATCH' | 'MISMATCH' | 'UNVERIFIED';
    mismatchReasons: string[];
  };
  operatorControls: {
    publishBlockedByOperator: boolean;
    publishBlockedByRuntime: boolean;
    publishBlockedByPolicy: boolean;
    effectivePublishPaused: boolean;
    emergencyStop: boolean;
  };
  featureRollouts: ReturnType<typeof listFeatureRolloutStates>;
}

function uniqueReasons(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function latestByIssuedAt<T extends { issuedAt: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt))[0];
}

export async function buildAutomationOperationalHealth(now = Date.now()): Promise<AutomationOperationalHealth> {
  const [
    jobs,
    settings,
    control,
    runtime,
    recovery,
    permits,
    leases,
    latestSlo,
  ] = await Promise.all([
    getAllAutomationJobs(),
    getAutomationSettings(),
    getAutomationControl(),
    getLatestRuntimeHealth(),
    getRuntimeRecoveryState(),
    listRuntimeRecoveryCanaryPermits(),
    listRuntimeRoleLeases(),
    getLatestSloMeasurement(),
  ]);
  const release = getReleaseIdentity();
  const features = listFeatureRolloutStates();
  const runtimeCheckedAt = Date.parse(runtime?.checkedAt || '');
  const runtimeFresh = Number.isFinite(runtimeCheckedAt)
    && runtimeCheckedAt <= now + 60_000
    && now - runtimeCheckedAt <= CURRENT_RUNTIME_MAX_AGE_MS;
  const workerLease = leases.find(lease =>
    lease.role === 'WORKER' && lease.status === 'ACTIVE' && Date.parse(lease.leaseExpiresAt) > now);
  const schedulerLease = leases.find(lease =>
    lease.role === 'SCHEDULER' && lease.status === 'ACTIVE' && Date.parse(lease.leaseExpiresAt) > now);
  const releaseMismatchReasons = uniqueReasons([
    ...release.releaseMismatchReasons,
    workerLease?.releaseId && workerLease.releaseId !== release.embeddedBuildId
      ? 'WORKER_RELEASE_MISMATCH'
      : undefined,
    schedulerLease?.releaseId && schedulerLease.releaseId !== release.embeddedBuildId
      ? 'SCHEDULER_RELEASE_MISMATCH'
      : undefined,
  ]);
  const identitiesPresent = Boolean(workerLease?.releaseId && schedulerLease?.releaseId);
  const matchStatus = releaseMismatchReasons.length
    ? 'MISMATCH'
    : identitiesPresent ? 'MATCH' : 'UNVERIFIED';
  const currentActiveReasons = uniqueReasons([
    ...(runtimeFresh
      ? runtime?.reasons || []
      : [runtime ? 'RUNTIME_HEALTH_SNAPSHOT_STALE' : 'RUNTIME_HEALTH_SNAPSHOT_MISSING']),
    ...(control.publishBlockedByRuntime ? control.publishRuntimeReasons || [] : []),
    ...(control.publishBlockedByPolicy ? control.publishPolicyReasons || [] : []),
    ...(recovery && recovery.state !== 'CLOSED_HEALTHY' ? recovery.currentApplicableReasons : []),
    ...releaseMismatchReasons,
    ...features
      .filter(feature => !feature.valid)
      .map(feature => `FEATURE_ROLLOUT_INVALID_VALUE:${feature.feature}`),
  ]);
  const historicalAuditReasons = uniqueReasons([
    ...(runtime?.historicalReasons || []),
    ...(!runtimeFresh ? runtime?.reasons || [] : []),
    ...(recovery?.originatingBreachReasons || []),
  ]).filter(reason => !currentActiveReasons.includes(reason));
  const runningJobs = jobs.filter(job => job.status === 'RUNNING');
  const activeCriticalSlots = runningJobs.filter(job =>
    job.executionCritical === true || isCriticalAutomationJob(job.type)).length;
  const maximumSlots = settings.maxConcurrency;
  const activeSlots = runningJobs.length;
  const latestPermit = latestByIssuedAt(permits);
  const activePermits = permits.filter(permit => ['ISSUED', 'CONSUMED'].includes(permit.status));
  const canaryMode = features.find(item => item.feature === 'RECOVERY_CANARY')?.mode || 'OFF';
  const workerPoolMode = features.find(item => item.feature === 'WORKER_CONTINUOUS_POOL_V2')?.mode || 'OFF';

  return {
    generatedAt: new Date(now).toISOString(),
    currentActiveReasons,
    historicalAuditReasons,
    recovery,
    canary: {
      featureMode: canaryMode,
      activeCount: activePermits.length,
      maximumActive: getRuntimeRecoveryCanaryPolicy().maximumActivePermits,
      latest: latestPermit ? {
        permitId: latestPermit.id,
        status: latestPermit.status,
        issuedAt: latestPermit.issuedAt,
        expiresAt: latestPermit.expiresAt,
        outcomeReasonCode: latestPermit.outcomeReasonCode || null,
      } : null,
    },
    slo: latestSlo ? {
      dataStatus: latestSlo.dataStatus,
      evaluationStatus: latestSlo.evaluation?.status || null,
      windowStartedAt: latestSlo.windowStartedAt,
      windowEndedAt: latestSlo.windowEndedAt,
      pickupLatencyP50Ms: latestSlo.pickupLatencyP50Ms ?? null,
      pickupLatencyP95Ms: latestSlo.pickupLatencyP95Ms,
      pendingQueueAgeMs: latestSlo.pendingQueueAgeMs ?? null,
      pendingQueueCount: latestSlo.pendingQueueCount ?? 0,
      pickupLatencyMode: latestSlo.pickupLatencyMode || 'LEGACY_CREATED_AT',
      pickupLatencyFeatureMode: latestSlo.pickupLatencyFeatureMode || 'SHADOW',
    } : null,
    workerPool: {
      featureMode: workerPoolMode,
      maximumSlots,
      activeSlots,
      availableSlots: Math.max(0, maximumSlots - activeSlots),
      criticalReservedCapacity: maximumSlots > 1 ? 1 : 0,
      activeCriticalSlots,
      activeNormalSlots: Math.max(0, activeSlots - activeCriticalSlots),
      capacityExceeded: activeSlots > maximumSlots,
    },
    release: {
      embeddedReleaseId: release.embeddedBuildId,
      runtimeReleaseId: release.runtimeReleaseId,
      gitCommitSha: release.gitCommitSha,
      publicBuildId: release.publicBuildId,
      workerReleaseId: workerLease?.releaseId || null,
      schedulerReleaseId: schedulerLease?.releaseId || null,
      matchStatus,
      mismatchReasons: releaseMismatchReasons,
    },
    operatorControls: {
      publishBlockedByOperator: control.publishPausedByOperator === true,
      publishBlockedByRuntime: control.publishBlockedByRuntime === true,
      publishBlockedByPolicy: control.publishBlockedByPolicy === true,
      effectivePublishPaused: control.publishPaused === true,
      emergencyStop: control.killSwitch === true || control.mode === 'EMERGENCY_STOP',
    },
    featureRollouts: features,
  };
}
