/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const allowedRoot = path.resolve(process.cwd(), '.test-tmp');
const suiteRoot = path.join(
  allowedRoot,
  `round3-v4-1-candidate-identity-${process.pid}-${Date.now()}`,
);
if (path.dirname(path.resolve(suiteRoot)) !== allowedRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(suiteRoot, { recursive: true });

const releaseId = '4'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
process.env.SANDEAL_BUILD_MANIFEST_COMMIT = releaseId;
process.env.SANDEAL_BUILD_COMMIT = releaseId;
process.env.SANDEAL_RELEASE_ID = releaseId;
process.env.GIT_COMMIT_SHA = releaseId;
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = releaseId;
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
require('./register-typescript.cjs');

const COLLECTIONS = [
  'automation-jobs',
  'automation-job-attempts',
  'automation-job-heartbeats',
  'automation-job-projections',
  'automation-job-list-projections-v2',
  'automation-job-health-summary-v1',
  'automation-job-projection-manifest-v1',
  'automation-job-projection-maintenance-v1',
  'automation-job-projection-rebuild-staging-v1',
  'automation-control',
  'automation-audit',
  'automation-settings',
  'automation-ai-usage',
  'business-usage',
  'candidate-queue',
  'autonomous-entity-migrations',
  'domain-circuit-breakers',
  'operation-journal',
  'products',
  'lifecycle-transitions',
  'automation-canary',
];

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

function candidate(sourceId, revision = 'v1') {
  const now = new Date().toISOString();
  const payload = {
    title: `Verified candidate ${sourceId} ${revision}`,
    description: `Deterministic source-backed fixture ${revision}.`,
    kind: 'product',
    platform: 'website',
    originalUrl: `https://merchant.example/products/${sourceId}`,
    canonicalUrlSource: 'provider_api',
    canonicalUrlProvider: 'accesstrade',
    canonicalUrlSourceEndpoint: 'datafeed',
    canonicalUrlSourceField: 'url',
    canonicalUrlFetchedAt: now,
    affiliateUrl: `https://merchant.example/products/${sourceId}?affiliate=fixture`,
    affiliateUrlSource: 'provider_api',
    affiliateUrlProvider: 'accesstrade',
    affiliateUrlSourceEndpoint: 'datafeed',
    affiliateUrlSourceField: 'aff_link',
    affiliateUrlFetchedAt: now,
    imageUrl: `https://merchant.example/images/${sourceId}.jpg`,
    imageCandidates: [],
    price: 1_500_000,
    salePrice: 1_200_000,
    currency: 'VND',
    category: 'Audio',
    verifiedSource: true,
    autoPublishEligible: true,
    sourceQualityScore: 95,
    isolatedHealthFixture: 'healthy',
  };
  const sourceHash = crypto.createHash('sha256')
    .update(JSON.stringify({ revision, payload }))
    .digest('hex');
  return {
    source: 'accesstrade',
    sourceId,
    priority: 90,
    contentHash: sourceHash,
    sourceHash,
    payload,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const fileStorage = require('../src/lib/storage/fileStorageAdapter.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const bridge = require('../src/lib/automation/candidateBridge.ts');
  const history = require('../src/lib/automation/jobHistoryArchive.ts');
  const journal = require('../src/lib/automation/operationJournal.ts');
  const migrations = require('../src/lib/autonomous/schemaMigrations.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const reconciler = require('../src/lib/automation/reconciler.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const store = require('../src/lib/automation/store.ts');

  async function scenario(name) {
    const root = path.join(suiteRoot, name);
    if (path.dirname(path.resolve(root)) !== suiteRoot) throw new Error('UNSAFE_SCENARIO_ROOT');
    fs.mkdirSync(root, { recursive: true });
    process.env.SANDEAL_DATA_DIR = root;
    process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
    fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    store.setAutomationJobArchiveTestHookForTests(undefined);
    for (const collection of COLLECTIONS) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      publishPaused: true,
      ingestionPaused: false,
      workerPaused: false,
      schedulerPaused: false,
      killSwitch: false,
    }, 'v4-1-identity-test');
    return root;
  }

  async function claimOnly(workerId) {
    const claimed = await store.claimAutomationJobs(workerId, 1, 60_000, Date.now() + 1_000);
    assert.equal(claimed.length, 1);
    assert.ok(claimed[0].claimToken);
    return claimed[0];
  }

  async function failClaimed(job, workerId, code) {
    return store.failAutomationJob(job.id, workerId, code, new Error(code), {
      claimToken: job.claimToken,
      attemptCount: job.attemptCount,
      releaseId: job.releaseId,
    });
  }

  await test('bounded candidate identities retain a distinct generation suffix', async () => {
    const candidateId = `candidate-${'x'.repeat(220)}`;
    const sourceHash = 'a'.repeat(256);
    const keyOne = bridge.candidateJobKey(candidateId, sourceHash, 1);
    const keyTwo = bridge.candidateJobKey(candidateId, sourceHash, 2);
    const operationOne = bridge.candidateOperationId(candidateId, sourceHash, 1);
    const operationTwo = bridge.candidateOperationId(candidateId, sourceHash, 2);
    assert.ok(keyOne.length <= 160);
    assert.ok(operationOne.length <= 160);
    assert.match(keyOne, /:g1$/);
    assert.match(operationOne, /:g1$/);
    assert.notEqual(keyOne, keyTwo);
    assert.notEqual(operationOne, operationTwo);
  });

  await test('prepared candidate is not runnable before the exact candidate CAS commits', async () => {
    await scenario('prepared-not-runnable');
    const queued = await queue.enqueueCandidate(candidate('prepared-not-runnable'));
    let claimObserved;
    let intercepted = false;
    fileStorage.setFileStorageTransactionTestHookForTests(async input => {
      if (
        !intercepted
        && input.collection === 'candidate-queue'
        && input.operationCategory === 'candidate_job_materialization_bind'
        && input.phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY'
      ) {
        intercepted = true;
        claimObserved = await store.claimAutomationJobs('pre-bind-worker', 1);
      }
    });
    try {
      const bridged = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
      assert.equal(bridged.created, 1);
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(intercepted, true);
    assert.deepEqual(claimObserved, []);
    const bound = await queue.getCandidateById(queued.item.id);
    const job = await store.getAutomationJob(bound.durableJobId);
    assert.equal(job.status, 'PENDING');
    assert.equal(bound.durableJobPreparedAt, undefined);
    assert.ok(bound.bridgedAt);
  });

  await test('active, running, and retry-scheduled bindings reuse one authoritative job', async () => {
    await scenario('same-job-retries');
    const queued = await queue.enqueueCandidate(candidate('same-job-retries'));
    const [first, concurrent] = await Promise.all([
      bridge.bridgeCandidatesToDurableJobs({ limit: 1 }),
      bridge.bridgeCandidatesToDurableJobs({ limit: 1 }),
    ]);
    assert.equal(first.created + concurrent.created, 1);
    let bound = await queue.getCandidateById(queued.item.id);
    const jobId = bound.durableJobId;
    assert.ok(jobId);
    assert.equal(bound.durableJobGeneration || 0, 0);
    assert.equal((await store.getAllActiveAutomationJobs()).filter(job => job.type === 'PROCESS_CANDIDATE').length, 1);

    const pendingReplay = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    assert.equal(pendingReplay.created, 0);
    assert.equal(pendingReplay.jobs[0].jobId, jobId);

    const running = await claimOnly('same-job-worker');
    assert.equal(running.id, jobId);
    assert.equal(running.status, 'RUNNING');
    const runningReplay = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    assert.equal(runningReplay.created, 0);
    assert.equal(runningReplay.jobs[0].jobId, jobId);

    const retry = await failClaimed(running, 'same-job-worker', 'PROVIDER_TIMEOUT');
    assert.equal(retry.status, 'RETRY_SCHEDULED');
    const retryReplay = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    assert.equal(retryReplay.created, 0);
    assert.equal(retryReplay.jobs[0].jobId, jobId);
    bound = await queue.getCandidateById(queued.item.id);
    assert.equal(bound.durableJobId, jobId);
    assert.equal(bound.durableJobGeneration || 0, 0);
    await assert.rejects(
      pipeline.processCandidateFromDurableJob({
        candidateId: queued.item.id,
        jobId: 'wrong-worker-job-id',
        operationId: bound.durableOperationId,
        workerId: 'wrong-worker',
      }),
      /CANDIDATE_JOB_MISMATCH/,
    );
  });

  await test('a bound non-final candidate snapshot cannot be superseded while its worker owns it', async () => {
    await scenario('bound-supersession');
    const original = await queue.enqueueCandidate(candidate('bound-supersession', 'v1'));
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const bound = await queue.getCandidateById(original.item.id);
    const claimedCandidate = await queue.claimCandidateForDurableJob(bound.id, bound.durableJobId);
    assert.equal(claimedCandidate.status, 'processing');

    const whileProcessing = await queue.enqueueCandidate(candidate('bound-supersession', 'v2'));
    assert.equal(whileProcessing.queued, false);
    assert.equal(whileProcessing.unchanged, true);
    assert.equal(whileProcessing.item.sourceHash, original.item.sourceHash);
    assert.equal(whileProcessing.item.durableJobId, bound.durableJobId);

    await queue.finishCandidate(bound.id, { status: 'needs_review', retryable: false });
    const afterDisposition = await queue.enqueueCandidate(candidate('bound-supersession', 'v2'));
    assert.equal(afterDisposition.queued, false);
    assert.equal(afterDisposition.item.sourceHash, original.item.sourceHash);
    assert.equal(afterDisposition.item.durableJobId, bound.durableJobId);
  });

  await test('pre-V4.1 generation encoded in key and operation remains authoritative', async () => {
    await scenario('legacy-generation-contract');
    const queued = await queue.enqueueCandidate(candidate('legacy-generation-contract'));
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.durableJobGeneration = 2;
      item.updatedAt = new Date().toISOString();
      return items;
    });
    const current = await queue.getCandidateById(queued.item.id);
    const key = bridge.candidateJobKey(current.id, current.sourceHash, 2);
    const operationId = bridge.candidateOperationId(current.id, current.sourceHash, 2);
    const legacy = await store.createAutomationJob({
      type: 'PROCESS_CANDIDATE',
      payload: { candidateId: current.id, sourceHash: current.sourceHash },
      priority: 90,
      idempotencyKey: key,
      operationId,
      requestedBy: 'legacy-generation-fixture',
      dryRun: false,
    });
    const replay = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    assert.equal(replay.created, 0);
    assert.equal(replay.existing, 1);
    assert.equal(replay.jobs[0].jobId, legacy.job.id);
    const bound = await queue.getCandidateById(current.id);
    assert.equal(bound.durableJobGeneration, 2);
    assert.equal(bound.durableJobId, legacy.job.id);
    assert.equal(bound.durableOperationId, operationId);
    assert.equal((await journal.getOperationJournal(operationId)).jobId, legacy.job.id);
  });

  await test('archived terminal binding is historical authority and is never called orphaned', async () => {
    await scenario('archived-binding');
    const queued = await queue.enqueueCandidate(candidate('archived-binding'));
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const before = await queue.getCandidateById(queued.item.id);
    const cancelled = await store.cancelAutomationJob(before.durableJobId, 'v4-1-identity-test', 'terminal fixture');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal((await store.getAllActiveAutomationJobs()).some(job => job.id === before.durableJobId), false);
    assert.equal((await store.getAutomationJob(before.durableJobId)).status, 'CANCELLED');

    const repaired = await reconciler.runAutonomousReconciler();
    const after = await queue.getCandidateById(queued.item.id);
    assert.equal(repaired.orphans, 0);
    assert.equal(after.durableJobId, before.durableJobId);
    assert.equal(after.durableJobGeneration || 0, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.payload.candidateId === queued.item.id).length, 1);
  });

  await test('concurrent orphan recovery performs one generation CAS and preserves the old journal', async () => {
    await scenario('orphan-cas');
    const queued = await queue.enqueueCandidate(candidate('orphan-cas'));
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const before = await queue.getCandidateById(queued.item.id);
    const oldJournal = await journal.getOperationJournal(before.durableOperationId);
    assert.equal(oldJournal.jobId, before.durableJobId);
    await adapter.runTransaction('automation-jobs', jobs => jobs.filter(job => job.id !== before.durableJobId));

    await Promise.all([
      reconciler.runAutonomousReconciler(),
      reconciler.runAutonomousReconciler(),
    ]);
    const after = await queue.getCandidateById(queued.item.id);
    assert.equal(after.durableJobGeneration, 1);
    assert.notEqual(after.durableJobId, before.durableJobId);
    assert.equal(after.durableJobKey, bridge.candidateJobKey(after.id, after.sourceHash, 1));
    assert.equal(after.durableOperationId, bridge.candidateOperationId(after.id, after.sourceHash, 1));
    const candidateJobs = (await store.getAllAutomationJobs())
      .filter(job => job.payload.candidateId === queued.item.id);
    assert.equal(candidateJobs.length, 1);
    assert.equal(candidateJobs[0].id, after.durableJobId);
    assert.deepEqual(await journal.getOperationJournal(before.durableOperationId), oldJournal);
    assert.equal((await journal.getOperationJournal(after.durableOperationId)).jobId, after.durableJobId);
  });

  await test('failed delayed candidate advances exactly once and receives a new operation contract', async () => {
    await scenario('failed-generation');
    const queued = await queue.enqueueCandidate(candidate('failed-generation'));
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const before = await queue.getCandidateById(queued.item.id);
    const oldJournal = await journal.getOperationJournal(before.durableOperationId);
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.status = 'delayed';
      item.retryable = true;
      item.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
      item.updatedAt = new Date().toISOString();
      return items;
    });
    const claimed = await claimOnly('failed-generation-worker');
    const terminal = await failClaimed(claimed, 'failed-generation-worker', 'VALIDATION_FAILED');
    assert.equal(terminal.status, 'FAILED');
    assert.equal((await store.getAllActiveAutomationJobs()).some(job => job.id === before.durableJobId), false);

    await Promise.all([
      reconciler.runAutonomousReconciler(),
      reconciler.runAutonomousReconciler(),
    ]);
    const after = await queue.getCandidateById(queued.item.id);
    assert.equal(after.durableJobGeneration, 1);
    assert.notEqual(after.durableJobId, before.durableJobId);
    assert.notEqual(after.durableOperationId, before.durableOperationId);
    assert.equal((await journal.getOperationJournal(after.durableOperationId)).jobId, after.durableJobId);
    assert.deepEqual(await journal.getOperationJournal(before.durableOperationId), oldJournal);
    const all = (await store.getAllAutomationJobs()).filter(job => job.payload.candidateId === queued.item.id);
    assert.equal(all.length, 2);
    assert.equal(all.filter(job => job.payload.generation === 1).length, 1);
  });

  await test('reconciler cannot invent candidate generation advancement without persisted retry intent', async () => {
    await scenario('generation-intent-required');
    const queued = await queue.enqueueCandidate(candidate('generation-intent-required'));
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const before = await queue.getCandidateById(queued.item.id);
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.status = 'delayed';
      item.retryable = true;
      item.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
      item.updatedAt = new Date().toISOString();
      return items;
    });
    await adapter.runTransaction('automation-jobs', jobs => {
      const job = jobs.find(entry => entry.id === before.durableJobId);
      job.status = 'FAILED';
      job.retryable = false;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      return jobs;
    });

    const repair = await reconciler.runAutonomousReconciler();
    const after = await queue.getCandidateById(queued.item.id);
    assert.equal(repair.orphans, 0);
    assert.equal(after.durableJobGeneration, 0);
    assert.equal(after.durableJobId, before.durableJobId);
    assert.equal(after.durableJobGenerationAdvanceIntent, undefined);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.payload.candidateId === queued.item.id).length, 1);
  });

  await test('failed retry-intent persistence prevents every automatic generation advance', async () => {
    await scenario('generation-intent-persistence-failure');
    const queued = await queue.enqueueCandidate(candidate('generation-intent-persistence-failure'));
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const before = await queue.getCandidateById(queued.item.id);
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.status = 'delayed';
      item.retryable = true;
      item.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
      item.updatedAt = new Date().toISOString();
      return items;
    });
    const claimed = await claimOnly('intent-persistence-worker');
    let rejected = false;
    fileStorage.setFileStorageTransactionTestHookForTests(async input => {
      if (
        !rejected
        && input.collection === 'candidate-queue'
        && input.operationCategory === 'candidate_job_generation_advance_intent'
        && input.phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY'
      ) {
        rejected = true;
        throw new Error('TEST_GENERATION_INTENT_COMMIT_REJECTED');
      }
    });
    try {
      assert.equal((await failClaimed(claimed, 'intent-persistence-worker', 'VALIDATION_FAILED')).status, 'FAILED');
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(rejected, true);
    const binding = {
      candidateId: before.id,
      sourceHash: before.sourceHash,
      generation: before.durableJobGeneration,
      jobId: before.durableJobId,
      durableJobKey: before.durableJobKey,
      operationId: before.durableOperationId,
    };
    assert.equal(await queue.advanceCandidateBridgeGeneration(binding), false);
    await reconciler.runAutonomousReconciler();
    const after = await queue.getCandidateById(queued.item.id);
    assert.equal(after.durableJobGeneration, 0);
    assert.equal(after.durableJobId, before.durableJobId);
    assert.equal(after.durableJobGenerationAdvanceIntent, undefined);
    assert.equal(after.durableJobGenerationLastAdvance, undefined);
  });

  await test('explicit operator advancement verifies terminal identity and records its reason', async () => {
    await scenario('operator-generation-advance');
    const queued = await queue.enqueueCandidate(candidate('operator-generation-advance'));
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const before = await queue.getCandidateById(queued.item.id);
    await queue.finishCandidate(before.id, {
      status: 'delayed',
      retryable: true,
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
      delayReason: 'operator-fixture',
    });
    const binding = {
      candidateId: before.id,
      sourceHash: before.sourceHash,
      generation: before.durableJobGeneration,
      jobId: before.durableJobId,
      durableJobKey: before.durableJobKey,
      operationId: before.durableOperationId,
    };
    assert.equal(await bridge.advanceCandidateBridgeGenerationByOperator({
      binding,
      actor: 'source-reliability-reconciliation',
      reasonCode: 'MERCHANT_CONNECT_TIMEOUT',
    }), false);
    await store.cancelAutomationJob(before.durableJobId, 'v4-1-identity-test', 'operator terminal fixture');
    assert.equal(await bridge.advanceCandidateBridgeGenerationByOperator({
      binding,
      actor: 'source-reliability-reconciliation',
      reasonCode: 'MERCHANT_CONNECT_TIMEOUT',
    }), true);
    const after = await queue.getCandidateById(queued.item.id);
    assert.equal(after.durableJobGeneration, 1);
    assert.equal(after.durableJobGenerationLastAdvance.fromJobId, before.durableJobId);
    assert.equal(after.durableJobGenerationLastAdvance.fromGeneration, 0);
    assert.equal(after.durableJobGenerationLastAdvance.toGeneration, 1);
    assert.equal(after.durableJobGenerationLastAdvance.requestedBy, 'source-reliability-reconciliation');
    assert.equal(after.durableJobGenerationLastAdvance.reasonCode, 'operator:MERCHANT_CONNECT_TIMEOUT');
  });

  await test('candidate generation is strictly bounded and exhausts to needs_review', async () => {
    await scenario('generation-bound');
    const queued = await queue.enqueueCandidate(candidate('generation-bound'));
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.durableJobGeneration = queue.MAX_CANDIDATE_DURABLE_JOB_GENERATION;
      item.updatedAt = new Date().toISOString();
      return items;
    });
    await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const before = await queue.getCandidateById(queued.item.id);
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.status = 'delayed';
      item.retryable = true;
      item.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
      item.updatedAt = new Date().toISOString();
      return items;
    });
    const claimed = await claimOnly('generation-bound-worker');
    const terminal = await failClaimed(claimed, 'generation-bound-worker', 'VALIDATION_FAILED');
    assert.equal(terminal.status, 'FAILED');
    await reconciler.runAutonomousReconciler();
    const after = await queue.getCandidateById(queued.item.id);
    assert.equal(after.durableJobGeneration, queue.MAX_CANDIDATE_DURABLE_JOB_GENERATION);
    assert.equal(after.durableJobId, before.durableJobId);
    assert.equal(after.status, 'needs_review');
    assert.equal(after.retryable, false);
    assert.equal(after.nextAttemptAt, undefined);
    assert.equal(after.terminalReason, 'candidate_generation_limit_reached');
  });

  await test('a terminal candidate materialization stays authoritative and is not silently rebound', async () => {
    await scenario('terminal-materialization-stickiness');
    const queued = await queue.enqueueCandidate(candidate('terminal-materialization-stickiness'));
    const key = bridge.candidateJobKey(queued.item.id, queued.item.sourceHash, 0);
    const operationId = bridge.candidateOperationId(queued.item.id, queued.item.sourceHash, 0);
    const prepared = await store.createAutomationJob({
      type: 'PROCESS_CANDIDATE',
      payload: { candidateId: queued.item.id, sourceHash: queued.item.sourceHash, generation: 0 },
      priority: 90,
      idempotencyKey: key,
      operationId,
      requestedBy: 'automation-bridge',
      preparedCandidate: true,
    });
    const cancelled = await store.cancelAutomationJob(prepared.job.id, 'v4-1-identity-test', 'terminal-before-bind fixture');
    assert.equal(cancelled.status, 'CANCELLED');

    const first = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const replay = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    const bound = await queue.getCandidateById(queued.item.id);
    assert.equal(first.created, 0);
    assert.equal(first.existing, 1);
    assert.equal(replay.created, 0);
    assert.equal(bound.durableJobId, prepared.job.id);
    assert.equal(bound.durableJobGeneration, 0);
    assert.equal(bound.durableOperationId, operationId);
    assert.equal((await journal.getOperationJournal(operationId)).jobId, prepared.job.id);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.payload.candidateId === queued.item.id).length, 1);
  });

  await test('candidate bridge writes no journal when source authority changes before binding', async () => {
    await scenario('authority-race');
    const original = await queue.enqueueCandidate(candidate('authority-race', 'v1'));
    const oldOperationId = bridge.candidateOperationId(original.item.id, original.item.sourceHash, 0);
    let changed = false;
    fileStorage.setFileStorageTransactionTestHookForTests(async input => {
      if (!changed && input.collection === 'automation-jobs' && input.phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY') {
        changed = true;
        await queue.enqueueCandidate(candidate('authority-race', 'v2'));
      }
    });
    try {
      const result = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
      assert.equal(result.created, 0);
      assert.equal(result.skipped, 1);
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(changed, true);
    assert.equal(await journal.getOperationJournal(oldOperationId), null);
    const current = await queue.getCandidateById(original.item.id);
    assert.notEqual(current.sourceHash, original.item.sourceHash);
    assert.equal(current.durableJobId, undefined);
    const replacement = await bridge.bridgeCandidatesToDurableJobs({ limit: 1 });
    assert.equal(replacement.created, 1);
    const rebound = await queue.getCandidateById(original.item.id);
    assert.notEqual(rebound.durableOperationId, oldOperationId);
    assert.equal((await journal.getOperationJournal(rebound.durableOperationId)).jobId, rebound.durableJobId);
  });

  await test('journal commit is rejected and prepared job compensated when authority is lost after binding', async () => {
    await scenario('journal-authority-race');
    const original = await queue.enqueueCandidate(candidate('journal-authority-race', 'v1'));
    const oldOperationId = bridge.candidateOperationId(original.item.id, original.item.sourceHash, 0);
    let changed = false;
    fileStorage.setFileStorageTransactionTestHookForTests(async input => {
      if (!changed && input.collection === 'operation-journal' && input.phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY') {
        changed = true;
        await queue.finishCandidate(original.item.id, { status: 'completed', retryable: false });
        const superseded = await queue.enqueueCandidate(candidate('journal-authority-race', 'v2'));
        assert.equal(superseded.queued, true);
      }
    });
    try {
      await assert.rejects(
        bridge.bridgeCandidatesToDurableJobs({ limit: 1 }),
        /CANDIDATE_BINDING_AUTHORITY_LOST/,
      );
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(changed, true);
    assert.equal(await journal.getOperationJournal(oldOperationId), null);
    const oldJobs = (await store.getAllAutomationJobs())
      .filter(job => job.operationId === oldOperationId);
    assert.equal(oldJobs.length, 1);
    assert.equal(oldJobs[0].status, 'CANCELLED');
    const current = await queue.getCandidateById(original.item.id);
    assert.notEqual(current.sourceHash, original.item.sourceHash);
    assert.equal(current.durableJobId, undefined);
  });

  await test('journal replay is stable and changed contracts remain fail-closed', async () => {
    await scenario('journal-contract');
    const input = {
      operationId: 'v4-1-journal-contract',
      jobId: 'v4-1-journal-job',
      operationType: 'PROCESS_CANDIDATE',
      effects: [{
        id: 'candidate-bridge',
        description: 'Stable candidate bridge fixture.',
        idempotencyKey: 'v4-1-journal-effect',
        intendedValue: { generation: 0 },
      }],
    };
    const first = await journal.ensureOperationJournal(input);
    const replay = await journal.ensureOperationJournal(input);
    assert.equal(replay.contractHash, first.contractHash);
    assert.equal(replay.jobId, first.jobId);
    await assert.rejects(
      journal.ensureOperationJournal({ ...input, jobId: 'different-job' }),
      /JOURNAL_CONTRACT_MISMATCH/,
    );
    const blocked = await journal.getOperationJournal(input.operationId);
    assert.equal(blocked.reconciliationStatus, 'BLOCKED');
    assert.equal(blocked.integrityError, 'JOURNAL_CONTRACT_MISMATCH');
  });

  await test('stored journal contract hashes are immutable integrity evidence', async () => {
    await scenario('journal-stored-hash');
    const input = {
      operationId: 'v4-1-journal-stored-hash',
      jobId: 'v4-1-journal-stored-hash-job',
      operationType: 'PROCESS_CANDIDATE',
      effects: [{
        id: 'candidate-bridge',
        description: 'Stored hash immutability fixture.',
        idempotencyKey: 'v4-1-journal-stored-hash-effect',
        intendedValue: { generation: 0 },
      }],
    };
    const created = await journal.ensureOperationJournal(input);
    const tamperedHash = 'f'.repeat(64);
    assert.notEqual(tamperedHash, created.contractHash);
    await adapter.runTransaction('operation-journal', entries => {
      entries[0].contractHash = tamperedHash;
      return entries;
    });
    await assert.rejects(journal.ensureOperationJournal(input), /JOURNAL_CONTRACT_MISMATCH/);
    await assert.rejects(
      journal.claimJournalEffect(input.operationId, 'candidate-bridge', 'tampered-owner'),
      /JOURNAL_CONTRACT_MISMATCH/,
    );
    await assert.rejects(
      journal.completeJournalEffect(input.operationId, 'candidate-bridge', { generation: 0 }),
      /JOURNAL_CONTRACT_MISMATCH/,
    );
    await assert.rejects(
      journal.failJournalEffect(input.operationId, 'candidate-bridge', new Error('must not mutate')),
      /JOURNAL_CONTRACT_MISMATCH/,
    );
    const blocked = await journal.getOperationJournal(input.operationId);
    assert.equal(blocked.contractHash, tamperedHash);
    assert.equal(blocked.reconciliationStatus, 'BLOCKED');
    assert.equal(blocked.integrityError, 'JOURNAL_CONTRACT_MISMATCH');
    assert.equal(blocked.intendedEffects[0].status, 'PENDING');
  });

  await test('one reconciliation identity survives repeated, failed, archived, and legacy-index ticks', async () => {
    await scenario('reconciliation-bucket');
    const base = Math.floor(Date.now() / (5 * 60_000)) * (5 * 60_000) + 1_000;
    const key = `scheduler:workflow-reconciliation:${Math.floor(base / (5 * 60_000))}`;
    const first = await scheduler.runAutomationReconciliationSchedulerTick(base);
    const [replay, concurrentReplay] = await Promise.all([
      scheduler.runAutomationReconciliationSchedulerTick(base + 40_000),
      scheduler.runAutomationReconciliationSchedulerTick(base + 60_000),
    ]);
    assert.equal(first.status, 'scheduled');
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.jobId, first.jobId);
    assert.equal(concurrentReplay.status, 'duplicate');
    assert.equal(concurrentReplay.jobId, first.jobId);

    const claimed = await claimOnly('reconciliation-worker');
    assert.equal(claimed.id, first.jobId);
    process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'false';
    let terminal;
    try {
      terminal = await failClaimed(claimed, 'reconciliation-worker', 'VALIDATION_FAILED');
    } finally {
      process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
    }
    assert.equal(terminal.status, 'FAILED');
    const failedReplay = await scheduler.runAutomationReconciliationSchedulerTick(base + 80_000);
    assert.equal(failedReplay.status, 'duplicate');
    assert.equal(failedReplay.jobId, first.jobId);

    const archived = await store.archiveTerminalAutomationJob(first.jobId);
    assert.equal(archived.status, 'ARCHIVED_AND_REMOVED');
    const archivedJob = await store.getAutomationJob(first.jobId);
    assert.equal(archivedJob.status, 'FAILED');
    const archiveReplay = await scheduler.runAutomationReconciliationSchedulerTick(base + 120_000);
    assert.equal(archiveReplay.status, 'duplicate');
    assert.equal(archiveReplay.jobId, first.jobId);

    // Simulate a terminal archive written by the previous success-only index
    // format. The immutable segment remains authoritative and read-only.
    const digest = crypto.createHash('sha256')
      .update(`automation-job-idempotency\u0000RECONCILE_AUTOMATION\u0000${key}`)
      .digest('hex');
    await adapter.writeCollection(`${history.AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX}${digest.slice(0, 2)}`, []);
    await history.assertAutomationJobHistoryArchived(archivedJob);
    const legacyReplay = await scheduler.runAutomationReconciliationSchedulerTick(base + 160_000);
    assert.equal(legacyReplay.status, 'duplicate');
    assert.equal(legacyReplay.jobId, first.jobId);

    const nextBucket = await scheduler.runAutomationReconciliationSchedulerTick(base + 5 * 60_000);
    assert.equal(nextBucket.status, 'scheduled');
    assert.notEqual(nextBucket.jobId, first.jobId);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'RECONCILE_AUTOMATION').length, 2);
  });

  await test('failed terminal reuse is scoped to workflow reconciliation and Guardian remains first', async () => {
    await scenario('sticky-scope-and-guardian');
    const first = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { fixture: true },
      idempotencyKey: 'non-workflow-failed-key',
      operationId: 'non-workflow-failed-operation',
      requestedBy: 'v4-1-identity-test',
      riskLevel: 'LOW',
    });
    const claimed = await claimOnly('non-workflow-worker');
    assert.equal(claimed.id, first.job.id);
    const failedJob = await failClaimed(claimed, 'non-workflow-worker', 'VALIDATION_FAILED');
    assert.equal(failedJob.status, 'FAILED');
    const replacement = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { fixture: 'replacement' },
      idempotencyKey: 'non-workflow-failed-key',
      operationId: 'non-workflow-replacement-operation',
      requestedBy: 'v4-1-identity-test',
      riskLevel: 'LOW',
    });
    assert.equal(replacement.created, true);
    assert.notEqual(replacement.job.id, first.job.id);

    await scenario('manual-reconciliation-scope');
    const manual = await store.createAutomationJob({
      type: 'RECONCILE_AUTOMATION',
      payload: { reconciliationKind: 'SOURCE', scheduleBucket: 1 },
      idempotencyKey: 'manual-reconciliation-key',
      operationId: 'manual-reconciliation-operation',
      requestedBy: 'v4-1-identity-test',
    });
    const manualClaim = await claimOnly('manual-reconciliation-worker');
    assert.equal(manualClaim.id, manual.job.id);
    assert.equal((await failClaimed(manualClaim, 'manual-reconciliation-worker', 'VALIDATION_FAILED')).status, 'FAILED');
    const manualReplacement = await store.createAutomationJob({
      type: 'RECONCILE_AUTOMATION',
      payload: { reconciliationKind: 'SOURCE', scheduleBucket: 1 },
      idempotencyKey: 'manual-reconciliation-key',
      operationId: 'manual-reconciliation-replacement',
      requestedBy: 'v4-1-identity-test',
    });
    assert.equal(manualReplacement.created, true);
    assert.notEqual(manualReplacement.job.id, manual.job.id);

    await scenario('guardian-priority');
    const now = Date.now();
    const guardian = await scheduler.runRuntimeControlSchedulerTick(now);
    const reconciliation = await scheduler.runAutomationReconciliationSchedulerTick(now);
    assert.equal(guardian.status, 'scheduled');
    assert.equal(reconciliation.status, 'scheduled');
    const next = await claimOnly('priority-worker');
    assert.equal(next.id, guardian.jobId);
    assert.equal(next.type, 'RUNTIME_GUARDIAN');
    assert.equal(next.priority > (await store.getAutomationJob(reconciliation.jobId)).priority, true);
  });

  await test('candidate schema migration upgrades to v3 without downgrading current records', async () => {
    await scenario('candidate-schema-v3');
    const now = new Date().toISOString();
    await adapter.writeCollection('candidate-queue', [
      {
        ...candidate('schema-current'),
        schemaVersion: 3,
        id: 'schema-current',
        status: 'pending',
        attempts: 0,
        durableJobGeneration: 7,
        durableOperationId: 'candidate-operation:schema-current:fixture:g7',
        createdAt: now,
        updatedAt: now,
      },
      {
        ...candidate('schema-legacy'),
        id: 'schema-legacy',
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const result = await migrations.runPersistedEntityBackfill({ dryRun: false, limit: 100 });
    assert.equal(result.failed, 0);
    const records = await adapter.readCollection('candidate-queue');
    const current = records.find(item => item.id === 'schema-current');
    const legacy = records.find(item => item.id === 'schema-legacy');
    assert.equal(current.schemaVersion, 3);
    assert.equal(current.durableJobGeneration, 7);
    assert.equal(current.durableOperationId, 'candidate-operation:schema-current:fixture:g7');
    assert.equal(legacy.schemaVersion, 3);
    assert.equal(legacy.durableJobGeneration, 0);
  });

  fileStorage.setFileStorageTransactionTestHookForTests(undefined);
  store.setAutomationJobArchiveTestHookForTests(undefined);
  process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
  console.log(`\nSanDeal V4.1 candidate identity regression: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), suiteRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
