import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const load = createRequire(import.meta.url);
load('./register-typescript.cjs');
const { dealFixture, verifiedPublicOffers } = load('./fixtures/v6-deal-intelligence.cjs');
const { evaluateDeal, dealFingerprint } = load('../src/lib/deal-intelligence/evaluate.ts');
const { buildDecisionContext } = load('../src/lib/decision-os/context.ts');
const { evaluateDecisionPolicy } = load('../src/lib/decision-os/policy.ts');
const { planDecision } = load('../src/lib/decision-os/planner.ts');
const { emptyAiResult } = load('../src/lib/decision-os/reasoner.ts');
const { DECISION_CONFIG } = load('../src/lib/decision-os/config.ts');
const { evaluateOpportunity } = load('../src/lib/opportunity/evaluate.ts');
const { OPPORTUNITY_CONFIG, validateOpportunityConfig, boundedOpportunity } = load('../src/lib/opportunity/config.ts');
const { D1OpportunityStore } = load('../src/lib/storage/d1/d1OpportunityStore.ts');
const { D1DecisionStore } = load('../src/lib/storage/d1/d1DecisionStore.ts');
const { D1ExperimentStore } = load('../src/lib/storage/d1/d1ExperimentStore.ts');
const { D1JobStore } = load('../src/lib/storage/d1/d1JobStore.ts');
const { assignVariant, experimentIdentity, summarizeExperiment, validateExperiment, validateTransition, EXPERIMENT_LIMITS } = load('../src/lib/experiments/model.ts');
const { EXPERIMENT_TYPES, EXPERIMENT_STATES, EXPERIMENT_METRICS } = load('../src/lib/experiments/types.ts');
const { createCloudflareSchedulerAdapter } = load('../src/lib/platform/cloudflareAdapters.ts');
const { cloudflareOpportunityStore } = load('../src/lib/runtime/cloudflare/opportunity.ts');
const { consumeDelivery } = load('../src/lib/runtime/cloudflare/autopilot.ts');
const { delivery } = load('./lib/cloudflare-autopilot-test.cjs');
const { makeMessage } = load('../src/lib/platform/cloudflareContracts.ts');
const { ShopeeAffiliateProvider } = load('../src/lib/affiliate/shopeeAffiliateProvider.ts');
const { fileStorageAdapter } = load('../src/lib/storage/fileStorageAdapter.ts');

const constraints = { executionMode: 'SHADOW', systemHealth: 'AVAILABLE', systemVersion: 'local-d1-queue-v1', securityRisk: false, quarantined: false, runtimeValid: true };
const cases = [], proofs = {}, directMethods = new Map();
let directShopeeCalls = 0;
for (const method of ['discoverProducts', 'getProduct', 'getOffers', 'getPromotions', 'createTrackingLink', 'syncTransactions', 'syncCommissions']) {
  directMethods.set(method, ShopeeAffiliateProvider.prototype[method]);
  ShopeeAffiliateProvider.prototype[method] = async () => { directShopeeCalls++; throw new Error('DIRECT_SHOPEE_FORBIDDEN'); };
}
async function test(name, work) {
  try { await work(); cases.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, status: 'FAIL', message: String(error.message) }); console.error(`FAIL ${name}`, error); }
}
function prepareSource(fixture) {
  const source = structuredClone(fixture.input);
  source.evidenceRevision = 1;
  for (const offer of source.product.offers) if (offer.monetization) {
    offer.monetization.validUntil = new Date(source.now + 8 * 3_600_000).toISOString();
    offer.expiresAt = offer.monetization.validUntil;
  }
  return source;
}
function revenue(source, changes = {}) {
  return { scope: 'PRODUCT', scopeId: source.product.id, day: new Date(source.now).toISOString().slice(0, 10), currency: 'VND', clicks: 100, conversions: 20,
    amountsMinor: { UNKNOWN: 0, ESTIMATED: 0, PENDING: 0, APPROVED: 25000, REJECTED: 0, PAID: 0 }, unknownAmounts: 0, asOfSequence: 42, ...changes };
}
function inputFor(source, dealChanges = {}, changes = {}) {
  const deal = { ...evaluateDeal(source), ...dealChanges };
  if (Object.keys(dealChanges).length) deal.evidenceFingerprint = dealFingerprint(['EXPLICIT_TEST_FIXTURE_SCORE_CASE', deal]);
  const context = buildDecisionContext({ ...source, deal, evidenceRevision: source.evidenceRevision ?? 1, constraints: { ...constraints, ...changes } });
  const policy = evaluateDecisionPolicy(context), ai = emptyAiResult('DISABLED', 'AI_DISABLED');
  const decision = { decisionId: context.decisionId, productId: context.productId, origin: context.origin, evidenceFingerprint: context.evidenceFingerprint,
    dealEvaluationId: deal.evidenceFingerprint, dealScore: deal.dealScore, dealConfidence: deal.confidence, dealPriority: deal.priority,
    provider: context.money.provider, platform: context.money.platform, policyVersion: context.decisionPolicyVersion, dealAlgorithmVersion: deal.algorithmVersion,
    promptVersion: null, policy, ai, plan: planDecision(context, policy, null), createdAt: context.decisionTimestamp, validUntil: context.validUntil };
  return { source, deal, decision, context };
}
function specFor(productId, now, changes = {}) {
  return { productId, type: 'TITLE_VARIANT', version: 1, variants: [{ id: 'A', weight: 5000 }, { id: 'B', weight: 5000 }], primaryMetric: 'CLICK',
    startsAt: now, expiresAt: now + 600000, minimumRuntimeMs: 60000, minimumSubjectsPerVariant: 20, minimumEventsPerVariant: 5, ...changes };
}
function experimentFor(spec) {
  const identity = experimentIdentity(spec);
  return { ...identity.normalized, experimentId: identity.experimentId, definitionFingerprint: identity.fingerprint, state: 'SHADOW', executionMode: 'SHADOW', origin: 'TEST_FIXTURE', guardrails: [] };
}
async function integrated(name, work) {
  await test(name, () => dealFixture(async fixture => {
    const source = prepareSource(fixture);
    Object.assign(fixture.product, source.product);
    await fixture.persist();
    const decisions = new D1DecisionStore(fixture.db, constraints, true), opportunities = new D1OpportunityStore(fixture.db, decisions, true);
    const opportunity = await opportunities.evaluate(fixture.product.id, source.allowedHosts, fixture.now);
    const experiments = new D1ExperimentStore(fixture.db, opportunities, true);
    await work({ ...fixture, source, decisions, opportunities, opportunity, experiments,
      env: { ...fixture.env, SANDEAL_DECISION_OS_ENABLED: 'true', SANDEAL_OPPORTUNITY_ENABLED: 'true' },
      async shadow(changes = {}) {
        const experiment = await experiments.create(specFor(fixture.product.id, fixture.now, changes), fixture.now);
        await experiments.transition(experiment.experimentId, 'ELIGIBLE', fixture.now);
        return experiments.transition(experiment.experimentId, 'SHADOW', fixture.now);
      } });
  }));
}
async function count(db, table) { return (await db.prepare(`SELECT count(*) AS count FROM ${table}`).first()).count; }
async function queryPlan(db, sql, values = []) {
  const result = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all()).results.map(row => row.detail).join('\n');
  assert.match(result, /SEARCH/); assert.doesNotMatch(result, /SCAN (?:opportunity_evaluations|experiments|experiment_assignments|experiment_metric_events|affiliate_money_events|deal_work)\b/);
  return result;
}
async function main() {
  await dealFixture(async fixture => {
    const base = prepareSource(fixture), original = structuredClone(base);
    const strong = structuredClone(base); strong.revenue = [revenue(strong)];
    for (const offer of strong.product.offers) if (offer.monetization) offer.monetization.commissionRate = 5;
    const excellent = inputFor(strong, { dealScore: 95, confidence: 1 }), caseA = evaluateOpportunity(excellent);
    const poor = structuredClone(base);
    for (const offer of poor.product.offers) if (offer.monetization) { offer.monetization.validUntil = new Date(base.now + 60000).toISOString(); offer.expiresAt = offer.monetization.validUntil; }
    const inputB = inputFor(poor, { dealScore: 95, confidence: 0.75 }), caseB = evaluateOpportunity(inputB);
    const caseC = evaluateOpportunity(inputFor(strong, { dealScore: 84, confidence: 1 }));
    const caseD = evaluateOpportunity(inputFor(base, { dealScore: 90, confidence: 1 }));
    const caseE = evaluateOpportunity(inputFor(strong, { dealScore: 35, confidence: 1 }));
    proofs.opportunityCases = Object.fromEntries(Object.entries({ A: caseA, B: caseB, C: caseC, D: caseD, E: caseE }).map(([name, record]) => [name,
      { dealScore: record.dealScore, score: record.opportunityScore, confidence: record.opportunityConfidence, priority: record.opportunityPriority }]));
    await test('A great deal plus verified monetization has high opportunity and priority', () => {
      assert.equal(caseA.dealScore, 95); assert.equal(caseA.opportunityPriority, 'P0'); assert.equal(caseA.opportunityConfidence, 1);
      assert.equal(caseA.resourceRecommendation.actions.includes('HIGH_PRIORITY_CANDIDATE'), true); assert.equal(caseA.opportunityScore, 93.2);
    });
    await test('B great deal with weak monetization ranks below A without DealScore mutation', () => {
      assert.equal(caseB.opportunityScore < caseA.opportunityScore, true); assert.equal(inputB.deal.dealScore, 95); assert.equal(caseB.dealScore, 95);
      assert.deepEqual(caseB.monetizationEvidence, ['MONETIZATION_PATH_ONLY']);
      assert.equal(caseA.monetizationEvidence.includes('MONETIZATION_PATH_ONLY'), false);
      assert.equal(caseA.monetizationEvidence.includes('VERIFIED_REVENUE_EVIDENCE'), true);
    });
    await test('C moderate deal with verified business evidence outranks B', () => {
      assert.equal(caseC.dealScore, 84); assert.equal(caseC.opportunityScore > caseB.opportunityScore, true);
    });
    await test('D cold-start gets bounded exploration, lower confidence, meaningful priority', () => {
      assert.equal(caseD.explorationBonus, 4); assert.equal(caseD.opportunityConfidence, 0.85);
      assert.equal(caseD.reasonCodes.includes('NEW_OPPORTUNITY_LIMITED_HISTORY'), true); assert.equal(caseD.revenueEvidenceScore, null);
      assert.equal(caseD.opportunityPriority, 'P1'); assert.equal(caseD.opportunityScore > caseB.opportunityScore, true);
    });
    await test('E historical revenue cannot make a weak current deal top-ranked', () => { assert.equal(caseE.opportunityPriority, 'P3'); assert.equal(caseE.opportunityScore < caseD.opportunityScore, true); });
    for (const [name, changes, outcome] of [['F policy BLOCK', { securityRisk: true }, 'BLOCK'], ['policy QUARANTINE', { quarantined: true }, 'QUARANTINE']]) {
      await test(`${name} dominates every score and experiment recommendation`, () => {
        const input = inputFor(strong, { dealScore: 100 }, changes), result = evaluateOpportunity(input);
        assert.equal(input.decision.policy.outcome, outcome); assert.equal(result.opportunityPriority, 'BLOCKED');
        assert.deepEqual(result.resourceRecommendation.actions, ['NO_RESOURCE']); assert.equal(result.experimentEligibility.state, 'NOT_ELIGIBLE'); assert.equal(result.experimentProposal, null);
      });
    }
    await test('H same inputs have byte-identical evaluation and recommendation identity', () => {
      assert.deepEqual(evaluateOpportunity(excellent), caseA); assert.deepEqual(base, original); assert.equal(excellent.deal.dealScore, 95);
    });
    await test('unknown revenue is distinct from observed zero and never fake demand', () => {
      const known = structuredClone(base); known.revenue = [revenue(known, { conversions: 0, clicks: 0, amountsMinor: { UNKNOWN: 0, ESTIMATED: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, PAID: 0 } })];
      const result = evaluateOpportunity(inputFor(known));
      assert.equal(result.revenueEvidenceScore, 0); assert.equal(caseD.revenueEvidenceScore, null); assert.equal(result.seoExternalEvidence, 'NOT_AVAILABLE'); assert.equal(result.competitionEvidenceScore, null);
    });
    await test('absent optional commission fields are not invented commission terms', () => {
      const source = structuredClone(base);
      for (const offer of source.product.offers) if (offer.monetization) { delete offer.monetization.commissionRate; delete offer.monetization.commissionAmountEstimate; }
      const result = evaluateOpportunity(inputFor(source));
      assert.equal(result.monetizationEvidence.includes('KNOWN_COMMISSION_TERMS'), false);
      assert.equal(result.reasonCodes.includes('KNOWN_COMMISSION_TERMS_NOT_PAID_REVENUE'), false);
    });
    for (const score of [0, 10, 35, 50, 70, 84, 95, 100]) await test(`bounded deterministic score invariant for DealScore ${score}`, () => {
      const input = inputFor(strong, { dealScore: score }), record = evaluateOpportunity(input);
      assert.equal(record.opportunityScore >= 0 && record.opportunityScore <= 100, true); assert.equal(record.opportunityConfidence >= 0 && record.opportunityConfidence <= 1, true);
      assert.deepEqual(record, evaluateOpportunity(input)); assert.equal(input.deal.dealScore, score);
    });
    await test('raising verified deal quality helps but is not the sole ranking factor', () => {
      const left = evaluateOpportunity(inputFor(strong, { dealScore: 80 })), right = evaluateOpportunity(inputFor(strong, { dealScore: 90 }));
      assert.equal(Math.round((right.opportunityScore - left.opportunityScore) * 10000), 38000);
    });
    for (const value of [NaN, Infinity, -Infinity, -1, 101, '95', null]) await test(`invalid DealScore ${String(value)} fails closed`, () => {
      const input = structuredClone(excellent); input.deal.dealScore = value;
      assert.throws(() => evaluateOpportunity(input), /OPPORTUNITY/);
    });
    for (const value of [NaN, Infinity, -0.1, 1.1, 95]) await test(`invalid confidence ${String(value)} fails closed`, () => {
      const input = structuredClone(excellent); input.deal.confidence = value; assert.throws(() => evaluateOpportunity(input), /OPPORTUNITY/);
    });
    for (const field of ['deal', 'decision', 'context']) await test(`missing ${field} fails closed`, () => {
      const input = { ...excellent, [field]: null }; assert.throws(() => evaluateOpportunity(input), /OPPORTUNITY_REQUIRED_EVIDENCE_MISSING/);
    });
    for (const [name, mutation] of [
      ['negative revenue', source => source.revenue[0].amountsMinor.APPROVED = -1],
      ['infinite revenue', source => source.revenue[0].amountsMinor.PAID = Infinity],
      ['NaN revenue', source => source.revenue[0].clicks = NaN],
      ['negative conversions', source => source.revenue[0].conversions = -1],
      ['future revenue day', source => source.revenue[0].day = '2099-01-01'],
      ['wrong revenue product', source => source.revenue[0].scopeId = 'not-this-product'],
      ['wrong revenue currency', source => source.revenue[0].currency = 'USD'],
      ['missing commission states', source => delete source.revenue[0].amountsMinor.PAID],
      ['repeated revenue day', source => source.revenue.push(structuredClone(source.revenue[0]))],
      ['zero evidence sequence', source => source.revenue[0].asOfSequence = 0],
    ]) await test(`${name} is rejected rather than scored`, () => {
      const input = structuredClone(excellent); mutation(input.source); assert.throws(() => evaluateOpportunity(input), /OPPORTUNITY/);
    });
    await test('historic revenue outlier has identical bounded influence to a modest verified amount', () => {
      const outlier = structuredClone(strong); outlier.revenue[0].amountsMinor.APPROVED = 1000000000000;
      assert.equal(evaluateOpportunity(inputFor(outlier, { dealScore: 95, confidence: 1 })).opportunityScore, caseA.opportunityScore);
    });
    await test('extreme revenue dominance and quota configuration attacks are rejected', () => {
      const input = structuredClone(excellent); input.source.revenue[0].amountsMinor.APPROVED = Number.MAX_SAFE_INTEGER; assert.throws(() => evaluateOpportunity(input), /OPPORTUNITY/);
      const config = structuredClone(OPPORTUNITY_CONFIG); config.weights.revenue = 60; config.weights.deal = -14; assert.throws(() => validateOpportunityConfig(config), /INVALID_OPPORTUNITY_CONFIG/);
    });
    for (const [name, mutation] of [
      ['NaN weight', config => config.weights.deal = NaN], ['infinite confidence weight', config => config.confidence.deal = Infinity],
      ['weights do not sum', config => config.weights.deal = 37], ['confidence sum invalid', config => config.confidence.deal = 0.99],
      ['excessive exploration', config => config.explorationMax = 5], ['invalid priority thresholds', config => config.highScore = 110],
      ['unbounded reads', config => config.readLimit = 1000000], ['unsupported algorithm', config => config.algorithmVersion = 'unknown'],
    ]) await test(`configuration ${name} fails closed`, () => { const config = structuredClone(OPPORTUNITY_CONFIG); mutation(config); assert.throws(() => validateOpportunityConfig(config), /INVALID_OPPORTUNITY_CONFIG/); });
    for (const value of [NaN, Infinity, -Infinity]) await test(`canonical bounded score refuses ${String(value)}`, () => assert.throws(() => boundedOpportunity(value), /INVALID_OPPORTUNITY_SCORE/));
    await test('algorithm version change creates different opportunity fingerprint', () => {
      const next = evaluateOpportunity(excellent, { ...OPPORTUNITY_CONFIG, algorithmVersion: 'opportunity-engine-v2' });
      assert.notEqual(next.evidenceFingerprint, caseA.evidenceFingerprint); assert.equal(next.algorithmVersion, 'opportunity-engine-v2');
    });
    await test('high score can have lower independent confidence', () => {
      const source = structuredClone(strong); source.revenue = [];
      for (const offer of source.product.offers) if (offer.monetization) { offer.monetization.validUntil = null; delete offer.expiresAt; }
      const result = evaluateOpportunity(inputFor(source, { dealScore: 100, confidence: 1 }));
      assert.equal(result.opportunityScore > 70, true); assert.equal(result.opportunityConfidence, 0.75); assert.equal(result.opportunityPriority, 'P2');
    });
    await test('canonical content takes precedence over contradictory missing-content marker', () => {
      const source = structuredClone(base); source.product.contentPackageStatus = 'none';
      const result = evaluateOpportunity(inputFor(source)); assert.equal(result.contentOpportunity, 'LOW'); assert.equal(result.reasonCodes.includes('CONTENT_ALREADY_COVERED'), true);
      assert.equal(result.resourceRecommendation.actions.includes('CONTENT_REVIEW_CANDIDATE'), false);
    });
    for (const status of ['POSSIBLE', 'UNRESOLVED', 'MERGED']) await test(`duplicate content status ${status} prevents experiment`, () => {
      const source = structuredClone(base); source.product.duplicateStatus = status;
      const result = evaluateOpportunity(inputFor(source)); assert.equal(result.contentOpportunityScore, 0); assert.equal(result.experimentEligibility.state, 'NOT_ELIGIBLE'); assert.equal(result.riskCodes.includes('DUPLICATE_CONTENT_RISK'), true);
    });
    await test('merchant reputation, money cost, search demand remain explicitly unknown', () => {
      assert.deepEqual(caseA.merchantTrust, { state: 'UNKNOWN', basis: 'INSUFFICIENT_MERCHANT_HISTORY' }); assert.equal(caseA.resourceRecommendation.cost, 'UNKNOWN');
      assert.equal(caseA.competitionEvidenceScore, null); assert.equal(caseA.providerTrustBasis, 'CURRENT_PROVIDER_HEALTH_ONLY');
    });
    for (const [name, mutate, expectedRisk] of [
      ['stale price', source => source.product.priceObservedAt = new Date(source.now - 4 * 86400000).toISOString(), 'STALE_PRICE'],
      ['expired offer', source => { for (const offer of source.product.offers) if (offer.monetization) offer.monetization.validUntil = new Date(source.now - 1).toISOString(); }, 'NO_SAFE_MONEY_ROUTE'],
      ['provider unavailable', source => { for (const row of source.providers) { row.health.ready = false; row.health.state = 'DISABLED'; row.health.enabled = false; } }, 'PROVIDER_UNAVAILABLE'],
      ['provider degraded', source => { for (const row of source.providers) { row.health.ready = false; row.health.state = 'DEGRADED'; } }, 'PROVIDER_DEGRADED'],
      ['no money route', source => source.product.offers = [], 'NO_SAFE_MONEY_ROUTE'],
      ['publication denied', source => source.product.publicHidden = true, 'PUBLICATION_BLOCKED'],
    ]) await test(`${name} cannot become an experiment`, () => {
      const source = structuredClone(base); mutate(source); const result = evaluateOpportunity(inputFor(source));
      assert.equal(result.riskCodes.includes(expectedRisk), true); assert.equal(result.experimentEligibility.state, 'NOT_ELIGIBLE');
    });
    await test('staler evidence never improves freshness contribution', () => {
      const source = structuredClone(base); source.product.priceObservedAt = new Date(source.now - 4 * 86400000).toISOString();
      const older = evaluateOpportunity(inputFor(source)); assert.equal(older.freshnessScore <= caseA.freshnessScore, true);
      assert.equal(older.signals.find(signal => signal.code === 'freshness').contribution <= caseA.signals.find(signal => signal.code === 'freshness').contribution, true);
    });
    await test('future deal timestamp is rejected', () => { const input = structuredClone(excellent); input.deal.evaluatedAt = new Date(base.now + 1).toISOString(); assert.throws(() => evaluateOpportunity(input), /OPPORTUNITY_FUTURE_OR_INVALID_TIME/); });
    await test('expired decision produces blocked opportunity without resource use', () => {
      const input = structuredClone(excellent); input.decision.validUntil = input.context.validUntil = base.now;
      const result = evaluateOpportunity(input); assert.equal(result.opportunityPriority, 'BLOCKED'); assert.equal(result.validUntil, base.now);
    });
    await test('forged ALLOW policy cannot override authoritative context', () => {
      const input = inputFor(strong, {}, { securityRisk: true }); input.decision.policy.outcome = 'ALLOW'; assert.throws(() => evaluateOpportunity(input), /OPPORTUNITY_EVIDENCE_MISMATCH/);
    });
    await test('AI advice, legacy product opportunity and legacy deal score do not control V6 scores', () => {
      const input = structuredClone(excellent); input.source.product.opportunityScore = 1000000; input.source.product.dealScore = -50;
      input.decision.ai.advice = { recommendedAction: 'MARK_HIGH_PRIORITY', confidence: 1, summary: 'Synthetic malicious advice' };
      const result = evaluateOpportunity(input); assert.deepEqual(result, caseA); assert.equal(result.resourceRecommendation.actions.includes('AI_REVIEW_CANDIDATE'), false);
    });
    const spec = specFor(base.product.id, base.now), experiment = experimentFor(spec);
    await test('experiment A deterministic 50/50 assignment is stable across retries and order', () => {
      const first = Array.from({ length: 1000 }, (_, index) => assignVariant(experiment, `subject-${index}`));
      const again = Array.from({ length: 1000 }, (_, index) => assignVariant({ ...experiment, variants: [...experiment.variants].reverse() }, `subject-${index}`));
      assert.deepEqual(first, again); assert.equal(first.includes('A'), true); assert.equal(first.includes('B'), true);
      proofs.assignmentFixture = { subjects: first.length, A: first.filter(variant => variant === 'A').length, B: first.filter(variant => variant === 'B').length };
    });
    for (const [name, change] of [
      ['B weights do not sum', { variants: [{ id: 'A', weight: 4000 }, { id: 'B', weight: 4000 }] }],
      ['zero variants', { variants: [] }], ['one variant', { variants: [{ id: 'A', weight: 10000 }] }],
      ['duplicate variants', { variants: [{ id: 'A', weight: 5000 }, { id: 'A', weight: 5000 }] }],
      ['negative weights', { variants: [{ id: 'A', weight: -5000 }, { id: 'B', weight: 15000 }] }],
      ['fractional weights', { variants: [{ id: 'A', weight: 5000.5 }, { id: 'B', weight: 4999.5 }] }],
      ['NaN weights', { variants: [{ id: 'A', weight: NaN }, { id: 'B', weight: 5000 }] }],
      ['unknown type', { type: 'PRICE_MANIPULATION' }], ['unsupported metric', { primaryMetric: 'FAKE_RPM' }],
      ['insufficient minimum sample', { minimumSubjectsPerVariant: 1 }], ['zero minimum runtime', { minimumRuntimeMs: 0 }],
      ['expired definition', { expiresAt: base.now - 1 }], ['infinite timestamp', { startsAt: Infinity }], ['unapproved fields', { destination: 'unsafe' }],
    ]) await test(`experiment ${name} is rejected`, () => assert.throws(() => validateExperiment({ ...spec, ...change })));
    await test('all six permitted experiment types are modeled without prices or destinations', () => {
      assert.deepEqual(EXPERIMENT_TYPES, ['TITLE_VARIANT', 'CTA_VARIANT', 'DEAL_BADGE_VARIANT', 'CARD_LAYOUT_VARIANT', 'SORT_PRIORITY_VARIANT', 'CONTENT_ANGLE_VARIANT']);
      for (const type of EXPERIMENT_TYPES) validateExperiment({ ...spec, type }); assert.deepEqual(EXPERIMENT_METRICS, ['CLICK', 'CONVERSION']);
    });
    for (const state of EXPERIMENT_STATES) await test(`ACTIVE cannot be entered from ${state}`, () => assert.throws(() => validateTransition(state, 'ACTIVE'), /EXPERIMENT_TRANSITION_REJECTED/));
    await test('experiment E raw count leader with insufficient evidence is INCONCLUSIVE, never winner', () => {
      const result = summarizeExperiment(experiment, [{ variantId: 'A', subjects: 8, clicks: 7, conversions: 1, revenue: 'UNKNOWN' }, { variantId: 'B', subjects: 8, clicks: 0, conversions: 0, revenue: 'UNKNOWN' }], base.now + 600000);
      assert.equal(result.outcome, 'INCONCLUSIVE'); assert.equal(result.winner, null); assert.equal(result.sampleSize, 16); assert.equal(result.statisticalSignificance, 'NOT_IMPLEMENTED');
    });
    const evidence = [{ variantId: 'A', subjects: 20, clicks: 10, conversions: 5, revenue: 'UNKNOWN' }, { variantId: 'B', subjects: 20, clicks: 6, conversions: 5, revenue: 'UNKNOWN' }];
    await test('minimum runtime and explicit completion prevent continuous auto-winner', () => {
      for (const offset of [0, 59999, 60000, 599999]) assert.equal(summarizeExperiment(experiment, evidence, base.now + offset).outcome, 'INCONCLUSIVE');
      const complete = summarizeExperiment(experiment, evidence, experiment.expiresAt); assert.equal(complete.outcome, 'SUFFICIENT_EVIDENCE'); assert.equal(complete.winner, null); assert.equal(complete.productionRolloutAllowed, false);
    });
    await test('impossible sample totals and contradictory variant summaries fail closed', () => {
      assert.throws(() => summarizeExperiment(experiment, [{ ...evidence[0], clicks: 21 }, evidence[1]], base.now));
      assert.throws(() => summarizeExperiment(experiment, [evidence[0], evidence[0]], base.now));
    });
  });
  await integrated('D1 latest opportunity is atomic, idempotent and leaves deal/product untouched', async fixture => {
    const before = await fixture.db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first();
    const dealBefore = await fixture.db.prepare('SELECT payload FROM deal_evaluations WHERE origin=? AND product_id=?').bind('TEST_FIXTURE', fixture.product.id).first();
    const repeated = await fixture.opportunities.evaluate(fixture.product.id, fixture.source.allowedHosts, fixture.now);
    assert.deepEqual(repeated, fixture.opportunity); assert.equal(await count(fixture.db, 'opportunity_evaluations'), 1); assert.equal(await count(fixture.db, 'decision_records'), 1);
    assert.deepEqual(await fixture.db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first(), before);
    assert.deepEqual(await fixture.db.prepare('SELECT payload FROM deal_evaluations WHERE origin=? AND product_id=?').bind('TEST_FIXTURE', fixture.product.id).first(), dealBefore);
    assert.deepEqual(await fixture.opportunities.latest(fixture.product.id, fixture.now), repeated);
  });
  await integrated('ranking and observability use bounded indexed candidate pages', async fixture => {
    const filters = ['TOP', 'NEW', 'LOW_CONFIDENCE', 'CONTENT', 'EXPERIMENT', 'REFRESH', 'REVIEW', 'BLOCKED', 'STALE'].map(kind => ({ kind }));
    filters.push({ kind: 'PRIORITY', priority: 'P1' }, { kind: 'PROVIDER', provider: 'accesstrade' }, { kind: 'PROVIDER', provider: 'accesstrade', platform: 'shopee' });
    for (const filter of filters) {
      const query = fixture.opportunities.rankingQuery(filter, 5, fixture.now);
      await queryPlan(fixture.db, query.sql, query.values);
      const page = await fixture.opportunities.rank(filter, 5, fixture.now); assert.equal(page.inspected <= 5, true); assert.equal(page.partialPagePossible, true);
    }
    assert.equal((await fixture.opportunities.summary(5, fixture.now)).evaluated, 1);
    for (const limit of [0, -1, 51, Infinity, NaN]) assert.throws(() => fixture.opportunities.rankingQuery({ kind: 'TOP' }, limit, fixture.now), /OPPORTUNITY_QUERY_BOUND/);
    await queryPlan(fixture.db, 'SELECT product_id FROM deal_work WHERE due_at<=? ORDER BY due_at,product_id LIMIT ?', [fixture.now, 10]);
  });
  await integrated('content/source change invalidates current opportunity and recomputes one product', async fixture => {
    const previous = await fixture.adapter.domain.getProduct(fixture.product.id);
    await fixture.adapter.domain.replaceProduct({ ...previous.value, duplicateStatus: 'POSSIBLE' }, previous.version);
    assert.equal(await fixture.opportunities.latest(fixture.product.id, fixture.now), null);
    const changed = await fixture.opportunities.evaluate(fixture.product.id, fixture.source.allowedHosts, fixture.now);
    assert.notEqual(changed.evidenceFingerprint, fixture.opportunity.evidenceFingerprint); assert.equal(changed.experimentEligibility.state, 'NOT_ELIGIBLE');
    assert.equal(await count(fixture.db, 'opportunity_evaluations'), 1);
  });
  await integrated('provider health change invalidates opportunity before provider fanout', async fixture => {
    const observation = (await fixture.money.providers())[0]; observation.health.ready = false; observation.health.state = 'DEGRADED';
    await fixture.money.observeProvider(observation); assert.equal(await fixture.opportunities.latest(fixture.product.id, fixture.now), null);
  });
  await integrated('missing D1, Queue, phase prerequisites and production flags fail closed', async fixture => {
    for (const changes of [{ DB: undefined }, { JOB_QUEUE: undefined }, { SANDEAL_PRODUCTION: 'true' }, { SANDEAL_LOCAL_ONLY: 'false' },
      { SANDEAL_DECISION_OS_ENABLED: 'false' }, { SANDEAL_DEAL_INTELLIGENCE_ENABLED: 'false' }, { SANDEAL_OPPORTUNITY_ENABLED: 'invalid' }])
      assert.throws(() => cloudflareOpportunityStore({ ...fixture.env, ...changes }, fixture.db, fixture.decisions, true), /OPPORTUNITY_RUNTIME_FAIL_CLOSED/);
    const broken = { prepare() { throw new Error('offline'); }, batch() { throw new Error('offline'); } };
    await assert.rejects(new D1OpportunityStore(broken, fixture.decisions, true).latest(fixture.product.id, fixture.now), /D1_OPPORTUNITY_UNAVAILABLE/);
    assert.throws(() => new D1OpportunityStore(null, fixture.decisions, true), /OPPORTUNITY_SHADOW_DEPENDENCY_REQUIRED/);
  });
  await integrated('AI cost governor is reused disabled, never bypassed with live AI', async fixture => {
    const configured = new D1DecisionStore(fixture.db, constraints, true, { ...DECISION_CONFIG, ai: { ...DECISION_CONFIG.ai, enabled: true } });
    assert.throws(() => new D1OpportunityStore(fixture.db, configured, true), /OPPORTUNITY_SHADOW_DEPENDENCY_REQUIRED/);
    assert.equal(await count(fixture.db, 'decision_ai_budget'), 0); assert.equal(await count(fixture.db, 'decision_ai_advice'), 0);
  });
  await integrated('missing product/deal and algorithm version change never reuse obsolete scores', async fixture => {
    await assert.rejects(fixture.opportunities.evaluate('missing-product', fixture.source.allowedHosts, fixture.now), /DEAL_PRODUCT_NOT_FOUND/);
    const next = new D1OpportunityStore(fixture.db, fixture.decisions, true, { ...OPPORTUNITY_CONFIG, algorithmVersion: 'opportunity-engine-v2' });
    assert.equal(await next.latest(fixture.product.id, fixture.now), null); const result = await next.evaluate(fixture.product.id, fixture.source.allowedHosts, fixture.now);
    assert.equal(result.algorithmVersion, 'opportunity-engine-v2'); assert.notEqual(result.evidenceFingerprint, fixture.opportunity.evidenceFingerprint);
  });
  await integrated('atomic opportunity insertion failure rolls back decision and job completion', async fixture => {
    const stored = await fixture.adapter.domain.getProduct(fixture.product.id);
    await fixture.adapter.domain.replaceProduct({ ...stored.value, contentPackageStatus: 'none' }, stored.version);
    await fixture.db.prepare("CREATE TRIGGER fixture_fail_opportunity BEFORE UPDATE ON opportunity_evaluations BEGIN SELECT RAISE(ABORT,'FIXTURE_FAILURE'); END").run();
    const before = await count(fixture.db, 'decision_records');
    await assert.rejects(fixture.opportunities.evaluate(fixture.product.id, fixture.source.allowedHosts, fixture.now), /D1_DEAL_COMMIT_RETRY/);
    assert.equal(await count(fixture.db, 'decision_records'), before); assert.equal(await count(fixture.db, 'opportunity_evaluations'), 1);
  });
  await integrated('Queue redelivery and lost acknowledgment have zero duplicate resource effect', async fixture => {
    const jobs = new D1JobStore(fixture.db), input = { type: 'DEAL_EVALUATE', payload: { productId: fixture.product.id }, idempotencyKey: 'opportunity-queue-fixture' };
    const job = (await jobs.createJob(input, fixture.now)).job, body = makeMessage(job);
    await assert.rejects(consumeDelivery(delivery(body), fixture.env, { now: () => fixture.now, moneyTestOnly: true, afterCommit: async () => { throw new Error('ACK_LOST'); } }), /ACK_LOST/);
    const repeated = delivery(body); assert.equal(await consumeDelivery(repeated, fixture.env, { now: () => fixture.now, moneyTestOnly: true }), 'DUPLICATE_SAFE');
    assert.equal(repeated.ackCount, 1); assert.equal((await jobs.get(job.id)).status, 'SUCCEEDED'); assert.equal(await count(fixture.db, 'opportunity_evaluations'), 1);
  });
  await integrated('Cron materializes one bounded opportunity recomputation via existing deal job', async fixture => {
    const product = await fixture.adapter.domain.getProduct(fixture.product.id);
    await fixture.adapter.domain.replaceProduct({ ...product.value, contentPackageStatus: 'none' }, product.version);
    const scheduler = createCloudflareSchedulerAdapter(fixture.env);
    await scheduler.tick(fixture.now); await scheduler.tick(fixture.now);
    assert.equal(fixture.sent.length, 1); assert.equal(fixture.sent[0].jobType, 'DEAL_EVALUATE');
    assert.equal(await consumeDelivery(delivery(fixture.sent[0]), fixture.env, { now: () => fixture.now, moneyTestOnly: true }), 'SUCCEEDED');
    assert.notEqual((await fixture.opportunities.latest(fixture.product.id, fixture.now)).evidenceFingerprint, fixture.opportunity.evidenceFingerprint);
    assert.equal(await count(fixture.db, 'opportunity_evaluations'), 1);
  });
  await integrated('provider/product CAS race rejects stale opportunity commit', async fixture => {
    const prepared = await fixture.store.prepare(fixture.product.id, fixture.source.allowedHosts, fixture.now), decision = await fixture.decisions.prepare(prepared);
    const opportunity = fixture.opportunities.prepare(prepared, decision), stored = await fixture.adapter.domain.getProduct(fixture.product.id);
    await fixture.adapter.domain.replaceProduct({ ...stored.value, publicHidden: true }, stored.version);
    await assert.rejects(fixture.opportunities.commit(prepared, decision, opportunity, fixture.now), /D1_DEAL_COMMIT_RETRY/);
    assert.equal(await fixture.opportunities.latest(fixture.product.id, fixture.now), null);
  });
  await integrated('experiment lifecycle and duplicate assignment D have one durable enrollment', async fixture => {
    const experiment = await fixture.shadow();
    const first = await fixture.experiments.assign(experiment.experimentId, 'local-subject', fixture.now);
    const repeated = await fixture.experiments.assign(experiment.experimentId, 'local-subject', fixture.now + 1);
    assert.deepEqual(first, repeated); assert.equal(await count(fixture.db, 'experiment_assignments'), 1);
    const summary = await fixture.experiments.summary(experiment.experimentId, fixture.now); assert.equal(summary.sampleSize, 1); assert.equal(summary.exposureCount, 1); assert.equal(summary.outcome, 'INCONCLUSIVE');
    assert.equal((await fixture.experiments.observability('SHADOW', 5, fixture.now)).shadowAssignments, 1);
    await assert.rejects(fixture.experiments.transition(experiment.experimentId, 'ACTIVE', fixture.now), /EXPERIMENT_TRANSITION_REJECTED/);
    await assert.rejects(fixture.db.prepare("UPDATE experiments SET state='ACTIVE' WHERE id=?").bind(experiment.experimentId).run(), /CHECK constraint failed/);
    assert.equal((await fixture.db.prepare("SELECT count(*) AS count FROM experiments WHERE state='ACTIVE'").first()).count, 0);
  });
  await integrated('experiment C blocked subject, stale evidence and expiry reject new assignments', async fixture => {
    const experiment = await fixture.shadow();
    await assert.rejects(fixture.experiments.assign(experiment.experimentId, 'expired', experiment.expiresAt), /EXPERIMENT_NOT_SHADOW_OR_EXPIRED/);
    const stored = await fixture.adapter.domain.getProduct(fixture.product.id);
    await fixture.adapter.domain.replaceProduct({ ...stored.value, riskLevel: 'high' }, stored.version);
    await assert.rejects(fixture.experiments.assign(experiment.experimentId, 'blocked', fixture.now), /EXPERIMENT_POLICY_INELIGIBLE/);
    await assert.rejects(fixture.experiments.create(specFor(fixture.product.id, fixture.now, { version: 2 }), fixture.now), /EXPERIMENT_POLICY_INELIGIBLE/);
    assert.equal(await count(fixture.db, 'experiment_assignments'), 0);
  });
  await integrated('experiment version immutability and conflicting shadow experiments are enforced', async fixture => {
    const experiment = await fixture.shadow();
    await assert.rejects(fixture.experiments.create(specFor(fixture.product.id, fixture.now, { variants: [{ id: 'A', weight: 4000 }, { id: 'B', weight: 6000 }] }), fixture.now), /EXPERIMENT_VERSION_IMMUTABLE/);
    const second = await fixture.experiments.create(specFor(fixture.product.id, fixture.now, { version: 2 }), fixture.now);
    await fixture.experiments.transition(second.experimentId, 'ELIGIBLE', fixture.now);
    await assert.rejects(fixture.experiments.transition(second.experimentId, 'SHADOW', fixture.now), /EXPERIMENT_ATOMIC_CONFLICT/);
    await assert.rejects(fixture.db.prepare("UPDATE experiment_variants SET weight=1 WHERE experiment_id=? AND id='A'").bind(experiment.experimentId).run(), /IMMUTABLE_EXPERIMENT_VARIANT/);
    await assert.rejects(fixture.db.prepare("UPDATE experiments SET expires_at=expires_at+1 WHERE id=?").bind(experiment.experimentId).run(), /IMMUTABLE_EXPERIMENT_DEFINITION/);
  });
  await integrated('parallel assignment redelivery enrolls a subject exactly once', async fixture => {
    const experiment = await fixture.shadow();
    const results = await Promise.all(Array.from({ length: 5 }, () => fixture.experiments.assign(experiment.experimentId, 'parallel-subject', fixture.now)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal((await fixture.experiments.summary(experiment.experimentId, fixture.now)).sampleSize, 1);
    assert.equal(await count(fixture.db, 'experiment_assignments'), 1);
    const replay = await fixture.experiments.create(specFor(fixture.product.id, fixture.now), fixture.now + 1);
    assert.equal(replay.experimentId, experiment.experimentId); assert.equal(await count(fixture.db, 'experiments'), 1);
  });
  await integrated('paused and review-state experiments cannot enroll or prematurely complete', async fixture => {
    const experiment = await fixture.shadow();
    await fixture.experiments.transition(experiment.experimentId, 'PAUSED', fixture.now);
    await assert.rejects(fixture.experiments.assign(experiment.experimentId, 'paused-subject', fixture.now), /EXPERIMENT_NOT_SHADOW_OR_EXPIRED/);
    await fixture.experiments.transition(experiment.experimentId, 'SHADOW', fixture.now);
    await fixture.experiments.transition(experiment.experimentId, 'READY_FOR_REVIEW', fixture.now);
    await assert.rejects(fixture.experiments.transition(experiment.experimentId, 'COMPLETED', fixture.now), /EXPERIMENT_COMPLETION_INSUFFICIENT/);
    assert.equal(await count(fixture.db, 'experiment_assignments'), 0);
  });
  await integrated('assignment failure rolls back both enrollment and exposure counters', async fixture => {
    const experiment = await fixture.shadow();
    await fixture.db.prepare("CREATE TRIGGER fixture_fail_assignment AFTER INSERT ON experiment_assignments BEGIN SELECT RAISE(ABORT,'FIXTURE_ASSIGNMENT_FAILURE'); END").run();
    await assert.rejects(fixture.experiments.assign(experiment.experimentId, 'rollback-subject', fixture.now), /EXPERIMENT_ATOMIC_CONFLICT/);
    assert.equal(await count(fixture.db, 'experiment_assignments'), 0); assert.equal((await fixture.experiments.summary(experiment.experimentId, fixture.now)).sampleSize, 0);
  });
  await integrated('assignment and metric mutations are unavailable without explicit fixture injection', async fixture => {
    const experiment = await fixture.shadow(), production = new D1ExperimentStore(fixture.db, fixture.opportunities);
    await assert.rejects(production.assign(experiment.experimentId, 'real-subject', fixture.now), /EXPERIMENT_ASSIGNMENTS_FIXTURE_ONLY/);
    await assert.rejects(production.recordMetric(experiment.experimentId, 'real-subject', 'CLICK', 'click:real-subject', fixture.now), /EXPERIMENT_ASSIGNMENTS_FIXTURE_ONLY/);
    assert.equal(await production.get(experiment.experimentId), null);
  });
  await integrated('verified fixture click/conversion IDs deduplicate metrics transactionally', async fixture => {
    const experiment = await fixture.shadow(), subject = 'fixture-click-subject';
    await fixture.experiments.assign(experiment.experimentId, subject, fixture.now);
    const product = await fixture.adapter.domain.getProduct(fixture.product.id), offer = product.value.offers.find(item => item.monetization?.provider === 'accesstrade').monetization;
    const click = { id: subject, productId: product.value.id, offerId: offer.id, provider: offer.provider, platform: offer.platform, merchantId: offer.merchant.id, campaignId: offer.campaign.id,
      currency: 'VND', createdAt: new Date(fixture.now + 1).toISOString(), attribution: { reference: subject, transport: 'PROVIDER_SUB1' }, context: 'DEAL', destinationHash: dealFingerprint(offer.id), origin: 'TEST_FIXTURE' };
    await fixture.money.recordClick(click, product.version.token);
    const first = await fixture.experiments.recordMetric(experiment.experimentId, subject, 'CLICK', `click:${subject}`, fixture.now + 2);
    const duplicate = await fixture.experiments.recordMetric(experiment.experimentId, subject, 'CLICK', `click:${subject}`, fixture.now + 2);
    assert.deepEqual(first, { status: 'APPLIED', effect: 1 }); assert.deepEqual(duplicate, { status: 'DUPLICATE', effect: 0 });
    await assert.rejects(fixture.experiments.recordMetric(experiment.experimentId, subject, 'CLICK', `click:${subject}`, fixture.now), /EXPERIMENT_METRIC_SOURCE_INVALID/);
    await fixture.evidence(click);
    const conversion = await fixture.db.prepare('SELECT occurred_at FROM affiliate_conversions WHERE provider=? AND external_id=?').bind('accesstrade', 'fixture-order').first();
    const conversionTime = Date.parse(conversion.occurred_at);
    assert.equal(await fixture.opportunities.latest(fixture.product.id, conversionTime), null);
    await fixture.opportunities.evaluate(fixture.product.id, fixture.source.allowedHosts, conversionTime);
    assert.deepEqual(await fixture.experiments.recordMetric(experiment.experimentId, subject, 'CONVERSION', 'conversion:accesstrade:fixture-order', conversionTime), { status: 'APPLIED', effect: 1 });
    assert.deepEqual(await fixture.experiments.recordMetric(experiment.experimentId, subject, 'CONVERSION', 'conversion:accesstrade:fixture-order', conversionTime), { status: 'DUPLICATE', effect: 0 });
    const summary = await fixture.experiments.summary(experiment.experimentId, conversionTime);
    assert.equal(summary.variants.reduce((total, variant) => total + variant.clicks, 0), 1); assert.equal(summary.variants.reduce((total, variant) => total + variant.conversions, 0), 1);
    assert.equal(summary.outcome, 'INCONCLUSIVE'); assert.equal(summary.winner, null); assert.equal(await count(fixture.db, 'experiment_metric_events'), 2);
    await assert.rejects(fixture.experiments.recordMetric(experiment.experimentId, subject, 'REVENUE', 'invented', conversionTime), /EXPERIMENT_METRIC_UNSUPPORTED/);
    await assert.rejects(fixture.experiments.recordMetric(experiment.experimentId, subject, 'CLICK', 'click:invented', conversionTime), /EXPERIMENT_METRIC_SOURCE_INVALID/);
    await assert.rejects(fixture.experiments.recordMetric(experiment.experimentId, 'another-subject', 'CONVERSION', 'conversion:accesstrade:fixture-order', conversionTime), /EXPERIMENT_METRIC_SUBJECT_MISMATCH/);
    await fixture.experiments.cleanup(experiment.expiresAt + EXPERIMENT_LIMITS.retentionMs + 1);
    assert.equal(await count(fixture.db, 'experiment_metric_events'), 0); assert.equal(await count(fixture.db, 'experiment_assignments'), 0);
    assert.equal((await fixture.experiments.summary(experiment.experimentId, experiment.expiresAt)).sampleSize, 1);
    await assert.rejects(fixture.experiments.recordMetric(experiment.experimentId, subject, 'CLICK', `click:${subject}`, experiment.expiresAt + EXPERIMENT_LIMITS.retentionMs + 1), /EXPERIMENT_NOT_SHADOW_OR_EXPIRED/);
  });
  await integrated('experiment assignment, metrics and retention EXPLAIN plans are indexed', async fixture => {
    for (const [sql, values] of [
      ['SELECT id FROM experiments WHERE origin=? AND state=? ORDER BY expires_at,id LIMIT ?', ['TEST_FIXTURE', 'SHADOW', 10]],
      ['SELECT fingerprint FROM experiments WHERE origin=? AND product_id=? AND experiment_type=? AND version=? LIMIT 1', ['TEST_FIXTURE', fixture.product.id, 'TITLE_VARIANT', 1]],
      ['SELECT variant_id FROM experiment_assignments WHERE experiment_id=? AND subject_key=? LIMIT 1', ['unknown', 'unknown']],
      ['SELECT metric FROM experiment_metric_events WHERE experiment_id=? AND event_key=? LIMIT 1', ['unknown', 'unknown']],
      ['SELECT id,subjects FROM experiment_variants WHERE experiment_id=? ORDER BY id LIMIT ?', ['unknown', 8]],
      ['SELECT effect_key FROM affiliate_money_events WHERE effect_key=? LIMIT 1', ['unknown']],
      ['SELECT experiment_id,event_key FROM experiment_metric_events WHERE retain_until<? ORDER BY retain_until,experiment_id,event_key LIMIT ?', [fixture.now, 10]],
      ['SELECT experiment_id,subject_key FROM experiment_assignments WHERE retain_until<? ORDER BY retain_until,experiment_id,subject_key LIMIT ?', [fixture.now, 10]],
    ]) await queryPlan(fixture.db, sql, values);
  });
  await integrated('bounded ranking excludes blocked score leaders before selecting the top page', async fixture => {
    const { cloudflareProduct } = load('./fixtures/v6-cloudflare-product.cjs');
    const product = cloudflareProduct('blocked-leader', { riskLevel: 'high', createdAt: new Date(fixture.now).toISOString(), updatedAt: new Date(fixture.now).toISOString() });
    await fixture.adapter.domain.createProduct(product);
    await fixture.opportunities.evaluate(product.id, fixture.source.allowedHosts, fixture.now);
    await fixture.db.prepare("UPDATE opportunity_evaluations SET score=100 WHERE product_id='blocked-leader'").run();
    const page = await fixture.opportunities.rank({ kind: 'TOP' }, 1, fixture.now);
    assert.equal(page.inspected, 1); assert.equal(page.data.length, 1); assert.equal(page.data[0].productId, fixture.product.id);
  });
  await test('G AccessTrade Shopee keeps provider/platform provenance with direct Shopee disabled', () => dealFixture(async fixture => {
    const shopee = await fixture.seedShopee(), product = { ...shopee.product, price: 1600000, offers: verifiedPublicOffers(shopee.product.offers) };
    for (const offer of product.offers) if (offer.monetization) { offer.monetization.validUntil = new Date(fixture.now + 28800000).toISOString(); offer.expiresAt = offer.monetization.validUntil; }
    const input = inputFor({ ...fixture.input, product, providers: await fixture.money.providers(), allowedHosts: shopee.allowedHosts });
    const record = evaluateOpportunity(input); assert.equal(record.provider, 'accesstrade'); assert.equal(record.platform, 'shopee');
    assert.equal(record.providerTrust, 'TRUST_HIGH'); assert.equal(record.opportunityPriority, 'P1'); assert.equal(record.reasonCodes.includes('ACCESS_TRADE_SHOPEE_VALID'), true);
    assert.equal((await fixture.shopee.healthCheck()).state, 'DISABLED_NO_CREDENTIALS'); assert.equal(directShopeeCalls, 0);
  }));
  await integrated('supported opportunity paths make zero FileStorage/settings calls', async fixture => {
    const originals = new Map(), descriptors = new Map(); let fileCalls = 0, filesystemCalls = 0;
    for (const method of ['readFile', 'writeFile', 'mkdir', 'rename', 'open', 'stat', 'access', 'readdir', 'unlink', 'rm']) {
      originals.set(method, fs.promises[method]); fs.promises[method] = async () => { filesystemCalls++; throw new Error('FILESYSTEM_FORBIDDEN'); };
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fileStorageAdapter))) {
      if (typeof descriptor.value !== 'function' && !descriptor.get) continue;
      descriptors.set(key, descriptor); Object.defineProperty(fileStorageAdapter, key, { configurable: true, get() { fileCalls++; throw new Error('FILE_STORAGE_FORBIDDEN'); } });
    }
    try {
      await fixture.opportunities.evaluate(fixture.product.id, fixture.source.allowedHosts, fixture.now);
      await fixture.opportunities.rank({ kind: 'TOP' }, 5, fixture.now);
      const experiment = await fixture.shadow(); await fixture.experiments.assign(experiment.experimentId, 'filesystem-fixture', fixture.now);
      assert.equal((await fixture.experiments.summary(experiment.experimentId, fixture.now)).sampleSize, 1);
    } finally { for (const [method, original] of originals) fs.promises[method] = original; for (const [key, descriptor] of descriptors) Object.defineProperty(fileStorageAdapter, key, descriptor); }
    assert.equal(fileCalls, 0); assert.equal(filesystemCalls, 0); assert.equal(fixture.runtime.built.fileStorageModules, 0); assert.equal(fixture.runtime.built.filesystemSettingsModules, 0);
  });
  await test('native local Worker Cron/Queue creates only blocked shadow opportunity from fixture money', () => dealFixture(async fixture => {
    const { openWorker } = load('./lib/cloudflare-local.cjs'), { createD1StorageAdapter } = load('../src/lib/storage/d1/d1StorageAdapter.ts');
    const runtime = await openWorker({ queue: true, bindings: { SANDEAL_AUTOPILOT_ENABLED: 'true', SANDEAL_DEAL_INTELLIGENCE_ENABLED: 'true', SANDEAL_DECISION_OS_ENABLED: 'true', SANDEAL_OPPORTUNITY_ENABLED: 'true', AFFILIATE_REDIRECT_HOSTS: 'merchant.example' } });
    try {
      await createD1StorageAdapter(runtime.db).domain.createProduct(fixture.product);
      const before = await runtime.db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first(), worker = await runtime.mf.getWorker();
      assert.equal((await worker.scheduled({ scheduledTime: new Date(fixture.now), cron: '*/5 * * * *' })).outcome, 'ok');
      let row = null;
      for (let attempt = 0; attempt < 100; attempt++) { row = await runtime.db.prepare('SELECT payload FROM opportunity_evaluations WHERE product_id=? LIMIT 1').bind(fixture.product.id).first(); if (row) break; await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.notEqual(row, null); const record = JSON.parse(row.payload); assert.equal(record.opportunityPriority, 'BLOCKED'); assert.equal(record.executionMode, 'SHADOW');
      assert.equal(record.experimentEligibility.state, 'NOT_ELIGIBLE'); assert.equal(record.experimentProposal, null); assert.equal(await count(runtime.db, 'experiment_assignments'), 0);
      const jobRow = await runtime.db.prepare("SELECT id FROM automation_jobs WHERE status='SUCCEEDED' LIMIT 1").first(); assert.notEqual(jobRow, null);
      const job = await new D1JobStore(runtime.db).get(jobRow.id);
      const repeated = await worker.queue('sandeal-local-jobs', [{ id: 'opportunity-native-duplicate', timestamp: new Date(), attempts: 1, body: makeMessage(job) }]);
      assert.deepEqual(repeated.explicitAcks, ['opportunity-native-duplicate']); assert.equal(await count(runtime.db, 'opportunity_evaluations'), 1);
      assert.deepEqual(await runtime.db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first(), before);
    } finally { await runtime.dispose(); }
  }));
  await test('test integrity: no skipped/focused tests, random assignment, network, production executor or artificial SEO data', () => {
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    assert.equal(new RegExp('\\.' + '(?:skip|only)\\s*\\(|\\b(?:f' + 'it|fdescribe)\\s*\\(').test(source), false);
    for (const directory of ['src/lib/opportunity', 'src/lib/experiments']) for (const filename of fs.readdirSync(directory)) {
      const content = fs.readFileSync(path.join(directory, filename), 'utf8'); assert.equal(/Math\.random|fetch\(|setInterval|while\s*\(\s*true|process\.env|searchVolume|keywordDifficulty/.test(content), false);
    }
    assert.equal(directShopeeCalls, 0);
  });
}
try { await main(); } catch (error) { cases.push({ name: 'setup', status: 'FAIL', message: String(error.message) }); console.error('FAIL setup', error); }
for (const [method, original] of directMethods) ShopeeAffiliateProvider.prototype[method] = original;
const passed = cases.filter(item => item.status === 'PASS').length, failed = cases.filter(item => item.status === 'FAIL').length;
const evidence = { phase: 'PHASE_7_5', generatedAt: new Date().toISOString(), passed, failed, skipped: 0, liveAiProbe: 'NOT_RUN', directShopeeCalls, proofs, cases };
fs.mkdirSync('.test-tmp/phase7-5', { recursive: true });
fs.writeFileSync('.test-tmp/phase7-5/focused-results.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(`V6 Opportunity and Experiments: ${passed} passed, ${failed} failed, 0 skipped`); process.exitCode = failed ? 1 : 0;
