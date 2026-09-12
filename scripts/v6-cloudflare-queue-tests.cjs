/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { fixture, delivery } = require('./lib/cloudflare-autopilot-test.cjs');
const { consumeDelivery, cloudflareQueue } = require('../src/lib/runtime/cloudflare/autopilot.ts');
const { createCloudflareJobQueueAdapter } = require('../src/lib/platform/cloudflareAdapters.ts');
const { EVENT_LIMITS, EventJobError, validateMessage, makeMessage } = require('../src/lib/platform/cloudflareContracts.ts');
let passed = 0, failed = 0;
async function test(name, work) { try { await fixture(work); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  await test('queue adapter implements bounded enqueue contract and emits only reference fields', async f => {
    const queue = createCloudflareJobQueueAdapter(f.env), first = await queue.enqueueJob(f.input), second = await queue.enqueueJob(f.input);
    assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.job.id, second.job.id); assert.equal(f.sent.length, 1);
    validateMessage(f.sent[0]); assert.deepEqual(Object.keys(f.sent[0]).sort(), ['attempt','createdAt','idempotencyKey','jobId','jobType','payloadVersion']);
    assert.ok(Buffer.byteLength(JSON.stringify(f.sent[0])) < EVENT_LIMITS.messageBytes);
    await assert.rejects(() => queue.enqueueJobs(Array.from({ length: 11 }, () => f.input)), error => error.code === 'QUEUE_BATCH_TOO_LARGE');
    await assert.rejects(() => queue.enqueueJob({ ...f.input, payload: { productId: f.product.id, password: 'local-test-password' } }));
    await assert.rejects(() => queue.enqueueJob({ ...f.input, payload: { productId: 'different' } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  });
  await test('consumer atomically records one price observation and existing SUCCEEDED lifecycle', async f => {
    const job = await f.job(), message = f.message(job);
    assert.equal(await consumeDelivery(message, f.env), 'SUCCEEDED'); assert.equal(message.ackCount, 1);
    const stored = await f.store.get(job.id); assert.equal(stored.status, 'SUCCEEDED'); assert.equal(stored.attemptCount, 1); assert.deepEqual(stored.result, { snapshotCreated: true });
    const rows = await f.history(); assert.equal(rows.length, 1); assert.equal(rows[0].operation_id, job.idempotencyKey);
  });
  await test('duplicate and simultaneous Queue deliveries produce one domain effect', async f => {
    const job = await f.job(); await Promise.all([consumeDelivery(f.message(job), f.env), consumeDelivery(f.message(job), f.env)]);
    assert.equal(await consumeDelivery(f.message(job), f.env), 'DUPLICATE_SAFE'); assert.equal((await f.history()).length, 1);
    assert.equal((await f.store.get(job.id)).attemptCount, 1);
  });
  await test('failure before domain commit transitions to retry and succeeds without duplicates', async f => {
    const job = await f.job(), first = f.message(job);
    assert.equal(await consumeDelivery(first, f.env, { now: () => f.now, beforeCommit: async () => { throw new EventJobError('PROVIDER_TIMEOUT', 'RETRYABLE'); } }), 'RETRYABLE');
    assert.equal((await f.history()).length, 0); assert.equal((await f.store.get(job.id)).status, 'RETRY_SCHEDULED');
    assert.equal(await consumeDelivery(f.message(job), f.env, { now: () => f.now + 30000 }), 'SUCCEEDED'); assert.equal((await f.history()).length, 1);
  });
  await test('consumer process loss before commit recovers an expired finite claim without heartbeat', async f => {
    const job = await f.job(); await f.store.claim(job, f.now);
    assert.equal(await consumeDelivery(f.message(job), f.env, { now: () => f.now + 1 }), 'DEFERRED');
    assert.equal(await consumeDelivery(f.message(job), f.env, { now: () => f.now + EVENT_LIMITS.claimMs + 1 }), 'SUCCEEDED');
    assert.equal((await f.history()).length, 1); assert.equal((await f.store.get(job.id)).attemptCount, 2);
  });
  await test('crash after domain commit before acknowledgment replays completed effect even after product changes', async f => {
    const job = await f.job(), first = f.message(job);
    await assert.rejects(() => consumeDelivery(first, f.env, { afterCommit: async () => { throw new Error('TEST_CRASH_AFTER_COMMIT'); } }), /TEST_CRASH_AFTER_COMMIT/);
    assert.equal(first.ackCount, 0); assert.equal((await f.store.get(job.id)).status, 'SUCCEEDED');
    const product = await f.adapter.domain.getProduct(f.product.id); await f.adapter.domain.replaceProduct({ ...product.value, price: 9999999 }, product.version);
    assert.equal(await consumeDelivery(f.message(job), f.env), 'DUPLICATE_SAFE'); assert.equal((await f.history()).length, 1); assert.equal((await f.history())[0].price, f.product.price);
  });
  await test('failure between price insert and job completion rolls back the complete D1 batch', async f => {
    const job = await f.job();
    await f.db.prepare("CREATE TRIGGER test_fail_completion BEFORE UPDATE OF status ON automation_jobs WHEN NEW.status='SUCCEEDED' BEGIN SELECT RAISE(ABORT,'synthetic-private-driver-detail'); END").run();
    assert.equal(await consumeDelivery(f.message(job), f.env, { now: () => f.now }), 'RETRYABLE'); assert.equal((await f.history()).length, 0);
    await f.db.prepare('DROP TRIGGER test_fail_completion').run();
    assert.equal(await consumeDelivery(f.message(job), f.env, { now: () => f.now + 30000 }), 'SUCCEEDED'); assert.equal((await f.history()).length, 1);
  });
  await test('stale claim is fenced after takeover and cannot commit a domain effect', async f => {
    const job = await f.job(), stale = await f.store.claim(job, f.now), current = await f.store.claim(job, f.now + EVENT_LIMITS.claimMs + 1);
    const snapshot = { id: 'ignored', productId: f.product.id, source: 'manual', price: 1, currency: 'VND', capturedAt: job.createdAt, operationId: job.idempotencyKey, sourceHash: 'fixture' };
    await assert.rejects(() => f.store.commitPriceSnapshot(stale, snapshot, f.now + EVENT_LIMITS.claimMs + 2), error => error.code === 'STALE_CLAIM');
    assert.equal((await f.history()).length, 0);
    await f.store.commitPriceSnapshot(current, snapshot, f.now + EVENT_LIMITS.claimMs + 2); assert.equal((await f.history()).length, 1);
  });
  await test('unknown job types quarantine and acknowledge with no business mutation', async f => {
    const job = await f.job(), message = delivery({ ...makeMessage(job), jobType: 'AI_ANALYSIS' });
    assert.equal(await consumeDelivery(message, f.env), 'QUARANTINED'); assert.equal(message.ackCount, 1); assert.equal(message.retries.length, 0);
    assert.equal((await f.history()).length, 0); assert.equal((await f.store.get(job.id)).status, 'PENDING');
  });
  await test('malformed, secret-bearing and oversized payloads quarantine without storing raw contents', async f => {
    const job = await f.job(), body = makeMessage(job);
    for (const [i, value] of [null, [], {}, { ...body, payload: { secret: 'local-test-sensitive-marker' } }, { ...body, idempotencyKey: 'x'.repeat(300000) }, { ...body, attempt: 0 }, { ...body, payloadVersion: 2 }].entries()) {
      const message = delivery(value, `malformed-${i}`); assert.equal(await consumeDelivery(message, f.env), 'QUARANTINED'); assert.equal(message.retries.length, 0);
    }
    const rows = (await f.db.prepare('SELECT * FROM automation_queue_quarantine').all()).results;
    assert.equal(rows.length, 7); assert.equal(JSON.stringify(rows).includes('sensitive-marker'), false); assert.equal((await f.history()).length, 0);
  });
  await test('forged job references cannot change stored work', async f => {
    const job = await f.job(); const message = delivery({ ...makeMessage(job), createdAt: new Date(f.now - 1000).toISOString() });
    assert.equal(await consumeDelivery(message, f.env), 'QUARANTINED'); assert.equal((await f.store.get(job.id)).status, 'PENDING');
  });
  await test('expired job is blocked and cannot execute a stale effect', async f => {
    const job = await f.job(); assert.equal(await consumeDelivery(f.message(job), f.env, { now: () => f.now + EVENT_LIMITS.lifetimeMs }), 'TERMINAL');
    assert.equal((await f.store.get(job.id)).status, 'BLOCKED'); assert.equal((await f.history()).length, 0);
  });
  await test('unavailable D1 retries without acknowledgment, fallback, or private logs', async f => {
    const job = await f.job(), message = f.message(job), bad = { ...f.env, DB: { prepare() { throw new Error('synthetic-private-driver-detail'); }, async batch() { throw new Error('synthetic-private-driver-detail'); } } };
    const logs = [], original = console.error; console.error = (...args) => logs.push(args);
    try { await cloudflareQueue({ queue: 'sandeal-local-jobs', messages: [message] }, bad); } finally { console.error = original; }
    assert.equal(message.ackCount, 0); assert.equal(message.retries.length, 1); assert.deepEqual(logs, []); assert.equal((await f.history()).length, 0);
  });
  await test('retryable provider errors exhaust the durable attempt cap and never loop forever', async f => {
    const job = await f.job(); let time = f.now;
    for (let i = 1; i <= 3; i++) {
      const message = f.message(job); const result = await consumeDelivery(message, f.env, { now: () => time, beforeCommit: async () => { throw { code: 'PROVIDER_RATE_LIMIT' }; } });
      assert.equal(result, i < 3 ? 'RETRYABLE' : 'TERMINAL'); time += 30000 * 2 ** (i - 1);
    }
    const stored = await f.store.get(job.id); assert.equal(stored.status, 'FAILED'); assert.equal(stored.attemptCount, 3);
    assert.equal(await consumeDelivery(f.message(job), f.env, { now: () => time }), 'TERMINAL'); assert.equal((await f.history()).length, 0);
  });
  await test('final validation errors acknowledge and persist FAILED without retries', async f => {
    const job = await f.job({ payload: { productId: 'missing' } }), message = f.message(job);
    assert.equal(await consumeDelivery(message, f.env), 'TERMINAL'); assert.equal(message.ackCount, 1); assert.equal(message.retries.length, 0);
    assert.equal((await f.store.get(job.id)).status, 'FAILED'); assert.equal((await f.history()).length, 0);
  });
  await test('consumer rejects oversized batches and foreign queues before effects', async f => {
    const job = await f.job();
    await assert.rejects(() => cloudflareQueue({ queue: 'foreign', messages: [f.message(job)] }, f.env));
    await assert.rejects(() => cloudflareQueue({ queue: 'sandeal-local-jobs', messages: Array.from({ length: 11 }, () => f.message(job)) }, f.env));
    assert.equal((await f.history()).length, 0); assert.equal((await f.store.get(job.id)).attemptCount, 0);
  });
  await test('unchanged adjacent observation completes as a durable no-op', async f => {
    const first = await f.job(); await consumeDelivery(f.message(first), f.env);
    const next = await f.job({ idempotencyKey: 'next-observation' }); await consumeDelivery(f.message(next), f.env);
    assert.equal((await f.history()).length, 1); assert.deepEqual((await f.store.get(next.id)).result, { snapshotCreated: false });
    assert.equal(await consumeDelivery(f.message(next), f.env), 'DUPLICATE_SAFE');
  });
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => { console.log(`V6 Cloudflare Queue: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; });
