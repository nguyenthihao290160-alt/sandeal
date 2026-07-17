/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-resilience-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.ACCESS_TRADE_API_KEY = 'fixture-access-trade-key';
require('./register-typescript.cjs');

let passed = 0; let failed = 0;
async function test(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function abortError(message = 'fixture timeout') {
  const error = new Error(message); error.name = 'AbortError'; return error;
}

function publishedProduct(id, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2, id, title: `Resilient Bluetooth headset ${id}`, slug: `resilient-headset-${id}`,
    description: 'Source-backed fixture for isolated health resilience verification.',
    kind: 'product', recordType: 'PRODUCT', lifecycleState: 'PUBLISHED', platform: 'website', source: 'manual',
    originalUrl: `https://${id}.example/product`, affiliateUrl: `https://${id}.example/go`, imageUrl: `https://${id}.example/primary.jpg`,
    gallery: [`https://${id}.example/fallback.jpg`], price: 1500000, salePrice: 1200000, currency: 'VND',
    category: 'Audio', tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'published', publicHidden: false,
    autoPublished: true, needsVerification: false, verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now,
    duplicateStatus: 'CLEAR', claimValidationStatus: 'VERIFIED', createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function geminiCredential(id, group, healthScore = 100) {
  return {
    id, platform: 'gemini', credentialType: 'api_key', role: id.endsWith('1') ? 'primary' : 'backup', label: id,
    encryptedValue: `b64:${Buffer.from(`fixture-${id}`).toString('base64')}`, maskedValue: 'fixt****test', status: 'valid',
    metadata: {
      billingMode: 'free_confirmed', keyType: 'auth', quotaGroupId: group,
      supportedModels: ['gemini-3.1-flash-lite', 'gemini-3.5-flash'], lightTestStatus: 'available', generationStatus: 'available',
      failureStreak: 0, requestsTodayEstimated: 0, inputTokensTodayEstimated: 0, outputTokensTodayEstimated: 0, healthScore,
    },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const health = require('../src/lib/bots/productHealthCheck.ts');
  const healthCleanup = require('../src/lib/bots/productHealth.ts');
  const circuits = require('../src/lib/bots/domainCircuitBreaker.ts');
  const products = require('../src/lib/storage/products.ts');
  const accessTrade = require('../src/lib/integrations/accesstrade.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const geminiRouter = require('../src/lib/ai/geminiCredentialRouter.ts');
  const geminiEditorial = require('../src/lib/ai/geminiEditorialProvider.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const providerRouter = require('../src/lib/automation/providerRouter.ts');
  const evidence = require('../src/lib/autonomous/evidenceGraph.ts');
  const automationStore = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_RESILIENCE'); };

  async function clear(...collections) {
    for (const collection of collections) await adapter.writeCollection(collection, []);
  }

  await test('link timeout remains retryable and persisted circuit uses exponential backoff with jitter', async () => {
    await clear('domain-circuit-breakers');
    let calls = 0;
    const timeoutFetch = async () => { calls++; throw abortError(); };
    const result = await health.checkLinkHealth('https://timeout-link.example/product', { fetchImpl: timeoutFetch, resolveDns: false });
    assert.equal(result.status, 'timeout'); assert.equal(result.retryable, true); assert.equal(calls, 2);

    const base = Date.parse('2026-07-16T00:00:00.000Z');
    const first = await circuits.recordDomainHealth('https://timeout-link.example/product', 'timeout', base, { baseDelayMs: 1000, maximumDelayMs: 60_000, jitterRatio: .2, random: () => .5 });
    const second = await circuits.recordDomainHealth('https://timeout-link.example/product', 'timeout', base + 1000, { baseDelayMs: 1000, maximumDelayMs: 60_000, jitterRatio: .2, random: () => .5 });
    const third = await circuits.recordDomainHealth('https://timeout-link.example/product', 'timeout', base + 2000, { baseDelayMs: 1000, maximumDelayMs: 60_000, jitterRatio: .2, random: () => .5 });
    assert.equal(first.failureStreak, 1); assert.equal(first.openedUntil, undefined);
    assert.equal(Date.parse(second.nextRetryAt) - (base + 1000), 2200);
    assert.equal(Date.parse(third.nextRetryAt) - (base + 2000), 4400);
    assert.equal((await circuits.getDomainCircuitDecision('https://timeout-link.example/product', base + 3000)).allowed, false);
    const reset = await circuits.recordDomainHealth('https://timeout-link.example/product', 'ok', base + 7000);
    assert.equal(reset.failureStreak, 0); assert.equal(reset.openedUntil, undefined);
  });

  await test('public cleanup records timeout cooldown but does not immediately hide product', async () => {
    await clear('products', 'domain-circuit-breakers');
    const fixture = publishedProduct('temporary-health');
    await adapter.writeCollection('products', [fixture]);
    const summary = await healthCleanup.runProductHealthCleanup({ fetchImpl: async () => { throw abortError(); }, resolveDns: false, random: () => 0 });
    const saved = await products.getProductById(fixture.id);
    assert.equal(summary.hidden, 0); assert.equal(summary.retryable, 1);
    assert.equal(saved.status, 'published'); assert.equal(saved.publicHidden, false);
    assert.equal(saved.linkHealthStatus, 'timeout'); assert.equal(saved.imageHealthStatus, 'timeout');
    assert.ok(saved.sourceHealthCooldownUntil); assert.equal(saved.sourceHealthReason, 'timeout');
  });

  await test('image candidates reject HTML and undersized payload before selecting healthy fallback', async () => {
    const fetchFixture = async (url) => {
      if (String(url).includes('html')) return new Response('', { status: 200, headers: { 'content-type': 'text/html', 'content-length': '1024' } });
      if (String(url).includes('tiny')) return new Response('', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '64' } });
      return new Response('', { status: 200, headers: { 'content-type': 'image/webp', 'content-length': '4096' } });
    };
    const resolved = await health.resolveHealthyImageCandidate([
      'https://images.example/html.jpg', 'https://images.example/tiny.jpg', 'https://images.example/good.webp',
    ], { fetchImpl: fetchFixture, resolveDns: false });
    assert.equal(resolved.attempts, 3); assert.equal(resolved.selectedUrl, 'https://images.example/good.webp');
    assert.equal(resolved.checked[0].result.status, 'invalid_image');
    assert.match(resolved.checked[1].result.reason, /too small/i);
    assert.equal(resolved.result.contentLength, 4096);
  });

  await test('published product switches to validated fallback image without being hidden', async () => {
    await clear('products', 'domain-circuit-breakers');
    const fixture = publishedProduct('image-fallback');
    await adapter.writeCollection('products', [fixture]);
    const fetchFixture = async (url, init) => {
      const value = String(url);
      if (init?.method === 'HEAD' && value.endsWith('/go')) return new Response('', { status: 200 });
      if (value.includes('primary.jpg')) return new Response('', { status: 200, headers: { 'content-type': 'text/html', 'content-length': '2048' } });
      return new Response('', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '8192' } });
    };
    const summary = await healthCleanup.runProductHealthCleanup({ fetchImpl: fetchFixture, resolveDns: false, random: () => 0 });
    const saved = await products.getProductById(fixture.id);
    assert.equal(summary.healthy, 1); assert.equal(summary.hidden, 0);
    assert.equal(saved.imageUrl, fixture.gallery[0]); assert.equal(saved.imageHealthStatus, 'ok');
    assert.equal(saved.status, 'published'); assert.equal(saved.publicHidden, false);
  });

  await test('durable health job uses circuits and image fallback without hiding a published product', async () => {
    await clear('products', 'domain-circuit-breakers', 'automation-jobs', 'automation-control', 'automation-audit');
    await automationStore.updateAutomationControl({
      mode: 'CANARY', effectiveMode: 'CANARY', publishPaused: false, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false,
    }, 'resilience-test');
    const fixture = publishedProduct('durable-health', {
      originalUrl: 'https://durable-link.example/product',
      affiliateUrl: 'https://durable-affiliate.example/go',
      imageUrl: 'https://durable-images.example/primary.jpg',
      gallery: ['https://durable-images.example/fallback.jpg'],
    });
    await adapter.writeCollection('products', [fixture]);
    const requests = [];
    global.fetch = async (url, init) => {
      const value = String(url);
      requests.push({ url: value, method: init?.method });
      if (value.includes('durable-link.example')) throw abortError();
      if (value.includes('durable-affiliate.example')) return new Response('', { status: 200 });
      if (value.includes('primary.jpg')) return new Response('', { status: 200, headers: { 'content-type': 'text/html', 'content-length': '2048' } });
      if (value.includes('fallback.jpg')) return new Response('', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '8192' } });
      throw new Error(`UNEXPECTED_DURABLE_HEALTH_REQUEST:${value}`);
    };
    const queued = await automationStore.createAutomationJob({
      type: 'RECHECK_PRODUCT_HEALTH', payload: { productIds: [fixture.id] },
      idempotencyKey: 'prompt10-resilience-durable-health', requestedBy: 'scheduler', priority: 80,
    });
    assert.equal(queued.job.status, 'PENDING');
    const run = await worker.processAutomationBatch('prompt10-resilience-worker', 1);
    assert.equal(run.succeeded, 1);
    const [saved, completed, circuit] = await Promise.all([
      products.getProductById(fixture.id),
      automationStore.getAutomationJob(queued.job.id),
      circuits.getDomainCircuitDecision(fixture.originalUrl),
    ]);
    assert.equal(saved.status, 'published'); assert.equal(saved.publicHidden, false);
    assert.equal(saved.linkHealthStatus, 'timeout'); assert.ok(saved.sourceHealthCooldownUntil);
    assert.match(saved.sourceHealthReason, /link:timeout/);
    assert.equal(saved.affiliateHealthStatus, 'ok');
    assert.equal(saved.imageUrl, fixture.gallery[0]); assert.equal(saved.imageHealthStatus, 'ok');
    assert.equal(requests.filter(request => request.url.includes('durable-affiliate.example')).length, 1);
    assert.equal(requests.length, 5);
    assert.equal(circuit.failureStreak, 1);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(completed.result.failed, 1); assert.equal(completed.result.fallbackImages, 1);
    assert.equal(completed.result.retryScheduled, 1);
    assert.equal(completed.result.externalRequests, 4);
  });

  await test('durable health job skips network access while a domain circuit is open', async () => {
    await clear('products', 'domain-circuit-breakers', 'automation-jobs', 'automation-control', 'automation-audit');
    await automationStore.updateAutomationControl({
      mode: 'CANARY', effectiveMode: 'CANARY', publishPaused: false, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false,
    }, 'resilience-test');
    const fixture = publishedProduct('durable-open-circuit');
    await adapter.writeCollection('products', [fixture]);
    const retryAfter = new Date(Date.now() + 120_000).toISOString();
    await circuits.recordDomainHealth(fixture.originalUrl, 'rate_limited', Date.now(), { retryAfter });
    let requests = 0;
    global.fetch = async () => { requests++; throw new Error('OPEN_CIRCUIT_MUST_NOT_FETCH'); };
    const queued = await automationStore.createAutomationJob({
      type: 'RECHECK_PRODUCT_HEALTH', payload: { productIds: [fixture.id], healthTarget: 'link' },
      idempotencyKey: 'prompt10-resilience-open-circuit', requestedBy: 'scheduler', priority: 80,
    });
    const run = await worker.processAutomationBatch('prompt10-resilience-open-circuit-worker', 1);
    assert.equal(run.succeeded, 1);
    const [saved, completed] = await Promise.all([
      products.getProductById(fixture.id),
      automationStore.getAutomationJob(queued.job.id),
    ]);
    assert.equal(requests, 0);
    assert.equal(saved.status, 'published'); assert.equal(saved.publicHidden, false);
    assert.equal(saved.linkHealthStatus, 'timeout'); assert.equal(saved.sourceHealthCooldownUntil, retryAfter);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(completed.result.circuitSkipped, 1); assert.equal(completed.result.externalRequests, 0);
    assert.equal(completed.result.retryScheduled, 1);
  });

  await test('AccessTrade 429 parses Retry-After and opens persisted source circuit without a second request', async () => {
    await clear('domain-circuit-breakers', 'token-vault');
    let calls = 0;
    global.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '120' } }); };
    const before = Date.now();
    let caught;
    try { await accessTrade.searchAccessTrade({ keyword: 'headset', kind: 'all', limit: 5 }); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof accessTrade.AccessTradeRequestError);
    assert.equal(caught.resultType, 'rate_limited'); assert.equal(calls, 1);
    assert.deepEqual(caught.requests.map(request => [request.resultType, request.attempts]), [['rate_limited', 1], ['circuit_open', 0]]);
    const retryAt = Date.parse(caught.requests[0].retryAfter);
    assert.ok(retryAt >= before + 119_000 && retryAt <= Date.now() + 121_000);
    const circuit = await circuits.getDomainCircuitDecision('https://api.accesstrade.vn/v1/datafeeds');
    assert.equal(circuit.allowed, false); assert.equal(circuit.retryAt, caught.requests[0].retryAfter);
  });

  await test('source scan contains rate limiting, reduces requests, and returns batch outcome instead of throwing', async () => {
    await clear('domain-circuit-breakers', 'token-vault', 'pipeline-keyword-stats', 'candidate-queue', 'products', 'automation-pipeline-usage');
    let calls = 0;
    global.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '90' } }); };
    const result = await pipeline.scanSourcesToQueue('steady', Date.now() + 30_000);
    assert.equal(result.resultTypes.rate_limited, 1); assert.equal(result.sourceRequests, 1); assert.equal(calls, 1);
    assert.ok(result.retryAfter); assert.equal(result.failed, 0);
  });

  await test('Gemini transient failover is bounded to two free quota groups', async () => {
    await clear('token-vault', 'gemini-pool-state', 'gemini-usage');
    await adapter.writeCollection('token-vault', [
      geminiCredential('resilience-1', 'resilience-group-1', 100),
      geminiCredential('resilience-2', 'resilience-group-2', 90),
      geminiCredential('resilience-3', 'resilience-group-3', 80),
    ]);
    let calls = 0;
    const result = await geminiRouter.executeGeminiRequest({
      modelId: 'gemini-3.1-flash-lite', taskType: 'editorial_review', idempotencyKey: 'resilience-bounded-failover',
      body: {}, timeoutMs: 1000, maxFailoverGroups: 2,
    }, async () => { calls++; return new Response('{}', { status: 503 }); });
    assert.equal(result.ok, false); assert.equal(calls, 2);
  });

  await test('invalid Gemini schema falls back to local editorial content without mandatory manual input', async () => {
    await clear('token-vault', 'gemini-pool-state', 'gemini-usage', 'automation-control', 'automation-circuits', 'automation-ai-usage');
    await adapter.writeCollection('token-vault', [geminiCredential('schema-1', 'schema-group-1')]);
    const product = publishedProduct('provider-fallback', { lifecycleState: 'CONTENT_PREPARING', status: 'needs_review', publicHidden: true });
    const localReview = editorial.generateEditorialReview(product, [], new Date().toISOString());
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reviewTitle: 'Incomplete schema' }) }] } }] });
    };
    const profile = { taskType: 'editorial_review', riskLevel: 'low', complexityScore: 40, factCount: localReview.keyFacts.length, inputTokenEstimate: 100, candidateLane: 'NORMAL_LANE', priority: 50, previousFailures: 0, requiredQuality: 80 };
    const generated = await geminiEditorial.generateGeminiEditorialReview(product, profile, ['gemini-3.5-flash'], () => localReview);
    assert.equal(generated, null); assert.equal(calls, 1);

    await adapter.writeCollection('token-vault', []);
    const route = await providerRouter.routeProviderExecution({
      capability: 'GENERATE_CONTENT', requestedMode: 'AUTO', provider: 'gemini', providerAdapterAvailable: true,
      localMode: 'LOCAL_TEMPLATE', allowLocalFallback: true, allowManualFallback: true,
    });
    assert.equal(route.executionMode, 'LOCAL_TEMPLATE'); assert.equal(route.requiresManualInput, false); assert.equal(route.provider, 'local');
    const claims = [...localReview.factualClaims, ...localReview.inferredClaims].map(claim => ({ id: claim.id, evidenceFactIds: claim.evidenceFactIds }));
    const validation = evidence.validateClaimsAgainstEvidence(product.id, claims, []);
    assert.equal(validation.valid, false);
    assert.equal(validation.status, 'MISSING_EVIDENCE');
  });

  await test('AUTO mode without provider or local content returns fail-closed decision, never manual work', async () => {
    await clear('token-vault', 'automation-control', 'automation-circuits', 'automation-ai-usage');
    const route = await providerRouter.routeProviderExecution({
      capability: 'UNKNOWN_CONTENT', requestedMode: 'AUTO', provider: 'gemini', providerAdapterAvailable: false,
      allowLocalFallback: true, allowManualFallback: true,
    });
    assert.equal(route.providerReady, false); assert.equal(route.requiresManualInput, false); assert.notEqual(route.executionMode, 'MANUAL_INPUT');
  });

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_RESILIENCE'); };
  console.log(`\nPROMPT10 Gate 6 resilience: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
