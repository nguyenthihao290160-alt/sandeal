/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.resolve(
  process.cwd(),
  '.test-tmp',
  `post-m3-reconciliation-product-flow-${process.pid}-${Date.now()}`,
);
const allowedRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(testRoot) !== allowedRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.RUNTIME_RECOVERY_V2 = 'ACTIVE';
const releaseId = '3'.repeat(40);
process.env.SANDEAL_BUILD_MANIFEST_COMMIT = releaseId;
process.env.SANDEAL_BUILD_COMMIT = releaseId;
process.env.SANDEAL_RELEASE_ID = releaseId;
process.env.GIT_COMMIT_SHA = releaseId;
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = releaseId;
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

function lease(now, overrides = {}) {
  return {
    schemaVersion: 3,
    id: 'WORKER',
    role: 'WORKER',
    ownerId: 'worker-owner',
    instanceId: 'worker-instance',
    holderId: 'worker-owner',
    pid: 4101,
    releaseId,
    status: 'ACTIVE',
    processStartedAt: iso(now - 60_000),
    acquiredAt: iso(now - 60_000),
    startedAt: iso(now - 60_000),
    heartbeatAt: iso(now - 1_000),
    expiresAt: iso(now + 45_000),
    leaseExpiresAt: iso(now + 45_000),
    fencingToken: 7,
    takeoverCount: 0,
    updatedAt: iso(now - 1_000),
    ...overrides,
  };
}

function runtime(now, overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'runtime-health:post-m3-fixture',
    ruleVersion: 'runtime-guardian-v2',
    web: {
      status: 'ready',
      buildAvailable: true,
      publicRouteHealthy: true,
      buildId: releaseId,
      releaseId,
      releaseMatchesBuild: true,
    },
    worker: {
      status: 'active',
      holderId: 'worker-owner',
      instanceId: 'worker-instance',
      pid: 4101,
      fencingToken: 7,
      heartbeatAt: iso(now - 1_000),
      releaseId,
    },
    scheduler: {
      status: 'active',
      holderId: 'scheduler-owner',
      instanceId: 'scheduler-instance',
      pid: 4102,
      fencingToken: 9,
      heartbeatAt: iso(now - 1_000),
      releaseId,
    },
    providers: {},
    queue: { pending: 0, running: 0, stuck: 0, staleJobs: 0 },
    storage: { status: 'healthy', staleLocks: 0, freeBytes: 1_000_000 },
    duplicateRoles: [],
    publishSafe: true,
    reasons: [],
    historicalReasons: [],
    recommendation: { pausePublish: false, pauseIngestion: false },
    checkedAt: iso(now - 1_000),
    ...overrides,
  };
}

function reconcileInput(now, overrides = {}) {
  return {
    now,
    releaseId,
    candidateCurrentReasons: ['WORKER_HEARTBEAT_STALE', 'UNRELATED_RUNTIME_REASON'],
    historicalReasons: ['OLDER_INCIDENT'],
    runtime: runtime(now),
    leases: [lease(now)],
    conflicts: [],
    workerRequired: true,
    schedulerRequired: false,
    ...overrides,
  };
}

function automationJob(now, index, overrides = {}) {
  const createdAt = iso(now - 10_000 + index);
  return {
    schemaVersion: 2,
    policyVersion: 'fixture-policy',
    handlerVersion: 'fixture-handler',
    id: `post-m3-job-${index}`,
    type: 'PROCESS_CANDIDATE',
    status: 'SUCCEEDED',
    payload: { candidateId: `candidate-${index}`, productId: `product-${index}` },
    result: { candidateStatus: 'completed' },
    priority: 50,
    idempotencyKey: `post-m3-key-${index}`,
    operationId: `post-m3-operation-${index}`,
    requestedBy: 'post-m3-test',
    releaseId,
    rolloutCohort: 'SLO_RUNNABLE_AT_V2:SHADOW',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'SCHEDULED_AT',
    claimedAt: iso(now - 9_000 + index),
    startedAt: iso(now - 9_000 + index),
    completedAt: iso(now - 8_000 + index),
    createdAt,
    updatedAt: iso(now - 8_000 + index),
    ...overrides,
  };
}

function jobRead(now, items = [], overrides = {}) {
  return {
    items,
    availability: 'AVAILABLE',
    reasonCodes: [],
    evidenceClassification: 'COMPLETE',
    source: 'job-status-projection-v1',
    collectionPresent: true,
    currentStateComplete: true,
    historyComplete: true,
    truncated: false,
    observedRange: {
      earliestCreatedAt: items[0]?.createdAt || null,
      latestCreatedAt: items.at(-1)?.createdAt || null,
      earliestUpdatedAt: items[0]?.updatedAt || null,
      latestUpdatedAt: items.at(-1)?.updatedAt || null,
    },
    retentionBoundary: null,
    manifestRebuiltAt: iso(now),
    manifestReleaseId: releaseId,
    manifestUpdatedAt: iso(now),
    projectionVersion: 'automation-job-projection-v3',
    sourceRevision: 'a'.repeat(64),
    summaryRevision: 'b'.repeat(64),
    projectionFingerprint: 'c'.repeat(64),
    generatedAt: iso(now),
    recordCounts: {
      durable: items.length,
      active: items.filter(item => ['PENDING', 'RUNNING', 'RETRY_SCHEDULED'].includes(item.status)).length,
      retained: items.length,
      retainedTerminal: items.length,
      list: items.length,
      status: items.length,
    },
    completeness: {
      baselineEstablished: true,
      currentStateComplete: true,
      historyComplete: true,
      truncated: false,
    },
    coverageComplete: true,
    ...overrides,
  };
}

function candidate(now, index, overrides = {}) {
  return {
    schemaVersion: 2,
    id: `candidate-${index}`,
    source: 'accesstrade',
    sourceId: `source-${index}`,
    status: 'completed',
    priority: 50,
    attempts: 1,
    createdAt: iso(now - 10_000),
    updatedAt: iso(now - 5_000),
    contentHash: `content-${index}`,
    sourceHash: `source-hash-${index}`,
    payload: {
      title: `Candidate ${index}`,
      kind: 'product',
      platform: 'accesstrade',
      originalUrl: `https://merchant.example/product-${index}`,
      affiliateUrl: `https://go.example/product-${index}`,
      imageUrl: `https://img.example/product-${index}.jpg`,
      price: 100_000,
      currency: 'VND',
      verifiedSource: true,
      autoPublishEligible: true,
    },
    ...overrides,
  };
}

function eligibility(now, overrides = {}) {
  return {
    eligibleForReview: true,
    eligibleForCanary: true,
    eligibleForPublish: true,
    eligibleForPublic: true,
    qualityScore: 90,
    criticalBlockers: [],
    warningBlockers: [],
    nextRequiredAction: 'READY',
    evaluatedAt: iso(now - 2_000),
    policyVersion: 'product-eligibility-v2',
    reviewQuality: {
      qualityScore: 90,
      trustScore: 90,
      freshnessScore: 90,
      completenessScore: 90,
      usefulnessScore: 90,
      sourceCoverageScore: 90,
      balancedReviewScore: 90,
      criticalIssues: [],
      warnings: [],
      nextRequiredAction: 'READY',
      evaluatedAt: iso(now - 2_000),
      reviewPolicyVersion: 'review-policy-v1',
    },
    ...overrides,
  };
}

function completeProduct(now, index, overrides = {}) {
  return {
    schemaVersion: 2,
    id: `product-${index}`,
    title: `Sản phẩm ${index}`,
    slug: `san-pham-${index}`,
    description: 'Mô tả sản phẩm đã được xác minh.',
    kind: 'product',
    platform: 'accesstrade',
    source: 'accesstrade',
    recordType: 'PRODUCT',
    status: 'draft',
    lifecycleState: 'READY_FOR_PUBLISH',
    originalUrl: `https://merchant.example/product-${index}`,
    canonicalProductUrl: `https://merchant.example/product-${index}`,
    canonicalUrlStatus: 'verified',
    affiliateUrl: `https://go.example/product-${index}`,
    affiliateUrlStatus: 'verified',
    imageUrl: `https://img.example/product-${index}.jpg`,
    price: 100_000,
    currency: 'VND',
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: true,
    publicHidden: false,
    publicBlocked: false,
    linkHealthStatus: 'ok',
    productHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    priceVerificationStatus: 'VERIFIED',
    reviewContent: {
      reviewStatus: 'approved',
      contentQualityScore: 90,
      originalityScore: 90,
      seoReadinessScore: 90,
      reviewBlockReasons: [],
    },
    eligibility: eligibility(now),
    evidenceSnapshotHash: `evidence-${index}`,
    createdAt: iso(now - 60_000),
    updatedAt: iso(now - 2_000),
    ...overrides,
  };
}

function control(now, overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'automation-control',
    mode: 'OBSERVE',
    effectiveMode: 'OBSERVE',
    publishPaused: false,
    publishPausedByOperator: false,
    publishBlockedByRuntime: false,
    publishBlockedByPolicy: false,
    publishRuntimeReasons: [],
    publishPolicyReasons: [],
    ingestionPaused: false,
    workerPaused: false,
    schedulerPaused: false,
    killSwitch: false,
    timezone: 'Asia/Ho_Chi_Minh',
    updatedAt: iso(now),
    ...overrides,
  };
}

function flowInput(now, overrides = {}) {
  return {
    products: { items: [], complete: true, collectionPresent: true, reasonCodes: [] },
    candidates: { items: [], complete: true, collectionPresent: true, reasonCodes: [] },
    jobs: jobRead(now),
    sourceHealth: { status: 'ready', configured: true, ready: true, checkedAt: iso(now) },
    aiReadiness: {
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
    },
    control: control(now),
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const currentReasons = require('../src/lib/automation/currentReasonReconciler.ts');
  const healthSummary = require('../src/lib/automation/jobHealthSummary.ts');
  const store = require('../src/lib/automation/store.ts');
  const rollout = require('../src/lib/automation/featureRollout.ts');
  const flow = require('../src/lib/automation/productFlowDiagnostics.ts');
  const rechecks = require('../src/lib/automation/safeProductRechecks.ts');
  const productJobs = require('../src/lib/product-intelligence/jobs.ts');
  const slo = require('../src/lib/automation/sloErrorBudget.ts');
  const maintenance = require('../src/lib/automation/projectionMaintenance.ts');
  const now = Date.parse('2026-07-30T04:00:00.000Z');

  await test('stale Worker heartbeat remains active', () => {
    const result = currentReasons.reconcileCurrentReasons(reconcileInput(now, {
      leases: [lease(now, { heartbeatAt: iso(now - 120_000) })],
    }));
    assert.ok(result.currentActiveReasons.includes('WORKER_HEARTBEAT_STALE'));
    assert.equal(result.roleEvidence.worker.valid, false);
  });

  await test('fresh Worker evidence clears only the obsolete heartbeat reason', () => {
    const result = currentReasons.reconcileCurrentReasons(reconcileInput(now));
    assert.ok(!result.currentActiveReasons.includes('WORKER_HEARTBEAT_STALE'));
    assert.ok(result.currentActiveReasons.includes('UNRELATED_RUNTIME_REASON'));
    assert.ok(result.historicalAuditReasons.includes('WORKER_HEARTBEAT_STALE'));
    assert.equal(
      result.transitions.find(item => item.reasonCode === 'WORKER_HEARTBEAT_STALE').transitionType,
      'CLEARED_BY_CURRENT_EVIDENCE',
    );
  });

  await test('fresh Scheduler evidence clears only the obsolete heartbeat reason', () => {
    const schedulerLease = lease(now, {
      id: 'SCHEDULER',
      role: 'SCHEDULER',
      ownerId: 'scheduler-owner',
      instanceId: 'scheduler-instance',
      holderId: 'scheduler-owner',
      pid: 4102,
      fencingToken: 9,
    });
    const result = currentReasons.reconcileCurrentReasons(reconcileInput(now, {
      candidateCurrentReasons: ['SCHEDULER_HEARTBEAT_STALE', 'UNRELATED_RUNTIME_REASON'],
      historicalReasons: ['SCHEDULER_HEARTBEAT_STALE'],
      leases: [schedulerLease],
      workerRequired: false,
      schedulerRequired: true,
    }));
    assert.ok(!result.currentActiveReasons.includes('SCHEDULER_HEARTBEAT_STALE'));
    assert.ok(result.currentActiveReasons.includes('UNRELATED_RUNTIME_REASON'));
    assert.ok(result.historicalAuditReasons.includes('SCHEDULER_HEARTBEAT_STALE'));
  });

  await test('release mismatch cannot clear a heartbeat reason', () => {
    const result = currentReasons.reconcileCurrentReasons(reconcileInput(now, {
      leases: [lease(now, { releaseId: '4'.repeat(40) })],
    }));
    assert.ok(result.currentActiveReasons.includes('WORKER_HEARTBEAT_STALE'));
    assert.ok(result.roleEvidence.worker.reasonCodes.includes('WORKER_LEASE_RELEASE_MISMATCH'));
  });

  await test('PID mismatch cannot clear a heartbeat reason', () => {
    const result = currentReasons.reconcileCurrentReasons(reconcileInput(now, {
      runtime: runtime(now, { worker: { ...runtime(now).worker, pid: 9999 } }),
    }));
    assert.ok(result.currentActiveReasons.includes('WORKER_HEARTBEAT_STALE'));
    assert.ok(result.roleEvidence.worker.reasonCodes.includes('WORKER_PID_OWNERSHIP_MISMATCH'));
  });

  await test('duplicate role evidence cannot clear a heartbeat reason', () => {
    const result = currentReasons.reconcileCurrentReasons(reconcileInput(now, {
      conflicts: [{
        schemaVersion: 1,
        id: 'worker-conflict',
        role: 'WORKER',
        activeHolderId: 'worker-owner',
        rejectedHolderId: 'other-owner',
        activeInstanceId: 'worker-instance',
        rejectedInstanceId: 'other-instance',
        observedAt: iso(now - 500),
      }],
    }));
    assert.ok(result.currentActiveReasons.includes('WORKER_HEARTBEAT_STALE'));
    assert.ok(result.roleEvidence.worker.reasonCodes.includes('WORKER_DUPLICATE_ROLE_CONFLICT'));
  });

  await test('historical audit remains visible after a current reason clears', () => {
    const result = currentReasons.reconcileCurrentReasons(reconcileInput(now, {
      candidateCurrentReasons: [],
      historicalReasons: ['WORKER_HEARTBEAT_STALE', 'OLDER_INCIDENT'],
    }));
    assert.deepEqual(result.currentActiveReasons, []);
    assert.deepEqual(result.historicalAuditReasons, ['OLDER_INCIDENT', 'WORKER_HEARTBEAT_STALE']);
  });

  const durable = [automationJob(now, 1), automationJob(now, 2)];
  await adapter.writeCollection('automation-jobs', durable);
  const manifest = await store.rebuildAutomationJobReadModelsFromDurable(durable, now);

  await test('valid Job Health manifest passes strict validation', () => {
    const validation = healthSummary.validateAutomationJobProjectionManifest(manifest);
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.reasonCodes, []);
  });

  await test('missing Job Health manifest is invalid', () => {
    const validation = healthSummary.validateAutomationJobProjectionManifest(undefined);
    assert.equal(validation.valid, false);
    assert.ok(validation.reasonCodes.includes('JOB_PROJECTION_MANIFEST_INVALID'));
  });

  await test('mismatched manifest schema is explicit', () => {
    const validation = healthSummary.validateAutomationJobProjectionManifest({
      ...manifest,
      schemaVersion: 99,
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.reasonCodes.includes('JOB_PROJECTION_MANIFEST_SCHEMA_MISMATCH'));
  });

  await test('mismatched manifest source revision is explicit', () => {
    const validation = healthSummary.validateAutomationJobProjectionManifest({
      ...manifest,
      sourceRevision: 'f'.repeat(64),
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.reasonCodes.includes('JOB_PROJECTION_MANIFEST_SOURCE_REVISION_MISMATCH'));
  });

  await test('mismatched manifest fingerprint is explicit', () => {
    const validation = healthSummary.validateAutomationJobProjectionManifest({
      ...manifest,
      projectionFingerprint: 'e'.repeat(64),
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.reasonCodes.includes('JOB_PROJECTION_MANIFEST_FINGERPRINT_MISMATCH'));
  });

  await test('one projection rebuild request is reused on refresh', async () => {
    const invalidView = {
      projectionStatus: 'INVALID',
      projectionVersion: 'automation-job-projection-v3',
      sourceRevision: manifest.sourceRevision,
      projectionFingerprint: manifest.projectionFingerprint,
      reasonCodes: ['JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH'],
    };
    const first = await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, now + 10_000);
    const second = await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, now + 11_000);
    assert.equal((await adapter.readCollection('automation-jobs')).filter(job =>
      job.payload?.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD').length, 0);
    await maintenance.materializeJobHealthProjectionMaintenanceRequest(now + 12_000);
    const jobs = await adapter.readCollection('automation-jobs');
    const rebuildJobs = jobs.filter(job =>
      job.type === 'RECONCILE_AUTOMATION'
      && job.payload.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD');
    assert.equal(first.status, 'REQUESTED');
    assert.equal(second.status, 'REUSED_ACTIVE_REQUEST');
    assert.equal(first.repairId, second.repairId);
    assert.equal(rebuildJobs.length, 1);
    assert.ok(second.duplicateRequestsSuppressed >= 1);
  });

  await test('explicit pickup ignores old createdAt and uses current runnableAt', () => {
    const observed = slo.deriveExplicitPickupLatencyObservation({
      createdAt: iso(now - 10 * 86_400_000),
      runnableAt: iso(now - 5_000),
      runnableReason: 'SCHEDULED_AT',
      claimedAt: iso(now - 2_000),
    }, now - 86_400_000, now);
    assert.equal(observed.latencyMs, 3_000);
    assert.equal(observed.runnableReason, 'SCHEDULED_AT');
  });

  await test('delayed eligibility pickup starts at the eligibility boundary', () => {
    const observed = slo.deriveExplicitPickupLatencyObservation({
      createdAt: iso(now - 60_000),
      runnableAt: iso(now - 4_000),
      runnableReason: 'RETRY_ELIGIBLE_AT',
      claimedAt: iso(now - 1_000),
    }, now - 86_400_000, now);
    assert.equal(observed.latencyMs, 3_000);
    assert.equal(observed.retryAttempt, true);
  });

  await test('missing explicit runnable timestamp is insufficient, not zero', () => {
    const observed = slo.deriveExplicitPickupLatencyObservation({
      createdAt: iso(now - 5_000),
      claimedAt: iso(now - 1_000),
    }, now - 86_400_000, now);
    assert.equal(observed, null);
  });

  await test('Worker Pool OFF is distinct from calculated capacity', () => {
    const state = rollout.getWorkerPoolRolloutState({});
    assert.equal(state.configuredMode, 'OFF');
    assert.equal(state.effectiveMode, 'OFF');
    assert.equal(state.implementationActive, false);
    assert.equal(state.disabledReason, 'WORKER_POOL_ROLLOUT_OFF');
  });

  await test('Worker Pool SHADOW remains observation-only', () => {
    const state = rollout.getWorkerPoolRolloutState({ WORKER_CONTINUOUS_POOL_V2: 'SHADOW' });
    assert.equal(state.effectiveMode, 'SHADOW');
    assert.equal(state.implementationActive, false);
    assert.equal(state.disabledReason, 'WORKER_POOL_OBSERVATION_ONLY');
  });

  await test('Worker Pool ACTIVE test configuration reports implementation active', () => {
    const state = rollout.getWorkerPoolRolloutState({ WORKER_CONTINUOUS_POOL_V2: 'ACTIVE' });
    assert.equal(state.configuredMode, 'ACTIVE');
    assert.equal(state.effectiveMode, 'ACTIVE');
    assert.equal(state.implementationActive, true);
    assert.equal(state.activationControl, 'WORKER_CONTINUOUS_POOL_V2=ACTIVE');
  });

  await test('invalid Worker Pool configuration fails to safe default', () => {
    const state = rollout.getWorkerPoolRolloutState({ WORKER_CONTINUOUS_POOL_V2: 'enabled' });
    assert.equal(state.valid, false);
    assert.equal(state.effectiveMode, 'OFF');
    assert.equal(state.disabledReason, 'WORKER_POOL_INVALID_CONFIGURATION');
  });

  await test('product flow distinguishes unknown from authoritative zero', () => {
    const unknown = flow.deriveProductFlowDiagnostics(flowInput(now, {
      products: { items: [], complete: false, collectionPresent: false, reasonCodes: ['PRODUCT_STATE_UNAVAILABLE'] },
    }), now);
    const zero = flow.deriveProductFlowDiagnostics(flowInput(now), now);
    assert.equal(unknown.currentState.totalCanonicalProducts, null);
    assert.equal(unknown.emptyHomepage.classification, 'UNKNOWN_INCOMPLETE_DATA');
    assert.equal(zero.currentState.totalCanonicalProducts, 0);
    assert.equal(zero.emptyHomepage.classification, 'NO_SOURCE_INGESTION');
  });

  const sourceJob = automationJob(now, 20, { type: 'PRODUCT_SCAN', status: 'SUCCEEDED' });

  const classifications = [
    {
      name: 'source not ready',
      expected: 'SOURCE_NOT_READY',
      input: flowInput(now, {
        sourceHealth: {
          status: 'configured',
          configured: true,
          ready: false,
          reason: 'live_probe_not_run',
        },
      }),
    },
    {
      name: 'no candidates after source ingestion',
      expected: 'NO_CANDIDATES',
      input: flowInput(now, { jobs: jobRead(now, [sourceJob]) }),
    },
    {
      name: 'candidates waiting',
      expected: 'CANDIDATES_WAITING',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        candidates: {
          items: [candidate(now, 1, { status: 'pending' })],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
    {
      name: 'candidate processing failed',
      expected: 'CANDIDATE_PROCESSING_FAILED',
      input: flowInput(now, {
        jobs: jobRead(now, [
          sourceJob,
          automationJob(now, 21, { type: 'PROCESS_CANDIDATE', status: 'FAILED' }),
        ]),
        candidates: {
          items: [candidate(now, 2, { status: 'failed' })],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
    {
      name: 'products missing evidence',
      expected: 'PRODUCTS_MISSING_EVIDENCE',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        products: {
          items: [{ ...completeProduct(now, 3), imageUrl: '' }],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
    {
      name: 'products quarantined',
      expected: 'PRODUCTS_QUARANTINED',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        products: {
          items: [completeProduct(now, 4, {
            lifecycleState: 'QUARANTINED',
            quarantineReasons: ['duplicate_identity_unresolved'],
            eligibility: eligibility(now, { eligibleForPublish: false, eligibleForPublic: false }),
          })],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
    {
      name: 'products require recheck',
      expected: 'PRODUCTS_REQUIRE_RECHECK',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        products: {
          items: [completeProduct(now, 5, {
            nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH',
            eligibility: eligibility(now, { eligibleForPublish: false, eligibleForPublic: false }),
          })],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
    {
      name: 'eligible products blocked only by runtime',
      expected: 'PRODUCTS_ELIGIBLE_RUNTIME_BLOCKED',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        products: {
          items: [completeProduct(now, 6)],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
        control: control(now, {
          publishPaused: true,
          publishBlockedByRuntime: true,
          publishRuntimeReasons: ['RUNTIME_GUARDIAN_UNSAFE'],
        }),
      }),
    },
    {
      name: 'eligible product evidence blocked by policy',
      expected: 'PRODUCTS_ELIGIBLE_POLICY_BLOCKED',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        products: {
          items: [completeProduct(now, 7, {
            currentBlockers: [{
              code: 'MERCHANT_POLICY_BLOCK',
              category: 'POLICY',
              target: 'merchant',
              scope: 'PUBLICATION',
              severity: 'BLOCKER',
              source: 'fixture',
              message: 'fixture',
              checkedAt: iso(now),
            }],
            eligibility: eligibility(now, { eligibleForPublish: false, eligibleForPublic: false }),
          })],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
    {
      name: 'no product meets public eligibility',
      expected: 'NO_PRODUCT_MEETS_PUBLIC_ELIGIBILITY',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        products: {
          items: [completeProduct(now, 8, {
            autoPublishEligible: false,
            eligibility: eligibility(now, {
              eligibleForCanary: false,
              eligibleForPublish: false,
              eligibleForPublic: false,
              criticalBlockers: ['auto_publish_ineligible'],
            }),
          })],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
    {
      name: 'public projection mismatch',
      expected: 'PUBLIC_PROJECTION_MISMATCH',
      input: flowInput(now, {
        jobs: jobRead(now, [sourceJob]),
        products: {
          items: [completeProduct(now, 9, {
            status: 'published',
            lifecycleState: 'PUBLISHED',
            publicDecision: 'blocked',
          })],
          complete: true,
          collectionPresent: true,
          reasonCodes: [],
        },
      }),
    },
  ];

  for (const item of classifications) {
    await test(`product flow classifies ${item.name}`, () => {
      const diagnostic = flow.deriveProductFlowDiagnostics(item.input, now);
      assert.equal(diagnostic.emptyHomepage.classification, item.expected);
      assert.ok(diagnostic.emptyHomepage.labelVi.length > 5);
      assert.ok(Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') < 64 * 1_024);
    });
  }

  await test('AccessTrade configured without a probe exposes a safe reason code', () => {
    const diagnostic = flow.deriveProductFlowDiagnostics(classifications[0].input, now);
    assert.equal(diagnostic.accessTradeReadinessReason, 'ACCESS_TRADE_LIVE_PROBE_NOT_RUN');
    assert.equal(JSON.stringify(diagnostic).includes('token'), false);
  });

  await test('recheck classification respects backoff and stable evidence identity', () => {
    const product = completeProduct(now, 30, {
      nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH',
      nextRetryAt: iso(now + 60_000),
    });
    const first = rechecks.classifyProductRecheck(product, now);
    const second = rechecks.classifyProductRecheck(product, now + 1_000);
    assert.equal(first.disposition, 'NOT_DUE');
    assert.equal(first.idempotencyKey, second.idempotencyKey);
  });

  await test('permanent and manual recheck outcomes do not loop', () => {
    const permanent = rechecks.classifyProductRecheck(completeProduct(now, 31, {
      lifecycleState: 'CONFIRMED_BROKEN',
      nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH',
    }), now);
    const manual = rechecks.classifyProductRecheck(completeProduct(now, 32, {
      status: 'needs_review',
      nextAutomaticAction: 'MANUAL_REVIEW',
    }), now);
    assert.equal(permanent.disposition, 'PERMANENT');
    assert.equal(manual.disposition, 'MANUAL_INPUT_REQUIRED');
  });

  await test('retryable rechecks are deduplicated and bounded', async () => {
    let calls = 0;
    const products = Array.from({ length: 75 }, (_, index) => completeProduct(now, 100 + index, {
      nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH',
      nextRetryAt: iso(now - 1_000),
    }));
    const result = await rechecks.scheduleSafeProductRechecks(products, {
      now,
      limit: 10,
      createJob: async input => {
        calls += 1;
        return {
          created: false,
          code: 'IN_PROGRESS',
          job: { id: `existing-${calls}`, ...input },
        };
      },
    });
    assert.equal(calls, 10);
    assert.equal(result.enqueueAttempts, 10);
    assert.equal(result.created, 0);
    assert.equal(result.duplicateSuppressed, 10);
    assert.equal(result.createdJobIds.length, 0);
  });

  await test('first transient timeout retains a previously safe product only once', () => {
    const first = productJobs.shouldRetainPublicAfterTransientHealthCheck({
      wasPublicSafe: true,
      confirmedBroken: false,
      retryScheduled: true,
      priorFailureCount: 0,
      operationalBlockers: ['product_url_unhealthy', 'canonical_url_unverified', 'cooldown'],
    });
    const repeated = productJobs.shouldRetainPublicAfterTransientHealthCheck({
      wasPublicSafe: true,
      confirmedBroken: false,
      retryScheduled: true,
      priorFailureCount: 1,
      operationalBlockers: ['product_url_unhealthy'],
    });
    const policy = productJobs.shouldRetainPublicAfterTransientHealthCheck({
      wasPublicSafe: true,
      confirmedBroken: false,
      retryScheduled: true,
      priorFailureCount: 0,
      operationalBlockers: ['compliance_block'],
    });
    assert.equal(first, true);
    assert.equal(repeated, false);
    assert.equal(policy, false);
  });

  await test('product-flow diagnostic remains bounded on 1,000 products and 2,000 candidates', () => {
    const products = Array.from({ length: 1_000 }, (_, index) => completeProduct(now, 1_000 + index, {
      status: 'draft',
      lifecycleState: 'VERIFYING',
      autoPublishEligible: false,
      eligibility: eligibility(now, {
        eligibleForCanary: false,
        eligibleForPublish: false,
        eligibleForPublic: false,
        criticalBlockers: ['auto_publish_ineligible'],
      }),
    }));
    const candidates = Array.from({ length: 2_000 }, (_, index) =>
      candidate(now, 2_000 + index, { status: index % 2 ? 'completed' : 'pending' }));
    const started = performance.now();
    const diagnostic = flow.deriveProductFlowDiagnostics(flowInput(now, {
      products: { items: products, complete: true, collectionPresent: true, reasonCodes: [] },
      candidates: { items: candidates, complete: true, collectionPresent: true, reasonCodes: [] },
      jobs: jobRead(now, [sourceJob]),
    }), now);
    const durationMs = performance.now() - started;
    const responseBytes = Buffer.byteLength(JSON.stringify(diagnostic), 'utf8');
    assert.ok(durationMs < 3_000, `duration ${durationMs.toFixed(1)}ms`);
    assert.ok(responseBytes < 64 * 1_024, `response ${responseBytes} bytes`);
    assert.equal(diagnostic.currentState.totalCanonicalProducts, 1_000);
    assert.equal(diagnostic.currentState.totalActiveCandidates, 1_000);
    console.log(`METRIC product_flow_1000_2000 durationMs=${durationMs.toFixed(1)} responseBytes=${responseBytes}`);
  });

  console.log(`\nPost-M3 reconciliation/product-flow tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (path.dirname(testRoot) === allowedRoot) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });
