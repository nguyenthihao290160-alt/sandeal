import { capturePriceSnapshot } from '../../product-intelligence/priceHistory';
import { createCloudflareSchedulerAdapter, eventContext } from '../../platform/cloudflareAdapters';
import { EVENT_LIMITS, EventJobError, classifyEventError, validateInput, validateMessage, validTime,
  type QueueBatch, type QueueDelivery } from '../../platform/cloudflareContracts';
import type { CloudflareEnvironment } from './context';
import { MoneyError } from '../../affiliate/money/types';
import { D1DealStore } from '../../storage/d1/d1DealStore';
import { cloudflareDecisionStore, type DecisionRuntimeOptions } from './decision';
import { cloudflareOpportunityStore } from './opportunity';
import { cloudflareContentLifecycleStore } from './contentLifecycle';

export async function cloudflareScheduled(controller: { scheduledTime: number }, env: CloudflareEnvironment) {
  try { await createCloudflareSchedulerAdapter(env).tick(controller.scheduledTime); }
  catch (error) { throw classifyEventError(error); }
}
export async function consumeDelivery(delivery: QueueDelivery, env: CloudflareEnvironment, options: {
  now?: () => number; beforeCommit?: () => Promise<void>; afterCommit?: () => Promise<void>; moneyTestOnly?: boolean;
  decisionOptions?: DecisionRuntimeOptions;
} = {}) {
  const clock = options.now || Date.now, now = validTime(clock()), context = eventContext(env), { jobs } = context;
  const body = delivery.body;
  try { validateMessage(body); }
  catch (error) { await jobs.quarantine(delivery.id, classifyEventError(error).code, now); delivery.ack(); return 'QUARANTINED'; }
  const stored = await jobs.get(body.jobId);
  if (!stored || stored.type !== body.jobType || stored.idempotencyKey !== body.idempotencyKey || stored.createdAt !== body.createdAt
    || stored.payloadVersion !== body.payloadVersion || body.attempt > stored.attemptCount + 1) {
    await jobs.quarantine(delivery.id, 'MESSAGE_JOB_MISMATCH', now); delivery.ack(); return 'QUARANTINED';
  }
  if (['SUCCEEDED','FAILED','BLOCKED'].includes(stored.status)) { delivery.ack(); return stored.status === 'SUCCEEDED' ? 'DUPLICATE_SAFE' : 'TERMINAL'; }
  if (stored.expiresAt <= now || (stored.attemptCount >= EVENT_LIMITS.attempts && stored.leaseExpiresAt <= now)) {
    await jobs.retire(stored, now, stored.expiresAt <= now ? 'STALE_JOB' : 'ATTEMPTS_EXHAUSTED'); delivery.ack(); return 'TERMINAL';
  }
  const job = await jobs.claim(stored, now);
  if (!job) { delivery.retry({ delaySeconds: Math.max(1, Math.min(60, Math.ceil((Math.max(stored.availableAt, stored.leaseExpiresAt) - now) / 1000))) }); return 'DEFERRED'; }
  try {
    validateInput({ type: job.type, payload: job.payload, idempotencyKey: job.idempotencyKey });
    if (job.type === 'CONTENT_LIFECYCLE_EVALUATE') {
      await options.beforeCommit?.();
      await cloudflareContentLifecycleStore(env, options.moneyTestOnly === true).execute(job, validTime(clock()));
    } else if (job.type === 'DEAL_EVALUATE') {
      if (env.SANDEAL_DEAL_INTELLIGENCE_ENABLED !== 'true') throw new EventJobError('DEAL_INTELLIGENCE_DISABLED', 'FINAL');
      if (!env.JOB_QUEUE || typeof env.JOB_QUEUE.send !== 'function') throw new EventJobError('QUEUE_BINDING_UNAVAILABLE', 'RETRYABLE');
      const store = new D1DealStore(context.db, options.moneyTestOnly === true);
      const prepared = await store.prepare(job.payload.productId, (env.AFFILIATE_REDIRECT_HOSTS || '').split(',').map(host => host.trim()).filter(Boolean), now);
      const decisions = env.SANDEAL_DECISION_OS_ENABLED === 'true' ? cloudflareDecisionStore(env, context.db, options.moneyTestOnly === true, options.decisionOptions) : null;
      const opportunities = env.SANDEAL_OPPORTUNITY_ENABLED === 'true' && decisions ? cloudflareOpportunityStore(env, context.db, decisions, options.moneyTestOnly === true) : null;
      const decision = decisions ? await decisions.prepare(prepared) : null;
      const opportunity = opportunities && decision ? opportunities.prepare(prepared, decision) : null;
      await options.beforeCommit?.();
      if (opportunities && opportunity && decision) await opportunities.commit(prepared, decision, opportunity, validTime(clock()), job);
      else if (decisions && decision) await decisions.commit(prepared, decision, validTime(clock()), job);
      else await store.commit(prepared, validTime(clock()), job);
    } else if (job.type === 'AGGREGATE_GROWTH_METRICS') {
      await options.beforeCommit?.();
      await jobs.commitRevenueSnapshot(job, validTime(clock()), options.moneyTestOnly === true);
    } else {
    const product = await context.domain.getProduct(job.payload.productId);
    if (!product || !Number(product.value.price || product.value.salePrice || 0)) throw new EventJobError('PRODUCT_PRICE_REQUIRED', 'FINAL');
    await options.beforeCommit?.();
    await capturePriceSnapshot(product.value, job.idempotencyKey, { capturedAt: job.createdAt }, {
      ...context.domain,
      appendPriceSnapshot: snapshot => jobs.commitPriceSnapshot(job, snapshot, validTime(clock())),
    });
    }
  } catch (error) {
    // A lost response after an atomic commit must never downgrade SUCCEEDED.
    const latest = await jobs.get(job.id);
    if (latest?.status === 'SUCCEEDED') { delivery.ack(); return 'DUPLICATE_SAFE'; }
    const disposition = await jobs.fail(job, validTime(clock()), error instanceof MoneyError
      ? new EventJobError(error.code, error.classification) : classifyEventError(error));
    if (disposition.retry) delivery.retry({ delaySeconds: disposition.delay }); else delivery.ack();
    return disposition.retry ? 'RETRYABLE' : 'TERMINAL';
  }
  // Test hooks are dependency-injected only; no environment flag or HTTP route enables faults.
  await options.afterCommit?.();
  delivery.ack(); return 'SUCCEEDED';
}
export async function cloudflareQueue(batch: QueueBatch, env: CloudflareEnvironment) {
  if (batch.queue !== 'sandeal-local-jobs' || batch.messages.length > EVENT_LIMITS.queueBatch) throw new EventJobError('QUEUE_BATCH_REJECTED', 'QUARANTINE');
  // D1 has the business attempt cap. The local Queue config separately caps transport retries.
  for (const message of batch.messages) {
    try { await consumeDelivery(message, env); }
    catch { message.retry({ delaySeconds: 30 }); }
  }
}
