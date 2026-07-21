/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

require('./register-typescript.cjs');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt13-readiness-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.SANDEAL_BUILD_COMMIT = 'a'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'a'.repeat(40);

let passed = 0;
let failed = 0;
function assert(value, message = 'assertion failed') { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message || `${actual} !== ${expected}`); }
async function test(name, run) {
  try { await run(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error}`); }
}

function fixtureProduct(index, now) {
  return {
    id: `product-${String(index).padStart(2, '0')}`,
    title: `Sản phẩm thật số ${index}`,
    slug: `san-pham-that-${index}`,
    kind: 'product', recordType: 'PRODUCT', platform: 'accesstrade', source: 'accesstrade',
    originalUrl: `https://merchant-${index}.example/products/${index}`,
    canonicalProductUrl: `https://merchant-${index}.example/products/${index}`,
    canonicalUrlSource: 'provider_api', canonicalUrlProvider: 'accesstrade', canonicalUrlSourceEndpoint: 'datafeed', canonicalUrlSourceField: 'url', canonicalUrlStatus: 'unverified',
    affiliateUrl: `https://tracking-${index}.example/click/${index}`,
    affiliateUrlSource: 'provider_api', affiliateUrlProvider: 'accesstrade', affiliateUrlSourceEndpoint: 'datafeed', affiliateUrlSourceField: 'aff_link', affiliateUrlStatus: 'unverified', deepLinkSupported: true,
    imageUrl: `https://images-${index}.example/product.jpg`,
    price: 100000 + index, currency: 'VND', priceObservedAt: now, priceTruthState: 'FRESH',
    tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review', lifecycleState: 'STAGED',
    verifiedSource: true, sourceVerified: true, autoPublishEligible: true, publicHidden: true, publicBlocked: true, needsVerification: true,
    duplicateStatus: 'CLEAR', claimValidationStatus: 'MISSING_EVIDENCE', createdAt: now, updatedAt: now,
  };
}

(async () => {
  const adapter = require('../src/lib/storage/adapter.ts');
  const truthModule = require('../src/lib/automation/truth.ts');
  const dashboard = require('../src/lib/automation/dashboard.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const products = require('../src/lib/storage/products.ts');
  const jobs = require('../src/lib/product-intelligence/jobs.ts');
  const mismatch = require('../src/lib/buildMismatch.ts');
  const release = require('../src/lib/releaseIdentity.ts');

  await test('heartbeat scheduler hiện tại không bị snapshot nextRunAt cũ ghi đè', () => {
    const now = Date.now();
    const iso = offset => new Date(now + offset).toISOString();
    const built = truthModule.buildAutomationTruth({
      now,
      settings: { enabled: true, intervalHours: 1, maxItemsPerDay: 100 },
      control: { schedulerPaused: false, workerPaused: false, schedulerHeartbeatAt: iso(-5000), schedulerLastRunAt: iso(-3_600_000), schedulerNextRunAt: iso(-300_000) },
      leases: [{ schemaVersion: 3, id: 'SCHEDULER', role: 'SCHEDULER', ownerId: 'scheduler-1', holderId: 'scheduler-1', instanceId: 'scheduler-instance', status: 'ACTIVE', acquiredAt: iso(-60_000), startedAt: iso(-60_000), heartbeatAt: iso(-5000), expiresAt: iso(40_000), leaseExpiresAt: iso(40_000), fencingToken: 3, takeoverCount: 0, updatedAt: iso(-5000), releaseId: 'a'.repeat(40) }],
      conflicts: [], jobs: [], usage: { day: truthModule.vietnamDayKey ? truthModule.vietnamDayKey(now) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(now)), requests: 0, requestLimit: 100, tokens: 0, tokenLimit: 1000, blocked: 0 },
    });
    equal(built.scheduler.active, true);
    equal(built.scheduler.runtimeState, 'ACTIVE');
    equal(built.scheduler.scheduleState, 'OVERDUE');
    equal(built.scheduler.heartbeatSource, 'role_lease');
    equal(built.inconsistencies.find(item => item.code === 'NEXT_RUN_OVERDUE')?.severity, 'WARNING');
    equal(dashboard.schedulerRuntimeStatusFromTruth({ paused: false, enabled: true, active: built.scheduler.active, heartbeatAt: built.scheduler.heartbeatAt, snapshotStatus: 'stale' }), 'active');
  });

  await test('lỗi lịch sử không bị tính thành lỗi hiện tại', () => {
    const now = Date.now();
    const start = now - 24 * 60 * 60_000;
    const makeFailed = (id, at) => ({ id, status: 'FAILED', createdAt: at, updatedAt: at, completedAt: at });
    const historical = Array.from({ length: 30 }, (_, index) => makeFailed(`old-${index}`, new Date(start - 60_000 - index).toISOString()));
    const current = makeFailed('current-1', new Date(now - 60_000).toISOString());
    const summary = dashboard.summarizeDashboardErrors([...historical, current], start, [{ code: 'CURRENT_RUNTIME', severity: 'CRITICAL' }, { code: 'SCHEDULE_WARNING', severity: 'WARNING' }]);
    equal(summary.failedJobsInRange, 1);
    equal(summary.historicalFailedJobs, 30);
    equal(summary.currentRuntimeErrors.length, 1);
    const freshGuardian = dashboard.partitionGuardianReasons(
      ['SCHEDULER_STALE', 'STORAGE_BLOCKED'], new Date(now - 5000).toISOString(), now,
    );
    assert(!freshGuardian.current.includes('SCHEDULER_STALE'));
    assert(freshGuardian.current.includes('STORAGE_BLOCKED'));
    assert(freshGuardian.historical.includes('SCHEDULER_STALE'));
    const staleGuardian = dashboard.partitionGuardianReasons(
      ['STORAGE_BLOCKED'], new Date(now - 10 * 60_000).toISOString(), now,
    );
    equal(staleGuardian.current.length, 0);
    assert(staleGuardian.historical.includes('STORAGE_BLOCKED'));
  });

  await test('reprocess 52 record idempotent, có audit và không hard delete', async () => {
    const now = new Date().toISOString();
    await adapter.writeCollection('products', Array.from({ length: 52 }, (_, index) => fixtureProduct(index + 1, now)));
    await adapter.writeCollection('product-reprocess-audit', []);
    let requests = 0;
    const originalFetch = global.fetch;
    global.fetch = async (input, init) => {
      requests += 1;
      const url = String(input);
      if (init?.method === 'HEAD' && url.includes('images-')) {
        return new Response('', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '12000' } });
      }
      return new Response('<html><title>Verified product</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const job = { id: 'reprocess-job-52', type: 'RECHECK_PRODUCT_HEALTH', payload: { limit: 52, healthTarget: 'all' }, dryRun: false, operationId: 'reprocess-52-fixture', requestedBy: 'test-operator' };
    try {
      const first = await jobs.executeProductIntelligenceJob(job);
      equal(first.processed, 52); equal(first.failed, 0);
      const requestCountAfterFirst = requests;
      const auditAfterFirst = JSON.stringify(await adapter.readCollection('product-reprocess-audit'));
      const second = await jobs.executeProductIntelligenceJob(job);
      equal(second.processed, 0); equal(second.skipped, 52); equal(requests, requestCountAfterFirst);
      equal(JSON.stringify(await adapter.readCollection('product-reprocess-audit')), auditAfterFirst);
    } finally {
      global.fetch = originalFetch;
    }
    const stored = await products.getAllProducts();
    const audit = await adapter.readCollection('product-reprocess-audit');
    equal(stored.length, 52);
    equal(audit.length, 52);
    assert(stored.every(item => item.lastReprocessOperationId === 'reprocess-52-fixture'));
    assert(audit.every(item => item.status === 'COMPLETED' && item.before && item.after));
    equal(stored.filter(item => item.status === 'published').length, 0);
  });

  await test('release ID runtime khớp web, worker và scheduler', async () => {
    await adapter.writeCollection('runtime-role-leases', []);
    const now = Date.now();
    const worker = await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'worker-owner', instanceId: 'worker-instance', now });
    const scheduler = await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'scheduler-owner', instanceId: 'scheduler-instance', now });
    const webRelease = release.getReleaseIdentity().releaseId;
    equal(worker.lease.releaseId, webRelease);
    equal(scheduler.lease.releaseId, webRelease);
  });

  await test('Server Action mismatch được phân loại stale client, không phải lỗi server hiện tại', () => {
    const classified = mismatch.classifyRequestError('Failed to find Server Action. This request might be from an older or newer deployment.', 'action');
    equal(classified.classification, 'STALE_CLIENT_ACTION_MISMATCH');
    equal(classified.currentIncident, false);
    const ordinary = mismatch.classifyRequestError('storage write failed', 'route');
    equal(ordinary.currentIncident, true);
    const nextConfig = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');
    assert(nextConfig.includes('deploymentId: buildCommit'));
  });

  console.log(`\nSanDeal production readiness: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
