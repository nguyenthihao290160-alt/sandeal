/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

require.extensions['.ts'] = function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(process.cwd(), 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

const root = process.cwd();
const testRoot = path.join(root, '.next', `stabilization-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'local-test-user';
process.env.BASIC_AUTH_PASSWORD = 'local-test-password:with-colon';
process.env.SCHEDULER_SECRET = 'local-test-scheduler-secret';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack || error}`); }
}
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
const authHeader = `Basic ${Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASSWORD}`).toString('base64')}`;

(async () => {
  const { NextRequest } = require('next/server');
  const adapter = require('../src/lib/storage/adapter.ts');
  const auth = require('../src/lib/basicAuth.ts');
  const guard = require('../src/lib/safety/operationGuard.ts');
  const apiResponses = require('../src/lib/apiResponse.ts');
  const { proxy } = require('../src/proxy.ts');
  const productRoute = require('../src/app/api/products/route.ts');
  const productByIdRoute = require('../src/app/api/products/[id]/route.ts');
  const products = require('../src/lib/storage/products.ts');
  const tokenListRoute = require('../src/app/api/token-vault/list/route.ts');
  const schedulerRoute = require('../src/app/api/ai-bots/scheduler/tick/route.ts');
  const geminiRouter = require('../src/lib/ai/geminiCredentialRouter.ts');

  await test('Basic Auth fails closed and supports colons in passwords', () => {
    equal(auth.validateBasicAuthHeader('Basic Og==', '', ''), false);
    equal(auth.validateBasicAuthHeader(authHeader, process.env.BASIC_AUTH_USER, process.env.BASIC_AUTH_PASSWORD), true);
    equal(auth.validateBasicAuthHeader('Basic not-valid-base64!', process.env.BASIC_AUTH_USER, process.env.BASIC_AUTH_PASSWORD), false);
  });

  await test('proxy exposes only the exact public product listing', () => {
    equal(proxy(new NextRequest('http://localhost/api/products')).status, 401);
    equal(proxy(new NextRequest('http://localhost/api/products/internal-id')).status, 401);
    equal(proxy(new NextRequest('http://localhost/api/products?public=true')).status, 200);
  });

  await test('operation guard blocks HIGH without approval and BLOCKER with approval', async () => {
    guard.clearOperationGuardRegistryForTests();
    let calls = 0;
    const high = await guard.runGuardedOperation({ operationType: 'publish', actor: 'test', environment: 'test', target: 'p1', riskLevel: 'HIGH' }, async () => ++calls);
    const blocker = await guard.runGuardedOperation({ operationType: 'credential_write', actor: 'test', environment: 'test', target: 'vault', riskLevel: 'BLOCKER', approval: true }, async () => ++calls);
    equal(high.status, 'APPROVAL_REQUIRED'); equal(blocker.status, 'BLOCKED'); equal(calls, 0);
  });

  await test('dry-run never calls its side effect', async () => {
    let calls = 0;
    const result = await guard.runGuardedOperation({ operationType: 'scheduler_tick', actor: 'test', environment: 'test', target: 'scheduler', riskLevel: 'HIGH', dryRun: true }, async () => ++calls);
    equal(result.status, 'DRY_RUN'); equal(calls, 0);
  });

  await test('idempotency returns IN_PROGRESS then ALREADY_PROCESSED', async () => {
    guard.clearOperationGuardRegistryForTests();
    let release;
    let calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const input = { operationType: 'publish', actor: 'test', environment: 'test', target: 'p2', riskLevel: 'HIGH', approval: true, idempotencyKey: 'same-key' };
    const firstPromise = guard.runGuardedOperation(input, async () => { calls++; await gate; return 'done'; });
    await new Promise(resolve => setImmediate(resolve));
    const second = await guard.runGuardedOperation(input, async () => { calls++; return 'duplicate'; });
    equal(second.status, 'IN_PROGRESS'); release();
    const first = await firstPromise; equal(first.status, 'COMPLETED');
    const third = await guard.runGuardedOperation(input, async () => { calls++; return 'duplicate'; });
    equal(third.status, 'ALREADY_PROCESSED'); equal(calls, 1);
  });

  await test('publication idempotency changes when a Safe Publish gate changes', () => {
    const base = { id: 'gate-product', status: 'needs_review', riskLevel: 'low', verifiedSource: true, autoPublishEligible: true, sourceHash: 'source', publicBlockReasons: [], linkHealthStatus: 'timeout', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok' };
    const before = products.publicationIdempotencyKey(base);
    const same = products.publicationIdempotencyKey({ ...base, updatedAt: new Date().toISOString() });
    const recovered = products.publicationIdempotencyKey({ ...base, linkHealthStatus: 'ok' });
    equal(before, same); assert(before !== recovered);
  });

  await test('secret sanitizer removes structured and inline credentials', () => {
    const sanitized = guard.sanitizeSensitiveValue({ authorization: 'Bearer abc', nested: { apiKey: 'raw', note: 'token=raw-token' } });
    const serialized = JSON.stringify(sanitized);
    assert(!serialized.includes('abc') && !serialized.includes('raw-token') && !serialized.includes('"raw"'));
    assert(serialized.includes('[REDACTED]'));
  });

  await test('product API rejects anonymous and invalid input', async () => {
    equal((await productRoute.POST(new NextRequest('http://localhost/api/products', { method: 'POST', body: '{}' }))).status, 401);
    const invalid = await productRoute.POST(new NextRequest('http://localhost/api/products', { method: 'POST', headers: { authorization: authHeader, 'content-type': 'application/json' }, body: '{broken' }));
    equal(invalid.status, 400);
  });

  await test('product creation is forced into review and duplicate-safe', async () => {
    await adapter.writeCollection('products', []);
    const payload = { title: 'Local fixture product', platform: 'website', originalUrl: 'https://example.test/products/fixture', affiliateUrl: 'https://example.test/go/fixture', price: 125000, status: 'published', publicHidden: false };
    const request = () => new NextRequest('http://localhost/api/products', { method: 'POST', headers: { authorization: authHeader, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const created = await productRoute.POST(request()); equal(created.status, 201);
    const body = await created.json(); equal(body.data.status, 'needs_review'); equal(body.data.publicHidden, true); equal(body.data.autoPublished, false);
    const duplicate = await productRoute.POST(request()); equal(duplicate.status, 409);
    equal((await adapter.readCollection('products')).length, 1);
  });

  await test('generic product update cannot bypass Safe Publish', async () => {
    const [product] = await adapter.readCollection('products');
    const anonymous = await productByIdRoute.GET(new NextRequest(`http://localhost/api/products/${product.id}`), { params: Promise.resolve({ id: product.id }) });
    equal(anonymous.status, 401);
    const response = await productByIdRoute.PATCH(new NextRequest(`http://localhost/api/products/${product.id}`, { method: 'PATCH', headers: { authorization: authHeader, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'published', publicHidden: false }) }), { params: Promise.resolve({ id: product.id }) });
    equal(response.status, 409);
    equal((await adapter.readCollection('products'))[0].status, 'needs_review');
  });

  await test('product route handler protects internal list and empty public data is safe', async () => {
    const internal = await productRoute.GET(new NextRequest('http://localhost/api/products'));
    equal(internal.status, 401);
    await adapter.writeCollection('products', []);
    const publicResponse = await productRoute.GET(new NextRequest('http://localhost/api/products?public=true'));
    equal(publicResponse.status, 200); equal((await publicResponse.json()).data.length, 0);
  });

  await test('Token Vault route rejects anonymous access in the handler', async () => {
    equal((await tokenListRoute.GET(new NextRequest('http://localhost/api/token-vault/list'))).status, 401);
    equal((await tokenListRoute.GET(new NextRequest('http://localhost/api/token-vault/list', { headers: { authorization: authHeader } }))).status, 200);
  });

  await test('scheduler authenticated dry-run performs no write', async () => {
    const before = fs.readdirSync(testRoot).sort().join(',');
    const response = await schedulerRoute.POST(new NextRequest('http://localhost/api/ai-bots/scheduler/tick?dryRun=true', { method: 'POST', headers: { 'x-sandeal-scheduler-secret': process.env.SCHEDULER_SECRET } }));
    equal(response.status, 200); equal((await response.json()).data.status, 'DRY_RUN');
    equal(fs.readdirSync(testRoot).sort().join(','), before);
  });

  await test('missing Gemini credential returns local-only without network calls', async () => {
    await adapter.writeCollection('token-vault', []); await adapter.writeCollection('gemini-pool-state', []);
    let calls = 0;
    const result = await geminiRouter.executeGeminiRequest({ modelId: 'gemini-3.1-flash-lite', taskType: 'metadata_repair', idempotencyKey: 'missing-credential', body: {}, timeoutMs: 100 }, async () => { calls++; throw new Error('must not call'); });
    equal(result.ok, false); equal(result.errorCode, 'local_only'); equal(calls, 0);
  });

  await test('server errors are sanitized for logs and clients', async () => {
    const messages = [];
    const original = console.error;
    console.error = (...args) => messages.push(args.join(' '));
    try {
      const response = apiResponses.serverErrorResponse('failed safely', new Error('token=raw-secret-value'));
      equal((await response.json()).error, 'INTERNAL_ERROR');
    } finally { console.error = original; }
    assert(!messages.join(' ').includes('raw-secret-value'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
})().catch(error => {
  failed++;
  console.error(`FAIL setup: ${error.stack || error}`);
}).finally(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
});
