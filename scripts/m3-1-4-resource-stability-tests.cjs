/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `m3-1-4-resource-stability-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_BUILD_COMMIT = 'e'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'e'.repeat(40);
process.env.GIT_COMMIT_SHA = 'e'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'e'.repeat(40);
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
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function cleanup() {
  const resolved = path.resolve(testRoot);
  if (path.dirname(resolved) !== allowedTempRoot || !path.basename(resolved).startsWith('m3-1-4-resource-stability-')) {
    throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function iso(value) {
  return new Date(value).toISOString();
}

function fixtureJob(id, now = Date.now(), overrides = {}) {
  const createdAt = iso(now - 10_000);
  return {
    schemaVersion: 2,
    policyVersion: 'stability-policy',
    handlerVersion: 'stability-handler',
    projectionSourceVersion: 1,
    projectionSourceSequence: 0,
    id,
    type: 'HEALTH_CHECK',
    status: 'SUCCEEDED',
    payload: { source: 'm3.1.4' },
    result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES' },
    priority: 50,
    idempotencyKey: `${id}:key`,
    operationId: `${id}:operation`,
    requestedBy: 'm3-1-4-test',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'CREATED_AT',
    createdAt,
    updatedAt: iso(now - 5_000),
    completedAt: iso(now - 4_000),
    ...overrides,
  };
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
  'runtime-health',
  'products',
  'candidate-queue',
];

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const health = require('../src/lib/automation/jobHealthSummary.ts');
  const store = require('../src/lib/automation/store.ts');
  const runtimeRoles = require('../src/lib/automation/runtimeRoles.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const budget = require('../src/lib/automation/executionBudget.ts');
  const urlSafety = require('../src/lib/product-intelligence/urlSafety.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const mongoSerialization = require('../src/lib/storage/mongoSerialization.ts');

  async function quiet(work) {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      return await work();
    } finally {
      console.log = originalLog;
    }
  }

  async function reset(jobs = []) {
    await Promise.all(COLLECTIONS.map(collection => adapter.writeCollection(collection, [])));
    await adapter.writeCollection('automation-jobs', jobs);
    await settings.updateAutomationSettings({ enabled: false });
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      workerPaused: false,
      schedulerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
      publishPaused: true,
      workerHeartbeatAt: iso(Date.now()),
    }, 'm3-1-4-test');
  }

  function owner(label, fencingToken = 1) {
    return {
      repairId: `m314-repair-${label}`,
      ownerId: `m314-owner-${label}`,
      ownerInstanceId: `m314-instance-${label}`,
      workerFencingToken: fencingToken,
      claimToken: `m314-claim-${label}`,
      attemptNumber: 1,
    };
  }

  async function repair(label, options = {}) {
    return quiet(() => store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), {
      owner: options.owner || owner(label),
      maximumCatchUpPasses: options.maximumCatchUpPasses || 3,
      catchUpBackoffMs: [0, 0, 0, 0],
      sleep: async () => undefined,
      authorizePublication: options.authorizePublication,
      hooks: options.hooks,
    }));
  }

  await test('file scan and page paths do not materialize the durable collection', async () => {
    const values = Array.from({ length: 3_000 }, (_, index) => ({
      id: `stream-${index}`,
      value: index,
      nested: { values: [index, index + 1], text: 'closing ] brace } is data' },
    }));
    await adapter.writeCollection('stream-fixture', values);
    adapter.resetStorageDiagnostics();
    let scanned = 0;
    await adapter.scanCollection('stream-fixture', item => {
      if (item.id === 'stream-2999') scanned += 1;
    });
    const page = await adapter.readCollectionPage('stream-fixture', {
      page: 1,
      pageSize: 1,
      filters: { id: 'stream-2999' },
    });
    const diagnostics = adapter.getStorageDiagnosticsSnapshot();
    assert.equal(scanned, 1);
    assert.equal(page.totalItems, 1);
    assert.equal(page.items[0].id, 'stream-2999');
    assert.equal(diagnostics.fullCollectionReadCount, 0);
    assert.equal(diagnostics.scanCollectionCount, 1);
  });

  await test('streaming atomic mutation supports nested JSON and rejects corrupt delimiters', async () => {
    const file = path.join(testRoot, 'nested-fixture.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 'nested-a', value: 1, array: [1, { close: ']' }] },
      { id: 'nested-b', value: 2 },
    ]));
    const mutation = await adapter.runStreamingTransaction('nested-fixture', item => {
      if (item.id !== 'nested-b') return false;
      item.value = 3;
      return true;
    });
    assert.equal(mutation.changed, true);
    assert.equal((await adapter.readCollectionPage('nested-fixture', { page: 1, pageSize: 1, filters: { id: 'nested-b' } })).items[0].value, 3);
    fs.writeFileSync(file, '[{"id":"bad"},]');
    await assert.rejects(() => adapter.scanCollection('nested-fixture', () => undefined), /collection_trailing_delimiter/);
  });

  await test('repair captures a stable high-watermark and catches up a concurrent write', async () => {
    await reset([fixtureJob('hwm-base')]);
    let startBoundary;
    let catchUpPasses = 0;
    let deltaJobs = 0;
    const manifest = await repair('hwm', {
      hooks: {
        afterBaseRebuild: async ({ context }) => {
          startBoundary = context.startBoundary.highWatermark;
          await store.createAutomationJob({
            type: 'HEALTH_CHECK',
            payload: { source: 'hwm-write' },
            priority: 50,
            idempotencyKey: 'm314-hwm-write',
            operationId: 'm314-hwm-write',
            requestedBy: 'm3-1-4-test',
            riskLevel: 'LOW',
            dryRun: false,
          });
        },
        afterCatchUpPass: async input => {
          catchUpPasses = input.pass;
          deltaJobs += input.deltaJobCount;
        },
      },
    });
    assert.equal(startBoundary, 0);
    assert.ok(catchUpPasses >= 1);
    assert.ok(deltaJobs >= 1);
    assert.equal(manifest.durableJobCount, 2);
    assert.ok(manifest.sourceHighWatermark >= 1);
  });

  await test('duplicate repair execution has one effective flight', async () => {
    await reset([fixtureJob('flight-base')]);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const repairOwner = owner('flight');
    const first = store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), {
      owner: repairOwner,
      catchUpBackoffMs: [0, 0],
      sleep: async () => undefined,
      hooks: { afterBaseRebuild: async () => hold },
    });
    const second = store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), {
      owner: repairOwner,
      catchUpBackoffMs: [0, 0],
      sleep: async () => undefined,
    });
    assert.strictEqual(first, second);
    release();
    await quiet(() => first);
  });

  await test('crash or stale fencing preserves the previous serving generation', async () => {
    await reset([fixtureJob('serving-base')]);
    const serving = await repair('serving-base');
    await assert.rejects(
      () => repair('crash', { hooks: { beforePublication: async () => { throw new Error('M314_SIMULATED_CRASH'); } } }),
      /M314_SIMULATED_CRASH/,
    );
    const afterCrash = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.equal(afterCrash.activeGeneration, serving.activeGeneration);
    await assert.rejects(
      () => repair('stale', { authorizePublication: async () => false }),
      /FENCING_REJECTED|REPAIR_PRE_PUBLISH|PUBLICATION_NOT_AUTHORIZED/,
    );
    const afterStale = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.equal(afterStale.activeGeneration, serving.activeGeneration);
  });

  await test('file and Mongo-compatible serialization preserve repair identity', async () => {
    const manifest = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.ok(manifest);
    const roundTrip = mongoSerialization.deserializeMongoItems(
      mongoSerialization.serializeMongoItems([manifest], 3),
    );
    assert.deepEqual(roundTrip[0], manifest);
    assert.equal(health.validateAutomationJobProjectionManifest(manifest).valid, true);
  });

  await test('execution budgets abort and dispose deterministically', async () => {
    const controller = new AbortController();
    const execution = budget.createAutomationExecutionBudget('EVALUATE_ALERTS', controller.signal);
    controller.abort('JOB_CANCELLED');
    assert.throws(() => execution.throwIfAborted(), error => error && error.code === 'JOB_CANCELLED');
    execution.dispose();
    const short = budget.createAutomationExecutionBudget('RUNTIME_GUARDIAN');
    short.abort('WORKER_FENCING_REJECTED');
    assert.throws(() => short.throwIfAborted(), error => error && error.code === 'WORKER_FENCING_REJECTED');
    short.dispose();
  });

  await test('a timed-out provider request is aborted and cannot mutate the job afterward', async () => {
    await reset([fixtureJob('timeout-job', Date.now(), { status: 'RUNNING', completedAt: undefined })]);
    const before = await adapter.readCollection('automation-jobs');
    const controller = new AbortController();
    let providerObservedAbort = false;
    const pending = urlSafety.fetchExternalSafely('https://example.com/slow', {
      resolveDns: false,
      timeoutMs: 500,
      signal: controller.signal,
      fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          providerObservedAbort = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }),
    });
    setTimeout(() => controller.abort('HANDLER_TIMEOUT'), 20).unref?.();
    await assert.rejects(() => pending);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(providerObservedAbort, true);
    assert.deepEqual(await adapter.readCollection('automation-jobs'), before);
  });

  await test('fencing loss rejects stale completion and leaves the job running', async () => {
    await reset();
    const first = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'm314-worker-a', instanceId: 'm314-instance-a', releaseId: 'e'.repeat(40), leaseMs: 5_000,
    });
    assert.equal(first.acquired, true);
    const created = await store.createAutomationJob({
      type: 'HEALTH_CHECK', payload: {}, priority: 50, idempotencyKey: 'm314-fenced-job', operationId: 'm314-fenced-job',
      requestedBy: 'm3-1-4-test', riskLevel: 'LOW', dryRun: false,
    });
    const claimed = await store.claimAutomationJobs('m314-worker-a', 1, 60_000, Date.now(), first.ownership);
    assert.equal(claimed.length, 1);
    const takeover = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'm314-worker-b', instanceId: 'm314-instance-b', releaseId: 'e'.repeat(40), leaseMs: 5_000, now: Date.now() + 6_000,
    });
    assert.equal(takeover.event, 'TAKEN_OVER');
    await assert.rejects(
      () => store.completeAutomationJob(created.job.id, 'm314-worker-a', { late: true }, {
        claimToken: claimed[0].claimToken,
        attemptCount: claimed[0].attemptCount,
        releaseId: claimed[0].releaseId,
        ownership: first.ownership,
      }),
      /WORKER_FENCING_REJECTED/,
    );
    assert.equal((await store.getAutomationJobAuthoritySnapshot(created.job.id)).status, 'RUNNING');
  });

  await test('scheduler overlap and maintenance-loop guards are explicit', async () => {
    await reset();
    await settings.updateAutomationSettings({ enabled: false });
    const acquired = await runtimeRoles.acquireRuntimeRole({
      role: 'SCHEDULER', ownerId: 'm314-scheduler', instanceId: 'm314-scheduler-instance', releaseId: 'e'.repeat(40), leaseMs: 5_000,
    });
    const first = scheduler.runOwnedSchedulerCycle(acquired.ownership, Date.now());
    const second = await scheduler.runOwnedSchedulerCycle(acquired.ownership, Date.now());
    assert.equal(second.skippedOverlap, true);
    await first;
    const schedulerSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/automation/scheduler.ts'), 'utf8');
    const workerEntrySource = fs.readFileSync(path.join(process.cwd(), 'scripts/automation-worker.cjs'), 'utf8');
    assert.match(schedulerSource, /ownedSchedulerFlight/);
    assert.match(workerEntrySource, /roleHeartbeatBusy/);
  });

  await test('critical ordering and degraded operation fail closed', async () => {
    const ordered = worker.orderAutomationWorkerBatch([
      { id: 'normal', type: 'HEALTH_CHECK', executionCritical: false },
      { id: 'guardian', type: 'RUNTIME_GUARDIAN', executionCritical: true },
      { id: 'monitor', type: 'POST_PUBLISH_MONITOR', executionCritical: true },
    ]);
    assert.deepEqual(ordered.map(item => item.id), ['guardian', 'monitor', 'normal']);
    await reset([fixtureJob('paused-job', Date.now(), { status: 'PENDING', completedAt: undefined })]);
    await store.updateAutomationControl({ workerPaused: true, degradedReason: 'M314_TEST_DEGRADED' }, 'm3-1-4-test');
    assert.deepEqual(await store.claimAutomationJobs('paused-worker', 1), []);
    const control = await store.getAutomationControl();
    assert.equal(control.workerPaused, true);
    assert.equal(control.degradedReason, 'M314_TEST_DEGRADED');
  });

  await test('repeated streaming cycles retain bounded memory and no full snapshots', async () => {
    const jobs = Array.from({ length: 13_000 }, (_, index) => ({ id: `memory-${index}`, value: index, payload: { bounded: true } }));
    await adapter.writeCollection('memory-fixture', jobs);
    adapter.resetStorageDiagnostics();
    const before = process.memoryUsage().heapUsed;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      let count = 0;
      await adapter.scanCollection('memory-fixture', () => { count += 1; });
      assert.equal(count, 13_000);
    }
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    const diagnostics = adapter.getStorageDiagnosticsSnapshot();
    assert.equal(diagnostics.fullCollectionReadCount, 0);
    assert.equal(diagnostics.scanCollectionCount, 4);
    assert.ok(after - before < 96 * 1024 * 1024, `heap delta ${(after - before) / (1024 * 1024)}MB`);
  });

  console.log(`M3.1.4 focused resource stability tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { cleanup(); } catch (error) { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; }
  });
