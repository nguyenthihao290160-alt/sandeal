/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
require('./register-typescript.cjs');

const { derivePersistedPriceTruth } = require('../src/lib/autonomous/priceTruthEngine.ts');
const { deriveProductRemediationSummary } = require('../src/lib/dashboard/productDetailStatus.ts');
const { CURRENT_REVIEW_VERSION, extractVerifiedProductFacts, generateEditorialReview } = require('../src/lib/editorialReview.ts');
const { GEMINI_EDITORIAL_PROMPT_VERSION } = require('../src/lib/ai/geminiEditorialProvider.ts');
const { updateProductHealthFailureCounters } = require('../src/lib/productHealthFailureCounters.ts');
const { calculateDealScore } = require('../src/lib/product-intelligence/scoring.ts');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const now = Date.parse('2026-08-16T10:00:00.000Z');
const iso = offset => new Date(now + offset).toISOString();
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

function product(overrides = {}) {
  return {
    id: 'v4-1-product', title: 'Sản phẩm dữ liệu trung lập', slug: 'san-pham-du-lieu-trung-lap',
    kind: 'product', platform: 'other', source: 'other', sourceId: 'source-v4-1',
    originalUrl: 'https://merchant.example/product', canonicalProductUrl: 'https://merchant.example/product',
    affiliateUrl: 'https://affiliate.example/go', imageUrl: 'https://images.example/product.jpg',
    currency: 'VND', price: 250_000, category: 'Khác', brand: 'Nguồn thử nghiệm', tags: [],
    benefits: [], warnings: [], status: 'needs_review', riskLevel: 'low', publicHidden: true,
    publicBlocked: true, verifiedSource: false, sourceHash: 'v4-1-source-hash',
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    linkLastCheckedAt: iso(-60_000), updatedAt: iso(-60_000), createdAt: iso(-86_400_000),
    ...overrides,
  };
}

void (async () => {
  await test('stale provenance cannot render as fresh price truth', () => {
    const truth = derivePersistedPriceTruth(product({
      priceObservedAt: iso(-60_000), priceTruthState: 'FRESH', priceVerificationStatus: 'STALE',
      fieldProvenance: { price: { source: 'provider', verificationStatus: 'STALE', fetchedAt: iso(-60_000) } },
    }), now);
    assert.equal(truth.state, 'STALE');
    assert.equal(truth.isFresh, false);
    assert.equal(truth.isVerified, false);
  });

  await test('price freshness uses one 24h/72h model', () => {
    const fresh = derivePersistedPriceTruth(product({ priceObservedAt: iso(-23 * 60 * 60_000), priceVerificationStatus: 'VERIFIED' }), now);
    const aging = derivePersistedPriceTruth(product({ priceObservedAt: iso(-25 * 60 * 60_000), priceVerificationStatus: 'VERIFIED' }), now);
    const stale = derivePersistedPriceTruth(product({ priceObservedAt: iso(-73 * 60 * 60_000), priceVerificationStatus: 'VERIFIED' }), now);
    assert.equal(fresh.state, 'FRESH');
    assert.equal(aging.state, 'AGING');
    assert.equal(stale.state, 'STALE');
  });

  await test('declared invalid or conflicted price cannot remain fresh', () => {
    const invalid = derivePersistedPriceTruth(product({
      priceObservedAt: iso(-60_000), priceTruthState: 'FRESH', priceVerificationStatus: 'INVALID',
    }), now);
    const conflicted = derivePersistedPriceTruth(product({
      priceObservedAt: iso(-60_000), priceTruthState: 'FRESH', priceVerificationStatus: 'CONFLICT',
    }), now);
    assert.equal(invalid.state, 'UNAVAILABLE');
    assert.equal(invalid.verificationStatus, 'INVALID');
    assert.equal(invalid.isVerified, false);
    assert.equal(conflicted.state, 'CONFLICTED');
    assert.equal(conflicted.verificationStatus, 'CONFLICT');
    assert.equal(conflicted.isVerified, false);
  });

  await test('editorial price facts use the canonical price observation timestamp', () => {
    const priceObservedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const facts = extractVerifiedProductFacts(product({
      price: 300_000, salePrice: 250_000, priceObservedAt, priceVerificationStatus: 'VERIFIED',
      priceTruthDiscountPercent: 17, priceTruthEvidenceFactIds: ['current-price', 'reference-price'],
      linkLastCheckedAt: new Date(Date.now() - 60_000).toISOString(),
      fieldProvenance: { price: { source: 'provider', verificationStatus: 'VERIFIED', fetchedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() } },
    }));
    for (const id of ['current_price', 'original_price', 'discount']) {
      assert.equal(facts.find(fact => fact.id === id).verifiedAt, priceObservedAt);
    }
  });

  await test('editorial discount claims require canonical evidence and percent agreement', () => {
    const base = {
      price: 300_000, salePrice: 250_000, priceObservedAt: new Date().toISOString(),
      priceVerificationStatus: 'VERIFIED', priceTruthState: 'FRESH',
    };
    const withoutEvidence = extractVerifiedProductFacts(product(base));
    assert.equal(withoutEvidence.some(fact => ['original_price', 'discount'].includes(fact.id)), false);

    const mismatched = extractVerifiedProductFacts(product({
      ...base, priceTruthDiscountPercent: 40, priceTruthEvidenceFactIds: ['current-price', 'reference-price'],
    }));
    assert.equal(mismatched.some(fact => ['original_price', 'discount'].includes(fact.id)), false);

    const verified = extractVerifiedProductFacts(product({
      ...base, priceTruthDiscountPercent: 17, priceTruthEvidenceFactIds: ['current-price', 'reference-price'],
    }));
    assert.equal(verified.find(fact => fact.id === 'original_price')?.value, 300_000);
    assert.equal(verified.find(fact => fact.id === 'discount')?.value, 17);
  });

  await test('deal scoring rejects evidenced discount percentages that contradict the observed price pair', () => {
    const base = product({
      price: 100_000, salePrice: 90_000, priceObservedAt: iso(-60_000),
      priceVerificationStatus: 'VERIFIED', priceTruthState: 'FRESH',
      priceTruthEvidenceFactIds: ['current-price', 'reference-price'],
    });
    const mismatched = calculateDealScore({ ...base, priceTruthDiscountPercent: 50 }, { score: 80, blockers: [] }, undefined, now);
    assert.equal(mismatched.positiveSignals.includes('verified_discount_present'), false);
    assert.equal(mismatched.negativeSignals.includes('no_verified_discount'), true);
    assert.equal(mismatched.reasons.some(reason => reason.includes('50%')), false);

    const verified = calculateDealScore({ ...base, priceTruthDiscountPercent: 10 }, { score: 80, blockers: [] }, undefined, now);
    assert.equal(verified.positiveSignals.includes('verified_discount_present'), true);
    assert.equal(verified.negativeSignals.includes('no_verified_discount'), false);
    assert.ok(verified.reasons.some(reason => reason.includes('10%') && reason.includes('10.000')));
  });

  await test('blockers group deterministically without treating product quarantine as merchant failure', () => {
    const summary = deriveProductRemediationSummary(
      ['quarantined', 'review_not_approved', 'low_originality', 'price_stale', 'auto_publish_ineligible'],
      ['quarantined', 'review_not_approved', 'price_stale'],
      'KEEP_QUARANTINED',
    );
    assert.deepEqual(summary.rootCauses.slice(0, 3).map(group => group.id), ['CONTENT_REVIEW', 'PRICE', 'POLICY_PUBLICATION']);
    assert.equal(summary.productHeldInQuarantine, true);
    assert.equal(summary.merchantQuarantined, false);
    assert.doesNotMatch(JSON.stringify(summary), /Merchant đang bị quarantine/i);
  });

  await test('neutral local review fallback does not invent category-specific advice', () => {
    const review = generateEditorialReview(product({
      title: 'Mẫu hàng chưa phân loại', category: undefined, description: 'Thông tin nguồn ngắn.', specifications: {},
    }), [], iso(0));
    const text = JSON.stringify(review).toLocaleLowerCase('vi');
    for (const forbidden of ['phối đồ', 'chọn size', 'kích cỡ cơ thể', 'thử trên da', 'dinh dưỡng', 'liều dùng', 'tương thích thiết bị']) {
      assert.ok(!text.includes(forbidden), forbidden);
    }
    const userFacing = [review.reviewSummary, review.reviewVerdict, ...review.buyingConsiderations, ...review.suitableFor, ...review.notSuitableFor];
    const normalized = userFacing.map(value => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi'));
    assert.equal(new Set(normalized).size, normalized.length);
  });

  await test('review V3 regenerates unchanged V2 content and keeps known categories neutral', () => {
    assert.equal(CURRENT_REVIEW_VERSION, 3);
    assert.equal(GEMINI_EDITORIAL_PROMPT_VERSION, 'editorial-v3.0');
    const base = product({
      title: 'Hoodie source record', category: 'fashion', description: 'Neutral source description.',
      specifications: {}, priceObservedAt: iso(-60_000), priceVerificationStatus: 'VERIFIED',
    });
    const generated = generateEditorialReview(base, [], iso(-60_000));
    const legacy = { ...generated, reviewVersion: 2, contentUpdatedAt: iso(-60_000), reviewedAt: iso(-60_000) };
    const regenerated = generateEditorialReview({ ...base, reviewContent: legacy }, [], iso(0));
    assert.equal(regenerated.reviewVersion, 3);
    assert.notStrictEqual(regenerated, legacy);
    assert.equal(regenerated.contentUpdatedAt, iso(0));
    const text = JSON.stringify(regenerated).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd').toLowerCase();
    for (const forbidden of ['phoi do', 'chon size', 'kich co co the', 'thu tren da', 'lieu dung', 'tuong thich thiet bi']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  await test('health success resets only the verified evidence scope', () => {
    const existing = product({
      consecutiveHealthFailures: 2,
      healthFailureCounters: {
        price: { consecutiveFailures: 2, checkedAt: iso(-60_000), lastFailureAt: iso(-60_000), reason: 'price:stale' },
        productUrl: { consecutiveFailures: 1, checkedAt: iso(-60_000), lastFailureAt: iso(-60_000), reason: 'link:timeout' },
      },
    });
    const linkRecovered = updateProductHealthFailureCounters(existing, [{ scope: 'productUrl', healthy: true }], now);
    assert.equal(linkRecovered.counters.productUrl.consecutiveFailures, 0);
    assert.equal(linkRecovered.counters.price.consecutiveFailures, 2);
    assert.equal(linkRecovered.consecutiveFailures, 2);
    const allRecovered = updateProductHealthFailureCounters({ ...existing, healthFailureCounters: linkRecovered.counters }, [{ scope: 'price', healthy: true }], now);
    assert.equal(allRecovered.consecutiveFailures, 0);
  });

  await test('stale historical health counters do not masquerade as current failure', () => {
    const result = updateProductHealthFailureCounters(product({
      consecutiveHealthFailures: 4,
      healthFailureCounters: { image: { consecutiveFailures: 4, checkedAt: iso(-8 * 86_400_000), reason: 'image:not_found' } },
    }), [], now);
    assert.equal(result.consecutiveFailures, 0);
    assert.equal(result.counters.image.consecutiveFailures, 4);
  });

  await test('empty scoped maps migrate legacy failures and future evidence stays inactive', () => {
    const migrated = updateProductHealthFailureCounters(product({
      consecutiveHealthFailures: 2,
      sourceHealthReason: 'legacy_failure',
      healthFailureCounters: {},
    }), [], now);
    assert.equal(migrated.counters.legacy.consecutiveFailures, 2);
    assert.equal(migrated.consecutiveFailures, 2);

    const future = updateProductHealthFailureCounters(product({
      consecutiveHealthFailures: 5,
      healthFailureCounters: {
        image: { consecutiveFailures: 5, checkedAt: iso(60 * 60_000), lastHealthyAt: iso(60 * 60_000), reason: 'future_image_failure' },
      },
    }), [], now);
    assert.equal(future.consecutiveFailures, 0);
    assert.notEqual(future.lastHealthyAt, iso(60 * 60_000));
    assert.equal(future.counters.image.consecutiveFailures, 5);
  });

  await test('coherent full verification supersedes an unscoped legacy failure without deleting history', () => {
    const result = updateProductHealthFailureCounters(product({
      consecutiveHealthFailures: 3,
      sourceHealthReason: 'legacy_failure',
    }), [
      { scope: 'price', healthy: true },
      { scope: 'productUrl', healthy: true },
      { scope: 'affiliateUrl', healthy: true },
      { scope: 'image', healthy: true },
    ], now);
    assert.equal(result.consecutiveFailures, 0);
    assert.equal(result.counters.legacy.consecutiveFailures, 0);
    assert.ok(result.counters.legacy.lastFailureAt);
    assert.ok(result.counters.legacy.lastHealthyAt);
  });

  await test('legacy failure recovery is reason-scoped while unknown evidence remains fail-closed', () => {
    const recoveredImage = updateProductHealthFailureCounters(product({
      consecutiveHealthFailures: 3,
      sourceHealthReason: 'image:image_broken',
      imageHealthStatus: 'image_broken',
    }), [{ scope: 'image', healthy: true }], now);
    assert.equal(recoveredImage.consecutiveFailures, 0);
    assert.equal(recoveredImage.counters.legacy.consecutiveFailures, 0);

    const unknown = updateProductHealthFailureCounters(product({
      consecutiveHealthFailures: 3,
      sourceHealthReason: 'legacy_failure',
    }), [{ scope: 'image', healthy: true }], now);
    assert.equal(unknown.consecutiveFailures, 3);
    assert.equal(unknown.counters.legacy.consecutiveFailures, 3);
  });

  await test('Product Detail exposes five accessible tabs and keeps raw JSON in Debug', () => {
    const page = read('src/app/dashboard/products/[id]/page.tsx');
    for (const label of ['Tổng quan', 'Review', 'Affiliate', 'Lịch sử', 'Debug']) assert.ok(page.includes(label));
    assert.ok(page.includes('role="tablist"') && page.includes('role="tabpanel"'));
    assert.ok(page.includes('hidden={activeTab !== \'debug\'}'));
    assert.ok(page.includes('Copy safe JSON'));
    assert.ok(page.includes('Opportunity Score') && page.includes('Product Quality'));
    assert.ok(!page.includes('Thành phần khác'));
  });

  await test('Safe Publish is absent as an action when server eligibility is false', () => {
    const dashboard = read('src/app/dashboard/products/products-dashboard.tsx');
    assert.ok(dashboard.includes('item.publish.eligible &&'));
    assert.ok(dashboard.includes("item.publish.eligible ? 'Xem chi tiết' : 'Xem blockers'"));
    const approveRoute = read('src/app/api/products/[id]/approve/route.ts');
    assert.ok(approveRoute.includes('SAFE_PUBLISH_NOT_READY'));
  });

  await test('sidebar X and Google Fonts runtime request stay removed without losing the hamburger', () => {
    const layout = read('src/app/dashboard/layout.tsx');
    const css = read('src/app/globals.css');
    assert.ok(!layout.includes('dashboard-sidebar-close'));
    assert.ok(!css.includes('.dashboard-sidebar-close'));
    assert.ok(layout.includes('dashboard-mobile-menu'));
    assert.ok(layout.includes("sidebarOpen ? 'Đóng menu bảng điều khiển' : 'Mở menu bảng điều khiển'"));
    assert.ok(layout.includes('aria-expanded={sidebarOpen}') && layout.includes('aria-controls="dashboard-primary-navigation"'));
    assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  await test('public zero-catalogue semantics differ from zero filtered matches', () => {
    const query = read('src/lib/product-intelligence/publicProducts.ts');
    const deals = read('src/app/deals/page.tsx');
    assert.ok(query.includes('totalPublicProducts: products.length'));
    assert.ok(deals.includes('result.totalPublicProducts > 0 && activeFilters'));
    assert.ok(deals.includes('result.pagination.totalItems > 0 ? <p>Trang'));
  });

  await test('known-broken images bypass legacy remote URLs and remain truthfully unhealthy', () => {
    const image = read('src/components/safe-product-image.tsx');
    assert.ok(image.includes('KNOWN_UNHEALTHY_IMAGE_STATES'));
    assert.ok(image.includes("'known_unhealthy'"));
    assert.ok(image.includes("knownUnhealthy\n      ? []"));
  });

  console.log(`\nRound 3 V4.1 regression: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
