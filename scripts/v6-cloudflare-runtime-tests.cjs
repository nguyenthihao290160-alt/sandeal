/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
require('./register-typescript.cjs');
const { openWorker } = require('./lib/cloudflare-local.cjs');
const { cloudflareProduct } = require('./fixtures/v6-cloudflare-product.cjs');
const { createD1StorageAdapter } = require('../src/lib/storage/d1/d1StorageAdapter.ts');
const { isPublicSafeProduct, getPublicProductBlockReason } = require('../src/lib/publicProductFilter.ts');
const { cloudflareFetch, boundedJson } = require('../src/lib/runtime/cloudflare/http.ts');
let passed = 0, failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  const password = randomBytes(24).toString('hex'), authorization = `Basic ${Buffer.from(`local-admin:${password}`).toString('base64')}`;
  const runtime = await openWorker({ bindings: { BASIC_AUTH_USER: 'local-admin', BASIC_AUTH_PASSWORD: password, AFFILIATE_REDIRECT_HOSTS: 'merchant.example' } });
  const adapter = createD1StorageAdapter(runtime.db), product = cloudflareProduct();
  try {
    await test('safe local fixture passes the unchanged public gate and persists in D1', async () => {
      assert.equal(isPublicSafeProduct(product), true, getPublicProductBlockReason(product));
      assert.equal((await adapter.domain.createProduct(product)).status, 'APPLIED');
      const hidden = cloudflareProduct('local-hidden', { status: 'archived', publicHidden: true });
      assert.equal((await adapter.domain.createProduct(hidden)).status, 'APPLIED');
    });
    await test('workerd liveness and readiness verify local D1 with optional Shopee disabled', async () => {
      assert.equal((await runtime.fetch('/api/health/live')).status, 200);
      const response = await runtime.fetch('/api/health/ready'); assert.equal(response.status, 200);
      const report = await response.json(); assert.equal(report.d1, 'PASS'); assert.equal(report.remote, false); assert.equal(report.production, false);
      assert.equal(report.dependencies.shopee, 'DISABLED_NO_CREDENTIALS');
    });
    await test('public product page uses live D1 and excludes archived/private data', async () => {
      const response = await runtime.fetch('/api/public/products?limit=1'); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const { data } = await response.json(); assert.equal(data.items.length, 1); assert.equal(data.items[0].id, product.id);
      assert.equal(data.items[0].currentPrice, 1200000); assert.equal(data.nextCursor, product.id);
      assert.equal(JSON.stringify(data).includes('sourceMappings'), false); assert.equal(JSON.stringify(data).includes('affiliateUrl'), false);
      assert.equal((await runtime.fetch('/api/public/products/local-hidden')).status, 404);
    });
    await test('offers and publication state read through D1 without exposing affiliate targets', async () => {
      const response = await runtime.fetch(`/api/public/products/${product.slug}`); assert.equal(response.status, 200);
      const { data } = await response.json(); assert.equal(data.publication.public, true); assert.equal(data.offers.length, 1);
      assert.equal(data.offers[0].affiliateUrl, undefined);
      assert.equal((await (await runtime.fetch(`/api/public/products/${product.slug}/offers`)).json()).data[0].price, 1200000);
    });
    await test('affiliate health exposes sanitized disabled states and never credentials', async () => {
      const response = await runtime.fetch('/api/public/affiliate/health'); const body = await response.text();
      assert.equal(response.status, 200); assert.match(body, /DISABLED_NO_CREDENTIALS/); assert.equal(body.includes(password), false);
    });
    await test('query bounds and unsupported filters reject instead of scanning or fabricating totals', async () => {
      for (const query of ['limit=51', 'limit=0', 'limit=1&limit=2', 'q=unported-search', 'after='+'a'.repeat(161)]) assert.equal((await runtime.fetch(`/api/public/products?${query}`)).status, 400);
    });
    await test('admin routes require explicit authentication and stay private', async () => {
      assert.equal((await runtime.fetch('/api/admin/settings/automation')).status, 401);
      const response = await runtime.fetch(`/api/admin/products/${product.id}/publication`, { headers: { authorization } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).data.status, 'published');
      for (const route of ['/dashboard', '/api/token-vault/list', '/api/automation/control', '/api/ai-bots/scheduler/tick']) assert.equal((await runtime.fetch(route)).status, 501);
    });
    await test('settings writes use D1, enforce same origin and reject secret fields', async () => {
      const url = '/api/admin/settings/automation', headers = { authorization, origin: 'http://localhost', 'content-type': 'application/json' };
      assert.equal((await runtime.fetch(url, { method: 'PUT', headers, body: JSON.stringify({ enabled: false, freeOnly: true }) })).status, 200);
      assert.deepEqual(await adapter.settingsStore.read('automation'), { enabled: false, freeOnly: true });
      assert.equal((await runtime.fetch(url, { method: 'PUT', headers: { ...headers, origin: 'https://hostile.example' }, body: '{}' })).status, 403);
      assert.equal((await runtime.fetch(url, { method: 'PUT', headers, body: JSON.stringify({ token: 'local-test-rejected-value' }) })).status, 400);
      assert.equal((await runtime.fetch(url, { method: 'PUT', headers, body: 'x'.repeat(65537) })).status, 413);
    });
    await test('chunked request bodies are limited even without Content-Length', async () => {
      const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(40000)); controller.close(); } });
      await assert.rejects(() => boundedJson(new Request('http://localhost', { method: 'POST', body, duplex: 'half' })), error => error.status === 413);
    });
    await test('affiliate redirects only use published stored URLs and explicit approved hosts', async () => {
      const response = await runtime.fetch(`/go/${product.id}?url=https://hostile.example`, { redirect: 'manual' });
      assert.equal(response.status, 302); assert.match(response.headers.get('location'), /^https:\/\/merchant\.example\//);
      assert.equal((await runtime.fetch('/go/local-hidden', { redirect: 'manual' })).status, 404);
      const current = await adapter.domain.getProduct(product.id);
      await adapter.domain.replaceProduct({ ...current.value, affiliateUrl: 'https://hostile.example/path' }, current.version);
      assert.equal((await runtime.fetch(`/go/${product.id}`, { redirect: 'manual' })).status, 422);
    });
    await test('security headers and private cache policy apply to errors as well as successes', async () => {
      for (const route of ['/api/health/live', '/api/public/products', '/api/unknown']) {
        const response = await runtime.fetch(route); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('x-frame-options'), 'DENY'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      }
    });
    await test('the compiled Worker has no File/Mongo/settings filesystem dependency', () => {
      const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.built.file), 'metafile.json')));
      assert.equal(Object.keys(meta.inputs).some(name => /fileStorageAdapter|mongoStorageAdapter|legacySettingsStore/.test(name)), false);
      const imports = Object.values(meta.outputs).flatMap(row => row.imports.map(item => item.path));
      assert.equal(imports.some(name => /fs|child_process/.test(name)), false);
    });
  } finally { await runtime.dispose(); }
  const missing = await openWorker({ database: false });
  try { await test('missing D1 fails closed while liveness remains independent', async () => {
    assert.equal((await missing.fetch('/api/health/live')).status, 200);
    assert.equal((await missing.fetch('/api/health/ready')).status, 503);
    assert.equal((await missing.fetch('/api/public/products')).status, 503);
  }); } finally { await missing.dispose(); }
  await test('D1 failures are sanitized and remote/production configurations reject', async () => {
    const env = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false', DB: { prepare() { throw new Error('synthetic-private-driver-detail'); }, async batch() { throw new Error('synthetic-private-driver-detail'); } } };
    const response = await cloudflareFetch(new Request('http://localhost/api/health/ready'), env);
    assert.equal(response.status, 503); assert.equal((await response.text()).includes('synthetic-private-driver-detail'), false);
    for (const overrides of [{ SANDEAL_RUNTIME: 'legacy' }, { SANDEAL_LOCAL_ONLY: 'false' }, { SANDEAL_PRODUCTION: 'true' }]) assert.equal((await cloudflareFetch(new Request('http://localhost/api/public/products'), { ...env, ...overrides })).status, 503);
  });
  if (!failed) console.log('CLOUDFLARE_LOCAL_RUNTIME=PASS D1_LOCAL=PASS FILE_STORAGE_CALLS=0 FILESYSTEM_SETTINGS_CALLS=0 PM2_REQUIRED=NO VPS_REQUIRED=NO SHOPEE_REQUIRED=NO');
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => { console.log(`V6 Cloudflare runtime: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; });
