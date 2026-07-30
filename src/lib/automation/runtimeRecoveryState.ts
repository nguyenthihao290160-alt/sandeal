import { createHash } from 'node:crypto';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { FeatureRolloutMode } from './featureRollout';

const COLLECTION = 'runtime-recovery-state';
const RECORD_ID = 'runtime-recovery';

export const RUNTIME_RECOVERY_SCHEMA_VERSION = 2;
export const DEFAULT_RECOVERY_REQUIRED_HEALTHY_COUNT = 3;
export const DEFAULT_RECOVERY_MAXIMUM_EVIDENCE_AGE_MS = 2 * 60_000;

export type RuntimeRecoveryPhase =
  | 'CLOSED_HEALTHY'
  | 'OPEN_BLOCKED'
  | 'RECOVERY_OBSERVING'
  | 'HALF_OPEN'
  | 'RECOVERED_PENDING_CONFIRMATION';

export type RuntimeRecoveryMeasurementState =
  | 'MEASURED'
  | 'INSUFFICIENT_DATA'
  | 'NOT_APPLICABLE'
  | 'BOOTSTRAP'
  | 'RECOVERY';

export interface RuntimeRecoveryEvidenceSummary {
  measurementState: RuntimeRecoveryMeasurementState;
  evaluationStatus: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA';
  evaluatedAt?: string;
  maximumEvidenceAgeMs: number;
  reasonCodes: string[];
  terminalJobSamples: number;
  pickupLatencyP95Ms?: number | null;
  pendingQueueAgeMs?: number | null;
  publicationAttempts: number;
  monitorOutcomes: number;
  publicProducts: number;
}

export type RuntimeRecoveryReasonMeasurement = 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA' | 'NOT_APPLICABLE';

export interface RuntimeRecoveryReasonProgress {
  reasonCode: string;
  metricKey: string;
  measurement: RuntimeRecoveryReasonMeasurement;
  consecutiveHealthyCount: number;
  requiredHealthyCount: number;
  lastEvaluationId?: string;
  lastHealthyEvaluation?: string;
  qualifiedWindowStartedAt?: string;
  lastQualifiedObservationAt?: string;
  lastReleaseIdentity?: string;
  lastEvidenceReferences?: string[];
  lastEvidenceRevision?: string;
  lastFailedEvaluation?: string;
  lastFailedEvaluationId?: string;
  lastResetReason?: string;
  qualificationReasons: string[];
  interruptedAt?: string;
  lastTransitionAt: string;
}

export interface RuntimeRecoveredReason {
  reasonCode: string;
  metricKey: string;
  recoveredAt: string;
  evaluationId: string;
}

export interface RuntimeRecoveryState {
  schemaVersion: typeof RUNTIME_RECOVERY_SCHEMA_VERSION;
  id: typeof RECORD_ID;
  state: RuntimeRecoveryPhase;
  stateVersion: number;
  enteredAt: string;
  updatedAt: string;
  originatingBreachReasons: string[];
  currentApplicableReasons: string[];
  consecutiveHealthyCount: number;
  requiredHealthyCount: number;
  lastHealthyEvaluation?: string;
  lastHealthyEvaluationId?: string;
  lastResetReason?: string;
  currentCanaryPermitReference?: string;
  reasonProgress: RuntimeRecoveryReasonProgress[];
  recentlyRecoveredReasons: RuntimeRecoveredReason[];
  evidenceSummary: RuntimeRecoveryEvidenceSummary;
  releaseIdentity: string;
}

const PHASES = new Set<RuntimeRecoveryPhase>([
  'CLOSED_HEALTHY',
  'OPEN_BLOCKED',
  'RECOVERY_OBSERVING',
  'HALF_OPEN',
  'RECOVERED_PENDING_CONFIRMATION',
]);
const MEASUREMENT_STATES = new Set<RuntimeRecoveryMeasurementState>([
  'MEASURED',
  'INSUFFICIENT_DATA',
  'NOT_APPLICABLE',
  'BOOTSTRAP',
  'RECOVERY',
]);
const EVALUATION_STATUSES = new Set<RuntimeRecoveryEvidenceSummary['evaluationStatus']>([
  'PASS',
  'BREACH',
  'INSUFFICIENT_DATA',
]);

function boundedInteger(
  value: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function getRuntimeRecoveryPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { requiredHealthyCount: number; maximumEvidenceAgeMs: number } {
  return {
    requiredHealthyCount: boundedInteger(
      environment.RUNTIME_RECOVERY_REQUIRED_HEALTHY_COUNT,
      DEFAULT_RECOVERY_REQUIRED_HEALTHY_COUNT,
      3,
      20,
    ),
    maximumEvidenceAgeMs: boundedInteger(
      environment.RUNTIME_RECOVERY_MAX_EVIDENCE_AGE_MS,
      DEFAULT_RECOVERY_MAXIMUM_EVIDENCE_AGE_MS,
      60_000,
      30 * 60_000,
    ),
  };
}

function safeTimestamp(value: unknown, fallback: string): string {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function safeReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map(reason => reason.trim()).filter(Boolean))].slice(0, 50);
}

function safeOptionalReference(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  return /^[a-zA-Z0-9:_-]{8,200}$/.test(normalized) ? normalized : undefined;
}

function emptyEvidence(maximumEvidenceAgeMs: number): RuntimeRecoveryEvidenceSummary {
  return {
    measurementState: 'BOOTSTRAP',
    evaluationStatus: 'INSUFFICIENT_DATA',
    maximumEvidenceAgeMs,
    reasonCodes: ['RECOVERY_EVIDENCE_NOT_EVALUATED'],
    terminalJobSamples: 0,
    publicationAttempts: 0,
    monitorOutcomes: 0,
    publicProducts: 0,
  };
}

function normalizeEvidence(
  value: Partial<RuntimeRecoveryEvidenceSummary> | undefined,
  maximumEvidenceAgeMs: number,
): RuntimeRecoveryEvidenceSummary {
  const measurementState = MEASUREMENT_STATES.has(value?.measurementState as RuntimeRecoveryMeasurementState)
    ? value!.measurementState as RuntimeRecoveryMeasurementState
    : 'BOOTSTRAP';
  const evaluationStatus = EVALUATION_STATUSES.has(value?.evaluationStatus as RuntimeRecoveryEvidenceSummary['evaluationStatus'])
    ? value!.evaluationStatus as RuntimeRecoveryEvidenceSummary['evaluationStatus']
    : 'INSUFFICIENT_DATA';
  const reasonCodes = safeReasons(value?.reasonCodes);
  const optionalNumber = (item: unknown): number | null | undefined => (
    item === null ? null : Number.isFinite(Number(item)) && Number(item) >= 0 ? Number(item) : undefined
  );
  const normalizedReasonCodes = reasonCodes.length
    ? reasonCodes
    : evaluationStatus === 'PASS'
      ? []
      : evaluationStatus === 'BREACH'
        ? ['RECOVERY_EVIDENCE_BREACH_REASON_MISSING']
        : measurementState === 'BOOTSTRAP'
          ? ['RECOVERY_EVIDENCE_NOT_EVALUATED']
          : ['RECOVERY_EVIDENCE_INSUFFICIENT'];
  return {
    measurementState,
    evaluationStatus,
    evaluatedAt: value?.evaluatedAt ? safeTimestamp(value.evaluatedAt, new Date(0).toISOString()) : undefined,
    maximumEvidenceAgeMs,
    reasonCodes: normalizedReasonCodes,
    terminalJobSamples: boundedInteger(value?.terminalJobSamples, 0, 0, Number.MAX_SAFE_INTEGER),
    pickupLatencyP95Ms: optionalNumber(value?.pickupLatencyP95Ms),
    pendingQueueAgeMs: optionalNumber(value?.pendingQueueAgeMs),
    publicationAttempts: boundedInteger(value?.publicationAttempts, 0, 0, Number.MAX_SAFE_INTEGER),
    monitorOutcomes: boundedInteger(value?.monitorOutcomes, 0, 0, Number.MAX_SAFE_INTEGER),
    publicProducts: boundedInteger(value?.publicProducts, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function newRecoveryState(input: {
  publishBlockedByRuntime: boolean;
  reasons?: string[];
  nowMs?: number;
}): RuntimeRecoveryState {
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  const policy = getRuntimeRecoveryPolicy();
  const reasons = safeReasons(input.reasons);
  return normalizeRuntimeRecoveryState({
    schemaVersion: RUNTIME_RECOVERY_SCHEMA_VERSION,
    id: RECORD_ID,
    state: input.publishBlockedByRuntime ? 'OPEN_BLOCKED' : 'CLOSED_HEALTHY',
    stateVersion: 1,
    enteredAt: now,
    updatedAt: now,
    originatingBreachReasons: input.publishBlockedByRuntime ? reasons : [],
    currentApplicableReasons: input.publishBlockedByRuntime ? reasons : [],
    consecutiveHealthyCount: 0,
    requiredHealthyCount: policy.requiredHealthyCount,
    reasonProgress: reasons.map(reasonCode => ({
      reasonCode,
      metricKey: reasonCode,
      measurement: 'BREACH',
      consecutiveHealthyCount: 0,
      requiredHealthyCount: policy.requiredHealthyCount,
      lastEvidenceReferences: [],
      qualificationReasons: ['RUNTIME_BLOCK_ALREADY_ACTIVE'],
      lastTransitionAt: now,
    })),
    recentlyRecoveredReasons: [],
    lastResetReason: input.publishBlockedByRuntime ? 'RUNTIME_BLOCK_ALREADY_ACTIVE' : undefined,
    evidenceSummary: emptyEvidence(policy.maximumEvidenceAgeMs),
    releaseIdentity: getReleaseIdentity().releaseId,
  }, input.nowMs);
}

export function normalizeRuntimeRecoveryState(
  value: Partial<RuntimeRecoveryState>,
  nowMs = Date.now(),
): RuntimeRecoveryState {
  const now = new Date(nowMs).toISOString();
  const policy = getRuntimeRecoveryPolicy();
  const validPhase = PHASES.has(value.state as RuntimeRecoveryPhase);
  const state = validPhase ? value.state as RuntimeRecoveryPhase : 'OPEN_BLOCKED';
  const originatingBreachReasons = safeReasons(value.originatingBreachReasons);
  const currentApplicableReasons = safeReasons(value.currentApplicableReasons);
  const invalidStateReasons = validPhase ? currentApplicableReasons : [...new Set([
    ...currentApplicableReasons,
    'RUNTIME_RECOVERY_STATE_INVALID',
  ])];
  const reasonProgress: RuntimeRecoveryReasonProgress[] = Array.isArray(value.reasonProgress)
    ? value.reasonProgress
      .filter(item => item && typeof item === 'object')
      .flatMap(item => {
        const candidate = item as Partial<RuntimeRecoveryReasonProgress>;
        const reasonCode = safeReasons([candidate.reasonCode])[0];
        const measurement = ['PASS', 'BREACH', 'INSUFFICIENT_DATA', 'NOT_APPLICABLE'].includes(String(candidate.measurement))
          ? candidate.measurement as RuntimeRecoveryReasonMeasurement
          : 'INSUFFICIENT_DATA';
        return reasonCode ? [{
          reasonCode,
          metricKey: String(candidate.metricKey || reasonCode).slice(0, 120),
          measurement,
          consecutiveHealthyCount: boundedInteger(
            candidate.consecutiveHealthyCount,
            0,
            0,
            policy.requiredHealthyCount,
          ),
          requiredHealthyCount: boundedInteger(
            candidate.requiredHealthyCount,
            policy.requiredHealthyCount,
            3,
            20,
          ),
          ...(safeOptionalReference(candidate.lastEvaluationId)
            ? { lastEvaluationId: safeOptionalReference(candidate.lastEvaluationId) }
            : {}),
          ...(candidate.lastHealthyEvaluation
            ? { lastHealthyEvaluation: safeTimestamp(candidate.lastHealthyEvaluation, new Date(0).toISOString()) }
            : {}),
          ...(candidate.qualifiedWindowStartedAt
            ? { qualifiedWindowStartedAt: safeTimestamp(candidate.qualifiedWindowStartedAt, new Date(0).toISOString()) }
            : {}),
          ...(candidate.lastQualifiedObservationAt
            ? { lastQualifiedObservationAt: safeTimestamp(candidate.lastQualifiedObservationAt, new Date(0).toISOString()) }
            : {}),
          ...(safeOptionalReference(candidate.lastReleaseIdentity)
            ? { lastReleaseIdentity: safeOptionalReference(candidate.lastReleaseIdentity) }
            : {}),
          lastEvidenceReferences: Array.isArray(candidate.lastEvidenceReferences)
            ? candidate.lastEvidenceReferences
              .flatMap(reference => safeOptionalReference(reference) || [])
              .slice(0, 20)
            : [],
          ...(safeOptionalReference(candidate.lastEvidenceRevision)
            ? { lastEvidenceRevision: safeOptionalReference(candidate.lastEvidenceRevision) }
            : {}),
          ...(candidate.lastFailedEvaluation
            ? { lastFailedEvaluation: safeTimestamp(candidate.lastFailedEvaluation, now) }
            : {}),
          ...(safeOptionalReference(candidate.lastFailedEvaluationId)
            ? { lastFailedEvaluationId: safeOptionalReference(candidate.lastFailedEvaluationId) }
            : {}),
          ...(safeReasons(candidate.lastResetReason ? [candidate.lastResetReason] : [])[0]
            ? { lastResetReason: safeReasons([candidate.lastResetReason!])[0] }
            : {}),
          qualificationReasons: safeReasons(candidate.qualificationReasons),
          ...(candidate.interruptedAt
            ? { interruptedAt: safeTimestamp(candidate.interruptedAt, now) }
            : {}),
          lastTransitionAt: safeTimestamp(candidate.lastTransitionAt, now),
        } satisfies RuntimeRecoveryReasonProgress] : [];
      })
      .slice(0, 50)
    : [];
  const recentlyRecoveredReasons: RuntimeRecoveredReason[] = Array.isArray(value.recentlyRecoveredReasons)
    ? value.recentlyRecoveredReasons.flatMap(item => {
        const candidate = item as Partial<RuntimeRecoveredReason>;
        const reasonCode = safeReasons([candidate.reasonCode])[0];
        const evaluationId = safeOptionalReference(candidate.evaluationId);
        if (!reasonCode || !evaluationId) return [];
        return [{
          reasonCode,
          metricKey: String(candidate.metricKey || reasonCode).slice(0, 120),
          recoveredAt: safeTimestamp(candidate.recoveredAt, now),
          evaluationId,
        }];
      }).slice(-50)
    : [];
  return {
    schemaVersion: RUNTIME_RECOVERY_SCHEMA_VERSION,
    id: RECORD_ID,
    state,
    stateVersion: boundedInteger(value.stateVersion, 1, 1, Number.MAX_SAFE_INTEGER),
    enteredAt: safeTimestamp(value.enteredAt, now),
    updatedAt: safeTimestamp(value.updatedAt, now),
    originatingBreachReasons,
    currentApplicableReasons: invalidStateReasons,
    consecutiveHealthyCount: boundedInteger(value.consecutiveHealthyCount, 0, 0, policy.requiredHealthyCount),
    requiredHealthyCount: boundedInteger(value.requiredHealthyCount, policy.requiredHealthyCount, 3, 20),
    lastHealthyEvaluation: value.lastHealthyEvaluation
      ? safeTimestamp(value.lastHealthyEvaluation, new Date(0).toISOString())
      : undefined,
    lastHealthyEvaluationId: safeOptionalReference(value.lastHealthyEvaluationId),
    lastResetReason: validPhase
      ? safeReasons(value.lastResetReason ? [value.lastResetReason] : [])[0]
      : 'RUNTIME_RECOVERY_STATE_INVALID',
    currentCanaryPermitReference: safeOptionalReference(value.currentCanaryPermitReference),
    reasonProgress,
    recentlyRecoveredReasons,
    evidenceSummary: normalizeEvidence(value.evidenceSummary, policy.maximumEvidenceAgeMs),
    releaseIdentity: String(value.releaseIdentity || getReleaseIdentity().releaseId).slice(0, 120),
  };
}

export interface RuntimeReasonObservation {
  reasonCode: string;
  metricKey: string;
  measurement: RuntimeRecoveryReasonMeasurement;
  qualifyingStatus: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA';
  observedAt?: string;
  releaseIdentity?: string;
  qualificationReasons: string[];
  evidenceReferences?: string[];
  evidenceRevision?: string;
}

export interface RuntimeReasonRecoveryTransition {
  state: RuntimeRecoveryState;
  clearedReasons: string[];
  advancedReasons: string[];
  breachedReasons: string[];
  insufficientReasons: string[];
}

export async function advanceRuntimeReasonRecoveryState(input: {
  evaluationId: string;
  observations: RuntimeReasonObservation[];
  activeReasons: string[];
  evidenceSummary: RuntimeRecoveryEvidenceSummary;
  featureMode: FeatureRolloutMode;
  requiredReleaseIdentity: string;
  nowMs: number;
}): Promise<RuntimeReasonRecoveryTransition> {
  const activeReasons = safeReasons(input.activeReasons);
  const observations = new Map(input.observations.map(observation => [observation.reasonCode, observation]));
  const now = new Date(input.nowMs).toISOString();
  const requiredReleaseIdentity = safeOptionalReference(input.requiredReleaseIdentity);
  if (!requiredReleaseIdentity) throw new Error('RUNTIME_RECOVERY_RELEASE_IDENTITY_REQUIRED');
  const evidenceWindowMs = getRuntimeRecoveryPolicy().maximumEvidenceAgeMs;
  let current = await ensureRuntimeRecoveryState({
    publishBlockedByRuntime: activeReasons.length > 0,
    reasons: activeReasons,
    nowMs: input.nowMs,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previousProgress = new Map(current.reasonProgress.map(progress => [progress.reasonCode, progress]));
    const clearedReasons: string[] = [];
    const advancedReasons: string[] = [];
    const breachedReasons: string[] = [];
    const insufficientReasons: string[] = [];
    const reasonProgress: RuntimeRecoveryReasonProgress[] = [];

    if (activeReasons.length === 0) {
      const next: RuntimeRecoveryState = {
        ...current,
        state: 'CLOSED_HEALTHY',
        currentApplicableReasons: [],
        reasonProgress: [],
        consecutiveHealthyCount: 0,
        lastResetReason: current.state === 'CLOSED_HEALTHY'
          ? current.lastResetReason
          : 'RUNTIME_BLOCK_NOT_ACTIVE',
        evidenceSummary: input.evidenceSummary,
      };
      try {
        const state = await updateRuntimeRecoveryState({
          expectedStateVersion: current.stateVersion,
          nowMs: input.nowMs,
          mutate: () => next,
        });
        return {
          state,
          clearedReasons: [],
          advancedReasons: [],
          breachedReasons: [],
          insufficientReasons: [],
        };
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'RUNTIME_RECOVERY_STATE_VERSION_CONFLICT' || attempt === 2) throw error;
        const refreshed = await getRuntimeRecoveryState();
        if (!refreshed) throw new Error('RUNTIME_RECOVERY_STATE_REQUIRED');
        current = refreshed;
        continue;
      }
    }

    for (const reasonCode of activeReasons) {
      const observation = observations.get(reasonCode);
      const previous = previousProgress.get(reasonCode);
      const measurement = observation?.measurement || 'INSUFFICIENT_DATA';
      const distinctEvaluation = previous?.lastEvaluationId !== input.evaluationId;
      const evidenceRevision = safeOptionalReference(observation?.evidenceRevision)
        || (observation
          ? createHash('sha256').update(JSON.stringify({
              reasonCode,
              metricKey: observation.metricKey,
              observedAt: observation.observedAt,
              releaseIdentity: observation.releaseIdentity,
              measurement: observation.measurement,
              qualifyingStatus: observation.qualifyingStatus,
              evidenceReferences: observation.evidenceReferences || [],
            })).digest('hex')
          : undefined);
      const distinctEvidence = !previous?.lastEvidenceRevision
        || previous.lastEvidenceRevision !== evidenceRevision;

      const observedAtMs = Date.parse(observation?.observedAt || '');
      const previousObservedAtMs = Date.parse(previous?.lastQualifiedObservationAt || '');
      const previousWindowStartedAtMs = Date.parse(previous?.qualifiedWindowStartedAt || '');
      const evidenceReferences = (observation?.evidenceReferences || [])
        .flatMap(reference => safeOptionalReference(reference) || [])
        .slice(0, 20);
      const evidenceFresh = Number.isFinite(observedAtMs)
        && observedAtMs <= input.nowMs + 60_000
        && input.nowMs - observedAtMs <= evidenceWindowMs;
      const evidenceOrdered = !Number.isFinite(previousObservedAtMs) || observedAtMs > previousObservedAtMs;
      const releaseCompatible = observation?.releaseIdentity === requiredReleaseIdentity;
      const previousProgressCompatible = (previous?.consecutiveHealthyCount || 0) === 0 || (
        previous?.lastReleaseIdentity === requiredReleaseIdentity
        && Number.isFinite(previousObservedAtMs)
        && input.nowMs - previousObservedAtMs <= evidenceWindowMs
        && Number.isFinite(previousWindowStartedAtMs)
        && input.nowMs - previousWindowStartedAtMs <= evidenceWindowMs
      );
      if (
        (!distinctEvaluation || !distinctEvidence)
        && previous
        && evidenceFresh
        && previousProgressCompatible
      ) {
        reasonProgress.push(previous);
        continue;
      }
      const evidenceWindowStartedAtMs = previousProgressCompatible && (previous?.consecutiveHealthyCount || 0) > 0
        ? previousWindowStartedAtMs
        : observedAtMs;
      const evidenceInsideWindow = Number.isFinite(evidenceWindowStartedAtMs)
        && Number.isFinite(observedAtMs)
        && observedAtMs - evidenceWindowStartedAtMs <= evidenceWindowMs;
      const evidenceReferenced = evidenceReferences.length > 0;
      const evidenceRevisionPresent = Boolean(evidenceRevision);
      const qualifyingPass = measurement === 'PASS'
        && observation?.qualifyingStatus === 'PASS'
        && evidenceFresh
        && evidenceOrdered
        && releaseCompatible
        && previousProgressCompatible
        && evidenceInsideWindow
        && evidenceReferenced
        && evidenceRevisionPresent;
      const explicitBreach = measurement === 'BREACH' || observation?.qualifyingStatus === 'BREACH';
      const qualificationReasons = safeReasons([
        ...(observation?.qualificationReasons || []),
        ...(!evidenceFresh ? ['RUNTIME_RECOVERY_EVIDENCE_STALE_OR_INVALID'] : []),
        ...(!evidenceOrdered ? ['RUNTIME_RECOVERY_EVIDENCE_OUT_OF_ORDER'] : []),
        ...(!releaseCompatible ? ['RUNTIME_RECOVERY_RELEASE_MISMATCH'] : []),
        ...(!previousProgressCompatible ? ['RUNTIME_RECOVERY_STREAK_EXPIRED_OR_RELEASE_CHANGED'] : []),
        ...(!evidenceInsideWindow ? ['RUNTIME_RECOVERY_EVIDENCE_OUTSIDE_WINDOW'] : []),
        ...(!evidenceReferenced ? ['RUNTIME_RECOVERY_EVIDENCE_REFERENCE_REQUIRED'] : []),
        ...(!evidenceRevisionPresent ? ['RUNTIME_RECOVERY_EVIDENCE_REVISION_REQUIRED'] : []),
        ...(measurement === 'NOT_APPLICABLE' ? ['RUNTIME_RECOVERY_EVIDENCE_NOT_APPLICABLE'] : []),
        ...(measurement === 'INSUFFICIENT_DATA' ? ['RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT'] : []),
      ]);
      const healthyCount = qualifyingPass
        ? Math.min(
            current.requiredHealthyCount,
            (previousProgressCompatible ? previous?.consecutiveHealthyCount || 0 : 0) + 1,
          )
        : 0;

      if (explicitBreach) breachedReasons.push(reasonCode);
      else if (qualifyingPass) advancedReasons.push(reasonCode);
      else insufficientReasons.push(reasonCode);

      if (
        qualifyingPass
        && healthyCount >= current.requiredHealthyCount
        && input.featureMode === 'ACTIVE'
      ) {
        clearedReasons.push(reasonCode);
        continue;
      }

      reasonProgress.push({
        reasonCode,
        metricKey: observation?.metricKey || previous?.metricKey || reasonCode,
        measurement,
        consecutiveHealthyCount: healthyCount,
        requiredHealthyCount: current.requiredHealthyCount,
        lastEvaluationId: input.evaluationId,
        lastHealthyEvaluation: qualifyingPass
          ? now
          : previous?.lastHealthyEvaluation,
        qualifiedWindowStartedAt: qualifyingPass
          ? new Date(evidenceWindowStartedAtMs).toISOString()
          : undefined,
        lastQualifiedObservationAt: qualifyingPass
          ? new Date(observedAtMs).toISOString()
          : previous?.lastQualifiedObservationAt,
        lastReleaseIdentity: qualifyingPass
          ? requiredReleaseIdentity
          : previous?.lastReleaseIdentity,
        lastEvidenceReferences: qualifyingPass
          ? evidenceReferences
          : previous?.lastEvidenceReferences || [],
        lastEvidenceRevision: qualifyingPass
          ? evidenceRevision
          : previous?.lastEvidenceRevision,
        lastFailedEvaluation: qualifyingPass ? previous?.lastFailedEvaluation : now,
        lastFailedEvaluationId: qualifyingPass ? previous?.lastFailedEvaluationId : input.evaluationId,
        lastResetReason: qualifyingPass
          ? undefined
          : explicitBreach
            ? reasonCode
            : qualificationReasons[0] || 'RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT',
        qualificationReasons,
        interruptedAt: qualifyingPass ? undefined : now,
        lastTransitionAt: measurement !== previous?.measurement || healthyCount !== previous?.consecutiveHealthyCount
          ? now
          : previous?.lastTransitionAt || now,
      });
    }

    const remainingReasons = activeReasons.filter(reason => !clearedReasons.includes(reason));
    const recoveredRecords: RuntimeRecoveredReason[] = clearedReasons.map(reasonCode => ({
      reasonCode,
      metricKey: observations.get(reasonCode)?.metricKey || reasonCode,
      recoveredAt: now,
      evaluationId: input.evaluationId,
    }));
    const aggregateHealthyCount = reasonProgress.length
      ? Math.min(...reasonProgress.map(progress => progress.consecutiveHealthyCount))
      : 0;
    const next: RuntimeRecoveryState = {
      ...current,
      state: remainingReasons.length === 0
        ? 'RECOVERED_PENDING_CONFIRMATION'
        : advancedReasons.length > 0
          ? 'RECOVERY_OBSERVING'
          : 'OPEN_BLOCKED',
      originatingBreachReasons: [...new Set([...current.originatingBreachReasons, ...activeReasons])],
      currentApplicableReasons: remainingReasons,
      reasonProgress,
      recentlyRecoveredReasons: [
        ...current.recentlyRecoveredReasons,
        ...recoveredRecords,
      ].slice(-50),
      consecutiveHealthyCount: aggregateHealthyCount,
      lastHealthyEvaluation: advancedReasons.length ? now : current.lastHealthyEvaluation,
      lastHealthyEvaluationId: advancedReasons.length ? input.evaluationId : current.lastHealthyEvaluationId,
      lastResetReason: breachedReasons[0]
        || (insufficientReasons.length ? 'RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT' : undefined),
      evidenceSummary: input.evidenceSummary,
    };

    try {
      const state = await updateRuntimeRecoveryState({
        expectedStateVersion: current.stateVersion,
        nowMs: input.nowMs,
        mutate: () => next,
      });
      return { state, clearedReasons, advancedReasons, breachedReasons, insufficientReasons };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RUNTIME_RECOVERY_STATE_VERSION_CONFLICT' || attempt === 2) throw error;
      const refreshed = await getRuntimeRecoveryState();
      if (!refreshed) throw new Error('RUNTIME_RECOVERY_STATE_REQUIRED');
      current = refreshed;
    }
  }
  throw new Error('RUNTIME_RECOVERY_REASON_UPDATE_FAILED');
}

export async function getRuntimeRecoveryState(): Promise<RuntimeRecoveryState | null> {
  const stored = (await readCollection<Partial<RuntimeRecoveryState>>(COLLECTION))
    .find(item => item.id === RECORD_ID);
  return stored ? normalizeRuntimeRecoveryState(stored) : null;
}

export async function ensureRuntimeRecoveryState(input: {
  publishBlockedByRuntime: boolean;
  reasons?: string[];
  nowMs?: number;
}): Promise<RuntimeRecoveryState> {
  let output!: RuntimeRecoveryState;
  await runTransaction<Partial<RuntimeRecoveryState>>(COLLECTION, items => {
    const index = items.findIndex(item => item.id === RECORD_ID);
    if (index >= 0) {
      output = normalizeRuntimeRecoveryState(items[index], input.nowMs);
      const serialized = JSON.stringify(output);
      if (serialized === JSON.stringify(items[index])) return undefined;
      items[index] = output;
      return items;
    }
    output = newRecoveryState(input);
    items.push(output);
    return items;
  });
  return structuredClone(output);
}

export async function updateRuntimeRecoveryState(input: {
  expectedStateVersion: number;
  nowMs?: number;
  mutate: (current: RuntimeRecoveryState) => RuntimeRecoveryState;
}): Promise<RuntimeRecoveryState> {
  let output!: RuntimeRecoveryState;
  await runTransaction<Partial<RuntimeRecoveryState>>(COLLECTION, items => {
    const index = items.findIndex(item => item.id === RECORD_ID);
    if (index < 0) throw new Error('RUNTIME_RECOVERY_STATE_REQUIRED');
    const current = normalizeRuntimeRecoveryState(items[index], input.nowMs);
    if (current.stateVersion !== input.expectedStateVersion) {
      throw new Error('RUNTIME_RECOVERY_STATE_VERSION_CONFLICT');
    }
    const requested = input.mutate(structuredClone(current));
    const now = new Date(input.nowMs ?? Date.now()).toISOString();
    output = normalizeRuntimeRecoveryState({
      ...requested,
      schemaVersion: RUNTIME_RECOVERY_SCHEMA_VERSION,
      id: RECORD_ID,
      stateVersion: current.stateVersion + 1,
      updatedAt: now,
      releaseIdentity: getReleaseIdentity().releaseId,
    }, input.nowMs);
    if (output.state !== current.state && requested.enteredAt === current.enteredAt) {
      output.enteredAt = now;
    }
    items[index] = output;
    return items;
  });
  return structuredClone(output);
}

export interface RuntimeRecoveryTransitionInput {
  evaluationId: string;
  evaluationStatus: RuntimeRecoveryEvidenceSummary['evaluationStatus'];
  applicableReasons: string[];
  recoveryEligibilityReasons: string[];
  evidenceSummary: RuntimeRecoveryEvidenceSummary;
  publishBlockedByRuntime: boolean;
  featureMode: FeatureRolloutMode;
  nowMs: number;
}

export interface RuntimeRecoveryTransition {
  state: RuntimeRecoveryState;
  shouldClearRuntimeBlock: boolean;
  reasonCode:
    | 'RUNTIME_BREACH_RECORDED'
    | 'RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT'
    | 'RUNTIME_RECOVERY_SAFETY_GATE_BLOCKED'
    | 'RUNTIME_RECOVERY_HEALTHY_PROGRESS'
    | 'RUNTIME_RECOVERY_CONFIRMATION_READY'
    | 'RUNTIME_RECOVERY_NOT_REQUIRED';
}

export function deriveRuntimeRecoveryTransition(
  current: RuntimeRecoveryState,
  input: RuntimeRecoveryTransitionInput,
): RuntimeRecoveryTransition {
  const applicableReasons = safeReasons(input.applicableReasons);
  const evidenceSummary = normalizeEvidence(input.evidenceSummary, current.evidenceSummary.maximumEvidenceAgeMs);

  if (!input.publishBlockedByRuntime) {
    return {
      state: {
        ...current,
        state: 'CLOSED_HEALTHY',
        currentApplicableReasons: [],
        consecutiveHealthyCount: 0,
        lastResetReason: current.state === 'CLOSED_HEALTHY' ? current.lastResetReason : 'RUNTIME_BLOCK_NOT_ACTIVE',
        evidenceSummary,
      },
      shouldClearRuntimeBlock: false,
      reasonCode: 'RUNTIME_RECOVERY_NOT_REQUIRED',
    };
  }

  /*
   * Compatibility-only transition for snapshots written before per-reason
   * evidence existed. It may preserve or strengthen a runtime block, but it
   * must never advance or clear one. `advanceRuntimeReasonRecoveryState` is
   * the sole authoritative recovery path.
   */
  if (input.evaluationStatus === 'BREACH') {
    return {
      state: {
        ...current,
        state: 'OPEN_BLOCKED',
        originatingBreachReasons: current.originatingBreachReasons.length
          ? current.originatingBreachReasons
          : applicableReasons,
        currentApplicableReasons: applicableReasons,
        consecutiveHealthyCount: 0,
        lastResetReason: applicableReasons[0] || 'RUNTIME_BREACH_RECORDED',
        evidenceSummary,
      },
      shouldClearRuntimeBlock: false,
      reasonCode: 'RUNTIME_BREACH_RECORDED',
    };
  }

  return {
    state: {
      ...current,
      state: 'RECOVERY_OBSERVING',
      currentApplicableReasons: applicableReasons.length
        ? applicableReasons
        : current.currentApplicableReasons,
      consecutiveHealthyCount: 0,
      reasonProgress: current.reasonProgress.map(progress => ({
        ...progress,
        consecutiveHealthyCount: 0,
        measurement: 'INSUFFICIENT_DATA',
        qualifiedWindowStartedAt: undefined,
        qualificationReasons: ['RUNTIME_RECOVERY_EXPLICIT_REASON_EVIDENCE_REQUIRED'],
        interruptedAt: new Date(input.nowMs).toISOString(),
      })),
      lastResetReason: 'RUNTIME_RECOVERY_EXPLICIT_REASON_EVIDENCE_REQUIRED',
      evidenceSummary,
    },
    shouldClearRuntimeBlock: false,
    reasonCode: input.evaluationStatus === 'INSUFFICIENT_DATA'
      ? 'RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT'
      : 'RUNTIME_RECOVERY_SAFETY_GATE_BLOCKED',
  };
}

export async function advanceRuntimeRecoveryState(
  input: RuntimeRecoveryTransitionInput,
): Promise<RuntimeRecoveryTransition> {
  let current = await ensureRuntimeRecoveryState({
    publishBlockedByRuntime: input.publishBlockedByRuntime,
    reasons: input.applicableReasons,
    nowMs: input.nowMs,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transition = deriveRuntimeRecoveryTransition(current, input);
    try {
      const state = await updateRuntimeRecoveryState({
        expectedStateVersion: current.stateVersion,
        nowMs: input.nowMs,
        mutate: () => transition.state,
      });
      return { ...transition, state };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RUNTIME_RECOVERY_STATE_VERSION_CONFLICT' || attempt === 2) {
        throw error;
      }
      const refreshed = await getRuntimeRecoveryState();
      if (!refreshed) throw new Error('RUNTIME_RECOVERY_STATE_REQUIRED');
      current = refreshed;
    }
  }
  throw new Error('RUNTIME_RECOVERY_STATE_UPDATE_FAILED');
}

export async function confirmRuntimeRecoveryClosed(input: {
  expectedStateVersion: number;
  nowMs: number;
  evidenceSummary: RuntimeRecoveryEvidenceSummary;
}): Promise<RuntimeRecoveryState> {
  return updateRuntimeRecoveryState({
    expectedStateVersion: input.expectedStateVersion,
    nowMs: input.nowMs,
    mutate: current => {
      if (
        current.state !== 'RECOVERED_PENDING_CONFIRMATION'
        || current.currentApplicableReasons.length > 0
        || current.reasonProgress.length > 0
        || current.recentlyRecoveredReasons.length === 0
      ) {
        throw new Error('RUNTIME_RECOVERY_CONFIRMATION_NOT_AUTHORIZED');
      }
      return {
        ...current,
        state: 'CLOSED_HEALTHY',
        currentApplicableReasons: [],
        consecutiveHealthyCount: 0,
        lastResetReason: 'RUNTIME_RECOVERY_CONFIRMED',
        evidenceSummary: input.evidenceSummary,
      };
    },
  });
}
