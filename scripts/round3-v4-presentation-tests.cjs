/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
const readOnlyDataDir = path.join(process.cwd(), '.test-tmp', `round3-v4-read-only-${process.pid}-${Date.now()}`);
process.env.SANDEAL_DATA_DIR = readOnlyDataDir;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
require('./register-typescript.cjs');

const {
  aggregateSourceDiscoveryStatus,
  buildAffiliateBroadcastCopy,
  buildDealMatrix,
  buildPublicSocialProof,
  buildThirtyDayPriceHistory,
  buildTrendingDealLeaderboard,
  buildVerifiedUrgency,
  calculateDealEconomics,
  classifyProductFunnel,
  currentVerifiedPaymentPromotions,
  explainTechnicalReason,
  mapProductPipelineStage,
  presentAutomationJob,
} = require('../src/lib/dashboard/v4.ts');
const { buildProductStudioDetail } = require('../src/lib/dashboard/productStudio.ts');
const { toDashboardProductItem } = require('../src/lib/dashboard/products.ts');
const { buildDashboardStatusStrip } = require('../src/lib/dashboard/statusStrip.ts');
const { getAutomationControl } = require('../src/lib/automation/store.ts');
const { getAutomationSettings } = require('../src/lib/storage/automationSettings.ts');

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

const now = Date.parse('2026-08-09T10:00:00.000Z');
const iso = offsetMs => new Date(now + offsetMs).toISOString();

function offer(id, overrides = {}) {
  return {
    id,
    source: 'TikTok Shop',
    merchant: 'Verified Shop',
    price: 900_000,
    originalPrice: 1_000_000,
    affiliateUrl: `https://merchant.example/${id}?aff=verified`,
    health: 'HEALTHY',
    affiliateHealth: 'HEALTHY',
    sourceVerified: true,
    observedAt: iso(-60_000),
    confidence: 0.95,
    primary: false,
    ...overrides,
  };
}

function product(overrides = {}) {
  return {
    id: 'product-1',
    title: 'Tai nghe Bluetooth chính hãng',
    slug: 'tai-nghe-bluetooth',
    description: 'Thiết bị công nghệ cho văn phòng.',
    kind: 'product',
    platform: 'tiktok',
    source: 'accesstrade_tiktok',
    originalUrl: 'https://merchant.example/product-1',
    canonicalProductUrl: 'https://merchant.example/product-1',
    affiliateUrl: 'https://merchant.example/product-1?aff=sandeal',
    affiliateUrlStatus: 'verified',
    affiliateHealthStatus: 'ok',
    imageUrl: undefined,
    price: 1_000_000,
    salePrice: 900_000,
    currency: 'VND',
    category: 'Công nghệ',
    brand: 'SanDeal Audio',
    sku: 'SD-AUDIO-001',
    tags: ['tai nghe'],
    benefits: [],
    warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    lifecycleState: 'QUARANTINED',
    publicHidden: true,
    publicBlocked: true,
    verifiedSource: true,
    sourceVerified: true,
    priceTruthState: 'FRESH',
    priceVerificationStatus: 'VERIFIED',
    priceTruthDiscountPercent: 10,
    commissionAmount: 45_000,
    commissionRate: 5,
    qualityScore: 82,
    opportunityScore: 76,
    dealScore: 71,
    eligibility: {
      eligibleForReview: false,
      eligibleForPublish: false,
      criticalBlockers: ['review_not_indexable'],
      warningBlockers: [],
    },
    identity: { identityHash: 'canonical:product-1' },
    offers: [offer('tiktok-primary', { primary: true, expiresAt: iso(3_600_000) })],
    bestOfferId: 'tiktok-primary',
    createdAt: iso(-86_400_000),
    updatedAt: iso(-60_000),
    rawData: { accessToken: 'test-fixture-never-leaves-server' },
    privateToken: 'test-fixture-never-leaves-server',
    ...overrides,
  };
}

void (async () => {
  await test('lifecycle presentation mapping preserves every known group and unknown fallback', () => {
    assert.equal(mapProductPipelineStage({ lifecycleState: 'DISCOVERED', status: 'draft' }), 'discovered');
    assert.equal(mapProductPipelineStage({ lifecycleState: 'VERIFYING', status: 'draft' }), 'checking');
    assert.equal(mapProductPipelineStage({ lifecycleState: 'QUARANTINED', status: 'needs_review' }), 'review');
    assert.equal(mapProductPipelineStage({ lifecycleState: 'READY_FOR_PUBLISH', status: 'approved' }), 'safe_publish');
    assert.equal(mapProductPipelineStage({ lifecycleState: 'PUBLISHED', status: 'published', publicHidden: false, publicBlocked: false }), 'public');
    assert.equal(mapProductPipelineStage({ lifecycleState: 'UNRECOGNIZED_STATE', status: 'draft' }), 'unclassified');
    const reason = explainTechnicalReason('PRODUCT_SELECTION_SOURCE_CHANGED');
    assert.equal(reason.technicalCode, 'PRODUCT_SELECTION_SOURCE_CHANGED');
  });

  await test('automation presentation separates operator work from durable self-recovery', () => {
    const waiting = presentAutomationJob({
      type: 'AUTO_PILOT', status: 'WAITING_CHILDREN', progress: { processed: 9, total: 10, succeeded: 9, skipped: 0, failed: 0, percentage: 90, updatedAt: iso(-1_000) },
    });
    assert.equal(waiting.statusLabel, 'Đang chờ các tác vụ con');
    assert.equal(waiting.humanActionRequired, false);
    assert.match(waiting.nextAction, /tự đối soát/);
    assert.equal(waiting.progressLabel, '9/10 · 90%');
    const approval = presentAutomationJob({ type: 'SAFE_PUBLISH', status: 'WAITING_APPROVAL', lastErrorCode: 'POLICY_APPROVAL_REQUIRED' });
    assert.equal(approval.humanActionRequired, true);
    assert.equal(approval.technicalReason, 'POLICY_APPROVAL_REQUIRED');
  });

  await test('contextual funnels require a strong deterministic match', () => {
    assert.equal(classifyProductFunnel(product()).id, 'technology');
    assert.equal(classifyProductFunnel({ title: 'Sản phẩm tổng hợp', category: 'Khác', tags: [], description: '' }).id, 'unclassified');
  });

  await test('Product Studio exposes List, Board, drawer tabs, filters, and missing-image fallback', () => {
    const workspace = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/products/products-dashboard.tsx'), 'utf8');
    const drawer = fs.readFileSync(path.join(process.cwd(), 'src/components/dashboard/product-studio-drawer.tsx'), 'utf8');
    for (const token of ['Danh sách', 'Board', 'Mới phát hiện', 'Chưa phân loại', 'ProductStudioDrawer', 'Tìm sản phẩm, shop, nguồn...', 'Đã tìm thấy', 'Đủ điều kiện', 'Đã đăng']) assert.match(workspace, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const token of ['Tổng quan', 'Review', 'Affiliate', 'Lịch sử', 'Debug', 'SafeProductImage', 'aria-labelledby', 'tabIndex', 'onKeyDown']) assert.match(drawer, new RegExp(token));
    assert.equal(buildProductStudioDetail({ product: product(), priceSnapshots: [], now }).product.image, null);
  });

  await test('Deal Matrix requires canonical identity and includes verified offers only', () => {
    assert.equal(buildDealMatrix({ offers: [offer('a')] }).reason, 'IDENTITY_UNVERIFIED');
    const matrix = buildDealMatrix({
      identity: { identityHash: 'canonical:one' },
      offers: [
        offer('verified-low', { price: 800_000 }),
        offer('unverified', { sourceVerified: false, price: 1 }),
        offer('low-confidence', { confidence: 0.79, price: 2 }),
        offer('verified-low', { price: 3 }),
        offer('broken-affiliate', { affiliateHealth: 'BROKEN', price: 850_000 }),
      ],
    });
    assert.equal(matrix.available, true);
    assert.deepEqual(matrix.rows.map(row => row.offerId), ['verified-low', 'broken-affiliate']);
    assert.equal(matrix.rows[0].verifiedDiscountPercent, 20);
    assert.equal(matrix.rows[1].affiliateAvailable, false);
  });

  await test('30-day history derives the true low/high/average and refuses sparse claims', () => {
    const history = buildThirtyDayPriceHistory([
      { capturedAt: iso(-31 * 86_400_000), price: 1 },
      { capturedAt: iso(-20 * 86_400_000), price: 120 },
      { capturedAt: iso(-10 * 86_400_000), price: 100 },
      { capturedAt: iso(-60_000), salePrice: 80 },
    ], now);
    assert.deepEqual({ current: history.current, low: history.low, high: history.high, average: history.average, currentIsLow: history.currentIsLow }, { current: 80, low: 80, high: 120, average: 100, currentIsLow: true });
    assert.equal(buildThirtyDayPriceHistory([{ capturedAt: iso(-60_000), price: 80 }], now).sufficient, false);
  });

  await test('payment optimization rejects stale, future, unverified, and impossible cashback claims', () => {
    const base = {
      id: 'valid', issuer: 'Verified Bank', productName: 'Verified Card', cashbackRate: 5,
      eligiblePlatforms: ['tiktok'], validFrom: iso(-86_400_000), validUntil: iso(86_400_000),
      sourceUrl: 'https://bank.example/terms', verifiedAt: iso(-60_000), verified: true,
    };
    const result = currentVerifiedPaymentPromotions([
      base,
      { ...base, id: 'stale', verifiedAt: iso(-8 * 86_400_000) },
      { ...base, id: 'future', verifiedAt: iso(60_000) },
      { ...base, id: 'unverified', verified: false },
      { ...base, id: 'impossible-rate', cashbackRate: 101 },
    ], 'tiktok', now);
    assert.deepEqual(result.map(item => item.id), ['valid']);
  });

  await test('deal economics separates customer savings from publisher commission', () => {
    const economics = calculateDealEconomics({ platformDiscount: 100, voucherDiscount: 20, verifiedCashback: 30, affiliateCommission: 40 });
    assert.equal(economics.customerSavings, 150);
    assert.equal(economics.publisherRevenue, 40);
    assert.equal(economics.totalEconomicValue, 190);
    const unavailable = calculateDealEconomics({ platformDiscount: null, affiliateCommission: null });
    assert.equal(unavailable.customerSavings, null);
    assert.equal(unavailable.publisherRevenue, null);
  });

  await test('urgency uses real timestamps, expires, and rejects future verification evidence', () => {
    const live = buildVerifiedUrgency({ promotionExpiresAt: iso(120_000) }, now);
    assert.deepEqual(live, [{ kind: 'promotion_expiry', expiresAt: iso(120_000), remainingMs: 120_000 }]);
    assert.deepEqual(buildVerifiedUrgency({ promotionExpiresAt: iso(-1) }, now), []);
    assert.deepEqual(buildVerifiedUrgency({ stockRemaining: 2, stockVerifiedAt: iso(60_000) }, now), []);
    assert.deepEqual(buildVerifiedUrgency({}, now), []);
  });

  await test('trending ranking is deterministic and unavailable without enough real events', () => {
    const products = [
      { id: 'a', title: 'A', qualityScore: 90, dealScore: 90 },
      { id: 'b', title: 'B', qualityScore: 50, dealScore: 50 },
    ];
    const events = [
      { id: '1', eventType: 'OUTBOUND_CLICK', productId: 'b', timestamp: iso(-1_000), referrerCategory: 'direct' },
      { id: '2', eventType: 'PRODUCT_DETAIL_VIEW', productId: 'a', timestamp: iso(-2_000), referrerCategory: 'direct' },
      { id: '3', eventType: 'PRODUCT_CARD_CLICK', productId: 'a', timestamp: iso(-3_000), referrerCategory: 'direct' },
    ];
    const ranked = buildTrendingDealLeaderboard(products, events, now);
    assert.equal(ranked.available, true);
    assert.deepEqual(ranked.items.map(item => item.productId), ['b', 'a']);
    assert.equal(buildTrendingDealLeaderboard(products, events.slice(0, 2), now).available, false);
  });

  await test('public social proof accepts only recent privacy-safe verified conversions', () => {
    const events = [
      { id: 'valid', eventType: 'VERIFIED_CONVERSION', occurredAt: iso(-1_000), privacySafe: true },
      { id: 'private', eventType: 'VERIFIED_CONVERSION', occurredAt: iso(-2_000), privacySafe: false },
      { id: 'fake', eventType: 'PURCHASE', occurredAt: iso(-3_000), privacySafe: true },
      { id: 'future', eventType: 'VERIFIED_CONVERSION', occurredAt: iso(1_000), privacySafe: true },
      { id: 'old', eventType: 'VERIFIED_CONVERSION', occurredAt: iso(-25 * 3_600_000), privacySafe: true },
    ];
    const proof = buildPublicSocialProof(events, now);
    assert.equal(proof.enabled, true);
    assert.deepEqual(proof.events.map(item => item.id), ['valid']);
    assert.deepEqual(buildPublicSocialProof([], now), { enabled: false, events: [] });
  });

  await test('source health isolation keeps discovery active when one legacy source fails', () => {
    const state = aggregateSourceDiscoveryStatus([
      { id: 'tiktok', status: 'healthy' },
      { id: 'legacy-30shine', status: 'failed' },
      { id: 'shopee', status: 'not_connected' },
    ]);
    assert.equal(state.status, 'healthy');
    assert.deepEqual(state.activeSourceIds, ['tiktok']);
    assert.deepEqual(state.degradedSourceIds, ['legacy-30shine']);
  });

  await test('Product Studio DTO is secret-safe and gates unavailable MMO data honestly', () => {
    const detail = buildProductStudioDetail({
      product: product(),
      priceSnapshots: [
        { capturedAt: iso(-86_400_000), price: 1_000_000 },
        { capturedAt: iso(-60_000), salePrice: 900_000 },
      ],
      paymentPromotions: [{
        id: 'unverified', issuer: 'Bank', productName: 'Card', cashbackRate: 9,
        eligiblePlatforms: ['tiktok'], validFrom: iso(-1), validUntil: iso(1),
        sourceUrl: 'https://bank.example', verifiedAt: iso(-1), verified: false,
      }],
      now,
    });
    assert.equal(detail.overview.priceDropSubscription.state, 'COMING_SOON');
    assert.equal(detail.overview.paymentOptimization.state, 'NO_VERIFIED_DATA');
    assert.equal(detail.overview.socialProof.enabled, false);
    // A FRESH label without a persisted observation timestamp is not current
    // price evidence and cannot support a customer-savings claim.
    assert.equal(detail.overview.economics.customerSavings, null);
    assert.equal(detail.overview.economics.publisherRevenue, 45_000);
    assert.equal(detail.review.reasons[0].technicalCode, 'review_not_indexable');
    assert.equal(detail.product.brand, 'SanDeal Audio');
    assert.equal(detail.product.sku, 'SD-AUDIO-001');
    assert.equal(detail.affiliate.state, 'verified');
    assert.equal(detail.broadcast.available, true);
    assert.match(detail.broadcast.copy, /SanDeal/);
    const serialized = JSON.stringify(detail);
    assert.doesNotMatch(serialized, /test-fixture-never-leaves-server|accessToken|privateToken|rawData/);
  });

  await test('Product Studio discount economics requires explicit price-truth evidence', () => {
    const verifiedPrice = {
      priceObservedAt: iso(-60_000),
      fieldProvenance: { price: { source: 'provider_api', verificationStatus: 'VERIFIED' } },
    };
    const missingEvidence = buildProductStudioDetail({
      product: product(verifiedPrice),
      priceSnapshots: [],
      now,
    });
    assert.equal(missingEvidence.overview.economics.customerSavings, null);

    const verified = buildProductStudioDetail({
      product: product({ ...verifiedPrice, priceTruthEvidenceFactIds: ['current-price-fact', 'reference-price-fact'] }),
      priceSnapshots: [],
      now,
    });
    assert.equal(verified.overview.economics.customerSavings, 100_000);

    const contradictory = buildProductStudioDetail({
      product: product({
        ...verifiedPrice,
        priceTruthEvidenceFactIds: ['current-price-fact', 'reference-price-fact'],
        priceTruthDiscountPercent: 40,
      }),
      priceSnapshots: [],
      now,
    });
    assert.equal(contradictory.overview.economics.customerSavings, null);
    assert.doesNotMatch(contradictory.broadcast.copy || '', /Giảm 40%/);
  });

  await test('legacy score remains Opportunity Score and never masquerades as quality or review quality', () => {
    const legacy = product({
      score: 61,
      opportunityScore: undefined,
      qualityScore: undefined,
      reviewQuality: { qualityScore: 73 },
    });
    const item = toDashboardProductItem(legacy);
    assert.equal(item.scores.opportunity, 61);
    assert.equal(item.scores.quality, null);
    assert.equal(item.review.score, 73);

    const detail = buildProductStudioDetail({ product: legacy, priceSnapshots: [], now });
    assert.equal(detail.product.opportunityScore, 61);
    assert.equal(detail.product.qualityScore, null);
  });

  await test('status strip is fail-closed and distinguishes unknown from healthy', () => {
    const control = { killSwitch: false, publishPaused: false, publishPausedByOperator: false, publishBlockedByRuntime: false, publishBlockedByPolicy: false, workerPaused: false, schedulerPaused: false };
    const stale = buildDashboardStatusStrip({ control, runtime: { checkedAt: iso(-10 * 60_000), publishSafe: true, reasons: [], worker: { status: 'active' }, scheduler: { status: 'active' } }, leases: [], schedulerEnabled: true, now });
    assert.equal(stale.items.find(item => item.id === 'publish').tone, 'unknown');
    assert.equal(stale.runtimeGuardian.technicalValue, 'RUNTIME_GUARDIAN_UNVERIFIED');
    const blocked = buildDashboardStatusStrip({ control: { ...control, publishBlockedByRuntime: true }, runtime: { checkedAt: iso(-1_000), publishSafe: false, reasons: ['JOB_PICKUP_LATENCY_SLO_FAILED'], worker: { status: 'active' }, scheduler: { status: 'active' } }, leases: [], schedulerEnabled: true, now });
    assert.equal(blocked.items.find(item => item.id === 'publish').technicalValue, 'SAFE_PUBLISH_BLOCKED');
    assert.deepEqual(blocked.runtimeGuardian.reasons, ['JOB_PICKUP_LATENCY_SLO_FAILED']);
  });

  await test('read-only dashboard health sources do not create or mutate the data directory', async () => {
    assert.equal(fs.existsSync(readOnlyDataDir), false);
    const [control, settings] = await Promise.all([getAutomationControl(), getAutomationSettings()]);
    assert.equal(control.killSwitch, false);
    assert.equal(settings.safePublish, true);
    assert.equal(fs.existsSync(readOnlyDataDir), false);
  });

  await test('broadcast copy refuses missing affiliate identity and adds disclosure', () => {
    assert.equal(buildAffiliateBroadcastCopy({ title: 'Verified product', price: 100 }), null);
    const copy = buildAffiliateBroadcastCopy({ title: 'Verified product', price: 100, affiliateUrl: 'https://merchant.example/aff' });
    assert.match(copy, /https:\/\/merchant\.example\/aff/);
    assert.match(copy, /SanDeal/);
    assert.doesNotMatch(copy, /stock|viewer|purchase/i);
  });

  console.log(`\nRound 3 V4 presentation: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
