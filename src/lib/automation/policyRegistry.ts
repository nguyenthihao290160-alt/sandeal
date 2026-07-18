import type {
  ActualExecutionMode,
  ApprovalStatus,
  AutomationJobType,
  AutomationRiskLevel,
  BotRegistryEntry,
  RequestedExecutionMode,
} from './types';

export const AUTOMATION_POLICY_SCHEMA_VERSION = 1;
export const AUTOMATION_POLICY_VERSION = 'prompt10-policy-v1';

export type ApprovalMode = 'NEVER' | 'OWNER_OVERRIDE' | 'REQUIRED';
export type PublishPermission = 'NONE' | 'SHADOW_ONLY' | 'AUTONOMOUS_GUARDED' | 'OWNER_APPROVED';
export type AutomationBudgetClass = 'CONTROL' | 'INGESTION' | 'NETWORK' | 'AI_FREE' | 'CONTENT' | 'PUBLISH' | 'MONITORING';

export interface AutomationPolicy {
  schemaVersion: number;
  policyVersion: string;
  capability: string;
  jobType: AutomationJobType;
  botId: string;
  defaultRisk: AutomationRiskLevel;
  autonomousAllowed: boolean;
  approvalMode: ApprovalMode;
  writeScope: string[];
  externalSideEffect: boolean;
  retryPolicy: { maxAttempts: number; baseDelayMs: number; maximumDelayMs: number; retryableCodes: string[] };
  fallbackPolicy: ActualExecutionMode[];
  quarantinePolicy: 'NEVER' | 'ON_INVALID_INPUT' | 'ON_EXHAUSTED_RETRY' | 'ON_ANY_POLICY_FAILURE';
  publishPermission: PublishPermission;
  budgetClass: AutomationBudgetClass;
  idempotencyStrategy: string;
  handlerVersion: string;
  defaultExecutionMode: RequestedExecutionMode;
  ownerEnqueueAllowed: boolean;
}

const RETRYABLE = [
  'TIMEOUT', 'RATE_LIMITED', 'NETWORK_ERROR', 'PROVIDER_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'TEMPORARY_ERROR',
  'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMIT', 'IMAGE_HOTLINK_BLOCKED', 'STORAGE_ERROR',
];

function policy(
  input: Omit<AutomationPolicy, 'schemaVersion' | 'policyVersion' | 'retryPolicy' | 'handlerVersion' | 'ownerEnqueueAllowed'>
    & Partial<Pick<AutomationPolicy, 'retryPolicy' | 'handlerVersion' | 'ownerEnqueueAllowed'>>,
): AutomationPolicy {
  return {
    schemaVersion: AUTOMATION_POLICY_SCHEMA_VERSION,
    policyVersion: AUTOMATION_POLICY_VERSION,
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 5_000,
      maximumDelayMs: 15 * 60_000,
      retryableCodes: RETRYABLE,
      ...input.retryPolicy,
    },
    handlerVersion: input.handlerVersion || 'prompt10-handler-v1',
    ownerEnqueueAllowed: input.ownerEnqueueAllowed ?? true,
    ...input,
  };
}

const POLICIES: readonly AutomationPolicy[] = [
  policy({ capability: 'INGEST_SOURCES', jobType: 'PRODUCT_SCAN', botId: 'SOURCE_INTAKE', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['candidate-queue', 'automation-jobs'], externalSideEffect: true, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_EXHAUSTED_RETRY', publishPermission: 'NONE', budgetClass: 'INGESTION', idempotencyStrategy: 'source-time-bucket', defaultExecutionMode: 'AUTO' }),
  policy({ capability: 'ORCHESTRATE_OPERATIONS', jobType: 'AUTO_PILOT', botId: 'OPERATIONS_ORCHESTRATOR', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['automation-jobs', 'operation-journal', 'candidate-queue', 'source-keyword-state', 'pipeline-daily-usage'], externalSideEffect: true, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'NEVER', publishPermission: 'NONE', budgetClass: 'INGESTION', idempotencyStrategy: 'cycle-time-bucket', defaultExecutionMode: 'AUTO' }),
  policy({ capability: 'PROCESS_CANDIDATE', jobType: 'PROCESS_CANDIDATE', botId: 'PRODUCT_LIFECYCLE_ENGINE', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['candidate-queue', 'products', 'evidence-facts', 'automation-jobs', 'operation-journal'], externalSideEffect: true, fallbackPolicy: ['LOCAL_RULES', 'LOCAL_TEMPLATE'], quarantinePolicy: 'ON_ANY_POLICY_FAILURE', publishPermission: 'NONE', budgetClass: 'NETWORK', idempotencyStrategy: 'candidate-source-hash', defaultExecutionMode: 'AUTO', ownerEnqueueAllowed: false }),
  policy({ capability: 'AUTO_SAFE_PUBLISH', jobType: 'AUTO_SAFE_PUBLISH', botId: 'AUTONOMOUS_PUBLISH_GUARD', defaultRisk: 'LOW', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['products', 'publication-audit', 'automation-jobs', 'operation-journal'], externalSideEffect: true, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_ANY_POLICY_FAILURE', publishPermission: 'AUTONOMOUS_GUARDED', budgetClass: 'PUBLISH', idempotencyStrategy: 'product-readiness-snapshot', defaultExecutionMode: 'LOCAL_ONLY', retryPolicy: { maxAttempts: 3, baseDelayMs: 5_000, maximumDelayMs: 15 * 60_000, retryableCodes: RETRYABLE }, ownerEnqueueAllowed: false }),
  policy({ capability: 'POST_PUBLISH_MONITOR', jobType: 'POST_PUBLISH_MONITOR', botId: 'POST_PUBLISH_GUARDIAN', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['products', 'evidence-facts', 'automation-jobs'], externalSideEffect: true, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_EXHAUSTED_RETRY', publishPermission: 'AUTONOMOUS_GUARDED', budgetClass: 'MONITORING', idempotencyStrategy: 'product-monitor-window', defaultExecutionMode: 'LOCAL_ONLY', ownerEnqueueAllowed: false }),
  policy({ capability: 'RECONCILE_AUTOMATION', jobType: 'RECONCILE_AUTOMATION', botId: 'AUTONOMOUS_RECONCILER', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['automation-jobs', 'candidate-queue', 'products', 'operation-journal'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'NEVER', publishPermission: 'NONE', budgetClass: 'CONTROL', idempotencyStrategy: 'reconcile-time-bucket', defaultExecutionMode: 'LOCAL_ONLY', ownerEnqueueAllowed: false }),
  policy({ capability: 'RUNTIME_GUARDIAN', jobType: 'RUNTIME_GUARDIAN', botId: 'RUNTIME_GUARDIAN', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['automation-control', 'runtime-health'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'NEVER', publishPermission: 'NONE', budgetClass: 'CONTROL', idempotencyStrategy: 'guardian-time-bucket', defaultExecutionMode: 'LOCAL_ONLY', ownerEnqueueAllowed: false }),
  policy({ capability: 'ENFORCE_SAFETY_POLICY', jobType: 'SAFE_PUBLISH', botId: 'POLICY_SAFETY_GUARD', defaultRisk: 'HIGH', autonomousAllowed: false, approvalMode: 'REQUIRED', writeScope: ['products', 'publication-audit'], externalSideEffect: true, fallbackPolicy: ['MANUAL_INPUT'], quarantinePolicy: 'ON_ANY_POLICY_FAILURE', publishPermission: 'OWNER_APPROVED', budgetClass: 'PUBLISH', idempotencyStrategy: 'owner-approved-product-snapshot', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'ANALYZE_WITH_EVIDENCE', jobType: 'AI_ANALYSIS', botId: 'EVIDENCE_GROUNDED_ANALYST', defaultRisk: 'MEDIUM', autonomousAllowed: false, approvalMode: 'OWNER_OVERRIDE', writeScope: ['analysis-drafts'], externalSideEffect: true, fallbackPolicy: ['LOCAL_TEMPLATE', 'MANUAL_INPUT'], quarantinePolicy: 'ON_EXHAUSTED_RETRY', publishPermission: 'NONE', budgetClass: 'AI_FREE', idempotencyStrategy: 'evidence-input-hash', defaultExecutionMode: 'AUTO' }),
  policy({ capability: 'CHECK_SYSTEM_HEALTH', jobType: 'HEALTH_CHECK', botId: 'SYSTEM_HEALTH_INSPECTOR', defaultRisk: 'LOW', autonomousAllowed: true, approvalMode: 'OWNER_OVERRIDE', writeScope: [], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'NEVER', publishPermission: 'NONE', budgetClass: 'CONTROL', idempotencyStrategy: 'health-time-bucket', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'NORMALIZE_PRODUCT', jobType: 'IMPORT_PRODUCTS', botId: 'PRODUCT_NORMALIZER', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['products'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_INVALID_INPUT', publishPermission: 'NONE', budgetClass: 'CONTENT', idempotencyStrategy: 'import-row-hash', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'INSPECT_PRODUCT_HEALTH', jobType: 'RECHECK_PRODUCT_HEALTH', botId: 'HEALTH_INSPECTOR', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['product-health', 'products'], externalSideEffect: true, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_EXHAUSTED_RETRY', publishPermission: 'NONE', budgetClass: 'NETWORK', idempotencyStrategy: 'product-health-window', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'DETECT_DUPLICATES', jobType: 'DETECT_DUPLICATES', botId: 'DUPLICATE_RESOLVER', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['duplicate-groups'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_INVALID_INPUT', publishPermission: 'NONE', budgetClass: 'CONTENT', idempotencyStrategy: 'product-set-hash', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'SCORE_PRODUCTS', jobType: 'SCORE_PRODUCTS', botId: 'SCORING_ENGINE', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['product-scores'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'NEVER', publishPermission: 'NONE', budgetClass: 'CONTENT', idempotencyStrategy: 'product-score-version', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'CAPTURE_PRICE_HISTORY', jobType: 'CAPTURE_PRICE_HISTORY', botId: 'PRICE_WATCHER', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['price-history'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_INVALID_INPUT', publishPermission: 'NONE', budgetClass: 'CONTENT', idempotencyStrategy: 'product-price-window', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'PREPARE_CONTENT_DRAFT', jobType: 'PREPARE_CONTENT_DRAFT', botId: 'CONTENT_DRAFT_ASSISTANT', defaultRisk: 'MEDIUM', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['content-drafts'], externalSideEffect: false, fallbackPolicy: ['LOCAL_TEMPLATE'], quarantinePolicy: 'ON_INVALID_INPUT', publishPermission: 'NONE', budgetClass: 'CONTENT', idempotencyStrategy: 'product-evidence-hash', defaultExecutionMode: 'AUTO' }),
  policy({ capability: 'VALIDATE_EDITORIAL', jobType: 'EDITORIAL_CHECK', botId: 'EDITORIAL_GUARD', defaultRisk: 'HIGH', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['content-drafts', 'products'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_ANY_POLICY_FAILURE', publishPermission: 'NONE', budgetClass: 'CONTENT', idempotencyStrategy: 'content-evidence-hash', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'EVALUATE_ALERTS', jobType: 'EVALUATE_ALERTS', botId: 'ALERT_METRICS_ENGINE', defaultRisk: 'LOW', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['alerts'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'NEVER', publishPermission: 'NONE', budgetClass: 'CONTROL', idempotencyStrategy: 'alert-time-bucket', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'AGGREGATE_GROWTH_METRICS', jobType: 'AGGREGATE_GROWTH_METRICS', botId: 'GROWTH_METRICS_AGGREGATOR', defaultRisk: 'LOW', autonomousAllowed: true, approvalMode: 'NEVER', writeScope: ['growth-metrics'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'NEVER', publishPermission: 'NONE', budgetClass: 'CONTROL', idempotencyStrategy: 'growth-time-bucket', defaultExecutionMode: 'LOCAL_ONLY' }),
  policy({ capability: 'BULK_PRODUCT_OPERATION', jobType: 'BULK_PRODUCT_OPERATION', botId: 'BULK_OPERATION_COORDINATOR', defaultRisk: 'MEDIUM', autonomousAllowed: false, approvalMode: 'OWNER_OVERRIDE', writeScope: ['products', 'product-health', 'product-scores', 'price-history', 'content-drafts', 'duplicate-groups'], externalSideEffect: false, fallbackPolicy: ['LOCAL_RULES'], quarantinePolicy: 'ON_INVALID_INPUT', publishPermission: 'NONE', budgetClass: 'CONTENT', idempotencyStrategy: 'bulk-selection-hash', defaultExecutionMode: 'LOCAL_ONLY' }),
];

export function listAutomationPolicies(): AutomationPolicy[] {
  return POLICIES.map(item => ({
    ...item,
    writeScope: [...item.writeScope],
    fallbackPolicy: [...item.fallbackPolicy],
    retryPolicy: { ...item.retryPolicy, retryableCodes: [...item.retryPolicy.retryableCodes] },
  }));
}

export function getAutomationPolicy(jobType: AutomationJobType): AutomationPolicy {
  const found = POLICIES.find(item => item.jobType === jobType);
  if (!found) throw new Error(`AUTOMATION_POLICY_NOT_FOUND:${jobType}`);
  return {
    ...found,
    writeScope: [...found.writeScope],
    fallbackPolicy: [...found.fallbackPolicy],
    retryPolicy: { ...found.retryPolicy, retryableCodes: [...found.retryPolicy.retryableCodes] },
  };
}

export function approvalStatusForPolicy(policyEntry: AutomationPolicy, risk: AutomationRiskLevel): ApprovalStatus {
  return policyEntry.approvalMode === 'REQUIRED'
    || (policyEntry.approvalMode === 'OWNER_OVERRIDE' && risk === 'HIGH')
    || risk === 'BLOCKER'
    ? 'PENDING'
    : 'NOT_REQUIRED';
}

export function initialStatusForPolicy(policyEntry: AutomationPolicy, risk: AutomationRiskLevel) {
  if (risk === 'BLOCKER') return 'BLOCKED' as const;
  if (policyEntry.approvalMode === 'REQUIRED' || (policyEntry.approvalMode === 'OWNER_OVERRIDE' && risk === 'HIGH')) return 'WAITING_APPROVAL' as const;
  return 'PENDING' as const;
}

export function applyPolicyToBotEntry(entry: BotRegistryEntry): BotRegistryEntry {
  if (!entry.jobType) return entry;
  const policyEntry = getAutomationPolicy(entry.jobType);
  return {
    ...entry,
    risk: policyEntry.defaultRisk,
    approvalRequired: policyEntry.approvalMode === 'REQUIRED',
    defaultExecutionMode: policyEntry.defaultExecutionMode,
    fallback: [...policyEntry.fallbackPolicy],
    maxAttempts: policyEntry.retryPolicy.maxAttempts,
    writeScope: [...policyEntry.writeScope],
    externalSideEffect: policyEntry.externalSideEffect,
    rulesVersion: entry.rulesVersion || policyEntry.handlerVersion,
  };
}
