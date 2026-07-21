/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

require.extensions['.ts'] = function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(process.cwd(), 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

const tempDir = path.join(process.cwd(), '.test-tmp', `accesstrade-link-safety-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;

let passed = 0;
let failed = 0;
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
async function test(name, run) {
  try { await run(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error}`); }
}
function envelope(job, status = 200) {
  return new Response(JSON.stringify({ ok: true, data: job }), { status, headers: { 'content-type': 'application/json' } });
}
function product(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'at-product', title: 'Sản phẩm AccessTrade kiểm thử', slug: 'access-trade-test', kind: 'product',
    platform: 'accesstrade', source: 'accesstrade', originalUrl: 'https://merchant.example/product/1',
    canonicalProductUrl: 'https://merchant.example/product/1', canonicalUrlSource: 'provider_api', canonicalUrlProvider: 'accesstrade', canonicalUrlSourceEndpoint: 'datafeed', canonicalUrlSourceField: 'url', canonicalUrlStatus: 'verified', canonicalUrlVerifiedAt: now,
    affiliateUrl: 'https://tracking.example/click/1', affiliateUrlSource: 'provider_api', affiliateUrlProvider: 'accesstrade', affiliateUrlSourceEndpoint: 'datafeed', affiliateUrlSourceField: 'aff_link', affiliateUrlStatus: 'verified', affiliateUrlVerifiedAt: now, deepLinkSupported: true,
    imageUrl: 'https://images.example/product.jpg', price: 100000, currency: 'VND', tags: [], benefits: [], warnings: [],
    riskLevel: 'low', status: 'needs_review', verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', imageUrlHttpStatus: 200, imageContentType: 'image/jpeg', linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now, priceObservedAt: now, priceTruthState: 'FRESH', publicHidden: true,
    publicBlocked: false, needsVerification: true, createdAt: now, updatedAt: now, ...overrides,
  };
}

(async () => {
  const health = require('../src/lib/bots/productHealthCheck.ts');
  const accessTrade = require('../src/lib/integrations/accesstrade.ts');
  const safety = require('../src/lib/safePublish.ts');
  const eligibility = require('../src/lib/productEligibility.ts');
  const polling = require('../src/lib/dashboard/scanPolling.ts');
  const adapter = require('../src/lib/storage/adapter.ts');
  const products = require('../src/lib/storage/products.ts');
  const jobs = require('../src/lib/product-intelligence/jobs.ts');

  await test('HTTP 200 nhưng body Not Allowed bị đánh dấu không hợp lệ', async () => {
    const result = await health.checkLinkHealth('https://go.isclix.com/deep_link/campaign', {
      resolveDns: false,
      fetchImpl: async () => new Response('<html><body>Not Allowed!</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    equal(result.ok, false); equal(result.status, 'not_allowed'); equal(result.statusCode, 200);
    equal(result.errorCode, 'DEEPLINK_NOT_SUPPORTED');
  });

  await test('redirect giới hạn đến trang sản phẩm hợp lệ và lưu final URL', async () => {
    const fetchImpl = async (input) => String(input).includes('tracking.example')
      ? new Response('', { status: 302, headers: { location: 'https://merchant.example/products/sku-1' } })
      : new Response('<html><title>Product SKU 1</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const result = await health.checkLinkHealth('https://tracking.example/click', { resolveDns: false, fetchImpl });
    equal(result.ok, true); equal(result.finalUrl, 'https://merchant.example/products/sku-1');
    equal(new URL(result.finalUrl).hostname, 'merchant.example');
  });

  await test('timeout và connection reset được phân loại rõ', async () => {
    const timeout = new Error('timed out'); timeout.name = 'TimeoutError';
    const timed = await health.checkLinkHealth('https://merchant.example/timeout', { resolveDns: false, fetchImpl: async () => { throw timeout; } });
    equal(timed.status, 'timeout'); equal(timed.errorCode, 'TIMEOUT'); equal(timed.timedOut, true);
    const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    const disconnected = await health.checkLinkHealth('https://merchant.example/reset', { resolveDns: false, fetchImpl: async () => { throw reset; } });
    equal(disconnected.status, 'error'); equal(disconnected.errorCode, 'ECONNRESET');
  });

  await test('401/403/404/429/5xx và redirect loop đều fail closed', async () => {
    const cases = [[401, 'not_allowed', 'HTTP_UNAUTHORIZED'], [403, 'not_allowed', 'HTTP_FORBIDDEN'], [404, 'broken', 'HTTP_NOT_FOUND'], [429, 'rate_limited', 'HTTP_RATE_LIMITED'], [503, 'server_error', 'HTTP_SERVER_ERROR']];
    for (const [statusCode, status, errorCode] of cases) {
      const result = await health.checkLinkHealth(`https://merchant.example/${statusCode}`, {
        resolveDns: false,
        fetchImpl: async () => new Response('', { status: statusCode }),
      });
      equal(result.ok, false); equal(result.status, status); equal(result.errorCode, errorCode);
    }
    const loop = await health.checkLinkHealth('https://merchant.example/loop', {
      resolveDns: false,
      fetchImpl: async () => new Response('', { status: 302, headers: { location: '/loop' } }),
    });
    equal(loop.ok, false); equal(loop.errorCode, 'REDIRECT_LOOP');
  });

  await test('tracking host không redirect và ảnh HTTP 206 không được đánh dấu healthy', async () => {
    const tracking = await health.checkLinkHealth('https://go.isclix.com/deep_link/clean', {
      resolveDns: false,
      fetchImpl: async () => new Response('<html>clean page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    equal(tracking.ok, false); equal(tracking.errorCode, 'TRACKING_DESTINATION_UNVERIFIED');
    const image = await health.checkImageHealth('https://images.example/partial.jpg', {
      resolveDns: false,
      inspectImageBody: true,
      fetchImpl: async (_input, init) => init?.method === 'HEAD'
        ? new Response('', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '10000' } })
        : new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 206, headers: { 'content-type': 'image/jpeg' } }),
    });
    equal(image.ok, false); equal(image.statusCode, 206);
  });

  await test('không tự ghép affiliate URL khi provider không trả deep-link', () => {
    const resolved = accessTrade.resolveAccessTradeAffiliateUrl({ campaign_id: 'campaign-1', product_url: 'https://merchant.example/product/1' });
    equal(resolved.affiliateUrl, ''); equal(resolved.deepLinkSupported, false); equal(resolved.reason, 'provider_deeplink_not_supported');
    assert(!JSON.stringify(resolved).includes('go.isclix.com'));
    const canonical = accessTrade.resolveAccessTradeCanonicalProductUrl({
      aff_link: 'https://go.isclix.com/deep_link/campaign?url=https%3A%2F%2Fmerchant.example%2Fp%2F1',
    });
    equal(canonical.canonicalProductUrl, '');
    equal(canonical.status, 'unavailable');
    const duplicatedTrackingValue = accessTrade.resolveAccessTradeCanonicalProductUrl({
      url: 'https://unknown-tracker.example/click/1',
      aff_link: 'https://unknown-tracker.example/click/1',
    });
    equal(duplicatedTrackingValue.canonicalProductUrl, '');
    equal(duplicatedTrackingValue.status, 'unavailable');
  });

  await test('payload datafeed chính thức giữ riêng url và aff_link', () => {
    const fetchedAt = new Date().toISOString();
    const raw = {
      __sandealEndpoint: 'datafeed', __sandealFetchedAt: fetchedAt,
      product_id: 'provider-product-1', name: 'Sản phẩm datafeed chính thức',
      url: 'https://merchant.example/products/provider-product-1',
      aff_link: 'https://go.isclix.com/deep_link/campaign?url=https%3A%2F%2Fmerchant.example%2Fproducts%2Fprovider-product-1',
      image: 'https://images.example/provider-product-1.jpg', price: 120000, discount: 99000,
    };
    const normalized = accessTrade.normalizeAccessTradeItem(raw);
    equal(normalized.canonicalProductUrl, raw.url);
    equal(normalized.canonicalUrlSourceField, 'url');
    equal(normalized.canonicalUrlSourceEndpoint, 'datafeed');
    equal(normalized.affiliateUrl, raw.aff_link);
    equal(normalized.affiliateUrlSourceField, 'aff_link');
    equal(normalized.affiliateUrlSourceEndpoint, 'datafeed');
    const observed = accessTrade.observeAccessTradePayload({ data: [raw] }, [raw]);
    assert(observed.observedCanonicalUrlFields.includes('url'));
    assert(observed.observedAffiliateUrlFields.includes('aff_link'));
  });

  await test('chỉ field provider trong allowlist tạo affiliate provenance', () => {
    const direct = accessTrade.resolveAccessTradeAffiliateUrl({
      campaign_id: 'campaign-1',
      aff_link: 'https://tracking.example/direct-provider-link',
      click_url: 'https://untrusted.example/not-allowlisted',
    });
    equal(direct.source, 'provider_api'); equal(direct.field, 'aff_link');
    equal(direct.affiliateUrl, 'https://tracking.example/direct-provider-link');
    equal(direct.deepLinkSupported, undefined);
    const now = new Date().toISOString();
    const directEligibility = eligibility.evaluateProductEligibility(product({
      affiliateUrl: direct.affiliateUrl,
      affiliateUrlSource: direct.source,
      affiliateUrlSourceField: direct.field,
      deepLinkSupported: direct.deepLinkSupported,
      linkLastCheckedAt: now,
      affiliateLastCheckedAt: now,
      imageLastCheckedAt: now,
      priceObservedAt: now,
      priceTruthState: 'FRESH',
    }));
    assert(!directEligibility.criticalBlockers.includes('affiliate_provenance_missing'));
    const unknown = accessTrade.resolveAccessTradeAffiliateUrl({ click_url: 'https://untrusted.example/not-allowlisted' });
    equal(unknown.source, 'none'); equal(unknown.affiliateUrl, '');
    equal(jobs.accessTradeAffiliateSupport(product({ affiliateUrlSourceField: 'aff_link' })).supported, true);
    equal(jobs.accessTradeAffiliateSupport(product({ affiliateUrlSourceField: 'click_url' })).supported, false);
  });

  await test('product URL khỏe không làm affiliate thiếu trở thành publishable', () => {
    const evaluation = eligibility.evaluateProductEligibility(product({
      affiliateUrl: undefined,
      affiliateUrlSource: 'none',
      affiliateHealthStatus: 'unknown',
      affiliateLastCheckedAt: undefined,
      affiliateUrlSourceField: undefined,
    }));
    assert(!evaluation.criticalBlockers.includes('product_url_unhealthy'));
    assert(evaluation.criticalBlockers.includes('missing_affiliate_url'));
    assert(evaluation.criticalBlockers.includes('affiliate_url_unhealthy'));
    equal(evaluation.eligibleForPublish, false);
  });

  await test('nút scan khóa khi chạy và polling SUCCEEDED trả counters', async () => {
    const pageSource = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    assert(pageSource.includes('disabled={runningBot}'));
    assert(pageSource.includes('handleProductHealthScan'));
    assert(pageSource.includes('pollScanJob({ jobId })'));
    const sequence = [envelope({ id: 'scan-1', status: 'RUNNING' }), envelope({ id: 'scan-1', status: 'SUCCEEDED', result: { total: 52, processed: 52, healthy: 15, unhealthy: 37, quarantined: 2, unchanged: 4, skipped: 0, failed: 0, durationMs: 1250 } })];
    const result = await polling.pollScanJob({ jobId: 'scan-1', fetchImpl: async () => sequence.shift(), wait: async () => {}, intervalMs: 0, maximumPolls: 3 });
    equal(result.status, 'SUCCEEDED'); equal(result.result.unhealthy, 37); equal(result.result.processed, 52);
    const pollIndex = pageSource.indexOf('pollScanJob({ jobId })');
    const reloadIndex = pageSource.indexOf('await loadRecent()', pollIndex);
    assert(pollIndex >= 0 && reloadIndex > pollIndex, 'terminal polling must refresh product records');
  });

  await test('nút scan polling FAILED giữ và hiển thị lý do lỗi', async () => {
    const pageSource = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    assert(pageSource.includes("job.status !== 'SUCCEEDED'"));
    assert(pageSource.includes('job.lastErrorMessage'));
    const result = await polling.pollScanJob({ jobId: 'scan-2', fetchImpl: async () => envelope({ id: 'scan-2', status: 'FAILED', lastErrorCode: 'NETWORK_ERROR', lastErrorMessage: 'upstream reset' }), wait: async () => {}, intervalMs: 0 });
    equal(result.status, 'FAILED'); equal(result.lastErrorCode, 'NETWORK_ERROR');
  });

  await test('UI không tạo href khi link chưa verified/healthy', () => {
    const detailSource = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/products/[id]/page.tsx'), 'utf8');
    assert(detailSource.includes("data-link-state={affiliateLinkEnabled ? 'enabled' : 'disabled'}"));
    assert(detailSource.includes('disabled aria-disabled="true">Link affiliate bị khóa'));
    assert(detailSource.includes("product.affiliateUrlStatus === 'verified'"));
    assert(detailSource.includes('verificationIsFresh(product.affiliateLastCheckedAt)'));
    assert(detailSource.includes('verificationIsFresh(product.linkLastCheckedAt)'));
    assert(!detailSource.includes('product.affiliateUrl && <a'));
  });

  await test('Safe Publish bị khóa nếu product URL hoặc affiliate URL không hợp lệ', () => {
    const badProduct = safety.evaluateSafePublish(product({ linkHealthStatus: 'timeout' }));
    const badAffiliate = safety.evaluateSafePublish(product({ affiliateHealthStatus: 'not_allowed' }));
    equal(badProduct.eligible, false); equal(badAffiliate.eligible, false);
    assert(badProduct.reasons.includes('product_url_unhealthy'));
    assert(badAffiliate.reasons.includes('affiliate_url_unhealthy'));
  });

  await test('mọi đường ghi URL mới đều làm mất hiệu lực health cũ', async () => {
    await adapter.writeCollection('products', [product()]);
    const changed = await products.saveCanonicalProduct('at-product', {
      affiliateUrl: 'https://tracking.example/click/changed',
    });
    equal(changed.affiliateHealthStatus, 'unknown');
    equal(changed.affiliateUrlErrorCode, 'URL_CHANGED_RECHECK_REQUIRED');
    equal(changed.publicHidden, true); equal(changed.publicBlocked, true);
    assert(changed.publicBlockReasons.includes('affiliate_url_unhealthy'));
  });

  await test('record 30shinestore được quarantine mềm, không bị xóa', async () => {
    await adapter.writeCollection('products', [product({
      originalUrl: 'https://30shinestore.com/products/item-1',
      canonicalProductUrl: 'https://30shinestore.com/products/item-1',
      affiliateUrl: 'https://go.isclix.com/deep_link/legacy?url=https%3A%2F%2F30shinestore.com%2Fproducts%2Fitem-1',
      affiliateUrlSource: undefined, affiliateUrlProvider: undefined, affiliateUrlSourceField: undefined, affiliateUrlStatus: 'unverified', deepLinkSupported: undefined,
    })]);
    const originalFetch = global.fetch;
    global.fetch = async (input) => String(input).includes('isclix')
      ? new Response('Not Allowed!', { status: 200 })
      : (() => { const error = new Error('socket hang up'); error.code = 'ECONNRESET'; throw error; })();
    try {
      await jobs.executeProductIntelligenceJob({ id: 'health-job', type: 'RECHECK_PRODUCT_HEALTH', payload: { limit: 10, healthTarget: 'all' }, dryRun: false });
    } finally { global.fetch = originalFetch; }
    const stored = await products.getProductById('at-product');
    assert(stored, 'record must remain stored'); equal(stored.status, 'archived'); equal(stored.lifecycleState, 'QUARANTINED');
    equal(stored.canonicalProductUrl, 'https://30shinestore.com/products/item-1');
    equal(stored.publicHidden, true); equal(stored.publicBlocked, true);
    assert(stored.publicBlockReasons.includes('product_url_unhealthy'));
    assert(stored.publicBlockReasons.includes('affiliate_url_unhealthy'));
  });

  console.log(`\nAccessTrade link safety: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
