/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-slo-error-budget-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
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

  async function seedWaveOneWithThreePublished() {
    await reset('CANARY');
    await canary.recordSuccessfulShadowCycle();
    for (const key of ['effect-1', 'effect-2', 'effect-3']) {
      assert.equal(await canary.reserveCanaryEffect('CANARY', key), true);
      await canary.completeCanaryEffect('CANARY', key, true);
    }
  }

  async function seedWaveTwoWithTenPublished() {
    await seedWaveOneWithThreePublished();
    await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'seed-healthy-wave-1', status: 'PASS', dataStatus: 'MEASURED', sampleSize: 5, evaluatedAt: new Date().toISOString(),
    });
    for (let index = 4; index <= 10; index += 1) {
      assert.equal(await canary.reserveCanaryEffect('CANARY', `effect-${index}`), true);
      await canary.completeCanaryEffect('CANARY', `effect-${index}`, true);
    }
  }

  await test('wave 0 is shadow-only and wave 1 admits at most three unique effects', async () => {
    await reset('CANARY');
    assert.equal(canary.getCanaryWaveBudget(0), 0);
    assert.equal((await canary.canPublishInCurrentWave('CANARY', 'effect-1')).allowed, false);
    assert.equal((await canary.recordSuccessfulShadowCycle()).wave, 1);
    assert.equal(canary.getCanaryWaveBudget(1), 3);
    for (const key of ['effect-1', 'effect-2', 'effect-3']) assert.equal(await canary.reserveCanaryEffect('CANARY', key), true);
    assert.equal(await canary.reserveCanaryEffect('CANARY', 'effect-4'), false);
    for (const key of ['effect-1', 'effect-2', 'effect-3']) await canary.completeCanaryEffect('CANARY', key, true);
    assert.equal((await canary.canPublishInCurrentWave('CANARY', 'effect-1')).allowed, true, 'completed effect replay must remain allowed');
  });

  await test('wave promotion rejects missing or insufficient evidence and wave 2 caps total effects at ten', async () => {
    await seedWaveOneWithThreePublished();
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation()).wave, 1);
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'insufficient', status: 'INSUFFICIENT_DATA', dataStatus: 'INSUFFICIENT_DATA', sampleSize: 99, evaluatedAt: new Date().toISOString(),
    })).wave, 1);
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'healthy-wave-1', status: 'PASS', dataStatus: 'MEASURED', sampleSize: 5, evaluatedAt: new Date().toISOString(),
    })).wave, 2);
    assert.equal(canary.getCanaryWaveBudget(2), 10);
    for (let index = 4; index <= 10; index += 1) assert.equal(await canary.reserveCanaryEffect('CANARY', `effect-${index}`), true);
    assert.equal(await canary.reserveCanaryEffect('CANARY', 'effect-11'), false);
  });

  await test('wave 3 expands only after a new measured PASS and retains a deterministic budget', async () => {
    await seedWaveTwoWithTenPublished();
    assert.equal((await canary.advanceCanaryWaveAfterHealthyEvaluation({
      evaluationId: 'healthy-wave-2', status: 'PASS', dataStatus: 'MEASURED', sampleSize: 5, evaluatedAt: new Date().toISOString(),
    })).wave, 3);
    assert.equal(canary.getCanaryWaveBudget(3), 50);
    for (let index = 11; index <= 50; index += 1) assert.equal(await canary.reserveCanaryEffect('CANARY', `effect-${index}`), true);
    assert.equal(await canary.reserveCanaryEffect('CANARY', 'effect-51'), false);
  });

  await test('empty persisted telemetry is insufficient data and never reports SLO PASS', async () => {
    await reset('AUTONOMOUS'); const now = Date.now();
    const measured = await slo.measureAutomationSlo({ now });
    assert.equal(measured.dataStatus, 'INSUFFICIENT_DATA');
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

  await test('healthy persisted outcomes produce a measured PASS without changing configured mode', async () => {
    await reset('AUTONOMOUS'); const now = Date.now(); await seedHealthyEvidence(now);
    const result = await slo.applyAutomationErrorBudget({ now });
    assert.equal(result.measurement.dataStatus, 'MEASURED');
    assert.equal(result.evaluation.status, 'PASS', JSON.stringify(result.measurement.metrics));
    assert.equal(result.measurement.zeroTouchRate, 1);
    assert.equal(result.measurement.duplicatePublishCount, 0);
    assert.equal(result.measurement.unsafePublishCount, 0);
    assert.equal(result.control.mode, 'AUTONOMOUS'); assert.equal(result.control.effectiveMode, 'AUTONOMOUS');
    assert.equal(result.applied, false); assert.equal(result.ingestionAvailable, true);
  });

  await test('a non-severe error-rate breach degrades one step without pausing canary publication', async () => {
    await reset('AUTONOMOUS'); const now = Date.now(); await seedHealthyEvidence(now);
    await adapter.runTransaction('automation-jobs', jobs => {
      jobs[0].status = 'FAILED';
      jobs[0].lastErrorCode = 'TRANSIENT_PROVIDER_ERROR';
      for (let index = 5; index < 10; index += 1) jobs.push(job(now, index));
      return jobs;
    });
    const result = await slo.applyAutomationErrorBudget({ now });
    assert.deepEqual(result.evaluation.reasons, ['ERROR_BUDGET_EXCEEDED']);
    assert.equal(result.control.effectiveMode, 'CANARY'); assert.equal(result.control.publishPaused, false);
    assert.equal(result.canary.paused, false); assert.equal(result.control.ingestionPaused, false);
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
