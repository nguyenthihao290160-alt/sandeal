/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const testRoot = path.join(
  process.cwd(),
  '.test-tmp',
  `m3-1-2-projection-performance-${process.pid}-${Date.now()}`,
);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '2000';
process.env.SANDEAL_BUILD_COMMIT = 'd'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'd'.repeat(40);
process.env.GIT_COMMIT_SHA = 'd'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'd'.repeat(40);
require('./register-typescript.cjs');

function cleanupTestRoot() {
  const resolvedRoot = path.resolve(testRoot);
  const expectedParent = path.resolve(process.cwd(), '.test-tmp');
  if (
    path.dirname(resolvedRoot) !== expectedParent
    || !path.basename(resolvedRoot).startsWith('m3-1-2-projection-performance-')
  ) {
    throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolvedRoot}`);
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

function iso(value) {
  return new Date(value).toISOString();
}

function fixtureJob(index, now) {
  const createdAt = iso(now - 86_400_000 + index);
  const completedAt = iso(now - 60_000 + index);
  const running = index === 0;
  const pending = index > 0 && index < 5;
  return {
    schemaVersion: 2,
    policyVersion: 'performance-policy',
    handlerVersion: 'performance-handler',
    projectionSourceVersion: 1,
    id: `performance-job-${String(index).padStart(5, '0')}`,
    type: index === 0 ? 'RUNTIME_GUARDIAN' : 'HEALTH_CHECK',
    status: running ? 'RUNNING' : pending ? 'PENDING' : 'SUCCEEDED',
    payload: { evidence: 'x'.repeat(3_600), sequence: index },
    result: running || pending ? undefined : { executionStatus: 'COMPLETED_WITH_LOCAL_RULES' },
    priority: 50,
    idempotencyKey: `performance-job-key-${index}`,
    operationId: `performance-operation-${index}`,
    requestedBy: index % 10 === 0 ? 'scheduler' : 'performance-fixture',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: running ? 1 : pending ? 0 : 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'CREATED_AT',
    claimedAt: running ? iso(now - 2_000) : pending ? undefined : iso(now - 59_000 + index),
    claimedBy: running ? 'performance-worker' : undefined,
    claimToken: running ? 'local-test-performance-claim' : undefined,
    heartbeatAt: running ? iso(now - 500) : undefined,
    leaseExpiresAt: running ? iso(now + 60_000) : undefined,
    startedAt: running ? iso(now - 2_000) : pending ? undefined : iso(now - 59_000 + index),
    completedAt: running || pending ? undefined : completedAt,
    createdAt,
    updatedAt: running ? iso(now - 2_000) : pending ? createdAt : completedAt,
  };
}

function runtimeSnapshot(index, now) {
  const checkedAt = iso(now - (499 - index) * 1_000);
  return {
    schemaVersion: 1,
    id: `performance-runtime-${index}`,
    ruleVersion: 'runtime-guardian-v2',
    web: {
      status: 'ready',
      buildAvailable: true,
      publicRouteHealthy: true,
      buildId: 'performance-build',
      releaseId: 'd'.repeat(40),
      releaseMatchesBuild: true,
    },
    worker: { status: 'active', heartbeatAt: checkedAt, releaseId: 'd'.repeat(40) },
    scheduler: { status: 'active', heartbeatAt: checkedAt, releaseId: 'd'.repeat(40) },
    providers: {},
    queue: { pending: 4, running: 1, stuck: 0, staleJobs: 0 },
    storage: { status: 'healthy', staleLocks: 0, freeBytes: 1024 * 1024 * 1024 },
    duplicateRoles: [],
    publishSafe: true,
    reasons: [],
    historicalReasons: [],
    recommendation: { pausePublish: false, pauseIngestion: false },
    checkedAt,
  };
}

function memorySample(samples, label) {
  const usage = process.memoryUsage();
  samples.push({ label, heapUsed: usage.heapUsed, rss: usage.rss });
}

function mb(bytes) {
  return bytes / (1024 * 1024);
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const health = require('../src/lib/automation/jobHealthSummary.ts');
  const healthService = require('../src/lib/automation/healthService.ts');
  const maintenance = require('../src/lib/automation/projectionMaintenance.ts');
  const store = require('../src/lib/automation/store.ts');
  const now = Date.now();
  const memorySamples = [];
  let repairCounter = 0;
  let fullJobReads = 0;
  const fsPromises = require('node:fs').promises;
  const originalReadFile = fsPromises.readFile;
  fsPromises.readFile = async function instrumentedReadFile(target, ...rest) {
    if (path.basename(String(target)) === 'automation-jobs.json') fullJobReads += 1;
    return originalReadFile.call(this, target, ...rest);
  };

  function owner(label) {
    repairCounter += 1;
    return {
      repairId: `performance-repair-${label}-${repairCounter}`,
      ownerId: 'performance-owner',
      ownerInstanceId: 'performance-instance',
      workerFencingToken: repairCounter,
      claimToken: `performance-claim-${label}-${repairCounter}`,
      attemptNumber: 1,
    };
  }

  async function measuredRepair(label, workload = {}) {
    const timing = {
      startedAt: performance.now(),
      baseEndedAt: null,
      validationStartedAt: null,
      publishStartedAt: null,
      atomicPromotedAt: null,
      legacyMirroredAt: null,
      completedAt: null,
      catchUpPasses: 0,
      deltaJobCount: 0,
      retainedCandidateRecords: 0,
    };
    const readsAtStart = fullJobReads;
    const manifest = await store.rebuildAutomationJobReadModelsFromDurable(null, now, {
      owner: owner(label),
      maximumCatchUpPasses: 3,
      catchUpBackoffMs: [0, 0, 0],
      sleep: async () => undefined,
      onPhase: ({ phase }) => {
        if (phase === 'PUBLISHING') timing.publishStartedAt = performance.now();
      },
      hooks: {
        afterBaseRebuild: async ({ candidate, context }) => {
          timing.baseEndedAt = performance.now();
          timing.retainedCandidateRecords = candidate.listProjections.length
            + candidate.statusProjections.length;
          memorySample(memorySamples, `${label}:base`);
          await workload.afterBaseRebuild?.({ candidate, context });
        },
        afterCatchUpPass: async input => {
          timing.catchUpPasses = input.pass;
          timing.deltaJobCount += input.deltaJobCount;
          memorySample(memorySamples, `${label}:catch-up-${input.pass}`);
          await workload.afterCatchUpPass?.(input);
        },
        beforeCandidateValidation: async input => {
          timing.validationStartedAt = performance.now();
          await workload.beforeCandidateValidation?.(input);
        },
        beforePublication: workload.beforePublication,
        afterAtomicPromotion: async input => {
          timing.atomicPromotedAt = performance.now();
          memorySample(memorySamples, `${label}:promoted`);
          await workload.afterAtomicPromotion?.(input);
        },
        afterLegacyMirror: async input => {
          timing.legacyMirroredAt = performance.now();
          await workload.afterLegacyMirror?.(input);
        },
      },
    });
    timing.completedAt = performance.now();
    memorySample(memorySamples, `${label}:complete`);
    return {
      manifest,
      fullJobReads: fullJobReads - readsAtStart,
      baseMs: timing.baseEndedAt - timing.startedAt,
      catchUpMs: timing.validationStartedAt - timing.baseEndedAt,
      promotionMs: timing.atomicPromotedAt - timing.publishStartedAt,
      legacyMirrorMs: timing.legacyMirroredAt - timing.atomicPromotedAt,
      totalMs: timing.completedAt - timing.startedAt,
      catchUpPasses: timing.catchUpPasses,
      deltaJobCount: timing.deltaJobCount,
      retainedCandidateRecords: timing.retainedCandidateRecords,
    };
  }

  try {
    await Promise.all([
      adapter.writeCollection('automation-job-projections', []),
      adapter.writeCollection('automation-job-list-projections-v2', []),
      adapter.writeCollection('automation-job-health-summary-v1', []),
      adapter.writeCollection('automation-job-projection-manifest-v1', []),
      adapter.writeCollection('automation-job-projection-maintenance-v1', []),
      adapter.writeCollection('automation-job-projection-rebuild-staging-v1', []),
      adapter.writeCollection('automation-control', []),
      adapter.writeCollection('automation-audit', []),
      adapter.writeCollection('automation-job-attempts', []),
      adapter.writeCollection('runtime-role-leases', []),
      adapter.writeCollection('runtime-role-conflicts', []),
      adapter.writeCollection('products', []),
      adapter.writeCollection('candidate-queue', []),
    ]);
    let jobs = Array.from({ length: 13_000 }, (_, index) => fixtureJob(index, now));
    await adapter.writeCollection('automation-jobs', jobs);
    jobs = null;
    await adapter.writeCollection('automation-job-heartbeats', [{
      id: 'performance-job-00000',
      jobId: 'performance-job-00000',
      workerId: 'performance-worker',
      claimToken: 'local-test-performance-claim',
      heartbeatAt: iso(now - 500),
      leaseExpiresAt: iso(now + 60_000),
    }]);
    await adapter.writeCollection(
      'runtime-health',
      Array.from({ length: 500 }, (_, index) => runtimeSnapshot(index, now)),
    );
    global.gc?.();
    memorySample(memorySamples, 'fixture-persisted');
    const jobsFileBytes = fs.statSync(path.join(testRoot, 'automation-jobs.json')).size;
    assert.ok(jobsFileBytes >= 55 * 1024 * 1024, `fixture=${mb(jobsFileBytes).toFixed(1)}MB`);

    fullJobReads = 0;
    const base = await measuredRepair('base');
    assert.equal(base.fullJobReads, 2);
    assert.equal(base.catchUpPasses, 1);
    assert.equal(base.manifest.durableJobCount, 13_000);
    assert.equal(base.manifest.currentStateComplete, true);

    fullJobReads = 0;
    const relevantMutationStartedAt = { value: null };
    const relevantMutationEndedAt = { value: null };
    const relevant = await measuredRepair('relevant-write', {
      afterBaseRebuild: async () => {
        relevantMutationStartedAt.value = performance.now();
        await store.createAutomationJob({
          type: 'HEALTH_CHECK',
          payload: { source: 'performance-relevant-write' },
          priority: 60,
          idempotencyKey: 'performance-relevant-write-job',
          operationId: 'performance-relevant-write-operation',
          requestedBy: 'performance-test',
          riskLevel: 'LOW',
          dryRun: false,
        });
        relevantMutationEndedAt.value = performance.now();
      },
    });
    assert.equal(relevant.fullJobReads, 3);
    assert.ok(relevant.deltaJobCount >= 1);
    assert.equal(relevant.manifest.durableJobCount, 13_001);
    assert.equal(
      relevant.manifest.sourceFingerprint,
      store.automationJobProjectionSourceFingerprint(await store.getAllAutomationJobs()),
    );

    const heartbeatBoundary = relevant.manifest.sourceHighWatermark;
    fullJobReads = 0;
    const heartbeatErrors = [];
    const originalConsoleError = console.error;
    console.error = value => heartbeatErrors.push(String(value));
    let heartbeatWrites = 0;
    let heartbeatWorkMs = 0;
    let heartbeat;
    try {
      heartbeat = await measuredRepair('continuous-heartbeat', {
        afterBaseRebuild: async () => {
          const startedAt = performance.now();
          for (let index = 0; index < 6; index += 1) {
            assert.equal(await store.heartbeatAutomationJob(
              'performance-job-00000',
              'performance-worker',
              60_000,
              'local-test-performance-claim',
            ), true);
            heartbeatWrites += 1;
          }
          heartbeatWorkMs += performance.now() - startedAt;
        },
        afterCatchUpPass: async () => {
          const startedAt = performance.now();
          assert.equal(await store.heartbeatAutomationJob(
            'performance-job-00000',
            'performance-worker',
            60_000,
            'local-test-performance-claim',
          ), true);
          heartbeatWrites += 1;
          heartbeatWorkMs += performance.now() - startedAt;
        },
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(heartbeat.fullJobReads, 2);
    assert.equal(heartbeat.manifest.sourceHighWatermark, heartbeatBoundary);
    assert.ok(heartbeatWrites >= 7);
    assert.equal(
      heartbeatErrors.some(value => value.includes('JOB_HEALTH_SUMMARY_SOURCE_REVISION_CHANGED')),
      false,
    );

    fullJobReads = 0;
    const dependencies = {
      getGeminiReadiness: async () => ({
        status: 'not_configured',
        adapterAvailable: true,
        configured: false,
        totalConnections: 0,
        enabledConnections: 0,
        validConnections: 0,
        generationReadyConnections: 0,
        productionReadyConnections: 0,
        primaryCredentialId: null,
        primaryReady: false,
        reason: 'NOT_CONFIGURED',
      }),
      getAccessTradeCredential: async () => null,
    };
    global.gc?.();
    const interactiveMemoryBefore = process.memoryUsage().heapUsed;
    const coldStartedAt = performance.now();
    const cold = await healthService.buildAutomationHealthResponse({ now, dependencies });
    const coldMs = performance.now() - coldStartedAt;
    const warmStartedAt = performance.now();
    const warm = await healthService.buildAutomationHealthResponse({ now: now + 1, dependencies });
    const warmMs = performance.now() - warmStartedAt;
    for (let index = 0; index < 3; index += 1) {
      await healthService.buildAutomationHealthResponse({ now: now + index + 2, dependencies });
    }
    global.gc?.();
    const interactiveMemoryAfter = process.memoryUsage().heapUsed;
    assert.equal(fullJobReads, 0);
    assert.ok(coldMs < 4_500, `cold=${coldMs.toFixed(1)}ms`);
    assert.ok(warmMs < 2_700, `warm=${warmMs.toFixed(1)}ms`);
    assert.ok(Buffer.byteLength(JSON.stringify(cold)) < 512 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(warm)) < 512 * 1024);

    const heldMutation = await health.beginAutomationJobProjectionMutation(Date.now());
    let schedulingMs;
    let scheduled;
    try {
      const invalidView = await health.getAutomationJobHealthView(Date.now());
      fullJobReads = 0;
      const schedulingStartedAt = performance.now();
      scheduled = await maintenance.ensureJobHealthProjectionMaintenanceRequest(
        invalidView,
        Date.now(),
      );
      schedulingMs = performance.now() - schedulingStartedAt;
      assert.equal(fullJobReads, 0);
      assert.ok(schedulingMs < 1_500, `scheduling=${schedulingMs.toFixed(1)}ms`);
      assert.equal(scheduled.status, 'REQUESTED');
      assert.equal(scheduled.jobId, null);
      assert.ok(scheduled.repairId);
    } finally {
      await health.abortAutomationJobProjectionMutation(heldMutation);
    }

    const peakHeapBytes = Math.max(...memorySamples.map(sample => sample.heapUsed));
    const peakRssBytes = Math.max(...memorySamples.map(sample => sample.rss));
    assert.ok(peakRssBytes < 1.5 * 1024 * 1024 * 1024, `peakRss=${mb(peakRssBytes).toFixed(1)}MB`);
    assert.ok(base.retainedCandidateRecords <= 4_000);
    assert.ok(relevant.retainedCandidateRecords <= 4_000);
    assert.ok(heartbeat.retainedCandidateRecords <= 4_000);

    const relevantMutationMs = relevantMutationEndedAt.value - relevantMutationStartedAt.value;
    console.log(`METRIC fixture jobs=13000 runtimeSnapshots=500 jobsFileMB=${mb(jobsFileBytes).toFixed(1)}`);
    console.log(`METRIC appHealth coldMs=${coldMs.toFixed(1)} warmMs=${warmMs.toFixed(1)} repeatedReads=5 durableJobReads=0 heapDeltaMB=${mb(interactiveMemoryAfter - interactiveMemoryBefore).toFixed(1)}`);
    console.log(`METRIC scheduling latencyMs=${schedulingMs.toFixed(1)} durableJobReads=0 jobEnqueuedInline=false repairId=${scheduled.repairId}`);
    console.log(`METRIC baseRepair totalMs=${base.totalMs.toFixed(1)} baseMs=${base.baseMs.toFixed(1)} catchUpMs=${base.catchUpMs.toFixed(1)} promotionMs=${base.promotionMs.toFixed(1)} legacyMirrorMs=${base.legacyMirrorMs.toFixed(1)} fullJobReads=${base.fullJobReads} catchUpPasses=${base.catchUpPasses}`);
    console.log(`METRIC relevantRepair totalMs=${relevant.totalMs.toFixed(1)} mutationMs=${relevantMutationMs.toFixed(1)} catchUpMs=${relevant.catchUpMs.toFixed(1)} promotionMs=${relevant.promotionMs.toFixed(1)} fullJobReads=${relevant.fullJobReads} deltaJobs=${relevant.deltaJobCount}`);
    console.log(`METRIC heartbeatRepair totalMs=${heartbeat.totalMs.toFixed(1)} heartbeatWorkMs=${heartbeatWorkMs.toFixed(1)} heartbeatWrites=${heartbeatWrites} catchUpMs=${heartbeat.catchUpMs.toFixed(1)} promotionMs=${heartbeat.promotionMs.toFixed(1)} fullJobReads=${heartbeat.fullJobReads} sourceBoundaryMoved=false`);
    console.log(`METRIC memory peakHeapMB=${mb(peakHeapBytes).toFixed(1)} peakRssMB=${mb(peakRssBytes).toFixed(1)} candidateCopiesPeakBound=2 candidateProjectionRecordsPeakBound=8000`);
    console.log('M3.1.2 projection performance: PASS');
  } finally {
    fsPromises.readFile = originalReadFile;
  }
}

main()
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      cleanupTestRoot();
    } catch (error) {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    }
  });
