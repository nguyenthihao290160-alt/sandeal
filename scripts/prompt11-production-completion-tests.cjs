/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, '.test-tmp', `prompt11-production-${runId}`);
const authPassword = ['prompt11', 'local', 'only'].join('-');
fs.mkdirSync(dataDir, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: 'test', SANDEAL_DATA_DIR: dataDir, BASIC_AUTH_ENABLED: 'true',
  BASIC_AUTH_USER: 'prompt11-test', BASIC_AUTH_PASSWORD: authPassword,
  SANDEAL_ADMIN_PERMISSIONS: '*', ALLOW_PAID_AI: 'false', AUTO_PUBLISH_ENABLED: 'false',
  ALLOW_PUBLISHING_API: 'false', ACCESS_TRADE_API_KEY: '', GEMINI_API_KEY: '',
  SANDEAL_RELEASE_ID: 'prompt11-test-build', SANDEAL_RUNTIME_OPT_IN: 'false',
});
require('./register-typescript.cjs');

let passed = 0; let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
}

function product(id, overrides = {}) {
  const now = new Date('2026-07-18T05:00:00.000Z').toISOString();
  return {
    id, title: `Sản phẩm thật ${id}`, slug: id, kind: 'product', recordType: 'PRODUCT', platform: 'website', source: 'manual',
    sourceId: id, originalUrl: `https://merchant.example/products/${id}`, affiliateUrl: `https://merchant.example/products/${id}?affiliate=sandeal`,
    imageUrl: `https://images.example/${id}.png`, price: 1_000_000, salePrice: 800_000, currency: 'VND',
    classification: { schemaVersion: 3, decisionId: `decision-${id}`, recordType: 'PRODUCT', sourceType: 'manual:owner_import', confidence: 0.98, reasons: ['verified_product_shape'], signals: ['title', 'price', 'url'], action: 'ACCEPT', ruleVersion: 'record-classifier-v3', classifiedAt: now },
    tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review', lifecycleState: 'NORMALIZED',
    verifiedSource: true, sourceVerified: true, publicHidden: true, needsVerification: true, autoPublishEligible: false,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', duplicateStatus: 'CLEAR',
    lastSeenAt: now, createdAt: now, updatedAt: now, ...overrides,
  };
}

function png(width, height) {
  const bytes = Buffer.alloc(160, 0);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); Buffer.from('IHDR').copy(bytes, 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

function imageFetch(body, contentType = 'image/png', status = 200) {
  return async (_url, init = {}) => new Response(String(init.method || 'GET').toUpperCase() === 'HEAD' ? null : body, {
    status, headers: { 'content-type': contentType, 'content-length': String(body.length) },
  });
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const classifier = require('../src/lib/autonomous/recordClassification.ts');
  const health = require('../src/lib/bots/productHealthCheck.ts');
  const inventory = require('../src/lib/automation/launchInventory.ts');
  const alerts = require('../src/lib/product-intelligence/alerts.ts');
  const automation = require('../src/lib/automation/store.ts');
  const automationSettings = require('../src/lib/storage/automationSettings.ts');
  const dashboard = require('../src/lib/automation/dashboard.ts');
  const buildMismatch = require('../src/lib/buildMismatch.ts');
  const liveRoute = require('../src/app/api/health/live/route.ts');
  const readyRoute = require('../src/app/api/health/ready/route.ts');
  const proxyModule = require('../src/proxy.ts');
  const { NextRequest } = require('next/server');
  const auth = `Basic ${Buffer.from(`prompt11-test:${authPassword}`).toString('base64')}`;
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT11_TEST'); };

  async function reset(...collections) {
    for (const collection of collections) await adapter.writeCollection(collection, []);
  }

  await test('classifier uses source evidence and separates all six record types', () => {
    const cases = [
      ['PRODUCT', { name: 'Tai nghe Bluetooth SoundPro X2', price: 590000, productUrl: 'https://shop.example/product/x2', imageUrl: 'https://img.example/x2.jpg', merchant: 'Shop A', sku: 'X2', provider: 'owner', endpointType: 'product_feed' }],
      ['VOUCHER', { name: 'Giảm 45K cho đơn hàng từ 399K', price: 590000, productUrl: 'https://shop.example/product/x2', sourceItemKind: 'product' }],
      ['CAMPAIGN', { name: 'Mega Sale tháng 7', campaignId: 'campaign-7', landingUrl: 'https://shop.example/campaign/july' }],
      ['STORE_OFFER', { name: '[SoundPro Official Store] - Giảm 10% tối đa 50K', originalUrl: 'https://shop.example/store/soundpro' }],
      ['CATEGORY_OR_LANDING_PAGE', { name: 'Bộ sưu tập tai nghe', originalUrl: 'https://shop.example/collections/headphones' }],
      ['UNKNOWN', { name: 'Dữ liệu chưa đủ', sourceItemKind: 'product' }],
    ];
    for (const [expected, input] of cases) assert.equal(classifier.classifyRecord(input).recordType, expected);
    const full = classifier.classifyRecord(cases[0][1]);
    assert.equal(full.action, 'ACCEPT'); assert.match(full.sourceType, /owner:product feed/);
    const unknown = classifier.classifyRecord(cases[5][1]);
    assert.equal(unknown.action, 'QUARANTINE'); assert.ok(unknown.reasons.includes('insufficient_verified_product_fields'));
  });

  await test('image checks enforce SSRF, signature, dimensions, dark/placeholder states and safe fallback mapping', async () => {
    assert.equal((await health.checkImageHealth('http://127.0.0.1/private.png')).status, 'forbidden');
    let calls = 0;
    const placeholder = await health.checkImageHealth('https://images.example/placeholder-1x1.png', { fetchImpl: async () => { calls += 1; throw new Error('not reached'); } });
    assert.equal(placeholder.status, 'placeholder'); assert.equal(calls, 0);
    const small = await health.checkImageHealth('https://images.example/small.png', { fetchImpl: imageFetch(png(1, 1)), resolveDns: false, inspectImageBody: true });
    assert.equal(small.status, 'too_small'); assert.equal(health.productImageValidationState(small), 'TOO_SMALL');
    const valid = await health.checkImageHealth('https://images.example/valid.png', { fetchImpl: imageFetch(png(320, 240)), resolveDns: false, inspectImageBody: true });
    assert.equal(valid.status, 'ok'); assert.equal(valid.dimensionsVerified, true);
    const fake = Buffer.alloc(160, '<');
    assert.equal((await health.checkImageHealth('https://images.example/fake.png', { fetchImpl: imageFetch(fake), resolveDns: false, inspectImageBody: true })).status, 'invalid_image');
    const darkSvg = Buffer.from(`<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="240" fill="#000"/></svg>${' '.repeat(160)}`);
    assert.equal((await health.checkImageHealth('https://images.example/dark.svg', { fetchImpl: imageFetch(darkSvg, 'image/svg+xml'), resolveDns: false, inspectImageBody: true })).status, 'dark_image_suspected');
    assert.equal(health.productImageValidationState(valid, true), 'FALLBACK_USED');
  });

  await test('launch inventory excludes fixtures and exposes the complete lifecycle with structured blockers', async () => {
    await reset('products', 'candidate-queue', 'automation-jobs', 'automation-control', 'runtime-health', 'automation-audit');
    await adapter.writeCollection('products', [
      product('fixture-ready', { source: 'fixture-prompt11', lifecycleState: 'READY_FOR_PUBLISH' }),
      product('real-blocked', { imageHealthStatus: 'image_broken' }),
      product('real-voucher', { kind: 'voucher', recordType: 'VOUCHER', classification: { ...product('x').classification, recordType: 'VOUCHER', action: 'QUARANTINE' } }),
    ]);
    const report = await inventory.buildLaunchReadyReport();
    assert.equal(report.inventoryFunnel.fixtureRecordsExcluded, 1);
    assert.equal(report.inventoryFunnel.productsClassified, 1);
    assert.equal(report.inventoryFunnel.excluded.vouchers, 1);
    assert.equal(report.totalReady, 0, 'fixture readiness must not affect launch totals');
    assert.deepEqual(report.lifecycle.stages, ['SOURCE_RECEIVED', 'CLASSIFIED', 'NORMALIZED', 'LINK_CHECKED', 'IMAGE_CHECKED', 'PRICE_VERIFIED', 'DEDUPED', 'SCORED', 'READY_FOR_PUBLISH', 'PUBLISHED', 'MONITORED']);
    const blocker = report.lifecycle.blockedItems.flatMap(item => item.blockers)[0];
    for (const field of ['code', 'message', 'retryable', 'owner', 'evidence', 'suggestedAction', 'manualApprovalRequired']) assert.ok(Object.hasOwn(blocker, field), field);
  });

  await test('worker failures have bounded retry, sanitized categories, dead-letter and idempotency', async () => {
    await reset('automation-jobs', 'automation-control', 'automation-audit');
    await automation.updateAutomationControl({ workerPaused: false, killSwitch: false }, 'prompt11-test');
    const first = await automation.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'prompt11-retry', requestedBy: 'prompt11-test', riskLevel: 'LOW' });
    const duplicate = await automation.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'prompt11-retry', requestedBy: 'prompt11-test', riskLevel: 'LOW' });
    assert.equal(duplicate.created, false); assert.equal(duplicate.job.id, first.job.id);
    const claimed = (await automation.claimAutomationJobs('prompt11-worker', 1))[0];
    const retry = await automation.failAutomationJob(claimed.id, 'prompt11-worker', 'PROVIDER_TIMEOUT', new Error('provider timed out; authorization=hidden'));
    assert.equal(retry.status, 'RETRY_SCHEDULED'); assert.equal(retry.lastErrorCategory, 'PROVIDER_TIMEOUT'); assert.equal(retry.retryable, true); assert.equal(retry.deadLetterReason, undefined);
    const terminalJob = await automation.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'prompt11-dead-letter', requestedBy: 'prompt11-test', riskLevel: 'LOW' });
    const claimedTerminal = (await automation.claimAutomationJobs('prompt11-worker', 1))[0];
    assert.equal(claimedTerminal.id, terminalJob.job.id);
    const dead = await automation.failAutomationJob(claimedTerminal.id, 'prompt11-worker', 'VALIDATION_FAILED', new Error('invalid source data'));
    assert.equal(dead.status, 'FAILED'); assert.equal(dead.retryable, false); assert.match(dead.deadLetterReason, /^VALIDATION_FAILED:/);
  });

  await test('scheduler dashboard fails closed when nextRunAt is overdue despite a fresh heartbeat', async () => {
    await reset('automation-jobs', 'automation-control', 'automation-audit', 'automation-role-leases', 'automation-role-conflicts', 'runtime-health', 'products', 'product-sources', 'candidate-queue', 'outbound-events', 'token-vault');
    await automationSettings.updateAutomationSettings({ enabled: true, launchEnabled: false, safePublish: true });
    const now = Date.now();
    await automation.updateAutomationControl({ schedulerPaused: false, schedulerHeartbeatAt: new Date(now).toISOString(), schedulerNextRunAt: new Date(now - 5 * 60_000).toISOString() }, 'prompt11-test');
    const result = await dashboard.buildAutomationDashboard('today');
    assert.equal(result.scheduler.status, 'stale'); assert.equal(result.scheduler.blockReason, 'NEXT_RUN_OVERDUE');
  });

  await test('normal new-price state is grouped as info and stale products are grouped once', async () => {
    await reset('products', 'price-history', 'product-alerts', 'automation-jobs', 'automation-control', 'automation-audit', 'automation-ai-usage', 'automation-circuits', 'token-vault');
    await automationSettings.updateAutomationSettings({ enabled: false });
    const now = Date.parse('2026-07-18T05:00:00.000Z');
    await adapter.writeCollection('products', [product('new-1'), product('new-2'), product('new-3')]);
    await alerts.evaluateAlerts('prompt11-new-price', now);
    let items = await alerts.listAlerts({ limit: 500 });
    const info = items.find(item => item.type === 'price_history_building');
    assert.ok(info); assert.equal(info.severity, 'info'); assert.equal(info.occurrenceCount, 3); assert.equal(items.filter(item => item.type === 'price_history_building').length, 1);
    const old = '2026-06-01T00:00:00.000Z';
    await adapter.writeCollection('products', [product('old-1', { createdAt: old, updatedAt: old, lastSeenAt: old }), product('old-2', { createdAt: old, updatedAt: old, lastSeenAt: old })]);
    await alerts.evaluateAlerts('prompt11-stale-price', now);
    items = await alerts.listAlerts({ limit: 500 });
    const stale = items.find(item => item.type === 'stale_price' && item.groupKey === 'group:products:stale-price');
    assert.ok(stale); assert.equal(stale.occurrenceCount, 2); assert.equal(stale.autoResolve, true);
  });

  await test('health live is public/minimal, readiness is authenticated, and 401 differs from missing route', async () => {
    const live = await liveRoute.GET(); const liveBody = await live.json();
    assert.equal(live.status, 200); assert.equal(liveBody.status, 'PASS'); assert.equal(liveBody.buildId, 'prompt11-test-build');
    assert.deepEqual(Object.keys(liveBody).sort(), ['app', 'buildId', 'status', 'timestamp', 'version'].sort());
    const denied = await readyRoute.GET(new NextRequest('http://localhost/api/health/ready'));
    assert.equal(denied.status, 401);
    const allowed = await readyRoute.GET(new NextRequest('http://localhost/api/health/ready', { headers: { authorization: auth } }));
    assert.ok([200, 503].includes(allowed.status));
    const allowedBody = await allowed.json(); assert.ok(['PASS', 'WARNING', 'CRITICAL'].includes(allowedBody.status)); assert.ok(Array.isArray(allowedBody.checks));
    const proxyLive = proxyModule.proxy(new NextRequest('http://localhost/api/health/live'));
    const proxyAdmin = proxyModule.proxy(new NextRequest('http://localhost/api/health/ready'));
    assert.equal(proxyLive.status, 200); assert.equal(proxyAdmin.status, 401);
  });

  await test('build mismatch detection is precise and repository has no duplicated dashboard route', () => {
    assert.equal(buildMismatch.isBuildMismatchMessage('Failed to find Server Action. This request might be from an older or newer deployment.'), true);
    assert.equal(buildMismatch.isBuildMismatchMessage('ordinary validation error'), false);
    assert.equal(buildMismatch.isComparableBuildId('release-20260718'), true);
    assert.equal(buildMismatch.isComparableBuildId('development'), false);
    const sourceFiles = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(file => typeof file === 'string' && /\.(?:ts|tsx)$/.test(file));
    const duplicated = sourceFiles.filter(file => fs.readFileSync(path.join(root, 'src', file), 'utf8').includes('/dashboard/dashboard/'));
    assert.deepEqual(duplicated, []);
  });

  const guardSource = fs.readFileSync(path.join(root, 'src/components/public/BuildMismatchGuard.tsx'), 'utf8');
  await test('client build guard has a single-reload key, dirty-form preservation and deduplicated log', () => {
    assert.match(guardSource, /sessionStorage\.getItem\(reloadKey\)/);
    assert.match(guardSource, /dirtyForm\.current/);
    assert.match(guardSource, /sessionStorage\.getItem\(logKey\)/);
    assert.match(guardSource, /Website vừa được cập nhật/);
  });

  global.fetch = originalFetch;
  console.log(`\nPROMPT11 production completion: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, dataDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
