/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-prompt08-growth-alerts-'));
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt08-growth-test';
process.env.BASIC_AUTH_PASSWORD = 'local-only-password';
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';

require('./register-typescript.cjs');

const TEST_NOW = Date.parse('2026-07-14T03:00:00.000Z');
const auth = `Basic ${Buffer.from('prompt08-growth-test:local-only-password').toString('base64')}`;
const jsonHeaders = { authorization: auth, 'content-type': 'application/json' };
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

function product(id, overrides = {}) {
  const now = new Date(TEST_NOW).toISOString();
  return {
    id,
    title: `Sản phẩm ${id}`,
    slug: id,
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}?utm_source=sandeal`,
    affiliateUrl: `https://merchant.example/products/${id}?aff_id=track-${id}`,
    price: 1_000_000,
    salePrice: 800_000,
    currency: 'VND',
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    linkLastCheckedAt: now,
    affiliateLastCheckedAt: now,
    imageLastCheckedAt: now,
    lastEditorialCheckAt: now,
    lastSeenAt: now,
    priceLastChangedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const affiliateLinks = require('../src/lib/product-intelligence/affiliateLinks.ts');
  const alerts = require('../src/lib/product-intelligence/alerts.ts');
  const affiliateRoute = require('../src/app/api/dashboard/affiliate-links/route.ts');
  const alertsRoute = require('../src/app/api/dashboard/alerts/route.ts');
  const recommendationsRoute = require('../src/app/api/dashboard/recommendations/route.ts');
  const automationStore = require('../src/lib/automation/store.ts');
  const automationSettings = require('../src/lib/storage/automationSettings.ts');
  const { NextRequest } = require('next/server');

  async function reset(...collections) {
    for (const collection of collections) await adapter.writeCollection(collection, []);
  }

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_GROWTH_ALERTS_TEST'); };

  await test('affiliate DTO is browser-safe and listing is server-paginated', async () => {
    await reset('products');
    const products = Array.from({ length: 23 }, (_, index) => product(`affiliate-${String(index).padStart(2, '0')}`, {
      affiliateSource: index % 2 ? 'provider-b' : 'provider-a',
    }));
    products[0].affiliateUrl = 'https://merchant.example/item?aff_id=visible-track&token=super-secret-token';
    products[1].affiliateUrl = 'http://127.0.0.1/private';
    products[2].affiliateHealthStatus = 'broken';
    await adapter.writeCollection('products', products);
    const safe = affiliateLinks.toAffiliateLinkAdminDto(products[0]);
    assert.equal(safe.trackingParameters.includes('aff_id'), true);
    assert.equal(safe.trackingCode, 'aff_id=visible-track');
    assert.equal(JSON.stringify(safe).includes('super-secret-token'), false);
    assert.equal(safe.canonicalUrl.includes('aff_id'), false);
    const unsafe = affiliateLinks.toAffiliateLinkAdminDto(products[1]);
    assert.equal(unsafe.status, 'unsafe');
    assert.equal(unsafe.affiliateUrl, undefined);
    const result = await affiliateLinks.listAffiliateLinks({ page: 2, pageSize: 10, sort: 'title' });
    assert.equal(result.items.length, 10);
    assert.deepEqual(result.pagination, { page: 2, pageSize: 10, totalItems: 23, totalPages: 3 });
    assert.deepEqual(result.providers, ['provider-a', 'provider-b']);
  });

  await test('affiliate API validates filters, caps pages and omits internal product fields', async () => {
    await reset('products');
    await adapter.writeCollection('products', [product('api-affiliate', { sourceHash: 'must-not-leak', rawData: { password: 'must-not-leak' } })]);
    const response = await affiliateRoute.GET(new NextRequest('http://localhost/api/dashboard/affiliate-links?page=1&pageSize=1', { headers: { authorization: auth } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.pagination.pageSize, 1);
    assert.equal(JSON.stringify(body).includes('must-not-leak'), false);
    assert.equal((await affiliateRoute.GET(new NextRequest('http://localhost/api/dashboard/affiliate-links?pageSize=51', { headers: { authorization: auth } }))).status, 400);
    assert.equal((await affiliateRoute.GET(new NextRequest('http://localhost/api/dashboard/affiliate-links?unknown=x', { headers: { authorization: auth } }))).status, 400);
  });

  await test('affiliate recheck API only enqueues an idempotent durable health job', async () => {
    await reset('products', 'automation-jobs', 'automation-audit', 'automation-control');
    await adapter.writeCollection('products', [
      product('queue-affiliate'),
      product('queue-unsafe', { affiliateUrl: 'http://169.254.169.254/private' }),
    ]);
    const request = () => new NextRequest('http://localhost/api/dashboard/affiliate-links', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ action: 'recheck', productIds: ['queue-affiliate', 'queue-unsafe', 'missing-product'] }),
    });
    const first = await affiliateRoute.POST(request());
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.deepEqual(firstBody.data.accepted, ['queue-affiliate']);
    assert.equal(firstBody.data.skipped.length, 2);
    const second = await affiliateRoute.POST(request());
    assert.equal(second.status, 200);
    const jobs = await automationStore.getAllAutomationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'RECHECK_PRODUCT_HEALTH');
    assert.deepEqual(jobs[0].payload, { productIds: ['queue-affiliate'], healthTarget: 'affiliate' });
    assert.equal(jobs[0].status, 'PENDING');
  });

  await test('affiliate API enforces server-side authentication and permissions', async () => {
    const anonymous = await affiliateRoute.GET(new NextRequest('http://localhost/api/dashboard/affiliate-links'));
    assert.equal(anonymous.status, 401);
    process.env.SANDEAL_ADMIN_PERMISSIONS = 'VIEW_ANALYTICS';
    try {
      const readable = await affiliateRoute.GET(new NextRequest('http://localhost/api/dashboard/affiliate-links', { headers: { authorization: auth } }));
      assert.equal(readable.status, 200);
      const forbidden = await affiliateRoute.POST(new NextRequest('http://localhost/api/dashboard/affiliate-links', {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'recheck', productIds: ['queue-affiliate'] }),
      }));
      assert.equal(forbidden.status, 403);
    } finally {
      process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
    }
  });

  await test('alert and recommendation status changes require permission and append audit operation IDs', async () => {
    await reset('product-alerts', 'recommended-actions', 'automation-audit');
    const now = new Date(TEST_NOW).toISOString();
    await adapter.writeCollection('product-alerts', [{
      id: 'alert-api-status', deduplicationKey: 'api:alert-status', type: 'low_quality', severity: 'attention',
      title: 'Cần bổ sung dữ liệu', message: 'Thiếu dữ liệu.', entityType: 'product', entityId: 'api-product',
      operationId: 'alert-evaluation', suggestedAction: 'Bổ sung dữ liệu.', status: 'new', createdAt: now, updatedAt: now,
    }]);
    await adapter.writeCollection('recommended-actions', [{
      id: 'recommendation-api-status', deduplicationKey: 'today:api-status', title: 'Xử lý dữ liệu', reason: 'Có dữ liệu cần xử lý.',
      priority: 'medium', objectCount: 1, impact: 'Cải thiện chất lượng.', estimatedTime: '5 phút', href: '/dashboard/products',
      completionCriteria: 'Dữ liệu được bổ sung.', status: 'new', createdAt: now,
    }]);
    const alertResponse = await alertsRoute.PATCH(new NextRequest('http://localhost/api/dashboard/alerts', {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ id: 'alert-api-status', status: 'acknowledged' }),
    }));
    assert.equal(alertResponse.status, 200);
    assert.ok(alertResponse.headers.get('x-operation-id'));
    process.env.SANDEAL_ADMIN_PERMISSIONS = 'VIEW_PRODUCTS';
    try {
      const forbidden = await recommendationsRoute.PATCH(new NextRequest('http://localhost/api/dashboard/recommendations', {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ id: 'recommendation-api-status', status: 'seen' }),
      }));
      assert.equal(forbidden.status, 403);
    } finally {
      process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
    }
    const recommendationResponse = await recommendationsRoute.PATCH(new NextRequest('http://localhost/api/dashboard/recommendations', {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ id: 'recommendation-api-status', status: 'seen' }),
    }));
    assert.equal(recommendationResponse.status, 200);
    assert.ok(recommendationResponse.headers.get('x-operation-id'));
    const audit = await adapter.readCollection('automation-audit');
    assert.deepEqual(audit.map(item => item.operationType), ['ALERT_STATUS_CHANGED', 'RECOMMENDATION_STATUS_CHANGED']);
    assert.equal(audit.every(item => item.actor === 'dashboard-admin'), true);
  });

  await test('alert evaluation uses real heartbeat, source, public and price-history evidence', async () => {
    await reset('products', 'price-history', 'product-alerts', 'automation-jobs', 'automation-control', 'automation-audit', 'automation-ai-usage', 'automation-circuits', 'token-vault');
    await automationSettings.updateAutomationSettings({ enabled: true });
    await adapter.writeCollection('automation-control', [{
      id: 'automation-control', workerPaused: false, schedulerPaused: false, killSwitch: false,
      timezone: 'Asia/Ho_Chi_Minh', updatedAt: new Date(TEST_NOW).toISOString(),
    }]);
    await automationStore.createAutomationJob({
      type: 'SCORE_PRODUCTS', payload: { productIds: ['alert-evidence'] }, idempotencyKey: 'alert-heartbeat-job-001',
      requestedBy: 'prompt08-test', riskLevel: 'MEDIUM',
    });
    await adapter.writeCollection('products', [product('alert-evidence', {
      source: 'accesstrade', status: 'published', publicHidden: false, needsVerification: false, lastSeenAt: '2026-06-01T00:00:00.000Z',
      priceLastChangedAt: '2026-06-01T00:00:00.000Z', linkLastCheckedAt: '2026-06-01T00:00:00.000Z',
      imageUrl: 'https://merchant.example/image.jpg', imageLastCheckedAt: '2026-06-01T00:00:00.000Z',
      lastEditorialCheckAt: '2026-05-01T00:00:00.000Z',
    })]);
    await adapter.writeCollection('price-history', [
      { id: 'price-old', productId: 'alert-evidence', source: 'accesstrade', price: 1_000_000, currency: 'VND', availability: 'available', capturedAt: '2026-07-14T01:00:00.000Z', operationId: 'price-old', sourceHash: 'old' },
      { id: 'price-new', productId: 'alert-evidence', source: 'accesstrade', price: 700_000, currency: 'VND', availability: 'available', capturedAt: '2026-07-14T02:00:00.000Z', operationId: 'price-new', sourceHash: 'new' },
    ]);
    await alerts.evaluateAlerts('evidence-alerts', TEST_NOW);
    const types = new Set((await alerts.listAlerts({ limit: 500 })).map(item => item.type));
    for (const type of ['worker_stale', 'scheduler_stale', 'source_stale', 'strong_price_variation', 'public_recheck']) {
      assert.equal(types.has(type), true, type);
    }
  });

  await test('ignored alerts stay quiet during cooldown and reopen the same record afterwards', async () => {
    await reset('products', 'product-alerts', 'automation-jobs', 'automation-control', 'automation-ai-usage', 'automation-circuits', 'token-vault', 'price-history');
    await automationSettings.updateAutomationSettings({ enabled: false });
    await adapter.writeCollection('products', [product('alert-cooldown', { linkHealthStatus: 'broken' })]);
    await alerts.evaluateAlerts('alert-cooldown-first', TEST_NOW);
    const initial = (await alerts.listAlerts({ limit: 500 })).find(item => item.type === 'broken_link');
    assert.ok(initial);
    await alerts.updateAlertStatus(initial.id, 'ignored', 'Đang chờ nhà bán cập nhật link.', TEST_NOW);
    await alerts.evaluateAlerts('alert-cooldown-hidden', TEST_NOW + 60 * 60_000);
    const hidden = (await alerts.listAlerts({ limit: 500 })).find(item => item.id === initial.id);
    assert.equal(hidden.status, 'ignored');
    await alerts.evaluateAlerts('alert-cooldown-reopen', TEST_NOW + 25 * 60 * 60_000);
    const reopened = (await alerts.listAlerts({ limit: 500 })).find(item => item.id === initial.id);
    assert.equal(reopened.status, 'new');
    const stored = await adapter.readCollection('product-alerts');
    assert.equal(stored.filter(item => item.deduplicationKey === initial.deduplicationKey).length, 1);
  });

  await test('snoozed recommendations are hidden until cooldown and never duplicate', async () => {
    await reset('products', 'product-alerts', 'recommended-actions', 'automation-control', 'token-vault');
    await adapter.writeCollection('products', [product('recommendation-price', { price: undefined, salePrice: undefined })]);
    const first = await alerts.generateRecommendedActions(TEST_NOW);
    const action = first.find(item => item.deduplicationKey === 'today:missing-price');
    assert.ok(action);
    await alerts.updateRecommendedAction(action.id, 'snoozed', undefined, TEST_NOW);
    const during = await alerts.generateRecommendedActions(TEST_NOW + 60 * 60_000);
    assert.equal(during.some(item => item.deduplicationKey === action.deduplicationKey), false);
    const after = await alerts.generateRecommendedActions(TEST_NOW + 25 * 60 * 60_000);
    const reopened = after.find(item => item.deduplicationKey === action.deduplicationKey);
    assert.ok(reopened);
    assert.equal(reopened.id, action.id);
    assert.equal(reopened.status, 'new');
    const stored = await adapter.readCollection('recommended-actions');
    assert.equal(stored.filter(item => item.deduplicationKey === action.deduplicationKey).length, 1);
  });

  const pageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'dashboard', 'affiliate-links', 'page.tsx'), 'utf8');
  assert.equal(pageSource.includes('/api/dashboard/affiliate-links'), true);
  assert.equal(pageSource.includes('affiliate-links.module.css'), true);

  global.fetch = originalFetch;
  console.log(`\nPrompt08 growth/alerts/affiliate links targeted: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(error => {
    failed += 1;
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
