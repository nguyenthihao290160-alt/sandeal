import { createHash } from 'node:crypto';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { sanitizeErrorMessage } from '@/lib/safety/operationGuard';
import { getJobRegistryDefaults } from './botRegistry';
import { approvalStatusForPolicy, getAutomationPolicy, initialStatusForPolicy, listAutomationPolicies } from './policyRegistry';
import { buildAutoPilotExecutionPlan } from './autoPilotGraph';
import { vietnamDayKey } from './timezone';
import { isRuntimeRoleOwner, type RuntimeRoleOwnership } from './runtimeRoles';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { releaseProductProcessingCapacity, reserveProductProcessingCapacity } from './businessUsage';
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
  AutomationJobStatus,
  AutomationJobType,
  AutomationRiskLevel,
  CircuitBreakerRecord,
  RequestedExecutionMode,
} from './types';

const JOBS = 'automation-jobs';
const CONTROL = 'automation-control';
const AUDIT = 'automation-audit';
const USAGE = 'automation-ai-usage';
const CIRCUITS = 'automation-circuits';
const MAX_PAYLOAD_BYTES = 16 * 1024;
export const AUTOMATION_JOB_SCHEMA_VERSION = 2;
const SECRET_KEY = /token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|credential/i;
const TERMINAL = new Set<AutomationJobStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
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
  ingestionPaused: false,
  workerPaused: false,
  schedulerPaused: true,
  killSwitch: false,
  timezone: 'Asia/Ho_Chi_Minh',
  updatedAt: new Date(0).toISOString(),
};

export function sanitizeAutomationData(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[Đã rút gọn]';
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'string') return value.slice(0, 1_000);
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
  return stored ? { ...DEFAULT_CONTROL, ...stored, schemaVersion: 2, id: 'automation-control' } : { ...DEFAULT_CONTROL };
}

export async function updateAutomationControl(
  updates: Partial<Pick<AutomationControlState, 'mode' | 'effectiveMode' | 'publishPaused' | 'ingestionPaused' | 'workerPaused' | 'schedulerPaused' | 'pausedAt' | 'pauseReason' | 'killSwitch' | 'reason' | 'changedBy' | 'workerHeartbeatAt' | 'workerId' | 'workerCurrentJobId' | 'schedulerHeartbeatAt' | 'schedulerLastRunAt' | 'schedulerNextRunAt' | 'guardianHeartbeatAt' | 'degradedAt' | 'degradedReason'>>,
  actor = 'system',
): Promise<AutomationControlState> {
  let previous = await getAutomationControl();
  let next = previous;
  const now = new Date().toISOString();
  await runTransaction<AutomationControlState>(CONTROL, items => {
    previous = items[0] || { ...DEFAULT_CONTROL };
    next = { ...previous, ...updates, schemaVersion: 2, id: 'automation-control', updatedAt: now };
    if ('killSwitch' in updates || 'workerPaused' in updates || 'schedulerPaused' in updates || 'mode' in updates || 'effectiveMode' in updates || 'publishPaused' in updates || 'ingestionPaused' in updates) {
      next.changedAt = now;
      next.changedBy = actor;
    }
    return [next];
  });
  if ('killSwitch' in updates || 'workerPaused' in updates || 'schedulerPaused' in updates || 'mode' in updates || 'effectiveMode' in updates || 'publishPaused' in updates || 'ingestionPaused' in updates) {
    await appendAutomationAudit({
      correlationId: generateId(), operationId: generateId(), operationType: 'CONTROL_CHANGED', actor,
      target: 'automation-control', previousState: JSON.stringify({ mode: previous.mode, effectiveMode: previous.effectiveMode, publishPaused: previous.publishPaused, ingestionPaused: previous.ingestionPaused, workerPaused: previous.workerPaused, schedulerPaused: previous.schedulerPaused, killSwitch: previous.killSwitch }),
      nextState: JSON.stringify({ mode: next.mode, effectiveMode: next.effectiveMode, publishPaused: next.publishPaused, ingestionPaused: next.ingestionPaused, workerPaused: next.workerPaused, schedulerPaused: next.schedulerPaused, killSwitch: next.killSwitch }),
      risk: updates.killSwitch ? 'HIGH' : 'MEDIUM', reasons: updates.reason ? [updates.reason] : [], dryRun: false, attempts: 0,
    });
  }
  return next;
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
  if (typeof job.idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(job.idempotencyKey)) reasons.push('idempotencyKey is invalid');
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
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(key)) rejectAutomationJob('INVALID_IDEMPOTENCY_KEY', ['idempotencyKey must be 8-160 safe characters']);
  const requestedBy = typeof input.requestedBy === 'string' ? input.requestedBy.trim() : '';
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
    ? input.capability.trim()
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
  const operationId = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId.trim() : generateId();
  const correlationId = typeof input.correlationId === 'string' && input.correlationId.trim() ? input.correlationId.trim() : operationId;
  const source = typeof payload.source === 'string' ? payload.source.slice(0, 100) : undefined;
  const trigger = typeof payload.trigger === 'string' ? payload.trigger.slice(0, 100) : undefined;
  const job: AutomationJob = {
    schemaVersion: AUTOMATION_JOB_SCHEMA_VERSION, policyVersion: jobPolicy.policyVersion, handlerVersion: jobPolicy.handlerVersion,
    id: generateId(), correlationId, type: input.type, status, payload,
    priority: Math.max(0, Math.min(100, input.priority ?? 50)), idempotencyKey: key, operationId, requestedBy,
    sourceMetadata: { producer: requestedBy, source, trigger },
    parentJobId: input.parentJobId,
    botId: jobPolicy.botId,
    capability,
    requestedExecutionMode: input.requestedExecutionMode || registryDefaults.requestedExecutionMode,
    executionPlan,
    progress: { processed: 0, total: executionPlan.length || undefined, succeeded: 0, skipped: 0, failed: 0, updatedAt: now },
    checkpoint: { version: 1, completedSteps: [], pendingSteps: executionPlan.map(step => step.id), outputs: {}, executionModes: [], inputHash, updatedAt: now },
    approvalStatus, approvalReason: input.approvalReason, approvalExpiresAt: approvalStatus === 'PENDING' ? new Date(nowMs + 24 * 60 * 60_000).toISOString() : undefined,
    riskLevel: risk, dryRun: input.dryRun === true, attemptCount: 0,
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
  try {
    await runTransaction<AutomationJob>(JOBS, items => {
      const existing = items.find(item => item.type === input.type && item.idempotencyKey === job.idempotencyKey);
      if (existing) {
        response = { job: existing, created: false, code: existing.status === 'SUCCEEDED' ? 'ALREADY_PROCESSED' : 'IN_PROGRESS' };
        return undefined;
      }
      items.push(job);
      response = { job, created: true, code: 'CREATED' };
      return items;
    });
  } catch (error) {
    if (quotaReserved) await releaseProductProcessingCapacity(reservationKey);
    throw error;
  }
  if (!response.created && ['FAILED', 'CANCELLED', 'BLOCKED'].includes(response.job.status)) {
    await releaseProductProcessingCapacity(reservationKey);
  }
  if (response.created) {
    await appendAutomationAudit({ correlationId: response.job.correlationId || response.job.operationId, operationId: response.job.operationId, jobId: response.job.id,
      operationType: response.job.type, actor: response.job.requestedBy, nextState: response.job.status, risk: response.job.riskLevel,
      reasons: input.approvalReason ? [input.approvalReason] : [], dryRun: response.job.dryRun, attempts: 0 });
  }
  return response;
}

export async function getAutomationJob(id: string): Promise<AutomationJob | null> {
  return (await readCollection<AutomationJob>(JOBS)).find(job => job.id === id) || null;
}

export async function getAllAutomationJobs(): Promise<AutomationJob[]> {
  return readCollection<AutomationJob>(JOBS);
}

export async function listAutomationJobs(options: { status?: AutomationJobStatus; type?: AutomationJobType; page: number; pageSize: number }) {
  let items = await readCollection<AutomationJob>(JOBS);
  if (options.status) items = items.filter(item => item.status === options.status);
  if (options.type) items = items.filter(item => item.type === options.type);
  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / options.pageSize));
  const page = Math.min(options.page, totalPages);
  return { items: items.slice((page - 1) * options.pageSize, page * options.pageSize), pagination: { page, pageSize: options.pageSize, totalItems, totalPages } };
}

export function publicAutomationJob(job: AutomationJob) {
  const { payload: _payload, ...safe } = job;
  void _payload;
  return {
    ...safe,
    queuedAt: job.queuedAt || job.scheduledAt,
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

export async function updateAutomationJobExecution(
  id: string,
  workerId: string,
  patch: Partial<ExecutionUpdate>,
): Promise<AutomationJob | null> {
  let updated: AutomationJob | null = null;
  const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.claimedBy !== workerId) return undefined;
    if (patch.executionMode) job.executionMode = patch.executionMode;
    if (patch.outcomeStatus) job.outcomeStatus = patch.outcomeStatus;
    if (patch.executionPlan) job.executionPlan = sanitizeAutomationData(patch.executionPlan) as AutomationExecutionPlanStep[];
    if (patch.progress) job.progress = sanitizeAutomationData({ ...patch.progress, updatedAt: now }) as AutomationJob['progress'];
    if (patch.checkpoint) job.checkpoint = sanitizeAutomationData({ ...patch.checkpoint, updatedAt: now }) as AutomationCheckpoint;
    if (patch.disclosure) job.disclosure = sanitizeAutomationData(patch.disclosure) as AutomationExecutionDisclosure;
    if (patch.manualTaskId) job.manualTaskId = patch.manualTaskId;
    job.updatedAt = now;
    updated = { ...job };
    return items;
  });
  return updated;
}

export async function waitAutomationJobForManual(
  id: string,
  workerId: string,
  taskId: string,
  checkpoint: AutomationCheckpoint,
  disclosure: AutomationExecutionDisclosure,
): Promise<AutomationJob | null> {
  let waiting: AutomationJob | null = null;
  const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.claimedBy !== workerId) return undefined;
    job.status = 'WAITING_FOR_MANUAL_INPUT';
    job.manualTaskId = taskId;
    job.outcomeStatus = 'WAITING_FOR_MANUAL_INPUT';
    job.executionMode = 'MANUAL_INPUT';
    job.checkpoint = sanitizeAutomationData({ ...checkpoint, updatedAt: now }) as AutomationCheckpoint;
    job.disclosure = sanitizeAutomationData(disclosure) as AutomationExecutionDisclosure;
    job.leaseExpiresAt = undefined;
    job.heartbeatAt = now;
    job.updatedAt = now;
    waiting = { ...job };
    return items;
  });
  const waitingJob = waiting as AutomationJob | null;
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
): Promise<AutomationJob | null> {
  let waiting: AutomationJob | null = null;
  const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.claimedBy !== workerId || !job.checkpoint?.pendingSteps.length) return undefined;
    job.status = 'WAITING_CHILDREN';
    job.result = sanitizeAutomationData(result) as Record<string, unknown>;
    job.leaseExpiresAt = undefined;
    job.claimedAt = undefined;
    job.claimedBy = undefined;
    job.heartbeatAt = now;
    job.updatedAt = now;
    waiting = { ...job };
    return items;
  });
  const waitingJob = waiting as AutomationJob | null;
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
  await runTransaction<AutomationJob>(JOBS, items => {
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
    completed = { ...job };
    return items;
  });
  const completedJob = completed as AutomationJob | null;
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
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'WAITING_FOR_MANUAL_INPUT' || job.manualTaskId !== taskId) return undefined;
    job.status = 'PENDING';
    job.scheduledAt = now;
    job.claimedAt = undefined;
    job.claimedBy = undefined;
    job.leaseExpiresAt = undefined;
    job.updatedAt = now;
    resumed = { ...job };
    return items;
  });
  const resumedJob = resumed as AutomationJob | null;
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

export async function claimAutomationJobs(workerId: string, limit = 1, leaseMs = 60_000, nowMs = Date.now()): Promise<AutomationJob[]> {
  const control = await getAutomationControl();
  if (control.workerPaused) return [];
  const claimed: AutomationJob[] = [];
  const rejectedBeforeClaim: Array<{ job: AutomationJob; validation: AutomationJobContractValidation; previousStatus: AutomationJobStatus }> = [];
  const now = new Date(nowMs).toISOString();
  const preclaimJobs = (await readCollection<AutomationJob>(JOBS))
    .filter(item => item.type === 'PROCESS_CANDIDATE'
      && (item.status === 'PENDING' || (item.status === 'RETRY_SCHEDULED' && Boolean(item.nextRetryAt) && Date.parse(item.nextRetryAt!) <= nowMs))
      && Date.parse(item.scheduledAt) <= nowMs)
    .sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(0, Math.min(limit, 10)));
  const candidateClaimable = new Set<string>();
  const candidateQuotaDenied = new Set<string>();
  if (preclaimJobs.length) {
    const settings = await getAutomationSettings();
    for (const item of preclaimJobs) {
      const reservation = await reserveProductProcessingCapacity(productProcessingReservationKey(item), 1, settings.maxItemsPerDay, nowMs);
      if (reservation.allowed) candidateClaimable.add(item.id);
      else candidateQuotaDenied.add(item.id);
    }
  }
  await runTransaction<AutomationJob>(JOBS, items => {
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
          item.leaseExpiresAt = undefined;
          item.completedAt = now;
          item.updatedAt = now;
          rejectedBeforeClaim.push({ job: { ...item }, validation, previousStatus });
          changed = true;
          continue;
        }
      }
      if (item.status === 'RUNNING' && item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= nowMs) {
        item.status = item.attemptCount < item.maxAttempts ? 'RETRY_SCHEDULED' : 'FAILED';
        item.nextRetryAt = item.status === 'RETRY_SCHEDULED' ? new Date(nowMs + retryDelayMs(item.type, item.attemptCount)).toISOString() : undefined;
        item.lastErrorCode = 'LEASE_EXPIRED'; item.lastErrorCategory = 'PROVIDER_TIMEOUT'; item.lastErrorMessage = 'Bộ xử lý mất tín hiệu trước khi hoàn tất.';
        item.retryable = item.status === 'RETRY_SCHEDULED'; item.deadLetterReason = item.retryable ? undefined : 'PROVIDER_TIMEOUT:LEASE_EXPIRED'; item.claimedBy = undefined; item.updatedAt = now;
        changed = true;
      }
      if (item.status === 'RETRY_SCHEDULED' && item.nextRetryAt && Date.parse(item.nextRetryAt) <= nowMs) { item.status = 'PENDING'; changed = true; }
      if (item.status === 'PENDING' && item.type === 'PROCESS_CANDIDATE' && candidateQuotaDenied.has(item.id)) {
        item.status = 'BLOCKED';
        item.lastErrorCode = 'DAILY_PRODUCT_LIMIT_REACHED';
        item.lastErrorCategory = 'VALIDATION_FAILED';
        item.lastErrorMessage = 'Đã đạt giới hạn sản phẩm xử lý trong ngày Việt Nam.';
        item.completedAt = now;
        item.updatedAt = now;
        changed = true;
      }
    }
    const due = items.filter(item => item.status === 'PENDING' && Date.parse(item.scheduledAt) <= nowMs
      && (!control.killSwitch || item.type === 'RUNTIME_GUARDIAN')
      && (item.type !== 'PROCESS_CANDIDATE' || candidateClaimable.has(item.id)))
      .sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, Math.max(0, Math.min(limit, 10)));
    for (const item of due) {
      item.status = 'RUNNING'; item.claimedBy = workerId; item.claimedAt = now; item.heartbeatAt = now;
      item.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString(); item.startedAt ||= now; item.attemptCount += 1; item.updatedAt = now;
      claimed.push({ ...item, payload: { ...item.payload } });
      changed = true;
    }
    return changed ? items : undefined;
  });
  for (const rejected of rejectedBeforeClaim) {
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
  return claimed;
}

export async function heartbeatAutomationJob(id: string, workerId: string, leaseMs = 60_000): Promise<boolean> {
  let updated = false; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.claimedBy !== workerId) return undefined;
    job.heartbeatAt = now; job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString(); job.updatedAt = now; updated = true; return items;
  });
  return updated;
}

export async function completeAutomationJob(id: string, workerId: string, result: Record<string, unknown>): Promise<AutomationJob | null> {
  let completed: AutomationJob | null = null; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.claimedBy !== workerId) return undefined;
    job.status = 'SUCCEEDED'; job.result = sanitizeAutomationData(result) as Record<string, unknown>; job.completedAt = now;
    job.lastErrorCode = undefined; job.lastErrorCategory = undefined; job.lastErrorMessage = undefined; job.retryable = undefined; job.deadLetterReason = undefined;
    if (job.progress) {
      const total = job.progress.total;
      const fullyCompleted = job.outcomeStatus !== 'PARTIALLY_COMPLETED' && !job.checkpoint?.pendingSteps.length;
      job.progress = fullyCompleted
        ? { ...job.progress, processed: total ?? Math.max(1, job.progress.processed), succeeded: Math.max(job.progress.succeeded, 1), percentage: total ? 100 : undefined, updatedAt: now }
        : { ...job.progress, updatedAt: now };
    }
    job.leaseExpiresAt = undefined; job.heartbeatAt = now; job.updatedAt = now; completed = { ...job }; return items;
  });
  const completedJob = completed as AutomationJob | null;
  if (completedJob) await appendAutomationAudit({ correlationId: completedJob.operationId, operationId: completedJob.operationId, jobId: completedJob.id, operationType: completedJob.type,
    actor: workerId, previousState: 'RUNNING', nextState: 'SUCCEEDED', risk: completedJob.riskLevel, result, reasons: [], dryRun: completedJob.dryRun, attempts: completedJob.attemptCount });
  return completedJob;
}

export async function failAutomationJob(id: string, workerId: string, code: string, error: unknown, options: { nextRetryAt?: string; errorCategory?: AutomationErrorCategory } = {}): Promise<AutomationJob | null> {
  let failed: AutomationJob | null = null; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.claimedBy !== workerId) return undefined;
    const retry = isRetryableAutomationError(code, job.type) && job.attemptCount < Math.min(job.maxAttempts, getAutomationPolicy(job.type).retryPolicy.maxAttempts);
    const requestedRetryAt = Date.parse(options.nextRetryAt || '');
    job.status = retry ? 'RETRY_SCHEDULED' : 'FAILED';
    job.nextRetryAt = retry ? Number.isFinite(requestedRetryAt) && requestedRetryAt > Date.now()
      ? new Date(requestedRetryAt).toISOString()
      : new Date(Date.now() + retryDelayMs(job.type, job.attemptCount)).toISOString()
      : undefined;
    job.lastErrorCode = code; job.lastErrorCategory = options.errorCategory || defaultErrorCategory(code);
    job.lastErrorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    job.retryable = retry;
    job.deadLetterReason = retry ? undefined : `${job.lastErrorCategory}:${code}`.slice(0, 240);
    job.leaseExpiresAt = undefined; job.updatedAt = now; if (!retry) job.completedAt = now; failed = { ...job }; return items;
  });
  const failedJob = failed as AutomationJob | null;
  if (failedJob) await appendAutomationAudit({ correlationId: failedJob.operationId, operationId: failedJob.operationId, jobId: failedJob.id, operationType: failedJob.type,
    actor: workerId, previousState: 'RUNNING', nextState: failedJob.status, risk: failedJob.riskLevel, reasons: [failedJob.lastErrorMessage || code], dryRun: failedJob.dryRun, attempts: failedJob.attemptCount });
  return failedJob;
}

export async function cancelAutomationJob(id: string, actor: string, reason: string): Promise<AutomationJob | null> {
  let cancelled: AutomationJob | null = null; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || TERMINAL.has(job.status) || (job.status === 'RUNNING' && !job.dryRun && !canCancelWhileRunning(job))) return undefined;
    const previous = job.status; job.status = 'CANCELLED'; job.cancelledAt = now; job.completedAt = now; job.updatedAt = now;
    job.lastErrorCode = 'CANCELLED'; job.lastErrorMessage = sanitizeErrorMessage(reason); cancelled = { ...job, result: { previousState: previous } }; return items;
  });
  const cancelledJob = cancelled as AutomationJob | null;
  if (cancelledJob?.type === 'PROCESS_CANDIDATE') await releaseProductProcessingCapacity(productProcessingReservationKey(cancelledJob));
  if (cancelledJob) await appendAutomationAudit({ correlationId: cancelledJob.operationId, operationId: cancelledJob.operationId, jobId: cancelledJob.id, operationType: 'JOB_CANCELLED', actor,
    previousState: String(cancelledJob.result?.previousState || ''), nextState: 'CANCELLED', risk: cancelledJob.riskLevel, reasons: [reason], dryRun: cancelledJob.dryRun, attempts: cancelledJob.attemptCount });
  return cancelledJob;
}

export async function retryAutomationJob(id: string, actor: string): Promise<AutomationJob | null> {
  let retried: AutomationJob | null = null; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'FAILED' || job.attemptCount >= job.maxAttempts) return undefined;
    job.status = 'PENDING'; job.nextRetryAt = undefined; job.completedAt = undefined; job.retryable = undefined; job.deadLetterReason = undefined; job.updatedAt = now; retried = { ...job }; return items;
  });
  const retriedJob = retried as AutomationJob | null;
  if (retriedJob) await appendAutomationAudit({ correlationId: retriedJob.operationId, operationId: retriedJob.operationId, jobId: retriedJob.id, operationType: 'JOB_RETRIED', actor,
    previousState: 'FAILED', nextState: 'PENDING', risk: retriedJob.riskLevel, reasons: [], dryRun: retriedJob.dryRun, attempts: retriedJob.attemptCount });
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
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.completedAt) return undefined;
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > nowMs) throw new Error('HEALTHY_JOB_LEASE_TAKEOVER_FORBIDDEN');
    const retry = job.attemptCount < job.maxAttempts;
    job.status = retry ? 'RETRY_SCHEDULED' : 'FAILED';
    job.nextRetryAt = retry ? new Date(nowMs + retryDelayMs(job.type, job.attemptCount)).toISOString() : undefined;
    job.lastErrorCode = 'LEASE_EXPIRED'; job.lastErrorCategory = 'PROVIDER_TIMEOUT';
    job.lastErrorMessage = 'Lease job đã hết hạn và được worker owner có fencing hợp lệ phục hồi.';
    job.retryable = retry; job.deadLetterReason = retry ? undefined : 'PROVIDER_TIMEOUT:LEASE_EXPIRED';
    job.claimedBy = undefined; job.claimedAt = undefined; job.leaseExpiresAt = undefined; job.updatedAt = now;
    if (!retry) job.completedAt = now;
    recovered = structuredClone(job);
    return items;
  });
  const result = recovered as AutomationJob | null;
  if (result) await appendAutomationAudit({ correlationId: result.operationId, operationId: `${result.operationId}:stale-recovery:${ownership.fencingToken}`.slice(0, 160), jobId: result.id, operationType: 'STALE_JOB_RECOVERED', actor, previousState: 'RUNNING', nextState: result.status, risk: 'MEDIUM', reasons: ['LEASE_EXPIRED', `fencing:${ownership.fencingToken}`], dryRun: result.dryRun, attempts: result.attemptCount });
  return result;
}

export async function approveAutomationJob(id: string, actor: string, reason: string, approve: boolean): Promise<AutomationJob | null> {
  let changed: AutomationJob | null = null; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'WAITING_APPROVAL' || job.riskLevel === 'BLOCKER') return undefined;
    if (!job.approvalExpiresAt || Date.parse(job.approvalExpiresAt) <= Date.now()) {
      job.approvalStatus = 'EXPIRED'; job.status = 'CANCELLED'; job.cancelledAt = now; job.lastErrorCode = 'APPROVAL_EXPIRED';
    } else if (approve) {
      job.approvalStatus = 'APPROVED'; job.approvedBy = actor; job.approvalReason = sanitizeErrorMessage(reason); job.status = 'PENDING';
    } else {
      job.approvalStatus = 'REJECTED'; job.approvedBy = actor; job.approvalReason = sanitizeErrorMessage(reason); job.status = 'CANCELLED'; job.cancelledAt = now;
    }
    job.updatedAt = now; changed = { ...job }; return items;
  });
  const changedJob = changed as AutomationJob | null;
  if (changedJob) await appendAutomationAudit({ correlationId: changedJob.operationId, operationId: changedJob.operationId, jobId: changedJob.id, operationType: approve ? 'JOB_APPROVED' : 'JOB_REJECTED', actor,
    previousState: 'WAITING_APPROVAL', nextState: changedJob.status, risk: changedJob.riskLevel, reasons: [reason], dryRun: changedJob.dryRun, attempts: changedJob.attemptCount });
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
  const jobs = await readCollection<AutomationJob>(JOBS);
  const counts = Object.fromEntries(['PENDING','WAITING_APPROVAL','WAITING_FOR_MANUAL_INPUT','WAITING_CHILDREN','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED','BLOCKED','PAUSED'].map(status => [status, jobs.filter(job => job.status === status).length]));
  return { total: jobs.length, ...counts } as Record<AutomationJobStatus | 'total', number>;
}
