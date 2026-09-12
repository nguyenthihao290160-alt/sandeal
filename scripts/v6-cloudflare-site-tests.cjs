/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const { openWorker } = require('./lib/cloudflare-local.cjs');
const { cloudflareProduct } = require('./fixtures/v6-cloudflare-product.cjs');
const { createD1StorageAdapter } = require('../src/lib/storage/d1/d1StorageAdapter.ts');
let passed = 0, failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  const runtime = await openWorker({ assets: true });
  try {
    const adapter = createD1StorageAdapter(runtime.db), product = cloudflareProduct();
    await adapter.domain.createProduct(product);
    await test('actual Next export is served by local Workers Assets without embedded product data', async () => {
      for (const route of ['/', '/deals/', '/review-methodology/', '/thong-tin/minh-bach-affiliate/']) {
        const response = await runtime.fetch(route); assert.equal(response.status, 200, route);
        const html = await response.text(); assert.match(html, /SanDeal/); assert.equal(html.includes(product.title), false);
        assert.match(html, /_next\/static\//);
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
      }
    });
    await test('existing product URL serves the static detail shell only after a live publication check', async () => {
      const response = await runtime.fetch(`/deals/${product.slug}`); assert.equal(response.status, 200);
      assert.match(await response.text(), /Thông tin sản phẩm/); assert.equal(response.headers.get('cache-control'), 'no-store');
      const current = await adapter.domain.getProduct(product.id);
      await adapter.domain.replaceProduct({ ...current.value, status: 'archived', publicHidden: true }, current.version);
      assert.equal((await runtime.fetch(`/deals/${product.slug}`)).status, 404);
      assert.equal((await runtime.fetch(`/api/public/products/${product.slug}`)).status, 404);
    });
    await test('static fallback cannot expose admin routes or conceal an unknown API', async () => {
      assert.equal((await runtime.fetch('/dashboard')).status, 501);
      assert.equal((await runtime.fetch('/api/unknown')).status, 501);
      assert.equal((await runtime.fetch('/missing-public-route')).status, 404);
      assert.equal((await runtime.fetch('/api/health/ready')).status, 200);
    });
  } finally { await runtime.dispose(); }
  const missing = await openWorker({ assets: true, database: false });
  try { await test('static public shell survives missing D1 but catalogue API fails closed', async () => {
    assert.equal((await missing.fetch('/')).status, 200);
    assert.equal((await missing.fetch('/api/public/products')).status, 503);
    assert.equal((await missing.fetch('/api/health/ready')).status, 503);
  }); } finally { await missing.dispose(); }
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => { console.log(`V6 Cloudflare site: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; });
