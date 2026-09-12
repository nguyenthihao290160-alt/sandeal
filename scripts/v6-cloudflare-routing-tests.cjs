/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('./register-typescript.cjs');
const { openWorker } = require('./lib/cloudflare-local.cjs');
const { cloudflareFetch } = require('../src/lib/runtime/cloudflare/http.ts');
const { publicPage, publicCard } = require('../src/lib/runtime/cloudflare/publicCatalogue.ts');
const { cloudflareProduct } = require('./fixtures/v6-cloudflare-product.cjs');
const { createD1StorageAdapter } = require('../src/lib/storage/d1/d1StorageAdapter.ts');
let passed = 0, failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  const password = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`local-admin:${password}`).toString('base64')}`;
  const runtime = await openWorker({ assets: true, bindings: { BASIC_AUTH_USER: 'local-admin', BASIC_AUTH_PASSWORD: password, AFFILIATE_REDIRECT_HOSTS: 'merchant.example' } });
  try {
    const adapter = createD1StorageAdapter(runtime.db), product = cloudflareProduct();
    await adapter.domain.createProduct(product);
    await test('HTML-referenced JavaScript and CSS return actual immutable assets', async () => {
      const html = await (await runtime.fetch('/')).text();
      const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"?]+\.(?:js|css))(?:\?[^\"]*)?"/g)].map(match => match[1]))];
      assert.ok(assets.some(url => url.endsWith('.js'))); assert.ok(assets.some(url => url.endsWith('.css')));
      for (const url of assets) {
        const response = await runtime.fetch(url); assert.equal(response.status, 200, url);
        assert.match(response.headers.get('content-type'), url.endsWith('.js') ? /javascript/ : /text\/css/);
        assert.match(response.headers.get('cache-control'), /immutable/);
        const bytes = await response.text(); assert.ok(bytes.length > 0); assert.doesNotMatch(bytes, /^<!doctype html/i);
      }
    });
    await test('health, readiness and bounded catalogue stay JSON through the asset router', async () => {
      for (const route of ['/api/health', '/api/health/ready', '/api/public/products?limit=1']) {
        const response = await runtime.fetch(route, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
        assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
        assert.equal((await response.json()).ok, true);
      }
    });
    await test('reserved API roots and unknown APIs never fall through to assets', async () => {
      for (const route of ['/api', '/api/', '/api/missing', '/api/missing.css', '/go', '/dashboard/private']) {
        const response = await runtime.fetch(route); assert.equal(response.status, 501, route);
        assert.match(response.headers.get('content-type'), /application\/json/);
      }
    });
    await test('authenticated private routes remain isolated from public static requests', async () => {
      for (const auth of ['', 'Bearer invalid', 'Basic invalid', `Basic ${Buffer.from('local-admin:incorrect').toString('base64')}`]) {
        const response = await runtime.fetch('/api/admin/settings/automation', { headers: { authorization: auth } });
        assert.equal(response.status, 401); assert.equal((await response.text()).includes(password), false);
      }
      const response = await runtime.fetch('/api/admin/settings/automation', { headers: { authorization } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const before = await adapter.settingsStore.read('automation');
      await runtime.fetch('/?action=/api/admin/settings/automation', { method: 'POST', headers: { authorization, origin: 'http://localhost', 'content-type': 'application/json' }, body: '{"enabled":true}' });
      assert.deepEqual(await adapter.settingsStore.read('automation'), before);
    });
    await test('product shell and affiliate redirect resolve the same live published D1 entity', async () => {
      const detail = await runtime.fetch(`/deals/${product.slug}`); assert.equal(detail.status, 200);
      assert.equal((await detail.text()).includes(product.title), false);
      const redirect = await runtime.fetch(`/go/${product.id}`, { redirect: 'manual' }); assert.equal(redirect.status, 302);
      assert.match(redirect.headers.get('location'), /^https:\/\/merchant\.example\//);
    });
    await test('all exported HTML and flight files exclude mutable product records and private facts', () => {
      const directory = path.resolve('cloudflare/site/out');
      const files = fs.readdirSync(directory, { recursive: true }).filter(name => /\.(html|txt)$/.test(name)); assert.ok(files.length >= 5);
      for (const file of files) {
        const bytes = fs.readFileSync(path.join(directory, file), 'utf8');
        for (const marker of [product.title, product.affiliateUrl, '"commissionRate":', '"sourceMappings":']) assert.equal(bytes.includes(marker), false, file);
      }
    });
    await test('public projection is allowlisted and one bounded indexed page cannot scan to fill results', async () => {
      const queries = [];
      const hidden = cloudflareProduct('hidden', { publicHidden: true });
      const canary = cloudflareProduct('canary', { runtimeRecoveryCanaryObservationPending: true });
      const result = await publicPage({ async listProducts(query) { queries.push(query); return [hidden, canary].map(value => ({ value })); } }, new URLSearchParams('limit=2'));
      assert.deepEqual(queries, [{ status: 'published', afterId: '', limit: 2 }]); assert.deepEqual(result.items, []); assert.equal(result.nextCursor, 'canary');
      const projected = publicCard({ ...product, commissionRate: 99, revenue: 999, adminNotes: 'private-marker' });
      for (const field of ['commissionRate', 'revenue', 'adminNotes', 'sourceMappings', 'affiliateUrl', 'reviewContent']) assert.equal(field in projected, false);
      const plan = await runtime.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM products WHERE status = ? AND id > ? ORDER BY id LIMIT ?').bind('published', '', 20).all();
      assert.match(JSON.stringify(plan.results), /SEARCH.*products_status_id/); assert.doesNotMatch(JSON.stringify(plan.results), /SCAN products/);
    });
    await test('redirect validation rejects malicious destinations despite an approved hostname', async () => {
      for (const target of ['http://merchant.example/x', 'https://merchant.example:8080/x', 'https://merchant.example.hostile.example/x']) {
        const current = await adapter.domain.getProduct(product.id);
        await adapter.domain.replaceProduct({ ...current.value, affiliateUrl: target }, current.version);
        assert.equal((await runtime.fetch(`/go/${product.id}`, { redirect: 'manual' })).status, 422);
      }
    });
  } finally { await runtime.dispose(); }
  const missing = await openWorker({ assets: true, database: false });
  try {
    await test('unknown static paths return application 404 independently of D1 availability', async () => {
      for (const route of ['/missing-public-route', '/_next/static/missing.css']) assert.equal((await missing.fetch(route)).status, 404, route);
    });
  } finally { await missing.dispose(); }
  await test('direct static handler never touches D1 or privileged settings', async () => {
    let assetCalls = 0, databaseCalls = 0;
    const env = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false',
      get DB() { databaseCalls++; throw new Error('DATABASE_MUST_NOT_BE_TOUCHED'); },
      ASSETS: { async fetch() { assetCalls++; return new Response('static fixture'); } } };
    assert.equal((await cloudflareFetch(new Request('http://localhost/'), env)).status, 200);
    assert.equal(databaseCalls, 0); assert.equal(assetCalls, 1);
  });
  await test('invalid bindings and unconfigured admin fail closed without driver or secret logs', async () => {
    const env = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false' };
    for (const DB of [undefined, {}, { prepare: 'invalid', batch() {} }]) {
      const response = await cloudflareFetch(new Request('http://localhost/api/public/products'), { ...env, DB }); assert.equal(response.status, 503);
    }
    const logs = [], original = console.error; console.error = (...args) => logs.push(args);
    try {
      const DB = { prepare() { throw new Error('synthetic-private-marker'); }, async batch() { throw new Error('synthetic-private-marker'); } };
      const response = await cloudflareFetch(new Request('http://localhost/api/health/ready'), { ...env, DB });
      assert.equal(response.status, 503); assert.equal((await response.text()).includes('synthetic-private-marker'), false);
      assert.equal((await cloudflareFetch(new Request('http://localhost/api/admin/settings/automation'), { ...env, DB })).status, 503);
    } finally { console.error = original; }
    assert.equal(logs.length, 0);
  });
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => { console.log(`V6 Cloudflare routing: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; });
