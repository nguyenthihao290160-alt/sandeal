/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

require.extensions['.ts'] = function transpile(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(process.cwd(), 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};

const tempDir = path.join(process.cwd(), '.test-tmp', `gemini-diagnostics-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;

let passed = 0;
let failed = 0;
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
async function test(name, run) {
  try { await run(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error}`); }
}
function response(status, body = {}, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const rawKey = 'AIza-isolated-complete-key-must-never-escape-1234';
function credential(overrides = {}) {
  return {
    id: 'gemini-safe-test', platform: 'gemini', credentialType: 'api_key', role: 'primary', label: 'Gemini isolated',
    encryptedValue: `b64:${Buffer.from(rawKey).toString('base64')}`, maskedValue: '****1234', status: 'valid',
    metadata: {
      provider: 'gemini', billingMode: 'free_confirmed', keyType: 'auth', quotaGroupId: 'isolated-group', priority: 7,
      supportedModels: ['gemini-3.1-flash-lite'], preferredModel: 'gemini-3.1-flash-lite',
      lightTestStatus: 'available', generationStatus: 'unchecked', failureStreak: 0,
      requestsTodayEstimated: 0, inputTokensTodayEstimated: 0, outputTokensTodayEstimated: 0, healthScore: 80,
    },
    createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z', ...overrides,
  };
}

(async () => {
  const adapter = require('../src/lib/storage/adapter.ts');
  const diagnostics = require('../src/lib/ai/geminiProviderDiagnostics.ts');
  const probe = require('../src/lib/ai/geminiCredentialProbe.ts');
  const truth = require('../src/lib/ai/credentialTruth.ts');
  const vault = require('../src/lib/storage/tokenVault.ts');
  const secrets = require('../src/lib/security/secrets.ts');

  await test('Gemini HTTP errors map to safe normalized categories', async () => {
    const cases = [
      [response(401), 'INVALID_KEY', false],
      [response(403, { error: { status: 'PERMISSION_DENIED', message: 'permission denied' } }), 'PERMISSION_DENIED', false],
      [response(403, { error: { message: 'Generative Language API is not supported in your region' } }), 'REGION_RESTRICTED', false],
      [response(404, { error: { message: 'model not found' } }), 'MODEL_NOT_AVAILABLE', false],
      [response(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }), 'QUOTA_EXCEEDED', true],
      [response(429, {}), 'RATE_LIMITED', true],
      [response(503, {}), 'PROVIDER_UNAVAILABLE', true],
    ];
    for (const [providerResponse, category, retryable] of cases) {
      const result = await diagnostics.classifyGeminiProviderResponse(providerResponse);
      equal(result.category, category);
      equal(result.retryable, retryable);
    }
    const timeout = diagnostics.classifyGeminiProviderException(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    equal(timeout.category, 'NETWORK_TIMEOUT'); equal(timeout.retryable, true);
  });

  await test('bounded exponential cooldown never applies to invalid or permission errors', () => {
    equal(diagnostics.computeGeminiCooldownMs('INVALID_KEY', 5), undefined);
    equal(diagnostics.computeGeminiCooldownMs('PERMISSION_DENIED', 5), undefined);
    const first = diagnostics.computeGeminiCooldownMs('RATE_LIMITED', 1);
    const fifth = diagnostics.computeGeminiCooldownMs('RATE_LIMITED', 5);
    assert(first >= diagnostics.GEMINI_MIN_COOLDOWN_MS);
    assert(fifth > first);
    assert(fifth <= diagnostics.GEMINI_MAX_COOLDOWN_MS);
    equal(diagnostics.computeGeminiCooldownMs('QUOTA_EXCEEDED', 10, 24 * 60 * 60_000), diagnostics.GEMINI_MAX_COOLDOWN_MS);
  });

  await test('generationReady remains false before a successful real generation request', async () => {
    const stored = credential({ metadata: { ...credential().metadata, generationStatus: 'available' } });
    equal(truth.getCredentialTruth(stored).generationReady, false);
    await adapter.writeCollection('token-vault', [credential()]);
    const light = await probe.lightTestCredential('gemini-safe-test', async () => response(200, {
      models: [{ name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] }],
    }));
    equal(light.generationReady, false);
    equal(truth.getCredentialTruth(await vault.getSafeCredentialById('gemini-safe-test')).generationReady, false);
    const generated = await probe.generationProbeCredential('gemini-safe-test', async () => response(200, {
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
    }));
    equal(generated.generationReady, true);
    const after = await vault.getSafeCredentialById('gemini-safe-test');
    equal(truth.getCredentialTruth(after).generationReady, true);
    equal(after.metadata.testedModel, 'gemini-3.1-flash-lite');
    equal(after.metadata.providerHttpStatus, 200);
    equal(after.role, 'primary');
    equal(after.metadata.priority, 7);
  });

  await test('invalid and permission failures are terminal and have no cooldown', async () => {
    for (const [status, category] of [[401, 'INVALID_KEY'], [403, 'PERMISSION_DENIED']]) {
      await adapter.writeCollection('token-vault', [credential()]);
      const result = await probe.generationProbeCredential('gemini-safe-test', async () => response(status, { error: { message: category } }));
      equal(result.errorCategory, category);
      equal(result.retryable, false);
      equal(result.cooldownUntil, null);
      equal(result.generationReady, false);
      const safe = await vault.getSafeCredentialById('gemini-safe-test');
      equal(safe.metadata.cooldownUntil, undefined);
      equal(safe.metadata.errorCategory, category);
    }
  });

  await test('rate and quota failures persist bounded retry metadata', async () => {
    await adapter.writeCollection('token-vault', [credential()]);
    const first = await probe.generationProbeCredential('gemini-safe-test', async () => response(429, {}, { 'retry-after': '30' }));
    equal(first.errorCategory, 'RATE_LIMITED'); equal(first.retryable, true); assert(first.cooldownUntil);
    const firstDelay = Date.parse(first.cooldownUntil) - Date.parse(first.lastCheckedAt);
    const second = await probe.generationProbeCredential('gemini-safe-test', async () => response(429, { error: { message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }));
    equal(second.errorCategory, 'QUOTA_EXCEEDED'); equal(second.retryable, true); assert(second.cooldownUntil);
    const secondDelay = Date.parse(second.cooldownUntil) - Date.parse(second.lastCheckedAt);
    assert(firstDelay >= diagnostics.GEMINI_MIN_COOLDOWN_MS && firstDelay <= diagnostics.GEMINI_MAX_COOLDOWN_MS);
    assert(secondDelay >= firstDelay && secondDelay <= diagnostics.GEMINI_MAX_COOLDOWN_MS);
  });

  await test('provider bodies, thrown messages and complete API keys never enter safe results', async () => {
    await adapter.writeCollection('token-vault', [credential()]);
    const providerBody = { error: { message: `permission denied for key ${rawKey}`, internal: { authorization: rawKey } } };
    const result = await probe.generationProbeCredential('gemini-safe-test', async () => response(403, providerBody));
    const safe = await vault.getSafeCredentialById('gemini-safe-test');
    const projection = secrets.toSafeCredential(await vault.getCredentialById('gemini-safe-test'));
    const snapshot = JSON.stringify({ result, safe, projection });
    assert(!snapshot.includes(rawKey));
    assert(!snapshot.includes('permission denied for key'));
    assert(!snapshot.includes('encryptedValue'));
    equal(result.errorCategory, 'PERMISSION_DENIED');

    await adapter.writeCollection('token-vault', [credential()]);
    const thrown = await probe.generationProbeCredential('gemini-safe-test', async () => { throw new Error(`socket failed ${rawKey}`); });
    assert(!JSON.stringify(thrown).includes(rawKey));
    equal(thrown.errorCategory, 'TRANSIENT_ERROR');
  });

  await test('Vietnamese admin message is useful and UI exposes category groups only', async () => {
    await adapter.writeCollection('token-vault', [credential()]);
    const result = await probe.generationProbeCredential('gemini-safe-test', async () => response(404, { error: { message: 'model not found' } }));
    assert(/mô hình|không khả dụng/i.test(result.message));
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/token-vault/page.tsx'), 'utf8');
    for (const label of ['Lỗi cấu hình', 'Lỗi quyền', 'Hạn mức / tốc độ', 'Lỗi tạm thời', 'Sẵn sàng']) assert(page.includes(label));
    assert(page.includes('Mô hình đã thử'));
    assert(page.includes('Có thể thử lại'));
  });

  console.log(`\nGemini provider diagnostics: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
