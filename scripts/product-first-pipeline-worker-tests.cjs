/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./register-typescript.cjs');

const tempDir = path.join(process.cwd(), '.test-tmp', `product-first-pipeline-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';

let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error.stack || error}`); }
}

function sourceDraft(overrides = {}) {
  const observedAt = '2026-08-03T01:00:00.000Z';
  return {
    title: 'Tai nghe Bluetooth Product First',
    description: 'Tai nghe không dây chính hãng',
    kind: 'product',
    recordType: 'PRODUCT',
    platform: 'accesstrade',
    source: 'accesstrade',
    sourceId: 'at-stable-product-1',
    sourceItemId: 'at-stable-product-1',
    externalId: 'at-stable-product-1',
    sourceEndpoint: 'datafeed',
    sourceFetchedAt: observedAt,
    providerUpdatedAt: observedAt,
    originalUrl: 'https://merchant.example/products/at-stable-product-1',
    canonicalProductUrl: 'https://merchant.example/products/at-stable-product-1',
    canonicalUrlStatus: 'unverified',
    affiliateUrl: 'https://go.isclix.com/click/at-stable-product-1',
    affiliateUrlStatus: 'unverified',
    imageUrl: 'https://images.example/at-stable-product-1.jpg',
    price: 450000,
    currency: 'VND',
    merchant: 'Merchant Example',
    merchantDomain: 'merchant.example',
    shopId: 'shop-1',
    shopName: 'Merchant Shop',
    sku: 'SKU-AT-1',
    tags: [], benefits: [], warnings: [],
    riskLevel: 'low',
    status: 'needs_review',
    publicHidden: true,
    publicBlocked: true,
    needsVerification: true,
    autoPublishEligible: false,
    verifiedSource: true,
    sourceVerified: true,
    fieldProvenance: {
      canonicalProductUrl: { value: 'https://merchant.example/products/at-stable-product-1', source: 'accesstrade', provider: 'accesstrade', endpoint: 'datafeed', fetchedAt: observedAt, verificationStatus: 'UNVERIFIED' },
      affiliateUrl: { value: 'https://go.isclix.com/click/at-stable-product-1', source: 'accesstrade', provider: 'accesstrade', endpoint: 'datafeed', fetchedAt: observedAt, verificationStatus: 'UNVERIFIED' },
      imageUrl: { value: 'https://images.example/at-stable-product-1.jpg', source: 'accesstrade', provider: 'accesstrade', endpoint: 'datafeed', fetchedAt: observedAt, verificationStatus: 'UNVERIFIED' },
      price: { value: 450000, source: 'accesstrade', provider: 'accesstrade', endpoint: 'datafeed', fetchedAt: observedAt, verificationStatus: 'UNVERIFIED' },
    },
    ...overrides,
  };
}

function repairDraft(base, overrides = {}) {
  return {
    source: base.source,
    sourceId: base.sourceId,
    sourceItemId: base.sourceItemId,
    externalId: base.externalId,
    sourceEndpoint: 'datafeed',
    sourceFetchedAt: '2026-08-03T02:00:00.000Z',
    providerUpdatedAt: '2026-08-03T02:00:00.000Z',
    title: base.title,
    ...overrides,
  };
}

function job(id, type, priority, createdAt) {
  return { id, type, priority, createdAt, scheduledAt: createdAt, status: 'PENDING', dryRun: false, payload: {}, operationId: `op-${id}` };
}

function batchResult(workerId, overrides = {}) {
  return { workerId, claimed: 1, criticalClaimed: 0, normalClaimed: 1, succeeded: 1, failed: 0, skipped: 0, waitingManual: 0, waitingChildren: 0, ...overrides };
}

(async () => {
  const adapter = require('../src/lib/storage/adapter.ts');
  const products = require('../src/lib/storage/products.ts');
  const classifier = require('../src/lib/sourceItemClassifier.ts');
  const safePublish = require('../src/lib/safePublish.ts');
  const publishPolicy = require('../src/lib/autonomous/publishPolicy.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const execution = require('../src/lib/automation/executionPolicy.ts');
  const rollout = require('../src/lib/automation/featureRollout.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');

  async function resetProducts() {
    for (const collection of ['products', 'product-source-mappings', 'product-duplicate-merge-audit', 'product-evidence-repair-audit']) {
      await adapter.writeCollection(collection, []);
    }
  }

  async function resetAutomation() {
    for (const collection of [
      'automation-jobs', 'automation-job-attempts', 'automation-job-heartbeats', 'automation-job-projections',
      'automation-job-list-projections-v2', 'automation-control', 'automation-audit', 'runtime-role-leases',
      'runtime-role-conflicts', 'runtime-health', 'publication-audit', 'automation-outbound-events',
    ]) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode: 'SHADOW', effectiveMode: 'SHADOW', workerPaused: false, schedulerPaused: false,
      publishPaused: true, publishBlockedByRuntime: true, killSwitch: false,
    }, 'product-first-test');
  }

  await test('24. real products remain separate from vouchers and campaigns', () => {
    assert.equal(classifier.classifySourceItem(sourceDraft()), 'product');
    assert.equal(classifier.classifySourceItem({ ...sourceDraft(), kind: 'voucher', title: 'Voucher giảm 50%', price: undefined, sku: undefined }), 'voucher');
    assert.equal(classifier.classifySourceItem({ ...sourceDraft(), kind: 'campaign', title: 'Campaign Mega Sale', price: undefined, sku: undefined }), 'campaign');
  });

  await test('25. stable provider identity prevents duplicate product creation', async () => {
    await resetProducts();
    const first = await products.upsertSourceCandidateProduct(sourceDraft());
    const second = await products.upsertSourceCandidateProduct(sourceDraft({ title: 'Tai nghe Bluetooth tên nguồn mới', canonicalProductUrl: 'https://merchant.example/products/new-url', originalUrl: 'https://merchant.example/products/new-url' }));
    const stored = await products.getAllProducts();
    assert.equal(stored.length, 1);
    assert.equal(first.product.id, second.product.id);
  });

  await test('26. newer verified URL replaces an older invalid URL by exact identity', async () => {
    await resetProducts();
    const created = await products.upsertSourceCandidateProduct(sourceDraft({
      originalUrl: 'https://merchant.example/products/old-invalid',
      canonicalProductUrl: 'https://merchant.example/products/old-invalid',
      canonicalUrlStatus: 'invalid', linkHealthStatus: 'broken',
      fieldProvenance: { canonicalProductUrl: { value: 'https://merchant.example/products/old-invalid', source: 'accesstrade', fetchedAt: '2026-08-01T00:00:00.000Z', verificationStatus: 'INVALID' } },
    }));
    const nextUrl = 'https://merchant.example/products/recovered-valid';
    const repaired = await products.repairSourceCandidateEvidence(created.product.id, repairDraft(created.product, {
      originalUrl: nextUrl, canonicalProductUrl: nextUrl, canonicalUrlStatus: 'verified', linkHealthStatus: 'ok',
      productHealthStatus: 'ok', canonicalUrlVerifiedAt: '2026-08-03T02:00:00.000Z', linkLastCheckedAt: '2026-08-03T02:00:00.000Z',
      fieldProvenance: { canonicalProductUrl: { value: nextUrl, source: 'accesstrade', provider: 'accesstrade', fetchedAt: '2026-08-03T02:00:00.000Z', verificationStatus: 'VERIFIED' } },
    }), { expectedUpdatedAt: created.product.updatedAt, verifiedFields: { canonicalProductUrl: true }, verifiedAt: '2026-08-03T02:00:00.000Z' });
    assert.equal(repaired.product.canonicalProductUrl, nextUrl);
    assert.equal(repaired.product.linkHealthStatus, 'ok');
    assert.equal(repaired.product.fieldProvenance.canonicalProductUrl.verificationStatus, 'VERIFIED');
  });

  await test('27. missing, older, or worse evidence cannot overwrite valid verified evidence', async () => {
    await resetProducts();
    const validUrl = 'https://merchant.example/products/current-verified';
    const created = await products.upsertSourceCandidateProduct(sourceDraft({
      originalUrl: validUrl, canonicalProductUrl: validUrl, canonicalUrlStatus: 'verified', linkHealthStatus: 'ok',
      canonicalUrlVerifiedAt: '2026-08-03T03:00:00.000Z',
      fieldProvenance: { canonicalProductUrl: { value: validUrl, source: 'accesstrade', fetchedAt: '2026-08-03T03:00:00.000Z', verifiedAt: '2026-08-03T03:00:00.000Z', verificationStatus: 'VERIFIED' } },
    }));
    const repaired = await products.repairSourceCandidateEvidence(created.product.id, repairDraft(created.product, {
      sourceFetchedAt: '2026-08-02T00:00:00.000Z', providerUpdatedAt: '2026-08-02T00:00:00.000Z',
      originalUrl: 'https://merchant.example/products/older', canonicalProductUrl: 'https://merchant.example/products/older', canonicalUrlStatus: 'verified', linkHealthStatus: 'ok',
    }), { expectedUpdatedAt: created.product.updatedAt, verifiedFields: { canonicalProductUrl: true }, verifiedAt: '2026-08-02T00:00:00.000Z' });
    assert.equal(repaired.product.canonicalProductUrl, validUrl);
    assert(repaired.preservedFields.includes('canonicalProductUrl'));
  });

  await test('28. a quarantined merchant remains quarantined after evidence repair', async () => {
    await resetProducts();
    const created = await products.upsertSourceCandidateProduct(sourceDraft({ lifecycleState: 'QUARANTINED', quarantineReasons: ['merchant_quarantined'], publicDecision: 'quarantined' }));
    const repaired = await products.repairSourceCandidateEvidence(created.product.id, repairDraft(created.product, {
      imageUrl: created.product.imageUrl, imageHealthStatus: 'ok', imageValidationState: 'VALID', imageLastCheckedAt: '2026-08-03T02:00:00.000Z',
    }), { expectedUpdatedAt: created.product.updatedAt, verifiedFields: { imageUrl: true } });
    assert.equal(repaired.product.lifecycleState, 'QUARANTINED');
    assert.deepEqual(repaired.product.quarantineReasons, ['merchant_quarantined']);
    assert.equal(repaired.product.publicDecision, 'quarantined');
  });

  await test('29. an unapproved review remains unapproved after recovery', async () => {
    await resetProducts();
    const reviewContent = { reviewStatus: 'needs_review', reviewTitle: 'Cần biên tập', reviewSummary: 'Chưa duyệt', reviewVerdict: 'Chờ duyệt', strengths: [], limitations: [], keyFacts: [], factualClaims: [], inferredClaims: [], reviewBlockReasons: ['manual_review_required'], reviewContentHash: 'review-hash', reviewVersion: 1 };
    const created = await products.upsertSourceCandidateProduct(sourceDraft({ reviewContent }));
    const repaired = await products.repairSourceCandidateEvidence(created.product.id, repairDraft(created.product, { title: 'Tai nghe Bluetooth nguồn mới hơn' }), {
      expectedUpdatedAt: created.product.updatedAt, verifiedFields: {}, verifiedAt: '2026-08-03T02:00:00.000Z',
    });
    assert.equal(repaired.product.reviewContent.reviewStatus, 'needs_review');
    assert.equal(repaired.product.reviewContent.reviewContentHash, 'review-hash');
  });

  await test('30. invalid canonical, affiliate, image, or price evidence still blocks publication', () => {
    const base = sourceDraft({
      canonicalUrlStatus: 'verified', affiliateUrlStatus: 'verified', linkHealthStatus: 'ok', affiliateHealthStatus: 'ok',
      imageHealthStatus: 'ok', imageValidationState: 'VALID', imageUrlHttpStatus: 200, imageContentType: 'image/jpeg',
      priceVerificationStatus: 'VERIFIED', priceTruthState: 'FRESH', status: 'needs_review', publicHidden: true,
    });
    const variants = [
      { canonicalUrlStatus: 'invalid', linkHealthStatus: 'broken' },
      { affiliateUrlStatus: 'invalid', affiliateHealthStatus: 'broken' },
      { imageHealthStatus: 'broken', imageValidationState: 'BROKEN' },
      { priceVerificationStatus: 'INVALID', priceTruthState: 'UNAVAILABLE' },
    ];
    for (const variant of variants) assert.equal(safePublish.evaluateSafePublish({ ...base, ...variant }).eligible, false);
  });

  await test('31. product evidence preparation proceeds while Runtime Guardian blocks publish', async () => {
    await resetProducts();
    await resetAutomation();
    const control = await store.getAutomationControl();
    assert.equal(control.publishBlockedByRuntime, true);
    const created = await products.upsertSourceCandidateProduct(sourceDraft());
    const repaired = await products.repairSourceCandidateEvidence(created.product.id, repairDraft(created.product, {
      imageUrl: created.product.imageUrl, imageHealthStatus: 'ok', imageValidationState: 'VALID', imageLastCheckedAt: '2026-08-03T02:00:00.000Z',
    }), { expectedUpdatedAt: created.product.updatedAt, verifiedFields: { imageUrl: true } });
    assert.equal(repaired.product.imageHealthStatus, 'ok');
    assert.equal((await store.getAutomationControl()).publishBlockedByRuntime, true);
    assert.notEqual(repaired.product.status, 'published');
  });

  await test('32. final publication remains blocked until product and runtime gates pass', () => {
    const now = Date.now();
    const product = sourceDraft({ lifecycleState: 'READY_FOR_PUBLISH', duplicateStatus: 'CLEAR', claimValidationStatus: 'VERIFIED', evidenceCoverage: 1, evidenceSnapshotAt: new Date(now).toISOString(), confidences: { source: 1, identity: 1, link: 1, image: 1, price: 1, evidence: 1, review: 1, risk: 1, publish: 1 }, canonicalUrlStatus: 'verified', affiliateUrlStatus: 'verified', linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', imageValidationState: 'VALID', imageUrlHttpStatus: 200, imageContentType: 'image/jpeg', priceVerificationStatus: 'VERIFIED', priceTruthState: 'FRESH' });
    const decision = publishPolicy.evaluateAutonomousPublish(product, { mode: 'AUTONOMOUS', killSwitch: false, publishPaused: true, workerId: 'worker-1', jobType: 'AUTO_SAFE_PUBLISH', jobClaimedBy: 'worker-1', withinBudget: true, withinCanaryWave: true, now }, { valid: true, productId: 'p1', reasons: [], coverage: 1, evidenceIds: ['e1'], snapshotHash: 's1', verifiedAt: new Date(now).toISOString(), ruleVersion: 'test' });
    assert.equal(decision.eligible, false);
    assert(decision.reasons.includes('publish_lane_paused'));
    assert.equal(safePublish.evaluateSafePublish({ ...product, affiliateHealthStatus: 'broken' }).eligible, false);
  });

  await test('33. stale product repair revisions fail closed', async () => {
    await resetProducts();
    const created = await products.upsertSourceCandidateProduct(sourceDraft());
    await assert.rejects(
      products.repairSourceCandidateEvidence(created.product.id, repairDraft(created.product, { imageUrl: created.product.imageUrl }), { expectedUpdatedAt: '2000-01-01T00:00:00.000Z', verifiedFields: { imageUrl: true } }),
      error => error && error.code === 'STALE_PRODUCT_REPAIR_REVISION',
    );
    assert.equal((await products.getProductById(created.product.id)).imageHealthStatus, undefined);
  });

  await test('34. Guardian remains the highest safety priority', () => {
    const now = new Date().toISOString();
    const ordered = worker.orderAutomationWorkerBatch([job('product', 'PROCESS_CANDIDATE', 95, now), job('guardian', 'RUNTIME_GUARDIAN', 10, now)]);
    assert.equal(ordered[0].type, 'RUNTIME_GUARDIAN');
    assert.equal(execution.isCriticalAutomationJob('RUNTIME_GUARDIAN'), true);
    assert.equal(execution.isCriticalAutomationJob('PROCESS_CANDIDATE'), false);
  });

  await test('35. product-critical work receives a bounded non-Guardian opportunity', () => {
    const now = Date.now();
    const items = Array.from({ length: 25 }, (_, index) => job(`maintenance-${index}`, 'AGGREGATE_GROWTH_METRICS', 100, new Date(now - index).toISOString()));
    items.push(job('product-forward', 'PROCESS_CANDIDATE', 1, new Date(now).toISOString()));
    const selected = store.selectProductForwardRunnableJobs(items, 1, now);
    assert.equal(selected[0].id, 'product-forward');
    assert.equal(execution.isProductCriticalAutomationJob('RECHECK_PRODUCT_HEALTH'), true);
  });

  await test('36. mixed Guardian/product lanes avoid sequential head-of-line blocking', async () => {
    const completed = [];
    const claimedLane = new Set();
    const result = await worker.runContinuousWorkerPool({
      workerId: 'mixed-lane-test', maxConcurrency: 2, maximumClaims: 2, criticalReservedCapacity: 1, lanePollMs: 100,
      runBatch: async (workerId, ownership, options) => {
        if (claimedLane.has(options.claimLane)) return batchResult(workerId, { claimed: 0, succeeded: 0, normalClaimed: 0 });
        claimedLane.add(options.claimLane);
        const guardian = options.claimLane === 'RUNTIME_GUARDIAN';
        await new Promise(resolve => setTimeout(resolve, guardian ? 80 : 5));
        completed.push(guardian ? 'guardian' : 'product');
        return batchResult(workerId, guardian ? { criticalClaimed: 1, normalClaimed: 0 } : {});
      },
    });
    assert.equal(result.peakInFlight, 2);
    assert.equal(completed[0], 'product');
    assert.deepEqual(completed.sort(), ['guardian', 'product']);
  });

  await test('37. fencing rejection prevents stale worker execution', async () => {
    await resetAutomation();
    const role = await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'stale-worker', instanceId: 'stale-worker-instance', leaseMs: 60_000 });
    assert.equal(role.acquired, true);
    await store.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'product-first-fenced-health', operationId: 'product-first-fenced-health-op', requestedBy: 'scheduler', priority: 50 });
    assert.equal(await roles.releaseRuntimeRole('WORKER', role.ownership), true);
    await assert.rejects(worker.runContinuousWorkerPool({ workerId: 'stale-worker', ownership: role.ownership, maxConcurrency: 2, maximumClaims: 2 }), /WORKER_FENCING_REJECTED/);
    assert.equal((await store.getAllAutomationJobs()).filter(item => item.status === 'RUNNING').length, 0);
  });

  await test('38. duplicate active Guardian jobs coalesce instead of flooding the queue', async () => {
    await resetAutomation();
    const first = await store.createAutomationJob({ type: 'RUNTIME_GUARDIAN', payload: {}, idempotencyKey: 'guardian-minute-1', operationId: 'guardian-op-1', requestedBy: 'scheduler', priority: 100 });
    const second = await store.createAutomationJob({ type: 'RUNTIME_GUARDIAN', payload: {}, idempotencyKey: 'guardian-minute-2', operationId: 'guardian-op-2', requestedBy: 'scheduler', priority: 100 });
    assert.equal(first.job.id, second.job.id);
    assert.equal(second.code, 'IN_PROGRESS');
    assert.equal((await store.getAllAutomationJobs()).filter(item => item.type === 'RUNTIME_GUARDIAN').length, 1);
  });

  await test('39. active pool remains within the configured four-slot safe ceiling', async () => {
    assert.equal(rollout.isContinuousWorkerPoolEnabled({}), true);
    let active = 0;
    let peak = 0;
    let count = 0;
    const result = await worker.runContinuousWorkerPool({
      workerId: 'bounded-pool', maxConcurrency: 4, maximumClaims: 8, criticalReservedCapacity: 1,
      runBatch: async workerId => {
        count += 1; active += 1; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return batchResult(workerId);
      },
    });
    assert.equal(count, 8);
    assert.equal(result.peakInFlight, 4);
    assert.equal(peak, 4);
    const launcher = fs.readFileSync(path.join(process.cwd(), 'scripts/automation-worker.cjs'), 'utf8');
    assert.match(launcher, /Math\.max\(1, Math\.min\(4, Number\(settings\.maxConcurrency\)/);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\nProduct-first pipeline/worker: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
