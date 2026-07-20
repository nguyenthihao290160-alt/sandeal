/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt09-phase-c-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';

require('./register-typescript.cjs');

const TEST_NOW = '2026-07-15T04:00:00.000Z';
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
  return {
    id,
    title: `Verified fixture ${id}`,
    slug: `verified-fixture-${id}`,
    description: 'Source-backed fixture used only in isolated storefront tests.',
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=fixture`,
    imageUrl: `https://merchant.example/images/${id}.jpg`,
    gallery: [],
    price: 1500000,
    salePrice: 1200000,
    currency: 'VND',
    category: 'Audio',
    brand: 'Fixture Brand',
    sku: `SKU-${id}`,
    specifications: { connection: 'Bluetooth', model: `MODEL-${id}` },
    tags: ['verified-fixture'],
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
    linkLastCheckedAt: TEST_NOW,
    affiliateLastCheckedAt: TEST_NOW,
    imageLastCheckedAt: TEST_NOW,
    priceObservedAt: TEST_NOW,
    priceTruthState: 'FRESH',
    lastSeenAt: TEST_NOW,
    priceLastChangedAt: TEST_NOW,
    availability: 'available',
    sourceHash: `source-${id}`,
    qualityScore: 86,
    qualityBand: 'good',
    opportunityScore: 78,
    opportunityBand: 'recommended',
    dealScore: 82,
    dealBand: 'featured',
    dealReasons: ['Giá và nguồn hiện có đã vượt cổng dữ liệu công khai.'],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const safePublish = require('../src/lib/safePublish.ts');
  const publicFilter = require('../src/lib/publicProductFilter.ts');
  const publicProducts = require('../src/lib/product-intelligence/publicProducts.ts');
  const priceHistory = require('../src/lib/product-intelligence/priceHistory.ts');
  const publicProductsRoute = require('../src/app/api/public/products/route.ts');
  const publicEventsRoute = require('../src/app/api/public/events/route.ts');
  const outboundRoute = require('../src/app/go/[productId]/route.ts');
  const { NextRequest } = require('next/server');

  async function reset() {
    for (const collection of ['products', 'price-history', 'outbound-events', 'growth-daily']) {
      await adapter.writeCollection(collection, []);
    }
  }

  function publicProduct(id, overrides = {}) {
    const source = product(id, overrides);
    const reviewContent = editorial.generateEditorialReview(source, [], TEST_NOW);
    const published = safePublish.applySafePublishDecision({ ...source, reviewContent }, TEST_NOW);
    assert.equal(published.status, 'published', `fixture blocked: ${(published.publicBlockReasons || []).join(',')}`);
    assert.equal(publicFilter.isPublicSafeProduct(published), true);
    return published;
  }

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT09_PHASE_C'); };

  await test('public query validates extended filters and page bounds', () => {
    const parsed = publicProducts.parsePublicProductQuery(new URLSearchParams('brand=Fixture&priceTrend=down&sort=price_drop_desc&pageSize=50'));
    assert.equal(parsed.brand, 'Fixture');
    assert.equal(parsed.priceTrend, 'down');
    assert.equal(parsed.sort, 'price_drop_desc');
    assert.equal(parsed.pageSize, 50);
    assert.throws(() => publicProducts.parsePublicProductQuery(new URLSearchParams('pageSize=51')), error => error.field === 'pageSize');
    assert.throws(() => publicProducts.parsePublicProductQuery(new URLSearchParams('unknown=value')), error => error.field === 'unknown');
  });

  await test('public search covers brand SKU category source and specification without loading unsafe products', async () => {
    await reset();
    const searchable = publicProduct('searchable', {
      brand: 'Acme Search', sku: 'SKU-UNIQUE-42', category: 'Home Office', source: 'csv',
      specifications: { chipset: 'ZX-900', connectivity: 'WiFi 6' },
    });
    const blocked = product('blocked-record', { title: 'Acme Search private draft', rawData: { token: 'private-marker' } });
    await adapter.writeCollection('products', [searchable, blocked]);
    for (const term of ['Acme Search', 'SKU-UNIQUE-42', 'Home Office', 'csv', 'ZX-900']) {
      const result = await publicProducts.queryPublicProducts(new URLSearchParams({ q: term }));
      assert.deepEqual(result.items.map(item => item.id), ['searchable']);
      assert.equal(JSON.stringify(result).includes('private-marker'), false);
    }
  });

  await test('price movement, price-drop sorting and homepage sections use recorded snapshots only', async () => {
    await reset();
    const drop = publicProduct('price-drop', { salePrice: 900000 });
    const rise = publicProduct('price-rise', { salePrice: 1300000, dealScore: 76 });
    await adapter.writeCollection('products', [drop, rise]);
    await priceHistory.capturePriceSnapshot({ ...drop, salePrice: 1200000 }, 'price-drop-old', { capturedAt: '2026-07-10T00:00:00.000Z' });
    await priceHistory.capturePriceSnapshot({ ...drop, salePrice: 900000 }, 'price-drop-new', { capturedAt: '2026-07-11T00:00:00.000Z' });
    await priceHistory.capturePriceSnapshot({ ...rise, salePrice: 1000000 }, 'price-rise-old', { capturedAt: '2026-07-10T00:00:00.000Z' });
    await priceHistory.capturePriceSnapshot({ ...rise, salePrice: 1300000 }, 'price-rise-new', { capturedAt: '2026-07-11T00:00:00.000Z' });

    const drops = await publicProducts.queryPublicProducts(new URLSearchParams('priceTrend=down&sort=price_drop_desc'));
    assert.deepEqual(drops.items.map(item => item.id), ['price-drop']);
    assert.equal(drops.items[0].priceMovement.direction, 'down');
    assert.equal(drops.items[0].priceMovement.percent, 25);
    const homepage = await publicProducts.getPublicHomepageData();
    assert.deepEqual(homepage.priceDrops.map(item => item.id), ['price-drop']);
    assert.ok(homepage.verifiedRecently.length > 0);
    assert.ok(homepage.highQuality.length > 0);
  });

  await test('detail and card DTOs allowlist fields, sanitize warnings and filter gallery URLs', async () => {
    await reset();
    const safe = publicProduct('dto-safe', {
      dataIssues: ['price_outlier_internal_rule_91'],
      gallery: [
        'javascript:alert(1)',
        'https://merchant.example/images/placeholder-demo.jpg',
        'https://merchant.example/images/dto-safe-alt.jpg',
      ],
      rawData: { apiKey: 'must-not-leak' },
      trackingCode: 'private-code',
    });
    await adapter.writeCollection('products', [safe]);
    const result = await publicProducts.getPublicProductBySlugSafe(safe.slug);
    assert.ok(result);
    const serialized = JSON.stringify(result.detail);
    assert.equal(result.detail.outboundHref, '/go/dto-safe');
    assert.deepEqual(result.detail.gallery, [
      'https://merchant.example/images/dto-safe.jpg',
      'https://merchant.example/images/dto-safe-alt.jpg',
    ]);
    assert.deepEqual(result.detail.warnings, ['Giá cần được đối chiếu lại tại nhà bán.']);
    assert.equal(Object.hasOwn(result.detail, 'dataIssues'), false);
    assert.equal(serialized.includes('internal_rule_91'), false);
    assert.equal(serialized.includes('must-not-leak'), false);
    assert.equal(serialized.includes('private-code'), false);
    assert.equal(serialized.includes('affiliate=fixture'), false);
  });

  await test('public API returns public-safe cards and rejects unknown filters', async () => {
    await reset();
    await adapter.writeCollection('products', [publicProduct('api-public'), product('api-private', { rawData: { password: 'hidden' } })]);
    const response = await publicProductsRoute.GET(new NextRequest('http://localhost/api/public/products?pageSize=6'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.items.map(item => item.id), ['api-public']);
    assert.equal(JSON.stringify(body).includes('hidden'), false);
    assert.equal((await publicProductsRoute.GET(new NextRequest('http://localhost/api/public/products?rawData=x'))).status, 400);
  });

  await test('comparison enforces four products and UI requires two before opening', async () => {
    await reset();
    const products = Array.from({ length: 5 }, (_, index) => publicProduct(`compare-${index + 1}`));
    await adapter.writeCollection('products', products);
    const compared = await publicProducts.getPublicComparison(products.map(item => item.id));
    assert.equal(compared.length, 4);
    assert.deepEqual(compared.map(item => item.id), products.slice(0, 4).map(item => item.id));

    const traySource = fs.readFileSync(path.join(process.cwd(), 'src/components/public/ProductComparisonTray.tsx'), 'utf8');
    const cardSource = fs.readFileSync(path.join(process.cwd(), 'src/components/public/DealCard.tsx'), 'utf8');
    assert.match(traySource, /const MAX_COMPARISON = 4/);
    assert.match(traySource, /selected\.length >= 2/);
    assert.match(cardSource, /\?compare=/);
  });

  await test('search UI is bounded, debounced, cancellable and keyboard accessible', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/components/public/PublicSearch.tsx'), 'utf8');
    assert.match(source, /pageSize: '6'/);
    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /}, 240\)/);
    assert.match(source, /event\.key === 'Escape'/);
    assert.match(source, /role="combobox"/);
    assert.match(source, /role="listbox"/);
    assert.doesNotMatch(source, /getAllProducts|pageSize:\s*'50'/);
  });

  await test('public events retain classified metadata only and outbound uses an internal redirect', async () => {
    await reset();
    const safe = publicProduct('event-safe');
    await adapter.writeCollection('products', [safe]);
    const eventResponse = await publicEventsRoute.POST(new NextRequest('http://localhost/api/public/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Private Browser Signature 12345',
        referer: 'https://private-referrer.example/path?person=test',
        'x-forwarded-for': '203.0.113.44',
      },
      body: JSON.stringify({ productId: safe.id, contentPageId: 'deal:event-safe', authorization: 'must-ignore' }),
    }));
    assert.equal(eventResponse.status, 204);
    const events = await adapter.readCollection('outbound-events');
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('Private Browser Signature'), false);
    assert.equal(serialized.includes('private-referrer.example'), false);
    assert.equal(serialized.includes('203.0.113.44'), false);
    assert.equal(serialized.includes('must-ignore'), false);

    const redirect = await outboundRoute.GET(new NextRequest('http://localhost/go/event-safe?content=deal%3Aevent-safe'), {
      params: Promise.resolve({ productId: safe.id }),
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), safe.affiliateUrl);
    assert.equal(redirect.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  global.fetch = originalFetch;
  console.log(`\nPrompt09 Phase C: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
