import { createHash } from 'node:crypto';
import {
  backupCollection,
  generateId,
  readBoundedCollectionSnapshot,
  readCollection,
  readCollectionPage,
  runTransaction,
} from '@/lib/storage/adapter';
import type { StorageTransaction } from '@/lib/storage/types';
import { sanitizeErrorMessage } from '@/lib/safety/operationGuard';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { getJobRegistryDefaults } from './botRegistry';
import { approvalStatusForPolicy, getAutomationPolicy, initialStatusForPolicy, listAutomationPolicies } from './policyRegistry';
import { buildAutoPilotExecutionPlan } from './autoPilotGraph';
import { vietnamDayKey } from './timezone';
import { isRuntimeRoleOwner, type RuntimeRoleOwnership } from './runtimeRoles';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { releaseProductProcessingCapacity, reserveProductProcessingCapacity } from './businessUsage';
import { IDEMPOTENCY_KEY_PATTERN } from './idempotency';
import { getFeatureRolloutState } from './featureRollout';
import {
  AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
  AUTOMATION_JOB_PROJECTION_NAME,
  AUTOMATION_JOB_PROJECTION_VERSION,
  AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION,
  automationJobCombinedProjectionFingerprint,
  automationJobProjectionContentFingerprint,
  automationJobProjectionFingerprint,
  automationJobProjectionSourceRevision,
  automationJobProjectionStorageCollections,
  acknowledgeAutomationJobProjectionCandidateCleanup,
  abortAutomationJobProjectionMutation,
  beginAutomationJobProjectionRebuild,
  beginAutomationJobProjectionMutation,
  beginAutomationJobProjectionSync,
  buildAutomationJobHealthSummary,
  completeAutomationJobProjectionRepair,
  failAutomationJobProjectionRepair,
  finishAutomationJobProjectionRebuild,
  finishAutomationJobProjectionSync,
  getAutomationJobActiveProjectionStorage,
  getAutomationJobHealthView,
  getAutomationJobProjectionManifestForMaintenance,
  getAutomationJobProjectionLimit,
  invalidateAutomationJobProjectionMutation,
  deterministicProjectionFingerprint,
  readBoundedAutomationJobProjections,
  refreshAutomationJobHealthSummary,
  transitionAutomationJobProjectionRepair,
  validateAutomationJobHealthSummary,
  type AutomationJobHealthSummary,
  type AutomationJobProjectionMutationHandle,
  type AutomationJobProjectionEvidence,
  type AutomationJobProjectionManifest,
  type AutomationJobProjectionRepairContext,
  type AutomationJobProjectionRepairOwnerInput,
  type AutomationJobProjectionRepairPhase,
  type AutomationJobProjectionRetentionBoundary,
  type AutomationJobProjectionSourceBoundary,
  type AutomationJobProjectionCandidateStorageRef,
} from './jobHealthSummary';
import {
  getAutomationExecutionDescriptor,
  isAutomationJobEligibleForClaimLane,
  isCriticalAutomationJob,
  selectCompatibleWorkerJobs,
  type AutomationWorkerClaimLane,
} from './executionPolicy';
import type {
  AiUsageRecord,
  ApprovalStatus,
  AutomationAuditEvent,
  AutomationCheckpoint,
  AutomationControlState,
  AutomationExecutionDisclosure,
  AutomationExecutionPlanStep,
  AutomationErrorCategory,
  AutomationJob,
  AutomationJobAttempt,
  AutomationJobListItem,
  AutomationJobListProjection,
  AutomationJobStatusProjection,
  AutomationJobStatus,
  AutomationJobType,
  AutomationRiskLevel,
  CircuitBreakerRecord,
  RequestedExecutionMode,
} from './types';

const JOBS = 'automation-jobs';
const JOB_ATTEMPTS = 'automation-job-attempts';
const JOB_HEARTBEATS = 'automation-job-heartbeats';
const JOB_PROJECTION_REBUILD_STAGING = 'automation-job-projection-rebuild-staging-v1';
const CONTROL = 'automation-control';
const AUDIT = 'automation-audit';
const USAGE = 'automation-ai-usage';
const CIRCUITS = 'automation-circuits';
const MAX_PAYLOAD_BYTES = 16 * 1024;
export const AUTOMATION_JOB_SCHEMA_VERSION = 2;
export const AUTOMATION_JOB_LIST_PAYLOAD_BUDGET_BYTES = 300 * 1024;
const SECRET_KEY = /token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|credential/i;
const TERMINAL = new Set<AutomationJobStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const ALL_JOB_STATUSES = new Set<AutomationJobStatus>([
  'PENDING',
  'WAITING_APPROVAL',
  'WAITING_FOR_MANUAL_INPUT',
  'WAITING_CHILDREN',
  'RUNNING',
  'RETRY_SCHEDULED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
  'PAUSED',
]);
const FAIRNESS_AFTER_MS = Math.max(15_000, Number(process.env.SANDEAL_JOB_FAIRNESS_AFTER_MS) || 60_000);
const MAX_JOB_PROJECTIONS = getAutomationJobProjectionLimit();
const PROJECTION_RECONCILE_AFTER_MS = Math.max(30_000, Number(process.env.SANDEAL_JOB_PROJECTION_RECONCILE_MS) || 60_000);
const projectionReconcileTimes = new Map<string, number>();
let lastHeartbeatHealthSummaryRefreshAt = 0;
const HEALTH_SUMMARY_HEARTBEAT_REFRESH_MS = 15_000;

interface AutomationJobHeartbeat {
  id: string;
  jobId: string;
  workerId: string;
  claimToken: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export type AutomationJobLogEvent =
  | 'job_created' | 'job_reused' | 'job_claim_attempt' | 'job_claimed'
  | 'job_skipped' | 'job_not_runnable' | 'job_handler_resolved' | 'job_started'
  | 'job_completed' | 'job_failed' | 'job_requeued' | 'job_terminal_timeout';

export function logAutomationJobEvent(
  event: AutomationJobLogEvent,
  job: Pick<AutomationJob, 'id' | 'type' | 'status' | 'scheduledAt' | 'priority' | 'attemptCount'>,
  input: { workerId?: string; reasonCode: string; durationMs?: number },
): void {
  console.log(JSON.stringify({
    type: event,
    jobId: job.id,
    jobType: job.type,
    status: job.status,
    scheduledAt: job.scheduledAt,
    priority: job.priority,
    attemptCount: job.attemptCount,
    workerId: input.workerId || null,
    reasonCode: input.reasonCode,
    ...(input.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(input.durationMs)) }),
  }));
}

function shortReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = sanitizeErrorMessage(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

export function projectAutomationJobListItem(job: AutomationJob): AutomationJobListProjection {
  const disclosure = job.disclosure;
  const resources = automationJobResourceReferences(job);
  const resourceProductIds = resources.resourceProductIds;
  const externalRequestCount = Math.max(0, Number(disclosure?.externalRequests) || 0);
  const progress = job.progress ? {
    processed: Math.max(0, Number(job.progress.processed) || 0),
    total: Number.isFinite(job.progress.total) ? Math.max(0, Number(job.progress.total)) : undefined,
    succeeded: Math.max(0, Number(job.progress.succeeded) || 0),
    skipped: Math.max(0, Number(job.progress.skipped) || 0),
    failed: Math.max(0, Number(job.progress.failed) || 0),
    percentage: Number.isFinite(job.progress.percentage)
      ? Math.max(0, Math.min(100, Number(job.progress.percentage)))
      : undefined,
    updatedAt: job.progress.updatedAt,
  } : undefined;
  return {
    projectionSchemaVersion: AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION,
    schemaVersion: job.schemaVersion,
    projectionSourceVersion: job.projectionSourceVersion,
    id: job.id,
    operationId: shortReason(job.operationId)?.slice(0, 160) || job.id,
    type: job.type,
    capability: shortReason(job.capability),
    botId: shortReason(job.botId),
    status: job.status,
    outcomeStatus: job.outcomeStatus,
    priority: job.priority,
    requestedBy: shortReason(job.requestedBy)?.slice(0, 160) || 'system',
    releaseId: shortReason(job.releaseId)?.slice(0, 160),
    rolloutCohort: shortReason(job.rolloutCohort)?.slice(0, 160),
    requestedExecutionMode: job.requestedExecutionMode,
    executionMode: job.executionMode,
    provider: shortReason(disclosure?.provider),
    progress,
    externalCallsOccurred: externalRequestCount > 0,
    externalRequestCount,
    aiRequestCount: Math.max(0, Number(disclosure?.aiRequests) || 0),
    fallbackUsed: Boolean(disclosure?.fallbackReason),
    evidenceCoverage: Number.isFinite(disclosure?.evidenceCoverage)
      ? Math.max(0, Math.min(100, Number(disclosure?.evidenceCoverage)))
      : undefined,
    approvalStatus: job.approvalStatus,
    approvalExpiresAt: job.approvalExpiresAt,
    riskLevel: job.riskLevel,
    dryRun: job.dryRun,
    attemptCount: Math.max(0, Number(job.attemptCount) || 0),
    maxAttempts: Math.max(1, Number(job.maxAttempts) || 1),
    queuedAt: job.queuedAt || job.scheduledAt,
    scheduledAt: job.scheduledAt,
    nextRetryAt: job.nextRetryAt,
    runnableAt: job.runnableAt,
    runnableReason: job.runnableReason,
    claimedAt: job.claimedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    lastErrorCode: shortReason(job.lastErrorCode),
    lastErrorCategory: job.lastErrorCategory,
    shortStatusReason: shortReason(job.lastErrorMessage || job.deadLetterReason || job.approvalReason),
    retryable: job.retryable,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    claimedBy: job.claimedBy,
    claimToken: job.claimToken,
    workerInstanceId: job.workerInstanceId,
    workerFencingToken: job.workerFencingToken,
    executionCritical: job.executionCritical,
    leaseExpiresAt: job.leaseExpiresAt,
    heartbeatAt: job.heartbeatAt,
    resourceProductIds: [...resourceProductIds],
    resourceCandidateId: resources.resourceCandidateId,
    resourceDraftId: resources.resourceDraftId,
  };
}

const STATUS_RESULT_FIELDS = [
  'active',
  'blockReason',
  'candidateQueued',
  'candidateStatus',
  'claimValidationFailed',
  'claimed',
  'created',
  'discarded',
  'duplicate',
  'duplicateRejected',
  'duplicateRechecksSuppressed',
  'durationMs',
  'evidenceVerified',
  'executionStatus',
  'failed',
  'fallbackUsed',
  'found',
  'inspected',
  'jobEvidence',
  'limitations',
  'outcome',
  'productCreated',
  'productId',
  'productUpdated',
  'publishBlocked',
  'publishEligible',
  'published',
  'queued',
  'quarantineReasons',
  'readinessReasons',
  'reason',
  'rejected',
  'reopened',
  'resolutionDeferred',
  'resolved',
  'recheckJobs',
  'rechecksAwaitingExecution',
  'seoBlocked',
  'seoReady',
  'skipped',
  'sourceFound',
  'sourceRequests',
  'succeeded',
  'summary',
  'updated',
  'validationRejected',
  'warnings',
  'childSummary',
] as const;

interface ProjectionValueBudget {
  remainingBytes: number;
  remainingNodes: number;
}

function compactProjectionValue(
  value: unknown,
  budget: ProjectionValueBudget,
  depth = 0,
): unknown {
  if (budget.remainingNodes <= 0 || budget.remainingBytes <= 0 || depth > 3) return undefined;
  budget.remainingNodes -= 1;
  if (value === null || typeof value === 'boolean') {
    budget.remainingBytes -= value === null ? 4 : 5;
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    budget.remainingBytes -= 24;
    return value;
  }
  if (typeof value === 'string') {
    const normalized = shortReason(value)?.slice(0, 200);
    if (!normalized) return undefined;
    const available = Math.max(0, budget.remainingBytes - 2);
    if (!available) return undefined;
    let compact = normalized;
    while (Buffer.byteLength(compact, 'utf8') > available && compact.length > 0) {
      compact = compact.slice(0, Math.max(0, compact.length - 16));
    }
    if (!compact) return undefined;
    budget.remainingBytes -= Buffer.byteLength(compact, 'utf8') + 2;
    return compact;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    budget.remainingBytes -= 2;
    for (const item of value.slice(0, 20)) {
      const compact = compactProjectionValue(item, budget, depth + 1);
      if (compact === undefined) break;
      output.push(compact);
      budget.remainingBytes -= 1;
      if (budget.remainingBytes <= 0) break;
    }
    return output;
  }
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  budget.remainingBytes -= 2;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SECRET_KEY.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 30)) {
    const keyBytes = Buffer.byteLength(key, 'utf8') + 4;
    if (budget.remainingBytes <= keyBytes) break;
    budget.remainingBytes -= keyBytes;
    const compact = compactProjectionValue(item, budget, depth + 1);
    if (compact !== undefined) output[key] = compact;
    if (budget.remainingBytes <= 0) break;
  }
  return output;
}

function compactAutomationJobStatusResult(
  result: AutomationJob['result'],
): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const selected: Record<string, unknown> = {};
  for (const key of STATUS_RESULT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) selected[key] = result[key];
  }
  return compactProjectionValue(selected, {
    remainingBytes: 2_048,
    remainingNodes: 96,
  }) as Record<string, unknown> | undefined;
}

function automationJobResourceReferences(job: AutomationJob): {
  resourceProductIds: string[];
  resourceCandidateId?: string;
  resourceDraftId?: string;
} {
  const resourceProductIds = [
    typeof job.payload.productId === 'string' ? job.payload.productId : undefined,
    ...(Array.isArray(job.payload.productIds)
      ? job.payload.productIds.filter((value): value is string => typeof value === 'string')
      : []),
  ].filter((value): value is string => Boolean(value)).slice(0, 100);
  return {
    resourceProductIds: [...new Set(resourceProductIds)],
    resourceCandidateId: typeof job.payload.candidateId === 'string' ? job.payload.candidateId : undefined,
    resourceDraftId: typeof job.payload.draftId === 'string' ? job.payload.draftId : undefined,
  };
}

export function projectAutomationJobStatusItem(job: AutomationJob): AutomationJobStatusProjection {
  const resources = automationJobResourceReferences(job);
  return {
    projectionSchemaVersion: AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION,
    schemaVersion: job.schemaVersion,
    projectionSourceVersion: job.projectionSourceVersion,
    policyVersion: job.policyVersion,
    handlerVersion: job.handlerVersion,
    id: job.id,
    correlationId: shortReason(job.correlationId),
    type: job.type,
    status: job.status,
    payload: {},
    result: compactAutomationJobStatusResult(job.result),
    priority: job.priority,
    idempotencyKey: '',
    operationId: shortReason(job.operationId)?.slice(0, 160) || job.id,
    requestedBy: shortReason(job.requestedBy)?.slice(0, 160) || 'unknown',
    releaseId: shortReason(job.releaseId)?.slice(0, 160),
    rolloutCohort: shortReason(job.rolloutCohort)?.slice(0, 160),
    sourceMetadata: job.sourceMetadata ? {
      producer: shortReason(job.sourceMetadata.producer)?.slice(0, 160) || 'unknown',
      source: shortReason(job.sourceMetadata.source)?.slice(0, 160),
      trigger: shortReason(job.sourceMetadata.trigger)?.slice(0, 160),
    } : undefined,
    parentJobId: shortReason(job.parentJobId)?.slice(0, 160),
    botId: shortReason(job.botId)?.slice(0, 160),
    capability: shortReason(job.capability)?.slice(0, 160),
    requestedExecutionMode: job.requestedExecutionMode,
    executionMode: job.executionMode,
    outcomeStatus: job.outcomeStatus,
    progress: job.progress ? {
      processed: Math.max(0, Number(job.progress.processed) || 0),
      total: job.progress.total === undefined ? undefined : Math.max(0, Number(job.progress.total) || 0),
      succeeded: Math.max(0, Number(job.progress.succeeded) || 0),
      skipped: Math.max(0, Number(job.progress.skipped) || 0),
      failed: Math.max(0, Number(job.progress.failed) || 0),
      percentage: job.progress.percentage === undefined
        ? undefined
        : Math.max(0, Math.min(100, Number(job.progress.percentage) || 0)),
      updatedAt: job.progress.updatedAt,
    } : undefined,
    checkpoint: job.checkpoint ? {
      version: 1,
      completedSteps: job.checkpoint.completedSteps.slice(0, 50).map(value => String(value).slice(0, 160)),
      pendingSteps: job.checkpoint.pendingSteps.slice(0, 50).map(value => String(value).slice(0, 160)),
      failedStep: shortReason(job.checkpoint.failedStep)?.slice(0, 160),
      outputs: {},
      executionModes: job.checkpoint.executionModes.slice(0, 20),
      inputHash: shortReason(job.checkpoint.inputHash)?.slice(0, 160) || '',
      outputHash: shortReason(job.checkpoint.outputHash)?.slice(0, 160),
      updatedAt: job.checkpoint.updatedAt,
    } : undefined,
    disclosure: job.disclosure ? {
      status: job.disclosure.status,
      requestedMode: job.disclosure.requestedMode,
      executionMode: job.disclosure.executionMode,
      provider: shortReason(job.disclosure.provider)?.slice(0, 160) || 'unknown',
      modelId: shortReason(job.disclosure.modelId)?.slice(0, 160),
      promptVersion: shortReason(job.disclosure.promptVersion)?.slice(0, 160),
      rulesVersion: shortReason(job.disclosure.rulesVersion)?.slice(0, 160),
      templateVersion: shortReason(job.disclosure.templateVersion)?.slice(0, 160),
      fallbackReason: shortReason(job.disclosure.fallbackReason)?.slice(0, 240),
      confidence: job.disclosure.confidence,
      evidenceCoverage: job.disclosure.evidenceCoverage,
      warnings: job.disclosure.warnings.slice(0, 20).map(value => String(value).slice(0, 200)),
      limitations: job.disclosure.limitations.slice(0, 20).map(value => String(value).slice(0, 200)),
      aiRequests: Math.max(0, Number(job.disclosure.aiRequests) || 0),
      externalRequests: Math.max(0, Number(job.disclosure.externalRequests) || 0),
      completedSteps: job.disclosure.completedSteps.slice(0, 50).map(value => String(value).slice(0, 160)),
      pendingSteps: job.disclosure.pendingSteps.slice(0, 50).map(value => String(value).slice(0, 160)),
      completedAt: job.disclosure.completedAt,
    } : undefined,
    manualTaskId: shortReason(job.manualTaskId)?.slice(0, 160),
    approvedBy: shortReason(job.approvedBy)?.slice(0, 160),
    approvalStatus: job.approvalStatus,
    approvalExpiresAt: job.approvalExpiresAt,
    riskLevel: job.riskLevel,
    dryRun: job.dryRun,
    attemptCount: Math.max(0, Number(job.attemptCount) || 0),
    maxAttempts: Math.max(1, Number(job.maxAttempts) || 1),
    queuedAt: job.queuedAt || job.scheduledAt,
    scheduledAt: job.scheduledAt,
    nextRetryAt: job.nextRetryAt,
    runnableAt: job.runnableAt,
    runnableReason: job.runnableReason,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    claimToken: job.claimToken,
    workerOwnerId: job.workerOwnerId,
    workerInstanceId: job.workerInstanceId,
    workerFencingToken: job.workerFencingToken,
    executionConcurrencyClass: shortReason(job.executionConcurrencyClass)?.slice(0, 160),
    executionResourceKeys: job.executionResourceKeys?.slice(0, 100).map(value => String(value).slice(0, 200)),
    executionExclusive: job.executionExclusive,
    executionCritical: job.executionCritical,
    leaseExpiresAt: job.leaseExpiresAt,
    heartbeatAt: job.heartbeatAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    cancelledAt: job.cancelledAt,
    lastErrorCode: shortReason(job.lastErrorCode)?.slice(0, 160),
    lastErrorCategory: job.lastErrorCategory,
    lastErrorMessage: shortReason(job.lastErrorMessage)?.slice(0, 240),
    retryable: job.retryable,
    deadLetterReason: shortReason(job.deadLetterReason)?.slice(0, 240),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...resources,
  };
}

/**
 * Explicit maintenance hook for establishing an authoritative projection
 * baseline. Callers must provide the durable automation-jobs snapshot they
 * already read; health/dashboard request paths must never invoke this rebuild.
 */
export interface AutomationJobProjectionRebuildCandidate {
  schemaVersion: 2;
  projectionName: typeof AUTOMATION_JOB_PROJECTION_NAME;
  projectionVersion: typeof AUTOMATION_JOB_PROJECTION_VERSION;
  releaseId: string;
  sourceSnapshotFingerprint: string;
  startBoundary: AutomationJobProjectionSourceBoundary;
  sourceBoundary: AutomationJobProjectionSourceBoundary;
  targetGeneration: number;
  targetSlot: 'A' | 'B';
  repairId: string;
  repairFence: number;
  repairAttemptNumber: number;
  catchUpPasses: number;
  deltaJobCount: number;
  sourceRevision: string;
  projectionFingerprint: string;
  candidateFingerprint: string;
  generatedAt: string;
  observedRange: {
    earliestCreatedAt: string | null;
    latestCreatedAt: string | null;
    earliestUpdatedAt: string | null;
    latestUpdatedAt: string | null;
  };
  recordCounts: {
    durable: number;
    active: number;
    retained: number;
    retainedTerminal: number;
    list: number;
    status: number;
  };
  completeness: {
    baselineEstablished: boolean;
    currentStateComplete: boolean;
    historyComplete: boolean;
    truncated: boolean;
  };
  projectionCapacity: number;
  sourceUpdatedAt: string | null;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  listProjectionContentFingerprint: string;
  statusProjectionContentFingerprint: string;
  listProjections: AutomationJobListProjection[];
  statusProjections: AutomationJobStatusProjection[];
}

interface AutomationJobProjectionRebuildStagingRecord {
  schemaVersion: 2;
  id: string;
  rebuildToken: string;
  repairId: string;
  repairFence: number;
  targetGeneration: number;
  targetSlot: 'A' | 'B';
  sourceBoundary: AutomationJobProjectionSourceBoundary;
  status: 'STAGED' | 'PROMOTED' | 'MIRRORED' | 'FAILED';
  stagedAt: string;
  completedAt?: string;
  reasonCode?: string;
  listProjectionCount: number;
  statusProjectionCount: number;
  listProjectionFingerprint: string;
  statusProjectionFingerprint: string;
  listProjectionContentFingerprint: string;
  statusProjectionContentFingerprint: string;
  candidateFingerprint: string;
}

function projectionRange(items: AutomationJobListProjection[]): AutomationJobProjectionRebuildCandidate['observedRange'] {
  const created = items.map(item => item.createdAt).filter(value => Number.isFinite(Date.parse(value)));
  const updated = items.map(item => item.updatedAt).filter(value => Number.isFinite(Date.parse(value)));
  created.sort((left, right) => Date.parse(left) - Date.parse(right) || left.localeCompare(right));
  updated.sort((left, right) => Date.parse(left) - Date.parse(right) || left.localeCompare(right));
  return {
    earliestCreatedAt: created[0] || null,
    latestCreatedAt: created.at(-1) || null,
    earliestUpdatedAt: updated[0] || null,
    latestUpdatedAt: updated.at(-1) || null,
  };
}

function projectionCandidateFingerprint(
  candidate: Omit<AutomationJobProjectionRebuildCandidate, 'candidateFingerprint' | 'generatedAt'>,
): string {
  return deterministicProjectionFingerprint(candidate);
}

export function validateAutomationJobProjectionRebuildCandidate(
  value: unknown,
  expected: { sourceSnapshotFingerprint?: string } = {},
): { valid: boolean; reasonCodes: string[] } {
  if (!value || typeof value !== 'object') {
    return { valid: false, reasonCodes: ['JOB_PROJECTION_CANDIDATE_INVALID'] };
  }
  const candidate = value as AutomationJobProjectionRebuildCandidate;
  const list = Array.isArray(candidate.listProjections) ? candidate.listProjections : [];
  const statuses = Array.isArray(candidate.statusProjections) ? candidate.statusProjections : [];
  const listIdentity = automationJobProjectionFingerprint(list);
  const statusIdentity = automationJobProjectionFingerprint(statuses);
  const listContent = automationJobProjectionContentFingerprint(list);
  const statusContent = automationJobProjectionContentFingerprint(statuses);
  const combined = automationJobCombinedProjectionFingerprint({
    listProjectionFingerprint: listIdentity,
    statusProjectionFingerprint: statusIdentity,
    listProjectionContentFingerprint: listContent,
    statusProjectionContentFingerprint: statusContent,
    listProjectionCount: list.length,
    statusProjectionCount: statuses.length,
  });
  const range = projectionRange(list);
  const activeCount = list.filter(item => !TERMINAL.has(item.status)).length;
  const retainedTerminalCount = list.length - activeCount;
  const matchingIdentities = deterministicProjectionFingerprint(
    list.map(item => [item.id, item.status, item.updatedAt]).sort(),
  ) === deterministicProjectionFingerprint(
    statuses.map(item => [item.id, item.status, item.updatedAt]).sort(),
  );
  const expectedSourceRevision = automationJobProjectionSourceRevision({
    releaseId: candidate.releaseId,
    projectionFingerprint: combined,
    durableJobCount: Number(candidate.recordCounts?.durable),
    activeJobCount: Number(candidate.recordCounts?.active),
    retainedJobCount: Number(candidate.recordCounts?.retained),
    sourceUpdatedAt: candidate.sourceUpdatedAt,
  });
  const { candidateFingerprint: _candidateFingerprint, generatedAt: _generatedAt, ...fingerprinted } = candidate;
  void _candidateFingerprint;
  void _generatedAt;
  const reasons = [
    ...(candidate.schemaVersion !== 2 ? ['JOB_PROJECTION_CANDIDATE_SCHEMA_MISMATCH'] : []),
    ...(candidate.projectionName !== AUTOMATION_JOB_PROJECTION_NAME
      ? ['JOB_PROJECTION_CANDIDATE_NAME_MISMATCH']
      : []),
    ...(candidate.projectionVersion !== AUTOMATION_JOB_PROJECTION_VERSION
      ? ['JOB_PROJECTION_CANDIDATE_VERSION_MISMATCH']
      : []),
    ...(!/^[a-f0-9]{64}$/.test(String(candidate.sourceSnapshotFingerprint || ''))
      ? ['JOB_PROJECTION_CANDIDATE_SOURCE_FINGERPRINT_INVALID']
      : []),
    ...(expected.sourceSnapshotFingerprint
      && candidate.sourceSnapshotFingerprint !== expected.sourceSnapshotFingerprint
      ? ['JOB_PROJECTION_CANDIDATE_SOURCE_CHANGED']
      : []),
    ...(candidate.startBoundary?.schemaVersion !== 1
      || candidate.sourceBoundary?.schemaVersion !== 1
      || !Number.isInteger(candidate.startBoundary?.highWatermark)
      || !Number.isInteger(candidate.sourceBoundary?.highWatermark)
      || candidate.sourceBoundary.highWatermark < candidate.startBoundary.highWatermark
      || candidate.sourceBoundary.sourceFingerprint !== candidate.sourceSnapshotFingerprint
      ? ['JOB_PROJECTION_CANDIDATE_BOUNDARY_INVALID']
      : []),
    ...(!Number.isInteger(candidate.targetGeneration)
      || candidate.targetGeneration <= 0
      || (candidate.targetSlot !== 'A' && candidate.targetSlot !== 'B')
      || candidate.repairId !== String(candidate.repairId || '').slice(0, 160)
      || !candidate.repairId
      || !Number.isInteger(candidate.repairFence)
      || candidate.repairFence <= 0
      || !Number.isInteger(candidate.repairAttemptNumber)
      || candidate.repairAttemptNumber <= 0
      || !Number.isInteger(candidate.catchUpPasses)
      || candidate.catchUpPasses < 0
      || !Number.isInteger(candidate.deltaJobCount)
      || candidate.deltaJobCount < 0
      ? ['JOB_PROJECTION_CANDIDATE_REPAIR_METADATA_INVALID']
      : []),
    ...(!Array.isArray(candidate.listProjections) || !Array.isArray(candidate.statusProjections)
      ? ['JOB_PROJECTION_CANDIDATE_ITEMS_INVALID']
      : []),
    ...(list.length !== statuses.length || !matchingIdentities
      ? ['JOB_PROJECTION_CANDIDATE_IDENTITY_MISMATCH']
      : []),
    ...(new Set(list.map(item => item.id)).size !== list.length
      || new Set(statuses.map(item => item.id)).size !== statuses.length
      ? ['JOB_PROJECTION_CANDIDATE_DUPLICATE_ID']
      : []),
    ...(list.some(item => item.projectionSchemaVersion !== AUTOMATION_JOB_LIST_PROJECTION_SCHEMA_VERSION)
      || statuses.some(item => item.projectionSchemaVersion !== AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION)
      ? ['JOB_PROJECTION_CANDIDATE_ITEM_SCHEMA_MISMATCH']
      : []),
    ...(list.some(item => (
      !item
      || typeof item.id !== 'string'
      || typeof item.type !== 'string'
      || !ALL_JOB_STATUSES.has(item.status)
      || !Number.isFinite(Date.parse(item.createdAt))
      || !Number.isFinite(Date.parse(item.updatedAt))
    )) || statuses.some(item => (
      !item
      || typeof item.id !== 'string'
      || typeof item.type !== 'string'
      || !ALL_JOB_STATUSES.has(item.status)
      || !Number.isFinite(Date.parse(item.createdAt))
      || !Number.isFinite(Date.parse(item.updatedAt))
    )) ? ['JOB_PROJECTION_CANDIDATE_ITEM_INVALID'] : []),
    ...(candidate.listProjectionFingerprint !== listIdentity
      || candidate.statusProjectionFingerprint !== statusIdentity
      || candidate.listProjectionContentFingerprint !== listContent
      || candidate.statusProjectionContentFingerprint !== statusContent
      || candidate.projectionFingerprint !== combined
      ? ['JOB_PROJECTION_CANDIDATE_FINGERPRINT_MISMATCH']
      : []),
    ...(candidate.recordCounts?.retained !== list.length
      || candidate.recordCounts?.list !== list.length
      || candidate.recordCounts?.status !== statuses.length
      || candidate.recordCounts?.retainedTerminal !== retainedTerminalCount
      || candidate.recordCounts?.active < activeCount
      || (candidate.completeness?.currentStateComplete && candidate.recordCounts.active !== activeCount)
      || !Number.isInteger(candidate.recordCounts?.durable)
      || candidate.recordCounts.durable < list.length
      ? ['JOB_PROJECTION_CANDIDATE_COUNT_MISMATCH']
      : []),
    ...(candidate.projectionCapacity !== getAutomationJobProjectionLimit()
      || list.length > candidate.projectionCapacity
      ? ['JOB_PROJECTION_CANDIDATE_CAPACITY_INVALID']
      : []),
    ...(candidate.completeness?.baselineEstablished !== true
      || candidate.completeness.currentStateComplete !== (candidate.recordCounts?.active <= candidate.projectionCapacity)
      || candidate.completeness.historyComplete !== !candidate.completeness.truncated
      ? ['JOB_PROJECTION_CANDIDATE_COMPLETENESS_INVALID']
      : []),
    ...(deterministicProjectionFingerprint(candidate.observedRange) !== deterministicProjectionFingerprint(range)
      || candidate.sourceUpdatedAt !== range.latestUpdatedAt
      ? ['JOB_PROJECTION_CANDIDATE_OBSERVED_RANGE_MISMATCH']
      : []),
    ...(candidate.sourceRevision !== expectedSourceRevision
      ? ['JOB_PROJECTION_CANDIDATE_SOURCE_REVISION_MISMATCH']
      : []),
    ...(candidate.candidateFingerprint !== projectionCandidateFingerprint(fingerprinted)
      ? ['JOB_PROJECTION_CANDIDATE_SERIALIZATION_MISMATCH']
      : []),
    ...(Number.isNaN(Date.parse(candidate.generatedAt))
      ? ['JOB_PROJECTION_CANDIDATE_GENERATED_AT_INVALID']
      : []),
  ];
  return { valid: reasons.length === 0, reasonCodes: [...new Set(reasons)] };
}

interface AutomationJobProjectionSourceIdentity {
  fingerprint: string;
  jobFingerprints: Map<string, string>;
}

function assertProjectionSourceJobs(jobs: AutomationJob[]): void {
  if (!Array.isArray(jobs)) throw new Error('JOB_PROJECTION_REBUILD_INPUT_INVALID');
  const ids = new Set<string>();
  for (const job of jobs) {
    if (!job || typeof job.id !== 'string' || ids.has(job.id)) {
      throw new Error(ids.has(job?.id)
        ? 'JOB_PROJECTION_REBUILD_DUPLICATE_JOB_ID'
        : 'JOB_PROJECTION_REBUILD_INPUT_INVALID');
    }
    ids.add(job.id);
  }
}

function projectionSourceItemFingerprint(job: AutomationJob): string {
  return deterministicProjectionFingerprint({
    id: job.id,
    list: automationJobProjectionContentFingerprint([projectAutomationJobListItem(job)]),
    status: automationJobProjectionContentFingerprint([projectAutomationJobStatusItem(job)]),
  });
}

export function automationJobMutationAffectsProjection(
  before: AutomationJob | null,
  after: AutomationJob | null,
): boolean {
  if (!before || !after) return before !== after;
  return projectionSourceItemFingerprint(before) !== projectionSourceItemFingerprint(after);
}

function selectProjectionSourceJobs(jobs: AutomationJob[]): {
  active: AutomationJob[];
  retained: AutomationJob[];
} {
  const newestFirst = (left: AutomationJob, right: AutomationJob) => {
    const byUpdatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return byUpdatedAt || left.id.localeCompare(right.id);
  };
  const active = jobs.filter(job => !TERMINAL.has(job.status)).sort(newestFirst);
  const terminal = jobs.filter(job => TERMINAL.has(job.status)).sort(newestFirst);
  return {
    active,
    retained: [
      ...active.slice(0, MAX_JOB_PROJECTIONS),
      ...terminal.slice(0, Math.max(0, MAX_JOB_PROJECTIONS - active.length)),
    ],
  };
}

export function automationJobProjectionSourceFingerprint(jobs: AutomationJob[]): string {
  return projectionSourceIdentity(jobs).fingerprint;
}

function projectionSourceIdentity(jobs: AutomationJob[]): AutomationJobProjectionSourceIdentity {
  assertProjectionSourceJobs(jobs);
  const jobFingerprints = new Map<string, string>();
  for (const job of jobs) jobFingerprints.set(job.id, projectionSourceItemFingerprint(job));
  const selection = selectProjectionSourceJobs(jobs);
  return {
    fingerprint: deterministicProjectionFingerprint({
      durableJobCount: jobs.length,
      activeJobCount: selection.active.length,
      retainedProjectionInputs: selection.retained
        .map(job => [job.id, jobFingerprints.get(job.id)])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    }),
    jobFingerprints,
  };
}

function changedProjectionSourceJobs(
  previous: Map<string, string>,
  current: Map<string, string>,
): number {
  let changed = 0;
  for (const [id, fingerprint] of current) {
    if (previous.get(id) !== fingerprint) changed += 1;
  }
  for (const id of previous.keys()) {
    if (!current.has(id)) changed += 1;
  }
  return changed;
}

async function applyCurrentProjectionHeartbeats(jobs: AutomationJob[]): Promise<AutomationJob[]> {
  const heartbeats = await readCollection<AutomationJobHeartbeat>(JOB_HEARTBEATS);
  if (!heartbeats.length) return jobs;
  const byJobId = new Map(heartbeats.map(heartbeat => [heartbeat.jobId, heartbeat]));
  return jobs.map(job => {
    if (job.status !== 'RUNNING') return job;
    const heartbeat = byJobId.get(job.id);
    if (
      !heartbeat
      || heartbeat.workerId !== job.claimedBy
      || (job.claimToken && heartbeat.claimToken !== job.claimToken)
    ) return job;
    return {
      ...job,
      heartbeatAt: heartbeat.heartbeatAt,
      leaseExpiresAt: heartbeat.leaseExpiresAt,
    };
  });
}

function buildProjectionRepairCandidate(
  jobs: AutomationJob[],
  identity: AutomationJobProjectionSourceIdentity,
  context: AutomationJobProjectionRepairContext,
  sourceBoundary: AutomationJobProjectionSourceBoundary,
  input: { now: number; catchUpPasses: number; deltaJobCount: number },
  reuse?: {
    identity: AutomationJobProjectionSourceIdentity;
    candidate: AutomationJobProjectionRebuildCandidate;
  },
): AutomationJobProjectionRebuildCandidate {
  const { active, retained } = selectProjectionSourceJobs(jobs);
  const reusableStatuses = new Map(reuse?.candidate.statusProjections.map(item => [item.id, item]) || []);
  const reusableList = new Map(reuse?.candidate.listProjections.map(item => [item.id, item]) || []);
  const unchanged = (job: AutomationJob) => reuse?.identity.jobFingerprints.get(job.id) === identity.jobFingerprints.get(job.id);
  const statusProjections = retained.map(job => unchanged(job) && reusableStatuses.has(job.id)
    ? reusableStatuses.get(job.id)!
    : projectAutomationJobStatusItem(job));
  const listProjections = retained.map(job => unchanged(job) && reusableList.has(job.id)
    ? reusableList.get(job.id)!
    : projectAutomationJobListItem(job));
  const listFingerprint = automationJobProjectionFingerprint(listProjections);
  const statusFingerprint = automationJobProjectionFingerprint(statusProjections);
  const listContentFingerprint = automationJobProjectionContentFingerprint(listProjections);
  const statusContentFingerprint = automationJobProjectionContentFingerprint(statusProjections);
  const range = projectionRange(listProjections);
  const atCapacity = retained.length >= MAX_JOB_PROJECTIONS;
  const truncated = jobs.length > retained.length || atCapacity;
  const retentionBoundary = atCapacity && range.earliestUpdatedAt
    ? { field: 'updatedAt' as const, oldestRetainedAt: range.earliestUpdatedAt }
    : null;
  const projectionFingerprint = automationJobCombinedProjectionFingerprint({
    listProjectionFingerprint: listFingerprint,
    statusProjectionFingerprint: statusFingerprint,
    listProjectionContentFingerprint: listContentFingerprint,
    statusProjectionContentFingerprint: statusContentFingerprint,
    listProjectionCount: listProjections.length,
    statusProjectionCount: statusProjections.length,
  });
  const releaseId = getReleaseIdentity().releaseId;
  const recordCounts = {
    durable: jobs.length,
    active: active.length,
    retained: retained.length,
    retainedTerminal: retained.filter(job => TERMINAL.has(job.status)).length,
    list: listProjections.length,
    status: statusProjections.length,
  };
  const completeness = {
    baselineEstablished: true,
    currentStateComplete: active.length <= MAX_JOB_PROJECTIONS,
    historyComplete: !truncated,
    truncated,
  };
  const sourceRevision = automationJobProjectionSourceRevision({
    releaseId,
    projectionFingerprint,
    durableJobCount: recordCounts.durable,
    activeJobCount: recordCounts.active,
    retainedJobCount: recordCounts.retained,
    sourceUpdatedAt: range.latestUpdatedAt,
  });
  const candidateIdentity: Omit<AutomationJobProjectionRebuildCandidate, 'candidateFingerprint' | 'generatedAt'> = {
    schemaVersion: 2,
    projectionName: AUTOMATION_JOB_PROJECTION_NAME,
    projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
    releaseId,
    sourceSnapshotFingerprint: identity.fingerprint,
    startBoundary: context.startBoundary,
    sourceBoundary,
    targetGeneration: context.targetGeneration,
    targetSlot: context.targetSlot,
    repairId: context.repairId,
    repairFence: context.repairFence,
    repairAttemptNumber: context.attemptNumber,
    catchUpPasses: input.catchUpPasses,
    deltaJobCount: input.deltaJobCount,
    sourceRevision,
    projectionFingerprint,
    observedRange: range,
    recordCounts,
    completeness,
    projectionCapacity: MAX_JOB_PROJECTIONS,
    sourceUpdatedAt: range.latestUpdatedAt,
    retentionBoundary,
    listProjectionFingerprint: listFingerprint,
    statusProjectionFingerprint: statusFingerprint,
    listProjectionContentFingerprint: listContentFingerprint,
    statusProjectionContentFingerprint: statusContentFingerprint,
    listProjections,
    statusProjections,
  };
  return {
    ...candidateIdentity,
    generatedAt: new Date(input.now).toISOString(),
    candidateFingerprint: projectionCandidateFingerprint(candidateIdentity),
  };
}

function candidateProjectionEvidence(
  candidate: AutomationJobProjectionRebuildCandidate,
): AutomationJobProjectionEvidence {
  return {
    evidenceClassification: candidate.completeness.currentStateComplete ? 'COMPLETE' : 'INCOMPLETE',
    source: 'job-list-projection-v2',
    collectionPresent: true,
    currentStateComplete: candidate.completeness.currentStateComplete,
    historyComplete: candidate.completeness.historyComplete,
    truncated: candidate.completeness.truncated,
    observedRange: candidate.observedRange,
    retentionBoundary: candidate.retentionBoundary,
    manifestRebuiltAt: candidate.generatedAt,
    manifestReleaseId: candidate.releaseId,
    manifestUpdatedAt: candidate.generatedAt,
    projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
    sourceRevision: candidate.sourceRevision,
    summaryRevision: null,
    projectionFingerprint: candidate.projectionFingerprint,
    generatedAt: candidate.generatedAt,
    recordCounts: candidate.recordCounts,
    completeness: candidate.completeness,
  };
}

export interface AutomationJobProjectionRepairHooks {
  afterBaseRebuild?: (input: { context: AutomationJobProjectionRepairContext; candidate: AutomationJobProjectionRebuildCandidate }) => Promise<void> | void;
  afterCatchUpPass?: (input: { context: AutomationJobProjectionRepairContext; pass: number; deltaJobCount: number }) => Promise<void> | void;
  beforeCandidateValidation?: (input: { context: AutomationJobProjectionRepairContext; pass: number; candidate: AutomationJobProjectionRebuildCandidate }) => Promise<void> | void;
  beforePublication?: (input: { context: AutomationJobProjectionRepairContext; pass: number; sourceBoundary: AutomationJobProjectionSourceBoundary }) => Promise<void> | void;
  afterAtomicPromotion?: (input: { context: AutomationJobProjectionRepairContext; pass: number; sourceBoundary: AutomationJobProjectionSourceBoundary }) => Promise<void> | void;
  afterLegacyMirror?: (input: { context: AutomationJobProjectionRepairContext; sourceBoundary: AutomationJobProjectionSourceBoundary }) => Promise<void> | void;
}

export interface AutomationJobProjectionRepairOptions {
  owner?: AutomationJobProjectionRepairOwnerInput;
  maximumCatchUpPasses?: number;
  catchUpBackoffMs?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
  authorizePublication?: () => Promise<boolean>;
  onPhase?: (input: {
    context: AutomationJobProjectionRepairContext;
    phase: AutomationJobProjectionRepairPhase;
    catchUpPasses: number;
    catchUpPending: boolean;
    lastFailureReason: string | null;
  }) => Promise<void> | void;
  hooks?: AutomationJobProjectionRepairHooks;
}

function projectionRepairOwned(
  manifest: AutomationJobProjectionManifest | null,
  context: AutomationJobProjectionRepairContext,
): boolean {
  const repair = manifest?.activeRepair;
  return Boolean(
    repair
    && repair.repairId === context.repairId
    && repair.rebuildToken === context.rebuildToken
    && repair.repairFence === context.repairFence,
  );
}

async function delayProjectionRepair(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

async function cleanupStaleProjectionCandidates(now = Date.now()): Promise<void> {
  const manifest = await getAutomationJobProjectionManifestForMaintenance();
  const stale = (manifest?.staleCandidateStorage || []).filter(ref => !(
    manifest?.activeSlot === ref.slot
    && manifest.activeStorageRepairFence === ref.repairFence
  ));
  const cleaned: AutomationJobProjectionCandidateStorageRef[] = [];
  for (const ref of stale) {
    const collections = automationJobProjectionStorageCollections(ref.slot, ref.repairFence);
    try {
      // Sequential clearing bounds FileStorage to one parsed candidate at a time.
      await runTransaction<AutomationJobStatusProjection>(collections.status, () => []);
      await runTransaction<AutomationJobListProjection>(collections.list, () => []);
      await runTransaction<AutomationJobHealthSummary>(collections.summary, () => []);
      cleaned.push(ref);
    } catch {
      break;
    }
  }
  await acknowledgeAutomationJobProjectionCandidateCleanup(cleaned, now);
}

const activeProjectionRepairFlights = new Map<string, Promise<AutomationJobProjectionManifest>>();

export function rebuildAutomationJobReadModelsFromDurable(
  suppliedJobs: AutomationJob[] | null,
  now = Date.now(),
  options: AutomationJobProjectionRepairOptions = {},
): Promise<AutomationJobProjectionManifest> {
  const owner = options.owner;
  if (!owner) return performAutomationJobReadModelRebuild(suppliedJobs, now, options);
  const flightKey = deterministicProjectionFingerprint({
    repairId: owner.repairId,
    ownerId: owner.ownerId,
    ownerInstanceId: owner.ownerInstanceId,
    workerFencingToken: owner.workerFencingToken,
    claimTokenHash: createHash('sha256').update(owner.claimToken).digest('hex'),
    attemptNumber: owner.attemptNumber,
  });
  const existing = activeProjectionRepairFlights.get(flightKey);
  if (existing) return existing;
  const flight = performAutomationJobReadModelRebuild(suppliedJobs, now, options);
  activeProjectionRepairFlights.set(flightKey, flight);
  const cleanup = () => {
    if (activeProjectionRepairFlights.get(flightKey) === flight) {
      activeProjectionRepairFlights.delete(flightKey);
    }
  };
  void flight.then(cleanup, cleanup);
  return flight;
}

async function performAutomationJobReadModelRebuild(
  suppliedJobs: AutomationJob[] | null,
  now = Date.now(),
  options: AutomationJobProjectionRepairOptions = {},
): Promise<AutomationJobProjectionManifest> {
  if (suppliedJobs !== null) assertProjectionSourceJobs(suppliedJobs);
  const localRepairId = `projection-repair:${generateId()}`.slice(0, 160);
  const owner: AutomationJobProjectionRepairOwnerInput = options.owner || {
    repairId: localRepairId,
    ownerId: 'projection-maintenance',
    ownerInstanceId: 'local-maintenance',
    workerFencingToken: 0,
    claimToken: localRepairId,
    attemptNumber: 1,
  };
  const maximumCatchUpPasses = Math.max(1, Math.min(5, options.maximumCatchUpPasses ?? 3));
  const backoffs = options.catchUpBackoffMs?.length ? options.catchUpBackoffMs : [10, 25, 50, 100, 200];
  const sleep = options.sleep || delayProjectionRepair;
  await cleanupStaleProjectionCandidates(now);
  const context = await beginAutomationJobProjectionRebuild(owner, now);
  const targetCollections = automationJobProjectionStorageCollections(context.targetSlot, context.repairFence);
  const observePhase = async (
    phase: AutomationJobProjectionRepairPhase,
    input: { catchUpPasses?: number; catchUpPending?: boolean; lastFailureReason?: string | null } = {},
  ): Promise<void> => {
    await options.onPhase?.({
      context,
      phase,
      catchUpPasses: input.catchUpPasses || 0,
      catchUpPending: input.catchUpPending === true,
      lastFailureReason: input.lastFailureReason || null,
    });
  };
  const transitionRepair = async (
    phase: AutomationJobProjectionRepairPhase,
    input: Parameters<typeof transitionAutomationJobProjectionRepair>[2] = {},
  ): Promise<void> => {
    const repair = await transitionAutomationJobProjectionRepair(context, phase, input, now);
    await observePhase(phase, {
      catchUpPasses: repair.catchUpPasses,
      catchUpPending: repair.catchUpPending,
      lastFailureReason: repair.lastFailureReason,
    });
  };
  let promoted = false;
  let candidate: AutomationJobProjectionRebuildCandidate | undefined;
  let identity: AutomationJobProjectionSourceIdentity | undefined;
  let totalDeltaJobCount = 0;
  try {
    await cleanupStaleProjectionCandidates(now);
    await observePhase('CLAIMED');
    await transitionRepair('REBUILDING');
    let currentJobs = await applyCurrentProjectionHeartbeats(
      suppliedJobs || await readCollection<AutomationJob>(JOBS),
    );
    suppliedJobs = null;
    identity = projectionSourceIdentity(currentJobs);
    candidate = buildProjectionRepairCandidate(currentJobs, identity, context, {
      schemaVersion: 1,
      highWatermark: context.startBoundary.highWatermark,
      sourceFingerprint: identity.fingerprint,
    }, { now, catchUpPasses: 0, deltaJobCount: 0 });
    currentJobs = [];
    await options.hooks?.afterBaseRebuild?.({ context, candidate });

    const activeStorage = await getAutomationJobActiveProjectionStorage();
    const previousSummarySnapshot = await readBoundedCollectionSnapshot<AutomationJobHealthSummary>(
      activeStorage.collections.summary,
      { maximumItems: 1, maximumBytes: 512 * 1024 },
    ).catch(() => null);
    const previousSummary = previousSummarySnapshot?.items[0];

    for (let pass = 1; pass <= maximumCatchUpPasses; pass += 1) {
      await transitionRepair('CATCHING_UP', {
        catchUpPasses: pass,
        catchUpPending: true,
      });
      const before = await getAutomationJobProjectionManifestForMaintenance();
      if (!projectionRepairOwned(before, context)) throw new Error('JOB_PROJECTION_REPAIR_FENCING_REJECTED');
      if (before!.inFlightSyncTokens.length > 0) {
        await sleep(backoffs[Math.min(pass - 1, backoffs.length - 1)] || 0);
        continue;
      }

      // File storage necessarily parses one authoritative jobs revision per pass;
      // only compact hashes and the bounded candidate survive into the next pass.
      const previousIdentity = identity;
      const previousCandidate = candidate;
      currentJobs = [];
      candidate = undefined;
      let latestJobs = await applyCurrentProjectionHeartbeats(
        await readCollection<AutomationJob>(JOBS),
      );
      const latestIdentity = projectionSourceIdentity(latestJobs);
      const deltaJobCount = changedProjectionSourceJobs(previousIdentity.jobFingerprints, latestIdentity.jobFingerprints);
      totalDeltaJobCount += deltaJobCount;
      currentJobs = latestJobs;
      identity = latestIdentity;
      const after = await getAutomationJobProjectionManifestForMaintenance();
      if (!projectionRepairOwned(after, context)) throw new Error('JOB_PROJECTION_REPAIR_FENCING_REJECTED');
      const sourceBoundary: AutomationJobProjectionSourceBoundary = {
        schemaVersion: 1,
        highWatermark: after!.sourceHighWatermark || 0,
        sourceFingerprint: identity.fingerprint,
      };
      candidate = buildProjectionRepairCandidate(currentJobs, identity, context, sourceBoundary, {
        now,
        catchUpPasses: pass,
        deltaJobCount: totalDeltaJobCount,
      }, previousCandidate ? { identity: previousIdentity, candidate: previousCandidate } : undefined);
      currentJobs = [];
      latestJobs = [];
      await options.hooks?.afterCatchUpPass?.({ context, pass, deltaJobCount });
      const settled = await getAutomationJobProjectionManifestForMaintenance();
      const stableBoundary = projectionRepairOwned(settled, context)
        && settled!.inFlightSyncTokens.length === 0
        && before!.sourceHighWatermark === after!.sourceHighWatermark
        && after!.sourceHighWatermark === settled!.sourceHighWatermark;
      if (!stableBoundary) {
        await sleep(backoffs[Math.min(pass - 1, backoffs.length - 1)] || 0);
        continue;
      }

      await options.hooks?.beforeCandidateValidation?.({ context, pass, candidate });
      const validation = validateAutomationJobProjectionRebuildCandidate(candidate, {
        sourceSnapshotFingerprint: identity.fingerprint,
      });
      if (!validation.valid) {
        throw new Error(validation.reasonCodes[0] || 'JOB_PROJECTION_REBUILD_CANDIDATE_INVALID');
      }
      await transitionRepair('VALIDATING', {
        candidateBoundary: sourceBoundary,
        catchUpPasses: pass,
        catchUpPending: false,
      });
      const summary = buildAutomationJobHealthSummary(candidate.listProjections, {
        now,
        previous: previousSummary,
        evidence: candidateProjectionEvidence(candidate),
      });
      if (
        summary.sourceRevision !== candidate.sourceRevision
        || summary.projectionFingerprint !== candidate.projectionFingerprint
        || !summary.projectionEvidence.currentStateComplete
      ) {
        throw new Error('JOB_PROJECTION_REBUILD_SUMMARY_NOT_VERIFIED');
      }

      const stagedAt = new Date(now).toISOString();
      const stagingRecord: AutomationJobProjectionRebuildStagingRecord = {
        schemaVersion: 2,
        id: context.rebuildToken,
        rebuildToken: context.rebuildToken,
        repairId: context.repairId,
        repairFence: context.repairFence,
        targetGeneration: context.targetGeneration,
        targetSlot: context.targetSlot,
        sourceBoundary,
        status: 'STAGED',
        stagedAt,
        listProjectionCount: candidate.listProjections.length,
        statusProjectionCount: candidate.statusProjections.length,
        listProjectionFingerprint: candidate.listProjectionFingerprint,
        statusProjectionFingerprint: candidate.statusProjectionFingerprint,
        listProjectionContentFingerprint: candidate.listProjectionContentFingerprint,
        statusProjectionContentFingerprint: candidate.statusProjectionContentFingerprint,
        candidateFingerprint: candidate.candidateFingerprint,
      };
      await runTransaction<AutomationJobProjectionRebuildStagingRecord>(
        JOB_PROJECTION_REBUILD_STAGING,
        items => [...items.filter(item => item.id !== context.rebuildToken).slice(-9), stagingRecord],
      );
      await Promise.all([
        runTransaction<AutomationJobStatusProjection>(targetCollections.status, () => candidate!.statusProjections),
        runTransaction<AutomationJobListProjection>(targetCollections.list, () => candidate!.listProjections),
        runTransaction<AutomationJobHealthSummary>(targetCollections.summary, () => [summary]),
      ]);
      const [writtenStatuses, writtenList, writtenSummary, staged] = await Promise.all([
        readBoundedCollectionSnapshot<AutomationJobStatusProjection>(targetCollections.status, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobListProjection>(targetCollections.list, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobHealthSummary>(targetCollections.summary, {
          maximumItems: 1,
          maximumBytes: 512 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobProjectionRebuildStagingRecord>(
          JOB_PROJECTION_REBUILD_STAGING,
          { maximumItems: 10, maximumBytes: 128 * 1024 },
        ),
      ]);
      const stagedCandidate = staged.items.find(item => item.id === context.rebuildToken);
      if (
        writtenStatuses.items.length !== candidate.statusProjections.length
        || writtenList.items.length !== candidate.listProjections.length
        || automationJobProjectionFingerprint(writtenStatuses.items) !== candidate.statusProjectionFingerprint
        || automationJobProjectionFingerprint(writtenList.items) !== candidate.listProjectionFingerprint
        || automationJobProjectionContentFingerprint(writtenStatuses.items) !== candidate.statusProjectionContentFingerprint
        || automationJobProjectionContentFingerprint(writtenList.items) !== candidate.listProjectionContentFingerprint
        || !validateAutomationJobHealthSummary(writtenSummary.items[0])
        || writtenSummary.items[0]?.summaryRevision !== summary.summaryRevision
        || stagedCandidate?.candidateFingerprint !== candidate.candidateFingerprint
      ) {
        throw new Error('JOB_PROJECTION_REBUILD_CANDIDATE_STORAGE_MISMATCH');
      }
      await options.hooks?.beforePublication?.({ context, pass, sourceBoundary });
      if (options.authorizePublication && !await options.authorizePublication()) {
        throw new Error('JOB_PROJECTION_REPAIR_PUBLICATION_NOT_AUTHORIZED');
      }
      const [publishStatuses, publishList, publishSummary] = await Promise.all([
        readBoundedCollectionSnapshot<AutomationJobStatusProjection>(targetCollections.status, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobListProjection>(targetCollections.list, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobHealthSummary>(targetCollections.summary, {
          maximumItems: 1,
          maximumBytes: 512 * 1024,
        }),
      ]);
      if (
        publishStatuses.items.length !== candidate.statusProjections.length
        || publishList.items.length !== candidate.listProjections.length
        || automationJobProjectionFingerprint(publishStatuses.items) !== candidate.statusProjectionFingerprint
        || automationJobProjectionFingerprint(publishList.items) !== candidate.listProjectionFingerprint
        || automationJobProjectionContentFingerprint(publishStatuses.items)
          !== candidate.statusProjectionContentFingerprint
        || automationJobProjectionContentFingerprint(publishList.items)
          !== candidate.listProjectionContentFingerprint
        || !validateAutomationJobHealthSummary(publishSummary.items[0])
        || publishSummary.items[0].summaryRevision !== summary.summaryRevision
      ) {
        throw new Error('JOB_PROJECTION_REPAIR_PRE_PUBLISH_VALIDATION_FAILED');
      }
      await transitionRepair('PUBLISHING', {
        candidateBoundary: sourceBoundary,
        catchUpPending: false,
      });
      try {
        await finishAutomationJobProjectionRebuild(context, {
          durableJobCount: candidate.recordCounts.durable,
          activeJobCount: candidate.recordCounts.active,
          retainedJobCount: candidate.recordCounts.retained,
          retainedTerminalCount: candidate.recordCounts.retainedTerminal,
          listProjectionCount: candidate.recordCounts.list,
          statusProjectionCount: candidate.recordCounts.status,
          listProjectionFingerprint: candidate.listProjectionFingerprint,
          statusProjectionFingerprint: candidate.statusProjectionFingerprint,
          listProjectionContentFingerprint: candidate.listProjectionContentFingerprint,
          statusProjectionContentFingerprint: candidate.statusProjectionContentFingerprint,
          truncated: candidate.completeness.truncated,
          sourceUpdatedAt: candidate.sourceUpdatedAt,
          retentionBoundary: candidate.retentionBoundary,
          observedRange: candidate.observedRange,
          summaryRevision: summary.summaryRevision,
          sourceBoundary,
        }, now);
        promoted = true;
        await options.hooks?.afterAtomicPromotion?.({ context, pass, sourceBoundary });
      } catch (error) {
        if (error instanceof Error && error.message === 'JOB_PROJECTION_REPAIR_BOUNDARY_CHANGED') {
          await transitionRepair('RETRY_WAIT', {
            catchUpPending: true,
            lastFailureReason: error.message,
          });
          await sleep(backoffs[Math.min(pass - 1, backoffs.length - 1)] || 0);
          continue;
        }
        throw error;
      }
      await runTransaction<AutomationJobProjectionRebuildStagingRecord>(
        JOB_PROJECTION_REBUILD_STAGING,
        items => items.map(item => item.id === context.rebuildToken
          ? { ...item, status: 'PROMOTED' as const }
          : item),
      );
      break;
    }

    if (!promoted || !candidate) throw new Error('JOB_PROJECTION_CATCH_UP_RETRY_EXHAUSTED');

    let legacyMirrored = false;
    const legacyCollections = automationJobProjectionStorageCollections('LEGACY');
    for (let mirrorAttempt = 0; mirrorAttempt < 2 && !legacyMirrored; mirrorAttempt += 1) {
      const mirrorManifest = await getAutomationJobProjectionManifestForMaintenance();
      if (!projectionRepairOwned(mirrorManifest, context)) throw new Error('JOB_PROJECTION_REPAIR_FENCING_REJECTED');
      if (mirrorManifest!.inFlightSyncTokens.length > 0) {
        await sleep(backoffs[Math.min(mirrorAttempt, backoffs.length - 1)] || 0);
        continue;
      }
      const [statuses, list, summaries] = await Promise.all([
        readBoundedCollectionSnapshot<AutomationJobStatusProjection>(targetCollections.status, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobListProjection>(targetCollections.list, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobHealthSummary>(targetCollections.summary, {
          maximumItems: 1,
          maximumBytes: 512 * 1024,
        }),
      ]);
      await Promise.all([
        runTransaction<AutomationJobStatusProjection>(legacyCollections.status, () => statuses.items),
        runTransaction<AutomationJobListProjection>(legacyCollections.list, () => list.items),
        runTransaction<AutomationJobHealthSummary>(legacyCollections.summary, () => summaries.items),
      ]);
      const [mirroredStatuses, mirroredList, mirroredSummary] = await Promise.all([
        readBoundedCollectionSnapshot<AutomationJobStatusProjection>(legacyCollections.status, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobListProjection>(legacyCollections.list, {
          maximumItems: MAX_JOB_PROJECTIONS,
          maximumBytes: 32 * 1024 * 1024,
        }),
        readBoundedCollectionSnapshot<AutomationJobHealthSummary>(legacyCollections.summary, {
          maximumItems: 1,
          maximumBytes: 512 * 1024,
        }),
      ]);
      if (
        mirroredStatuses.items.length !== mirrorManifest!.statusProjectionCount
        || mirroredList.items.length !== mirrorManifest!.listProjectionCount
        || automationJobProjectionFingerprint(mirroredStatuses.items) !== mirrorManifest!.statusProjectionFingerprint
        || automationJobProjectionFingerprint(mirroredList.items) !== mirrorManifest!.listProjectionFingerprint
        || automationJobProjectionContentFingerprint(mirroredStatuses.items)
          !== mirrorManifest!.statusProjectionContentFingerprint
        || automationJobProjectionContentFingerprint(mirroredList.items)
          !== mirrorManifest!.listProjectionContentFingerprint
        || !validateAutomationJobHealthSummary(mirroredSummary.items[0])
        || mirroredSummary.items[0].summaryRevision !== mirrorManifest!.summaryRevision
      ) {
        throw new Error('JOB_PROJECTION_LEGACY_MIRROR_VALIDATION_FAILED');
      }
      try {
        await completeAutomationJobProjectionRepair(context, {
          legacyMirrored: true,
          expectedSourceRevision: mirrorManifest!.sourceRevision,
          expectedSummaryRevision: mirrorManifest!.summaryRevision || undefined,
          expectedHighWatermark: mirrorManifest!.sourceHighWatermark || 0,
        }, now);
        legacyMirrored = true;
        await options.hooks?.afterLegacyMirror?.({
          context,
          sourceBoundary: candidate.sourceBoundary,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'JOB_PROJECTION_LEGACY_MIRROR_BOUNDARY_CHANGED') throw error;
      }
    }
    if (!legacyMirrored) {
      await completeAutomationJobProjectionRepair(context, { legacyMirrored: false }, now);
    }
    await observePhase('COMPLETED', {
      catchUpPasses: candidate.catchUpPasses,
      catchUpPending: false,
    });
    await runTransaction<AutomationJobProjectionRebuildStagingRecord>(
      JOB_PROJECTION_REBUILD_STAGING,
      items => items.map(item => item.id === context.rebuildToken ? {
        ...item,
        status: legacyMirrored ? 'MIRRORED' : 'PROMOTED',
        completedAt: new Date(now).toISOString(),
      } : item),
    );
    await cleanupStaleProjectionCandidates(now);
    const manifest = await getAutomationJobProjectionManifestForMaintenance();
    if (
      !manifest
      || manifest.activeGeneration !== context.targetGeneration
      || (manifest.sourceHighWatermark || 0) < candidate.sourceBoundary.highWatermark
      || !manifest.lastSuccessfulRepairAt
    ) {
      throw new Error('JOB_PROJECTION_REBUILD_MANIFEST_NOT_VERIFIED');
    }
    return manifest;
  } catch (error) {
    if (promoted) {
      const recovered = await completeAutomationJobProjectionRepair(
        context,
        { legacyMirrored: false },
        now,
      ).catch(() => getAutomationJobProjectionManifestForMaintenance());
      if (
        recovered?.activeGeneration === context.targetGeneration
        && (recovered.activeSlot === 'LEGACY'
          || recovered.activeStorageRepairFence === context.repairFence)
      ) {
        await observePhase('COMPLETED', {
          catchUpPasses: candidate?.catchUpPasses || 0,
          catchUpPending: false,
        }).catch(() => undefined);
        await cleanupStaleProjectionCandidates(now).catch(() => undefined);
        return recovered;
      }
    } else {
      await failAutomationJobProjectionRepair(
        context,
        error instanceof Error ? error.message : 'JOB_PROJECTION_REBUILD_FAILED',
        now,
      ).catch(() => undefined);
      await refreshAutomationJobHealthSummary(now).catch(() => undefined);
      const terminalPhase: AutomationJobProjectionRepairPhase = error instanceof Error
        && error.message.includes('FENCING')
        ? 'SUPERSEDED'
        : 'FAILED';
      await observePhase(terminalPhase, {
        catchUpPasses: candidate?.catchUpPasses || 0,
        catchUpPending: false,
        lastFailureReason: error instanceof Error ? error.message : 'JOB_PROJECTION_REBUILD_FAILED',
      }).catch(() => undefined);
    }
    await cleanupStaleProjectionCandidates(now).catch(() => undefined);
    await runTransaction<AutomationJobProjectionRebuildStagingRecord>(
      JOB_PROJECTION_REBUILD_STAGING,
      items => items.map(item => item.id === context.rebuildToken ? {
        ...item,
        status: 'FAILED',
        completedAt: new Date(now).toISOString(),
        reasonCode: error instanceof Error
          ? error.message.replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 120)
          : 'JOB_PROJECTION_REBUILD_FAILED',
      } : item),
    ).catch(() => undefined);
    throw error;
  }
}

interface ProjectionMutationStats {
  inserted: boolean;
  insertedCount: number;
  sourceAffected: boolean;
  count: number;
  activeCount: number;
  terminalCount: number;
  fingerprint: string;
  contentFingerprint: string;
  retentionLimitReached: boolean;
  currentStateTruncated: boolean;
  sourceUpdatedAt: string | null;
  retentionBoundary: AutomationJobProjectionRetentionBoundary | null;
}

function boundedProjectionItems<T extends Pick<AutomationJob, 'id' | 'status' | 'updatedAt'>>(
  items: T[],
): { items: T[]; stats: Omit<ProjectionMutationStats, 'inserted' | 'insertedCount' | 'sourceAffected'> } {
  const activeBeforeRetention = items.filter(item => !TERMINAL.has(item.status)).length;
  let retained = items;
  if (items.length > MAX_JOB_PROJECTIONS) {
    const oldestFirst = [...items].sort((left, right) => {
      const byUpdatedAt = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      // The rebuild retains lexicographically smaller ids when timestamps tie,
      // so incremental eviction removes the larger ids first at that boundary.
      return byUpdatedAt || right.id.localeCompare(left.id);
    });
    const removable = [
      ...oldestFirst.filter(item => TERMINAL.has(item.status)),
      ...oldestFirst.filter(item => !TERMINAL.has(item.status)),
    ];
    const removeIds = new Set(removable.slice(0, items.length - MAX_JOB_PROJECTIONS).map(item => item.id));
    retained = removeIds.size ? items.filter(item => !removeIds.has(item.id)) : items;
  }
  const timestamps = retained
    .map(item => ({ value: item.updatedAt, parsed: Date.parse(item.updatedAt) }))
    .filter((item): item is { value: string; parsed: number } => Number.isFinite(item.parsed))
    .sort((left, right) => left.parsed - right.parsed);
  const retentionLimitReached = items.length >= MAX_JOB_PROJECTIONS;
  return {
    items: retained,
    stats: {
      count: retained.length,
      activeCount: retained.filter(item => !TERMINAL.has(item.status)).length,
      terminalCount: retained.filter(item => TERMINAL.has(item.status)).length,
      fingerprint: automationJobProjectionFingerprint(retained),
      contentFingerprint: automationJobProjectionContentFingerprint(retained),
      retentionLimitReached,
      currentStateTruncated: activeBeforeRetention > MAX_JOB_PROJECTIONS,
      sourceUpdatedAt: timestamps.at(-1)?.value || null,
      retentionBoundary: retentionLimitReached && timestamps[0]
        ? { field: 'updatedAt', oldestRetainedAt: timestamps[0].value }
        : null,
    },
  };
}

async function syncJobProjections(
  jobs: AutomationJob[],
  collection: string,
): Promise<ProjectionMutationStats> {
  let output: ProjectionMutationStats | undefined;
  await runTransaction<AutomationJobStatusProjection>(collection, items => {
    const previousContentFingerprint = automationJobProjectionContentFingerprint(items);
    let insertedCount = 0;
    for (const job of jobs) {
      const index = items.findIndex(item => item.id === job.id);
      const projection = projectAutomationJobStatusItem(job);
      if (index >= 0) {
        if ((items[index].projectionSourceVersion || 0) > (projection.projectionSourceVersion || 0)) continue;
        items[index] = projection;
      } else {
        insertedCount += 1;
        items.push(projection);
      }
    }
    const bounded = boundedProjectionItems(items);
    output = {
      inserted: insertedCount > 0,
      insertedCount,
      sourceAffected: previousContentFingerprint !== bounded.stats.contentFingerprint,
      ...bounded.stats,
    };
    return bounded.items;
  });
  if (!output) throw new Error('JOB_STATUS_PROJECTION_SYNC_RESULT_MISSING');
  return output;
}

async function syncJobListProjections(
  jobs: AutomationJob[],
  collection: string,
): Promise<ProjectionMutationStats> {
  let output: ProjectionMutationStats | undefined;
  await runTransaction<AutomationJobListProjection>(collection, items => {
    const previousContentFingerprint = automationJobProjectionContentFingerprint(items);
    let insertedCount = 0;
    for (const job of jobs) {
      const index = items.findIndex(item => item.id === job.id);
      const projection = projectAutomationJobListItem(job);
      if (index >= 0) {
        if ((items[index].projectionSourceVersion || 0) > (projection.projectionSourceVersion || 0)) continue;
        items[index] = projection;
      } else {
        insertedCount += 1;
        items.push(projection);
      }
    }
    const bounded = boundedProjectionItems(items);
    output = {
      inserted: insertedCount > 0,
      insertedCount,
      sourceAffected: previousContentFingerprint !== bounded.stats.contentFingerprint,
      ...bounded.stats,
    };
    return bounded.items;
  });
  if (!output) throw new Error('JOB_LIST_PROJECTION_SYNC_RESULT_MISSING');
  return output;
}

async function removeJobProjections<T extends Pick<AutomationJob, 'id' | 'status' | 'updatedAt'>>(
  jobIds: ReadonlySet<string>,
  collection: string,
): Promise<ProjectionMutationStats> {
  let output: ProjectionMutationStats | undefined;
  await runTransaction<T>(collection, items => {
    const filtered = items.filter(item => !jobIds.has(item.id));
    const removedCount = items.length - filtered.length;
    const bounded = boundedProjectionItems(filtered);
    output = {
      inserted: false,
      insertedCount: 0,
      sourceAffected: removedCount > 0,
      ...bounded.stats,
    };
    return removedCount > 0 ? bounded.items : undefined;
  });
  if (!output) throw new Error('JOB_PROJECTION_REMOVE_RESULT_MISSING');
  return output;
}

async function removeJobHeartbeats(jobIds: string[]): Promise<void> {
  const ids = new Set(jobIds);
  await runTransaction<AutomationJobHeartbeat>(JOB_HEARTBEATS, items => {
    const filtered = items.filter(item => !ids.has(item.jobId));
    return filtered.length === items.length ? undefined : filtered;
  });
}

async function syncJobReadModelsBatchBestEffort(
  jobs: AutomationJob[],
  input: {
    removeHeartbeatJobIds?: string[];
    mutation?: AutomationJobProjectionMutationHandle;
    sourceMutationCommitted?: boolean;
    supersededRetry?: boolean;
  } = {},
): Promise<void> {
  if (!jobs.length) {
    if (input.mutation) await abortAutomationJobProjectionMutation(input.mutation).catch(() => undefined);
    return;
  }
  const mutation = input.mutation || await beginAutomationJobProjectionMutation();
  const sourceVersions = mutation.jobSourceVersions || {};
  const versionedJobs = jobs.map(job => sourceVersions[job.id] === undefined
    ? job
    : { ...job, projectionSourceVersion: sourceVersions[job.id] });
  const collections = automationJobProjectionStorageCollections(mutation.targetSlot, mutation.targetRepairFence);
  const operations: Array<{ label: string; work: Promise<ProjectionMutationStats | void> }> = [
    { label: 'status-projection', work: syncJobProjections(versionedJobs, collections.status) },
    { label: 'list-projection-v2', work: syncJobListProjections(versionedJobs, collections.list) },
  ];
  if (input.removeHeartbeatJobIds?.length) {
    operations.push({ label: 'heartbeat', work: removeJobHeartbeats(input.removeHeartbeatJobIds) });
  }
  const results = await Promise.allSettled(operations.map(operation => operation.work));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(JSON.stringify({
        type: 'automation_job_read_model_sync_failed',
        jobId: jobs[0].id,
        jobCount: jobs.length,
        readModel: operations[index].label,
        reasonCode: sanitizeErrorMessage(result.reason instanceof Error ? result.reason.message : 'unknown_error'),
      }));
    }
  });
  const statusResult = results[0];
  const listResult = results[1];
  const projectionSyncSucceeded = statusResult.status === 'fulfilled'
    && listResult.status === 'fulfilled'
    && statusResult.value !== undefined
    && listResult.value !== undefined;
  const statusStats = statusResult.status === 'fulfilled' && statusResult.value
    ? statusResult.value
    : undefined;
  const listStats = listResult.status === 'fulfilled' && listResult.value
    ? listResult.value
    : undefined;
  try {
    await finishAutomationJobProjectionSync(mutation, {
      success: projectionSyncSucceeded,
      inserted: Boolean(statusStats?.inserted || listStats?.inserted),
      insertedCount: Math.max(statusStats?.insertedCount || 0, listStats?.insertedCount || 0),
      // The durable source watermark advances only for a committed JOBS write.
      // Repairing an already-existing read model must not invent a source event.
      sourceAffected: input.sourceMutationCommitted === true && (
        !projectionSyncSucceeded
        || Boolean(statusStats?.sourceAffected || listStats?.sourceAffected)
        || Math.max(statusStats?.insertedCount || 0, listStats?.insertedCount || 0) > 0
      ),
      projectionChanged: Boolean(statusStats?.sourceAffected || listStats?.sourceAffected),
      listProjectionCount: listStats?.count || 0,
      statusProjectionCount: statusStats?.count || 0,
      listProjectionFingerprint: listStats?.fingerprint || automationJobProjectionFingerprint([]),
      statusProjectionFingerprint: statusStats?.fingerprint || automationJobProjectionFingerprint([]),
      listProjectionContentFingerprint: listStats?.contentFingerprint
        || automationJobProjectionContentFingerprint([]),
      statusProjectionContentFingerprint: statusStats?.contentFingerprint
        || automationJobProjectionContentFingerprint([]),
      activeJobCount: Math.max(statusStats?.activeCount || 0, listStats?.activeCount || 0),
      retainedTerminalCount: projectionSyncSucceeded
        ? Math.min(statusStats?.terminalCount || 0, listStats?.terminalCount || 0)
        : 0,
      retentionLimitReached: Boolean(statusStats?.retentionLimitReached || listStats?.retentionLimitReached),
      currentStateTruncated: Boolean(statusStats?.currentStateTruncated || listStats?.currentStateTruncated),
      sourceUpdatedAt: [statusStats?.sourceUpdatedAt, listStats?.sourceUpdatedAt]
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null,
      retentionBoundary: statusStats?.retentionBoundary || listStats?.retentionBoundary || null,
    });
  } catch (error) {
    console.error(JSON.stringify({
      type: 'automation_job_projection_manifest_sync_failed',
      jobId: jobs[0].id,
      jobCount: jobs.length,
      reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'unknown_error'),
    }));
    if (
      input.sourceMutationCommitted === true
      && input.supersededRetry !== true
      && error instanceof Error
      && ['JOB_PROJECTION_MUTATION_SUPERSEDED', 'JOB_PROJECTION_MUTATION_GENERATION_SUPERSEDED'].includes(error.message)
    ) {
      await syncJobReadModelsBatchBestEffort(versionedJobs, {
        removeHeartbeatJobIds: input.removeHeartbeatJobIds,
        sourceMutationCommitted: true,
        supersededRetry: true,
      });
    }
    return;
  }
  if (!projectionSyncSucceeded) return;
  const manifestAfterSync = await getAutomationJobProjectionManifestForMaintenance().catch(() => null);
  if (manifestAfterSync?.rebuildToken || manifestAfterSync?.inFlightSyncTokens.length) return;
  try {
    await refreshAutomationJobHealthSummary();
  } catch (error) {
    console.error(JSON.stringify({
      type: 'automation_job_health_summary_sync_failed',
      jobId: jobs[0].id,
      jobCount: jobs.length,
      readModel: 'job-health-summary-v1',
      reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'unknown_error'),
    }));
  }
}

async function syncJobReadModelsBestEffort(
  job: AutomationJob,
  removeHeartbeat = false,
  mutation?: AutomationJobProjectionMutationHandle,
): Promise<void> {
  await syncJobReadModelsBatchBestEffort([job], {
    mutation,
    sourceMutationCommitted: Boolean(mutation),
    removeHeartbeatJobIds: removeHeartbeat ? [job.id] : [],
  });
}
const COOPERATIVELY_CANCELLABLE = new Set<AutomationJobType>([
  'RECHECK_PRODUCT_HEALTH',
  'SCORE_PRODUCTS',
  'CAPTURE_PRICE_HISTORY',
  'PREPARE_CONTENT_DRAFT',
  'EDITORIAL_CHECK',
  'BULK_PRODUCT_OPERATION',
]);

export function productProcessingReservationKey(job: Pick<AutomationJob, 'idempotencyKey'>): string {
  return `automation-product:${job.idempotencyKey}`;
}

function canCancelWhileRunning(job: AutomationJob): boolean {
  if (!COOPERATIVELY_CANCELLABLE.has(job.type)) return false;
  return job.type !== 'BULK_PRODUCT_OPERATION' || job.payload.action !== 'merge_duplicates';
}

export const DEFAULT_CONTROL: AutomationControlState = {
  schemaVersion: 2,
  id: 'automation-control',
  mode: 'OBSERVE',
  effectiveMode: 'OBSERVE',
  publishPaused: false,
  publishPausedByOperator: false,
  publishBlockedByRuntime: false,
  publishBlockedByPolicy: false,
  publishRuntimeReasons: [],
  publishPolicyReasons: [],
  ingestionPaused: false,
  workerPaused: false,
  schedulerPaused: true,
  killSwitch: false,
  timezone: 'Asia/Ho_Chi_Minh',
  updatedAt: new Date(0).toISOString(),
};

const MAX_AUDITED_RUNTIME_CONTROL_APPLICATIONS = 50;
const MAX_EXPLICIT_RUNTIME_REASONS = 100;
const RUNTIME_CONTROL_JOURNAL_INVALID_REASON = 'RUNTIME_CONTROL_JOURNAL_INVALID';
type RuntimeControlApplication = NonNullable<AutomationControlState['runtimeControlApplications']>[number];

function normalizedRuntimeControlApplication(value: unknown): RuntimeControlApplication | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RuntimeControlApplication>;
  const validMode = (mode: unknown): mode is AutomationControlState['effectiveMode'] =>
    ['OBSERVE', 'SHADOW', 'CANARY', 'AUTONOMOUS'].includes(String(mode));
  const appliedAt = Date.parse(String(candidate.appliedAt || ''));
  const auditedAt = candidate.auditedAt === undefined
    ? undefined
    : Date.parse(String(candidate.auditedAt || ''));
  if (
    candidate.schemaVersion !== 1
    || !['RUNTIME_BLOCK_APPLIED', 'RUNTIME_REASONS_CLEARED'].includes(String(candidate.operationType))
    || typeof candidate.evaluationId !== 'string'
    || !candidate.evaluationId.trim()
    || candidate.evaluationId.length > 240
    || typeof candidate.actor !== 'string'
    || !candidate.actor.trim()
    || candidate.actor.length > 200
    || !validMode(candidate.previousEffectiveMode)
    || !validMode(candidate.nextEffectiveMode)
    || !Number.isFinite(appliedAt)
    || (auditedAt !== undefined && !Number.isFinite(auditedAt))
    || !Array.isArray(candidate.reasons)
    || !Array.isArray(candidate.previousRuntimeReasons)
    || !Array.isArray(candidate.nextRuntimeReasons)
  ) return null;
  return {
    schemaVersion: 1,
    evaluationId: candidate.evaluationId.trim(),
    operationType: candidate.operationType as RuntimeControlApplication['operationType'],
    actor: candidate.actor.trim(),
    reasons: normalizedRuntimeReasons(candidate.reasons),
    previousRuntimeReasons: normalizedRuntimeReasons(candidate.previousRuntimeReasons),
    nextRuntimeReasons: normalizedRuntimeReasons(candidate.nextRuntimeReasons),
    previousEffectiveMode: candidate.previousEffectiveMode,
    nextEffectiveMode: candidate.nextEffectiveMode,
    appliedAt: new Date(appliedAt).toISOString(),
    auditedAt: auditedAt === undefined ? undefined : new Date(auditedAt).toISOString(),
  };
}

function runtimeControlApplicationJournal(value: unknown): {
  valid: RuntimeControlApplication[];
  invalidEntries: unknown[];
} {
  if (!Array.isArray(value)) return { valid: [], invalidEntries: value === undefined ? [] : [value] };
  const valid: RuntimeControlApplication[] = [];
  const invalidEntries: unknown[] = [];
  for (const item of value) {
    const normalized = normalizedRuntimeControlApplication(item);
    if (normalized) valid.push(normalized);
    else invalidEntries.push(item);
  }
  return { valid, invalidEntries };
}

function retainedRuntimeControlApplications(
  value: AutomationControlState['runtimeControlApplications'] | unknown,
): NonNullable<AutomationControlState['runtimeControlApplications']> {
  const applications = runtimeControlApplicationJournal(value).valid;
  const audited = applications.filter(application => Boolean(application.auditedAt));
  const pending = applications.filter(application => !application.auditedAt);
  // Pending audit/idempotency intents are never discarded by a history cap.
  return [
    ...audited.slice(-MAX_AUDITED_RUNTIME_CONTROL_APPLICATIONS),
    ...pending,
  ];
}

function persistedRuntimeControlApplications(
  original: unknown,
  validApplications: RuntimeControlApplication[],
): AutomationControlState['runtimeControlApplications'] {
  const invalidEntries = runtimeControlApplicationJournal(original).invalidEntries;
  // Malformed durable entries are retained verbatim for forensic recovery.
  // The typed read view excludes them and applies a fail-closed blocker.
  return [
    ...invalidEntries,
    ...retainedRuntimeControlApplications(validApplications),
  ] as AutomationControlState['runtimeControlApplications'];
}

export function sanitizeAutomationData(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[Đã rút gọn]';
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'string') {
    const redacted = value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:access_?token|token|api_?key|signature|secret|password|authorization)=)[^&\s]+/gi, '$1[REDACTED]');
    return redacted.slice(0, 1_000);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeAutomationData(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (SECRET_KEY.test(key)) continue;
    output[key] = sanitizeAutomationData(item, depth + 1);
  }
  return output;
}

export async function appendAutomationAudit(input: Omit<AutomationAuditEvent, 'schemaVersion' | 'id' | 'createdAt'>): Promise<void> {
  const event: AutomationAuditEvent = {
    ...input,
    schemaVersion: 2,
    id: generateId(),
    result: sanitizeAutomationData(input.result) as Record<string, unknown> | undefined,
    reasons: input.reasons.map(reason => sanitizeErrorMessage(reason)).slice(0, 20),
    createdAt: new Date().toISOString(),
  };
  await runTransaction<AutomationAuditEvent>(AUDIT, items => [...items.slice(-4_999), event]);
}

export async function getAutomationControl(): Promise<AutomationControlState> {
  const stored = (await readCollection<Partial<AutomationControlState>>(CONTROL))[0];
  if (!stored) return { ...DEFAULT_CONTROL };
  const runtimeJournal = runtimeControlApplicationJournal(stored.runtimeControlApplications);
  const runtimeControlJournalInvalidCount = runtimeJournal.invalidEntries.length;
  const hasProvenance = typeof stored.publishPausedByOperator === 'boolean'
    || typeof stored.publishBlockedByRuntime === 'boolean'
    || typeof stored.publishBlockedByPolicy === 'boolean';
  const systemPause = ['runtime-guardian', 'error-budget-controller'].includes(String(stored.changedBy || ''));
  const publishPausedByOperator = stored.publishPausedByOperator
    ?? (hasProvenance ? false : Boolean(stored.publishPaused) && !systemPause);
  const publishBlockedByRuntime = Boolean(
    (stored.publishBlockedByRuntime
      ?? (hasProvenance ? false : Boolean(stored.publishPaused) && systemPause))
    || runtimeControlJournalInvalidCount > 0
  );
  const publishBlockedByPolicy = stored.publishBlockedByPolicy ?? false;
  return {
    ...DEFAULT_CONTROL,
    ...stored,
    schemaVersion: 2,
    id: 'automation-control',
    publishPausedByOperator,
    publishBlockedByRuntime,
    publishBlockedByPolicy,
    publishRuntimeReasons: normalizedRuntimeReasons([
      ...(stored.publishRuntimeReasons || []),
      ...(runtimeControlJournalInvalidCount > 0 ? [RUNTIME_CONTROL_JOURNAL_INVALID_REASON] : []),
    ]),
    publishPolicyReasons: Array.isArray(stored.publishPolicyReasons) ? stored.publishPolicyReasons.map(String).slice(0, 20) : [],
    runtimeControlApplications: retainedRuntimeControlApplications(runtimeJournal.valid),
    runtimeControlJournalInvalidCount,
    publishPaused: publishPausedByOperator || publishBlockedByRuntime || publishBlockedByPolicy,
  };
}

export async function updateAutomationControl(
  updates: Partial<Pick<AutomationControlState, 'mode' | 'effectiveMode' | 'publishPaused' | 'publishPausedByOperator' | 'publishBlockedByRuntime' | 'publishBlockedByPolicy' | 'publishRuntimeReasons' | 'publishPolicyReasons' | 'ingestionPaused' | 'workerPaused' | 'schedulerPaused' | 'pausedAt' | 'pauseReason' | 'killSwitch' | 'reason' | 'changedBy' | 'workerHeartbeatAt' | 'workerId' | 'workerCurrentJobId' | 'schedulerHeartbeatAt' | 'schedulerLastRunAt' | 'schedulerNextRunAt' | 'guardianHeartbeatAt' | 'degradedAt' | 'degradedReason'>>,
  actor = 'system',
): Promise<AutomationControlState> {
  let previous = await getAutomationControl();
  let next = previous;
  const now = new Date().toISOString();
  const changesControlState = 'killSwitch' in updates
    || 'workerPaused' in updates
    || 'schedulerPaused' in updates
    || 'mode' in updates
    || 'effectiveMode' in updates
    || 'publishPaused' in updates
    || 'publishPausedByOperator' in updates
    || 'publishBlockedByRuntime' in updates
    || 'publishBlockedByPolicy' in updates
    || 'ingestionPaused' in updates;
  await runTransaction<AutomationControlState>(CONTROL, items => {
    const rawPrevious = items[0] || { ...DEFAULT_CONTROL };
    const runtimeJournal = runtimeControlApplicationJournal(rawPrevious.runtimeControlApplications);
    const invalidRuntimeJournal = runtimeJournal.invalidEntries.length > 0;
    const hasProvenance = typeof rawPrevious.publishPausedByOperator === 'boolean'
      || typeof rawPrevious.publishBlockedByRuntime === 'boolean'
      || typeof rawPrevious.publishBlockedByPolicy === 'boolean';
    const legacySystemPause = ['runtime-guardian', 'error-budget-controller'].includes(String(rawPrevious.changedBy || ''));
    previous = {
      ...DEFAULT_CONTROL,
      ...rawPrevious,
      publishPausedByOperator: rawPrevious.publishPausedByOperator
        ?? (hasProvenance ? false : Boolean(rawPrevious.publishPaused) && !legacySystemPause),
      publishBlockedByRuntime: Boolean(
        (rawPrevious.publishBlockedByRuntime
          ?? (hasProvenance ? false : Boolean(rawPrevious.publishPaused) && legacySystemPause))
        || invalidRuntimeJournal
      ),
      publishBlockedByPolicy: rawPrevious.publishBlockedByPolicy ?? false,
      publishRuntimeReasons: normalizedRuntimeReasons([
        ...(rawPrevious.publishRuntimeReasons || []),
        ...(invalidRuntimeJournal ? [RUNTIME_CONTROL_JOURNAL_INVALID_REASON] : []),
      ]),
      runtimeControlApplications: rawPrevious.runtimeControlApplications,
      runtimeControlJournalInvalidCount: runtimeJournal.invalidEntries.length,
    };
    const normalizedUpdates = { ...updates };
    if ('publishPaused' in updates
      && !('publishPausedByOperator' in updates)
      && !('publishBlockedByRuntime' in updates)
      && !('publishBlockedByPolicy' in updates)) {
      if (['runtime-guardian', 'error-budget-controller'].includes(actor)) {
        normalizedUpdates.publishBlockedByRuntime = Boolean(updates.publishPaused);
      } else {
        normalizedUpdates.publishPausedByOperator = Boolean(updates.publishPaused);
      }
    }
    if (
      previous.publishBlockedByRuntime === true
      && normalizedUpdates.publishBlockedByRuntime === false
    ) {
      throw new Error('RUNTIME_PUBLISH_BLOCK_CLEAR_REQUIRES_EVIDENCE_PATH');
    }
    if (
      previous.publishBlockedByRuntime === true
      && Array.isArray(normalizedUpdates.publishRuntimeReasons)
    ) {
      const requestedRuntimeReasons = normalizedRuntimeReasons(normalizedUpdates.publishRuntimeReasons);
      const existingRuntimeReasons = normalizedRuntimeReasons(previous.publishRuntimeReasons);
      if (existingRuntimeReasons.some(reasonCode => !requestedRuntimeReasons.includes(reasonCode))) {
        throw new Error('RUNTIME_PUBLISH_REASON_REMOVAL_REQUIRES_EVIDENCE_PATH');
      }
    }
    next = { ...previous, ...normalizedUpdates, schemaVersion: 2, id: 'automation-control', updatedAt: now };
    if ('publishPaused' in updates
      || 'publishPausedByOperator' in normalizedUpdates
      || 'publishBlockedByRuntime' in normalizedUpdates
      || 'publishBlockedByPolicy' in normalizedUpdates) {
      next.publishPaused = Boolean(next.publishPausedByOperator || next.publishBlockedByRuntime || next.publishBlockedByPolicy);
    }
    if (changesControlState) {
      next.changedAt = now;
      next.changedBy = actor;
    }
    return [next];
  });
  if (changesControlState) {
    await appendAutomationAudit({
      correlationId: generateId(), operationId: generateId(), operationType: 'CONTROL_CHANGED', actor,
      target: 'automation-control', previousState: JSON.stringify({
        mode: previous.mode, effectiveMode: previous.effectiveMode, publishPaused: previous.publishPaused,
        publishPausedByOperator: previous.publishPausedByOperator, publishBlockedByRuntime: previous.publishBlockedByRuntime,
        publishBlockedByPolicy: previous.publishBlockedByPolicy, ingestionPaused: previous.ingestionPaused,
        workerPaused: previous.workerPaused, schedulerPaused: previous.schedulerPaused, killSwitch: previous.killSwitch,
      }),
      nextState: JSON.stringify({
        mode: next.mode, effectiveMode: next.effectiveMode, publishPaused: next.publishPaused,
        publishPausedByOperator: next.publishPausedByOperator, publishBlockedByRuntime: next.publishBlockedByRuntime,
        publishBlockedByPolicy: next.publishBlockedByPolicy, ingestionPaused: next.ingestionPaused,
        workerPaused: next.workerPaused, schedulerPaused: next.schedulerPaused, killSwitch: next.killSwitch,
      }),
      risk: updates.killSwitch ? 'HIGH' : 'MEDIUM', reasons: updates.reason ? [updates.reason] : [], dryRun: false, attempts: 0,
    });
  }
  return getAutomationControl();
}

export interface ApplyRuntimePublishBlockResult {
  control: AutomationControlState;
  previousEffectiveMode: AutomationControlState['effectiveMode'];
  nextEffectiveMode: AutomationControlState['effectiveMode'];
  addedReasons: string[];
  status: 'APPLIED' | 'ALREADY_APPLIED';
}

function nextRuntimeDegradedMode(
  mode: AutomationControlState['effectiveMode'],
): AutomationControlState['effectiveMode'] {
  if (mode === 'AUTONOMOUS') return 'CANARY';
  if (mode === 'CANARY') return 'SHADOW';
  return mode;
}

function normalizedRuntimeReasons(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const reasons = [...new Set(values
    .map(String)
    .map(item => item.trim().slice(0, 200))
    .filter(Boolean))];
  if (reasons.length <= MAX_EXPLICIT_RUNTIME_REASONS) return reasons;
  const overflowHash = createHash('sha256').update(JSON.stringify(reasons)).digest('hex').slice(0, 16);
  return [
    ...reasons.slice(0, MAX_EXPLICIT_RUNTIME_REASONS - 1),
    `RUNTIME_BLOCK_REASON_OVERFLOW:${reasons.length}:${overflowHash}`,
  ];
}

/**
 * Adds runtime blockers atomically. The evaluation id is a durable idempotency
 * key, so retrying an interrupted controller invocation cannot degrade twice.
 */
export async function applyRuntimePublishBlock(
  input: {
    reasonCodes: string[];
    evaluationId: string;
    evaluatedAt?: string;
    degradeMode?: boolean;
  },
  actor = 'error-budget-controller',
): Promise<ApplyRuntimePublishBlockResult> {
  const reasons = normalizedRuntimeReasons(input.reasonCodes);
  if (!reasons.length) throw new Error('RUNTIME_PUBLISH_BLOCK_REASON_REQUIRED');
  const evaluationId = String(input.evaluationId || '').trim().slice(0, 240);
  if (!evaluationId) throw new Error('RUNTIME_PUBLISH_BLOCK_EVALUATION_REQUIRED');
  let output!: ApplyRuntimePublishBlockResult;
  await runTransaction<AutomationControlState>(CONTROL, items => {
    const raw = items[0] || { ...DEFAULT_CONTROL };
    const runtimeJournal = runtimeControlApplicationJournal(raw.runtimeControlApplications);
    const invalidRuntimeJournal = runtimeJournal.invalidEntries.length > 0;
    const hasProvenance = typeof raw.publishPausedByOperator === 'boolean'
      || typeof raw.publishBlockedByRuntime === 'boolean'
      || typeof raw.publishBlockedByPolicy === 'boolean';
    const legacySystemPause = ['runtime-guardian', 'error-budget-controller'].includes(String(raw.changedBy || ''));
    const previous: AutomationControlState = {
      ...DEFAULT_CONTROL,
      ...raw,
      publishPausedByOperator: raw.publishPausedByOperator
        ?? (hasProvenance ? false : Boolean(raw.publishPaused) && !legacySystemPause),
      publishBlockedByRuntime: Boolean(
        (raw.publishBlockedByRuntime
          ?? (hasProvenance ? false : Boolean(raw.publishPaused) && legacySystemPause))
        || invalidRuntimeJournal
      ),
      publishBlockedByPolicy: raw.publishBlockedByPolicy ?? false,
      publishRuntimeReasons: normalizedRuntimeReasons([
        ...(raw.publishRuntimeReasons || []),
        ...(invalidRuntimeJournal ? [RUNTIME_CONTROL_JOURNAL_INVALID_REASON] : []),
      ]),
      publishPolicyReasons: normalizedRuntimeReasons(raw.publishPolicyReasons),
      runtimeControlApplications: retainedRuntimeControlApplications(runtimeJournal.valid),
      runtimeControlJournalInvalidCount: runtimeJournal.invalidEntries.length,
    };
    const existing = previous.runtimeControlApplications?.find(
      application => application.evaluationId === evaluationId
        && application.operationType === 'RUNTIME_BLOCK_APPLIED',
    );
    if (existing) {
      output = {
        control: previous,
        previousEffectiveMode: existing.previousEffectiveMode,
        nextEffectiveMode: existing.nextEffectiveMode,
        addedReasons: existing.reasons.filter(reason => !existing.previousRuntimeReasons.includes(reason)),
        status: 'ALREADY_APPLIED',
      };
      return undefined;
    }
    const previousReasons = normalizedRuntimeReasons(previous.publishRuntimeReasons);
    const nextReasons = normalizedRuntimeReasons([...previousReasons, ...reasons]);
    const nextMode = input.degradeMode === false
      ? previous.effectiveMode
      : nextRuntimeDegradedMode(previous.effectiveMode);
    const appliedAt = input.evaluatedAt && Number.isFinite(Date.parse(input.evaluatedAt))
      ? new Date(input.evaluatedAt).toISOString()
      : new Date().toISOString();
    const application: NonNullable<AutomationControlState['runtimeControlApplications']>[number] = {
      schemaVersion: 1,
      evaluationId,
      operationType: 'RUNTIME_BLOCK_APPLIED',
      actor: actor.slice(0, 200),
      reasons,
      previousRuntimeReasons: previousReasons,
      nextRuntimeReasons: nextReasons,
      previousEffectiveMode: previous.effectiveMode,
      nextEffectiveMode: nextMode,
      appliedAt,
    };
    const next: AutomationControlState = {
      ...previous,
      effectiveMode: nextMode,
      publishBlockedByRuntime: true,
      publishRuntimeReasons: nextReasons,
      publishPaused: true,
      degradedAt: appliedAt,
      degradedReason: nextReasons.join(','),
      reason: nextReasons.join(','),
      changedAt: appliedAt,
      changedBy: actor,
      updatedAt: appliedAt,
      runtimeControlApplications: persistedRuntimeControlApplications(
        raw.runtimeControlApplications,
        [...(previous.runtimeControlApplications || []), application],
      ),
    };
    output = {
      control: next,
      previousEffectiveMode: previous.effectiveMode,
      nextEffectiveMode: nextMode,
      addedReasons: reasons.filter(reason => !previousReasons.includes(reason)),
      status: 'APPLIED',
    };
    return [next];
  });
  return output;
}

/**
 * Replays any durable audit intent left by a crash between the control update
 * and its audit append. appendAutomationAuditOnce keeps this retry idempotent.
 */
export async function flushRuntimeControlApplicationAudits(): Promise<number> {
  const control = await getAutomationControl();
  const pending = (control.runtimeControlApplications || []).filter(application => !application.auditedAt);
  let flushed = 0;
  for (const application of pending) {
    await appendAutomationAuditOnce({
      correlationId: application.evaluationId,
      operationId: `${application.evaluationId}:${application.operationType}:automation-control`,
      operationType: application.operationType === 'RUNTIME_BLOCK_APPLIED'
        ? 'CONTROL_RUNTIME_BLOCK_APPLIED'
        : 'CONTROL_RUNTIME_REASONS_CLEARED',
      actor: application.actor,
      target: 'automation-control',
      previousState: JSON.stringify({
        effectiveMode: application.previousEffectiveMode,
        publishRuntimeReasons: application.previousRuntimeReasons,
      }),
      nextState: JSON.stringify({
        effectiveMode: application.nextEffectiveMode,
        publishRuntimeReasons: application.nextRuntimeReasons,
      }),
      risk: 'HIGH',
      reasons: application.reasons,
      dryRun: false,
      attempts: 1,
    });
    const auditedAt = new Date().toISOString();
    await runTransaction<AutomationControlState>(CONTROL, items => {
      const current = items[0];
      if (!current || !Array.isArray(current.runtimeControlApplications)) return undefined;
      const target = (current.runtimeControlApplications as unknown[]).find(item => {
        const normalized = normalizedRuntimeControlApplication(item);
        return normalized?.evaluationId === application.evaluationId
          && normalized.operationType === application.operationType;
      });
      const normalizedTarget = normalizedRuntimeControlApplication(target);
      if (!target || !normalizedTarget || normalizedTarget.auditedAt) return undefined;
      (target as RuntimeControlApplication).auditedAt = auditedAt;
      current.updatedAt = auditedAt;
      return [current];
    });
    flushed += 1;
  }
  return flushed;
}

export interface ClearRuntimePublishReasonsResult {
  control: AutomationControlState;
  clearedReasons: string[];
  status: 'CLEARED' | 'NO_MATCH' | 'STATE_CONFLICT';
}

/**
 * Evidence-based recovery uses this compare-and-set path so a concurrent
 * runtime incident, operator action, or policy change cannot be overwritten by
 * an older healthy observation.
 */
export async function clearRuntimePublishReasons(
  input: {
    reasonCodes: string[];
    expectedChangedAt?: string;
    expectedRuntimeReasons: string[];
    reason: string;
    evaluationId: string;
  },
  actor = 'error-budget-controller',
): Promise<ClearRuntimePublishReasonsResult> {
  const requestedReasons = normalizedRuntimeReasons(input.reasonCodes);
  const expectedReasons = normalizedRuntimeReasons(input.expectedRuntimeReasons).sort();
  let previous = await getAutomationControl();
  let next = previous;
  let clearedReasons: string[] = [];
  let status: ClearRuntimePublishReasonsResult['status'] = 'NO_MATCH';
  await runTransaction<AutomationControlState>(CONTROL, items => {
    const raw = items[0] || { ...DEFAULT_CONTROL };
    const runtimeJournal = runtimeControlApplicationJournal(raw.runtimeControlApplications);
    const invalidRuntimeJournal = runtimeJournal.invalidEntries.length > 0;
    const hasProvenance = typeof raw.publishPausedByOperator === 'boolean'
      || typeof raw.publishBlockedByRuntime === 'boolean'
      || typeof raw.publishBlockedByPolicy === 'boolean';
    const legacySystemPause = ['runtime-guardian', 'error-budget-controller'].includes(String(raw.changedBy || ''));
    previous = {
      ...DEFAULT_CONTROL,
      ...raw,
      publishPausedByOperator: raw.publishPausedByOperator
        ?? (hasProvenance ? false : Boolean(raw.publishPaused) && !legacySystemPause),
      publishBlockedByRuntime: Boolean(
        (raw.publishBlockedByRuntime
          ?? (hasProvenance ? false : Boolean(raw.publishPaused) && legacySystemPause))
        || invalidRuntimeJournal
      ),
      publishBlockedByPolicy: raw.publishBlockedByPolicy ?? false,
      publishRuntimeReasons: normalizedRuntimeReasons([
        ...(raw.publishRuntimeReasons || []),
        ...(invalidRuntimeJournal ? [RUNTIME_CONTROL_JOURNAL_INVALID_REASON] : []),
      ]),
      publishPolicyReasons: Array.isArray(raw.publishPolicyReasons)
        ? [...new Set(raw.publishPolicyReasons.map(String).filter(Boolean))].slice(0, 20)
        : [],
      runtimeControlApplications: retainedRuntimeControlApplications(runtimeJournal.valid),
      runtimeControlJournalInvalidCount: runtimeJournal.invalidEntries.length,
    };
    if (invalidRuntimeJournal) {
      status = 'STATE_CONFLICT';
      next = previous;
      return undefined;
    }
    const priorApplication = previous.runtimeControlApplications?.find(application =>
      application.evaluationId === input.evaluationId
      && application.operationType === 'RUNTIME_REASONS_CLEARED');
    if (priorApplication) {
      clearedReasons = [...priorApplication.reasons];
      status = 'CLEARED';
      next = previous;
      return undefined;
    }
    const currentReasons = [...(previous.publishRuntimeReasons || [])].sort();
    if (
      previous.changedAt !== input.expectedChangedAt
      || JSON.stringify(currentReasons) !== JSON.stringify(expectedReasons)
    ) {
      status = 'STATE_CONFLICT';
      next = previous;
      return undefined;
    }
    clearedReasons = requestedReasons.filter(reasonCode => currentReasons.includes(reasonCode));
    if (!clearedReasons.length) {
      status = 'NO_MATCH';
      next = previous;
      return undefined;
    }
    const remainingReasons = currentReasons.filter(reasonCode => !clearedReasons.includes(reasonCode));
    const now = new Date().toISOString();
    const application: NonNullable<AutomationControlState['runtimeControlApplications']>[number] = {
      schemaVersion: 1,
      evaluationId: input.evaluationId.slice(0, 240),
      operationType: 'RUNTIME_REASONS_CLEARED',
      actor: actor.slice(0, 200),
      reasons: clearedReasons,
      previousRuntimeReasons: currentReasons,
      nextRuntimeReasons: remainingReasons,
      previousEffectiveMode: previous.effectiveMode,
      nextEffectiveMode: previous.effectiveMode,
      appliedAt: now,
    };
    next = {
      ...previous,
      publishBlockedByRuntime: remainingReasons.length > 0,
      publishRuntimeReasons: remainingReasons,
      publishPaused: Boolean(
        previous.publishPausedByOperator
        || previous.publishBlockedByPolicy
        || remainingReasons.length > 0
      ),
      degradedReason: remainingReasons.length ? remainingReasons.join(',') : undefined,
      reason: input.reason,
      changedAt: now,
      changedBy: actor,
      updatedAt: now,
      runtimeControlApplications: persistedRuntimeControlApplications(
        raw.runtimeControlApplications,
        [...(previous.runtimeControlApplications || []), application],
      ),
    };
    status = 'CLEARED';
    return [next];
  });
  if ((status as ClearRuntimePublishReasonsResult['status']) === 'CLEARED') {
    await flushRuntimeControlApplicationAudits();
    next = await getAutomationControl();
  }
  return { control: next, clearedReasons, status };
}

export interface CreateAutomationJobInput {
  type: AutomationJobType;
  payload?: Record<string, unknown>;
  priority?: number;
  idempotencyKey: string;
  correlationId?: string;
  operationId?: string;
  requestedBy: string;
  riskLevel?: AutomationRiskLevel;
  dryRun?: boolean;
  maxAttempts?: number;
  scheduledAt?: string;
  approvalReason?: string;
  parentJobId?: string;
  botId?: string;
  capability?: string;
  requestedExecutionMode?: RequestedExecutionMode;
  executionPlan?: AutomationExecutionPlanStep[];
}

const RISK_RANK: Record<AutomationRiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, BLOCKER: 3 };

function effectiveRisk(defaultRisk: AutomationRiskLevel, requested?: AutomationRiskLevel): AutomationRiskLevel {
  if (!requested || RISK_RANK[requested] <= RISK_RANK[defaultRisk]) return defaultRisk;
  return requested;
}

export interface AutomationJobContractValidation {
  valid: boolean;
  code?: 'AUTOMATION_JOB_SCHEMA_UNSUPPORTED' | 'AUTOMATION_JOB_TYPE_UNSUPPORTED' | 'STALE_POLICY_SNAPSHOT' | 'STALE_HANDLER_VERSION' | 'SCHEMA_VALIDATION_FAILED';
  reasons: string[];
}

export class AutomationJobEnqueueError extends Error {
  readonly code: string;
  readonly reasons: string[];

  constructor(code: string, reasons: string[] = []) {
    super(reasons.length ? `${code}:${reasons.join('|')}` : code);
    this.name = 'AutomationJobEnqueueError';
    this.code = code;
    this.reasons = [...reasons];
  }
}

function rejectAutomationJob(code: string, reasons: string[] = []): never {
  throw new AutomationJobEnqueueError(code, reasons);
}

export function validateAutomationJobContract(
  job: Partial<AutomationJob>,
  options: { requireFactoryMetadata?: boolean } = {},
): AutomationJobContractValidation {
  if (job.schemaVersion !== AUTOMATION_JOB_SCHEMA_VERSION) {
    return { valid: false, code: 'AUTOMATION_JOB_SCHEMA_UNSUPPORTED', reasons: [`schemaVersion must be ${AUTOMATION_JOB_SCHEMA_VERSION}`] };
  }
  let policy;
  try {
    policy = getAutomationPolicy(job.type as AutomationJobType);
  } catch {
    return { valid: false, code: 'AUTOMATION_JOB_TYPE_UNSUPPORTED', reasons: ['job type is not registered'] };
  }
  if (job.policyVersion !== policy.policyVersion) return { valid: false, code: 'STALE_POLICY_SNAPSHOT', reasons: ['policyVersion does not match the current registry'] };
  if (job.handlerVersion !== policy.handlerVersion) return { valid: false, code: 'STALE_HANDLER_VERSION', reasons: ['handlerVersion does not match the current registry'] };
  const reasons: string[] = [];
  if (typeof job.id !== 'string' || !job.id.trim()) reasons.push('id is required');
  if (typeof job.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(job.idempotencyKey)) reasons.push('idempotencyKey is invalid');
  if (typeof job.operationId !== 'string' || !job.operationId.trim()) reasons.push('operationId is required');
  if (typeof job.requestedBy !== 'string' || !job.requestedBy.trim()) reasons.push('requestedBy is required');
  if (!job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) reasons.push('payload must be an object');
  if (job.botId !== policy.botId) reasons.push('botId does not match policy');
  if (typeof job.capability !== 'string' || !job.capability.trim()) reasons.push('capability is required');
  if (!job.riskLevel || !(job.riskLevel in RISK_RANK) || RISK_RANK[job.riskLevel] < RISK_RANK[policy.defaultRisk]) reasons.push('riskLevel understates policy');
  if (job.maxAttempts !== policy.retryPolicy.maxAttempts) reasons.push('maxAttempts does not match policy');
  if (!['AUTO', 'API_ONLY', 'LOCAL_ONLY', 'MANUAL_ONLY'].includes(String(job.requestedExecutionMode || ''))) reasons.push('requestedExecutionMode is invalid');
  if (!Number.isFinite(Date.parse(job.scheduledAt || ''))) reasons.push('scheduledAt is invalid');
  if (!Number.isFinite(Date.parse(job.createdAt || ''))) reasons.push('createdAt is invalid');
  if (!Number.isFinite(Date.parse(job.updatedAt || ''))) reasons.push('updatedAt is invalid');
  if (options.requireFactoryMetadata) {
    if (typeof job.correlationId !== 'string' || !job.correlationId.trim()) reasons.push('correlationId is required');
    if (!job.sourceMetadata || job.sourceMetadata.producer !== job.requestedBy) reasons.push('sourceMetadata producer is invalid');
    if (!Array.isArray(job.executionPlan) || !job.executionPlan.length) reasons.push('executionPlan is required');
  }
  return reasons.length
    ? { valid: false, code: 'SCHEMA_VALIDATION_FAILED', reasons }
    : { valid: true, reasons: [] };
}

export function assertAutomationJobContract(
  job: Partial<AutomationJob>,
  options: { requireFactoryMetadata?: boolean } = {},
): void {
  const validation = validateAutomationJobContract(job, options);
  if (!validation.valid) rejectAutomationJob(validation.code || 'SCHEMA_VALIDATION_FAILED', validation.reasons);
}

export function createAutomationJobRecord(input: CreateAutomationJobInput, nowMs = Date.now()): AutomationJob {
  const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) rejectAutomationJob('INVALID_IDEMPOTENCY_KEY', ['idempotencyKey must be 8-160 safe characters']);
  const requestedBy = typeof input.requestedBy === 'string' ? input.requestedBy.trim().slice(0, 160) : '';
  if (!requestedBy) rejectAutomationJob('AUTOMATION_JOB_REQUESTED_BY_REQUIRED', ['requestedBy is required']);
  const payload = sanitizeAutomationData(input.payload || {}) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) rejectAutomationJob('PAYLOAD_TOO_LARGE', [`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`]);
  let jobPolicy;
  try {
    jobPolicy = getAutomationPolicy(input.type);
  } catch {
    rejectAutomationJob('AUTOMATION_JOB_TYPE_UNSUPPORTED', ['job type is not registered']);
  }
  const risk = effectiveRisk(jobPolicy.defaultRisk, input.riskLevel);
  const registryDefaults = getJobRegistryDefaults(input.type, payload);
  const capability = typeof input.capability === 'string' && input.capability.trim()
    ? input.capability.trim().slice(0, 160)
    : jobPolicy.capability;
  const now = new Date(nowMs).toISOString();
  const approvalStatus: ApprovalStatus = approvalStatusForPolicy(jobPolicy, risk);
  const status: AutomationJobStatus = initialStatusForPolicy(jobPolicy, risk);
  const requestedPlan = input.executionPlan?.length ? input.executionPlan : input.type === 'AUTO_PILOT' ? buildAutoPilotExecutionPlan() : [{
    id: capability.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'execute-job',
    capability,
    dependsOn: [],
    reason: 'Thực thi capability đã đăng ký qua durable worker hiện có.',
    status: 'PENDING' as const,
    risk,
    approvalRequired: approvalStatus === 'PENDING',
    expectedWrite: registryDefaults.writeScope,
    externalCall: registryDefaults.externalSideEffect,
    fallback: registryDefaults.fallback,
  }];
  const executionPlan = (sanitizeAutomationData(requestedPlan) as AutomationExecutionPlanStep[]).slice(0, 30).map(step => ({
    ...step,
    risk: RISK_RANK[step.risk] > RISK_RANK[risk] ? step.risk : risk,
    approvalRequired: approvalStatus === 'PENDING',
    expectedWrite: [...jobPolicy.writeScope],
    externalCall: jobPolicy.externalSideEffect,
    fallback: [...jobPolicy.fallbackPolicy],
  }));
  const inputHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const operationId = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId.trim().slice(0, 160) : generateId();
  const correlationId = typeof input.correlationId === 'string' && input.correlationId.trim() ? input.correlationId.trim().slice(0, 160) : operationId;
  const execution = getAutomationExecutionDescriptor({ type: input.type, payload, operationId });
  const source = typeof payload.source === 'string' ? payload.source.slice(0, 100) : undefined;
  const trigger = typeof payload.trigger === 'string' ? payload.trigger.slice(0, 100) : undefined;
  const releaseId = getReleaseIdentity().releaseId;
  const pickupRollout = getFeatureRolloutState('SLO_RUNNABLE_AT_V2');
  const job: AutomationJob = {
    schemaVersion: AUTOMATION_JOB_SCHEMA_VERSION, policyVersion: jobPolicy.policyVersion, handlerVersion: jobPolicy.handlerVersion,
    projectionSourceVersion: 1,
    id: generateId(), correlationId, type: input.type, status, payload,
    priority: Math.max(0, Math.min(100, input.priority ?? 50)), idempotencyKey: key, operationId, requestedBy,
    sourceMetadata: { producer: requestedBy, source, trigger },
    releaseId,
    rolloutCohort: `SLO_RUNNABLE_AT_V2:${pickupRollout.mode}`,
    parentJobId: input.parentJobId,
    botId: jobPolicy.botId,
    capability,
    requestedExecutionMode: input.requestedExecutionMode || registryDefaults.requestedExecutionMode,
    executionPlan,
    progress: { processed: 0, total: executionPlan.length || undefined, succeeded: 0, skipped: 0, failed: 0, updatedAt: now },
    checkpoint: { version: 1, completedSteps: [], pendingSteps: executionPlan.map(step => step.id), outputs: {}, executionModes: [], inputHash, updatedAt: now },
    approvalStatus, approvalReason: input.approvalReason, approvalExpiresAt: approvalStatus === 'PENDING' ? new Date(nowMs + 24 * 60 * 60_000).toISOString() : undefined,
    riskLevel: risk, dryRun: input.dryRun === true, attemptCount: 0,
    executionCritical: execution.critical,
    maxAttempts: jobPolicy.retryPolicy.maxAttempts,
    queuedAt: now,
    scheduledAt: input.scheduledAt && Number.isFinite(Date.parse(input.scheduledAt)) ? input.scheduledAt : now,
    createdAt: now, updatedAt: now,
  };
  assertAutomationJobContract(job, { requireFactoryMetadata: true });
  return job;
}

async function auditRejectedAutomationJob(input: CreateAutomationJobInput, error: unknown): Promise<void> {
  const operationId = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId.trim() : generateId();
  const correlationId = typeof input.correlationId === 'string' && input.correlationId.trim() ? input.correlationId.trim() : operationId;
  const actor = typeof input.requestedBy === 'string' && input.requestedBy.trim() ? input.requestedBy.trim() : 'unknown-producer';
  try {
    await appendAutomationAudit({
      correlationId,
      operationId,
      operationType: 'JOB_ENQUEUE_REJECTED',
      actor,
      target: String(input.type || 'unknown-job-type'),
      nextState: 'REJECTED_BEFORE_PERSIST',
      risk: 'BLOCKER',
      reasons: [error instanceof Error ? error.message : String(error)],
      dryRun: input.dryRun === true,
      attempts: 0,
    });
  } catch (auditError) {
    console.error(JSON.stringify({
      type: 'automation_job_enqueue_audit_failed',
      code: auditError instanceof Error ? auditError.message : 'unknown_error',
    }));
  }
}

export async function createAutomationJob(input: CreateAutomationJobInput): Promise<{ job: AutomationJob; created: boolean; code: 'CREATED' | 'ALREADY_PROCESSED' | 'IN_PROGRESS' }> {
  let job: AutomationJob;
  try {
    job = createAutomationJobRecord(input);
    assertAutomationJobContract(job, { requireFactoryMetadata: true });
  } catch (error) {
    await auditRejectedAutomationJob(input, error);
    throw error;
  }
  const reservationKey = productProcessingReservationKey(job);
  let quotaReserved = false;
  if (job.type === 'PROCESS_CANDIDATE') {
    const settings = await getAutomationSettings();
    const reservation = await reserveProductProcessingCapacity(reservationKey, 1, settings.maxItemsPerDay);
    if (!reservation.allowed && !reservation.alreadyProcessed) {
      const error = new AutomationJobEnqueueError('DAILY_PRODUCT_LIMIT_REACHED', ['No product-processing capacity remains for the Vietnam business day.']);
      await auditRejectedAutomationJob(input, error);
      throw error;
    }
    quotaReserved = !reservation.alreadyProcessed;
  }
  let response!: { job: AutomationJob; created: boolean; code: 'CREATED' | 'ALREADY_PROCESSED' | 'IN_PROGRESS' };
  const projectionMutation = await beginAutomationJobProjectionMutation();
  try {
    await runTransaction<AutomationJob>(JOBS, items => {
      const sameKey = items
        .filter(item => item.type === input.type && item.idempotencyKey === job.idempotencyKey)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      const existing = sameKey.find(item => ACTIVE_SCAN_STATUSES.has(item.status))
        || sameKey.find(item => item.status === 'SUCCEEDED');
      if (existing) {
        response = { job: existing, created: false, code: existing.status === 'SUCCEEDED' ? 'ALREADY_PROCESSED' : 'IN_PROGRESS' };
        return undefined;
      }
      const equivalentActive = items.find(item => isEquivalentActiveScan(item, job));
      if (equivalentActive) {
        response = { job: equivalentActive, created: false, code: 'IN_PROGRESS' };
        return undefined;
      }
      items.push(job);
      response = { job, created: true, code: 'CREATED' };
      return items;
    });
  } catch (error) {
    await abortAutomationJobProjectionMutation(projectionMutation).catch(() => undefined);
    if (quotaReserved) await releaseProductProcessingCapacity(reservationKey);
    throw error;
  }
  if (!response.created && ['FAILED', 'CANCELLED', 'BLOCKED'].includes(response.job.status)) {
    await releaseProductProcessingCapacity(reservationKey);
  }
  if (response.created) {
    try {
      await appendAutomationAudit({ correlationId: response.job.correlationId || response.job.operationId, operationId: response.job.operationId, jobId: response.job.id,
        operationType: response.job.type, actor: response.job.requestedBy, nextState: response.job.status, risk: response.job.riskLevel,
        reasons: input.approvalReason ? [input.approvalReason] : [], dryRun: response.job.dryRun, attempts: 0 });
    } catch (error) {
      console.error(JSON.stringify({ type: 'automation_job_created_audit_failed', jobId: response.job.id, reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'unknown_error') }));
    }
  }
  if (response.created) await syncJobReadModelsBestEffort(response.job, false, projectionMutation);
  else await abortAutomationJobProjectionMutation(projectionMutation);
  logAutomationJobEvent(response.created ? 'job_created' : 'job_reused', response.job, {
    workerId: response.created ? response.job.requestedBy : response.job.claimedBy,
    reasonCode: response.created ? 'CREATED' : response.code === 'ALREADY_PROCESSED' ? 'COMPLETED_RECENTLY' : 'REUSED_ACTIVE_JOB',
  });
  return response;
}

const ACTIVE_SCAN_STATUSES = new Set<AutomationJobStatus>([
  'PENDING',
  'WAITING_APPROVAL',
  'WAITING_FOR_MANUAL_INPUT',
  'WAITING_CHILDREN',
  'RUNNING',
  'RETRY_SCHEDULED',
  'PAUSED',
]);

function payloadProductIds(payload: Record<string, unknown>): Set<string> {
  if (!Array.isArray(payload.productIds)) return new Set();
  return new Set(payload.productIds.map(value => String(value || '').trim()).filter(Boolean));
}

/** Prevent overlapping health/source scans even when callers use different time-based keys. */
export function isEquivalentActiveScan(existing: AutomationJob, requested: AutomationJob): boolean {
  if (!ACTIVE_SCAN_STATUSES.has(existing.status) || existing.dryRun !== requested.dryRun) return false;
  if (existing.type === 'PRODUCT_SCAN' && requested.type === 'PRODUCT_SCAN') return true;
  if (existing.type !== 'RECHECK_PRODUCT_HEALTH' || requested.type !== 'RECHECK_PRODUCT_HEALTH') return false;
  const existingIds = payloadProductIds(existing.payload);
  const requestedIds = payloadProductIds(requested.payload);
  if (!existingIds.size || !requestedIds.size) return true;
  return [...requestedIds].some(id => existingIds.has(id));
}

export async function getAutomationJob(id: string): Promise<AutomationJob | null> {
  const page = await readCollectionPage<AutomationJob>(JOBS, {
    page: 1,
    pageSize: 1,
    filters: { id },
  });
  return page.items[0] || null;
}

/** Lightweight status read for browser polling; falls back once for legacy jobs. */
export async function getAutomationJobProjection(id: string): Promise<AutomationJob | null> {
  const activeProjection = await getAutomationJobActiveProjectionStorage();
  const page = await readCollectionPage<AutomationJob>(activeProjection.collections.status, {
    page: 1,
    pageSize: 1,
    filters: { id },
  });
  const projection = page.items[0] || null;
  if (projection) {
    if (TERMINAL.has(projection.status)) {
      projectionReconcileTimes.delete(id);
      return projection;
    }
    const nowMs = Date.now();
    const heartbeat = (await readCollection<AutomationJobHeartbeat>(JOB_HEARTBEATS)).find(item => item.jobId === id);
    const matchingActiveHeartbeat = Boolean(heartbeat
      && heartbeat.workerId === projection.claimedBy
      && (!projection.claimToken || heartbeat.claimToken === projection.claimToken)
      && Date.parse(heartbeat.leaseExpiresAt) > nowMs);
    const projectionAge = nowMs - Date.parse(projection.updatedAt || projection.createdAt);
    const statusContradictsHeartbeat = projection.status === 'RUNNING'
      ? !matchingActiveHeartbeat
      : matchingActiveHeartbeat;
    const periodicReconcileDue = !Number.isFinite(projectionAge) || projectionAge >= PROJECTION_RECONCILE_AFTER_MS;
    if (!statusContradictsHeartbeat && !periodicReconcileDue) {
      return projection;
    }
    const lastReconcileAt = projectionReconcileTimes.get(id) || 0;
    if (!statusContradictsHeartbeat && nowMs - lastReconcileAt < PROJECTION_RECONCILE_AFTER_MS) return projection;
    projectionReconcileTimes.set(id, nowMs);
    if (projectionReconcileTimes.size > 2_000) {
      for (const [jobId, checkedAt] of projectionReconcileTimes) {
        if (nowMs - checkedAt >= PROJECTION_RECONCILE_AFTER_MS) projectionReconcileTimes.delete(jobId);
      }
    }
    const durable = await getAutomationJob(id);
    if (!durable) return projection;
    const reconciled = durable.status === 'RUNNING' && heartbeat
      && heartbeat.workerId === durable.claimedBy
      && (!durable.claimToken || heartbeat.claimToken === durable.claimToken)
      ? { ...durable, heartbeatAt: heartbeat.heartbeatAt, leaseExpiresAt: heartbeat.leaseExpiresAt }
      : durable;
    await syncJobReadModelsBestEffort(reconciled);
    return reconciled;
  }
  const job = await getAutomationJob(id);
  if (job) await syncJobReadModelsBestEffort(job);
  return job;
}

/**
 * EXPENSIVE FULL-HISTORY READ.
 *
 * Reserved for explicit maintenance, recovery, compaction, and historical
 * analysis. Interactive health, dashboard, queue-summary, and guardian paths
 * must use compact projections or getAutomationJobHealthView().
 */
export async function getAllAutomationJobs(): Promise<AutomationJob[]> {
  return readCollection<AutomationJob>(JOBS);
}

export async function listAutomationJobs(options: { status?: AutomationJobStatus; type?: AutomationJobType; page: number; pageSize: number }) {
  const projection = await readBoundedAutomationJobProjections();
  const filtered = projection.items
    .filter(item => !options.status || item.status === options.status)
    .filter(item => !options.type || item.type === options.type)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / options.pageSize));
  const start = (options.page - 1) * options.pageSize;
  return {
    items: filtered.slice(start, start + options.pageSize).map(publicAutomationJobListItem),
    pagination: { page: options.page, pageSize: options.pageSize, totalItems, totalPages },
    dataAccess: {
      queryCount: 1,
      source: 'compact-read-model' as const,
      availability: projection.availability,
      reasonCodes: projection.reasonCodes,
      coverageComplete: projection.coverageComplete,
      evidenceClassification: projection.evidenceClassification,
      currentStateComplete: projection.currentStateComplete,
      historyComplete: projection.historyComplete,
      truncated: projection.truncated,
      collectionPresent: projection.collectionPresent,
      observedRange: projection.observedRange,
      retentionBoundary: projection.retentionBoundary,
      totalSemantics: 'BOUNDED_RETAINED_HISTORY' as const,
    },
  };
}

export function publicAutomationJobListItem(job: AutomationJobListProjection): AutomationJobListItem {
  const {
    projectionSchemaVersion: _projectionSchemaVersion,
    claimedAt: _claimedAt,
    runnableAt: _runnableAt,
    runnableReason: _runnableReason,
    executionCritical: _executionCritical,
    resourceProductIds: _resourceProductIds,
    resourceCandidateId: _resourceCandidateId,
    resourceDraftId: _resourceDraftId,
    claimedBy: _claimedBy,
    claimToken: _claimToken,
    workerInstanceId: _workerInstanceId,
    workerFencingToken: _workerFencingToken,
    leaseExpiresAt: _leaseExpiresAt,
    heartbeatAt: _heartbeatAt,
    ...safe
  } = job;
  void _claimedBy;
  void _projectionSchemaVersion;
  void _claimedAt;
  void _runnableAt;
  void _runnableReason;
  void _executionCritical;
  void _resourceProductIds;
  void _resourceCandidateId;
  void _resourceDraftId;
  void _claimToken;
  void _workerInstanceId;
  void _workerFencingToken;
  void _leaseExpiresAt;
  void _heartbeatAt;
  return safe;
}

export function publicAutomationJob(job: AutomationJob) {
  const {
    payload: _payload,
    claimToken: _claimToken,
    idempotencyKey: _idempotencyKey,
    ...safe
  } = job;
  void _payload;
  void _claimToken;
  void _idempotencyKey;
  return {
    ...safe,
    queuedAt: job.queuedAt || job.scheduledAt,
    sourceMetadata: sanitizeAutomationData(job.sourceMetadata),
    executionPlan: sanitizeAutomationData(job.executionPlan) as AutomationExecutionPlanStep[] | undefined,
    approvalReason: shortReason(job.approvalReason),
    lastErrorMessage: shortReason(job.lastErrorMessage),
    deadLetterReason: shortReason(job.deadLetterReason),
    result: sanitizeAutomationData(job.result),
    checkpoint: job.checkpoint ? {
      ...job.checkpoint,
      outputs: sanitizeAutomationData(job.checkpoint.outputs) as Record<string, unknown>,
      providerStatus: sanitizeAutomationData(job.checkpoint.providerStatus) as Record<string, unknown> | undefined,
    } : undefined,
    disclosure: sanitizeAutomationData(job.disclosure) as AutomationExecutionDisclosure | undefined,
  };
}

function retryDelayMs(type: AutomationJobType, attempt: number): number {
  const retry = getAutomationPolicy(type).retryPolicy;
  const base = Math.min(retry.maximumDelayMs, retry.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * Math.max(250, base * 0.15));
}

function defaultErrorCategory(code: string): AutomationErrorCategory {
  if (code === 'PROVIDER_TIMEOUT' || /TIMEOUT|NETWORK|UNAVAILABLE|TEMPORARY|LEASE_EXPIRED/.test(code)) return 'PROVIDER_TIMEOUT';
  if (code === 'PROVIDER_RATE_LIMIT' || /RATE|QUOTA/.test(code)) return 'PROVIDER_RATE_LIMIT';
  if (code === 'IMAGE_HOTLINK_BLOCKED') return 'IMAGE_HOTLINK_BLOCKED';
  if (code === 'LINK_NOT_FOUND') return 'LINK_NOT_FOUND';
  if (code === 'DUPLICATE') return 'DUPLICATE';
  if (code === 'STORAGE_ERROR' || /STORAGE|LOCK/.test(code)) return 'STORAGE_ERROR';
  if (code === 'INVALID_SOURCE_DATA' || /CREDENTIAL|SOURCE/.test(code)) return 'INVALID_SOURCE_DATA';
  if (code === 'VALIDATION_FAILED' || /VALIDATION|SCHEMA|SAFETY|POLICY|APPROVAL|KILL/.test(code)) return 'VALIDATION_FAILED';
  if (code === 'UNKNOWN_ERROR') return 'UNKNOWN_ERROR';
  return 'INTERNAL_CODE_ERROR';
}

export function isRetryableAutomationError(code: string, type?: AutomationJobType): boolean {
  if (type) return getAutomationPolicy(type).retryPolicy.retryableCodes.includes(code);
  return listPolicyRetryCodes().has(code);
}

function listPolicyRetryCodes(): Set<string> {
  return new Set(listAutomationPolicies().flatMap(policy => policy.retryPolicy.retryableCodes));
}

type ExecutionUpdate = Pick<AutomationJob, 'executionMode' | 'outcomeStatus' | 'executionPlan' | 'progress' | 'checkpoint' | 'disclosure' | 'manualTaskId'>;

export interface AutomationJobClaimGuard {
  claimToken: string;
  ownership?: RuntimeRoleOwnership;
}

function activeClaimMatches(
  job: AutomationJob,
  workerId: string,
  guard: AutomationJobClaimGuard,
): boolean {
  return job.status === 'RUNNING'
    && job.claimedBy === workerId
    && Boolean(guard.claimToken)
    && job.claimToken === guard.claimToken
    && (
      !guard.ownership
      || (
        job.workerInstanceId === guard.ownership.instanceId
        && job.workerFencingToken === guard.ownership.fencingToken
      )
    );
}

async function assertClaimGuardOwnership(guard: AutomationJobClaimGuard): Promise<void> {
  if (guard.ownership && !await isRuntimeRoleOwner('WORKER', guard.ownership)) {
    throw new Error('WORKER_FENCING_REJECTED');
  }
}

function clearAutomationJobClaim(job: AutomationJob): void {
  job.claimedBy = undefined;
  job.claimToken = undefined;
  job.workerOwnerId = undefined;
  job.workerInstanceId = undefined;
  job.workerFencingToken = undefined;
  job.leaseExpiresAt = undefined;
}

function markAutomationJobProjectionSourceMutation(job: AutomationJob): void {
  job.projectionSourceVersion = Math.max(0, Math.floor(job.projectionSourceVersion || 0)) + 1;
}

async function runAutomationJobSourceTransaction(
  work: StorageTransaction<AutomationJob>,
): Promise<AutomationJobProjectionMutationHandle> {
  const mutation = await beginAutomationJobProjectionMutation();
  try {
    await runTransaction<AutomationJob>(JOBS, async items => {
      const previous = new Map(items.map(item => [item.id, {
        updatedAt: item.updatedAt,
        version: Math.max(0, Math.floor(item.projectionSourceVersion || 0)),
      }]));
      const result = await work(items);
      if (!result) return undefined;
      const assignedVersions: Record<string, number> = {};
      for (const item of result) {
        const prior = previous.get(item.id);
        const currentVersion = Math.max(0, Math.floor(item.projectionSourceVersion || 0));
        if (prior && prior.updatedAt === item.updatedAt && prior.version === currentVersion) continue;
        const nextVersion = Math.max(currentVersion, (prior?.version || 0) + 1);
        item.projectionSourceVersion = nextVersion;
        assignedVersions[item.id] = nextVersion;
      }
      mutation.jobSourceVersions = assignedVersions;
      return result;
    });
    return mutation;
  } catch (error) {
    await abortAutomationJobProjectionMutation(mutation).catch(() => undefined);
    throw error;
  }
}

export async function updateAutomationJobExecution(
  id: string,
  workerId: string,
  patch: Partial<ExecutionUpdate>,
  guard: AutomationJobClaimGuard,
): Promise<AutomationJob | null> {
  await assertClaimGuardOwnership(guard);
  let updated: AutomationJob | null = null;
  const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || !activeClaimMatches(job, workerId, guard)) return undefined;
    if (patch.executionMode) job.executionMode = patch.executionMode;
    if (patch.outcomeStatus) job.outcomeStatus = patch.outcomeStatus;
    if (patch.executionPlan) job.executionPlan = sanitizeAutomationData(patch.executionPlan) as AutomationExecutionPlanStep[];
    if (patch.progress) job.progress = sanitizeAutomationData({ ...patch.progress, updatedAt: now }) as AutomationJob['progress'];
    if (patch.checkpoint) job.checkpoint = sanitizeAutomationData({ ...patch.checkpoint, updatedAt: now }) as AutomationCheckpoint;
    if (patch.disclosure) job.disclosure = sanitizeAutomationData(patch.disclosure) as AutomationExecutionDisclosure;
    if (patch.manualTaskId) job.manualTaskId = patch.manualTaskId;
    job.updatedAt = now;
    markAutomationJobProjectionSourceMutation(job);
    updated = { ...job };
    return items;
  });
  const updatedJob = updated as AutomationJob | null;
  if (updatedJob) await syncJobReadModelsBestEffort(updatedJob, false, projectionMutation);
  else await abortAutomationJobProjectionMutation(projectionMutation);
  return updatedJob;
}

export async function waitAutomationJobForManual(
  id: string,
  workerId: string,
  taskId: string,
  checkpoint: AutomationCheckpoint,
  disclosure: AutomationExecutionDisclosure,
  guard: AutomationJobClaimGuard,
): Promise<AutomationJob | null> {
  await assertClaimGuardOwnership(guard);
  let waiting: AutomationJob | null = null;
  const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || !activeClaimMatches(job, workerId, guard)) return undefined;
    job.status = 'WAITING_FOR_MANUAL_INPUT';
    job.manualTaskId = taskId;
    job.outcomeStatus = 'WAITING_FOR_MANUAL_INPUT';
    job.executionMode = 'MANUAL_INPUT';
    job.checkpoint = sanitizeAutomationData({ ...checkpoint, updatedAt: now }) as AutomationCheckpoint;
    job.disclosure = sanitizeAutomationData(disclosure) as AutomationExecutionDisclosure;
    clearAutomationJobClaim(job);
    job.heartbeatAt = now;
    job.updatedAt = now;
    markAutomationJobProjectionSourceMutation(job);
    waiting = { ...job };
    return items;
  });
  const waitingJob = waiting as AutomationJob | null;
  if (waitingJob) await syncJobReadModelsBestEffort(waitingJob, true, projectionMutation);
  else await abortAutomationJobProjectionMutation(projectionMutation);
  if (waitingJob) await appendAutomationAudit({
    correlationId: waitingJob.operationId,
    operationId: waitingJob.operationId,
    jobId: waitingJob.id,
    operationType: 'JOB_WAITING_MANUAL_INPUT',
    actor: workerId,
    previousState: 'RUNNING',
    nextState: 'WAITING_FOR_MANUAL_INPUT',
    risk: waitingJob.riskLevel,
    reasons: [disclosure.fallbackReason || 'MANUAL_INPUT_REQUIRED'],
    dryRun: waitingJob.dryRun,
    attempts: waitingJob.attemptCount,
  });
  return waitingJob;
}

export async function waitAutomationJobForChildren(
  id: string,
  workerId: string,
  result: Record<string, unknown>,
  guard: AutomationJobClaimGuard,
): Promise<AutomationJob | null> {
  await assertClaimGuardOwnership(guard);
  let waiting: AutomationJob | null = null;
  const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || !activeClaimMatches(job, workerId, guard) || !job.checkpoint?.pendingSteps.length) return undefined;
    job.status = 'WAITING_CHILDREN';
    job.result = sanitizeAutomationData(result) as Record<string, unknown>;
    clearAutomationJobClaim(job);
    job.heartbeatAt = now;
    job.updatedAt = now;
    markAutomationJobProjectionSourceMutation(job);
    waiting = { ...job };
    return items;
  });
  const waitingJob = waiting as AutomationJob | null;
  if (waitingJob) await syncJobReadModelsBestEffort(waitingJob, true, projectionMutation);
  else await abortAutomationJobProjectionMutation(projectionMutation);
  if (waitingJob) await appendAutomationAudit({
    correlationId: waitingJob.operationId,
    operationId: waitingJob.operationId,
    jobId: waitingJob.id,
    operationType: 'JOB_WAITING_CHILDREN',
    actor: workerId,
    previousState: 'RUNNING',
    nextState: 'WAITING_CHILDREN',
    risk: waitingJob.riskLevel,
    reasons: ['Durable child jobs must reach a terminal state before the parent can complete.'],
    dryRun: waitingJob.dryRun,
    attempts: waitingJob.attemptCount,
  });
  return waitingJob;
}

export async function completeAutomationParentJob(
  id: string,
  actor: string,
  childSummary: Record<string, unknown>,
): Promise<AutomationJob | null> {
  let completed: AutomationJob | null = null;
  const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'WAITING_CHILDREN') return undefined;
    const completedSteps = (job.executionPlan || []).map(step => step.id);
    job.status = 'SUCCEEDED';
    job.outcomeStatus = 'COMPLETED_WITH_LOCAL_RULES';
    job.executionPlan = (job.executionPlan || []).map(step => ({ ...step, status: 'COMPLETED' }));
    if (job.checkpoint) {
      job.checkpoint = {
        ...job.checkpoint,
        completedSteps,
        pendingSteps: [],
        outputs: { ...job.checkpoint.outputs, childSummary: sanitizeAutomationData(childSummary) },
        outputHash: createHash('sha256').update(JSON.stringify(childSummary)).digest('hex'),
        updatedAt: now,
      };
    }
    if (job.progress) {
      const total = job.progress.total || Math.max(1, completedSteps.length);
      job.progress = { ...job.progress, processed: total, succeeded: total, percentage: 100, updatedAt: now };
    }
    if (job.disclosure) {
      job.disclosure = { ...job.disclosure, status: 'COMPLETED_WITH_LOCAL_RULES', completedSteps, pendingSteps: [], completedAt: now };
    }
    job.result = sanitizeAutomationData({ ...job.result, executionStatus: 'COMPLETED_WITH_LOCAL_RULES', completedSteps, pendingSteps: [], childSummary }) as Record<string, unknown>;
    job.completedAt = now;
    job.updatedAt = now;
    markAutomationJobProjectionSourceMutation(job);
    completed = { ...job };
    return items;
  });
  const completedJob = completed as AutomationJob | null;
  if (completedJob) await syncJobReadModelsBestEffort(completedJob, false, projectionMutation);
  else await abortAutomationJobProjectionMutation(projectionMutation);
  if (completedJob) await appendAutomationAudit({
    correlationId: completedJob.operationId,
    operationId: completedJob.operationId,
    jobId: completedJob.id,
    operationType: 'PARENT_JOB_COMPLETED',
    actor,
    previousState: 'WAITING_CHILDREN',
    nextState: 'SUCCEEDED',
    risk: completedJob.riskLevel,
    result: childSummary,
    reasons: ['All descendant jobs reached terminal state.'],
    dryRun: completedJob.dryRun,
    attempts: completedJob.attemptCount,
  });
  return completedJob;
}

export async function resumeAutomationJobFromManual(id: string, actor: string, taskId: string): Promise<AutomationJob | null> {
  let resumed: AutomationJob | null = null;
  const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'WAITING_FOR_MANUAL_INPUT' || job.manualTaskId !== taskId) return undefined;
    job.status = 'PENDING';
    job.scheduledAt = now;
    job.claimedAt = undefined;
    job.claimedBy = undefined;
    job.leaseExpiresAt = undefined;
    job.updatedAt = now;
    markAutomationJobProjectionSourceMutation(job);
    resumed = { ...job };
    return items;
  });
  const resumedJob = resumed as AutomationJob | null;
  if (resumedJob) await syncJobReadModelsBestEffort(resumedJob, false, projectionMutation);
  else await abortAutomationJobProjectionMutation(projectionMutation);
  if (resumedJob) await appendAutomationAudit({
    correlationId: resumedJob.operationId,
    operationId: resumedJob.operationId,
    jobId: resumedJob.id,
    operationType: 'JOB_RESUMED_FROM_MANUAL_INPUT',
    actor,
    previousState: 'WAITING_FOR_MANUAL_INPUT',
    nextState: 'PENDING',
    risk: resumedJob.riskLevel,
    reasons: [],
    dryRun: resumedJob.dryRun,
    attempts: resumedJob.attemptCount,
  });
  return resumedJob;
}

function runnableCreatedAt(job: AutomationJob): number {
  const value = Date.parse(job.queuedAt || job.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function deriveJobRunnableContext(
  job: Pick<AutomationJob, 'createdAt' | 'scheduledAt'>,
  retryEligibleAt?: string,
): {
  runnableAt: string;
  runnableReason: AutomationJobAttempt['runnableReason'];
} {
  const retryAt = Date.parse(retryEligibleAt || '');
  if (Number.isFinite(retryAt)) {
    return {
      runnableAt: new Date(retryAt).toISOString(),
      runnableReason: 'RETRY_ELIGIBLE_AT',
    };
  }
  const createdAt = Date.parse(job.createdAt);
  const scheduledAt = Date.parse(job.scheduledAt);
  if (Number.isFinite(scheduledAt)
    && (!Number.isFinite(createdAt) || scheduledAt > createdAt)) {
    return {
      runnableAt: new Date(scheduledAt).toISOString(),
      runnableReason: 'SCHEDULED_AT',
    };
  }
  return {
    runnableAt: Number.isFinite(createdAt)
      ? new Date(createdAt).toISOString()
      : new Date(scheduledAt).toISOString(),
    runnableReason: 'CREATED_AT',
  };
}

/** Priority is respected for fresh work; overdue work gets a guaranteed FIFO slot. */
export function selectFairRunnableJobs(items: AutomationJob[], limit: number, nowMs = Date.now()): AutomationJob[] {
  const maximum = Math.max(0, Math.min(limit, 10));
  if (!maximum) return [];
  const priorityOrder = (left: AutomationJob, right: AutomationJob) =>
    right.priority - left.priority || runnableCreatedAt(left) - runnableCreatedAt(right);
  const due = [...items].sort(priorityOrder);
  const overdue = due
    .filter(item => nowMs - runnableCreatedAt(item) >= FAIRNESS_AFTER_MS)
    .sort((left, right) => runnableCreatedAt(left) - runnableCreatedAt(right));
  const selected: AutomationJob[] = overdue[0] ? [overdue[0]] : [];
  const selectedIds = new Set(selected.map(item => item.id));
  const selectedTypes = new Set(selected.map(item => item.type));
  const remaining = due.filter(item => !selectedIds.has(item.id));
  for (const item of remaining.filter(candidate => !selectedTypes.has(candidate.type))) {
    if (selected.length >= maximum) break;
    selected.push(item);
    selectedIds.add(item.id);
    selectedTypes.add(item.type);
  }
  for (const item of remaining) {
    if (selected.length >= maximum) break;
    if (!selectedIds.has(item.id)) selected.push(item);
  }
  return selected;
}

const notRunnableLogTimes = new Map<string, number>();

export async function claimAutomationJobs(
  workerId: string,
  limit = 1,
  leaseMs = 60_000,
  nowMs = Date.now(),
  ownership?: RuntimeRoleOwnership,
  options: {
    maximumInFlight?: number;
    criticalReservedCapacity?: number;
    enforceExecutionCompatibility?: boolean;
    claimLane?: AutomationWorkerClaimLane;
    preferCritical?: boolean;
  } = {},
): Promise<AutomationJob[]> {
  const control = await getAutomationControl();
  if (control.workerPaused) return [];
  if (ownership && !await isRuntimeRoleOwner('WORKER', ownership, nowMs)) throw new Error('WORKER_FENCING_REJECTED');
  const claimed: AutomationJob[] = [];
  const rejectedBeforeClaim: Array<{ job: AutomationJob; validation: AutomationJobContractValidation; previousStatus: AutomationJobStatus }> = [];
  const timedOut: AutomationJob[] = [];
  const requeued: AutomationJob[] = [];
  const projectionChanges: AutomationJob[] = [];
  const projectionChangedIds = new Set<string>();
  const now = new Date(nowMs).toISOString();
  const heartbeatItems = await readCollection<AutomationJobHeartbeat>(JOB_HEARTBEATS);
  const heartbeats = new Map(heartbeatItems.map(item => [item.jobId, item]));
  // Product capacity is reserved atomically at enqueue; claim must not parse the
  // large queue a second time merely to reserve the same key again.
  const candidateQuotaDenied = new Set<string>();
  let oldestNotRunnable: AutomationJob | undefined;
  let poolActiveSlots = 0;
  let poolAvailableSlots = 0;
  let claimBlockReason: 'WORKER_CAPACITY_FULL' | 'EXECUTION_RESOURCE_CONFLICT' | 'SCHEDULED_FOR_FUTURE' = 'SCHEDULED_FOR_FUTURE';
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    let changed = false;
    for (const item of items) {
      if (!TERMINAL.has(item.status)) {
        const validation = validateAutomationJobContract(item);
        if (!validation.valid) {
          const previousStatus = item.status;
          item.status = 'BLOCKED';
          item.lastErrorCode = validation.code || 'SCHEMA_VALIDATION_FAILED';
          item.lastErrorMessage = sanitizeErrorMessage(validation.reasons.join('; ') || 'Automation job contract is invalid.');
          item.claimedBy = undefined;
          item.claimedAt = undefined;
          item.claimToken = undefined;
          item.workerOwnerId = undefined;
          item.workerInstanceId = undefined;
          item.workerFencingToken = undefined;
          item.leaseExpiresAt = undefined;
          item.completedAt = now;
          item.updatedAt = now;
          markAutomationJobProjectionSourceMutation(item);
          rejectedBeforeClaim.push({ job: structuredClone(item), validation, previousStatus });
          projectionChangedIds.add(item.id);
          changed = true;
          continue;
        }
      }
      if (item.status === 'RUNNING') {
        const heartbeat = heartbeats.get(item.id);
        const heartbeatMatches = heartbeat
          && heartbeat.workerId === item.claimedBy
          && (!item.claimToken || heartbeat.claimToken === item.claimToken);
        const effectiveLease = heartbeatMatches ? heartbeat.leaseExpiresAt : item.leaseExpiresAt;
        if (effectiveLease && Date.parse(effectiveLease) <= nowMs) {
        item.status = item.attemptCount < item.maxAttempts ? 'RETRY_SCHEDULED' : 'FAILED';
        item.nextRetryAt = item.status === 'RETRY_SCHEDULED' ? new Date(nowMs + retryDelayMs(item.type, item.attemptCount)).toISOString() : undefined;
        item.runnableAt = item.nextRetryAt;
        item.runnableReason = item.nextRetryAt ? 'RETRY_ELIGIBLE_AT' : item.runnableReason;
        item.lastErrorCode = 'LEASE_EXPIRED'; item.lastErrorCategory = 'PROVIDER_TIMEOUT'; item.lastErrorMessage = 'Bộ xử lý mất tín hiệu trước khi hoàn tất.';
        item.retryable = item.status === 'RETRY_SCHEDULED'; item.deadLetterReason = item.retryable ? undefined : 'PROVIDER_TIMEOUT:LEASE_EXPIRED'; item.claimedBy = undefined; item.updatedAt = now;
        item.claimedAt = undefined; item.claimToken = undefined; item.workerOwnerId = undefined; item.workerInstanceId = undefined; item.workerFencingToken = undefined; item.leaseExpiresAt = undefined;
        markAutomationJobProjectionSourceMutation(item);
        if (item.status === 'FAILED') { item.completedAt = now; timedOut.push(structuredClone(item)); }
        else requeued.push(structuredClone(item));
        projectionChangedIds.add(item.id);
        changed = true;
        }
      }
      if (item.status === 'RETRY_SCHEDULED' && item.nextRetryAt && Date.parse(item.nextRetryAt) <= nowMs) {
        const retryEligibleAt = item.nextRetryAt;
        const runnable = deriveJobRunnableContext(item, retryEligibleAt);
        item.status = 'PENDING';
        item.scheduledAt = retryEligibleAt;
        item.nextRetryAt = undefined;
        item.runnableAt = runnable.runnableAt;
        item.runnableReason = runnable.runnableReason;
        markAutomationJobProjectionSourceMutation(item);
        projectionChangedIds.add(item.id);
        changed = true;
      }
      if (item.status === 'PENDING' && item.type === 'PROCESS_CANDIDATE' && candidateQuotaDenied.has(item.id)) {
        item.status = 'BLOCKED';
        item.lastErrorCode = 'DAILY_PRODUCT_LIMIT_REACHED';
        item.lastErrorCategory = 'VALIDATION_FAILED';
        item.lastErrorMessage = 'Đã đạt giới hạn sản phẩm xử lý trong ngày Việt Nam.';
        item.completedAt = now;
        item.updatedAt = now;
        markAutomationJobProjectionSourceMutation(item);
        projectionChangedIds.add(item.id);
        changed = true;
      }
    }
    const activeJobs = items.filter(item => item.status === 'RUNNING');
    poolActiveSlots = activeJobs.length;
    const maximumInFlight = Number.isInteger(options.maximumInFlight)
      ? Math.max(1, Number(options.maximumInFlight))
      : undefined;
    const reservedCriticalCapacity = maximumInFlight && maximumInFlight > 1
      ? Math.max(0, Math.min(maximumInFlight - 1, Math.floor(Number(options.criticalReservedCapacity) || 0)))
      : 0;
    const activeGuardianJobs = activeJobs.filter(item => item.type === 'RUNTIME_GUARDIAN').length;
    const activeNonGuardianJobs = activeJobs.length - activeGuardianJobs;
    const activeCriticalJobs = activeJobs.filter(item => isCriticalAutomationJob(item)).length;
    const activeNormalJobs = activeJobs.length - activeCriticalJobs;
    const totalAvailableCapacity = maximumInFlight === undefined
      ? limit
      : Math.max(0, maximumInFlight - activeJobs.length);
    const guardianCapacity = maximumInFlight === undefined
      ? limit
      : Math.max(
          0,
          (reservedCriticalCapacity || maximumInFlight) - activeGuardianJobs,
        );
    const nonGuardianCapacity = maximumInFlight === undefined
      ? limit
      : Math.max(
          0,
          maximumInFlight - reservedCriticalCapacity - activeNonGuardianJobs,
        );
    const criticalCapacity = maximumInFlight === undefined
      ? limit
      : Math.max(
          0,
          (reservedCriticalCapacity || maximumInFlight) - activeCriticalJobs,
        );
    const normalCapacity = maximumInFlight === undefined
      ? limit
      : Math.max(
          0,
          maximumInFlight - reservedCriticalCapacity - activeNormalJobs,
        );
    const claimLane = options.claimLane || 'ANY';
    const allCriticalLane = claimLane === 'CRITICAL' || claimLane === 'NON_CRITICAL';
    const laneAvailableCapacity = claimLane === 'RUNTIME_GUARDIAN'
      ? guardianCapacity
      : claimLane === 'NON_GUARDIAN'
        ? nonGuardianCapacity
        : claimLane === 'CRITICAL'
          ? criticalCapacity
          : claimLane === 'NON_CRITICAL'
            ? normalCapacity
            : guardianCapacity + nonGuardianCapacity;
    const availableCapacity = Math.max(
      0,
      Math.min(limit, totalAvailableCapacity, laneAvailableCapacity),
    );
    poolAvailableSlots = availableCapacity;
    const eligible = items.filter(item => item.status === 'PENDING' && Date.parse(item.scheduledAt) <= nowMs
      && (!control.killSwitch || item.type === 'RUNTIME_GUARDIAN')
      && isAutomationJobEligibleForClaimLane(item, claimLane));
    const due = options.enforceExecutionCompatibility
      ? selectCompatibleWorkerJobs(
          eligible,
          activeJobs,
          availableCapacity,
          nowMs,
          selectFairRunnableJobs,
          options.criticalReservedCapacity,
          allCriticalLane
            ? {
                critical: claimLane === 'NON_CRITICAL' ? 0 : criticalCapacity,
                normal: claimLane === 'CRITICAL' ? 0 : normalCapacity,
              }
            : {
                runtimeGuardian: claimLane === 'NON_GUARDIAN' ? 0 : guardianCapacity,
                nonGuardian: claimLane === 'RUNTIME_GUARDIAN' ? 0 : nonGuardianCapacity,
              },
          options.preferCritical === true,
        )
      : selectFairRunnableJobs(eligible, availableCapacity, nowMs);
    if (!due.length) {
      claimBlockReason = availableCapacity <= 0
        ? 'WORKER_CAPACITY_FULL'
        : eligible.length > 0 && options.enforceExecutionCompatibility
          ? 'EXECUTION_RESOURCE_CONFLICT'
          : 'SCHEDULED_FOR_FUTURE';
      oldestNotRunnable = items
        .filter(item => item.status === 'PENDING')
        .sort((left, right) => runnableCreatedAt(left) - runnableCreatedAt(right))[0];
    }
    for (const item of due) {
      const execution = getAutomationExecutionDescriptor(item);
      const runnable = item.runnableAt && item.runnableReason
        ? { runnableAt: item.runnableAt, runnableReason: item.runnableReason }
        : deriveJobRunnableContext(item);
      item.status = 'RUNNING'; item.claimedBy = workerId; item.claimedAt = now; item.heartbeatAt = now;
      item.claimToken = generateId(); item.workerOwnerId = ownership?.ownerId; item.workerInstanceId = ownership?.instanceId; item.workerFencingToken = ownership?.fencingToken;
      item.executionConcurrencyClass = execution.concurrencyClass;
      item.executionResourceKeys = execution.resourceKeys;
      item.executionExclusive = execution.exclusive;
      item.executionCritical = execution.critical;
      item.runnableAt = runnable.runnableAt;
      item.runnableReason = runnable.runnableReason;
      item.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString(); item.startedAt ||= now; item.attemptCount += 1; item.updatedAt = now;
      markAutomationJobProjectionSourceMutation(item);
      claimed.push(structuredClone(item));
      projectionChangedIds.add(item.id);
      changed = true;
    }
    projectionChanges.push(...items
      .filter(item => projectionChangedIds.has(item.id))
      .map(item => structuredClone(item)));
    return changed ? items : undefined;
  });
  if (claimed.length) {
    try {
      await runTransaction<AutomationJobAttempt>(JOB_ATTEMPTS, attempts => {
        const existingIds = new Set(attempts.map(attempt => attempt.id));
        for (const job of claimed) {
          const id = `${job.id}:attempt:${job.attemptCount}`;
          if (existingIds.has(id)) continue;
          attempts.push({
            schemaVersion: 1,
            id,
            jobId: job.id,
            jobType: job.type,
            operationId: job.operationId,
            attemptNumber: job.attemptCount,
            runnableAt: job.runnableAt!,
            runnableReason: job.runnableReason!,
            createdAt: job.createdAt,
            scheduledAt: job.scheduledAt,
            retryEligibleAt: job.runnableReason === 'RETRY_ELIGIBLE_AT' ? job.runnableAt : undefined,
            claimedAt: job.claimedAt!,
            claimTokenHash: createHash('sha256').update(job.claimToken || '').digest('hex'),
            workerId,
            workerFencingToken: job.workerFencingToken,
            releaseId: job.releaseId || getReleaseIdentity().releaseId,
            rolloutCohort: job.rolloutCohort
              || `SLO_RUNNABLE_AT_V2:${getFeatureRolloutState('SLO_RUNNABLE_AT_V2').mode}`,
            priorityClass: isCriticalAutomationJob(job) ? 'CRITICAL' : 'NORMAL',
            priority: job.priority,
          });
          existingIds.add(id);
        }
        return attempts.slice(-10_000);
      });
    } catch (error) {
      console.error(JSON.stringify({
        type: 'automation_job_attempt_persistence_failed',
        claimedJobs: claimed.length,
        reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'UNKNOWN_ERROR'),
      }));
    }
  }
  if (projectionChanges.length) {
    await syncJobReadModelsBatchBestEffort(projectionChanges, {
      mutation: projectionMutation,
      sourceMutationCommitted: true,
    });
  } else {
    await abortAutomationJobProjectionMutation(projectionMutation);
  }
  if (claimed.length) {
    await runTransaction<AutomationJobHeartbeat>(JOB_HEARTBEATS, items => {
      const claimedIds = new Set(claimed.map(job => job.id));
      const next = items.filter(item => !claimedIds.has(item.jobId) && Date.parse(item.leaseExpiresAt) > nowMs);
      for (const job of claimed) next.push({
        id: job.id,
        jobId: job.id,
        workerId,
        claimToken: job.claimToken || '',
        heartbeatAt: now,
        leaseExpiresAt: job.leaseExpiresAt || now,
      });
      return next;
    });
  }
  for (const job of requeued) logAutomationJobEvent('job_requeued', job, { workerId, reasonCode: 'LEASE_EXPIRED' });
  for (const job of timedOut) logAutomationJobEvent('job_terminal_timeout', job, { workerId, reasonCode: 'LEASE_EXPIRED_MAX_ATTEMPTS' });
  const notRunnable = oldestNotRunnable as AutomationJob | undefined;
  if (notRunnable && nowMs - (notRunnableLogTimes.get(notRunnable.id) || 0) >= 60_000) {
    notRunnableLogTimes.set(notRunnable.id, nowMs);
    logAutomationJobEvent('job_not_runnable', notRunnable, {
      workerId,
      reasonCode: control.killSwitch && notRunnable.type !== 'RUNTIME_GUARDIAN' ? 'KILL_SWITCH_ACTIVE' : claimBlockReason,
    });
  }
  if (options.enforceExecutionCompatibility && (claimed.length > 0 || claimBlockReason !== 'SCHEDULED_FOR_FUTURE')) {
    console.info(JSON.stringify({
      type: 'worker_pool_claim',
      workerId,
      activeSlotsBeforeClaim: poolActiveSlots,
      availableSlotsBeforeClaim: poolAvailableSlots,
      claimedSlots: claimed.length,
      criticalSlotsClaimed: claimed.filter(job => job.executionCritical === true).length,
      reasonCode: claimed.length ? 'WORKER_POOL_SLOTS_FILLED' : claimBlockReason,
    }));
  }
  for (const rejected of rejectedBeforeClaim) {
    logAutomationJobEvent('job_skipped', rejected.job, { workerId, reasonCode: rejected.validation.code || 'SCHEMA_VALIDATION_FAILED' });
    if (rejected.job.type === 'PROCESS_CANDIDATE') await releaseProductProcessingCapacity(productProcessingReservationKey(rejected.job), nowMs);
    const operationId = rejected.job.operationId || generateId();
    const risk = rejected.job.riskLevel && rejected.job.riskLevel in RISK_RANK ? rejected.job.riskLevel : 'BLOCKER';
    await appendAutomationAudit({
      correlationId: rejected.job.correlationId || operationId,
      operationId,
      jobId: rejected.job.id,
      operationType: 'JOB_REJECTED_BEFORE_CLAIM',
      actor: workerId,
      previousState: rejected.previousStatus,
      nextState: 'BLOCKED',
      risk,
      reasons: [rejected.validation.code || 'SCHEMA_VALIDATION_FAILED', ...rejected.validation.reasons],
      dryRun: rejected.job.dryRun === true,
      attempts: Number(rejected.job.attemptCount || 0),
    });
  }
  for (const job of claimed) {
    logAutomationJobEvent('job_claim_attempt', job, { workerId, reasonCode: 'RUNNABLE_SELECTED' });
    logAutomationJobEvent('job_claimed', job, { workerId, reasonCode: 'ATOMIC_CLAIM_COMMITTED' });
    try {
      await appendAutomationAudit({
        correlationId: job.correlationId || job.operationId,
        operationId: job.operationId,
        jobId: job.id,
        operationType: 'JOB_CLAIMED',
        actor: workerId,
        previousState: 'PENDING',
        nextState: 'RUNNING',
        risk: job.riskLevel,
        reasons: [],
        dryRun: job.dryRun,
        attempts: job.attemptCount,
      });
    } catch (error) {
      // Claim already committed: an activity-log failure must not strand the
      // business job in RUNNING until its lease expires.
      console.error(JSON.stringify({
        type: 'automation_job_claim_audit_failed',
        jobId: job.id,
        code: sanitizeErrorMessage(error instanceof Error ? error.message : 'unknown_error'),
      }));
    }
  }
  return claimed;
}

export async function heartbeatAutomationJob(
  id: string,
  workerId: string,
  leaseMs = 60_000,
  claimToken?: string,
  ownership?: RuntimeRoleOwnership,
): Promise<boolean> {
  const nowMs = Date.now();
  if (ownership && !await isRuntimeRoleOwner('WORKER', ownership, nowMs)) return false;
  if (!claimToken) return false;
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
  let renewed = false;
  await runTransaction<AutomationJobHeartbeat>(JOB_HEARTBEATS, items => {
    const current = items.find(item => item.jobId === id);
    if (!current || current.workerId !== workerId || current.claimToken !== claimToken) return undefined;
    current.heartbeatAt = now;
    current.leaseExpiresAt = leaseExpiresAt;
    renewed = true;
    return items.filter(item => item.jobId === id || Date.parse(item.leaseExpiresAt) > nowMs);
  });
  if (!renewed) return false;
  // Projection is a read model. Update it atomically only while it still
  // represents this claim, so an in-flight heartbeat can never overwrite a
  // terminal projection written by complete/fail.
  const activeProjection = await getAutomationJobActiveProjectionStorage();
  const projectionUpdates = await Promise.allSettled([
    runTransaction<AutomationJobStatusProjection>(activeProjection.collections.status, items => {
      const current = items.find(item => item.id === id);
      if (!current || current.status !== 'RUNNING' || current.claimedBy !== workerId || current.claimToken !== claimToken) return undefined;
      if (ownership && (current.workerInstanceId !== ownership.instanceId || current.workerFencingToken !== ownership.fencingToken)) return undefined;
      current.heartbeatAt = now;
      current.leaseExpiresAt = leaseExpiresAt;
      return items;
    }),
    runTransaction<AutomationJobListProjection>(activeProjection.collections.list, items => {
      const current = items.find(item => item.id === id);
      if (!current || current.status !== 'RUNNING' || current.claimedBy !== workerId || current.claimToken !== claimToken) return undefined;
      if (ownership && (current.workerInstanceId !== ownership.instanceId || current.workerFencingToken !== ownership.fencingToken)) return undefined;
      current.heartbeatAt = now;
      current.leaseExpiresAt = leaseExpiresAt;
      return items;
    }),
  ]);
  projectionUpdates.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(JSON.stringify({
        type: 'automation_job_projection_heartbeat_failed',
        jobId: id,
        readModel: index === 0 ? 'status-projection' : 'list-projection-v2',
        reasonCode: sanitizeErrorMessage(result.reason instanceof Error ? result.reason.message : 'unknown_error'),
      }));
    }
  });
  if (projectionUpdates.some(result => result.status === 'rejected')) {
    try {
      const failureToken = await beginAutomationJobProjectionSync(nowMs);
      await finishAutomationJobProjectionSync(failureToken, {
        success: false,
        inserted: false,
        insertedCount: 0,
        sourceAffected: false,
        listProjectionCount: 0,
        statusProjectionCount: 0,
        listProjectionFingerprint: automationJobProjectionFingerprint([]),
        statusProjectionFingerprint: automationJobProjectionFingerprint([]),
        listProjectionContentFingerprint: automationJobProjectionContentFingerprint([]),
        statusProjectionContentFingerprint: automationJobProjectionContentFingerprint([]),
        activeJobCount: 0,
        retainedTerminalCount: 0,
        retentionLimitReached: false,
        currentStateTruncated: false,
        sourceUpdatedAt: null,
        retentionBoundary: null,
      }, nowMs);
    } catch {
      // The projection error was already logged; the stale heartbeat evidence
      // remains fail-closed even when its manifest cannot be invalidated.
    }
    return true;
  }
  if (nowMs - lastHeartbeatHealthSummaryRefreshAt < HEALTH_SUMMARY_HEARTBEAT_REFRESH_MS) return true;
  const manifest = await getAutomationJobProjectionManifestForMaintenance().catch(() => null);
  if (manifest?.rebuildToken || manifest?.inFlightSyncTokens.length) return true;
  try {
    await refreshAutomationJobHealthSummary(nowMs);
    lastHeartbeatHealthSummaryRefreshAt = nowMs;
  } catch (error) {
    console.error(JSON.stringify({
      type: 'automation_job_health_summary_heartbeat_failed',
      jobId: id,
      reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'unknown_error'),
    }));
  }
  return true;
}

export async function completeAutomationJob(
  id: string,
  workerId: string,
  result: Record<string, unknown>,
  guard: AutomationJobClaimGuard,
): Promise<AutomationJob | null> {
  await assertClaimGuardOwnership(guard);
  let completed: AutomationJob | null = null; const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || !activeClaimMatches(job, workerId, guard)) return undefined;
    job.status = 'SUCCEEDED'; job.result = sanitizeAutomationData(result) as Record<string, unknown>; job.completedAt = now;
    job.lastErrorCode = undefined; job.lastErrorCategory = undefined; job.lastErrorMessage = undefined; job.retryable = undefined; job.deadLetterReason = undefined;
    if (job.progress) {
      const total = job.progress.total;
      const fullyCompleted = job.outcomeStatus !== 'PARTIALLY_COMPLETED' && !job.checkpoint?.pendingSteps.length;
      job.progress = fullyCompleted
        ? { ...job.progress, processed: total ?? Math.max(1, job.progress.processed), succeeded: Math.max(job.progress.succeeded, 1), percentage: total ? 100 : undefined, updatedAt: now }
        : { ...job.progress, updatedAt: now };
    }
    clearAutomationJobClaim(job); job.heartbeatAt = now; job.updatedAt = now;
    markAutomationJobProjectionSourceMutation(job); completed = { ...job }; return items;
  });
  const completedJob = completed as AutomationJob | null;
  if (completedJob) {
    await syncJobReadModelsBestEffort(completedJob, true, projectionMutation);
    logAutomationJobEvent('job_completed', completedJob, { workerId, reasonCode: 'HANDLER_COMPLETED', durationMs: Date.now() - Date.parse(completedJob.startedAt || completedJob.claimedAt || completedJob.updatedAt) });
    try {
      await appendAutomationAudit({ correlationId: completedJob.operationId, operationId: completedJob.operationId, jobId: completedJob.id, operationType: completedJob.type,
        actor: workerId, previousState: 'RUNNING', nextState: 'SUCCEEDED', risk: completedJob.riskLevel, result, reasons: [], dryRun: completedJob.dryRun, attempts: completedJob.attemptCount });
    } catch (error) {
      console.error(JSON.stringify({ type: 'automation_job_completion_audit_failed', jobId: completedJob.id, reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'unknown_error') }));
    }
  } else await abortAutomationJobProjectionMutation(projectionMutation);
  return completedJob;
}

export async function failAutomationJob(
  id: string,
  workerId: string,
  code: string,
  error: unknown,
  options: {
    nextRetryAt?: string;
    errorCategory?: AutomationErrorCategory;
    result?: Record<string, unknown>;
    claimToken: string;
    ownership?: RuntimeRoleOwnership;
  },
): Promise<AutomationJob | null> {
  const guard: AutomationJobClaimGuard = {
    claimToken: options.claimToken,
    ownership: options.ownership,
  };
  await assertClaimGuardOwnership(guard);
  let failed: AutomationJob | null = null; const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || !activeClaimMatches(job, workerId, guard)) return undefined;
    const retry = isRetryableAutomationError(code, job.type) && job.attemptCount < Math.min(job.maxAttempts, getAutomationPolicy(job.type).retryPolicy.maxAttempts);
    const requestedRetryAt = Date.parse(options.nextRetryAt || '');
    job.status = retry ? 'RETRY_SCHEDULED' : 'FAILED';
    job.nextRetryAt = retry ? Number.isFinite(requestedRetryAt) && requestedRetryAt > Date.now()
      ? new Date(requestedRetryAt).toISOString()
      : new Date(Date.now() + retryDelayMs(job.type, job.attemptCount)).toISOString()
      : undefined;
    job.runnableAt = job.nextRetryAt;
    job.runnableReason = job.nextRetryAt ? 'RETRY_ELIGIBLE_AT' : job.runnableReason;
    job.lastErrorCode = code; job.lastErrorCategory = options.errorCategory || defaultErrorCategory(code);
    job.lastErrorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    if (options.result) job.result = sanitizeAutomationData(options.result) as Record<string, unknown>;
    job.retryable = retry;
    job.deadLetterReason = retry ? undefined : `${job.lastErrorCategory}:${code}`.slice(0, 240);
    clearAutomationJobClaim(job); job.updatedAt = now; if (!retry) job.completedAt = now;
    markAutomationJobProjectionSourceMutation(job); failed = { ...job }; return items;
  });
  const failedJob = failed as AutomationJob | null;
  if (failedJob) {
    await syncJobReadModelsBestEffort(failedJob, true, projectionMutation);
    logAutomationJobEvent(failedJob.status === 'RETRY_SCHEDULED' ? 'job_requeued' : 'job_failed', failedJob, {
      workerId,
      reasonCode: code,
      durationMs: Date.now() - Date.parse(failedJob.startedAt || failedJob.claimedAt || failedJob.updatedAt),
    });
    try {
      await appendAutomationAudit({ correlationId: failedJob.operationId, operationId: failedJob.operationId, jobId: failedJob.id, operationType: failedJob.type,
        actor: workerId, previousState: 'RUNNING', nextState: failedJob.status, risk: failedJob.riskLevel, result: options.result,
        reasons: [failedJob.lastErrorMessage || code], dryRun: failedJob.dryRun, attempts: failedJob.attemptCount });
    } catch (auditError) {
      console.error(JSON.stringify({ type: 'automation_job_failure_audit_failed', jobId: failedJob.id, reasonCode: sanitizeErrorMessage(auditError instanceof Error ? auditError.message : 'unknown_error') }));
    }
  } else await abortAutomationJobProjectionMutation(projectionMutation);
  return failedJob;
}

export async function cancelAutomationJob(id: string, actor: string, reason: string): Promise<AutomationJob | null> {
  let cancelled: AutomationJob | null = null; const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || TERMINAL.has(job.status) || (job.status === 'RUNNING' && !job.dryRun && !canCancelWhileRunning(job))) return undefined;
    const previous = job.status; job.status = 'CANCELLED'; job.cancelledAt = now; job.completedAt = now; job.updatedAt = now;
    clearAutomationJobClaim(job);
    job.lastErrorCode = 'CANCELLED'; job.lastErrorMessage = sanitizeErrorMessage(reason);
    markAutomationJobProjectionSourceMutation(job); cancelled = { ...job, result: { previousState: previous } }; return items;
  });
  const cancelledJob = cancelled as AutomationJob | null;
  if (cancelledJob?.type === 'PROCESS_CANDIDATE') await releaseProductProcessingCapacity(productProcessingReservationKey(cancelledJob));
  if (cancelledJob) {
    await syncJobReadModelsBestEffort(cancelledJob, true, projectionMutation);
    await appendAutomationAudit({ correlationId: cancelledJob.operationId, operationId: cancelledJob.operationId, jobId: cancelledJob.id, operationType: 'JOB_CANCELLED', actor,
      previousState: String(cancelledJob.result?.previousState || ''), nextState: 'CANCELLED', risk: cancelledJob.riskLevel, reasons: [reason], dryRun: cancelledJob.dryRun, attempts: cancelledJob.attemptCount });
  } else await abortAutomationJobProjectionMutation(projectionMutation);
  return cancelledJob;
}

export async function retryAutomationJob(id: string, actor: string): Promise<AutomationJob | null> {
  let retried: AutomationJob | null = null; const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'FAILED' || job.attemptCount >= job.maxAttempts) return undefined;
    job.status = 'PENDING'; job.scheduledAt = now; job.nextRetryAt = undefined; job.runnableAt = now; job.runnableReason = 'RETRY_ELIGIBLE_AT';
    job.completedAt = undefined; job.retryable = undefined; job.deadLetterReason = undefined; job.updatedAt = now;
    clearAutomationJobClaim(job);
    markAutomationJobProjectionSourceMutation(job);
    retried = { ...job }; return items;
  });
  const retriedJob = retried as AutomationJob | null;
  if (retriedJob) {
    await syncJobReadModelsBestEffort(retriedJob, false, projectionMutation);
    await appendAutomationAudit({ correlationId: retriedJob.operationId, operationId: retriedJob.operationId, jobId: retriedJob.id, operationType: 'JOB_RETRIED', actor,
      previousState: 'FAILED', nextState: 'PENDING', risk: retriedJob.riskLevel, reasons: [], dryRun: retriedJob.dryRun, attempts: retriedJob.attemptCount });
  } else await abortAutomationJobProjectionMutation(projectionMutation);
  return retriedJob;
}

export async function appendAutomationAuditOnce(input: Omit<AutomationAuditEvent, 'schemaVersion' | 'id' | 'createdAt'>): Promise<boolean> {
  let created = false;
  await runTransaction<AutomationAuditEvent>(AUDIT, items => {
    if (items.some(item => item.operationId === input.operationId && item.operationType === input.operationType)) return undefined;
    items.push({
      ...input, schemaVersion: 2, id: generateId(),
      result: sanitizeAutomationData(input.result) as Record<string, unknown> | undefined,
      reasons: input.reasons.map(reason => sanitizeErrorMessage(reason)).slice(0, 20),
      createdAt: new Date().toISOString(),
    });
    if (items.length > 5_000) items.splice(0, items.length - 5_000);
    created = true;
    return items;
  });
  return created;
}

export async function recoverStaleAutomationJob(id: string, ownership: RuntimeRoleOwnership, actor: string, nowMs = Date.now()): Promise<AutomationJob | null> {
  if (!await isRuntimeRoleOwner('WORKER', ownership, nowMs)) throw new Error('STALE_RECOVERY_FENCING_REJECTED');
  let recovered: AutomationJob | null = null;
  const now = new Date(nowMs).toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.completedAt) return undefined;
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > nowMs) throw new Error('HEALTHY_JOB_LEASE_TAKEOVER_FORBIDDEN');
    const retry = job.attemptCount < job.maxAttempts;
    job.status = retry ? 'RETRY_SCHEDULED' : 'FAILED';
    job.nextRetryAt = retry ? new Date(nowMs + retryDelayMs(job.type, job.attemptCount)).toISOString() : undefined;
    job.lastErrorCode = 'LEASE_EXPIRED'; job.lastErrorCategory = 'PROVIDER_TIMEOUT';
    job.lastErrorMessage = 'Lease job đã hết hạn và được worker owner có fencing hợp lệ phục hồi.';
    job.retryable = retry; job.deadLetterReason = retry ? undefined : 'PROVIDER_TIMEOUT:LEASE_EXPIRED';
    clearAutomationJobClaim(job); job.updatedAt = now;
    if (!retry) job.completedAt = now;
    markAutomationJobProjectionSourceMutation(job);
    recovered = structuredClone(job);
    return items;
  });
  const result = recovered as AutomationJob | null;
  if (result) {
    await syncJobReadModelsBestEffort(result, true, projectionMutation);
    await appendAutomationAudit({ correlationId: result.operationId, operationId: `${result.operationId}:stale-recovery:${ownership.fencingToken}`.slice(0, 160), jobId: result.id, operationType: 'STALE_JOB_RECOVERED', actor, previousState: 'RUNNING', nextState: result.status, risk: 'MEDIUM', reasons: ['LEASE_EXPIRED', `fencing:${ownership.fencingToken}`], dryRun: result.dryRun, attempts: result.attemptCount });
  } else await abortAutomationJobProjectionMutation(projectionMutation);
  return result;
}

export async function approveAutomationJob(id: string, actor: string, reason: string, approve: boolean): Promise<AutomationJob | null> {
  let changed: AutomationJob | null = null; const now = new Date().toISOString();
  const projectionMutation = await runAutomationJobSourceTransaction(items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'WAITING_APPROVAL' || job.riskLevel === 'BLOCKER') return undefined;
    if (!job.approvalExpiresAt || Date.parse(job.approvalExpiresAt) <= Date.now()) {
      job.approvalStatus = 'EXPIRED'; job.status = 'CANCELLED'; job.cancelledAt = now; job.lastErrorCode = 'APPROVAL_EXPIRED';
    } else if (approve) {
      job.approvalStatus = 'APPROVED'; job.approvedBy = actor; job.approvalReason = sanitizeErrorMessage(reason); job.status = 'PENDING';
    } else {
      job.approvalStatus = 'REJECTED'; job.approvedBy = actor; job.approvalReason = sanitizeErrorMessage(reason); job.status = 'CANCELLED'; job.cancelledAt = now;
    }
    job.updatedAt = now; markAutomationJobProjectionSourceMutation(job); changed = { ...job }; return items;
  });
  const changedJob = changed as AutomationJob | null;
  if (changedJob) {
    await syncJobReadModelsBestEffort(changedJob, TERMINAL.has(changedJob.status), projectionMutation);
    await appendAutomationAudit({ correlationId: changedJob.operationId, operationId: changedJob.operationId, jobId: changedJob.id, operationType: approve ? 'JOB_APPROVED' : 'JOB_REJECTED', actor,
      previousState: 'WAITING_APPROVAL', nextState: changedJob.status, risk: changedJob.riskLevel, reasons: [reason], dryRun: changedJob.dryRun, attempts: changedJob.attemptCount });
  } else await abortAutomationJobProjectionMutation(projectionMutation);
  return changedJob;
}

export async function getAiUsage(now = Date.now()): Promise<AiUsageRecord> {
  const day = vietnamDayKey(now); const existing = (await readCollection<AiUsageRecord>(USAGE)).find(item => item.day === day);
  return existing || { id: day, day, requests: 0, tokens: 0, fallbacks: 0, blocked: 0, requestLimit: 100, tokenLimit: 100_000, updatedAt: new Date(now).toISOString() };
}

export async function reserveAiUsage(requests: number, tokens: number, now = Date.now()): Promise<{ allowed: boolean; usage: AiUsageRecord }> {
  const day = vietnamDayKey(now); let result!: { allowed: boolean; usage: AiUsageRecord };
  await runTransaction<AiUsageRecord>(USAGE, items => {
    let usage = items.find(item => item.day === day);
    if (!usage) { usage = { id: day, day, requests: 0, tokens: 0, fallbacks: 0, blocked: 0, requestLimit: 100, tokenLimit: 100_000, updatedAt: new Date(now).toISOString() }; items.push(usage); }
    const allowed = usage.requests + requests <= usage.requestLimit && usage.tokens + tokens <= usage.tokenLimit;
    if (allowed) { usage.requests += requests; usage.tokens += tokens; } else usage.blocked += 1;
    usage.updatedAt = new Date(now).toISOString(); result = { allowed, usage: { ...usage } }; return items;
  });
  return result;
}

export async function getCircuit(provider: string): Promise<CircuitBreakerRecord> {
  return (await readCollection<CircuitBreakerRecord>(CIRCUITS)).find(item => item.provider === provider) || {
    id: provider, provider, state: 'CLOSED', consecutiveFailures: 0, updatedAt: new Date(0).toISOString(),
  };
}

export async function canUseCircuit(provider: string, now = Date.now()): Promise<{ allowed: boolean; circuit: CircuitBreakerRecord }> {
  const current = await getCircuit(provider);
  if (current.state === 'OPEN' && current.nextProbeAt && Date.parse(current.nextProbeAt) <= now) {
    let half = current;
    await runTransaction<CircuitBreakerRecord>(CIRCUITS, items => {
      const found = items.find(item => item.provider === provider);
      if (found) { found.state = 'HALF_OPEN'; found.updatedAt = new Date(now).toISOString(); half = { ...found }; }
      else { half = { ...current, state: 'HALF_OPEN', updatedAt: new Date(now).toISOString() }; items.push(half); }
      return items;
    });
    return { allowed: true, circuit: half };
  }
  return { allowed: current.state !== 'OPEN', circuit: current };
}

export async function recordCircuitResult(provider: string, success: boolean, now = Date.now()): Promise<CircuitBreakerRecord> {
  let next!: CircuitBreakerRecord; const timestamp = new Date(now).toISOString();
  await runTransaction<CircuitBreakerRecord>(CIRCUITS, items => {
    let current = items.find(item => item.provider === provider);
    if (!current) { current = { id: provider, provider, state: 'CLOSED', consecutiveFailures: 0, updatedAt: timestamp }; items.push(current); }
    if (success) { current.state = 'CLOSED'; current.consecutiveFailures = 0; current.lastSuccessAt = timestamp; current.openedAt = undefined; current.nextProbeAt = undefined; }
    else { current.consecutiveFailures += 1; current.lastFailureAt = timestamp; if (current.consecutiveFailures >= 3 || current.state === 'HALF_OPEN') { current.state = 'OPEN'; current.openedAt = timestamp; current.nextProbeAt = new Date(now + 5 * 60_000).toISOString(); } }
    current.updatedAt = timestamp; next = { ...current }; return items;
  });
  return next;
}

export async function listAutomationAudit(page = 1, pageSize = 20) {
  const items = (await readCollection<AutomationAuditEvent>(AUDIT)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const totalItems = items.length; const totalPages = Math.max(1, Math.ceil(totalItems / pageSize)); const safePage = Math.min(page, totalPages);
  return { items: items.slice((safePage - 1) * pageSize, safePage * pageSize), pagination: { page: safePage, pageSize, totalItems, totalPages } };
}

export async function getAutomationQueueStats() {
  const summary = await getAutomationJobHealthView();
  return {
    total: summary.totalProjectedJobs,
    ...summary.statusCounts,
    dataAccess: {
      source: summary.source,
      availability: summary.availability,
      stale: summary.stale,
      reasonCodes: summary.reasonCodes,
      coverageComplete: summary.coverageComplete,
      evidenceClassification: summary.evidenceClassification,
      currentStateComplete: summary.currentStateComplete,
      historyComplete: summary.historyComplete,
      truncated: summary.truncated,
      totalSemantics: 'BOUNDED_RETAINED_HISTORY',
    },
  } as Record<AutomationJobStatus | 'total', number> & {
    dataAccess: {
      source: string;
      availability: string;
      stale: boolean;
      reasonCodes: string[];
      coverageComplete: boolean;
      evidenceClassification: string;
      currentStateComplete: boolean;
      historyComplete: boolean;
      truncated: boolean;
      totalSemantics: 'BOUNDED_RETAINED_HISTORY';
    };
  };
}

export interface AutomationJobCompactionPlan {
  apply: boolean;
  totalJobs: number;
  activeJobs: number;
  terminalJobs: number;
  removableJobs: number;
  retainedJobs: number;
  retentionDays: number;
  minimumTerminalJobs: number;
  cutoffAt: string;
  backupRef?: string;
  removedJobIdsSample: string[];
}

function buildCompactionSelection(
  jobs: AutomationJob[],
  nowMs: number,
  retentionDays: number,
  minimumTerminalJobs: number,
): { removable: Set<string>; cutoffAt: string; terminalJobs: AutomationJob[] } {
  const cutoffAt = new Date(nowMs - retentionDays * 24 * 60 * 60_000).toISOString();
  const terminalJobs = jobs
    .filter(job => TERMINAL.has(job.status))
    .sort((left, right) => Date.parse(right.completedAt || right.updatedAt) - Date.parse(left.completedAt || left.updatedAt));
  const jobsById = new Map(jobs.map(job => [job.id, job]));
  const childrenByParent = new Map<string, AutomationJob[]>();
  for (const job of jobs) {
    if (!job.parentJobId) continue;
    const children = childrenByParent.get(job.parentJobId) || [];
    children.push(job);
    childrenByParent.set(job.parentJobId, children);
  }

  // Retention may remove old terminal history, but never a job connected to an
  // active workflow. Protect both ancestors and descendants so reconciliation
  // can still prove the complete durable execution tree after a long manual wait.
  const workflowProtectedIds = new Set(jobs.filter(job => !TERMINAL.has(job.status)).map(job => job.id));
  const pending = [...workflowProtectedIds];
  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    const id = pending[pendingIndex++];
    const parentId = jobsById.get(id)?.parentJobId;
    if (parentId && jobsById.has(parentId) && !workflowProtectedIds.has(parentId)) {
      workflowProtectedIds.add(parentId);
      pending.push(parentId);
    }
    for (const child of childrenByParent.get(id) || []) {
      if (workflowProtectedIds.has(child.id)) continue;
      workflowProtectedIds.add(child.id);
      pending.push(child.id);
    }
  }

  const protectedIds = new Set([
    ...terminalJobs.slice(0, minimumTerminalJobs).map(job => job.id),
    ...workflowProtectedIds,
  ]);
  const removable = new Set(terminalJobs
    .filter(job => !protectedIds.has(job.id) && Date.parse(job.completedAt || job.updatedAt) < Date.parse(cutoffAt))
    .map(job => job.id));
  return { removable, cutoffAt, terminalJobs };
}

/** Preview by default. Apply is explicit and always snapshots FileStorage first. */
export async function compactAutomationJobs(options: {
  apply?: boolean;
  nowMs?: number;
  retentionDays?: number;
  minimumTerminalJobs?: number;
  actor?: string;
} = {}): Promise<AutomationJobCompactionPlan> {
  const nowMs = options.nowMs ?? Date.now();
  const retentionDays = Math.max(7, Math.floor(options.retentionDays ?? (Number(process.env.SANDEAL_JOB_RETENTION_DAYS) || 30)));
  const minimumTerminalJobs = Math.max(100, Math.floor(options.minimumTerminalJobs ?? (Number(process.env.SANDEAL_JOB_MIN_TERMINAL_AUDIT) || 1_000)));
  const initial = await readCollection<AutomationJob>(JOBS);
  const preview = buildCompactionSelection(initial, nowMs, retentionDays, minimumTerminalJobs);
  let backupRef: string | undefined;
  let removedIds = [...preview.removable];

  if (options.apply && removedIds.length) {
    backupRef = await backupCollection(JOBS, 'pre-compaction');
    const projectionMutation = await runAutomationJobSourceTransaction(jobs => {
      const current = buildCompactionSelection(jobs, nowMs, retentionDays, minimumTerminalJobs);
      removedIds = [...current.removable];
      const retainedAfterCompaction = jobs.filter(job => !current.removable.has(job.id));
      return removedIds.length ? retainedAfterCompaction : undefined;
    });
    try {
      if (!removedIds.length) {
        await abortAutomationJobProjectionMutation(projectionMutation);
      } else {
        const removedSet = new Set(removedIds);
        const collections = automationJobProjectionStorageCollections(
          projectionMutation.targetSlot,
          projectionMutation.targetRepairFence,
        );
        const [statusStats, listStats] = await Promise.all([
          removeJobProjections<AutomationJobStatusProjection>(removedSet, collections.status),
          removeJobProjections<AutomationJobListProjection>(removedSet, collections.list),
          removeJobHeartbeats(removedIds),
        ]);
        await finishAutomationJobProjectionSync(projectionMutation, {
          success: true,
          inserted: false,
          insertedCount: 0,
          removedCount: removedIds.length,
          sourceAffected: true,
          projectionChanged: statusStats.sourceAffected || listStats.sourceAffected,
          listProjectionCount: listStats.count,
          statusProjectionCount: statusStats.count,
          listProjectionFingerprint: listStats.fingerprint,
          statusProjectionFingerprint: statusStats.fingerprint,
          listProjectionContentFingerprint: listStats.contentFingerprint,
          statusProjectionContentFingerprint: statusStats.contentFingerprint,
          activeJobCount: Math.max(statusStats.activeCount, listStats.activeCount),
          retainedTerminalCount: Math.min(statusStats.terminalCount, listStats.terminalCount),
          retentionLimitReached: statusStats.retentionLimitReached || listStats.retentionLimitReached,
          currentStateTruncated: statusStats.currentStateTruncated || listStats.currentStateTruncated,
          sourceUpdatedAt: [statusStats.sourceUpdatedAt, listStats.sourceUpdatedAt]
            .filter((value): value is string => Boolean(value))
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null,
          retentionBoundary: statusStats.retentionBoundary || listStats.retentionBoundary,
        }, nowMs);
        await refreshAutomationJobHealthSummary(nowMs).catch(error => {
          console.error(JSON.stringify({
            type: 'automation_job_health_summary_compaction_failed',
            reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'unknown_error'),
          }));
        });
      }
    } catch (error) {
      await invalidateAutomationJobProjectionMutation(projectionMutation, nowMs).catch(() => undefined);
      throw error;
    }
    await appendAutomationAudit({
      correlationId: generateId(),
      operationId: generateId(),
      operationType: 'AUTOMATION_QUEUE_COMPACTED',
      actor: options.actor || 'queue-compaction',
      target: JOBS,
      previousState: String(initial.length),
      nextState: String(initial.length - removedIds.length),
      risk: 'MEDIUM',
      result: { removedJobs: removedIds.length, retentionDays, minimumTerminalJobs, backupCreated: true },
      reasons: ['TERMINAL_RETENTION_EXPIRED'],
      dryRun: false,
      attempts: 1,
    });
  }

  return {
    apply: options.apply === true,
    totalJobs: initial.length,
    activeJobs: initial.filter(job => !TERMINAL.has(job.status)).length,
    terminalJobs: preview.terminalJobs.length,
    removableJobs: removedIds.length,
    retainedJobs: initial.length - removedIds.length,
    retentionDays,
    minimumTerminalJobs,
    cutoffAt: preview.cutoffAt,
    backupRef,
    removedJobIdsSample: removedIds.slice(0, 20),
  };
}
