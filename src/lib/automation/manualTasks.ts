import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { appendAutomationAudit, getAutomationJob, resumeAutomationJobFromManual, sanitizeAutomationData } from './store';
import type { AutomationRiskLevel, EvidenceClaim, ManualTask, ManualTaskFieldSchema, ManualTaskStatus } from './types';

const COLLECTION = 'automation-manual-tasks';
const SECRET_KEY = /token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|credential/i;
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._~-]{12,}|AIza[a-z0-9_-]{20,}|sk-[a-z0-9_-]{16,})/i;
const HIGH_RISK_CAPABILITY = /PUBLISH|MERGE|ARCHIVE|DELETE/i;
const MAX_TASKS = 5_000;

export interface CreateManualTaskInput {
  jobId: string;
  operationId: string;
  capability: string;
  targetType: string;
  targetId?: string;
  title: string;
  reasonCode: string;
  instructions: string[];
  verifiedFacts?: Record<string, unknown>;
  evidence?: EvidenceClaim[];
  missingInformation: string[];
  questions: string[];
  expectedInputSchema: { version: 1; fields: ManualTaskFieldSchema[] };
  validationRules?: string[];
  risk?: AutomationRiskLevel;
  approvalRequired?: boolean;
  resumeCheckpoint: string;
  expiresInMs?: number;
  actor: string;
}

function cleanText(value: string, maximumLength = 1_000): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximumLength);
}

function assertSafeSchema(fields: ManualTaskFieldSchema[]): void {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 20) throw new Error('INVALID_MANUAL_SCHEMA');
  const names = new Set<string>();
  for (const field of fields) {
    if (!/^[a-z][a-zA-Z0-9_]{1,50}$/.test(field.name) || SECRET_KEY.test(field.name) || names.has(field.name)) throw new Error('INVALID_MANUAL_SCHEMA');
    if (!field.label?.trim() || field.label.length > 100) throw new Error('INVALID_MANUAL_SCHEMA');
    if (!['string', 'number', 'boolean', 'string_array'].includes(field.type)) throw new Error('INVALID_MANUAL_SCHEMA');
    names.add(field.name);
  }
}

function validateSubmittedInput(task: ManualTask, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_MANUAL_INPUT');
  const input = raw as Record<string, unknown>;
  const allowed = new Set(task.expectedInputSchema.fields.map(field => field.name));
  if (Object.keys(input).some(key => !allowed.has(key) || SECRET_KEY.test(key))) throw new Error('INVALID_MANUAL_INPUT');
  const output: Record<string, unknown> = {};
  for (const field of task.expectedInputSchema.fields) {
    const value = input[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new Error(`MANUAL_FIELD_REQUIRED:${field.name}`);
      continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string') throw new Error(`MANUAL_FIELD_INVALID:${field.name}`);
      const cleaned = cleanText(value, field.maximumLength || 2_000);
      if (SENSITIVE_VALUE.test(cleaned)) throw new Error('SENSITIVE_INPUT_REJECTED');
      if (field.options && !field.options.includes(cleaned)) throw new Error(`MANUAL_FIELD_INVALID:${field.name}`);
      output[field.name] = cleaned;
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) throw new Error(`MANUAL_FIELD_INVALID:${field.name}`);
      output[field.name] = value;
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`MANUAL_FIELD_INVALID:${field.name}`);
      output[field.name] = value;
    } else {
      if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string')) throw new Error(`MANUAL_FIELD_INVALID:${field.name}`);
      const cleaned = value.map(item => cleanText(item as string, field.maximumLength || 500));
      if (cleaned.some(item => SENSITIVE_VALUE.test(item))) throw new Error('SENSITIVE_INPUT_REJECTED');
      output[field.name] = cleaned;
    }
  }
  return sanitizeAutomationData(output) as Record<string, unknown>;
}

export async function createManualTask(input: CreateManualTaskInput): Promise<ManualTask> {
  if (HIGH_RISK_CAPABILITY.test(input.capability)) throw new Error('MANUAL_HIGH_RISK_ACTION_BLOCKED');
  assertSafeSchema(input.expectedInputSchema.fields);
  const job = await getAutomationJob(input.jobId);
  if (!job || job.operationId !== input.operationId || job.status !== 'RUNNING') throw new Error('MANUAL_JOB_NOT_RUNNING');
  const now = new Date();
  const expiresInMs = Math.max(60 * 60_000, Math.min(7 * 24 * 60 * 60_000, input.expiresInMs || 24 * 60 * 60_000));
  const task: ManualTask = {
    id: generateId(),
    operationId: input.operationId,
    jobId: input.jobId,
    capability: cleanText(input.capability, 100),
    targetType: cleanText(input.targetType, 100),
    targetId: input.targetId ? cleanText(input.targetId, 200) : undefined,
    title: cleanText(input.title, 160),
    reasonCode: cleanText(input.reasonCode, 100),
    instructions: input.instructions.slice(0, 20).map(value => cleanText(value, 500)),
    verifiedFacts: sanitizeAutomationData(input.verifiedFacts || {}) as Record<string, unknown>,
    evidence: (sanitizeAutomationData(input.evidence || []) as EvidenceClaim[]).slice(0, 50),
    missingInformation: input.missingInformation.slice(0, 30).map(value => cleanText(value, 300)),
    questions: input.questions.slice(0, 20).map(value => cleanText(value, 300)),
    expectedInputSchema: { version: 1, fields: input.expectedInputSchema.fields.map(field => ({ ...field, label: cleanText(field.label, 100), options: field.options?.slice(0, 30).map(option => cleanText(option, 100)) })) },
    validationRules: (input.validationRules || []).slice(0, 20).map(value => cleanText(value, 300)),
    risk: input.risk || 'MEDIUM',
    approvalRequired: input.approvalRequired === true,
    resumeCheckpoint: cleanText(input.resumeCheckpoint, 200),
    status: 'WAITING',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
  };
  await runTransaction<ManualTask>(COLLECTION, items => [...items.slice(-(MAX_TASKS - 1)), task]);
  await appendAutomationAudit({ correlationId: task.operationId, operationId: task.operationId, jobId: task.jobId, operationType: 'MANUAL_TASK_CREATED', actor: input.actor, target: task.id, nextState: task.status, risk: task.risk, reasons: [task.reasonCode], dryRun: job.dryRun, attempts: job.attemptCount });
  return task;
}

export async function getManualTask(id: string): Promise<ManualTask | null> {
  return (await readCollection<ManualTask>(COLLECTION)).find(task => task.id === id) || null;
}

export async function listManualTasks(options: { status?: ManualTaskStatus; page: number; pageSize: number }) {
  await expireManualTasks();
  let items = await readCollection<ManualTask>(COLLECTION);
  if (options.status) items = items.filter(task => task.status === options.status);
  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / options.pageSize));
  const page = Math.min(options.page, totalPages);
  return { items: items.slice((page - 1) * options.pageSize, page * options.pageSize), pagination: { page, pageSize: options.pageSize, totalItems, totalPages } };
}

export async function expireManualTasks(nowMs = Date.now()): Promise<number> {
  let expired = 0;
  await runTransaction<ManualTask>(COLLECTION, items => {
    for (const task of items) {
      if (['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(task.status) && Date.parse(task.expiresAt) <= nowMs) {
        task.status = 'EXPIRED';
        task.updatedAt = new Date(nowMs).toISOString();
        expired += 1;
      }
    }
    return expired ? items : undefined;
  });
  return expired;
}

export async function submitManualTask(id: string, rawInput: unknown, actor: string): Promise<ManualTask> {
  const existing = await getManualTask(id);
  if (!existing) throw new Error('MANUAL_TASK_NOT_FOUND');
  if (Date.parse(existing.expiresAt) <= Date.now()) {
    await expireManualTasks();
    throw new Error('MANUAL_TASK_EXPIRED');
  }
  if (!['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(existing.status)) throw new Error('MANUAL_TASK_INVALID_STATE');
  const submittedInput = validateSubmittedInput(existing, rawInput);
  let submitted: ManualTask | null = null;
  const now = new Date().toISOString();
  await runTransaction<ManualTask>(COLLECTION, items => {
    const task = items.find(item => item.id === id);
    if (!task || !['WAITING', 'DRAFT', 'REVISION_REQUIRED'].includes(task.status)) return undefined;
    task.submittedInput = submittedInput;
    task.submittedBy = actor;
    task.submittedAt = now;
    task.status = 'SUBMITTED';
    task.updatedAt = now;
    submitted = { ...task };
    return items;
  });
  const submittedTask = submitted as ManualTask | null;
  if (!submittedTask) throw new Error('MANUAL_TASK_INVALID_STATE');
  const resumed = await resumeAutomationJobFromManual(submittedTask.jobId, actor, submittedTask.id);
  if (!resumed) {
    await runTransaction<ManualTask>(COLLECTION, items => {
      const task = items.find(item => item.id === id);
      if (task?.status === 'SUBMITTED') { task.status = 'REVISION_REQUIRED'; task.updatedAt = new Date().toISOString(); }
      return items;
    });
    throw new Error('MANUAL_RESUME_FAILED');
  }
  await appendAutomationAudit({ correlationId: submittedTask.operationId, operationId: submittedTask.operationId, jobId: submittedTask.jobId, operationType: 'MANUAL_INPUT_SUBMITTED', actor, target: submittedTask.id, previousState: existing.status, nextState: 'SUBMITTED', risk: submittedTask.risk, reasons: [], dryRun: resumed.dryRun, attempts: resumed.attemptCount });
  return submittedTask;
}

export async function completeManualTask(id: string, jobId: string, workerId: string): Promise<ManualTask | null> {
  let completed: ManualTask | null = null;
  await runTransaction<ManualTask>(COLLECTION, items => {
    const task = items.find(item => item.id === id && item.jobId === jobId);
    if (!task || task.status !== 'SUBMITTED') return undefined;
    task.status = 'COMPLETED';
    task.updatedAt = new Date().toISOString();
    completed = { ...task };
    return items;
  });
  const completedTask = completed as ManualTask | null;
  if (completedTask) await appendAutomationAudit({ correlationId: completedTask.operationId, operationId: completedTask.operationId, jobId, operationType: 'MANUAL_TASK_COMPLETED', actor: workerId, target: id, previousState: 'SUBMITTED', nextState: 'COMPLETED', risk: completedTask.risk, reasons: [], dryRun: false, attempts: 0 });
  return completedTask;
}
