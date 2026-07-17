/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `prompt10-revenue-integrity-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = path.join(testRoot, 'data');
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function fixture(overrides = {}) {
  const observedAt = '2026-07-16T09:00:00.000Z';
  const offer = {
    id: 'offer-verified', source: 'accesstrade', merchant: 'merchant.example',
    price: 1200000, originalPrice: 1500000,
    affiliateUrl: 'https://merchant.example/products/headset?affiliate_id=fixture',
    health: 'HEALTHY', sourceVerified: true, sourceConfidence: 0.98,
    merchantQuality: 0.95, priceConfidence: 0.96, observedAt, confidence: 0.96, primary: true,
  };
  return {
    id: 'revenue-product', source: 'accesstrade', platform: 'website',
    originalUrl: 'https://merchant.example/products/headset',
    affiliateUrl: offer.affiliateUrl,
    affiliateHealthStatus: 'ok', bestOfferId: offer.id, offers: [offer],
    identity: { merchant: 'merchant.example' },
    ...overrides,
  };
}

async function main() {
  const revenue = require('../src/lib/autonomous/revenueIntegrity.ts');

  await test('verified offer passes source, merchant, tracking, expiry, and redirect-chain integrity', () => {
    const product = fixture();
    const offer = revenue.selectRevenueIntegrityOffer(product);
    const result = revenue.inspectRevenueIntegrity({
      product, offer, now: Date.parse('2026-07-16T10:00:00.000Z'),
      redirectChain: [offer.affiliateUrl, product.originalUrl],
    });
    assert.equal(result.eligible, true, JSON.stringify(result.reasons));
    assert.equal(result.redirectHealthy, true);
    assert.equal(result.publicRedirectPath, '/go/revenue-product');
    const disclosure = revenue.revenueIntegrityDisclosure(result);
    assert.equal(JSON.stringify(disclosure).includes('affiliate_id=fixture'), false);
  });

  await test('mismatched, expired, untracked, and broken offers fail closed with explicit reasons', () => {
    const product = fixture();
    const offer = {
      ...product.offers[0], source: 'other-source', merchant: 'attacker.example',
      affiliateUrl: 'https://attacker.example/redirect', health: 'BROKEN', expiresAt: '2026-07-15T00:00:00.000Z',
    };
    const result = revenue.inspectRevenueIntegrity({ product, offer, now: Date.parse('2026-07-16T10:00:00.000Z') });
    assert.equal(result.eligible, false);
    for (const reason of ['offer_source_mismatch', 'offer_merchant_mismatch', 'affiliate_offer_unhealthy', 'affiliate_offer_expired', 'tracking_parameter_missing']) {
      assert.ok(result.reasons.includes(reason), reason);
    }
  });

  await test('unsafe redirect chains detect loops, origin drift, and merchant drift', () => {
    const product = fixture();
    const offer = product.offers[0];
    const loop = revenue.inspectRevenueIntegrity({ product, offer, redirectChain: [offer.affiliateUrl, offer.affiliateUrl] });
    assert.ok(loop.reasons.includes('redirect_loop'));
    const drift = revenue.inspectRevenueIntegrity({ product, offer, redirectChain: ['https://other.example/?ref=fixture', 'https://unrelated.example/final'] });
    assert.ok(drift.reasons.includes('redirect_origin_mismatch'));
    assert.ok(drift.reasons.includes('redirect_merchant_mismatch'));
  });

  await test('bot, prefetch, and non-GET requests never count as outbound clicks', () => {
    assert.equal(revenue.isCountableOutboundClick({ userAgent: 'Mozilla/5.0', method: 'GET' }), true);
    assert.equal(revenue.isCountableOutboundClick({ userAgent: 'Googlebot/2.1', method: 'GET' }), false);
    assert.equal(revenue.isCountableOutboundClick({ userAgent: 'curl/8.0', method: 'GET' }), false);
    assert.equal(revenue.isCountableOutboundClick({ userAgent: 'Mozilla/5.0', method: 'GET', purpose: 'prefetch' }), false);
    assert.equal(revenue.isCountableOutboundClick({ userAgent: 'Mozilla/5.0', method: 'POST' }), false);
  });

  await test('business summary reports measured clicks but never invents redirect success or revenue', () => {
    const now = Date.parse('2026-07-16T10:00:00.000Z');
    const product = fixture({ affiliateHealthStatus: 'broken', offers: [{ ...fixture().offers[0], health: 'BROKEN' }] });
    const summary = revenue.summarizeRevenueIntegrity({
      products: [product], now, cutoff: now - 60_000,
      events: [{
        id: 'event-1', eventType: 'OUTBOUND_CLICK', productId: product.id,
        timestamp: '2026-07-16T09:59:30.000Z', referrerCategory: 'internal', deviceCategory: 'desktop',
      }],
    });
    assert.equal(summary.outboundClicks, 1);
    assert.equal(summary.redirectSuccesses, null);
    assert.equal(summary.redirectMeasurementStatus, 'insufficient_data');
    assert.equal(summary.brokenAffiliateProducts, 1);
    assert.deepEqual(summary.trafficWithBrokenOffer, [{ productId: product.id, outboundClicks: 1 }]);
    assert.equal(Object.hasOwn(summary, 'conversion'), false);
    assert.equal(Object.hasOwn(summary, 'revenue'), false);
  });

  console.log(`\nPROMPT10 Gate 7 revenue integrity: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
