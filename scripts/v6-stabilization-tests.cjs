/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
require('./register-typescript.cjs');
const rollout = require('../src/lib/automation/featureRollout.ts');
const { LocalAiAdapter } = require('../src/lib/ai/localAiAdapter.ts');
const { dispatchOperatorAlert } = require('../src/lib/automation/operatorAlerting.ts');
let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
async function main() {
  for (const feature of rollout.SANDEAL_FEATURE_FLAGS) {
    await test(`${feature}: every mode agrees with authority`, () => {
      for (const value of [...rollout.FEATURE_ROLLOUT_MODES, 'invalid-fixture', undefined, '']) {
        const state = rollout.getFeatureRolloutState(feature, { [feature]: value });
        assert.equal(state.mode, state.effectiveMode);
        assert.equal(state.rolloutCohort, `${feature}:${state.effectiveMode}`);
        assert.equal(rollout.isFeatureActive(feature, { [feature]: value }), state.effectiveMode === 'ACTIVE');
        if (value === 'invalid-fixture') {
          assert.equal(state.valid, false);
          assert.equal(state.effectiveMode, 'OFF');
          assert.equal(state.configuredValue, 'INVALID');
        }
        if (value === 'ACTIVE' || value === 'OFF') assert.equal(state.effectiveMode, value);
      }
    });
  }
  await test('invalid local AI never reaches request boundary', async () => {
    let calls = 0;
    const adapter = new LocalAiAdapter({
      baseUrl: 'http://127.0.0.1:11434', environment: { AI_LOCAL_FALLBACK: 'invalid-fixture' },
      resourceSnapshot: () => ({ freeMemoryBytes: 4 * 1024 ** 3, eventLoopDelayMs: 0 }),
      fetchImpl: async () => { calls++; throw new Error('REQUEST_FORBIDDEN'); },
    });
    const state = await adapter.readiness();
    assert.equal(state.featureMode, 'OFF');
    assert.equal(state.reasonCode, 'FEATURE_DISABLED');
    await assert.rejects(adapter.generateCanonicalProposal({}, new Set()), /FEATURE_DISABLED/);
    assert.equal(calls, 0);
  });
  await test('invalid operator alert stops before adapter selection or storage', async () => {
    const result = await dispatchOperatorAlert({}, [], { OPERATOR_ALERTING: 'invalid-fixture' });
    assert.deepEqual(result, { status: 'SUPPRESSED', reasonCode: 'FEATURE_DISABLED', deliveries: [] });
  });
  await test('unknown feature rejects without falling back', () => {
    assert.throws(() => rollout.getFeatureRolloutState('UNKNOWN', { UNKNOWN: 'ACTIVE' }), /UNKNOWN_FEATURE/);
  });
  await test('documented defaults never implicitly activate optional features', () => {
    for (const [feature, expected] of Object.entries({
      WORKER_CONTINUOUS_POOL_V2: 'OFF', AI_LOCAL_FALLBACK: 'OFF', OPERATOR_ALERTING: 'OFF',
      SMART_CATEGORIZATION_V2: 'SHADOW', MULTI_AFFILIATE_OFFER: 'SHADOW', PROGRAMMATIC_SEO_V2: 'SHADOW',
    })) assert.equal(rollout.getFeatureRolloutState(feature, {}).effectiveMode, expected);
  });
  await test('synthetic samples cannot enter storage and remain public blocked', async () => {
    const { seedSampleProducts } = require('../src/lib/storage/products.ts');
    const { isPublicSafeProduct } = require('../src/lib/publicProductFilter.ts');
    const fixtures = require('./fixtures/development-products.cjs')();
    assert.equal(fixtures.length, 3);
    assert.equal(fixtures.filter(item => item.platform === 'shopee').length, 1);
    for (const item of fixtures) {
      assert.equal(item.isSample, true);
      assert.equal(isPublicSafeProduct({ ...item, status: 'published' }), false);
    }
    for (const mode of ['production', 'development', 'test']) {
      process.env.NODE_ENV = mode;
      await assert.rejects(seedSampleProducts(), /SYNTHETIC_SEED_DISABLED/);
    }
    process.env.NODE_ENV = 'test';
  });
  console.log(`V6 stabilization tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
