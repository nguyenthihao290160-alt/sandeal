import type { RuntimeHealthSnapshot } from './runtimeGuardian';
import type { RuntimeRoleConflict, RuntimeRoleLease } from './runtimeRoles';

export const CURRENT_REASON_RECONCILIATION_VERSION = 'current-reason-reconciliation-v1';
export const DEFAULT_ROLE_HEARTBEAT_FRESHNESS_MS = 90_000;
export const DEFAULT_RUNTIME_SNAPSHOT_FRESHNESS_MS = 3 * 60_000;

type RuntimeRole = 'WORKER' | 'SCHEDULER';
type ReasonState = 'ACTIVE' | 'HISTORICAL' | 'ABSENT';

const HEARTBEAT_REASON_CODES: Readonly<Record<RuntimeRole, ReadonlySet<string>>> = {
  WORKER: new Set([
    'WORKER_HEARTBEAT_STALE',
    'WORKER_STALE',
    'WORKER_MISSING',
    'WORKER_CRASHED',
    'WORKER_UNVERIFIED',
  ]),
  SCHEDULER: new Set([
    'SCHEDULER_HEARTBEAT_STALE',
    'SCHEDULER_STALE',
    'SCHEDULER_MISSING',
    'SCHEDULER_CRASHED',
    'SCHEDULER_UNVERIFIED',
  ]),
};

export type CurrentReasonTransitionType =
  | 'CLEARED_BY_CURRENT_EVIDENCE'
  | 'RETAINED_FAIL_CLOSED'
  | 'ADDED_FAIL_CLOSED'
  | 'UNCHANGED_CURRENT'
  | 'UNCHANGED_HISTORICAL';

export interface CurrentReasonTransition {
  reasonCode: string;
  previousState: ReasonState;
  resultingState: ReasonState;
  transitionType: CurrentReasonTransitionType;
  evaluatedAt: string;
  releaseId: string;
  evidenceTimestamps: {
    runtimeCheckedAt: string | null;
    leaseHeartbeatAt: string | null;
    leaseExpiresAt: string | null;
    conflictObservedAt: string | null;
  };
  evidenceReferences: string[];
  evidenceReasonCodes: string[];
}

export interface CurrentRoleEvidence {
  role: RuntimeRole;
  valid: boolean;
  reasonCodes: string[];
  runtimeCheckedAt: string | null;
  leaseHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  conflictObservedAt: string | null;
  evidenceReferences: string[];
}

export interface CurrentReasonReconciliation {
  schemaVersion: 1;
  reconciliationVersion: typeof CURRENT_REASON_RECONCILIATION_VERSION;
  evaluatedAt: string;
  releaseId: string;
  currentActiveReasons: string[];
  historicalAuditReasons: string[];
  transitions: CurrentReasonTransition[];
  roleEvidence: {
    worker: CurrentRoleEvidence;
    scheduler: CurrentRoleEvidence;
  };
}

export interface CurrentReasonReconciliationInput {
  now: number;
  releaseId: string;
  candidateCurrentReasons: string[];
  historicalReasons: string[];
  runtime: RuntimeHealthSnapshot | null;
  leases: RuntimeRoleLease[];
  conflicts: RuntimeRoleConflict[];
  workerRequired?: boolean;
  schedulerRequired?: boolean;
  heartbeatFreshnessMs?: number;
  runtimeFreshnessMs?: number;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))].sort();
}

function validTimestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeReference(value: string): string | null {
  const normalized = value.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 200);
  return normalized.length >= 4 ? normalized : null;
}

function roleRuntimeEvidence(
  runtime: RuntimeHealthSnapshot | null,
  role: RuntimeRole,
): RuntimeHealthSnapshot['worker'] | RuntimeHealthSnapshot['scheduler'] | undefined {
  return role === 'WORKER' ? runtime?.worker : runtime?.scheduler;
}

function evaluateRoleEvidence(
  input: CurrentReasonReconciliationInput,
  role: RuntimeRole,
  required: boolean,
): CurrentRoleEvidence {
  const heartbeatFreshnessMs = Math.max(
    5_000,
    input.heartbeatFreshnessMs ?? DEFAULT_ROLE_HEARTBEAT_FRESHNESS_MS,
  );
  const runtimeFreshnessMs = Math.max(
    heartbeatFreshnessMs,
    input.runtimeFreshnessMs ?? DEFAULT_RUNTIME_SNAPSHOT_FRESHNESS_MS,
  );
  const roleLeases = input.leases.filter(lease => lease.role === role);
  const lease = roleLeases[0];
  const runtimeRole = roleRuntimeEvidence(input.runtime, role);
  const runtimeCheckedAt = validTimestamp(input.runtime?.checkedAt);
  const heartbeatAt = validTimestamp(lease?.heartbeatAt);
  const leaseExpiresAt = validTimestamp(lease?.leaseExpiresAt || lease?.expiresAt);
  const processStartedAt = validTimestamp(lease?.processStartedAt || lease?.acquiredAt);
  const matchingConflicts = input.conflicts.filter(conflict =>
    conflict.role === role
    && (!lease?.instanceId || conflict.activeInstanceId === lease.instanceId)
    && (processStartedAt === null || (validTimestamp(conflict.observedAt) || 0) >= processStartedAt));
  const latestConflict = [...matchingConflicts]
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
  const reasonCodes: string[] = [];

  if (!required) reasonCodes.push(`${role}_ROLE_NOT_REQUIRED`);
  if (required && roleLeases.length === 0) reasonCodes.push(`${role}_LEASE_MISSING`);
  if (required && roleLeases.length > 1) reasonCodes.push(`${role}_DUPLICATE_LEASE_RECORD`);
  if (required && lease?.status !== 'ACTIVE') reasonCodes.push(`${role}_LEASE_NOT_ACTIVE`);
  if (required && (leaseExpiresAt === null || leaseExpiresAt <= input.now)) {
    reasonCodes.push(`${role}_LEASE_STALE`);
  }
  if (
    required
    && (
      heartbeatAt === null
      || heartbeatAt > input.now + 60_000
      || input.now - heartbeatAt > heartbeatFreshnessMs
    )
  ) {
    reasonCodes.push(`${role}_HEARTBEAT_STALE`);
  }
  if (
    required
    && (
      runtimeCheckedAt === null
      || runtimeCheckedAt > input.now + 60_000
      || input.now - runtimeCheckedAt > runtimeFreshnessMs
    )
  ) {
    reasonCodes.push(`${role}_RUNTIME_SNAPSHOT_STALE`);
  }
  if (required && runtimeRole?.status !== 'active') reasonCodes.push(`${role}_PROCESS_NOT_ACTIVE`);
  if (required && (!lease?.releaseId || lease.releaseId !== input.releaseId)) {
    reasonCodes.push(`${role}_LEASE_RELEASE_MISMATCH`);
  }
  if (required && (!runtimeRole?.releaseId || runtimeRole.releaseId !== input.releaseId)) {
    reasonCodes.push(`${role}_RUNTIME_RELEASE_MISMATCH`);
  }
  if (
    required
    && (
      !lease?.ownerId
      || !lease.instanceId
      || !runtimeRole?.holderId
      || runtimeRole.holderId !== lease.ownerId
      || runtimeRole.instanceId !== lease.instanceId
    )
  ) {
    reasonCodes.push(`${role}_ROLE_IDENTITY_MISMATCH`);
  }
  if (
    required
    && (
      !Number.isInteger(lease?.pid)
      || Number(lease?.pid) <= 0
      || !Number.isInteger(runtimeRole?.pid)
      || runtimeRole?.pid !== lease?.pid
    )
  ) {
    reasonCodes.push(`${role}_PID_OWNERSHIP_MISMATCH`);
  }
  if (
    required
    && (
      !Number.isInteger(lease?.fencingToken)
      || Number(lease?.fencingToken) <= 0
      || !Number.isInteger(runtimeRole?.fencingToken)
      || runtimeRole?.fencingToken !== lease?.fencingToken
    )
  ) {
    reasonCodes.push(`${role}_FENCING_TOKEN_MISMATCH`);
  }
  if (required && matchingConflicts.length > 0) reasonCodes.push(`${role}_DUPLICATE_ROLE_CONFLICT`);

  const references = unique([
    ...(input.runtime?.id ? [`runtime-health:${input.runtime.id}`] : []),
    ...(lease ? [`runtime-role:${role}:${lease.fencingToken || 0}`] : []),
    ...matchingConflicts.map(conflict => `runtime-role-conflict:${conflict.id}`),
  ].flatMap(reference => safeReference(reference) || []));

  return {
    role,
    valid: !required || reasonCodes.length === 0,
    reasonCodes: unique(reasonCodes),
    runtimeCheckedAt: runtimeCheckedAt === null ? null : new Date(runtimeCheckedAt).toISOString(),
    leaseHeartbeatAt: heartbeatAt === null ? null : new Date(heartbeatAt).toISOString(),
    leaseExpiresAt: leaseExpiresAt === null ? null : new Date(leaseExpiresAt).toISOString(),
    conflictObservedAt: latestConflict?.observedAt || null,
    evidenceReferences: references,
  };
}

function stateOf(reason: string, current: Set<string>, historical: Set<string>): ReasonState {
  if (current.has(reason)) return 'ACTIVE';
  if (historical.has(reason)) return 'HISTORICAL';
  return 'ABSENT';
}

export function reconcileCurrentReasons(
  input: CurrentReasonReconciliationInput,
): CurrentReasonReconciliation {
  const evaluatedAt = new Date(input.now).toISOString();
  const initialCurrent = new Set(unique(input.candidateCurrentReasons));
  const historical = new Set(unique(input.historicalReasons));
  const resultingCurrent = new Set(initialCurrent);
  const worker = evaluateRoleEvidence(input, 'WORKER', input.workerRequired !== false);
  const scheduler = evaluateRoleEvidence(input, 'SCHEDULER', input.schedulerRequired !== false);
  const evidenceByRole = { WORKER: worker, SCHEDULER: scheduler } as const;
  const transitions: CurrentReasonTransition[] = [];

  for (const role of ['WORKER', 'SCHEDULER'] as const) {
    const evidence = evidenceByRole[role];
    const matchingReasons = [...HEARTBEAT_REASON_CODES[role]].filter(reason =>
      initialCurrent.has(reason) || historical.has(reason));

    if (evidence.valid) {
      for (const reasonCode of matchingReasons) {
        const previousState = stateOf(reasonCode, initialCurrent, historical);
        resultingCurrent.delete(reasonCode);
        historical.add(reasonCode);
        transitions.push({
          reasonCode,
          previousState,
          resultingState: 'HISTORICAL',
          transitionType: previousState === 'ACTIVE'
            ? 'CLEARED_BY_CURRENT_EVIDENCE'
            : 'UNCHANGED_HISTORICAL',
          evaluatedAt,
          releaseId: input.releaseId,
          evidenceTimestamps: {
            runtimeCheckedAt: evidence.runtimeCheckedAt,
            leaseHeartbeatAt: evidence.leaseHeartbeatAt,
            leaseExpiresAt: evidence.leaseExpiresAt,
            conflictObservedAt: evidence.conflictObservedAt,
          },
          evidenceReferences: evidence.evidenceReferences,
          evidenceReasonCodes: [],
        });
      }
      continue;
    }

    const canonicalReason = `${role}_HEARTBEAT_STALE`;
    const currentMatching = [...HEARTBEAT_REASON_CODES[role]].filter(reason => resultingCurrent.has(reason));
    if (currentMatching.length === 0) resultingCurrent.add(canonicalReason);
    const reportedReasons = currentMatching.length ? currentMatching : [canonicalReason];
    for (const reasonCode of reportedReasons) {
      const previousState = stateOf(reasonCode, initialCurrent, historical);
      transitions.push({
        reasonCode,
        previousState,
        resultingState: 'ACTIVE',
        transitionType: previousState === 'ACTIVE'
          ? 'RETAINED_FAIL_CLOSED'
          : 'ADDED_FAIL_CLOSED',
        evaluatedAt,
        releaseId: input.releaseId,
        evidenceTimestamps: {
          runtimeCheckedAt: evidence.runtimeCheckedAt,
          leaseHeartbeatAt: evidence.leaseHeartbeatAt,
          leaseExpiresAt: evidence.leaseExpiresAt,
          conflictObservedAt: evidence.conflictObservedAt,
        },
        evidenceReferences: evidence.evidenceReferences,
        evidenceReasonCodes: evidence.reasonCodes,
      });
    }
  }

  for (const reasonCode of initialCurrent) {
    if (transitions.some(transition => transition.reasonCode === reasonCode)) continue;
    transitions.push({
      reasonCode,
      previousState: 'ACTIVE',
      resultingState: 'ACTIVE',
      transitionType: 'UNCHANGED_CURRENT',
      evaluatedAt,
      releaseId: input.releaseId,
      evidenceTimestamps: {
        runtimeCheckedAt: input.runtime?.checkedAt || null,
        leaseHeartbeatAt: null,
        leaseExpiresAt: null,
        conflictObservedAt: null,
      },
      evidenceReferences: input.runtime?.id ? [`runtime-health:${input.runtime.id}`] : [],
      evidenceReasonCodes: [],
    });
  }

  for (const reasonCode of historical) {
    if (resultingCurrent.has(reasonCode)) historical.delete(reasonCode);
  }

  return {
    schemaVersion: 1,
    reconciliationVersion: CURRENT_REASON_RECONCILIATION_VERSION,
    evaluatedAt,
    releaseId: input.releaseId,
    currentActiveReasons: unique(resultingCurrent),
    historicalAuditReasons: unique(historical),
    transitions: transitions.sort((left, right) => left.reasonCode.localeCompare(right.reasonCode)),
    roleEvidence: { worker, scheduler },
  };
}
