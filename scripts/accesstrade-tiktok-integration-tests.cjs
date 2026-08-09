/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `accesstrade-tiktok-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = path.join(tempDir, 'data');
process.env.NODE_ENV = 'test';
process.env.ACCESS_TRADE_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function rawProduct(id = '1731928656336816836', overrides = {}) {
  return {
    id,
    title: `Tai nghe Bluetooth chống ồn chính hãng mẫu ${id}`,
    description: 'Sản phẩm có thông tin kỹ thuật, giá, hình ảnh và gian hàng do nguồn đối tác cung cấp.',
    detail_link: `https://shop.tiktok.com/view/product/${id}?region=VN`,
    main_image_url: `https://p16-oec-va.ibyteimg.com/products/${id}.webp`,
    has_inventory: true,
    units_sold: 1234,
    original_price: { currency: 'VND', minimum_amount: '399000', maximum_amount: '399000' },
    sales_price: { currency: 'VND', minimum_amount: '299000', maximum_amount: '299000' },
    commission: { amount: '36901.66', currency: 'VND', rate: 1234 },
    shop: { id: `shop-${id}`, name: `Cửa hàng ${id}` },
    category_chains: [
      { id: '600001', local_name: 'Điện tử', parent_id: '0', is_leaf: false },
      { id: '600002', local_name: 'Tai nghe', parent_id: '600001', is_leaf: true },
    ],
    updated_at: '2026-08-01T01:02:03.000Z',
    ...overrides,
  };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function searchEnvelope(products, nextPageToken) {
  return { status: true, data: { products, next_page_token: nextPageToken, total_count: products.length } };
}

function dependencies(fetchImpl, overrides = {}) {
  return {
    credential: 'test-access-key',
    fetchImpl,
    circuit: false,
    random: () => 0,
    sleep: async () => undefined,
    maximumAttempts: 3,
    ...overrides,
  };
}

async function main() {
  const integration = require('../src/lib/integrations/accesstradeTikTokShop.ts');
  const circuits = require('../src/lib/bots/domainCircuitBreaker.ts');
  const storage = require('../src/lib/storage/adapter.ts');
  const queue = require('../src/lib/storage/candidateQueue.ts');
  const productsStore = require('../src/lib/storage/products.ts');
  const platform = require('../src/lib/autonomous/sourceAdapterPlatform.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const automationStore = require('../src/lib/automation/store.ts');
  const bridge = require('../src/lib/automation/candidateBridge.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const eligibility = require('../src/lib/productEligibility.ts');

  const originalInfo = console.info;
  const events = [];
  console.info = (...args) => {
    try { const event = JSON.parse(String(args[0])); if (event.event) events.push(event); } catch { }
  };

  await test('1 complete product normalization preserves identity, price, commission, sales, category, and shop', async () => {
    const result = integration.normalizeAccessTradeTikTokProduct(rawProduct());
    assert.equal(result.ok, true);
    const product = result.product;
    assert.equal(product.source, 'accesstrade_tiktok_shop');
    assert.equal(product.platform, 'tiktok_shop');
    assert.equal(product.id, '1731928656336816836');
    assert.equal(product.shopId, 'shop-1731928656336816836');
    assert.equal(product.merchantIdentity, 'tiktok-shop:shop-1731928656336816836');
    assert.equal(product.price, 399000);
    assert.equal(product.salePrice, 299000);
    assert.equal(product.currentPrice, 299000);
    assert.equal(product.commissionRate, 12.34);
    assert.equal(product.commissionAmount, 36901.66);
    assert.equal(product.unitsSold, 1234);
    assert.equal(product.categoryId, '600002');
    assert.equal(product.categoryChain.length, 2);
    assert.equal(product.affiliateUrl, '');
    assert.equal(product.publicHidden, true);
  });

  const invalidCases = [
    ['2 missing product id is rejected', { id: undefined }, 'MISSING_PRODUCT_ID'],
    ['3 missing title is rejected', { title: '' }, 'MISSING_TITLE'],
    ['4 missing URL is rejected', { detail_link: '' }, 'MISSING_PRODUCT_URL'],
    ['5 invalid URL is rejected', { detail_link: 'javascript:alert(1)' }, 'INVALID_PRODUCT_URL'],
    ['6 missing image is rejected', { main_image_url: '' }, 'MISSING_IMAGE'],
    ['7 invalid price is rejected', { sales_price: {}, original_price: {} }, 'INVALID_PRICE'],
    ['8 missing shop identity is rejected', { shop: {} }, 'MISSING_SHOP_IDENTITY'],
    ['9 unavailable product is rejected', { has_inventory: false }, 'PRODUCT_UNAVAILABLE'],
    ['9a non-TikTok product URL is rejected', { detail_link: 'https://example.com/product/not-tiktok' }, 'INVALID_PRODUCT_URL'],
  ];
  for (const [name, overrides, reason] of invalidCases) {
    await test(name, async () => {
      const result = integration.normalizeAccessTradeTikTokProduct(rawProduct('invalid-case', overrides));
      assert.deepEqual(result, { ok: false, reason });
    });
  }

  await test('9b missing inventory and original price remain absent instead of being fabricated', async () => {
    const result = integration.normalizeAccessTradeTikTokProduct(rawProduct('source-optional', {
      has_inventory: undefined,
      original_price: undefined,
    }));
    assert.equal(result.ok, true);
    assert.equal(result.product.available, undefined);
    assert.equal(result.product.originalPrice, undefined);
    assert.equal(result.product.price, 299000);
    assert.equal(result.product.salePrice, 0);
  });

  await test('10 V2 request uses the exact URL, server token header, repeated keywords, product IDs, and sort mapping', async () => {
    let observed;
    const result = await integration.searchAccessTradeTikTokProducts({
      titleKeywords: ['tai nghe', 'bluetooth'], productIds: ['p-1', 'p-2'], sortStrategy: 'HIGH_COMMISSION_RATE', maximumPages: 1,
    }, dependencies(async (url, init) => {
      observed = { url: new URL(String(url)), init };
      return jsonResponse(searchEnvelope([rawProduct('p-1')]));
    }));
    assert.equal(observed.url.origin + observed.url.pathname, integration.ACCESSTRADE_TIKTOK_PRODUCT_ENDPOINT);
    assert.deepEqual(observed.url.searchParams.getAll('title_keywords'), ['tai nghe', 'bluetooth']);
    assert.deepEqual(observed.url.searchParams.getAll('product_ids'), ['p-1', 'p-2']);
    assert.equal(observed.url.searchParams.get('sort_field'), 'HIGH_COMMISSION_RATE');
    assert.equal(observed.init.headers.Authorization, 'Token test-access-key');
    assert.equal(result.items.length, 1);
  });

  await test('11 page_token follows next_page_token across multiple bounded pages', async () => {
    const urls = [];
    const result = await integration.searchAccessTradeTikTokProducts({ maximumPages: 2, acceptedItemBudget: 10 }, dependencies(async url => {
      urls.push(new URL(String(url)));
      return urls.length === 1
        ? jsonResponse(searchEnvelope([rawProduct('page-1')], 'next-token'))
        : jsonResponse(searchEnvelope([rawProduct('page-2')]));
    }));
    assert.equal(urls.length, 2);
    assert.equal(urls[1].searchParams.get('page_token'), 'next-token');
    assert.equal(result.items.length, 2);
    assert.equal(result.diagnostics.pageCount, 2);
  });

  await test('12 repeated page token terminates deterministically without looping', async () => {
    let calls = 0;
    const result = await integration.searchAccessTradeTikTokProducts({ maximumPages: 3, acceptedItemBudget: 20 }, dependencies(async () => {
      calls += 1;
      return jsonResponse(searchEnvelope([rawProduct(`repeat-${calls}`)], 'same-token'));
    }));
    assert.equal(calls, 2);
    assert.equal(result.diagnostics.stopReason, 'REPEATED_PAGE_TOKEN');
  });

  await test('13 maximum page count is enforced', async () => {
    let calls = 0;
    const result = await integration.searchAccessTradeTikTokProducts({ maximumPages: 2, acceptedItemBudget: 40 }, dependencies(async () => {
      calls += 1;
      return jsonResponse(searchEnvelope([rawProduct(`limit-${calls}`)], `token-${calls}`));
    }));
    assert.equal(calls, 2);
    assert.equal(result.diagnostics.stopReason, 'MAX_PAGES_REACHED');
  });

  await test('14 raw item budget truncates provider accumulation', async () => {
    const result = await integration.searchAccessTradeTikTokProducts({ maximumPages: 3, rawItemBudget: 2, limit: 20, acceptedItemBudget: 20 }, dependencies(async () => (
      jsonResponse(searchEnvelope([rawProduct('budget-1'), rawProduct('budget-2'), rawProduct('budget-3')], 'more'))
    )));
    assert.equal(result.diagnostics.fetched, 2);
    assert.equal(result.diagnostics.stopReason, 'RAW_ITEM_BUDGET_REACHED');
  });

  await test('15 duplicate page records merge deterministically by product ID', async () => {
    let calls = 0;
    const result = await integration.searchAccessTradeTikTokProducts({ maximumPages: 2, acceptedItemBudget: 10 }, dependencies(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(searchEnvelope([rawProduct('merge', { shop: { id: 'shop-merge' } })], 'merge-next'))
        : jsonResponse(searchEnvelope([rawProduct('merge', { shop: { name: 'Shop Merge' } })]));
    }));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].shopId, 'shop-merge');
    assert.equal(result.items[0].shopName, 'Shop Merge');
    assert.equal(result.diagnostics.duplicates, 1);
  });

  await test('16 empty result is successful and bounded', async () => {
    const result = await integration.searchAccessTradeTikTokProducts({}, dependencies(async () => jsonResponse(searchEnvelope([]))));
    assert.equal(result.items.length, 0);
    assert.equal(result.diagnostics.stopReason, 'EMPTY_PAGE');
  });

  await test('17 malformed JSON fails with a semantic code', async () => {
    await assert.rejects(
      integration.searchAccessTradeTikTokProducts({}, dependencies(async () => new Response('{bad', { status: 200 }))),
      error => error.resultType === 'malformed_json',
    );
  });

  await test('18 schema mismatch fails closed', async () => {
    await assert.rejects(
      integration.searchAccessTradeTikTokProducts({}, dependencies(async () => jsonResponse({ status: true, data: { products: {} } }))),
      error => error.resultType === 'schema_mismatch',
    );
  });

  await test('18a malformed product entries consume the raw budget and are rejected by schema reason', async () => {
    const result = await integration.searchAccessTradeTikTokProducts({}, dependencies(async () => (
      jsonResponse(searchEnvelope([null, rawProduct('valid-after-invalid')]))
    )));
    assert.equal(result.diagnostics.fetched, 2);
    assert.equal(result.diagnostics.normalized, 1);
    assert.equal(result.diagnostics.accepted, 1);
    assert.equal(result.diagnostics.rejectedByReason.SOURCE_SCHEMA_INVALID, 1);
  });

  for (const [status, resultType] of [[401, 'unauthorized'], [403, 'forbidden'], [400, 'client_error']]) {
    await test(`19.${status} HTTP ${status} is non-retryable`, async () => {
      let calls = 0;
      await assert.rejects(
        integration.searchAccessTradeTikTokProducts({}, dependencies(async () => { calls += 1; return jsonResponse({}, status); })),
        error => error.resultType === resultType,
      );
      assert.equal(calls, 1);
    });
  }

  await test('20 HTTP 429 honors Retry-After and retries within the fixed attempt bound', async () => {
    let calls = 0;
    const sleeps = [];
    const result = await integration.searchAccessTradeTikTokProducts({}, dependencies(async () => {
      calls += 1;
      return calls < 3 ? jsonResponse({}, 429, { 'retry-after': '2' }) : jsonResponse(searchEnvelope([rawProduct('retry-429')]));
    }, { sleep: async delay => sleeps.push(delay) }));
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2000, 2000]);
    assert.equal(result.items.length, 1);
  });

  await test('21 retryable 5xx uses bounded retry and stops after success', async () => {
    let calls = 0;
    const result = await integration.searchAccessTradeTikTokProducts({}, dependencies(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 503) : jsonResponse(searchEnvelope([rawProduct('retry-503')]));
    }));
    assert.equal(calls, 2);
    assert.equal(result.requests[0].attempts, 2);
  });

  await test('22 timeout aborts the request and does not exceed the attempt bound', async () => {
    let calls = 0;
    await assert.rejects(
      integration.searchAccessTradeTikTokProducts({}, dependencies(async (_url, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      }, { timeoutMs: 5, maximumAttempts: 2 })),
      error => error.resultType === 'timeout',
    );
    assert.equal(calls, 2);
  });

  await test('23 caller abort stops without a retry storm', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = integration.searchAccessTradeTikTokProducts({ signal: controller.signal }, dependencies(async (_url, init) => {
      calls += 1;
      controller.abort();
      if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return jsonResponse(searchEnvelope([]));
    }));
    await assert.rejects(promise, error => error.resultType === 'aborted');
    assert.equal(calls, 1);
  });

  await test('24 tokens and Authorization values never appear in errors or structured events', async () => {
    events.length = 0;
    const secret = 'sensitive-test-access-key';
    let caught;
    try {
      await integration.searchAccessTradeTikTokProducts({}, dependencies(async () => jsonResponse({}, 401), { credential: secret }));
    } catch (error) { caught = error; }
    assert.equal(JSON.stringify({ caught, events }).includes(secret), false);
    assert.equal(JSON.stringify({ caught, events }).toLowerCase().includes('authorization'), false);
  });

  await test('24a manual TikTok search route returns truthful previews without persistence', async () => {
    const previousCredential = process.env.ACCESS_TRADE_API_KEY;
    const previousFetch = global.fetch;
    const queueBefore = (await queue.listCandidateQueue()).length;
    process.env.ACCESS_TRADE_API_KEY = 'manual-route-test-key';
    global.fetch = async () => jsonResponse(searchEnvelope([rawProduct('manual-route-product', {
      shop: { id: 'manual-route-shop', name: 'Manual Route Shop' },
    })]));
    try {
      const { NextRequest } = require('next/server');
      const route = require('../src/app/api/product-sources/accesstrade/tiktok/search/route.ts');
      const response = await route.POST(new NextRequest('http://localhost/api/product-sources/accesstrade/tiktok/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keyword: 'tai nghe', limit: 20 }),
      }));
      const envelope = await response.json();
      assert.equal(response.status, 200);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.source, 'accesstrade_tiktok_shop');
      assert.equal(envelope.data.sourceLabel, 'TikTok Shop qua AccessTrade');
      assert.equal(envelope.data.items[0].state, 'preview');
      assert.equal(envelope.data.items[0].merchantIdentity, 'tiktok-shop:manual-route-shop');
      assert.equal('rawData' in envelope.data.items[0], false);
      assert.equal(envelope.data.diagnostics.previewOnly, true);
      assert.equal(envelope.data.diagnostics.persisted, false);
      assert.equal((await queue.listCandidateQueue()).length, queueBefore);
    } finally {
      global.fetch = previousFetch;
      process.env.ACCESS_TRADE_API_KEY = previousCredential;
    }
  });

  await test('25 affiliate V2 prefers aff_short_url and sends supported tracking fields', async () => {
    let observed;
    const link = await integration.createAccessTradeTikTokAffiliateLink({
      productUrl: 'https://shop.tiktok.com/view/product/link-short', productId: 'link-short',
      tracking: { utmSource: 'sandeal', sub1: 'one', sub4: 'four' },
    }, dependencies(async (_url, init) => {
      observed = JSON.parse(init.body);
      return jsonResponse({ status: true, data: { aff_short_url: 'https://go.isclix.com/s/short', aff_url: 'https://go.isclix.com/full' } });
    }));
    assert.equal(link.sourceField, 'aff_short_url');
    assert.equal(observed.product_url, 'https://shop.tiktok.com/view/product/link-short');
    assert.equal(observed.product_id, 'link-short');
    assert.equal(observed.sub_1, 'one');
    assert.equal(observed.sub_4, 'four');
  });

  await test('26 affiliate V2 falls back to valid aff_url', async () => {
    const link = await integration.createAccessTradeTikTokAffiliateLink({ productUrl: 'https://shop.tiktok.com/view/product/link-full' }, dependencies(async () => (
      jsonResponse({ status: true, data: { aff_short_url: '', aff_url: 'https://go.isclix.com/full/link' } })
    )));
    assert.equal(link.sourceField, 'aff_url');
  });

  await test('27 missing or malformed affiliate URL fails closed without original URL fallback', async () => {
    await assert.rejects(
      integration.createAccessTradeTikTokAffiliateLink({ productUrl: 'https://shop.tiktok.com/view/product/no-link' }, dependencies(async () => (
        jsonResponse({ status: true, data: { aff_short_url: 'javascript:bad', aff_url: '' } })
      ))),
      error => error.resultType === 'schema_mismatch',
    );
    const originalUrl = 'https://shop.tiktok.com/view/product/original-returned';
    await assert.rejects(
      integration.createAccessTradeTikTokAffiliateLink({ productUrl: originalUrl }, dependencies(async () => (
        jsonResponse({ status: true, data: { aff_short_url: originalUrl } })
      ))),
      error => error.resultType === 'schema_mismatch',
    );
  });

  await test('28 affiliate API status false and 5xx both fail', async () => {
    await assert.rejects(
      integration.createAccessTradeTikTokAffiliateLink({ productUrl: 'https://shop.tiktok.com/view/product/status-false' }, dependencies(async () => jsonResponse({ status: false, data: {} }))),
      error => error.resultType === 'schema_mismatch',
    );
    let calls = 0;
    await assert.rejects(
      integration.createAccessTradeTikTokAffiliateLink({ productUrl: 'https://shop.tiktok.com/view/product/status-503' }, dependencies(async () => { calls += 1; return jsonResponse({}, 503); })),
      error => error.resultType === 'upstream_error',
    );
    assert.equal(calls, 3);
  });

  async function resetCollections() {
    for (const collection of [
      'domain-circuit-breakers', 'candidate-queue', 'products', 'source-keyword-state', 'source-quality',
      'source-reliability-state', 'pipeline-daily-usage', 'automation-jobs', 'automation-control', 'automation-settings',
      'automation-audit', 'automation-circuits', 'operation-journal', 'product-lifecycle-events', 'evidence-facts',
      'publication-audit', 'automation-ai-usage', 'automation-manual-tasks', 'automation-outbound-events',
    ]) await storage.writeCollection(collection, []);
  }

  await test('29 legacy 30shine, TikTok source, link operation, and shops have independent circuit scopes', async () => {
    await resetCollections();
    for (let index = 0; index < 3; index += 1) await circuits.recordDomainHealth('https://30shinestore.com/product', 'timeout');
    await circuits.recordDomainHealth(integration.ACCESSTRADE_TIKTOK_PRODUCT_ENDPOINT, 'server_error', Date.now(), {
      threshold: 1, role: 'SOURCE_API', identityKey: 'accesstrade_tiktok_shop', jitterRatio: 0,
    });
    await circuits.recordDomainHealth(integration.ACCESSTRADE_TIKTOK_LINK_ENDPOINT, 'server_error', Date.now(), {
      threshold: 1, role: 'AFFILIATE_OPERATION', identityKey: 'accesstrade_tiktok_shop:create_link', jitterRatio: 0,
    });
    await circuits.recordDomainHealth('https://shop.tiktok.com/view/product/a', 'timeout', Date.now(), {
      threshold: 1, role: 'MERCHANT', identityKey: 'tiktok-shop:shop-a', jitterRatio: 0,
    });
    const states = await circuits.listDomainCircuitStates();
    assert.equal(states.find(state => state.domain === '30shinestore.com' && state.role === 'MERCHANT').state, 'OPEN');
    assert.equal(states.find(state => state.domain === 'accesstrade_tiktok_shop' && state.role === 'SOURCE_API').state, 'OPEN');
    assert.equal(states.find(state => state.domain === 'accesstrade_tiktok_shop:create_link' && state.role === 'AFFILIATE_OPERATION').state, 'OPEN');
    assert.equal((await circuits.peekDomainCircuitDecision('https://shop.tiktok.com/view/product/b', Date.now(), { role: 'MERCHANT', identityKey: 'tiktok-shop:shop-b' })).allowed, true);
    assert.equal((await circuits.peekDomainCircuitDecision('https://30shinestore.com/other')).allowed, false);
  });

  function normalized(id, shopId) {
    const result = integration.normalizeAccessTradeTikTokProduct(rawProduct(id, { shop: { id: shopId, name: `Shop ${shopId}` } }));
    assert.equal(result.ok, true);
    return result.product;
  }

  function tiktokRegistry(items, linkBehavior) {
    const registry = new platform.SourceAdapterRegistry();
    registry.register(platform.createAccessTradeTikTokSourceAdapter({
      configured: async () => true,
      credentialReadiness: async () => ({ configured: true, credentialsPresent: true, credentialFormatValid: true, source: 'TOKEN_VAULT', reason: 'CONFIGURED' }),
      discover: async () => ({
        items,
        requests: [{ endpoint: 'tiktok_product_feed_v2', durationMs: 1, statusCode: 200, attempts: 1, resultType: items.length ? 'success_with_results' : 'success_empty', itemCount: items.length }],
        diagnostics: { source: 'accesstrade_tiktok_shop', fetched: items.length, normalized: items.length, accepted: items.length, duplicates: 0, rejectedByReason: {}, pageCount: 1, stopReason: 'NO_NEXT_PAGE_TOKEN', durationMs: 1, rawItemBudget: 160, acceptedItemBudget: 30, maximumPages: 2, nextPageTokenPresent: false, previewOnly: true, persisted: false },
      }),
      createLink: linkBehavior,
    }));
    return registry;
  }

  function successfulLink(linkCalls) {
    return async input => {
      linkCalls.push(input.productId);
      return {
        url: `https://go.isclix.com/tiktok/${input.productId}`,
        sourceField: 'aff_short_url', fetchedAt: new Date().toISOString(), attempts: 1,
        request: { endpoint: 'tiktok_create_link_v2', durationMs: 1, statusCode: 200, attempts: 1, resultType: 'success_with_results', itemCount: 1 },
      };
    };
  }

  await test('30 AUTO_PILOT TikTok discovery continues with 30shine OPEN and retains two real shops', async () => {
    await resetCollections();
    for (let index = 0; index < 3; index += 1) await circuits.recordDomainHealth('https://30shinestore.com/product', 'timeout');
    const linkCalls = [];
    const registry = tiktokRegistry([normalized('auto-a', 'shop-a'), normalized('auto-b', 'shop-b')], successfulLink(linkCalls));
    const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 30_000, { registry, runId: 'tiktok-auto-1', scheduleBucket: 'fixed' });
    assert.equal(result.reason, 'source_scan_completed');
    assert.equal(result.discoveredMerchantCount, 2);
    assert.equal(result.healthyMerchantCount, 2);
    assert.equal(result.queued, 2);
    assert.equal(linkCalls.length, 2, 'link creation must run only after two unique products are selected');
    const candidates = await queue.listCandidateQueue();
    assert.deepEqual(new Set(candidates.map(candidate => candidate.source)), new Set(['accesstrade_tiktok_shop']));
    assert.deepEqual(new Set(candidates.map(candidate => candidate.merchantDomain)), new Set(['tiktok-shop:shop-a', 'tiktok-shop:shop-b']));
    assert.ok(candidates.every(candidate => candidate.payload.affiliateUrl !== candidate.payload.originalUrl));
  });

  await test('31 repeated AUTO_PILOT discovery is idempotent and creates no duplicate affiliate work or candidates', async () => {
    const existing = await queue.listCandidateQueue();
    const beforeCount = existing.length;
    const linkCalls = [];
    const registry = tiktokRegistry([normalized('auto-a', 'shop-a'), normalized('auto-b', 'shop-b')], successfulLink(linkCalls));
    const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 30_000, { registry, runId: 'tiktok-auto-2', scheduleBucket: 'fixed' });
    assert.equal(result.reason, 'source_scan_completed');
    assert.equal(result.healthyMerchantCount, 2);
    assert.equal(result.queued, 0);
    assert.equal(linkCalls.length, 0);
    assert.equal((await queue.listCandidateQueue()).length, beforeCount);
  });

  await test('32 Shop A OPEN does not block Shop B and both count as distinct merchants', async () => {
    await resetCollections();
    await circuits.recordDomainHealth('https://shop.tiktok.com/view/product/a', 'timeout', Date.now(), {
      threshold: 1, role: 'MERCHANT', identityKey: 'tiktok-shop:shop-a', jitterRatio: 0,
    });
    const linkCalls = [];
    const registry = tiktokRegistry([normalized('isolated-a', 'shop-a'), normalized('isolated-b', 'shop-b')], successfulLink(linkCalls));
    const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 30_000, { registry, runId: 'tiktok-shop-isolation', scheduleBucket: 'fixed' });
    assert.equal(result.discoveredMerchantCount, 2);
    assert.equal(result.eligibleMerchantCount, 1);
    assert.equal(result.queued, 1);
    assert.deepEqual(linkCalls, ['isolated-b']);
    assert.equal((await queue.listCandidateQueue())[0].merchantDomain, 'tiktok-shop:shop-b');
  });

  await test('33 affiliate failure creates no candidate and never falls back to original URL', async () => {
    await resetCollections();
    const registry = tiktokRegistry([normalized('affiliate-fail', 'shop-safe')], async () => {
      throw new integration.AccessTradeTikTokError('schema_mismatch', 'link unavailable');
    });
    const result = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 30_000, { registry, runId: 'tiktok-link-fail', scheduleBucket: 'fixed' });
    assert.equal(result.queued, 0);
    assert.ok(result.rejected > 0);
    assert.equal((await queue.listCandidateQueue()).length, 0);
  });

  await test('34 manual selected-product path is idempotent and creates one candidate/link', async () => {
    await resetCollections();
    const linkCalls = [];
    const product = normalized('manual-one', 'manual-shop');
    const registry = tiktokRegistry([product], successfulLink(linkCalls));
    const first = await pipeline.enqueueSelectedAccessTradeTikTokProduct(product, { registry, requestedBy: 'test-manual' });
    const second = await pipeline.enqueueSelectedAccessTradeTikTokProduct(product, { registry, requestedBy: 'test-manual' });
    assert.equal(first.queued, true);
    assert.equal(second.queued, false);
    assert.equal(second.unchanged, true);
    assert.equal(linkCalls.length, 1);
    assert.equal((await queue.listCandidateQueue()).length, 1);
  });

  await test('35 candidate bridge creates no duplicate child job', async () => {
    const first = await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'tiktok-test', limit: 10 });
    const second = await bridge.bridgeCandidatesToDurableJobs({ requestedBy: 'tiktok-test', limit: 10 });
    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal((await automationStore.getAllAutomationJobs()).filter(job => job.type === 'PROCESS_CANDIDATE').length, 1);
  });

  await test('36 TikTok candidate processing preserves source/shop identity and remains fail-closed under Safe Publish', async () => {
    const candidates = await queue.listCandidateQueue();
    candidates[0].payload.isolatedHealthFixture = 'healthy';
    await storage.writeCollection('candidate-queue', candidates);
    await settings.updateAutomationSettings({ enabled: true, safePublish: true, launchEnabled: false });
    await automationStore.updateAutomationControl({
      mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: false, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false,
    }, 'tiktok-test');
    await worker.processAutomationBatch('tiktok-worker', 1);
    const products = await productsStore.getAllProducts();
    assert.equal(products.length, 1);
    assert.equal(products[0].source, 'accesstrade_tiktok_shop');
    assert.equal(products[0].platform, 'tiktok_shop');
    assert.equal(products[0].merchantIdentity, 'tiktok-shop:manual-shop');
    assert.equal(products[0].shopId, 'manual-shop');
    assert.equal(products[0].publicHidden, true);
    assert.notEqual(products[0].status, 'published');
    assert.notEqual(products[0].affiliateUrl, products[0].originalUrl);
    const decision = eligibility.evaluateProductEligibility({ ...products[0], affiliateUrl: products[0].originalUrl, affiliateUrlSourceEndpoint: undefined });
    assert.ok(decision.criticalBlockers.includes('affiliate_provenance_missing'));
    assert.ok(decision.criticalBlockers.includes('invalid_affiliate_url_source'));
  });

  await test('37 FileStorage-backed candidate/product collections remain readable after TikTok flow', async () => {
    assert.ok(Array.isArray(await storage.readCollection('candidate-queue')));
    assert.ok(Array.isArray(await storage.readCollection('products')));
    assert.equal(fs.existsSync(path.join(process.env.SANDEAL_DATA_DIR, 'candidate-queue.json')), true);
  });

  console.info = originalInfo;
  console.log(`\nAccessTrade TikTok integration suite: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
