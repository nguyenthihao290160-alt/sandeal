/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testAuthValue = ['local', 'only', 'value'].join('-');

const tempDir = path.join(process.cwd(), '.test-tmp', `sandeal-prompt08-hardening-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'hardening-test';
process.env.BASIC_AUTH_PASSWORD = testAuthValue;
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
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
    console.error(`FAIL ${name}\n${error?.stack || error}`);
  }
}

function product(id, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id,
    title: `San pham chinh hang ${id}`,
    slug: id,
    description: 'Thong tin san pham day du va co nguon duoc xac minh.',
    kind: 'product',
    platform: 'website',
    source: 'website',
    originalUrl: `https://merchant.example/${id}`,
    canonicalProductUrl: `https://merchant.example/${id}`,
    canonicalUrlSource: 'manual',
    canonicalUrlStatus: 'verified',
    canonicalUrlVerifiedAt: now,
    affiliateUrl: `https://merchant.example/${id}?aff_id=local-test`,
    affiliateUrlSource: 'manual',
    affiliateUrlStatus: 'verified',
    affiliateUrlVerifiedAt: now,
    imageUrl: `https://merchant.example/${id}.jpg`,
    price: 100_000,
    salePrice: 90_000,
    currency: 'VND',
    category: 'Test',
    brand: 'SanDeal Test',
    sku: `SKU-${id}`,
    tags: [], benefits: [], warnings: [],
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
    imageUrlHttpStatus: 200,
    imageContentType: 'image/jpeg',
    linkLastCheckedAt: now,
    affiliateLastCheckedAt: now,
    imageLastCheckedAt: now,
    priceObservedAt: now,
    priceTruthState: 'FRESH',
    sourceHash: `source-${id}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const products = require('../src/lib/storage/products.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const safePublish = require('../src/lib/safePublish.ts');
  const publicFilter = require('../src/lib/publicProductFilter.ts');
  const seo = require('../src/lib/seo/productSeo.ts');
  const jobs = require('../src/lib/product-intelligence/jobs.ts');
  const priceHistory = require('../src/lib/product-intelligence/priceHistory.ts');
  const health = require('../src/lib/bots/productHealthCheck.ts');
  const automation = require('../src/lib/automation/store.ts');
  const jobDetailRoute = require('../src/app/api/automation/jobs/[id]/route.ts');
  const jobActionRoute = require('../src/app/api/automation/jobs/[id]/[action]/route.ts');
  const { NextRequest } = require('next/server');
  const auth = `Basic ${Buffer.from(`hardening-test:${testAuthValue}`).toString('base64')}`;

  async function reset(...names) {
    for (const name of names) await adapter.writeCollection(name, []);
  }

  function published(id, overrides = {}) {
    const base = product(id, overrides);
    const reviewContent = editorial.generateEditorialReview(base, [], base.updatedAt);
    const result = safePublish.applySafePublishDecision({ ...base, reviewContent }, base.updatedAt);
    assert.equal(result.status, 'published');
    return result;
  }

  await test('public selector requires published and blocks high duplicate confidence', () => {
    const ready = published('public-ready');
    assert.equal(publicFilter.isPublicSafeProduct(ready), true);
    assert.equal(publicFilter.isPublicSafeProduct({ ...ready, status: 'approved' }), false);
    const duplicate = { ...ready, duplicateConfidence: 0.95 };
    assert.equal(publicFilter.isPublicSafeProduct(duplicate), false);
    assert.equal(seo.getProductIndexingDecision(duplicate).reasons.includes('duplicate_high_confidence'), true);
  });

  await test('scheduler batch honors limit and rotates by deterministic bucket', () => {
    const inventory = Array.from({ length: 10 }, (_, index) => product(`p${String(index).padStart(2, '0')}`));
    assert.deepEqual(jobs.selectDeterministicProductBatch(inventory, { limit: 3, scheduleBucket: '1' }).map(item => item.id), ['p03', 'p04', 'p05']);
    assert.deepEqual(jobs.selectDeterministicProductBatch(inventory, { limit: 3, scheduleBucket: '2' }).map(item => item.id), ['p06', 'p07', 'p08']);
    assert.deepEqual(jobs.selectDeterministicProductBatch(inventory, { limit: 3, cursor: 8 }).map(item => item.id), ['p08', 'p09', 'p00']);
  });

  await test('price snapshots distinguish checkpoints from actual price changes', async () => {
    await reset('price-history');
    const base = product('price-change');
    const first = await priceHistory.capturePriceSnapshot(base, 'price-first', { capturedAt: '2026-07-10T00:00:00.000Z' });
    const checkpoint = await priceHistory.capturePriceSnapshot(base, 'price-checkpoint', { forceCheckpoint: true, capturedAt: '2026-07-11T01:00:00.000Z' });
    const changed = await priceHistory.capturePriceSnapshot({ ...base, salePrice: 80_000 }, 'price-changed', { capturedAt: '2026-07-12T00:00:00.000Z' });
    assert.equal(first.priceChanged, false);
    assert.equal(checkpoint.created, true);
    assert.equal(checkpoint.priceChanged, false);
    assert.equal(changed.priceChanged, true);
  });

  await test('health redirects are checked at every hop without real network', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    };
    const result = await health.checkLinkHealth('https://public.example/start', { fetchImpl, resolveDns: false });
    assert.equal(result.status, 'forbidden');
    assert.equal(calls, 1);
  });

  await test('bulk link and image rechecks only probe the requested target', async () => {
    await reset('products', 'automation-control', 'automation-jobs');
    const stored = product('health-target');
    await adapter.writeCollection('products', [stored]);
    const originalFetch = global.fetch;
    const requested = [];
    global.fetch = async (url) => {
      requested.push(String(url));
      const isImage = String(url).endsWith('.jpg');
      return new Response('', { status: 200, headers: isImage ? { 'content-type': 'image/jpeg' } : {} });
    };
    try {
      await jobs.executeProductIntelligenceJob({
        id: 'bulk-link-job', type: 'BULK_PRODUCT_OPERATION', status: 'RUNNING', payload: { action: 'recheck_link', productIds: [stored.id] },
        priority: 50, idempotencyKey: 'bulk-link-hardening', operationId: 'bulk-link-operation', requestedBy: 'test', approvalStatus: 'NOT_REQUIRED',
        riskLevel: 'LOW', dryRun: false, attemptCount: 1, maxAttempts: 1, scheduledAt: stored.updatedAt, createdAt: stored.updatedAt, updatedAt: stored.updatedAt,
      });
      assert.equal(requested.length, 1);
      assert.equal(requested[0].includes('.jpg'), false);
      const afterLink = await products.getProductById(stored.id);
      assert.equal(afterLink.imageLastCheckedAt, stored.imageLastCheckedAt);
      requested.length = 0;
      await jobs.executeProductIntelligenceJob({
        id: 'bulk-image-job', type: 'BULK_PRODUCT_OPERATION', status: 'RUNNING', payload: { action: 'recheck_image', productIds: [stored.id] },
        priority: 50, idempotencyKey: 'bulk-image-hardening', operationId: 'bulk-image-operation', requestedBy: 'test', approvalStatus: 'NOT_REQUIRED',
        riskLevel: 'LOW', dryRun: false, attemptCount: 1, maxAttempts: 1, scheduledAt: stored.updatedAt, createdAt: stored.updatedAt, updatedAt: stored.updatedAt,
      });
      assert.equal(requested.length, 1);
      assert.equal(requested[0].includes('.jpg'), true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('running cooperative job observes cancellation before storing health result', async () => {
    await reset('products', 'automation-control', 'automation-jobs', 'automation-audit');
    const stored = product('cancel-health');
    await adapter.writeCollection('products', [stored]);
    const created = await automation.createAutomationJob({
      type: 'RECHECK_PRODUCT_HEALTH', payload: { productIds: [stored.id], healthTarget: 'link' }, idempotencyKey: 'cancel-health-hardening',
      requestedBy: 'test', riskLevel: 'LOW', maxAttempts: 1,
    });
    const [claimed] = await automation.claimAutomationJobs('hardening-worker', 1);
    const originalFetch = global.fetch;
    global.fetch = async () => {
      await automation.cancelAutomationJob(created.job.id, 'hardening-admin', 'Stop cooperative health check');
      return new Response('', { status: 200 });
    };
    try {
      await assert.rejects(() => jobs.executeProductIntelligenceJob(claimed), /JOB_CANCELLED/);
      assert.equal((await automation.getAutomationJob(created.job.id)).status, 'CANCELLED');
      assert.equal((await products.getProductById(stored.id)).linkLastCheckedAt, stored.linkLastCheckedAt);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('job detail and action routes enforce MANAGE_AUTOMATION', async () => {
    await reset('automation-control', 'automation-jobs', 'automation-audit');
    const created = await automation.createAutomationJob({
      type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'route-permission-hardening', requestedBy: 'test', riskLevel: 'LOW',
    });
    process.env.SANDEAL_ADMIN_PERMISSIONS = 'VIEW_PRODUCTS';
    try {
      const detail = await jobDetailRoute.GET(new NextRequest(`http://localhost/api/automation/jobs/${created.job.id}`, { headers: { authorization: auth } }), { params: Promise.resolve({ id: created.job.id }) });
      const action = await jobActionRoute.POST(new NextRequest(`http://localhost/api/automation/jobs/${created.job.id}/cancel`, {
        method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Permission test cancellation' }),
      }), { params: Promise.resolve({ id: created.job.id, action: 'cancel' }) });
      assert.equal(detail.status, 403);
      assert.equal(action.status, 403);
    } finally {
      process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
    }
  });

  console.log(`\nBackend hardening targeted: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
