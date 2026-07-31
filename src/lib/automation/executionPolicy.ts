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
    job.type === 'RECONCILE_AUTOMATION'
    && job.payload.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD'
  ) {
    return {
      concurrencyClass: 'PROJECTION_MAINTENANCE',
      critical: false,
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

export function isCriticalAutomationJob(type: AutomationJobType): boolean {
  return CRITICAL_JOB_TYPES.has(type);
}

export function isRuntimeGuardianJob(type: AutomationJobType): boolean {
  return type === 'RUNTIME_GUARDIAN';
}

export function selectCompatibleWorkerJobs(
  candidates: AutomationJob[],
  activeJobs: AutomationJob[],
  limit: number,
  nowMs: number,
  fairSelector: (items: AutomationJob[], limit: number, nowMs: number) => AutomationJob[],
  criticalReservedCapacity = 1,
  laneCapacity?: {
    runtimeGuardian: number;
    nonGuardian: number;
  },
): AutomationJob[] {
  const maximum = Math.max(0, Math.min(10, Math.floor(limit)));
  if (!maximum) return [];
  const selected: AutomationJob[] = [];
  const compatible = (candidate: AutomationJob) =>
    [...activeJobs, ...selected].every(active => !automationJobsConflict(candidate, active));
  const runtimeGuardianLimit = Math.min(
    maximum,
    laneCapacity
      ? Math.max(0, Math.floor(laneCapacity.runtimeGuardian))
      : Math.max(0, Math.floor(criticalReservedCapacity)),
  );
  if (runtimeGuardianLimit > 0) {
    const guardians = fairSelector(
      candidates.filter(candidate => isRuntimeGuardianJob(candidate.type)),
      runtimeGuardianLimit,
      nowMs,
    );
    for (const candidate of guardians) {
      if (compatible(candidate)) selected.push(candidate);
    }
  }
  const selectedIds = new Set(selected.map(job => job.id));
  let selectedGuardians = selected.filter(job => isRuntimeGuardianJob(job.type)).length;
  let selectedNonGuardians = selected.length - selectedGuardians;
  const guardianCapacity = laneCapacity
    ? Math.max(0, Math.floor(laneCapacity.runtimeGuardian))
    : maximum;
  const nonGuardianCapacity = laneCapacity
    ? Math.max(0, Math.floor(laneCapacity.nonGuardian))
    : maximum;
  const remainder = fairSelector(
    candidates.filter(candidate => !selectedIds.has(candidate.id)),
    candidates.length,
    nowMs,
  );
  for (const candidate of remainder) {
    if (selected.length >= maximum) break;
    const guardian = isRuntimeGuardianJob(candidate.type);
    if (guardian ? selectedGuardians >= guardianCapacity : selectedNonGuardians >= nonGuardianCapacity) continue;
    if (!compatible(candidate)) continue;
    selected.push(candidate);
    if (guardian) selectedGuardians += 1;
    else selectedNonGuardians += 1;
  }
  return selected;
}
