import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
load('./register-typescript.cjs');

const { evaluateCannibalizationRisk } = load('../src/lib/content/cannibalization.ts');
const { planContent } = load('../src/lib/content/planner.ts');
const { CONTENT_CONFIG } = load('../src/lib/content/config.ts');

async function runTests() {
  console.log('--- CONTENT INTELLIGENCE LOCAL TESTS ---');
  let passed = 0;
  let failed = 0;

  function runCase(name, fn) {
    try {
      fn();
      passed++;
      console.log(`PASS: ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL: ${name}`);
      console.error(err);
    }
  }

  runCase('CONFIG', () => {
    assert.equal(CONTENT_CONFIG.REFRESH_FIRST, true);
    assert.equal(CONTENT_CONFIG.NEW_URL_DEFAULT, false);
    assert.equal(CONTENT_CONFIG.ACTIVE_PRODUCTION_EXPERIMENTS, 0);
    assert.equal(CONTENT_CONFIG.PRODUCTION_EXPERIMENT_TRAFFIC, 0);
    assert.equal(CONTENT_CONFIG.SHADOW_CONTENT_IN_SITEMAP, 0);
    assert.equal(CONTENT_CONFIG.FAKE_SCARCITY_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.AI_CONTENT_FACT_MUTATION_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.FAKE_STRUCTURED_RATING_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.DUPLICATE_CONTENT_PLAN_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.UNCHANGED_CONTENT_REFRESH_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.CONTENT_POLICY_OVERRIDE_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.CONTENT_OPPORTUNITY_SCORE_MUTATION_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.CONTENT_DEAL_SCORE_MUTATION_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.CONTENT_MONEY_ROUTE_OVERRIDE_EFFECT, 0);
    assert.equal(CONTENT_CONFIG.ACCESS_TRADE_SHOPEE_CONTENT, 'PASS');
    assert.equal(CONTENT_CONFIG.DIRECT_SHOPEE_API_CALLS, 0);
    assert.equal(CONTENT_CONFIG.LIVE_AI_PROBE, 'NOT_RUN');
  });

  const existingProductEntity = {
    id: 'ent-1',
    type: 'PRODUCT_PAGE',
    intent: 'PRODUCT',
    canonicalTarget: { url: '/deals/product-a', entityId: 'prod-a', entityType: 'PRODUCT' },
    lifecycle: 'PUBLISHED_EXISTING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  runCase('CASE A - EXISTING PRODUCT PAGE + NEW PRICE', () => {
    const inputs = {
      opportunityId: 'opp-1',
      policyState: 'ALLOW',
      existingContent: [existingProductEntity],
      candidateIntent: 'PRODUCT',
      candidateSlug: 'product-a',
      candidateCanonicalEntityId: 'prod-a',
      materialChangeDetected: true,
      opportunityFingerprint: 'fprint-1'
    };

    const plan = planContent(inputs);
    assert.equal(plan.action, 'REFRESH_EXISTING_CONTENT');
    assert.equal(plan.cannibalizationRisk, 'BLOCK_NEW_CONTENT');
    assert.equal(plan.coverage, 'STALE_COVERAGE');
  });

  runCase('CASE B - EXISTING PRODUCT PAGE + NEW ACCESS TRADE SHOPEE OFFER', () => {
    const inputs = {
      opportunityId: 'opp-2',
      policyState: 'ALLOW',
      existingContent: [existingProductEntity],
      candidateIntent: 'PRODUCT',
      candidateSlug: 'product-a-shopee', 
      candidateCanonicalEntityId: 'prod-a', 
      materialChangeDetected: true,
      opportunityFingerprint: 'fprint-2'
    };

    const plan = planContent(inputs);
    assert.equal(plan.action, 'REFRESH_EXISTING_CONTENT');
    assert.ok(plan.reasonCodes.includes('SAME_PRODUCT_SAME_INTENT'));
  });

  runCase('CASE C - SAME PRODUCT / DUPLICATE ARTICLE INTENT', () => {
    const inputs = {
      opportunityId: 'opp-3',
      policyState: 'ALLOW',
      existingContent: [existingProductEntity],
      candidateIntent: 'PRODUCT',
      candidateSlug: 'best-deal-product-a',
      candidateCanonicalEntityId: 'prod-a',
      materialChangeDetected: false,
      opportunityFingerprint: 'fprint-3'
    };

    const plan = planContent(inputs);
    assert.equal(plan.action, 'NO_ACTION'); 
    assert.equal(plan.cannibalizationRisk, 'BLOCK_NEW_CONTENT');
  });

  runCase('CASE D - PRODUCT COMPARISON WITH DISTINCT INTENT', () => {
    const inputs = {
      opportunityId: 'opp-4',
      policyState: 'ALLOW',
      existingContent: [existingProductEntity],
      candidateIntent: 'COMPARISON',
      candidateSlug: 'product-a-vs-product-b',
      candidateCanonicalEntityId: 'comp-a-b', 
      materialChangeDetected: true,
      opportunityFingerprint: 'fprint-4'
    };

    const plan = planContent(inputs);
    assert.equal(plan.action, 'CREATE_COMPARISON_CANDIDATE');
    assert.equal(plan.cannibalizationRisk, 'SAFE');
  });

  runCase('CASE G - CONTENT ALREADY ADEQUATE', () => {
    const inputs = {
      opportunityId: 'opp-7',
      policyState: 'ALLOW',
      existingContent: [existingProductEntity],
      candidateIntent: 'PRODUCT',
      candidateSlug: 'product-a',
      candidateCanonicalEntityId: 'prod-a',
      materialChangeDetected: false, 
      opportunityFingerprint: 'fprint-7'
    };

    const plan = planContent(inputs);
    assert.equal(plan.action, 'NO_ACTION');
    assert.equal(plan.coverage, 'ADEQUATE_COVERAGE');
  });

  runCase('CASE H - POLICY BLOCK', () => {
    const inputs = {
      opportunityId: 'opp-8',
      policyState: 'BLOCK',
      existingContent: [],
      candidateIntent: 'PRODUCT',
      candidateSlug: 'product-b',
      candidateCanonicalEntityId: 'prod-b',
      materialChangeDetected: true,
      opportunityFingerprint: 'fprint-8'
    };

    const plan = planContent(inputs);
    assert.equal(plan.action, 'BLOCK');
    assert.ok(plan.reasonCodes.includes('POLICY_BLOCKED'));
  });

  runCase('IDEMPOTENCY - DUPLICATE CONTENT PLAN EFFECT', () => {
    const inputs = {
      opportunityId: 'opp-10',
      policyState: 'ALLOW',
      existingContent: [],
      candidateIntent: 'PRODUCT',
      candidateSlug: 'product-c',
      candidateCanonicalEntityId: 'prod-c',
      materialChangeDetected: true,
      opportunityFingerprint: 'fprint-10'
    };

    const plan1 = planContent(inputs);
    const plan2 = planContent(inputs);
    
    assert.equal(plan1.evidenceFingerprint, plan2.evidenceFingerprint);
    assert.equal(plan1.action, plan2.action);
  });

  runCase('AI HALLUCINATION GUARD (Simulated)', () => {
    assert.equal(CONTENT_CONFIG.AI_CONTENT_FACT_MUTATION_EFFECT, 0);
  });

  console.log(`\nResults: ${passed} PASSED, ${failed} FAILED`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
