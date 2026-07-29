/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-slo-error-budget-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.RUNTIME_RECOVERY_V2 = 'ACTIVE';
process.env.SANDEAL_BUILD_COMMIT = 'a'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'a'.repeat(40);
process.env.GIT_COMMIT_SHA = 'a'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'a'.repeat(40);
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function job(now, index, overrides = {}) {
  const createdAt = new Date(now - 20_000 - index * 1_000).toISOString();
  const claimedAt = new Date(now - 19_000 - index * 1_000).toISOString();
  const completedAt = new Date(now - 10_000 - index * 1_000).toISOString();
  return {
    schemaVersion: 2,
    policyVersion: 'automation-policy-v1',
    handlerVersion: 'handler-v1',
    id: `job-${index}`,
    type: 'AUTO_PILOT',
    status: 'SUCCEEDED',
    payload: {},
    result: {},
    priority: 50,
    idempotencyKey: `job-key-${index}`,
    operationId: `operation-${index}`,
    requestedBy: 'scheduler',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    scheduledAt: createdAt,
    claimedAt,
    startedAt: claimedAt,
    completedAt,
    createdAt,
    updatedAt: completedAt,
    ...overrides,
  };
}

function runtimeSnapshot(now, overrides = {}) {
  return {
    schemaVersion: 1,
    id: `runtime-health:${now}`,
    ruleVersion: 'runtime-guardian-v1',
    web: {
      status: 'ready',
      buildAvailable: true,
      publicRouteHealthy: true,
      buildId: 'fixture-build',
      releaseId: 'a'.repeat(40),
      releaseMatchesBuild: null,
    },
    worker: {
      status: 'active',
      holderId: 'worker-fixture',
      heartbeatAt: new Date(now - 1_000).toISOString(),
      releaseId: 'a'.repeat(40),
    },
    scheduler: {
      status: 'active',
      holderId: 'scheduler-fixture',
      heartbeatAt: new Date(now - 1_000).toISOString(),
      releaseId: 'a'.repeat(40),
    },
    providers: {},
    queue: { pending: 0, running: 0, stuck: 0, staleJobs: 0 },
    storage: { status: 'healthy', staleLocks: 0, freeBytes: 1024 * 1024 * 1024 },
    duplicateRoles: [],
    publishSafe: true,
    reasons: [],
    recommendation: { pausePublish: false, pauseIngestion: false },
    checkedAt: new Date(now - 1_000).toISOString(),
    ...overrides,
  };
}

function safePublicProduct(now, overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'public-safe',
    title: 'Verified public fixture product',
    slug: 'verified-public-fixture-product',
    kind: 'product',
    recordType: 'PRODUCT',
    platform: 'website',
    source: 'manual',
    originalUrl: 'https://merchant.example/product',
    affiliateUrl: 'https://merchant.example/product?affiliate=fixture',
    imageUrl: 'https://merchant.example/product.jpg',
    price: 1000000,
    currency: 'VND',
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: 'published',
    publicHidden: false,
    verifiedSource: true,
    autoPublishEligible: true,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    duplicateStatus: 'CLEAR',
    claimValidationStatus: 'VERIFIED',
    evidenceCoverage: 0.95,
    confidences: { publish: 0.95 },
    publishedAt: new Date(now - 5_000).toISOString(),
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 5_000).toISOString(),
    ...overrides,
  };
}

function cleanupTempDir() {
  const fixtureRoot = path.resolve(process.cwd(), '.test-tmp');
  const resolvedTempDir = path.resolve(tempDir);
  if (
    path.dirname(resolvedTempDir) !== fixtureRoot
    || !path.basename(resolvedTempDir).startsWith('prompt10-slo-error-budget-')
  ) {
    throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolvedTempDir}`);
  }
  fs.rmSync(resolvedTempDir, { recursive: true, force: true });
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const canary = require('../src/lib/automation/canaryController.ts');
  const slo = require('../src/lib/automation/sloErrorBudget.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_SLO_TESTS'); };

  async function reset(mode = 'AUTONOMOUS') {
    for (const collection of [
      'automation-canary', 'automation-slo-snapshots', 'automation-jobs', 'runtime-health',
      'publication-audit', 'automation-outbound-events', 'products', 'automation-control', 'automation-audit',
      'runtime-recovery-state', 'automation-job-projections', 'automation-job-list-projections-v2',
      'automation-job-projection-manifest-v1', 'automation-job-attempts',
    ]) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode,
      effectiveMode: mode,
      publishPaused: false,
      ingestionPaused: false,
      workerPaused: false,
      schedulerPaused: false,
      killSwitch: false,
    }, 'slo-test');
  }

  async function seedHealthyEvidence(now) {
    const types = ['AUTO_PILOT', 'PROCESS_CANDIDATE', 'AUTO_SAFE_PUBLISH', 'POST_PUBLISH_MONITOR', 'RECONCILE_AUTOMATION', 'AUTO_PILOT'];
    const jobs = types.map((type, index) => job(now, index, {
      type,
      requestedBy: type === 'AUTO_PILOT' ? 'scheduler' : 'autopilot-worker',
      result: type === 'PROCESS_CANDIDATE'
        ? { candidateStatus: 'completed', productId: `candidate-product-${index}` }
        : type === 'AUTO_SAFE_PUBLISH'
          ? { published: true, evidenceVerified: true, productId: 'public-safe' }
          : type === 'POST_PUBLISH_MONITOR'
            ? { outcome: 'HEALTHY' }
            : type === 'AUTO_PILOT'
              ? { executionStatus: 'COMPLETED_WITH_LOCAL_RULES', summary: { failed: 0 } }
              : {},
    }));
    await adapter.writeCollection('automation-jobs', jobs);
    await store.rebuildAutomationJobReadModelsFromDurable(jobs, now);
    await adapter.writeCollection('runtime-health', [runtimeSnapshot(now)]);
    await adapter.writeCollection('publication-audit', [{ runId: 'publish-run-1', productId: 'public-safe', action: 'published', timestamp: new Date(now - 5_000).toISOString() }]);
    await adapter.writeCollection('automation-outbound-events', [{ effectKey: 'publish-effect:public-safe:1', productId: 'public-safe', eventType: 'PRODUCT_PUBLISHED', createdAt: new Date(now - 5_000).toISOString() }]);
    await adapter.writeCollection('products', [safePublicProduct(now)]);
  }

  async function seedBreachedEvidence(now) {
    await seedHealthyEvidence(now);
    await adapter.runTransaction('automation-jobs', jobs => {
      jobs[0].status = 'FAILED';
      jobs[0].lastErrorCode = 'STORAGE_LOCK_TIMEOUT';
      jobs[0].lastErrorMessage = 'Storage lock timeout: products';
      return jobs;
    });
    await adapter.writeCollection('runtime-health', [runtimeSnapshot(now, {
      web: { status: 'unhealthy', buildAvailable: true, publicRouteHealthy: false },
      worker: { status: 'stale', heartbeatAt: new Date(now - 10 * 60_000).toISOString() },
      scheduler: { status: 'stale', heartbeatAt: new Date(now - 10 * 60_000).toISOString() },
      publishSafe: false,
      reasons: ['WORKER_STALE', 'SCHEDULER_STALE', 'WEB_UNHEALTHY'],
      recommendation: { pausePublish: true, pauseIngestion: false, effectiveMode: 'SHADOW' },
    })]);
    await adapter.writeCollection('publication-audit', [
      { runId: 'publish-run-1', productId: 'public-safe', action: 'published', timestamp: new Date(now - 5_000).toISOString() },
      { runId: 'publish-run-2', productId: 'rollback', action: 'rolled_back', timestamp: new Date(now - 4_000).toISOString() },
    ]);
    await adapter.writeCollection('automation-outbound-events', [
      { effectKey: 'publish-effect:unsafe:1', productId: 'public-safe', eventType: 'PRODUCT_PUBLISHED', createdAt: new Date(now - 5_000).toISOString() },
      { effectKey: 'publish-effect:unsafe:1', productId: 'public-safe', eventType: 'PRODUCT_PUBLISHED', createdAt: new Date(now - 4_000).toISOString() },
    ]);
    await adapter.writeCollection('products', [safePublicProduct(now, { riskLevel: 'high' })]);
    await adapter.runTransaction('automation-jobs', jobs => {
      const monitor = jobs.find(item => item.type === 'POST_PUBLISH_MONITOR');
      monitor.result = { outcome: 'CONFIRMED_BROKEN' };
      return jobs;
    });
    await store.rebuildAutomationJobReadModelsFromDurable(
      await adapter.readCollection('automation-jobs'),
      now,
    );
  }

  async function seedZeroProductRecoveryEvidence(now, monitorOutcome) {
    const types = ['AUTO_PILOT', 'AUTO_PILOT', 'AUTO_PILOT', 'AUTO_PILOT', 'AUTO_PILOT'];
    const jobs = types.map((type, index) => job(now, index, {
      type,
      requestedBy: type === 'AUTO_PILOT' ? 'scheduler' : 'autopilot-worker',
      result: type === 'AUTO_PILOT'
        ? { executionStatus: 'COMPLETED_WITH_LOCAL_RULES', summary: { failed: 0 } }
        : {},
    }));
    if (monitorOutcome) {
      jobs[4] = job(now, 4, {
        type: 'POST_PUBLISH_MONITOR',
        requestedBy: 'autopilot-worker',
        result: { outcome: monitorOutcome },
      });
    }
    await adapter.writeCollection('automation-jobs', jobs);
    await store.rebuildAutomationJobReadModelsFromDurable(jobs, now);
    await adapter.writeCollection('runtime-health', [runtimeSnapshot(now)]);
    await adapter.writeCollection('publication-audit', []);
    await adapter.writeCollection('automation-outbound-events', []);
    await adapter.writeCollection('products', []);
  }

  async function seedQuiescentCurrentProof(now, runtimeOverrides = undefined) {
    await adapter.writeCollection('automation-jobs', []);
    await store.rebuildAutomationJobReadModelsFromDurable([], now);
    await adapter.writeCollection('runtime-health', [
      runtimeSnapshot(now, runtimeOverrides),
    ]);
    await adapter.writeCollection('publication-audit', []);
    await adapter.writeCollection('automation-outbound-events', []);
    await adapter.writeCollection('products', []);
  }

  async function seedErrorRateOnlyBreach(now) {
    await seedHealthyEvidence(now);
    await adapter.runTransaction('automation-jobs', jobs => {
      jobs[0].status = 'FAILED';
      jobs[0].lastErrorCode = 'TRANSIENT_PROVIDER_ERROR';
      jobs[0].lastErrorMessage = 'Fixture transient provider failure';
      for (let index = 6; index < 11; index += 1) {
        jobs.push(job(now, index, {
          result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES', summary: { failed: 0 } },
        }));
      }
      return jobs;
    });
    await store.rebuildAutomationJobReadModelsFromDurable(
      await adapter.readCollection('automation-jobs'),
      now,
    );
  }

  async function seedControlledWave(wave, publishedCount = 0) {
    const initial = await canary.getCanaryState();
    const now = new Date().toISOString();
    await adapter.writeCollection('automation-canary', [{
      ...initial, controlledLaunch: true, wave, approvedWave: wave, successfulShadowCycles: 1,
      reservedEffectKeys: [], publishedEffectKeys: Array.from({ length: publishedCount }, (_, index) => `effect-${index + 1}`),
      approvedBy: 'slo-test', approvedAt: now, approvalReason: `Isolated approved controlled wave ${wave}.`,
      wavePublishedBaseline: 0, paused: false, pauseReasons: [], updatedAt: now,
    }]);
  }

  async function seedWaveOneWithTenPublished() {
    await reset('CANARY');
    await seedControlledWave(1, 10);
  }

  async function seedWaveTwoWithThirtyFivePublished() {
    await reset('CANARY');
    await seedControlledWave(2, 35);
  }

  await test('controlled wave 0 is shadow-only and approved wave 1 admits at most ten unique effects', async () => {
    await reset('CANARY');
    await seedControlledWave(0, 0);
    assert.equal(canary.getControlledWaveBudget(0), 0);
    assert.equal((await canary.canPublishInCurrentWave('CANARY', 'effect-1')).allowed, false);
    assert.equal((await canary.recordSuccessfulShadowCycle()).wave, 0, 'shadow success must not auto-create a controlled wave');
    await seedControlledWave(1, 0);
    assert.equal(canary.getControlledWaveBudget(1), 10);
    for (let index = 1; index <= 10; index += 1) assert.equal(await canary.reserveCanaryEffect('CANARY', `effect-${index}`), true);
    assert.equal(await canary.reserveCanaryEffect('CANARY', 'effect-11'), false);
    for (let index = 1; index <= 10; index += 1) await canary.completeCanaryEffect('CANARY', `effect-${index}`, true);
    assert.equal((await canary.canPublishInCurrentWave('CANARY', 'effect-1')).allowed, true, 'completed effect replay must remain allowed');
  });

  await test('controlled promotion rejects missing evidence, never auto-approves, and approved wave 2 caps at thirty-five', async () => {
    await seedWaveOneWithTenPublished();
    const releaseIdentity = 'a'.repeat(40);
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation()).wave, 1);
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'insufficient', status: 'INSUFFICIENT_DATA', dataStatus: 'INSUFFICIENT_DATA', sampleSize: 99, evaluatedAt: new Date().toISOString(),
      evidenceComplete: false, releaseIdentity, requiredReleaseIdentity: releaseIdentity,
    })).wave, 1);
    const incomplete = await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'incomplete-pass',
      status: 'PASS',
      dataStatus: 'MEASURED',
      sampleSize: 5,
      evaluatedAt: new Date().toISOString(),
      evidenceComplete: false,
      releaseIdentity,
      requiredReleaseIdentity: releaseIdentity,
    });
    assert.equal(incomplete.lastHealthyEvaluationId, undefined);
    const releaseMismatch = await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'release-mismatch-pass',
      status: 'PASS',
      dataStatus: 'MEASURED',
      sampleSize: 5,
      evaluatedAt: new Date().toISOString(),
      evidenceComplete: true,
      releaseIdentity,
      requiredReleaseIdentity: 'b'.repeat(40),
    });
    assert.equal(releaseMismatch.lastHealthyEvaluationId, undefined);
    const measured = await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'healthy-wave-1', status: 'PASS', dataStatus: 'MEASURED', sampleSize: 5, evaluatedAt: new Date().toISOString(),
      evidenceComplete: true, releaseIdentity, requiredReleaseIdentity: releaseIdentity,
    });
    assert.equal(measured.wave, 1, 'measured PASS is evidence, not owner wave approval');
    assert.equal(measured.lastHealthyEvaluationId, 'healthy-wave-1');
    await seedControlledWave(2, 10);
    assert.equal(canary.getControlledWaveBudget(2), 35);
    for (let index = 11; index <= 35; index += 1) assert.equal(await canary.reserveCanaryEffect('CANARY', `effect-${index}`), true);
    assert.equal(await canary.reserveCanaryEffect('CANARY', 'effect-36'), false);
  });

  await test('controlled wave 3 requires a separate approval and retains its deterministic cumulative budget', async () => {
    await seedWaveTwoWithThirtyFivePublished();
    const releaseIdentity = 'a'.repeat(40);
    const measured = await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'healthy-wave-2', status: 'PASS', dataStatus: 'MEASURED', sampleSize: 5, evaluatedAt: new Date().toISOString(),
      evidenceComplete: true, releaseIdentity, requiredReleaseIdentity: releaseIdentity,
    });
    assert.equal(measured.wave, 2);
    await seedControlledWave(3, 35);
    assert.equal(canary.getControlledWaveBudget(3), 85);
    for (let index = 36; index <= 85; index += 1) assert.equal(await canary.reserveCanaryEffect('CANARY', `effect-${index}`), true);
    assert.equal(await canary.reserveCanaryEffect('CANARY', 'effect-86'), false);
  });

  await test('empty persisted telemetry is insufficient data and never reports SLO PASS', async () => {
    await reset('AUTONOMOUS'); const now = Date.now();
    const measured = await slo.measureAutomationSlo({ now });
    assert.equal(measured.dataStatus, 'BOOTSTRAP');
    assert.equal(slo.evaluateAutomationErrorBudget(measured).status, 'INSUFFICIENT_DATA');
    assert.deepEqual(new Set(measured.metrics.map(metric => metric.key)), new Set([
      'worker_heartbeat_fresh', 'scheduler_heartbeat_fresh', 'job_pickup_latency_p95_ms', 'terminal_outcome_rate',
      'terminal_error_rate', 'post_publish_health_pass_rate', 'duplicate_publish_count', 'unsafe_publish_count',
      'storage_lock_timeout_count', 'rollback_rate', 'zero_touch_completion_rate', 'runtime_publish_safe', 'public_route_healthy',
    ]));
    const applied = await slo.applyAutomationErrorBudget({ now });
    assert.equal(applied.applied, false); assert.equal(applied.control.effectiveMode, 'AUTONOMOUS');
    assert.equal((await adapter.readCollection('automation-slo-snapshots')).length, 1);
  });

  await test('no eligible zero-touch sample stays insufficient instead of becoming zero-percent or PASS', async () => {
    await reset('AUTONOMOUS');
    const now = Date.now();
    const manualJobs = Array.from({ length: 5 }, (_, index) => job(now, index, {
      type: 'AUTO_PILOT',
      requestedBy: 'dashboard-user',
      requestedExecutionMode: 'MANUAL_ONLY',
      executionMode: 'MANUAL_INPUT',
      outcomeStatus: 'COMPLETED_WITH_MANUAL_INPUT',
      result: { executionStatus: 'COMPLETED_WITH_MANUAL_INPUT', summary: { failed: 0 } },
    }));
    await adapter.writeCollection('automation-jobs', manualJobs);
    await store.rebuildAutomationJobReadModelsFromDurable(manualJobs, now);
    await adapter.writeCollection('runtime-health', [runtimeSnapshot(now)]);
    await adapter.writeCollection('publication-audit', []);
    await adapter.writeCollection('automation-outbound-events', []);
    await adapter.writeCollection('products', []);
    const measured = await slo.measureAutomationSlo({ now, minimumSamples: 1 });
    const zeroTouch = measured.metrics.find(metric => metric.key === 'zero_touch_completion_rate');
    assert.equal(measured.sourceCounts.zeroTouchEligible, 0);
    assert.equal(measured.sourceCounts.zeroTouchSucceeded, 0);
    assert.equal(measured.zeroTouchRate, null);
    assert.equal(zeroTouch.evaluationStatus, 'INSUFFICIENT_DATA');
    assert.equal(slo.evaluateAutomationErrorBudget(measured).status, 'INSUFFICIENT_DATA');
  });

  await test('AUTO_PILOT child failures, blocks, and cancellations remain truthful terminal outcomes', async () => {
    await reset('AUTONOMOUS');
    const now = Date.now();
    const autoPilotResult = (byStatus) => ({
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES',
      summary: { failed: 0 },
      childSummary: { total: 1, byStatus },
    });
    const jobs = [
      job(now, 1, { result: autoPilotResult({ FAILED: 1 }) }),
      job(now, 2, { result: autoPilotResult({ BLOCKED: 1 }) }),
      job(now, 3, { result: autoPilotResult({ CANCELLED: 1 }) }),
      job(now, 4, { result: autoPilotResult({ SUCCEEDED: 1 }) }),
    ];
    await adapter.writeCollection('automation-jobs', jobs);
    await store.rebuildAutomationJobReadModelsFromDurable(jobs, now);
    await adapter.writeCollection('runtime-health', [runtimeSnapshot(now)]);
    await adapter.writeCollection('publication-audit', []);
    await adapter.writeCollection('automation-outbound-events', []);
    await adapter.writeCollection('products', []);

    const measured = await slo.measureAutomationSlo({ now, minimumSamples: 1 });
    const zeroTouch = measured.metrics.find(metric => metric.key === 'zero_touch_completion_rate');
    assert.equal(measured.sourceCounts.zeroTouchEligible, 4);
    assert.equal(measured.sourceCounts.zeroTouchSucceeded, 1);
    assert.equal(measured.sourceCounts.zeroTouchBlocked, 1);
    assert.equal(measured.sourceCounts.zeroTouchFailed, 2);
    assert.equal(measured.sourceCounts.zeroTouchPartial, 0);
    assert.equal(measured.zeroTouchRate, 0.25);
    assert.equal(zeroTouch.value, 0.25);
    assert.equal(zeroTouch.status, 'BREACH');
  });

  await test('truthful publish_blocked outcome is blocked zero-touch work and never a publication attempt or success', async () => {
    await reset('AUTONOMOUS');
    const now = Date.now();
    const blocked = [job(now, 1, {
      type: 'AUTO_SAFE_PUBLISH',
      requestedBy: 'autopilot-worker',
      result: {
        published: false,
        quarantined: false,
        evidenceVerified: false,
        reasons: ['PRICE_EVIDENCE_MISSING'],
      },
    })];
    await adapter.writeCollection('automation-jobs', blocked);
    await store.rebuildAutomationJobReadModelsFromDurable(blocked, now);
    await adapter.writeCollection('runtime-health', [runtimeSnapshot(now)]);
    await adapter.writeCollection('publication-audit', [{
      runId: 'blocked-publication-run',
      productId: 'blocked-product',
      action: 'publish_blocked',
      timestamp: new Date(now - 1_000).toISOString(),
    }]);
    await adapter.writeCollection('automation-outbound-events', []);
    await adapter.writeCollection('products', []);
    const measured = await slo.measureAutomationSlo({ now, minimumSamples: 1 });
    const zeroTouch = measured.metrics.find(metric => metric.key === 'zero_touch_completion_rate');
    const rollback = measured.metrics.find(metric => metric.key === 'rollback_rate');
    const duplicate = measured.metrics.find(metric => metric.key === 'duplicate_publish_count');
    assert.equal(measured.sourceCounts.zeroTouchEligible, 1);
    assert.equal(measured.sourceCounts.zeroTouchSucceeded, 0);
    assert.equal(measured.sourceCounts.zeroTouchBlocked, 1);
    assert.equal(measured.sourceCounts.zeroTouchFailed, 0);
    assert.equal(measured.sourceCounts.publicationAttempts, 0);
    assert.equal(measured.sourceCounts.publishBlockedDecisions, 1);
    assert.equal(zeroTouch.status, 'BREACH');
    assert.equal(rollback.evaluationStatus, 'NOT_APPLICABLE');
    assert.equal(duplicate.evaluationStatus, 'NOT_APPLICABLE');
  });

  await test('operator pause prevents runtime recovery progress and remains untouched', async () => {
    await reset('AUTONOMOUS'); const now = Date.now(); await seedZeroProductRecoveryEvidence(now);
    await store.updateAutomationControl({
      publishPausedByOperator: true,
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['REPEATED_PROCESS_RESTART'],
    }, 'slo-test');
    const result = await slo.applyAutomationErrorBudget({ now });
    assert.equal(result.measurement.dataStatus, 'RECOVERY');
    assert.equal(result.evaluation.status, 'PASS', JSON.stringify(result.measurement.metrics));
    assert.equal(result.control.mode, 'AUTONOMOUS'); assert.equal(result.control.effectiveMode, 'AUTONOMOUS');
    assert.equal(result.control.publishBlockedByRuntime, true);
    assert.equal(result.control.publishPausedByOperator, true);
    assert.equal(result.control.publishPaused, true);
    assert.equal(result.recovery.consecutiveHealthyCount, 0);
    assert.equal(result.recovery.lastResetReason, 'RUNTIME_RECOVERY_EVIDENCE_INSUFFICIENT');
    assert.equal(result.applied, false); assert.equal(result.ingestionAvailable, true);
  });

  await test('three current same-release quiescent proofs clear a runtime block despite unrelated insufficient zero-sample metrics', async () => {
    await reset('AUTONOMOUS');
    const firstNow = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['HEALTH_SLO_FAILED'],
    }, 'slo-test');

    let result;
    for (let index = 0; index < 3; index += 1) {
      const now = firstNow + index * 40_000;
      await seedQuiescentCurrentProof(now);
      result = await slo.applyAutomationErrorBudget({ now, minimumSamples: 5 });
      const zeroTouch = result.measurement.metrics.find(
        metric => metric.key === 'zero_touch_completion_rate',
      );
      assert.equal(result.measurement.sourceCounts.zeroTouchEligible, 0);
      assert.equal(result.measurement.zeroTouchRate, null);
      assert.equal(zeroTouch.evaluationStatus, 'INSUFFICIENT_DATA');
      assert.equal(result.measurement.dataStatus, 'INSUFFICIENT_DATA');
      assert.equal(result.evaluation.status, 'INSUFFICIENT_DATA');
      if (index < 2) {
        const progress = result.recovery.reasonProgress.find(
          item => item.reasonCode === 'HEALTH_SLO_FAILED',
        );
        assert.equal(result.control.publishBlockedByRuntime, true);
        assert.equal(progress.consecutiveHealthyCount, index + 1, JSON.stringify({
          evaluation: result.evaluation,
          projection: result.measurement.jobProjection,
          sourceCompleteness: result.measurement.sourceCompleteness,
          metrics: result.measurement.metrics,
          recovery: result.recovery,
        }));
        assert.equal(progress.lastReleaseIdentity, 'a'.repeat(40));
        assert.ok(progress.lastEvidenceReferences.length > 0);
      }
    }

    assert.equal(result.control.publishBlockedByRuntime, false);
    assert.deepEqual(result.control.publishRuntimeReasons, []);
    assert.equal(result.recovery.state, 'CLOSED_HEALTHY');
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).length, 0);
  });

  await test('missing and release-incomplete current evidence interrupt recovery and cannot clear a runtime block', async () => {
    await reset('AUTONOMOUS');
    const firstNow = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['JOB_PICKUP_LATENCY_SLO_FAILED'],
    }, 'slo-test');

    await seedQuiescentCurrentProof(firstNow);
    const first = await slo.applyAutomationErrorBudget({ now: firstNow, minimumSamples: 5 });
    assert.equal(first.control.publishBlockedByRuntime, true);
    assert.equal(first.recovery.consecutiveHealthyCount, 1, JSON.stringify({
      evaluation: first.evaluation,
      projection: first.measurement.jobProjection,
      sourceCompleteness: first.measurement.sourceCompleteness,
      metrics: first.measurement.metrics,
      recovery: first.recovery,
    }));

    const incompleteNow = firstNow + 30_000;
    await seedQuiescentCurrentProof(incompleteNow, {
      worker: {
        status: 'active',
        holderId: 'worker-without-release-evidence',
        heartbeatAt: new Date(incompleteNow - 1_000).toISOString(),
      },
    });
    const incomplete = await slo.applyAutomationErrorBudget({ now: incompleteNow, minimumSamples: 5 });
    assert.equal(incomplete.control.publishBlockedByRuntime, true);
    assert.equal(incomplete.recovery.consecutiveHealthyCount, 0);
    assert.ok(incomplete.recovery.reasonProgress[0].qualificationReasons.includes(
      'RUNTIME_RECOVERY_MANDATORY_RUNTIME_EVIDENCE_INCOMPLETE',
    ));

    const missingNow = firstNow + 60_000;
    await adapter.writeCollection('runtime-health', []);
    const missing = await slo.applyAutomationErrorBudget({ now: missingNow, minimumSamples: 5 });
    assert.equal(missing.evaluation.status, 'INSUFFICIENT_DATA');
    assert.equal(missing.control.publishBlockedByRuntime, true);
    assert.equal(missing.recovery.consecutiveHealthyCount, 0);
    assert.equal(missing.recovery.reasonProgress[0].consecutiveHealthyCount, 0);
  });

  await test('an overdue scheduled retry is active queue evidence and cannot authorize idle pickup recovery', async () => {
    await reset('AUTONOMOUS');
    const firstNow = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
    const retryEligibleAt = new Date(firstNow - 60_000).toISOString();
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['JOB_PICKUP_LATENCY_SLO_FAILED'],
    }, 'slo-test');

    let result;
    for (let index = 0; index < 3; index += 1) {
      const now = firstNow + index * 40_000;
      const retryJob = job(now, 100 + index, {
        id: 'overdue-retry-job',
        idempotencyKey: 'overdue-retry-job-key',
        operationId: 'overdue-retry-operation',
        type: 'PROCESS_CANDIDATE',
        status: 'RETRY_SCHEDULED',
        attemptCount: 1,
        createdAt: new Date(firstNow - 10 * 60_000).toISOString(),
        scheduledAt: retryEligibleAt,
        retryEligibleAt,
        runnableAt: retryEligibleAt,
        runnableReason: 'RETRY_ELIGIBLE_AT',
        claimedAt: undefined,
        startedAt: undefined,
        completedAt: undefined,
        updatedAt: new Date(now - 1_000).toISOString(),
        result: undefined,
      });
      await adapter.writeCollection('automation-jobs', [retryJob]);
      await store.rebuildAutomationJobReadModelsFromDurable([retryJob], now);
      await adapter.writeCollection('runtime-health', [runtimeSnapshot(now)]);
      result = await slo.applyAutomationErrorBudget({ now, minimumSamples: 5 });

      const pickup = result.measurement.metrics.find(
        metric => metric.key === 'job_pickup_latency_p95_ms',
      );
      assert.equal(result.measurement.pendingQueueCount, 1);
      assert.equal(result.measurement.sourceCounts.neverClaimedPending, 0);
      assert.equal(result.measurement.pendingQueueAgeMs >= 60_000, true);
      assert.notEqual(pickup.evaluationStatus, 'NOT_APPLICABLE');
      assert.notEqual(pickup.stateReason, 'VERIFIED_IDLE_QUEUE_NO_PICKUP_SAMPLE');
      assert.equal(result.control.publishBlockedByRuntime, true);
      assert.equal(result.recovery.reasonProgress[0].consecutiveHealthyCount, 0);
    }

    assert.equal(result.control.publishBlockedByRuntime, true);
    assert.deepEqual(result.control.publishRuntimeReasons, ['JOB_PICKUP_LATENCY_SLO_FAILED']);
  });

  await test('zero public products recover after three distinct healthy evaluations without fabricated monitor evidence', async () => {
    await reset('AUTONOMOUS');
    const firstNow = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['JOB_PICKUP_LATENCY_SLO_FAILED'],
    }, 'slo-test');
    let result;
    for (let index = 0; index < 3; index += 1) {
      const now = firstNow + index * 45_000;
      await seedZeroProductRecoveryEvidence(now);
      result = await slo.applyAutomationErrorBudget({ now });
      assert.equal(result.measurement.dataStatus, 'RECOVERY');
      assert.equal(result.evaluation.status, 'PASS');
      const monitorMetric = result.measurement.metrics.find(metric => metric.key === 'post_publish_health_pass_rate');
      assert.equal(monitorMetric.measurementState, 'NOT_APPLICABLE');
      assert.equal(monitorMetric.stateReason, 'NO_PUBLIC_PRODUCT_OR_LEGITIMATE_MONITOR_TARGET');
      if (index < 2) {
        assert.equal(result.control.publishBlockedByRuntime, true);
        assert.equal(result.recovery.consecutiveHealthyCount, index + 1);
      }
    }
    assert.equal(result.control.publishBlockedByRuntime, false);
    assert.equal(result.recovery.state, 'CLOSED_HEALTHY');
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);
  });

  await test('a real unhealthy monitor is measured as a breach and cannot authorize recovery', async () => {
    await reset('AUTONOMOUS');
    const now = Date.now();
    await seedZeroProductRecoveryEvidence(now, 'CONFIRMED_BROKEN');
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['HEALTH_SLO_FAILED'],
    }, 'slo-test');
    const result = await slo.applyAutomationErrorBudget({ now });
    const monitorMetric = result.measurement.metrics.find(metric => metric.key === 'post_publish_health_pass_rate');
    assert.equal(monitorMetric.measurementState, 'MEASURED');
    assert.equal(monitorMetric.status, 'BREACH');
    assert.equal(result.evaluation.status, 'BREACH');
    assert.equal(result.control.publishBlockedByRuntime, true);
    assert.equal(result.recovery.consecutiveHealthyCount, 0);
  });

  await test('an error-rate breach degrades one step and remains fail-closed', async () => {
    await reset('AUTONOMOUS'); const now = Date.now(); await seedHealthyEvidence(now);
    await adapter.runTransaction('automation-jobs', jobs => {
      jobs[0].status = 'FAILED';
      jobs[0].lastErrorCode = 'TRANSIENT_PROVIDER_ERROR';
      for (let index = 6; index < 11; index += 1) jobs.push(job(now, index, {
        result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES', summary: { failed: 0 } },
      }));
      return jobs;
    });
    await store.rebuildAutomationJobReadModelsFromDurable(
      await adapter.readCollection('automation-jobs'),
      now,
    );
    const result = await slo.applyAutomationErrorBudget({ now });
    assert.deepEqual(result.evaluation.reasons, ['ERROR_BUDGET_EXCEEDED']);
    assert.equal(result.control.effectiveMode, 'CANARY'); assert.equal(result.control.publishPaused, true);
    assert.equal(result.control.publishBlockedByRuntime, true);
    assert.equal(result.canary.paused, true); assert.equal(result.control.ingestionPaused, false);
  });

  await test('severe persisted faults degrade AUTONOMOUS to paused CANARY while ingestion remains available', async () => {
    await reset('AUTONOMOUS'); const now = Date.now(); await seedBreachedEvidence(now);
    const result = await slo.applyAutomationErrorBudget({ now });
    assert.equal(result.evaluation.status, 'BREACH');
    for (const reason of ['UNSAFE_PUBLISH', 'DUPLICATE_PUBLISH', 'STORAGE_LOCK_TIMEOUT', 'ROLLBACK_BUDGET_EXCEEDED', 'PUBLIC_ROUTE_UNHEALTHY']) {
      assert.ok(result.evaluation.reasons.includes(reason), JSON.stringify(result.evaluation.reasons));
    }
    assert.equal(result.previousEffectiveMode, 'AUTONOMOUS');
    assert.equal(result.control.mode, 'AUTONOMOUS'); assert.equal(result.control.effectiveMode, 'CANARY');
    assert.equal(result.control.publishPaused, true); assert.equal(result.control.ingestionPaused, false);
    assert.equal(result.canary.paused, true); assert.equal(result.publishPausedByBudget, true);
  });

  await test('a repeated breach degrades CANARY to SHADOW without skipping the mode ladder', async () => {
    const now = Date.now() + 61_000;
    const result = await slo.applyAutomationErrorBudget({ now });
    assert.equal(result.previousEffectiveMode, 'CANARY'); assert.equal(result.control.effectiveMode, 'SHADOW');
    assert.equal(result.control.mode, 'AUTONOMOUS'); assert.equal(result.control.publishPaused, true);
    assert.equal(result.control.ingestionPaused, false); assert.equal(result.canary.paused, true);
  });

  await test('an interrupted CLAIMED control application resumes exactly once without double degradation', async () => {
    await reset('AUTONOMOUS');
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
    await seedBreachedEvidence(now);
    const measurement = await slo.measureAutomationSlo({ now });
    const evaluation = slo.evaluateAutomationErrorBudget(measurement);
    assert.equal(evaluation.status, 'BREACH');
    await adapter.writeCollection('automation-slo-snapshots', [{
      ...measurement,
      evaluation,
      application: {
        status: 'CLAIMED',
        evaluationId: evaluation.id,
        claimedAt: evaluation.evaluatedAt,
      },
    }]);

    const resumed = await slo.applyAutomationErrorBudget({ now });
    assert.equal(resumed.applied, true);
    assert.equal(resumed.previousEffectiveMode, 'AUTONOMOUS');
    assert.equal(resumed.control.effectiveMode, 'CANARY');
    const replayed = await slo.applyAutomationErrorBudget({ now });
    assert.equal(replayed.applied, false);
    assert.equal(replayed.control.effectiveMode, 'CANARY');

    const applications = replayed.control.runtimeControlApplications.filter(
      application => application.evaluationId === evaluation.id
        && application.operationType === 'RUNTIME_BLOCK_APPLIED',
    );
    assert.equal(applications.length, 1);
    const controlAudits = (await adapter.readCollection('automation-audit')).filter(
      event => event.operationId === `${evaluation.id}:RUNTIME_BLOCK_APPLIED:automation-control`,
    );
    assert.equal(controlAudits.length, 1);
    const snapshot = await slo.getLatestSloMeasurement();
    assert.equal(snapshot.application.status, 'APPLIED');
    assert.equal(snapshot.application.evaluationId, evaluation.id);
    assert.equal(snapshot.application.nextEffectiveMode, 'CANARY');
  });

  await test('an identical breached evidence replay cannot apply the control downgrade twice', async () => {
    await reset('AUTONOMOUS'); const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000; await seedBreachedEvidence(now);
    const first = await slo.applyAutomationErrorBudget({ now });
    const second = await slo.applyAutomationErrorBudget({ now });
    assert.equal(first.control.effectiveMode, 'CANARY'); assert.equal(first.applied, true);
    assert.equal(second.control.effectiveMode, 'CANARY'); assert.equal(second.applied, false);
    const snapshot = await slo.getLatestSloMeasurement();
    assert.equal(snapshot.application.status, 'APPLIED'); assert.equal(snapshot.application.nextEffectiveMode, 'CANARY');
  });

  await test('distinct same-minute breach evidence is not mistaken for a prior APPLIED evaluation', async () => {
    await reset('AUTONOMOUS');
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
    await seedErrorRateOnlyBreach(now);
    const firstMeasurement = await slo.measureAutomationSlo({ now });
    const firstEvaluation = slo.evaluateAutomationErrorBudget(firstMeasurement);
    assert.deepEqual(firstEvaluation.reasons, ['ERROR_BUDGET_EXCEEDED']);
    const first = await slo.applyAutomationErrorBudget({ now });
    assert.equal(first.applied, true);
    assert.equal(first.control.effectiveMode, 'CANARY');

    await adapter.runTransaction('automation-jobs', jobs => {
      const replacement = jobs.find(item => item.id === 'job-10');
      replacement.id = 'job-10-distinct-evidence';
      replacement.idempotencyKey = 'job-key-10-distinct-evidence';
      replacement.operationId = 'operation-10-distinct-evidence';
      return jobs;
    });
    await store.rebuildAutomationJobReadModelsFromDurable(
      await adapter.readCollection('automation-jobs'),
      now,
    );
    const secondMeasurement = await slo.measureAutomationSlo({ now });
    const secondEvaluation = slo.evaluateAutomationErrorBudget(secondMeasurement);
    assert.notEqual(secondMeasurement.evidenceHash, firstMeasurement.evidenceHash);
    assert.deepEqual(secondEvaluation.reasons, firstEvaluation.reasons);
    assert.notEqual(
      secondEvaluation.id,
      firstEvaluation.id,
      'a distinct durable evidence set needs a distinct control idempotency key',
    );

    const second = await slo.applyAutomationErrorBudget({ now });
    assert.equal(second.applied, true);
    assert.equal(second.previousEffectiveMode, 'CANARY');
    assert.equal(second.control.effectiveMode, 'SHADOW');
    const blockApplications = second.control.runtimeControlApplications.filter(
      application => application.operationType === 'RUNTIME_BLOCK_APPLIED',
    );
    assert.equal(blockApplications.length, 2);
  });

  await test('legacy caller snapshots cannot forge a healthy outcome', async () => {
    await reset('CANARY'); const now = Date.now(); await seedBreachedEvidence(now);
    const result = await canary.applyErrorBudget({
      sampleSize: 1000, errorRate: 0, rollbackRate: 0, duplicatePublishCount: 0, unsafePublishCount: 0,
      storageLockTimeoutCount: 0, zeroTouchRate: 1, workerFresh: true, schedulerFresh: true, publicRouteHealthy: true,
    });
    assert.equal(result.effectiveMode, 'SHADOW');
    assert.ok(result.reasons.includes('UNSAFE_PUBLISH'));
  });

  console.log(`\nPROMPT10 Gate 5 SLO/error budget: ${passed} passed, ${failed} failed`);
  console.log(`Isolated fixture: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => cleanupTempDir());
