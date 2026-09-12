import { randomUUID } from 'node:crypto';
import type { D1Database, D1Statement, SqlValue } from './database';
import type { PriceSnapshot } from '../../product-intelligence/types';
import { D1AffiliateStore } from './d1AffiliateStore';
import { EVENT_LIMITS, EventJobError, digest, jobId, validateInput, validTime,
  type EventJob, type EventJobInput, type ScheduledTask, type ScheduledTaskInput } from '../../platform/cloudflareContracts';

type Row = Record<string, string | number | null>;
function decode(row: Row): EventJob {
  return { id: String(row.id), type: row.job_type as EventJob['type'], idempotencyKey: String(row.idempotency_key),
    payload: JSON.parse(String(row.payload)), payloadVersion: Number(row.payload_version) as 1, status: row.status as EventJob['status'],
    createdAt: String(row.created_at), attemptCount: Number(row.attempt_count), claimToken: row.claim_token as string | null,
    leaseExpiresAt: Number(row.lease_expires_at), availableAt: Number(row.available_at), expiresAt: Number(row.expires_at),
    dispatchCount: Number(row.dispatch_count), dispatchAt: Number(row.dispatch_at), lastErrorCode: row.last_error_code as string | null,
    result: row.result ? JSON.parse(String(row.result)) : null };
}
export class D1JobStore {
  constructor(private readonly db: D1Database) {}
  private statement(sql: string, values: SqlValue[] = []): D1Statement { return this.db.prepare(sql).bind(...values); }
  private async query(sql: string, values: SqlValue[] = []) {
    try { const result = await this.statement(sql, values).all<Row>(); if (!result.success) throw new Error(); return result.results; }
    catch { throw new EventJobError('D1_JOB_OPERATION_FAILED', 'RETRYABLE'); }
  }
  private async batch(statements: D1Statement[]) {
    try { const result = await this.db.batch<Row>(statements); if (result.some(row => !row.success)) throw new Error(); return result; }
    catch { throw new EventJobError('D1_JOB_OPERATION_FAILED', 'RETRYABLE'); }
  }
  async get(id: string) { const [row] = await this.query('SELECT * FROM automation_jobs WHERE id=? LIMIT 1', [id]); return row ? decode(row) : null; }
  async createJob(input: EventJobInput, now: number) {
    validateInput(input); validTime(now);
    const id = jobId(input.idempotencyKey), payload = JSON.stringify(input.payload);
    const rows = await this.query(`INSERT INTO automation_jobs(id,job_type,idempotency_key,payload_version,payload,status,created_at,available_at,expires_at,dispatch_at)
      VALUES(?,?,?,1,?,'PENDING',?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
    [id, input.type, input.idempotencyKey, payload, new Date(now).toISOString(), now, now + EVENT_LIMITS.lifetimeMs, now]);
    const job = rows[0] ? decode(rows[0]) : await this.get(id);
    if (!job || job.type !== input.type || JSON.stringify(job.payload) !== payload) throw new EventJobError('IDEMPOTENCY_CONFLICT', 'QUARANTINE');
    return { job, created: rows.length === 1, code: rows.length ? 'CREATED' as const : job.status === 'SUCCEEDED' ? 'ALREADY_PROCESSED' as const : 'IN_PROGRESS' as const };
  }
  async createTask(task: ScheduledTaskInput) {
    validateInput({ ...task, idempotencyKey: task.id }); validTime(task.nextRunAt);
    if (!/^[a-z0-9-]{1,160}$/i.test(task.id) || typeof task.enabled !== 'boolean' || !Number.isSafeInteger(task.intervalMs)
      || task.intervalMs < 60000 || task.intervalMs > 2678400000) throw new EventJobError('INVALID_SCHEDULE', 'QUARANTINE');
    await this.query(`INSERT INTO scheduled_tasks(id,job_type,payload,enabled,next_run_at,interval_ms) VALUES(?,?,?,?,?,?)`,
      [task.id, task.type, JSON.stringify(task.payload), task.enabled ? 1 : 0, task.nextRunAt, task.intervalMs]);
  }
  async due(now: number): Promise<ScheduledTask[]> {
    validTime(now);
    const rows = await this.query('SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id LIMIT ?', [now, EVENT_LIMITS.cronBatch]);
    return rows.map(row => ({ id: String(row.id), type: row.job_type as ScheduledTask['type'], payload: JSON.parse(String(row.payload)),
      enabled: !!row.enabled, nextRunAt: Number(row.next_run_at), intervalMs: Number(row.interval_ms), revision: Number(row.revision) }));
  }
  async materialize(task: ScheduledTask, now: number): Promise<boolean> {
    const key = `cron:${task.id}:${task.nextRunAt}`;
    validateInput({ type: task.type, payload: task.payload, idempotencyKey: key }); validTime(now);
    const id = jobId(key), next = task.nextRunAt + (Math.floor((now - task.nextRunAt) / task.intervalMs) + 1) * task.intervalMs;
    if (task.nextRunAt > now) return false;
    validTime(next);
    // One bounded transaction: persist the durable outbox job before moving its due task.
    const results = await this.batch([
      this.statement(`INSERT INTO automation_jobs(id,job_type,idempotency_key,payload_version,payload,status,created_at,available_at,expires_at,dispatch_at)
        SELECT ?,job_type,?,1,payload,'PENDING',?,?,?,? FROM scheduled_tasks
        WHERE id=? AND enabled=1 AND next_run_at=? AND revision=?
        ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
      [id, key, new Date(now).toISOString(), now, now + EVENT_LIMITS.lifetimeMs, now, task.id, task.nextRunAt, task.revision]),
      this.statement(`UPDATE scheduled_tasks SET next_run_at=?,revision=revision+1 WHERE id=? AND enabled=1 AND next_run_at=? AND revision=?
        AND EXISTS(SELECT 1 FROM automation_jobs WHERE id=? AND job_type=? AND payload=? LIMIT 1)`,
      [next, task.id, task.nextRunAt, task.revision, id, task.type, JSON.stringify(task.payload)]),
    ]);
    return results[0].results.length === 1;
  }
  async dispatchDue(now: number) {
    validTime(now);
    return (await this.query('SELECT * FROM automation_jobs WHERE dispatch_pending=1 AND dispatch_at<=? ORDER BY dispatch_at,id LIMIT ?', [now, EVENT_LIMITS.queueBatch])).map(decode);
  }
  async reserveDispatch(job: EventJob, now: number) {
    const [row] = await this.query(`UPDATE automation_jobs SET dispatch_count=dispatch_count+1,dispatch_at=?
      WHERE id=? AND dispatch_pending=1 AND dispatch_at<=? AND dispatch_count<? RETURNING *`,
    [now + EVENT_LIMITS.redeliveryMs, job.id, now, EVENT_LIMITS.dispatches]);
    return row ? decode(row) : null;
  }
  async claim(job: EventJob, now: number) {
    const [row] = await this.query(`UPDATE automation_jobs SET status='RUNNING',attempt_count=attempt_count+1,claim_token=?,lease_expires_at=?,dispatch_at=?
      WHERE id=? AND available_at<=? AND expires_at>? AND attempt_count<?
      AND (status IN ('PENDING','RETRY_SCHEDULED') OR (status='RUNNING' AND lease_expires_at<=?)) RETURNING *`,
    [randomUUID(), now + EVENT_LIMITS.claimMs, now + EVENT_LIMITS.claimMs, job.id, now, now, EVENT_LIMITS.attempts, now]);
    return row ? decode(row) : null;
  }
  async retire(job: EventJob, now: number, code: 'STALE_JOB' | 'ATTEMPTS_EXHAUSTED' | 'QUEUE_DISPATCH_EXHAUSTED') {
    await this.query(`UPDATE automation_jobs SET status=?,last_error_code=?,dispatch_pending=0,claim_token=NULL
      WHERE id=? AND status IN ('PENDING','RETRY_SCHEDULED','RUNNING') AND lease_expires_at<=?`,
    [code === 'STALE_JOB' ? 'BLOCKED' : 'FAILED', code, job.id, now]);
  }
  async fail(job: EventJob, now: number, error: EventJobError) {
    const retry = error.classification === 'RETRYABLE' && job.attemptCount < EVENT_LIMITS.attempts;
    const delay = Math.min(300, 30 * 2 ** (job.attemptCount - 1));
    const status = retry ? 'RETRY_SCHEDULED' : error.classification === 'QUARANTINE' ? 'BLOCKED' : 'FAILED';
    await this.query(`UPDATE automation_jobs SET status=?,last_error_code=?,available_at=?,dispatch_at=?,dispatch_pending=?,claim_token=NULL,lease_expires_at=0
      WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>?`,
    [status, error.code, now + delay * 1000, now + delay * 1000, retry ? 1 : 0, job.id, job.claimToken, now]);
    return { retry, delay };
  }
  async quarantine(deliveryId: string, reason: string, now: number) {
    // Never persist or log the untrusted message body, credentials, or exception text.
    await this.query('INSERT INTO automation_queue_quarantine(delivery_hash,reason_code,created_at) VALUES(?,?,?) ON CONFLICT(delivery_hash) DO NOTHING',
      [digest(deliveryId.slice(0,256)), reason, new Date(now).toISOString()]);
  }
  async commitRevenueSnapshot(job: EventJob, now: number, testOnly = false) {
    const prepared = await new D1AffiliateStore(this.db, testOnly).snapshotStatements();
    const guard = this.statement(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM automation_jobs
      WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>?) THEN '{}' ELSE 'STALE_CLAIM' END)`, [job.id,job.claimToken,now]);
    const result = await this.batch([guard,...prepared.statements,this.statement(`UPDATE automation_jobs SET status='SUCCEEDED',result=?,
      dispatch_pending=0,claim_token=NULL,lease_expires_at=0,last_error_code=NULL
      WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>? RETURNING id`,
    [JSON.stringify({ revenueEvents: prepared.eventsProcessed, lastSequence: prepared.lastSequence }),job.id,job.claimToken,now])]);
    if (!result.at(-1)?.results.length) throw new EventJobError('STALE_CLAIM','RETRYABLE');
  }
  async commitPriceSnapshot(job: EventJob, snapshot: PriceSnapshot, now: number) {
    const value = { ...snapshot, id: `price-${job.id}`, capturedAt: job.createdAt };
    const payload = JSON.stringify(value);
    if (new TextEncoder().encode(payload).byteLength > 4096) throw new EventJobError('SNAPSHOT_TOO_LARGE', 'FINAL');
    // Same adjacent-unchanged rule as DomainStorage.appendPriceSnapshot (forceCheckpoint=false).
    // The effect and SUCCEEDED record commit atomically; a stale claim cannot write either.
    const result = await this.batch([
      this.statement('SELECT payload FROM price_history WHERE product_id=? ORDER BY captured_at DESC,id DESC LIMIT 1', [value.productId]),
      this.statement(`INSERT INTO price_history(id,product_id,captured_at,source_hash,price,sale_price,operation_id,payload)
        SELECT ?,?,?,?,?,?,?,? FROM automation_jobs WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>?
        AND NOT EXISTS(SELECT 1 FROM price_history WHERE id=? LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM (SELECT source_hash FROM price_history WHERE product_id=? ORDER BY captured_at DESC,id DESC LIMIT 1) WHERE source_hash=?)`,
      [value.id, value.productId, value.capturedAt, value.sourceHash, value.price ?? null, value.salePrice ?? null, value.operationId, payload,
        job.id, job.claimToken, now, value.id, value.productId, value.sourceHash]),
      this.statement(`UPDATE automation_jobs SET status='SUCCEEDED',result=json_object('snapshotCreated',json(CASE WHEN changes()>0 THEN 'true' ELSE 'false' END)),
        dispatch_pending=0,claim_token=NULL,lease_expires_at=0,last_error_code=NULL WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_expires_at>? RETURNING id`,
      [job.id, job.claimToken, now]),
    ]);
    if (!result[2].results.length) throw new EventJobError('STALE_CLAIM', 'RETRYABLE');
    return { created: Number(result[1].meta?.changes) === 1, snapshot: value,
      previous: result[0].results[0] ? JSON.parse(String(result[0].results[0].payload)) as PriceSnapshot : undefined };
  }
}
