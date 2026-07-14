import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { sanitizeErrorMessage } from '@/lib/safety/operationGuard';
import type {
  AiUsageRecord,
  ApprovalStatus,
  AutomationAuditEvent,
  AutomationControlState,
  AutomationJob,
  AutomationJobStatus,
  AutomationJobType,
  AutomationRiskLevel,
  CircuitBreakerRecord,
} from './types';

const JOBS = 'automation-jobs';
const CONTROL = 'automation-control';
const AUDIT = 'automation-audit';
const USAGE = 'automation-ai-usage';
const CIRCUITS = 'automation-circuits';
const MAX_PAYLOAD_BYTES = 16 * 1024;
const SECRET_KEY = /token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|credential/i;
const TERMINAL = new Set<AutomationJobStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);

export const DEFAULT_CONTROL: AutomationControlState = {
  id: 'automation-control',
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

function vietnamDay(now = Date.now()): string {
  return new Date(now + 7 * 60 * 60_000).toISOString().slice(0, 10);
}

export async function appendAutomationAudit(input: Omit<AutomationAuditEvent, 'id' | 'createdAt'>): Promise<void> {
  const event: AutomationAuditEvent = {
    ...input,
    id: generateId(),
    result: sanitizeAutomationData(input.result) as Record<string, unknown> | undefined,
    reasons: input.reasons.map(reason => sanitizeErrorMessage(reason)).slice(0, 20),
    createdAt: new Date().toISOString(),
  };
  await runTransaction<AutomationAuditEvent>(AUDIT, items => [...items.slice(-4_999), event]);
}

export async function getAutomationControl(): Promise<AutomationControlState> {
  return (await readCollection<AutomationControlState>(CONTROL))[0] || { ...DEFAULT_CONTROL };
}

export async function updateAutomationControl(
  updates: Partial<Pick<AutomationControlState, 'workerPaused' | 'schedulerPaused' | 'killSwitch' | 'reason' | 'changedBy' | 'workerHeartbeatAt' | 'workerId' | 'workerCurrentJobId' | 'schedulerHeartbeatAt' | 'schedulerLastRunAt' | 'schedulerNextRunAt'>>,
  actor = 'system',
): Promise<AutomationControlState> {
  let previous = await getAutomationControl();
  let next = previous;
  const now = new Date().toISOString();
  await runTransaction<AutomationControlState>(CONTROL, items => {
    previous = items[0] || { ...DEFAULT_CONTROL };
    next = { ...previous, ...updates, id: 'automation-control', updatedAt: now };
    if ('killSwitch' in updates || 'workerPaused' in updates || 'schedulerPaused' in updates) {
      next.changedAt = now;
      next.changedBy = actor;
    }
    return [next];
  });
  if ('killSwitch' in updates || 'workerPaused' in updates || 'schedulerPaused' in updates) {
    await appendAutomationAudit({
      correlationId: generateId(), operationId: generateId(), operationType: 'CONTROL_CHANGED', actor,
      target: 'automation-control', previousState: JSON.stringify({ workerPaused: previous.workerPaused, schedulerPaused: previous.schedulerPaused, killSwitch: previous.killSwitch }),
      nextState: JSON.stringify({ workerPaused: next.workerPaused, schedulerPaused: next.schedulerPaused, killSwitch: next.killSwitch }),
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
  operationId?: string;
  requestedBy: string;
  riskLevel?: AutomationRiskLevel;
  dryRun?: boolean;
  maxAttempts?: number;
  scheduledAt?: string;
  approvalReason?: string;
}

export async function createAutomationJob(input: CreateAutomationJobInput): Promise<{ job: AutomationJob; created: boolean; code: 'CREATED' | 'ALREADY_PROCESSED' | 'IN_PROGRESS' }> {
  const key = input.idempotencyKey.trim();
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(key)) throw new Error('INVALID_IDEMPOTENCY_KEY');
  const payload = sanitizeAutomationData(input.payload || {}) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const risk = input.riskLevel || 'LOW';
  const now = new Date().toISOString();
  let response!: { job: AutomationJob; created: boolean; code: 'CREATED' | 'ALREADY_PROCESSED' | 'IN_PROGRESS' };
  await runTransaction<AutomationJob>(JOBS, items => {
    const existing = items.find(item => item.type === input.type && item.idempotencyKey === key);
    if (existing) {
      response = { job: existing, created: false, code: existing.status === 'SUCCEEDED' ? 'ALREADY_PROCESSED' : 'IN_PROGRESS' };
      return undefined;
    }
    const approvalStatus: ApprovalStatus = risk === 'HIGH' ? 'PENDING' : 'NOT_REQUIRED';
    const status: AutomationJobStatus = risk === 'BLOCKER' ? 'BLOCKED' : risk === 'HIGH' ? 'WAITING_APPROVAL' : 'PENDING';
    const job: AutomationJob = {
      id: generateId(), type: input.type, status, payload, priority: Math.max(0, Math.min(100, input.priority ?? 50)),
      idempotencyKey: key, operationId: input.operationId || generateId(), requestedBy: input.requestedBy,
      approvalStatus, approvalReason: input.approvalReason, approvalExpiresAt: risk === 'HIGH' ? new Date(Date.now() + 24 * 60 * 60_000).toISOString() : undefined,
      riskLevel: risk, dryRun: input.dryRun === true, attemptCount: 0, maxAttempts: Math.max(1, Math.min(5, input.maxAttempts ?? 3)),
      scheduledAt: input.scheduledAt && Number.isFinite(Date.parse(input.scheduledAt)) ? input.scheduledAt : now,
      createdAt: now, updatedAt: now,
    };
    items.push(job);
    response = { job, created: true, code: 'CREATED' };
    return items;
  });
  if (response.created) {
    await appendAutomationAudit({ correlationId: response.job.operationId, operationId: response.job.operationId, jobId: response.job.id,
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
  return { ...safe, result: sanitizeAutomationData(job.result) };
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * Math.max(250, base * 0.15));
}

export function isRetryableAutomationError(code: string): boolean {
  return ['TIMEOUT', 'RATE_LIMITED', 'NETWORK_ERROR', 'SERVICE_UNAVAILABLE', 'TEMPORARY_ERROR'].includes(code);
}

export async function claimAutomationJobs(workerId: string, limit = 1, leaseMs = 60_000, nowMs = Date.now()): Promise<AutomationJob[]> {
  const control = await getAutomationControl();
  if (control.workerPaused || control.killSwitch) return [];
  const claimed: AutomationJob[] = [];
  const now = new Date(nowMs).toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    for (const item of items) {
      if (item.status === 'RUNNING' && item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= nowMs) {
        item.status = item.attemptCount < item.maxAttempts ? 'RETRY_SCHEDULED' : 'FAILED';
        item.nextRetryAt = item.status === 'RETRY_SCHEDULED' ? new Date(nowMs + retryDelayMs(item.attemptCount)).toISOString() : undefined;
        item.lastErrorCode = 'LEASE_EXPIRED'; item.lastErrorMessage = 'Bộ xử lý mất tín hiệu trước khi hoàn tất.'; item.claimedBy = undefined; item.updatedAt = now;
      }
      if (item.status === 'RETRY_SCHEDULED' && item.nextRetryAt && Date.parse(item.nextRetryAt) <= nowMs) item.status = 'PENDING';
    }
    const due = items.filter(item => item.status === 'PENDING' && Date.parse(item.scheduledAt) <= nowMs)
      .sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, Math.max(0, Math.min(limit, 10)));
    for (const item of due) {
      item.status = 'RUNNING'; item.claimedBy = workerId; item.claimedAt = now; item.heartbeatAt = now;
      item.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString(); item.startedAt ||= now; item.attemptCount += 1; item.updatedAt = now;
      claimed.push({ ...item, payload: { ...item.payload } });
    }
    return items;
  });
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
    job.leaseExpiresAt = undefined; job.heartbeatAt = now; job.updatedAt = now; completed = { ...job }; return items;
  });
  const completedJob = completed as AutomationJob | null;
  if (completedJob) await appendAutomationAudit({ correlationId: completedJob.operationId, operationId: completedJob.operationId, jobId: completedJob.id, operationType: completedJob.type,
    actor: workerId, previousState: 'RUNNING', nextState: 'SUCCEEDED', risk: completedJob.riskLevel, result, reasons: [], dryRun: completedJob.dryRun, attempts: completedJob.attemptCount });
  return completedJob;
}

export async function failAutomationJob(id: string, workerId: string, code: string, error: unknown): Promise<AutomationJob | null> {
  let failed: AutomationJob | null = null; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'RUNNING' || job.claimedBy !== workerId) return undefined;
    const retry = isRetryableAutomationError(code) && job.attemptCount < job.maxAttempts;
    job.status = retry ? 'RETRY_SCHEDULED' : 'FAILED'; job.nextRetryAt = retry ? new Date(Date.now() + retryDelayMs(job.attemptCount)).toISOString() : undefined;
    job.lastErrorCode = code; job.lastErrorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
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
    if (!job || TERMINAL.has(job.status) || (job.status === 'RUNNING' && !job.dryRun)) return undefined;
    const previous = job.status; job.status = 'CANCELLED'; job.cancelledAt = now; job.completedAt = now; job.updatedAt = now;
    job.lastErrorCode = 'CANCELLED'; job.lastErrorMessage = sanitizeErrorMessage(reason); cancelled = { ...job, result: { previousState: previous } }; return items;
  });
  const cancelledJob = cancelled as AutomationJob | null;
  if (cancelledJob) await appendAutomationAudit({ correlationId: cancelledJob.operationId, operationId: cancelledJob.operationId, jobId: cancelledJob.id, operationType: 'JOB_CANCELLED', actor,
    previousState: String(cancelledJob.result?.previousState || ''), nextState: 'CANCELLED', risk: cancelledJob.riskLevel, reasons: [reason], dryRun: cancelledJob.dryRun, attempts: cancelledJob.attemptCount });
  return cancelledJob;
}

export async function retryAutomationJob(id: string, actor: string): Promise<AutomationJob | null> {
  let retried: AutomationJob | null = null; const now = new Date().toISOString();
  await runTransaction<AutomationJob>(JOBS, items => {
    const job = items.find(item => item.id === id);
    if (!job || job.status !== 'FAILED' || job.attemptCount >= job.maxAttempts) return undefined;
    job.status = 'PENDING'; job.nextRetryAt = undefined; job.completedAt = undefined; job.updatedAt = now; retried = { ...job }; return items;
  });
  const retriedJob = retried as AutomationJob | null;
  if (retriedJob) await appendAutomationAudit({ correlationId: retriedJob.operationId, operationId: retriedJob.operationId, jobId: retriedJob.id, operationType: 'JOB_RETRIED', actor,
    previousState: 'FAILED', nextState: 'PENDING', risk: retriedJob.riskLevel, reasons: [], dryRun: retriedJob.dryRun, attempts: retriedJob.attemptCount });
  return retriedJob;
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
  const day = vietnamDay(now); const existing = (await readCollection<AiUsageRecord>(USAGE)).find(item => item.day === day);
  return existing || { id: day, day, requests: 0, tokens: 0, fallbacks: 0, blocked: 0, requestLimit: 100, tokenLimit: 100_000, updatedAt: new Date(now).toISOString() };
}

export async function reserveAiUsage(requests: number, tokens: number, now = Date.now()): Promise<{ allowed: boolean; usage: AiUsageRecord }> {
  const day = vietnamDay(now); let result!: { allowed: boolean; usage: AiUsageRecord };
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
  const counts = Object.fromEntries(['PENDING','WAITING_APPROVAL','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED','BLOCKED','PAUSED'].map(status => [status, jobs.filter(job => job.status === status).length]));
  return { total: jobs.length, ...counts } as Record<AutomationJobStatus | 'total', number>;
}
