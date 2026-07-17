/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const runId = `${process.pid}-${Date.now()}`;
const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-self-healing-${runId}`);
const restoreDir = path.join(process.cwd(), '.test-tmp', `prompt10-restore-${runId}`);
const backupDir = path.join(process.cwd(), '.test-tmp', `prompt10-backups-${runId}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.SANDEAL_PUBLIC_HEALTH_BASE_URL = 'http://127.0.0.1:43119';
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.GEMINI_API_KEY = '';
require('./register-typescript.cjs');

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

function sourceHash(id) {
  return crypto.createHash('sha256').update(`source:${id}`).digest('hex');
}

function publishedProduct(id, overrides = {}) {
  const now = new Date().toISOString();
  const base = {
    schemaVersion: 2,
    id,
    title: 'Auralink Pro wireless noise cancelling headphones',
    slug: `auralink-pro-${id}`,
    description: 'Wireless over-ear headphones with Bluetooth 5.3, active noise cancellation, replaceable cushions, and a twelve-month merchant warranty.',
    kind: 'product',
    recordType: 'PRODUCT',
    lifecycleState: 'PUBLISHED',
    lifecycleVersion: 'product-lifecycle-v1',
    lifecycleUpdatedAt: now,
    platform: 'website',
    source: 'manual',
    sourceId: `auralink-${id}`,
    originalUrl: `https://merchant.example/products/${id}`,
    affiliateUrl: `https://merchant.example/products/${id}?ref=sandeal`,
    imageUrl: `https://merchant.example/assets/${id}.jpg`,
    gallery: [`https://merchant.example/assets/${id}-gallery.jpg`],
    price: 1500000,
    salePrice: 1200000,
    currency: 'VND',
    category: 'Audio',
    brand: 'Auralink',
    sku: `AURALINK-${id}`,
    specifications: { connection: 'Bluetooth 5.3', warranty: '12 months', battery: '40 hours' },
    tags: ['headphones', 'wireless'],
    benefits: ['Active noise cancellation'],
    warnings: [],
    riskLevel: 'low',
    status: 'published',
    publicDecision: 'published',
    publicHidden: false,
    needsVerification: false,
    autoPublished: true,
    verifiedSource: true,
    sourceVerified: true,
    autoPublishEligible: true,
    linkHealthStatus: 'ok',
    affiliateHealthStatus: 'ok',
    imageHealthStatus: 'ok',
    linkLastCheckedAt: now,
    affiliateLastCheckedAt: now,
    imageLastCheckedAt: now,
    duplicateStatus: 'CLEAR',
    claimValidationStatus: 'VERIFIED',
    qualityScore: 98,
    lastSeenAt: now,
    priceObservedAt: now,
    sourceHash: sourceHash(id),
    contentHash: sourceHash(id),
    publicationEffectKey: `publish-effect:${id}:${sourceHash(id)}`,
    publicationJobId: `publication-job-${id}`,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    confidences: {
      classification: 0.99, source: 0.98, price: 0.97, image: 0.98,
      health: 0.98, duplicate: 0.99, contentEvidenceCoverage: 1,
      editorial: 0.95, publish: 0.95, calculatedAt: now, ruleVersion: 'confidence-engine-v2',
    },
    ...overrides,
  };
  const editorial = require('../src/lib/editorialReview.ts');
  return { ...base, reviewContent: editorial.generateEditorialReview(base, [], now) };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const products = require('../src/lib/storage/products.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const monitor = require('../src/lib/automation/postPublishMonitor.ts');
  const evidence = require('../src/lib/autonomous/evidenceGraph.ts');
  const publishPolicy = require('../src/lib/autonomous/publishPolicy.ts');
  const confidence = require('../src/lib/autonomous/confidenceEngine.ts');
  const backups = require('../src/lib/autonomous/backupManager.ts');
  const publicFilter = require('../src/lib/publicProductFilter.ts');

  const collections = [
    'products', 'evidence-facts', 'product-lifecycle-events', 'automation-jobs',
    'automation-control', 'automation-audit', 'automation-canary', 'operation-journal',
    'automation-outbound-events', 'publication-audit', 'manual-tasks',
  ];

  const forbidNetwork = () => {
    global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_SELF_HEALING'); };
  };

  async function reset(mode = 'AUTONOMOUS') {
    forbidNetwork();
    for (const collection of collections) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode,
      effectiveMode: mode,
      publishPaused: false,
      ingestionPaused: false,
      workerPaused: false,
      schedulerPaused: false,
      killSwitch: false,
    }, 'self-healing-test');
  }

  async function seed(id = 'self-healing-product', overrides = {}) {
    let product = publishedProduct(id, overrides);
    const captured = await evidence.captureProductEvidence(product, product.updatedAt);
    product = {
      ...product,
      evidenceCoverage: 1,
      evidenceFactIds: captured.snapshot.evidenceIds,
      evidenceSnapshotAt: captured.snapshot.createdAt,
      evidenceSnapshotHash: captured.snapshot.snapshotHash,
    };
    product.confidences = confidence.calculateProductConfidences(product, {
      evidenceCoverage: 1,
      now: Date.parse(product.updatedAt),
    });
    await adapter.writeCollection('products', [product]);
    return product;
  }

  async function enqueue(productId, outcome, suffix, payload = {}) {
    return store.createAutomationJob({
      type: 'POST_PUBLISH_MONITOR',
      payload: { productId, healthOutcome: outcome, publicPageStatus: 200, sequence: 0, ...payload },
      idempotencyKey: `post-monitor-${suffix}`,
      operationId: `post-monitor-operation-${suffix}`,
      requestedBy: 'autopilot-worker',
      priority: 99,
    });
  }

  async function processOne(job, workerId) {
    const run = await worker.processAutomationBatch(workerId, 1);
    assert.equal(run.succeeded, 1, JSON.stringify({ run, job: await store.getAutomationJob(job.job.id) }));
    return store.getAutomationJob(job.job.id);
  }

  await test('temporary failure is audited, retained public, and backed by a rebuilt health evidence snapshot', async () => {
    await reset();
    const seeded = await seed('temporary');
    const originalFacts = (await evidence.listProductEvidence(seeded.id)).filter(fact => fact.status === 'ACTIVE');
    const protectedIds = originalFacts.filter(fact => ['title', 'price', 'salePrice'].includes(fact.field)).map(fact => fact.id).sort();
    const queued = await enqueue(seeded.id, 'TEMPORARY_FAILURE', 'temporary');
    const completed = await processOne(queued, 'self-heal-worker-temporary');
    const current = await products.getProductById(seeded.id);
    assert.equal(current.status, 'published');
    assert.equal(current.publicHidden, false);
    assert.equal(current.lifecycleState, 'DEGRADED');
    assert.equal(current.linkHealthStatus, 'timeout');
    assert.equal(publicFilter.isPublicSafeProduct(current), true);
    assert.equal((await products.getPublicProducts()).some(product => product.id === seeded.id), true);
    assert.equal(publicFilter.isPublicSafeProduct({ ...current, publicationEffectKey: undefined, publishedAt: undefined }), false);
    const events = (await adapter.readCollection('product-lifecycle-events')).filter(event => event.productId === seeded.id);
    assert.deepEqual(events.map(event => `${event.previousState}->${event.nextState}:${event.status}`), ['PUBLISHED->DEGRADED:APPLIED']);
    assert.equal(events[0].actor.jobId, queued.job.id);
    assert.equal(events[0].actor.id, 'self-heal-worker-temporary');
    const active = (await evidence.listProductEvidence(seeded.id)).filter(fact => fact.status === 'ACTIVE');
    assert.deepEqual(active.filter(fact => ['title', 'price', 'salePrice'].includes(fact.field)).map(fact => fact.id).sort(), protectedIds);
    assert.equal(active.find(fact => fact.field === 'linkHealthStatus').value, 'timeout');
    assert.deepEqual([...current.evidenceFactIds].sort(), active.map(fact => fact.id).sort());
    const child = (await store.getAllAutomationJobs()).find(job => job.parentJobId === queued.job.id && job.type === 'POST_PUBLISH_MONITOR');
    assert.ok(child);
    assert.equal(child.payload.interval, '15m');
    assert.equal(completed.result.outcome, 'TEMPORARY_FAILURE');
  });

  await test('public page HTTP 500 degrades and retries even when source links and image are healthy', async () => {
    await reset();
    const seeded = await seed('public-page-500');
    const queued = await enqueue(seeded.id, 'HEALTHY', 'public-page-500', { publicPageStatus: 500 });
    const completed = await processOne(queued, 'self-heal-worker-public-page');
    const current = await products.getProductById(seeded.id);
    assert.equal(current.lifecycleState, 'DEGRADED');
    assert.equal(current.status, 'published');
    assert.equal(current.publicHidden, false);
    assert.equal(publicFilter.isPublicSafeProduct(current), true);
    assert.equal(current.linkHealthStatus, 'ok');
    assert.equal(completed.result.outcome, 'TEMPORARY_FAILURE');
    const active = (await evidence.listProductEvidence(seeded.id)).filter(fact => fact.status === 'ACTIVE');
    assert.equal(active.find(fact => fact.field === 'publicPageHealthStatus').value, 'server_error');
    assert.equal(current.confidences.publish, 0.4);
  });

  await test('one permanent observation retains public state and the second claimed observation confirms then hides', async () => {
    await reset();
    const seeded = await seed('confirmed-broken');
    const first = await enqueue(seeded.id, 'CONFIRMED_BROKEN', 'broken-first');
    await processOne(first, 'self-heal-worker-broken-1');
    let current = await products.getProductById(seeded.id);
    assert.equal(current.lifecycleState, 'DEGRADED');
    assert.equal(current.status, 'published');
    assert.equal(current.publicHidden, false);
    const second = await enqueue(seeded.id, 'CONFIRMED_BROKEN', 'broken-second');
    const claimed = (await store.claimAutomationJobs('self-heal-worker-broken-2', 1))[0];
    assert.equal(claimed.id, second.job.id);
    const firstResult = await monitor.executePostPublishMonitor(claimed, 'self-heal-worker-broken-2');
    const replayResult = await monitor.executePostPublishMonitor(claimed, 'self-heal-worker-broken-2');
    assert.equal(firstResult.childJobId, replayResult.childJobId);
    await store.completeAutomationJob(claimed.id, 'self-heal-worker-broken-2', firstResult);
    current = await products.getProductById(seeded.id);
    assert.equal(current.lifecycleState, 'HIDDEN');
    assert.equal(current.status, 'needs_review');
    assert.equal(current.publicHidden, true);
    assert.equal(current.hiddenReason, 'confirmed_broken');
    assert.equal(publicFilter.isPublicSafeProduct(current), false);
    assert.equal((await products.getPublicProducts()).some(product => product.id === seeded.id), false);
    const transitions = (await adapter.readCollection('product-lifecycle-events')).map(event => `${event.previousState}->${event.nextState}`);
    assert.deepEqual(transitions, [
      'PUBLISHED->DEGRADED',
      'DEGRADED->RECHECKING',
      'RECHECKING->CONFIRMED_BROKEN',
      'CONFIRMED_BROKEN->HIDDEN',
    ]);
    const secondEvents = (await adapter.readCollection('product-lifecycle-events')).filter(event => event.actor.jobId === second.job.id);
    assert.equal(secondEvents.length, 3);
    assert.ok(secondEvents.every(event => event.actor.id === 'self-heal-worker-broken-2' && event.status === 'APPLIED'));
    const hiddenRecheck = (await store.getAllAutomationJobs()).find(job => job.parentJobId === second.job.id && job.payload.reason === 'hidden-recheck');
    assert.ok(hiddenRecheck);
    assert.equal(hiddenRecheck.payload.interval, '24h');
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.parentJobId === second.job.id && job.payload.reason === 'hidden-recheck').length, 1);
    assert.equal((await adapter.readCollection('product-lifecycle-events')).filter(event => event.actor.jobId === second.job.id && event.nextState === 'HIDDEN').length, 1);
  });

  await test('hidden recovery replay creates one AUTO_SAFE_PUBLISH child and one exactly-once publication effect', async () => {
    await reset();
    const seeded = await seed('recovery');
    const first = await enqueue(seeded.id, 'CONFIRMED_BROKEN', 'recovery-broken-first');
    await processOne(first, 'self-heal-worker-recovery-1');
    const second = await enqueue(seeded.id, 'CONFIRMED_BROKEN', 'recovery-broken-second');
    await processOne(second, 'self-heal-worker-recovery-2');
    assert.equal((await products.getProductById(seeded.id)).lifecycleState, 'HIDDEN');

    const recovery = await enqueue(seeded.id, 'HEALTHY', 'recovery-healthy', { sequence: 2 });
    const claimed = (await store.claimAutomationJobs('self-heal-worker-recovery-3', 1))[0];
    assert.equal(claimed.id, recovery.job.id);
    const firstResult = await monitor.executePostPublishMonitor(claimed, 'self-heal-worker-recovery-3');
    const replayResult = await monitor.executePostPublishMonitor(claimed, 'self-heal-worker-recovery-3');
    assert.equal(firstResult.childJobId, replayResult.childJobId);
    let ready = await products.getProductById(seeded.id);
    assert.equal(ready.lifecycleState, 'READY_FOR_PUBLISH');
    assert.equal(ready.publicHidden, true);
    const verification = await publishPolicy.verifyAutonomousPublishEvidence(ready);
    assert.equal(verification.valid, true, JSON.stringify(verification.reasons));
    const publishJobs = (await store.getAllAutomationJobs()).filter(job => job.type === 'AUTO_SAFE_PUBLISH' && job.payload.productId === seeded.id);
    assert.equal(publishJobs.length, 1);
    assert.equal(publishJobs[0].approvalStatus, 'NOT_REQUIRED');
    await store.completeAutomationJob(claimed.id, 'self-heal-worker-recovery-3', firstResult);

    const publishRun = await worker.processAutomationBatch('self-heal-worker-recovery-publish', 1);
    assert.equal(publishRun.succeeded, 1, JSON.stringify(await store.getAutomationJob(publishJobs[0].id)));
    ready = await products.getProductById(seeded.id);
    assert.equal(ready.lifecycleState, 'PUBLISHED');
    assert.equal(ready.status, 'published');
    assert.equal(ready.publicHidden, false);
    const outbound = (await adapter.readCollection('automation-outbound-events')).filter(event => event.productId === seeded.id);
    assert.equal(outbound.length, 1);
    const initialMonitor = (await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR' && job.parentJobId === publishJobs[0].id);
    assert.equal(initialMonitor.length, 1);
    assert.equal(initialMonitor[0].payload.interval, '15m');
  });

  await test('healthy monitoring cadence advances from six hours to 24 hours then periodic', async () => {
    const cases = [
      { sequence: 0, interval: '6h', delay: 6 * 60 * 60_000 },
      { sequence: 1, interval: '24h', delay: 24 * 60 * 60_000 },
      { sequence: 2, interval: 'periodic', delay: 24 * 60 * 60_000 },
    ];
    for (const item of cases) {
      await reset();
      const seeded = await seed(`cadence-${item.sequence}`);
      const queued = await enqueue(seeded.id, 'HEALTHY', `cadence-${item.sequence}`, { sequence: item.sequence });
      const completed = await processOne(queued, `self-heal-worker-cadence-${item.sequence}`);
      const child = (await store.getAllAutomationJobs()).find(job => job.parentJobId === queued.job.id && job.type === 'POST_PUBLISH_MONITOR');
      assert.equal(child.payload.interval, item.interval);
      const elapsed = Date.parse(child.scheduledAt) - Date.parse(completed.startedAt);
      assert.equal(elapsed, item.delay);
    }
  });

  await test('validated canonical URL, alternate offer, and gallery image fallbacks are persisted with evidence', async () => {
    await reset();
    const now = new Date().toISOString();
    const canonicalUrl = 'https://merchant.example/products/fallback-canonical';
    const alternateAffiliate = 'https://backup-merchant.example/products/fallback?ref=sandeal';
    const galleryImage = 'https://merchant.example/assets/fallback-gallery.jpg';
    const seeded = await seed('fallback', {
      identity: {
        sourceId: 'auralink-fallback', canonicalUrl, affiliateUrl: alternateAffiliate,
        normalizedTitle: 'auralink pro wireless noise cancelling headphones', merchant: 'merchant.example',
        identityHash: sourceHash('fallback-identity'), ruleVersion: 'product-identity-v2',
      },
      offers: [{
        id: 'offer-backup', source: 'manual', merchant: 'backup-merchant.example', price: 1200000,
        originalPrice: 1500000, affiliateUrl: alternateAffiliate, health: 'HEALTHY', observedAt: now,
        expiresAt: new Date(Date.now() + 48 * 60 * 60_000).toISOString(), confidence: 0.97, primary: false,
      }],
      gallery: [galleryImage],
    });
    global.fetch = async (input, options = {}) => {
      const url = String(input);
      const healthy = [canonicalUrl, alternateAffiliate, galleryImage].includes(url);
      if (healthy) {
        const image = url === galleryImage;
        return new Response(options.method === 'HEAD' ? null : image ? new Uint8Array(1024) : '<html>ok</html>', {
          status: 200,
          headers: image ? { 'content-type': 'image/jpeg', 'content-length': '1024' } : { 'content-type': 'text/html' },
        });
      }
      return new Response(null, { status: 404, headers: { 'content-type': 'text/html' } });
    };
    const queued = await store.createAutomationJob({
      type: 'POST_PUBLISH_MONITOR',
      payload: { productId: seeded.id, publicPageStatus: 200, sequence: 0 },
      idempotencyKey: 'post-monitor-fallback-validation',
      operationId: 'post-monitor-operation-fallback-validation',
      requestedBy: 'autopilot-worker',
      priority: 99,
    });
    await processOne(queued, 'self-heal-worker-fallback');
    const current = await products.getProductById(seeded.id);
    assert.equal(current.lifecycleState, 'PUBLISHED');
    assert.equal(current.originalUrl, canonicalUrl);
    assert.equal(current.affiliateUrl, alternateAffiliate);
    assert.equal(current.imageUrl, galleryImage);
    assert.equal(current.bestOfferId, 'offer-backup');
    const active = (await evidence.listProductEvidence(seeded.id)).filter(fact => fact.status === 'ACTIVE');
    assert.equal(active.find(fact => fact.field === 'originalUrl').value, canonicalUrl);
    assert.equal(active.find(fact => fact.field === 'affiliateUrl').value, alternateAffiliate);
    assert.equal(active.find(fact => fact.field === 'imageUrl').value, galleryImage);
    forbidNetwork();
  });

  await test('snapshot manifest verifies and restores into an isolated directory', async () => {
    await reset();
    const seeded = await seed('backup-restore');
    const snapshot = await backups.createStorageSnapshot({ sourceDir: tempDir, outputDir: backupDir, reason: 'test', retention: 2 });
    const verified = await backups.verifyStorageSnapshot(snapshot.directory);
    assert.ok(verified.files.some(file => file.name === 'products.json'));
    const restored = await backups.restoreSnapshotToIsolatedDirectory(snapshot.directory, restoreDir);
    assert.equal(restored.restored, verified.files.length);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restoreDir, 'products.json'), 'utf8')).map(item => item.id), [seeded.id]);
  });

  await test('corrupt main uses a valid backup and corrupt main plus backup blocks health', async () => {
    await reset();
    await adapter.writeCollection('corruption-fixture', [{ id: 'first' }]);
    await adapter.writeCollection('corruption-fixture', [{ id: 'second' }]);
    const mainFile = path.join(tempDir, 'corruption-fixture.json');
    const backupFile = `${mainFile}.bak`;
    fs.writeFileSync(mainFile, '{broken-json', 'utf8');
    assert.equal(await backups.verifyCollectionRecovery('corruption-fixture', tempDir), 'RECOVERABLE_FROM_BACKUP');
    fs.writeFileSync(backupFile, '{also-broken', 'utf8');
    assert.equal(await backups.verifyCollectionRecovery('corruption-fixture', tempDir), 'BLOCKED');
  });

  console.log(`\nPROMPT10 Gate 6 self-healing: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
