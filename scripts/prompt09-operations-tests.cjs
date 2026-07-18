/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testAuthValue = ['workspace', 'fixture', 'only'].join('-');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt09-phase-b-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt09-operations-test';
process.env.BASIC_AUTH_PASSWORD = testAuthValue;
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';

require('./register-typescript.cjs');

const auth = `Basic ${Buffer.from(`prompt09-operations-test:${testAuthValue}`).toString('base64')}`;
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

function product(id = 'operations-product', overrides = {}) {
  const now = new Date().toISOString();
  return {
    id,
    title: `Verified fixture ${id}`,
    slug: `verified-fixture-${id}`,
    description: 'Source-backed fixture used only in isolated workspace tests.',
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=fixture`,
    imageUrl: `https://merchant.example/images/${id}.jpg`,
    price: 1500000,
    salePrice: 1200000,
    currency: 'VND',
    category: 'Audio',
    brand: 'Fixture',
    sku: `SKU-${id}`,
    specifications: { connection: 'Bluetooth' },
    tags: [], benefits: [], warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: false,
    publicHidden: true,
    needsVerification: true,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    linkLastCheckedAt: now,
    imageLastCheckedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const onboarding = require('../src/lib/operations/onboarding.ts');
  const dashboard = require('../src/lib/automation/dashboard.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const products = require('../src/lib/storage/products.ts');
  const candidateQueue = require('../src/lib/storage/candidateQueue.ts');
  const contentStudio = require('../src/lib/product-intelligence/contentStudio.ts');
  const alerts = require('../src/lib/product-intelligence/alerts.ts');
  const onboardingRoute = require('../src/app/api/automation/onboarding/route.ts');
  const importRoute = require('../src/app/api/dashboard/import/route.ts');
  const contentRoute = require('../src/app/api/dashboard/content/route.ts');
  const alertsRoute = require('../src/app/api/dashboard/alerts/route.ts');
  const bulkRoute = require('../src/app/api/dashboard/bulk/route.ts');
  const qualityRoute = require('../src/app/api/dashboard/quality/route.ts');
  const archiveRoute = require('../src/app/api/products/[id]/archive/route.ts');
  const productRoute = require('../src/app/api/products/[id]/route.ts');
  const { NextRequest } = require('next/server');

  const collections = [
    'products', 'product-sources', 'pending-manual-sources', 'content-drafts', 'product-alerts',
    'outbound-events', 'price-history', 'import-batches', 'duplicate-groups', 'automation-jobs',
    'automation-control', 'automation-audit', 'automation-ai-usage', 'automation-circuits',
    'automation-manual-tasks', 'automation-settings',
  ];
  async function reset() {
    for (const collection of collections) await adapter.writeCollection(collection, []);
  }

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT09_PHASE_B'); };

  await test('zero-data onboarding and dashboard are server-derived', async () => {
    await reset();
    const state = await onboarding.buildOperationsOnboarding();
    assert.equal(state.hasOperationalData, false);
    assert.equal(state.compact, false);
    assert.equal(state.steps.length, 10);
    assert.ok(state.recommendations.length <= 5);
    assert.equal(state.steps.find(item => item.id === 'import').status, 'NOT_STARTED');
    assert.equal(state.steps.find(item => item.id === 'quality').status, 'BLOCKED');
    const view = await dashboard.buildAutomationDashboard('7d');
    assert.equal(view.zeroData, true);
    assert.equal(view.kpis.completionRate, null);
    assert.equal(Number.isNaN(view.kpis.completionRate), false);
    assert.ok(view.onboarding.recommendations.length <= 5);
  });

  await test('onboarding API requires auth and returns no credential values', async () => {
    assert.equal((await onboardingRoute.GET(new NextRequest('http://localhost/api/automation/onboarding'))).status, 401);
    const response = await onboardingRoute.GET(new NextRequest('http://localhost/api/automation/onboarding', { headers: { authorization: auth } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.hasOperationalData, false);
    assert.equal(JSON.stringify(body).match(/password|authorization|apiKey|encryptedValue/i), null);
  });

  await test('CSV preview validates partial rows and apply only enqueues import', async () => {
    await reset();
    const csv = [
      'name,url,cost,platform,source',
      '=2+2,https://merchant.example/items/one,199000,website,csv',
      'Unsafe row,http://127.0.0.1/private,100000,website,csv',
    ].join('\n');
    const previewResponse = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
      method: 'POST', headers,
      body: JSON.stringify({ mode: 'preview', csv, mapping: { title: 'name', originalUrl: 'url', price: 'cost' } }),
    }));
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).data;
    assert.equal(preview.totalRows, 2);
    assert.equal(preview.validRows, 1);
    assert.equal(preview.invalidRows, 1);
    assert.equal(preview.rows[0].normalized.title, "'=2+2");
    assert.equal(preview.publicSideEffect, false);
    assert.equal((await products.getAllProducts()).length, 0);

    const apply = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
      method: 'POST', headers,
      body: JSON.stringify({ mode: 'apply', previewId: preview.previewId, idempotencyKey: 'prompt09-import-apply-001' }),
    }));
    assert.equal(apply.status, 201);
    const job = (await store.getAllAutomationJobs())[0];
    assert.equal(job.type, 'IMPORT_PRODUCTS');
    assert.equal(job.botId, 'PRODUCT_NORMALIZER');
    assert.equal(job.capability, 'NORMALIZE_PRODUCT');
    assert.ok(job.executionPlan.length > 0);
    assert.equal((await products.getAllProducts()).length, 0);
    const run = await worker.processAutomationBatch('prompt09-import-worker', 1);
    assert.equal(run.waitingChildren, 1);
    const queuedCandidates = await candidateQueue.listCandidateQueue();
    assert.equal(queuedCandidates.length, 1);
    assert.equal(queuedCandidates[0].durableJobId.length > 0, true);
    const child = (await store.getAllAutomationJobs()).find(item => item.type === 'PROCESS_CANDIDATE');
    assert.equal(child.parentJobId, job.id);
    assert.equal(child.status, 'PENDING');
    assert.equal((await products.getAllProducts()).length, 0);
  });

  await test('manual URL SSRF is blocked without network or fake success', async () => {
    const blocked = await importRoute.POST(new NextRequest('http://localhost/api/dashboard/import', {
      method: 'POST', headers, body: JSON.stringify({ mode: 'manual', url: 'http://169.254.169.254/latest/meta-data' }),
    }));
    assert.equal(blocked.status, 400);
    const body = await blocked.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'UNSAFE_URL');
  });

  await test('content local fallback is a durable job with aiRequests zero', async () => {
    await reset();
    const source = product('content-local');
    await adapter.writeCollection('products', [source]);
    const queued = await contentRoute.POST(new NextRequest('http://localhost/api/dashboard/content', {
      method: 'POST', headers, body: JSON.stringify({ action: 'create_local', productId: source.id, idempotencyKey: 'prompt09-content-local-001' }),
    }));
    assert.equal(queued.status, 202);
    assert.equal((await contentStudio.listContentDrafts()).length, 0);
    const job = (await store.getAllAutomationJobs())[0];
    assert.equal(job.type, 'PREPARE_CONTENT_DRAFT');
    assert.equal(job.requestedExecutionMode, 'LOCAL_ONLY');
    const run = await worker.processAutomationBatch('prompt09-content-worker', 1);
    assert.equal(run.succeeded, 1);
    const completed = await store.getAutomationJob(job.id);
    assert.equal(completed.disclosure.aiRequests, 0);
    assert.equal(completed.disclosure.executionMode, 'LOCAL_TEMPLATE');
    assert.equal(completed.outcomeStatus, 'COMPLETED_WITH_LOCAL_TEMPLATE');
    const drafts = await contentStudio.listContentDrafts();
    assert.equal(drafts.length, 1);
    assert.equal((await products.getProductById(source.id)).status, 'needs_review');

    const check = await contentRoute.POST(new NextRequest('http://localhost/api/dashboard/content', {
      method: 'POST', headers, body: JSON.stringify({ action: 'check', draftId: drafts[0].id, idempotencyKey: 'prompt09-editorial-check-001' }),
    }));
    assert.equal(check.status, 202);
    assert.equal((await store.getAllAutomationJobs()).filter(item => item.type === 'EDITORIAL_CHECK').length, 1);
  });

  await test('product archive and bulk high-risk actions wait for approval', async () => {
    await reset();
    const source = product('archive-target');
    await adapter.writeCollection('products', [source]);
    const archive = await archiveRoute.POST(new NextRequest(`http://localhost/api/products/${source.id}/archive`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'Reviewed archive request', idempotencyKey: 'prompt09-archive-001' }),
    }), { params: Promise.resolve({ id: source.id }) });
    assert.equal(archive.status, 202);
    const archiveJob = (await store.getAllAutomationJobs())[0];
    assert.equal(archiveJob.status, 'WAITING_APPROVAL');
    assert.equal(archiveJob.capability, 'ARCHIVE_PRODUCT');
    assert.equal((await products.getProductById(source.id)).status, 'needs_review');
    assert.equal((await worker.processAutomationBatch('prompt09-unapproved-worker', 2)).claimed, 0);

    const preview = await bulkRoute.POST(new NextRequest('http://localhost/api/dashboard/bulk', {
      method: 'POST', headers, body: JSON.stringify({ action: 'archive', productIds: [source.id] }),
    }));
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).data.requiresApproval, true);
    const apply = await bulkRoute.POST(new NextRequest('http://localhost/api/dashboard/bulk', {
      method: 'POST', headers, body: JSON.stringify({ mode: 'apply', action: 'archive', productIds: [source.id], confirmed: true, idempotencyKey: 'prompt09-bulk-archive-001' }),
    }));
    assert.equal(apply.status, 201);
    const applyBody = await apply.json();
    const bulkJob = (await store.getAllAutomationJobs()).find(item => item.id === applyBody.data.jobId);
    assert.equal(bulkJob.status, 'WAITING_APPROVAL');
    assert.equal(bulkJob.capability, 'BULK_ARCHIVE');
    assert.ok(bulkJob.executionPlan.length > 0);
    assert.equal((await products.getProductById(source.id)).status, 'needs_review');
  });

  await test('quality actions enqueue registered jobs and low-risk review does not merge', async () => {
    await reset();
    const left = product('quality-left');
    const right = product('quality-right');
    await adapter.writeCollection('products', [left, right]);
    const queued = await qualityRoute.POST(new NextRequest('http://localhost/api/dashboard/quality', {
      method: 'POST', headers, body: JSON.stringify({ action: 'detect_duplicates', productIds: [left.id, right.id], idempotencyKey: 'prompt09-dedupe-001' }),
    }));
    assert.equal(queued.status, 201);
    const job = (await store.getAllAutomationJobs())[0];
    assert.equal(job.botId, 'DUPLICATE_RESOLVER');
    assert.equal(job.capability, 'DETECT_DUPLICATES');
    assert.ok(job.executionPlan.length > 0);
    assert.equal((await products.getAllProducts()).filter(item => item.status === 'archived').length, 0);
  });

  await test('alert evaluation is idempotent and exposes real run metadata', async () => {
    await reset();
    const request = () => new NextRequest('http://localhost/api/dashboard/alerts', {
      method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'prompt09-alert-evaluation-001' }),
    });
    const first = await alertsRoute.POST(request());
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    const job = await store.getAutomationJob(firstBody.data.jobId);
    assert.equal(job.botId, 'ALERT_METRICS_ENGINE');
    assert.equal(job.requestedExecutionMode, 'LOCAL_ONLY');
    assert.equal((await worker.processAutomationBatch('prompt09-alert-worker', 1)).succeeded, 1);
    const second = await alertsRoute.POST(request());
    assert.equal(second.status, 200);
    assert.equal((await store.getAllAutomationJobs()).length, 1);
    const items = await alerts.listAlerts({ limit: 500 });
    assert.equal(new Set(items.map(item => item.deduplicationKey)).size, items.length);
    const response = await alertsRoute.GET(new NextRequest('http://localhost/api/dashboard/alerts', { headers: { authorization: auth } }));
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.evaluation.operationId, job.operationId);
    assert.equal(data.evaluation.runStatus, 'SUCCEEDED');
    assert.equal(typeof data.summary.unresolved, 'number');
  });

  await test('DELETE product is blocked in favor of durable archive', async () => {
    await reset();
    const source = product('delete-blocked');
    await adapter.writeCollection('products', [source]);
    const response = await productRoute.DELETE(new NextRequest(`http://localhost/api/products/${source.id}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id: source.id }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'ARCHIVE_REQUIRED');
    assert.ok(await products.getProductById(source.id));
  });

  global.fetch = originalFetch;
  console.log(`\nPROMPT09 Phase B targeted: ${passed} passed, ${failed} failed`);
  console.log('Isolated artifacts retained under .test-tmp by no-delete policy.');
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
