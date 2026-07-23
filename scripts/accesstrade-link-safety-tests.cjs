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
process.env.ACCESS_TRADE_API_KEY = 'isolated-access-trade-test-key';

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

  function datafeedRecord(index = 1, overrides = {}) {
    return {
      product_id: `provider-product-${index}`,
      name: `Tai nghe Bluetooth Model X${index}`,
      price: 120000 + index,
      url: `https://merchant.example/products/provider-product-${index}`,
      aff_link: `https://go.isclix.com/deep_link/campaign?url=https%3A%2F%2Fmerchant.example%2Fproducts%2Fprovider-product-${index}`,
      image: `https://images.example/provider-product-${index}.jpg`,
      merchant: 'Merchant Example',
      shop_id: 'shop-1',
      shop_name: 'Merchant Shop',
      cate: 'Điện tử',
      ...overrides,
    };
  }

  await test('datafeed { data, total } giữ đủ 80 record qua extract và normalize', () => {
    const records = Array.from({ length: 80 }, (_, index) => datafeedRecord(index + 1));
    const result = accessTrade.processAccessTradePayload(
      { data: records, total: 80 },
      { keyword: 'tai nghe', kind: 'product', limit: 20, imageOnly: false, affiliateLinkOnly: false },
    );
    equal(result.diagnostics.providerReportedItemCount, 80);
    equal(result.diagnostics.rawItemCount, 80);
    equal(result.diagnostics.extractedItemCount, 80);
    equal(result.diagnostics.normalizedItemCount, 80);
    equal(result.diagnostics.classifiedProductCount, 80);
    equal(result.items.length, 20);
    equal(result.diagnostics.returnedCount, 20);
    equal(result.diagnostics.limitedCount, 60);
    equal(result.diagnostics.rejectedCount, 0);
    equal(result.diagnostics.state, 'RESULTS_RETURNED');
  });

  await test('keyword tiếng Việt khớp có dấu, không dấu và qua alias title/name/product_name', () => {
    const aliases = [
      datafeedRecord(201, { name: undefined, title: 'Điện thoại chống nước Model A' }),
      datafeedRecord(202, { name: 'Điện thoại pin bền Model B' }),
      datafeedRecord(203, { name: undefined, product_name: 'Điện thoại màn hình lớn Model C' }),
    ];
    const accented = accessTrade.processAccessTradePayload({ data: aliases, total: 3 }, { keyword: 'điện thoại', kind: 'product' });
    const plain = accessTrade.processAccessTradePayload({ data: aliases, total: 3 }, { keyword: 'dien thoai', kind: 'product' });
    equal(accented.items.length, 3);
    equal(plain.items.length, 3);
    equal(plain.diagnostics.rejectedByReason.KEYWORD_MISMATCH, undefined);
  });

  await test('structured rejection counters có lý do riêng và optional chỉ bắt buộc khi bật filter', () => {
    const missingTitle = datafeedRecord(210, { name: undefined });
    const wrongKeyword = datafeedRecord(211, { name: 'Bàn phím cơ Model K11' });
    const malformed = datafeedRecord(212, { url: 'javascript:alert(1)' });
    const unsafe = datafeedRecord(213, { url: 'http://127.0.0.1/private' });
    const voucher = datafeedRecord(214, { type: 'voucher', name: 'Voucher tai nghe giảm 20%', voucher_code: 'SAFE20' });
    const missingImage = datafeedRecord(215); delete missingImage.image;
    const missingAffiliate = datafeedRecord(216); delete missingAffiliate.aff_link;
    const result = accessTrade.processAccessTradePayload(
      { data: [missingTitle, wrongKeyword, malformed, unsafe, voucher, missingImage, missingAffiliate], total: 7 },
      { keyword: 'tai nghe', kind: 'product', imageOnly: true, affiliateLinkOnly: true },
    );
    equal(result.items.length, 0);
    equal(result.diagnostics.rejectedByReason.MISSING_TITLE, 1);
    equal(result.diagnostics.rejectedByReason.KEYWORD_MISMATCH, 1);
    equal(result.diagnostics.rejectedByReason.INVALID_URL, 1);
    equal(result.diagnostics.rejectedByReason.UNSAFE_DESTINATION, 1);
    equal(result.diagnostics.rejectedByReason.TYPE_MISMATCH, 1);
    equal(result.diagnostics.rejectedByReason.IMAGE_REQUIRED, 1);
    equal(result.diagnostics.rejectedByReason.AFFILIATE_LINK_REQUIRED, 1);
    equal(result.diagnostics.rejectedCount, 7);
  });

  await test('search thật phân trang cục bộ vì datafeeds không hỗ trợ keyword provider', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    const requestedUrls = [];
    global.fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      requestedUrls.push(url);
      const page = Number(url.searchParams.get('page'));
      const rows = Array.from({ length: 200 }, (_, index) => datafeedRecord(page * 1000 + index, {
        name: page === 2 && index < 20 ? `Tai nghe Bluetooth trang 2 Model ${index}` : `Bàn phím trang ${page} Model ${index}`,
      }));
      return new Response(JSON.stringify({ data: rows, total: 400 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await accessTrade.searchAccessTrade({ keyword: 'tai nghe', kind: 'product', limit: 20 });
      equal(calls, 2);
      assert(requestedUrls.every((url) => !url.searchParams.has('keyword')));
      equal(result.items.length, 20);
      equal(result.diagnostics.acceptedCount, 20);
      equal(result.diagnostics.rejectedByReason.KEYWORD_MISMATCH, 380);
    } finally { global.fetch = originalFetch; }
  });

  await test('datafeed data.data và root array đều được extract có giới hạn', () => {
    const nested = accessTrade.processAccessTradePayload(
      { data: { data: [datafeedRecord(1), datafeedRecord(2)] }, total: 2 },
      { kind: 'product', limit: 20 },
    );
    equal(nested.diagnostics.extractedItemCount, 2);
    equal(nested.items.length, 2);
    const root = accessTrade.processAccessTradePayload(
      [datafeedRecord(3), datafeedRecord(4)],
      { kind: 'product', limit: 20 },
    );
    equal(root.diagnostics.rawItemCount, 2);
    equal(root.items.length, 2);
  });

  await test('datafeed product không cần provider type field', () => {
    const result = accessTrade.processAccessTradePayload(
      { data: [datafeedRecord(5)], total: 1 },
      { kind: 'product', limit: 20 },
    );
    equal(result.items.length, 1);
    equal(result.items[0].kind, 'product');
    equal(result.items[0].sourceItemId, 'provider-product-5');
  });

  await test('thiếu aff_link khi filter tắt vẫn giữ product để review', () => {
    const record = datafeedRecord(6);
    delete record.aff_link;
    const result = accessTrade.processAccessTradePayload(
      { data: [record], total: 1 },
      { kind: 'product', affiliateLinkOnly: false },
    );
    equal(result.items.length, 1);
    equal(result.items[0].kind, 'product');
    assert(result.items[0].normalizationIssues.includes('MISSING_AFFILIATE_URL'));
    equal(result.items[0].publicDecision, 'needs_review');
  });

  await test('thiếu image khi filter tắt vẫn giữ product để review', () => {
    const record = datafeedRecord(7);
    delete record.image;
    const result = accessTrade.processAccessTradePayload(
      { data: [record], total: 1 },
      { kind: 'product', imageOnly: false },
    );
    equal(result.items.length, 1);
    assert(result.items[0].normalizationIssues.includes('MISSING_IMAGE'));
    equal(result.diagnostics.reviewByReason.MISSING_IMAGE, 1);
  });

  await test('canonical URL lỗi bị loại khỏi search với lý do INVALID_URL', () => {
    const result = accessTrade.processAccessTradePayload(
      { data: [datafeedRecord(8, { url: 'javascript:alert(1)' })], total: 1 },
      { kind: 'product' },
    );
    equal(result.items.length, 0);
    equal(result.diagnostics.rejectedByReason.INVALID_URL, 1);
  });

  await test('giá nguồn sai định dạng được giữ làm provenance INVALID, không bị gọi là MISSING', () => {
    const result = accessTrade.processAccessTradePayload(
      { data: [datafeedRecord(81, { price: 'not-a-price' })], total: 1 },
      { kind: 'product' },
    );
    equal(result.items.length, 1);
    equal(result.items[0].price, 0);
    assert(result.items[0].normalizationIssues.includes('INVALID_PRICE'));
    assert(!result.items[0].normalizationIssues.includes('MISSING_PRICE'));
    equal(result.items[0].fieldProvenance.price.value, 'not-a-price');
    equal(result.items[0].fieldProvenance.price.verificationStatus, 'INVALID');
    equal(result.diagnostics.reviewByReason.INVALID_PRICE, 1);
    const mapped = accessTrade.mapAccessTradeToProduct(result.items[0]);
    equal(mapped.priceVerificationStatus, 'INVALID');
  });

  await test('mapping tự động giữ INVALID khác MISSING cho canonical và affiliate URL', () => {
    const normalized = accessTrade.normalizeAccessTradeItem(datafeedRecord(82, { url: 'javascript:bad', aff_link: 'data:text/plain,bad' }));
    const mapped = accessTrade.mapAccessTradeToProduct(normalized);
    equal(mapped.canonicalUrlStatus, 'invalid');
    equal(mapped.affiliateUrlStatus, 'invalid');
    equal(mapped.fieldProvenance.canonicalProductUrl.verificationStatus, 'INVALID');
    equal(mapped.fieldProvenance.affiliateUrl.verificationStatus, 'INVALID');
    equal(mapped.publicHidden, true);
    equal(mapped.publicBlocked, true);
    const searched = accessTrade.processAccessTradePayload({ data: [datafeedRecord(82, { url: 'javascript:bad', aff_link: 'data:text/plain,bad' })], total: 1 }, { kind: 'product' });
    equal(searched.items.length, 0);
    equal(searched.diagnostics.rejectedByReason.INVALID_URL, 1);
  });

  await test('provider có dữ liệu nhưng không extract được có state riêng', () => {
    const result = accessTrade.processAccessTradePayload(
      { data: [null, 42, 'unsafe'], total: 3 },
      { kind: 'product' },
    );
    equal(result.items.length, 0);
    equal(result.diagnostics.state, 'PROVIDER_DATA_REJECTED');
    equal(result.diagnostics.providerReportedItemCount, 3);
    equal(result.diagnostics.rejectedByReason.INVALID_RECORD, 3);
  });

  await test('summary được tính đúng từ đúng collection cuối cùng', () => {
    const result = accessTrade.processAccessTradePayload(
      { data: [datafeedRecord(9), datafeedRecord(10)], total: 2 },
      { kind: 'product', limit: 1 },
    );
    equal(result.summary.total, result.items.length);
    equal(result.summary.products, result.products.length);
    equal(result.summary.vouchers, result.vouchers.length);
    equal(result.summary.campaigns, result.campaigns.length);
    equal(result.summary.storeOffers, result.storeOffers.length);
    equal(result.summary.unknown, result.unknown.length);
  });

  await test('canonical và affiliate URL tách biệt, deep-link Unicode chỉ decode một lớp', () => {
    const destination = 'https://merchant.example/sản-phẩm?q=đỏ&nested=https%3A%2F%2Finner.example%2Fa%3Fx%3D1';
    const affiliate = `https://go.isclix.com/deep_link/campaign?url=${encodeURIComponent(destination)}`;
    const result = accessTrade.processAccessTradePayload(
      { data: [datafeedRecord(11, { url: 'https://merchant.example/sản-phẩm?q=đỏ', aff_link: affiliate })], total: 1 },
      { kind: 'product' },
    );
    const item = result.items[0];
    assert(item.canonicalProductUrl !== item.affiliateUrl);
    equal(item.affiliateUrl, new URL(affiliate).href);
    const decoded = new URL(item.affiliateDestinationUrl);
    equal(decoded.searchParams.get('q'), 'đỏ');
    equal(decoded.searchParams.get('nested'), 'https://inner.example/a?x=1');
  });

  await test('duplicate provider record được dedupe bằng identity ổn định', () => {
    const record = datafeedRecord(12);
    const first = accessTrade.processAccessTradePayload({ data: [record, { ...record }], total: 2 }, { kind: 'product' });
    const second = accessTrade.processAccessTradePayload({ data: [{ ...record }], total: 1 }, { kind: 'product' });
    equal(first.items.length, 1);
    equal(first.diagnostics.duplicateCount, 1);
    equal(first.diagnostics.rejectedByReason.DUPLICATE, 1);
    equal(first.items[0].id, second.items[0].id);
  });

  await test('duplicate merge deterministic và bổ sung evidence optional', () => {
    const withoutImage = datafeedRecord(220, { image: undefined, desc: 'Mô tả chính' });
    const withImage = datafeedRecord(220, { desc: undefined, image: 'https://images.example/merged.jpg' });
    const forward = accessTrade.processAccessTradePayload({ data: [withoutImage, withImage], total: 2 }, { kind: 'product' });
    const reverse = accessTrade.processAccessTradePayload({ data: [withImage, withoutImage], total: 2 }, { kind: 'product' });
    equal(forward.items.length, 1);
    equal(reverse.items.length, 1);
    equal(JSON.stringify(forward.items[0]), JSON.stringify(reverse.items[0]));
    equal(forward.items[0].imageUrl, 'https://images.example/merged.jpg');
    equal(forward.items[0].description, 'Mô tả chính');
  });

  await test('raw metadata bị chặn secret và giới hạn ở allowlist', () => {
    const result = accessTrade.processAccessTradePayload({ data: [datafeedRecord(13, {
      authorization: 'must-not-leak', api_key: 'must-not-leak', unexpected: 'not-allowlisted',
    })], total: 1 }, { kind: 'product' });
    const raw = result.items[0].rawData;
    assert(!('authorization' in raw));
    assert(!('api_key' in raw));
    assert(!('unexpected' in raw));
    equal(raw.product_id, 'provider-product-13');
  });

  await test('UI phân biệt provider rỗng và provider có data nhưng zero-normalized', () => {
    const pageSource = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    assert(pageSource.includes("state?: 'RESULTS_RETURNED' | 'PROVIDER_EMPTY' | 'PROVIDER_DATA_REJECTED'"));
    assert(pageSource.includes("atResults.diagnostics?.state === 'PROVIDER_DATA_REJECTED'"));
    assert(pageSource.includes('AccessTrade đã trả dữ liệu, nhưng không có bản ghi nào vượt qua bước chuẩn hoá'));
    assert(pageSource.includes('providerReportedItemCount'));
    assert(pageSource.includes('aria-selected={activeTab === tab.id}'));
    assert(pageSource.includes('role="tabpanel"'));
    assert(pageSource.includes('id={`product-source-panel-${tabId}`}'));
    assert(pageSource.includes('id="product-source-panel-csv"'));
    for (const tabId of ['shopee', 'tiktok', 'lazada', 'other']) assert(pageSource.includes(`'${tabId}',`));
  });

  await test('HTTP image được giữ làm bằng chứng nhưng UI không tạo mixed-content request', () => {
    const result = accessTrade.processAccessTradePayload({
      data: [datafeedRecord(14, { image: 'http://legacy-images.example/item.jpg' })], total: 1,
    }, { kind: 'product' });
    equal(result.items[0].imageUrl, 'http://legacy-images.example/item.jpg');
    equal(result.items[0].publicDecision, 'needs_review');
    equal(result.items[0].autoPublishEligible, false);
    const sourcesPage = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    const safeImage = fs.readFileSync(path.join(process.cwd(), 'src/components/safe-product-image.tsx'), 'utf8');
    const publicImage = fs.readFileSync(path.join(process.cwd(), 'src/app/deals/ProductImage.tsx'), 'utf8');
    assert(!sourcesPage.includes("candidate.protocol = 'https:'"));
    assert(safeImage.includes("parsed.protocol === 'https:'"));
    assert(publicImage.includes("parsed.protocol === 'https:'"));
  });

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
    assert(pageSource.includes('pollScanJob({'));
    const sequence = [envelope({ id: 'scan-1', status: 'RUNNING' }), envelope({ id: 'scan-1', status: 'SUCCEEDED', result: { total: 52, processed: 52, healthy: 15, unhealthy: 37, quarantined: 2, unchanged: 4, skipped: 0, failed: 0, durationMs: 1250 } })];
    const result = await polling.pollScanJob({ jobId: 'scan-1', fetchImpl: async () => sequence.shift(), wait: async () => {}, intervalMs: 0, maximumPolls: 3 });
    equal(result.status, 'SUCCEEDED'); equal(result.result.unhealthy, 37); equal(result.result.processed, 52);
    const pollIndex = pageSource.indexOf('pollScanJob({');
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
