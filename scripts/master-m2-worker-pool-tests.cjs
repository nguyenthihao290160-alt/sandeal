/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `master-m2-worker-pool-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

function batchResult(workerId, overrides = {}) {
  return {
    workerId,
    claimed: 1,
    criticalClaimed: 0,
    normalClaimed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    waitingManual: 0,
    waitingChildren: 0,
    ...overrides,
  };
}

function selectionJob(id, type, priority, createdAt, payload = {}) {
  return {
    id,
    type,
    priority,
    payload,
    operationId: `operation-${id}`,
    queuedAt: createdAt,
    createdAt,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const store = require('../src/lib/automation/store.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const execution = require('../src/lib/automation/executionPolicy.ts');

  async function reset() {
    for (const collection of [
      'automation-jobs',
      'automation-job-heartbeats',
      'automation-job-projections',
      'automation-job-list-projections-v2',
      'automation-control',
      'automation-audit',
      'runtime-role-leases',
      'runtime-role-conflicts',
    ]) {
      await adapter.writeCollection(collection, []);
    }
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      workerPaused: false,
      schedulerPaused: false,
      publishPaused: true,
      killSwitch: false,
    }, 'master-m2-worker-test');
  }

  async function createJob(type, suffix, payload = {}, priority = 50) {
    return store.createAutomationJob({
      type,
      payload,
      idempotencyKey: `master-m2-worker-${type.toLowerCase()}-${suffix}`,
      operationId: `master-m2-operation-${type.toLowerCase()}-${suffix}`,
      requestedBy: 'scheduler',
      priority,
    });
  }

  await test('a freed slot starts replacement work before an unrelated slow sibling finishes', async () => {
    let active = 0;
    let peak = 0;
    let next = 0;
    const started = [];
    const completed = [];
    const delays = [90, 20, 15, 10];
    const result = await worker.runContinuousWorkerPool({
      workerId: 'pool-replacement-worker',
      maxConcurrency: 2,
      maximumClaims: 4,
      stopPollMs: 10,
      runBatch: async workerId => {
        const index = next;
        next += 1;
        active += 1;
        peak = Math.max(peak, active);
        started[index] = Date.now();
        await new Promise(resolve => setTimeout(resolve, delays[index]));
        completed[index] = Date.now();
        active -= 1;
        return batchResult(workerId);
      },
    });
    assert.equal(result.claimed, 4);
    assert.equal(result.peakInFlight, 2);
    assert.equal(peak, 2);
    assert.ok(started[2] < completed[0], JSON.stringify({ started, completed }));
    assert.ok(result.replacementClaims >= 1);
  });

  await test('a failed sibling is isolated and does not cancel remaining pool work', async () => {
    let next = 0;
    const result = await worker.runContinuousWorkerPool({
      workerId: 'pool-sibling-failure-worker',
      maxConcurrency: 3,
      maximumClaims: 5,
      runBatch: async workerId => {
        const index = next;
        next += 1;
        await new Promise(resolve => setTimeout(resolve, index === 0 ? 20 : 5));
        return index === 1
          ? batchResult(workerId, { succeeded: 0, failed: 1 })
          : batchResult(workerId);
      },
    });
    assert.equal(result.claimed, 5);
    assert.equal(result.succeeded, 4);
    assert.equal(result.failed, 1);
  });

  await test('the execution pool keeps its promise set and total claims bounded', async () => {
    let active = 0;
    let peak = 0;
    const result = await worker.runContinuousWorkerPool({
      workerId: 'pool-bound-worker',
      maxConcurrency: 3,
      maximumClaims: 40,
      runBatch: async workerId => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        return batchResult(workerId);
      },
    });
    assert.equal(result.claimed, 40);
    assert.equal(result.claimAttempts, 40);
    assert.equal(result.peakInFlight, 3);
    assert.equal(peak, 3);
  });

  await test('shutdown stops replacement claims and drains already running slots', async () => {
    let stop = false;
    setTimeout(() => { stop = true; }, 15);
    const result = await worker.runContinuousWorkerPool({
      workerId: 'pool-shutdown-worker',
      maxConcurrency: 2,
      maximumClaims: 20,
      shouldStop: () => stop,
      drainTimeoutMs: 1_000,
      stopPollMs: 10,
      runBatch: async workerId => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return batchResult(workerId);
      },
    });
    assert.equal(result.stopRequested, true);
    assert.equal(result.drained, true);
    assert.equal(result.claimed, 2);
    assert.equal(result.replacementClaims, 0);
  });

  await test('critical reservation is borrowable and overdue normal work retains fairness', () => {
    const now = Date.now();
    const old = new Date(now - 120_000).toISOString();
    const fresh = new Date(now - 1_000).toISOString();
    const overdueNormal = selectionJob('overdue-normal', 'HEALTH_CHECK', 1, old);
    const guardian = selectionJob('guardian', 'RUNTIME_GUARDIAN', 100, fresh);
    const normal = selectionJob('normal', 'HEALTH_CHECK', 50, fresh);
    const selected = execution.selectCompatibleWorkerJobs(
      [normal, overdueNormal, guardian],
      [],
      2,
      now,
      store.selectFairRunnableJobs,
      1,
    );
    assert.equal(selected[0].id, 'guardian');
    assert.equal(selected[1].id, 'overdue-normal');
    const borrowed = execution.selectCompatibleWorkerJobs(
      [normal, overdueNormal],
      [],
      2,
      now,
      store.selectFairRunnableJobs,
      1,
    );
    assert.equal(borrowed.length, 2);
  });

  await test('same-product and storage-exclusive jobs are incompatible while different products can run together', () => {
    const now = new Date().toISOString();
    const sameOne = selectionJob('same-one', 'SCORE_PRODUCTS', 50, now, { productId: 'product-shared' });
    const sameTwo = selectionJob('same-two', 'CAPTURE_PRICE_HISTORY', 50, now, { productIds: ['product-shared'] });
    const other = selectionJob('other', 'SCORE_PRODUCTS', 50, now, { productId: 'product-other' });
    const bulk = selectionJob('bulk', 'BULK_PRODUCT_OPERATION', 50, now);
    assert.equal(execution.automationJobsConflict(sameOne, sameTwo), true);
    assert.equal(execution.automationJobsConflict(sameOne, other), false);
    assert.equal(execution.automationJobsConflict(bulk, other), true);
    const descriptor = execution.getAutomationExecutionDescriptor(sameOne);
    assert.equal(descriptor.resourceKeys.some(key => key.includes('product-shared')), false);
  });

  await test('durable claims enforce max concurrency across concurrent claim attempts', async () => {
    await reset();
    for (let index = 0; index < 7; index += 1) await createJob('HEALTH_CHECK', `bound-${index}`);
    const claims = await Promise.all(Array.from({ length: 7 }, () =>
      store.claimAutomationJobs(
        'durable-bound-worker',
        1,
        60_000,
        Date.now(),
        undefined,
        { maximumInFlight: 4, criticalReservedCapacity: 1, enforceExecutionCompatibility: true },
      )));
    assert.equal(claims.flat().length, 4);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.status === 'RUNNING').length, 4);
  });

  await test('durable resource keys prevent same-product races without blocking another product', async () => {
    await reset();
    await createJob('SCORE_PRODUCTS', 'same-product-score', { productId: 'product-one' }, 80);
    await createJob('CAPTURE_PRICE_HISTORY', 'same-product-price', { productId: 'product-one' }, 70);
    await createJob('SCORE_PRODUCTS', 'other-product-score', { productId: 'product-two' }, 60);
    const claimed = await store.claimAutomationJobs(
      'durable-resource-worker',
      4,
      60_000,
      Date.now(),
      undefined,
      { maximumInFlight: 4, criticalReservedCapacity: 1, enforceExecutionCompatibility: true },
    );
    assert.equal(claimed.length, 2);
    assert.equal(claimed.filter(job => job.executionResourceKeys.some(key => key.startsWith('product:'))).length, 2);
    assert.equal(new Set(claimed.flatMap(job => job.executionResourceKeys)).size, 2);
  });

  await test('critical work is claimed immediately when capacity exists and normal work borrows idle capacity', async () => {
    await reset();
    for (let index = 0; index < 4; index += 1) await createJob('HEALTH_CHECK', `borrow-${index}`, {}, 20 + index);
    let claimed = await store.claimAutomationJobs(
      'critical-capacity-worker',
      4,
      60_000,
      Date.now(),
      undefined,
      { maximumInFlight: 4, criticalReservedCapacity: 1, enforceExecutionCompatibility: true },
    );
    assert.equal(claimed.length, 4);
    assert.equal(claimed.every(job => job.executionCritical === false), true);

    await reset();
    for (let index = 0; index < 4; index += 1) await createJob('HEALTH_CHECK', `mixed-${index}`, {}, 20 + index);
    const guardian = await createJob('RUNTIME_GUARDIAN', 'critical-guardian', {}, 100);
    claimed = await store.claimAutomationJobs(
      'critical-capacity-worker',
      4,
      60_000,
      Date.now(),
      undefined,
      { maximumInFlight: 4, criticalReservedCapacity: 1, enforceExecutionCompatibility: true },
    );
    assert.equal(claimed.length, 4);
    assert.equal(claimed[0].id, guardian.job.id);
    assert.equal(claimed.filter(job => job.executionCritical).length, 1);
    assert.ok(Date.parse(claimed[0].claimedAt) - Date.parse(claimed[0].scheduledAt) < 30_000);
  });

  await test('worker fencing loss prevents the pool from claiming new work', async () => {
    await reset();
    const role = await roles.acquireRuntimeRole({
      role: 'WORKER',
      ownerId: 'fenced-worker',
      instanceId: 'fenced-worker-instance',
      leaseMs: 60_000,
    });
    assert.equal(role.acquired, true);
    await createJob('HEALTH_CHECK', 'fenced-job');
    assert.equal(await roles.releaseRuntimeRole('WORKER', role.ownership), true);
    await assert.rejects(
      worker.runContinuousWorkerPool({
        workerId: 'fenced-worker',
        ownership: role.ownership,
        maxConcurrency: 2,
        maximumClaims: 2,
      }),
      /WORKER_FENCING_REJECTED/,
    );
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.status === 'RUNNING').length, 0);
  });

  console.log(`\nMaster M2 worker pool: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
