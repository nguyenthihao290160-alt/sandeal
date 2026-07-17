/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const tempDir = path.join(root, '.test-tmp', `prompt10-shadow-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function candidate(sourceId, overrides = {}) {
  const payload = {
    title: `Tai nghe Bluetooth Shadow ${sourceId}`,
    description: 'Sản phẩm nguồn fixture có dữ liệu giá, merchant và đặc tả đủ để kiểm tra pipeline cô lập.',
    kind: 'product', platform: 'website',
    originalUrl: `https://${sourceId}.merchant.example/products/headset`,
    affiliateUrl: `https://${sourceId}.merchant.example/go/headset?affiliate=fixture`,
    imageUrl: `https://${sourceId}.merchant.example/images/headset.jpg`, imageCandidates: [],
    price: 1500000, salePrice: 1200000, currency: 'VND', category: 'Âm thanh', brand: 'Fixture Audio',
    model: `Shadow ${sourceId}`, sku: `SHADOW-${sourceId}`,
    gtin: `893${String(Math.abs(sourceId.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0))).padStart(10, '0').slice(0, 10)}`,
    specifications: { connection: 'Bluetooth 5.3', warranty: '12 tháng', battery: '30 giờ' },
    rawSourceKind: 'product_feed', verifiedSource: true, autoPublishEligible: true,
    sourceQualityScore: 98, isolatedHealthFixture: 'healthy',
    ...overrides,
  };
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { source: 'accesstrade', sourceId, priority: 95, contentHash: sourceHash, sourceHash, payload };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const bridge = require('../src/lib/automation/candidateBridge.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const products = require('../src/lib/storage/products.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const actions = require('../src/lib/automation/productActions.ts');

  const collections = [
    'candidate-queue', 'products', 'automation-jobs', 'automation-control', 'automation-audit',
    'automation-circuits', 'automation-ai-usage', 'automation-manual-tasks', 'operation-journal',
    'product-lifecycle-events', 'evidence-facts', 'domain-circuit-breakers', 'publication-audit',
    'automation-outbound-events', 'automation-canary',
  ];
  let networkCalls = 0;
  global.fetch = async () => { networkCalls += 1; throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_SHADOW'); };

  async function reset() {
    for (const collection of collections) await adapter.writeCollection(collection, []);
    await settings.updateAutomationSettings({ enabled: true, launchEnabled: false, sourceScanEnabled: true });
    await store.updateAutomationControl({
      mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: true, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false,
    }, 'shadow-safety-test');
  }

  await test('valid and transient candidates share one SHADOW batch without public side effects', async () => {
    await reset();
    const healthy = await queue.enqueueCandidate(candidate('shadow-healthy'));
    const transient = await queue.enqueueCandidate(candidate('shadow-transient', { isolatedHealthFixture: 'temporary_failure' }));
    assert.equal(healthy.queued, true); assert.equal(transient.queued, true);
    const bridged = await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'autopilot-worker', limit: 10 });
    assert.equal(bridged.created, 2);
    const run = await worker.processAutomationBatch('shadow-batch-worker', 10);
    assert.equal(run.claimed, 2); assert.equal(run.succeeded, 1); assert.equal(run.failed, 1);
    const jobs = await store.getAllAutomationJobs();
    const healthyJob = jobs.find(job => job.payload.candidateId === healthy.item.id);
    const transientJob = jobs.find(job => job.payload.candidateId === transient.item.id);
    assert.equal(healthyJob.status, 'SUCCEEDED'); assert.equal(transientJob.status, 'RETRY_SCHEDULED');
    assert.equal(healthyJob.result.reviewed, 1); assert.equal(healthyJob.result.published, 0);
    assert.equal(healthyJob.progress.percentage, 100);
    assert.equal(healthyJob.disclosure.aiRequests, 0);
    const healthyProduct = (await products.getAllProducts()).find(product => product.sourceId === 'shadow-healthy');
    assert.equal(healthyProduct.lifecycleState, 'READY_FOR_PUBLISH');
    assert.equal(healthyProduct.status, 'needs_review'); assert.equal(healthyProduct.publicHidden, true);
    assert.equal((await products.getPublicProducts()).length, 0);
    assert.equal(jobs.some(job => job.type === 'AUTO_SAFE_PUBLISH'), false);
    assert.equal(networkCalls, 0, 'isolated health fixture must not call a live provider');
  });

  await test('unsafe candidate is quarantined and does not stop the following valid candidate', async () => {
    await reset();
    const unsafe = await queue.enqueueCandidate(candidate('shadow-unsafe', {
      title: 'Mã giảm 50K toàn sàn', kind: 'product', rawSourceKind: 'voucher',
      price: undefined, salePrice: undefined, isolatedHealthFixture: undefined,
    }));
    const healthy = await queue.enqueueCandidate(candidate('shadow-after-unsafe'));
    await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'autopilot-worker', limit: 10 });
    const run = await worker.processAutomationBatch('shadow-quarantine-worker', 10);
    assert.equal(run.claimed, 2); assert.equal(run.succeeded, 2);
    const allProducts = await products.getAllProducts();
    const unsafeProduct = allProducts.find(product => product.sourceId === 'shadow-unsafe');
    const healthyProduct = allProducts.find(product => product.sourceId === 'shadow-after-unsafe');
    assert.equal(unsafeProduct.lifecycleState, 'QUARANTINED'); assert.equal(unsafeProduct.publicHidden, true);
    assert.equal((await queue.getCandidateById(unsafe.item.id)).status, 'discarded');
    assert.equal(healthyProduct.lifecycleState, 'READY_FOR_PUBLISH'); assert.equal(healthyProduct.publicHidden, true);
    assert.equal((await products.getPublicProducts()).length, 0);
  });

  await test('SHADOW publish request is blocked by the paused lane with a durable reason', async () => {
    await reset();
    const queued = await queue.enqueueCandidate(candidate('shadow-publish-request'));
    await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'autopilot-worker', limit: 10 });
    await worker.processAutomationBatch('shadow-ready-worker', 10);
    const product = (await products.getAllProducts()).find(item => item.sourceId === 'shadow-publish-request');
    const requested = await actions.enqueueProductAction({
      actor: 'dashboard-owner', action: 'safe_publish', productId: product.id,
      reason: 'Fixture yêu cầu xác minh publish lane đang đóng', idempotencyKey: 'shadow-manual-safe-publish-paused',
    });
    await store.approveAutomationJob(requested.job.id, 'dashboard-owner', 'Fixture approval for safety rejection', true);
    const run = await worker.processAutomationBatch('shadow-publish-worker', 1);
    assert.equal(run.failed, 1);
    const failedJob = await store.getAutomationJob(requested.job.id);
    assert.equal(failedJob.status, 'FAILED'); assert.equal(failedJob.lastErrorCode, 'SAFETY_POLICY_BLOCKED');
    assert.match(failedJob.lastErrorMessage, /PUBLISH_LANE_PAUSED/);
    const unchanged = await products.getProductById(product.id);
    assert.equal(unchanged.status, 'needs_review'); assert.equal(unchanged.publicHidden, true);
  });

  await test('launch disabled and SHADOW mode independently block an approved worker job', async () => {
    await reset();
    const queued = await queue.enqueueCandidate(candidate('shadow-launch-guard'));
    await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'autopilot-worker', limit: 10 });
    await worker.processAutomationBatch('shadow-launch-ready-worker', 10);
    const product = (await products.getAllProducts()).find(item => item.sourceId === 'shadow-launch-guard');

    await store.updateAutomationControl({ mode: 'CANARY', effectiveMode: 'CANARY', publishPaused: false }, 'shadow-safety-test');
    const launchBlocked = await actions.enqueueProductAction({
      actor: 'dashboard-owner', action: 'safe_publish', productId: product.id,
      reason: 'Fixture verifies launch opt-in', idempotencyKey: 'shadow-launch-disabled-publish',
    });
    await store.approveAutomationJob(launchBlocked.job.id, 'dashboard-owner', 'Fixture approval', true);
    assert.equal((await worker.processAutomationBatch('shadow-launch-worker', 1)).failed, 1);
    assert.match((await store.getAutomationJob(launchBlocked.job.id)).lastErrorMessage, /PUBLISH_LAUNCH_DISABLED/);

    await settings.updateAutomationSettings({ launchEnabled: true });
    await store.updateAutomationControl({ mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: false }, 'shadow-safety-test');
    const modeBlocked = await actions.enqueueProductAction({
      actor: 'dashboard-owner', action: 'safe_publish', productId: product.id,
      reason: 'Fixture verifies SHADOW mode', idempotencyKey: 'shadow-mode-disabled-publish',
    });
    await store.approveAutomationJob(modeBlocked.job.id, 'dashboard-owner', 'Fixture approval', true);
    assert.equal((await worker.processAutomationBatch('shadow-mode-worker', 1)).failed, 1);
    assert.match((await store.getAutomationJob(modeBlocked.job.id)).lastErrorMessage, /PUBLISH_MODE_BLOCKED/);
    assert.equal((await products.getProductById(product.id)).publicHidden, true);
  });

  await test('generic storage, missing worker authorization, kill switch, and paid settings all fail closed', async () => {
    await reset();
    const queued = await queue.enqueueCandidate(candidate('shadow-direct-guard'));
    await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'autopilot-worker', limit: 10 });
    await worker.processAutomationBatch('shadow-direct-ready-worker', 10);
    const product = (await products.getAllProducts()).find(item => item.sourceId === 'shadow-direct-guard');
    await assert.rejects(() => products.updateProduct(product.id, { status: 'published', publicHidden: false }), /SAFE_PUBLISH_JOB_REQUIRED/);
    await assert.rejects(() => products.publishCanonicalProductTransaction(product.id, { status: 'published' }), /SAFE_PUBLISH_JOB_REQUIRED/);
    await assert.rejects(() => settings.updateAutomationSettings({ allowPaidAi: true }), /Policy violation/);

    const requested = await actions.enqueueProductAction({
      actor: 'dashboard-owner', action: 'safe_publish', productId: product.id,
      reason: 'Fixture verifies kill switch priority', idempotencyKey: 'shadow-kill-switch-publish',
    });
    await store.approveAutomationJob(requested.job.id, 'dashboard-owner', 'Fixture approval', true);
    await store.updateAutomationControl({ killSwitch: true, mode: 'EMERGENCY_STOP', effectiveMode: 'SHADOW' }, 'shadow-safety-test');
    assert.equal((await worker.processAutomationBatch('shadow-killed-worker', 1)).claimed, 0);
    assert.equal((await store.getAutomationJob(requested.job.id)).status, 'PENDING');
    assert.equal((await products.getProductById(product.id)).publicHidden, true);
  });

  console.log(`\nPROMPT10 SHADOW safety: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
