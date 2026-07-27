/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `master-m1-runtime-recovery-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.SANDEAL_BUILD_COMMIT = 'a'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'a'.repeat(40);
process.env.GIT_COMMIT_SHA = 'a'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'a'.repeat(40);
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

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const rollout = require('../src/lib/automation/featureRollout.ts');
  const recovery = require('../src/lib/automation/runtimeRecoveryState.ts');
  const recoveryCanary = require('../src/lib/automation/runtimeRecoveryCanary.ts');
  const runtimeRoles = require('../src/lib/automation/runtimeRoles.ts');
  const store = require('../src/lib/automation/store.ts');

  async function prepareCanarySafety(nowMs, owner = {
    ownerId: 'recovery-canary-worker',
    instanceId: 'recovery-canary-instance',
  }) {
    await Promise.all([
      adapter.writeCollection('runtime-recovery-canary-permits', []),
      adapter.writeCollection('runtime-recovery-state', []),
      adapter.writeCollection('runtime-role-leases', []),
      adapter.writeCollection('automation-control', []),
    ]);
    const acquired = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER',
      ...owner,
      now: nowMs,
      leaseMs: 45_000,
    });
    assert.equal(acquired.acquired, true);
    const scheduler = await runtimeRoles.acquireRuntimeRole({
      role: 'SCHEDULER',
      ownerId: 'recovery-canary-scheduler',
      instanceId: 'recovery-canary-scheduler-instance',
      now: nowMs,
      leaseMs: 45_000,
    });
    assert.equal(scheduler.acquired, true);
    await store.updateAutomationControl({
      mode: 'AUTONOMOUS',
      effectiveMode: 'AUTONOMOUS',
      publishBlockedByRuntime: true,
      publishPausedByOperator: false,
      publishBlockedByPolicy: false,
      killSwitch: false,
    }, 'runtime-guardian');
    const initial = await recovery.ensureRuntimeRecoveryState({
      publishBlockedByRuntime: true,
      reasons: ['HISTORICAL_RUNTIME_BREACH'],
      nowMs,
    });
    await recovery.updateRuntimeRecoveryState({
      expectedStateVersion: initial.stateVersion,
      nowMs,
      mutate: current => ({
        ...current,
        state: 'RECOVERY_OBSERVING',
        currentApplicableReasons: [],
        consecutiveHealthyCount: 1,
        lastHealthyEvaluation: new Date(nowMs).toISOString(),
        lastHealthyEvaluationId: 'recovery-canary-evaluation-1',
        evidenceSummary: {
          measurementState: 'RECOVERY',
          evaluationStatus: 'PASS',
          evaluatedAt: new Date(nowMs).toISOString(),
          maximumEvidenceAgeMs: 120_000,
          reasonCodes: [],
          terminalJobSamples: 20,
          pickupLatencyP95Ms: 5_000,
          pendingQueueAgeMs: 0,
          publicationAttempts: 0,
          monitorOutcomes: 0,
          publicProducts: 0,
        },
      }),
    });
    return acquired.ownership;
  }

  await test('feature rollout defaults are conservative and server controlled', async () => {
    const states = rollout.listFeatureRolloutStates({});
    assert.equal(states.find(item => item.feature === 'RUNTIME_RECOVERY_V2').mode, 'SHADOW');
    assert.equal(states.find(item => item.feature === 'RECOVERY_CANARY').mode, 'OFF');
    assert.equal(states.find(item => item.feature === 'WORKER_CONTINUOUS_POOL_V2').mode, 'OFF');
    assert.equal(states.find(item => item.feature === 'MONGO_BULK_WRITE').mode, 'OFF');
    assert.equal(states.every(item => item.valid), true);
  });

  await test('invalid rollout configuration falls back without exposing the raw value', async () => {
    const state = rollout.getFeatureRolloutState('RECOVERY_CANARY', { RECOVERY_CANARY: 'unexpected-secret-like-value' });
    assert.deepEqual(state, {
      feature: 'RECOVERY_CANARY',
      mode: 'OFF',
      defaultMode: 'OFF',
      configured: true,
      valid: false,
      reasonCode: 'FEATURE_ROLLOUT_INVALID_VALUE',
    });
  });

  await test('only ACTIVE enables behavior through the active helper', async () => {
    assert.equal(rollout.isFeatureActive('RECOVERY_CANARY', { RECOVERY_CANARY: 'CANARY' }), false);
    assert.equal(rollout.isFeatureActive('RECOVERY_CANARY', { RECOVERY_CANARY: 'active' }), true);
  });

  await test('an existing runtime block initializes a durable open recovery state', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    const state = await recovery.ensureRuntimeRecoveryState({
      publishBlockedByRuntime: true,
      reasons: ['WORKER_STALE', 'WORKER_STALE', 'RELEASE_MISMATCH'],
      nowMs: Date.parse('2026-07-26T00:00:00.000Z'),
    });
    assert.equal(state.state, 'OPEN_BLOCKED');
    assert.equal(state.stateVersion, 1);
    assert.deepEqual(state.originatingBreachReasons, ['WORKER_STALE', 'RELEASE_MISMATCH']);
    assert.equal(state.consecutiveHealthyCount, 0);
    assert.equal(state.requiredHealthyCount, 3);
    assert.equal(state.evidenceSummary.measurementState, 'BOOTSTRAP');
    assert.equal(state.releaseIdentity, 'a'.repeat(40));
    assert.deepEqual(await recovery.getRuntimeRecoveryState(), state);
  });

  await test('a missing runtime block initializes closed state without fabricating healthy evidence', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    const state = await recovery.ensureRuntimeRecoveryState({
      publishBlockedByRuntime: false,
      nowMs: Date.parse('2026-07-26T00:01:00.000Z'),
    });
    assert.equal(state.state, 'CLOSED_HEALTHY');
    assert.equal(state.evidenceSummary.evaluationStatus, 'INSUFFICIENT_DATA');
    assert.deepEqual(state.evidenceSummary.reasonCodes, ['RECOVERY_EVIDENCE_NOT_EVALUATED']);
  });

  await test('invalid persisted state normalizes fail closed and remains restart safe', async () => {
    await adapter.writeCollection('runtime-recovery-state', [{
      id: 'runtime-recovery',
      state: 'UNKNOWN',
      stateVersion: 4,
      enteredAt: 'invalid',
      updatedAt: 'invalid',
      consecutiveHealthyCount: 99,
      requiredHealthyCount: 1,
      evidenceSummary: { measurementState: 'UNKNOWN', evaluationStatus: 'PASS' },
    }]);
    const first = await recovery.ensureRuntimeRecoveryState({
      publishBlockedByRuntime: false,
      nowMs: Date.parse('2026-07-26T00:02:00.000Z'),
    });
    const restarted = await recovery.getRuntimeRecoveryState();
    assert.equal(first.state, 'OPEN_BLOCKED');
    assert.equal(first.lastResetReason, 'RUNTIME_RECOVERY_STATE_INVALID');
    assert.ok(first.currentApplicableReasons.includes('RUNTIME_RECOVERY_STATE_INVALID'));
    assert.equal(first.requiredHealthyCount >= 3, true);
    assert.deepEqual(restarted, first);
  });

  await test('state updates use optimistic versions and preserve release identity', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    const initial = await recovery.ensureRuntimeRecoveryState({
      publishBlockedByRuntime: true,
      reasons: ['QUEUE_STUCK'],
      nowMs: Date.parse('2026-07-26T00:03:00.000Z'),
    });
    const updated = await recovery.updateRuntimeRecoveryState({
      expectedStateVersion: initial.stateVersion,
      nowMs: Date.parse('2026-07-26T00:04:00.000Z'),
      mutate: current => ({
        ...current,
        state: 'RECOVERY_OBSERVING',
        currentApplicableReasons: [],
        lastResetReason: 'APPLICABLE_RUNTIME_REASONS_CLEARED',
      }),
    });
    assert.equal(updated.state, 'RECOVERY_OBSERVING');
    assert.equal(updated.stateVersion, 2);
    assert.equal(updated.enteredAt, '2026-07-26T00:04:00.000Z');
    assert.equal(updated.releaseIdentity, 'a'.repeat(40));
    await assert.rejects(() => recovery.updateRuntimeRecoveryState({
      expectedStateVersion: initial.stateVersion,
      mutate: current => current,
    }), /RUNTIME_RECOVERY_STATE_VERSION_CONFLICT/);
  });

  await test('recovery transition requires distinct healthy evaluations and ACTIVE mode to clear', async () => {
    const nowMs = Date.parse('2026-07-26T00:05:00.000Z');
    const initial = recovery.normalizeRuntimeRecoveryState({
      id: 'runtime-recovery',
      state: 'OPEN_BLOCKED',
      stateVersion: 1,
      enteredAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      originatingBreachReasons: ['QUEUE_CONGESTION'],
      currentApplicableReasons: [],
      consecutiveHealthyCount: 0,
      requiredHealthyCount: 3,
      evidenceSummary: {
        measurementState: 'RECOVERY',
        evaluationStatus: 'PASS',
        evaluatedAt: new Date(nowMs).toISOString(),
        maximumEvidenceAgeMs: 120_000,
        reasonCodes: [],
        terminalJobSamples: 20,
        publicationAttempts: 0,
        monitorOutcomes: 0,
        publicProducts: 0,
      },
      releaseIdentity: 'a'.repeat(40),
    }, nowMs);
    const input = {
      evaluationId: 'healthy-evaluation-1',
      evaluationStatus: 'PASS',
      applicableReasons: [],
      recoveryEligibilityReasons: [],
      evidenceSummary: initial.evidenceSummary,
      publishBlockedByRuntime: true,
      featureMode: 'ACTIVE',
      nowMs,
    };
    const first = recovery.deriveRuntimeRecoveryTransition(initial, input);
    const duplicate = recovery.deriveRuntimeRecoveryTransition(first.state, input);
    const second = recovery.deriveRuntimeRecoveryTransition(duplicate.state, {
      ...input,
      evaluationId: 'healthy-evaluation-2',
      nowMs: nowMs + 1_000,
    });
    const shadowThird = recovery.deriveRuntimeRecoveryTransition(second.state, {
      ...input,
      evaluationId: 'healthy-evaluation-3',
      featureMode: 'SHADOW',
      nowMs: nowMs + 2_000,
    });
    const activeThird = recovery.deriveRuntimeRecoveryTransition(second.state, {
      ...input,
      evaluationId: 'healthy-evaluation-3',
      nowMs: nowMs + 2_000,
    });
    assert.equal(first.state.consecutiveHealthyCount, 1);
    assert.equal(duplicate.state.consecutiveHealthyCount, 1);
    assert.equal(second.state.consecutiveHealthyCount, 2);
    assert.equal(shadowThird.state.state, 'RECOVERED_PENDING_CONFIRMATION');
    assert.equal(shadowThird.shouldClearRuntimeBlock, false);
    assert.equal(activeThird.shouldClearRuntimeBlock, true);
  });

  await test('operator pause, emergency stop, and severe reasons reset recovery progress', async () => {
    const nowMs = Date.parse('2026-07-26T00:06:00.000Z');
    const current = recovery.normalizeRuntimeRecoveryState({
      id: 'runtime-recovery',
      state: 'RECOVERY_OBSERVING',
      stateVersion: 3,
      enteredAt: new Date(nowMs - 60_000).toISOString(),
      updatedAt: new Date(nowMs - 60_000).toISOString(),
      originatingBreachReasons: ['QUEUE_CONGESTION'],
      currentApplicableReasons: [],
      consecutiveHealthyCount: 2,
      requiredHealthyCount: 3,
      evidenceSummary: {
        measurementState: 'RECOVERY',
        evaluationStatus: 'PASS',
        evaluatedAt: new Date(nowMs).toISOString(),
        maximumEvidenceAgeMs: 120_000,
        reasonCodes: [],
        terminalJobSamples: 20,
        publicationAttempts: 0,
        monitorOutcomes: 0,
        publicProducts: 0,
      },
      releaseIdentity: 'a'.repeat(40),
    }, nowMs);
    for (const reasonCode of ['OPERATOR_PAUSE_ACTIVE', 'EMERGENCY_STOP_ACTIVE', 'RELEASE_MISMATCH']) {
      const transition = recovery.deriveRuntimeRecoveryTransition(current, {
        evaluationId: `blocked-${reasonCode}`,
        evaluationStatus: reasonCode === 'RELEASE_MISMATCH' ? 'BREACH' : 'PASS',
        applicableReasons: reasonCode === 'RELEASE_MISMATCH' ? [reasonCode] : [],
        recoveryEligibilityReasons: reasonCode === 'RELEASE_MISMATCH' ? [] : [reasonCode],
        evidenceSummary: current.evidenceSummary,
        publishBlockedByRuntime: true,
        featureMode: 'ACTIVE',
        nowMs,
      });
      assert.equal(transition.state.consecutiveHealthyCount, 0);
      assert.equal(transition.shouldClearRuntimeBlock, false);
      assert.ok(transition.state.currentApplicableReasons.includes(reasonCode));
    }
  });

  await test('recovery canary stays disabled by default even with otherwise eligible evidence', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    delete process.env.RECOVERY_CANARY;
    const decision = await recoveryCanary.issueRuntimeRecoveryCanaryPermit({
      operationId: 'recovery-canary-disabled-operation',
      productId: 'recovery-canary-disabled-product',
      jobId: 'recovery-canary-disabled-job',
      claimToken: 'test-fixture-recovery-canary-disabled-claim',
      ownership,
      readinessSnapshotHash: 'b'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasonCode, 'RECOVERY_CANARY_DISABLED');
    assert.deepEqual(await recoveryCanary.listRuntimeRecoveryCanaryPermits(), []);
  });

  await test('a stale scheduler lease prevents a recovery canary permit', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    process.env.RECOVERY_CANARY = 'ACTIVE';
    assert.equal(await runtimeRoles.heartbeatRuntimeRole('WORKER', ownership, 5 * 60_000, nowMs + 30_000), true);
    const decision = await recoveryCanary.issueRuntimeRecoveryCanaryPermit({
      operationId: 'recovery-canary-stale-scheduler-operation',
      productId: 'recovery-canary-stale-scheduler-product',
      jobId: 'recovery-canary-stale-scheduler-job',
      claimToken: 'test-fixture-recovery-canary-stale-scheduler-claim',
      ownership,
      readinessSnapshotHash: 'f'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs: nowMs + 46_000,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasonCode, 'RECOVERY_CANARY_SCHEDULER_LEASE_INVALID');
  });

  await test('a role release mismatch prevents a recovery canary permit', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    process.env.RECOVERY_CANARY = 'ACTIVE';
    await adapter.runTransaction('runtime-role-leases', leases => {
      const scheduler = leases.find(lease => lease.role === 'SCHEDULER');
      scheduler.releaseId = 'b'.repeat(40);
      return leases;
    });
    const decision = await recoveryCanary.issueRuntimeRecoveryCanaryPermit({
      operationId: 'recovery-canary-release-mismatch-operation',
      productId: 'recovery-canary-release-mismatch-product',
      jobId: 'recovery-canary-release-mismatch-job',
      claimToken: 'test-fixture-recovery-canary-release-mismatch-claim',
      ownership,
      readinessSnapshotHash: 'a'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasonCode, 'RECOVERY_CANARY_RELEASE_MISMATCH');
  });

  await test('one scoped permit is fenced, capacity bounded, and consumed exactly once', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    process.env.RECOVERY_CANARY = 'ACTIVE';
    const base = {
      operationId: 'recovery-canary-operation-one',
      productId: 'recovery-canary-product-one',
      jobId: 'recovery-canary-job-one',
      claimToken: 'test-fixture-recovery-canary-claim-one',
      ownership,
      readinessSnapshotHash: 'c'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs,
    };
    const issued = await recoveryCanary.issueRuntimeRecoveryCanaryPermit(base);
    assert.equal(issued.allowed, true);
    assert.equal(issued.permit.status, 'ISSUED');
    assert.equal((await recovery.getRuntimeRecoveryState()).state, 'HALF_OPEN');

    const capacity = await recoveryCanary.issueRuntimeRecoveryCanaryPermit({
      ...base,
      operationId: 'recovery-canary-operation-two',
      productId: 'recovery-canary-product-two',
      jobId: 'recovery-canary-job-two',
      claimToken: 'test-fixture-recovery-canary-claim-two',
    });
    assert.equal(capacity.allowed, false);
    assert.equal(capacity.reasonCode, 'RECOVERY_CANARY_CAPACITY_REACHED');

    const differentClaim = await recoveryCanary.consumeRuntimeRecoveryCanaryPermit({
      ...base,
      claimToken: 'test-fixture-recovery-canary-competing-claim',
      permitId: issued.permit.id,
      publicationEffectKey: 'recovery-canary-publication-effect',
    });
    assert.equal(differentClaim.allowed, false);
    assert.equal(differentClaim.reasonCode, 'RECOVERY_CANARY_PERMIT_OWNERSHIP_MISMATCH');

    const consumed = await recoveryCanary.consumeRuntimeRecoveryCanaryPermit({
      ...base,
      permitId: issued.permit.id,
      publicationEffectKey: 'recovery-canary-publication-effect',
    });
    const replay = await recoveryCanary.consumeRuntimeRecoveryCanaryPermit({
      ...base,
      permitId: issued.permit.id,
      publicationEffectKey: 'recovery-canary-publication-effect',
    });
    assert.equal(consumed.allowed, true);
    assert.equal(consumed.permit.status, 'CONSUMED');
    assert.equal(replay.allowed, true);
    assert.equal(replay.permit.id, consumed.permit.id);
    assert.equal((await recoveryCanary.listRuntimeRecoveryCanaryPermits()).length, 1);

    const afterPermitExpiry = nowMs + 31 * 60_000;
    const schedulerOwnership = {
      ownerId: 'recovery-canary-scheduler',
      instanceId: 'recovery-canary-scheduler-instance',
      fencingToken: 1,
    };
    for (let heartbeatAt = nowMs + 30_000; heartbeatAt < afterPermitExpiry; heartbeatAt += 4 * 60_000) {
      assert.equal(await runtimeRoles.heartbeatRuntimeRole('WORKER', ownership, 5 * 60_000, heartbeatAt), true);
      assert.equal(await runtimeRoles.heartbeatRuntimeRole('SCHEDULER', schedulerOwnership, 5 * 60_000, heartbeatAt), true);
    }
    assert.equal(await runtimeRoles.heartbeatRuntimeRole('WORKER', ownership, 5 * 60_000, afterPermitExpiry), true);
    assert.equal(await runtimeRoles.heartbeatRuntimeRole('SCHEDULER', schedulerOwnership, 5 * 60_000, afterPermitExpiry), true);
    const currentRecovery = await recovery.getRuntimeRecoveryState();
    await recovery.updateRuntimeRecoveryState({
      expectedStateVersion: currentRecovery.stateVersion,
      nowMs: afterPermitExpiry,
      mutate: current => ({
        ...current,
        evidenceSummary: {
          ...current.evidenceSummary,
          evaluatedAt: new Date(afterPermitExpiry).toISOString(),
        },
      }),
    });
    const stillBounded = await recoveryCanary.issueRuntimeRecoveryCanaryPermit({
      ...base,
      operationId: 'recovery-canary-operation-after-expiry',
      productId: 'recovery-canary-product-after-expiry',
      jobId: 'recovery-canary-job-after-expiry',
      claimToken: 'test-fixture-recovery-canary-claim-after-expiry',
      nowMs: afterPermitExpiry,
    });
    assert.equal(stillBounded.allowed, false);
    assert.equal(stillBounded.reasonCode, 'RECOVERY_CANARY_CAPACITY_REACHED');
    const resumedAfterIssueExpiry = await recoveryCanary.validateRuntimeRecoveryCanaryPermitForOperation({
      ...base,
      claimToken: 'test-fixture-recovery-canary-restarted-claim',
      permitId: consumed.permit.id,
      publicationEffectKey: 'recovery-canary-publication-effect',
      nowMs: afterPermitExpiry,
    });
    assert.equal(resumedAfterIssueExpiry.allowed, true);
    assert.equal(resumedAfterIssueExpiry.permit.status, 'CONSUMED');
  });

  await test('healthy canary evidence does not clear the runtime block by itself', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    process.env.RECOVERY_CANARY = 'ACTIVE';
    const base = {
      operationId: 'recovery-canary-healthy-operation',
      productId: 'recovery-canary-healthy-product',
      jobId: 'recovery-canary-healthy-job',
      claimToken: 'test-fixture-recovery-canary-healthy-claim',
      ownership,
      readinessSnapshotHash: 'd'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs,
    };
    const issued = await recoveryCanary.issueRuntimeRecoveryCanaryPermit(base);
    const consumed = await recoveryCanary.consumeRuntimeRecoveryCanaryPermit({
      ...base,
      permitId: issued.permit.id,
      publicationEffectKey: 'recovery-canary-healthy-publication',
    });
    await recoveryCanary.finalizeRuntimeRecoveryCanaryPermit({
      permitId: consumed.permit.id,
      productId: base.productId,
      healthy: true,
      reasonCode: 'RECOVERY_CANARY_MONITOR_HEALTHY',
      publicationEffectKey: 'recovery-canary-healthy-publication',
      nowMs: nowMs + 1_000,
    });
    const control = await store.getAutomationControl();
    const state = await recovery.getRuntimeRecoveryState();
    assert.equal(control.publishBlockedByRuntime, true);
    assert.equal(state.state, 'RECOVERY_OBSERVING');
    assert.equal(state.currentCanaryPermitReference, undefined);
  });

  await test('unhealthy canary preserves the runtime block and resets recovery progress', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    process.env.RECOVERY_CANARY = 'ACTIVE';
    const base = {
      operationId: 'recovery-canary-unhealthy-operation',
      productId: 'recovery-canary-unhealthy-product',
      jobId: 'recovery-canary-unhealthy-job',
      claimToken: 'test-fixture-recovery-canary-unhealthy-claim',
      ownership,
      readinessSnapshotHash: 'e'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs,
    };
    const issued = await recoveryCanary.issueRuntimeRecoveryCanaryPermit(base);
    const consumed = await recoveryCanary.consumeRuntimeRecoveryCanaryPermit({
      ...base,
      permitId: issued.permit.id,
      publicationEffectKey: 'recovery-canary-unhealthy-publication',
    });
    await recoveryCanary.finalizeRuntimeRecoveryCanaryPermit({
      permitId: consumed.permit.id,
      productId: base.productId,
      healthy: false,
      reasonCode: 'RECOVERY_CANARY_MONITOR_TEMPORARY_FAILURE',
      publicationEffectKey: 'recovery-canary-unhealthy-publication',
      nowMs: nowMs + 1_000,
      preserveRuntimeBlock: true,
    });
    const control = await store.getAutomationControl();
    const state = await recovery.getRuntimeRecoveryState();
    assert.equal(control.publishBlockedByRuntime, true);
    assert.equal(state.state, 'OPEN_BLOCKED');
    assert.equal(state.consecutiveHealthyCount, 0);
    assert.deepEqual(state.currentApplicableReasons, ['RECOVERY_CANARY_MONITOR_TEMPORARY_FAILURE']);
  });

  console.log(`\nMaster M1 runtime recovery primitives: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
