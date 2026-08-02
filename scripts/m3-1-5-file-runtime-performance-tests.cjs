/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const testRoot = path.join(process.cwd(), '.test-tmp', `m3-1-5-file-runtime-performance-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_FILE_LOCK_WAIT_MS = '7000';
process.env.SANDEAL_FILE_LOCK_LEASE_MS = '15000';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '2_000';
process.env.SANDEAL_BUILD_COMMIT = '6'.repeat(40);
process.env.SANDEAL_RELEASE_ID = '6'.repeat(40);
process.env.GIT_COMMIT_SHA = '6'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = '6'.repeat(40);
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

function cleanup() {
  const resolved = path.resolve(testRoot);
  if (path.dirname(resolved) !== allowedTempRoot || !path.basename(resolved).startsWith('m3-1-5-file-runtime-performance-')) {
    throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function iso(value) { return new Date(value).toISOString(); }
function mb(value) { return value / (1024 * 1024); }

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const runtimeRoles = require('../src/lib/automation/runtimeRoles.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const worker = require('../src/lib/automation/worker.ts');

  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  async function quiet(work) {
    console.log = () => undefined;
    console.info = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    try { return await work(); } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
  }

  const collections = [
    'automation-jobs', 'automation-job-attempts', 'automation-job-heartbeats',
    'automation-job-projections', 'automation-job-list-projections-v2', 'automation-job-health-summary-v1',
    'automation-job-projection-manifest-v1', 'automation-job-projection-maintenance-v1',
    'automation-job-projection-rebuild-staging-v1', 'automation-control', 'automation-audit',
    'runtime-role-leases', 'runtime-role-conflicts', 'runtime-role-fencing', 'runtime-health',
    'products', 'candidate-queue',
  ];
  await Promise.all(collections.map(collection => adapter.writeCollection(collection, [])));
  await settings.updateAutomationSettings({ enabled: false });
  await store.updateAutomationControl({
    mode: 'SHADOW', effectiveMode: 'SHADOW', workerPaused: false, schedulerPaused: false,
    ingestionPaused: false, killSwitch: false, publishPaused: true,
    workerHeartbeatAt: iso(Date.now()), schedulerHeartbeatAt: iso(Date.now()),
  }, 'm3-1-5-performance');

  function fixtureJob(index, now) {
    const createdAt = iso(now - 86_400_000 + index);
    const completedAt = iso(now - 60_000 + index);
    return {
      schemaVersion: 2,
      policyVersion: 'performance-policy',
      handlerVersion: 'performance-handler',
      projectionSourceVersion: 1,
      projectionSourceSequence: 0,
      id: `m315-performance-${String(index).padStart(5, '0')}`,
      type: 'HEALTH_CHECK',
      status: 'SUCCEEDED',
      payload: { evidence: 'x'.repeat(3_600), sequence: index, locale: 'Đà Nẵng' },
      result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES' },
      priority: 50,
      idempotencyKey: `m315-performance-key-${index}`,
      operationId: `m315-performance-operation-${index}`,
      requestedBy: 'm3-1-5-performance',
      approvalStatus: 'NOT_REQUIRED',
      riskLevel: 'LOW',
      dryRun: false,
      attemptCount: 1,
      maxAttempts: 3,
      queuedAt: createdAt,
      scheduledAt: createdAt,
      runnableAt: createdAt,
      runnableReason: 'CREATED_AT',
      startedAt: completedAt,
      completedAt,
      createdAt,
      updatedAt: completedAt,
    };
  }

  const now = Date.now();
  let jobs = Array.from({ length: 13_000 }, (_, index) => fixtureJob(index, now));
  await adapter.writeCollection('automation-jobs', jobs);
  jobs = null;
  global.gc?.();
  const jobsFileBytes = fs.statSync(path.join(testRoot, 'automation-jobs.json')).size;
  const memorySamples = [process.memoryUsage()];

  function diagnosticsDelta(before, after) {
    const fullReadsByCollection = {};
    for (const [collection, value] of Object.entries(after.fullCollectionReadsByCollection)) {
      const delta = value - (before.fullCollectionReadsByCollection[collection] || 0);
      if (delta > 0) fullReadsByCollection[collection] = delta;
    }
    return {
      fullDurableCollectionReads: after.fullCollectionReadCount - before.fullCollectionReadCount,
      fullReadsByCollection,
      automationJobsFullReads: fullReadsByCollection['automation-jobs'] || 0,
      boundedReads: after.boundedReadCount - before.boundedReadCount,
      scans: after.scanCollectionCount - before.scanCollectionCount,
      lockWaitCount: after.lockWaitCount - before.lockWaitCount,
      totalLockWaitMs: after.totalLockWaitMs - before.totalLockWaitMs,
      maximumLockWaitMs: after.maximumLockWaitMs,
      totalLockHoldMs: after.totalLockHoldMs - before.totalLockHoldMs,
      maximumLockHoldMs: after.maximumLockHoldMs,
      staleLockRecoveries: after.staleLockRecoveryCount - before.staleLockRecoveryCount,
      fencingRejections: after.fencingRejectionCount - before.fencingRejectionCount,
    };
  }

  async function repair(label, hooks = {}) {
    const before = adapter.getStorageDiagnosticsSnapshot();
    const started = performance.now();
    const manifest = await quiet(() => store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), {
      owner: {
        repairId: `m315-performance-repair-${label}`,
        ownerId: 'm315-performance-owner',
        ownerInstanceId: 'm315-performance-instance',
        workerFencingToken: 1,
        claimToken: `m315-performance-claim-${label}`,
        attemptNumber: 1,
      },
      maximumCatchUpPasses: 3,
      catchUpBackoffMs: [0, 0, 0],
      sleep: async () => undefined,
      hooks,
    }));
    memorySamples.push(process.memoryUsage());
    return {
      durationMs: performance.now() - started,
      manifest,
      diagnostics: diagnosticsDelta(before, adapter.getStorageDiagnosticsSnapshot()),
    };
  }

  adapter.resetStorageDiagnostics();
  const coldRepair = await repair('cold');
  global.gc?.();
  const warmRepair = await repair('warm');
  const catchUp = await repair('catch-up', {
    afterBaseRebuild: async () => {
      await store.createAutomationJob({
        type: 'HEALTH_CHECK', payload: { source: 'm315-performance-catch-up' }, priority: 50,
        idempotencyKey: 'm315-performance-catch-up', operationId: 'm315-performance-catch-up',
        requestedBy: 'm3-1-5-performance', riskLevel: 'LOW', dryRun: false,
      });
    },
  });

  await settings.updateAutomationSettings({ enabled: true, intervalHours: 6, maxItemsPerRun: 10 });
  await store.updateAutomationControl({ workerHeartbeatAt: iso(Date.now()), schedulerPaused: false, workerPaused: false }, 'm3-1-5-performance');
  const schedulerRole = await runtimeRoles.acquireRuntimeRole({
    role: 'SCHEDULER', ownerId: 'm315-performance-scheduler', instanceId: 'm315-performance-scheduler-instance',
    releaseId: '6'.repeat(40), leaseMs: 45_000,
  });
  assert.equal(schedulerRole.acquired, true);

  const coldSchedulerBefore = adapter.getStorageDiagnosticsSnapshot();
  const coldSchedulerStarted = performance.now();
  const coldScheduler = await quiet(() => scheduler.runOwnedSchedulerCycle(schedulerRole.ownership, Date.now()));
  const coldSchedulerMs = performance.now() - coldSchedulerStarted;
  const coldSchedulerDiagnostics = diagnosticsDelta(coldSchedulerBefore, adapter.getStorageDiagnosticsSnapshot());
  const warmSchedulerBefore = adapter.getStorageDiagnosticsSnapshot();
  const warmSchedulerStarted = performance.now();
  const warmScheduler = await quiet(() => scheduler.runOwnedSchedulerCycle(schedulerRole.ownership, Date.now() + 1));
  const warmSchedulerMs = performance.now() - warmSchedulerStarted;
  const warmSchedulerDiagnostics = diagnosticsDelta(warmSchedulerBefore, adapter.getStorageDiagnosticsSnapshot());

  const jobsAfterScheduler = await adapter.readCollectionPage('automation-jobs', {
    page: 1, pageSize: 100, filters: { type: 'RUNTIME_GUARDIAN' },
  });
  const criticalJobs = jobsAfterScheduler.items.filter(item => item.type === 'RUNTIME_GUARDIAN');
  assert.equal(criticalJobs.length, 1);
  const duplicateRepairOwner = {
    repairId: 'm315-performance-duplicate-repair', ownerId: 'm315-performance-duplicate-owner',
    ownerInstanceId: 'm315-performance-duplicate-instance', workerFencingToken: 1,
    claimToken: 'local-test-duplicate-claim', attemptNumber: 1,
  };
  const duplicateRepair = await quiet(() => Promise.all([
    store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), {
      owner: duplicateRepairOwner, maximumCatchUpPasses: 1, catchUpBackoffMs: [0], sleep: async () => undefined,
    }),
    store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), {
      owner: duplicateRepairOwner, maximumCatchUpPasses: 1, catchUpBackoffMs: [0], sleep: async () => undefined,
    }),
  ]));
  assert.strictEqual(duplicateRepair[0], duplicateRepair[1]);

  const workerRole = await runtimeRoles.acquireRuntimeRole({
    role: 'WORKER', ownerId: 'm315-performance-worker', instanceId: 'm315-performance-worker-instance',
    releaseId: '6'.repeat(40), leaseMs: 45_000,
  });
  assert.equal(workerRole.acquired, true);
  const workerBefore = adapter.getStorageDiagnosticsSnapshot();
  const workerStarted = performance.now();
  const workerResult = await quiet(() => worker.processAutomationBatch(
    'm315-performance-worker', 1, workerRole.ownership,
    { maximumInFlight: 1, criticalReservedCapacity: 1, enforceExecutionCompatibility: true, claimLane: 'RUNTIME_GUARDIAN', preferCritical: true },
  ));
  const workerMs = performance.now() - workerStarted;
  const workerDiagnostics = diagnosticsDelta(workerBefore, adapter.getStorageDiagnosticsSnapshot());
  memorySamples.push(process.memoryUsage());
  global.gc?.();
  const repeatedCycleHeapBefore = process.memoryUsage().heapUsed;
  for (let index = 0; index < 4; index += 1) {
    await quiet(() => worker.processAutomationBatch('m315-performance-worker', 1, workerRole.ownership, {
      maximumInFlight: 1, criticalReservedCapacity: 1, enforceExecutionCompatibility: true,
      claimLane: 'RUNTIME_GUARDIAN', preferCritical: true,
    }));
  }
  global.gc?.();
  const repeatedCycleHeapAfter = process.memoryUsage().heapUsed;
  memorySamples.push(process.memoryUsage());

  const criticalAfter = (await adapter.readCollectionPage('automation-jobs', {
    page: 1, pageSize: 100, filters: { type: 'RUNTIME_GUARDIAN' },
  })).items.find(item => item.type === 'RUNTIME_GUARDIAN');
  const pickupLatencyMs = criticalAfter?.claimedAt && criticalAfter?.scheduledAt
    ? Math.max(0, Date.parse(criticalAfter.claimedAt) - Date.parse(criticalAfter.scheduledAt))
    : null;
  await runtimeRoles.releaseRuntimeRole('WORKER', workerRole.ownership);
  await runtimeRoles.releaseRuntimeRole('SCHEDULER', schedulerRole.ownership);

  const peakRss = Math.max(...memorySamples.map(sample => sample.rss));
  const peakHeap = Math.max(...memorySamples.map(sample => sample.heapUsed));
  const report = {
    fixture: { jobs: 13_000, fileBytes: jobsFileBytes, fileMB: mb(jobsFileBytes) },
    repair: {
      coldMs: coldRepair.durationMs,
      warmMs: warmRepair.durationMs,
      incrementalCatchUpMs: catchUp.durationMs,
      cold: coldRepair.diagnostics,
      warm: warmRepair.diagnostics,
      incrementalCatchUp: catchUp.diagnostics,
      durableJobCount: catchUp.manifest.durableJobCount,
      retainedJobCount: catchUp.manifest.retainedJobCount,
      effectiveDuplicateRepairs: duplicateRepair[0] === duplicateRepair[1] ? 1 : 2,
    },
    scheduler: {
      coldMs: coldSchedulerMs,
      warmMs: warmSchedulerMs,
      coldStatus: coldScheduler.status,
      warmStatus: warmScheduler.status,
      cold: coldSchedulerDiagnostics,
      warm: warmSchedulerDiagnostics,
    },
    worker: {
      coldMs: workerMs,
      result: workerResult,
      diagnostics: workerDiagnostics,
      repeatedCycleHeapDeltaBytes: repeatedCycleHeapAfter - repeatedCycleHeapBefore,
      criticalPickupLatencyMs: pickupLatencyMs,
    },
    memory: { peakRssMB: mb(peakRss), peakHeapMB: mb(peakHeap), finalRssMB: mb(process.memoryUsage().rss) },
    acceptance: {
      noInfiniteRepairReadLoop: coldRepair.diagnostics.automationJobsFullReads === 0
        && warmRepair.diagnostics.automationJobsFullReads === 0
        && catchUp.diagnostics.automationJobsFullReads === 0,
      readsBelowProductionBaseline: workerDiagnostics.automationJobsFullReads < 136,
      lockHoldBelowProductionBaseline: Math.max(
        coldSchedulerDiagnostics.maximumLockHoldMs,
        warmSchedulerDiagnostics.maximumLockHoldMs,
        workerDiagnostics.maximumLockHoldMs,
      ) < 30_697,
      noDuplicateCritical: criticalJobs.length === 1,
      oneEffectiveDuplicateRepair: duplicateRepair[0] === duplicateRepair[1],
      repeatedCycleHeapBounded: repeatedCycleHeapAfter - repeatedCycleHeapBefore < 96 * 1024 * 1024,
      peakRssBelowVpsRoom: peakRss < 768 * 1024 * 1024,
    },
  };
  assert.equal(report.acceptance.noInfiniteRepairReadLoop, true);
  assert.equal(report.acceptance.readsBelowProductionBaseline, true, `worker automation-jobs reads ${workerDiagnostics.automationJobsFullReads}`);
  assert.equal(report.acceptance.lockHoldBelowProductionBaseline, true, `maximum lock hold ${Math.max(coldSchedulerDiagnostics.maximumLockHoldMs, warmSchedulerDiagnostics.maximumLockHoldMs, workerDiagnostics.maximumLockHoldMs)}ms`);
  assert.equal(report.acceptance.noDuplicateCritical, true);
  assert.equal(report.acceptance.oneEffectiveDuplicateRepair, true);
  assert.equal(report.acceptance.repeatedCycleHeapBounded, true);
  assert.equal(report.acceptance.peakRssBelowVpsRoom, true, `peak RSS ${report.memory.peakRssMB.toFixed(1)}MB`);
  console.log(`M3.1.5 performance report ${JSON.stringify(report)}`);
  console.log('M3.1.5 file runtime performance: PASS');
}

main()
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { cleanup(); } catch (error) {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    }
  });
