/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
require('./register-typescript.cjs');

const {
  getSandealRuntime,
  SandealRuntimeConfigurationError,
} = require('../src/lib/runtime/config.ts');
const {
  getAnalyticsAdapter,
  getJobQueueAdapter,
  getSchedulerAdapter,
  RuntimeAdapterUnavailableError,
} = require('../src/lib/platform/factory.ts');
const {
  AccessTradeAffiliateProvider,
  AccessTradeTikTokAffiliateProvider,
} = require('../src/lib/affiliate/accessTradeProviders.ts');
const {
  AffiliateProviderRegistry,
  createDefaultAffiliateProviderRegistry,
} = require('../src/lib/affiliate/registry.ts');
const {
  ShopeeAffiliateProvider,
} = require('../src/lib/affiliate/shopeeAffiliateProvider.ts');
const {
  discoverAffiliateProducts,
} = require('../src/lib/affiliate/service.ts');
const {
  createAccessTradeSourceAdapter,
  createAccessTradeTikTokSourceAdapter,
} = require('../src/lib/autonomous/sourceAdapterPlatform.ts');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function fakeSourceAdapter(item, overrides = {}) {
  return {
    id: overrides.id || 'fixture',
    version: 'fixture-v1',
    async isConfigured() { return overrides.configured !== false; },
    async healthCheck() {
      return overrides.health || {
        status: 'ready',
        configured: true,
        ready: true,
        credentialsPresent: true,
        readinessProbeStatus: 'PASSED',
        checkedAt: '2026-09-06T00:00:00.000Z',
      };
    },
    async discover(input) {
      if (overrides.discover) return overrides.discover(input);
      return { items: [item], requests: 1, outcomes: { success_with_results: 1 } };
    },
    normalize(value) { return value; },
    async budget() { return { maximumRequests: 10, usedRequests: 1, remainingRequests: 9 }; },
    classifyError() { return 'last_check_failed'; },
    retryAfter() { return undefined; },
    disclosure() { return { fixture: true }; },
  };
}

const accessTradeProduct = {
  id: 'at-product-1',
  provider: 'accesstrade',
  source: 'accesstrade',
  name: 'Verified AccessTrade fixture',
  description: 'fixture',
  kind: 'product',
  sourceItemKind: 'product',
  platform: 'accesstrade',
  imageUrl: 'https://cdn.example.test/product.jpg',
  imageCandidates: ['https://cdn.example.test/product.jpg'],
  originalUrl: 'https://merchant.example.test/product/1',
  canonicalProductUrl: 'https://merchant.example.test/product/1',
  affiliateUrl: 'https://go.isclix.com/deep_link/fixture',
  price: 120000,
  salePrice: 99000,
  category: 'fixture',
  rawSourceKind: 'product_feed',
  needsVerification: true,
  verifiedSource: false,
  publicHidden: true,
  autoPublishEligible: false,
  publicDecision: 'needs_review',
  publicBlockReason: 'fixture',
  qualityScore: 70,
};

const tikTokProduct = {
  ...accessTradeProduct,
  id: 'tiktok-product-1',
  source: 'accesstrade_tiktok_shop',
  sourceLabel: 'TikTok Shop Affiliate',
  sourceLabelVi: 'TikTok Shop qua AccessTrade',
  platform: 'tiktok_shop',
  merchantIdentity: 'shop:fixture',
  currentPrice: 99000,
  currency: 'VND',
  categoryChain: [],
  affiliateState: 'NOT_CREATED',
  sourceEndpoint: 'tiktok_product_feed_v2',
};

async function main() {
  await test('legacy is the default runtime and existing adapters remain selected', () => {
    assert.equal(getSandealRuntime({}), 'legacy');
    assert.equal(getSandealRuntime({ SANDEAL_RUNTIME: 'LEGACY' }), 'legacy');
    assert.equal(getJobQueueAdapter({}).runtime, 'legacy');
    assert.equal(getSchedulerAdapter({}).runtime, 'legacy');
    assert.equal(getAnalyticsAdapter({}).runtime, 'legacy');
  });

  await test('cloudflare is recognized but cannot silently use legacy adapters in Phase 1', () => {
    assert.equal(getSandealRuntime({ SANDEAL_RUNTIME: 'cloudflare' }), 'cloudflare');
    assert.throws(
      () => getJobQueueAdapter({ SANDEAL_RUNTIME: 'cloudflare' }),
      error => error instanceof RuntimeAdapterUnavailableError
        && error.code === 'RUNTIME_ADAPTER_UNAVAILABLE',
    );
  });

  await test('unknown runtime fails closed without reflecting its value', () => {
    const unknownValue = 'secret-looking-runtime-value';
    assert.throws(
      () => getSandealRuntime({ SANDEAL_RUNTIME: unknownValue }),
      error => error instanceof SandealRuntimeConfigurationError
        && error.code === 'SANDEAL_RUNTIME_UNSUPPORTED'
        && !error.message.includes(unknownValue),
    );
  });

  await test('default affiliate registry preserves AccessTrade, TikTok, and Shopee', () => {
    const registry = createDefaultAffiliateProviderRegistry({});
    assert.deepEqual(registry.list().map(provider => provider.id), [
      'accesstrade',
      'shopee',
      'tiktok',
    ]);
    assert.equal(registry.select('accesstrade').ok, true);
    assert.equal(registry.select('accesstrade_tiktok_shop').ok, true);
    assert.equal(registry.select('shopee').ok, true);
  });

  await test('Shopee without credentials reports DISABLED_NO_CREDENTIALS', async () => {
    const provider = new ShopeeAffiliateProvider({ SHOPEE_AFFILIATE_ENABLED: 'false' });
    const health = await provider.healthCheck();
    assert.equal(health.state, 'DISABLED_NO_CREDENTIALS');
    assert.equal(health.enabled, false);
    assert.equal(health.configured, false);
    assert.equal(health.ready, false);
  });

  await test('Shopee pending access returns typed provider-unavailable results without throwing', async () => {
    const provider = new ShopeeAffiliateProvider({ SHOPEE_AFFILIATE_ENABLED: 'true' });
    const health = await provider.healthCheck();
    assert.equal(health.state, 'PENDING_EXTERNAL_ACCESS');
    const result = await provider.discoverProducts({ keyword: 'phone' });
    assert.equal(result.ok, false);
    assert.equal(result.error.type, 'PROVIDER_UNAVAILABLE');
    assert.equal(result.error.reason, 'PENDING_EXTERNAL_ACCESS');
    assert.equal(result.error.state, 'PENDING_EXTERNAL_ACCESS');
  });

  await test('Shopee credentials are never included in health, results, or logs', async () => {
    const appId = 'fixture-shopee-app-id-never-log';
    const apiKey = 'local-test-shopee-api-key-never-log';
    const captured = [];
    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...values) => captured.push(values.join(' '));
    console.warn = (...values) => captured.push(values.join(' '));
    console.error = (...values) => captured.push(values.join(' '));
    try {
      const provider = new ShopeeAffiliateProvider({
        SHOPEE_AFFILIATE_ENABLED: 'true',
        SHOPEE_APP_ID: appId,
        SHOPEE_API_KEY: apiKey,
      });
      const health = await provider.healthCheck();
      const result = await provider.createTrackingLink({ productUrl: 'https://shopee.vn/product/1' });
      assert.equal(health.state, 'CONFIGURED_NOT_VERIFIED');
      assert.equal(health.ready, false);
      assert.equal(result.ok, false);
      const observable = JSON.stringify({ health, result, captured });
      assert.equal(observable.includes(appId), false);
      assert.equal(observable.includes(apiKey), false);
      assert.equal(captured.length, 0);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
  });

  await test('AccessTrade behavior is available through AffiliateProvider', async () => {
    const provider = new AccessTradeAffiliateProvider(fakeSourceAdapter(accessTradeProduct));
    const health = await provider.healthCheck();
    const result = await provider.discoverProducts({ keyword: 'fixture', limit: 1 });
    assert.equal(health.state, 'READY');
    assert.equal(result.ok, true);
    assert.equal(result.data.products[0].provider, 'accesstrade');
    assert.equal(result.data.products[0].externalId, accessTradeProduct.id);
    assert.equal(result.data.products[0].affiliateUrl, accessTradeProduct.affiliateUrl);
    assert.equal(result.data.products[0].sourcePayload.rawData, undefined);
  });

  await test('TikTok discovery and link creation remain available through AffiliateProvider', async () => {
    const provider = new AccessTradeTikTokAffiliateProvider(
      fakeSourceAdapter(tikTokProduct),
      async input => ({
        url: `https://tracking.example.test/${input.productId}`,
        sourceField: 'aff_short_url',
        fetchedAt: '2026-09-06T00:00:00.000Z',
        attempts: 1,
        request: {
          endpoint: 'tiktok_create_link_v2',
          durationMs: 1,
          attempts: 1,
          resultType: 'success_with_results',
          itemCount: 1,
        },
      }),
    );
    const discovery = await provider.discoverProducts({ limit: 1 });
    const link = await provider.createTrackingLink({
      productUrl: tikTokProduct.originalUrl,
      productExternalId: tikTokProduct.id,
    });
    assert.equal(discovery.ok, true);
    assert.equal(discovery.data.products[0].provider, 'tiktok');
    assert.equal(link.ok, true);
    assert.equal(link.data.url, 'https://tracking.example.test/tiktok-product-1');
    assert.equal(link.data.source, 'provider_api');
  });

  await test('both affiliate wrappers preserve the existing raw-metadata normalization boundary', async () => {
    for (const [Provider, createAdapter, fixture] of [
      [AccessTradeAffiliateProvider, createAccessTradeSourceAdapter, accessTradeProduct],
      [AccessTradeTikTokAffiliateProvider, createAccessTradeTikTokSourceAdapter, tikTokProduct],
    ]) {
      const item = { ...fixture, rawData: { internalMarker: 'must-not-cross-normalization-boundary' } };
      const adapter = createAdapter({
        configured: async () => true,
        discover: async () => ({ items: [item], requests: [] }),
      });
      const normalize = adapter.normalize.bind(adapter);
      const normalizedItems = [];
      adapter.normalize = value => {
        normalizedItems.push(value);
        return normalize(value);
      };
      const result = await new Provider(adapter).discoverProducts({ limit: 1 });
      assert.equal(result.ok, true);
      assert.deepEqual(normalizedItems, [item]);
      assert.equal(result.data.products.length, 1);
      assert.equal(result.data.products[0].externalId, item.id);
      assert.equal(result.data.products[0].affiliateUrl, item.affiliateUrl);
      assert.equal(Object.hasOwn(result.data.products[0].sourcePayload, 'rawData'), false);
      assert.equal(JSON.stringify(result).includes('must-not-cross-normalization-boundary'), false);
    }
  });

  await test('unknown affiliate provider fails closed without AccessTrade fallback', () => {
    const registry = new AffiliateProviderRegistry();
    registry.register(new ShopeeAffiliateProvider({}));
    const selection = registry.select('unknown-provider');
    assert.equal(selection.ok, false);
    assert.equal(selection.error.type, 'PROVIDER_UNAVAILABLE');
    assert.equal(selection.error.reason, 'UNKNOWN_PROVIDER');
    assert.equal(selection.error.state, 'INVALID_CONFIGURATION');
  });

  await test('business logic depends only on AffiliateProvider', async () => {
    const calls = [];
    const provider = {
      id: 'accesstrade',
      contractVersion: 'affiliate-provider-v1',
      async discoverProducts(input) {
        calls.push(input);
        return { ok: true, provider: 'accesstrade', data: { products: [], requestCount: 0 } };
      },
    };
    const result = await discoverAffiliateProducts(provider, { keyword: 'contract-only' });
    assert.equal(result.ok, true);
    assert.equal(calls[0].keyword, 'contract-only');
  });

  await test('example configuration names are present and real env files remain ignored', () => {
    const root = process.cwd();
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(example, /^SANDEAL_RUNTIME=legacy$/m);
    assert.match(example, /^SHOPEE_AFFILIATE_ENABLED=false$/m);
    assert.match(example, /^SHOPEE_APP_ID=$/m);
    assert.match(example, /^SHOPEE_API_KEY=$/m);
    assert.match(gitignore, /^\.env\*$/m);
    assert.match(gitignore, /^!\.env\.example$/m);
  });

  console.log(`\nV6 Phase 1 foundation: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
