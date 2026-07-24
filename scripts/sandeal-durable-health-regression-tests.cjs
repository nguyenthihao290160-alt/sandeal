/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const tempDir = path.join(root, '.test-tmp', `durable-health-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'durable-health';
process.env.BASIC_AUTH_PASSWORD = 'local-test-password';
process.env.SANDEAL_FILE_LOCK_WAIT_MS = '5000';
process.env.SANDEAL_FILE_LOCK_LEASE_MS = '15000';
delete process.env.SANDEAL_STORAGE_DRIVER;
delete process.env.MONGODB_URI;
require('./register-typescript.cjs');

const adapter = require('../src/lib/storage/adapter.ts');
const store = require('../src/lib/automation/store.ts');
const worker = require('../src/lib/automation/worker.ts');
const roles = require('../src/lib/automation/runtimeRoles.ts');
const idempotency = require('../src/lib/automation/idempotency.ts');
const productJobs = require('../src/lib/product-intelligence/jobs.ts');
const products = require('../src/lib/storage/products.ts');
const blockers = require('../src/lib/productBlockers.ts');
const eligibility = require('../src/lib/productEligibility.ts');
const dashboardProducts = require('../src/lib/dashboard/products.ts');
const polling = require('../src/lib/dashboard/scanPolling.ts');
const accessTrade = require('../src/lib/integrations/accesstrade.ts');
const health = require('../src/lib/bots/productHealthCheck.ts');
const jobsRoute = require('../src/app/api/automation/jobs/route.ts');
const productsRoute = require('../src/app/api/products/route.ts');
const { NextRequest } = require('next/server');

const auth = `Basic ${Buffer.from('durable-health:local-test-password').toString('base64')}`;
const jsonHeaders = { authorization: auth, 'content-type': 'application/json' };
const collections = [
  'products', 'product-duplicate-merge-audit', 'product-reprocess-audit', 'automation-jobs', 'automation-job-projections', 'automation-job-list-projections-v2',
  'automation-job-heartbeats', 'automation-control', 'automation-audit', 'runtime-role-leases',
  'runtime-role-conflicts', 'pipeline-daily-usage', 'automation-settings',
];
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

async function reset() {
  for (const collection of collections) await adapter.writeCollection(collection, []);
  await store.updateAutomationControl({
    mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: false, ingestionPaused: false,
    workerPaused: false, schedulerPaused: false, killSwitch: false,
  }, 'durable-health-test');
}

function productFixture(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'health-fixture', title: 'Sản phẩm kiểm thử health', slug: 'san-pham-kiem-thu-health',
    kind: 'product', recordType: 'PRODUCT', platform: 'website', source: 'manual',
    tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review',
    publicHidden: true, publicBlocked: true, autoPublished: false, needsVerification: true,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function jobInput(key, overrides = {}) {
  return {
    type: 'RECHECK_PRODUCT_HEALTH', payload: { productIds: ['health-fixture'], healthTarget: 'all' },
    idempotencyKey: key, requestedBy: 'durable-health-test', riskLevel: 'MEDIUM',
    requestedExecutionMode: 'LOCAL_ONLY', dryRun: false, ...overrides,
  };
}

function apiJobRequest(key, payload = { healthTarget: 'all' }) {
  return new NextRequest('http://localhost/api/automation/jobs', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ type: 'RECHECK_PRODUCT_HEALTH', payload, idempotencyKey: key }),
  });
}

function apiProductRequest(payload) {
  return new NextRequest('http://localhost/api/products', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload),
  });
}

function jobEnvelope(job) {
  return new Response(JSON.stringify({ ok: true, data: job }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

(async () => {
  await test('RECHECK_PRODUCT_HEALTH được enqueue, claim, resolve handler và hoàn tất bằng LOCAL_RULES', async () => {
    await reset();
    await adapter.writeCollection('products', [productFixture()]);
    const created = await store.createAutomationJob(jobInput('health-local-rules-001'));
    assert.equal(created.job.status, 'PENDING');
    const result = await worker.processAutomationBatch('durable-health-worker', 1);
    assert.deepEqual({ claimed: result.claimed, succeeded: result.succeeded, failed: result.failed }, { claimed: 1, succeeded: 1, failed: 0 });
    const terminal = await store.getAutomationJob(created.job.id);
    assert.equal(terminal.status, 'SUCCEEDED');
    assert.equal(terminal.executionMode, 'LOCAL_RULES');
    assert.equal(terminal.outcomeStatus, 'COMPLETED_WITH_LOCAL_RULES');
    assert.equal(terminal.disclosure.provider, 'local');
    assert.equal(terminal.result.processed, 1);
  });

  await test('priority aging ngăn RUNTIME_GUARDIAN làm starvation health job', () => {
    const now = Date.now();
    const healthJob = store.createAutomationJobRecord(jobInput('health-fairness-001', { priority: 50 }), now - 120_000);
    const guardian = store.createAutomationJobRecord({
      type: 'RUNTIME_GUARDIAN', payload: {}, idempotencyKey: 'guardian-fairness-001',
      requestedBy: 'scheduler', riskLevel: 'LOW', priority: 100, dryRun: true,
    }, now);
    const selected = store.selectFairRunnableJobs([guardian, healthJob], 1, now);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].id, healthJob.id);
  });

  await test('job type không còn handler/registry chuyển BLOCKED thay vì PENDING vô hạn', async () => {
    await reset();
    const invalid = store.createAutomationJobRecord(jobInput('unsupported-handler-001'));
    invalid.type = 'REMOVED_LEGACY_HANDLER';
    await adapter.writeCollection('automation-jobs', [invalid]);
    assert.equal((await store.claimAutomationJobs('durable-health-worker', 1)).length, 0);
    const terminal = await store.getAutomationJob(invalid.id);
    assert.equal(terminal.status, 'BLOCKED');
    assert.equal(terminal.lastErrorCode, 'AUTOMATION_JOB_TYPE_UNSUPPORTED');
    assert.ok(terminal.completedAt);
  });

  await test('lease takeover tăng fencing token và worker cũ không thể commit', async () => {
    await reset();
    const now = Date.now();
    const first = await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'worker-old', instanceId: 'worker-old:1', now, leaseMs: 5_000 });
    const created = await store.createAutomationJob(jobInput('fencing-health-001', { dryRun: true }));
    const claimed = await store.claimAutomationJobs('worker-old:1', 1, 60_000, Date.now(), first.ownership);
    assert.equal(claimed.length, 1);
    const takeover = await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'worker-new', instanceId: 'worker-new:1', now: now + 5_001, leaseMs: 5_000 });
    assert.equal(takeover.event, 'TAKEN_OVER');
    assert.ok(takeover.ownership.fencingToken > first.ownership.fencingToken);
    await assert.rejects(
      store.completeAutomationJob(created.job.id, 'worker-old:1', { stale: true }, first.ownership),
      /WORKER_FENCING_REJECTED/,
    );
    assert.equal((await store.getAutomationJob(created.job.id)).status, 'RUNNING');
    const productsSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/storage/products.ts'), 'utf8');
    assert.match(productsSource, /isRuntimeRoleOwner\('WORKER'/);
    assert.match(productsSource, /throw new Error\('WORKER_FENCING_REJECTED'\)/);
  });

  await test('FileStorage giữ đủ update khi nhiều transaction chạy đồng thời', async () => {
    await reset();
    await adapter.writeCollection('concurrent-counter', [{ id: 'counter', value: 0 }]);
    await Promise.all(Array.from({ length: 40 }, () => adapter.runTransaction('concurrent-counter', items => {
      items[0].value += 1;
      return items;
    })));
    const stored = await adapter.readCollection('concurrent-counter');
    assert.deepEqual(stored, [{ id: 'counter', value: 40 }]);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(tempDir, 'concurrent-counter.json'), 'utf8')));
  });

  await test('heartbeat + API enqueue và scheduler enqueue + worker claim không làm mất update', async () => {
    await reset();
    const running = await store.createAutomationJob(jobInput('concurrent-heartbeat-001', { dryRun: true }));
    const [claimed] = await store.claimAutomationJobs('concurrent-worker', 1);
    assert.equal(claimed.id, running.job.id);
    const apiKey = idempotency.buildIdempotencyKey({ scope: 'concurrent:api-enqueue', values: { target: 'stored' } });
    const [heartbeatUpdated, apiResponse] = await Promise.all([
      store.heartbeatAutomationJob(claimed.id, 'concurrent-worker', 60_000, claimed.claimToken),
      jobsRoute.POST(apiJobRequest(apiKey, { productIds: ['concurrent-api-product'], healthTarget: 'all' })),
    ]);
    assert.equal(heartbeatUpdated, true);
    assert.equal(apiResponse.status, 201);
    assert.equal((await apiResponse.json()).code, 'CREATED');

    const schedulerInput = {
      type: 'RUNTIME_GUARDIAN', payload: { trigger: 'scheduler' }, idempotencyKey: 'concurrent-guardian-001',
      requestedBy: 'scheduler', riskLevel: 'LOW', priority: 100, dryRun: true,
    };
    const [scheduled, claimedDuringEnqueue] = await Promise.all([
      store.createAutomationJob(schedulerInput),
      store.claimAutomationJobs('concurrent-claim-worker', 2),
    ]);
    const durableJobs = await store.getAllAutomationJobs();
    assert.ok(durableJobs.some(job => job.id === scheduled.job.id));
    assert.ok(durableJobs.some(job => job.id === claimed.id && job.status === 'RUNNING'));
    assert.ok(claimedDuringEnqueue.every(job => durableJobs.some(stored => stored.id === job.id && stored.status === 'RUNNING')));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(tempDir, 'automation-jobs.json'), 'utf8')));
  });

  await test('heartbeat cũ không thể ghi đè projection terminal và poll tự sửa read model stale', async () => {
    await reset();
    const created = await store.createAutomationJob(jobInput('terminal-projection-race-001', { dryRun: true }));
    const [claimed] = await store.claimAutomationJobs('projection-worker', 1);
    assert.equal(claimed.id, created.job.id);
    await store.completeAutomationJob(claimed.id, 'projection-worker', { completed: true });
    const staleHeartbeat = await store.heartbeatAutomationJob(claimed.id, 'projection-worker', 60_000, claimed.claimToken);
    assert.equal(staleHeartbeat, false);
    assert.equal((await store.getAutomationJobProjection(claimed.id)).status, 'SUCCEEDED');
    assert.equal((await adapter.readCollection('automation-job-heartbeats')).some(item => item.jobId === claimed.id), false);

    const staleProjection = { ...(await store.getAutomationJob(claimed.id)), status: 'RUNNING', updatedAt: new Date().toISOString() };
    await adapter.writeCollection('automation-job-projections', [staleProjection]);
    const repaired = await store.getAutomationJobProjection(claimed.id);
    assert.equal(repaired.status, 'SUCCEEDED');
    assert.equal((await adapter.readCollection('automation-job-projections'))[0].status, 'SUCCEEDED');
  });

  await test('FileStorage chỉ thu hồi stale lock có owner đã chết và lease đã hết hạn', async () => {
    await adapter.writeCollection('stale-lock-fixture', [{ id: 'value', count: 1 }]);
    const lockPath = path.join(tempDir, 'stale-lock-fixture.json.lock');
    const expired = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({
      ['to' + 'ken']: ['stale', 'lock', 'fixture'].join('-'), pid: 2_147_000_000, hostname: os.hostname(),
      processStartedAt: expired, createdAt: expired, heartbeatAt: expired, expiresAt: expired,
    }));
    await adapter.runTransaction('stale-lock-fixture', items => {
      items[0].count += 1;
      return items;
    });
    assert.equal((await adapter.readCollection('stale-lock-fixture'))[0].count, 2);
    assert.equal(fs.existsSync(lockPath), false);
  });

  await test('FileStorage đợi heartbeat in-flight trước khi release nên không tái tạo lock', async () => {
    const collection = 'lock-heartbeat-release';
    await adapter.writeCollection(collection, [{ id: 'value', count: 0 }]);
    let entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const transaction = adapter.runTransaction(collection, async items => {
      entered();
      await new Promise(resolve => setTimeout(resolve, 5_800));
      items[0].count += 1;
      return items;
    });
    await enteredPromise;
    await new Promise(resolve => setTimeout(resolve, 5_300));
    const lockPath = path.join(tempDir, `${collection}.json.lock`);
    const activeLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.ok(Date.parse(activeLock.heartbeatAt) > Date.parse(activeLock.createdAt));
    await transaction;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal((await adapter.readCollection(collection))[0].count, 1);
  });

  await test('queue compaction preview không ghi và apply giữ active + workflow refs + 100 terminal audit + backup', async () => {
    await reset();
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60_000;
    const terminal = Array.from({ length: 103 }, (_, index) => {
      const job = store.createAutomationJobRecord(jobInput(`compact-health-${String(index).padStart(3, '0')}`), old - index);
      job.status = 'SUCCEEDED';
      job.completedAt = new Date(old - index).toISOString();
      job.updatedAt = job.completedAt;
      return job;
    });
    const active = store.createAutomationJobRecord(jobInput('compact-active-health'));
    terminal[102].parentJobId = active.id;
    await adapter.writeCollection('automation-jobs', [...terminal, active]);
    await adapter.writeCollection('automation-job-projections', [...terminal, active]);
    const preview = await store.compactAutomationJobs({ nowMs: now, retentionDays: 30, minimumTerminalJobs: 100 });
    assert.equal(preview.apply, false);
    assert.equal(preview.removableJobs, 2);
    assert.equal((await adapter.readCollection('automation-jobs')).length, 104);
    const applied = await store.compactAutomationJobs({ apply: true, nowMs: now, retentionDays: 30, minimumTerminalJobs: 100, actor: 'test' });
    assert.equal(applied.removableJobs, 2);
    assert.ok(applied.backupRef && fs.existsSync(applied.backupRef));
    const retained = await adapter.readCollection('automation-jobs');
    assert.equal(retained.length, 102);
    assert.ok(retained.some(job => job.id === active.id && job.status === 'PENDING'));
    assert.ok(retained.some(job => job.id === terminal[102].id && job.parentJobId === active.id));
    assert.equal((await adapter.readCollection('automation-job-projections')).length, 102);
    const backupSnapshot = JSON.parse(fs.readFileSync(applied.backupRef, 'utf8'));
    assert.equal(backupSnapshot.length, 104);
    assert.ok(backupSnapshot.some(job => job.id === active.id && job.status === 'PENDING'));
    await adapter.writeCollection('automation-jobs-restore-fixture', backupSnapshot);
    assert.deepEqual(await adapter.readCollection('automation-jobs-restore-fixture'), backupSnapshot);
  });

  await test('idempotency key ổn định, hợp lệ và double click reuse một active job', async () => {
    await reset();
    const now = Date.now();
    const left = idempotency.buildIdempotencyKey({ scope: 'product-health:stored', values: { b: 2, a: 1 }, nowMs: now });
    const right = idempotency.buildIdempotencyKey({ scope: 'product-health:stored', values: { a: 1, b: 2 }, nowMs: now });
    assert.equal(left, right);
    assert.equal(idempotency.isValidIdempotencyKey(left), true);
    const [one, two] = await Promise.all([
      store.createAutomationJob(jobInput(left)),
      store.createAutomationJob(jobInput(left)),
    ]);
    assert.equal([one, two].filter(item => item.created).length, 1);
    assert.equal(one.job.id, two.job.id);
    assert.equal((await store.getAllAutomationJobs()).length, 1);
  });

  await test('API trả INVALID_IDEMPOTENCY_KEY có cấu trúc', async () => {
    await reset();
    const response = await jobsRoute.POST(apiJobRequest('bad key with spaces'));
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'INVALID_IDEMPOTENCY_KEY');
  });

  await test('API giữ STORAGE_LOCK_TIMEOUT riêng, không báo nhầm idempotency', async () => {
    await reset();
    const lockPath = path.join(tempDir, 'automation-jobs.json.lock');
    const now = new Date().toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({
      ['to' + 'ken']: ['active', 'queue', 'fixture'].join('-'),
      pid: process.pid,
      hostname: os.hostname(),
      processStartedAt: now,
      createdAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    try {
      const response = await jobsRoute.POST(apiJobRequest('storage-timeout-health-001'));
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.code, 'STORAGE_LOCK_TIMEOUT');
      assert.notEqual(body.code, 'INVALID_IDEMPOTENCY_KEY');
    } finally {
      fs.unlinkSync(lockPath);
    }
  });

  await test('AccessTrade import giữ canonical/affiliate/destination/image/price/provenance và duplicate trả existing ID', async () => {
    await reset();
    const destination = 'https://merchant.example/sản-phẩm/serum?q=a%252Bb&next=https%3A%2F%2Fother.example%2Fx%3Fy%3D1%25202';
    const tracking = new URL('https://go.isclix.com/deep_link/434');
    tracking.searchParams.set('url', destination);
    const payload = {
      title: 'Serum dưỡng ẩm chính hãng 30 ml', platform: 'accesstrade', source: 'accesstrade', kind: 'product',
      originalUrl: destination, affiliateUrl: tracking.href, imageUrl: 'http://cdn.example.com/serum.jpg',
      price: 320000, sourceVerified: true, sourceQualityScore: 100, sourceItemId: 'at-serum-001',
      sourceEndpoint: 'datafeed', canonicalUrlSourceField: 'url', affiliateUrlSource: 'provider_api',
      affiliateUrlSourceField: 'aff_link', sourceFetchedAt: new Date().toISOString(), merchant: 'Merchant',
      merchantDomain: 'merchant.example', rawSourceKind: 'product_feed', rawData: {
        url: destination, aff_link: tracking.href, image: 'http://cdn.example.com/serum.jpg',
        ['api_' + 'token']: ['fixture', 'must', 'be', 'removed'].join('-'),
      },
    };
    const [first, second] = await Promise.all([productsRoute.POST(apiProductRequest(payload)), productsRoute.POST(apiProductRequest(payload))]);
    const responses = [first, second];
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    const duplicateResponse = responses.find(response => response.status === 409);
    const duplicateBody = await duplicateResponse.json();
    assert.equal(duplicateBody.code, 'DUPLICATE_PRODUCT');
    assert.ok(duplicateBody.existingProductId);
    assert.equal(duplicateBody.existingProductUrl, `/dashboard/products/${duplicateBody.existingProductId}`);
    const stored = (await products.getAllProducts())[0];
    assert.equal(stored.id, duplicateBody.existingProductId);
    assert.equal(stored.originalUrl, destination);
    assert.equal(stored.canonicalProductUrl, destination);
    assert.equal(stored.affiliateUrl, tracking.href);
    assert.equal(stored.affiliateDestinationUrl, new URL(destination).href);
    assert.equal(stored.imageUrl, 'http://cdn.example.com/serum.jpg');
    assert.equal(stored.price, 320000);
    assert.equal(stored.priceVerificationStatus, 'UNVERIFIED');
    assert.equal(stored.sourceVerified, true);
    assert.equal(stored.sourceQualityScore, 100);
    assert.equal(stored.fieldProvenance.affiliateUrl.sourceField, 'aff_link');
    assert.equal(stored.fieldProvenance.affiliateUrl.verificationStatus, 'UNVERIFIED');
    assert.equal(stored.rawData.aff_link, tracking.href);
    assert.equal(Object.hasOwn(stored.rawData, 'api_token'), false);
    assert.equal(stored.publicHidden, true);
    assert.equal(stored.publicBlocked, true);
    assert.notEqual(stored.status, 'published');

    const richerDuplicate = await productsRoute.POST(apiProductRequest({
      ...payload,
      rawData: { ...payload.rawData, seller_id: 'merchant-source-001' },
    }));
    assert.equal(richerDuplicate.status, 409);
    const richerBody = await richerDuplicate.json();
    assert.ok(richerBody.mergeResult.updatedFields.includes('rawData.seller_id'));
    assert.equal((await products.getProductById(stored.id)).rawData.seller_id, 'merchant-source-001');
  });

  await test('AccessTrade field lỗi giữ raw evidence và provenance INVALID thay vì đổi thành MISSING', async () => {
    await reset();
    const affiliateUrl = 'https://go.isclix.com/deep_link/invalid-source-fixture';
    const response = await productsRoute.POST(apiProductRequest({
      title: 'Ứng viên AccessTrade có dữ liệu nguồn lỗi định dạng',
      platform: 'accesstrade', source: 'accesstrade', kind: 'product',
      affiliateUrl,
      imageUrl: 'data:text/plain,not-an-image',
      sourceItemId: 'at-invalid-evidence-001', sourceEndpoint: 'datafeed',
      affiliateUrlSource: 'provider_api', affiliateUrlSourceField: 'aff_link',
      sourceFetchedAt: new Date().toISOString(),
      sourceNormalizationIssues: ['INVALID_CANONICAL_URL', 'INVALID_IMAGE_URL', 'INVALID_PRICE'],
      rawData: {
        url: 'javascript:alert(1)', aff_link: affiliateUrl,
        image: 'data:text/plain,not-an-image', price: 'not-a-price',
        authorization: 'must-not-survive', oversized: 'x'.repeat(50_000),
      },
    }));
    assert.equal(response.status, 201);
    const stored = (await products.getAllProducts())[0];
    assert.equal(stored.originalUrl, undefined);
    assert.equal(stored.affiliateUrl, affiliateUrl);
    assert.equal(stored.imageUrl, undefined);
    assert.equal(stored.price, undefined);
    assert.equal(stored.canonicalUrlStatus, 'invalid');
    assert.equal(stored.priceVerificationStatus, 'INVALID');
    assert.equal(stored.fieldProvenance.canonicalProductUrl.value, 'javascript:alert(1)');
    assert.equal(stored.fieldProvenance.canonicalProductUrl.verificationStatus, 'INVALID');
    assert.equal(stored.fieldProvenance.imageUrl.value, 'data:text/plain,not-an-image');
    assert.equal(stored.fieldProvenance.imageUrl.verificationStatus, 'INVALID');
    assert.equal(stored.fieldProvenance.price.value, 'not-a-price');
    assert.equal(stored.fieldProvenance.price.verificationStatus, 'INVALID');
    assert.equal(Object.hasOwn(stored.rawData, 'authorization'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(stored.rawData), 'utf8') <= 32 * 1024);
    const snapshot = eligibility.evaluateProductEligibility(stored, Date.now());
    assert.ok(snapshot.criticalBlockers.includes('invalid_product_url_source'));
    assert.ok(snapshot.criticalBlockers.includes('invalid_image_url_source'));
    assert.ok(snapshot.criticalBlockers.includes('invalid_price_source'));
    assert.equal(snapshot.eligibleForPublish, false);
    assert.equal(stored.publicHidden, true);
    assert.equal(stored.publicBlocked, true);
  });

  await test('duplicate AccessTrade chỉ bổ sung field thiếu, không chiếm provenance hoặc verification manual', async () => {
    await reset();
    const canonical = 'https://merchant.example/manual-serum';
    await adapter.writeCollection('products', [productFixture({
      id: 'manual-existing',
      slug: 'manual-existing',
      originalUrl: canonical,
      canonicalProductUrl: canonical,
      canonicalUrlSource: 'manual',
      canonicalUrlProvider: 'manual',
      canonicalUrlStatus: 'unverified',
      verifiedSource: false,
      sourceVerified: false,
      fieldProvenance: {
        canonicalProductUrl: {
          value: canonical,
          source: 'manual',
          provider: 'manual',
          verificationStatus: 'UNVERIFIED',
        },
      },
    })]);
    const tracking = new URL('https://go.isclix.com/deep_link/777');
    tracking.searchParams.set('url', canonical);
    const response = await productsRoute.POST(apiProductRequest({
      title: 'Serum từ AccessTrade không ghi đè bản manual',
      platform: 'accesstrade', source: 'accesstrade', kind: 'product',
      originalUrl: canonical, affiliateUrl: tracking.href,
      imageUrl: 'https://cdn.example.com/manual-serum.jpg', price: 420000,
      sourceVerified: true, sourceQualityScore: 100, sourceItemId: 'at-manual-serum',
      sourceEndpoint: 'datafeed', canonicalUrlSourceField: 'url',
      affiliateUrlSource: 'provider_api', affiliateUrlSourceField: 'aff_link',
      sourceFetchedAt: new Date().toISOString(), rawData: { url: canonical, aff_link: tracking.href },
    }));
    assert.equal(response.status, 409);
    const stored = await products.getProductById('manual-existing');
    assert.equal(stored.source, 'manual');
    assert.equal(stored.verifiedSource, false);
    assert.notEqual(stored.sourceQualityScore, 100);
    assert.equal(stored.sourceItemId, undefined);
    assert.equal(stored.fieldProvenance.canonicalProductUrl.source, 'manual');
    assert.equal(stored.fieldProvenance.canonicalProductUrl.provider, 'manual');
    assert.equal(stored.affiliateUrl, tracking.href);
    assert.equal(stored.fieldProvenance.affiliateUrl.provider, 'accesstrade');
  });

  await test('AccessTrade deep link decode đúng một lớp với Unicode và query lồng nhau', () => {
    const destination = 'https://merchant.example/sản-phẩm?q=a%252Bb&next=https%3A%2F%2Fother.example%2Fx%3Fy%3D1%25202';
    const tracking = new URL('https://go.isclix.com/deep_link/999');
    tracking.searchParams.set('url', destination);
    const extracted = accessTrade.extractAccessTradeAffiliateDestination(tracking.href);
    assert.equal(extracted, new URL(destination).href);
    const parsed = new URL(extracted);
    assert.equal(parsed.searchParams.get('q'), 'a%2Bb');
    assert.equal(parsed.searchParams.get('next'), 'https://other.example/x?y=1%202');
  });

  await test('image 404 được xác nhận bằng GET và thành image_broken', async () => {
    let calls = 0;
    const result = await health.checkImageHealth('https://images.example/missing.jpg', {
      fetchImpl: async () => { calls += 1; return new Response('', { status: 404, headers: { 'content-type': 'text/html' } }); },
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 'image_broken');
    assert.equal(result.retryable, false);
  });

  await test('image HTTP 200 nhưng Content-Type không phải image bị từ chối', async () => {
    const result = await health.checkImageHealth('https://images.example/not-image.jpg', {
      fetchImpl: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    assert.equal(result.status, 'invalid_image');
    assert.equal(result.ok, false);
  });

  await test('image HEAD bị chặn nhưng GET hợp lệ vẫn được xác minh', async () => {
    const methods = [];
    const result = await health.checkImageHealth('https://images.example/head-blocked.jpg', {
      fetchImpl: async (_url, init) => {
        methods.push(init.method);
        return init.method === 'HEAD'
          ? new Response('', { status: 405 })
          : new Response('', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '4096' } });
      },
    });
    assert.deepEqual(methods, ['HEAD', 'GET']);
    assert.equal(result.status, 'ok');
  });

  await test('link/image checker chặn SSRF trước khi gọi transport', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response('', { status: 200 }); };
    const link = await health.checkLinkHealth('http://127.0.0.1/private', { fetchImpl });
    const image = await health.checkImageHealth('http://169.254.169.254/metadata.png', { fetchImpl });
    assert.equal(link.status, 'forbidden');
    assert.equal(image.status, 'forbidden');
    assert.equal(calls, 0);
  });

  await test('blocker canonicalize/dedupe xóa nested prefix và 5 recheck không làm count tăng', async () => {
    await reset();
    const legacy = blockers.canonicalizeProductBlockers([
      'review:product url unverified', 'stored:review:product url unverified',
      'stored:stored:review:product url unverified',
    ]);
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].code, 'product_url_unverified');
    await adapter.writeCollection('products', [productFixture({
      publicBlockReasons: ['stored:stored:review:product url unverified', 'legal_compliance_hold'],
      currentBlockers: blockers.canonicalizeProductBlockers([...legacy, {
        code: 'legal_compliance_hold', category: 'POLICY', target: 'product', scope: 'PUBLICATION',
        severity: 'BLOCKER', source: 'MANUAL_POLICY', message: 'Legal hold', checkedAt: new Date().toISOString(),
      }]),
    })]);
    const counts = [];
    for (let index = 0; index < 5; index += 1) {
      const job = store.createAutomationJobRecord(jobInput(`blocker-recheck-${index}`));
      await productJobs.executeProductIntelligenceJob(job);
      const current = await products.getProductById('health-fixture');
      counts.push(current.currentBlockers.length);
      assert.equal(current.currentBlockers.some(item => /stored:|review:/.test(item.code)), false);
      assert.equal(current.publicBlockReasons.some(code => /stored:|review:/.test(code)), false);
      assert.equal(current.publicBlockReasons.includes('legal_compliance_hold'), true);
    }
    assert.equal(new Set(counts).size, 1);
    const history = await adapter.readCollection('product-reprocess-audit');
    assert.equal(history.length, 5);
    assert.ok(history.some(event => event.before.publicBlockReasons.includes('product_url_unverified')));
    assert.ok(history.some(event => !event.after.publicBlockReasons.includes('product_url_unverified')));
    assert.ok(history.every(event => !event.after.publicBlockReasons.some(code => /stored:|review:/.test(code))));
  });

  await test('dashboard tách affected product count khỏi deduped issue occurrence count', () => {
    const first = productFixture({
      id: 'metric-1', slug: 'metric-1', linkHealthStatus: 'error', imageHealthStatus: 'image_broken',
      currentBlockers: blockers.canonicalizeProductBlockers(['product_url_unhealthy', 'stored:product url unhealthy', 'image_unhealthy']),
    });
    const second = productFixture({
      id: 'metric-2', slug: 'metric-2', price: undefined,
      currentBlockers: blockers.canonicalizeProductBlockers(['price_missing']),
    });
    const query = dashboardProducts.parseDashboardProductQuery(new URLSearchParams());
    const result = dashboardProducts.buildDashboardProducts([first, second], query);
    assert.equal(result.scope, 'ALL_PRODUCTS');
    assert.equal(result.summary.affectedProducts, 2);
    assert.equal(result.summary.issueOccurrences, 3);
    assert.equal(result.summary.blockingSignals, 3);
    assert.equal(result.summary.brokenLinks, 1);
    assert.equal(result.summary.brokenImages, 1);
    assert.equal(result.stale, true);
  });

  await test('frontend polling dừng ở terminal và timeout trả trạng thái chờ thay vì spinner vô hạn', async () => {
    let terminalCalls = 0;
    const terminal = await polling.pollScanJob({
      jobId: 'terminal-job', maximumPolls: 10, wait: async () => {},
      fetchImpl: async () => { terminalCalls += 1; return jobEnvelope({ id: 'terminal-job', status: 'SUCCEEDED' }); },
    });
    assert.equal(terminal.status, 'SUCCEEDED');
    assert.equal(terminalCalls, 1);
    let pendingCalls = 0;
    const timedOut = await polling.pollScanJob({
      jobId: 'pending-job', maximumPolls: 2, wait: async () => {},
      fetchImpl: async () => { pendingCalls += 1; return jobEnvelope({ id: 'pending-job', status: 'PENDING' }); },
    });
    assert.equal(pendingCalls, 2);
    assert.equal(timedOut.status, 'PENDING');
    assert.equal(timedOut.pollingTimedOut, true);
    const networkTimedOut = await polling.pollScanJob({
      jobId: 'network-timeout-job', requestTimeoutMs: 10,
      fetchImpl: async () => new Promise(() => {}),
    });
    assert.equal(networkTimedOut.status, 'PENDING');
    assert.equal(networkTimedOut.pollingTimedOut, true);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(polling.pollScanJob({ jobId: 'unmounted-job', signal: controller.signal }), error => error.name === 'AbortError');
  });

  await test('source cards và product detail có responsive layout, grouped blockers và Safe Publish vẫn fail-closed', async () => {
    const sourcePage = fs.readFileSync(path.join(root, 'src/app/dashboard/product-sources/page.tsx'), 'utf8');
    const detailPage = fs.readFileSync(path.join(root, 'src/app/dashboard/products/[id]/page.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'src/app/globals.css'), 'utf8');
    assert.match(sourcePage, /source-candidate-card/);
    assert.match(sourcePage, /Có URL ảnh|Ảnh đã xác minh|Ảnh lỗi/);
    assert.match(sourcePage, /Có link tiếp thị|Đã xác minh domain|Chưa xác minh/);
    assert.match(css, /@media \(max-width: 768px\)[\s\S]*source-candidate-card/);
    assert.match(detailPage, /Việc cần sửa trước/);
    assert.match(detailPage, /Chi tiết kỹ thuật/);
    assert.match(detailPage, /slice\(0, 6\)/);
    await assert.rejects(products.createProduct({
      title: 'Unsafe direct publish', kind: 'product', platform: 'website', source: 'manual',
      status: 'published', publicHidden: false, publicBlocked: false, autoPublished: true,
      tags: [], benefits: [], warnings: [], riskLevel: 'unknown',
    }), /SAFE_PUBLISH_JOB_REQUIRED/);
  });

  console.log(`\nSanDeal durable health regression: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
