/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `master-m2-operational-health-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.RUNTIME_RECOVERY_V2 = 'ACTIVE';
process.env.WORKER_CONTINUOUS_POOL_V2 = 'ACTIVE';
process.env.SLO_RUNNABLE_AT_V2 = 'ACTIVE';
const releaseSha = '1111111111111111111111111111111111111111';
process.env.SANDEAL_BUILD_MANIFEST_COMMIT = releaseSha;
process.env.SANDEAL_BUILD_COMMIT = releaseSha;
process.env.SANDEAL_RELEASE_ID = releaseSha;
process.env.GIT_COMMIT_SHA = releaseSha;
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = releaseSha;
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

function roleLease(role, now, releaseId = releaseSha) {
  const current = new Date(now).toISOString();
  const expires = new Date(now + 45_000).toISOString();
  return {
    schemaVersion: 3,
    id: role,
    role,
    ownerId: `${role.toLowerCase()}-owner`,
    instanceId: `${role.toLowerCase()}-instance`,
    holderId: `${role.toLowerCase()}-owner`,
    releaseId,
    status: 'ACTIVE',
    acquiredAt: current,
    startedAt: current,
    heartbeatAt: current,
    expiresAt: expires,
    leaseExpiresAt: expires,
    fencingToken: 1,
    takeoverCount: 0,
    updatedAt: current,
  };
}

function recoveryState(now, overrides = {}) {
  const current = new Date(now).toISOString();
  return {
    schemaVersion: 1,
    id: 'runtime-recovery',
    state: 'RECOVERY_OBSERVING',
    stateVersion: 3,
    enteredAt: current,
    updatedAt: current,
    originatingBreachReasons: ['ORIGINATING_BREACH'],
    currentApplicableReasons: ['RECOVERY_REASON_ACTIVE'],
    consecutiveHealthyCount: 2,
    requiredHealthyCount: 3,
    lastHealthyEvaluation: current,
    lastHealthyEvaluationId: 'evaluation-2',
    lastResetReason: 'RECOVERY_EVIDENCE_STALE',
    evidenceSummary: {
      measurementState: 'RECOVERY',
      evaluationStatus: 'PASS',
      evaluatedAt: current,
      maximumEvidenceAgeMs: 120_000,
      reasonCodes: [],
      terminalJobSamples: 10,
      pickupLatencyP95Ms: 12_000,
      pendingQueueAgeMs: 5_000,
      publicationAttempts: 0,
      monitorOutcomes: 0,
      publicProducts: 0,
    },
    releaseIdentity: releaseSha,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const health = require('../src/lib/automation/operationalHealth.ts');
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const current = new Date(now).toISOString();

  async function seedBase() {
    await store.updateAutomationControl({
      publishPausedByOperator: false,
      publishBlockedByRuntime: true,
      publishBlockedByPolicy: false,
      publishRuntimeReasons: ['CONTROL_RUNTIME_BLOCK_ACTIVE'],
      killSwitch: false,
    }, 'master-m2-operational-health-test');
    await adapter.writeCollection('runtime-health', [{
      schemaVersion: 1,
      id: 'runtime-health:fixture',
      ruleVersion: 'runtime-guardian-v2',
      web: {
        status: 'ready',
        buildAvailable: true,
        publicRouteHealthy: true,
        buildId: releaseSha,
        releaseId: releaseSha,
        embeddedReleaseId: releaseSha,
        runtimeReleaseId: releaseSha,
        publicBuildId: releaseSha,
        releaseMatchesBuild: true,
      },
      worker: { status: 'active', heartbeatAt: current, releaseId: releaseSha },
      scheduler: { status: 'active', heartbeatAt: current, releaseId: releaseSha },
      providers: {},
      queue: { pending: 0, running: 2, stuck: 0, staleJobs: 0 },
      storage: { status: 'healthy', staleLocks: 0, freeBytes: 1_000_000, criticalCollections: {} },
      duplicateRoles: [],
      publishSafe: false,
      reasons: ['CURRENT_RUNTIME_REASON'],
      historicalReasons: ['RESOLVED_RUNTIME_REASON'],
      recommendation: { pausePublish: true, pauseIngestion: false },
      checkedAt: current,
    }]);
    await adapter.writeCollection('runtime-recovery-state', [recoveryState(now)]);
    await adapter.writeCollection('runtime-role-leases', [
      roleLease('WORKER', now),
      roleLease('SCHEDULER', now),
    ]);
    await adapter.writeCollection('runtime-recovery-canary-permits', [{
      schemaVersion: 1,
      id: 'permit-fixture',
      operationId: 'operation-fixture',
      productId: 'product-fixture',
      jobId: 'job-canary',
      readinessSnapshotHash: 'readiness-hash',
      ownerId: 'worker-owner',
      instanceId: 'worker-instance',
      fencingToken: 1,
      claimTokenHash: 'claim-hash',
      status: 'CONSUMED',
      issuedAt: new Date(now - 20_000).toISOString(),
      expiresAt: new Date(now + 20_000).toISOString(),
      consumedAt: new Date(now - 10_000).toISOString(),
      releaseIdentity: releaseSha,
    }]);
    await adapter.writeCollection('automation-jobs', [
      { id: 'guardian-running', type: 'RUNTIME_GUARDIAN', status: 'RUNNING', executionCritical: true },
      { id: 'candidate-running', type: 'PROCESS_CANDIDATE', status: 'RUNNING', executionCritical: false },
    ]);
    await adapter.writeCollection('automation-slo-snapshots', [{
      id: 'automation-slo:fixture',
      dataStatus: 'RECOVERY',
      windowStartedAt: new Date(now - 86_400_000).toISOString(),
      windowEndedAt: current,
      pickupLatencyP50Ms: 4_000,
      pickupLatencyP95Ms: 12_000,
      pendingQueueAgeMs: 5_000,
      pendingQueueCount: 2,
      pickupLatencyMode: 'RUNNABLE_AT',
      pickupLatencyFeatureMode: 'ACTIVE',
      measuredAt: current,
      evaluation: { status: 'PASS' },
    }]);
  }

  await test('operational health exposes current and historical reasons in separate fields', async () => {
    await seedBase();
    const result = await health.buildAutomationOperationalHealth(now);
    assert.deepEqual(result.currentActiveReasons, [
      'CONTROL_RUNTIME_BLOCK_ACTIVE',
      'CURRENT_RUNTIME_REASON',
      'RECOVERY_REASON_ACTIVE',
    ]);
    assert.deepEqual(result.historicalAuditReasons, [
      'ORIGINATING_BREACH',
      'RESOLVED_RUNTIME_REASON',
    ]);
    assert.ok(!result.currentActiveReasons.includes('RESOLVED_RUNTIME_REASON'));
  });

  await test('operational health reports recovery, SLO, canary, pool, feature, and release truth', async () => {
    await seedBase();
    const result = await health.buildAutomationOperationalHealth(now);
    assert.equal(result.recovery.state, 'RECOVERY_OBSERVING');
    assert.equal(result.recovery.consecutiveHealthyCount, 2);
    assert.equal(result.recovery.requiredHealthyCount, 3);
    assert.equal(result.slo.dataStatus, 'RECOVERY');
    assert.equal(result.slo.evaluationStatus, 'PASS');
    assert.equal(result.slo.pickupLatencyP50Ms, 4_000);
    assert.equal(result.slo.pickupLatencyP95Ms, 12_000);
    assert.equal(result.slo.pendingQueueAgeMs, 5_000);
    assert.equal(result.canary.activeCount, 1);
    assert.equal(result.canary.latest.status, 'CONSUMED');
    assert.equal(result.workerPool.featureMode, 'ACTIVE');
    assert.equal(result.workerPool.activeSlots, 2);
    assert.equal(result.workerPool.activeCriticalSlots, 1);
    assert.equal(result.workerPool.availableSlots, 2);
    assert.equal(result.release.matchStatus, 'MATCH');
    assert.equal(result.featureRollouts.find(item => item.feature === 'RECOVERY_CANARY').mode, 'OFF');
  });

  await test('stale runtime evidence becomes historical while stale and release mismatches remain current', async () => {
    await seedBase();
    await store.updateAutomationControl({
      publishBlockedByRuntime: false,
      publishRuntimeReasons: [],
    }, 'master-m2-operational-health-test');
    const staleAt = new Date(now - 4 * 60_000).toISOString();
    const snapshots = await adapter.readCollection('runtime-health');
    snapshots[0].checkedAt = staleAt;
    snapshots[0].reasons = ['STALE_SNAPSHOT_REASON'];
    await adapter.writeCollection('runtime-health', snapshots);
    await adapter.writeCollection('runtime-recovery-state', [recoveryState(now, {
      state: 'CLOSED_HEALTHY',
      originatingBreachReasons: [],
      currentApplicableReasons: [],
      consecutiveHealthyCount: 0,
    })]);
    await adapter.writeCollection('runtime-role-leases', [
      roleLease('WORKER', now),
      roleLease('SCHEDULER', now, '2222222222222222222222222222222222222222'),
    ]);
    const result = await health.buildAutomationOperationalHealth(now);
    assert.ok(result.currentActiveReasons.includes('RUNTIME_HEALTH_SNAPSHOT_STALE'));
    assert.ok(result.currentActiveReasons.includes('SCHEDULER_RELEASE_MISMATCH'));
    assert.ok(!result.currentActiveReasons.includes('STALE_SNAPSHOT_REASON'));
    assert.ok(result.historicalAuditReasons.includes('STALE_SNAPSHOT_REASON'));
    assert.equal(result.release.matchStatus, 'MISMATCH');
  });

  console.log(`\nM2 operational health truth: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
