/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testAuthValue = ['local', 'fixture', 'only'].join('-');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt09-phase-a-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt09-test';
process.env.BASIC_AUTH_PASSWORD = testAuthValue;
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';

require('./register-typescript.cjs');

const auth = `Basic ${Buffer.from(`prompt09-test:${testAuthValue}`).toString('base64')}`;
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

function makeProduct(id = 'safe-publish-product') {
  const now = new Date().toISOString();
  return {
    id,
    title: 'Tai nghe Bluetooth SanDeal đã xác minh',
    slug: `tai-nghe-bluetooth-${id}`,
    description: 'Thông tin sản phẩm được tổng hợp từ nguồn và chỉ nêu các dữ kiện đã ghi nhận.',
    kind: 'product',
    platform: 'website',
    source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=fixture`,
    imageUrl: `https://merchant.example/images/${id}.jpg`,
    price: 1500000,
    salePrice: 1200000,
    currency: 'VND',
    category: 'Điện tử',
    brand: 'Fixture',
    sku: `SKU-${id}`,
    specifications: { connection: 'Bluetooth', warranty: '12 tháng' },
    tags: [], benefits: [], warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: true,
    publicHidden: true,
    needsVerification: true,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    linkLastCheckedAt: now,
    imageLastCheckedAt: now,
    lastSeenAt: now,
    availability: 'available',
    sourceHash: `source-${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const registry = require('../src/lib/automation/botRegistry.ts');
  const enqueue = require('../src/lib/automation/enqueue.ts');
  const productActions = require('../src/lib/automation/productActions.ts');
  const providerRouter = require('../src/lib/automation/providerRouter.ts');
  const store = require('../src/lib/automation/store.ts');
  const manualTasks = require('../src/lib/automation/manualTasks.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const productsStore = require('../src/lib/storage/products.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const aiBotsRoute = require('../src/app/api/ai-bots/route.ts');
  const runNowRoute = require('../src/app/api/ai-bots/run-now/route.ts');
  const manualRoute = require('../src/app/api/automation/manual-tasks/route.ts');
  const { NextRequest } = require('next/server');

  const collections = [
    'products', 'automation-jobs', 'automation-control', 'automation-audit', 'automation-ai-usage',
    'automation-circuits', 'automation-manual-tasks', 'bot-runs', 'publication-audit',
  ];
  async function reset() {
    for (const collection of collections) await adapter.writeCollection(collection, []);
  }

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT09_TESTS'); };

  await test('Bot Registry phân loại đầy đủ và không chứa secret', () => {
    const entries = registry.listBotRegistry();
    const ids = new Set(entries.map(item => item.id));
    for (const id of ['OPERATIONS_ORCHESTRATOR', 'POLICY_SAFETY_GUARD', 'PROVIDER_BUDGET_ROUTER', 'SOURCE_INTAKE', 'PRODUCT_NORMALIZER', 'HEALTH_INSPECTOR', 'DUPLICATE_RESOLVER', 'SCORING_ENGINE', 'PRICE_WATCHER', 'ALERT_METRICS_ENGINE', 'EDITORIAL_GUARD', 'EVIDENCE_GROUNDED_ANALYST', 'CONTENT_DRAFT_ASSISTANT', 'EDITORIAL_ADJUDICATOR', 'MERCHANDISING_ADVISOR']) assert.ok(ids.has(id), `missing ${id}`);
    assert.equal(JSON.stringify(entries).match(/apiKey|authorization|encryptedValue/i), null);
    assert.ok(entries.every(item => item.version && item.inputSchemaVersion && item.outputSchemaVersion && item.updatedAt));
  });

  await test('/api/ai-bots chỉ enqueue durable job và không tạo bot run legacy', async () => {
    await reset();
    const request = new NextRequest('http://localhost/api/ai-bots', { method: 'POST', headers, body: JSON.stringify({ mode: 'full_safe_run', source: 'local', requestedExecutionMode: 'AUTO', dryRun: true, idempotencyKey: 'prompt09-route-enqueue-001' }) });
    const response = await aiBotsRoute.POST(request);
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.ok(body.data.jobId); assert.ok(body.data.operationId); assert.equal(body.data.trackingRoute, `/api/automation/jobs/${body.data.jobId}`);
    const jobs = await store.getAllAutomationJobs();
    assert.equal(jobs.length, 1); assert.equal(jobs[0].type, 'AUTO_PILOT'); assert.equal(jobs[0].status, 'PENDING'); assert.ok(jobs[0].executionPlan.length >= 3);
    assert.deepEqual(await adapter.readCollection('bot-runs'), []);
  });

  await test('idempotency giữ nguyên job và operationId', async () => {
    await reset();
    const input = { actor: 'test-actor', mode: 'source_scan', source: 'local', idempotencyKey: 'prompt09-idempotent-job-01', operationId: 'prompt09-operation-stable' };
    const first = await enqueue.enqueueBotExecution(input); const second = await enqueue.enqueueBotExecution(input);
    assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.job.id, second.job.id); assert.equal(second.job.operationId, 'prompt09-operation-stable');
  });

  await test('/run-now enqueue và không chạy AutoPilot đồng bộ', async () => {
    await reset();
    const response = await runNowRoute.POST(new NextRequest('http://localhost/api/ai-bots/run-now', { method: 'POST', headers, body: JSON.stringify({ mode: 'source_scan' }) }));
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.ok(body.data.jobId); assert.equal((await store.getAllAutomationJobs()).length, 1); assert.deepEqual(await adapter.readCollection('bot-runs'), []);
  });

  await test('Provider Router ưu tiên local và phân loại adapter chưa triển khai', async () => {
    await reset();
    const local = await providerRouter.routeProviderExecution({ capability: 'SCORE_PRODUCTS', requestedMode: 'AUTO', providerAdapterAvailable: false, localMode: 'LOCAL_RULES', deterministicFirst: true });
    assert.equal(local.executionMode, 'LOCAL_RULES'); assert.equal(local.aiRequests, 0); assert.equal(local.provider, 'local');
    const apiOnly = await providerRouter.routeProviderExecution({ capability: 'ANALYZE_WITH_EVIDENCE', requestedMode: 'API_ONLY', providerAdapterAvailable: false, localMode: 'LOCAL_TEMPLATE', allowManualFallback: true });
    assert.equal(apiOnly.executionMode, 'MANUAL_INPUT'); assert.equal(apiOnly.failureCode, 'PROVIDER_NOT_IMPLEMENTED'); assert.equal(apiOnly.aiRequests, 0);
    assert.equal(providerRouter.classifyProviderFailure(new Error('HTTP 429 rate limit'), 429), 'RATE_LIMITED');
    assert.equal(providerRouter.classifyProviderFailure(new Error('request timeout')), 'TIMEOUT');
  });

  await test('AI job thiếu adapter tạo Manual Task, không báo AI success', async () => {
    await reset();
    const created = await store.createAutomationJob({ type: 'AI_ANALYSIS', payload: { limit: 1 }, idempotencyKey: 'prompt09-ai-manual-fallback', requestedBy: 'test', riskLevel: 'MEDIUM', botId: 'EVIDENCE_GROUNDED_ANALYST', capability: 'ANALYZE_WITH_EVIDENCE', requestedExecutionMode: 'AUTO', executionPlan: [{ id: 'analysis', capability: 'ANALYZE_WITH_EVIDENCE', dependsOn: [], reason: 'test', status: 'PENDING', risk: 'MEDIUM', approvalRequired: false, expectedWrite: ['analysis-drafts'], externalCall: true, fallback: ['LOCAL_TEMPLATE', 'MANUAL_INPUT'] }] });
    const run = await worker.processAutomationBatch('prompt09-ai-worker', 1);
    assert.equal(run.waitingManual, 1);
    const job = await store.getAutomationJob(created.job.id);
    assert.equal(job.status, 'WAITING_FOR_MANUAL_INPUT'); assert.equal(job.outcomeStatus, 'WAITING_FOR_MANUAL_INPUT'); assert.equal(job.disclosure.aiRequests, 0); assert.equal(job.disclosure.provider, 'manual'); assert.equal(job.result, undefined);
    const tasks = await manualTasks.listManualTasks({ page: 1, pageSize: 20 });
    assert.equal(tasks.items.length, 1); assert.equal(tasks.items[0].operationId, job.operationId); assert.equal(JSON.stringify(tasks.items[0]).includes('Gia hop ly'), false);
  });

  await test('Manual input chặn secret, resume cùng job và chỉ tạo draft UNVERIFIED', async () => {
    const task = (await manualTasks.listManualTasks({ page: 1, pageSize: 20 })).items[0];
    await assert.rejects(() => manualTasks.submitManualTask(task.id, { analysisSummary: 'Bearer abcdefghijklmnopqrstuvwxyz', evidenceFactIds: ['title'], limitations: ['Chưa thử nghiệm'] }, 'dashboard-admin'), /SENSITIVE_INPUT_REJECTED/);
    const submitted = await manualTasks.submitManualTask(task.id, { analysisSummary: 'Theo dữ liệu hiện có, sản phẩm cần được đối chiếu thêm.', evidenceFactIds: ['title', 'current_price'], limitations: ['Chưa có dữ liệu trải nghiệm thực tế.'] }, 'dashboard-admin');
    const resumed = await store.getAutomationJob(submitted.jobId);
    assert.equal(resumed.status, 'PENDING'); assert.equal(resumed.operationId, task.operationId); assert.equal((await store.getAllAutomationJobs()).length, 1);
    const run = await worker.processAutomationBatch('prompt09-manual-resume-worker', 1);
    assert.equal(run.succeeded, 1);
    const completed = await store.getAutomationJob(submitted.jobId);
    assert.equal(completed.status, 'SUCCEEDED'); assert.equal(completed.outcomeStatus, 'PARTIALLY_COMPLETED'); assert.equal(completed.result.executionMode, 'MANUAL_INPUT'); assert.equal(completed.result.aiRequests, 0); assert.equal(completed.result.validationStatus, 'UNVERIFIED'); assert.equal(completed.result.published, false);
    assert.equal((await manualTasks.getManualTask(task.id)).status, 'COMPLETED');
  });

  await test('Manual Task API yêu cầu auth và DTO không có secret', async () => {
    assert.equal((await manualRoute.GET(new NextRequest('http://localhost/api/automation/manual-tasks'))).status, 401);
    const response = await manualRoute.GET(new NextRequest('http://localhost/api/automation/manual-tasks?page=1&pageSize=20', { headers }));
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(JSON.stringify(body).match(/authorization|apiKey|password/i), null);
  });

  await test('Safe Publish từ chối direct write và chỉ chạy sau durable approval', async () => {
    await reset();
    const product = makeProduct();
    product.reviewContent = editorial.generateEditorialReview(product, [], product.updatedAt);
    await adapter.writeCollection('products', [product]);
    await assert.rejects(() => productsStore.publishCanonicalProductTransaction(product.id, { status: 'published' }, { approval: true }), /SAFE_PUBLISH_JOB_REQUIRED/);
    const requested = await productActions.enqueueProductAction({ actor: 'dashboard-admin', action: 'safe_publish', productId: product.id, reason: 'Đã kiểm tra evidence và điều kiện đăng' });
    assert.equal(requested.job.status, 'WAITING_APPROVAL'); assert.equal((await productsStore.getProductById(product.id)).status, 'needs_review');
    assert.equal((await worker.processAutomationBatch('worker-before-approval', 1)).claimed, 0);
    const approved = await store.approveAutomationJob(requested.job.id, 'dashboard-admin', 'Đã kiểm tra đầy đủ điều kiện Safe Publish', true);
    assert.equal(approved.status, 'PENDING');
    const run = await worker.processAutomationBatch('prompt09-publish-worker', 1);
    assert.equal(run.succeeded, 1);
    const published = await productsStore.getProductById(product.id);
    assert.equal(published.status, 'published'); assert.equal(published.publicHidden, false);
  });

  await test('kill switch chặn claim và checkpoint giữ input hash', async () => {
    await reset();
    const created = await store.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'prompt09-kill-switch-job', requestedBy: 'test', riskLevel: 'LOW', executionPlan: [{ id: 'health', capability: 'HEALTH', dependsOn: [], reason: 'test', status: 'PENDING', risk: 'LOW', approvalRequired: false, expectedWrite: [], externalCall: false, fallback: ['LOCAL_RULES'] }] });
    assert.match(created.job.checkpoint.inputHash, /^[a-f0-9]{64}$/);
    await store.updateAutomationControl({ killSwitch: true, reason: 'Kiểm tra dừng khẩn cấp' }, 'test');
    assert.equal((await store.claimAutomationJobs('blocked-worker', 1)).length, 0);
  });

  global.fetch = originalFetch;
  console.log(`\nPROMPT09 Phase A targeted: ${passed} passed, ${failed} failed`);
  console.log('Isolated artifacts retained under .test-tmp by no-delete policy.');
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
