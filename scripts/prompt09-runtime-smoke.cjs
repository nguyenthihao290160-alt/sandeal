/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, '.test-tmp', `prompt09-runtime-${runId}`);
const processTemp = path.join(root, '.test-tmp', `prompt09-process-temp-${runId}`);
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(processTemp, { recursive: true });

const authUser = 'prompt09-runtime';
const authValue = ['workspace', 'runtime', 'fixture'].join('-');
const authHeader = `Basic ${Buffer.from(`${authUser}:${authValue}`).toString('base64')}`;

process.env.SANDEAL_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = authUser;
process.env.BASIC_AUTH_PASSWORD = authValue;
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
process.env.ALLOW_PAID_AI = 'false';
process.env.ALLOW_PUBLISHING_API = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
process.env.GEMINI_API_KEY = '';
process.env.ACCESS_TRADE_API_KEY = '';

require('./register-typescript.cjs');

function childEnvironment(port) {
  return {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    WINDIR: process.env.WINDIR || 'C:\\Windows',
    TEMP: processTemp,
    TMP: processTemp,
    NODE_ENV: 'production',
    PORT: String(port),
    NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
    SANDEAL_DATA_DIR: dataDir,
    BASIC_AUTH_ENABLED: 'true',
    BASIC_AUTH_USER: authUser,
    BASIC_AUTH_PASSWORD: authValue,
    SANDEAL_ADMIN_PERMISSIONS: '*',
    ALLOW_PAID_AI: 'false',
    ALLOW_PUBLISHING_API: 'false',
    AUTO_PUBLISH_ENABLED: 'false',
    AI_COST_MODE: 'safe_free',
    GEMINI_API_KEY: '',
    ACCESS_TRADE_API_KEY: '',
  };
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'prompt09-smoke-server.cjs')], {
    cwd: root,
    env: childEnvironment(port),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  return { child, output: () => output };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.send({ type: 'shutdown' });
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 12_000))]);
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
  }
  assert.notEqual(child.exitCode, null, 'child process did not stop');
}

async function waitForServer(baseUrl, server) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.child.exitCode !== null) throw new Error(`server exited early: ${server.output().slice(-500)}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { authorization: authHeader },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error(`server readiness timeout: ${server.output().slice(-500)}`);
}

function runOnce(script, args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: root,
      env: childEnvironment(port),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} timeout`));
    }, 30_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${script} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function product(id, overrides = {}) {
  const now = '2026-07-15T06:00:00.000Z';
  return {
    id,
    title: `Sản phẩm runtime ${id}`,
    slug: `san-pham-runtime-${id}`,
    description: `Dữ liệu runtime cô lập cho ${id}, dùng để xác minh route và không đại diện sản phẩm thật.`,
    kind: 'product', platform: 'website', source: 'manual',
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?affiliate=runtime`,
    imageUrl: `https://merchant.example/images/${id}.jpg`, gallery: [],
    price: 1500000, salePrice: id.endsWith('two') ? 1100000 : 1200000, currency: 'VND',
    category: 'Runtime Audio', brand: 'Runtime Brand', sku: `RUNTIME-${id}`,
    specifications: { model: `MODEL-${id}` }, tags: [id], benefits: [], warnings: [],
    riskLevel: 'low', status: 'needs_review', verifiedSource: true, sourceVerified: true,
    autoPublishEligible: true, publicHidden: true, needsVerification: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    linkLastCheckedAt: now, imageLastCheckedAt: now, lastSeenAt: now,
    availability: 'available', sourceHash: `source-${id}`,
    qualityScore: 88, qualityBand: 'good', opportunityScore: 80, opportunityBand: 'recommended',
    dealScore: 84, dealBand: 'featured', dealReasons: ['Fixture runtime đã vượt kiểm tra dữ liệu.'],
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const editorial = require('../src/lib/editorialReview.ts');
  const safePublish = require('../src/lib/safePublish.ts');
  const publicFilter = require('../src/lib/publicProductFilter.ts');
  const store = require('../src/lib/automation/store.ts');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  const published = [product('one'), product('two')].map(source => {
    const reviewContent = editorial.generateEditorialReview(source, [], source.updatedAt);
    const result = safePublish.applySafePublishDecision({ ...source, reviewContent }, source.updatedAt);
    assert.equal(publicFilter.isPublicSafeProduct(result), true);
    return result;
  });
  await adapter.writeCollection('products', published);
  for (const collection of [
    'automation-jobs', 'automation-control', 'automation-audit', 'automation-ai-usage',
    'automation-circuits', 'automation-manual-tasks', 'automation-settings', 'price-history',
    'outbound-events', 'growth-daily', 'product-alerts',
  ]) await adapter.writeCollection(collection, []);
  await store.updateAutomationControl({ workerPaused: false, schedulerPaused: true, killSwitch: false, reason: 'Runtime smoke uses paused scheduler.' }, 'runtime-smoke');
  const queued = await store.createAutomationJob({
    type: 'PRODUCT_SCAN', payload: { limit: 2 }, priority: 50,
    idempotencyKey: `runtime-smoke-dry-run-${runId}`, requestedBy: 'runtime-smoke',
    riskLevel: 'LOW', dryRun: true, maxAttempts: 1,
  });

  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    const routes = [
      ['/', 200, false],
      ['/deals', 200, false],
      [`/deals/${published[0].slug}`, 200, false],
      ['/deals/category/runtime-audio', 200, false],
      ['/deals/brand/runtime-brand', 200, false],
      [`/compare?ids=${published.map(item => item.id).join(',')}`, 200, false],
      ['/review-methodology', 200, false],
      ['/robots.txt', 200, false],
      ['/sitemap.xml', 200, false],
      ['/api/public/products?pageSize=6', 200, false],
      ['/api/public/products?pageSize=51', 400, false],
      ['/api/health', 200, true],
      ['/api/automation/jobs', 401, false],
      ['/api/automation/jobs', 200, true],
      ['/api/automation/health', 200, true],
      ['/api/automation/onboarding', 200, true],
      ['/dashboard/ai-bots', 200, true],
    ];
    for (const [route, expected, authenticated] of routes) {
      const response = await fetch(`${baseUrl}${route}`, {
        headers: authenticated ? { authorization: authHeader } : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, expected, `${route} returned ${response.status}`);
      await response.arrayBuffer();
    }

    const beforeRestart = await fetch(`${baseUrl}/api/automation/jobs/${queued.job.id}`, {
      headers: { authorization: authHeader }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(beforeRestart.status, 200);
    assert.equal((await beforeRestart.json()).data.status, 'PENDING');
    await stopProcess(server.child);
    server = undefined;

    server = startServer(port);
    await waitForServer(baseUrl, server);
    const afterRestart = await fetch(`${baseUrl}/api/automation/jobs/${queued.job.id}`, {
      headers: { authorization: authHeader }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(afterRestart.status, 200);
    const recovered = (await afterRestart.json()).data;
    assert.equal(recovered.id, queued.job.id);
    assert.equal(recovered.status, 'PENDING');
    await stopProcess(server.child);
    server = undefined;

    const worker = await runOnce('automation-worker.cjs', ['--once'], port);
    assert.match(worker.stdout, /"claimed":1/);
    assert.match(worker.stdout, /"succeeded":1/);
    assert.equal((await store.getAutomationJob(queued.job.id)).status, 'SUCCEEDED');

    const scheduler = await runOnce('automation-scheduler.cjs', ['--once'], port);
    assert.match(scheduler.stdout, /"status":"paused"/);
    assert.equal((await store.getAutomationControl()).schedulerPaused, true);

    console.log(JSON.stringify({
      http: { passed: routes.length, total: routes.length },
      restartRecovery: 'PASS',
      worker: { claimed: 1, succeeded: 1 },
      scheduler: 'paused',
      externalRequests: 0,
      artifacts: path.relative(root, dataDir),
    }));
  } finally {
    if (server) await stopProcess(server.child);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
