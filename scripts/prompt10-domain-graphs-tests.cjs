/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-domain-graphs-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';
require('./register-typescript.cjs');

let passed = 0; let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function reviewFixture() {
  return {
    reviewStatus: 'approved', reviewBlockReasons: [], editorialConfidence: 95,
    contentQualityScore: 94, originalityScore: 93, seoReadinessScore: 92,
  };
}

function productFixture(id = 'domain-product') {
  const now = '2026-07-16T08:00:00.000Z';
  return {
    id, schemaVersion: 2, title: `Verified headset ${id}`, slug: `verified-headset-${id}`,
    description: 'Source-backed product fixture.', kind: 'product', recordType: 'PRODUCT',
    platform: 'website', source: 'accesstrade', originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate_id=fixture`, imageUrl: `https://cdn.example/${id}.jpg`,
    price: 1500000, salePrice: 1200000, currency: 'VND', category: 'Audio', tags: [], benefits: [], warnings: [],
    riskLevel: 'low', status: 'needs_review', sourceId: `source-${id}`, sourceHash: `hash-${id}`,
    verifiedSource: true, sourceVerified: true, qualityScore: 96, duplicateStatus: 'CLEAR', evidenceCoverage: 1,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    lastSeenAt: '2026-07-16T07:00:00.000Z', priceObservedAt: '2026-07-16T07:10:00.000Z',
    linkLastCheckedAt: '2026-07-16T07:20:00.000Z', affiliateLastCheckedAt: '2026-07-16T07:30:00.000Z',
    imageLastCheckedAt: '2026-07-16T07:40:00.000Z', lifecycleUpdatedAt: '2026-07-16T07:05:00.000Z',
    brand: 'Fixture', sku: `SKU-${id}`, gtin: '1234567890123', mpn: 'MODEL-1',
    reviewContent: reviewFixture(), createdAt: now, updatedAt: now,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const classifier = require('../src/lib/autonomous/recordClassification.ts');
  const evidence = require('../src/lib/autonomous/evidenceGraph.ts');
  const confidence = require('../src/lib/autonomous/confidenceEngine.ts');
  const identity = require('../src/lib/autonomous/productIdentityGraph.ts');
  const priceTruth = require('../src/lib/autonomous/priceTruthEngine.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_DOMAIN_GRAPHS'); };
  await adapter.writeCollection('evidence-facts', []);

  await test('voucher semantics override a claimed product kind', () => {
    const result = classifier.classifyRecord({ kind: 'product', title: 'Voucher 50K cho don hang tu 500K', price: 500000, originalUrl: 'https://merchant.example/voucher' });
    assert.equal(result.recordType, 'VOUCHER'); assert.equal(result.action, 'QUARANTINE'); assert.ok(result.confidence >= 0.9);
  });

  await test('campaign and store promotion source signals override product claims', () => {
    const campaign = classifier.classifyRecord({ kind: 'product', rawSourceType: 'campaign', title: 'Mega Sale 7.7', price: 100000, originalUrl: 'https://merchant.example/campaign' });
    const store = classifier.classifyRecord({ kind: 'product', title: '[Fixture Official Store] - Giam 10% toi da 100K', price: 100000, originalUrl: 'https://merchant.example/store' });
    assert.equal(campaign.recordType, 'CAMPAIGN'); assert.equal(campaign.action, 'QUARANTINE');
    assert.equal(store.recordType, 'STORE_OFFER'); assert.equal(store.action, 'QUARANTINE');
  });

  await test('content source type overrides product claim and a complete product gets a stable versioned decision', () => {
    const content = classifier.classifyRecord({ kind: 'product', rawSourceType: 'article', title: 'Guide to choosing headphones', price: 100000, originalUrl: 'https://merchant.example/blog/guide' });
    const semanticContent = classifier.classifyRecord({ kind: 'product', title: 'Review tai nghe nao phu hop?', price: 100000, originalUrl: 'https://merchant.example/blog/review-headphones' });
    assert.equal(content.recordType, 'CATEGORY_OR_LANDING_PAGE'); assert.equal(content.action, 'QUARANTINE');
    assert.equal(semanticContent.recordType, 'CATEGORY_OR_LANDING_PAGE'); assert.equal(semanticContent.action, 'QUARANTINE');
    const input = { kind: 'product', title: 'Fixture Headset X', sku: 'X-1', price: 1200000, originalUrl: 'https://merchant.example/products/x' };
    const first = classifier.classifyRecord(input); const replay = classifier.classifyRecord({ ...input });
    assert.equal(first.recordType, 'PRODUCT'); assert.equal(first.action, 'ACCEPT');
    assert.equal(first.schemaVersion, classifier.CLASSIFICATION_SCHEMA_VERSION); assert.equal(first.ruleVersion, classifier.CLASSIFICATION_RULE_VERSION);
    assert.equal(first.decisionId, replay.decisionId);
  });

  let captured;
  await test('product evidence uses field-specific observed timestamps', async () => {
    captured = await evidence.captureProductEvidence(productFixture(), '2026-07-16T08:00:00.000Z');
    const byField = Object.fromEntries(captured.facts.map(fact => [fact.field, fact]));
    assert.equal(byField.price.observedAt, '2026-07-16T07:10:00.000Z');
    assert.equal(byField.originalUrl.observedAt, '2026-07-16T07:20:00.000Z');
    assert.equal(byField.affiliateUrl.observedAt, '2026-07-16T07:30:00.000Z');
    assert.equal(byField.imageUrl.observedAt, '2026-07-16T07:40:00.000Z');
    assert.equal(captured.coverage, 1); assert.match(captured.snapshotHash, /^[a-f0-9]{64}$/);
  });

  await test('replaying the same observation is idempotent with stable fact ids', async () => {
    const before = await adapter.readCollection('evidence-facts');
    const replay = await evidence.captureProductEvidence(productFixture(), '2026-07-16T08:00:00.000Z');
    const after = await adapter.readCollection('evidence-facts');
    assert.equal(after.length, before.length);
    assert.deepEqual(replay.facts.map(fact => fact.id).sort(), captured.facts.map(fact => fact.id).sort());
    assert.equal(replay.snapshotHash, captured.snapshotHash);
  });

  await test('AI inference cannot create a canonical fact', async () => {
    await assert.rejects(evidence.captureEvidenceFact({
      productId: 'domain-product', field: 'claim', value: 'invented', sourceType: 'AI_INFERENCE', sourceId: 'model',
      observedAt: '2026-07-16T07:00:00.000Z', verificationMethod: 'model_generation', confidence: 0.99,
      status: 'ACTIVE', expiresAt: '2026-07-17T08:00:00.000Z', ruleVersion: 'test', modelId: 'fixture-model',
    }, { capturedAt: '2026-07-16T08:00:00.000Z' }), /AI_INFERENCE_CANNOT_CREATE_CANONICAL_FACT/);
  });

  let foreignFact;
  await test('snapshot verification enforces active state, expiry, hash, and product ownership', async () => {
    foreignFact = (await evidence.captureEvidenceFact({
      productId: 'foreign-product', field: 'title', value: 'Foreign title', sourceType: 'SOURCE_API', sourceId: 'foreign-source',
      observedAt: '2026-07-16T07:00:00.000Z', verificationMethod: 'source_payload', confidence: 0.99,
      status: 'ACTIVE', expiresAt: '2026-07-17T08:00:00.000Z', ruleVersion: evidence.EVIDENCE_RULE_VERSION,
    }, { capturedAt: '2026-07-16T08:00:00.000Z' })).fact;
    const valid = await evidence.verifyEvidenceSnapshot(captured.snapshot, {
      productId: 'domain-product', requiredFields: ['title', 'price', 'originalUrl', 'affiliateUrl', 'imageUrl'], nowMs: Date.parse('2026-07-16T09:00:00.000Z'),
    });
    assert.equal(valid.valid, true, JSON.stringify(valid.reasons)); assert.equal(valid.coverage, 1);
    const injected = {
      ...captured.snapshot,
      evidenceIds: [...captured.snapshot.evidenceIds, foreignFact.id],
      factHashes: { ...captured.snapshot.factHashes, [foreignFact.id]: foreignFact.contentHash },
    };
    const ownership = await evidence.verifyEvidenceSnapshot(injected, { productId: 'domain-product', nowMs: Date.parse('2026-07-16T09:00:00.000Z') });
    assert.equal(ownership.valid, false); assert.ok(ownership.reasons.includes('snapshot_evidence_owner_mismatch'));
    const expired = await evidence.verifyEvidenceSnapshot(captured.snapshot, { productId: 'domain-product', nowMs: Date.parse('2026-07-17T09:00:00.000Z') });
    assert.equal(expired.valid, false); assert.ok(expired.reasons.includes('snapshot_expired')); assert.ok(expired.reasons.includes('snapshot_evidence_inactive_or_expired'));
  });

  await test('snapshot verification recomputes fact integrity instead of trusting a stored hash field', async () => {
    const fact = (await evidence.captureEvidenceFact({
      productId: 'integrity-product', field: 'price', value: 100000, sourceType: 'PRICE_OBSERVATION', sourceId: 'integrity-source',
      observedAt: '2026-07-16T07:00:00.000Z', verificationMethod: 'source_price_observation', confidence: 0.95,
      status: 'ACTIVE', expiresAt: '2026-07-17T08:00:00.000Z', ruleVersion: evidence.EVIDENCE_RULE_VERSION,
    }, { capturedAt: '2026-07-16T08:00:00.000Z' })).fact;
    const snapshot = evidence.buildEvidenceSnapshot('integrity-product', [fact], Date.parse('2026-07-16T08:00:00.000Z'));
    await adapter.runTransaction('evidence-facts', facts => { facts.find(item => item.id === fact.id).value = 1; return facts; });
    const verification = await evidence.verifyEvidenceSnapshot(snapshot, { productId: 'integrity-product', nowMs: Date.parse('2026-07-16T09:00:00.000Z') });
    assert.equal(verification.valid, false); assert.ok(verification.reasons.includes('snapshot_fact_integrity_mismatch'));
  });

  await test('claim validation requires active evidence owned by the same product and required field', () => {
    const title = captured.facts.find(fact => fact.field === 'title');
    const valid = evidence.validateClaimsAgainstEvidence('domain-product', [{ id: 'claim-title', field: 'title', evidenceFactIds: [title.id] }], [...captured.facts, foreignFact], { nowMs: Date.parse('2026-07-16T09:00:00.000Z') });
    assert.equal(valid.status, 'VERIFIED'); assert.equal(valid.valid, true);
    const missing = evidence.validateClaimsAgainstEvidence('domain-product', [{ id: 'claim-price', field: 'price', evidenceFactIds: [] }], captured.facts, { nowMs: Date.parse('2026-07-16T09:00:00.000Z') });
    assert.equal(missing.status, 'MISSING_EVIDENCE'); assert.ok(missing.issues.some(issue => issue.code === 'claim_evidence_missing'));
    const foreign = evidence.validateClaimsAgainstEvidence('domain-product', [{ id: 'claim-foreign', evidenceFactIds: [foreignFact.id] }], [foreignFact], { nowMs: Date.parse('2026-07-16T09:00:00.000Z') });
    assert.equal(foreign.status, 'UNSAFE'); assert.ok(foreign.issues.some(issue => issue.code === 'claim_evidence_owner_mismatch'));
  });

  await test('expiry transition is persisted and does not mutate revoked or conflicted facts', async () => {
    const expired = await evidence.expireEvidenceFacts(Date.parse('2026-07-17T09:00:00.000Z'));
    assert.ok(expired >= captured.facts.length + 1);
    const listed = await evidence.listProductEvidence('domain-product', Date.parse('2026-07-17T09:00:00.000Z'));
    assert.ok(listed.every(fact => fact.status === 'EXPIRED'));
  });

  await test('publish confidence is the named minimum dimension, never an average', () => {
    const product = productFixture('confidence');
    product.evidenceCoverage = 0.61;
    const result = confidence.calculateProductConfidences(product, { classificationConfidence: 0.96, evidenceCoverage: 0.61, now: Date.parse('2026-07-16T08:00:00.000Z') });
    const minimum = confidence.minimumPublishConfidenceDimension(result);
    assert.equal(minimum.dimension, 'contentEvidenceCoverage'); assert.equal(minimum.value, 0.61); assert.equal(result.publish, 0.61);
    assert.equal(confidence.confidenceAction(result.publish), 'CROSS_CHECK');
    assert.deepEqual([...confidence.PUBLISH_CONFIDENCE_DIMENSIONS].sort(), ['classification', 'source', 'price', 'image', 'health', 'duplicate', 'contentEvidenceCoverage', 'editorial'].sort());
  });

  await test('a non-product record cannot obtain publish confidence through an input override', () => {
    const product = productFixture('voucher-confidence'); product.recordType = 'VOUCHER';
    const result = confidence.calculateProductConfidences(product, { classificationConfidence: 1, evidenceCoverage: 1, now: Date.parse('2026-07-16T08:00:00.000Z') });
    assert.equal(result.classification, 0); assert.equal(result.publish, 0); assert.equal(confidence.confidenceAction(result.publish), 'QUARANTINE');
  });

  await test('identity hash follows the strongest key and ignores weaker field drift', () => {
    const left = identity.deriveProductIdentity(productFixture('identity-a'));
    const right = identity.deriveProductIdentity({ ...productFixture('identity-b'), title: 'Completely renamed item', originalUrl: 'https://other.example/new-url', sourceId: 'other-source' });
    assert.equal(left.identityStrategy, 'GTIN'); assert.equal(right.identityStrategy, 'GTIN');
    assert.equal(left.identityHash, right.identityHash); assert.equal(identity.identityMatchConfidence(left, right), 1);
    assert.equal(left.schemaVersion, identity.IDENTITY_SCHEMA_VERSION); assert.equal(left.ruleVersion, identity.IDENTITY_RULE_VERSION);
  });

  await test('source identifiers are namespace-scoped and outrank canonical URL', () => {
    const base = { title: 'Scoped item', sourceId: '123', originalUrl: 'https://merchant.example/a', imageUrl: 'https://cdn.example/a.jpg' };
    const left = identity.deriveProductIdentity({ ...base, source: 'accesstrade' });
    const sameSource = identity.deriveProductIdentity({ ...base, source: 'accesstrade', originalUrl: 'https://merchant.example/changed' });
    const otherSource = identity.deriveProductIdentity({ ...base, source: 'manual', title: 'Different title', originalUrl: 'https://other.example/a' });
    assert.equal(left.identityStrategy, 'SOURCE_ID'); assert.equal(left.identityHash, sameSource.identityHash);
    assert.notEqual(left.identityHash, otherSource.identityHash); assert.equal(identity.identityMatchConfidence(left, otherSource), 0);
  });

  await test('canonical URL removes tracking noise deterministically', () => {
    const first = identity.canonicalizeProductUrl('https://WWW.Merchant.Example/item/1/?utm_source=x&b=2&a=1#section');
    const second = identity.canonicalizeProductUrl('https://www.merchant.example/item/1?a=1&b=2&utm_campaign=y');
    assert.equal(first, second);
  });

  await test('price truth emits factual freshness states and rejects unavailable prices', () => {
    const now = Date.parse('2026-07-16T10:00:00.000Z');
    const observation = observedAt => [{
      sourceId: 'source-a', value: 1000000, currency: 'VND', observedAt,
      evidenceFactIds: ['price-fact-a'], verified: true, confidence: 0.95,
    }];
    assert.equal(priceTruth.evaluatePriceTruth({}, observation('2026-07-16T09:00:00.000Z'), now).state, 'FRESH');
    assert.equal(priceTruth.evaluatePriceTruth({}, observation('2026-07-14T10:00:00.000Z'), now).state, 'AGING');
    assert.equal(priceTruth.evaluatePriceTruth({}, observation('2026-07-12T09:00:00.000Z'), now).state, 'STALE');
    assert.equal(priceTruth.evaluatePriceTruth({}, [{ sourceId: 'source-a', value: 0, currency: 'VND', observedAt: '2026-07-16T09:00:00.000Z', verified: true }], now).state, 'UNAVAILABLE');
    assert.equal(priceTruth.evaluatePriceTruth({}, [{ sourceId: 'source-a', value: -1, currency: 'VND', observedAt: '2026-07-16T09:00:00.000Z', verified: true }], now).state, 'UNAVAILABLE');
  });

  await test('price conflicts and large changes require cross-check instead of producing a public price', () => {
    const now = Date.parse('2026-07-16T10:00:00.000Z');
    const base = { currency: 'VND', verified: true, confidence: 0.95, evidenceFactIds: ['price-fact'] };
    const conflicted = priceTruth.evaluatePriceTruth({}, [
      { ...base, sourceId: 'source-a', value: 1000000, observedAt: '2026-07-16T09:00:00.000Z' },
      { ...base, sourceId: 'source-b', value: 1500000, observedAt: '2026-07-16T09:05:00.000Z' },
    ], now);
    assert.equal(conflicted.state, 'CONFLICTED'); assert.equal(conflicted.requiresCrossCheck, true); assert.equal(conflicted.effectivePrice, undefined);
    const anomalous = priceTruth.evaluatePriceTruth({}, [
      { ...base, sourceId: 'source-a', value: 2000000, observedAt: '2026-07-15T09:00:00.000Z' },
      { ...base, sourceId: 'source-a', value: 900000, observedAt: '2026-07-16T09:00:00.000Z' },
    ], now);
    assert.equal(anomalous.state, 'ANOMALOUS'); assert.equal(anomalous.requiresCrossCheck, true); assert.equal(anomalous.effectivePrice, undefined);
  });

  await test('discount is emitted only when current and original prices both carry evidence', () => {
    const now = Date.parse('2026-07-16T10:00:00.000Z');
    const current = { sourceId: 'source-a', value: 800000, currency: 'VND', observedAt: '2026-07-16T09:00:00.000Z', evidenceFactIds: ['current-price'], verified: true, kind: 'CURRENT' };
    const evidenced = priceTruth.evaluatePriceTruth({}, [
      current,
      { sourceId: 'source-a', value: 1000000, currency: 'VND', observedAt: '2026-07-16T09:00:00.000Z', evidenceFactIds: ['original-price'], verified: true, kind: 'ORIGINAL' },
    ], now);
    assert.equal(evidenced.discountPercent, 20);
    const missingOriginalEvidence = priceTruth.evaluatePriceTruth({}, [
      current,
      { sourceId: 'source-a', value: 1000000, currency: 'VND', observedAt: '2026-07-16T09:00:00.000Z', verified: true, kind: 'ORIGINAL' },
    ], now);
    assert.equal(missingOriginalEvidence.discountPercent, undefined);
    assert.ok(missingOriginalEvidence.reasons.includes('discount_evidence_incomplete'));
  });

  await test('offer observation replay dedupes while a newer price replaces the same offer', () => {
    const oldProduct = productFixture('offer'); delete oldProduct.gtin;
    const oldOffer = identity.buildOffer(oldProduct, '2026-07-16T08:00:00.000Z');
    const replay = identity.buildOffer({ ...oldProduct }, '2026-07-16T08:00:00.000Z');
    const newer = identity.buildOffer({ ...oldProduct, salePrice: 1100000 }, '2026-07-16T09:00:00.000Z');
    assert.equal(oldOffer.id, replay.id); assert.equal(oldOffer.observationHash, replay.observationHash);
    assert.equal(newer.id, oldOffer.id); assert.notEqual(newer.observationHash, oldOffer.observationHash);
    const merged = identity.mergeOffers([oldOffer], [replay, newer, oldOffer]);
    assert.equal(merged.length, 1); assert.equal(merged[0].price, 1100000); assert.equal(merged[0].observedAt, '2026-07-16T09:00:00.000Z');
    const selected = identity.selectBestPublicOffer(merged, Date.parse('2026-07-16T10:00:00.000Z'));
    assert.equal(selected.bestOffer.id, merged[0].id); assert.equal(selected.offers.filter(offer => offer.primary).length, 1);
  });

  console.log(`\nPROMPT10 Gate 4 domain graphs: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
