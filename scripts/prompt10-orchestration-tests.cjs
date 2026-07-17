/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testAuthValue = ['prompt10', 'orchestration', 'fixture'].join('-');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-orchestration-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
process.env.ALLOW_PAID_AI = 'false';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt10-orchestration';
process.env.BASIC_AUTH_PASSWORD = testAuthValue;
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
require('./register-typescript.cjs');

const auth = `Basic ${Buffer.from(`prompt10-orchestration:${testAuthValue}`).toString('base64')}`;

let passed = 0; let failed = 0;
async function test(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function candidate(id) {
  const payload = {
    title: `Verified candidate ${id} Bluetooth headset`,
    description: 'Isolated candidate with deterministic source-backed fixture fields.',
    kind: 'product', platform: 'website',
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=fixture`,
    imageUrl: `https://merchant.example/images/${id}.jpg`, imageCandidates: [],
    price: 1500000, salePrice: 1200000, currency: 'VND', category: 'Audio',
    verifiedSource: true, autoPublishEligible: true, sourceQualityScore: 95,
    isolatedHealthFixture: 'healthy',
  };
  const hash = require('node:crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { source: 'accesstrade', sourceId: id, priority: 90, contentHash: hash, sourceHash: hash, payload };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const bridge = require('../src/lib/automation/candidateBridge.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const journal = require('../src/lib/automation/operationJournal.ts');
  const reconciler = require('../src/lib/automation/reconciler.ts');
  const products = require('../src/lib/storage/products.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const legacyRunner = require('../src/lib/bots/autoPilotRunner.ts');
  const legacyScheduler = require('../src/lib/bots/automationScheduler.ts');
  const runNowRoute = require('../src/app/api/ai-bots/run-now/route.ts');
  const { NextRequest } = require('next/server');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_ORCHESTRATION'); };

  for (const collection of ['candidate-queue', 'products', 'automation-jobs', 'automation-control', 'automation-audit', 'operation-journal', 'automation-circuits', 'automation-ai-usage', 'automation-manual-tasks', 'automation-canary']) await adapter.writeCollection(collection, []);
  await store.updateAutomationControl({ mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: true, ingestionPaused: false, workerPaused: false, schedulerPaused: false, killSwitch: false }, 'orchestration-test');

  await test('candidate bridge creates one idempotent durable job and no product write', async () => {
    const queued = await queue.enqueueCandidate(candidate('bridge-one'));
    const first = await bridge.bridgeCandidatesToDurableJobs({ parentJobId: 'parent-cycle', limit: 10 });
    const second = await bridge.bridgeCandidatesToDurableJobs({ parentJobId: 'parent-cycle', limit: 10 });
    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal(second.existing, 1);
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'PROCESS_CANDIDATE');
    assert.equal((await queue.getCandidateById(queued.item.id)).durableJobId, jobs[0].id);
    assert.equal((await products.getAllProducts()).length, 0);
  });

  await test('durable worker alone performs candidate workflow and completes journal', async () => {
    const run = await worker.processAutomationBatch('orchestration-worker', 1);
    assert.equal(run.succeeded, 1);
    const allProducts = await products.getAllProducts();
    assert.equal(allProducts.length, 1);
    assert.notEqual(allProducts[0].status, 'published');
    assert.equal(allProducts[0].publicHidden, true);
    const job = (await store.getAllAutomationJobs())[0];
    const operation = await journal.getOperationJournal(job.operationId);
    assert.equal(operation.reconciliationStatus, 'CONSISTENT');
    assert.deepEqual(new Set(operation.completedEffects), new Set(['candidate-bridge', 'canonical-product', 'evidence-snapshot', 'publish-child']));
  });

  await test('operation effect lease is idempotent and replay-safe', async () => {
    await journal.ensureOperationJournal({ operationId: 'journal-replay-one', operationType: 'TEST', effects: [{ id: 'write', description: 'fixture', idempotencyKey: 'journal-effect-fixture' }] });
    assert.equal(await journal.beginJournalEffect('journal-replay-one', 'write', 1000), 'CLAIMED');
    assert.equal(await journal.beginJournalEffect('journal-replay-one', 'write', 1001), 'IN_PROGRESS');
    await journal.completeJournalEffect('journal-replay-one', 'write', { ok: true });
    assert.equal(await journal.beginJournalEffect('journal-replay-one', 'write', 1002), 'COMPLETED');
  });

  await test('journal preserves contract and result checksums with explicit ownership and reclaim', async () => {
    await journal.ensureOperationJournal({
      operationId: 'journal-owned-effect',
      jobId: 'journal-owned-job',
      operationType: 'TEST_OWNERSHIP',
      effects: [{ id: 'write', description: 'owned fixture', idempotencyKey: 'journal-owned-effect-key', intendedValue: { target: 'fixture' } }],
    });
    const first = await journal.claimJournalEffect('journal-owned-effect', 'write', 'owner-a', 10_000);
    assert.equal(first.status, 'CLAIMED');
    const blocked = await journal.claimJournalEffect('journal-owned-effect', 'write', 'owner-b', 10_001);
    assert.equal(blocked.status, 'IN_PROGRESS');
    assert.equal(blocked.activeOwnerId, 'owner-a');
    const resumed = await journal.claimJournalEffect('journal-owned-effect', 'write', 'owner-a', 10_002);
    assert.equal(resumed.status, 'OWNED');
    const reclaimed = await journal.claimJournalEffect(
      'journal-owned-effect',
      'write',
      'owner-b',
      10_002 + journal.OPERATION_JOURNAL_EFFECT_LEASE_MS + 1,
    );
    assert.equal(reclaimed.status, 'RECLAIMED');
    await assert.rejects(
      journal.completeJournalEffect('journal-owned-effect', 'write', { result: 'wrong-owner' }, { ownerId: 'owner-a' }),
      /JOURNAL_EFFECT_OWNERSHIP_MISMATCH/,
    );
    await journal.completeJournalEffect('journal-owned-effect', 'write', { result: 'persisted' }, { ownerId: 'owner-b' });
    const entry = await journal.getOperationJournal('journal-owned-effect');
    const effect = entry.intendedEffects.find(item => item.id === 'write');
    assert.equal(entry.schemaVersion, 2);
    assert.match(entry.contractHash, /^[a-f0-9]{64}$/);
    assert.match(effect.intendedChecksum, /^[a-f0-9]{64}$/);
    assert.match(effect.actualChecksum, /^[a-f0-9]{64}$/);
    assert.notEqual(effect.intendedChecksum, effect.actualChecksum);
    assert.equal(entry.intendedChecksums.write, effect.intendedChecksum);
    assert.equal(entry.actualChecksums.write, effect.actualChecksum);
    assert.equal(entry.reconciliationStatus, 'CONSISTENT');
  });

  await test('journal rejects a changed replay contract and persists a blocked integrity state', async () => {
    const input = {
      operationId: 'journal-contract-mismatch',
      jobId: 'journal-contract-job',
      operationType: 'TEST_CONTRACT',
      effects: [{ id: 'write', description: 'stable fixture', idempotencyKey: 'journal-contract-key', intendedValue: { version: 1 } }],
    };
    const first = await journal.ensureOperationJournal(input);
    const replay = await journal.ensureOperationJournal(input);
    assert.equal(replay.contractHash, first.contractHash);
    await assert.rejects(
      journal.ensureOperationJournal({ ...input, effects: [{ ...input.effects[0], idempotencyKey: 'journal-contract-changed' }] }),
      /JOURNAL_CONTRACT_MISMATCH/,
    );
    const blocked = await journal.getOperationJournal(input.operationId);
    assert.equal(blocked.reconciliationStatus, 'BLOCKED');
    assert.equal(blocked.integrityError, 'JOURNAL_CONTRACT_MISMATCH');
  });

  await test('reconciler repairs orphan staging candidate without user action', async () => {
    const queued = await queue.enqueueCandidate(candidate('orphan-two'));
    assert.equal((await queue.getCandidateById(queued.item.id)).durableJobId, undefined);
    const result = await reconciler.runAutonomousReconciler();
    assert.equal(result.bridgeJobs, 1);
    const repaired = await queue.getCandidateById(queued.item.id);
    assert.ok(repaired.durableJobId);
    const matching = (await store.getAllAutomationJobs()).filter(job => job.payload.candidateId === queued.item.id);
    assert.equal(matching.length, 1);
  });

  await test('temporary candidate failure reschedules the same durable job and resumes without loss', async () => {
    const input = candidate('retry-three');
    input.payload.isolatedHealthFixture = 'temporary_failure';
    const queued = await queue.enqueueCandidate(input);
    await bridge.bridgeCandidatesToDurableJobs({ limit: 100 });
    await worker.processAutomationBatch('retry-worker', 10);

    const retryJob = (await store.getAllAutomationJobs()).find(job => job.payload.candidateId === queued.item.id);
    assert.ok(retryJob);
    assert.equal(retryJob.status, 'RETRY_SCHEDULED');
    const delayed = await queue.getCandidateById(queued.item.id);
    assert.equal(delayed.status, 'delayed');
    assert.equal(retryJob.nextRetryAt, delayed.nextAttemptAt);
    assert.notEqual((await journal.getOperationJournal(retryJob.operationId)).reconciliationStatus, 'CONSISTENT');

    const past = new Date(Date.now() - 1_000).toISOString();
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.nextAttemptAt = past;
      item.payload.isolatedHealthFixture = 'healthy';
      return items;
    });
    await adapter.runTransaction('automation-jobs', items => {
      const item = items.find(entry => entry.id === retryJob.id);
      item.nextRetryAt = past;
      return items;
    });
    await adapter.writeCollection('domain-circuit-breakers', []);
    await worker.processAutomationBatch('retry-worker-restarted', 10);
    const resumed = await store.getAutomationJob(retryJob.id);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.equal(resumed.attemptCount, 2);
    assert.equal((await queue.getCandidateById(queued.item.id)).status, 'completed');
    assert.equal((await journal.getOperationJournal(retryJob.operationId)).reconciliationStatus, 'CONSISTENT');
  });

  await test('parent cycle waits for terminal descendants and reconciler completes it once', async () => {
    await queue.enqueueCandidate(candidate('parent-wait-four'));
    const parent = await store.createAutomationJob({
      type: 'AUTO_PILOT',
      payload: {},
      idempotencyKey: 'autopilot-parent-wait-four',
      requestedBy: 'scheduler',
      priority: 100,
    });
    const parentRun = await worker.processAutomationBatch('parent-worker', 1);
    assert.equal(parentRun.waitingChildren, 1);
    const waiting = await store.getAutomationJob(parent.job.id);
    assert.equal(waiting.status, 'WAITING_CHILDREN');
    assert.equal(waiting.completedAt, undefined);
    const descendants = (await store.getAllAutomationJobs()).filter(job => job.parentJobId === parent.job.id);
    assert.ok(descendants.length > 0);

    await worker.processAutomationBatch('child-worker', 10);
    assert.equal((await store.getAutomationJob(parent.job.id)).status, 'WAITING_CHILDREN');
    const firstReconcile = await reconciler.runAutonomousReconciler();
    assert.equal(firstReconcile.parentJobsCompleted, 1);
    assert.equal(firstReconcile.shadowCyclesRecorded, 1);
    const completed = await store.getAutomationJob(parent.job.id);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(completed.progress.percentage, 100);
    assert.deepEqual(completed.checkpoint.pendingSteps, []);
    const secondReconcile = await reconciler.runAutonomousReconciler();
    assert.equal(secondReconcile.parentJobsCompleted, 0);
    assert.equal(secondReconcile.shadowCyclesRecorded, 0);
    assert.equal((await store.getAutomationJob(parent.job.id)).completedAt, completed.completedAt);
    const canaryState = (await adapter.readCollection('automation-canary'))[0];
    assert.equal(canaryState.successfulShadowCycles, 1); assert.equal(canaryState.wave, 1);
  });

  await test('failed or cancelled descendants and non-SHADOW parents never record a shadow cycle', async () => {
    async function terminalParentFixture(suffix, effectiveMode, childStatuses) {
      for (const collection of ['candidate-queue', 'products', 'automation-jobs', 'automation-audit', 'automation-canary', 'operation-journal']) await adapter.writeCollection(collection, []);
      await store.updateAutomationControl({
        mode: effectiveMode,
        effectiveMode,
        publishPaused: true,
        ingestionPaused: false,
        workerPaused: false,
        schedulerPaused: false,
        killSwitch: false,
      }, 'shadow-cycle-test');
      const parent = await store.createAutomationJob({
        type: 'AUTO_PILOT', payload: {}, idempotencyKey: `shadow-parent-${suffix}`, requestedBy: 'scheduler', priority: 100,
      });
      const children = [];
      for (let index = 0; index < childStatuses.length; index += 1) {
        const child = await store.createAutomationJob({
          type: 'PROCESS_CANDIDATE',
          payload: { candidateId: `shadow-child-${suffix}-${index}` },
          idempotencyKey: `shadow-child-${suffix}-${index}`,
          parentJobId: parent.job.id,
          requestedBy: 'autopilot-worker',
          priority: 80,
        });
        children.push(child.job);
      }
      const completedAt = new Date().toISOString();
      await adapter.runTransaction('automation-jobs', jobs => {
        const storedParent = jobs.find(job => job.id === parent.job.id);
        storedParent.status = 'WAITING_CHILDREN';
        for (let index = 0; index < children.length; index += 1) {
          const storedChild = jobs.find(job => job.id === children[index].id);
          storedChild.status = childStatuses[index];
          storedChild.completedAt = completedAt;
          storedChild.updatedAt = completedAt;
        }
        return jobs;
      });
      return parent.job.id;
    }

    const failedParentId = await terminalParentFixture('failed', 'SHADOW', ['SUCCEEDED', 'FAILED', 'CANCELLED']);
    const failedResult = await reconciler.runAutonomousReconciler();
    assert.equal(failedResult.parentJobsCompleted, 1); assert.equal(failedResult.shadowCyclesRecorded, 0);
    assert.ok(['SUCCEEDED', 'FAILED', 'BLOCKED'].includes((await store.getAutomationJob(failedParentId)).status));
    assert.equal((await adapter.readCollection('automation-canary')).length, 0);

    await terminalParentFixture('canary', 'CANARY', ['SUCCEEDED', 'SUCCEEDED']);
    const canaryResult = await reconciler.runAutonomousReconciler();
    assert.equal(canaryResult.parentJobsCompleted, 1); assert.equal(canaryResult.shadowCyclesRecorded, 0);
    assert.equal((await adapter.readCollection('automation-canary')).length, 0);
  });

  await test('production run-now route only enqueues and leaves candidate workflow untouched', async () => {
    for (const collection of ['candidate-queue', 'products', 'automation-jobs', 'automation-audit', 'bot-runs', 'run-logs']) await adapter.writeCollection(collection, []);
    const queued = await queue.enqueueCandidate(candidate('route-staging'));
    const response = await runNowRoute.POST(new NextRequest('http://localhost/api/ai-bots/run-now', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'full_safe_run' }),
    }));
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.ok(body.data.jobId);
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'AUTO_PILOT');
    assert.equal(jobs[0].status, 'PENDING');
    assert.equal((await queue.getCandidateById(queued.item.id)).status, 'pending');
    assert.equal((await queue.getCandidateById(queued.item.id)).durableJobId, undefined);
    assert.deepEqual(await products.getAllProducts(), []);
    assert.deepEqual(await adapter.readCollection('bot-runs'), []);
  });

  await test('deprecated AutoPilot entry is enqueue-only and returns durable tracking', async () => {
    for (const collection of ['candidate-queue', 'products', 'automation-jobs', 'automation-audit', 'bot-runs', 'run-logs']) await adapter.writeCollection(collection, []);
    const queued = await queue.enqueueCandidate(candidate('legacy-entry-staging'));
    const result = await legacyRunner.runAutoPilot({ mode: 'health_check', trigger: 'api' });
    assert.equal(result.status, 'running');
    assert.ok(result.jobId);
    assert.equal(result.runId, result.jobId);
    assert.equal(result.trackingRoute, `/api/automation/jobs/${result.jobId}`);
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'RECHECK_PRODUCT_HEALTH');
    assert.equal((await queue.getCandidateById(queued.item.id)).status, 'pending');
    assert.deepEqual(await products.getAllProducts(), []);
    assert.deepEqual(await adapter.readCollection('bot-runs'), []);
    assert.deepEqual(await adapter.readCollection('run-logs'), []);
  });

  await test('deprecated scheduler entry only creates durable jobs', async () => {
    for (const collection of ['candidate-queue', 'products', 'automation-jobs', 'automation-audit', 'bot-runs', 'run-logs', 'scheduler-state']) await adapter.writeCollection(collection, []);
    const queued = await queue.enqueueCandidate(candidate('legacy-scheduler-staging'));
    await settings.updateAutomationSettings({ enabled: true, intervalHours: 6 });
    const now = Date.now();
    await store.updateAutomationControl({
      schedulerPaused: false,
      workerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
      workerHeartbeatAt: new Date(now).toISOString(),
      schedulerNextRunAt: undefined,
    }, 'orchestration-test');
    const result = await legacyScheduler.runSchedulerTick(now);
    assert.equal(result.status, 'completed');
    assert.equal(result.reason, 'durable_jobs_enqueued');
    const jobs = await store.getAllAutomationJobs();
    assert.ok(jobs.some(job => job.type === 'AUTO_PILOT'));
    assert.ok(jobs.some(job => job.type === 'RECHECK_PRODUCT_HEALTH'));
    assert.ok(jobs.every(job => ['PENDING', 'WAITING_APPROVAL', 'BLOCKED'].includes(job.status)));
    assert.equal((await queue.getCandidateById(queued.item.id)).status, 'pending');
    assert.equal((await queue.getCandidateById(queued.item.id)).durableJobId, undefined);
    assert.deepEqual(await products.getAllProducts(), []);
    assert.deepEqual(await adapter.readCollection('scheduler-state'), []);
  });

  console.log(`\nPROMPT10 Gate 3 orchestration: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
