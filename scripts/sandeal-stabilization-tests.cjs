/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `sandeal-stabilization-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'stabilization-test';
process.env.BASIC_AUTH_PASSWORD = 'not-a-real-secret';
delete process.env.SANDEAL_STORAGE_DRIVER;
delete process.env.MONGODB_URI;
require('./register-typescript.cjs');

const adapter = require('../src/lib/storage/adapter.ts');
const store = require('../src/lib/automation/store.ts');
const scheduler = require('../src/lib/automation/scheduler.ts');
const truth = require('../src/lib/automation/truth.ts');
const usage = require('../src/lib/automation/businessUsage.ts');
const worker = require('../src/lib/automation/worker.ts');
const settingsStore = require('../src/lib/storage/automationSettings.ts');
const controlRoute = require('../src/app/api/automation/control/route.ts');
const safeRunRoute = require('../src/app/api/automation/safe-run/route.ts');
const { NextRequest } = require('next/server');

const auth = `Basic ${Buffer.from('stabilization-test:not-a-real-secret').toString('base64')}`;
const headers = { authorization: auth, 'content-type': 'application/json' };
let passed = 0;
let failed = 0;

async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack || error}`); }
}

async function reset() {
  for (const collection of ['automation-jobs', 'automation-control', 'automation-audit', 'automation-ai-usage', 'automation-circuits', 'runtime-role-leases', 'runtime-role-conflicts', 'runtime-health', 'pipeline-daily-usage', 'products', 'candidate-queue']) {
    await adapter.writeCollection(collection, []);
  }
  await settingsStore.updateAutomationSettings({ enabled: true, intervalHours: 3, maxItemsPerRun: 1, maxItemsPerDay: 3 });
}

function truthFixture(overrides = {}) {
  const now = Date.parse('2026-07-20T05:00:00.000Z');
  const at = new Date(now).toISOString();
  const lease = { schemaVersion: 2, id: 'SCHEDULER', role: 'SCHEDULER', ownerId: 'scheduler:sandeal', instanceId: 'scheduler-current', holderId: 'scheduler:sandeal', status: 'ACTIVE', processStartedAt: new Date(now - 10_000).toISOString(), acquiredAt: new Date(now - 10_000).toISOString(), startedAt: new Date(now - 10_000).toISOString(), heartbeatAt: at, expiresAt: new Date(now + 45_000).toISOString(), leaseExpiresAt: new Date(now + 45_000).toISOString(), fencingToken: 7, takeoverCount: 0, updatedAt: at };
  return { now, settings: { enabled: true, intervalHours: 3, maxItemsPerDay: 50 }, control: { ...store.DEFAULT_CONTROL, schedulerPaused: false, schedulerHeartbeatAt: at, schedulerLastRunAt: at, schedulerNextRunAt: new Date(now + 60_000).toISOString(), updatedAt: at }, leases: [lease], conflicts: [], jobs: [], usage: { id: 'usage', day: '2026-07-20', requests: 0, tokens: 0, fallbacks: 0, blocked: 0, requestLimit: 100, tokenLimit: 1000, updatedAt: at }, businessUsage: { id: '2026-07-20', sourceRequests: 0, candidatesFound: 0, candidatesQueued: 0, networkChecks: 0, productsReviewed: 0, productsPublished: 0, updatedAt: at }, ...overrides };
}

(async () => {
  await test('PAUSED + nextRunAt cũ không tạo NEXT_RUN_OVERDUE', () => {
    const input = truthFixture();
    input.control.schedulerPaused = true;
    input.control.schedulerNextRunAt = new Date(input.now - 60 * 60_000).toISOString();
    const snapshot = truth.buildAutomationTruth(input);
    assert.equal(snapshot.scheduler.state, 'PAUSED');
    assert.equal(snapshot.inconsistencies.some(item => item.code === 'NEXT_RUN_OVERDUE'), false);
  });

  await test('RESUME tính nextRunAt từ thời điểm resume và không enqueue catch-up', async () => {
    await reset();
    await store.updateAutomationControl({ schedulerPaused: true, schedulerNextRunAt: new Date(Date.now() - 86_400_000).toISOString(), pausedAt: new Date().toISOString(), pauseReason: 'fixture' }, 'fixture');
    const before = Date.now();
    const response = await controlRoute.PATCH(new NextRequest('http://localhost/api/automation/control', { method: 'PATCH', headers, body: JSON.stringify({ action: 'resume_scheduler' }) }));
    assert.equal(response.status, 200);
    const state = (await response.json()).data;
    assert.ok(Date.parse(state.schedulerNextRunAt) >= before + 3 * 60 * 60_000 - 2_000);
    assert.equal((await store.getAllAutomationJobs()).length, 0);
  });

  await test('Scheduler PAUSED trả scheduled=0 cho automation và intelligence', async () => {
    await reset();
    await store.updateAutomationControl({ schedulerPaused: true, workerHeartbeatAt: new Date().toISOString() }, 'fixture');
    assert.equal((await scheduler.runAutomationSchedulerTick()).status, 'paused');
    const intelligence = await scheduler.runProductIntelligenceSchedulerTick();
    assert.equal(intelligence.status, 'paused');
    assert.equal(intelligence.scheduled, 0);
    assert.deepEqual(intelligence.jobs, []);
  });

  await test('Safe-run khi PAUSED idempotent, không đổi schedule và hoàn tất SUCCEEDED', async () => {
    await reset();
    await adapter.writeCollection('products', [{ id: 'p1', title: 'Fixture', kind: 'product', status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
    await store.updateAutomationControl({ schedulerPaused: true, schedulerNextRunAt: undefined }, 'fixture');
    const request = () => safeRunRoute.POST(new NextRequest('http://localhost/api/automation/safe-run', { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'safe-click-bucket-1', limit: 1 }) }));
    const first = await request(); const firstBody = await first.json();
    const second = await request(); const secondBody = await second.json();
    assert.equal(firstBody.data.id, secondBody.data.id);
    assert.equal((await store.getAllAutomationJobs()).length, 1);
    assert.equal((await store.getAutomationControl()).schedulerPaused, true);
    await worker.processAutomationBatch('safe-run-worker', 1);
    assert.equal((await store.getAutomationJob(firstBody.data.id)).status, 'SUCCEEDED');
    const snapshot = await truth.getAutomationTruth();
    assert.equal(snapshot.runs.latestSafeRun.status, 'SUCCEEDED');
    assert.equal(snapshot.runs.latestSafeRun.result.failed, 0);
  });

  await test('Heartbeat, scheduler tick và guardian không tăng processedToday', async () => {
    await reset();
    const now = Date.now();
    await store.updateAutomationControl({ schedulerPaused: true, schedulerHeartbeatAt: new Date(now).toISOString(), workerHeartbeatAt: new Date(now).toISOString() }, 'fixture');
    await scheduler.runRuntimeControlSchedulerTick(now);
    await worker.processAutomationBatch('guardian-worker', 1);
    const snapshot = await truth.getAutomationTruth(now + 1_000);
    assert.equal(snapshot.dailyUsage.processed, 0);
  });

  await test('Quota atomic không vượt giới hạn khi race và chặn enqueue nghiệp vụ', async () => {
    await reset();
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) => usage.reserveProductProcessingCapacity(`race:${index}`, 1, 3)));
    const allowed = attempts.map((item, index) => ({ item, index })).filter(entry => entry.item.allowed);
    assert.equal(allowed.length, 3);
    await Promise.all(allowed.map(entry => usage.commitProductProcessingCapacity(`race:${entry.index}`, 1)));
    assert.equal((await usage.getDailyBusinessUsage()).productsReviewed, 3);
    await assert.rejects(() => store.createAutomationJob({ type: 'PROCESS_CANDIDATE', payload: { candidateId: 'blocked' }, idempotencyKey: 'candidate:quota-blocked', requestedBy: 'fixture', dryRun: false }), error => error.code === 'DAILY_PRODUCT_LIMIT_REACHED');
  });

  await test('ALREADY_ACTIVE cũ được coi là đã phục hồi khi lease hiện tại khỏe', () => {
    const input = truthFixture();
    input.conflicts = [{ schemaVersion: 2, id: 'old', role: 'SCHEDULER', activeHolderId: 'old-owner', rejectedHolderId: 'old-contender', activeInstanceId: 'old-instance', rejectedInstanceId: 'old-rejected', observedAt: new Date(input.now - 2 * 60_000).toISOString() }];
    const snapshot = truth.buildAutomationTruth(input);
    assert.equal(snapshot.inconsistencies.some(item => item.code === 'SCHEDULER_OWNER_CONFLICT'), false);
    assert.equal(snapshot.scheduler.active, true);
  });

  await test('Toast gọn ở đáy, có close và không che nút làm mới', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/automation/page.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/operations.module.css'), 'utf8');
    assert.match(page, /aria-label="Đóng thông báo"/);
    assert.match(page, />Làm mới</);
    assert.match(css, /\.toastRegion[^}]*bottom:/s);
    assert.doesNotMatch(css, /\.toastRegion[^}]*top:/s);
  });

  await test('Product detail render blocker nhóm và lý do action disabled', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/products/[id]/page.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/dashboard/products/[id]/product-detail.module.css'), 'utf8');
    assert.match(page, /blockerGroups/);
    assert.match(page, /title=\{canaryDisabledReason/);
    assert.match(page, /title=\{publishDisabledReason/);
    assert.match(css, /@media \(max-width: 900px\)/);
    assert.match(css, /\.operationGrid/);
  });

  console.log(`\nSanDeal stabilization: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
