/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { fixture } = require('./lib/cloudflare-autopilot-test.cjs');
const { createCloudflareSchedulerAdapter, createCloudflareJobQueueAdapter } = require('../src/lib/platform/cloudflareAdapters.ts');
const { EVENT_LIMITS } = require('../src/lib/platform/cloudflareContracts.ts');
let passed = 0, failed = 0;
async function test(name, work) { try { await fixture(work); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
function task(f, id = 'due-task', overrides = {}) { return { id, type: f.input.type, payload: f.input.payload, nextRunAt: f.now, intervalMs: 3600000, enabled: true, ...overrides }; }
async function main() {
  await test('Cron creates deterministic durable job, enqueues and advances only due enabled task', async f => {
    await f.store.createTask(task(f)); await f.store.createTask(task(f, 'future', { nextRunAt: f.now + 1 })); await f.store.createTask(task(f, 'disabled', { enabled: false }));
    const scheduler = createCloudflareSchedulerAdapter(f.env), result = await scheduler.tick(f.now);
    assert.deepEqual(result, { due: 1, created: 1, enqueued: 1 }); assert.equal(f.sent.length, 1);
    const job = await f.store.get(f.sent[0].jobId); assert.equal(job.status, 'PENDING'); assert.equal(job.attemptCount, 0);
    assert.equal((await f.store.due(f.now)).length, 0);
  });
  await test('same Cron event twice creates and enqueues no duplicate scheduled job', async f => {
    await f.store.createTask(task(f)); const scheduler = createCloudflareSchedulerAdapter(f.env);
    await scheduler.tick(f.now); assert.deepEqual(await scheduler.tick(f.now), { due: 0, created: 0, enqueued: 0 });
    assert.equal(f.sent.length, 1); assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM automation_jobs').first()).n, 1);
  });
  await test('concurrent Cron events use task CAS and dispatch reservation', async f => {
    await f.store.createTask(task(f));
    const results = await Promise.all([createCloudflareSchedulerAdapter(f.env).tick(f.now), createCloudflareSchedulerAdapter(f.env).tick(f.now)]);
    assert.equal(results.reduce((n, row) => n + row.created, 0), 1); assert.equal(f.sent.length, 1);
    assert.equal((await f.db.prepare('SELECT revision FROM scheduled_tasks WHERE id=?').bind('due-task').first()).revision, 2);
  });
  await test('due task query and outbox query use indexed bounded ranges', async f => {
    for (let i = 0; i < 25; i++) await f.store.createTask(task(f, `due-${i}`));
    const result = await createCloudflareSchedulerAdapter(f.env).tick(f.now);
    assert.equal(result.due, EVENT_LIMITS.cronBatch); assert.equal(result.created, 10); assert.equal(result.enqueued, 10);
    for (const [sql, index] of [
      ['EXPLAIN QUERY PLAN SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id LIMIT 10','scheduled_tasks_due'],
      ['EXPLAIN QUERY PLAN SELECT * FROM automation_jobs WHERE dispatch_pending=1 AND dispatch_at<=? ORDER BY dispatch_at,id LIMIT 10','automation_jobs_dispatch_due'],
    ]) { const plan = JSON.stringify((await f.db.prepare(sql).bind(f.now).all()).results); assert.match(plan, new RegExp(`SEARCH.*${index}`)); assert.doesNotMatch(plan, /SCAN (scheduled_tasks|automation_jobs)/); }
  });
  await test('many missed intervals create one deterministic due effect without catch-up loop', async f => {
    await f.store.createTask(task(f, 'old', { nextRunAt: f.now - 3600000 * 1000 }));
    assert.equal((await createCloudflareSchedulerAdapter(f.env).tick(f.now)).created, 1);
    const row = await f.db.prepare('SELECT next_run_at FROM scheduled_tasks WHERE id=?').bind('old').first(); assert.equal(row.next_run_at, f.now + 3600000);
  });
  await test('queue outage retains the durable job and a later Cron tick dispatches it once', async f => {
    await f.store.createTask(task(f)); const broken = { ...f.env, JOB_QUEUE: { async send() { throw new Error('synthetic-private-provider-detail'); } } };
    await assert.rejects(() => createCloudflareSchedulerAdapter(broken).tick(f.now), error => error.code === 'QUEUE_SEND_FAILED');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM automation_jobs').first()).n, 1);
    const result = await createCloudflareSchedulerAdapter(f.env).tick(f.now + EVENT_LIMITS.redeliveryMs);
    assert.equal(result.created, 0); assert.equal(result.enqueued, 1); assert.equal(f.sent.length, 1);
  });
  await test('crash after materializing before queue send recovers from indexed outbox', async f => {
    await f.store.createTask(task(f)); const [due] = await f.store.due(f.now); await f.store.materialize(due, f.now);
    const result = await createCloudflareSchedulerAdapter(f.env).tick(f.now);
    assert.equal(result.created, 0); assert.equal(result.enqueued, 1);
  });
  await test('outbox dispatch attempts are finite even when every send fails', async f => {
    const job = await f.job(); const broken = { ...f.env, JOB_QUEUE: { async send() { throw new Error('offline'); } } };
    const queue = createCloudflareJobQueueAdapter(broken);
    for (let i = 0; i < EVENT_LIMITS.dispatches; i++) await assert.rejects(() => queue.dispatch(f.now + EVENT_LIMITS.redeliveryMs * i));
    assert.equal(await queue.dispatch(f.now + EVENT_LIMITS.redeliveryMs * EVENT_LIMITS.dispatches), 0);
    const stored = await f.store.get(job.id); assert.equal(stored.status, 'FAILED'); assert.equal(stored.dispatchCount, 5); assert.equal(stored.lastErrorCode, 'QUEUE_DISPATCH_EXHAUSTED');
  });
  await test('empty Cron ticks do not write heartbeat or settings rows', async f => {
    const queries = [];
    const observed = { prepare(sql) { queries.push(sql); return f.db.prepare(sql); }, batch(statements) { return f.db.batch(statements); } };
    const scheduler = createCloudflareSchedulerAdapter({ ...f.env, DB: observed });
    assert.deepEqual(await scheduler.tick(f.now), { due: 0, created: 0, enqueued: 0 });
    assert.equal(queries.length, 2); assert.ok(queries.every(sql => /^SELECT\b/.test(sql)));
    for (const table of ['automation_jobs','scheduled_tasks','system_settings']) assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE '%heartbeat%'").first()).n, 0);
  });
  await test('disabled mode, missing dependencies and unsafe schedules fail closed', async f => {
    for (const overrides of [{ SANDEAL_AUTOPILOT_ENABLED: 'false' }, { DB: undefined }, { JOB_QUEUE: undefined }, { SANDEAL_PRODUCTION: 'true' }]) assert.throws(() => createCloudflareSchedulerAdapter({ ...f.env, ...overrides }));
    for (const overrides of [{ intervalMs: 0 }, { nextRunAt: NaN }, { type: 'AI_ANALYSIS' }, { payload: { productId: f.product.id, secret: 'local-test-secret' } }]) await assert.rejects(() => f.store.createTask(task(f, 'bad', overrides)));
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_tasks').first()).n, 0);
  });
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => { console.log(`V6 Cloudflare Cron: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; });
