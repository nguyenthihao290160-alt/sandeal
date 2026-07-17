/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-lifecycle-storage-${process.pid}-${Date.now()}`);
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

const adapter = require('../src/lib/storage/adapter.ts');
const lifecycle = require('../src/lib/autonomous/lifecycle.ts');
const store = require('../src/lib/autonomous/lifecycleStore.ts');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function product(id, lifecycleState = 'DISCOVERED') {
  const now = '2026-07-16T00:00:00.000Z';
  return {
    schemaVersion: 2,
    id,
    title: `Lifecycle fixture ${id}`,
    slug: `lifecycle-fixture-${id}`,
    kind: 'product',
    recordType: 'PRODUCT',
    lifecycleState,
    lifecycleVersion: lifecycle.PRODUCT_LIFECYCLE_VERSION,
    lifecycleUpdatedAt: now,
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/${id}`,
    affiliateUrl: `https://merchant.example/${id}?affiliate=test`,
    imageUrl: `https://merchant.example/${id}.jpg`,
    currency: 'VND',
    price: 100000,
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: lifecycleState === 'PUBLISHED' ? 'published' : 'needs_review',
    publicHidden: lifecycleState !== 'PUBLISHED',
    needsVerification: lifecycleState !== 'PUBLISHED',
    sourceHash: `source-${id}`,
    contentHash: `content-${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function runningJob(id, type, claimedBy) {
  return { id, type, status: 'RUNNING', claimedBy };
}

const processActor = (jobId = 'process-job-1', workerId = 'worker-process-1') => ({
  type: 'worker', id: workerId, jobId, jobType: 'PROCESS_CANDIDATE',
});
const publishActor = (jobId = 'publish-job-1', workerId = 'worker-publish-1') => ({
  type: 'worker', id: workerId, jobId, jobType: 'AUTO_SAFE_PUBLISH',
});

async function reset(products, jobs = []) {
  await adapter.writeCollection('products', products);
  await adapter.writeCollection('automation-jobs', jobs);
  await adapter.writeCollection('product-lifecycle-events', []);
  await adapter.writeCollection('operation-journal', []);
}

async function currentProduct(id) {
  return (await adapter.readCollection('products')).find(item => item.id === id);
}

async function main() {
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_LIFECYCLE'); };

  await test('transition registry discloses complete policy metadata', () => {
    const contract = lifecycle.listLifecycleContract();
    assert.ok(contract.length >= 35);
    assert.equal(new Set(contract.map(item => `${item.from}:${item.to}`)).size, contract.length);
    for (const item of contract) {
      assert.equal(item.schemaVersion, 1);
      assert.ok(item.authorizedActors.length > 0);
      assert.ok(item.precondition);
      assert.ok(item.output);
      assert.ok(item.writeScope.includes('products'));
      assert.ok(item.writeScope.includes('product-lifecycle-events'));
      assert.equal(item.idempotencyStrategy, 'CALLER_TRANSITION_KEY');
      assert.match(item.auditEvent, /^PRODUCT_[A-Z_]+_TO_[A-Z_]+$/);
    }
  });

  await test('durable ingestion chain persists one applied event and consistent journal per transition', async () => {
    await reset([product('chain')], [runningJob('process-job-1', 'PROCESS_CANDIDATE', 'worker-process-1')]);
    const states = ['STAGED', 'CLASSIFIED', 'NORMALIZED', 'VERIFYING', 'CONTENT_PREPARING', 'READY_FOR_PUBLISH'];
    for (let index = 0; index < states.length; index += 1) {
      const transitionKey = `chain-transition-${index + 1}`;
      const result = await store.persistLifecycleTransition({
        productId: 'chain',
        to: states[index],
        actor: processActor(),
        transitionKey,
        operationId: 'candidate-operation-chain',
        reasonCodes: [`step_${index + 1}`],
        now: `2026-07-16T00:0${index + 1}:00.000Z`,
      });
      assert.equal(result.changed, true);
      assert.equal(result.event.status, 'APPLIED');
      assert.equal(result.event.schemaVersion, 1);
      assert.equal(result.event.actor.jobType, 'PROCESS_CANDIDATE');
      assert.deepEqual(result.event.reasonCodes, [`step_${index + 1}`]);
      const journal = await store.getLifecycleTransitionJournal(transitionKey);
      assert.equal(journal.reconciliationStatus, 'CONSISTENT');
      assert.deepEqual(new Set(journal.completedEffects), new Set(['event-intent', 'product-transition', 'event-finalize']));
    }
    const saved = await currentProduct('chain');
    assert.equal(saved.lifecycleState, 'READY_FOR_PUBLISH');
    const events = await store.listLifecycleTransitionEvents('chain');
    assert.equal(events.length, states.length);
    assert.deepEqual(events.map(event => event.nextState), states);
  });

  await test('forbidden, API, and wrong-job transitions leave product and events unchanged', async () => {
    await reset([product('forbidden', 'STAGED'), product('wrong-job', 'READY_FOR_PUBLISH')]);
    const before = JSON.stringify(await adapter.readCollection('products'));
    await assert.rejects(
      store.persistLifecycleTransition({ productId: 'forbidden', to: 'PUBLISHED', actor: publishActor(), transitionKey: 'forbidden-state-skip' }),
      /FORBIDDEN_LIFECYCLE_TRANSITION/,
    );
    await assert.rejects(
      store.persistLifecycleTransition({ productId: 'forbidden', to: 'CLASSIFIED', actor: { type: 'api', id: 'dashboard-api' }, transitionKey: 'forbidden-api-write' }),
      /LIFECYCLE_API_WRITE_FORBIDDEN/,
    );
    await assert.rejects(
      store.persistLifecycleTransition({ productId: 'wrong-job', to: 'PUBLISHING', actor: processActor(), transitionKey: 'forbidden-wrong-job' }),
      /LIFECYCLE_JOB_TYPE_FORBIDDEN/,
    );
    await assert.rejects(
      store.persistLifecycleTransition({ productId: 'forbidden', to: 'CLASSIFIED', actor: processActor('missing-process-job'), transitionKey: 'forbidden-unclaimed-job' }),
      /LIFECYCLE_DURABLE_JOB_INVALID/,
    );
    assert.equal(JSON.stringify(await adapter.readCollection('products')), before);
    assert.equal((await store.listLifecycleTransitionEvents()).length, 0);
  });

  await test('publish transitions require the claimed durable publish job actor', async () => {
    await reset([product('publish', 'READY_FOR_PUBLISH')], [runningJob('publish-job-1', 'AUTO_SAFE_PUBLISH', 'worker-publish-1')]);
    const publishing = await store.persistLifecycleTransition({
      productId: 'publish', to: 'PUBLISHING', actor: publishActor(), transitionKey: 'authorized-publish-start',
    });
    assert.equal(publishing.product.lifecycleState, 'PUBLISHING');
    const published = await store.persistLifecycleTransition({
      productId: 'publish', to: 'PUBLISHED', actor: publishActor(), transitionKey: 'authorized-publish-finish',
    });
    assert.equal(published.product.lifecycleState, 'PUBLISHED');
    await reset([product('migration-publish', 'READY_FOR_PUBLISH')]);
    await assert.rejects(
      store.persistLifecycleTransition({ productId: 'migration-publish', to: 'PUBLISHING', actor: { type: 'migration', id: 'backfill-v2' }, transitionKey: 'migration-cannot-publish' }),
      /LIFECYCLE_ACTOR_FORBIDDEN/,
    );
  });

  await test('same transition key replay is a no-op with one event and stable timestamp', async () => {
    await reset([product('replay')], [runningJob('replay-job', 'PROCESS_CANDIDATE', 'worker-before-restart')]);
    const input = {
      productId: 'replay', to: 'STAGED', actor: processActor('replay-job', 'worker-before-restart'),
      transitionKey: 'stable-replay-transition-key', now: '2026-07-16T01:00:00.000Z',
    };
    const first = await store.persistLifecycleTransition(input);
    const second = await store.persistLifecycleTransition({ ...input, actor: processActor('replay-job', 'worker-after-restart') });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.product.lifecycleUpdatedAt, first.product.lifecycleUpdatedAt);
    assert.equal((await store.listLifecycleTransitionEvents('replay')).length, 1);
  });

  await test('crash after product write reconciles the pending event without a second state change', async () => {
    await reset([product('crash-product')], [runningJob('crash-job', 'PROCESS_CANDIDATE', 'worker-before-crash')]);
    const input = {
      productId: 'crash-product', to: 'STAGED', actor: processActor('crash-job', 'worker-before-crash'),
      transitionKey: 'crash-after-product-write-key', now: '2026-07-16T02:00:00.000Z',
    };
    await assert.rejects(
      store.persistLifecycleTransition({ ...input, testFailurePoint: 'AFTER_PRODUCT_WRITE' }),
      /SIMULATED_LIFECYCLE_CRASH_AFTER_PRODUCT_WRITE/,
    );
    const afterCrash = await currentProduct('crash-product');
    assert.equal(afterCrash.lifecycleState, 'STAGED');
    assert.equal(afterCrash.lifecycleUpdatedAt, input.now);
    const pending = await store.getLifecycleTransitionEvent(input.transitionKey);
    assert.equal(pending.status, 'PENDING');

    const recovered = await store.persistLifecycleTransition({ ...input, actor: processActor('crash-job', 'worker-after-crash') });
    assert.equal(recovered.changed, false);
    assert.equal(recovered.reconciled, true);
    assert.equal(recovered.event.status, 'APPLIED');
    assert.equal(recovered.product.lifecycleUpdatedAt, input.now);
    assert.equal((await store.listLifecycleTransitionEvents('crash-product')).length, 1);
    assert.equal((await store.getLifecycleTransitionJournal(input.transitionKey)).reconciliationStatus, 'CONSISTENT');
  });

  await test('autonomous reconciler repairs event-first crash and stable key cannot be reused', async () => {
    await reset([product('event-crash')], [runningJob('event-crash-job', 'PROCESS_CANDIDATE', 'worker-process-1')]);
    const input = {
      productId: 'event-crash', to: 'STAGED', actor: processActor('event-crash-job'),
      transitionKey: 'crash-after-event-intent-key', now: '2026-07-16T03:00:00.000Z',
    };
    await assert.rejects(
      store.persistLifecycleTransition({ ...input, testFailurePoint: 'AFTER_EVENT_INTENT' }),
      /SIMULATED_LIFECYCLE_CRASH_AFTER_EVENT_INTENT/,
    );
    assert.equal((await currentProduct('event-crash')).lifecycleState, 'DISCOVERED');
    assert.equal((await store.getLifecycleTransitionEvent(input.transitionKey)).status, 'PENDING');
    const repaired = await store.reconcilePendingLifecycleTransitions();
    assert.equal(repaired.repaired, 1);
    assert.equal(repaired.failed.length, 0);
    assert.equal((await currentProduct('event-crash')).lifecycleState, 'STAGED');
    assert.equal((await store.getLifecycleTransitionEvent(input.transitionKey)).status, 'APPLIED');
    await assert.rejects(
      store.persistLifecycleTransition({ ...input, to: 'QUARANTINED' }),
      /LIFECYCLE_TRANSITION_KEY_REUSED/,
    );
    assert.equal((await store.listLifecycleTransitionEvents('event-crash')).length, 1);
  });

  console.log(`\nPROMPT10 lifecycle storage: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
