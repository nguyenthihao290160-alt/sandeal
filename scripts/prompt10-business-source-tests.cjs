/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const testRoot = path.join(root, '.test-tmp', `prompt10-business-source-${process.pid}-${Date.now()}`);
const dataDir = path.join(testRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.ACCESS_TRADE_API_KEY = '';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function accessTradeItem(id = 'source-fixture') {
  return {
    id,
    name: 'Verified source adapter fixture',
    description: 'Behavior fixture',
    kind: 'product',
    sourceItemKind: 'product',
    platform: 'accesstrade',
    imageUrl: `https://cdn.example/${id}.jpg`,
    imageCandidates: [`https://cdn.example/${id}.jpg`],
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?aff=fixture`,
    price: 1500000,
    salePrice: 1200000,
    category: 'Audio',
    rawSourceKind: 'datafeed',
    needsVerification: false,
    verifiedSource: true,
    publicHidden: false,
    autoPublishEligible: true,
    publicDecision: 'public_candidate',
    publicBlockReason: '',
    qualityScore: 96,
    rawData: { api_key: 'must-not-cross-normalization-boundary', internal: true },
  };
}

async function main() {
  const storage = require('../src/lib/storage/adapter.ts');
  const platform = require('../src/lib/autonomous/sourceAdapterPlatform.ts');
  const quality = require('../src/lib/autonomous/sourceQuality.ts');
  const accessTrade = require('../src/lib/integrations/accesstrade.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_BUSINESS_SOURCE_TESTS'); };
  await storage.writeCollection('source-quality', []);

  await test('AccessTrade is the default registered adapter and exposes the complete source contract', async () => {
    const registry = platform.createDefaultSourceAdapterRegistry({ accessTrade: { configured: async () => false } });
    const adapter = registry.get('accesstrade');
    assert.ok(adapter);
    for (const method of ['isConfigured', 'healthCheck', 'discover', 'normalize', 'budget', 'classifyError', 'retryAfter', 'disclosure']) {
      assert.equal(typeof adapter[method], 'function', method);
    }
    assert.equal(registry.list().length, 1);
    assert.equal(registry.disclosures()[0].platformVersion, platform.SOURCE_ADAPTER_PLATFORM_VERSION);
  });

  await test('configured is not reported ready until an explicit successful health probe runs', async () => {
    let probes = 0;
    const notConfigured = platform.createAccessTradeSourceAdapter({
      configured: async () => false,
      healthProbe: async () => { probes += 1; return true; },
    });
    assert.deepEqual(await notConfigured.healthCheck({ probe: true }), { status: 'not_configured', configured: false, ready: false });
    assert.equal(probes, 0);
    const configured = platform.createAccessTradeSourceAdapter({ configured: async () => true });
    assert.deepEqual(await configured.healthCheck(), { status: 'configured', configured: true, ready: false, reason: 'live_probe_not_run' });
    assert.equal((await configured.healthCheck({ probe: true })).status, 'adapter_unavailable');
    const ready = platform.createAccessTradeSourceAdapter({ configured: async () => true, healthProbe: async () => true });
    const health = await ready.healthCheck({ probe: true });
    assert.equal(health.status, 'ready'); assert.equal(health.configured, true); assert.equal(health.ready, true);
  });

  await test('health probes fail closed when a provider claims ready without a ready result', async () => {
    const adapter = platform.createAccessTradeSourceAdapter({
      configured: async () => true,
      healthProbe: async () => ({ status: 'ready', configured: true, ready: false, reason: 'inconsistent_fixture' }),
    });
    const health = await adapter.healthCheck({ probe: true });
    assert.equal(health.status, 'last_check_failed'); assert.equal(health.ready, false);
  });

  await test('fixture discovery is product-only, bounded, request-counted, and normalization removes raw provider payload', async () => {
    let received;
    const adapter = platform.createAccessTradeSourceAdapter({
      configured: async () => true,
      discover: async input => {
        received = input;
        return {
          items: [accessTradeItem()], products: [], vouchers: [], campaigns: [], storeOffers: [], unknown: [],
          summary: {},
          requests: [
            { endpoint: 'datafeed', durationMs: 5, resultType: 'success_with_results', itemCount: 1, attempts: 2 },
            { endpoint: 'offers', durationMs: 2, resultType: 'circuit_open', itemCount: 0, attempts: 0, retryAfter: '2026-07-16T12:30:00.000Z' },
          ],
        };
      },
      getBudget: async () => ({ maximumRequests: 100, usedRequests: 20, remainingRequests: 80, resetAt: '2026-07-17T00:00:00.000Z' }),
    });
    const discovered = await adapter.discover({ keyword: '  headset  ', limit: 999 });
    assert.deepEqual(received, { keyword: 'headset', kind: 'product', limit: 50 });
    assert.equal(discovered.requests, 2); assert.equal(discovered.retryAfter, '2026-07-16T12:30:00.000Z');
    const normalized = adapter.normalize(discovered.items[0]);
    assert.equal(Object.hasOwn(normalized, 'rawData'), false);
    assert.deepEqual(await adapter.budget(), { maximumRequests: 100, usedRequests: 20, remainingRequests: 80, resetAt: '2026-07-17T00:00:00.000Z' });
  });

  await test('discovery refuses an unconfigured adapter before invoking the source', async () => {
    let called = false;
    const adapter = platform.createAccessTradeSourceAdapter({
      configured: async () => false,
      discover: async () => { called = true; throw new Error('should_not_run'); },
    });
    await assert.rejects(() => adapter.discover({ keyword: 'fixture', limit: 10 }), /SOURCE_NOT_CONFIGURED/);
    assert.equal(called, false);
  });

  await test('provider errors map to health states and preserve a safe Retry-After timestamp', () => {
    const retryAt = '2026-07-16T12:30:00.000Z';
    const adapter = platform.createAccessTradeSourceAdapter({ configured: async () => true });
    const limited = new accessTrade.AccessTradeRequestError('rate_limited', [
      { endpoint: 'datafeed', durationMs: 5, statusCode: 429, resultType: 'rate_limited', itemCount: 0, retryAfter: retryAt },
    ], 'rate limited fixture');
    const unauthorized = new accessTrade.AccessTradeRequestError('unauthorized', [], 'unauthorized fixture');
    assert.equal(adapter.classifyError(limited), 'rate_limited');
    assert.equal(adapter.retryAfter(limited), retryAt);
    assert.equal(adapter.classifyError(unauthorized), 'invalid_credential');
  });

  await test('adapter disclosures redact sensitive keys and authorization-like values', () => {
    const registry = new platform.SourceAdapterRegistry();
    registry.register({
      id: 'fixture', version: 'fixture-v1',
      isConfigured: async () => true,
      healthCheck: async () => ({ status: 'configured', configured: true, ready: false }),
      discover: async () => ({ items: [], requests: 0 }), normalize: item => item,
      budget: async () => ({ maximumRequests: 0, usedRequests: 0, remainingRequests: 0 }),
      classifyError: () => 'last_check_failed', retryAfter: () => undefined,
      disclosure: () => ({ apiKey: 'secret-fixture', nested: { authorization: 'Bearer secret-fixture' }, label: 'safe' }),
    });
    const serialized = JSON.stringify(registry.disclosures());
    assert.equal(serialized.includes('secret-fixture'), false);
    assert.equal(registry.disclosures()[0].details.apiKey, '[redacted]');
    assert.throws(() => registry.register(registry.get('fixture')), /SOURCE_ADAPTER_ALREADY_REGISTERED/);
  });

  let goodSnapshot;
  await test('Source Quality Bot persists every required business and health metric', async () => {
    const result = await quality.recordSourceQualityObservation('accesstrade', {
      idempotencyKey: 'quality-run:good:1', observedAt: '2026-07-16T12:00:00.000Z',
      candidatesObserved: 100, validCandidates: 90,
      linksChecked: 90, healthyLinks: 88,
      imagesChecked: 90, healthyImages: 87,
      pricesChecked: 90, pricesAvailable: 85,
      publishedProducts: 70, rolledBackProducts: 1,
      timeouts: 1, externalRequests: 80,
    });
    assert.equal(result.recorded, true);
    goodSnapshot = result.snapshot;
    assert.equal(goodSnapshot.schemaVersion, quality.SOURCE_QUALITY_SCHEMA_VERSION);
    assert.equal(goodSnapshot.ruleVersion, quality.SOURCE_QUALITY_RULE_VERSION);
    assert.equal(goodSnapshot.counters.candidatesObserved, 100);
    assert.equal(goodSnapshot.rates.candidateValidity, 0.9);
    assert.equal(goodSnapshot.rates.linkHealth, 0.9778);
    assert.equal(goodSnapshot.rates.imageHealth, 0.9667);
    assert.equal(goodSnapshot.rates.priceAvailability, 0.9444);
    assert.equal(goodSnapshot.rates.publishRate, 0.7778);
    assert.equal(goodSnapshot.rates.rollbackRate, 0.0143);
    assert.equal(goodSnapshot.rates.timeoutRate, 0.0125);
    assert.equal(goodSnapshot.rates.requestsPerPublishedProduct, 1.14);
    assert.equal(goodSnapshot.priorityClass, 'PREFERRED');
  });

  await test('quality observation replay is idempotent and changed replay is rejected', async () => {
    const input = {
      idempotencyKey: 'quality-run:good:1', observedAt: '2026-07-16T12:00:00.000Z',
      candidatesObserved: 100, validCandidates: 90, linksChecked: 90, healthyLinks: 88,
      imagesChecked: 90, healthyImages: 87, pricesChecked: 90, pricesAvailable: 85,
      publishedProducts: 70, rolledBackProducts: 1, timeouts: 1, externalRequests: 80,
    };
    const replay = await quality.recordSourceQualityObservation('accesstrade', input);
    assert.equal(replay.recorded, false); assert.equal(replay.snapshot.observations.length, 1);
    await assert.rejects(
      () => quality.recordSourceQualityObservation('accesstrade', { ...input, validCandidates: 89 }),
      /SOURCE_QUALITY_OBSERVATION_CONFLICT/,
    );
    assert.equal((await quality.getSourceQualitySnapshot('accesstrade')).observations.length, 1);
  });

  let poorSnapshot;
  await test('poor source outcomes deterministically lower scheduling priority', async () => {
    poorSnapshot = (await quality.recordSourceQualityObservation('poor-source', {
      idempotencyKey: 'quality-run:poor:1', observedAt: '2026-07-16T12:05:00.000Z',
      candidatesObserved: 100, validCandidates: 20,
      linksChecked: 20, healthyLinks: 5,
      imagesChecked: 20, healthyImages: 4,
      pricesChecked: 20, pricesAvailable: 5,
      publishedProducts: 2, rolledBackProducts: 1,
      timeouts: 50, externalRequests: 100,
    })).snapshot;
    const good = quality.applySourceQualityPriority(90, goodSnapshot);
    const poor = quality.applySourceQualityPriority(90, poorSnapshot);
    assert.equal(good.effectivePriority, 90);
    assert.equal(poor.priorityClass, 'SEVERELY_DEGRADED');
    assert.equal(poor.effectivePriority, 18);
    assert.ok(poor.qualityScore < good.qualityScore);
    const persisted = await quality.getSourcePriorityDecision('poor-source', 90);
    assert.deepEqual(persisted, poor);
  });

  await test('metrics aggregate across observations while invalid counter relationships fail closed', async () => {
    const second = await quality.recordSourceQualityObservation('poor-source', {
      idempotencyKey: 'quality-run:poor:2', observedAt: '2026-07-16T12:10:00.000Z',
      candidatesObserved: 10, validCandidates: 10,
      linksChecked: 10, healthyLinks: 10,
      imagesChecked: 10, healthyImages: 10,
      pricesChecked: 10, pricesAvailable: 10,
      publishedProducts: 8, rolledBackProducts: 0,
      timeouts: 0, externalRequests: 10,
    });
    assert.equal(second.snapshot.counters.candidatesObserved, 110);
    assert.equal(second.snapshot.counters.publishedProducts, 10);
    assert.equal(second.snapshot.observations.length, 2);
    const ranked = await quality.listSourceQualitySnapshots();
    assert.equal(ranked[0].sourceId, 'accesstrade');
    await assert.rejects(() => quality.recordSourceQualityObservation('invalid-source', {
      idempotencyKey: 'invalid', candidatesObserved: 2, validCandidates: 3,
    }), /SOURCE_QUALITY_COUNTER_RELATION_INVALID/);
  });

  console.log(`\nPROMPT10 Gate 7 source platform/quality: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
