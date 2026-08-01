/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(
  process.cwd(),
  '.test-tmp',
  `m3-1-2-convergent-projection-repair-${process.pid}-${Date.now()}`,
);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '500';
process.env.SANDEAL_BUILD_COMMIT = 'c'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'c'.repeat(40);
process.env.GIT_COMMIT_SHA = 'c'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'c'.repeat(40);
require('./register-typescript.cjs');

function cleanupTestRoot() {
  const resolvedRoot = path.resolve(testRoot);
  const expectedParent = path.resolve(process.cwd(), '.test-tmp');
  if (
    path.dirname(resolvedRoot) !== expectedParent
    || !path.basename(resolvedRoot).startsWith('m3-1-2-convergent-projection-repair-')
  ) {
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

function automationJob(index, now, overrides = {}) {
  const createdAt = iso(now - 20_000 + index);
  return {
    schemaVersion: 2,
    policyVersion: 'test-policy',
    handlerVersion: 'test-handler',
    projectionSourceVersion: 1,
    id: `m312-job-${index}`,
    type: index === 1 ? 'PRODUCT_SCAN' : 'HEALTH_CHECK',
    status: 'SUCCEEDED',
    payload: {},
    result: { executionStatus: 'COMPLETED_WITH_LOCAL_RULES' },
    priority: 50,
    idempotencyKey: `m312-job-key-${index}`,
    operationId: `m312-operation-${index}`,
    requestedBy: 'm312-test',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'CREATED_AT',
    claimedAt: iso(now - 19_000 + index),
    startedAt: iso(now - 19_000 + index),
    completedAt: iso(now - 18_000 + index),
    createdAt,
    updatedAt: iso(now - 18_000 + index),
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const health = require('../src/lib/automation/jobHealthSummary.ts');
  const maintenance = require('../src/lib/automation/projectionMaintenance.ts');
  const reasons = require('../src/lib/automation/currentReasonReconciler.ts');
  const store = require('../src/lib/automation/store.ts');
  const mongoSerialization = require('../src/lib/storage/mongoSerialization.ts');
  const now = Date.now();
  let repairIndex = 0;
  let relevantWriteIndex = 0;

  function owner(label, overrides = {}) {
    repairIndex += 1;
    return {
      repairId: `m312-repair-${label}-${repairIndex}`,
      ownerId: `m312-owner-${label}`,
      ownerInstanceId: `m312-instance-${label}`,
      workerFencingToken: repairIndex,
      claimToken: `m312-claim-${label}-${repairIndex}`,
      attemptNumber: 1,
      ...overrides,
    };
  }

  async function repair(label, repairNow = Date.now(), options = {}) {
    return store.rebuildAutomationJobReadModelsFromDurable(
      options.suppliedJobs === undefined ? null : options.suppliedJobs,
      repairNow,
      {
        owner: options.owner || owner(label),
        maximumCatchUpPasses: options.maximumCatchUpPasses,
        catchUpBackoffMs: [0, 0, 0, 0, 0],
        sleep: async () => undefined,
        authorizePublication: options.authorizePublication,
        onPhase: options.onPhase,
        hooks: options.hooks,
      },
    );
  }

  async function resetBaseline(
    jobs = [automationJob(1, now), automationJob(2, now)],
    heartbeats = [],
  ) {
    await Promise.all([
      adapter.writeCollection('automation-jobs', jobs),
      adapter.writeCollection('automation-job-heartbeats', heartbeats),
      adapter.writeCollection('automation-job-projections', []),
      adapter.writeCollection('automation-job-list-projections-v2', []),
      adapter.writeCollection('automation-job-health-summary-v1', []),
      adapter.writeCollection('automation-job-projection-manifest-v1', []),
      adapter.writeCollection('automation-job-projection-maintenance-v1', []),
      adapter.writeCollection('automation-job-projection-rebuild-staging-v1', []),
      adapter.writeCollection('automation-control', []),
      adapter.writeCollection('automation-audit', []),
      adapter.writeCollection('automation-job-attempts', []),
      adapter.writeCollection('runtime-health', []),
      adapter.writeCollection('runtime-role-leases', []),
      adapter.writeCollection('runtime-role-conflicts', []),
      adapter.writeCollection('products', []),
      adapter.writeCollection('candidate-queue', []),
    ]);
    return repair('baseline', now, { suppliedJobs: jobs });
  }

  async function createRelevantJob(label) {
    relevantWriteIndex += 1;
    return store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { source: 'm3.1.2-test', label },
      priority: 60,
      idempotencyKey: `m312-relevant-${label}-${relevantWriteIndex}`,
      operationId: `m312-relevant-operation-${label}-${relevantWriteIndex}`,
      requestedBy: 'm312-concurrency-test',
      riskLevel: 'LOW',
      dryRun: false,
    });
  }

  async function activeProjectionItems() {
    const active = await health.getAutomationJobActiveProjectionStorage();
    return {
      active,
      list: await adapter.readCollection(active.collections.list),
      statuses: await adapter.readCollection(active.collections.status),
      summaries: await adapter.readCollection(active.collections.summary),
    };
  }

  await test('projection source identity excludes heartbeat and lease volatility but includes semantic changes', () => {
    const base = automationJob(10, now, {
      status: 'RUNNING',
      claimedBy: 'worker-a',
      claimToken: 'claim-a',
      heartbeatAt: iso(now - 1_000),
      leaseExpiresAt: iso(now + 60_000),
      completedAt: undefined,
    });
    const heartbeatOnly = {
      ...base,
      heartbeatAt: iso(now + 10_000),
      leaseExpiresAt: iso(now + 70_000),
    };
    const fencingVersionOnly = {
      ...base,
      projectionSourceVersion: base.projectionSourceVersion + 1,
    };
    const statusChanged = {
      ...base,
      status: 'FAILED',
      completedAt: iso(now + 1_000),
      updatedAt: iso(now + 1_000),
    };
    assert.equal(
      store.automationJobProjectionSourceFingerprint([base]),
      store.automationJobProjectionSourceFingerprint([heartbeatOnly]),
    );
    assert.equal(
      store.automationJobProjectionSourceFingerprint([base]),
      store.automationJobProjectionSourceFingerprint([fencingVersionOnly]),
    );
    assert.equal(store.automationJobMutationAffectsProjection(base, heartbeatOnly), false);
    assert.equal(store.automationJobMutationAffectsProjection(base, fencingVersionOnly), false);
    assert.equal(store.automationJobMutationAffectsProjection(base, statusChanged), true);
    assert.equal(
      store.projectAutomationJobStatusItem(base).projectionSourceVersion,
      base.projectionSourceVersion,
    );
    assert.equal(
      store.projectAutomationJobListItem(base).projectionSourceVersion,
      base.projectionSourceVersion,
    );
    assert.notEqual(
      store.automationJobProjectionSourceFingerprint([base]),
      store.automationJobProjectionSourceFingerprint([statusChanged]),
    );
  });

  await test('continuous heartbeat writes do not move the source boundary or prevent repair convergence', async () => {
    const runningNow = Date.now();
    const runningCreatedAt = iso(runningNow - 20 * 60_000);
    const runningUpdatedAt = iso(runningNow - 10 * 60_000);
    const running = automationJob(20, runningNow, {
      status: 'RUNNING',
      completedAt: undefined,
      claimedBy: 'heartbeat-worker',
      claimToken: 'heartbeat-claim',
      heartbeatAt: iso(runningNow - 500),
      leaseExpiresAt: iso(runningNow + 60_000),
      queuedAt: runningCreatedAt,
      scheduledAt: runningCreatedAt,
      runnableAt: runningCreatedAt,
      claimedAt: runningUpdatedAt,
      startedAt: runningUpdatedAt,
      createdAt: runningCreatedAt,
      updatedAt: runningUpdatedAt,
    });
    const heartbeatRecord = {
      id: running.id,
      jobId: running.id,
      workerId: 'heartbeat-worker',
      claimToken: 'heartbeat-claim',
      heartbeatAt: iso(runningNow - 500),
      leaseExpiresAt: iso(runningNow + 60_000),
    };
    await resetBaseline([running, automationJob(21, runningNow)], [heartbeatRecord]);
    const before = await health.getAutomationJobProjectionManifestForMaintenance();
    const errors = [];
    const originalError = console.error;
    console.error = value => errors.push(String(value));
    let heartbeatCount = 0;
    try {
      await repair('heartbeat', Date.now(), {
        hooks: {
          afterBaseRebuild: async () => {
            for (let index = 0; index < 12; index += 1) {
              assert.equal(await store.heartbeatAutomationJob(
                running.id,
                'heartbeat-worker',
                60_000,
                'heartbeat-claim',
              ), true);
              heartbeatCount += 1;
              const polled = await store.getAutomationJobProjection(running.id);
              assert.equal(polled.updatedAt, runningUpdatedAt);
              assert.ok(Date.parse(polled.heartbeatAt) > Date.parse(polled.updatedAt));
            }
          },
          afterCatchUpPass: async () => {
            assert.equal(await store.heartbeatAutomationJob(
              running.id,
              'heartbeat-worker',
              60_000,
              'heartbeat-claim',
            ), true);
            heartbeatCount += 1;
          },
        },
      });
    } finally {
      console.error = originalError;
    }
    const after = await health.getAutomationJobProjectionManifestForMaintenance();
    const view = await health.getAutomationJobHealthView(Date.now());
    assert.ok(heartbeatCount >= 13);
    assert.equal(after.sourceHighWatermark, before.sourceHighWatermark);
    assert.equal(after.sourceRevision, before.sourceRevision);
    assert.equal(after.activeGeneration, before.activeGeneration + 1);
    assert.equal(after.sourceFingerprint, store.automationJobProjectionSourceFingerprint(await store.getAllAutomationJobs()));
    assert.equal(view.projectionStatus, 'VALID');
    assert.equal(view.currentStateComplete, true);
    assert.equal(errors.some(value => value.includes('JOB_HEALTH_SUMMARY_SOURCE_REVISION_CHANGED')), false);
  });

  await test('a relevant write during the base rebuild is included by delta catch-up', async () => {
    await resetBaseline();
    let createdId = '';
    const passes = [];
    const manifest = await repair('relevant-write', Date.now(), {
      hooks: {
        afterBaseRebuild: async () => {
          createdId = (await createRelevantJob('during-base')).job.id;
        },
        afterCatchUpPass: ({ pass, deltaJobCount }) => {
          passes.push({ pass, deltaJobCount });
        },
      },
    });
    const jobs = await store.getAllAutomationJobs();
    const projected = await activeProjectionItems();
    assert.ok(projected.list.some(item => item.id === createdId));
    assert.ok(projected.statuses.some(item => item.id === createdId));
    assert.equal(manifest.sourceFingerprint, store.automationJobProjectionSourceFingerprint(jobs));
    assert.equal(
      health.automationJobProjectionContentFingerprint(projected.list),
      health.automationJobProjectionContentFingerprint(jobs.map(store.projectAutomationJobListItem)),
    );
    assert.ok(passes.some(pass => pass.deltaJobCount >= 1));
  });

  await test('multiple relevant waves converge with bounded catch-up and exhaustion is explicit', async () => {
    await resetBaseline();
    const createdIds = [];
    const passes = [];
    const converged = await repair('bounded-waves', Date.now(), {
      maximumCatchUpPasses: 3,
      hooks: {
        afterCatchUpPass: async ({ pass, deltaJobCount }) => {
          passes.push({ pass, deltaJobCount });
          if (pass <= 2) createdIds.push((await createRelevantJob(`wave-${pass}`)).job.id);
        },
      },
    });
    const projected = await activeProjectionItems();
    assert.deepEqual(passes.map(item => item.pass), [1, 2, 3]);
    assert.ok(createdIds.every(id => projected.list.some(item => item.id === id)));
    assert.equal(converged.sourceFingerprint, store.automationJobProjectionSourceFingerprint(await store.getAllAutomationJobs()));

    await resetBaseline();
    const previous = await health.getAutomationJobProjectionManifestForMaintenance();
    let boundedPasses = 0;
    await assert.rejects(
      () => repair('bounded-exhaustion', Date.now(), {
        maximumCatchUpPasses: 2,
        hooks: {
          afterCatchUpPass: async ({ pass }) => {
            boundedPasses = pass;
            await createRelevantJob(`exhaust-${pass}`);
          },
        },
      }),
      /JOB_PROJECTION_CATCH_UP_RETRY_EXHAUSTED/,
    );
    const failedManifest = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.equal(boundedPasses, 2);
    assert.equal(failedManifest.activeGeneration, previous.activeGeneration);
    assert.equal(failedManifest.activeRepair.phase, 'FAILED');
    assert.equal(failedManifest.activeRepair.lastFailureReason, 'JOB_PROJECTION_CATCH_UP_RETRY_EXHAUSTED');
  });

  await test('concurrent scheduling and materialization remain single-flight', async () => {
    await resetBaseline();
    const heldMutation = await health.beginAutomationJobProjectionMutation(Date.now());
    try {
      const invalidView = await health.getAutomationJobHealthView(Date.now());
      assert.notEqual(invalidView.projectionStatus, 'VALID');
      const requests = await Promise.all(Array.from({ length: 24 }, () =>
        maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, Date.now())));
      assert.equal(requests.filter(request => request.status === 'REQUESTED').length, 1);
      assert.equal(new Set(requests.map(request => request.repairId)).size, 1);
      assert.ok(requests[0].repairId);
      assert.ok(requests.every(request => request.repairState === 'SCHEDULED'));

      await Promise.all(Array.from({ length: 12 }, () =>
        maintenance.materializeJobHealthProjectionMaintenanceRequest(Date.now())));
      const state = await maintenance.getJobHealthProjectionMaintenanceState();
      const jobs = await adapter.readCollection('automation-jobs');
      const repairJobs = jobs.filter(job =>
        job.payload?.maintenanceTask === 'JOB_HEALTH_PROJECTION_REBUILD');
      assert.equal(repairJobs.length, 1);
      assert.equal(state.jobId, repairJobs[0].id);
      const repeated = await Promise.all(Array.from({ length: 12 }, () =>
        maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, Date.now())));
      assert.ok(repeated.every(request => request.jobId === state.jobId));
      assert.equal(new Set(repeated.map(request => request.repairId)).size, 1);
      assert.ok((await maintenance.getJobHealthProjectionMaintenanceState()).duplicateRequestsSuppressed >= 35);
    } finally {
      await health.abortAutomationJobProjectionMutation(heldMutation);
    }
  });

  await test('duplicate executor calls with the same claim join one local repair flight', async () => {
    await resetBaseline();
    const before = await health.getAutomationJobProjectionManifestForMaintenance();
    const repairOwner = owner('executor-single-flight');
    let enterBase;
    const baseEntered = new Promise(resolve => { enterBase = resolve; });
    let releaseBase;
    const baseGate = new Promise(resolve => { releaseBase = resolve; });
    let baseRuns = 0;
    const options = {
      owner: repairOwner,
      catchUpBackoffMs: [0, 0, 0],
      sleep: async () => undefined,
      hooks: {
        afterBaseRebuild: async () => {
          baseRuns += 1;
          enterBase();
          await baseGate;
        },
      },
    };
    const first = store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), options);
    const duplicate = store.rebuildAutomationJobReadModelsFromDurable(null, Date.now(), options);
    assert.equal(first, duplicate);
    await baseEntered;
    releaseBase();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    assert.equal(baseRuns, 1);
    assert.equal(firstResult.activeGeneration, before.activeGeneration + 1);
    assert.equal(duplicateResult.activeGeneration, firstResult.activeGeneration);
    assert.equal(duplicateResult.sourceRevision, firstResult.sourceRevision);
  });

  await test('a superseded worker cannot publish and only the newer fence promotes', async () => {
    await resetBaseline();
    const previous = await health.getAutomationJobProjectionManifestForMaintenance();
    const ownerA = owner('fence-a');
    const ownerB = owner('fence-b', { supersede: true });
    let contextB = null;
    await assert.rejects(
      () => repair('fence-a', Date.now(), {
        owner: ownerA,
        hooks: {
          beforePublication: async () => {
            contextB = await health.beginAutomationJobProjectionRebuild(ownerB, Date.now());
          },
        },
      }),
      /JOB_PROJECTION_REPAIR_FENCING_REJECTED/,
    );
    assert.ok(contextB);
    const fencedManifest = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.equal(fencedManifest.activeGeneration, previous.activeGeneration);
    assert.equal(fencedManifest.activeRepair.repairFence, contextB.repairFence);
    assert.equal(fencedManifest.activeRepair.ownerId, ownerB.ownerId);

    const promoted = await repair('fence-b', Date.now(), { owner: ownerB });
    assert.equal(promoted.activeGeneration, previous.activeGeneration + 1);
    assert.equal(promoted.repairFence, contextB.repairFence);
    assert.equal(promoted.activeRepair, undefined);
    const staleA = health.automationJobProjectionStorageCollections(
      contextB.targetSlot,
      contextB.repairFence - 1,
    );
    assert.deepEqual(await adapter.readCollection(staleA.list), []);
  });

  await test('a crash before promotion preserves the active generation and recovery is safe', async () => {
    await resetBaseline();
    const before = await health.getAutomationJobProjectionManifestForMaintenance();
    const beforeProjection = await activeProjectionItems();
    await assert.rejects(
      () => repair('crash-before-publish', Date.now(), {
        hooks: {
          beforePublication: () => {
            throw new Error('SIMULATED_CRASH_BEFORE_PUBLICATION');
          },
        },
      }),
      /SIMULATED_CRASH_BEFORE_PUBLICATION/,
    );
    const failedRepair = await health.getAutomationJobProjectionManifestForMaintenance();
    const stillActive = await activeProjectionItems();
    assert.equal(failedRepair.activeGeneration, before.activeGeneration);
    assert.equal(failedRepair.activeRepair.phase, 'FAILED');
    assert.deepEqual(stillActive.list, beforeProjection.list);
    assert.deepEqual(stillActive.statuses, beforeProjection.statuses);
    assert.equal(stillActive.summaries.length, 1);
    assert.equal(
      stillActive.summaries[0].sourceRevision,
      beforeProjection.summaries[0].sourceRevision,
    );
    assert.equal(
      stillActive.summaries[0].projectionFingerprint,
      beforeProjection.summaries[0].projectionFingerprint,
    );

    const recovered = await repair('crash-recovery', Date.now());
    assert.equal(recovered.activeGeneration, before.activeGeneration + 1);
    assert.equal(recovered.activeRepair, undefined);
    assert.equal((await health.getAutomationJobHealthView(Date.now())).projectionStatus, 'VALID');
  });

  await test('a crash during retry metadata mutation cannot corrupt durable state', async () => {
    await resetBaseline();
    const heldMutation = await health.beginAutomationJobProjectionMutation(Date.now());
    try {
      const invalidView = await health.getAutomationJobHealthView(Date.now());
      await maintenance.ensureJobHealthProjectionMaintenanceRequest(invalidView, Date.now());
      const materialized = await maintenance.materializeJobHealthProjectionMaintenanceRequest(Date.now());
      await maintenance.markJobHealthProjectionMaintenance({
        jobId: materialized.jobId,
        status: 'RUNNING',
        phase: 'CLAIMED',
        attemptNumber: 1,
        reasonCode: 'JOB_HEALTH_PROJECTION_REBUILD_RUNNING',
      });
      const before = await maintenance.getJobHealthProjectionMaintenanceState();
      await assert.rejects(
        () => adapter.runTransaction('automation-job-projection-maintenance-v1', items => {
          items[0].attemptCount = 99;
          items[0].nextRetryAt = iso(Date.now() + 999_999);
          throw new Error('SIMULATED_RETRY_METADATA_CRASH');
        }),
        /SIMULATED_RETRY_METADATA_CRASH/,
      );
      assert.deepEqual(await maintenance.getJobHealthProjectionMaintenanceState(), before);
      const retryAt = iso(Date.now() + 60_000);
      const retry = await maintenance.markJobHealthProjectionMaintenance({
        jobId: materialized.jobId,
        status: 'RETRY_SCHEDULED',
        phase: 'RETRY_WAIT',
        attemptNumber: 1,
        nextRetryAt: retryAt,
        reasonCode: 'JOB_PROJECTION_CATCH_UP_RETRY_EXHAUSTED',
      });
      assert.equal(retry.status, 'RETRY_SCHEDULED');
      assert.equal(retry.phase, 'RETRY_WAIT');
      assert.equal(retry.attemptCount, 1);
      assert.equal(retry.nextRetryAt, retryAt);
      assert.equal(retry.lastFailureReason, 'JOB_PROJECTION_CATCH_UP_RETRY_EXHAUSTED');
    } finally {
      await health.abortAutomationJobProjectionMutation(heldMutation);
    }
  });

  await test('invalid candidate metadata and corrupted staged collections fail closed', async () => {
    await resetBaseline();
    const previous = await health.getAutomationJobProjectionManifestForMaintenance();
    const previousProjection = await activeProjectionItems();
    await assert.rejects(
      () => repair('invalid-count', Date.now(), {
        hooks: {
          beforeCandidateValidation: ({ candidate }) => {
            candidate.recordCounts.list += 1;
          },
        },
      }),
      /JOB_PROJECTION_CANDIDATE_COUNT_MISMATCH/,
    );
    assert.equal(
      (await health.getAutomationJobProjectionManifestForMaintenance()).activeGeneration,
      previous.activeGeneration,
    );
    assert.deepEqual((await activeProjectionItems()).list, previousProjection.list);

    await resetBaseline();
    const prior = await health.getAutomationJobProjectionManifestForMaintenance();
    await assert.rejects(
      () => repair('corrupt-storage', Date.now(), {
        hooks: {
          beforePublication: async ({ context }) => {
            const collections = health.automationJobProjectionStorageCollections(
              context.targetSlot,
              context.repairFence,
            );
            await adapter.runTransaction(collections.list, items => items.slice(1));
          },
        },
      }),
      /JOB_PROJECTION_REPAIR_PRE_PUBLISH_VALIDATION_FAILED/,
    );
    assert.equal(
      (await health.getAutomationJobProjectionManifestForMaintenance()).activeGeneration,
      prior.activeGeneration,
    );
    assert.equal((await health.getAutomationJobHealthView(Date.now())).currentStateComplete, true);
  });

  await test('current reason reconciliation clears only projection reasons with verified evidence', () => {
    const input = {
      now,
      releaseId: 'c'.repeat(40),
      candidateCurrentReasons: [
        'JOB_PROJECTION_CURRENT_STATE_INCOMPLETE',
        'JOB_HEALTH_CURRENT_STATE_INCOMPLETE',
        'JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH',
        'SLO_DATA_INSUFFICIENT',
        'RUNTIME_GUARDIAN_PUBLISH_BLOCK',
        'AI_POLICY_BLOCKED',
        'PUBLICATION_POLICY_BLOCK',
      ],
      historicalReasons: ['HISTORICAL_AUDIT_REASON'],
      runtime: null,
      leases: [],
      conflicts: [],
      workerRequired: false,
      schedulerRequired: false,
    };
    const incomplete = reasons.reconcileCurrentReasons({
      ...input,
      projectionEvidence: {
        currentStateComplete: false,
        projectionStatus: 'INVALID',
        sourceRevision: null,
        summaryRevision: null,
        generatedAt: null,
        currentReasonCodes: ['JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH'],
      },
    });
    assert.ok(incomplete.currentActiveReasons.includes('JOB_PROJECTION_CURRENT_STATE_INCOMPLETE'));
    const repaired = reasons.reconcileCurrentReasons({
      ...input,
      projectionEvidence: {
        currentStateComplete: true,
        projectionStatus: 'VALID',
        sourceRevision: '1'.repeat(64),
        summaryRevision: '2'.repeat(64),
        generatedAt: iso(now),
        currentReasonCodes: [],
      },
    });
    assert.equal(repaired.currentActiveReasons.includes('JOB_PROJECTION_CURRENT_STATE_INCOMPLETE'), false);
    assert.equal(repaired.currentActiveReasons.includes('JOB_HEALTH_CURRENT_STATE_INCOMPLETE'), false);
    assert.equal(repaired.currentActiveReasons.includes('JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH'), false);
    assert.ok(repaired.historicalAuditReasons.includes('JOB_PROJECTION_CURRENT_STATE_INCOMPLETE'));
    assert.ok(repaired.historicalAuditReasons.includes('JOB_HEALTH_CURRENT_STATE_INCOMPLETE'));
    assert.ok(repaired.historicalAuditReasons.includes('JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH'));
    assert.ok(repaired.historicalAuditReasons.includes('HISTORICAL_AUDIT_REASON'));
    for (const reason of [
      'SLO_DATA_INSUFFICIENT',
      'RUNTIME_GUARDIAN_PUBLISH_BLOCK',
      'AI_POLICY_BLOCKED',
      'PUBLICATION_POLICY_BLOCK',
    ]) assert.ok(repaired.currentActiveReasons.includes(reason));
  });

  await test('legacy manifests bootstrap additively and an invalid older candidate never replaces valid state', async () => {
    await resetBaseline();
    const [rawManifest] = await adapter.readCollection('automation-job-projection-manifest-v1');
    const legacyManifest = { ...rawManifest };
    for (const key of [
      'repairProtocolVersion',
      'activeGeneration',
      'activeSlot',
      'activeStorageRepairFence',
      'nextMutationSequence',
      'sourceHighWatermark',
      'sourceFingerprint',
      'inFlightSyncOperations',
      'repairFence',
      'activeRepair',
      'lastSuccessfulRepairAt',
      'legacyMirrorPending',
      'staleCandidateStorage',
    ]) delete legacyManifest[key];
    await adapter.writeCollection('automation-job-projection-manifest-v1', [legacyManifest]);
    assert.equal(health.validateAutomationJobProjectionManifest(legacyManifest).valid, true);
    const normalized = await health.getAutomationJobProjectionManifestForMaintenance();
    assert.equal(normalized.repairProtocolVersion, 2);
    assert.equal(normalized.activeGeneration, 0);
    assert.equal(normalized.activeSlot, 'LEGACY');
    assert.equal((await health.getAutomationJobHealthView(Date.now())).projectionStatus, 'VALID');

    const activeBefore = await activeProjectionItems();
    await assert.rejects(
      () => repair('legacy-invalid-candidate', Date.now(), {
        hooks: {
          beforeCandidateValidation: ({ candidate }) => {
            candidate.projectionVersion = 'older-projection-version';
          },
        },
      }),
      /JOB_PROJECTION_CANDIDATE_VERSION_MISMATCH/,
    );
    assert.deepEqual((await activeProjectionItems()).list, activeBefore.list);
  });

  await test('missing or invalid current projection safely rebuilds without deleting durable history', async () => {
    const jobs = [automationJob(80, now), automationJob(81, now)];
    await Promise.all([
      adapter.writeCollection('automation-jobs', jobs),
      adapter.writeCollection('automation-job-projections', []),
      adapter.writeCollection('automation-job-list-projections-v2', []),
      adapter.writeCollection('automation-job-health-summary-v1', []),
      adapter.writeCollection('automation-job-projection-manifest-v1', []),
    ]);
    const unavailable = await health.getAutomationJobHealthView(Date.now());
    assert.equal(unavailable.currentStateComplete, false);
    const manifest = await repair('bootstrap-missing', Date.now());
    assert.equal(manifest.durableJobCount, jobs.length);
    assert.equal((await store.getAllAutomationJobs()).length, jobs.length);
    assert.equal((await health.getAutomationJobHealthView(Date.now())).projectionStatus, 'VALID');
  });

  await test('M3.1.2 manifest semantics survive Mongo serialization with the same validation result', async () => {
    await resetBaseline();
    const activeOwner = owner('mongo-parity');
    const context = await health.beginAutomationJobProjectionRebuild(activeOwner, Date.now());
    const manifest = await health.getAutomationJobProjectionManifestForMaintenance();
    const documents = mongoSerialization.serializeMongoItems([manifest], 17);
    const [roundTripped] = mongoSerialization.deserializeMongoItems(documents);
    assert.deepEqual(roundTripped, manifest);
    assert.equal(health.validateAutomationJobProjectionManifest(roundTripped).valid, true);
    assert.equal(roundTripped.activeRepair.repairFence, context.repairFence);
    assert.equal(roundTripped.activeRepair.startBoundary.highWatermark, context.startBoundary.highWatermark);
    await health.failAutomationJobProjectionRepair(context, 'TEST_PARITY_CLEANUP', Date.now());
  });

  await test('invalid repair phase transitions are rejected explicitly', async () => {
    await resetBaseline();
    const repairOwner = owner('invalid-transition');
    const context = await health.beginAutomationJobProjectionRebuild(repairOwner, Date.now());
    await assert.rejects(
      () => health.transitionAutomationJobProjectionRepair(context, 'PUBLISHING', {}, Date.now()),
      /JOB_PROJECTION_REPAIR_INVALID_TRANSITION:CLAIMED:PUBLISHING/,
    );
    await health.failAutomationJobProjectionRepair(context, 'TEST_INVALID_TRANSITION_CLEANUP', Date.now());
  });

  console.log(`\nM3.1.2 convergent projection repair tests: ${passed} passed, ${failed} failed`);
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
    } catch (error) {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    }
  });
