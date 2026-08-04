/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `master-m2-worker-pool-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_BUILD_COMMIT = 'f'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'f'.repeat(40);
process.env.GIT_COMMIT_SHA = 'f'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'f'.repeat(40);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(check, timeoutMs = 3_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue?.done) return lastValue.value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`WAIT_FOR_CONDITION_TIMEOUT:${JSON.stringify(lastValue?.value ?? null)}`);
}

const COLLECTIONS = [
  'automation-jobs',
  'automation-job-attempts',
  'automation-job-heartbeats',
  'automation-job-projections',
  'automation-job-list-projections-v2',
  'automation-job-health-summary-v1',
  'automation-job-projection-manifest-v1',
  'automation-job-projection-maintenance-v1',
  'automation-job-projection-rebuild-staging-v1',
  'automation-control',
  'automation-audit',
  'runtime-role-leases',
  'runtime-role-conflicts',
  'runtime-role-fencing',
  'automation-settings',
  'business-usage',
  'products',
  'candidate-queue',
];

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const store = require('../src/lib/automation/store.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const execution = require('../src/lib/automation/executionPolicy.ts');

  async function reset() {
    for (const collection of COLLECTIONS) {
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

  await test('shared worker activity keeps a slow sibling visible after the fast slot completes', async () => {
    await reset();
    const fast = await createJob('HEALTH_CHECK', 'shared-activity-fast', { marker: 'fast' }, 80);
    const slow = await createJob('HEALTH_CHECK', 'shared-activity-slow', { marker: 'slow' }, 70);
    const fastGate = deferred();
    const slowGate = deferred();
    const bothStarted = deferred();
    const started = new Set();

    const poolPromise = worker.runContinuousWorkerPool({
      workerId: 'shared-activity-worker',
      maxConcurrency: 2,
      maximumClaims: 2,
      criticalReservedCapacity: 0,
      stopPollMs: 10,
      runBatch: (workerId, ownership, batchOptions) =>
          worker.processAutomationBatch(workerId, 1, ownership, {
            ...batchOptions,
            executeJobOverride: async job => {
              started.add(job.id);
              if (started.size === 2) bothStarted.resolve();
              if (job.id === fast.job.id) await fastGate.promise;
              else if (job.id === slow.job.id) await slowGate.promise;
              else throw new Error(`UNEXPECTED_SHARED_ACTIVITY_JOB:${job.id}`);
              return {
                checkedAt: new Date().toISOString(),
                businessDataChanged: false,
              };
            },
          }),
    });

    try {
      await Promise.race([
        bothStarted.promise,
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('SHARED_ACTIVITY_START_TIMEOUT')), 3_000);
        }),
      ]);

      const runningControl = await store.getAutomationControl();
      assert.ok(
          [fast.job.id, slow.job.id].includes(runningControl.workerCurrentJobId),
          JSON.stringify(runningControl),
      );

      fastGate.resolve();
      const intermediate = await waitForCondition(async () => {
        const jobs = await store.getAllAutomationJobs();
        const fastState = jobs.find(job => job.id === fast.job.id);
        const slowState = jobs.find(job => job.id === slow.job.id);
        const control = await store.getAutomationControl();
        const value = {
          fastStatus: fastState?.status,
          slowStatus: slowState?.status,
          workerCurrentJobId: control.workerCurrentJobId,
        };
        return {
          done: fastState?.status === 'SUCCEEDED'
              && slowState?.status === 'RUNNING'
              && control.workerCurrentJobId === slow.job.id,
          value,
        };
      });
      assert.deepEqual(intermediate, {
        fastStatus: 'SUCCEEDED',
        slowStatus: 'RUNNING',
        workerCurrentJobId: slow.job.id,
      });

      slowGate.resolve();
      const result = await poolPromise;
      assert.equal(result.claimed, 2);
      assert.equal(result.succeeded, 2);
      const finalControl = await store.getAutomationControl();
      assert.ok(!finalControl.workerCurrentJobId, JSON.stringify(finalControl));
    } finally {
      fastGate.resolve();
      slowGate.resolve();
      await poolPromise.catch(() => undefined);
    }
  });

  await test('the global maximumClaims bound remains hard when Guardian capacity is reserved', async () => {
    const queued = [
      { id: 'guardian-only-budget', type: 'RUNTIME_GUARDIAN' },
      { id: 'ordinary-over-budget', type: 'HEALTH_CHECK' },
    ];
    const executed = [];
    const result = await worker.runContinuousWorkerPool({
      workerId: 'hard-claim-budget-worker',
      maxConcurrency: 2,
      maximumClaims: 1,
      criticalReservedCapacity: 1,
      runBatch: async (workerId, ownership, batchOptions) => {
        const index = queued.findIndex(job =>
            (batchOptions.claimLane !== 'RUNTIME_GUARDIAN' || job.type === 'RUNTIME_GUARDIAN')
            && (batchOptions.claimLane !== 'NON_GUARDIAN' || job.type !== 'RUNTIME_GUARDIAN'));
        const nextJob = index >= 0 ? queued.splice(index, 1)[0] : undefined;
        if (!nextJob) return batchResult(workerId, { claimed: 0, succeeded: 0, normalClaimed: 0 });
        executed.push(nextJob.id);
        return batchResult(workerId, {
          criticalClaimed: nextJob.type === 'RUNTIME_GUARDIAN' ? 1 : 0,
          normalClaimed: nextJob.type === 'RUNTIME_GUARDIAN' ? 0 : 1,
        });
      },
    });
    assert.equal(result.claimed, 1);
    assert.equal(result.claimAttempts, 1);
    assert.deepEqual(executed, ['guardian-only-budget']);
    assert.deepEqual(queued.map(job => job.id), ['ordinary-over-budget']);
  });

  await test('the reserved pool lane picks up a newly queued Runtime Guardian while ordinary work stays busy', async () => {
    const queued = [
      { id: 'recheck-long', type: 'RECHECK_PRODUCT_HEALTH', priority: 60, delay: 250 },
      { id: 'alerts-long', type: 'EVALUATE_ALERTS', priority: 55, delay: 250 },
      { id: 'ordinary-long', type: 'HEALTH_CHECK', priority: 40, delay: 250 },
      { id: 'ordinary-medium', type: 'HEALTH_CHECK', priority: 35, delay: 50 },
      { id: 'ordinary-later', type: 'SCORE_PRODUCTS', priority: 30, delay: 10 },
    ];
    const executions = new Map();
    let guardianCreatedAt = 0;
    let guardianStartedAt = 0;
    const enqueueGuardian = setTimeout(() => {
      guardianCreatedAt = Date.now();
      queued.push({ id: 'guardian-new', type: 'RUNTIME_GUARDIAN', priority: 100, delay: 5 });
    }, 10);
    const result = await worker.runContinuousWorkerPool({
      workerId: 'guardian-pickup-worker',
      maxConcurrency: 4,
      maximumClaims: 6,
      criticalReservedCapacity: 1,
      stopPollMs: 5,
      lanePollMs: 100,
      runBatch: async (workerId, ownership, batchOptions) => {
        const laneEligible = queued
            .filter(job => batchOptions.claimLane !== 'RUNTIME_GUARDIAN' || job.type === 'RUNTIME_GUARDIAN')
            .filter(job => batchOptions.claimLane !== 'NON_GUARDIAN' || job.type !== 'RUNTIME_GUARDIAN')
            .sort((left, right) => right.priority - left.priority);
        const nextJob = laneEligible[0];
        if (!nextJob) return batchResult(workerId, { claimed: 0, succeeded: 0, normalClaimed: 0 });
        queued.splice(queued.findIndex(job => job.id === nextJob.id), 1);
        executions.set(nextJob.id, (executions.get(nextJob.id) || 0) + 1);
        if (nextJob.type === 'RUNTIME_GUARDIAN') guardianStartedAt = Date.now();
        await new Promise(resolve => setTimeout(resolve, nextJob.delay));
        const critical = execution.isCriticalAutomationJob(nextJob.type);
        return batchResult(workerId, {
          criticalClaimed: critical ? 1 : 0,
          normalClaimed: critical ? 0 : 1,
        });
      },
    });
    clearTimeout(enqueueGuardian);
    assert.equal(result.maxConcurrency, 4);
    assert.equal(result.peakInFlight, 4);
    assert.equal(execution.isCriticalAutomationJob('RECHECK_PRODUCT_HEALTH'), false);
    assert.equal(execution.isCriticalAutomationJob('EVALUATE_ALERTS'), false);
    assert.equal(execution.isCriticalAutomationJob('RUNTIME_GUARDIAN'), true);
    assert.ok(guardianCreatedAt > 0 && guardianStartedAt >= guardianCreatedAt);
    assert.ok(guardianStartedAt - guardianCreatedAt < 500, JSON.stringify({ guardianCreatedAt, guardianStartedAt }));
    assert.ok(executions.has('ordinary-later'), 'ordinary work must continue making progress');
    assert.deepEqual([...executions.values()], Array.from(executions.values(), () => 1));
  });

  await test('the reserved Guardian slot is reusable while an unrelated ordinary job is still running', async () => {
    const guardians = [{ id: 'guardian-first', delay: 20 }];
    let ordinaryAvailable = true;
    let ordinaryCompletedAt = 0;
    let secondGuardianStartedAt = 0;
    const enqueueSecondGuardian = setTimeout(() => {
      guardians.push({ id: 'guardian-second', delay: 5 });
    }, 40);
    const result = await worker.runContinuousWorkerPool({
      workerId: 'guardian-reuse-worker',
      maxConcurrency: 2,
      maximumClaims: 3,
      criticalReservedCapacity: 1,
      stopPollMs: 10,
      lanePollMs: 100,
      runBatch: async (workerId, ownership, batchOptions) => {
        if (batchOptions.claimLane === 'RUNTIME_GUARDIAN') {
          const guardian = guardians.shift();
          if (!guardian) return batchResult(workerId, { claimed: 0, succeeded: 0, normalClaimed: 0 });
          if (guardian.id === 'guardian-second') secondGuardianStartedAt = Date.now();
          await new Promise(resolve => setTimeout(resolve, guardian.delay));
          return batchResult(workerId, { criticalClaimed: 1, normalClaimed: 0 });
        }
        if (!ordinaryAvailable) {
          return batchResult(workerId, { claimed: 0, succeeded: 0, normalClaimed: 0 });
        }
        ordinaryAvailable = false;
        await new Promise(resolve => setTimeout(resolve, 300));
        ordinaryCompletedAt = Date.now();
        return batchResult(workerId);
      },
    });
    clearTimeout(enqueueSecondGuardian);
    assert.equal(result.claimed, 3);
    assert.equal(result.criticalClaimed, 2);
    assert.equal(result.normalClaimed, 1);
    assert.ok(secondGuardianStartedAt > 0);
    assert.ok(secondGuardianStartedAt < ordinaryCompletedAt, JSON.stringify({
      secondGuardianStartedAt,
      ordinaryCompletedAt,
    }));
    assert.equal(guardians.length, 0);
  });

  await test('an empty Guardian lane and exhausted global budget terminate without a busy loop', async () => {
    let stopChecks = 0;
    let ordinaryClaims = 0;
    const result = await worker.runContinuousWorkerPool({
      workerId: 'settled-lanes-worker',
      maxConcurrency: 2,
      maximumClaims: 2,
      criticalReservedCapacity: 1,
      shouldStop: () => {
        stopChecks += 1;
        return stopChecks > 100;
      },
      runBatch: async (workerId, ownership, batchOptions) => {
        if (batchOptions.claimLane === 'RUNTIME_GUARDIAN') {
          return batchResult(workerId, { claimed: 0, succeeded: 0, normalClaimed: 0 });
        }
        ordinaryClaims += 1;
        return batchResult(workerId);
      },
    });
    assert.equal(result.stopRequested, false);
    assert.equal(result.claimed, 2);
    assert.equal(ordinaryClaims, 2);
    assert.ok(stopChecks < 20, JSON.stringify({ stopChecks, result }));
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

  await test('an empty reserved lane uses bounded probe backoff while ordinary work remains active', async () => {
    let guardianProbes = 0;
    let ordinaryAvailable = true;
    const result = await worker.runContinuousWorkerPool({
      workerId: 'reserved-lane-backoff-worker',
      maxConcurrency: 2,
      maximumClaims: 2,
      criticalReservedCapacity: 1,
      stopPollMs: 10,
      lanePollMs: 50,
      laneMaximumPollMs: 200,
      runBatch: async (workerId, ownership, batchOptions) => {
        if (batchOptions.claimLane === 'RUNTIME_GUARDIAN') {
          guardianProbes += 1;
          return batchResult(workerId, {
            claimed: 0,
            succeeded: 0,
            criticalClaimed: 0,
            normalClaimed: 0,
          });
        }
        if (!ordinaryAvailable) {
          return batchResult(workerId, {
            claimed: 0,
            succeeded: 0,
            criticalClaimed: 0,
            normalClaimed: 0,
          });
        }
        ordinaryAvailable = false;
        await new Promise(resolve => setTimeout(resolve, 420));
        return batchResult(workerId);
      },
    });
    assert.equal(result.claimed, 1);
    assert.ok(guardianProbes >= 2, `guardianProbes=${guardianProbes}`);
    assert.ok(guardianProbes <= 6, `guardianProbes=${guardianProbes}`);
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

  await test('Guardian reservation is strict while overdue ordinary work retains its lane fairness', () => {
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
        { runtimeGuardian: 1, nonGuardian: 1 },
    );
    assert.equal(selected[0].id, 'guardian');
    assert.equal(selected[1].id, 'overdue-normal');
    const reserved = execution.selectCompatibleWorkerJobs(
        [normal, overdueNormal],
        [],
        2,
        now,
        store.selectFairRunnableJobs,
        1,
        { runtimeGuardian: 1, nonGuardian: 1 },
    );
    assert.deepEqual(reserved.map(job => job.id), ['overdue-normal']);
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

  await test('durable claims atomically preserve the Guardian slot across concurrent ordinary claim attempts', async () => {
    await reset();
    for (let index = 0; index < 7; index += 1) await createJob('HEALTH_CHECK', `bound-${index}`);
    const claims = await Promise.all(Array.from({ length: 7 }, () =>
        store.claimAutomationJobs(
            'durable-bound-worker',
            1,
            60_000,
            Date.now(),
            undefined,
            {
              maximumInFlight: 4,
              criticalReservedCapacity: 1,
              enforceExecutionCompatibility: true,
              claimLane: 'NON_GUARDIAN',
            },
        )));
    assert.equal(claims.flat().length, 3);
    const guardian = await createJob('RUNTIME_GUARDIAN', 'reserved-after-long-jobs', {}, 100);
    const guardianCreatedAt = Date.parse(guardian.job.createdAt);
    const guardianClaim = await store.claimAutomationJobs(
        'durable-bound-worker',
        1,
        60_000,
        Date.now(),
        undefined,
        {
          maximumInFlight: 4,
          criticalReservedCapacity: 1,
          enforceExecutionCompatibility: true,
          claimLane: 'RUNTIME_GUARDIAN',
        },
    );
    assert.equal(guardianClaim.length, 1);
    assert.equal(guardianClaim[0].id, guardian.job.id);
    assert.ok(Date.parse(guardianClaim[0].claimedAt) - guardianCreatedAt < 30_000);
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

  await test('ordinary work uses only its bounded lane and continues alongside Guardian work', async () => {
    await reset();
    for (let index = 0; index < 4; index += 1) await createJob('HEALTH_CHECK', `borrow-${index}`, {}, 20 + index);
    let claimed = await store.claimAutomationJobs(
        'critical-capacity-worker',
        4,
        60_000,
        Date.now(),
        undefined,
        {
          maximumInFlight: 4,
          criticalReservedCapacity: 1,
          enforceExecutionCompatibility: true,
          claimLane: 'NON_GUARDIAN',
        },
    );
    assert.equal(claimed.length, 3);
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
        {
          maximumInFlight: 4,
          criticalReservedCapacity: 1,
          enforceExecutionCompatibility: true,
          claimLane: 'RUNTIME_GUARDIAN',
        },
    );
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, guardian.job.id);
    assert.equal(claimed.filter(job => job.executionCritical).length, 1);
    assert.ok(Date.parse(claimed[0].claimedAt) - Date.parse(claimed[0].scheduledAt) < 30_000);
    const ordinary = await store.claimAutomationJobs(
        'critical-capacity-worker',
        4,
        60_000,
        Date.now(),
        undefined,
        {
          maximumInFlight: 4,
          criticalReservedCapacity: 1,
          enforceExecutionCompatibility: true,
          claimLane: 'NON_GUARDIAN',
        },
    );
    assert.equal(ordinary.length, 3);
    assert.equal(ordinary.every(job => job.type !== 'RUNTIME_GUARDIAN'), true);
  });

  await test('production-sized mixed pending work cannot consume the reserved Guardian capacity', async () => {
    await reset();
    const mixedTypes = ['HEALTH_CHECK', 'EVALUATE_ALERTS', 'RECHECK_PRODUCT_HEALTH', 'SCORE_PRODUCTS'];
    const templates = [];
    for (const type of mixedTypes) {
      const created = await createJob(
          type,
          `production-template-${type.toLowerCase()}`,
          type === 'SCORE_PRODUCTS' ? { productId: 'mixed-product-template' } : {},
          50,
      );
      templates.push(created.job);
    }
    const fixtureStartedAt = Date.now();
    const fixtureNow = new Date().toISOString();
    const productionJobs = Array.from({ length: 13_000 }, (_, index) => {
      const template = structuredClone(templates[index % templates.length]);
      const suffix = String(index).padStart(5, '0');
      const productPayload = template.type === 'SCORE_PRODUCTS'
          ? { productId: `mixed-product-${suffix}` }
          : template.payload;
      return {
        ...template,
        id: `production-mixed-${suffix}`,
        idempotencyKey: `master-m2-production-mixed-${suffix}`,
        operationId: `master-m2-production-operation-${suffix}`,
        correlationId: `master-m2-production-correlation-${suffix}`,
        payload: productPayload,
        status: 'PENDING',
        priority: 20 + (index % 30),
        scheduledAt: fixtureNow,
        runnableAt: fixtureNow,
        createdAt: fixtureNow,
        updatedAt: fixtureNow,
      };
    });
    await adapter.writeCollection('automation-jobs', productionJobs);
    const ordinaryClaims = await store.claimAutomationJobs(
        'production-mixed-worker',
        4,
        60_000,
        Date.now(),
        undefined,
        {
          maximumInFlight: 4,
          criticalReservedCapacity: 1,
          enforceExecutionCompatibility: true,
          claimLane: 'NON_GUARDIAN',
        },
    );
    assert.equal(ordinaryClaims.length, 3);
    const guardian = await createJob('RUNTIME_GUARDIAN', 'production-mixed-guardian', {}, 100);
    const startedAt = Date.now();
    const guardianClaim = await store.claimAutomationJobs(
        'production-mixed-worker',
        1,
        60_000,
        Date.now(),
        undefined,
        {
          maximumInFlight: 4,
          criticalReservedCapacity: 1,
          enforceExecutionCompatibility: true,
          claimLane: 'RUNTIME_GUARDIAN',
        },
    );
    assert.equal(guardianClaim[0]?.id, guardian.job.id);
    const pickupMs = Date.now() - startedAt;
    assert.ok(pickupMs < 30_000);
    console.log(JSON.stringify({
      type: 'worker_guardian_capacity_benchmark',
      pendingJobs: productionJobs.length,
      fixtureMs: startedAt - fixtureStartedAt,
      pickupMs,
      ordinarySlotsClaimed: ordinaryClaims.length,
      guardianSlotsClaimed: guardianClaim.length,
    }));
  });

  await test('worker rollout controls retain safe defaults and enable only valid ACTIVE lanes', () => {
    const rollout = require('../src/lib/automation/featureRollout.ts');
    assert.equal(rollout.isContinuousWorkerPoolEnabled({ WORKER_CONTINUOUS_POOL_V2: 'ACTIVE' }), true);
    assert.equal(rollout.isContinuousWorkerPoolEnabled({ WORKER_CONTINUOUS_POOL_V2: 'OFF' }), false);
    assert.equal(rollout.isContinuousWorkerPoolEnabled({ WORKER_CONTINUOUS_POOL_V2: 'SHADOW' }), false);
    assert.equal(rollout.isContinuousWorkerPoolEnabled({ WORKER_CONTINUOUS_POOL_V2: 'OBSERVE' }), false);
    assert.equal(rollout.isContinuousWorkerPoolEnabled({ WORKER_CONTINUOUS_POOL_V2: 'CANARY' }), false);
    assert.equal(rollout.isContinuousWorkerPoolEnabled({ WORKER_CONTINUOUS_POOL_V2: 'not-a-mode' }), false);
    assert.equal(rollout.isCriticalWorkerSchedulingEnabled({}), false);
    assert.equal(rollout.isCriticalWorkerSchedulingEnabled({ WORKER_CRITICAL_SCHEDULING_V3: 'SHADOW' }), false);
    assert.equal(rollout.isCriticalWorkerSchedulingEnabled({ WORKER_CRITICAL_SCHEDULING_V3: 'ACTIVE' }), true);
    const workerScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'automation-worker.cjs'), 'utf8');
    assert.match(workerScript, /isContinuousWorkerPoolEnabled\(\)/);
    assert.match(workerScript, /criticalSchedulingActive[\s\S]*continuousPoolActive[\s\S]*runContinuousWorkerPool[\s\S]*processAutomationBatch/);
    const workerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'automation', 'worker.ts'), 'utf8');
    assert.match(workerSource, /jobLeaseMs = normalizeAutomationJobLeaseMs[\s\S]*claimAutomationJobs\(workerId, limit, jobLeaseMs, Date\.now\(\), ownership, options\)/);
    assert.match(workerSource, /for \(const job of claimed\)[\s\S]*startAutomationJobLeaseRenewal[\s\S]*claimedJobLifecycles\.set/);
    assert.match(workerSource, /maybeMaterializeJobHealthProjectionMaintenance/);
    assert.match(workerSource, /jobHealthMaintenanceMaterializationFlight/);
    assert.match(workerSource, /nextJobHealthMaintenanceMaterializationAt/);
    assert.match(workerSource, /activeJobIds/);
    assert.match(workerSource, /createWorkerActivityRegistry/);
    assert.match(workerSource, /queueWorkerActivityControlUpdate/);
    assert.match(workerSource, /activityRegistry/);
    assert.doesNotMatch(workerSource, /activeJobIds\.clear\(\)/);
    assert.match(workerSource, /automation_job_lease_renewal_diagnostic/);
    assert.match(workerSource, /automation_job_lease_authority_lost/);
    assert.doesNotMatch(workerSource, /getAutomationJobHealthView/);
    assert.match(
        workerSource,
        /orderAutomationWorkerBatch[\s\S]*isCriticalAutomationJob[\s\S]*orderedClaimed = orderAutomationWorkerBatch\(claimed\)[\s\S]*orderedClaimed\.every\(job => job\.type === 'PROCESS_CANDIDATE'\)[\s\S]*Promise\.all\(orderedClaimed\.map\(processJob\)\)[\s\S]*for \(const job of orderedClaimed\) await processJob\(job\)/,
    );
    assert.doesNotMatch(workerSource, /const claimOptions: WorkerBatchOptions/);
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

main()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => fs.rmSync(testRoot, { recursive: true, force: true }));
