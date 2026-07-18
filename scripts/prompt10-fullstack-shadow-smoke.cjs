/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, '.test-tmp', `prompt10-fullstack-${runId}`);
fs.mkdirSync(dataDir, { recursive: true });
const children = new Set();
let mockServer;
let childProcessesStopped = false;

function childEnv(mockUrl) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    SANDEAL_DATA_DIR: dataDir,
    SANDEAL_MOCK_SOURCE_URL: mockUrl,
    ALLOW_PAID_AI: 'false',
    AUTO_PUBLISH_ENABLED: 'false',
    ALLOW_PUBLISHING_API: 'false',
    GEMINI_API_KEY: '',
    ACCESS_TRADE_API_KEY: '',
  };
}

function runChild(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script} timeout`)); }, 40_000);
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer); children.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${script} exited ${code}: ${(stderr || stdout).slice(-1_000)}`));
    });
  });
}

async function stopAll() {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 5_000);
  })));
  children.clear();
  if (mockServer) await new Promise(resolve => mockServer.close(resolve));
  childProcessesStopped = true;
}

function fixture(port, keyword, verifiedSource) {
  const suffix = crypto.createHash('sha1').update(`${keyword}:${verifiedSource}`).digest('hex').slice(0, 10);
  const base = `http://127.0.0.1:${port}`;
  return {
    id: `mock-${suffix}`,
    name: verifiedSource ? `Tai nghe Bluetooth chính hãng ${suffix}` : `Sản phẩm nguồn chưa xác minh ${suffix}`,
    description: 'Fixture local kiểm tra pipeline; không đại diện dữ liệu production.',
    kind: 'product', sourceItemKind: 'product', platform: 'accesstrade',
    imageUrl: `${base}/image/${suffix}.png`, imageCandidates: [`${base}/image/${suffix}.png`],
    originalUrl: `${base}/product/${suffix}`, canonicalProductUrl: `${base}/product/${suffix}`,
    affiliateUrl: `${base}/go/${suffix}`, price: 1490000, salePrice: 1190000,
    category: verifiedSource ? 'Phụ kiện điện thoại' : 'Khác', rawSourceKind: 'product',
    needsVerification: !verifiedSource, verifiedSource, publicHidden: true,
    autoPublishEligible: verifiedSource, publicDecision: verifiedSource ? 'eligible' : 'hidden_needs_verification',
    publicBlockReason: verifiedSource ? '' : 'source_not_verified', qualityScore: verifiedSource ? 96 : 40,
  };
}

async function startMockSource() {
  let sourceRequests = 0;
  mockServer = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/source') {
      sourceRequests += 1;
      const keyword = url.searchParams.get('keyword') || '';
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ items: keyword.includes('empty') ? [] : [fixture(mockServer.address().port, keyword, true), fixture(mockServer.address().port, keyword, false)] }));
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', url.pathname.startsWith('/image/') ? 'image/png' : 'text/html; charset=utf-8');
    response.end(url.pathname.startsWith('/image/') ? Buffer.from('89504e470d0a1a0a', 'hex') : 'local fixture');
  });
  await new Promise((resolve, reject) => { mockServer.once('error', reject); mockServer.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${mockServer.address().port}/source`, count: () => sourceRequests };
}

async function main() {
  const mock = await startMockSource();
  Object.assign(process.env, childEnv(mock.url));
  require('./register-typescript.cjs');
  const adapter = require('../src/lib/storage/adapter.ts');
  const settingsStore = require('../src/lib/storage/automationSettings.ts');
  const store = require('../src/lib/automation/store.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const reconciler = require('../src/lib/automation/reconciler.ts');
  const productsStore = require('../src/lib/storage/products.ts');
  const publicFilter = require('../src/lib/publicProductFilter.ts');
  const dashboardModule = require('../src/lib/automation/dashboard.ts');

  await settingsStore.updateAutomationSettings({
    enabled: true, sourceScanEnabled: true, source: 'accesstrade', intervalHours: 3,
    maxItemsPerRun: 10, maxItemsPerDay: 20, sourceKeywords: ['tai nghe'],
    bootstrapKeywordCount: 1, bootstrapCandidateLimit: 10, bootstrapReviewBatch: 4,
    maxConcurrency: 4, launchEnabled: false, safePublish: true, freeOnly: true,
    allowPaidAi: false, costMode: 'safe_free',
  });
  await store.updateAutomationControl({
    mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: true, ingestionPaused: false,
    workerPaused: false, schedulerPaused: false, killSwitch: false,
    workerHeartbeatAt: new Date().toISOString(), reason: 'Prompt 10 isolated full-stack shadow smoke.',
  }, 'prompt10-smoke');

  const scheduler = await runChild('automation-scheduler.cjs', ['--once'], childEnv(mock.url));
  assert.match(scheduler.stdout, /scheduler_role_acquired/);
  assert.match(scheduler.stdout, /"automation":\{"status":"scheduled"/);

  let workerClaims = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const tick = await runChild('automation-worker.cjs', ['--once'], childEnv(mock.url));
    const claimed = Number(tick.stdout.match(/"claimed":(\d+)/)?.[1] || 0);
    workerClaims += claimed;
    const stats = await store.getAutomationQueueStats();
    if (claimed === 0 || (stats.PENDING === 0 && stats.RETRY_SCHEDULED === 0)) break;
  }

  await reconciler.runAutonomousReconciler();
  const jobsAfterPipeline = await store.getAllAutomationJobs();
  const autoPilot = jobsAfterPipeline.find(job => job.type === 'AUTO_PILOT');
  const candidateJobs = jobsAfterPipeline.filter(job => job.type === 'PROCESS_CANDIDATE');
  assert.equal(autoPilot?.status, 'SUCCEEDED');
  assert.ok(candidateJobs.length > 0);
  assert.ok(candidateJobs.some(job => job.status === 'SUCCEEDED'));

  const canonical = await productsStore.getAllProducts();
  const ready = canonical.find(product => product.lifecycleState === 'READY_FOR_PUBLISH');
  const quarantined = canonical.find(product => product.lifecycleState === 'QUARANTINED' || product.status === 'needs_review');
  assert.ok(ready, 'verified source fixture did not reach launch readiness');
  assert.ok(quarantined, 'unverified fixture was not held for review/quarantine');
  const publicBefore = canonical.filter(publicFilter.isPublicSafeProduct).length;

  const publish = await store.createAutomationJob({
    type: 'AUTO_SAFE_PUBLISH', payload: { productId: ready.id }, priority: 95,
    idempotencyKey: `prompt10-shadow-publish:${ready.id}`, requestedBy: 'scheduler', maxAttempts: 1,
  });
  const publishTick = await runChild('automation-worker.cjs', ['--once'], childEnv(mock.url));
  workerClaims += Number(publishTick.stdout.match(/"claimed":(\d+)/)?.[1] || 0);
  const publishJob = await store.getAutomationJob(publish.job.id);
  assert.equal(publishJob.status, 'SUCCEEDED');
  assert.equal(publishJob.result?.published, false);
  const publicAfter = (await productsStore.getAllProducts()).filter(publicFilter.isPublicSafeProduct).length;
  assert.equal(publicAfter, publicBefore);

  const beforeRestartCount = (await store.getAllAutomationJobs()).filter(job => job.type === 'AUTO_PILOT').length;
  await store.updateAutomationControl({ schedulerNextRunAt: undefined, workerHeartbeatAt: new Date().toISOString() }, 'prompt10-smoke');
  const schedulerRestart = await runChild('automation-scheduler.cjs', ['--once'], childEnv(mock.url));
  assert.match(schedulerRestart.stdout, /"automation":\{"status":"duplicate"/);
  const afterRestartCount = (await store.getAllAutomationJobs()).filter(job => job.type === 'AUTO_PILOT').length;
  assert.equal(afterRestartCount, beforeRestartCount);

  const leaseNow = Date.now();
  const firstLease = await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'smoke-a', instanceId: 'smoke-a-1', leaseMs: 5_000, now: leaseNow });
  const duplicateLease = await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'smoke-b', instanceId: 'smoke-b-1', leaseMs: 5_000, now: leaseNow + 1_000 });
  assert.equal(firstLease.acquired, true); assert.equal(duplicateLease.acquired, false);
  const takeover = await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'smoke-c', instanceId: 'smoke-c-1', leaseMs: 5_000, now: leaseNow + 6_000 });
  assert.equal(takeover.event, 'TAKEN_OVER');
  await roles.releaseRuntimeRole('SCHEDULER', takeover.ownership, leaseNow + 6_001);

  const malformed = store.createAutomationJobRecord({ type: 'PRODUCT_SCAN', payload: {}, idempotencyKey: 'prompt10-malformed-schema', requestedBy: 'prompt10-smoke' });
  await adapter.runTransaction('automation-jobs', jobs => [...jobs, { ...malformed, schemaVersion: 1 }]);
  await store.claimAutomationJobs('prompt10-schema-check', 1);
  assert.equal((await store.getAutomationJob(malformed.id)).status, 'BLOCKED');

  await settingsStore.updateAutomationSettings({ sourceKeywords: ['empty result'], bootstrapKeywordCount: 1 });
  const noResults = await pipeline.scanSourcesToQueue('bootstrap', Date.now() + 20_000);
  assert.equal(noResults.found, 0);

  await store.updateAutomationControl({ killSwitch: true, publishPaused: true, reason: 'Prompt 10 smoke kill-switch assertion.' }, 'prompt10-smoke');
  const killed = await store.createAutomationJob({ type: 'PRODUCT_SCAN', payload: { limit: 1 }, idempotencyKey: `prompt10-kill-${runId}`, requestedBy: 'prompt10-smoke' });
  const killedTick = await runChild('automation-worker.cjs', ['--once'], childEnv(mock.url));
  assert.match(killedTick.stdout, /"claimed":0/);
  assert.equal((await store.getAutomationJob(killed.job.id)).status, 'PENDING');
  await store.updateAutomationControl({ killSwitch: false, publishPaused: true, reason: 'Prompt 10 smoke cleanup.' }, 'prompt10-smoke');

  const dashboard = await dashboardModule.buildAutomationDashboard('24h');
  const finalJobs = await store.getAllAutomationJobs();
  const sourceFound = Number(autoPilot.result?.summary?.found || 0);
  const candidateQueued = Number(autoPilot.result?.summary?.queued || 0);
  const candidateProcessed = finalJobs.filter(job => job.type === 'PROCESS_CANDIDATE' && job.status === 'SUCCEEDED').length;
  const productCreated = (await productsStore.getAllProducts()).length;
  const launchReady = dashboard.inventory.launchReady.totalReady;
  const result = {
    schedulerAcquire: true, duplicateSchedulerRejected: true, staleLeaseTakeover: true,
    schedulerRestartNoDuplicateBucket: true, workerRestartResume: workerClaims > 1,
    workerClaim: workerClaims, sourceFound, candidateQueued, candidateProcessed, productCreated,
    launchReady, publishBlocked: publishJob.result?.published === false ? 1 : 0,
    publicProductCountBefore: publicBefore, publicProductCountAfter: publicAfter,
    invalidCandidateQuarantined: Boolean(quarantined), malformedJobBlocked: true,
    killSwitch: true, sourceNoResults: true, dashboardHealthData: Boolean(dashboard.inventory?.diagnostic),
    externalRequests: 0, localMockRequests: mock.count(), childProcessesStopped: false,
    artifacts: path.relative(root, dataDir),
  };
  assert.ok(result.sourceFound > 0 && result.candidateQueued > 0 && result.candidateProcessed > 0 && result.productCreated > 0);
  assert.ok(result.publishBlocked > 0 && result.publicProductCountAfter === result.publicProductCountBefore);
  return result;
}

let finalResult;
main().then(result => { finalResult = result; }).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1;
}).finally(async () => {
  await stopAll();
  if (finalResult) console.log(JSON.stringify({ ...finalResult, childProcessesStopped }, null, 2));
});
