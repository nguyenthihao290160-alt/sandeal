import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { FeatureRolloutMode } from './featureRollout';

const COLLECTION = 'runtime-recovery-state';
const RECORD_ID = 'runtime-recovery';

export const RUNTIME_RECOVERY_SCHEMA_VERSION = 1;
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
    evidenceSummary: normalizeEvidence(value.evidenceSummary, policy.maximumEvidenceAgeMs),
    releaseIdentity: String(value.releaseIdentity || getReleaseIdentity().releaseId).slice(0, 120),
  };
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
  const now = new Date(input.nowMs).toISOString();
  const applicableReasons = safeReasons(input.applicableReasons);
  const eligibilityReasons = safeReasons(input.recoveryEligibilityReasons);
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

  if (input.evaluationStatus === 'INSUFFICIENT_DATA') {
    return {
      state: {
        ...current,
        state: 'RECOVERY_OBSERVING',
        currentApplicableReasons: applicableReasons,
        consecutiveHealthyCount: 0,
        lastResetReason: 'RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT',
        evidenceSummary,
      },
      shouldClearRuntimeBlock: false,
      reasonCode: 'RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT',
    };
  }

  const rolloutBlocksActivation = input.featureMode === 'OFF';
  const blockers = rolloutBlocksActivation
    ? [...new Set([...eligibilityReasons, 'RUNTIME_RECOVERY_V2_OFF'])]
    : eligibilityReasons;
  if (blockers.length) {
    return {
      state: {
        ...current,
        state: 'RECOVERY_OBSERVING',
        currentApplicableReasons: blockers,
        consecutiveHealthyCount: 0,
        lastResetReason: blockers[0],
        evidenceSummary,
      },
      shouldClearRuntimeBlock: false,
      reasonCode: 'RUNTIME_RECOVERY_SAFETY_GATE_BLOCKED',
    };
  }

  const distinctEvaluation = current.lastHealthyEvaluationId !== input.evaluationId;
  const consecutiveHealthyCount = distinctEvaluation
    ? Math.min(current.requiredHealthyCount, current.consecutiveHealthyCount + 1)
    : current.consecutiveHealthyCount;
  const confirmationReady = consecutiveHealthyCount >= current.requiredHealthyCount;
  return {
    state: {
      ...current,
      state: confirmationReady ? 'RECOVERED_PENDING_CONFIRMATION' : 'RECOVERY_OBSERVING',
      currentApplicableReasons: [],
      consecutiveHealthyCount,
      lastHealthyEvaluation: distinctEvaluation ? now : current.lastHealthyEvaluation,
      lastHealthyEvaluationId: distinctEvaluation ? input.evaluationId : current.lastHealthyEvaluationId,
      lastResetReason: distinctEvaluation ? undefined : current.lastResetReason,
      evidenceSummary,
    },
    shouldClearRuntimeBlock: confirmationReady && input.featureMode === 'ACTIVE',
    reasonCode: confirmationReady
      ? 'RUNTIME_RECOVERY_CONFIRMATION_READY'
      : 'RUNTIME_RECOVERY_HEALTHY_PROGRESS',
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
    mutate: current => ({
      ...current,
      state: 'CLOSED_HEALTHY',
      currentApplicableReasons: [],
      consecutiveHealthyCount: 0,
      lastResetReason: 'RUNTIME_RECOVERY_CONFIRMED',
      evidenceSummary: input.evidenceSummary,
    }),
  });
}
