/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `m3-1-5-file-runtime-stability-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_FILE_LOCK_WAIT_MS = '7000';
process.env.SANDEAL_FILE_LOCK_LEASE_MS = '15000';
process.env.SANDEAL_BUILD_COMMIT = '5'.repeat(40);
process.env.SANDEAL_RELEASE_ID = '5'.repeat(40);
process.env.GIT_COMMIT_SHA = '5'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = '5'.repeat(40);
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

const COLLECTIONS = [
  'automation-jobs', 'automation-job-attempts', 'automation-job-heartbeats',
  'automation-job-projections', 'automation-job-list-projections-v2', 'automation-job-health-summary-v1',
  'automation-job-projection-manifest-v1', 'automation-job-projection-maintenance-v1',
  'automation-job-projection-rebuild-staging-v1', 'automation-control', 'automation-audit',
  'runtime-role-leases', 'runtime-role-conflicts', 'runtime-role-fencing', 'runtime-health',
  'automation-settings', 'products', 'candidate-queue',
];

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

function iso(value) { return new Date(value).toISOString(); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function cleanup() {
  const resolved = path.resolve(testRoot);
  if (path.dirname(resolved) !== allowedTempRoot || !path.basename(resolved).startsWith('m3-1-5-file-runtime-stability-')) {
    throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function lockMetadata(overrides = {}) {
  const now = Date.now();
  return {
    token: `test-lock-${now}`,
    pid: process.pid,
    hostname: os.hostname(),
    processStartedAt: iso(now - 10_000),
    createdAt: iso(now),
    heartbeatAt: iso(now),
    expiresAt: iso(now + 60_000),
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const diagnostics = require('../src/lib/storage/diagnostics.ts');
  const store = require('../src/lib/automation/store.ts');
  const runtimeRoles = require('../src/lib/automation/runtimeRoles.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const cycle = require('../src/lib/automation/cycleReadModel.ts');
  const mongoSerialization = require('../src/lib/storage/mongoSerialization.ts');

  async function quiet(work) {
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
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

  async function reset() {
    await Promise.all(COLLECTIONS.map(collection => adapter.writeCollection(collection, [])));
    await settings.updateAutomationSettings({ enabled: false });
    await store.updateAutomationControl({
      mode: 'SHADOW', effectiveMode: 'SHADOW', workerPaused: false, schedulerPaused: false,
      ingestionPaused: false, killSwitch: false, publishPaused: true,
      workerHeartbeatAt: iso(Date.now()), schedulerHeartbeatAt: iso(Date.now()),
    }, 'm3-1-5-test');
    diagnostics.resetStorageDiagnostics();
  }

  function jobInput(type, key, extra = {}) {
    return {
      type,
      payload: { source: 'm3.1.5-test' },
      priority: type === 'RUNTIME_GUARDIAN' ? 100 : 50,
      idempotencyKey: `m315:${key}`,
      operationId: `m315:${key}`,
      requestedBy: 'm3-1-5-test',
      riskLevel: type === 'RUNTIME_GUARDIAN' ? 'MEDIUM' : 'LOW',
      dryRun: false,
      ...extra,
    };
  }

  await test('independent role heartbeat survives a long Worker authority operation', async () => {
    await reset();
    const acquired = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'm315-worker-long', instanceId: 'm315-worker-long-instance',
      releaseId: '5'.repeat(40), leaseMs: 5_000,
    });
    assert.equal(acquired.acquired, true);
    let renewals = 0;
    let busy = false;
    const interval = setInterval(() => {
      if (busy) return;
      busy = true;
      void runtimeRoles.heartbeatRuntimeRole('WORKER', acquired.ownership, 5_000)
        .then(renewed => { if (renewed) renewals += 1; })
        .finally(() => { busy = false; });
    }, 800);
    try {
      await runtimeRoles.withRuntimeRoleAuthority('WORKER', acquired.ownership, async assertAuthority => {
        for (let index = 0; index < 7; index += 1) {
          await wait(900);
          await assertAuthority();
        }
      });
    } finally {
      clearInterval(interval);
      await runtimeRoles.releaseRuntimeRole('WORKER', acquired.ownership);
    }
    assert.ok(renewals >= 5, `renewals=${renewals}`);
  });

  await test('independent role heartbeat survives a long Scheduler authority operation', async () => {
    await reset();
    const acquired = await runtimeRoles.acquireRuntimeRole({
      role: 'SCHEDULER', ownerId: 'm315-scheduler-long', instanceId: 'm315-scheduler-long-instance',
      releaseId: '5'.repeat(40), leaseMs: 5_000,
    });
    assert.equal(acquired.acquired, true);
    let renewals = 0;
    let busy = false;
    const interval = setInterval(() => {
      if (busy) return;
      busy = true;
      void runtimeRoles.heartbeatRuntimeRole('SCHEDULER', acquired.ownership, 5_000)
        .then(renewed => { if (renewed) renewals += 1; })
        .finally(() => { busy = false; });
    }, 800);
    try {
      await runtimeRoles.withRuntimeRoleAuthority('SCHEDULER', acquired.ownership, async assertAuthority => {
        for (let index = 0; index < 7; index += 1) {
          await wait(900);
          await assertAuthority();
        }
      });
    } finally {
      clearInterval(interval);
      await runtimeRoles.releaseRuntimeRole('SCHEDULER', acquired.ownership);
    }
    assert.ok(renewals >= 5, `renewals=${renewals}`);
  });

  await test('fencing loss stops stale role renewal and rejects late durable completion', async () => {
    await reset();
    const first = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'm315-worker-a', instanceId: 'm315-worker-a-instance',
      releaseId: '5'.repeat(40), leaseMs: 5_000,
    });
    assert.equal(first.acquired, true);
    assert.equal(await runtimeRoles.heartbeatRuntimeRole('WORKER', first.ownership, 5_000, Date.now() + 7_000), false);
    const takeover = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'm315-worker-b', instanceId: 'm315-worker-b-instance',
      releaseId: '5'.repeat(40), leaseMs: 5_000, now: Date.now() + 7_000,
    });
    assert.equal(takeover.event, 'TAKEN_OVER');
    const created = await store.createAutomationJob(jobInput('HEALTH_CHECK', 'fenced-completion'));
    await assert.rejects(
      () => store.claimAutomationJobs('m315-worker-a', 1, 60_000, Date.now(), first.ownership),
      /WORKER_FENCING_REJECTED/,
    );
    assert.equal((await store.getAutomationJobAuthoritySnapshot(created.job.id)).status, 'PENDING');
    await runtimeRoles.releaseRuntimeRole('WORKER', takeover.ownership);
  });

  await test('a live file lock is never stolen and a dead-owner lock is recovered', async () => {
    await reset();
    const livePath = path.join(testRoot, 'live-lock.json.lock');
    fs.writeFileSync(livePath, JSON.stringify(lockMetadata({ expiresAt: iso(Date.now() - 1_000) })));
    await assert.rejects(
      () => adapter.runTransaction('live-lock', items => [...items, { id: 'must-not-write' }]),
      error => error && error.code === 'STORAGE_LOCK_TIMEOUT',
    );
    assert.equal(fs.existsSync(livePath), true);

    const deadPath = path.join(testRoot, 'dead-lock.json.lock');
    fs.writeFileSync(deadPath, JSON.stringify(lockMetadata({ pid: 2_147_000_000 })));
    await adapter.runTransaction('dead-lock', items => [...items, { id: 'recovered' }]);
    assert.equal(fs.existsSync(deadPath), false);
    assert.equal((await adapter.readCollection('dead-lock'))[0].id, 'recovered');
    assert.ok(diagnostics.getStorageDiagnosticsSnapshot().staleLockRecoveryCount >= 1);
  });

  await test('cancellation and before-commit fencing leave no owned lock or partial promotion', async () => {
    await reset();
    await assert.rejects(
      () => adapter.runTransaction('cancelled-lock', async () => {
        await wait(25);
        throw new Error('M315_CANCELLED');
      }),
      /M315_CANCELLED/,
    );
    assert.equal(fs.existsSync(path.join(testRoot, 'cancelled-lock.json.lock')), false);

    await adapter.writeCollection('before-commit', [{ id: 'serving', value: 1 }]);
    await assert.rejects(
      () => adapter.runStreamingTransaction('before-commit', item => {
        if (item.id !== 'serving') return false;
        item.value = 2;
        return true;
      }, { beforeCommit: () => { throw new Error('M315_FENCE_LOST'); } }),
      /M315_FENCE_LOST/,
    );
    assert.deepEqual(await adapter.readCollection('before-commit'), [{ id: 'serving', value: 1 }]);
    assert.equal(fs.existsSync(path.join(testRoot, 'before-commit.json.lock')), false);
  });

  await test('cycle-scoped control reads are replaced after an applicable mutation', async () => {
    await reset();
    await cycle.withAutomationCycleReadModel(async () => {
      const first = await store.getAutomationControl();
      const next = await store.updateAutomationControl({ workerId: 'm315-cycle-worker' }, 'm3-1-5-test');
      const second = await store.getAutomationControl();
      assert.notEqual(first.workerId, next.workerId);
      assert.equal(second.workerId, 'm315-cycle-worker');
    });
  });

  await test('batch enqueue deduplicates critical work with no full durable job read', async () => {
    await reset();
    const first = await store.createAutomationJobsBatch([
      jobInput('RUNTIME_GUARDIAN', 'guardian-batch'),
      jobInput('HEALTH_CHECK', 'health-batch'),
    ]);
    const second = await store.createAutomationJobsBatch([
      jobInput('RUNTIME_GUARDIAN', 'guardian-batch'),
      jobInput('HEALTH_CHECK', 'health-batch'),
    ]);
    const durable = await adapter.readCollectionPage('automation-jobs', { page: 1, pageSize: 10 });
    const snapshot = diagnostics.getStorageDiagnosticsSnapshot();
    assert.equal(first.filter(item => item.created).length, 2);
    assert.equal(second.filter(item => item.created).length, 0);
    assert.equal(durable.totalItems, 2);
    assert.equal(snapshot.fullCollectionReadsByCollection['automation-jobs'] || 0, 0);
  });

  await test('Worker and Scheduler concurrent scheduling remain single-flight and duplicate-free', async () => {
    await reset();
    await settings.updateAutomationSettings({ enabled: true, intervalHours: 6, maxItemsPerRun: 4 });
    const now = Date.now();
    await store.updateAutomationControl({ workerHeartbeatAt: iso(now), schedulerPaused: false, workerPaused: false }, 'm3-1-5-test');
    const role = await runtimeRoles.acquireRuntimeRole({
      role: 'SCHEDULER', ownerId: 'm315-scheduler', instanceId: 'm315-scheduler-instance',
      releaseId: '5'.repeat(40), leaseMs: 45_000,
    });
    assert.equal(role.acquired, true);
    const first = await quiet(() => scheduler.runOwnedSchedulerCycle(role.ownership, now));
    const overlapping = await quiet(() => Promise.all([
      scheduler.runOwnedSchedulerCycle(role.ownership, now + 1),
      scheduler.runOwnedSchedulerCycle(role.ownership, now + 2),
    ]));
    const jobs = await adapter.readCollection('automation-jobs');
    const active = jobs.filter(job => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(job.status));
    assert.equal(first.status, 'completed');
    assert.ok(overlapping.some(item => item.skippedOverlap === true) || overlapping[0].status === 'completed');
    assert.equal(active.filter(job => job.type === 'RUNTIME_GUARDIAN').length, 1);
    assert.equal(active.filter(job => job.type === 'RECHECK_PRODUCT_HEALTH').length, 1);
    assert.equal(active.filter(job => job.type === 'EVALUATE_ALERTS').length, 1);
    await runtimeRoles.releaseRuntimeRole('SCHEDULER', role.ownership);
  });

  await test('infrastructure contention is bounded, auditable, and does not consume a business attempt', async () => {
    await reset();
    const role = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'm315-worker-contention', instanceId: 'm315-worker-contention-instance',
      releaseId: '5'.repeat(40), leaseMs: 45_000,
    });
    const created = await store.createAutomationJob(jobInput('HEALTH_CHECK', 'contention'));
    const claimed = await store.claimAutomationJobs('m315-worker-contention', 1, 60_000, Date.now(), role.ownership);
    assert.equal(claimed.length, 1);
    const deferred = await store.deferAutomationJobForInfrastructure(
      created.job.id,
      'm315-worker-contention',
      'STORAGE_LOCK_TIMEOUT',
      new Error('Storage lock timeout: automation-jobs'),
      { claimToken: claimed[0].claimToken, attemptCount: claimed[0].attemptCount, releaseId: claimed[0].releaseId, ownership: role.ownership },
    );
    assert.equal(deferred.status, 'RETRY_SCHEDULED');
    assert.equal(deferred.attemptCount, claimed[0].attemptCount);
    assert.equal(deferred.lastErrorCode, 'STORAGE_LOCK_CONTENTION');
    const audit = (await adapter.readCollection('automation-audit')).find(item => item.operationType === 'INFRASTRUCTURE_RETRY_DEFERRED');
    assert.ok(audit);
    await runtimeRoles.releaseRuntimeRole('WORKER', role.ownership);
  });

  await test('repeated streaming cycles do not retain full job snapshots', async () => {
    await reset();
    const jobs = Array.from({ length: 13_000 }, (_, index) => ({ id: `m315-memory-${index}`, value: index, payload: { bounded: true } }));
    await adapter.writeCollection('m315-memory-fixture', jobs);
    diagnostics.resetStorageDiagnostics();
    const before = process.memoryUsage().heapUsed;
    for (let cycleIndex = 0; cycleIndex < 4; cycleIndex += 1) {
      let count = 0;
      await adapter.scanCollection('m315-memory-fixture', () => { count += 1; });
      assert.equal(count, 13_000);
    }
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    const snapshot = diagnostics.getStorageDiagnosticsSnapshot();
    assert.equal(snapshot.fullCollectionReadCount, 0);
    assert.equal(snapshot.scanCollectionCount, 4);
    assert.ok(after - before < 96 * 1024 * 1024, `heap delta ${(after - before) / (1024 * 1024)}MB`);
  });

  await test('modified file and Mongo-compatible representations retain fencing identity', async () => {
    const record = {
      schemaVersion: 1,
      id: 'WORKER',
      role: 'WORKER',
      ownerId: 'owner',
      instanceId: 'instance',
      token: 'fence-token',
      status: 'ACTIVE',
      acquiredAt: iso(Date.now()),
      heartbeatAt: iso(Date.now()),
      expiresAt: iso(Date.now() + 90_000),
      updatedAt: iso(Date.now()),
    };
    const roundTrip = mongoSerialization.deserializeMongoItems(
      mongoSerialization.serializeMongoItems([record], 3),
    );
    assert.deepEqual(roundTrip, [record]);
  });

  console.log(`M3.1.5 focused file runtime stability tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
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
