/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, '.test-tmp', `prompt10-launch-tests-${runId}`);
const fixtureDir = path.join(dataDir, 'fixtures');
const auditCredential = ['audit', 'fixture', 'value'].join('-');
fs.mkdirSync(fixtureDir, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: 'test', SANDEAL_DATA_DIR: dataDir, ALLOW_PAID_AI: 'false',
  AUTO_PUBLISH_ENABLED: 'false', ALLOW_PUBLISHING_API: 'false', GEMINI_API_KEY: '', ACCESS_TRADE_API_KEY: '',
});
require('./register-typescript.cjs');

let passed = 0; let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
}

function runAudit(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'production-readonly-audit.cjs'), `--base-url=${baseUrl}`], {
      cwd: root, windowsHide: true,
      env: { ...process.env, SANDEAL_AUDIT_AUTH_USER: 'audit-fixture', SANDEAL_AUDIT_AUTH_PASSWORD: auditCredential },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`audit exited ${code}: ${stderr || stdout}`)));
  });
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const inventory = require('../src/lib/automation/launchInventory.ts');
  const canary = require('../src/lib/automation/canaryController.ts');
  const importer = require('../src/lib/product-intelligence/importer.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const candidates = require('../src/lib/storage/candidateQueue.ts');
  const products = require('../src/lib/storage/products.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const store = require('../src/lib/automation/store.ts');
  const controlRoute = require('../src/app/api/automation/control/route.ts');
  const { NextRequest } = require('next/server');

  await test('zero-product diagnostic distinguishes source, ingestion and publish blockers without secrets', async () => {
    const result = await inventory.buildZeroProductDiagnostic();
    assert.equal(result.publicProductCount, 0); assert.equal(result.totalProductRecords, 0);
    assert.ok(result.primaryBlocker && result.sourceStatus && result.nextAutomaticAction && result.recommendedOperatorAction);
    assert.equal(JSON.stringify(result).includes(auditCredential), false);
  });

  await test('bootstrap profile previews diffs, requires confirmation and preserves immutable safety fields', async () => {
    const preview = await inventory.previewBootstrapLaunchProfile();
    assert.equal(preview.proposed.maxItemsPerDay, 200); assert.equal(preview.proposed.launchEnabled, false);
    await assert.rejects(() => inventory.applyBootstrapLaunchProfile({ actor: 'test-owner', reason: 'Owner reviewed bootstrap profile.', confirmed: false }), /CONFIRMATION_REQUIRED/);
    const applied = await inventory.applyBootstrapLaunchProfile({ actor: 'test-owner', reason: 'Owner reviewed bootstrap profile.', confirmed: true });
    assert.equal(applied.next.launchEnabled, false); assert.equal(applied.next.safePublish, true);
    assert.equal(applied.next.freeOnly, true); assert.equal(applied.next.allowPaidAi, false);
  });

  await test('keyword ranking favors measured yield while retaining exploration and cooldown', async () => {
    const base = { requests: 10, found: 10, normalized: 10, fastRejected: 0, valid: 8, duplicate: 0, quarantined: 0, ready: 6, published: 2, noResult: 0, timeout: 0, rateLimited: 0, costPerValidCandidate: 1, lastUsedAt: '2026-07-17T00:00:00.000Z', nextEligibleAt: '2026-07-17T01:00:00.000Z' };
    const stats = [
      { ...base, keyword: 'tai nghe', cursor: 0 }, { ...base, keyword: 'nồi chiên', cursor: 1, ready: 4 },
      { ...base, keyword: 'serum', cursor: 2, valid: 2, ready: 0, noResult: 4 },
      { ...base, keyword: 'laptop', cursor: 3, nextEligibleAt: '2099-01-01T00:00:00.000Z' },
      ...['giày dép', 'mẹ và bé', 'đồng hồ', 'máy hút bụi'].map((keyword, index) => ({ ...base, keyword, cursor: index + 4, requests: 0, found: 0, normalized: 0, valid: 0, ready: 0, published: 0, costPerValidCandidate: null, lastUsedAt: undefined, nextEligibleAt: undefined })),
    ];
    const selected = pipeline.selectSourceKeywords(stats, 4, Date.parse('2026-07-18T00:00:00.000Z'));
    assert.ok(selected.some(item => item.keyword === 'tai nghe'));
    assert.ok(selected.some(item => item.requests === 0));
    assert.equal(selected.some(item => item.keyword === 'laptop'), false);
  });

  await test('approved CSV and JSON fixtures preview per-row rejection and enter the durable candidate queue only', async () => {
    const csvFile = path.join(fixtureDir, 'approved.csv');
    const jsonFile = path.join(fixtureDir, 'approved.json');
    const header = 'sourceId,title,originalUrl,affiliateUrl,imageUrl,salePrice,category,merchant,platform,observedAt';
    fs.writeFileSync(csvFile, `${header}\ncsv-1,Tai nghe Bluetooth Model CSV,https://merchant.example.com/p/csv-1,https://merchant.example.com/go/csv-1,https://merchant.example.com/i/csv-1.jpg,1190000,Phụ kiện,Merchant A,website,2026-07-18T00:00:00Z\ncsv-2,Thiếu ảnh,https://merchant.example.com/p/csv-2,https://merchant.example.com/go/csv-2,,900000,Phụ kiện,Merchant B,website,2026-07-18T00:00:00Z\n`, 'utf8');
    fs.writeFileSync(jsonFile, JSON.stringify([{ externalId: 'json-1', title: 'Máy hút bụi Model JSON', productUrl: 'https://merchant.example.com/p/json-1', affiliateUrl: 'https://merchant.example.com/go/json-1', imageUrl: 'https://merchant.example.com/i/json-1.jpg', price: 2190000, category: 'Gia dụng', merchant: 'Merchant C', platform: 'website', observedAt: '2026-07-18T00:00:00Z' }]), 'utf8');
    const csv = await importer.previewApprovedDatafeed(fs.readFileSync(csvFile, 'utf8'), 'csv');
    const json = await importer.previewApprovedDatafeed(fs.readFileSync(jsonFile, 'utf8'), 'json');
    assert.equal(csv.validRows, 1); assert.equal(csv.invalidRows, 1); assert.equal(json.validRows, 1);
    assert.ok(csv.rejectionReportUrl); assert.equal(importer.neutralizeCsvFormula('=SUM(1,1)').startsWith("'"), true);
    const applied = await importer.applyImportBatch(csv.previewId, `csv-operation-${runId}`, { parentJobId: 'fixture-import-parent', requestedBy: 'test-owner', approvedSource: true });
    assert.equal(applied.accepted, 1); assert.ok((await candidates.listCandidateQueue()).length >= 1);
    assert.equal((await products.getAllProducts()).length, 0, 'approved datafeed must not write canonical/public products directly');
  });

  await test('JSON preview isolates malformed rows, preserves indexes, counts duplicates and rejects unsupported roots', async () => {
    const good = index => ({
      externalId: `isolated-json-${runId}-${index}`, title: `Verified JSON product model ${index}`,
      productUrl: `https://merchant.example.com/p/isolated-${runId}-${index}`,
      imageUrl: `https://merchant.example.com/i/isolated-${runId}-${index}.jpg`, price: 250000 + index,
      brand: 'Isolated Brand', sku: `ISOLATED-${index}`, observedAt: '2026-07-18T00:00:00Z',
    });
    const beforeCandidates = (await candidates.listCandidateQueue()).length;
    const beforeProducts = (await products.getAllProducts()).length;
    const allValid = await importer.previewApprovedDatafeed(JSON.stringify([good(1), good(2)]), 'json');
    assert.equal(allValid.validRows, 2); assert.equal(allValid.invalidRows, 0);

    const mixed = await importer.previewApprovedDatafeed(JSON.stringify([good(3), 42, good(4)]), 'json');
    assert.equal(mixed.totalRows, 3); assert.equal(mixed.validRows, 2); assert.equal(mixed.invalidRows, 1);
    assert.equal(mixed.rows[1].row, 2); assert.deepEqual(mixed.rows[1].errors, ['json_row_invalid']);
    assert.ok(mixed.rejectionReportUrl);

    const severalBad = await importer.previewApprovedDatafeed(JSON.stringify([null, [], { ...good(5), title: { nested: true } }, good(6)]), 'json');
    assert.deepEqual(severalBad.rows.filter(row => !row.valid).map(row => [row.row, row.errors[0]]), [
      [1, 'json_row_invalid'], [2, 'json_row_invalid'], [3, 'json_field_type_invalid'],
    ]);
    assert.equal(severalBad.validRows, 1); assert.equal(severalBad.invalidRows, 3);
    await assert.rejects(() => importer.previewApprovedDatafeed('42', 'json'), /JSON_ROOT_INVALID/);
    await assert.rejects(() => importer.previewApprovedDatafeed('{}', 'json'), /JSON_ROOT_INVALID/);
    await assert.rejects(() => importer.previewApprovedDatafeed('[]', 'json'), /JSON_HAS_NO_DATA/);
    assert.equal((await candidates.listCandidateQueue()).length, beforeCandidates, 'preview must not persist candidates');
    assert.equal((await products.getAllProducts()).length, beforeProducts, 'preview must not persist products');

    await adapter.writeCollection('products', [{ id: 'duplicate-reference', brand: 'Duplicate Brand', sku: 'DUPLICATE-SKU' }]);
    const duplicatePreview = await importer.previewApprovedDatafeed(JSON.stringify([{
      ...good(7), brand: 'Duplicate Brand', sku: 'DUPLICATE-SKU',
    }]), 'json');
    assert.equal(duplicatePreview.suspectedDuplicates, 1); assert.equal(duplicatePreview.validRows, 0);
    assert.equal(importer.getImportRejectionReportPath('../escape'), null);
    await adapter.writeCollection('products', []);

    const applied = await importer.applyImportBatch(mixed.previewId, `json-isolation-${runId}`, {
      parentJobId: 'json-isolation-parent', requestedBy: 'test-owner', approvedSource: true,
    });
    assert.equal(applied.accepted, 2); assert.equal(applied.rejected, 0);
    assert.equal(applied.processCandidateJobs, 2);
    assert.equal((await products.getAllProducts()).length, 0, 'apply must not write canonical/public products directly');
  });

  await test('launch-ready report exposes truthful targets and controlled wave budgets stay cumulative', async () => {
    const report = await inventory.buildLaunchReadyReport();
    assert.equal(report.totalReady, 0); assert.equal(report.targetPublicCount, 50); assert.equal(report.progressToTarget, 0);
    assert.equal(canary.getControlledWaveBudget(0), 0); assert.equal(canary.getControlledWaveBudget(1), 10);
    assert.equal(canary.getControlledWaveBudget(2), 35); assert.equal(canary.getControlledWaveBudget(3), 85);
    const state = await canary.getCanaryState(); assert.equal(state.controlledLaunch, true); assert.equal(state.wave, 0);
    const decision = await canary.canPublishInCurrentWave('SHADOW', 'fixture-effect');
    assert.equal(decision.allowed, false); assert.equal(decision.reason, 'MODE_DISALLOWS_PUBLISH');
    const wavePreview = await canary.previewControlledPublishWave(1);
    assert.equal(wavePreview.backupVerified, false); assert.equal(wavePreview.eligible, false);
    assert.ok(wavePreview.gates.some(item => item.code === 'BACKUP_VERIFIED' && !item.passed));
  });

  await test('controlled mode transition requires every shared safety gate and never grants publish by mode alone', async () => {
    const now = Date.parse('2026-07-18T03:00:00.000Z');
    const state = {
      schemaVersion: 2, id: 'canary-controller', wave: 0, approvedWave: 0, successfulShadowCycles: 1,
      reservedEffectKeys: [], publishedEffectKeys: [], paused: false, pauseReasons: [], controlledLaunch: true,
      approvedBy: 'test-owner', approvedAt: new Date(now - 60_000).toISOString(), approvalReason: 'Reviewed controlled launch plan.',
      updatedAt: new Date(now).toISOString(),
    };
    const control = {
      schemaVersion: 2, id: 'automation-control', mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: true,
      ingestionPaused: false, workerPaused: false, schedulerPaused: false, killSwitch: false,
      timezone: 'Asia/Ho_Chi_Minh', updatedAt: new Date(now).toISOString(),
    };
    const measurement = {
      sourceCounts: { publicationAttempts: 0 }, workerHeartbeatFresh: true, schedulerHeartbeatFresh: true,
      healthPassRate: 0.99, errorRate: 0.01, rollbackRate: null, publicRouteHealthy: true,
      duplicatePublishCount: 0, unsafePublishCount: 0, storageLockTimeoutCount: 0,
      runtimePublishSafe: true, runtimeReasons: [], measuredAt: new Date(now).toISOString(),
    };
    const evaluate = (overrides = {}) => canary.evaluateControlledModeTransition({
      targetMode: 'CANARY', state, control, measurement, readyForLaunchCount: 2,
      backupVerified: true, ownerConfirmed: true, confirmationAt: new Date(now).toISOString(), now,
      ...overrides,
    });
    assert.equal(evaluate().eligible, true, 'all gates permit the transition decision');
    assert.equal(evaluate({ state: { ...state, controlledLaunch: false } }).eligible, false);
    assert.equal(evaluate({ backupVerified: false }).gates.find(item => item.code === 'BACKUP_VERIFIED').passed, false);
    assert.equal(evaluate({ ownerConfirmed: false }).gates.find(item => item.code === 'OWNER_CONFIRMATION').passed, false);
    assert.equal(evaluate({ confirmationAt: new Date(now - 6 * 60_000).toISOString() }).gates.find(item => item.code === 'CONFIRMATION_FRESH').passed, false);
    assert.equal(evaluate({ measurement: { ...measurement, healthPassRate: 0.8 } }).eligible, false);
    assert.equal(evaluate({ control: { ...control, killSwitch: true } }).gates.find(item => item.code === 'KILL_SWITCH').passed, false);
    assert.equal(evaluate({ measurement: { ...measurement, runtimePublishSafe: false, runtimeReasons: ['STORAGE_BLOCKED'] } }).gates.find(item => item.code === 'NO_CRITICAL_BLOCKER').passed, false);
    assert.equal(evaluate({ targetMode: 'AUTONOMOUS' }).gates.find(item => item.code === 'LAUNCH_WAVE').passed, false);
    assert.equal(evaluate({ targetMode: 'AUTONOMOUS', state: { ...state, controlledLaunch: false } }).eligible, false);
    assert.equal(evaluate({ targetMode: 'AUTONOMOUS', state: { ...state, wave: 1, approvedWave: 1 } }).eligible, true);

    await adapter.writeCollection('automation-canary', []);
    assert.equal((await canary.canPublishInCurrentWave('AUTONOMOUS', 'uncontrolled-effect')).reason, 'CONTROLLED_LAUNCH_REQUIRED');
    assert.equal(await canary.reserveCanaryEffect('AUTONOMOUS', 'uncontrolled-effect'), false);
    await assert.rejects(() => canary.approveControlledPublishWave({
      requestedWave: 1, actor: 'test-owner', reason: 'Owner reviewed requested wave.', confirmed: true,
    }), /CONTROLLED_LAUNCH_REQUIRED/);
    assert.equal((await canary.getCanaryState()).controlledLaunch, undefined, 'wave approval must not auto-activate controlled launch');
  });

  await test('legacy set_mode preserves OBSERVE to SHADOW and cannot bypass the controlled launch gate', async () => {
    await adapter.writeCollection('automation-control', []);
    await adapter.writeCollection('automation-canary', []);
    await store.updateAutomationControl({ mode: 'OBSERVE', effectiveMode: 'OBSERVE', publishPaused: true, killSwitch: false }, 'route-test');
    const request = body => new NextRequest('http://localhost/api/automation/control', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const shadow = await controlRoute.PATCH(request({ action: 'set_mode', mode: 'SHADOW', confirmed: true, reason: 'Owner confirmed shadow policy.' }));
    assert.equal(shadow.status, 200, JSON.stringify(await shadow.clone().json()));
    assert.equal((await shadow.json()).data.mode, 'SHADOW');
    const missingConfirmation = await controlRoute.PATCH(request({ action: 'set_mode', mode: 'CANARY', reason: 'Owner requested controlled canary.' }));
    assert.equal((await missingConfirmation.json()).code, 'CONFIRMATION_REQUIRED');
    const wrongConfirmation = await controlRoute.PATCH(request({ action: 'set_mode', mode: 'CANARY', confirmed: false, reason: 'Owner requested controlled canary.' }));
    assert.equal((await wrongConfirmation.json()).code, 'CONFIRMATION_REQUIRED');
    const expiredConfirmation = await controlRoute.PATCH(request({
      action: 'set_mode', mode: 'CANARY', confirmed: true, confirmedAt: new Date(Date.now() - 6 * 60_000).toISOString(), reason: 'Owner requested controlled canary.',
    }));
    assert.equal((await expiredConfirmation.json()).code, 'CONFIRMATION_EXPIRED');
    const canaryAttempt = await controlRoute.PATCH(request({
      action: 'set_mode', mode: 'CANARY', confirmed: true, confirmedAt: new Date().toISOString(), reason: 'Owner requested controlled canary.',
    }));
    assert.equal(canaryAttempt.status, 409);
    const rejected = await canaryAttempt.json();
    assert.equal(rejected.code, 'CONTROLLED_LAUNCH_REQUIRED');
    assert.ok(rejected.data.blockers.includes('CONTROLLED_LAUNCH_PLAN'));
    const unchanged = await store.getAutomationControl();
    assert.equal(unchanged.mode, 'SHADOW'); assert.equal(unchanged.publishPaused, true);
  });

  await test('production audit emits only GET requests, follows redirects manually and never logs credentials', async () => {
    const methods = [];
    const server = http.createServer((request, response) => {
      methods.push(request.method);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/go/product-1') { response.statusCode = 302; response.setHeader('location', 'https://merchant.example/product-1'); response.end(); return; }
      response.setHeader('content-type', url.pathname.startsWith('/api/') ? 'application/json' : 'text/html');
      if (url.pathname === '/api/public/products') response.end(JSON.stringify({ ok: true, data: { items: [{ id: 'product-1', slug: 'product-one' }], pagination: { totalItems: 1 } } }));
      else if (url.pathname === '/api/automation/dashboard') response.end(JSON.stringify({ ok: true, data: { worker: { status: 'active' }, scheduler: { status: 'active' }, queue: { PENDING: 0 }, inventory: { diagnostic: { candidateQueue: { total: 0 }, totalProductRecords: 1, sourceStatus: 'SOURCE_READY' }, launchReady: { totalReady: 1 } } } }));
      else if (url.pathname === '/api/automation/health') response.end(JSON.stringify({ ok: true, data: { worker: { status: 'active' }, scheduler: { status: 'active' }, queue: { PENDING: 0 } } }));
      else response.end(url.pathname.startsWith('/api/') ? JSON.stringify({ ok: true, data: {} }) : '<!doctype html><title>fixture</title>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const stdout = await runAudit(`http://127.0.0.1:${server.address().port}`);
      const summary = JSON.parse(stdout.trim());
      assert.equal(summary.status, 'PASS'); assert.deepEqual(summary.methods, ['GET']);
      assert.ok(methods.length > 10 && methods.every(method => method === 'GET'));
      const report = fs.readFileSync(path.join(root, summary.output), 'utf8');
      assert.equal(report.includes(auditCredential), false); assert.equal(report.includes('authorization'), false);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  const storedSettings = await settings.getAutomationSettings();
  assert.equal(storedSettings.launchEnabled, false);
  assert.equal((await adapter.readCollection('automation-audit')).some(event => event.operationType === 'BOOTSTRAP_PROFILE_APPLIED'), true);
  console.log(`\nPROMPT10 launch inventory accelerator: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, dataDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
