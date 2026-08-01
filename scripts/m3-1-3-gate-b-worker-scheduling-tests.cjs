/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `m3-1-3-gate-b-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.SLO_RUNNABLE_AT_V2 = 'ACTIVE';
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

function iso(value) {
  return new Date(value).toISOString();
}

function attempt(id, values) {
  return {
    schemaVersion: 1,
    id,
    jobId: `job-${id}`,
    jobType: values.jobType,
    operationId: `operation-${id}`,
    attemptNumber: 1,
    runnableAt: values.runnableAt,
    runnableReason: values.runnableReason || 'CREATED_AT',
    createdAt: values.createdAt,
    scheduledAt: values.scheduledAt || values.createdAt,
    claimedAt: values.claimedAt,
    claimTokenHash: `claim-${id}`,
    workerId: 'fixture-worker',
    releaseId: values.releaseId,
    rolloutCohort: values.rolloutCohort,
    priorityClass: values.priorityClass,
    priority: values.priority,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const execution = require('../src/lib/automation/executionPolicy.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const store = require('../src/lib/automation/store.ts');
  const rollout = require('../src/lib/automation/featureRollout.ts');
  const operational = require('../src/lib/automation/operationalHealth.ts');
  const slo = require('../src/lib/automation/sloErrorBudget.ts');
  const release = require('../src/lib/releaseIdentity.ts');

  async function reset() {
    for (const collection of [
      'automation-jobs',
      'automation-job-attempts',
      'automation-job-heartbeats',
      'automation-job-projections',
      'automation-job-list-projections-v2',
      'automation-control',
      'automation-audit',
      'runtime-role-leases',
      'runtime-role-conflicts',
      'runtime-health',
      'publication-audit',
      'automation-outbound-events',
      'products',
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
    }, 'm3-1-3-gate-b');
  }

  async function createJob(type, suffix, payload = {}, priority = 50) {
    return store.createAutomationJob({
      type,
      payload,
      priority,
      idempotencyKey: `m3-1-3-gate-b-${type.toLowerCase()}-${suffix}`,
      operationId: `m3-1-3-gate-b-operation-${type.toLowerCase()}-${suffix}`,
      requestedBy: 'scheduler',
    });
  }

  await test('the serial mixed-batch ordering runs every critical class before normal work', () => {
    const now = new Date().toISOString();
    const normalOne = { id: 'normal-one', type: 'RECHECK_PRODUCT_HEALTH', payload: {}, createdAt: now };
    const monitor = { id: 'monitor', type: 'POST_PUBLISH_MONITOR', payload: {}, createdAt: now };
    const repair = {
      id: 'repair',
      type: 'RECONCILE_AUTOMATION',
      payload: { maintenanceTask: 'JOB_HEALTH_PROJECTION_REBUILD' },
      createdAt: now,
    };
    const normalTwo = { id: 'normal-two', type: 'EVALUATE_ALERTS', payload: {}, createdAt: now };
    const ordered = worker.orderAutomationWorkerBatch([normalOne, monitor, repair, normalTwo]);
    assert.deepEqual(ordered.map(job => job.id), ['monitor', 'repair', 'normal-one', 'normal-two']);
    assert.equal(execution.isCriticalAutomationJob(repair), true);
    assert.equal(execution.getAutomationExecutionDescriptor({ ...repair, operationId: 'repair-operation' }).critical, true);
  });

  await test('the V3 continuous pool reserves a reusable all-critical lane while normal work is busy', async () => {
    const queued = [
      { id: 'normal-one', type: 'RECHECK_PRODUCT_HEALTH', payload: {}, delay: 280 },
      { id: 'normal-two', type: 'EVALUATE_ALERTS', payload: {}, delay: 280 },
      { id: 'normal-three', type: 'SCORE_PRODUCTS', payload: { productId: 'product-3' }, delay: 10 },
    ];
    let criticalCreatedAt = 0;
    let criticalStartedAt = 0;
    let normalCompletedAt = 0;
    const addCritical = setTimeout(() => {
      criticalCreatedAt = Date.now();
      queued.push({ id: 'monitor-critical', type: 'POST_PUBLISH_MONITOR', payload: { productId: 'product-monitor' }, delay: 5 });
    }, 15);
    const result = await worker.runContinuousWorkerPool({
      workerId: 'm3-1-3-critical-pool',
      maxConcurrency: 3,
      maximumClaims: 3,
      criticalReservedCapacity: 1,
      priorityScheduling: 'ALL_CRITICAL',
      stopPollMs: 10,
      lanePollMs: 100,
      runBatch: async (workerId, ownership, options) => {
        const index = queued.findIndex(job => execution.isAutomationJobEligibleForClaimLane(job, options.claimLane));
        const job = index >= 0 ? queued.splice(index, 1)[0] : undefined;
        if (!job) return batchResult(workerId, { claimed: 0, succeeded: 0, normalClaimed: 0 });
        if (execution.isCriticalAutomationJob(job)) criticalStartedAt = Date.now();
        await new Promise(resolve => setTimeout(resolve, job.delay));
        if (!execution.isCriticalAutomationJob(job)) normalCompletedAt = Date.now();
        return batchResult(workerId, execution.isCriticalAutomationJob(job)
          ? { criticalClaimed: 1, normalClaimed: 0 }
          : {});
      },
    });
    clearTimeout(addCritical);
    assert.equal(result.priorityScheduling, 'ALL_CRITICAL');
    assert.equal(result.peakInFlight, 3);
    assert.ok(criticalCreatedAt > 0 && criticalStartedAt >= criticalCreatedAt);
    assert.ok(criticalStartedAt < normalCompletedAt, JSON.stringify({ criticalCreatedAt, criticalStartedAt, normalCompletedAt }));
  });

  await test('durable V3 lanes leave critical capacity available and reject duplicate concurrent critical claims', async () => {
    await reset();
    await createJob('RECHECK_PRODUCT_HEALTH', 'normal-one', { productId: 'product-one' }, 70);
    await createJob('EVALUATE_ALERTS', 'normal-two', {}, 65);
    const monitor = await createJob('POST_PUBLISH_MONITOR', 'monitor', { productId: 'product-monitor' }, 85);
    const repair = await createJob('RECONCILE_AUTOMATION', 'repair', {
      maintenanceTask: 'JOB_HEALTH_PROJECTION_REBUILD',
    }, 90);
    assert.equal(repair.job.executionCritical, true);
    assert.equal(monitor.job.executionCritical, true);

    const normalClaims = await store.claimAutomationJobs(
      'm3-1-3-durable-worker',
      3,
      60_000,
      Date.now(),
      undefined,
      {
        maximumInFlight: 3,
        criticalReservedCapacity: 1,
        enforceExecutionCompatibility: true,
        claimLane: 'NON_CRITICAL',
      },
    );
    assert.equal(normalClaims.length, 2);
    assert.equal(normalClaims.every(job => job.executionCritical === false), true);

    const claims = await Promise.all(Array.from({ length: 2 }, () => store.claimAutomationJobs(
      'm3-1-3-durable-worker',
      1,
      60_000,
      Date.now(),
      undefined,
      {
        maximumInFlight: 3,
        criticalReservedCapacity: 1,
        enforceExecutionCompatibility: true,
        claimLane: 'CRITICAL',
      },
    )));
    const claimed = claims.flat();
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].executionCritical, true);
    const attempts = await adapter.readCollection('automation-job-attempts');
    assert.equal(attempts.filter(item => item.jobId === claimed[0].id).length, 1);
    assert.equal(attempts.find(item => item.jobId === claimed[0].id).priorityClass, 'CRITICAL');
  });

  await test('the single-slot V3 path prefers waiting critical work when its shared slot becomes free', async () => {
    await reset();
    const normal = await createJob('EVALUATE_ALERTS', 'single-slot-normal', {}, 100);
    const critical = await createJob('POST_PUBLISH_MONITOR', 'single-slot-critical', {
      productId: 'product-single-slot-monitor',
    }, 1);
    const claim = await store.claimAutomationJobs(
      'm3-1-3-single-slot-worker',
      1,
      60_000,
      Date.now(),
      undefined,
      {
        maximumInFlight: 1,
        criticalReservedCapacity: 0,
        enforceExecutionCompatibility: true,
        claimLane: 'ANY',
        preferCritical: true,
      },
    );
    assert.equal(claim.length, 1);
    assert.equal(claim[0].id, critical.job.id);
    assert.notEqual(claim[0].id, normal.job.id);
  });

  await test('scheduler enqueue deduplication and lease-expiry recovery preserve exactly one active execution claim', async () => {
    await reset();
    const first = await createJob('RUNTIME_GUARDIAN', 'dedupe', { scheduleBucket: 123 }, 100);
    const duplicate = await store.createAutomationJob({
      type: 'RUNTIME_GUARDIAN',
      payload: { scheduleBucket: 123 },
      priority: 100,
      idempotencyKey: first.job.idempotencyKey,
      operationId: first.job.operationId,
      requestedBy: 'scheduler',
    });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);

    await reset();
    const crashed = await createJob('RECHECK_PRODUCT_HEALTH', 'crashed-claim', { productId: 'product-crash' }, 60);
    const now = Date.now();
    const initialClaim = await store.claimAutomationJobs('m3-1-3-crashed-worker', 1, 1_000, now);
    assert.equal(initialClaim.length, 1);
    const duplicateClaim = await store.claimAutomationJobs('m3-1-3-restarted-worker', 1, 1_000, now + 100);
    assert.equal(duplicateClaim.length, 0);
    const recoveryClaim = await store.claimAutomationJobs('m3-1-3-restarted-worker', 1, 1_000, now + 1_500);
    assert.equal(recoveryClaim.length, 0);
    const durable = await store.getAutomationJob(crashed.job.id);
    assert.equal(durable.status, 'RETRY_SCHEDULED');
    assert.equal(durable.claimedBy, undefined);
    assert.equal(durable.attemptCount, 1);
    const retryAt = Date.parse(durable.nextRetryAt);
    assert.ok(Number.isFinite(retryAt));
    const resumedClaim = await store.claimAutomationJobs(
      'm3-1-3-restarted-worker',
      1,
      1_000,
      retryAt + 1,
    );
    assert.equal(resumedClaim.length, 1);
    assert.equal(resumedClaim[0].id, crashed.job.id);
    assert.equal(resumedClaim[0].attemptCount, 2);
    const attempts = await adapter.readCollection('automation-job-attempts');
    assert.equal(attempts.filter(item => item.jobId === crashed.job.id).length, 2);
  });

  await test('priority metrics separate current, historical, and insufficient timestamp samples without a durable history scan', async () => {
    await reset();
    const now = Date.parse('2026-08-01T06:00:00.000Z');
    const currentRelease = release.getReleaseIdentity().releaseId;
    const currentCohort = 'SLO_RUNNABLE_AT_V2:ACTIVE';
    await adapter.writeCollection('automation-job-attempts', [
      attempt('current-critical', {
        jobType: 'POST_PUBLISH_MONITOR',
        priorityClass: 'CRITICAL',
        priority: 90,
        runnableAt: iso(now - 6_000),
        claimedAt: iso(now - 4_000),
        createdAt: iso(now - 7_000),
        releaseId: currentRelease,
        rolloutCohort: currentCohort,
      }),
      attempt('current-normal', {
        jobType: 'RECHECK_PRODUCT_HEALTH',
        priorityClass: 'NORMAL',
        priority: 60,
        runnableAt: iso(now - 5_000),
        claimedAt: iso(now - 1_000),
        createdAt: iso(now - 6_000),
        releaseId: currentRelease,
        rolloutCohort: currentCohort,
      }),
      attempt('historical-unclassified', {
        jobType: 'RECONCILE_AUTOMATION',
        runnableAt: iso(now - 8_000),
        claimedAt: iso(now - 7_000),
        createdAt: iso(now - 9_000),
        releaseId: 'legacy-release',
        rolloutCohort: 'SLO_RUNNABLE_AT_V2:SHADOW',
      }),
      attempt('missing-timestamp', {
        jobType: 'RECHECK_PRODUCT_HEALTH',
        priorityClass: 'NORMAL',
        createdAt: iso(now - 4_000),
        claimedAt: iso(now - 2_000),
        releaseId: currentRelease,
        rolloutCohort: currentCohort,
      }),
    ]);
    const measurement = await slo.measureAutomationSlo({ now, windowMs: 60_000, minimumSamples: 1 });
    assert.equal(measurement.pickupLatencyByPriorityClass.current.CRITICAL.sampleCount, 1);
    assert.equal(measurement.pickupLatencyByPriorityClass.current.NORMAL.sampleCount, 1);
    assert.equal(measurement.pickupLatencyByPriorityClass.historical.UNCLASSIFIED.sampleCount, 1);
    assert.equal(measurement.pickupLatencyExcludedLegacyCount, 1);
    assert.ok(measurement.pickupLatencyInsufficientTimestampCount >= 1);

    const summary = {
      currentStateComplete: true,
      statusCounts: { PENDING: 2, RETRY_SCHEDULED: 0, RUNNING: 2 },
      pendingJobs: [
        { id: 'pending-critical', type: 'POST_PUBLISH_MONITOR', executionCritical: true, runnableAt: iso(now - 3_000), createdAt: iso(now - 3_000) },
        { id: 'pending-normal', type: 'RECHECK_PRODUCT_HEALTH', executionCritical: false, runnableAt: iso(now - 2_000), createdAt: iso(now - 2_000) },
      ],
      runningJobs: [
        { id: 'running-critical', type: 'RUNTIME_GUARDIAN', executionCritical: true, createdAt: iso(now - 1_000) },
        { id: 'running-normal', type: 'EVALUATE_ALERTS', executionCritical: false, createdAt: iso(now - 1_000) },
      ],
    };
    const metrics = operational.buildBoundedWorkerPriorityMetrics(summary, now);
    assert.equal(metrics.status, 'COMPLETE');
    assert.equal(metrics.waitingCriticalJobs, 1);
    assert.equal(metrics.waitingNormalJobs, 1);
    assert.equal(metrics.runningCriticalJobs, 1);
    assert.equal(metrics.runningNormalJobs, 1);
    assert.equal(metrics.oldestUnclaimedRunnableJob.id, 'pending-critical');
  });

  await test('critical scheduling rollout defaults to shadow and exposes its effective state', () => {
    const defaultState = rollout.getWorkerCriticalSchedulingRolloutState({});
    assert.equal(defaultState.effectiveMode, 'SHADOW');
    assert.equal(defaultState.implementationActive, false);
    assert.equal(defaultState.disabledReason, 'WORKER_CRITICAL_SCHEDULING_OBSERVATION_ONLY');
    const activeState = rollout.getWorkerCriticalSchedulingRolloutState({ WORKER_CRITICAL_SCHEDULING_V3: 'ACTIVE' });
    assert.equal(activeState.implementationActive, true);
    assert.equal(activeState.rolloutCohort, 'WORKER_CRITICAL_SCHEDULING_V3:ACTIVE');
  });

  console.log(`\nM3.1.3 Gate B worker scheduling: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(testRoot, { recursive: true, force: true }));
