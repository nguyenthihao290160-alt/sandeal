/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const testRoot = path.join(
  process.cwd(),
  '.test-tmp',
  `m3-1-1-projection-repair-${process.pid}-${Date.now()}`,
);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '500';
process.env.SANDEAL_BUILD_COMMIT = 'b'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'b'.repeat(40);
process.env.GIT_COMMIT_SHA = 'b'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'b'.repeat(40);
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
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function iso(value) {
  return new Date(value).toISOString();
}

function automationJob(index, now, overrides = {}) {
  const createdAt = iso(now - 20_000 + index);
  return {
    schemaVersion: 2,
    policyVersion: 'test-policy',
    handlerVersion: 'test-handler',
    id: `m311-job-${index}`,
    type: index === 1 ? 'PRODUCT_SCAN' : 'HEALTH_CHECK',
    status: 'SUCCEEDED',
    payload: {},
    result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES' },
    priority: 50,
    idempotencyKey: `m311-job-key-${index}`,
    operationId: `m311-operation-${index}`,
    requestedBy: 'm311-test',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'CREATED_AT',
    claimedAt: iso(now - 19_000 + index),
    startedAt: iso(now - 19_000 + index),
    completedAt: iso(now - 18_000 + index),
    createdAt,
    updatedAt: iso(now - 18_000 + index),
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const health = require('../src/lib/automation/jobHealthSummary.ts');
  const healthService = require('../src/lib/automation/healthService.ts');
  const maintenance = require('../src/lib/automation/projectionMaintenance.ts');
  const flow = require('../src/lib/automation/productFlowDiagnostics.ts');
  const executionPolicy = require('../src/lib/automation/executionPolicy.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const mongoSerialization = require('../src/lib/storage/mongoSerialization.ts');
  const now = Date.parse('2026-07-31T03:00:00.000Z');

  async function resetBaseline(jobs = [automationJob(1, now), automationJob(2, now)]) {
    await Promise.all([
      adapter.writeCollection('automation-jobs', jobs),
      adapter.writeCollection('automation-job-heartbeats', []),
      adapter.writeCollection('automation-job-projections', []),
      adapter.writeCollection('automation-job-list-projections-v2', []),
      adapter.writeCollection('automation-job-health-summary-v1', []),
      adapter.writeCollection('automation-job-projection-manifest-v1', []),
      adapter.writeCollection('automation-job-projection-maintenance-v1', []),
      adapter.writeCollection('automation-job-projection-rebuild-staging-v1', []),
      adapter.writeCollection('automation-control', []),
      adapter.writeCollection('automation-audit', []),
      adapter.writeCollection('runtime-health', []),
      adapter.writeCollection('products', []),
      adapter.writeCollection('candidate-queue', []),
    ]);
    await store.rebuildAutomationJobReadModelsFromDurable(jobs, now);
    return jobs;
  }

  await test('canonical projection fingerprints ignore property order and normalized heartbeat volatility', () => {
    assert.equal(
      health.deterministicProjectionFingerprint({ beta: 2, alpha: { z: 1, a: 2 } }),
      health.deterministicProjectionFingerprint({ alpha: { a: 2, z: 1 }, beta: 2 }),
    );
    assert.equal(
      health.automationJobProjectionContentFingerprint([{ id: 'a', status: 'RUNNING', heartbeatAt: iso(now) }]),
      health.automationJobProjectionContentFingerprint([{ status: 'RUNNING', id: 'a', heartbeatAt: iso(now + 5_000) }]),
    );
  });

  await test('file and Mongo serialization retain identical valid manifest semantics', async () => {
    await resetBaseline();
    const manifest = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.ok(manifest);
    const mongoDocuments = mongoSerialization.serializeMongoItems([manifest], 7);
    const [roundTripped] = mongoSerialization.deserializeMongoItems(mongoDocuments);
    assert.deepEqual(roundTripped, manifest);
    assert.equal(health.validateAutomationJobProjectionManifest(roundTripped).valid, true);
    assert.equal(
      health.deterministicProjectionFingerprint(roundTripped),
      health.deterministicProjectionFingerprint(manifest),
    );
  });

  await test('invalid projection status is bounded, fast, and never reads durable job history', async () => {
    await resetBaseline();
    await health.beginAutomationJobProjectionSync(now + 1_000);
    const fsPromises = require('node:fs').promises;
    const originalReadFile = fsPromises.readFile;
    let durableReads = 0;
    fsPromises.readFile = async function instrumentedReadFile(target, ...args) {
      if (path.basename(String(target)) === 'automation-jobs.json') durableReads += 1;
      return originalReadFile.call(this, target, ...args);
    };
    try {
      const started = performance.now();
      const view = await health.getAutomationJobHealthView(now + 1_001);
      const durationMs = performance.now() - started;
      assert.notEqual(view.projectionStatus, 'VALID');
      assert.equal(view.currentStateComplete, false);
      assert.equal(durableReads, 0);
      assert.ok(durationMs < 500, `projection status duration ${durationMs.toFixed(1)}ms`);
      console.log(`METRIC projection_status_invalid durationMs=${durationMs.toFixed(1)} durableReads=${durableReads}`);
    } finally {
      fsPromises.readFile = originalReadFile;
    }
  });

  await test('one scheduled repair is reused while waiting, running, and retry-scheduled', async () => {
    await resetBaseline();
    await health.beginAutomationJobProjectionSync(now + 2_000);
    const invalidView = await health.getAutomationJobHealthView(now + 2_001);
    const first = await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, now + 2_002);
    const waiting = await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, now + 2_003);
    assert.equal(first.status, 'REQUESTED');
    assert.equal(waiting.status, 'REUSED_ACTIVE_REQUEST');
    await maintenance.materializeJobHealthProjectionMaintenanceRequest(now + 2_003);
    await adapter.runTransaction('automation-job-projection-maintenance-v1', items => items.map(item => ({
      ...item,
      status: 'RUNNING',
      startedAt: iso(now + 2_004),
    })));
    const running = await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, now + 2_005);
    assert.equal(running.status, 'REUSED_ACTIVE_REQUEST');
    assert.equal(running.repairState, 'RUNNING');
    await adapter.runTransaction('automation-job-projection-maintenance-v1', items => items.map(item => ({
      ...item,
      status: 'RETRY_SCHEDULED',
      nextRetryAt: iso(now + 60_000),
    })));
    const retry = await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, now + 2_006);
    assert.equal(retry.status, 'REUSED_ACTIVE_REQUEST');
    assert.equal(retry.repairState, 'RETRY_SCHEDULED');
    const jobs = await adapter.readCollection('automation-jobs');
    assert.equal(jobs.filter(job => job.payload.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD').length, 1);
    assert.ok(retry.duplicateRequestsSuppressed >= 3);
  });

  await test('mutating maintenance work is not abandoned by an interactive component timeout', async () => {
    await resetBaseline();
    let mutations = 0;
    const started = performance.now();
    const response = await healthService.buildAutomationHealthResponse({
      now,
      budgets: { maintenanceMs: 100 },
      dependencies: {
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
        ensureProjectionMaintenance: async () => {
          await new Promise(resolve => setTimeout(resolve, 150));
          mutations += 1;
          return {
            status: 'REQUESTED',
            repairState: 'SCHEDULED',
            jobId: 'repair-fixture',
            attemptCount: 1,
            maximumAttempts: 3,
            nextRetryAt: null,
            duplicateRequestsSuppressed: 0,
            incidentFingerprint: 'f'.repeat(64),
            reasonCodes: ['JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH'],
            requestedAt: iso(now),
            startedAt: null,
            completedAt: null,
            durationMs: null,
            sourceRevision: null,
            resultRevision: null,
            resultFingerprint: null,
            outcomeReasonCode: 'JOB_HEALTH_PROJECTION_REBUILD_REQUESTED',
          };
        },
      },
    });
    const durationMs = performance.now() - started;
    assert.equal(mutations, 1);
    assert.notEqual(response.components.projectionMaintenance.reasonCode, 'COMPONENT_TIMEOUT');
    assert.ok(durationMs >= 140, `maintenance returned after ${durationMs.toFixed(1)}ms`);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(mutations, 1);
  });

  await test('candidate validation happens before replacement and preserves the previous valid projection', async () => {
    await resetBaseline();
    const previousManifest = await health.getAutomationJobProjectionManifestForMaintenance();
    const previousList = await adapter.readCollection('automation-job-list-projections-v2');
    const previousStatuses = await adapter.readCollection('automation-job-projections');
    const invalid = automationJob(10, now, { updatedAt: 'not-a-timestamp' });
    await adapter.writeCollection('automation-jobs', [invalid]);
    await assert.rejects(
      () => store.rebuildAutomationJobReadModelsFromDurable([invalid], now + 3_000),
      /JOB_PROJECTION_CANDIDATE_ITEM_INVALID/,
    );
    assert.deepEqual(await adapter.readCollection('automation-job-list-projections-v2'), previousList);
    assert.deepEqual(await adapter.readCollection('automation-job-projections'), previousStatuses);
    const manifest = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.equal(manifest.sourceRevision, previousManifest.sourceRevision);
    assert.equal(manifest.projectionFingerprint, previousManifest.projectionFingerprint);
    assert.equal(manifest.lastRebuildStatus, 'FAILED');
  });

  await test('a write failure rolls back both live projections and keeps the prior manifest active', async () => {
    await resetBaseline();
    const previousManifest = await health.getAutomationJobProjectionManifestForMaintenance();
    const previousList = await adapter.readCollection('automation-job-list-projections-v2');
    const previousStatuses = await adapter.readCollection('automation-job-projections');
    const replacement = [automationJob(20, now), automationJob(21, now), automationJob(22, now)];
    await adapter.writeCollection('automation-jobs', replacement);
    const originalRunTransaction = adapter.runTransaction;
    let failOnce = true;
    adapter.runTransaction = async function injectedRunTransaction(collection, fn) {
      if (collection.startsWith('automation-job-list-projections-v2-generation-') && failOnce) {
        failOnce = false;
        throw new Error('TEST_ATOMIC_REPLACEMENT_FAILURE');
      }
      return originalRunTransaction(collection, fn);
    };
    try {
      await assert.rejects(
        () => store.rebuildAutomationJobReadModelsFromDurable(replacement, now + 4_000),
        /TEST_ATOMIC_REPLACEMENT_FAILURE/,
      );
    } finally {
      adapter.runTransaction = originalRunTransaction;
    }
    assert.deepEqual(await adapter.readCollection('automation-job-list-projections-v2'), previousList);
    assert.deepEqual(await adapter.readCollection('automation-job-projections'), previousStatuses);
    const manifest = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.equal(manifest.sourceRevision, previousManifest.sourceRevision);
    assert.equal(manifest.projectionFingerprint, previousManifest.projectionFingerprint);
  });

  await test('successful replacement activates matching list, status, summary, and manifest revisions', async () => {
    await resetBaseline();
    const replacement = [automationJob(30, now), automationJob(31, now), automationJob(32, now)];
    await adapter.writeCollection('automation-jobs', replacement);
    const manifest = await store.rebuildAutomationJobReadModelsFromDurable(replacement, now + 5_000);
    const [list, statuses, view] = await Promise.all([
      health.readBoundedAutomationJobProjections(),
      health.readBoundedAutomationJobStatuses(),
      health.getAutomationJobHealthView(now + 5_001),
    ]);
    assert.deepEqual(list.items.map(item => item.id).sort(), replacement.map(item => item.id).sort());
    assert.deepEqual(statuses.items.map(item => item.id).sort(), replacement.map(item => item.id).sort());
    assert.equal(list.projectionFingerprint, manifest.projectionFingerprint);
    assert.equal(statuses.projectionFingerprint, manifest.projectionFingerprint);
    assert.equal(view.sourceRevision, manifest.sourceRevision);
    assert.equal(view.projectionStatus, 'VALID');
  });

  await test('product flow keeps product truth, marks invalid job data unknown, and recovers after replacement', async () => {
    const jobs = await resetBaseline([automationJob(1, now, { type: 'PRODUCT_SCAN' })]);
    await adapter.writeCollection('products', [{
      id: 'product-known',
      name: 'Known product',
      title: 'Known product',
      status: 'draft',
      lifecycleState: 'VERIFYING',
      price: 100000,
      salePrice: 100000,
      createdAt: iso(now - 10_000),
      updatedAt: iso(now - 5_000),
    }]);
    await health.beginAutomationJobProjectionSync(now + 6_000);
    const invalidStatus = await health.getAutomationJobHealthView(now + 6_001);
    let jobReads = 0;
    const dependencies = {
      projectionStatus: invalidStatus,
      readJobs: async () => {
        jobReads += 1;
        return health.readBoundedAutomationJobStatuses();
      },
      getSourceHealth: async () => ({ status: 'ready', configured: true, ready: true, checkedAt: iso(now) }),
      getAiReadiness: async () => ({
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
      getControl: async () => ({ ...store.DEFAULT_CONTROL, updatedAt: iso(now) }),
    };
    const unknown = await flow.buildProductFlowDiagnostics(now + 6_001, dependencies);
    assert.equal(jobReads, 0);
    assert.equal(unknown.currentState.totalCanonicalProducts, 1);
    assert.equal(unknown.recentHistory.recentSourceIngestionSuccessCount, null);
    assert.equal(unknown.evidence.jobHistory.currentStateComplete, false);

    await resetBaseline(jobs);
    await adapter.writeCollection('products', [{
      id: 'product-known',
      name: 'Known product',
      title: 'Known product',
      status: 'draft',
      lifecycleState: 'VERIFYING',
      price: 100000,
      salePrice: 100000,
      createdAt: iso(now - 10_000),
      updatedAt: iso(now - 5_000),
    }]);
    const validStatus = await health.getAutomationJobHealthView(now + 6_002);
    const recovered = await flow.buildProductFlowDiagnostics(now + 6_002, {
      ...dependencies,
      projectionStatus: validStatus,
    });
    assert.equal(jobReads, 1);
    assert.equal(recovered.currentState.totalCanonicalProducts, 1);
    assert.equal(recovered.recentHistory.recentSourceIngestionSuccessCount, 1);
    assert.equal(recovered.evidence.jobHistory.currentStateComplete, true);
  });

  await test('projection maintenance conflicts with itself but never blocks Runtime Guardian capacity', () => {
    const repair = {
      type: 'RECONCILE_AUTOMATION',
      payload: { maintenanceTask: 'JOB_HEALTH_PROJECTION_REBUILD' },
      operationId: 'repair-one',
    };
    const secondRepair = { ...repair, operationId: 'repair-two' };
    const guardian = { type: 'RUNTIME_GUARDIAN', payload: {}, operationId: 'guardian-one' };
    assert.equal(executionPolicy.automationJobsConflict(repair, secondRepair), true);
    assert.equal(executionPolicy.automationJobsConflict(repair, guardian), false);
    assert.equal(executionPolicy.getAutomationExecutionDescriptor(repair).exclusive, false);
  });

  await test('maintenance failure is retried without escaping or crashing the worker batch', async () => {
    await resetBaseline();
    await store.updateAutomationControl({
      workerPaused: false,
      killSwitch: false,
      workerHeartbeatAt: iso(Date.now()),
      reason: 'M311_WORKER_TEST',
    }, 'm311-test');
    const created = await store.createAutomationJob({
      type: 'RECONCILE_AUTOMATION',
      payload: { maintenanceTask: 'JOB_HEALTH_PROJECTION_REBUILD' },
      idempotencyKey: 'm311-worker-repair-failure',
      operationId: 'm311-worker-repair-failure',
      requestedBy: 'm311-test',
      priority: 90,
      riskLevel: 'MEDIUM',
      dryRun: false,
      maxAttempts: 3,
    });
    const originalRunTransaction = adapter.runTransaction;
    let failOnce = true;
    adapter.runTransaction = async function injectedRunTransaction(collection, fn) {
      if (collection === 'automation-job-projection-rebuild-staging-v1' && failOnce) {
        failOnce = false;
        throw new Error('TEMPORARY_ERROR:TEST_MAINTENANCE_FAILURE');
      }
      return originalRunTransaction(collection, fn);
    };
    let result;
    try {
      result = await worker.processAutomationBatch('m311-worker', 1);
    } finally {
      adapter.runTransaction = originalRunTransaction;
    }
    assert.equal(result.failed, 1);
    const failedJob = await store.getAutomationJob(created.job.id);
    assert.equal(failedJob.status, 'RETRY_SCHEDULED');
    assert.ok(failedJob.nextRetryAt);
  });

  console.log(`\nM3.1.1 projection repair: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    failed += 1;
    console.error(`FAIL setup\n${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const resolved = path.resolve(testRoot);
    const expectedParent = path.resolve(process.cwd(), '.test-tmp');
    try {
      if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('m3-1-1-projection-repair-')) {
        throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolved}`);
      }
      fs.rmSync(resolved, { recursive: true, force: true });
      console.log(`Cleaned isolated artifacts: ${path.relative(process.cwd(), resolved)}`);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
