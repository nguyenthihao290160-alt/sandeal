/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const testRoot = path.join(process.cwd(), '.test-tmp', `m3-1-4-resource-performance-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '2_000';
process.env.SANDEAL_BUILD_COMMIT = 'f'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'f'.repeat(40);
process.env.GIT_COMMIT_SHA = 'f'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'f'.repeat(40);
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

function cleanup() {
  const resolved = path.resolve(testRoot);
  if (path.dirname(resolved) !== allowedTempRoot || !path.basename(resolved).startsWith('m3-1-4-resource-performance-')) {
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

  const originalLog = console.log;
  const originalInfo = console.info;
  async function quiet(work) {
    console.log = () => undefined;
    console.info = () => undefined;
    try { return await work(); } finally { console.log = originalLog; console.info = originalInfo; }
  }

  function diagnosticsDelta(before, after) {
    const reads = {};
    for (const [collection, value] of Object.entries(after.fullCollectionReadsByCollection)) {
      const delta = value - (before.fullCollectionReadsByCollection[collection] || 0);
      if (delta > 0) reads[collection] = delta;
    }
    return {
      fullReads: after.fullCollectionReadCount - before.fullCollectionReadCount,
      fullReadsByCollection: reads,
      automationJobFullReads: reads['automation-jobs'] || 0,
      scans: after.scanCollectionCount - before.scanCollectionCount,
      boundedReads: after.boundedReadCount - before.boundedReadCount,
      maximumLockHoldMs: after.maximumLockHoldMs,
    };
  }

  async function reset() {
    for (const collection of [
      'automation-jobs', 'automation-job-attempts', 'automation-job-heartbeats',
      'automation-job-projections', 'automation-job-list-projections-v2', 'automation-job-health-summary-v1',
      'automation-job-projection-manifest-v1', 'automation-job-projection-maintenance-v1',
      'automation-job-projection-rebuild-staging-v1', 'automation-control', 'automation-audit',
      'runtime-role-leases', 'runtime-role-conflicts', 'runtime-health', 'products', 'candidate-queue',
    ]) await adapter.writeCollection(collection, []);
    await settings.updateAutomationSettings({ enabled: false });
    await store.updateAutomationControl({
      mode: 'SHADOW', effectiveMode: 'SHADOW', workerPaused: false, schedulerPaused: false,
      ingestionPaused: false, killSwitch: false, publishPaused: true, workerHeartbeatAt: iso(Date.now()),
    }, 'm3-1-4-performance');
  }

  function fixtureJob(index, now) {
    const createdAt = iso(now - 86_400_000 + index);
    const completedAt = iso(now - 60_000 + index);
    return {
      schemaVersion: 2,
      policyVersion: 'performance-policy',
      handlerVersion: 'performance-handler',
      projectionSourceVersion: 1,
      projectionSourceSequence: 0,
      id: `m314-performance-${String(index).padStart(5, '0')}`,
      type: 'HEALTH_CHECK',
      status: 'SUCCEEDED',
      payload: { evidence: 'x'.repeat(3_600), sequence: index },
      result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES' },
      priority: 50,
      idempotencyKey: `m314-performance-key-${index}`,
      operationId: `m314-performance-operation-${index}`,
      requestedBy: 'm3-1-4-performance',
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

  await reset();
  const now = Date.now();
  let jobs = Array.from({ length: 13_000 }, (_, index) => fixtureJob(index, now));
  await adapter.writeCollection('automation-jobs', jobs);
  jobs = null;
  global.gc?.();
  const jobsFileBytes = fs.statSync(path.join(testRoot, 'automation-jobs.json')).size;
  const memorySamples = [process.memoryUsage()];

  async function repair(label, hooks = {}) {
    const started = performance.now();
    const before = adapter.getStorageDiagnosticsSnapshot();
    const manifest = await quiet(() => store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), {
      owner: {
        repairId: `m314-performance-repair-${label}`,
        ownerId: 'm314-performance-owner',
        ownerInstanceId: 'm314-performance-instance',
        workerFencingToken: 1,
        claimToken: `m314-performance-claim-${label}`,
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
        type: 'HEALTH_CHECK', payload: { source: 'm314-performance-catch-up' }, priority: 50,
        idempotencyKey: 'm314-performance-catch-up', operationId: 'm314-performance-catch-up',
        requestedBy: 'm3-1-4-performance', riskLevel: 'LOW', dryRun: false,
      });
    },
  });

  await settings.updateAutomationSettings({ enabled: true, intervalHours: 6, maxItemsPerRun: 10 });
  await store.updateAutomationControl({ workerHeartbeatAt: iso(Date.now()), schedulerPaused: false, workerPaused: false }, 'm3-1-4-performance');
  const coldSchedulerBefore = adapter.getStorageDiagnosticsSnapshot();
  const coldSchedulerStart = performance.now();
  const coldScheduler = await quiet(() => scheduler.runAutomationSchedulerTick(Date.now()));
  const coldSchedulerMs = performance.now() - coldSchedulerStart;
  const coldSchedulerDiagnostics = diagnosticsDelta(coldSchedulerBefore, adapter.getStorageDiagnosticsSnapshot());
  const warmSchedulerBefore = adapter.getStorageDiagnosticsSnapshot();
  const warmSchedulerStart = performance.now();
  const warmScheduler = await quiet(() => scheduler.runAutomationSchedulerTick(Date.now() + 1));
  const warmSchedulerMs = performance.now() - warmSchedulerStart;
  const warmSchedulerDiagnostics = diagnosticsDelta(warmSchedulerBefore, adapter.getStorageDiagnosticsSnapshot());

  const schedulerRole = await runtimeRoles.acquireRuntimeRole({
    role: 'SCHEDULER', ownerId: 'm314-performance-scheduler', instanceId: 'm314-performance-scheduler-instance',
    releaseId: 'f'.repeat(40), leaseMs: 45_000,
  });
  assert.equal(schedulerRole.acquired, true);
  const guardianCreated = await quiet(() => scheduler.runRuntimeControlSchedulerTick(Date.now()));
  const guardianDuplicate = await quiet(() => scheduler.runRuntimeControlSchedulerTick(Date.now()));
  const criticalJobs = (await adapter.readCollection('automation-jobs')).filter(item => item.type === 'RUNTIME_GUARDIAN' && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(item.status));
  assert.equal(guardianCreated.status, 'scheduled');
  assert.equal(guardianDuplicate.status, 'duplicate');
  assert.equal(criticalJobs.length, 1);

  const workerRole = await runtimeRoles.acquireRuntimeRole({
    role: 'WORKER', ownerId: 'm314-performance-worker', instanceId: 'm314-performance-worker-instance',
    releaseId: 'f'.repeat(40), leaseMs: 45_000,
  });
  assert.equal(workerRole.acquired, true);
  const workerBefore = adapter.getStorageDiagnosticsSnapshot();
  const workerStart = performance.now();
  const workerResult = await quiet(() => worker.processAutomationBatch(
    'm314-performance-worker',
    1,
    workerRole.ownership,
    { maximumInFlight: 1, criticalReservedCapacity: 1, enforceExecutionCompatibility: true, claimLane: 'RUNTIME_GUARDIAN', preferCritical: true },
  ));
  const workerMs = performance.now() - workerStart;
  const workerDiagnostics = diagnosticsDelta(workerBefore, adapter.getStorageDiagnosticsSnapshot());
  const criticalAfter = (await adapter.readCollection('automation-jobs')).find(item => item.type === 'RUNTIME_GUARDIAN');
  const pickupLatencyMs = criticalAfter && criticalAfter.claimedAt && criticalAfter.scheduledAt
    ? Math.max(0, Date.parse(criticalAfter.claimedAt) - Date.parse(criticalAfter.scheduledAt))
    : null;
  memorySamples.push(process.memoryUsage());

  const peakRss = Math.max(...memorySamples.map(sample => sample.rss));
  const peakHeap = Math.max(...memorySamples.map(sample => sample.heapUsed));
  const finalDiagnostics = adapter.getStorageDiagnosticsSnapshot();
  const report = {
    fixture: { jobs: 13_000, fileBytes: jobsFileBytes, fileMB: mb(jobsFileBytes) },
    repair: {
      coldMs: coldRepair.durationMs,
      warmMs: warmRepair.durationMs,
      catchUpMs: catchUp.durationMs,
      cold: coldRepair.diagnostics,
      warm: warmRepair.diagnostics,
      catchUp: catchUp.diagnostics,
      durableJobCount: catchUp.manifest.durableJobCount,
      retainedJobCount: catchUp.manifest.retainedJobCount,
    },
    scheduler: {
      coldMs: coldSchedulerMs,
      warmMs: warmSchedulerMs,
      coldStatus: coldScheduler.status,
      warmStatus: warmScheduler.status,
      cold: coldSchedulerDiagnostics,
      warm: warmSchedulerDiagnostics,
    },
    worker: { durationMs: workerMs, result: workerResult, diagnostics: workerDiagnostics, criticalPickupLatencyMs: pickupLatencyMs },
    critical: { first: guardianCreated.status, duplicate: guardianDuplicate.status, activeCount: criticalJobs.length },
    memory: { peakRssMB: mb(peakRss), peakHeapMB: mb(peakHeap), finalRssMB: mb(process.memoryUsage().rss) },
    diagnostics: { final: finalDiagnostics, maximumLockHoldMs: finalDiagnostics.maximumLockHoldMs },
    acceptance: {
      noUnboundedFullReads: coldRepair.diagnostics.automationJobFullReads === 0 && catchUp.diagnostics.automationJobFullReads === 0,
      noDuplicateCritical: criticalJobs.length === 1,
      peakRssBelowVpsRoom: peakRss < 768 * 1024 * 1024,
    },
  };
  assert.equal(report.acceptance.noUnboundedFullReads, true);
  assert.equal(report.acceptance.noDuplicateCritical, true);
  assert.equal(report.acceptance.peakRssBelowVpsRoom, true, `peak RSS ${report.memory.peakRssMB.toFixed(1)}MB`);
  console.log(`M3.1.4 performance report ${JSON.stringify(report)}`);
  console.log('M3.1.4 performance: PASS');
}

main()
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { cleanup(); } catch (error) { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; }
  });
