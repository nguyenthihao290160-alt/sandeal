import type { JobQueueAdapter, SchedulerAdapter } from './types';
import { D1JobStore } from '../storage/d1/d1JobStore';
import { D1DealStore } from '../storage/d1/d1DealStore';
import { cloudflareContext, type CloudflareEnvironment } from '../runtime/cloudflare/context';
import { EVENT_LIMITS, EventJobError, makeMessage, validTime, validateInput,
  type EventJob, type EventJobInput, type EventTickResult, type QueueBinding } from './cloudflareContracts';

export function eventContext(env: CloudflareEnvironment) {
  if (env.SANDEAL_AUTOPILOT_ENABLED !== 'true') throw new EventJobError('AUTOPILOT_DISABLED', 'FINAL');
  const context = cloudflareContext(env);
  return { ...context, jobs: new D1JobStore(context.db) };
}
export function createCloudflareJobQueueAdapter(env: CloudflareEnvironment): JobQueueAdapter<EventJobInput, EventJob> & { dispatch(now: number): Promise<number> } {
  const { jobs } = eventContext(env);
  if (!env.JOB_QUEUE || typeof env.JOB_QUEUE.send !== 'function') throw new EventJobError('QUEUE_BINDING_UNAVAILABLE', 'RETRYABLE');
  const queue: QueueBinding = env.JOB_QUEUE;
  async function dispatch(now: number) {
    validTime(now); let enqueued = 0;
    for (const job of await jobs.dispatchDue(now)) {
      if (job.expiresAt <= now || job.attemptCount >= EVENT_LIMITS.attempts || job.dispatchCount >= EVENT_LIMITS.dispatches) {
        await jobs.retire(job, now, job.expiresAt <= now ? 'STALE_JOB' : job.attemptCount >= EVENT_LIMITS.attempts ? 'ATTEMPTS_EXHAUSTED' : 'QUEUE_DISPATCH_EXHAUSTED'); continue;
      }
      const reserved = await jobs.reserveDispatch(job, now); if (!reserved) continue;
      try { await queue.send(makeMessage(reserved), { contentType: 'json' }); enqueued++; }
      catch { throw new EventJobError('QUEUE_SEND_FAILED', 'RETRYABLE'); }
    }
    return enqueued;
  }
  return { id: 'cloudflare-d1-outbox-queue', runtime: 'cloudflare', dispatch,
    async enqueueJob(input) { const now = Date.now(), result = await jobs.createJob(input, now); await dispatch(now); return result; },
    async enqueueJobs(inputs) {
      if (inputs.length > EVENT_LIMITS.queueBatch) throw new EventJobError('QUEUE_BATCH_TOO_LARGE', 'QUARANTINE');
      const now = Date.now(), results = [];
      // Validate the entire bounded batch before its first write.
      inputs.forEach(validateInput);
      for (const input of inputs) results.push(await jobs.createJob(input, now));
      await dispatch(now); return results;
    } };
}
export function createCloudflareSchedulerAdapter(env: CloudflareEnvironment): SchedulerAdapter<EventTickResult> {
  const { jobs, db } = eventContext(env), queue = createCloudflareJobQueueAdapter(env);
  return { id: 'cloudflare-indexed-cron', runtime: 'cloudflare', async tick(now = Date.now()) {
    validTime(now); const tasks = await jobs.due(now); let created = 0;
    for (const task of tasks) if (await jobs.materialize(task, now)) created++;
    const deals = env.SANDEAL_DEAL_INTELLIGENCE_ENABLED === 'true' ? await new D1DealStore(db).materializeDue(now) : 0;
    created += deals;
    const enqueued = await queue.dispatch(now);
    return { due: tasks.length + deals, created, enqueued };
  } };
}
