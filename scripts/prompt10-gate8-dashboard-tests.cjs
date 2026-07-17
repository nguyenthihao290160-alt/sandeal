/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const tempDir = path.join(root, '.test-tmp', `prompt10-gate8-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0; let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const dashboard = require('../src/lib/automation/dashboard.ts');
  const publicProducts = require('../src/lib/product-intelligence/publicProducts.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_GATE8'); };

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await store.updateAutomationControl({
    mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: true, ingestionPaused: false,
    workerPaused: false, schedulerPaused: false, killSwitch: false,
    schedulerHeartbeatAt: nowIso, schedulerLastRunAt: nowIso,
    schedulerNextRunAt: new Date(now + 60_000).toISOString(),
  }, 'gate8-test');
  await settings.updateAutomationSettings({ enabled: true, launchEnabled: false });
  await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'scheduler-leader', instanceId: 'scheduler-leader:1', now, leaseMs: 45_000 });
  await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'scheduler-contender', instanceId: 'scheduler-contender:1', now: now + 1, leaseMs: 45_000 });
  await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'worker-leader', instanceId: 'worker-leader:1', now, leaseMs: 45_000 });
  await adapter.writeCollection('runtime-health', [{
    schemaVersion: 1, id: 'runtime-health:gate8', ruleVersion: 'runtime-guardian-v1',
    web: { status: 'ready', buildAvailable: true, publicRouteHealthy: true },
    worker: { status: 'active', holderId: 'worker-leader', heartbeatAt: nowIso },
    scheduler: { status: 'active', holderId: 'scheduler-leader', heartbeatAt: nowIso },
    providers: { accessTrade: 'configured', gemini: 'degraded' }, queue: { pending: 0, running: 0, stuck: 0, staleJobs: 0 },
    storage: { status: 'healthy', staleLocks: 0, freeBytes: null, criticalCollections: { status: 'healthy', collections: [], healthy: [], freshEmpty: [], recoverable: [], blocked: [], checkedAt: nowIso } },
    duplicateRoles: ['SCHEDULER'], publishSafe: false, reasons: ['DUPLICATE_PROCESS_ROLE', 'PROVIDER_DEGRADED'],
    recommendation: { pausePublish: true, pauseIngestion: false, effectiveMode: 'SHADOW' }, checkedAt: nowIso,
  }]);
  await adapter.writeCollection('products', [{
    id: 'quarantined-product', slug: 'quarantined-product', title: 'Candidate chưa đủ bằng chứng', kind: 'product',
    platform: 'other', source: 'other', currency: 'VND', tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review',
    publicHidden: true, lifecycleState: 'QUARANTINED', lifecycleUpdatedAt: nowIso, quarantineReasons: ['evidence_coverage_low'],
    createdAt: nowIso, updatedAt: nowIso,
  }]);

  const scan = await store.createAutomationJob({ type: 'PRODUCT_SCAN', payload: { limit: 1 }, idempotencyKey: 'gate8-product-scan', requestedBy: 'gate8-test', dryRun: true });
  const claimedScan = await store.claimAutomationJobs('gate8-worker', 1);
  assert.equal(claimedScan[0].id, scan.job.id);
  await store.completeAutomationJob(scan.job.id, 'gate8-worker', { summary: {
    sourceRequests: 2, found: 3, queued: 2, duplicate: 1, rejected: 1, created: 1, updated: 1,
    seoReady: 1, seoBlocked: 1, failed: 0,
  } });
  const guardian = await store.createAutomationJob({ type: 'RUNTIME_GUARDIAN', payload: {}, idempotencyKey: 'gate8-guardian', requestedBy: 'gate8-test', dryRun: true });
  const claimedGuardian = await store.claimAutomationJobs('gate8-worker', 1);
  assert.equal(claimedGuardian[0].id, guardian.job.id);
  await store.failAutomationJob(guardian.job.id, 'gate8-worker', 'POLICY_BLOCKED', new Error('Provider chưa sẵn sàng; giữ SHADOW'));
  await store.createAutomationJob({ type: 'AUTO_PILOT', payload: {}, idempotencyKey: 'gate8-autopilot', requestedBy: 'gate8-test', dryRun: true });

  const data = await dashboard.buildAutomationDashboard('today');

  await test('owner dashboard separates online process state from active scheduler leadership', () => {
    assert.equal(data.runtime.web.status, 'ready'); assert.equal(data.runtime.scheduler.processStatus, 'active');
    assert.equal(data.runtime.scheduler.activeRole, true); assert.equal(data.runtime.scheduler.owner, 'scheduler-leader');
    assert.equal(data.runtime.scheduler.lastContenderState, 'rejected'); assert.equal(data.runtime.scheduler.rejectedOwner, 'scheduler-contender');
    assert.ok(data.runtime.scheduler.fencingToken >= 1); assert.ok(data.runtime.scheduler.leaseAgeMs >= 0);
  });

  await test('provider configured state is not presented as ready and degraded state stays visible', () => {
    const accessTrade = data.providers.find(item => item.id === 'accessTrade');
    const gemini = data.providers.find(item => item.id === 'gemini');
    assert.equal(accessTrade.configured, true); assert.equal(accessTrade.ready, false); assert.equal(accessTrade.status, 'configured');
    assert.equal(gemini.degraded, true); assert.deepEqual(data.business.degradedProviders, ['gemini']);
  });

  await test('safe publish diagnostics expose every effective blocker without false success', () => {
    assert.equal(data.control.safePublish.state, 'blocked');
    assert.ok(data.control.safePublish.reasons.includes('launch_not_enabled'));
    assert.ok(data.control.safePublish.reasons.includes('publish_paused'));
    assert.ok(data.control.safePublish.reasons.includes('effective_mode_not_publishable'));
  });

  await test('pipeline metrics use persisted job outcomes and quarantine facts', () => {
    assert.deepEqual(data.pipeline, {
      sourceRequests: 2, sourceFound: 3, candidateQueued: 2, duplicateRejected: 1, validationRejected: 1,
      productCreated: 1, productUpdated: 1, publishEligible: 1, publishBlocked: 1,
      quarantined: 1, failed: 1, durationMs: data.pipeline.durationMs,
    });
    assert.ok(data.pipeline.durationMs >= 0);
  });

  await test('job diagnostics include contract versions plus blocked reason and retry truth', () => {
    assert.equal(data.jobs.productScan.status, 'SUCCEEDED'); assert.equal(data.jobs.runtimeGuardian.status, 'FAILED');
    assert.ok(data.jobs.runtimeGuardian.reasons.some(reason => reason.includes('Provider')));
    assert.equal(data.jobs.runtimeGuardian.nextRetryAt, null);
    for (const job of [data.jobs.productScan, data.jobs.autoPilot, data.jobs.runtimeGuardian]) {
      assert.equal(job.schemaVersion, 2); assert.ok(job.policyVersion); assert.ok(job.handlerVersion);
    }
  });

  await test('empty and degraded business states are factual', () => {
    assert.equal(data.business.publicProducts, 0); assert.equal(data.business.outboundClicks, 0);
    assert.equal(data.business.freshPrice, 0); assert.equal(data.business.brokenLinks, 0);
    assert.equal(data.zeroData, false);
  });

  await test('public product card tolerates missing optional data without invented deal claims', () => {
    const card = publicProducts.toPublicProductCardDto({
      id: 'missing-card', slug: 'missing-card', title: 'Sản phẩm thiếu dữ liệu tùy chọn', kind: 'product', platform: 'other', source: 'manual',
      currency: 'VND', tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'draft', createdAt: nowIso, updatedAt: nowIso,
    });
    assert.equal(card.currentPrice, undefined); assert.equal(card.originalPrice, undefined); assert.equal(card.discountPercent, undefined);
    assert.equal(card.imageUrl, undefined); assert.deepEqual(card.warnings, []); assert.equal(card.outboundHref, '/go/missing-card');
  });

  await test('trust evidence panel has truthful empty states and renders only supplied facts and sources', () => {
    const source = fs.readFileSync(path.join(root, 'src/components/public/ProductSections.tsx'), 'utf8');
    assert.match(source, /evidence\.facts\.length > 0/); assert.match(source, /evidence\.facts\.map/);
    assert.match(source, /evidence\.sources\.length > 0/); assert.match(source, /evidence\.sources\.map/);
    assert.match(source, /Chưa có thông số được xác minh/); assert.match(source, /Chưa có nguồn bằng chứng chi tiết/);
    assert.match(source, /không được tự động suy đoán/);
  });

  await test('dashboard UI contains loading error degraded accessibility and guarded mode controls', () => {
    const page = fs.readFileSync(path.join(root, 'src/app/dashboard/page.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'src/app/dashboard/dashboard.module.css'), 'utf8');
    assert.match(page, /aria-busy=\{loading\}/); assert.match(page, /role="status"/); assert.match(page, /role="alertdialog"/);
    assert.match(page, /Advanced Diagnostics/); assert.match(page, /Chưa sẵn sàng/); assert.match(page, /pre-canary backup/);
    assert.match(page, /Ba điều khiển vận hành chính/); assert.match(css, /@media \(max-width: 600px\)/); assert.match(css, /focus-visible/);
    assert.match(css, /\.controlPanel \{ display: none; \}/);
  });

  await test('Gate 8 suite is isolated and performs no real network or production data write', () => {
    assert.equal(path.resolve(adapter.getDataDir()), path.resolve(tempDir));
    assert.ok(path.resolve(adapter.getDataDir()).startsWith(path.resolve(root, '.test-tmp')));
  });

  console.log(`\nPROMPT10 Gate 8 dashboard: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
