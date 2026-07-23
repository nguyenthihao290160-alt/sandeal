/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const testRoot = path.resolve(root, '.test-tmp', `production-health-readiness-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(root, '.test-tmp');
if (!testRoot.startsWith(`${allowedTempRoot}${path.sep}`)) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });

process.env.SANDEAL_DATA_DIR = path.join(testRoot, 'data');
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
process.env.RUNTIME_RESTART_DETECTION_WINDOW_MS = '600000';
process.env.RUNTIME_RESTART_THRESHOLD = '3';
process.env.RUNTIME_STABILIZATION_DURATION_MS = '600000';
process.env.TOKEN_VAULT_SECRET_KEY = ['fixture', 'vault', 'material', 'for', 'isolated', 'tests'].join('-');
delete process.env.GEMINI_API_KEY;
delete process.env.MONGODB_URI;
delete process.env.SANDEAL_STORAGE_DRIVER;

global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PRODUCTION_READINESS_TESTS'); };
require('./register-typescript.cjs');

const storage = require('../src/lib/storage/adapter.ts');
const systemCapability = require('../src/lib/health/systemCapability.ts');
const runtimeGuardian = require('../src/lib/automation/runtimeGuardian.ts');
const automationStore = require('../src/lib/automation/store.ts');
const slo = require('../src/lib/automation/sloErrorBudget.ts');
const geminiProbe = require('../src/lib/ai/geminiCredentialProbe.ts');
const credentialTruth = require('../src/lib/ai/credentialTruth.ts');
const geminiProvider = require('../src/lib/ai/geminiProviderStatus.ts');
const geminiRouter = require('../src/lib/ai/geminiCredentialRouter.ts');
const tokenVault = require('../src/lib/storage/tokenVault.ts');
const productStorage = require('../src/lib/storage/products.ts');
const accessTrade = require('../src/lib/integrations/accesstrade.ts');
const productDetail = require('../src/lib/dashboard/productDetailStatus.ts');

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fixtureNow = Date.parse('2026-07-23T04:00:00.000Z');
let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

async function resetCollections(...names) {
  for (const name of names) await storage.writeCollection(name, []);
}

function capabilityInput(overrides = {}) {
  return {
    web: { status: 'alive' },
    worker: { status: 'active' },
    scheduler: { status: 'active' },
    queue: { pending: 0, running: 0, stuck: 0, staleJobs: 0 },
    control: {
      publishPaused: false,
      publishPausedByOperator: false,
      publishBlockedByRuntime: false,
      publishBlockedByPolicy: false,
      publishRuntimeReasons: [],
      publishPolicyReasons: [],
      workerPaused: false,
      schedulerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
    },
    runtime: { publishSafe: true, reasons: [] },
    release: { releaseMismatch: false },
    ai: { providerStatus: 'ready', budgetAvailable: true, policyAllowed: true },
    ...overrides,
  };
}

function roleLease(role, now, takeoverHistory = []) {
  const at = new Date(now).toISOString();
  return {
    schemaVersion: 2,
    id: role,
    role,
    ownerId: `${role.toLowerCase()}-fixture`,
    instanceId: `${role.toLowerCase()}-fixture-instance`,
    holderId: `${role.toLowerCase()}-fixture`,
    status: 'ACTIVE',
    processStartedAt: at,
    acquiredAt: at,
    startedAt: at,
    heartbeatAt: at,
    expiresAt: new Date(now + 45_000).toISOString(),
    leaseExpiresAt: new Date(now + 45_000).toISOString(),
    fencingToken: 1,
    takeoverHistory,
    lastTakeoverAt: takeoverHistory.at(-1),
    takeoverCount: takeoverHistory.length,
    updatedAt: at,
  };
}

function modelListResponse() {
  return new Response(JSON.stringify({
    models: [
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function generationResponse() {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function createGemini(label, rawValue) {
  return tokenVault.createCredential({
    platform: 'gemini',
    credentialType: 'api_key',
    role: 'backup',
    label,
    value: rawValue,
  });
}

function candidate(sourceId, originalUrl, overrides = {}) {
  return {
    title: 'Serum dưỡng da fixture',
    kind: 'product',
    platform: 'accesstrade',
    source: 'accesstrade',
    sourceId,
    externalId: sourceId,
    originalUrl,
    affiliateUrl: `https://tracking.example/click/${sourceId}`,
    currency: 'VND',
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'unknown',
    status: 'needs_review',
    publicHidden: true,
    publicBlocked: true,
    needsVerification: true,
    verifiedSource: false,
    sourceVerified: false,
    ...overrides,
  };
}

function normalizedAtItem(overrides = {}) {
  return {
    id: 'at-1',
    name: 'Sữa tắm dịu nhẹ',
    description: 'Dành cho da nhạy cảm',
    kind: 'product',
    sourceItemKind: 'product',
    platform: 'accesstrade',
    imageUrl: 'https://cdn.example/item.jpg',
    imageCandidates: ['https://cdn.example/item.jpg'],
    originalUrl: 'https://merchant.example/item',
    affiliateUrl: 'https://tracking.example/item',
    price: 200000,
    salePrice: 180000,
    category: 'Chăm sóc cơ thể',
    merchant: 'Cửa hàng Việt',
    rawSourceKind: 'datafeed',
    needsVerification: true,
    verifiedSource: true,
    publicHidden: true,
    autoPublishEligible: false,
    publicDecision: 'needs_review',
    publicBlockReason: '',
    qualityScore: 80,
    rawData: { merchantName: 'Cửa hàng Việt', domain: 'merchant.example' },
    ...overrides,
  };
}

async function main() {
  await test('App Health: publish runtime block limits publishing without pausing operations', () => {
    const result = systemCapability.deriveSystemCapabilityStatus(capabilityInput({
      control: {
        ...capabilityInput().control,
        publishPaused: true,
        publishBlockedByRuntime: true,
        publishRuntimeReasons: ['REPEATED_PROCESS_RESTART'],
      },
      runtime: { publishSafe: false, reasons: ['REPEATED_PROCESS_RESTART'] },
    }));
    assert.equal(result.operationalStatus, 'OPERATIONAL');
    assert.equal(result.publishingStatus, 'BLOCKED');
    assert.equal(result.emergencyStatus, 'OFF');
    assert.equal(result.overallStatus, 'LIMITED');
    assert.equal(result.overallLabel, 'Hoạt động có giới hạn');
    assert.match(result.summary, /Bộ xử lý nền và lịch tự động vẫn hoạt động/);
  });

  await test('App Health: worker pause is an operational pause', () => {
    const input = capabilityInput();
    input.control.workerPaused = true;
    assert.equal(systemCapability.deriveSystemCapabilityStatus(input).operationalStatus, 'PAUSED');
  });

  await test('App Health: scheduler pause is scoped and reported as paused', () => {
    const input = capabilityInput();
    input.control.schedulerPaused = true;
    const result = systemCapability.deriveSystemCapabilityStatus(input);
    assert.equal(result.operationalStatus, 'PAUSED');
    assert.deepEqual(result.pausedComponents, ['scheduler']);
  });

  await test('App Health: kill switch is the only emergency stop', () => {
    const input = capabilityInput();
    input.control.killSwitch = true;
    const result = systemCapability.deriveSystemCapabilityStatus(input);
    assert.equal(result.operationalStatus, 'STOPPED');
    assert.equal(result.emergencyStatus, 'ON');
    assert.equal(result.overallStatus, 'EMERGENCY_STOP');
  });

  await test('App Health: release mismatch degrades instead of reporting healthy', () => {
    const result = systemCapability.deriveSystemCapabilityStatus(capabilityInput({ release: { releaseMismatch: true } }));
    assert.equal(result.operationalStatus, 'DEGRADED');
    assert.equal(result.publishingStatus, 'BLOCKED');
    assert.equal(result.overallStatus, 'LIMITED');
  });

  await test('Blank env configuration keeps centralized safe defaults', () => {
    const previous = {
      detection: process.env.RUNTIME_RESTART_DETECTION_WINDOW_MS,
      threshold: process.env.RUNTIME_RESTART_THRESHOLD,
      stabilization: process.env.RUNTIME_STABILIZATION_DURATION_MS,
      readiness: process.env.GEMINI_READINESS_MAX_AGE_MS,
    };
    try {
      process.env.RUNTIME_RESTART_DETECTION_WINDOW_MS = ' ';
      process.env.RUNTIME_RESTART_THRESHOLD = '';
      process.env.RUNTIME_STABILIZATION_DURATION_MS = ' ';
      process.env.GEMINI_READINESS_MAX_AGE_MS = '';
      assert.deepEqual(runtimeGuardian.getRuntimeRestartPolicy(), {
        detectionWindowMs: 15 * 60_000,
        threshold: 3,
        stabilizationDurationMs: 15 * 60_000,
      });
      assert.equal(credentialTruth.getGeminiReadinessMaxAgeMs(), 24 * 60 * 60_000);
    } finally {
      for (const [key, value] of Object.entries({
        RUNTIME_RESTART_DETECTION_WINDOW_MS: previous.detection,
        RUNTIME_RESTART_THRESHOLD: previous.threshold,
        RUNTIME_STABILIZATION_DURATION_MS: previous.stabilization,
        GEMINI_READINESS_MAX_AGE_MS: previous.readiness,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  await test('Runtime restart threshold is active only inside the configured window', () => {
    const history = [-180_000, -120_000, -60_000].map(offset => new Date(fixtureNow + offset).toISOString());
    const policy = { detectionWindowMs: 600_000, threshold: 3, stabilizationDurationMs: 600_000 };
    const active = runtimeGuardian.deriveRestartDegradation([roleLease('WORKER', fixtureNow, history)], fixtureNow, policy);
    assert.equal(active.active, true);
    assert.equal(active.roles.find(role => role.role === 'WORKER').restartsInWindow, 3);
    const stable = runtimeGuardian.deriveRestartDegradation([roleLease('WORKER', fixtureNow + 700_000, history)], fixtureNow + 700_000, policy);
    assert.equal(stable.active, false);
    assert.equal(stable.roles.find(role => role.role === 'WORKER').restartsInWindow, 0);
  });

  await test('Runtime Guardian clears current restart reason but retains historical incident', async () => {
    await resetCollections('automation-control', 'automation-jobs', 'runtime-role-leases', 'runtime-role-conflicts', 'runtime-health');
    const history = [-180_000, -120_000, -60_000].map(offset => new Date(fixtureNow + offset).toISOString());
    await storage.writeCollection('runtime-role-leases', [
      roleLease('WORKER', fixtureNow, history),
      roleLease('SCHEDULER', fixtureNow, []),
    ]);
    const first = await runtimeGuardian.runRuntimeGuardian({ apply: false, now: fixtureNow, webAlive: true, publicRouteHealthy: true, schedulerEnabled: true });
    assert.ok(first.reasons.includes('REPEATED_PROCESS_RESTART'));
    assert.ok(first.historicalReasons.includes('REPEATED_PROCESS_RESTART'));

    const stableNow = fixtureNow + 700_000;
    await storage.writeCollection('runtime-role-leases', [
      roleLease('WORKER', stableNow, history),
      roleLease('SCHEDULER', stableNow, []),
    ]);
    const second = await runtimeGuardian.runRuntimeGuardian({ apply: false, now: stableNow, webAlive: true, publicRouteHealthy: true, schedulerEnabled: true });
    assert.equal(second.reasons.includes('REPEATED_PROCESS_RESTART'), false);
    assert.ok(second.historicalReasons.includes('REPEATED_PROCESS_RESTART'));
  });

  await test('Operator publish pause survives runtime block reconciliation', async () => {
    await resetCollections('automation-control');
    await automationStore.updateAutomationControl({ publishPausedByOperator: true }, 'fixture-operator');
    await automationStore.updateAutomationControl({ publishBlockedByRuntime: true, publishRuntimeReasons: ['FIXTURE_RUNTIME_BLOCK'] }, 'runtime-guardian');
    const cleared = await automationStore.updateAutomationControl({ publishBlockedByRuntime: false, publishRuntimeReasons: [] }, 'runtime-guardian');
    assert.equal(cleared.publishPausedByOperator, true);
    assert.equal(cleared.publishBlockedByRuntime, false);
    assert.equal(cleared.publishPaused, true);
  });

  await test('Insufficient SLO data cannot clear a runtime publish block', async () => {
    await resetCollections('automation-jobs', 'runtime-health', 'automation-audit', 'outbound-events', 'products', 'automation-slo-snapshots');
    await automationStore.updateAutomationControl({ publishBlockedByRuntime: true, publishRuntimeReasons: ['FIXTURE_RUNTIME_BLOCK'] }, 'runtime-guardian');
    const result = await slo.applyAutomationErrorBudget({ now: fixtureNow + 900_000, actor: 'fixture-controller' });
    assert.notEqual(result.evaluation.status, 'PASS');
    assert.equal((await automationStore.getAutomationControl()).publishBlockedByRuntime, true);
  });

  await test('Gemini diagnostics classify terminal and transient failures safely', () => {
    assert.deepEqual(geminiProbe.classifyGeminiFailure(401).diagnosticCategory, 'INVALID_KEY');
    const permission = geminiProbe.classifyGeminiFailure(403);
    assert.equal(permission.diagnosticCategory, 'PERMISSION_DENIED');
    assert.equal(permission.retryable, false);
    assert.equal(permission.cooldownMs, 0);
    assert.equal(geminiProbe.classifyGeminiFailure(429, '60').diagnosticCategory, 'RATE_LIMITED');
    assert.equal(geminiProbe.classifyGeminiFailure(429).diagnosticCategory, 'QUOTA_EXCEEDED');
    assert.equal(geminiProbe.classifyGeminiFailure(404).diagnosticCategory, 'MODEL_NOT_AVAILABLE');
    assert.equal(geminiProbe.classifyGeminiFailure(451).diagnosticCategory, 'REGION_RESTRICTED');
    assert.equal(geminiProbe.classifyGeminiFailure(503).diagnosticCategory, 'PROVIDER_UNAVAILABLE');
    const timeout = new Error('fixture timeout'); timeout.name = 'TimeoutError';
    assert.equal(geminiProbe.classifyGeminiException(timeout).diagnosticCategory, 'NETWORK_TIMEOUT');
  });

  await test('Model listing HTTP 200 does not imply generation readiness', async () => {
    await resetCollections('token-vault', 'gemini-pool-state');
    const credential = await createGemini('listing-only', ['fixture', 'listing', 'only'].join('-'));
    const result = await geminiProbe.lightTestCredential(credential.id, async () => modelListResponse(), fixtureNow);
    assert.equal(result.status, 'valid');
    assert.equal(result.generationReady, false);
    assert.equal((await geminiProvider.getGeminiProviderReadiness(fixtureNow)).status, 'configured_not_ready');
  });

  await test('Generation permission denied persists terminal state without cooldown or provider body', async () => {
    await resetCollections('token-vault', 'gemini-pool-state');
    const rawValue = ['fixture', 'permission', 'denied'].join('-');
    const credential = await createGemini('permission-denied', rawValue);
    let calls = 0;
    const result = await geminiProbe.generationProbeCredential(credential.id, async (url) => {
      calls += 1;
      if (String(url).endsWith('/models')) return modelListResponse();
      return new Response(JSON.stringify({ error: { message: 'provider-body-must-not-persist' } }), { status: 403 });
    }, fixtureNow);
    const stored = await tokenVault.getCredentialById(credential.id);
    assert.equal(calls, 2);
    assert.equal(result.diagnosticCategory, 'PERMISSION_DENIED');
    assert.equal(result.generationReady, false);
    assert.equal(result.retryable, false);
    assert.equal(stored.status, 'missing_permission');
    assert.equal(stored.metadata.cooldownUntil, undefined);
    assert.equal(stored.metadata.generationReady, false);
    assert.equal(JSON.stringify({ result, stored }).includes(rawValue), false);
    assert.equal(JSON.stringify(stored).includes('provider-body-must-not-persist'), false);
  });

  await test('Minimal generation success persists a fresh route-ready truth', async () => {
    await resetCollections('token-vault', 'gemini-pool-state');
    const credential = await createGemini('ready', ['fixture', 'ready', 'generation'].join('-'));
    const result = await geminiProbe.generationProbeCredential(credential.id, async (url) => String(url).endsWith('/models') ? modelListResponse() : generationResponse(), fixtureNow);
    const stored = await tokenVault.getCredentialById(credential.id);
    const truth = credentialTruth.getCredentialTruth(stored, fixtureNow);
    assert.equal(result.generationReady, true);
    assert.equal(truth.generationReady, true);
    assert.equal(stored.metadata.lastGenerationSucceededAt, new Date(fixtureNow).toISOString());
    assert.equal(stored.metadata.testedModel, 'gemini-2.5-flash-lite');
    assert.equal(stored.metadata.freePolicyEligible, true);
    assert.equal(stored.metadata.adapterReady, true);
    assert.equal(stored.metadata.runtimeRouteReady, true);
    assert.equal((await geminiRouter.selectGeminiCredentials('unverified-paid-model', fixtureNow)).length, 0);
    assert.equal((await geminiRouter.selectGeminiCredentials('gemini-2.5-flash-lite', fixtureNow)).length, 1);
  });

  await test('A stale generation success no longer routes', async () => {
    const credentials = await tokenVault.listCredentials({ platform: 'gemini' });
    const stored = await tokenVault.getCredentialById(credentials[0].id);
    const stale = credentialTruth.getCredentialTruth(stored, fixtureNow + credentialTruth.getGeminiReadinessMaxAgeMs() + 1);
    assert.equal(stale.generationReady, false);
    assert.equal(stale.reasonCode, 'generation_check_stale');
  });

  await test('Primary selection rejects unready Gemini, accepts ready, and demotes terminal failures', async () => {
    await resetCollections('token-vault', 'gemini-pool-state');
    const unready = await createGemini('unready-primary', ['fixture', 'unready', 'primary'].join('-'));
    assert.equal(await tokenVault.setPrimaryCredential(unready.id), null);
    const ready = await createGemini('ready-primary', ['fixture', 'ready', 'primary'].join('-'));
    await geminiProbe.generationProbeCredential(ready.id, async (url) => String(url).endsWith('/models') ? modelListResponse() : generationResponse(), fixtureNow);
    assert.equal((await tokenVault.setPrimaryCredential(ready.id)).role, 'primary');
    await geminiProbe.generationProbeCredential(ready.id, async () => new Response('{}', { status: 403 }), fixtureNow + 1);
    assert.equal((await tokenVault.getCredentialById(ready.id)).role, 'backup');
  });

  await test('Batch Gemini probe updates every connection and returns structured stats', async () => {
    await resetCollections('token-vault', 'gemini-pool-state');
    const values = {
      ready: ['fixture', 'batch', 'ready'].join('-'),
      denied: ['fixture', 'batch', 'denied'].join('-'),
      invalid: ['fixture', 'batch', 'invalid'].join('-'),
    };
    await createGemini('batch-ready', values.ready);
    await createGemini('batch-denied', values.denied);
    await createGemini('batch-invalid', values.invalid);
    const batch = await geminiProbe.probeAllGeminiCredentials(async (url, init = {}) => {
      const headers = init.headers || {};
      const key = typeof headers.get === 'function' ? headers.get('x-goog-api-key') : headers['x-goog-api-key'];
      if (String(url).endsWith('/models')) {
        if (key === values.invalid) return new Response('{}', { status: 401 });
        return modelListResponse();
      }
      if (key === values.denied) return new Response('{}', { status: 403 });
      return generationResponse();
    }, fixtureNow);
    assert.equal(batch.stats.total, 3);
    assert.equal(batch.stats.validKeys, 2);
    assert.equal(batch.stats.generationReady, 1);
    assert.equal(batch.stats.permissionDenied, 1);
    assert.equal(batch.stats.invalidKey, 1);
    assert.equal(batch.results.length, 3);
    const stored = await Promise.all((await tokenVault.listCredentials({ platform: 'gemini' })).map(item => tokenVault.getCredentialById(item.id)));
    assert.ok(stored.every(item => item.lastCheckedAt));
    for (const value of Object.values(values)) assert.equal(JSON.stringify(batch).includes(value), false);
  });

  await test('Provider status changes from configured_not_ready to ready with a live runtime route', async () => {
    await resetCollections('token-vault', 'gemini-pool-state');
    const credential = await createGemini('provider-transition', ['fixture', 'provider', 'transition'].join('-'));
    await geminiProbe.lightTestCredential(credential.id, async () => modelListResponse(), fixtureNow);
    assert.equal((await geminiProvider.getGeminiProviderReadiness(fixtureNow)).status, 'configured_not_ready');
    await geminiProbe.generationProbeCredential(credential.id, async () => generationResponse(), fixtureNow);
    const provider = await geminiProvider.getGeminiProviderReadiness(fixtureNow);
    assert.equal(provider.status, 'ready');
    assert.equal(provider.adapterAvailable, true);
    assert.equal(provider.generationReadyConnections, 1);
  });

  await test('Three similar candidates create three distinct canonical mappings', async () => {
    await resetCollections('products');
    const results = [];
    for (const suffix of ['a', 'b', 'c']) {
      results.push(await productStorage.upsertSourceCandidateProduct(candidate(`source-${suffix}`, `https://merchant.example/serum-${suffix}`)));
    }
    assert.equal(new Set(results.map(result => result.product.id)).size, 3);
    assert.equal((await productStorage.getAllProducts()).length, 3);
  });

  await test('A true canonical URL duplicate merges with explicit evidence', async () => {
    await resetCollections('products');
    const first = await productStorage.upsertSourceCandidateProduct(candidate('source-original', 'https://merchant.example/serum?id=42&utm_source=fixture'));
    const duplicate = await productStorage.upsertSourceCandidateProduct(candidate('source-duplicate', 'https://merchant.example/serum?id=42'));
    assert.equal(duplicate.product.id, first.product.id);
    assert.ok(duplicate.mapping.duplicateEvidence.includes('CANONICAL_URL_EXACT'));
    assert.equal(duplicate.product.sourceMappings.length, 2);
  });

  await test('Similar title with different source IDs and URLs never merges by keyword', async () => {
    await resetCollections('products');
    const first = await productStorage.upsertSourceCandidateProduct(candidate('serum-1', 'https://one.example/serum'));
    const second = await productStorage.upsertSourceCandidateProduct(candidate('serum-2', 'https://two.example/serum'));
    assert.notEqual(first.product.id, second.product.id);
  });

  await test('Conflicting source ID and canonical URL evidence fails closed', async () => {
    await resetCollections('products');
    await productStorage.upsertSourceCandidateProduct(candidate('conflict-a', 'https://one.example/conflict'));
    await productStorage.upsertSourceCandidateProduct(candidate('conflict-b', 'https://two.example/conflict'));
    await assert.rejects(
      () => productStorage.upsertSourceCandidateProduct(candidate('conflict-a', 'https://two.example/conflict')),
      error => error && error.code === 'SOURCE_CANDIDATE_MAPPING_CONFLICT',
    );
  });

  await test('Candidate enrichment fills only missing canonical fields', async () => {
    await resetCollections('products');
    const first = await productStorage.upsertSourceCandidateProduct(candidate('enrich-1', 'https://merchant.example/enrich', {
      affiliateUrl: undefined,
      imageUrl: undefined,
      merchant: undefined,
      price: undefined,
    }));
    const enriched = await productStorage.upsertSourceCandidateProduct(candidate('enrich-1', 'https://merchant.example/enrich', {
      affiliateUrl: 'https://tracking.example/enrich',
      imageUrl: 'https://cdn.example/enrich.jpg',
      merchant: 'Fixture merchant',
      price: 350000,
    }));
    assert.equal(enriched.product.id, first.product.id);
    assert.equal(enriched.product.imageUrl, 'https://cdn.example/enrich.jpg');
    assert.equal(enriched.product.price, 350000);
    assert.ok(enriched.mapping.enrichedFields.includes('image URL'));
    assert.ok(enriched.mapping.enrichedFields.includes('giá nguồn'));
  });

  await test('Unverified enrichment never overwrites verified canonical fields', async () => {
    await resetCollections('products');
    const created = await productStorage.upsertSourceCandidateProduct(candidate('verified-1', 'https://merchant.example/verified', {
      affiliateUrl: 'https://tracking.example/verified-original',
      imageUrl: 'https://cdn.example/verified-original.jpg',
      price: 900000,
    }));
    await productStorage.updateProduct(created.product.id, { status: 'approved', verifiedSource: true, sourceVerified: true });
    const result = await productStorage.upsertSourceCandidateProduct(candidate('verified-1', 'https://merchant.example/verified', {
      affiliateUrl: 'https://tracking.example/unverified-replacement',
      imageUrl: 'https://cdn.example/unverified-replacement.jpg',
      price: 1,
    }));
    assert.equal(result.product.affiliateUrl, 'https://tracking.example/verified-original');
    assert.equal(result.product.imageUrl, 'https://cdn.example/verified-original.jpg');
    assert.equal(result.product.price, 900000);
  });

  await test('Affiliate URL is never used as canonical product identity', async () => {
    await resetCollections('products');
    const tracking = 'https://tracking.example/shared-click';
    const first = await productStorage.upsertSourceCandidateProduct(candidate('affiliate-a', tracking, { affiliateUrl: tracking }));
    const second = await productStorage.upsertSourceCandidateProduct(candidate('affiliate-b', tracking, { affiliateUrl: tracking }));
    assert.notEqual(first.product.id, second.product.id);
    assert.equal(first.product.originalUrl, undefined);
  });

  await test('AccessTrade matching is accent/case/whitespace insensitive across merchant metadata', () => {
    const result = accessTrade.applyAccessTradeFiltersWithDiagnostics(
      [normalizedAtItem({ name: 'SỮA    TẮM dịu nhẹ', rawData: { merchantName: 'Cửa Hàng Việt' } })],
      { keyword: 'sua tam cua hang viet', kind: 'product' },
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.rejectionCounters.keywordMismatch, 0);
  });

  await test('AccessTrade aliases normalize product_name and reject voucher/campaign records as products', () => {
    const product = accessTrade.normalizeAccessTradeItem({
      product_id: 'alias-product',
      product_name: 'Tai nghe fixture',
      product_url: 'https://merchant.example/alias-product',
      image_url: 'https://cdn.example/alias-product.jpg',
      price: 500000,
      __sandealEndpoint: 'datafeed',
      __sandealSourceKind: 'product_feed',
    });
    const voucher = accessTrade.normalizeAccessTradeItem({
      id: 'voucher-fixture',
      title: 'Voucher giảm 20%',
      type: 'voucher',
      url: 'https://merchant.example/voucher',
    });
    assert.equal(product.name, 'Tai nghe fixture');
    assert.equal(product.kind, 'product');
    assert.equal(voucher.kind, 'voucher');
  });

  await test('AccessTrade filter diagnostics are structured and optional image/affiliate filters remain bounded', () => {
    const items = [
      normalizedAtItem({ id: 'match' }),
      normalizedAtItem({ id: 'keyword-miss', name: 'Tai nghe', description: '' }),
      normalizedAtItem({ id: 'no-image', imageUrl: '' }),
      normalizedAtItem({ id: 'no-affiliate', affiliateUrl: '' }),
    ];
    const optional = accessTrade.applyAccessTradeFiltersWithDiagnostics(items, { keyword: 'sua tam', kind: 'product' });
    assert.equal(optional.items.length, 3);
    assert.equal(optional.rejectionCounters.keywordMismatch, 1);
    const strict = accessTrade.applyAccessTradeFiltersWithDiagnostics(items, { keyword: 'sua tam', kind: 'product', imageOnly: true, affiliateLinkOnly: true });
    assert.equal(strict.items.length, 1);
    assert.equal(strict.rejectionCounters.missingImage, 1);
    assert.equal(strict.rejectionCounters.missingAffiliateUrl, 1);
  });

  await test('AccessTrade rejects malformed and private-network URLs', () => {
    assert.equal(accessTrade.isValidHttpUrl('not-a-url'), false);
    assert.equal(accessTrade.isValidHttpUrl('http://127.0.0.1/private'), false);
    assert.equal(accessTrade.isValidHttpUrl('http://10.0.0.2/private'), false);
    assert.equal(accessTrade.isValidHttpUrl('http://[::ffff:127.0.0.1]/private'), false);
    assert.equal(accessTrade.isValidHttpUrl('https://merchant.example/product'), true);
    assert.equal(accessTrade.isValidHttpUrl('https://fcommerce.example/product'), true);
    const normalized = accessTrade.normalizeAccessTradeItem({
      product_id: 'private-url',
      product_name: 'Private URL fixture product',
      product_url: 'http://127.0.0.1/private',
      image_url: 'http://10.0.0.2/private.jpg',
      price: 100000,
      __sandealEndpoint: 'datafeed',
    });
    assert.equal(normalized.originalUrl, '');
    assert.equal(normalized.imageUrl, '');
  });

  await test('AccessTrade pagination and retry boundaries remain finite', () => {
    const code = source('src/lib/integrations/accesstrade.ts');
    assert.ok(code.includes('Math.min(Math.max(params.limit || 20, 1), 50)'));
    assert.ok(code.includes('Math.min(Math.max(limit * 4, 50), 200)'));
    assert.ok(code.includes('const MAX_RETRIES = 1'));
    assert.equal(code.includes('while (true)'), false);
  });

  await test('Product detail blocker summary separates merchant, affiliate, image, price and duplicate concerns', () => {
    const blockers = [
      'merchant_quarantined_30shinestore',
      'affiliate_provenance_missing',
      'missing_image',
      'price_stale',
      'duplicate_unresolved',
      'source_unverified',
    ];
    const summary = productDetail.deriveProductRemediationSummary(blockers, blockers.slice(0, 5), 'KEEP_QUARANTINED');
    assert.equal(summary.total, 6);
    assert.equal(summary.critical, 5);
    assert.equal(summary.merchantQuarantined, true);
    assert.deepEqual(summary.groups.map(group => group.category), ['MERCHANT_POLICY', 'AFFILIATE', 'IMAGE', 'PRICE', 'DUPLICATE', 'DATA']);
    assert.match(summary.nextAction, /quarantine/i);
  });

  await test('Technical product JSON redacts secret fields and sensitive URL query values', () => {
    const safe = productDetail.sanitizeProductTechnicalDetails({
      id: 'product-fixture',
      apiKey: 'must-not-appear',
      nested: { cookie: 'must-not-appear-either' },
      originalUrl: 'https://merchant.example/item?access_token=must-not-appear&sku=42',
    });
    const serialized = JSON.stringify(safe);
    assert.equal(serialized.includes('must-not-appear'), false);
    assert.ok(serialized.includes('[REDACTED]'));
    assert.ok(serialized.includes('sku=42'));
  });

  await test('UI regression guards expose unambiguous capability, Gemini and candidate mapping semantics', () => {
    const healthPage = source('src/app/dashboard/app-health/page.tsx');
    const healthRoute = source('src/app/api/automation/health/route.ts');
    const tokenPage = source('src/app/dashboard/token-vault/page.tsx');
    const sourcePage = source('src/app/dashboard/product-sources/page.tsx');
    const detailPage = source('src/app/dashboard/products/[id]/page.tsx');
    const detailCss = source('src/app/dashboard/products/[id]/product-detail.module.css');
    assert.ok(healthPage.includes('Hoạt động có giới hạn'));
    assert.ok(healthPage.includes('Đăng an toàn'));
    assert.ok(healthRoute.includes('getGeminiProviderReadiness'));
    assert.equal(healthRoute.includes('adapterAvailable: false'), false);
    assert.ok(tokenPage.includes('Thiếu quyền tạo nội dung'));
    assert.ok(tokenPage.includes('data-primary-disabled-reason'));
    assert.equal(tokenPage.includes('window.prompt'), false);
    assert.equal(tokenPage.includes('dialog-overlay'), false);
    assert.ok(sourcePage.includes('data-canonical-product-id={saveResult.productId}'));
    assert.ok(sourcePage.includes('encodeURIComponent(saveResult.productId)'));
    assert.ok(detailPage.includes('Tóm tắt cần xử lý'));
    assert.ok(detailPage.includes('data-secret-sanitized="true"'));
    assert.ok(detailCss.includes('.remediationSummary'));
  });
}

main()
  .catch((error) => {
    failed += 1;
    console.error(error && error.stack ? error.stack : error);
  })
  .finally(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    console.log(`\nProduction health/readiness regressions: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  });
