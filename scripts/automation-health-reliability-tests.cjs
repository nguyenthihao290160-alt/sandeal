/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const testRoot = path.join(
  process.cwd(),
  '.test-tmp',
  `automation-health-reliability-${process.pid}-${Date.now()}`,
);
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.RUNTIME_RECOVERY_V2 = 'ACTIVE';
process.env.SLO_RUNNABLE_AT_V2 = 'ACTIVE';
process.env.SANDEAL_BUILD_COMMIT = 'a'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'a'.repeat(40);
process.env.GIT_COMMIT_SHA = 'a'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'a'.repeat(40);
require('./register-typescript.cjs');

function cleanupTestRoot() {
  const resolvedRoot = path.resolve(testRoot);
  const expectedParent = path.resolve(process.cwd(), '.test-tmp');
  if (path.dirname(resolvedRoot) !== expectedParent
    || !path.basename(resolvedRoot).startsWith('automation-health-reliability-')) {
    throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolvedRoot}`);
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

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

function projectedJob(index, now, overrides = {}) {
  const createdAt = iso(now - 60_000 - index);
  const claimedAt = iso(now - 59_000 - index);
  const completedAt = iso(now - 58_000 - index);
  return {
    projectionSchemaVersion: 2,
    schemaVersion: 2,
    id: `projection-job-${index}`,
    type: 'HEALTH_CHECK',
    status: 'SUCCEEDED',
    payload: {},
    result: {
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES',
      summary: { failed: 0 },
    },
    policyVersion: 'automation-policy-v1',
    handlerVersion: 'handler-v1',
    idempotencyKey: `projection-job-key-${index}`,
    operationId: `projection-operation-${index}`,
    requestedBy: 'scheduler',
    priority: 50,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'CREATED_AT',
    claimedAt,
    startedAt: claimedAt,
    completedAt,
    updatedAt: completedAt,
    ...overrides,
  };
}

function runtimeSnapshot(now) {
  return {
    schemaVersion: 1,
    id: `runtime-health:${now}`,
    ruleVersion: 'runtime-guardian-v2',
    web: {
      status: 'ready',
      buildAvailable: true,
      publicRouteHealthy: true,
      buildId: 'fixture-build',
      releaseId: 'a'.repeat(40),
      releaseMatchesBuild: true,
    },
    worker: { status: 'active', heartbeatAt: iso(now - 1_000), releaseId: 'a'.repeat(40) },
    scheduler: { status: 'active', heartbeatAt: iso(now - 1_000), releaseId: 'a'.repeat(40) },
    providers: {},
    queue: { pending: 0, running: 0, stuck: 0, staleJobs: 0 },
    storage: { status: 'healthy', staleLocks: 0, freeBytes: 1024 * 1024 * 1024 },
    duplicateRoles: [],
    publishSafe: true,
    reasons: [],
    historicalReasons: [],
    recommendation: { pausePublish: false, pauseIngestion: false },
    checkedAt: iso(now - 1_000),
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const healthSummary = require('../src/lib/automation/jobHealthSummary.ts');
  const healthService = require('../src/lib/automation/healthService.ts');
  const refreshState = require('../src/lib/dashboard/appHealthRefreshState.ts');
  const recoveryState = require('../src/lib/automation/runtimeRecoveryState.ts');
  const store = require('../src/lib/automation/store.ts');
  const slo = require('../src/lib/automation/sloErrorBudget.ts');
  const alerts = require('../src/lib/product-intelligence/alerts.ts');
  const now = Date.now();

  await test('a 13,000-record durable fixture is not read by cold or warm App Health', async () => {
    let durableJobs = Array.from({ length: 13_000 }, (_, index) => {
      const lifecycle = index < 4
        ? {
            status: 'RUNNING',
            type: index === 0 ? 'RUNTIME_GUARDIAN' : 'HEALTH_CHECK',
            completedAt: undefined,
            heartbeatAt: iso(now - 1_000),
            leaseExpiresAt: iso(now + 60_000),
            executionCritical: index === 0,
          }
        : index < 14
          ? {
              status: 'PENDING',
              completedAt: undefined,
              claimedAt: undefined,
              startedAt: undefined,
              runnableAt: iso(now - 10_000),
            }
          : {};
      return {
        ...projectedJob(index, now, lifecycle),
        payload: { evidence: 'x'.repeat(3_500), sequence: index },
        result: { representative: true },
      };
    });
    await adapter.writeCollection('automation-jobs', durableJobs);
    await store.rebuildAutomationJobReadModelsFromDurable(durableJobs, now);
    durableJobs = null;
    await adapter.writeCollection(
      'runtime-health',
      Array.from({ length: 500 }, (_, index) =>
        runtimeSnapshot(now - (499 - index) * 1_000)),
    );
    const permitHistory = Array.from({ length: 13_000 }, (_, index) => ({
      schemaVersion: 1,
      id: `historical-permit-${index}`,
      status: 'SUCCEEDED',
      issuedAt: iso(now - 13_000 + index),
      expiresAt: iso(now - 12_000 + index),
      releaseIdentity: 'a'.repeat(40),
    }));
    await adapter.writeCollection('runtime-recovery-canary-permits', permitHistory);
    await adapter.writeCollection('runtime-recovery-canary-health-v1', [{
      schemaVersion: 1,
      id: 'runtime-recovery-canary-health',
      releaseIdentity: 'a'.repeat(40),
      generation: 1,
      appliedGeneration: 1,
      pendingMutations: [],
      currentStateComplete: true,
      activeCount: 0,
      activePermits: [],
      latestPermit: permitHistory[permitHistory.length - 1],
      durableHistoryCount: permitHistory.length,
      historyComplete: false,
      truncated: true,
      observedRange: {
        earliestIssuedAt: permitHistory[0].issuedAt,
        latestIssuedAt: permitHistory[permitHistory.length - 1].issuedAt,
      },
      source: 'runtime-recovery-canary-health-v1',
      updatedAt: iso(now),
    }]);

    const fsPromises = require('node:fs').promises;
    const originalReadFile = fsPromises.readFile;
    let durableHistoryReads = 0;
    let durablePermitHistoryReads = 0;
    fsPromises.readFile = async function instrumentedReadFile(target, ...rest) {
      if (path.basename(String(target)) === 'automation-jobs.json') durableHistoryReads += 1;
      if (path.basename(String(target)) === 'runtime-recovery-canary-permits.json') {
        durablePermitHistoryReads += 1;
      }
      return originalReadFile.call(this, target, ...rest);
    };
    try {
      const dependencies = {
        getGeminiReadiness: async () => ({ status: 'not_configured', reasonCode: 'TEST_PROVIDER' }),
        getAccessTradeCredential: async () => null,
      };
      const coldStartedAt = performance.now();
      const cold = await healthService.buildAutomationHealthResponse({ now, dependencies });
      const coldMs = performance.now() - coldStartedAt;
      const warmStartedAt = performance.now();
      const warm = await healthService.buildAutomationHealthResponse({ now: now + 1, dependencies });
      const warmMs = performance.now() - warmStartedAt;

      assert.equal(durableHistoryReads, 0);
      assert.equal(durablePermitHistoryReads, 0);
      const coldTargetMs = 5_000;
      const warmTargetMs = 3_000;
      const coldSafetyMarginMs = 500;
      const warmSafetyMarginMs = 300;
      assert.ok(coldMs < coldTargetMs - coldSafetyMarginMs, `cold=${coldMs.toFixed(1)}ms`);
      assert.ok(warmMs < warmTargetMs - warmSafetyMarginMs, `warm=${warmMs.toFixed(1)}ms`);
      assert.ok(Buffer.byteLength(JSON.stringify(cold)) < 512 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(warm)) < 512 * 1024);
      assert.equal(cold.jobReadModel.totalProjectedJobs, 2_000);
      console.log(`BENCHMARK cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms runtimeSnapshots=500 durableJobReads=${durableHistoryReads} durablePermitReads=${durablePermitHistoryReads}`);
    } finally {
      fsPromises.readFile = originalReadFile;
    }
  });

  await test('an optional provider timeout returns bounded partial health', async () => {
    const result = await healthService.buildAutomationHealthResponse({
      now,
      budgets: { providerMs: 100 },
      dependencies: {
        getGeminiReadiness: () => new Promise(() => {}),
        getAccessTradeCredential: async () => null,
      },
    });
    assert.equal(result.partial, true);
    assert.equal(result.components.providerGemini.status, 'unavailable');
    assert.equal(result.components.providerGemini.reasonCode, 'COMPONENT_TIMEOUT');
    assert.ok(result.release);
    assert.ok(result.worker);
  });

  await test('a required core failure remains fail-closed without throwing an uninformative 500', async () => {
    const result = await healthService.buildAutomationHealthResponse({
      now,
      dependencies: {
        getControl: async () => { throw new Error('TEST_CORE_FAILURE'); },
        getGeminiReadiness: async () => ({ status: 'not_configured' }),
        getAccessTradeCredential: async () => null,
      },
    });
    assert.equal(result.partial, true);
    assert.equal(result.components.core.status, 'unavailable');
    assert.equal(result.control.publishBlockedByRuntime, true);
    assert.equal(result.publishingStatus, 'BLOCKED');
    assert.ok(result.control.publishRuntimeReasons.includes('APP_HEALTH_CORE_UNAVAILABLE'));
  });

  await test('a future-dated Runtime Guardian snapshot is degraded rather than current', async () => {
    const result = await healthService.buildAutomationHealthResponse({
      now,
      dependencies: {
        getRuntime: async () => runtimeSnapshot(now + 5 * 60_000),
        getGeminiReadiness: async () => ({ status: 'not_configured' }),
        getAccessTradeCredential: async () => null,
      },
    });
    assert.equal(result.components.runtime.status, 'degraded');
    assert.equal(result.components.runtime.stale, true);
    assert.equal(result.components.runtime.reasonCode, 'RUNTIME_HEALTH_SNAPSHOT_FUTURE');
    assert.notEqual(result.worker.status, 'active');
  });

  await test('missing, stale, and incompatible projections are explicit and never treated as healthy', async () => {
    await adapter.writeCollection('automation-job-health-summary-v1', []);
    await adapter.writeCollection('automation-job-list-projections-v2', []);
    const missing = await healthSummary.getAutomationJobHealthView(now);
    assert.equal(missing.availability, 'DEGRADED');
    assert.ok(missing.reasonCodes.includes('JOB_HEALTH_SUMMARY_MISSING'));

    const staleJob = projectedJob(50, now, {
      status: 'RUNNING',
      completedAt: undefined,
      updatedAt: iso(now - 10 * 60_000),
      heartbeatAt: iso(now - 10 * 60_000),
      leaseExpiresAt: iso(now - 9 * 60_000),
    });
    await adapter.writeCollection('automation-jobs', [staleJob]);
    await store.rebuildAutomationJobReadModelsFromDurable([staleJob], now);
    await healthSummary.refreshAutomationJobHealthSummary(now);
    const stale = await healthSummary.getAutomationJobHealthView(now);
    assert.equal(stale.stale, true);
    assert.notEqual(stale.availability, 'AVAILABLE');

    await adapter.writeCollection('automation-job-health-summary-v1', []);
    await adapter.writeCollection('automation-job-list-projections-v2', [{
      ...projectedJob(1, now),
      projectionSchemaVersion: 999,
    }]);
    const invalid = await healthSummary.getAutomationJobHealthView(now);
    assert.notEqual(invalid.availability, 'AVAILABLE');
    assert.ok(invalid.reasonCodes.some(code => code.includes('INCOMPATIBLE')));

    const partialHealth = await healthService.buildAutomationHealthResponse({
      now,
      dependencies: {
        getGeminiReadiness: async () => ({ status: 'not_configured' }),
        getAccessTradeCredential: async () => null,
      },
    });
    assert.equal(partialHealth.publishingStatus, 'BLOCKED');
    assert.equal(partialHealth.healthEvidence.publishingBlocked, true);
    assert.ok(partialHealth.healthEvidence.reasonCodes.includes('JOB_READ_MODEL_INCOMPLETE'));
  });

  await test('the UI refresh reducer preserves the previous snapshot after failure', () => {
    const snapshot = { generatedAt: iso(now), readiness: 'active' };
    const loaded = refreshState.appHealthRefreshSucceeded(
      refreshState.initialAppHealthRefreshState(),
      snapshot,
      { receivedAt: iso(now), stale: false },
    );
    const failedRefresh = refreshState.appHealthRefreshFailed(loaded, 'REQUEST_TIMEOUT');
    assert.equal(failedRefresh.snapshot, snapshot);
    assert.equal(failedRefresh.stale, true);
    assert.equal(failedRefresh.message, 'REQUEST_TIMEOUT');
  });

  await test('App Health error mapping never exposes unknown exception text', () => {
    const secretText = 'C:\\private\\health.json api_key=should-not-render';
    const unknown = refreshState.appHealthRequestFailureMessage(new Error(secretText));
    const timeout = refreshState.appHealthRequestFailureMessage({
      code: 'REQUEST_TIMEOUT',
      message: secretText,
    });
    const serverFailure = refreshState.appHealthRequestFailureMessage({
      code: 'HTTP_ERROR',
      status: 503,
      details: { message: secretText },
    });
    assert.equal(
      unknown,
      'Không thể làm mới sức khỏe. Bản chụp hợp lệ gần nhất được giữ lại.',
    );
    assert.equal(
      timeout,
      'Yêu cầu làm mới đã hết thời gian chờ. Bản chụp hợp lệ gần nhất được giữ lại.',
    );
    assert.equal(
      serverFailure,
      'Máy chủ chưa thể hoàn tất lần làm mới. Bản chụp hợp lệ gần nhất được giữ lại.',
    );
    assert.equal([unknown, timeout, serverFailure].join(' ').includes(secretText), false);
  });

  await test('incomplete job evidence never auto-resolves job-derived operational alerts', async () => {
    const pendingJobs = Array.from({ length: 25 }, (_, index) => ({
      ...projectedJob(index, now, {
        id: `alert-pending-${index}`,
        projectionSchemaVersion: healthSummary.AUTOMATION_JOB_STATUS_PROJECTION_SCHEMA_VERSION,
        schemaVersion: 1,
        status: 'PENDING',
        completedAt: undefined,
        claimedAt: undefined,
        startedAt: undefined,
      }),
      payload: {},
    }));
    await adapter.writeCollection('product-alerts', []);
    await adapter.writeCollection('automation-job-projections', pendingJobs);
    await alerts.evaluateAlerts('alert-evidence-complete', now);
    const created = (await alerts.listAlerts({ limit: 500 }))
      .find(item => item.deduplicationKey === 'automation:queue-backlog');
    assert.ok(created);
    assert.notEqual(created.status, 'resolved');

    await adapter.writeCollection('automation-job-projections', [{ id: 'invalid-projection' }]);
    const incomplete = await alerts.evaluateAlerts('alert-evidence-incomplete', now + 1_000);
    const preserved = (await alerts.listAlerts({ limit: 500 }))
      .find(item => item.deduplicationKey === 'automation:queue-backlog');
    assert.notEqual(incomplete.jobEvidence.status, 'COMPLETE');
    assert.ok(incomplete.resolutionDeferred >= 1);
    assert.ok(preserved);
    assert.notEqual(preserved.status, 'resolved');
  });

  await test('per-reason recovery clears pickup after three passes while preserving policy and bounded unrelated metrics', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    await adapter.writeCollection('automation-audit', []);
    await adapter.writeCollection('publication-audit', []);
    await adapter.writeCollection('automation-outbound-events', []);
    await adapter.writeCollection('products', Array.from({ length: 5_000 }, (_, index) => ({
      id: `bounded-product-${index}`,
      status: 'draft',
      updatedAt: iso(now - index),
    })));
    let jobs = Array.from({ length: 2 }, (_, index) => projectedJob(index, now, {
      type: 'AUTO_PILOT',
      requestedBy: 'scheduler',
      releaseId: 'a'.repeat(40),
      rolloutCohort: 'SLO_RUNNABLE_AT_V2:ACTIVE',
      runnableReason: 'SCHEDULED_AT',
    }));
    await adapter.writeCollection('automation-jobs', jobs);
    await adapter.writeCollection('automation-job-attempts', []);
    await store.rebuildAutomationJobReadModelsFromDurable(jobs, now);
    await store.updateAutomationControl({
      mode: 'AUTONOMOUS',
      effectiveMode: 'AUTONOMOUS',
      publishPausedByOperator: false,
      publishBlockedByRuntime: true,
      publishRuntimeReasons: ['JOB_PICKUP_LATENCY_SLO_FAILED'],
      publishBlockedByPolicy: true,
      publishPolicyReasons: ['POLICY_FIXTURE_BLOCK'],
      killSwitch: false,
      workerPaused: false,
      schedulerPaused: false,
    }, 'automation-health-reliability-test');

    let applied;
    for (let index = 0; index < 3; index += 1) {
      const evaluatedAt = now + index * 30_000;
      jobs = [
        ...jobs,
        projectedJob(100 + index, evaluatedAt, {
          type: 'AUTO_PILOT',
          requestedBy: 'scheduler',
          releaseId: 'a'.repeat(40),
          rolloutCohort: 'SLO_RUNNABLE_AT_V2:ACTIVE',
          runnableReason: 'SCHEDULED_AT',
        }),
      ];
      await adapter.writeCollection('automation-jobs', jobs);
      await store.rebuildAutomationJobReadModelsFromDurable(jobs, evaluatedAt);
      await adapter.writeCollection('runtime-health', [runtimeSnapshot(evaluatedAt)]);
      applied = await slo.applyAutomationErrorBudget({
        now: evaluatedAt,
        minimumSamples: 1,
        actor: 'automation-health-reliability-test',
      });
    }
    const pickup = applied.measurement.metrics.find(metric => metric.key === 'job_pickup_latency_p95_ms');
    const postPublish = applied.measurement.metrics.find(metric => metric.key === 'post_publish_health_pass_rate');
    assert.equal(pickup.evaluationStatus, 'PASS');
    assert.equal(postPublish.evaluationStatus, 'INSUFFICIENT_DATA');
    assert.equal(postPublish.stateReason, 'PRODUCT_CURRENT_STATE_BOUNDED');
    assert.equal(
      applied.control.publishBlockedByRuntime,
      false,
      JSON.stringify({
        runtimeReasons: applied.control.publishRuntimeReasons,
        recovery: applied.recovery,
        evaluation: applied.evaluation,
        pickup,
      }),
    );
    assert.equal(applied.control.publishBlockedByPolicy, true);
    assert.deepEqual(applied.control.publishPolicyReasons, ['POLICY_FIXTURE_BLOCK']);
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
  });

  await test('insufficient or breached evidence interrupts and resets a reason streak', async () => {
    await adapter.writeCollection('runtime-recovery-state', []);
    const base = {
      activeReasons: ['JOB_PICKUP_LATENCY_SLO_FAILED'],
      evidenceSummary: {
        measurementState: 'INSUFFICIENT_DATA',
        evaluationStatus: 'INSUFFICIENT_DATA',
        maximumEvidenceAgeMs: 120_000,
        reasonCodes: [],
        terminalJobSamples: 0,
        publicationAttempts: 0,
        monitorOutcomes: 0,
        publicProducts: 0,
      },
      featureMode: 'ACTIVE',
      requiredReleaseIdentity: 'a'.repeat(40),
    };
    const observation = (measurement, observedAt) => ({
      reasonCode: 'JOB_PICKUP_LATENCY_SLO_FAILED',
      metricKey: 'job_pickup_latency_p95_ms',
      measurement,
      qualifyingStatus: measurement === 'PASS'
        ? 'PASS'
        : measurement === 'BREACH' ? 'BREACH' : 'INSUFFICIENT_DATA',
      observedAt: iso(observedAt),
      releaseIdentity: 'a'.repeat(40),
      qualificationReasons: measurement === 'PASS' ? [] : ['FIXTURE_NON_QUALIFYING_EVIDENCE'],
      evidenceReferences: [`runtime-health:${observedAt}`, `queue-summary:${observedAt}`],
    });
    const first = await recoveryState.advanceRuntimeReasonRecoveryState({
      ...base,
      evaluationId: 'reason-pass-1',
      observations: [observation('PASS', now)],
      nowMs: now,
    });
    const insufficient = await recoveryState.advanceRuntimeReasonRecoveryState({
      ...base,
      evaluationId: 'reason-insufficient',
      observations: [observation('INSUFFICIENT_DATA', now + 61_000)],
      nowMs: now + 61_000,
    });
    assert.equal(first.state.reasonProgress[0].consecutiveHealthyCount, 1);
    assert.equal(insufficient.state.reasonProgress[0].consecutiveHealthyCount, 0);
    const breached = await recoveryState.advanceRuntimeReasonRecoveryState({
      ...base,
      evaluationId: 'reason-breach',
      observations: [observation('BREACH', now + 122_000)],
      nowMs: now + 122_000,
    });
    assert.equal(breached.state.reasonProgress[0].consecutiveHealthyCount, 0);
  });

  const routeSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/automation/health/route.ts'), 'utf8');
  const guardianSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/automation/runtimeGuardian.ts'), 'utf8');
  const productFlowSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/automation/productFlowDiagnostics.ts'), 'utf8');
  await test('latency-sensitive App Health and Runtime Guardian source paths forbid full history reads', () => {
    assert.equal(routeSource.includes('getAllAutomationJobs'), false);
    assert.equal(guardianSource.includes('getAllAutomationJobs'), false);
    assert.equal(productFlowSource.includes('getAllAutomationJobs'), false);
    assert.equal(productFlowSource.includes('getAllProducts'), false);
    assert.equal(productFlowSource.includes('listCandidateQueue'), false);
    assert.ok(productFlowSource.includes('readBoundedCollectionSnapshot'));
    assert.ok(productFlowSource.includes('readBoundedAutomationJobStatuses'));
  });

  await test('App Health route keeps stable codes separate from valid Vietnamese messages', () => {
    const doubleEncodedMarkers = [
      String.fromCodePoint(0x4d, 0xe1, 0xbb),
      String.fromCodePoint(0xc4, 0x90),
    ];
    assert.ok(routeSource.includes("'APP_HEALTH_UNAVAILABLE'"));
    assert.ok(routeSource.includes("'APP_HEALTH_UNEXPECTED_FAILURE'"));
    assert.ok(routeSource.includes('Không thể xác minh sức khỏe hệ thống lúc này.'));
    assert.ok(routeSource.includes("headers: { 'Cache-Control': 'no-store' }"));
    for (const marker of doubleEncodedMarkers) assert.equal(routeSource.includes(marker), false);
  });

  console.log(`\nAutomation health reliability: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
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
