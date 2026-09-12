import { createHash } from 'node:crypto';
import type { AutomationJob, AutomationJobStatus } from '../automation/types';

export const EVENT_LIMITS = { cronBatch: 10, queueBatch: 10, messageBytes: 1024, payloadBytes: 512,
  attempts: 3, dispatches: 5, claimMs: 60_000, redeliveryMs: 60_000, lifetimeMs: 86_400_000 } as const;
export type EventErrorClass = 'RETRYABLE' | 'FINAL' | 'QUARANTINE';
export class EventJobError extends Error {
  constructor(readonly code: string, readonly classification: EventErrorClass) { super(code); }
}
export type EventJobStatus = Extract<AutomationJobStatus, 'PENDING' | 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED'>;
export interface EventJobInput {
  type: 'CAPTURE_PRICE_HISTORY' | 'AGGREGATE_GROWTH_METRICS';
  idempotencyKey: string;
  payload: { productId: string };
}
export interface EventJob extends Pick<AutomationJob, 'id' | 'type' | 'idempotencyKey' | 'createdAt' | 'attemptCount'> {
  status: EventJobStatus;
  payload: { productId: string };
  payloadVersion: 1;
  claimToken: string | null;
  leaseExpiresAt: number;
  availableAt: number;
  expiresAt: number;
  dispatchCount: number;
  dispatchAt: number;
  lastErrorCode: string | null;
  result: { snapshotCreated: boolean } | { revenueEvents: number; lastSequence: number } | null;
}
export interface JobMessage {
  jobId: string;
  jobType: EventJobInput['type'];
  idempotencyKey: string;
  attempt: number;
  createdAt: string;
  payloadVersion: 1;
}
export interface QueueBinding { send(message: JobMessage, options?: { contentType: 'json' }): Promise<void> }
export interface QueueDelivery { id: string; body: unknown; attempts: number; ack(): void; retry(options: { delaySeconds: number }): void }
export interface QueueBatch { queue: string; messages: readonly QueueDelivery[] }
export interface ScheduledTaskInput extends Omit<EventJobInput, 'idempotencyKey'> { id: string; nextRunAt: number; intervalMs: number; enabled: boolean }
export interface ScheduledTask extends ScheduledTaskInput { revision: number }
export interface EventTickResult { due: number; created: number; enqueued: number }

export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function jobId(key: string) { return `cf-${digest(key)}`; }
export function validTime(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000) throw new EventJobError('INVALID_EVENT_TIME', 'QUARANTINE');
  return value;
}
function objectKeys(value: unknown, names: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.sort().join(',');
}
export function validatePayload(value: unknown): asserts value is EventJobInput['payload'] {
  if (!objectKeys(value, ['productId']) || typeof value.productId !== 'string' || !/^[a-z0-9-]{1,160}$/i.test(value.productId)) {
    throw new EventJobError('UNSAFE_JOB_PAYLOAD', 'QUARANTINE');
  }
}
export function validateInput(input: EventJobInput) {
  if (!input || !['CAPTURE_PRICE_HISTORY','AGGREGATE_GROWTH_METRICS'].includes(input.type)) throw new EventJobError('UNKNOWN_JOB_TYPE', 'QUARANTINE');
  if (typeof input.idempotencyKey !== 'string' || !/^[a-z0-9:_-]{1,200}$/i.test(input.idempotencyKey)) throw new EventJobError('INVALID_IDEMPOTENCY_KEY', 'QUARANTINE');
  validatePayload(input.payload);
  if (input.type === 'AGGREGATE_GROWTH_METRICS' && input.payload.productId !== 'revenue-all') throw new EventJobError('INVALID_REVENUE_SCOPE', 'QUARANTINE');
}
export function makeMessage(job: EventJob): JobMessage {
  const message = { jobId: job.id, jobType: job.type, idempotencyKey: job.idempotencyKey,
    attempt: Math.min(job.attemptCount + 1, EVENT_LIMITS.attempts), createdAt: job.createdAt, payloadVersion: job.payloadVersion };
  validateMessage(message); return message;
}
export function validateMessage(value: unknown): asserts value is JobMessage {
  if (!objectKeys(value, ['jobId', 'jobType', 'idempotencyKey', 'attempt', 'createdAt', 'payloadVersion'])) throw new EventJobError('MALFORMED_MESSAGE', 'QUARANTINE');
  if (!['CAPTURE_PRICE_HISTORY','AGGREGATE_GROWTH_METRICS'].includes(String(value.jobType))) throw new EventJobError('UNKNOWN_JOB_TYPE', 'QUARANTINE');
  if (typeof value.idempotencyKey !== 'string' || !/^[a-z0-9:_-]{1,200}$/i.test(value.idempotencyKey)
    || value.jobId !== jobId(value.idempotencyKey) || value.payloadVersion !== 1
    || !Number.isInteger(value.attempt) || Number(value.attempt) < 1 || Number(value.attempt) > EVENT_LIMITS.attempts
    || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt))) throw new EventJobError('MALFORMED_MESSAGE', 'QUARANTINE');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > EVENT_LIMITS.messageBytes) throw new EventJobError('MESSAGE_TOO_LARGE', 'QUARANTINE');
}
export function classifyEventError(error: unknown): EventJobError {
  if (error instanceof EventJobError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'PROVIDER_RATE_LIMIT' || code === 'PROVIDER_TIMEOUT') return new EventJobError(String(code), 'RETRYABLE');
  if (code === 'VALIDATION_FAILED') return new EventJobError('VALIDATION_FAILED', 'FINAL');
  return new EventJobError('DEPENDENCY_UNAVAILABLE', 'RETRYABLE');
}
