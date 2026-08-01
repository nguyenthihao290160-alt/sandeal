/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `master-m1-runtime-recovery-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
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
      adapter.writeCollection('runtime-recovery-canary-health-v1', []),
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

  await test('safety-sensitive implementations preserve their guarded rollout defaults', async () => {
    const states = rollout.listFeatureRolloutStates({});
    assert.equal(states.find(item => item.feature === 'RUNTIME_RECOVERY_V2').mode, 'SHADOW');
    assert.equal(states.find(item => item.feature === 'RECOVERY_CANARY').mode, 'OFF');
    assert.equal(states.find(item => item.feature === 'WORKER_CONTINUOUS_POOL_V2').mode, 'OFF');
    assert.equal(states.find(item => item.feature === 'SLO_RUNNABLE_AT_V2').mode, 'SHADOW');
    assert.equal(states.find(item => item.feature === 'PRODUCT_RECHECK_V2').mode, 'SHADOW');
    assert.equal(states.find(item => item.feature === 'PUBLICATION_EVIDENCE_V2').mode, 'SHADOW');
    assert.equal(states.find(item => item.feature === 'ACCESSTRADE_LIVE_READINESS_PROBE').mode, 'OFF');
    assert.equal(states.find(item => item.feature === 'MONGO_BULK_WRITE').mode, 'OFF');
    assert.equal(states.every(item => item.valid), true);
    const productRecheck = states.find(item => item.feature === 'PRODUCT_RECHECK_V2');
    assert.deepEqual({
      configuredValue: productRecheck.configuredValue,
      effectiveMode: productRecheck.effectiveMode,
      effectiveModeSource: productRecheck.effectiveModeSource,
      rolloutCohort: productRecheck.rolloutCohort,
      inactiveReason: productRecheck.inactiveReason,
    }, {
      configuredValue: null,
      effectiveMode: 'SHADOW',
      effectiveModeSource: 'SAFE_DEFAULT',
      rolloutCohort: 'PRODUCT_RECHECK_V2:SHADOW',
      inactiveReason: 'FEATURE_ROLLOUT_SHADOW_ONLY',
    });
  });

  await test('malformed runtime-control journal is fail-closed and cannot be cleared as healthy', async () => {
    await adapter.writeCollection('automation-control', [{
      ...store.DEFAULT_CONTROL,
      updatedAt: new Date().toISOString(),
      runtimeControlApplications: [null, { evaluationId: 'missing-required-fields' }],
    }]);
    const control = await store.getAutomationControl();
    assert.equal(control.publishBlockedByRuntime, true);
    assert.equal(control.runtimeControlJournalInvalidCount, 2);
    assert.ok(control.publishRuntimeReasons.includes('RUNTIME_CONTROL_JOURNAL_INVALID'));
    const clear = await store.clearRuntimePublishReasons({
      reasonCodes: ['RUNTIME_CONTROL_JOURNAL_INVALID'],
      expectedChangedAt: control.changedAt,
      expectedRuntimeReasons: control.publishRuntimeReasons,
      reason: 'INVALID_JOURNAL_MUST_NOT_CLEAR',
      evaluationId: 'invalid-journal-clear-attempt',
    });
    assert.equal(clear.status, 'STATE_CONFLICT');
    assert.equal(clear.control.publishBlockedByRuntime, true);
    await adapter.writeCollection('automation-control', []);
  });

  await test('runtime blockers and unaudited control intents are not silently truncated', async () => {
    await adapter.writeCollection('automation-control', []);
    const reasons = Array.from({ length: 25 }, (_, index) => `RUNTIME_REASON_${index}`);
    const applied = await store.applyRuntimePublishBlock({
      reasonCodes: reasons,
      evaluationId: 'many-runtime-reasons',
      evaluatedAt: new Date().toISOString(),
      degradeMode: false,
    }, 'runtime-recovery-test');
    assert.equal(reasons.every(reason => applied.control.publishRuntimeReasons.includes(reason)), true);

    const now = new Date().toISOString();
    const pending = Array.from({ length: 60 }, (_, index) => ({
      schemaVersion: 1,
      evaluationId: `pending-runtime-control-${index}`,
      operationType: 'RUNTIME_BLOCK_APPLIED',
      actor: 'runtime-recovery-test',
      reasons: [`PENDING_REASON_${index}`],
      previousRuntimeReasons: [],
      nextRuntimeReasons: [`PENDING_REASON_${index}`],
      previousEffectiveMode: 'SHADOW',
      nextEffectiveMode: 'SHADOW',
      appliedAt: now,
    }));
    await adapter.writeCollection('automation-control', [{
      ...store.DEFAULT_CONTROL,
      publishPaused: true,
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['PENDING_AUDIT_FIXTURE'],
      runtimeControlApplications: pending,
      updatedAt: now,
    }]);
    const retained = await store.getAutomationControl();
    assert.equal(retained.runtimeControlApplications.length, 60);
    assert.equal(retained.runtimeControlApplications.every(item => item.auditedAt === undefined), true);
    await adapter.writeCollection('automation-control', []);
  });

  await test('invalid rollout configuration falls back without exposing the raw value', async () => {
    const state = rollout.getFeatureRolloutState('RECOVERY_CANARY', { RECOVERY_CANARY: 'unexpected-secret-like-value' });
    assert.deepEqual(state, {
      feature: 'RECOVERY_CANARY',
      configuredValue: 'INVALID',
      mode: 'OFF',
      defaultMode: 'OFF',
      effectiveMode: 'OFF',
      effectiveModeSource: 'INVALID_CONFIGURATION_FALLBACK',
      rolloutCohort: 'RECOVERY_CANARY:OFF',
      inactiveReason: 'FEATURE_ROLLOUT_INVALID_VALUE',
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

  await test('only ordered release-compatible evidence advances the authoritative recovery streak', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    const nowMs = Date.parse('2026-07-26T00:05:00.000Z');
    const reasonCode = 'QUEUE_CONGESTION';
    const evidenceSummary = {
      measurementState: 'RECOVERY',
      evaluationStatus: 'PASS',
      evaluatedAt: new Date(nowMs).toISOString(),
      maximumEvidenceAgeMs: 120_000,
      reasonCodes: [],
      terminalJobSamples: 20,
      publicationAttempts: 0,
      monitorOutcomes: 0,
      publicProducts: 0,
    };
    const observation = (observedAt, overrides = {}) => ({
      reasonCode,
      metricKey: 'job_pickup_latency_p95_ms',
      measurement: 'PASS',
      qualifyingStatus: 'PASS',
      observedAt: new Date(observedAt).toISOString(),
      releaseIdentity: 'a'.repeat(40),
      qualificationReasons: [],
      evidenceReferences: [`runtime-health:${observedAt}`],
      ...overrides,
    });
    const advance = (evaluationId, observedAt, overrides = {}) =>
      recovery.advanceRuntimeReasonRecoveryState({
        evaluationId,
        observations: [observation(observedAt, overrides)],
        activeReasons: [reasonCode],
        evidenceSummary: { ...evidenceSummary, evaluatedAt: new Date(observedAt).toISOString() },
        featureMode: 'ACTIVE',
        requiredReleaseIdentity: 'a'.repeat(40),
        nowMs: observedAt,
      });

    const first = await advance('healthy-evaluation-1', nowMs);
    const replay = await advance('healthy-evaluation-1', nowMs);
    const missing = await advance('missing-evidence-2', nowMs + 30_000, {
      measurement: 'INSUFFICIENT_DATA',
      qualifyingStatus: 'INSUFFICIENT_DATA',
      evidenceReferences: [],
    });
    const restarted = await advance('healthy-evaluation-3', nowMs + 60_000);
    const mismatched = await advance('release-mismatch-4', nowMs + 90_000, {
      releaseIdentity: 'b'.repeat(40),
    });

    assert.equal(first.state.reasonProgress[0].consecutiveHealthyCount, 1);
    assert.equal(replay.state.reasonProgress[0].consecutiveHealthyCount, 1);
    assert.equal(missing.state.reasonProgress[0].consecutiveHealthyCount, 0);
    assert.equal(restarted.state.reasonProgress[0].consecutiveHealthyCount, 1);
    assert.equal(mismatched.state.reasonProgress[0].consecutiveHealthyCount, 0);
    assert.ok(mismatched.state.reasonProgress[0].qualificationReasons.includes('RUNTIME_RECOVERY_RELEASE_MISMATCH'));
    assert.deepEqual(mismatched.clearedReasons, []);
  });

  await test('non-consecutive, stale, partial, and out-of-order evidence cannot clear a runtime reason', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    const nowMs = Date.parse('2026-07-26T00:10:00.000Z');
    const reasonCode = 'RUNTIME_GUARDIAN_UNSAFE';
    const evidenceSummary = {
      measurementState: 'RECOVERY',
      evaluationStatus: 'PASS',
      evaluatedAt: new Date(nowMs).toISOString(),
      maximumEvidenceAgeMs: 120_000,
      reasonCodes: [],
      terminalJobSamples: 0,
      publicationAttempts: 0,
      monitorOutcomes: 0,
      publicProducts: 0,
    };
    const call = (id, currentNow, observedAt, overrides = {}) =>
      recovery.advanceRuntimeReasonRecoveryState({
        evaluationId: id,
        observations: [{
          reasonCode,
          metricKey: 'runtime_publish_safe',
          measurement: 'PASS',
          qualifyingStatus: 'PASS',
          observedAt: new Date(observedAt).toISOString(),
          releaseIdentity: 'a'.repeat(40),
          qualificationReasons: [],
          evidenceReferences: [`runtime-health:${observedAt}`],
          ...overrides,
        }],
        activeReasons: [reasonCode],
        evidenceSummary: { ...evidenceSummary, evaluatedAt: new Date(currentNow).toISOString() },
        featureMode: 'ACTIVE',
        requiredReleaseIdentity: 'a'.repeat(40),
        nowMs: currentNow,
      });

    assert.equal((await call('sequence-1', nowMs, nowMs)).state.reasonProgress[0].consecutiveHealthyCount, 1);
    assert.equal((await call('sequence-partial', nowMs + 30_000, nowMs + 30_000, {
      qualifyingStatus: 'INSUFFICIENT_DATA',
      qualificationReasons: ['PARTIAL_SOURCE_EVIDENCE'],
    })).state.reasonProgress[0].consecutiveHealthyCount, 0);
    assert.equal((await call('sequence-2', nowMs + 60_000, nowMs + 60_000)).state.reasonProgress[0].consecutiveHealthyCount, 1);
    assert.equal((await call('sequence-stale', nowMs + 4 * 60_000, nowMs + 60_000)).state.reasonProgress[0].consecutiveHealthyCount, 0);
    assert.equal((await call('sequence-3', nowMs + 4 * 60_000 + 10_000, nowMs + 4 * 60_000 + 10_000)).state.reasonProgress[0].consecutiveHealthyCount, 1);
    const outOfOrder = await call('sequence-out-of-order', nowMs + 4 * 60_000 + 20_000, nowMs + 4 * 60_000 + 5_000);
    assert.equal(outOfOrder.state.reasonProgress[0].consecutiveHealthyCount, 0);
    assert.ok(outOfOrder.state.reasonProgress[0].qualificationReasons.includes('RUNTIME_RECOVERY_EVIDENCE_OUT_OF_ORDER'));
    assert.deepEqual(outOfOrder.clearedReasons, []);
  });

  await test('three consecutive explicit observations clear exactly one reason while SHADOW cannot clear', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    const nowMs = Date.parse('2026-07-26T00:20:00.000Z');
    const reasonCode = 'JOB_PICKUP_LATENCY_SLO_FAILED';
    const run = (index, featureMode) => recovery.advanceRuntimeReasonRecoveryState({
      evaluationId: `qualified-evaluation-${index}`,
      observations: [{
        reasonCode,
        metricKey: 'job_pickup_latency_p95_ms',
        measurement: 'PASS',
        qualifyingStatus: 'PASS',
        observedAt: new Date(nowMs + index * 30_000).toISOString(),
        releaseIdentity: 'a'.repeat(40),
        qualificationReasons: [],
        evidenceReferences: [`runtime-health:${nowMs + index * 30_000}`, `queue-summary:${index}`],
      }],
      activeReasons: [reasonCode],
      evidenceSummary: {
        measurementState: 'RECOVERY',
        evaluationStatus: 'INSUFFICIENT_DATA',
        evaluatedAt: new Date(nowMs + index * 30_000).toISOString(),
        maximumEvidenceAgeMs: 120_000,
        reasonCodes: ['UNRELATED_METRIC_INSUFFICIENT'],
        terminalJobSamples: 0,
        publicationAttempts: 0,
        monitorOutcomes: 0,
        publicProducts: 0,
      },
      featureMode,
      requiredReleaseIdentity: 'a'.repeat(40),
      nowMs: nowMs + index * 30_000,
    });
    assert.equal((await run(0, 'ACTIVE')).state.reasonProgress[0].consecutiveHealthyCount, 1);
    assert.equal((await run(1, 'ACTIVE')).state.reasonProgress[0].consecutiveHealthyCount, 2);
    assert.deepEqual((await run(2, 'SHADOW')).clearedReasons, []);
    const cleared = await run(3, 'ACTIVE');
    assert.deepEqual(cleared.clearedReasons, [reasonCode]);
    assert.equal(cleared.state.state, 'RECOVERED_PENDING_CONFIRMATION');
    assert.equal(cleared.state.recentlyRecoveredReasons.at(-1).reasonCode, reasonCode);
  });

  await test('the legacy aggregate transition can preserve or strengthen a block but cannot clear it', async () => {
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
      if (reasonCode === 'RELEASE_MISMATCH') {
        assert.ok(transition.state.currentApplicableReasons.includes(reasonCode));
        assert.equal(transition.reasonCode, 'RUNTIME_BREACH_RECORDED');
      } else {
        assert.equal(transition.state.lastResetReason, 'RUNTIME_RECOVERY_EXPLICIT_REASON_EVIDENCE_REQUIRED');
        assert.equal(transition.reasonCode, 'RUNTIME_RECOVERY_SAFETY_GATE_BLOCKED');
      }
    }
  });

  await test('a one-record legacy canary read remains explicitly bounded and incomplete', async () => {
    const nowMs = Date.now();
    const issuedAt = new Date(nowMs - 1_000).toISOString();
    await adapter.writeCollection('runtime-recovery-canary-health-v1', []);
    await adapter.writeCollection('runtime-recovery-canary-permits', [{
      schemaVersion: 1,
      id: 'legacy-bounded-permit',
      operationId: 'legacy-bounded-operation',
      productId: 'legacy-bounded-product',
      jobId: 'legacy-bounded-job',
      readinessSnapshotHash: '1'.repeat(64),
      ownerId: 'legacy-bounded-owner',
      instanceId: 'legacy-bounded-instance',
      fencingToken: 1,
      claimTokenHash: '2'.repeat(64),
      status: 'ISSUED',
      issuedAt,
      expiresAt: new Date(nowMs + 60_000).toISOString(),
      releaseIdentity: 'a'.repeat(40),
    }]);

    const health = await recoveryCanary.getRuntimeRecoveryCanaryHealthView(nowMs);
    assert.equal(health.activeCount, 1);
    assert.equal(health.latestPermit.id, 'legacy-bounded-permit');
    assert.equal(health.currentStateComplete, false);
    assert.equal(health.historyComplete, false);
    assert.equal(health.truncated, true);
    assert.equal(health.durableHistoryCount, null);
    assert.ok(health.reasonCodes.includes('RECOVERY_CANARY_HEALTH_BOOTSTRAP_BOUNDED'));
    assert.ok(health.reasonCodes.includes('RECOVERY_CANARY_CURRENT_STATE_INCOMPLETE'));
    assert.ok(health.reasonCodes.includes('RECOVERY_CANARY_HISTORY_BOUNDED'));
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

  await test('a persisted recovery-state release mismatch prevents a recovery canary permit', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    process.env.RECOVERY_CANARY = 'ACTIVE';
    const current = await recovery.getRuntimeRecoveryState();
    await adapter.writeCollection('runtime-recovery-state', [{
      ...current,
      releaseIdentity: 'b'.repeat(40),
    }]);
    const decision = await recoveryCanary.issueRuntimeRecoveryCanaryPermit({
      operationId: 'recovery-canary-state-release-mismatch-operation',
      productId: 'recovery-canary-state-release-mismatch-product',
      jobId: 'recovery-canary-state-release-mismatch-job',
      claimToken: 'test-fixture-recovery-canary-state-release-mismatch-claim',
      ownership,
      readinessSnapshotHash: '3'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasonCode, 'RECOVERY_CANARY_RELEASE_MISMATCH');
    assert.deepEqual(await recoveryCanary.listRuntimeRecoveryCanaryPermits(), []);
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

  await test('unhealthy canary additively preserves adjacent runtime reasons and interrupts every recovery streak', async () => {
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
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: [
        'HISTORICAL_RUNTIME_BREACH',
        'CONCURRENT_RUNTIME_INCIDENT',
      ],
      reason: 'CONCURRENT_RUNTIME_INCIDENT',
    }, 'runtime-guardian');
    const beforeFailure = await recovery.getRuntimeRecoveryState();
    await recovery.updateRuntimeRecoveryState({
      expectedStateVersion: beforeFailure.stateVersion,
      nowMs: nowMs + 500,
      mutate: current => ({
        ...current,
        state: 'OPEN_BLOCKED',
        currentApplicableReasons: ['CONCURRENT_RUNTIME_INCIDENT'],
        consecutiveHealthyCount: 2,
        reasonProgress: [{
          reasonCode: 'CONCURRENT_RUNTIME_INCIDENT',
          metricKey: 'runtime_publish_safe',
          measurement: 'PASS',
          consecutiveHealthyCount: 2,
          requiredHealthyCount: 3,
          lastEvaluationId: 'concurrent-runtime-evaluation',
          lastHealthyEvaluation: new Date(nowMs + 500).toISOString(),
          qualifiedWindowStartedAt: new Date(nowMs).toISOString(),
          lastQualifiedObservationAt: new Date(nowMs + 500).toISOString(),
          lastReleaseIdentity: 'a'.repeat(40),
          lastEvidenceReferences: ['runtime-health-concurrent'],
          qualificationReasons: [],
          lastTransitionAt: new Date(nowMs + 500).toISOString(),
        }],
      }),
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
    assert.deepEqual(
      [...control.publishRuntimeReasons].sort(),
      [
        'CONCURRENT_RUNTIME_INCIDENT',
        'HISTORICAL_RUNTIME_BREACH',
        'RECOVERY_CANARY_MONITOR_TEMPORARY_FAILURE',
      ],
    );
    assert.deepEqual(
      [...state.currentApplicableReasons].sort(),
      [
        'CONCURRENT_RUNTIME_INCIDENT',
        'HISTORICAL_RUNTIME_BREACH',
        'RECOVERY_CANARY_MONITOR_TEMPORARY_FAILURE',
      ],
    );
    assert.equal(state.evidenceSummary.evaluationStatus, 'BREACH');
    assert.equal(state.lastResetReason, 'RECOVERY_CANARY_MONITOR_TEMPORARY_FAILURE');
    assert.equal(state.reasonProgress.every(progress => progress.consecutiveHealthyCount === 0), true);
    const adjacent = state.reasonProgress.find(progress => progress.reasonCode === 'CONCURRENT_RUNTIME_INCIDENT');
    const canaryFailure = state.reasonProgress.find(
      progress => progress.reasonCode === 'RECOVERY_CANARY_MONITOR_TEMPORARY_FAILURE',
    );
    assert.equal(adjacent.measurement, 'INSUFFICIENT_DATA');
    assert.ok(adjacent.qualificationReasons.includes('RUNTIME_RECOVERY_CANARY_FAILURE_INTERRUPTED_STREAK'));
    assert.equal(canaryFailure.measurement, 'BREACH');
    assert.ok(canaryFailure.qualificationReasons.includes('RUNTIME_RECOVERY_CANARY_FAILURE_OBSERVED'));
  });

  await test('revoked canary remains fail-closed and cannot erase an adjacent runtime reason', async () => {
    const nowMs = Date.now();
    const ownership = await prepareCanarySafety(nowMs);
    process.env.RECOVERY_CANARY = 'ACTIVE';
    const base = {
      operationId: 'recovery-canary-revoked-operation',
      productId: 'recovery-canary-revoked-product',
      jobId: 'recovery-canary-revoked-job',
      claimToken: 'test-fixture-recovery-canary-revoked-claim',
      ownership,
      readinessSnapshotHash: '9'.repeat(64),
      productEligibleExceptRuntime: true,
      nowMs,
    };
    const issued = await recoveryCanary.issueRuntimeRecoveryCanaryPermit(base);
    assert.equal(issued.allowed, true);
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['ADJACENT_RUNTIME_REASON'],
      reason: 'ADJACENT_RUNTIME_REASON',
    }, 'runtime-guardian');
    await recoveryCanary.finalizeRuntimeRecoveryCanaryPermit({
      permitId: issued.permit.id,
      productId: base.productId,
      healthy: false,
      reasonCode: 'RECOVERY_CANARY_REVOKED_BY_SAFETY_GATE',
      nowMs: nowMs + 1_000,
      preserveRuntimeBlock: false,
      finalStatus: 'REVOKED',
    });

    const control = await store.getAutomationControl();
    const state = await recovery.getRuntimeRecoveryState();
    assert.equal(control.publishBlockedByRuntime, true);
    assert.deepEqual(
      [...control.publishRuntimeReasons].sort(),
      ['ADJACENT_RUNTIME_REASON', 'RECOVERY_CANARY_REVOKED_BY_SAFETY_GATE'],
    );
    assert.deepEqual(
      [...state.currentApplicableReasons].sort(),
      ['ADJACENT_RUNTIME_REASON', 'RECOVERY_CANARY_REVOKED_BY_SAFETY_GATE'],
    );
    assert.equal(state.state, 'OPEN_BLOCKED');
  });

  console.log(`\nMaster M1 runtime recovery primitives: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(testRoot, { recursive: true, force: true }));
