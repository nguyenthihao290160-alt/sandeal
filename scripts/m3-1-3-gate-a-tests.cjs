/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(
  process.cwd(),
  '.test-tmp',
  `m3-1-3-gate-a-${process.pid}-${Date.now()}`,
);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_BUILD_COMMIT = 'e'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'e'.repeat(40);
process.env.GIT_COMMIT_SHA = 'e'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'e'.repeat(40);
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

function job(id, now, overrides = {}) {
  const createdAt = iso(now - 20_000);
  return {
    schemaVersion: 2,
    policyVersion: 'm313-test-policy',
    handlerVersion: 'm313-test-handler',
    id,
    type: 'HEALTH_CHECK',
    status: 'SUCCEEDED',
    payload: {},
    result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES' },
    priority: 50,
    idempotencyKey: `key:${id}`,
    operationId: `operation:${id}`,
    requestedBy: 'm313-gate-a-test',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'CREATED_AT',
    claimedAt: iso(now - 19_000),
    startedAt: iso(now - 19_000),
    completedAt: iso(now - 18_000),
    createdAt,
    updatedAt: iso(now - 18_000),
    ...overrides,
  };
}

function providerDependencies() {
  return {
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
}

function cleanupTestRoot() {
  const resolvedRoot = path.resolve(testRoot);
  const expectedParent = path.resolve(process.cwd(), '.test-tmp');
  if (path.dirname(resolvedRoot) !== expectedParent
    || !path.basename(resolvedRoot).startsWith('m3-1-3-gate-a-')) {
    throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolvedRoot}`);
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const health = require('../src/lib/automation/jobHealthSummary.ts');
  const maintenance = require('../src/lib/automation/projectionMaintenance.ts');
  const healthService = require('../src/lib/automation/healthService.ts');
  const store = require('../src/lib/automation/store.ts');
  const now = Date.now();

  async function reset(jobs = [job('m313-source-1', now)]) {
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
      adapter.writeCollection('runtime-role-leases', []),
      adapter.writeCollection('products', []),
      adapter.writeCollection('candidate-queue', []),
    ]);
    await store.rebuildAutomationJobReadModelsFromDurable(jobs, now);
    return jobs;
  }

  await test('GET health observation is read-only and reports an explicit repair need', async () => {
    await reset();
    const heldMutation = await health.beginAutomationJobProjectionMutation(now + 1);
    try {
      const beforeMaintenance = await adapter.readCollection('automation-job-projection-maintenance-v1');
      const beforeJobs = await adapter.readCollection('automation-jobs');
      const response = await healthService.buildAutomationHealthResponse({
        now: now + 2,
        dependencies: providerDependencies(),
      });
      const afterMaintenance = await adapter.readCollection('automation-job-projection-maintenance-v1');
      const afterJobs = await adapter.readCollection('automation-jobs');
      assert.equal(response.projectionMaintenance.status, 'NEEDS_REPAIR');
      assert.equal(response.projectionMaintenance.repairState, 'IDLE');
      assert.deepEqual(afterMaintenance, beforeMaintenance);
      assert.deepEqual(afterJobs, beforeJobs);
    } finally {
      await health.abortAutomationJobProjectionMutation(heldMutation, now + 3);
    }
  });

  await test('explicit Retry is deduplicated and a prior successful cycle cannot suppress later recovery', async () => {
    await reset();
    let heldMutation = await health.beginAutomationJobProjectionMutation(now + 10);
    const invalid = await health.getAutomationJobHealthView(now + 11);
    const first = await healthService.buildAutomationHealthResponse({
      now: now + 12,
      scheduleProjectionMaintenance: true,
      dependencies: providerDependencies(),
    });
    assert.equal(first.projectionMaintenance.status, 'REQUESTED');
    const repeated = await Promise.all(Array.from({ length: 12 }, () =>
      healthService.buildAutomationHealthResponse({
        now: now + 13,
        scheduleProjectionMaintenance: true,
        dependencies: providerDependencies(),
      })));
    assert.ok(repeated.every(item => item.projectionMaintenance.repairId === first.projectionMaintenance.repairId));
    const stateBeforeMaterialization = await maintenance.getJobHealthProjectionMaintenanceState();
    assert.equal(stateBeforeMaterialization.requestGeneration, 1);
    await maintenance.materializeJobHealthProjectionMaintenanceRequest(now + 14);
    const firstMaintenanceJobs = (await adapter.readCollection('automation-jobs'))
      .filter(item => item.payload.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD');
    assert.equal(firstMaintenanceJobs.length, 1);
    await adapter.runTransaction('automation-job-projection-maintenance-v1', items => items.map(item => ({
      ...item,
      status: 'SUCCEEDED',
      phase: 'COMPLETED',
      completedAt: iso(now + 15),
      updatedAt: iso(now + 15),
    })));
    await health.abortAutomationJobProjectionMutation(heldMutation, now + 16);

    heldMutation = await health.beginAutomationJobProjectionMutation(now + 17);
    try {
      const observed = await maintenance.observeJobHealthProjectionMaintenance(
        await health.getAutomationJobHealthView(now + 18),
        now + 18,
      );
      assert.equal(observed.status, 'NEEDS_REPAIR');
      assert.equal(observed.repairState, 'IDLE');
      assert.equal(observed.historical.status, 'SUCCEEDED');
      const next = await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalid, now + 19);
      assert.equal(next.status, 'REQUESTED');
      assert.equal(next.requestGeneration, 2);
      await maintenance.materializeJobHealthProjectionMaintenanceRequest(now + 20);
      const allMaintenanceJobs = (await adapter.readCollection('automation-jobs'))
        .filter(item => item.payload.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD');
      assert.equal(allMaintenanceJobs.length, 2);
      assert.notEqual(allMaintenanceJobs[0].idempotencyKey, allMaintenanceJobs[1].idempotencyKey);
    } finally {
      await health.abortAutomationJobProjectionMutation(heldMutation, now + 21);
    }
  });

  await test('projection status exposes one serving state plus fenced pending repair metadata', async () => {
    await reset();
    const owner = {
      repairId: 'm313-status-owner',
      ownerId: 'm313-worker',
      ownerInstanceId: 'm313-worker-instance',
      workerFencingToken: 7,
      claimToken: 'm313-test-status-claim',
      attemptNumber: 1,
    };
    const context = await health.beginAutomationJobProjectionRebuild(owner, now + 30);
    try {
      const view = await health.getAutomationJobHealthView(now + 31);
      assert.equal(view.projectionStatus, 'REBUILD_RUNNING');
      assert.equal(view.activeRepairId, owner.repairId);
      assert.equal(view.pendingProjectionGeneration, context.targetGeneration);
      assert.equal(view.pendingProjectionSlot, context.targetSlot);
      assert.equal(view.repairOwnerId, owner.ownerId);
      assert.equal(view.repairOwnerInstanceId, owner.ownerInstanceId);
      assert.equal(view.repairFencingToken, context.repairFence);
      assert.equal(view.repairWorkerFencingToken, owner.workerFencingToken);
      assert.ok(view.repairStartedAt);
      assert.ok(view.repairLastHeartbeatAt);
      assert.notEqual(view.projectionStatus, 'VALID');
      const observed = await maintenance.observeJobHealthProjectionMaintenance(view, now + 31);
      assert.equal(observed.status, 'REUSED_ACTIVE_REQUEST');
      assert.equal(observed.repairState, 'RUNNING');
      assert.equal(observed.phase, view.repairPhase);
      const retry = await maintenance.ensureJobHealthProjectionMaintenanceRequest(view, now + 31);
      assert.equal(retry.status, 'REUSED_ACTIVE_REQUEST');
      assert.equal((await adapter.readCollection('automation-job-projection-maintenance-v1')).length, 0);
    } finally {
      await health.failAutomationJobProjectionRepair(context, 'M313_STATUS_TEST_COMPLETE', now + 32);
    }
  });

  await test('concurrent source change catches up, failed candidate preserves serving generation, and stale fence is rejected', async () => {
    const initial = await reset([job('m313-base', now)]);
    const before = await health.getAutomationJobProjectionManifestForMaintenance();
    const concurrent = await store.rebuildAutomationJobReadModelsFromDurable(null, now + 40, {
      owner: {
        repairId: 'm313-concurrent-repair',
        ownerId: 'm313-worker',
        ownerInstanceId: 'm313-worker-instance',
        workerFencingToken: 11,
        claimToken: 'm313-test-concurrent-claim',
        attemptNumber: 1,
      },
      catchUpBackoffMs: [0, 0, 0],
      sleep: async () => undefined,
      hooks: {
        afterBaseRebuild: async () => {
          await store.createAutomationJob({
            type: 'HEALTH_CHECK',
            payload: { source: 'm313-concurrent-write' },
            idempotencyKey: 'm313-concurrent-write',
            operationId: 'm313-concurrent-write',
            requestedBy: 'm313-gate-a-test',
            priority: 60,
            riskLevel: 'LOW',
            dryRun: false,
          });
        },
      },
    });
    assert.ok(concurrent.activeGeneration > before.activeGeneration);
    assert.equal(concurrent.durableJobCount, initial.length + 1);

    const servingBeforeFailure = await health.getAutomationJobHealthView(now + 41);
    const invalid = job('m313-invalid', now, { updatedAt: 'not-a-timestamp' });
    const durableBeforeFailure = await adapter.readCollection('automation-jobs');
    // A supplied base candidate is deliberately followed by a durable catch-up pass.
    // Put the invalid record in the authoritative source so validation proves the
    // candidate cannot replace the serving projection.
    await adapter.writeCollection('automation-jobs', [invalid]);
    await assert.rejects(
      () => store.rebuildAutomationJobReadModelsFromDurable([invalid], now + 42),
      /JOB_PROJECTION_CANDIDATE_ITEM_INVALID/,
    );
    await adapter.writeCollection('automation-jobs', durableBeforeFailure);
    const servingAfterFailure = await health.getAutomationJobHealthView(now + 43);
    assert.equal(servingAfterFailure.activeProjectionGeneration, servingBeforeFailure.activeProjectionGeneration);
    assert.equal(servingAfterFailure.currentServingProjectionFingerprint, servingBeforeFailure.currentServingProjectionFingerprint);

    const first = await health.beginAutomationJobProjectionRebuild({
      repairId: 'm313-stale-owner',
      ownerId: 'm313-worker-a',
      ownerInstanceId: 'm313-instance-a',
      workerFencingToken: 21,
      claimToken: 'm313-test-stale-claim-a',
      attemptNumber: 1,
    }, now + 44);
    const second = await health.beginAutomationJobProjectionRebuild({
      repairId: 'm313-current-owner',
      ownerId: 'm313-worker-b',
      ownerInstanceId: 'm313-instance-b',
      workerFencingToken: 22,
      claimToken: 'm313-test-stale-claim-b',
      attemptNumber: 2,
      supersede: true,
    }, now + 45);
    await assert.rejects(
      () => health.transitionAutomationJobProjectionRepair(first, 'REBUILDING', {}, now + 46),
      /JOB_PROJECTION_REPAIR_FENCING_REJECTED/,
    );
    await health.failAutomationJobProjectionRepair(second, 'M313_STALE_FENCE_TEST_COMPLETE', now + 47);
  });

  await test('a bounded App Health maintenance-observation timeout remains partial without scheduling work', async () => {
    await reset();
    const result = await healthService.buildAutomationHealthResponse({
      now: now + 50,
      budgets: { maintenanceMs: 100 },
      dependencies: {
        ...providerDependencies(),
        observeProjectionMaintenance: () => new Promise(() => {}),
      },
    });
    assert.equal(result.partial, true);
    assert.equal(result.components.projectionMaintenance.status, 'unavailable');
    assert.equal(result.components.projectionMaintenance.reasonCode, 'COMPONENT_TIMEOUT');
    assert.equal((await adapter.readCollection('automation-job-projection-maintenance-v1')).length, 0);
  });

  await test('route and App Health UI reserve POST for the explicit deduplicated repair retry', () => {
    const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/automation/health/route.ts'), 'utf8');
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/app-health/page.tsx'), 'utf8');
    const getSource = route.slice(0, route.indexOf('export async function POST'));
    assert.ok(route.includes('export async function POST'));
    assert.ok(route.includes('scheduleProjectionMaintenance: true'));
    assert.equal(getSource.includes('scheduleProjectionMaintenance'), false);
    assert.ok(page.includes("method: 'POST'"));
    assert.ok(page.includes('projectionRepairCanBeScheduled'));
    assert.ok(page.includes('repairRequestRef'));
  });

  console.log(`\nM3.1.3 Gate A tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      cleanupTestRoot();
      console.log(`Cleaned isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
