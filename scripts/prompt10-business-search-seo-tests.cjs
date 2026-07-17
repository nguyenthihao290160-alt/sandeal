/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-business-search-seo-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.SITE_URL = 'http://localhost:3000';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function draft(id, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id,
    title: `Verified product ${id}`,
    slug: `verified-product-${id}`,
    description: 'Source-backed product fixture with enough factual detail for editorial validation and deterministic public search.',
    kind: 'product', recordType: 'PRODUCT', platform: 'website', source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?ref=private-fixture`,
    imageUrl: `https://merchant.example/images/${id}.jpg`, gallery: [],
    price: 1500000, salePrice: 1200000, currency: 'VND',
    category: 'Audio', brand: 'Auralink', sku: `AUDIO-${id}`,
    specifications: { connectivity: 'Wireless Bluetooth 5.3' }, tags: ['wireless', 'headphones'],
    benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review', publicHidden: true,
    needsVerification: true, verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now,
    lastSeenAt: now, priceObservedAt: now, qualityScore: 90, qualityBand: 'good',
    opportunityScore: 84, opportunityBand: 'recommended', dealScore: 86, dealBand: 'featured',
    dealReasons: ['Verified source, current price, and healthy merchant links.'],
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const safePublish = require('../src/lib/safePublish.ts');
  const search = require('../src/lib/product-intelligence/searchRanking.ts');
  const publicProducts = require('../src/lib/product-intelligence/publicProducts.ts');
  const productSeo = require('../src/lib/seo/productSeo.ts');
  const sitemap = require('../src/app/sitemap.ts').default;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_BUSINESS_SEARCH_SEO'); };

  function published(id, overrides = {}) {
    const source = draft(id, overrides);
    const reviewContent = editorial.generateEditorialReview(source, [], source.updatedAt);
    return safePublish.applySafePublishDecision({ ...source, reviewContent }, source.updatedAt);
  }

  function autonomous(id, overrides = {}) {
    const base = published(id, overrides);
    return {
      ...base,
      schemaVersion: 2,
      lifecycleState: 'PUBLISHED',
      lifecycleVersion: 'product-lifecycle-v1',
      autoPublished: true,
      publicationEffectKey: `publish-effect:${id}`,
      publishedAt: base.publishedAt || base.updatedAt,
      evidenceCoverage: 0.95,
      evidenceFactIds: [`evidence:${id}:title`, `evidence:${id}:price`],
      evidenceSnapshotAt: base.updatedAt,
      evidenceSnapshotHash: `snapshot-${id}`,
      priceTruthState: 'FRESH',
      confidences: {
        classification: .99, source: .98, price: .97, image: .98, health: .98,
        duplicate: .99, contentEvidenceCoverage: .95, editorial: .94, publish: .94,
        calculatedAt: base.updatedAt, ruleVersion: 'confidence-engine-v2',
      },
      ...overrides,
    };
  }

  async function seed(items) {
    for (const collection of ['products', 'price-history']) await adapter.writeCollection(collection, []);
    await adapter.writeCollection('products', items);
  }

  await test('Vietnamese synonyms and one-edit typo resolve to factual product tokens', () => {
    const item = autonomous('synonym', { title: 'Auralink wireless headphones' });
    assert.deepEqual(search.rankPublicSearchProducts([item], 'tai nghe khong day').map(entry => entry.product.id), ['synonym']);
    assert.deepEqual(search.rankPublicSearchProducts([item], 'headphnes').map(entry => entry.product.id), ['synonym']);
  });

  await test('search ranking combines text, source, price freshness, quality, deal, health, and freshness', () => {
    const strong = autonomous('strong', { title: 'Wireless headphones Pro', brand: 'Auralink', category: 'Audio', qualityScore: 98, dealScore: 94 });
    const weak = autonomous('weak', {
      title: 'Wireless headphones Basic', brand: 'Generic', category: 'Accessories', qualityScore: 70, dealScore: 60,
      priceTruthState: 'AGING', confidences: { ...strong.confidences, source: .55, health: .55 },
    });
    const ranked = search.rankPublicSearchProducts([weak, strong], 'Auralink audio wireless headphones');
    assert.deepEqual(ranked.map(entry => entry.product.id), ['strong']);
    assert.deepEqual(Object.keys(ranked[0].score).sort(), ['deal', 'freshness', 'health', 'priceFreshness', 'quality', 'source', 'text', 'total']);
  });

  await test('public query ranks relevant products and excludes explicit stale and quarantined records', async () => {
    const best = autonomous('query-best', { title: 'Auralink wireless headphones', qualityScore: 98 });
    const lower = autonomous('query-lower', { title: 'Generic wireless headphones', qualityScore: 72, dealScore: 61 });
    const stale = autonomous('query-stale', { title: 'Auralink wireless headphones stale', priceTruthState: 'STALE' });
    const quarantined = autonomous('query-quarantined', { title: 'Auralink wireless headphones quarantined', lifecycleState: 'QUARANTINED', status: 'needs_review', publicHidden: true });
    await seed([lower, stale, quarantined, best]);
    const result = await publicProducts.queryPublicProducts(new URLSearchParams({ q: 'wireless headphnes' }));
    assert.deepEqual(result.items.map(item => item.id), ['query-best', 'query-lower']);
    assert.equal(result.rankingVersion, search.PUBLIC_SEARCH_RANKING_VERSION);
    assert.equal(JSON.stringify(result).includes('ref=private-fixture'), false);
  });

  await test('zero-result suggestions are bounded and derived from real public brands and categories', async () => {
    await seed([
      autonomous('suggest-one', { brand: 'Auralink', category: 'Audio' }),
      autonomous('suggest-two', { brand: 'Auralink', category: 'Audio' }),
      autonomous('suggest-three', { brand: 'HomeLab', category: 'Home Office' }),
    ]);
    const result = await publicProducts.queryPublicProducts(new URLSearchParams({ q: 'does-not-exist-anywhere' }));
    assert.equal(result.items.length, 0);
    assert.ok(result.suggestions.length > 0 && result.suggestions.length <= 5);
    assert.equal(result.suggestions[0].matchingProducts, 2);
    assert.ok(['Auralink', 'Audio'].includes(result.suggestions[0].label));
  });

  await test('SEO curator noindexes stale price, weak evidence, and incomplete autonomous taxonomy', () => {
    const ready = autonomous('seo-ready');
    assert.equal(productSeo.getProductIndexingDecision(ready).indexable, true);
    const stale = productSeo.getProductIndexingDecision({ ...ready, priceTruthState: 'STALE' });
    assert.equal(stale.indexable, false); assert.ok(stale.reasons.some(reason => reason.startsWith('price_or_lifecycle_not_discoverable')));
    assert.ok(productSeo.getProductIndexingDecision({ ...ready, evidenceCoverage: 0.2 }).reasons.includes('evidence_coverage_low'));
    assert.ok(productSeo.getProductIndexingDecision({ ...ready, brand: undefined }).reasons.includes('brand_missing'));
  });

  await test('product FAQ is built only from indexable canonical facts and never leaks affiliate URLs', () => {
    const ready = autonomous('faq-ready');
    const faq = productSeo.buildProductFactFaq(ready);
    assert.equal(faq.length, 2);
    assert.deepEqual(faq[0].evidenceFields, ['title', 'brand', 'category']);
    assert.deepEqual(faq[1].evidenceFields, ['price', 'currency', 'priceObservedAt']);
    assert.equal(JSON.stringify(faq).includes('ref=private-fixture'), false);
    assert.deepEqual(productSeo.buildProductFactFaq({ ...ready, priceTruthState: 'STALE' }), []);
  });

  await test('related recommendation prefers commerce quality after factual similarity', () => {
    const anchor = autonomous('related-anchor');
    const strong = autonomous('related-strong', { qualityScore: 99, dealScore: 96, updatedAt: new Date().toISOString() });
    const weak = autonomous('related-weak', { qualityScore: 70, dealScore: 55, priceTruthState: 'AGING' });
    assert.equal(productSeo.selectRelatedProducts(anchor, [weak, strong], 2)[0].id, 'related-strong');
  });

  await test('sitemap excludes explicit stale products while preserving an evidence-backed fresh product', async () => {
    const fresh = autonomous('sitemap-fresh');
    const stale = autonomous('sitemap-stale', { priceTruthState: 'STALE' });
    await seed([fresh, stale]);
    const urls = (await sitemap()).map(entry => entry.url);
    assert.ok(urls.some(url => url.endsWith(fresh.slug)));
    assert.equal(urls.some(url => url.endsWith(stale.slug)), false);
  });

  console.log(`\nPROMPT10 Gate 7 search/SEO: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
