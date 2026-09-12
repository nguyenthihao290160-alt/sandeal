/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { openLocalD1, applyLocalMigrations } = require('./lib/local-d1.cjs');
require('./register-typescript.cjs');
const { fixture } = require('./fixtures/v6-domain-contract.cjs');
const { createStorage, withStorageAdapter, getStorageAdapter } = require('../src/lib/storage/storageFactory.ts');
const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');
const { createD1StorageAdapter } = require('../src/lib/storage/d1/d1StorageAdapter.ts');
const products = require('../src/lib/storage/products.ts');
const history = require('../src/lib/product-intelligence/priceHistory.ts');
const settings = require('../src/lib/storage/automationSettings.ts');
const { ShopeeAffiliateProvider } = require('../src/lib/affiliate/shopeeAffiliateProvider.ts');
let passed = 0; let failed = 0;
let fileCalls = 0; let settingsFilesystemCalls = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  // Only bootstrap tooling may access the config/migration source files. DB data
  // persistence is disabled; the guarded domain phase starts after this setup.
  const local = await openLocalD1({ testOnly: true });
  const previousRuntime = process.env.SANDEAL_RUNTIME;
  const fileDescriptors = new Map();
  const filesystemMethods = new Map();
  try {
    await applyLocalMigrations(local);
    const observed = [];
    const storage = createStorage({ runtime: 'cloudflare', bindings: { DB: local.db },
      createD1: binding => createD1StorageAdapter(binding, value => observed.push(value)) });
    process.env.SANDEAL_RUNTIME = 'cloudflare';
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fileStorageAdapter))) {
      if (typeof descriptor.value !== 'function' && !descriptor.get) continue;
      fileDescriptors.set(key, descriptor);
      Object.defineProperty(fileStorageAdapter, key, { configurable: true, get() {
        fileCalls++; throw new Error('ZERO_VPS_FILE_STORAGE_FORBIDDEN');
      } });
    }
    for (const key of ['readFile','writeFile','mkdir','rename','open','stat','access','readdir','unlink','rm']) {
      filesystemMethods.set(key, fs.promises[key]);
      fs.promises[key] = async () => { settingsFilesystemCalls++; throw new Error('ZERO_VPS_FILESYSTEM_FORBIDDEN'); };
    }
    await withStorageAdapter(storage, async () => {
      let product;
      await test('Cloudflare domain harness selects D1 and imports/dedupes a fixture', async () => {
        assert.equal(getStorageAdapter().driver, 'd1');
        const first = await products.upsertSourceCandidateProduct(fixture('zero-vps-source'));
        const replay = await products.upsertSourceCandidateProduct(fixture('zero-vps-source'));
        assert.equal(first.product.id, replay.product.id); assert.equal(replay.created, false);
        product = replay.product;
      });
      await test('offer create/update and bounded price history need no filesystem', async () => {
        const offer = { id: 'zero-vps-offer', source: 'accesstrade', merchant: 'Fixture', price: 100, affiliateUrl: 'https://fixture.invalid/link', health: 'UNKNOWN', observedAt: '2026-09-01T00:00:00.000Z', confidence: 0, primary: true };
        await products.updateProduct(product.id, { offers: [offer] });
        await products.updateProduct(product.id, { offers: [{ ...offer, price: 120 }] });
        const saved = await products.getProductById(product.id);
        assert.equal(saved.offers.length, 1); assert.equal(saved.offers[0].price, 120);
        for (const [index, price] of [100, 120, 110].entries()) await history.capturePriceSnapshot({ ...saved, price }, `zero-vps-${index}`, { capturedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString() });
        assert.deepEqual((await history.listPriceHistory(product.id, 2)).map(row => row.price), [120, 110]);
      });
      await test('publication readiness state changes while unauthorized public publication stays blocked', async () => {
        const approved = await products.approveProduct(product.id);
        assert.equal(approved.status, 'approved'); assert.equal(approved.publicHidden, true);
        await assert.rejects(() => products.updateProduct(product.id, { status: 'published', publicHidden: false }), /SAFE_PUBLISH_JOB_REQUIRED/);
        assert.equal((await products.getProductById(product.id)).status, 'approved');
      });
      await test('mutable non-secret settings use the D1 store, never legacy singleton files', async () => {
        await settings.updateAutomationSettings({ enabled: false, maxItemsPerRun: 20 });
        const read = await settings.getAutomationSettings();
        assert.equal(read.maxItemsPerRun, 20); assert.equal(read.freeOnly, true); assert.equal(read.allowPaidAi, false);
      });
      await test('stale revision conflicts without overwriting newer data', async () => {
        const before = await storage.domain.getProduct(product.id);
        const changed = await storage.domain.replaceProduct({ ...before.value, price: 150 }, before.version);
        assert.equal(changed.status, 'APPLIED');
        assert.deepEqual(await storage.domain.replaceProduct({ ...before.value, price: 1 }, before.version), { status: 'CONFLICT', reason: 'VERSION' });
        assert.equal((await storage.domain.getProduct(product.id)).value.price, 150);
      });
      await test('missing binding, unknown runtime and SQL failure never select legacy storage', async () => {
        assert.throws(() => createStorage({ runtime: 'cloudflare' }), error => error.code === 'CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE');
        assert.throws(() => createStorage({ runtime: 'invalid' }), error => error.code === 'SANDEAL_RUNTIME_UNSUPPORTED');
        const failing = createStorage({ runtime: 'cloudflare', bindings: { DB: { prepare() { throw new Error('test-only-driver-detail'); }, async batch() { throw new Error('test-only-driver-detail'); } } } });
        await assert.rejects(() => failing.domain.getProduct(product.id), error => error.code === 'D1_OPERATION_FAILED' && error.message === 'D1_OPERATION_FAILED');
        assert.equal((await storage.domain.getProduct(product.id)).value.price, 150);
      });
      await test('Shopee remains unavailable with no network, fake health or provider fallback', async () => {
        const originalFetch = global.fetch; let networkCalls = 0;
        global.fetch = async () => { networkCalls++; throw new Error('SHOPEE_NETWORK_FORBIDDEN'); };
        try {
          const shopee = new ShopeeAffiliateProvider({ SHOPEE_AFFILIATE_ENABLED: 'false' });
          const health = await shopee.healthCheck(); assert.equal(health.state, 'DISABLED_NO_CREDENTIALS'); assert.equal(health.ready, false);
          const result = await shopee.discoverProducts(); assert.equal(result.ok, false); assert.equal(result.provider, 'shopee');
          assert.equal(networkCalls, 0);
        } finally { global.fetch = originalFetch; }
      });
      await test('every executed domain query belongs to the bounded access inventory', () => {
        const shapes = {
          'product.id': 'POINT_LOOKUP', 'product.slug': 'POINT_LOOKUP', 'product.identity': 'BOUNDED_RANGE',
          'product.page': 'BOUNDED_RANGE', 'product.create': 'BOUNDED_WRITE', 'product.conditional': 'CONDITIONAL_WRITE',
          'product.audit.append': 'BOUNDED_WRITE', 'product.audit.replay': 'POINT_LOOKUP',
          'history.range': 'BOUNDED_RANGE', 'history.append.batch': 'BATCH',
          'settings.read': 'POINT_LOOKUP', 'settings.write': 'BOUNDED_WRITE', 'health': 'POINT_LOOKUP',
        };
        assert.equal(observed.length > 0, true);
        for (const query of observed) assert.equal(Object.hasOwn(shapes, query.operation), true, query.operation);
        assert.equal(observed.filter(query => shapes[query.operation] === 'FULL_SCAN').length, 0);
      });
      await test('all representative domain operations completed with zero FileStorage and filesystem calls', () => {
        assert.equal(fileCalls, 0); assert.equal(settingsFilesystemCalls, 0);
      });
    });
  } finally {
    for (const [key, descriptor] of fileDescriptors) Object.defineProperty(fileStorageAdapter, key, descriptor);
    for (const [key, original] of filesystemMethods) fs.promises[key] = original;
    if (previousRuntime === undefined) delete process.env.SANDEAL_RUNTIME; else process.env.SANDEAL_RUNTIME = previousRuntime;
    await local.dispose();
  }
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => {
  console.log(`V6 zero-VPS storage: ${passed} passed, ${failed} failed`);
  console.log(`RUNTIME=CLOUDFLARE; STORAGE=D1_LOCAL; FILE_STORAGE_CALLS=${fileCalls}; FILESYSTEM_SETTINGS_CALLS=${settingsFilesystemCalls}; PM2_REQUIRED=NO; VPS_REQUIRED=NO; SHOPEE_REQUIRED=NO; DOMAIN_SCENARIO=${failed ? 'FAIL' : 'PASS'}`);
  process.exitCode = failed ? 1 : 0;
});
