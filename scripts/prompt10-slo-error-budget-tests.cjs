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
    web: { status: 'ready', buildAvailable: true, publicRouteHealthy: true },
    worker: { status: 'active', holderId: 'worker-fixture', heartbeatAt: new Date(now - 1_000).toISOString() },
    scheduler: { status: 'active', holderId: 'scheduler-fixture', heartbeatAt: new Date(now - 1_000).toISOString() },
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
      'runtime-recovery-state',
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
    const types = ['AUTO_PILOT', 'PROCESS_CANDIDATE', 'AUTO_SAFE_PUBLISH', 'POST_PUBLISH_MONITOR', 'RECONCILE_AUTOMATION'];
    const jobs = types.map((type, index) => job(now, index, {
      type,
      requestedBy: type === 'AUTO_PILOT' ? 'scheduler' : 'autopilot-worker',
      result: type === 'POST_PUBLISH_MONITOR' ? { outcome: 'HEALTHY' } : {},
    }));
    await adapter.writeCollection('automation-jobs', jobs);
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
  }

  async function seedZeroProductRecoveryEvidence(now, monitorOutcome) {
    const types = ['AUTO_PILOT', 'PROCESS_CANDIDATE', 'PROCESS_CANDIDATE', 'RECONCILE_AUTOMATION', 'AUTO_SAFE_PUBLISH'];
    const jobs = types.map((type, index) => job(now, index, {
      type,
      requestedBy: type === 'AUTO_PILOT' ? 'scheduler' : 'autopilot-worker',
    }));
    if (monitorOutcome) {
      jobs[4] = job(now, 4, {
        type: 'POST_PUBLISH_MONITOR',
        requestedBy: 'autopilot-worker',
        result: { outcome: monitorOutcome },
      });
    }
    await adapter.writeCollection('automation-jobs', jobs);
    await adapter.writeCollection('runtime-health', [runtimeSnapshot(now)]);
    await adapter.writeCollection('publication-audit', []);
    await adapter.writeCollection('automation-outbound-events', []);
    await adapter.writeCollection('products', []);
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
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation()).wave, 1);
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'insufficient', status: 'INSUFFICIENT_DATA', dataStatus: 'INSUFFICIENT_DATA', sampleSize: 99, evaluatedAt: new Date().toISOString(),
    })).wave, 1);
    const measured = await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'healthy-wave-1', status: 'PASS', dataStatus: 'MEASURED', sampleSize: 5, evaluatedAt: new Date().toISOString(),
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
    const measured = await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'healthy-wave-2', status: 'PASS', dataStatus: 'MEASURED', sampleSize: 5, evaluatedAt: new Date().toISOString(),
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
    assert.equal(result.recovery.lastResetReason, 'OPERATOR_PUBLISH_PAUSE_ACTIVE');
    assert.equal(result.applied, false); assert.equal(result.ingestionAvailable, true);
  });

  await test('zero public products recover after three distinct healthy evaluations without fabricated monitor evidence', async () => {
    await reset('AUTONOMOUS');
    const firstNow = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['HISTORICAL_RUNTIME_BREACH'],
    }, 'slo-test');
    let result;
    for (let index = 0; index < 3; index += 1) {
      const now = firstNow + index * 61_000;
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
      for (let index = 5; index < 10; index += 1) jobs.push(job(now, index));
      return jobs;
    });
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

  await test('the same breached time bucket cannot apply the control downgrade twice', async () => {
    await reset('AUTONOMOUS'); const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000; await seedBreachedEvidence(now);
    const first = await slo.applyAutomationErrorBudget({ now });
    const second = await slo.applyAutomationErrorBudget({ now: now + 1_000 });
    assert.equal(first.control.effectiveMode, 'CANARY'); assert.equal(first.applied, true);
    assert.equal(second.control.effectiveMode, 'CANARY'); assert.equal(second.applied, false);
    const snapshot = await slo.getLatestSloMeasurement();
    assert.equal(snapshot.application.status, 'APPLIED'); assert.equal(snapshot.application.nextEffectiveMode, 'CANARY');
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
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
