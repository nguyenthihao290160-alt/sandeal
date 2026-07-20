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
    affiliateUrl: 'https://tracking.example/click/1', affiliateUrlSource: 'provider_api', deepLinkSupported: true,
    imageUrl: 'https://images.example/product.jpg', price: 100000, currency: 'VND', tags: [], benefits: [], warnings: [],
    riskLevel: 'low', status: 'needs_review', verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', publicHidden: true,
    publicBlocked: false, needsVerification: true, createdAt: now, updatedAt: now, ...overrides,
  };
}

(async () => {
  const health = require('../src/lib/bots/productHealthCheck.ts');
  const accessTrade = require('../src/lib/integrations/accesstrade.ts');
  const safety = require('../src/lib/safePublish.ts');
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
  });

  await test('redirect giới hạn đến trang sản phẩm hợp lệ và lưu final URL', async () => {
    const fetchImpl = async (input) => String(input).includes('tracking.example')
      ? new Response('', { status: 302, headers: { location: 'https://merchant.example/products/sku-1' } })
      : new Response('<html><title>Product SKU 1</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const result = await health.checkLinkHealth('https://tracking.example/click', { resolveDns: false, fetchImpl });
    equal(result.ok, true); equal(result.finalUrl, 'https://merchant.example/products/sku-1');
  });

  await test('timeout và connection reset được phân loại rõ', async () => {
    const timeout = new Error('timed out'); timeout.name = 'TimeoutError';
    const timed = await health.checkLinkHealth('https://merchant.example/timeout', { resolveDns: false, fetchImpl: async () => { throw timeout; } });
    equal(timed.status, 'timeout'); equal(timed.errorCode, 'TIMEOUT'); equal(timed.timedOut, true);
    const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    const disconnected = await health.checkLinkHealth('https://merchant.example/reset', { resolveDns: false, fetchImpl: async () => { throw reset; } });
    equal(disconnected.status, 'error'); equal(disconnected.errorCode, 'ECONNRESET');
  });

  await test('không tự ghép affiliate URL khi provider không trả deep-link', () => {
    const resolved = accessTrade.resolveAccessTradeAffiliateUrl({ campaign_id: 'campaign-1', product_url: 'https://merchant.example/product/1' });
    equal(resolved.affiliateUrl, ''); equal(resolved.deepLinkSupported, false); equal(resolved.reason, 'provider_deeplink_not_supported');
    assert(!JSON.stringify(resolved).includes('go.isclix.com'));
  });

  await test('nút scan khóa khi chạy và polling SUCCEEDED trả counters', async () => {
    const pageSource = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    assert(pageSource.includes('disabled={runningBot}'));
    assert(pageSource.includes('handleProductHealthScan'));
    assert(pageSource.includes('pollScanJob({ jobId })'));
    const sequence = [envelope({ id: 'scan-1', status: 'RUNNING' }), envelope({ id: 'scan-1', status: 'SUCCEEDED', result: { checked: 52, valid: 15, blocked: 37, failed: 2 } })];
    const result = await polling.pollScanJob({ jobId: 'scan-1', fetchImpl: async () => sequence.shift(), wait: async () => {}, intervalMs: 0, maximumPolls: 3 });
    equal(result.status, 'SUCCEEDED'); equal(result.result.blocked, 37);
  });

  await test('nút scan polling FAILED giữ và hiển thị lý do lỗi', async () => {
    const pageSource = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    assert(pageSource.includes("job.status !== 'SUCCEEDED'"));
    assert(pageSource.includes('job.lastErrorMessage'));
    const result = await polling.pollScanJob({ jobId: 'scan-2', fetchImpl: async () => envelope({ id: 'scan-2', status: 'FAILED', lastErrorCode: 'NETWORK_ERROR', lastErrorMessage: 'upstream reset' }), wait: async () => {}, intervalMs: 0 });
    equal(result.status, 'FAILED'); equal(result.lastErrorCode, 'NETWORK_ERROR');
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
      affiliateUrl: 'https://go.isclix.com/deep_link/legacy?url=https%3A%2F%2F30shinestore.com%2Fproducts%2Fitem-1',
      affiliateUrlSource: undefined, deepLinkSupported: undefined,
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
    equal(stored.publicHidden, true); equal(stored.publicBlocked, true);
    assert(stored.publicBlockReasons.includes('product_url_unhealthy'));
    assert(stored.publicBlockReasons.includes('affiliate_url_unhealthy'));
  });

  console.log(`\nAccessTrade link safety: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
