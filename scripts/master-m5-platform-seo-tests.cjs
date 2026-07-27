/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const testRoot = path.join(root, '.test-tmp', `master-m5-platform-seo-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = path.join(testRoot, 'data');
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.NODE_ENV = 'test';
process.env.SITE_URL = 'http://localhost:3000';
require('./register-typescript.cjs');

const bulk = require('../src/lib/storage/bulkMutation.ts');
const offerSelector = require('../src/lib/product-intelligence/complianceOfferSelector.ts');
const structured = require('../src/lib/seo/structuredData.ts');
const productSeo = require('../src/lib/seo/productSeo.ts');
const editorial = require('../src/lib/editorialReview.ts');
const safePublish = require('../src/lib/safePublish.ts');
const manifest = require('../src/app/manifest.ts').default;
const robots = require('../src/app/robots.ts').default;

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

function offer(id, overrides = {}) {
  return {
    id,
    source: 'accesstrade',
    merchant: 'merchant.example',
    price: 1200000,
    affiliateUrl: `https://merchant.example/products/headset?affiliate_id=${id}`,
    destinationUrl: 'https://merchant.example/products/headset',
    health: 'HEALTHY',
    productLinkHealth: 'HEALTHY',
    affiliateHealth: 'HEALTHY',
    sourceVerified: true,
    sourceConfidence: 0.98,
    merchantQuality: 0.95,
    priceConfidence: 0.96,
    currency: 'VND',
    observedAt: '2026-07-26T08:00:00.000Z',
    expiresAt: '2026-07-27T08:00:00.000Z',
    confidence: 0.96,
    primary: false,
    disclosureVerified: true,
    affiliateDisclosure: 'SanDeal có thể nhận hoa hồng từ liên kết này.',
    trackingVerified: true,
    ...overrides,
  };
}

function offerProduct(overrides = {}) {
  return {
    id: 'offer-product',
    originalUrl: 'https://merchant.example/products/headset',
    merchant: 'merchant.example',
    merchantDomain: 'merchant.example',
    affiliateUrl: 'https://legacy.example/path?ref=legacy',
    bestOfferId: 'legacy-offer',
    offers: [],
    ...overrides,
  };
}

function draft(id, overrides = {}) {
  const now = '2026-07-26T08:00:00.000Z';
  return {
    id,
    title: `Verified product ${id}`,
    slug: `verified-product-${id}`,
    description: 'Source-backed product fixture with enough factual detail for editorial validation and deterministic structured data.',
    kind: 'product',
    recordType: 'PRODUCT',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    canonicalProductUrl: `https://merchant.example/products/${id}`,
    canonicalUrlStatus: 'verified',
    canonicalUrlVerifiedAt: now,
    affiliateUrl: `https://merchant.example/products/${id}?ref=fixture`,
    affiliateUrlStatus: 'verified',
    affiliateUrlVerifiedAt: now,
    imageUrl: `https://merchant.example/images/${id}.jpg`,
    imageUrlHttpStatus: 200,
    imageContentType: 'image/jpeg',
    gallery: [],
    price: 1500000,
    salePrice: 1200000,
    currency: 'VND',
    category: 'Audio',
    brand: 'Auralink',
    sku: `AUDIO-${id}`,
    specifications: { connectivity: 'Wireless Bluetooth 5.3' },
    tags: ['wireless', 'headphones'],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    publicHidden: true,
    needsVerification: true,
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: true,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    linkLastCheckedAt: now,
    affiliateLastCheckedAt: now,
    imageLastCheckedAt: now,
    lastSeenAt: now,
    priceObservedAt: now,
    priceVerificationStatus: 'VERIFIED',
    priceTruthState: 'FRESH',
    duplicateStatus: 'CLEAR',
    claimValidationStatus: 'VERIFIED',
    sourceHash: `source-hash-${id}`,
    qualityScore: 90,
    qualityBand: 'good',
    opportunityScore: 84,
    opportunityBand: 'recommended',
    dealScore: 86,
    dealBand: 'featured',
    dealReasons: ['Verified source, current price, and healthy merchant links.'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function indexableProduct(id = 'seo') {
  const source = draft(id);
  const reviewContent = editorial.generateEditorialReview(source, [], source.updatedAt);
  const published = safePublish.applySafePublishDecision({ ...source, reviewContent }, source.updatedAt);
  return {
    ...published,
    schemaVersion: 2,
    lifecycleState: 'PUBLISHED',
    lifecycleVersion: 'product-lifecycle-v1',
    autoPublished: true,
    publicationEffectKey: `publish-effect:${id}`,
    publishedAt: published.publishedAt || published.updatedAt,
    evidenceCoverage: 0.95,
    evidenceFactIds: [`evidence:${id}:title`, `evidence:${id}:price`],
    evidenceSnapshotAt: published.updatedAt,
    evidenceSnapshotHash: `snapshot-${id}`,
    priceTruthState: 'FRESH',
    priceVerificationStatus: 'VERIFIED',
    confidences: {
      classification: 0.99,
      source: 0.98,
      price: 0.97,
      image: 0.98,
      health: 0.98,
      duplicate: 0.99,
      contentEvidenceCoverage: 0.95,
      editorial: 0.94,
      publish: 0.94,
      calculatedAt: published.updatedAt,
      ruleVersion: 'confidence-engine-v2',
    },
  };
}

async function run() {
  await test('Bulk mutation kernel is bounded and reports deterministic duplicate and value failures', async () => {
    const result = bulk.applyStorageBulkMutations([{ id: 'one', value: 1 }], [
      { mutationId: 'm1', type: 'UPSERT', itemId: 'one', value: { id: 'one', value: 2 } },
      { mutationId: 'm1', type: 'DELETE', itemId: 'missing' },
      { mutationId: 'm3', type: 'DELETE', itemId: 'one' },
      { mutationId: 'm4', type: 'UPSERT', itemId: 'wrong', value: { id: 'other' } },
    ]);
    assert.equal(result.applied, 1);
    assert.equal(result.failed, 3);
    assert.deepEqual(result.results.map(item => item.code), [
      'UPSERTED',
      'DUPLICATE_MUTATION_ID',
      'DUPLICATE_TARGET',
      'INVALID_VALUE',
    ]);
    assert.throws(() => bulk.applyStorageBulkMutations([], []), /STORAGE_BULK_SIZE_INVALID/);
    assert.throws(
      () => bulk.applyStorageBulkMutations([], Array.from({ length: 101 }, (_, index) => ({
        mutationId: `m${index}`,
        type: 'DELETE',
        itemId: `i${index}`,
      }))),
      /STORAGE_BULK_SIZE_INVALID/,
    );
  });

  await test('Compliance is evaluated before price so an unverified cheaper offer cannot win', async () => {
    const product = offerProduct({
      offers: [
        offer('cheap-unverified', {
          price: 900000,
          disclosureVerified: false,
          affiliateDisclosure: undefined,
        }),
        offer('verified', { price: 1200000 }),
      ],
    });
    const decision = offerSelector.selectComplianceFirstOffer(product, Date.parse('2026-07-26T09:00:00.000Z'));
    assert.equal(decision.selectedOfferId, 'verified');
    const rejected = decision.evaluations.find(item => item.offerId === 'cheap-unverified');
    assert.ok(rejected.reasonCodes.includes('affiliate_disclosure_unverified'));
    assert.equal(JSON.stringify(decision).includes('affiliate_id='), false);
  });

  await test('Unsafe, stale, unhealthy, untracked, and merchant-drifted offers fail closed', async () => {
    const product = offerProduct({
      offers: [offer('unsafe', {
        affiliateUrl: 'https://127.0.0.1/private?ref=x',
        destinationUrl: 'https://attacker.example/item',
        merchant: 'attacker.example',
        health: 'BROKEN',
        trackingVerified: false,
        observedAt: '2026-07-20T00:00:00.000Z',
      })],
    });
    const decision = offerSelector.selectComplianceFirstOffer(product, Date.parse('2026-07-26T09:00:00.000Z'));
    assert.equal(decision.selectedOfferId, null);
    const reasons = decision.evaluations[0].reasonCodes;
    for (const reason of [
      'affiliate_url_not_safe_https',
      'merchant_mismatch',
      'offer_unhealthy',
      'tracking_unverified',
      'offer_stale',
    ]) assert.ok(reasons.includes(reason), reason);
  });

  await test('Duplicate offer identifiers and over-limit sets fail closed instead of hiding input ambiguity', async () => {
    const duplicate = offerProduct({
      offers: [offer('same'), offer('same', { price: 1100000 })],
    });
    const duplicateDecision = offerSelector.selectComplianceFirstOffer(
      duplicate,
      Date.parse('2026-07-26T09:00:00.000Z'),
    );
    assert.equal(duplicateDecision.selectedOfferId, null);
    assert.ok(duplicateDecision.evaluations.every(item => item.reasonCodes.includes('duplicate_offer_id')));

    const overLimit = offerProduct({
      offers: Array.from({ length: 33 }, (_, index) => offer(`bounded-${index}`)),
    });
    const boundedDecision = offerSelector.selectComplianceFirstOffer(
      overLimit,
      Date.parse('2026-07-26T09:00:00.000Z'),
    );
    assert.equal(boundedDecision.selectedOfferId, null);
    assert.deepEqual(boundedDecision.reasons, ['offer_limit_exceeded', 'no_compliant_offer']);
    assert.equal(boundedDecision.evaluations.length, 32);
  });

  await test('Offer ties are stable and never use commission as a ranking input', async () => {
    const product = offerProduct({
      offers: [
        offer('offer-b', { price: 1100000 }),
        offer('offer-a', { price: 1100000 }),
      ],
    });
    const first = offerSelector.selectComplianceFirstOffer(product, Date.parse('2026-07-26T09:00:00.000Z'));
    const second = offerSelector.selectComplianceFirstOffer({
      ...product,
      offers: [...product.offers].reverse(),
    }, Date.parse('2026-07-26T09:00:00.000Z'));
    assert.equal(first.selectedOfferId, 'offer-a');
    assert.equal(second.selectedOfferId, 'offer-a');
    assert.equal(first.inputHash, second.inputHash);
    const qualityChanged = offerSelector.selectComplianceFirstOffer({
      ...product,
      offers: product.offers.map(item => (
        item.id === 'offer-a' ? { ...item, merchantQuality: 0.8 } : item
      )),
    }, Date.parse('2026-07-26T09:00:00.000Z'));
    assert.equal(qualityChanged.selectedOfferId, 'offer-b');
    assert.notEqual(qualityChanged.inputHash, first.inputHash);
  });

  await test('Multi-offer SHADOW records a suggestion without changing legacy routing; ACTIVE is explicit', async () => {
    const product = offerProduct({ offers: [offer('verified')] });
    const shadow = offerSelector.applyComplianceOfferPolicy(product, {}, Date.parse('2026-07-26T09:00:00.000Z'));
    assert.equal(shadow.mode, 'SHADOW');
    assert.equal(shadow.applied, false);
    assert.equal(shadow.product.bestOfferId, 'legacy-offer');
    assert.equal(shadow.product.affiliateUrl, product.affiliateUrl);
    assert.equal(shadow.product.offerSelectionSuggestion.selectedOfferId, 'verified');
    const active = offerSelector.applyComplianceOfferPolicy(
      product,
      { MULTI_AFFILIATE_OFFER: 'ACTIVE' },
      Date.parse('2026-07-26T09:00:00.000Z'),
    );
    assert.equal(active.applied, true);
    assert.equal(active.product.bestOfferId, 'verified');
    assert.equal(active.product.offers[0].primary, true);
  });

  await test('JSON-LD serializer escapes script breakers, HTML delimiters, ampersands, and separators', async () => {
    const serialized = structured.serializeJsonLd({
      value: '</script><script>alert(1)</script>&\u2028\u2029',
    });
    assert.equal(serialized.includes('</script>'), false);
    assert.ok(serialized.includes('\\u003c'));
    assert.ok(serialized.includes('\\u003e'));
    assert.ok(serialized.includes('\\u0026'));
    assert.ok(serialized.includes('\\u2028'));
    const circular = {};
    circular.self = circular;
    assert.throws(() => structured.serializeJsonLd(circular), /JSON_LD_PAYLOAD_INVALID/);
    assert.throws(
      () => structured.serializeJsonLd({ value: 'x'.repeat(256 * 1024) }),
      /JSON_LD_PAYLOAD_INVALID/,
    );
    assert.equal(
      structured.futureStructuredDataDate(
        '2026-07-27T08:00:00.000Z',
        Date.parse('2026-07-26T09:00:00.000Z'),
      ),
      '2026-07-27',
    );
    assert.equal(
      structured.futureStructuredDataDate(
        '2026-07-25T08:00:00.000Z',
        Date.parse('2026-07-26T09:00:00.000Z'),
      ),
      undefined,
    );
  });

  await test('Verified product JSON-LD contains only safe public URLs and evidence-qualified price', async () => {
    const product = indexableProduct('structured');
    const indexing = productSeo.getProductIndexingDecision(product);
    assert.equal(indexing.indexable, true, JSON.stringify({
      reasons: indexing.reasons,
      status: product.status,
      publicBlockReasons: product.publicBlockReasons,
    }));
    const jsonLd = productSeo.buildProductJsonLd(product);
    assert.equal(jsonLd['@type'], 'Product');
    assert.deepEqual(jsonLd.image, ['https://merchant.example/images/structured.jpg']);
    assert.equal(jsonLd.offers.price, 1200000);
    assert.match(jsonLd.offers.url, /\/go\/structured$/);
    assert.equal(JSON.stringify(jsonLd).includes('ref=fixture'), false);
    const withoutPriceEvidence = productSeo.buildProductJsonLd({
      ...product,
      priceTruthState: undefined,
      priceVerificationStatus: 'UNVERIFIED',
      confidences: { ...product.confidences, price: 0.2 },
    });
    assert.equal(withoutPriceEvidence, null);
  });

  await test('Unsafe image URL makes product noindex and suppresses Product JSON-LD', async () => {
    const product = indexableProduct('unsafe-image');
    const unsafe = { ...product, imageUrl: 'https://127.0.0.1/private.jpg' };
    const decision = productSeo.getProductIndexingDecision(unsafe);
    assert.equal(decision.indexable, false);
    assert.ok(decision.reasons.includes('unsafe_image_url'));
    assert.equal(productSeo.buildProductJsonLd(unsafe), null);
  });

  await test('Programmatic SEO V2 stays SHADOW by default and only emits under explicit ACTIVE', async () => {
    const product = indexableProduct('rollout');
    const shadow = productSeo.getProgrammaticSeoV2State(product, {});
    assert.equal(shadow.mode, 'SHADOW');
    assert.equal(shadow.eligible, true);
    assert.equal(shadow.emitsV2, false);
    const active = productSeo.getProgrammaticSeoV2State(product, { PROGRAMMATIC_SEO_V2: 'ACTIVE' });
    assert.equal(active.emitsV2, true);
  });

  await test('Manifest uses the exact app name, real generated icon routes, and a bounded application scope', async () => {
    const value = manifest();
    assert.equal(value.name, 'SanDeal');
    assert.equal(value.short_name, 'SanDeal');
    assert.equal(value.start_url, '/');
    assert.equal(value.display, 'standalone');
    assert.equal(value.scope, '/');
    assert.deepEqual(value.icons.map(item => item.src), ['/icon', '/apple-icon']);
    assert.equal(value.icons.some(item => String(item.src).startsWith('/icons/')), false);
    assert.equal(fs.existsSync(path.join(root, 'src/app/icon.tsx')), true);
    assert.equal(fs.existsSync(path.join(root, 'src/app/apple-icon.tsx')), true);
  });

  await test('Robots keeps public deal paths crawlable and blocks operator, API, redirect, and comparison paths', async () => {
    const value = robots();
    assert.ok(value.rules.allow.includes('/deals/'));
    for (const path of ['/dashboard/', '/api/', '/go/', '/compare']) {
      assert.ok(value.rules.disallow.includes(path), path);
    }
    assert.match(value.sitemap, /\/sitemap\.xml$/);
  });

  await test('All rendered JSON-LD entry points use the centralized serializer', async () => {
    const files = [
      'src/app/layout.tsx',
      'src/app/deals/[slug]/page.tsx',
      'src/app/review-methodology/page.tsx',
      'src/components/public/TaxonomyLanding.tsx',
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(source, /serializeJsonLd/);
      assert.doesNotMatch(source, /JSON\.stringify\([^\\n]+replace\(\/</);
    }
  });

  console.log(`\nM5 platform/SEO tests: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, testRoot)}`);
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
