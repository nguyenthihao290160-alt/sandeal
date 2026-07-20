/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt09-phase-d-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.SITE_URL = 'http://localhost:3000';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';

require('./register-typescript.cjs');

const TEST_NOW = '2026-07-15T05:00:00.000Z';
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
    title: `Verified SEO fixture ${id}`,
    slug: `verified-seo-${id}`,
    description: 'Source-backed fixture used only in isolated SEO and analytics tests.',
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=private-fixture`,
    imageUrl: `https://merchant.example/images/${id}.jpg`,
    gallery: [],
    price: 1500000,
    salePrice: 1200000,
    currency: 'VND',
    category: 'Audio Devices',
    brand: 'Acme Verified',
    sku: `SKU-${id}`,
    specifications: { model: `MODEL-${id}` },
    tags: ['verified-fixture'], benefits: [], warnings: [],
    riskLevel: 'low', status: 'needs_review',
    verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    publicHidden: true, needsVerification: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    linkLastCheckedAt: TEST_NOW, affiliateLastCheckedAt: TEST_NOW, imageLastCheckedAt: TEST_NOW, lastSeenAt: TEST_NOW,
    priceObservedAt: TEST_NOW, priceTruthState: 'FRESH',
    availability: 'available', sourceHash: `source-${id}`,
    qualityScore: 88, qualityBand: 'good', opportunityScore: 80, opportunityBand: 'recommended',
    dealScore: 84, dealBand: 'featured', dealReasons: ['Dữ liệu fixture đã vượt cổng kiểm tra.'],
    createdAt: TEST_NOW, updatedAt: TEST_NOW,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const safePublish = require('../src/lib/safePublish.ts');
  const publicFilter = require('../src/lib/publicProductFilter.ts');
  const publicProducts = require('../src/lib/product-intelligence/publicProducts.ts');
  const taxonomySeo = require('../src/lib/seo/taxonomySeo.ts');
  const productSeo = require('../src/lib/seo/productSeo.ts');
  const siteSeo = require('../src/lib/seo/siteSeo.ts');
  const growth = require('../src/lib/product-intelligence/growth.ts');
  const publicEventsRoute = require('../src/app/api/public/events/route.ts');
  const outboundRoute = require('../src/app/go/[productId]/route.ts');
  const sitemap = require('../src/app/sitemap.ts').default;
  const { NextRequest } = require('next/server');

  async function reset(...collections) {
    for (const collection of collections.length ? collections : ['products', 'price-history', 'outbound-events', 'growth-daily']) {
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
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT09_PHASE_D'); };

  const fixtures = [
    publicProduct('audio-one'),
    publicProduct('audio-two'),
    publicProduct('home-one', { category: 'Home Office', brand: 'Solo Brand' }),
  ];

  await test('taxonomy slug, summaries and paginated landing use public products only', async () => {
    await reset();
    await adapter.writeCollection('products', [...fixtures, product('private-audio', { category: 'Audio Devices' })]);
    assert.equal(taxonomySeo.publicTaxonomySlug('Điện tử & Âm thanh'), 'dien-tu-am-thanh');
    const categories = await publicProducts.listPublicTaxonomies('category');
    assert.deepEqual(categories.map(item => [item.slug, item.count]), [['audio-devices', 2], ['home-office', 1]]);
    const first = await publicProducts.getPublicTaxonomyLanding('category', 'audio-devices', 1, 1);
    assert.ok(first);
    assert.equal(first.pagination.totalItems, 2);
    assert.equal(first.pagination.totalPages, 2);
    assert.equal(first.items.length, 1);
    assert.deepEqual(first.crossLinks.map(item => item.slug), ['acme-verified']);
    const outOfRange = await publicProducts.getPublicTaxonomyLanding('category', 'audio-devices', 3, 1);
    assert.equal(outOfRange.pagination.outOfRange, true);
    assert.equal(outOfRange.items.length, 0);
    assert.equal(await publicProducts.getPublicTaxonomyLanding('category', 'missing', 1), null);
  });

  await test('taxonomy metadata canonicalizes curated pages and noindexes thin or filtered URLs', () => {
    const base = { kind: 'category', name: 'Audio Devices', slug: 'audio-devices', totalItems: 2, page: 1, totalPages: 1 };
    const indexed = taxonomySeo.buildTaxonomyMetadata({ ...base, curated: true });
    assert.equal(indexed.robots.index, true);
    assert.equal(indexed.alternates.canonical, 'http://localhost:3000/deals/category/audio-devices');
    const thin = taxonomySeo.buildTaxonomyMetadata({ ...base, totalItems: 1, curated: true });
    assert.equal(thin.robots.index, false);
    const filtered = taxonomySeo.buildTaxonomyMetadata({ ...base, curated: false });
    assert.equal(filtered.robots.index, false);
    assert.equal(taxonomySeo.parseTaxonomySearchParams({ page: '2' }).curated, true);
    assert.equal(taxonomySeo.parseTaxonomySearchParams({ sort: 'price' }).curated, false);
    assert.equal(taxonomySeo.parseTaxonomySearchParams({ compare: 'one,two' }).curated, false);
    assert.equal(taxonomySeo.parseTaxonomySearchParams({ page: ['1', '2'] }).page, null);
  });

  await test('sitemap includes indexable category and brand landings but excludes thin taxonomy', async () => {
    await reset();
    await adapter.writeCollection('products', fixtures);
    const entries = await sitemap();
    const urls = entries.map(item => item.url);
    assert.ok(urls.includes('http://localhost:3000/deals/category/audio-devices'));
    assert.ok(urls.includes('http://localhost:3000/deals/brand/acme-verified'));
    assert.equal(urls.includes('http://localhost:3000/deals/category/home-office'), false);
    assert.equal(urls.includes('http://localhost:3000/deals/brand/solo-brand'), false);
    assert.ok(urls.includes('http://localhost:3000/deals/verified-seo-audio-one'));
  });

  await test('structured data matches visible routes and never exposes affiliate or fake review fields', () => {
    const schema = productSeo.buildProductJsonLd(fixtures[0]);
    assert.ok(schema);
    const serialized = JSON.stringify(schema);
    assert.equal(schema.offers.url, 'http://localhost:3000/go/audio-one');
    assert.equal(serialized.includes('affiliate=private-fixture'), false);
    assert.equal(serialized.includes('aggregateRating'), false);
    assert.equal(serialized.includes('reviewCount'), false);
    const faq = taxonomySeo.taxonomyFaq('category', 'Audio Devices');
    const faqSchema = taxonomySeo.buildFaqJsonLd(faq);
    assert.equal(faqSchema.mainEntity.length, faq.length);
    const itemList = taxonomySeo.buildTaxonomyItemListJsonLd({ kind: 'category', name: 'Audio Devices', slug: 'audio-devices', page: 1 }, [{ title: fixtures[0].title, slug: fixtures[0].slug }]);
    assert.equal(JSON.stringify(itemList).includes('/deals/verified-seo-audio-one'), true);
    assert.equal(JSON.stringify(siteSeo.buildSiteJsonLd()).includes('SearchAction'), true);
  });

  await test('public analytics API allowlists event DTO and stores classified metadata only', async () => {
    await reset();
    await adapter.writeCollection('products', [fixtures[0]]);
    const search = await publicEventsRoute.POST(new NextRequest('http://localhost/api/public/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Private Browser Signature 987',
        referer: 'https://private-referrer.example/person?q=secret',
        'x-forwarded-for': '203.0.113.99',
      },
      body: JSON.stringify({
        eventType: 'PUBLIC_SEARCH', contentPageId: 'search:header', resultCount: 3,
        query: 'private search text', authorization: 'must-not-store', eventId: 'search-event-0001',
      }),
    }));
    assert.equal(search.status, 204);
    const detail = await publicEventsRoute.POST(new NextRequest('http://localhost/api/public/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventType: 'PRODUCT_DETAIL_VIEW', productId: fixtures[0].id, contentPageId: 'deal:audio-one', eventId: 'detail-event-0001' }),
    }));
    assert.equal(detail.status, 204);
    const events = await adapter.readCollection('outbound-events');
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('private search text'), false);
    assert.equal(serialized.includes('must-not-store'), false);
    assert.equal(serialized.includes('Private Browser Signature'), false);
    assert.equal(serialized.includes('private-referrer.example'), false);
    assert.equal(serialized.includes('203.0.113.99'), false);
    assert.equal(events.find(item => item.eventType === 'PUBLIC_SEARCH').resultCount, 3);

    const fakeOutbound = await publicEventsRoute.POST(new NextRequest('http://localhost/api/public/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventType: 'OUTBOUND_CLICK', productId: fixtures[0].id }),
    }));
    assert.equal(fakeOutbound.status, 400);
    const missingProduct = await publicEventsRoute.POST(new NextRequest('http://localhost/api/public/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventType: 'PRODUCT_CARD_VIEW' }),
    }));
    assert.equal(missingProduct.status, 400);
    const rawUrl = await publicEventsRoute.POST(new NextRequest('http://localhost/api/public/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventType: 'CATEGORY_VIEW', contentPageId: 'https://private.example/path' }),
    }));
    assert.equal(rawUrl.status, 400);
  });

  await test('outbound click is server-recorded and funnel rates use real denominators only', async () => {
    await reset('outbound-events', 'growth-daily', 'products');
    await adapter.writeCollection('products', [fixtures[0]]);
    const now = new Date().toISOString();
    await growth.recordGrowthEvent({ eventType: 'PRODUCT_CARD_VIEW', productId: fixtures[0].id, source: 'manual', referrerCategory: 'direct', timestamp: now });
    await growth.recordGrowthEvent({ eventType: 'PRODUCT_DETAIL_VIEW', productId: fixtures[0].id, source: 'manual', referrerCategory: 'internal', timestamp: now });
    await growth.recordGrowthEvent({ eventType: 'PUBLIC_SEARCH', source: 'public', referrerCategory: 'direct', resultCount: 1, timestamp: now });
    await growth.recordGrowthEvent({ eventType: 'COMPARE_OPEN', source: 'public', referrerCategory: 'internal', resultCount: 2, timestamp: now });
    const redirect = await outboundRoute.GET(new NextRequest('http://localhost/go/audio-one'), { params: Promise.resolve({ productId: fixtures[0].id }) });
    assert.equal(redirect.status, 302);
    await growth.aggregateGrowthMetrics();
    const summary = await growth.getGrowthSummary(30);
    assert.equal(summary.funnel.listViews, 1);
    assert.equal(summary.funnel.detailViews, 1);
    assert.equal(summary.funnel.outboundClicks, 1);
    assert.equal(summary.funnel.listToDetailRate, 100);
    assert.equal(summary.funnel.detailToOutboundRate, 100);

    await reset('outbound-events', 'growth-daily');
    await growth.aggregateGrowthMetrics();
    const empty = await growth.getGrowthSummary(30);
    assert.equal(empty.ctr, undefined);
    assert.equal(empty.funnel.listToDetailRate, undefined);
    assert.equal(empty.funnel.detailToOutboundRate, undefined);
  });

  await test('public UI exposes analytics, canonical SEO and responsive accessibility hooks', () => {
    const searchSource = fs.readFileSync(path.join(process.cwd(), 'src/components/public/PublicSearch.tsx'), 'utf8');
    const cardSource = fs.readFileSync(path.join(process.cwd(), 'src/components/public/DealCard.tsx'), 'utf8');
    const compareSource = fs.readFileSync(path.join(process.cwd(), 'src/components/public/ProductComparisonTray.tsx'), 'utf8');
    const taxonomySource = fs.readFileSync(path.join(process.cwd(), 'src/components/public/TaxonomyLanding.tsx'), 'utf8');
    const layoutSource = fs.readFileSync(path.join(process.cwd(), 'src/app/layout.tsx'), 'utf8');
    const dealsSource = fs.readFileSync(path.join(process.cwd(), 'src/app/deals/page.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(process.cwd(), 'src/components/public/public.module.css'), 'utf8');
    assert.match(searchSource, /PUBLIC_SEARCH/);
    assert.match(searchSource, /SEARCH_NO_RESULT/);
    assert.match(cardSource, /PublicProductCardTracker/);
    assert.match(compareSource, /COMPARE_ADD/);
    assert.match(compareSource, /COMPARE_OPEN/);
    assert.match(taxonomySource, /CATEGORY_VIEW/);
    assert.match(taxonomySource, /aria-label="Breadcrumb"/);
    assert.match(taxonomySource, /aria-labelledby="taxonomy-faq"/);
    assert.match(dealsSource, /robots: \{ index: indexable/);
    assert.doesNotMatch(layoutSource, /ReviewPilot|Powered by|Săn deal thông minh bằng AI/);
    assert.match(layoutSource, /buildSiteJsonLd/);
    assert.match(css, /@media \(max-width: 800px\)/);
    assert.match(css, /@media \(max-width: 540px\)/);
    assert.doesNotMatch(css, /font-size:\s*[^;]*vw/);
  });

  global.fetch = originalFetch;
  console.log(`\nPrompt09 Phase D: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
