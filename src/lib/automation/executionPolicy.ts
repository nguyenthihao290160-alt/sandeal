import { createHash } from 'node:crypto';
import type { AutomationJob, AutomationJobType } from './types';

export type AutomationConcurrencyClass =
  | 'CONTROL'
  | 'PRODUCT'
  | 'SOURCE_NETWORK'
  | 'PROVIDER'
  | 'PROJECTION_MAINTENANCE'
  | 'STORAGE_EXCLUSIVE'
  | 'GENERAL';

export interface AutomationExecutionPolicy {
  concurrencyClass: AutomationConcurrencyClass;
  critical: boolean;
  exclusive: boolean;
  resourceScope: 'NONE' | 'PRODUCT' | 'CANDIDATE' | 'SOURCE' | 'GLOBAL';
  providerBudgetClass?: string;
}

export interface AutomationExecutionDescriptor extends AutomationExecutionPolicy {
  resourceKeys: string[];
}

/**
 * Claim lanes are deliberately narrower than general priority.  The legacy
 * Guardian lanes remain supported while the V3 rollout can reserve capacity
 * for every operationally-critical job.
 */
export type AutomationWorkerClaimLane =
  | 'ANY'
  | 'RUNTIME_GUARDIAN'
  | 'NON_GUARDIAN'
  | 'CRITICAL'
  | 'NON_CRITICAL';

export type AutomationPriorityClass = 'CRITICAL' | 'NORMAL';

const CRITICAL_JOB_TYPES = new Set<AutomationJobType>([
  'RUNTIME_GUARDIAN',
  'POST_PUBLISH_MONITOR',
]);

const PRODUCT_JOB_TYPES = new Set<AutomationJobType>([
  'PROCESS_CANDIDATE',
  'AUTO_SAFE_PUBLISH',
  'POST_PUBLISH_MONITOR',
  'SAFE_PUBLISH',
  'IMPORT_PRODUCTS',
  'RECHECK_PRODUCT_HEALTH',
  'DETECT_DUPLICATES',
  'SCORE_PRODUCTS',
  'CAPTURE_PRICE_HISTORY',
  'PREPARE_CONTENT_DRAFT',
  'EDITORIAL_CHECK',
]);

const CONTROL_JOB_TYPES = new Set<AutomationJobType>([
  'RUNTIME_GUARDIAN',
  'HEALTH_CHECK',
  'EVALUATE_ALERTS',
  'AGGREGATE_GROWTH_METRICS',
]);

function isProjectionRepairJob(input: Pick<AutomationJob, 'type' | 'payload'>): boolean {
  return input.type === 'RECONCILE_AUTOMATION'
    && input.payload.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD';
}

function policyForType(type: AutomationJobType): AutomationExecutionPolicy {
  if (type === 'BULK_PRODUCT_OPERATION' || type === 'RECONCILE_AUTOMATION') {
    return {
      concurrencyClass: 'STORAGE_EXCLUSIVE',
      critical: false,
      exclusive: true,
      resourceScope: 'GLOBAL',
    };
  }
  if (type === 'PRODUCT_SCAN' || type === 'AUTO_PILOT') {
    return {
      concurrencyClass: 'SOURCE_NETWORK',
      critical: false,
      exclusive: false,
      resourceScope: 'SOURCE',
      providerBudgetClass: 'INGESTION',
    };
  }
  if (type === 'AI_ANALYSIS') {
    return {
      concurrencyClass: 'PROVIDER',
      critical: false,
      exclusive: false,
      resourceScope: 'NONE',
      providerBudgetClass: 'AI_FREE',
    };
  }
  if (PRODUCT_JOB_TYPES.has(type)) {
    return {
      concurrencyClass: 'PRODUCT',
      critical: CRITICAL_JOB_TYPES.has(type),
      exclusive: false,
      resourceScope: type === 'PROCESS_CANDIDATE' ? 'CANDIDATE' : 'PRODUCT',
    };
  }
  if (CONTROL_JOB_TYPES.has(type)) {
    return {
      concurrencyClass: 'CONTROL',
      critical: CRITICAL_JOB_TYPES.has(type),
      exclusive: false,
      resourceScope: 'NONE',
    };
  }
  return {
    concurrencyClass: 'GENERAL',
    critical: CRITICAL_JOB_TYPES.has(type),
    exclusive: false,
    resourceScope: 'NONE',
  };
}

function stableResourceKey(kind: string, value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `${kind}:${digest}`;
}

function payloadIdentifiers(payload: Record<string, unknown>, singular: string, plural: string): string[] {
  const values = [
    typeof payload[singular] === 'string' ? payload[singular] : undefined,
    ...(Array.isArray(payload[plural]) ? payload[plural] : []),
  ];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100);
}

export function getAutomationExecutionDescriptor(
  job: Pick<AutomationJob, 'type' | 'payload' | 'operationId'>,
): AutomationExecutionDescriptor {
  if (
    isProjectionRepairJob(job)
  ) {
    return {
      concurrencyClass: 'PROJECTION_MAINTENANCE',
      // Repair heartbeat and promotion carry the serving projection's safety
      // boundary. They must not sit behind long product or alert work once
      // the guarded critical-lane rollout is enabled.
      critical: true,
      exclusive: false,
      resourceScope: 'NONE',
      resourceKeys: ['projection:automation-job-health'],
    };
  }
  const policy = policyForType(job.type);
  const keys = new Set<string>();
  if (policy.resourceScope === 'GLOBAL') keys.add('storage:global');
  if (policy.resourceScope === 'SOURCE') keys.add('source:ingestion');
  if (policy.resourceScope === 'PRODUCT') {
    for (const productId of payloadIdentifiers(job.payload, 'productId', 'productIds')) {
      const key = stableResourceKey('product', productId);
      if (key) keys.add(key);
    }
    if (!keys.size) keys.add('product:all');
  }
  if (policy.resourceScope === 'CANDIDATE') {
    const key = stableResourceKey('candidate', job.payload.candidateId);
    keys.add(key || 'candidate:all');
  }
  if (['AUTO_SAFE_PUBLISH', 'SAFE_PUBLISH'].includes(job.type)) {
    const key = stableResourceKey('publication-operation', job.operationId);
    if (key) keys.add(key);
  }
  const provider = stableResourceKey('provider', job.payload.providerId || job.payload.provider);
  if (provider) keys.add(provider);
  return { ...policy, resourceKeys: [...keys].sort() };
}

export function automationJobsConflict(
  left: Pick<AutomationJob, 'type' | 'payload' | 'operationId'>,
  right: Pick<AutomationJob, 'type' | 'payload' | 'operationId'>,
): boolean {
  const leftDescriptor = getAutomationExecutionDescriptor(left);
  const rightDescriptor = getAutomationExecutionDescriptor(right);
  if (leftDescriptor.exclusive || rightDescriptor.exclusive) return true;
  const leftKeys = new Set(leftDescriptor.resourceKeys);
  return rightDescriptor.resourceKeys.some(key => leftKeys.has(key));
}

export function isCriticalAutomationJob(
  input: AutomationJobType | Pick<AutomationJob, 'type' | 'payload'>,
  payload: Record<string, unknown> = {},
): boolean {
  const job = typeof input === 'string'
    ? { type: input, payload }
    : input;
  return CRITICAL_JOB_TYPES.has(job.type) || isProjectionRepairJob(job);
}

export function isRuntimeGuardianJob(type: AutomationJobType): boolean {
  return type === 'RUNTIME_GUARDIAN';
}

export function automationPriorityClassForJob(
  job: Pick<AutomationJob, 'type' | 'payload'>,
): AutomationPriorityClass {
  return isCriticalAutomationJob(job) ? 'CRITICAL' : 'NORMAL';
}

export function isAutomationJobEligibleForClaimLane(
  job: Pick<AutomationJob, 'type' | 'payload'>,
  lane: AutomationWorkerClaimLane,
): boolean {
  if (lane === 'ANY') return true;
  if (lane === 'RUNTIME_GUARDIAN') return isRuntimeGuardianJob(job.type);
  if (lane === 'NON_GUARDIAN') return !isRuntimeGuardianJob(job.type);
  const critical = isCriticalAutomationJob(job);
  return lane === 'CRITICAL' ? critical : !critical;
}

export function selectCompatibleWorkerJobs(
  candidates: AutomationJob[],
  activeJobs: AutomationJob[],
  limit: number,
  nowMs: number,
  fairSelector: (items: AutomationJob[], limit: number, nowMs: number) => AutomationJob[],
  criticalReservedCapacity = 1,
  laneCapacity?: {
    /** V3 all-critical lane capacities. */
    critical?: number;
    normal?: number;
    /** Legacy Guardian-only lane capacities. */
    runtimeGuardian?: number;
    nonGuardian?: number;
  },
  /**
   * Used only by the V3 guarded worker path when there is no separately
   * reservable slot (for example, maxConcurrency=1). It makes a newly free
   * shared slot pick critical work first without changing capacity.
   */
  preferCritical = false,
): AutomationJob[] {
  const maximum = Math.max(0, Math.min(10, Math.floor(limit)));
  if (!maximum) return [];
  const selected: AutomationJob[] = [];
  const compatible = (candidate: AutomationJob) =>
    [...activeJobs, ...selected].every(active => !automationJobsConflict(candidate, active));
  // Existing callers use the Guardian-only capacity shape.  Do not silently
  // reinterpret that safe legacy lane as an all-critical lane; V3 opts in by
  // passing the explicit critical/normal capacity shape.
  const allCriticalCapacity = laneCapacity?.critical !== undefined
    || laneCapacity?.normal !== undefined;
  const reservedCritical = (candidate: AutomationJob) => (allCriticalCapacity || preferCritical)
    ? isCriticalAutomationJob(candidate)
    : isRuntimeGuardianJob(candidate.type);
  const criticalLimit = Math.min(
    maximum,
    preferCritical
      ? maximum
      : laneCapacity
        ? Math.max(0, Math.floor(
          (allCriticalCapacity ? laneCapacity.critical : laneCapacity.runtimeGuardian)
          ?? criticalReservedCapacity,
        ))
        : Math.max(0, Math.floor(criticalReservedCapacity)),
  );
  if (criticalLimit > 0) {
    const critical = fairSelector(
      candidates.filter(reservedCritical),
      criticalLimit,
      nowMs,
    );
    for (const candidate of critical) {
      if (compatible(candidate)) selected.push(candidate);
    }
  }
  const selectedIds = new Set(selected.map(job => job.id));
  let selectedCritical = selected.filter(reservedCritical).length;
  let selectedNormal = selected.length - selectedCritical;
  const criticalCapacity = laneCapacity
    ? Math.max(0, Math.floor(
      (allCriticalCapacity ? laneCapacity.critical : laneCapacity.runtimeGuardian)
      ?? maximum,
    ))
    : maximum;
  const normalCapacity = laneCapacity
    ? Math.max(0, Math.floor(
      (allCriticalCapacity ? laneCapacity.normal : laneCapacity.nonGuardian)
      ?? maximum,
    ))
    : maximum;
  const remainder = fairSelector(
    candidates.filter(candidate => !selectedIds.has(candidate.id)),
    candidates.length,
    nowMs,
  );
  for (const candidate of remainder) {
    if (selected.length >= maximum) break;
    const critical = reservedCritical(candidate);
    if (critical ? selectedCritical >= criticalCapacity : selectedNormal >= normalCapacity) continue;
    if (!compatible(candidate)) continue;
    selected.push(candidate);
    if (critical) selectedCritical += 1;
    else selectedNormal += 1;
  }
  return selected;
}
