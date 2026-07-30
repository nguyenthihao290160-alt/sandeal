import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import {
  reconcileCurrentReasons,
  type CurrentReasonReconciliation,
} from './currentReasonReconciler';
import {
  getWorkerPoolRolloutState,
  listFeatureRolloutStates,
  type FeatureRolloutMode,
  type WorkerPoolRolloutState,
} from './featureRollout';
import { isCriticalAutomationJob } from './executionPolicy';
import { getAutomationJobHealthView, type AutomationJobHealthView } from './jobHealthSummary';
import {
  getRuntimeRecoveryCanaryHealthView,
  getRuntimeRecoveryCanaryPolicy,
  type RuntimeRecoveryCanaryHealthView,
  type RuntimeRecoveryCanaryPermit,
} from './runtimeRecoveryCanary';
import { getRuntimeRecoveryState, type RuntimeRecoveryState } from './runtimeRecoveryState';
import { getLatestRuntimeHealth } from './runtimeGuardian';
import {
  listRecentRuntimeRoleConflicts,
  listRuntimeRoleLeases,
  type RuntimeRoleConflict,
} from './runtimeRoles';
import { getLatestSloMeasurement, type AutomationSloMeasurement } from './sloErrorBudget';
import { getAutomationControl } from './store';
import type { AutomationControlState } from './types';

const CURRENT_RUNTIME_MAX_AGE_MS = 3 * 60_000;

export interface AutomationOperationalHealth {
  generatedAt: string;
  currentActiveReasons: string[];
  currentPolicyReasons: string[];
  projectionQualityWarnings: string[];
  historicalAuditReasons: string[];
  reasonReconciliation: CurrentReasonReconciliation;
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
    evidence: {
      source: 'runtime-recovery-canary-health-v1';
      currentStateComplete: boolean;
      historyComplete: boolean;
      truncated: boolean;
      durableHistoryCount: number | null;
      reasonCodes: string[];
    };
  };
  slo: {
    dataStatus: AutomationSloMeasurement['dataStatus'];
    evaluationStatus: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA' | null;
    windowStartedAt: string;
    windowEndedAt: string;
    pickupLatencyP50Ms: number | null;
    pickupLatencyP95Ms: number | null;
    historicalPickupLatencyP50Ms: number | null;
    historicalPickupLatencyP95Ms: number | null;
    historicalPickupSampleCount: number;
    currentPickupLatencyP50Ms: number | null;
    currentPickupLatencyP95Ms: number | null;
    currentPickupSampleCount: number;
    excludedLegacyPickupCount: number;
    insufficientPickupTimestampCount: number;
    pickupMeasurementSemantics: AutomationSloMeasurement['pickupLatencyMeasurementSemantics'];
    pickupRolloutBoundary: AutomationSloMeasurement['pickupLatencyRolloutBoundary'];
    pickupReleaseBoundary: AutomationSloMeasurement['pickupLatencyReleaseBoundary'];
    pendingQueueAgeMs: number | null;
    pendingQueueCount: number;
    pickupLatencyMode: AutomationSloMeasurement['pickupLatencyMode'];
    pickupLatencyFeatureMode: FeatureRolloutMode;
  } | null;
  workerPool: {
    featureMode: FeatureRolloutMode;
    configuredMode: FeatureRolloutMode;
    effectiveMode: FeatureRolloutMode;
    effectiveModeSource: WorkerPoolRolloutState['effectiveModeSource'];
    implementationActive: boolean;
    maximumSlots: number;
    activeSlots: number;
    availableSlots: number;
    criticalReservedCapacity: number;
    activeCriticalSlots: number;
    activeNormalSlots: number;
    normalAvailableSlots: number;
    rolloutCohort: string;
    disabledReason: WorkerPoolRolloutState['disabledReason'];
    activationControl: WorkerPoolRolloutState['activationControl'];
    ordinaryFairness: 'BOUNDED_NORMAL_LANE_WITH_RESERVED_GUARDIAN_CAPACITY';
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

export interface AutomationOperationalHealthInputs {
  summary?: AutomationJobHealthView;
  settings?: Awaited<ReturnType<typeof getAutomationSettings>>;
  control?: AutomationControlState;
  runtime?: Awaited<ReturnType<typeof getLatestRuntimeHealth>>;
  recovery?: Awaited<ReturnType<typeof getRuntimeRecoveryState>>;
  permits?: RuntimeRecoveryCanaryPermit[];
  canaryHealth?: RuntimeRecoveryCanaryHealthView;
  leases?: Awaited<ReturnType<typeof listRuntimeRoleLeases>>;
  conflicts?: RuntimeRoleConflict[];
  latestSlo?: Awaited<ReturnType<typeof getLatestSloMeasurement>>;
}

function uniqueReasons(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function latestByIssuedAt<T extends { issuedAt: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt))[0];
}

function injectedCanaryHealth(
  permits: RuntimeRecoveryCanaryPermit[],
  now: number,
): RuntimeRecoveryCanaryHealthView {
  const activePermits = permits.filter(permit =>
    permit.status === 'CONSUMED'
    || (permit.status === 'ISSUED' && Date.parse(permit.expiresAt) > now));
  const latest = latestByIssuedAt(permits);
  const issuedAt = permits
    .map(permit => Date.parse(permit.issuedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    activeCount: activePermits.length,
    activePermits,
    latestPermit: latest || null,
    currentStateComplete: true,
    historyComplete: true,
    truncated: false,
    durableHistoryCount: permits.length,
    source: 'runtime-recovery-canary-health-v1',
    reasonCodes: ['RECOVERY_CANARY_HEALTH_INJECTED_FIXTURE'],
    observedRange: {
      earliestIssuedAt: issuedAt.length ? new Date(issuedAt[0]).toISOString() : null,
      latestIssuedAt: issuedAt.length ? new Date(issuedAt[issuedAt.length - 1]).toISOString() : null,
    },
    updatedAt: null,
  };
}

export async function buildAutomationOperationalHealth(
  now = Date.now(),
  inputs: AutomationOperationalHealthInputs = {},
): Promise<AutomationOperationalHealth> {
  const [
    summary,
    settings,
    control,
    runtime,
    recovery,
    canaryHealth,
    leases,
    conflicts,
    latestSlo,
  ] = await Promise.all([
    inputs.summary ?? getAutomationJobHealthView(now),
    inputs.settings ?? getAutomationSettings(),
    inputs.control ?? getAutomationControl(),
    inputs.runtime === undefined ? getLatestRuntimeHealth() : inputs.runtime,
    inputs.recovery === undefined ? getRuntimeRecoveryState() : inputs.recovery,
    inputs.canaryHealth
      ?? (inputs.permits
        ? injectedCanaryHealth(inputs.permits, now)
        : getRuntimeRecoveryCanaryHealthView(now)),
    inputs.leases ?? listRuntimeRoleLeases(),
    inputs.conflicts ?? listRecentRuntimeRoleConflicts(now - CURRENT_RUNTIME_MAX_AGE_MS),
    inputs.latestSlo === undefined ? getLatestSloMeasurement() : inputs.latestSlo,
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
  const canaryMode = features.find(item => item.feature === 'RECOVERY_CANARY')?.mode || 'OFF';
  const candidateCurrentReasons = uniqueReasons([
    ...(!summary.currentStateComplete ? ['JOB_HEALTH_CURRENT_STATE_INCOMPLETE'] : []),
    ...(runtimeFresh
      ? runtime?.reasons || []
      : [runtime ? 'RUNTIME_HEALTH_SNAPSHOT_STALE' : 'RUNTIME_HEALTH_SNAPSHOT_MISSING']),
    ...(control.publishBlockedByRuntime ? control.publishRuntimeReasons || [] : []),
    ...(recovery && recovery.state !== 'CLOSED_HEALTHY' ? recovery.currentApplicableReasons : []),
    ...releaseMismatchReasons,
    ...(canaryMode === 'ACTIVE' && !canaryHealth.currentStateComplete
      ? canaryHealth.reasonCodes
      : []),
    ...features
      .filter(feature => !feature.valid)
      .map(feature => `FEATURE_ROLLOUT_INVALID_VALUE:${feature.feature}`),
  ]);
  const candidateHistoricalReasons = uniqueReasons([
    ...(runtime?.historicalReasons || []),
    ...(!runtimeFresh ? runtime?.reasons || [] : []),
    ...(recovery?.originatingBreachReasons || []),
  ]);
  const reasonReconciliation = reconcileCurrentReasons({
    now,
    releaseId: release.releaseId,
    candidateCurrentReasons,
    historicalReasons: candidateHistoricalReasons,
    runtime,
    leases,
    conflicts,
    workerRequired: true,
    schedulerRequired: settings.enabled,
  });
  const currentActiveReasons = reasonReconciliation.currentActiveReasons;
  const historicalAuditReasons = reasonReconciliation.historicalAuditReasons;
  const currentPolicyReasons = uniqueReasons(
    control.publishBlockedByPolicy ? control.publishPolicyReasons || [] : [],
  );
  const projectionQualityWarnings = uniqueReasons(summary.reasonCodes);
  const runningJobs = summary.runningJobs;
  const activeCriticalSlots = runningJobs.filter(job =>
    job.executionCritical === true || isCriticalAutomationJob(job.type)).length;
  const maximumSlots = settings.maxConcurrency;
  const activeSlots = runningJobs.length;
  const latestPermit = canaryHealth.latestPermit;
  const workerPoolRollout = getWorkerPoolRolloutState();
  const criticalReservedCapacity = maximumSlots > 1 ? 1 : 0;
  const normalCapacity = Math.max(0, maximumSlots - criticalReservedCapacity);
  const activeNormalSlots = Math.max(0, activeSlots - activeCriticalSlots);

  return {
    generatedAt: new Date(now).toISOString(),
    currentActiveReasons,
    currentPolicyReasons,
    projectionQualityWarnings,
    historicalAuditReasons,
    reasonReconciliation,
    recovery,
    canary: {
      featureMode: canaryMode,
      activeCount: canaryHealth.activeCount,
      maximumActive: getRuntimeRecoveryCanaryPolicy().maximumActivePermits,
      latest: latestPermit ? {
        permitId: latestPermit.id,
        status: latestPermit.status,
        issuedAt: latestPermit.issuedAt,
        expiresAt: latestPermit.expiresAt,
        outcomeReasonCode: latestPermit.outcomeReasonCode || null,
      } : null,
      evidence: {
        source: canaryHealth.source,
        currentStateComplete: canaryHealth.currentStateComplete,
        historyComplete: canaryHealth.historyComplete,
        truncated: canaryHealth.truncated,
        durableHistoryCount: canaryHealth.durableHistoryCount,
        reasonCodes: canaryHealth.reasonCodes,
      },
    },
    slo: latestSlo ? {
      dataStatus: latestSlo.dataStatus,
      evaluationStatus: latestSlo.evaluation?.status || null,
      windowStartedAt: latestSlo.windowStartedAt,
      windowEndedAt: latestSlo.windowEndedAt,
      pickupLatencyP50Ms: latestSlo.pickupLatencyP50Ms ?? null,
      pickupLatencyP95Ms: latestSlo.pickupLatencyP95Ms,
      historicalPickupLatencyP50Ms: latestSlo.pickupLatencyHistoricalP50Ms ?? null,
      historicalPickupLatencyP95Ms: latestSlo.pickupLatencyHistoricalP95Ms ?? null,
      historicalPickupSampleCount: latestSlo.pickupLatencyHistoricalSampleCount ?? 0,
      currentPickupLatencyP50Ms: latestSlo.pickupLatencyCurrentP50Ms ?? null,
      currentPickupLatencyP95Ms: latestSlo.pickupLatencyCurrentP95Ms ?? null,
      currentPickupSampleCount: latestSlo.pickupLatencyCurrentSampleCount ?? 0,
      excludedLegacyPickupCount: latestSlo.pickupLatencyExcludedLegacyCount ?? 0,
      insufficientPickupTimestampCount: latestSlo.pickupLatencyInsufficientTimestampCount ?? 0,
      pickupMeasurementSemantics: latestSlo.pickupLatencyMeasurementSemantics || {
        historical: 'LEGACY_CREATED_AT',
        current: 'EXPLICIT_RUNNABLE_AT_CURRENT_RELEASE',
      },
      pickupRolloutBoundary: latestSlo.pickupLatencyRolloutBoundary || {
        cohort: `SLO_RUNNABLE_AT_V2:${latestSlo.pickupLatencyFeatureMode || 'SHADOW'}`,
        startedAt: null,
      },
      pickupReleaseBoundary: latestSlo.pickupLatencyReleaseBoundary || {
        releaseId: release.releaseId,
        startedAt: null,
      },
      pendingQueueAgeMs: latestSlo.pendingQueueAgeMs ?? null,
      pendingQueueCount: latestSlo.pendingQueueCount ?? 0,
      pickupLatencyMode: latestSlo.pickupLatencyMode || 'LEGACY_CREATED_AT',
      pickupLatencyFeatureMode: latestSlo.pickupLatencyFeatureMode || 'SHADOW',
    } : null,
    workerPool: {
      featureMode: workerPoolRollout.effectiveMode,
      configuredMode: workerPoolRollout.configuredMode,
      effectiveMode: workerPoolRollout.effectiveMode,
      effectiveModeSource: workerPoolRollout.effectiveModeSource,
      implementationActive: workerPoolRollout.implementationActive,
      maximumSlots,
      activeSlots,
      availableSlots: Math.max(0, maximumSlots - activeSlots),
      criticalReservedCapacity,
      activeCriticalSlots,
      activeNormalSlots,
      normalAvailableSlots: Math.max(0, normalCapacity - activeNormalSlots),
      rolloutCohort: workerPoolRollout.rolloutCohort,
      disabledReason: workerPoolRollout.disabledReason,
      activationControl: workerPoolRollout.activationControl,
      ordinaryFairness: 'BOUNDED_NORMAL_LANE_WITH_RESERVED_GUARDIAN_CAPACITY',
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
