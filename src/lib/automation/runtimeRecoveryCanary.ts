import { createHash } from 'node:crypto';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { getFeatureRolloutState } from './featureRollout';
import {
  getRuntimeRecoveryState,
  updateRuntimeRecoveryState,
  type RuntimeRecoveryState,
} from './runtimeRecoveryState';
import { isRuntimeRoleOwner, listRuntimeRoleLeases, type RuntimeRoleOwnership } from './runtimeRoles';
import { getAutomationControl, updateAutomationControl } from './store';

const COLLECTION = 'runtime-recovery-canary-permits';

export const RUNTIME_RECOVERY_CANARY_SCHEMA_VERSION = 1;
export const DEFAULT_RECOVERY_CANARY_MAX_ACTIVE = 1;
export const HARD_MAXIMUM_RECOVERY_CANARY_PERMITS = 2;
export const DEFAULT_RECOVERY_CANARY_TTL_MS = 30 * 60_000;

export type RuntimeRecoveryCanaryPermitStatus =
  | 'ISSUED'
  | 'CONSUMED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REVOKED';

export interface RuntimeRecoveryCanaryPermit {
  schemaVersion: typeof RUNTIME_RECOVERY_CANARY_SCHEMA_VERSION;
  id: string;
  operationId: string;
  productId: string;
  jobId: string;
  readinessSnapshotHash: string;
  ownerId: string;
  instanceId: string;
  fencingToken: number;
  claimTokenHash: string;
  status: RuntimeRecoveryCanaryPermitStatus;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  completedAt?: string;
  publicationEffectKey?: string;
  outcomeReasonCode?: string;
  releaseIdentity: string;
}

export type RuntimeRecoveryCanaryPermitReason =
  | 'RECOVERY_CANARY_PERMIT_ISSUED'
  | 'RECOVERY_CANARY_PERMIT_REUSED'
  | 'RECOVERY_CANARY_DISABLED'
  | 'RECOVERY_CANARY_RUNTIME_BLOCK_REQUIRED'
  | 'RECOVERY_CANARY_OPERATOR_PAUSED'
  | 'RECOVERY_CANARY_EMERGENCY_STOP'
  | 'RECOVERY_CANARY_POLICY_BLOCKED'
  | 'RECOVERY_CANARY_RECOVERY_STATE_NOT_READY'
  | 'RECOVERY_CANARY_EVIDENCE_STALE'
  | 'RECOVERY_CANARY_PRODUCT_INELIGIBLE'
  | 'RECOVERY_CANARY_WORKER_FENCE_INVALID'
  | 'RECOVERY_CANARY_SCHEDULER_LEASE_INVALID'
  | 'RECOVERY_CANARY_RELEASE_MISMATCH'
  | 'RECOVERY_CANARY_CAPACITY_REACHED'
  | 'RECOVERY_CANARY_OWNED_BY_ANOTHER_OPERATION'
  | 'RECOVERY_CANARY_PERMIT_NOT_FOUND'
  | 'RECOVERY_CANARY_PERMIT_EXPIRED'
  | 'RECOVERY_CANARY_PERMIT_OWNERSHIP_MISMATCH'
  | 'RECOVERY_CANARY_PERMIT_ALREADY_FINAL';

export interface RuntimeRecoveryCanaryPermitDecision {
  allowed: boolean;
  reasonCode: RuntimeRecoveryCanaryPermitReason;
  permit?: RuntimeRecoveryCanaryPermit;
}

interface PermitOwnershipInput {
  operationId: string;
  productId: string;
  jobId: string;
  claimToken: string;
  ownership: RuntimeRoleOwnership;
}

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

export function getRuntimeRecoveryCanaryPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { maximumActivePermits: number; permitTtlMs: number } {
  return {
    maximumActivePermits: boundedInteger(
      environment.RECOVERY_CANARY_MAX_ACTIVE,
      DEFAULT_RECOVERY_CANARY_MAX_ACTIVE,
      1,
      HARD_MAXIMUM_RECOVERY_CANARY_PERMITS,
    ),
    permitTtlMs: boundedInteger(
      environment.RECOVERY_CANARY_TTL_MS,
      DEFAULT_RECOVERY_CANARY_TTL_MS,
      5 * 60_000,
      60 * 60_000,
    ),
  };
}

function claimTokenHash(claimToken: string): string {
  return createHash('sha256').update(claimToken).digest('hex');
}

function clonePermit(permit: RuntimeRecoveryCanaryPermit): RuntimeRecoveryCanaryPermit {
  return structuredClone(permit);
}

function isActivePermit(permit: RuntimeRecoveryCanaryPermit, nowMs: number): boolean {
  return permit.status === 'CONSUMED'
    || (permit.status === 'ISSUED' && Date.parse(permit.expiresAt) > nowMs);
}

function expirePermits(permits: RuntimeRecoveryCanaryPermit[], nowMs: number): boolean {
  let changed = false;
  const now = new Date(nowMs).toISOString();
  for (const permit of permits) {
    if (permit.status !== 'ISSUED' || Date.parse(permit.expiresAt) > nowMs) continue;
    permit.status = 'EXPIRED';
    permit.completedAt = now;
    permit.outcomeReasonCode = 'RECOVERY_CANARY_PERMIT_EXPIRED';
    changed = true;
  }
  return changed;
}

function sameOwnership(permit: RuntimeRecoveryCanaryPermit, input: PermitOwnershipInput): boolean {
  return permit.operationId === input.operationId
    && permit.productId === input.productId
    && permit.jobId === input.jobId
    && permit.ownerId === input.ownership.ownerId
    && permit.instanceId === input.ownership.instanceId
    && permit.fencingToken === input.ownership.fencingToken
    && permit.claimTokenHash === claimTokenHash(input.claimToken);
}

function recoveryStateReady(state: RuntimeRecoveryState | null, nowMs: number): RuntimeRecoveryCanaryPermitReason | null {
  if (!state
    || !['RECOVERY_OBSERVING', 'HALF_OPEN', 'RECOVERED_PENDING_CONFIRMATION'].includes(state.state)
    || state.evidenceSummary.evaluationStatus !== 'PASS'
    || state.currentApplicableReasons.length > 0) {
    return 'RECOVERY_CANARY_RECOVERY_STATE_NOT_READY';
  }
  const evaluatedAt = Date.parse(state.evidenceSummary.evaluatedAt || '');
  if (!Number.isFinite(evaluatedAt)
    || evaluatedAt > nowMs + 60_000
    || nowMs - evaluatedAt > state.evidenceSummary.maximumEvidenceAgeMs) {
    return 'RECOVERY_CANARY_EVIDENCE_STALE';
  }
  return null;
}

async function evaluateLiveSafety(
  input: PermitOwnershipInput & { productEligibleExceptRuntime: boolean; nowMs: number },
): Promise<RuntimeRecoveryCanaryPermitReason | null> {
  if (getFeatureRolloutState('RECOVERY_CANARY').mode !== 'ACTIVE') return 'RECOVERY_CANARY_DISABLED';
  const [control, state, ownsWorkerRole, roleLeases] = await Promise.all([
    getAutomationControl(),
    getRuntimeRecoveryState(),
    isRuntimeRoleOwner('WORKER', input.ownership, input.nowMs),
    listRuntimeRoleLeases(),
  ]);
  const release = getReleaseIdentity();
  const workerLease = roleLeases.find(lease => lease.role === 'WORKER');
  const schedulerLease = roleLeases.find(lease => lease.role === 'SCHEDULER');
  if (!control.publishBlockedByRuntime) return 'RECOVERY_CANARY_RUNTIME_BLOCK_REQUIRED';
  if (control.publishPausedByOperator) return 'RECOVERY_CANARY_OPERATOR_PAUSED';
  if (control.killSwitch) return 'RECOVERY_CANARY_EMERGENCY_STOP';
  if (control.publishBlockedByPolicy) return 'RECOVERY_CANARY_POLICY_BLOCKED';
  if (!input.productEligibleExceptRuntime) return 'RECOVERY_CANARY_PRODUCT_INELIGIBLE';
  if (!ownsWorkerRole) return 'RECOVERY_CANARY_WORKER_FENCE_INVALID';
  if (!schedulerLease
    || schedulerLease.status !== 'ACTIVE'
    || Date.parse(schedulerLease.expiresAt || schedulerLease.leaseExpiresAt) <= input.nowMs) {
    return 'RECOVERY_CANARY_SCHEDULER_LEASE_INVALID';
  }
  if (release.releaseMismatch
    || workerLease?.releaseId !== release.releaseId
    || schedulerLease.releaseId !== release.releaseId) {
    return 'RECOVERY_CANARY_RELEASE_MISMATCH';
  }
  return recoveryStateReady(state, input.nowMs);
}

async function transitionRecoveryStateForPermit(
  permitId: string | undefined,
  targetState: 'HALF_OPEN' | 'RECOVERY_OBSERVING' | 'OPEN_BLOCKED',
  reasonCode: string | undefined,
  nowMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getRuntimeRecoveryState();
    if (!current) throw new Error('RUNTIME_RECOVERY_STATE_REQUIRED');
    try {
      await updateRuntimeRecoveryState({
        expectedStateVersion: current.stateVersion,
        nowMs,
        mutate: state => ({
          ...state,
          state: targetState,
          currentCanaryPermitReference: permitId,
          ...(targetState === 'OPEN_BLOCKED' ? {
            consecutiveHealthyCount: 0,
            currentApplicableReasons: [reasonCode || 'RECOVERY_CANARY_UNHEALTHY'],
            lastResetReason: reasonCode || 'RECOVERY_CANARY_UNHEALTHY',
          } : {}),
        }),
      });
      return;
    } catch (error) {
      if (!(error instanceof Error)
        || error.message !== 'RUNTIME_RECOVERY_STATE_VERSION_CONFLICT'
        || attempt === 2) {
        throw error;
      }
    }
  }
}

export async function issueRuntimeRecoveryCanaryPermit(
  input: PermitOwnershipInput & {
    readinessSnapshotHash: string;
    productEligibleExceptRuntime: boolean;
    nowMs?: number;
  },
): Promise<RuntimeRecoveryCanaryPermitDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const safetyReason = await evaluateLiveSafety({ ...input, nowMs });
  if (safetyReason) return { allowed: false, reasonCode: safetyReason };

  const policy = getRuntimeRecoveryCanaryPolicy();
  let decision!: RuntimeRecoveryCanaryPermitDecision;
  await runTransaction<RuntimeRecoveryCanaryPermit>(COLLECTION, permits => {
    const expired = expirePermits(permits, nowMs);
    const operationPermits = permits
      .filter(permit => permit.operationId === input.operationId && isActivePermit(permit, nowMs))
      .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt));
    const existing = operationPermits[0];
    if (existing) {
      if (!sameOwnership(existing, input)) {
        decision = {
          allowed: false,
          reasonCode: 'RECOVERY_CANARY_OWNED_BY_ANOTHER_OPERATION',
        };
        return expired ? permits : undefined;
      }
      decision = {
        allowed: existing.status === 'ISSUED',
        reasonCode: 'RECOVERY_CANARY_PERMIT_REUSED',
        permit: clonePermit(existing),
      };
      return expired ? permits : undefined;
    }
    const activeCount = permits.filter(permit => isActivePermit(permit, nowMs)).length;
    if (activeCount >= policy.maximumActivePermits) {
      decision = { allowed: false, reasonCode: 'RECOVERY_CANARY_CAPACITY_REACHED' };
      return expired ? permits : undefined;
    }
    const now = new Date(nowMs).toISOString();
    const permit: RuntimeRecoveryCanaryPermit = {
      schemaVersion: RUNTIME_RECOVERY_CANARY_SCHEMA_VERSION,
      id: generateId(),
      operationId: input.operationId.slice(0, 200),
      productId: input.productId.slice(0, 200),
      jobId: input.jobId.slice(0, 200),
      readinessSnapshotHash: input.readinessSnapshotHash.slice(0, 128),
      ownerId: input.ownership.ownerId.slice(0, 200),
      instanceId: input.ownership.instanceId.slice(0, 200),
      fencingToken: input.ownership.fencingToken,
      claimTokenHash: claimTokenHash(input.claimToken),
      status: 'ISSUED',
      issuedAt: now,
      expiresAt: new Date(nowMs + policy.permitTtlMs).toISOString(),
      releaseIdentity: getReleaseIdentity().releaseId,
    };
    permits.push(permit);
    decision = {
      allowed: true,
      reasonCode: 'RECOVERY_CANARY_PERMIT_ISSUED',
      permit: clonePermit(permit),
    };
    return permits;
  });

  if (!decision.allowed || !decision.permit) return decision;
  try {
    await transitionRecoveryStateForPermit(decision.permit.id, 'HALF_OPEN', undefined, nowMs);
    return decision;
  } catch {
    await finalizeRuntimeRecoveryCanaryPermit({
      permitId: decision.permit.id,
      productId: input.productId,
      healthy: false,
      reasonCode: 'RECOVERY_CANARY_STATE_TRANSITION_FAILED',
      nowMs,
      preserveRuntimeBlock: true,
      finalStatus: 'REVOKED',
    });
    return { allowed: false, reasonCode: 'RECOVERY_CANARY_RECOVERY_STATE_NOT_READY' };
  }
}

export async function consumeRuntimeRecoveryCanaryPermit(
  input: PermitOwnershipInput & {
    permitId: string;
    productEligibleExceptRuntime: boolean;
    publicationEffectKey: string;
    nowMs?: number;
  },
): Promise<RuntimeRecoveryCanaryPermitDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const safetyReason = await evaluateLiveSafety({ ...input, nowMs });
  if (safetyReason) return { allowed: false, reasonCode: safetyReason };
  let decision!: RuntimeRecoveryCanaryPermitDecision;
  await runTransaction<RuntimeRecoveryCanaryPermit>(COLLECTION, permits => {
    const expired = expirePermits(permits, nowMs);
    const permit = permits.find(item => item.id === input.permitId);
    if (!permit) {
      decision = { allowed: false, reasonCode: 'RECOVERY_CANARY_PERMIT_NOT_FOUND' };
      return expired ? permits : undefined;
    }
    if (permit.status === 'EXPIRED'
      || (permit.status === 'ISSUED' && Date.parse(permit.expiresAt) <= nowMs)) {
      decision = { allowed: false, reasonCode: 'RECOVERY_CANARY_PERMIT_EXPIRED', permit: clonePermit(permit) };
      return permits;
    }
    if (!sameOwnership(permit, input)) {
      decision = { allowed: false, reasonCode: 'RECOVERY_CANARY_PERMIT_OWNERSHIP_MISMATCH', permit: clonePermit(permit) };
      return expired ? permits : undefined;
    }
    if (permit.status === 'CONSUMED') {
      const sameEffect = permit.publicationEffectKey === input.publicationEffectKey;
      decision = {
        allowed: sameEffect,
        reasonCode: sameEffect ? 'RECOVERY_CANARY_PERMIT_REUSED' : 'RECOVERY_CANARY_PERMIT_ALREADY_FINAL',
        permit: clonePermit(permit),
      };
      return expired ? permits : undefined;
    }
    if (permit.status !== 'ISSUED') {
      decision = { allowed: false, reasonCode: 'RECOVERY_CANARY_PERMIT_ALREADY_FINAL', permit: clonePermit(permit) };
      return expired ? permits : undefined;
    }
    permit.status = 'CONSUMED';
    permit.consumedAt = new Date(nowMs).toISOString();
    permit.publicationEffectKey = input.publicationEffectKey.slice(0, 240);
    decision = {
      allowed: true,
      reasonCode: 'RECOVERY_CANARY_PERMIT_REUSED',
      permit: clonePermit(permit),
    };
    return permits;
  });
  return decision;
}

export async function getRuntimeRecoveryCanaryPermit(
  permitId: string,
): Promise<RuntimeRecoveryCanaryPermit | null> {
  const permit = (await readCollection<RuntimeRecoveryCanaryPermit>(COLLECTION))
    .find(item => item.id === permitId);
  return permit ? clonePermit(permit) : null;
}

export async function validateRuntimeRecoveryCanaryPermitForOperation(
  input: PermitOwnershipInput & {
    permitId: string;
    productEligibleExceptRuntime: boolean;
    publicationEffectKey: string;
    nowMs?: number;
  },
): Promise<RuntimeRecoveryCanaryPermitDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const safetyReason = await evaluateLiveSafety({ ...input, nowMs });
  if (safetyReason) return { allowed: false, reasonCode: safetyReason };
  const permit = await getRuntimeRecoveryCanaryPermit(input.permitId);
  if (!permit) return { allowed: false, reasonCode: 'RECOVERY_CANARY_PERMIT_NOT_FOUND' };
  if (permit.operationId !== input.operationId
    || permit.productId !== input.productId
    || permit.jobId !== input.jobId
    || permit.publicationEffectKey !== input.publicationEffectKey) {
    return {
      allowed: false,
      reasonCode: 'RECOVERY_CANARY_PERMIT_OWNERSHIP_MISMATCH',
      permit,
    };
  }
  if (permit.status !== 'CONSUMED') {
    return {
      allowed: false,
      reasonCode: 'RECOVERY_CANARY_PERMIT_ALREADY_FINAL',
      permit,
    };
  }
  return {
    allowed: true,
    reasonCode: 'RECOVERY_CANARY_PERMIT_REUSED',
    permit,
  };
}

export async function listRuntimeRecoveryCanaryPermits(): Promise<RuntimeRecoveryCanaryPermit[]> {
  return (await readCollection<RuntimeRecoveryCanaryPermit>(COLLECTION)).map(clonePermit);
}

export async function finalizeRuntimeRecoveryCanaryPermit(input: {
  permitId: string;
  productId: string;
  healthy: boolean;
  reasonCode: string;
  publicationEffectKey?: string;
  nowMs?: number;
  preserveRuntimeBlock?: boolean;
  finalStatus?: 'SUCCEEDED' | 'FAILED' | 'REVOKED';
}): Promise<RuntimeRecoveryCanaryPermit | null> {
  const nowMs = input.nowMs ?? Date.now();
  let output: RuntimeRecoveryCanaryPermit | null = null;
  await runTransaction<RuntimeRecoveryCanaryPermit>(COLLECTION, permits => {
    const permit = permits.find(item => item.id === input.permitId && item.productId === input.productId);
    if (!permit) return undefined;
    if (input.publicationEffectKey
      && permit.publicationEffectKey
      && input.publicationEffectKey !== permit.publicationEffectKey) {
      throw new Error('RECOVERY_CANARY_PUBLICATION_EFFECT_MISMATCH');
    }
    if (['SUCCEEDED', 'FAILED', 'REVOKED'].includes(permit.status)) {
      output = clonePermit(permit);
      return undefined;
    }
    permit.status = input.finalStatus || (input.healthy ? 'SUCCEEDED' : 'FAILED');
    permit.completedAt = new Date(nowMs).toISOString();
    permit.outcomeReasonCode = input.reasonCode.slice(0, 200);
    output = clonePermit(permit);
    return permits;
  });
  const finalizedPermit = output as RuntimeRecoveryCanaryPermit | null;
  if (!finalizedPermit) return null;

  const failed = finalizedPermit.status === 'FAILED'
    || (finalizedPermit.status === 'REVOKED' && input.preserveRuntimeBlock);
  if (failed) {
    await updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: [input.reasonCode],
      reason: input.reasonCode,
    }, 'runtime-recovery-canary');
    await transitionRecoveryStateForPermit(undefined, 'OPEN_BLOCKED', input.reasonCode, nowMs);
  } else {
    await transitionRecoveryStateForPermit(undefined, 'RECOVERY_OBSERVING', undefined, nowMs);
  }
  return finalizedPermit;
}
