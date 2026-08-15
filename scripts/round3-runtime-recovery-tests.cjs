/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const rootTempDir = path.join(
  process.cwd(),
  '.test-tmp',
  `round3-runtime-recovery-${process.pid}-${Date.now()}`,
);
fs.mkdirSync(rootTempDir, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = rootTempDir;
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
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

function makeProduct(id, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id,
    title: `Verified product ${id}`,
    slug: id,
    description: 'Deterministic product fixture backed by isolated file storage.',
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    canonicalProductUrl: `https://merchant.example/products/${id}`,
    canonicalUrlSource: 'manual',
    canonicalUrlStatus: 'verified',
    canonicalUrlVerifiedAt: now,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=fixture`,
    affiliateUrlSource: 'manual',
    affiliateUrlStatus: 'verified',
    affiliateUrlVerifiedAt: now,
    imageUrl: `https://merchant.example/images/${id}.jpg`,
    price: 1_500_000,
    salePrice: 1_200_000,
    currency: 'VND',
    category: 'Audio',
    brand: 'Example',
    sku: `SKU-${id}`,
    tags: ['audio'],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: true,
    publicHidden: true,
    needsVerification: true,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    linkLastCheckedAt: now,
    affiliateLastCheckedAt: now,
    imageLastCheckedAt: now,
    priceObservedAt: now,
    priceTruthState: 'FRESH',
    lastSeenAt: now,
    availability: 'available',
    sourceHash: `source-${id}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeCandidate(id, fixture = 'healthy') {
  const payload = {
    title: `Verified candidate ${id} Bluetooth headset`,
    description: 'Deterministic source-backed candidate fixture.',
    kind: 'product',
    platform: 'website',
    originalUrl: `https://merchant.example/products/${id}`,
    canonicalUrlSource: 'provider_api',
    canonicalUrlProvider: 'accesstrade',
    canonicalUrlSourceEndpoint: 'datafeed',
    canonicalUrlSourceField: 'url',
    canonicalUrlFetchedAt: new Date().toISOString(),
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=fixture`,
    affiliateUrlSource: 'provider_api',
    affiliateUrlProvider: 'accesstrade',
    affiliateUrlSourceEndpoint: 'datafeed',
    affiliateUrlSourceField: 'aff_link',
    affiliateUrlFetchedAt: new Date().toISOString(),
    imageUrl: `https://merchant.example/images/${id}.jpg`,
    imageCandidates: [],
    price: 1_500_000,
    salePrice: 1_200_000,
    currency: 'VND',
    category: 'Audio',
    verifiedSource: true,
    autoPublishEligible: true,
    sourceQualityScore: 95,
    isolatedHealthFixture: fixture,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return {
    source: 'accesstrade',
    sourceId: id,
    priority: 90,
    contentHash: hash,
    sourceHash: hash,
    payload,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const reconciler = require('../src/lib/automation/reconciler.ts');
  const executionPolicy = require('../src/lib/automation/executionPolicy.ts');
  const intelligence = require('../src/lib/product-intelligence/jobs.ts');

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_ROUND3_RUNTIME_TESTS'); };

  async function scenario(name) {
    intelligence.setProductSelectionTestHookForTests();
    const directory = path.join(rootTempDir, name);
    fs.mkdirSync(directory, { recursive: true });
    process.env.SANDEAL_DATA_DIR = directory;
    for (const collection of [
      'automation-jobs',
      'automation-job-attempts',
      'automation-job-heartbeats',
      'automation-control',
      'automation-audit',
      'automation-circuits',
      'automation-ai-usage',
      'automation-canary',
      'candidate-queue',
      'products',
      'price-history',
      'operation-journal',
      'domain-circuit-breakers',
      'lifecycle-transitions',
    ]) {
      await adapter.writeCollection(collection, []);
    }
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      publishPaused: true,
      publishBlockedByRuntime: true,
      ingestionPaused: false,
      workerPaused: false,
      schedulerPaused: false,
      killSwitch: false,
    }, 'round3-runtime-test');
  }

  async function createParentFixture(suffix, statuses) {
    const parent = await store.createAutomationJob({
      type: 'AUTO_PILOT',
      payload: {},
      idempotencyKey: `parent-${suffix}`,
      operationId: `parent-operation-${suffix}`,
      requestedBy: 'round3-runtime-test',
      priority: 95,
    });
    const children = [];
    for (let index = 0; index < statuses.length; index += 1) {
      const child = await store.createAutomationJob({
        type: 'PROCESS_CANDIDATE',
        payload: { candidateId: `${suffix}-${index}` },
        idempotencyKey: `child-${suffix}-${index}`,
        operationId: `child-operation-${suffix}-${index}`,
        requestedBy: 'round3-runtime-test',
        parentJobId: parent.job.id,
        priority: 80,
      });
      children.push(child.job);
    }
    const now = new Date().toISOString();
    await adapter.runTransaction('automation-jobs', jobs => {
      const storedParent = jobs.find(job => job.id === parent.job.id);
      storedParent.status = 'WAITING_CHILDREN';
      storedParent.checkpoint = {
        version: 1,
        completedSteps: [],
        pendingSteps: ['children'],
        outputs: {},
        executionModes: [],
        inputHash: suffix,
        updatedAt: now,
      };
      storedParent.progress = {
        processed: 0,
        total: statuses.length,
        succeeded: 0,
        skipped: 0,
        failed: 0,
        percentage: 0,
        updatedAt: now,
      };
      for (let index = 0; index < children.length; index += 1) {
        const storedChild = jobs.find(job => job.id === children[index].id);
        storedChild.status = statuses[index];
        storedChild.updatedAt = now;
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(statuses[index])) {
          storedChild.completedAt = now;
        }
        if (statuses[index] === 'RETRY_SCHEDULED') {
          storedChild.nextRetryAt = new Date(Date.now() + 60_000).toISOString();
        }
      }
      return jobs;
    });
    return parent.job.id;
  }

  await test('durable scheduler and Worker close AUTO_PILOT after a natural child retry', async () => {
    await scenario('automatic-parent-reconciliation');
    const queued = await queue.enqueueCandidate(makeCandidate('automatic-parent', 'temporary_failure'));
    const parent = await store.createAutomationJob({
      type: 'AUTO_PILOT',
      payload: {},
      idempotencyKey: 'round3-autopilot-parent',
      operationId: 'round3-autopilot-parent-operation',
      requestedBy: 'scheduler',
      priority: 95,
    });

    const parentRun = await worker.processAutomationBatch('round3-parent-worker', 1);
    assert.equal(parentRun.waitingChildren, 1);
    assert.equal((await store.getAutomationJob(parent.job.id)).status, 'WAITING_CHILDREN');

    await worker.processAutomationBatch('round3-child-worker', 10);
    const retryChild = (await store.getAllAutomationJobs())
      .find(job => job.parentJobId === parent.job.id && job.status === 'RETRY_SCHEDULED');
    assert.ok(retryChild);

    const firstTickAt = Date.now();
    const firstTick = await scheduler.runAutomationReconciliationSchedulerTick(firstTickAt);
    const duplicateTick = await scheduler.runAutomationReconciliationSchedulerTick(firstTickAt + 5 * 60_000);
    const laterDuplicateTick = await scheduler.runAutomationReconciliationSchedulerTick(firstTickAt + 10 * 60_000);
    assert.equal(firstTick.status, 'scheduled');
    assert.equal(duplicateTick.status, 'duplicate');
    assert.equal(laterDuplicateTick.status, 'duplicate');
    assert.equal(new Set([firstTick.jobId, duplicateTick.jobId, laterDuplicateTick.jobId]).size, 1);

    await worker.processAutomationBatch('round3-reconcile-wait-worker', 1);
    assert.equal((await store.getAutomationJob(parent.job.id)).status, 'WAITING_CHILDREN');

    const retryPast = new Date(Date.now() - 1_000).toISOString();
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.nextAttemptAt = retryPast;
      item.payload.isolatedHealthFixture = 'healthy';
      return items;
    });
    await adapter.runTransaction('automation-jobs', jobs => {
      const child = jobs.find(job => job.id === retryChild.id);
      child.nextRetryAt = retryPast;
      return jobs;
    });
    await adapter.writeCollection('domain-circuit-breakers', []);
    await worker.processAutomationBatch('round3-retry-worker-restarted', 1);
    const succeededChild = await store.getAutomationJob(retryChild.id);
    assert.equal(succeededChild.status, 'SUCCEEDED');
    assert.equal(succeededChild.attemptCount, 2);

    const completionTickAt = firstTickAt + 15 * 60_000;
    assert.equal((await scheduler.runAutomationReconciliationSchedulerTick(completionTickAt)).status, 'scheduled');
    await worker.processAutomationBatch('round3-reconcile-complete-worker', 1);
    const completed = await store.getAutomationJob(parent.job.id);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(completed.progress.percentage, 100);
    assert.equal(completed.progress.processed, completed.progress.total);
    assert.ok(completed.completedAt);
    assert.deepEqual(completed.checkpoint.pendingSteps, []);

    const completedAt = completed.completedAt;
    assert.equal((await scheduler.runAutomationReconciliationSchedulerTick(completionTickAt)).status, 'duplicate');
    assert.equal((await store.getAutomationJob(parent.job.id)).completedAt, completedAt);
  });

  await test('RETRY_SCHEDULED and RUNNING descendants keep their parents waiting', async () => {
    await scenario('active-descendants-wait');
    const retryParent = await createParentFixture('retry-wait', ['SUCCEEDED', 'RETRY_SCHEDULED']);
    const runningParent = await createParentFixture('running-wait', ['SUCCEEDED', 'RUNNING']);
    const result = await reconciler.runAutonomousReconciler();
    assert.equal(result.parentJobsCompleted, 0);
    assert.equal((await store.getAutomationJob(retryParent)).status, 'WAITING_CHILDREN');
    assert.equal((await store.getAutomationJob(runningParent)).status, 'WAITING_CHILDREN');
  });

  await test('failed, cancelled, and blocked descendants preserve legitimate parent outcomes', async () => {
    await scenario('terminal-parent-outcomes');
    const failedParent = await createParentFixture('failed-child', ['SUCCEEDED', 'FAILED']);
    const cancelledParent = await createParentFixture('cancelled-child', ['SUCCEEDED', 'CANCELLED']);
    const blockedParent = await createParentFixture('blocked-child', ['SUCCEEDED', 'BLOCKED']);
    const result = await reconciler.runAutonomousReconciler();
    assert.equal(result.parentJobsCompleted, 3);

    const failed = await store.getAutomationJob(failedParent);
    const cancelled = await store.getAutomationJob(cancelledParent);
    const blocked = await store.getAutomationJob(blockedParent);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.lastErrorCode, 'AUTOMATION_CHILD_FAILED');
    assert.equal(cancelled.status, 'FAILED');
    assert.equal(cancelled.lastErrorCode, 'AUTOMATION_CHILD_CANCELLED');
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.lastErrorCode, 'AUTOMATION_CHILD_BLOCKED');
    for (const parent of [failed, cancelled, blocked]) {
      assert.equal(parent.progress.percentage, 100);
      assert.ok(parent.completedAt);
      assert.deepEqual(parent.checkpoint.pendingSteps, []);
    }
  });

  await test('workflow reconciliation stays distinct from projection repair and Guardian capacity', async () => {
    await scenario('reconciliation-lanes');
    const now = Date.now();
    const generic = await scheduler.runAutomationReconciliationSchedulerTick(now);
    const guardian = await scheduler.runRuntimeControlSchedulerTick(now);
    const projection = await store.createAutomationJob({
      type: 'RECONCILE_AUTOMATION',
      payload: { maintenanceTask: 'JOB_HEALTH_PROJECTION_REBUILD' },
      idempotencyKey: 'round3-projection-rebuild',
      operationId: 'round3-projection-rebuild-operation',
      requestedBy: 'projection-maintenance',
      priority: 99,
    });
    assert.equal(generic.status, 'scheduled');
    assert.equal(guardian.status, 'scheduled');
    assert.equal(projection.created, true);

    const all = await store.getAllAutomationJobs();
    const genericJob = all.find(job => job.id === generic.jobId);
    const guardianJob = all.find(job => job.id === guardian.jobId);
    const genericDescriptor = executionPolicy.getAutomationExecutionDescriptor(genericJob);
    const guardianDescriptor = executionPolicy.getAutomationExecutionDescriptor(guardianJob);
    const projectionDescriptor = executionPolicy.getAutomationExecutionDescriptor(projection.job);
    assert.equal(genericDescriptor.concurrencyClass, 'CONTROL');
    assert.equal(genericDescriptor.critical, false);
    assert.equal(genericDescriptor.exclusive, false);
    assert.equal(guardianDescriptor.critical, true);
    assert.equal(executionPolicy.automationJobsConflict(genericJob, guardianJob), false);
    assert.equal(projectionDescriptor.concurrencyClass, 'PROJECTION_MAINTENANCE');
    assert.equal(projectionDescriptor.critical, true);

    await worker.processAutomationBatch('round3-projection-worker', 1);
    assert.equal((await store.getAutomationJob(guardian.jobId)).status, 'SUCCEEDED');
    await worker.processAutomationBatch('round3-projection-worker', 1);
    assert.equal((await store.getAutomationJob(projection.job.id)).status, 'SUCCEEDED');
  });

  await test('one collection mutation rematerializes a coherent score selection', async () => {
    await scenario('selection-rematerializes');
    await adapter.writeCollection('products', Array.from({ length: 6 }, (_, index) => makeProduct(`p${index + 1}`)));
    let mutations = 0;
    intelligence.setProductSelectionTestHookForTests(async ({ attempt }) => {
      if (attempt !== 1 || mutations) return;
      await adapter.runTransaction('products', products => {
        products.unshift(products.pop());
        return products;
      });
      mutations += 1;
    });
    const created = await store.createAutomationJob({
      type: 'SCORE_PRODUCTS',
      payload: { limit: 2, cursor: 4 },
      idempotencyKey: 'selection-rematerializes',
      requestedBy: 'round3-runtime-test',
    });
    const result = await intelligence.executeProductIntelligenceJob({ ...created.job, status: 'RUNNING' });
    intelligence.setProductSelectionTestHookForTests();
    assert.equal(result.updated, 2);
    assert.equal(mutations, 1);
    const scored = (await adapter.readCollection('products'))
      .filter(product => product.scoreCalculatedAt)
      .map(product => product.id)
      .sort();
    assert.deepEqual(scored, ['p4', 'p5']);
  });

  await test('continuous collection changes retain the transient code and bounded Worker retry', async () => {
    await scenario('selection-continuous-change');
    await adapter.writeCollection('products', Array.from({ length: 6 }, (_, index) => makeProduct(`c${index + 1}`)));
    let mutationCount = 0;
    intelligence.setProductSelectionTestHookForTests(async () => {
      await adapter.runTransaction('products', products => {
        products.push(products.shift());
        return products;
      });
      mutationCount += 1;
    });
    const created = await store.createAutomationJob({
      type: 'SCORE_PRODUCTS',
      payload: { limit: 2, cursor: 4 },
      idempotencyKey: 'selection-continuous-change',
      requestedBy: 'scheduler',
    });

    await worker.processAutomationBatch('round3-selection-worker', 1);
    let current = await store.getAutomationJob(created.job.id);
    assert.equal(current.status, 'RETRY_SCHEDULED');
    assert.equal(current.lastErrorCode, 'PRODUCT_SELECTION_SOURCE_CHANGED');
    assert.equal(current.lastErrorCategory, 'STORAGE_ERROR');
    assert.equal(current.retryable, true);
    assert.ok(Date.parse(current.nextRetryAt) > Date.now());
    assert.equal(mutationCount, 3);

    for (let attempt = 2; attempt <= current.maxAttempts; attempt += 1) {
      await adapter.runTransaction('automation-jobs', jobs => {
        const job = jobs.find(item => item.id === created.job.id);
        job.nextRetryAt = new Date(Date.now() - 1_000).toISOString();
        return jobs;
      });
      await worker.processAutomationBatch('round3-selection-worker', 1);
      current = await store.getAutomationJob(created.job.id);
    }
    intelligence.setProductSelectionTestHookForTests();
    assert.equal(current.status, 'FAILED');
    assert.equal(current.attemptCount, current.maxAttempts);
    assert.equal(current.lastErrorCode, 'PRODUCT_SELECTION_SOURCE_CHANGED');
    assert.equal(mutationCount, current.maxAttempts * 3);
    assert.equal((await adapter.readCollection('products')).some(product => product.scoreCalculatedAt), false);
  });

  await test('explicit product IDs remain stable across collection reordering', async () => {
    await scenario('selection-explicit-ids');
    const products = Array.from({ length: 6 }, (_, index) => makeProduct(`e${index + 1}`)).reverse();
    await adapter.writeCollection('products', products);
    const created = await store.createAutomationJob({
      type: 'SCORE_PRODUCTS',
      payload: { productIds: ['e2', 'e5'], limit: 2, cursor: 99 },
      idempotencyKey: 'selection-explicit-ids',
      requestedBy: 'round3-runtime-test',
    });
    await intelligence.executeProductIntelligenceJob({ ...created.job, status: 'RUNNING' });
    const scored = (await adapter.readCollection('products'))
      .filter(product => product.scoreCalculatedAt)
      .map(product => product.id)
      .sort();
    assert.deepEqual(scored, ['e2', 'e5']);
  });

  await test('selection preserves cancellation and fencing authority', async () => {
    await scenario('selection-authority');
    await adapter.writeCollection('products', [makeProduct('authority-product')]);
    const fencedJob = await store.createAutomationJob({
      type: 'SCORE_PRODUCTS',
      payload: { productIds: ['authority-product'] },
      idempotencyKey: 'selection-fenced',
      requestedBy: 'round3-runtime-test',
    });
    const [claimedFenced] = await store.claimAutomationJobs('round3-authority-worker', 1);
    await assert.rejects(
      intelligence.executeProductIntelligenceJob({ ...claimedFenced, claimToken: 'mock-stale-claim-token' }),
      error => error && (error.code === 'WORKER_FENCING_REJECTED' || error.message === 'WORKER_FENCING_REJECTED'),
    );

    await scenario('selection-cancelled');
    await adapter.writeCollection('products', [makeProduct('cancelled-product')]);
    const cancelledJob = await store.createAutomationJob({
      type: 'SCORE_PRODUCTS',
      payload: { productIds: ['cancelled-product'] },
      idempotencyKey: 'selection-cancelled',
      requestedBy: 'round3-runtime-test',
    });
    const [claimedCancelled] = await store.claimAutomationJobs('round3-cancel-worker', 1);
    assert.equal(claimedCancelled.id, cancelledJob.job.id);
    assert.ok(await store.cancelAutomationJob(cancelledJob.job.id, 'round3-runtime-test', 'Cancellation fixture'));
    await assert.rejects(
      intelligence.executeProductIntelligenceJob(claimedCancelled),
      error => error && (error.code === 'JOB_CANCELLED' || error.message === 'JOB_CANCELLED'),
    );
    assert.equal((await adapter.readCollection('products'))[0].scoreCalculatedAt, undefined);
    assert.ok(fencedJob.job.id);
  });

  await test('stable collection selection preserves deterministic behavior', async () => {
    await scenario('selection-stable');
    await adapter.writeCollection('products', Array.from({ length: 6 }, (_, index) => makeProduct(`s${index + 1}`)));
    const created = await store.createAutomationJob({
      type: 'SCORE_PRODUCTS',
      payload: { limit: 2, cursor: 4 },
      idempotencyKey: 'selection-stable',
      requestedBy: 'round3-runtime-test',
    });
    await intelligence.executeProductIntelligenceJob({ ...created.job, status: 'RUNNING' });
    const scored = (await adapter.readCollection('products'))
      .filter(product => product.scoreCalculatedAt)
      .map(product => product.id)
      .sort();
    assert.deepEqual(scored, ['s5', 's6']);
  });

  await test('active automation read filter excludes terminal jobs without mutating them', async () => {
    await scenario('active-automation-filter');
    const active = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: {},
      idempotencyKey: 'active-filter-pending',
      requestedBy: 'round3-runtime-test',
    });
    const terminal = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: {},
      idempotencyKey: 'active-filter-terminal',
      requestedBy: 'round3-runtime-test',
    });
    assert.ok(await store.cancelAutomationJob(terminal.job.id, 'round3-runtime-test', 'Terminal filter fixture'));
    const result = await store.listAutomationJobs({ activeOnly: true, page: 1, pageSize: 20 });
    assert.ok(result.items.some(item => item.id === active.job.id));
    assert.equal(result.items.some(item => item.id === terminal.job.id), false);
    assert.equal((await store.getAutomationJob(terminal.job.id)).status, 'CANCELLED');
  });

  intelligence.setProductSelectionTestHookForTests();
  console.log(`\nROUND 3 runtime recovery: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), rootTempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
