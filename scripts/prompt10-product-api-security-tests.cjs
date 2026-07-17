/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const password = ['prompt10', 'product', 'security'].join('-');
const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-product-api-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt10-product-api';
process.env.BASIC_AUTH_PASSWORD = password;
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

const auth = `Basic ${Buffer.from(`prompt10-product-api:${password}`).toString('base64')}`;
const headers = { authorization: auth, 'content-type': 'application/json' };
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

function fixture(editorial) {
  const now = new Date().toISOString();
  const base = {
    schemaVersion: 2,
    id: 'secured-product',
    title: 'Tai nghe Bluetooth fixture',
    slug: 'tai-nghe-bluetooth-fixture',
    description: 'Du lieu san pham da duoc xac minh tu nguon fixture.',
    kind: 'product',
    recordType: 'PRODUCT',
    lifecycleState: 'PUBLISHED',
    lifecycleVersion: 'product-lifecycle-v1',
    lifecycleUpdatedAt: now,
    platform: 'website',
    source: 'manual',
    sourceId: 'secured-source',
    originalUrl: 'https://merchant.example/products/secured-product',
    affiliateUrl: 'https://merchant.example/go/secured-product',
    imageUrl: 'https://merchant.example/images/secured-product.jpg',
    price: 1_200_000,
    salePrice: 1_000_000,
    currency: 'VND',
    category: 'Audio',
    brand: 'Fixture',
    sku: 'FIXTURE-SECURE',
    specifications: { connection: 'Bluetooth', warranty: '12 months' },
    tags: ['audio'], benefits: [], warnings: [],
    riskLevel: 'low',
    status: 'published',
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: true,
    publicHidden: false,
    publicDecision: 'published',
    publicBlockReasons: [],
    autoPublished: true,
    needsVerification: false,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    linkLastCheckedAt: now,
    affiliateLastCheckedAt: now,
    imageLastCheckedAt: now,
    duplicateStatus: 'CLEAR',
    claimValidationStatus: 'VERIFIED',
    evidenceFactIds: ['fact-title', 'fact-price', 'fact-source'],
    evidenceCoverage: 0.95,
    evidenceSnapshotAt: now,
    evidenceSnapshotHash: 'fixture-evidence-snapshot',
    confidences: {
      classification: 0.99, source: 0.99, price: 0.97, image: 0.97, health: 0.97,
      duplicate: 0.99, contentEvidenceCoverage: 0.95, editorial: 0.93, publish: 0.94,
      calculatedAt: now, ruleVersion: 'confidence-v1',
    },
    identity: {
      sourceId: 'secured-source', canonicalUrl: 'https://merchant.example/products/secured-product',
      affiliateUrl: 'https://merchant.example/go/secured-product', sku: 'FIXTURE-SECURE',
      brand: 'Fixture', normalizedTitle: 'tai nghe bluetooth fixture', merchant: 'merchant.example',
      imageFingerprint: 'fixture-image', identityHash: 'fixture-identity', ruleVersion: 'identity-v1',
    },
    offers: [],
    priceTruthState: 'FRESH',
    priceObservedAt: now,
    publicationEffectKey: 'published-effect-fixture',
    publicationJobId: 'publish-job-fixture',
    publishedAt: now,
    sourceHash: 'secured-source-hash',
    contentHash: 'secured-content-hash',
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, reviewContent: editorial.generateEditorialReview(base, [], now) };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const route = require('../src/app/api/products/[id]/route.ts');
  const store = require('../src/lib/automation/store.ts');
  const { NextRequest } = require('next/server');

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PRODUCT_API_SECURITY_TEST'); };

  async function seed() {
    for (const collection of ['products', 'automation-jobs', 'automation-control', 'automation-audit', 'automation-circuits', 'automation-ai-usage']) {
      await adapter.writeCollection(collection, []);
    }
    await adapter.writeCollection('products', [fixture(editorial)]);
  }

  function patch(body, withAuth = true) {
    return route.PATCH(new NextRequest('http://localhost/api/products/secured-product', {
      method: 'PATCH',
      headers: withAuth ? headers : { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: 'secured-product' }) });
  }

  await test('anonymous product mutation is denied without storage changes', async () => {
    await seed();
    const before = JSON.stringify(await adapter.readCollection('products'));
    const response = await patch({ title: 'Forged anonymous title' }, false);
    assert.equal(response.status, 401);
    assert.equal(JSON.stringify(await adapter.readCollection('products')), before);
    assert.deepEqual(await store.getAllAutomationJobs(), []);
  });

  const reservedCases = [
    ['record type', { recordType: 'PRODUCT' }],
    ['lifecycle', { lifecycleState: 'READY_FOR_PUBLISH' }],
    ['evidence', { evidenceCoverage: 1, evidenceFactIds: ['forged'] }],
    ['confidence', { confidences: { publish: 1 } }],
    ['identity', { identity: { identityHash: 'forged' } }],
    ['offers', { offers: [{ id: 'forged' }], bestOfferId: 'forged' }],
    ['price truth', { priceTruthState: 'FRESH', priceObservedAt: new Date().toISOString() }],
    ['duplicate', { duplicateStatus: 'CLEAR' }],
    ['claim', { claimValidationStatus: 'VERIFIED' }],
    ['publication', { status: 'published', publicHidden: false, publicationEffectKey: 'forged' }],
    ['health', { linkHealthStatus: 'ok', linkLastCheckedAt: new Date().toISOString() }],
    ['readiness', { autoPublishEligible: true, needsVerification: false, readinessSnapshotHash: 'forged' }],
    ['related job', { relatedJobId: 'forged-job' }],
    ['mixed safe and forged', { title: 'Attempted mixed edit', evidenceSnapshotHash: 'forged' }],
  ];

  for (const [name, body] of reservedCases) {
    await test(`reserved ${name} fields are atomically read-only`, async () => {
      await seed();
      const beforeProducts = JSON.stringify(await adapter.readCollection('products'));
      const beforeJobs = JSON.stringify(await store.getAllAutomationJobs());
      const response = await patch(body);
      assert.equal(response.status, 409);
      const payload = await response.json();
      assert.equal(payload.code, 'AUTONOMOUS_FIELDS_READ_ONLY');
      assert.equal(payload.error, 'AUTONOMOUS_FIELDS_READ_ONLY');
      assert.ok(payload.fields.length >= 1);
      assert.equal(JSON.stringify(await adapter.readCollection('products')), beforeProducts);
      assert.equal(JSON.stringify(await store.getAllAutomationJobs()), beforeJobs);
    });
  }

  await test('unknown and malformed owner fields are rejected without mutation', async () => {
    await seed();
    const before = JSON.stringify(await adapter.readCollection('products'));
    const unknown = await patch({ arbitraryServerFlag: true });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'PRODUCT_FIELDS_NOT_EDITABLE');
    const malformed = await patch({ title: { forged: true } });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'PRODUCT_FIELDS_NOT_EDITABLE');
    assert.equal(JSON.stringify(await adapter.readCollection('products')), before);
    assert.deepEqual(await store.getAllAutomationJobs(), []);
  });

  await test('unsafe URLs and inconsistent prices are rejected before storage', async () => {
    await seed();
    const before = JSON.stringify(await adapter.readCollection('products'));
    const unsafeUrl = await patch({ originalUrl: 'http://127.0.0.1/internal' });
    assert.equal(unsafeUrl.status, 400);
    assert.equal((await unsafeUrl.json()).code, 'PRODUCT_FIELDS_NOT_EDITABLE');
    const unsafeCredentials = await patch({ imageUrl: 'https://user:password@merchant.example/image.jpg' });
    assert.equal(unsafeCredentials.status, 400);
    const priceConflict = await patch({ price: 900_000, salePrice: 950_000 });
    assert.equal(priceConflict.status, 400);
    assert.equal((await priceConflict.json()).field, 'salePrice');
    assert.equal(JSON.stringify(await adapter.readCollection('products')), before);
    assert.deepEqual(await store.getAllAutomationJobs(), []);
  });

  await test('safe factual edit invalidates readiness and enqueues durable re-verification', async () => {
    await seed();
    const response = await patch({
      title: 'Tai nghe Bluetooth fixture da cap nhat',
      originalUrl: 'https://merchant.example/products/secured-product-v2',
      price: 1_150_000,
      salePrice: 950_000,
      currency: 'VND',
      tags: 'audio, verified edit, audio',
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    const product = (await adapter.readCollection('products'))[0];
    assert.equal(product.title, 'Tai nghe Bluetooth fixture da cap nhat');
    assert.equal(product.originalUrl, 'https://merchant.example/products/secured-product-v2');
    assert.equal(product.price, 1_150_000);
    assert.deepEqual(product.tags, ['audio', 'verified edit']);
    assert.equal(product.status, 'needs_review');
    assert.equal(product.publicHidden, true);
    assert.equal(product.autoPublishEligible, false);
    assert.equal(product.needsVerification, true);
    assert.deepEqual(product.evidenceFactIds, []);
    assert.equal(product.evidenceCoverage, 0);
    assert.equal(product.evidenceSnapshotAt, undefined);
    assert.equal(product.confidences, undefined);
    assert.equal(product.claimValidationStatus, 'MISSING_EVIDENCE');
    assert.equal(product.duplicateStatus, 'UNRESOLVED');
    assert.equal(product.priceTruthState, 'STALE');
    assert.equal(product.linkHealthStatus, 'unverified');
    assert.equal(product.sourceVerified, false);
    assert.equal(product.reviewContent.reviewStatus, 'stale');
    assert.ok(product.publicBlockReasons.includes('owner_factual_edit_requires_reverification'));
    assert.ok(product.relatedJobId);
    assert.equal(product.nextAutomaticAction, 'RECHECK_PRODUCT_HEALTH');
    assert.equal(product.publicationEffectKey, 'published-effect-fixture');
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, product.relatedJobId);
    assert.equal(jobs[0].type, 'RECHECK_PRODUCT_HEALTH');
    assert.deepEqual(jobs[0].payload.productIds, ['secured-product']);
    assert.equal(jobs[0].status, 'PENDING');
  });

  await test('no-op factual edit does not create a verification job', async () => {
    await seed();
    const response = await patch({ title: 'Tai nghe Bluetooth fixture', currency: 'VND' });
    assert.equal(response.status, 200);
    assert.deepEqual(await store.getAllAutomationJobs(), []);
    const product = (await adapter.readCollection('products'))[0];
    assert.equal(product.status, 'published');
    assert.equal(product.publicHidden, false);
    assert.equal(product.evidenceCoverage, 0.95);
  });

  console.log(`\nPROMPT10 product API security: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
