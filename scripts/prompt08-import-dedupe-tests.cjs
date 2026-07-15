/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testAuthValue = ['local', 'only', 'value'].join('-');

const tempDir = path.join(process.cwd(), '.test-tmp', `sandeal-prompt08-import-dedupe-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt08-import-test';
process.env.BASIC_AUTH_PASSWORD = testAuthValue;
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';

require('./register-typescript.cjs');

const auth = `Basic ${Buffer.from(`prompt08-import-test:${testAuthValue}`).toString('base64')}`;
const jsonHeaders = { authorization: auth, 'content-type': 'application/json' };
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

function product(id, overrides = {}) {
  const now = '2026-07-14T03:00:00.000Z';
  return {
    id,
    title: `Sản phẩm ${id}`,
    slug: id,
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    price: 1_000_000,
    currency: 'VND',
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'unknown',
    status: 'needs_review',
    publicHidden: true,
    needsVerification: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const importer = require('../src/lib/product-intelligence/importer.ts');
  const dedupe = require('../src/lib/product-intelligence/dedupe.ts');
  const productsStore = require('../src/lib/storage/products.ts');
  const importRoute = require('../src/app/api/dashboard/import/route.ts');
  const qualityRoute = require('../src/app/api/dashboard/quality/route.ts');
  const automationStore = require('../src/lib/automation/store.ts');
  const { NextRequest } = require('next/server');

  async function reset(...collections) {
    for (const collection of collections) await adapter.writeCollection(collection, []);
  }

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_IMPORT_DEDUPE_TEST'); };

  await test('manual preview validates URL without fetching or storing anything', async () => {
    await reset('pending-manual-sources', 'products');
    const unsafe = importer.previewManualUrl('http://127.0.0.1/private');
    assert.equal(unsafe.valid, false);
    assert.equal(unsafe.publicSideEffect, false);
    const safe = importer.previewManualUrl('https://merchant.example/product/one?utm_source=test');
    assert.equal(safe.valid, true);
    assert.equal(safe.adapterSupported, false);
    assert.equal(safe.status, 'metadata_required');
    assert.equal(safe.publicSideEffect, false);
    assert.equal((await adapter.readCollection('pending-manual-sources')).length, 0);
    assert.equal((await productsStore.getAllProducts()).length, 0);
  });

  await test('explicit manual metadata submission creates one bounded pending source and remains idempotent', async () => {
    await reset('pending-manual-sources', 'products');
    const first = await importer.submitPendingManualSource({
      url: 'https://merchant.example/product/one?utm_source=test',
      title: 'Sản phẩm nhập thủ công',
      price: '199000',
      category: 'Âm thanh',
    }, { actor: 'prompt08-test', operationId: 'manual-operation-one' });
    const second = await importer.submitPendingManualSource({
      url: 'https://merchant.example/product/one',
      title: 'Sản phẩm nhập thủ công đã cập nhật',
      price: 199000,
    }, { actor: 'prompt08-test', operationId: 'manual-operation-two' });
    const stored = await importer.listPendingManualSources(100);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'pending_review');
    assert.equal(stored[0].metadataSubmitted, true);
    assert.equal(stored[0].adapterSupported, false);
    assert.equal(stored[0].publicSideEffect, false);
    assert.equal((await productsStore.getAllProducts()).length, 0);
    await assert.rejects(
      importer.submitPendingManualSource({ url: 'https://merchant.example/two', title: 'Hợp lệ', imageUrl: 'http://169.254.169.254/private' }, { actor: 'test', operationId: 'unsafe-image' }),
      /IMAGE_URL_PRIVATE_NETWORK/,
    );
  });

  await test('manual import API requires metadata before storing and writes a sanitized audit', async () => {
    await reset('pending-manual-sources', 'products', 'automation-audit');
    const preview = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ mode: 'manual', url: 'https://merchant.example/api-item' }),
    }));
    assert.equal(preview.status, 200);
    assert.equal((await adapter.readCollection('pending-manual-sources')).length, 0);
    const submitted = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ mode: 'manual_submit', url: 'https://merchant.example/api-item', metadata: { title: 'Nguồn chờ API', brand: 'Merchant' } }),
    }));
    assert.equal(submitted.status, 201);
    const body = await submitted.json();
    assert.equal(body.data.source.publicSideEffect, false);
    assert.equal((await productsStore.getAllProducts()).length, 0);
    const audits = await adapter.readCollection('automation-audit');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operationType, 'MANUAL_SOURCE_SUBMITTED');
    assert.equal(JSON.stringify(audits).includes('authorization'), false);
  });

  await test('duplicate review persists keep/ignore reason and operation history without changing products', async () => {
    await reset('products', 'duplicate-groups');
    const left = product('review-left');
    const right = product('review-right');
    const group = {
      id: 'dup-review', productIds: [left.id, right.id], candidates: [{ productId: right.id, confidence: 0.8, matchedSignals: ['title'], differentSignals: ['price'], reason: 'Cần người xem xét.' }],
      suggestedPrimaryId: left.id, confidence: 0.8, status: 'pending', calculatedAt: left.updatedAt,
      algorithmVersion: 'duplicate-v1', operationId: 'detect-operation',
    };
    await adapter.writeCollection('products', [left, right]);
    await adapter.writeCollection('duplicate-groups', [group]);
    const before = await productsStore.getAllProducts();
    const reviewed = await dedupe.reviewDuplicateGroup(group.id, 'kept_separate', 'Khác model và mức giá.', { actor: 'prompt08-test', operationId: 'review-operation' });
    assert.equal(reviewed.status, 'kept_separate');
    assert.equal(reviewed.reviewHistory.length, 1);
    assert.equal(reviewed.reviewHistory[0].operationId, 'review-operation');
    assert.deepEqual(await productsStore.getAllProducts(), before);
  });

  await test('quality API paginates, reports complete summary and omits merge metadata backups', async () => {
    await reset('products', 'duplicate-groups');
    const products = Array.from({ length: 25 }, (_, index) => product(`quality-${index}`, {
      qualityScore: index,
      qualityBand: index === 0 ? 'poor' : 'fair',
    }));
    await adapter.writeCollection('products', products);
    await adapter.writeCollection('duplicate-groups', [{
      id: 'dup-dto', productIds: ['quality-0', 'quality-1'], candidates: [{ productId: 'quality-1', confidence: 0.98, matchedSignals: ['canonical_url'], differentSignals: [], reason: 'Trùng URL.' }],
      suggestedPrimaryId: 'quality-0', confidence: 0.98, status: 'pending', calculatedAt: products[0].updatedAt,
      algorithmVersion: 'duplicate-v1', operationId: 'detect-dto',
      mergeHistory: [{ operationId: 'old-merge', primaryId: 'quality-0', secondaryIds: ['quality-1'], metadataBackup: [{ ...products[1], rawData: { secret: 'MUST_NOT_LEAK' } }], mergedAt: products[0].updatedAt }],
    }]);
    const response = await qualityRoute.GET(new NextRequest('http://localhost/api/dashboard/quality?page=2&pageSize=10', { headers: { authorization: auth } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.items.length, 10);
    assert.equal(body.data.pagination.page, 2);
    assert.equal(body.data.pagination.totalItems, 25);
    assert.equal(body.data.summary.averageQualityScore, 12);
    assert.equal(body.data.summary.poor, 1);
    assert.equal(body.data.summary.suspectedDuplicates, 2);
    assert.equal(body.data.duplicateGroups[0].hasMergeHistory, true);
    assert.equal(Object.hasOwn(body.data.duplicateGroups[0], 'mergeHistory'), false);
    assert.equal(JSON.stringify(body).includes('MUST_NOT_LEAK'), false);
  });

  await test('merge preview has no side effect and merge apply only queues HIGH approval', async () => {
    await reset('products', 'duplicate-groups', 'automation-jobs', 'automation-control', 'automation-audit');
    const primary = product('merge-primary', { source: 'csv', sourceId: 'same-id', qualityScore: 90, sourceHash: 'primary-provenance', description: undefined });
    const secondary = product('merge-secondary', { source: 'csv', sourceId: 'same-id', qualityScore: 30, sourceHash: 'secondary-provenance', description: 'Metadata bổ sung.' });
    await adapter.writeCollection('products', [primary, secondary]);
    const detected = await dedupe.detectDuplicateGroups(await productsStore.getAllProducts(), 'detect-merge');
    const group = detected.groups[0];
    const before = await productsStore.getAllProducts();
    const previewResponse = await qualityRoute.POST(new NextRequest('http://localhost/api/dashboard/quality', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ action: 'merge_preview', groupId: group.id, primaryId: primary.id }),
    }));
    assert.equal(previewResponse.status, 200);
    const previewBody = await previewResponse.json();
    assert.equal(previewBody.data.businessDataChanged, false);
    assert.equal(Object.hasOwn(previewBody.data, 'merged'), false);
    assert.deepEqual(await productsStore.getAllProducts(), before);
    const applyResponse = await qualityRoute.POST(new NextRequest('http://localhost/api/dashboard/quality', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ action: 'merge_apply', groupId: group.id, primaryId: primary.id, confirmed: true, idempotencyKey: 'merge-high-approval-test' }),
    }));
    assert.equal(applyResponse.status, 201);
    const jobs = await automationStore.getAllAutomationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].riskLevel, 'HIGH');
    assert.equal(jobs[0].status, 'WAITING_APPROVAL');
    assert.equal(jobs[0].approvalStatus, 'PENDING');
    assert.deepEqual(await productsStore.getAllProducts(), before);
  });

  global.fetch = originalFetch;
  console.log(`\nPrompt08 import/dedupe targeted: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(error => {
    failed += 1;
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
