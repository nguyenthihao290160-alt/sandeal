/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-lifecycle-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function candidate(sourceId, overrides = {}) {
  const payload = {
    title: `Tai nghe Bluetooth Pro ${sourceId}`,
    description: 'Tai nghe không dây có hộp sạc, thông tin được ghi nhận trực tiếp từ nguồn sản phẩm.',
    kind: 'product',
    platform: 'website',
    originalUrl: `https://${sourceId}.merchant.example/products/headset`,
    affiliateUrl: `https://${sourceId}.merchant.example/go/headset?affiliate=fixture`,
    imageUrl: `https://${sourceId}.merchant.example/images/headset.jpg`,
    imageCandidates: [],
    price: 1500000,
    salePrice: 1200000,
    currency: 'VND',
    category: 'Âm thanh',
    brand: 'Fixture Audio',
    model: `Model ${sourceId}`,
    sku: `SKU-${sourceId}`,
    gtin: `893${String(Math.abs(sourceId.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0))).padStart(10, '0').slice(0, 10)}`,
    specifications: { connection: 'Bluetooth 5.3', warranty: '12 tháng', battery: '30 giờ' },
    rawSourceKind: 'product_feed',
    verifiedSource: true,
    autoPublishEligible: true,
    sourceQualityScore: 98,
    isolatedHealthFixture: 'healthy',
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
  const lifecycle = require('../src/lib/autonomous/lifecycleStore.ts');
  const evidence = require('../src/lib/autonomous/evidenceGraph.ts');

  for (const collection of [
    'candidate-queue', 'products', 'automation-jobs', 'automation-control', 'automation-audit',
    'automation-circuits', 'automation-ai-usage', 'automation-manual-tasks', 'operation-journal',
    'product-lifecycle-events', 'evidence-facts', 'domain-circuit-breakers',
  ]) await adapter.writeCollection(collection, []);
  await store.updateAutomationControl({ mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: false, ingestionPaused: false, workerPaused: false, schedulerPaused: false, killSwitch: false }, 'gate4-test');
  let networkCalls = 0;
  global.fetch = async () => { networkCalls += 1; throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_LIFECYCLE'); };

  async function run(input, workerId) {
    const queued = await queue.enqueueCandidate(input);
    await bridge.bridgeCandidatesToDurableJobs({ limit: 100 });
    await worker.processAutomationBatch(workerId, 10);
    const job = (await store.getAllAutomationJobs()).find(item => item.payload.candidateId === queued.item.id);
    const product = (await products.getAllProducts()).find(item => item.sourceId === input.sourceId);
    return { queued: await queue.getCandidateById(queued.item.id), job, product };
  }

  await test('disguised voucher is classified and quarantined before any network probe', async () => {
    const before = networkCalls;
    const result = await run(candidate('voucher-one', {
      title: 'Mã giảm 10K cho đơn hàng từ 99K',
      description: 'Voucher freeship áp dụng toàn gian hàng, tối đa 10K.',
      kind: 'product',
      rawSourceKind: 'voucher',
      price: undefined,
      salePrice: undefined,
      originalUrl: 'https://voucher.merchant.example/campaign/sale',
      isolatedHealthFixture: undefined,
    }), 'gate4-voucher-worker');
    assert.equal(result.job.status, 'SUCCEEDED');
    assert.equal(result.queued.status, 'discarded');
    assert.equal(result.product.recordType, 'VOUCHER');
    assert.equal(result.product.lifecycleState, 'QUARANTINED');
    assert.equal(result.product.publicHidden, true);
    assert.equal(networkCalls, before);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'AUTO_SAFE_PUBLISH' && job.payload.productId === result.product.id).length, 0);
  });

  await test('incomplete claimed product is quarantined without probing or blocking the batch', async () => {
    const before = networkCalls;
    const result = await run(candidate('missing-price-two', { price: undefined, salePrice: undefined, isolatedHealthFixture: undefined }), 'gate4-incomplete-worker');
    assert.equal(result.job.status, 'SUCCEEDED');
    assert.equal(result.queued.status, 'needs_review');
    assert.equal(result.product.recordType, 'PRODUCT');
    assert.equal(result.product.lifecycleState, 'QUARANTINED');
    assert.ok(result.product.quarantineReasons.includes('classification_cross_check_failed'));
    assert.equal(networkCalls, before);
  });

  await test('healthy product reaches a terminal evidence-backed autonomous state in SHADOW', async () => {
    const result = await run(candidate('healthy-three'), 'gate4-healthy-worker');
    assert.equal(result.job.status, 'SUCCEEDED');
    assert.equal(result.queued.status, 'completed');
    assert.equal(result.product.recordType, 'PRODUCT');
    assert.equal(result.product.lifecycleState, 'READY_FOR_PUBLISH');
    assert.ok(result.product.identity?.identityHash);
    assert.equal(result.product.duplicateStatus, 'CLEAR');
    assert.ok(result.product.evidenceFactIds.length >= 7);
    const facts = await evidence.listProductEvidence(result.product.id);
    assert.equal(facts.length, result.product.evidenceFactIds.length);
    assert.ok(facts.every(fact => fact.productId === result.product.id && fact.status === 'ACTIVE'));
    assert.equal(result.product.confidences.publish, Math.min(
      result.product.confidences.classification, result.product.confidences.source, result.product.confidences.price,
      result.product.confidences.image, result.product.confidences.health, result.product.confidences.duplicate,
      result.product.confidences.contentEvidenceCoverage, result.product.confidences.editorial,
    ));
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'AUTO_SAFE_PUBLISH' && job.payload.productId === result.product.id).length, 0);
    const events = await lifecycle.listLifecycleTransitionEvents(result.product.id);
    assert.deepEqual(events.map(event => event.nextState), ['STAGED', 'CLASSIFIED', 'NORMALIZED', 'VERIFYING', 'CONTENT_PREPARING', 'READY_FOR_PUBLISH']);
    assert.ok(events.every(event => event.status === 'APPLIED' && event.actor.jobId === result.job.id));
  });

  await test('transient health failure resumes the same job without duplicate lifecycle facts', async () => {
    const input = candidate('retry-four', { isolatedHealthFixture: 'temporary_failure' });
    const queued = await queue.enqueueCandidate(input);
    await bridge.bridgeCandidatesToDurableJobs({ limit: 100 });
    await worker.processAutomationBatch('gate4-retry-worker', 10);
    const job = (await store.getAllAutomationJobs()).find(item => item.payload.candidateId === queued.item.id);
    assert.equal(job.status, 'RETRY_SCHEDULED');
    const product = (await products.getAllProducts()).find(item => item.sourceId === input.sourceId);
    assert.equal(product.lifecycleState, 'RETRY_SCHEDULED');
    const past = new Date(Date.now() - 1000).toISOString();
    await adapter.runTransaction('candidate-queue', items => {
      const item = items.find(entry => entry.id === queued.item.id);
      item.nextAttemptAt = past;
      item.payload.isolatedHealthFixture = 'healthy';
      return items;
    });
    await adapter.runTransaction('automation-jobs', items => {
      const item = items.find(entry => entry.id === job.id);
      item.nextRetryAt = past;
      return items;
    });
    await adapter.writeCollection('domain-circuit-breakers', []);
    await worker.processAutomationBatch('gate4-retry-worker-restarted', 10);
    const completed = await store.getAutomationJob(job.id);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(completed.attemptCount, 2);
    const events = await lifecycle.listLifecycleTransitionEvents(product.id);
    assert.equal(new Set(events.map(event => event.transitionKey)).size, events.length);
    const facts = await evidence.listProductEvidence(product.id);
    assert.equal(new Set(facts.map(fact => fact.observationKey)).size, facts.length);
  });

  await test('strong cross-source identity attaches one offer and keeps the duplicate entity quarantined', async () => {
    const canonical = (await products.getAllProducts()).find(item => item.sourceId === 'healthy-three');
    const input = candidate('second-offer-five', {
      title: 'Tai nghe Bluetooth Pro cùng mã GTIN',
      gtin: canonical.gtin,
      originalUrl: 'https://backup-merchant.example/products/headset-backup',
      affiliateUrl: 'https://backup-merchant.example/go/headset-backup?affiliate=fixture',
      imageUrl: 'https://backup-merchant.example/images/headset-backup.jpg',
    });
    const result = await run(input, 'gate4-identity-worker');
    assert.equal(result.job.status, 'SUCCEEDED');
    assert.equal(result.queued.status, 'completed');
    const duplicate = (await products.getAllProducts()).find(item => item.sourceId === input.sourceId);
    const refreshedCanonical = await products.getProductById(canonical.id);
    assert.equal(duplicate.lifecycleState, 'QUARANTINED');
    assert.equal(duplicate.duplicateStatus, 'MERGED');
    assert.equal(duplicate.duplicateGroupId, canonical.id);
    assert.equal(refreshedCanonical.offers.length, 2);
    assert.equal(new Set(refreshedCanonical.offers.map(offer => offer.id)).size, 2);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'AUTO_SAFE_PUBLISH' && job.payload.productId === duplicate.id).length, 0);
  });

  console.log(`\nPROMPT10 Gate 4 lifecycle integration: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
