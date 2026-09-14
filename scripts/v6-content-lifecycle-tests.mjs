import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);
load('./register-typescript.cjs');
const { dealFixture } = load('./fixtures/v6-deal-intelligence.cjs');
const { dealFingerprint } = load('../src/lib/deal-intelligence/evaluate.ts');
const { evaluateLifecycle, materialChanges, validateLifecycleTransition } = load('../src/lib/content/lifecycle/evaluate.ts');
const { LIFECYCLE_CONFIG, validateLifecycleConfig, valueWindow } = load('../src/lib/content/lifecycle/config.ts');
const { buildContentValue } = load('../src/lib/content/lifecycle/value.ts');
const { planContent } = load('../src/lib/content/planner.ts');
const { D1ContentLifecycleStore } = load('../src/lib/storage/d1/d1ContentLifecycleStore.ts');
const { D1ContentValueStore } = load('../src/lib/storage/d1/d1ContentValueStore.ts');
const { D1JobStore } = load('../src/lib/storage/d1/d1JobStore.ts');
const { D1DecisionStore } = load('../src/lib/storage/d1/d1DecisionStore.ts');
const { cloudflareDecisionStore } = load('../src/lib/runtime/cloudflare/decision.ts');
const { cloudflareOpportunityStore } = load('../src/lib/runtime/cloudflare/opportunity.ts');
const { cloudflareContentLifecycleStore, validateContentLifecycleRuntime } = load('../src/lib/runtime/cloudflare/contentLifecycle.ts');
const { createCloudflareSchedulerAdapter } = load('../src/lib/platform/cloudflareAdapters.ts');
const { consumeDelivery } = load('../src/lib/runtime/cloudflare/autopilot.ts');
const { makeMessage } = load('../src/lib/platform/cloudflareContracts.ts');
const { delivery } = load('./lib/cloudflare-autopilot-test.cjs');
const { moneyHash } = load('../src/lib/affiliate/money/validation.ts');
const { ShopeeAffiliateProvider } = load('../src/lib/affiliate/shopeeAffiliateProvider.ts');
const { fileStorageAdapter } = load('../src/lib/storage/fileStorageAdapter.ts');

const cases = [], proofs = {}, directMethods = new Map();
let directShopeeCalls = 0;
for (const method of ['discoverProducts', 'getProduct', 'getOffers', 'getPromotions', 'createTrackingLink', 'syncTransactions', 'syncCommissions']) {
  directMethods.set(method, ShopeeAffiliateProvider.prototype[method]);
  ShopeeAffiliateProvider.prototype[method] = async () => { directShopeeCalls++; throw new Error('DIRECT_SHOPEE_FORBIDDEN'); };
}
async function test(name, work) {
  try { await work(); cases.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, status: 'FAIL', error: String(error.message) }); console.error(`FAIL ${name}`, error); }
}
async function count(db, table) { return Number((await db.prepare(`SELECT count(*) AS total FROM ${table}`).first()).total); }
const clone = value => structuredClone(value);
function entityFor(product, now, suffix = 'primary') {
  return { id: `content-${suffix}`, type: 'PRODUCT_PAGE', intent: 'PRODUCT', lifecycle: 'PUBLISHED_EXISTING',
    canonicalTarget: { url: `/deals/${product.slug || product.id}`, entityId: product.id, entityType: 'PRODUCT' },
    createdAt: new Date(now - 86400000).toISOString(), updatedAt: new Date(now - 3600000).toISOString() };
}
function contentPlan(entity, opportunity) {
  return { ...planContent({ opportunityId: opportunity.opportunityId, opportunityFingerprint: opportunity.evidenceFingerprint, policyState: 'ALLOW',
    existingContent: [entity], candidateIntent: 'PRODUCT', candidateSlug: entity.canonicalTarget.url.split('/').at(-1),
    candidateCanonicalEntityId: entity.canonicalTarget.entityId, materialChangeDetected: false }), contentId: entity.id };
}
async function withLifecycle(work) {
  return dealFixture(async fixture => {
    for (const offer of fixture.product.offers) if (offer.monetization) {
      offer.monetization.validUntil = new Date(fixture.now + 8 * 3600000).toISOString(); offer.expiresAt = offer.monetization.validUntil;
    }
    await fixture.persist();
    const env = { ...fixture.env, SANDEAL_DECISION_OS_ENABLED: 'true', SANDEAL_OPPORTUNITY_ENABLED: 'true', SANDEAL_CONTENT_LIFECYCLE_ENABLED: 'true' };
    const decisions = cloudflareDecisionStore(env, fixture.db, true), opportunities = cloudflareOpportunityStore(env, fixture.db, decisions, true);
    const opportunity = await opportunities.evaluate(fixture.product.id, fixture.input.allowedHosts, fixture.now);
    const lifecycle = new D1ContentLifecycleStore(fixture.db, decisions, opportunities, fixture.input.allowedHosts, true);
    const entity = entityFor(fixture.product, fixture.now), plan = contentPlan(entity, opportunity);
    await lifecycle.register(entity, plan, fixture.now);
    await work({ ...fixture, env, decisions, opportunities, lifecycle, entity, plan, opportunity, jobs: new D1JobStore(fixture.db) });
  });
}
function validInput(prepared) {
  const input = clone(prepared.input), current = input.current;
  Object.assign(current, { policy: 'ALLOW', opportunityPriority: 'P2', opportunityFingerprint: dealFingerprint('fixture-opportunity'),
    routeSafe: true, destinationUnsafe: false, price: 1000000, priceState: 'FRESH', offerState: 'FRESH',
    providerHealth: 'AVAILABLE', contentConfidence: 0.9, coverage: 'ADEQUATE_COVERAGE', cannibalizationRisk: 'BLOCK_NEW_CONTENT',
    selectedOfferId: 'fixture-offer', provider: 'accesstrade', platform: 'shopee', dealScore: 80, dealConfidence: 0.9 });
  input.baseline = clone(current); input.contentPlan.action = 'NO_ACTION'; input.value = null;
  return input;
}
async function runPure() {
  await withLifecycle(async fixture => {
    const base = validInput(await fixture.lifecycle.prepare(fixture.entity.id, fixture.now));
    const evaluate = (change = {}) => evaluateLifecycle({ ...clone(base), ...change });
    await test('A unchanged evidence gives exact NO_ACTION and stable fingerprint', () => {
      const first = evaluate(), later = evaluate({ now: base.now + 10000 });
      assert.equal(first.plan.action, 'NO_ACTION'); assert.equal(first.eligibility, 'NOT_REQUIRED'); assert.equal(first.priority, 'NONE');
      assert.equal(first.evidenceFingerprint, later.evidenceFingerprint); assert.deepEqual(first.plan, later.plan);
    });
    await test('H old page alone cannot cause refresh or archive', () => {
      const input = clone(base); input.content.createdAt = '2001-01-01T00:00:00.000Z'; input.content.updatedAt = '2001-01-01T00:00:00.000Z';
      const result = evaluateLifecycle(input); assert.equal(result.plan.action, 'NO_ACTION'); assert.equal(result.materialChange, false);
    });
    await test('B material price change is MEDIUM eligible P2 refresh', () => {
      const result = evaluate({ current: { ...base.current, price: 900000 } });
      assert.equal(result.plan.action, 'REFRESH_CONTENT'); assert.equal(result.severity, 'MEDIUM'); assert.equal(result.priority, 'P2');
      assert.deepEqual(result.reasonCodes, ['PRICE_CHANGED']);
    });
    await test('C tiny price change below configured threshold has no effect', () => {
      const result = evaluate({ current: { ...base.current, price: 999000 } });
      assert.equal(result.plan.action, 'NO_ACTION'); assert.equal(result.materialChange, false);
    });
    await test('minor metadata-only change is LOW and never requires refresh', () => {
      const result = evaluate({ current: { ...base.current, contentFingerprint: dealFingerprint('metadata-only') } });
      assert.equal(result.severity, 'LOW'); assert.equal(result.materialChange, false); assert.equal(result.plan.action, 'NO_ACTION');
    });
    await test('price threshold exact boundary is material', () => assert.equal(evaluate({ current: { ...base.current, price: 970000 } }).plan.action, 'REFRESH_CONTENT'));
    await test('D K safe offer/provider change preserves canonical entity and URL', () => {
      const result = evaluate({ current: { ...base.current, selectedOfferId: 'fixture-offer-b', routeVersion: dealFingerprint('route-b') } });
      assert.equal(result.plan.action, 'REFRESH_CONTENT'); assert.equal(result.contentEntityId, base.content.id);
      assert.deepEqual(result.plan.brief.canonicalTarget, base.content.canonicalTarget); assert.equal(result.priority, 'P1');
    });
    for (const policy of ['BLOCK', 'QUARANTINE']) await test(`E ${policy} defeats high value and refresh`, () => {
      const input = clone(base); input.current.policy = policy; input.current.price = 800000;
      const result = evaluateLifecycle(input); assert.equal(result.plan.action, 'BLOCK'); assert.equal(result.state, 'BLOCKED');
      assert.equal(result.eligibility, 'BLOCKED'); assert.equal(result.plan.experimentProposal, null);
    });
    for (const policy of ['HOLD', 'ALLOW_WITH_REVIEW']) await test(`${policy} requires review and cannot refresh`, () => {
      const result = evaluate({ current: { ...base.current, policy, price: 800000 } });
      assert.equal(result.plan.action, 'HUMAN_REVIEW_REQUIRED'); assert.equal(result.eligibility, 'REVIEW_REQUIRED');
    });
    await test('F verified-value stale content outranks otherwise equivalent new content', () => {
      const start = Math.floor(base.now / LIFECYCLE_CONFIG.dayMs) * LIFECYCLE_CONFIG.dayMs;
      const value = buildContentValue(base.content.id, 'TEST_FIXTURE', start, base.now, base.now,
        [{ day: start, currency: 'VND', clicks: 20, conversions: 5, approvedMinor: 0, paidMinor: 25000, approvedCount: 0, paidCount: 5, commissionEvents: 5, sourceEvents: 30, lastSequence: 30 }]);
      assert.equal(value.businessValue, 'HIGH_VALUE');
      const current = { ...base.current, price: 900000 };
      assert.equal(evaluate({ current }).priority, 'P2'); assert.equal(evaluate({ current, value }).priority, 'P1');
      assert.equal(evaluate({ current: { ...current, policy: 'BLOCK' }, value }).plan.action, 'BLOCK');
    });
    await test('G no value history remains UNKNOWN, never default LOW_VALUE', () => {
      const start = Math.floor(base.now / LIFECYCLE_CONFIG.dayMs) * LIFECYCLE_CONFIG.dayMs;
      const value = buildContentValue(base.content.id, 'TEST_FIXTURE', start, base.now, base.now, []);
      assert.equal(value.businessValue, 'UNKNOWN'); assert.equal(value.valueConfidence, 0); assert.equal(value.revenueEvidence, null);
      assert.equal(value.revenueState, 'NO_REVENUE_DATA'); assert.equal(evaluate({ value }).plan.action, 'NO_ACTION');
    });
    for (const [field, invalid] of [['price', NaN], ['price', -1], ['price', Infinity], ['dealScore', NaN], ['dealConfidence', 2], ['contentConfidence', -1], ['priceState', 'invented'], ['policy', 'PASS']])
      await test(`invalid ${field} ${String(invalid)} fails closed`, () => assert.throws(() => evaluate({ current: { ...base.current, [field]: invalid } })));
    await test('missing selected offer requests offer evidence, not refresh execution', () => {
      const result = evaluate({ current: { ...base.current, selectedOfferId: null, routeSafe: false, offerState: 'MISSING' } });
      assert.equal(result.plan.action, 'REQUEST_OFFER_REFRESH'); assert.equal(result.eligibility, 'REVIEW_REQUIRED');
    });
    await test('fabricated direct Shopee provider cannot enter lifecycle evidence', () => assert.throws(() => evaluate({ current: { ...base.current, provider: 'shopee' } })));
    await test('contradictory safe-route claim is rejected', () => assert.throws(() => evaluate({ current: { ...base.current, selectedOfferId: null } })));
    await test('expired offer requests revalidation and invalidates offer facts', () => {
      const current = clone(base.current); current.offerState = 'EXPIRED'; current.routeSafe = false;
      current.facts = current.facts.map(fact => fact.section === 'OFFER' ? { ...fact, valid: false } : fact);
      const result = evaluate({ current }); assert.equal(result.plan.action, 'REQUEST_OFFER_REFRESH'); assert.equal(result.reasonCodes.includes('OFFER_EXPIRED'), true);
      for (const fact of current.facts.filter(fact => !fact.valid)) assert.equal(result.plan.brief.mustPreserveFacts.includes(fact.evidenceRef), false);
    });
    await test('unsafe destination produces critical BLOCK regardless of experiment', () => {
      const result = evaluate({ current: { ...base.current, destinationUnsafe: true, routeSafe: false } });
      assert.equal(result.plan.action, 'BLOCK'); assert.equal(result.severity, 'CRITICAL'); assert.equal(result.plan.experimentProposal, null);
    });
    for (const providerHealth of ['DEGRADED', 'UNAVAILABLE', 'COOLDOWN']) await test(`provider ${providerHealth} cannot execute refresh`, () => {
      const result = evaluate({ current: { ...base.current, providerHealth } }); assert.equal(result.plan.action, 'REQUEST_OFFER_REFRESH');
    });
    for (const priceState of ['STALE', 'UNKNOWN']) await test(`price ${priceState} requests authoritative refresh`, () => {
      const result = evaluate({ current: { ...base.current, price: null, priceState } }); assert.equal(result.plan.action, 'REQUEST_PRICE_REFRESH');
    });
    await test('explicit invalid price claim causes critical block', () => assert.equal(evaluate({ current: { ...base.current, price: null, priceState: 'INVALID' } }).plan.action, 'BLOCK'));
    await test('canonical conflict overrides Phase 8 refresh recommendation', () => {
      const result = evaluate({ current: { ...base.current, cannibalizationRisk: 'CANONICAL_CONFLICT' } });
      assert.equal(result.plan.action, 'HUMAN_REVIEW_REQUIRED'); assert.equal(result.priority, 'P0');
    });
    await test('duplicate coverage without verified merge target is review-only', () => assert.equal(evaluate({ current: { ...base.current, coverage: 'DUPLICATE_COVERAGE' } }).plan.action, 'HUMAN_REVIEW_REQUIRED'));
    for (const [relationship, action] of [['MERGED_INTO', 'MERGE_RECOMMENDED'], ['SUPERSEDES_CONTENT', 'SUPERSEDE_RECOMMENDED']]) await test(`${relationship} recommends but never deletes or redirects`, () => {
      const relation = { id: 'relationship-fixture', sourceId: relationship === 'SUPERSEDES_CONTENT' ? 'canonical-target-content' : base.content.id,
        targetId: relationship === 'SUPERSEDES_CONTENT' ? base.content.id : 'canonical-target-content', relationship, reasonCodes: ['CANONICAL_RELATIONSHIP_CHANGED'] };
      const result = evaluate({ current: { ...base.current, relationship: relation } }); assert.equal(result.plan.action, action);
      assert.deepEqual(result.plan.relationship, relation); assert.equal(result.plan.productionAllowed, false); assert.equal(result.plan.executionMode, 'SHADOW');
    });
    await test('obsolete authoritative entity yields archive review only', () => {
      const result = evaluate({ current: { ...base.current, obsolete: true } }); assert.equal(result.plan.action, 'ARCHIVE_REVIEW_RECOMMENDED');
      assert.equal(result.plan.productionAllowed, false);
    });
    await test('score collapse without obsolete evidence cannot auto-archive', () => assert.equal(evaluate({ current: { ...base.current, dealScore: 10 } }).plan.action, 'REFRESH_CONTENT'));
    for (const missing of ['baseline', 'contentPlan', 'opportunity']) await test(`missing ${missing} is review required`, () => {
      const input = clone(base); if (missing === 'opportunity') { input.current.opportunityPriority = null; input.current.opportunityFingerprint = null; }
      else input[missing] = null;
      assert.equal(evaluateLifecycle(input).plan.action, 'HUMAN_REVIEW_REQUIRED');
    });
    await test('invalid content identity rejected', () => assert.throws(() => evaluate({ content: { ...base.content, id: '../../private' } })));
    await test('canonical product mismatch rejected', () => assert.throws(() => evaluate({ current: { ...base.current, canonicalProductId: 'wrong-product' } })));
    await test('fingerprint mismatch input rejected', () => assert.throws(() => evaluate({ current: { ...base.current, dealFingerprint: 'not-a-hash' } })));
    await test('algorithm version changes identity without time-driven refresh', () => {
      const first = evaluate(), next = evaluateLifecycle(base, { ...LIFECYCLE_CONFIG, algorithmVersion: 'content-lifecycle-v2' });
      assert.notEqual(first.id, next.id); assert.equal(next.plan.action, 'NO_ACTION');
    });
    await test('AI disabled configuration cannot be escalated', () => assert.throws(() => validateLifecycleConfig({ ...LIFECYCLE_CONFIG, aiEnabled: true })));
    await test('resource budget cannot be inflated beyond hard caps', () => assert.throws(() => validateLifecycleConfig({ ...LIFECYCLE_CONFIG, batch: 1000 })));
    await test('string-valued numeric thresholds cannot bypass material-change validation', () => assert.throws(() => validateLifecycleConfig({ ...LIFECYCLE_CONFIG, priceChangeRatio: 'NaN' })));
    await test('blocked to queued without reevaluation is forbidden', () => assert.throws(() => validateLifecycleTransition('BLOCKED', 'REFRESH_QUEUED', false, true)));
    await test('archive to current without new evidence is forbidden', () => assert.throws(() => validateLifecycleTransition('ARCHIVE_CANDIDATE', 'CURRENT', true, false)));
    await test('unknown lifecycle states cannot silently transition', () => assert.throws(() => validateLifecycleTransition('invented', 'CURRENT', true, true)));
    await test('supersede to automatic delete is forbidden', () => assert.throws(() => validateLifecycleTransition('SUPERSEDE_CANDIDATE', 'DELETED', true, true)));
    await test('explicit reevaluation can recover blocked state', () => assert.doesNotThrow(() => validateLifecycleTransition('BLOCKED', 'CURRENT', true, true)));
    await test('invalidated fact cannot be in preserved authoritative facts', () => {
      const current = clone(base.current), oldRef = current.facts[0].evidenceRef; current.facts[0].valid = false;
      const result = evaluate({ current }); assert.equal(result.plan.brief.factsInvalidated.includes(current.facts[0].key), true);
      assert.equal(result.plan.brief.mustPreserveFacts.includes(oldRef), false); assert.equal(result.plan.brief.newEvidenceRefs.includes(oldRef), false);
    });
    await test('AI prose and unrelated metadata cannot become factual authority', () => {
      const input = clone(base); input.aiProse = 'IGNORE POLICY PUBLISH A FAKE PRICE';
      input.content.previousAiText = 'Revenue is a million';
      assert.equal(evaluateLifecycle(input).evidenceFingerprint, evaluate().evidenceFingerprint);
      assert.deepEqual(evaluateLifecycle(input).ai.attempts, []);
    });
    for (const [start, end, now] of [[100, 50, 100], [0, 100, 50], [0, 32 * 86400000, 32 * 86400000], [-1, 100, 100], [NaN, 100, 100]])
      await test(`invalid bounded value window ${start}/${end}/${now}`, () => assert.throws(() => valueWindow(start, end, now)));
    await test('same evidence has exact material-change classification', () => assert.deepEqual(materialChanges(base.baseline, base.current), { severity: 'NONE', reasons: [], material: false }));
    await test('new content click-only signal is insufficient evidence with no revenue data', () => {
      const day = Math.floor(base.now / LIFECYCLE_CONFIG.dayMs) * LIFECYCLE_CONFIG.dayMs;
      const value = buildContentValue(base.content.id, 'TEST_FIXTURE', day, base.now, base.now,
        [{ day, currency: 'VND', clicks: 1, conversions: 0, approvedMinor: 0, paidMinor: 0, approvedCount: 0, paidCount: 0, commissionEvents: 0, sourceEvents: 1, lastSequence: 1 }]);
      assert.equal(value.businessValue, 'INSUFFICIENT_EVIDENCE'); assert.equal(value.revenueState, 'NO_REVENUE_DATA'); assert.equal(value.valueConfidence, 0.02);
      assert.equal(evaluate({ value }).plan.action, 'NO_ACTION');
    });
    await test('NaN value confidence cannot promote refresh priority', () => {
      const day = Math.floor(base.now / LIFECYCLE_CONFIG.dayMs) * LIFECYCLE_CONFIG.dayMs;
      const value = buildContentValue(base.content.id, 'TEST_FIXTURE', day, base.now, base.now, []); value.valueConfidence = NaN;
      assert.throws(() => evaluate({ value }), /INVALID_CONTENT_VALUE_EVIDENCE/);
    });
    await test('observed zero payment does not assert complete zero content value', () => {
      const day = Math.floor(base.now / LIFECYCLE_CONFIG.dayMs) * LIFECYCLE_CONFIG.dayMs;
      const value = buildContentValue(base.content.id, 'TEST_FIXTURE', day, base.now, base.now,
        [{ day, currency: 'VND', clicks: 1, conversions: 1, approvedMinor: 0, paidMinor: 0, approvedCount: 0, paidCount: 1, commissionEvents: 1, sourceEvents: 3, lastSequence: 3 }]);
      assert.equal(value.revenueState, 'NO_REVENUE_OBSERVED'); assert.equal(value.dataCompleteness, 'PARTIAL');
      assert.deepEqual(value.revenueEvidence, [{ currency: 'VND', amountMinor: 0, evidenceCount: 1 }]); assert.equal(evaluate({ value }).plan.action, 'NO_ACTION');
    });
    await test('configured opportunity priority can promote but cannot override safety', () => {
      const result = evaluate({ current: { ...base.current, opportunityPriority: 'P0', price: 900000 } }); assert.equal(result.priority, 'P1');
      assert.equal(evaluate({ current: { ...base.current, opportunityPriority: 'P0', policy: 'QUARANTINE' } }).plan.action, 'BLOCK');
    });
    proofs.pureUnchanged = evaluate();
  });
}
async function runDurable() {
  await withLifecycle(async fixture => {
    const { db, lifecycle, entity, now, jobs } = fixture;
    await test('registration replay is idempotent and no public content mutation occurs', async () => {
      const before = await db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first();
      assert.deepEqual(await lifecycle.register(entity, fixture.plan, now), { created: false });
      assert.equal(await count(db, 'content_lifecycle_sources'), 1);
      assert.deepEqual(await db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first(), before);
    });
    await test('missing lifecycle record fails closed', async () => assert.rejects(() => lifecycle.prepare('not-registered', now), /CONTENT_LIFECYCLE_RECORD_MISSING/));
    await test('actual current upstream evidence produces unchanged NO_ACTION', async () => {
      const result = await lifecycle.prepare(entity.id, now); assert.equal(result.evaluation.plan.action, 'NO_ACTION');
      proofs.realUpstreamUnchanged = result.evaluation;
    });
    await test('coalescing suppresses immediate noncritical jobs', async () => {
      const result = await lifecycle.materializeDue(now); assert.equal(result.created, 0); assert.equal(result.coalesced, 1);
      assert.equal(await count(db, 'content_refresh_jobs'), 0);
    });
    let firstJob;
    await test('I duplicate materialization creates exactly one durable refresh job', async () => {
      const first = await lifecycle.materializeDue(now + 31000), again = await lifecycle.materializeDue(now + 31000);
      assert.equal(first.created, 1); assert.equal(again.created, 0); assert.equal(await count(db, 'content_refresh_jobs'), 1);
      const row = await db.prepare('SELECT job_id FROM content_refresh_jobs LIMIT 1').first(); firstJob = await jobs.get(row.job_id);
    });
    await test('duplicate queue delivery produces exactly one lifecycle plan and audit', async () => {
      const first = delivery(makeMessage(firstJob));
      assert.equal(await consumeDelivery(first, fixture.env, { now: () => now + 31000, moneyTestOnly: true }), 'SUCCEEDED');
      const second = delivery(makeMessage(firstJob));
      assert.equal(await consumeDelivery(second, fixture.env, { now: () => now + 31000, moneyTestOnly: true }), 'DUPLICATE_SAFE');
      assert.equal(await count(db, 'content_lifecycle_audit'), 1); assert.equal(await count(db, 'content_lifecycle'), 1);
      assert.equal((await lifecycle.latest(entity.id)).plan.action, 'NO_ACTION');
    });
    await test('J stale queued fingerprint cannot create a plan', async () => {
      const second = entityFor(fixture.product, now, 'stale'); await lifecycle.register(second, { ...fixture.plan, contentId: second.id }, now);
      await lifecycle.materializeDue(now); await lifecycle.materializeDue(now + 31000);
      const row = await db.prepare('SELECT job_id FROM content_refresh_jobs WHERE content_id=?').bind(second.id).first();
      await db.prepare("UPDATE content_lifecycle_sources SET token=?,plan=json_set(plan,'$.evidenceFingerprint',?) WHERE content_id=?").bind(dealFingerprint('new-facts'), dealFingerprint('new-plan'), second.id).run();
      const before = await count(db, 'content_lifecycle_audit');
      const message = delivery(makeMessage(await jobs.get(row.job_id)));
      assert.equal(await consumeDelivery(message, fixture.env, { now: () => now + 31000, moneyTestOnly: true }), 'SUCCEEDED');
      assert.equal((await db.prepare('SELECT outcome FROM content_refresh_jobs WHERE job_id=?').bind(row.job_id).first()).outcome, 'STALE_JOB_NOOP');
      assert.equal(await count(db, 'content_lifecycle_audit'), before);
    });
    await test('rapid changes coalesce into one current evaluation per content', async () => {
      const third = entityFor(fixture.product, now, 'storm'); await lifecycle.register(third, { ...fixture.plan, contentId: third.id }, now);
      await lifecycle.materializeDue(now);
      for (let change = 0; change < 12; change++) await db.prepare('UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE content_id=?').bind(third.id).run();
      assert.equal((await lifecycle.materializeDue(now + 1000)).created, 0);
      await lifecycle.materializeDue(now + 31000);
      assert.equal((await db.prepare('SELECT count(*) AS total FROM content_refresh_jobs WHERE content_id=?').bind(third.id).first()).total, 1);
    });
    await test('atomic audit failure rolls back lifecycle and job completion', async () => {
      const fourth = entityFor(fixture.product, now, 'rollback'); await lifecycle.register(fourth, { ...fixture.plan, contentId: fourth.id }, now);
      await lifecycle.materializeDue(now); await lifecycle.materializeDue(now + 31000);
      const row = await db.prepare('SELECT job_id FROM content_refresh_jobs WHERE content_id=?').bind(fourth.id).first();
      const job = await jobs.claim(await jobs.get(row.job_id), now + 31000);
      await db.prepare("CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON content_lifecycle_audit BEGIN SELECT RAISE(ABORT,'INJECTED_LOCAL_FAILURE'); END").run();
      try { await assert.rejects(() => lifecycle.execute(job, now + 31000), /LIFECYCLE_ATOMIC_CONFLICT/); }
      finally { await db.prepare('DROP TRIGGER reject_lifecycle_audit').run(); }
      assert.equal(await lifecycle.latest(fourth.id), null); assert.equal((await jobs.get(job.id)).status, 'RUNNING');
      assert.equal(await lifecycle.execute(job, now + 31000), 'SHADOW_RECORDED');
    });
    await test('portfolio and value queries use bounded indexed searches', async () => {
      const plans = [];
      for (const kind of ['P0', 'P1', 'HIGH_VALUE_STALE', 'LOW_CONFIDENCE_STALE', 'MERGE', 'SUPERSEDE', 'ARCHIVE', 'RECENT', 'ACCESSTRADE_SHOPEE', 'SAMPLE']) {
        const query = lifecycle.portfolioQuery(kind, 5), result = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
        const detail = result.results.map(row => row.detail).join(' '); assert.equal(/SEARCH/.test(detail), true); assert.equal(/SCAN content_lifecycle|USE TEMP B-TREE/.test(detail), false);
        plans.push({ kind, detail }); assert.equal((await lifecycle.portfolio(kind, 5)).records.length <= 5, true);
      }
      for (const kind of ['TOP', 'CONVERSIONS', 'REVENUE', 'UNKNOWN', 'NEW']) {
        const query = lifecycle.values.rankingQuery(kind, 5), result = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
        const detail = result.results.map(row => row.detail).join(' '); assert.equal(/SEARCH/.test(detail), true); assert.equal(/SCAN content_value_snapshots|USE TEMP B-TREE/.test(detail), false);
      }
      proofs.indexPlans = plans;
    });
    await test('unbounded portfolio/value query rejected', async () => {
      assert.throws(() => lifecycle.portfolioQuery('SAMPLE', 999)); assert.throws(() => lifecycle.values.rankingQuery('TOP', 0));
      await assert.rejects(() => lifecycle.values.snapshot(entity.id, now, now - 86400000 * 100));
    });
    await test('local lifecycle paths have no FileStorage or filesystem calls', async () => {
      const originals = new Map(), descriptors = new Map(); let fileCalls = 0, filesystemCalls = 0;
      for (const method of ['readFile', 'writeFile', 'mkdir', 'rename', 'open', 'stat', 'access', 'readdir', 'unlink', 'rm']) {
        originals.set(method, fs.promises[method]); fs.promises[method] = async () => { filesystemCalls++; throw new Error('FILESYSTEM_FORBIDDEN'); };
      }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fileStorageAdapter))) {
        if (typeof descriptor.value !== 'function' && !descriptor.get) continue;
        descriptors.set(key, descriptor); Object.defineProperty(fileStorageAdapter, key, { configurable: true, get() { fileCalls++; throw new Error('FILE_STORAGE_FORBIDDEN'); } });
      }
      try { await lifecycle.prepare(entity.id, now + 31000); await lifecycle.summary(5); await lifecycle.values.snapshot(entity.id, now + 31000); }
      finally { for (const [method, original] of originals) fs.promises[method] = original; for (const [key, descriptor] of descriptors) Object.defineProperty(fileStorageAdapter, key, descriptor); }
      assert.equal(fileCalls, 0); assert.equal(filesystemCalls, 0); assert.equal(fixture.runtime.built.fileStorageModules, 0);
      assert.equal(fixture.runtime.built.filesystemSettingsModules, 0);
    });
    await test('explicit relationship requires an existing matching canonical target', async () => {
      const source = await db.prepare('SELECT token FROM content_lifecycle_sources WHERE content_id=?').bind(entity.id).first();
      const relation = { id: 'merge-fixture', sourceId: entity.id, targetId: 'missing-target', relationship: 'MERGED_INTO', reasonCodes: ['CONTENT_DUPLICATION_FOUND'] };
      await assert.rejects(() => lifecycle.setRelationship(entity.id, relation, source.token));
      await lifecycle.setRelationship(entity.id, { ...relation, targetId: 'content-rollback' }, source.token);
      assert.equal((await lifecycle.prepare(entity.id, now + 31000)).evaluation.plan.action, 'MERGE_RECOMMENDED');
    });
    await test('content coverage events update only shadow plans through explicit CAS', async () => {
      const contentId = 'content-rollback';
      const before = await db.prepare('SELECT entity,baseline,token,plan FROM content_lifecycle_sources WHERE content_id=?').bind(contentId).first();
      const plan = { ...JSON.parse(before.plan), coverage: 'STALE_COVERAGE', evidenceFingerprint: dealFingerprint('coverage-update') };
      assert.deepEqual(await lifecycle.observePlan(contentId, plan, before.token, now + 31000), { changed: true });
      assert.deepEqual(await lifecycle.observePlan(contentId, plan, before.token, now + 31000), { changed: false });
      const after = await db.prepare('SELECT entity,baseline FROM content_lifecycle_sources WHERE content_id=?').bind(contentId).first();
      assert.equal(after.entity, before.entity); assert.equal(after.baseline, before.baseline);
      assert.equal((await lifecycle.prepare(contentId, now + 31000)).evaluation.plan.action, 'REFRESH_CONTENT');
    });
    await test('lifecycle audit cannot be silently rewritten or deleted', async () => {
      await assert.rejects(() => db.prepare('DELETE FROM content_lifecycle_audit WHERE content_id=?').bind('content-rollback').run());
      await assert.rejects(() => db.prepare("UPDATE content_lifecycle_audit SET execution_mode='SHADOW' WHERE content_id=?").bind('content-rollback').run());
      assert.notEqual(await lifecycle.latest('content-rollback'), null);
    });
    await test('critical change bypasses cooldown and coalescing', async () => {
      await db.prepare("UPDATE content_lifecycle_work SET cooldown_until=?,material_fingerprint='old',pending=1,due_at=0,coalesce_until=? WHERE content_id=?").bind(now + 3600000, now + 3600000, entity.id).run();
      const critical = new D1DecisionStore(db, { executionMode: 'SHADOW', systemHealth: 'AVAILABLE', systemVersion: 'local-d1-queue-v1', securityRisk: true, quarantined: false, runtimeValid: true }, true);
      const opportunities = cloudflareOpportunityStore(fixture.env, db, critical, true);
      const store = new D1ContentLifecycleStore(db, critical, opportunities, fixture.input.allowedHosts, true);
      const result = await store.materializeDue(now + 32000);
      assert.equal(result.created > 0, true);
      const prepared = await store.prepare(entity.id, now + 32000); assert.equal(prepared.evaluation.severity, 'CRITICAL'); assert.equal(prepared.evaluation.plan.action, 'BLOCK');
    });
    await test('budget caps a burst and keyset config invalidation is bounded', async () => {
      for (let index = 0; index < 7; index++) {
        const content = entityFor(fixture.product, now, `budget-${index}`); await lifecycle.register(content, { ...fixture.plan, contentId: content.id }, now);
      }
      await lifecycle.materializeDue(now + 33000);
      const result = await lifecycle.materializeDue(now + 65000); assert.equal(result.created <= LIFECYCLE_CONFIG.batch, true); assert.equal(result.inspected <= LIFECYCLE_CONFIG.read, true);
      const query = await db.prepare("EXPLAIN QUERY PLAN SELECT content_id FROM content_lifecycle_sources WHERE origin=? AND content_id>? ORDER BY content_id LIMIT ?").bind('TEST_FIXTURE', '', 5).all();
      assert.equal(query.results.some(row => /SEARCH/.test(row.detail)), true);
    });
    await test('Queue unavailable leaves durable outbox rather than falsely completing', async () => {
      const broken = { ...fixture.env, JOB_QUEUE: { async send() { throw new Error('LOCAL_QUEUE_OFFLINE'); } } };
      await assert.rejects(() => createCloudflareSchedulerAdapter(broken).tick(now + 65000), /QUEUE_SEND_FAILED/);
      const pending = await db.prepare("SELECT id FROM automation_jobs WHERE dispatch_pending=1 AND status IN ('PENDING','RUNNING','RETRY_SCHEDULED') LIMIT 1").first();
      assert.notEqual(pending, null);
    });
  });
}
async function runAttribution() {
  await withLifecycle(async fixture => {
    const { db, lifecycle, entity } = fixture, now = Date.now(), offer = fixture.product.offers.find(offer => offer.monetization?.provider === 'accesstrade').monetization;
    const product = await fixture.adapter.domain.getProduct(fixture.product.id);
    function clickFor(id, contentEntityId = entity.id, createdAt = new Date(now).toISOString()) {
      return { id, contentEntityId, productId: fixture.product.id, offerId: offer.id, provider: 'accesstrade', platform: offer.platform,
        merchantId: offer.merchant.id, campaignId: offer.campaign?.id ?? null, currency: offer.currency, createdAt,
        attribution: { reference: id, transport: 'PROVIDER_SUB1' }, context: 'PRODUCT', destinationHash: moneyHash(offer.destination.url), origin: 'TEST_FIXTURE' };
    }
    const click = clickFor('content-click-fixture');
    let shadowExperiment, experiments;
    await test('existing shadow experiment can reference the same stable click identity', async () => {
      const { D1ExperimentStore } = load('../src/lib/storage/d1/d1ExperimentStore.ts');
      experiments = new D1ExperimentStore(db, fixture.opportunities, true);
      shadowExperiment = await experiments.create({ productId: fixture.product.id, type: 'TITLE_VARIANT', version: 1,
        variants: [{ id: 'A', weight: 5000 }, { id: 'B', weight: 5000 }], primaryMetric: 'CLICK', startsAt: fixture.now,
        expiresAt: fixture.now + 600000, minimumRuntimeMs: 60000, minimumSubjectsPerVariant: 20, minimumEventsPerVariant: 5 }, fixture.now);
      await experiments.transition(shadowExperiment.experimentId, 'ELIGIBLE', fixture.now);
      await experiments.transition(shadowExperiment.experimentId, 'SHADOW', fixture.now);
      await experiments.assign(shadowExperiment.experimentId, click.id, fixture.now);
      assert.equal((await experiments.get(shadowExperiment.experimentId)).state, 'SHADOW');
    });
    await test('attribution A content-linked click counted once under duplicate replay', async () => {
      await fixture.money.recordClick(click, product.version.token);
      const source = { kind: 'CLICK', clickId: click.id };
      assert.deepEqual(await lifecycle.values.reconcile(source, now + 10), { status: 'DIRECTLY_ATTRIBUTED', effect: 1 });
      assert.deepEqual(await lifecycle.values.reconcile(source, now + 10), { status: 'DUPLICATE', effect: 0 });
      await fixture.money.recordClick(click, product.version.token);
      const value = await lifecycle.values.snapshot(entity.id, now + 10); assert.equal(value.attributedClicks, 1); assert.equal(value.attributedConversions, 0);
      assert.equal(value.valueConfidence < 0.5, true); assert.equal(value.revenueEvidence, null); assert.equal(value.revenueState, 'NO_REVENUE_DATA');
    });
    await test('content and experiment metrics reference one deduplicated business event with zero extra money', async () => {
      const before = await count(db, 'affiliate_money_events'), time = Date.now();
      assert.deepEqual(await experiments.recordMetric(shadowExperiment.experimentId, click.id, 'CLICK', `click:${click.id}`, time), { status: 'APPLIED', effect: 1 });
      assert.deepEqual(await experiments.recordMetric(shadowExperiment.experimentId, click.id, 'CLICK', `click:${click.id}`, time), { status: 'DUPLICATE', effect: 0 });
      assert.deepEqual(await lifecycle.values.reconcile({ kind: 'CLICK', clickId: click.id }, time), { status: 'DUPLICATE', effect: 0 });
      assert.equal(await count(db, 'affiliate_money_events'), before); assert.equal(await count(db, 'experiment_metric_events'), 1);
      assert.equal((await lifecycle.values.snapshot(entity.id, time)).attributedClicks, 1);
      const summary = await experiments.summary(shadowExperiment.experimentId, time);
      assert.equal(summary.variants.reduce((total, variant) => total + variant.clicks, 0), 1); assert.equal(summary.productionRolloutAllowed, false);
    });
    await test('attribution B click-conversion chain counted once', async () => {
      const conversion = fixture.conversion(click), commission = fixture.commission({ state: 'APPROVED' });
      await fixture.evidence(click, conversion, commission);
      const time = Date.now() + 10;
      assert.deepEqual(await lifecycle.values.reconcile({ kind: 'CONVERSION', provider: click.provider, externalId: conversion.externalId }, time), { status: 'DIRECTLY_ATTRIBUTED', effect: 1 });
      assert.deepEqual(await lifecycle.values.reconcile({ kind: 'CONVERSION', provider: click.provider, externalId: conversion.externalId }, time), { status: 'DUPLICATE', effect: 0 });
      assert.equal((await lifecycle.values.snapshot(entity.id, time)).attributedConversions, 1);
    });
    await test('attribution C approved commission replay has no extra economic effect', async () => {
      const source = { kind: 'COMMISSION', provider: 'accesstrade', externalId: 'fixture-commission' }, time = Date.now() + 10;
      assert.deepEqual(await lifecycle.values.reconcile(source, time), { status: 'DIRECTLY_ATTRIBUTED', effect: 1 });
      const economicBefore = await count(db, 'affiliate_money_events');
      assert.deepEqual(await lifecycle.values.reconcile(source, time), { status: 'DUPLICATE', effect: 0 });
      const value = await lifecycle.values.snapshot(entity.id, time);
      assert.deepEqual(value.approvedCommissionEvidence, [{ currency: 'VND', amountMinor: 25000, evidenceCount: 1 }]);
      assert.equal(value.revenueEvidence, null); assert.equal(await count(db, 'affiliate_money_events'), economicBefore);
    });
    await test('paid revision reclassifies value, duplicate revenue adds nothing', async () => {
      await fixture.evidence(click, fixture.conversion(click), fixture.commission({ eventId: 'fixture-commission-paid', revision: 2, state: 'PAID' }));
      const source = { kind: 'COMMISSION', provider: 'accesstrade', externalId: 'fixture-commission' }, time = Date.now() + 10;
      assert.equal((await lifecycle.values.reconcile(source, time)).effect, 1); assert.equal((await lifecycle.values.reconcile(source, time)).effect, 0);
      const value = await lifecycle.values.snapshot(entity.id, time);
      assert.equal(value.approvedCommissionEvidence, null); assert.deepEqual(value.revenueEvidence, [{ currency: 'VND', amountMinor: 25000, evidenceCount: 1 }]);
      assert.equal(value.attributedConversions, 1); assert.equal(value.sourceEventCount, 3); assert.equal(value.revenueState, 'VERIFIED_REVENUE');
      assert.equal(value.businessValue, 'INSUFFICIENT_EVIDENCE'); proofs.attribution = value;
    });
    await test('commission rejection retracts approved evidence and preserves final paid evidence', async () => {
      const approved = fixture.commission({ externalId: 'retractable-commission', eventId: 'retractable-approved', state: 'APPROVED' });
      await fixture.evidence(click, fixture.conversion(click), approved);
      await lifecycle.values.reconcile({ kind: 'COMMISSION', provider: 'accesstrade', externalId: approved.externalId }, Date.now() + 10);
      assert.deepEqual((await lifecycle.values.snapshot(entity.id, Date.now() + 10)).approvedCommissionEvidence, [{ currency: 'VND', amountMinor: 25000, evidenceCount: 1 }]);
      const rejected = await fixture.evidence(click, fixture.conversion(click), { ...approved, eventId: 'retractable-rejected', revision: 2, state: 'REJECTED', occurredAt: new Date().toISOString() });
      assert.equal(rejected.commissioned.outcomes[0].status, 'APPLIED');
      const time = Date.now() + 10;
      await lifecycle.values.reconcile({ kind: 'COMMISSION', provider: 'accesstrade', externalId: approved.externalId }, time);
      const value = await lifecycle.values.snapshot(entity.id, time); assert.deepEqual(value.revenueEvidence, [{ currency: 'VND', amountMinor: 25000, evidenceCount: 1 }]);
      assert.equal(value.approvedCommissionEvidence, null); assert.equal(value.revenueState, 'VERIFIED_REVENUE'); assert.equal(value.businessValue, 'INSUFFICIENT_EVIDENCE');
    });
    await test('paid money remains final when an invalid rejection revision is attempted', async () => {
      const before = await count(db, 'affiliate_money_events');
      const result = await fixture.evidence(click, fixture.conversion(click), fixture.commission({ eventId: 'paid-rejection-forbidden', revision: 3, state: 'REJECTED' }));
      assert.equal(result.commissioned.outcomes[0].status, 'QUARANTINED');
      assert.equal(result.commissioned.outcomes[0].code, 'INVALID_COMMISSION_REVISION_OR_TRANSITION');
      assert.equal(await count(db, 'affiliate_money_events'), before);
      assert.equal((await lifecycle.values.reconcile({ kind: 'COMMISSION', provider: 'accesstrade', externalId: 'fixture-commission' }, Date.now() + 10)).effect, 0);
      assert.deepEqual((await lifecycle.values.snapshot(entity.id, Date.now() + 10)).revenueEvidence, [{ currency: 'VND', amountMinor: 25000, evidenceCount: 1 }]);
    });
    await test('D missing conversion/click chain remains unattributed', async () => {
      assert.deepEqual(await lifecycle.values.reconcile({ kind: 'CONVERSION', provider: 'accesstrade', externalId: 'no-chain' }, Date.now()), { status: 'UNATTRIBUTED', effect: 0 });
      assert.deepEqual(await lifecycle.values.reconcile({ kind: 'CLICK', clickId: 'no-click' }, Date.now()), { status: 'UNATTRIBUTED', effect: 0 });
    });
    await test('loose content strings cannot retroactively assign existing click', async () => {
      const unlinked = clickFor('unlinked-click'); delete unlinked.contentEntityId; await fixture.money.recordClick(unlinked, product.version.token);
      assert.deepEqual(await lifecycle.values.reconcile({ kind: 'CLICK', clickId: unlinked.id, contentEntityId: entity.id }, Date.now()), { status: 'UNATTRIBUTED', effect: 0 });
    });
    await test('future event timestamp is quarantined without attributed value', async () => {
      const future = clickFor('future-click', entity.id, new Date(Date.now() + 3600000).toISOString()); await fixture.money.recordClick(future, product.version.token);
      await assert.rejects(() => lifecycle.values.reconcile({ kind: 'CLICK', clickId: future.id }, Date.now()), /CONTENT_ATTRIBUTION_CHAIN_INVALID/);
    });
    await test('ambiguous multiple content identity cannot produce attribution', async () => {
      await assert.rejects(() => fixture.money.recordClick({ ...clickFor('ambiguous-click'), contentEntityId: [entity.id, 'other'] }, product.version.token));
    });
    await test('fixture events cannot enter authenticated content value projections', async () => {
      const production = new D1ContentValueStore(db);
      assert.deepEqual(await production.reconcile({ kind: 'CLICK', clickId: click.id }, Date.now()), { status: 'UNATTRIBUTED', effect: 0 });
      await assert.rejects(() => production.snapshot(entity.id, Date.now()), /CONTENT_VALUE_ENTITY_MISSING/);
    });
    await test('same business IDs are referenced without new money or experiment events', async () => {
      const before = await count(db, 'affiliate_money_events'); await lifecycle.values.reconcileDue(Date.now());
      const rows = (await db.prepare('SELECT source_event_id FROM content_attribution').all()).results;
      assert.equal(rows.some(row => row.source_event_id === `click:${click.id}`), true);
      assert.equal(rows.some(row => row.source_event_id === 'conversion:accesstrade:fixture-order'), true);
      assert.equal(await count(db, 'affiliate_money_events'), before); assert.equal(await count(db, 'experiment_metric_events'), 1);
    });
    await test('concurrent content event reconciliation converges without lost or duplicate aggregates', async () => {
      const concurrent = clickFor('concurrent-content-click'); await fixture.money.recordClick(concurrent, product.version.token);
      const results = await Promise.all([lifecycle.values.reconcile({ kind: 'CLICK', clickId: concurrent.id }, Date.now() + 10),
        lifecycle.values.reconcile({ kind: 'CLICK', clickId: concurrent.id }, Date.now() + 10)]);
      assert.deepEqual(results.map(result => result.effect).sort(), [0, 1]);
      assert.equal((await lifecycle.values.snapshot(entity.id, Date.now() + 10)).attributedClicks, 2);
    });
    await test('attribution write and aggregate update roll back together on D1 failure', async () => {
      const rollback = clickFor('rollback-content-click'); await fixture.money.recordClick(rollback, product.version.token);
      await db.prepare("CREATE TRIGGER reject_content_value BEFORE UPDATE ON content_value_daily BEGIN SELECT RAISE(ABORT,'LOCAL_VALUE_FAULT'); END").run();
      try { await assert.rejects(() => lifecycle.values.reconcile({ kind: 'CLICK', clickId: rollback.id }, Date.now() + 10), /CONTENT_ATTRIBUTION_ATOMIC_CONFLICT/); }
      finally { await db.prepare('DROP TRIGGER reject_content_value').run(); }
      assert.equal(await db.prepare('SELECT event_key FROM content_attribution WHERE event_key=?').bind(`click:${rollback.id}`).first(), null);
      assert.equal((await lifecycle.values.snapshot(entity.id, Date.now() + 10)).attributedClicks, 2);
      assert.equal((await lifecycle.values.reconcile({ kind: 'CLICK', clickId: rollback.id }, Date.now() + 10)).effect, 1);
    });
    await test('attribution and due queries are indexed with explicit fixed bounds', async () => {
      for (const [sql, args] of [
        ['SELECT * FROM content_attribution_inbox WHERE origin=? AND pending=1 ORDER BY sequence LIMIT ?', ['TEST_FIXTURE', 5]],
        ['SELECT * FROM content_value_daily WHERE origin=? AND content_id=? AND day>=? AND day<? ORDER BY day,currency LIMIT ?', ['TEST_FIXTURE', entity.id, 0, Date.now(), 93]],
        ['SELECT content_id FROM content_lifecycle_work WHERE origin=? AND pending=1 AND urgency=0 AND due_at<=? ORDER BY due_at,content_id LIMIT ?', ['TEST_FIXTURE', Date.now(), 20]],
      ]) {
        const detail = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all()).results.map(row => row.detail).join(' ');
        assert.equal(/SEARCH/.test(detail), true); assert.equal(/SCAN |USE TEMP B-TREE/.test(detail), false);
      }
    });
    await test('critically unsafe content wins over existing shadow experiment state', async () => {
      const critical = new D1DecisionStore(db, { executionMode: 'SHADOW', systemHealth: 'AVAILABLE', systemVersion: 'local-d1-queue-v1', securityRisk: true, quarantined: false, runtimeValid: true }, true);
      const opportunities = cloudflareOpportunityStore(fixture.env, db, critical, true), store = new D1ContentLifecycleStore(db, critical, opportunities, fixture.input.allowedHosts, true);
      const prepared = await store.prepare(entity.id, Date.now() + 10);
      assert.equal((await experiments.get(shadowExperiment.experimentId)).state, 'SHADOW'); assert.equal(prepared.evaluation.plan.action, 'BLOCK');
      assert.equal(prepared.evaluation.plan.experimentProposal, null); assert.equal(await count(db, 'experiment_assignments'), 1);
    });
  });
}
async function runConcurrency() {
  await withLifecycle(async fixture => {
    const { db, lifecycle, jobs, now } = fixture, executionTime = now + 31000;
    const auditCount = async contentId => Number((await db.prepare('SELECT count(*) AS total FROM content_lifecycle_audit WHERE origin=? AND content_id=?').bind('TEST_FIXTURE', contentId).first()).total);
    async function queuedFor(suffix) {
      const entity = entityFor(fixture.product, now, suffix);
      await lifecycle.register(entity, { ...fixture.plan, contentId: entity.id }, now);
      await lifecycle.materializeDue(now); await lifecycle.materializeDue(executionTime);
      const queued = await db.prepare('SELECT job_id FROM content_refresh_jobs WHERE origin=? AND content_id=?').bind('TEST_FIXTURE', entity.id).first();
      assert.notEqual(queued, null);
      return { entity, job: await jobs.get(queued.job_id) };
    }
    const concurrent = entityFor(fixture.product, now, 'concurrent-registration');
    await test('concurrent identical registration retains one immutable content identity', async () => {
      const plan = { ...fixture.plan, contentId: concurrent.id };
      const results = await Promise.all([lifecycle.register(concurrent, plan, now), lifecycle.register(concurrent, plan, now)]);
      assert.deepEqual(results.map(result => result.created).sort(), [false, true]);
      assert.equal((await db.prepare('SELECT count(*) AS total FROM content_lifecycle_sources WHERE content_id=?').bind(concurrent.id).first()).total, 1);
    });
    await test('concurrent refresh producers create one outbox job per evidence fingerprint', async () => {
      await lifecycle.materializeDue(now);
      await Promise.all([lifecycle.materializeDue(executionTime), lifecycle.materializeDue(executionTime)]);
      assert.equal((await db.prepare('SELECT count(*) AS total FROM content_refresh_jobs WHERE content_id=?').bind(concurrent.id).first()).total, 1);
      assert.equal((await db.prepare("SELECT count(*) AS total FROM automation_jobs WHERE json_extract(payload,'$.contentEntityId')=?").bind(concurrent.id).first()).total, 1);
    });
    await test('concurrent Queue consumers and later redelivery commit one lifecycle plan', async () => {
      const row = await db.prepare('SELECT job_id FROM content_refresh_jobs WHERE content_id=?').bind(concurrent.id).first();
      const job = await jobs.get(row.job_id), messages = [delivery(makeMessage(job)), delivery(makeMessage(job))];
      const outcomes = await Promise.all(messages.map(message => consumeDelivery(message, fixture.env, { now: () => executionTime, moneyTestOnly: true })));
      assert.equal(outcomes.filter(outcome => outcome === 'SUCCEEDED').length, 1);
      assert.equal(outcomes.every(outcome => ['SUCCEEDED', 'DEFERRED', 'DUPLICATE_SAFE'].includes(outcome)), true);
      assert.equal(await consumeDelivery(delivery(makeMessage(job)), fixture.env, { now: () => executionTime, moneyTestOnly: true }), 'DUPLICATE_SAFE');
      assert.equal(await auditCount(concurrent.id), 1); assert.equal((await jobs.get(job.id)).status, 'SUCCEEDED');
    });
    await test('lost acknowledgement after commit cannot duplicate a lifecycle audit', async () => {
      const { entity, job } = await queuedFor('lost-ack');
      await assert.rejects(() => consumeDelivery(delivery(makeMessage(job)), fixture.env, { now: () => executionTime, moneyTestOnly: true,
        afterCommit: async () => { throw new Error('LOCAL_ACK_LOST'); } }), /LOCAL_ACK_LOST/);
      assert.equal((await jobs.get(job.id)).status, 'SUCCEEDED');
      assert.equal(await consumeDelivery(delivery(makeMessage(job)), fixture.env, { now: () => executionTime, moneyTestOnly: true }), 'DUPLICATE_SAFE');
      assert.equal(await auditCount(entity.id), 1);
    });
    await test('duplicate evidence notification does not invalidate an otherwise current queued job', async () => {
      const { entity, job } = await queuedFor('same-evidence');
      await db.prepare('UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE origin=? AND content_id=?').bind('TEST_FIXTURE', entity.id).run();
      assert.equal(await lifecycle.execute(await jobs.claim(job, executionTime), executionTime), 'SHADOW_RECORDED');
      assert.equal(await auditCount(entity.id), 1);
      assert.equal((await db.prepare('SELECT pending FROM content_lifecycle_work WHERE content_id=?').bind(entity.id).first()).pending, 0);
    });
    await test('evidence change between preparation and atomic commit rolls back the stale plan', async () => {
      const { entity, job } = await queuedFor('commit-race'), claimed = await jobs.claim(job, executionTime);
      const originalPrepare = lifecycle.prepare.bind(lifecycle);
      lifecycle.prepare = async (contentId, time) => {
        const prepared = await originalPrepare(contentId, time);
        if (contentId === entity.id) await db.prepare("UPDATE content_lifecycle_sources SET token=?,plan=json_set(plan,'$.evidenceFingerprint',?) WHERE origin=? AND content_id=?")
          .bind(dealFingerprint('commit-race-source'), dealFingerprint('commit-race-plan'), 'TEST_FIXTURE', entity.id).run();
        return prepared;
      };
      try { await assert.rejects(() => lifecycle.execute(claimed, executionTime), /LIFECYCLE_ATOMIC_CONFLICT/); }
      finally { lifecycle.prepare = originalPrepare; }
      assert.equal(await auditCount(entity.id), 0); assert.equal((await jobs.get(job.id)).status, 'RUNNING');
      assert.equal(await lifecycle.execute(claimed, executionTime), 'STALE_JOB_NOOP');
      assert.equal(await auditCount(entity.id), 0);
      assert.equal((await db.prepare('SELECT pending FROM content_lifecycle_work WHERE content_id=?').bind(entity.id).first()).pending, 1);
    });
    await test('expired worker claim cannot write after a replacement consumer takes over', async () => {
      const { entity, job } = await queuedFor('claim-takeover'), oldClaim = await jobs.claim(job, executionTime);
      const later = executionTime + 61000, replacement = await jobs.claim(await jobs.get(job.id), later);
      assert.notEqual(replacement, null); assert.notEqual(replacement.claimToken, oldClaim.claimToken);
      await assert.rejects(() => lifecycle.execute(oldClaim, later), /LIFECYCLE_ATOMIC_CONFLICT/);
      assert.equal(await auditCount(entity.id), 0);
      assert.equal(await lifecycle.execute(replacement, later), 'SHADOW_RECORDED'); assert.equal(await auditCount(entity.id), 1);
    });
    await test('cooldown suppresses equivalent nonmaterial evidence churn without losing pending work', async () => {
      const { entity, job } = await queuedFor('cooldown');
      await lifecycle.execute(await jobs.claim(job, executionTime), executionTime);
      const source = await db.prepare('SELECT token,plan FROM content_lifecycle_sources WHERE content_id=?').bind(entity.id).first();
      const plan = { ...JSON.parse(source.plan), evidenceFingerprint: dealFingerprint('metadata-first') };
      await lifecycle.observePlan(entity.id, plan, source.token, executionTime);
      await lifecycle.materializeDue(executionTime); await lifecycle.materializeDue(executionTime + 31000);
      const pending = await db.prepare("SELECT job_id FROM content_refresh_jobs WHERE content_id=? AND outcome IS NULL").bind(entity.id).first();
      assert.notEqual(pending, null);
      await lifecycle.execute(await jobs.claim(await jobs.get(pending.job_id), executionTime + 31000), executionTime + 31000);
      const changed = await db.prepare('SELECT token,plan FROM content_lifecycle_sources WHERE content_id=?').bind(entity.id).first();
      await lifecycle.observePlan(entity.id, { ...JSON.parse(changed.plan), evidenceFingerprint: dealFingerprint('metadata-second') }, changed.token, executionTime + 32000);
      await lifecycle.materializeDue(executionTime + 32000); await lifecycle.materializeDue(executionTime + 64000);
      assert.equal((await db.prepare('SELECT count(*) AS total FROM content_refresh_jobs WHERE content_id=?').bind(entity.id).first()).total, 2);
      const work = await db.prepare('SELECT pending,due_at,cooldown_until FROM content_lifecycle_work WHERE content_id=?').bind(entity.id).first();
      assert.equal(work.pending, 1); assert.equal(work.due_at, work.cooldown_until); assert.equal(work.due_at > executionTime + 64000, true);
    });
    await test('new lifecycle algorithm rejects old queued work without audit or publication effects', async () => {
      const { entity, job } = await queuedFor('version-stale');
      const updated = new D1ContentLifecycleStore(db, fixture.decisions, fixture.opportunities, fixture.input.allowedHosts, true,
        { ...LIFECYCLE_CONFIG, algorithmVersion: 'content-lifecycle-v2' });
      assert.equal(await updated.execute(await jobs.claim(job, executionTime), executionTime), 'STALE_JOB_NOOP');
      assert.equal(await auditCount(entity.id), 0); assert.equal((await lifecycle.latest(entity.id)), null);
      assert.equal((await db.prepare('SELECT pending FROM content_lifecycle_work WHERE content_id=?').bind(entity.id).first()).pending, 1);
    });
  });
}
async function runNativeAndShopee() {
  await test('native workerd Cron and Queue retain only blocked shadow records with zero publication effect', () => withLifecycle(async fixture => {
    const { openWorker } = load('./lib/cloudflare-local.cjs'), { createD1StorageAdapter } = load('../src/lib/storage/d1/d1StorageAdapter.ts');
    const bindings = { SANDEAL_AUTOPILOT_ENABLED: 'true', SANDEAL_DEAL_INTELLIGENCE_ENABLED: 'true', SANDEAL_DECISION_OS_ENABLED: 'true',
      SANDEAL_OPPORTUNITY_ENABLED: 'true', SANDEAL_CONTENT_LIFECYCLE_ENABLED: 'true', AFFILIATE_REDIRECT_HOSTS: 'merchant.example' };
    const runtime = await openWorker({ queue: true, bindings });
    try {
      await createD1StorageAdapter(runtime.db).domain.createProduct(fixture.product);
      const env = { ...fixture.env, ...bindings, DB: runtime.db, JOB_QUEUE: { async send() {} } };
      const decisions = cloudflareDecisionStore(env, runtime.db), opportunities = cloudflareOpportunityStore(env, runtime.db, decisions);
      const now = Date.now(); await opportunities.evaluate(fixture.product.id, ['merchant.example'], now);
      const lifecycle = cloudflareContentLifecycleStore(env);
      await lifecycle.register(fixture.entity, fixture.plan, now);
      const before = await runtime.db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first();
      const worker = await runtime.mf.getWorker();
      assert.equal((await worker.scheduled({ scheduledTime: new Date(now), cron: '*/5 * * * *' })).outcome, 'ok');
      let row = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        row = await runtime.db.prepare('SELECT payload FROM content_lifecycle_audit LIMIT 1').first();
        if (row) break;
        if (attempt === 40) await worker.scheduled({ scheduledTime: new Date(Date.now()), cron: '*/5 * * * *' });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.notEqual(row, null); const evaluation = JSON.parse(row.payload); assert.equal(evaluation.plan.action, 'BLOCK'); assert.equal(evaluation.plan.executionMode, 'SHADOW');
      assert.equal(evaluation.plan.productionAllowed, false); assert.deepEqual(await runtime.db.prepare('SELECT payload FROM products WHERE id=?').bind(fixture.product.id).first(), before);
      const queueRow = await runtime.db.prepare("SELECT job_id FROM content_refresh_jobs WHERE outcome='SHADOW_RECORDED' LIMIT 1").first();
      assert.notEqual(queueRow, null); const job = await new D1JobStore(runtime.db).get(queueRow.job_id), auditBefore = await count(runtime.db, 'content_lifecycle_audit');
      const replay = await worker.queue('sandeal-local-jobs', [{ id: 'lifecycle-native-replay', timestamp: new Date(), attempts: 1, body: makeMessage(job) }]);
      assert.deepEqual(replay.explicitAcks, ['lifecycle-native-replay']); assert.equal(await count(runtime.db, 'content_lifecycle_audit'), auditBefore);
      assert.equal(await count(runtime.db, 'affiliate_money_events'), 0); assert.equal(await count(runtime.db, 'experiment_assignments'), 0); proofs.nativeWorker = evaluation;
    } finally { await runtime.dispose(); }
  }));
  await test('real AccessTrade normalization with Shopee offer replacement preserves registered content identity', () => dealFixture(async fixture => {
    const seeded = await fixture.seedShopee();
    const { verifiedPublicOffers } = load('./fixtures/v6-deal-intelligence.cjs');
    fixture.product.originalUrl = seeded.product.originalUrl; fixture.product.offers = verifiedPublicOffers(seeded.product.offers); fixture.input.allowedHosts = seeded.allowedHosts;
    for (const offer of fixture.product.offers) if (offer.monetization) { offer.monetization.validUntil = new Date(fixture.now + 28800000).toISOString(); offer.expiresAt = offer.monetization.validUntil; }
    await fixture.persist();
    const env = { ...fixture.env, SANDEAL_DECISION_OS_ENABLED: 'true', SANDEAL_OPPORTUNITY_ENABLED: 'true', SANDEAL_CONTENT_LIFECYCLE_ENABLED: 'true', AFFILIATE_REDIRECT_HOSTS: seeded.allowedHosts.join(',') };
    const decisions = cloudflareDecisionStore(env, fixture.db, true), opportunities = cloudflareOpportunityStore(env, fixture.db, decisions, true);
    const opportunity = await opportunities.evaluate(fixture.product.id, seeded.allowedHosts, fixture.now), entity = entityFor(fixture.product, fixture.now, 'shopee');
    const lifecycle = new D1ContentLifecycleStore(fixture.db, decisions, opportunities, seeded.allowedHosts, true);
    await lifecycle.register(entity, contentPlan(entity, opportunity), fixture.now);
    const stored = await fixture.adapter.domain.getProduct(fixture.product.id), product = clone(stored.value);
    for (const offer of product.offers) if (offer.monetization) { offer.monetization.id = 'replacement-accesstrade-shopee-offer'; }
    assert.equal((await fixture.adapter.domain.replaceProduct(product, stored.version)).status, 'APPLIED');
    await opportunities.evaluate(product.id, seeded.allowedHosts, fixture.now);
    const result = await lifecycle.prepare(entity.id, fixture.now);
    assert.equal(result.input.current.provider, 'accesstrade'); assert.equal(result.input.current.platform, 'shopee');
    assert.equal(result.evaluation.plan.action, 'REFRESH_CONTENT'); assert.equal(result.evaluation.contentEntityId, entity.id);
    assert.deepEqual(result.evaluation.plan.brief.canonicalTarget, entity.canonicalTarget); assert.equal(await count(fixture.db, 'content_lifecycle_sources'), 1);
    assert.equal((await fixture.shopee.healthCheck()).state, 'DISABLED_NO_CREDENTIALS'); assert.equal(directShopeeCalls, 0);
  }));
}
async function runBoundaries() {
  await test('D1 unavailable fails closed without legacy fallback', async () => {
    const broken = { prepare() { throw new Error('OFFLINE'); }, batch() { throw new Error('OFFLINE'); } };
    await assert.rejects(() => new D1ContentValueStore(broken).snapshot('valid-content', Date.now()), /D1_CONTENT_VALUE_UNAVAILABLE/);
    assert.throws(() => new D1ContentValueStore(null));
  });
  const env = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false', SANDEAL_AUTOPILOT_ENABLED: 'true',
    SANDEAL_DEAL_INTELLIGENCE_ENABLED: 'true', SANDEAL_DECISION_OS_ENABLED: 'true', SANDEAL_OPPORTUNITY_ENABLED: 'true',
    SANDEAL_CONTENT_LIFECYCLE_ENABLED: 'true', DB: {}, JOB_QUEUE: { send() {} } };
  for (const key of ['DB', 'JOB_QUEUE', 'SANDEAL_LOCAL_ONLY', 'SANDEAL_OPPORTUNITY_ENABLED', 'SANDEAL_DECISION_OS_ENABLED', 'SANDEAL_DEAL_INTELLIGENCE_ENABLED'])
    await test(`missing Cloudflare binding/prerequisite ${key} fails closed`, () => { const missing = { ...env }; delete missing[key]; assert.throws(() => validateContentLifecycleRuntime(missing)); });
  await test('production mode cannot enable lifecycle automation', () => assert.throws(() => validateContentLifecycleRuntime({ ...env, SANDEAL_PRODUCTION: 'true' })));
  await test('absent opt-in remains disabled', () => assert.throws(() => cloudflareContentLifecycleStore({ ...env, SANDEAL_CONTENT_LIFECYCLE_ENABLED: 'false' })));
  await test('test/source integrity has no skip, focused test, network or production executor', () => {
    const testSource = fs.readFileSync('scripts/v6-content-lifecycle-tests.mjs', 'utf8');
    assert.equal(new RegExp('\.' + '(?:skip|only)\\s*\\(|\\b(?:f' + 'it|fdescribe)\\s*\\(').test(testSource), false);
    for (const name of fs.readdirSync('src/lib/content/lifecycle')) {
      const source = fs.readFileSync(path.join('src/lib/content/lifecycle', name), 'utf8');
      assert.equal(/fetch\(|setInterval|while\s*\(\s*true|node:fs|publishProduct|deleteProduct|process\.env/.test(source), false);
    }
    assert.equal(directShopeeCalls, 0);
  });
}
try { await runPure(); await runDurable(); await runAttribution(); await runConcurrency(); await runBoundaries(); await runNativeAndShopee(); }
catch (error) { cases.push({ name: 'fixture setup', status: 'FAIL', error: String(error.message) }); console.error(error); }
for (const [method, original] of directMethods) ShopeeAffiliateProvider.prototype[method] = original;
const passed = cases.filter(item => item.status === 'PASS').length, failed = cases.filter(item => item.status === 'FAIL').length;
fs.mkdirSync('.test-tmp/phase8-5', { recursive: true });
fs.writeFileSync('.test-tmp/phase8-5/focused-results.json', JSON.stringify({ passed, failed, skipped: 0, directShopeeCalls, cases, proofs }, null, 2) + '\n');
console.log(`V6 Content Lifecycle: ${passed} passed, ${failed} failed, 0 skipped`); process.exitCode = failed ? 1 : 0;
