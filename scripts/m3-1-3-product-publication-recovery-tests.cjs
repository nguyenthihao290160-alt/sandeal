/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `m3-1-3-product-publication-recovery-${process.pid}-${Date.now()}`);
const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.PUBLICATION_EVIDENCE_V2 = 'SHADOW';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'm3-1-3-readiness';
process.env.BASIC_AUTH_PASSWORD = 'not-a-real-secret';
process.env.SANDEAL_BUILD_COMMIT = 'c'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'c'.repeat(40);
process.env.GIT_COMMIT_SHA = 'c'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'c'.repeat(40);
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
    console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

function readyProduct(id, overrides = {}) {
  const now = new Date().toISOString();
  const base = {
    schemaVersion: 2,
    id,
    title: `Verified recovery fixture Bluetooth headset ${id}`,
    slug: `verified-recovery-fixture-headset-${id}`,
    description: `Source-backed product ${id} with verified price, URLs, image, identity, and editorial evidence.`,
    kind: 'product', recordType: 'PRODUCT', lifecycleState: 'READY_FOR_PUBLISH', platform: 'website', source: 'manual',
    originalUrl: `https://merchant.example/product/${id}`,
    canonicalProductUrl: `https://merchant.example/product/${id}`,
    canonicalUrlStatus: 'verified', canonicalUrlVerifiedAt: now,
    affiliateUrl: `https://merchant.example/product/${id}?affiliate=fixture`,
    affiliateUrlStatus: 'verified', affiliateUrlVerifiedAt: now,
    imageUrl: `https://merchant.example/image/${id}.jpg`, imageUrlHttpStatus: 200, imageContentType: 'image/jpeg',
    price: 1500000, salePrice: 1200000, currency: 'VND', priceObservedAt: now,
    priceVerificationStatus: 'VERIFIED', priceTruthState: 'FRESH',
    category: 'Audio', brand: 'Fixture', sku: `M313-${id}`, specifications: { connection: 'Bluetooth', warranty: '12 months' },
    tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review', publicHidden: true,
    needsVerification: true, autoPublished: false, verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now,
    duplicateStatus: 'CLEAR', claimValidationStatus: 'VERIFIED', evidenceCoverage: 0.95,
    evidenceFactIds: ['title', 'price', 'source', 'links', 'image'], evidenceSnapshotAt: now, evidenceSnapshotHash: `fixture-${id}`,
    confidences: { classification: 0.99, source: 0.98, price: 0.96, image: 0.96, health: 0.98, duplicate: 0.99, contentEvidenceCoverage: 0.95, editorial: 0.94, publish: 0.94, calculatedAt: now, ruleVersion: 'confidence-v1' },
    sourceHash: crypto.createHash('sha256').update(`m3-1-3-source-${id}`).digest('hex'), createdAt: now, updatedAt: now,
    ...overrides,
  };
  const editorial = require('../src/lib/editorialReview.ts');
  return { ...base, reviewContent: editorial.generateEditorialReview(base, [], now) };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const products = require('../src/lib/storage/products.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const evidence = require('../src/lib/autonomous/evidenceGraph.ts');
  const publishPolicy = require('../src/lib/autonomous/publishPolicy.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const canary = require('../src/lib/automation/canaryController.ts');
  const rechecks = require('../src/lib/automation/safeProductRechecks.ts');
  const blockerRules = require('../src/lib/productBlockers.ts');
  const productIntelligenceJobs = require('../src/lib/product-intelligence/jobs.ts');
  const pipeline = require('../src/lib/bots/productPipeline.ts');
  const providers = require('../src/lib/automation/providerRouter.ts');
  const accessTrade = require('../src/lib/integrations/accesstrade.ts');
  const sourcePlatform = require('../src/lib/autonomous/sourceAdapterPlatform.ts');
  const runtimeRoles = require('../src/lib/automation/runtimeRoles.ts');
  const recovery = require('../src/lib/automation/runtimeRecoveryState.ts');
  const recoveryCanary = require('../src/lib/automation/runtimeRecoveryCanary.ts');
  const publicationReadinessRoute = require('../src/app/api/automation/publication-readiness/route.ts');
  const { NextRequest } = require('next/server');

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_M3_1_3_PRODUCT_PUBLICATION_RECOVERY'); };

  async function hydratePersistedEvidence(product) {
    const captured = await evidence.captureProductEvidence(product, new Date().toISOString());
    return {
      ...product,
      evidenceCoverage: captured.coverage,
      evidenceFactIds: captured.snapshot.evidenceIds,
      evidenceSnapshotAt: captured.snapshot.createdAt,
      evidenceSnapshotHash: captured.snapshot.snapshotHash,
    };
  }

  async function reset() {
    delete process.env.RECOVERY_CANARY;
    process.env.PUBLICATION_EVIDENCE_V2 = 'SHADOW';
    process.env.ACCESS_TRADE_API_KEY = '';
    for (const collection of [
      'products', 'evidence-facts', 'product-lifecycle-events', 'automation-jobs', 'automation-control',
      'automation-audit', 'automation-canary', 'operation-journal', 'automation-outbound-events',
      'publication-audit', 'source-quality', 'runtime-role-leases', 'runtime-recovery-state',
      'runtime-recovery-canary-permits', 'runtime-recovery-canary-health-v1',
    ]) await adapter.writeCollection(collection, []);
    await settings.updateAutomationSettings({ launchEnabled: true });
    await store.updateAutomationControl({
      mode: 'AUTONOMOUS', effectiveMode: 'AUTONOMOUS', publishPaused: false, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false, publishBlockedByRuntime: false,
      publishPausedByOperator: false, publishBlockedByPolicy: false,
    }, 'm3-1-3-test');
    const initialCanary = await canary.getCanaryState();
    const now = new Date().toISOString();
    await adapter.writeCollection('automation-canary', [{
      ...initialCanary, controlledLaunch: true, wave: 1, approvedWave: 1,
      successfulShadowCycles: Math.max(1, initialCanary.successfulShadowCycles),
      approvedBy: 'm3-1-3-test', approvedAt: now,
      approvalReason: 'Isolated deterministic M3.1.3 publication recovery fixture.',
      wavePublishedBaseline: initialCanary.publishedEffectKeys.length, paused: false, pauseReasons: [], updatedAt: now,
    }]);
  }

  async function enqueuePublish(product, suffix) {
    return store.createAutomationJob({
      type: 'AUTO_SAFE_PUBLISH',
      payload: { productId: product.id, readinessSnapshotHash: publishPolicy.readinessSnapshotHash(product) },
      idempotencyKey: `m3-1-3-publish:${suffix}`,
      operationId: `m3-1-3-publish-operation:${suffix}`,
      requestedBy: 'scheduler', priority: 95,
    });
  }

  await test('a post-publish expected-product mismatch is retryable evidence, never a healthy monitor outcome', async () => {
    await reset();
    const product = await hydratePersistedEvidence(readyProduct('monitor-mismatch'));
    await adapter.writeCollection('products', [product]);
    const queued = await enqueuePublish(product, 'monitor-mismatch');
    assert.ok(queued.job.id);
    assert.equal((await worker.processAutomationBatch('m3-1-3-monitor-publish-worker', 1)).succeeded, 1);
    const monitor = (await store.getAllAutomationJobs()).find(job => job.type === 'POST_PUBLISH_MONITOR');
    assert.ok(monitor);
    await adapter.runTransaction('automation-jobs', jobs => {
      const current = jobs.find(job => job.id === monitor.id);
      current.scheduledAt = new Date(0).toISOString();
      current.payload.healthOutcome = 'HEALTHY';
      current.payload.publicPageStatus = 200;
      current.payload.publicPageIdentity = 'mismatch';
      return jobs;
    });
    const monitored = await worker.processAutomationBatch('m3-1-3-monitor-worker', 1);
    assert.equal(monitored.succeeded, 1);
    const completed = await store.getAutomationJob(monitor.id);
    assert.equal(completed.result.outcome, 'TEMPORARY_FAILURE');
    assert.equal(completed.result.statuses.publicPageIdentity, 'EXPECTED_PRODUCT_MISMATCH');
    assert.notEqual(completed.result.outcome, 'HEALTHY');
    const current = await products.getProductById(product.id);
    assert.equal(current.publicHidden, false);
    assert.match(current.sourceHealthReason, /EXPECTED_PRODUCT_MISMATCH/);
  });

  await test('publication and product-recheck idempotency suppress duplicate durable work', async () => {
    await reset();
    const product = await hydratePersistedEvidence(readyProduct('idempotency'));
    await adapter.writeCollection('products', [product]);
    const first = await enqueuePublish(product, 'idempotency');
    const duplicate = await enqueuePublish(product, 'idempotency');
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);
    assert.equal((await worker.processAutomationBatch('m3-1-3-idempotency-publish-worker', 1)).succeeded, 1);
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === product.id && item.action === 'published').length, 1);

    const recheckProduct = {
      ...product,
      id: 'm3-1-3-recheck-idempotency', slug: 'm3-1-3-recheck-idempotency', status: 'draft',
      lifecycleState: 'RETRY_SCHEDULED', nextAutomaticAction: 'VERIFY_AFFILIATE_URL',
      publicBlockReason: 'affiliate_url_unverified', publicBlockReasons: ['affiliate_url_unverified'],
      autoPublishEligible: false,
    };
    const firstRecheck = await rechecks.scheduleSafeProductRechecks([recheckProduct], { now: Date.now() });
    const duplicateRecheck = await rechecks.scheduleSafeProductRechecks([recheckProduct], { now: Date.now() });
    assert.equal(firstRecheck.created, 1);
    assert.equal(duplicateRecheck.duplicateSuppressed, 1);
  });

  await test('reprocess preserves MANUAL, UNKNOWN, permanent, policy, and external blockers when evidence is unavailable', async () => {
    await reset();
    const now = new Date().toISOString();
    const protectedBlockers = [
      { code: 'manual_operator_review_required', category: 'POLICY', target: 'product', scope: 'PUBLICATION', severity: 'BLOCKER', source: 'MANUAL_REVIEW', message: 'Operator decision required.', checkedAt: now },
      { code: 'unknown_evidence_pending', category: 'PROVENANCE', target: 'product', scope: 'PRODUCT', severity: 'BLOCKER', source: 'UNKNOWN_EVIDENCE', message: 'Evidence is unknown.', checkedAt: now },
      { code: 'permanent_failure_requires_confirmation', category: 'LINK', target: 'product_url', scope: 'PUBLICATION', severity: 'BLOCKER', source: 'POLICY_GATE', message: 'Permanent failure requires explicit confirmation.', checkedAt: now },
      { code: 'waiting_external_evidence', category: 'PROVENANCE', target: 'product', scope: 'PUBLICATION', severity: 'BLOCKER', source: 'EXTERNAL_EVIDENCE', message: 'Waiting for an external source.', checkedAt: now },
    ];
    const product = await hydratePersistedEvidence(readyProduct('fail-closed-reprocess', {
      status: 'needs_review', publicHidden: true, publicBlocked: true, autoPublishEligible: false,
      currentBlockers: protectedBlockers,
      publicBlockReasons: protectedBlockers.map(item => item.code),
      nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH',
    }));
    await adapter.writeCollection('products', [product]);
    const result = await productIntelligenceJobs.executeProductIntelligenceJob({
      schemaVersion: 2, id: 'm3-1-3-reprocess-job', type: 'RECHECK_PRODUCT_HEALTH', status: 'RUNNING',
      payload: { productIds: [product.id], healthTarget: 'all' }, operationId: 'm3-1-3-reprocess-operation',
       requestedBy: 'operator-reprocess-cli', dryRun: false,
      });
      assert.equal(result.failed, 0);
      assert.equal(result.healthy, 0);
      assert.equal(result.unhealthy, 1);
      const persisted = await products.getProductById(product.id);
    assert.ok(persisted);
    const codes = new Set(persisted.publicBlockReasons || []);
    for (const blocker of protectedBlockers) assert.equal(codes.has(blocker.code), true, blocker.code);
    assert.equal(persisted.publicBlocked, true);
    assert.equal(persisted.publicHidden, true);
    assert.ok((persisted.currentBlockers || []).some(item => item.source === 'MANUAL_REVIEW'));
    assert.ok((persisted.currentBlockers || []).some(item => item.source === 'UNKNOWN_EVIDENCE'));
    assert.equal(blockerRules.isFailClosedProductBlocker((persisted.currentBlockers || []).find(item => item.code === 'manual_operator_review_required')), true);

    const noEvidence = blockerRules.preserveFailClosedProductBlockers(persisted, [], now);
    for (const blocker of protectedBlockers) assert.equal(new Set(noEvidence.map(item => item.code)).has(blocker.code), true, blocker.code);
    const transientOnly = blockerRules.preserveFailClosedProductBlockers({
      currentBlockers: [{ code: 'affiliate_url_unavailable', source: 'PRODUCT_HEALTH_RULES', message: 'Affiliate URL unavailable.' }],
    }, [], now);
    assert.equal(transientOnly.length, 0);
    for (const state of ['stale', 'partial', 'missing', 'unknown', 'contradictory', 'unavailable']) {
      const evidenceBlocker = blockerRules.preserveFailClosedProductBlockers({
        currentBlockers: [{
          code: `${state}_evidence`, source: 'EVIDENCE_RECONCILIATION', message: `${state} evidence requires a new applicable observation.`,
        }],
      }, [], now);
      assert.equal(evidenceBlocker.length, 1, `${state} evidence must remain fail-closed`);
    }
  });

  await test('reprocess does not clear a persisted manual blocker when applicable transport evidence is healthy', async () => {
    await reset();
    const now = new Date().toISOString();
    const product = await hydratePersistedEvidence(readyProduct('fail-closed-reprocess-healthy', {
      status: 'needs_review', publicHidden: true, publicBlocked: true, autoPublishEligible: false,
      currentBlockers: [
        { code: 'manual_operator_review_required', category: 'POLICY', target: 'product', scope: 'PUBLICATION', severity: 'BLOCKER', source: 'MANUAL_REVIEW', message: 'Operator decision required.', checkedAt: now },
      ],
      publicBlockReasons: ['manual_operator_review_required'],
      nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH',
    }));
    await adapter.writeCollection('products', [product]);
    const originalFetch = global.fetch;
    global.fetch = async input => {
      const isImage = String(input).includes('/image/');
      return new Response(isImage ? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) : '<html><title>Verified product</title><body>Verified product evidence.</body></html>', {
        status: 200,
        headers: { 'content-type': isImage ? 'image/jpeg' : 'text/html' },
      });
    };
    try {
      const result = await productIntelligenceJobs.executeProductIntelligenceJob({
        schemaVersion: 2, id: 'm3-1-3-reprocess-healthy-job', type: 'RECHECK_PRODUCT_HEALTH', status: 'RUNNING',
        payload: { productIds: [product.id], healthTarget: 'all' }, operationId: 'm3-1-3-reprocess-healthy-operation',
        requestedBy: 'operator-reprocess-cli', dryRun: false,
      });
      assert.equal(result.failed, 0);
      const persisted = await products.getProductById(product.id);
      assert.ok(persisted);
      assert.ok((persisted.publicBlockReasons || []).includes('manual_operator_review_required'));
      assert.equal(persisted.publicBlocked, true);
      assert.equal(persisted.publicHidden, true);
      assert.equal(persisted.status, 'needs_review');
      assert.equal(persisted.nextAutomaticAction, 'WAITING_MANUAL_REVIEW');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('published-product recheck keeps persisted blockers during unavailable evidence and does not report a cleared state', async () => {
    await reset();
    const now = new Date().toISOString();
    const product = await hydratePersistedEvidence(readyProduct('fail-closed-published-recheck', {
      status: 'published', publicHidden: false, publicBlocked: false, needsVerification: false, autoPublished: true,
      currentBlockers: [
        { code: 'manual_publication_hold', category: 'POLICY', target: 'product', scope: 'PUBLICATION', severity: 'BLOCKER', source: 'OPERATOR', message: 'Operator hold.', checkedAt: now },
        { code: 'unknown_source_evidence', category: 'PROVENANCE', target: 'product', scope: 'PRODUCT', severity: 'BLOCKER', source: 'UNKNOWN', message: 'Source evidence is unknown.', checkedAt: now },
      ],
      publicBlockReasons: ['manual_publication_hold', 'unknown_source_evidence'],
    }));
    await adapter.writeCollection('products', [product]);
    const result = await pipeline.recheckPublishedProducts(1, Date.now() + 10_000);
    assert.equal(result.reviewed, 1);
    const persisted = await products.getProductById(product.id);
    assert.ok(persisted);
    assert.ok((persisted.publicBlockReasons || []).includes('manual_publication_hold'));
    assert.ok((persisted.publicBlockReasons || []).includes('unknown_source_evidence'));
    assert.equal(persisted.publicHidden, true);
    assert.equal(persisted.publicBlocked, true);
    assert.notEqual(persisted.publicBlockReasons?.length, 0);
  });

  await test('post-publish healthy transport cannot report a persisted blocker as healthy', async () => {
    await reset();
    const now = new Date().toISOString();
    const product = await hydratePersistedEvidence(readyProduct('fail-closed-monitor', {
      status: 'published', publicHidden: false, publicBlocked: false, needsVerification: false, autoPublished: true,
      lifecycleState: 'PUBLISHED', currentBlockers: [{
        code: 'manual_publication_hold', category: 'POLICY', target: 'product', scope: 'PUBLICATION',
        severity: 'BLOCKER', source: 'OPERATOR', message: 'Operator hold.', checkedAt: now,
      }], publicBlockReasons: ['manual_publication_hold'],
    }));
    await adapter.writeCollection('products', [product]);
    const monitorJob = await store.createAutomationJob({
      type: 'POST_PUBLISH_MONITOR',
      payload: { productId: product.id, healthOutcome: 'HEALTHY', publicPageStatus: 200, publicPageIdentity: 'expected' },
      idempotencyKey: 'm3-1-3-monitor-fail-closed', operationId: 'm3-1-3-monitor-fail-closed-operation',
      requestedBy: 'm3-1-3-test', priority: 90, scheduledAt: new Date(0).toISOString(),
    });
    assert.ok(monitorJob.job.id);
    assert.equal((await worker.processAutomationBatch('m3-1-3-fail-closed-monitor-worker', 1)).succeeded, 1);
    const completed = await store.getAutomationJob(monitorJob.job.id);
    assert.equal(completed.result.outcome, 'TEMPORARY_FAILURE');
    assert.equal(completed.result.blockedByPersistedBlockers, true);
    const persisted = await products.getProductById(product.id);
    assert.equal(persisted.status, 'needs_review');
    assert.equal(persisted.publicHidden, true);
    assert.equal(persisted.publicBlocked, true);
    assert.equal(persisted.nextAutomaticAction, 'WAITING_MANUAL_REVIEW');
  });

  await test('publication-readiness dry run is read-only and classifies runtime-only and evidence blockers', async () => {
    await reset();
    const ready = await hydratePersistedEvidence(readyProduct('dry-run-ready'));
    const missingAffiliate = {
      ...ready,
      id: 'dry-run-affiliate', slug: 'dry-run-affiliate', affiliateUrlStatus: 'unverified',
      affiliateHealthStatus: 'unverified', publicBlockReason: 'affiliate_url_unverified',
      publicBlockReasons: ['affiliate_url_unverified'], autoPublishEligible: false,
    };
    const before = JSON.stringify([ready, missingAffiliate]);
    const report = rechecks.publicationReadinessDryRun([ready, missingAffiliate], {
      now: Date.now(), runtimePublishingBlocked: true, limit: 10,
    });
    assert.equal(JSON.stringify([ready, missingAffiliate]), before);
    assert.equal(report.runtimeSafetyOnlyCount, 1);
    const runtimeOnly = report.closestToReady.find(item => item.productId === ready.id);
    assert.equal(runtimeOnly.runtimeSafetyOnly, true);
    assert.deepEqual(runtimeOnly.blockers, [{ code: 'RESOLVED', classification: 'RESOLVED' }]);
    const affiliate = report.closestToReady.find(item => item.productId === missingAffiliate.id);
    assert.equal(affiliate.blockers.some(item => item.classification === 'WAITING_EXTERNAL'), true);
  });

  await test('authenticated publication-readiness API is bounded and observational', async () => {
    await reset();
    const ready = await hydratePersistedEvidence(readyProduct('readiness-route'));
    const missingAffiliate = {
      ...ready,
      id: 'readiness-route-affiliate', slug: 'readiness-route-affiliate', affiliateUrlStatus: 'unverified',
      affiliateHealthStatus: 'unverified', publicBlockReason: 'affiliate_url_unverified',
      publicBlockReasons: ['affiliate_url_unverified'], autoPublishEligible: false,
    };
    await adapter.writeCollection('products', [ready, missingAffiliate]);
    await store.updateAutomationControl({ publishBlockedByRuntime: true }, 'm3-1-3-test');
    const productFile = path.join(testRoot, 'products.json');
    const before = fs.readFileSync(productFile, 'utf8');
    const auth = `Basic ${Buffer.from('m3-1-3-readiness:not-a-real-secret').toString('base64')}`;
    const unauthorized = await publicationReadinessRoute.GET(new NextRequest('http://localhost/api/automation/publication-readiness?limit=1'));
    assert.equal(unauthorized.status, 401);
    const invalid = await publicationReadinessRoute.GET(new NextRequest('http://localhost/api/automation/publication-readiness?limit=51', { headers: { authorization: auth } }));
    assert.equal(invalid.status, 400);
    const response = await publicationReadinessRoute.GET(new NextRequest('http://localhost/api/automation/publication-readiness?limit=1', { headers: { authorization: auth } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.readOnly, true);
    assert.equal(body.data.readOnly, true);
    assert.equal(body.data.closestToReady.length, 1);
    assert.equal(body.data.runtime.publishBlockedByRuntime, true);
    assert.equal(body.data.source.maximumItems, 5000);
    assert.equal(body.data.source.queryCount, 1);
    assert.equal(fs.readFileSync(productFile, 'utf8'), before);
  });

  await test('AccessTrade readiness records local credential state and mocked timeout/rate limit without a real probe', async () => {
    await reset();
    process.env.ACCESS_TRADE_API_KEY = 'short';
    const invalid = await accessTrade.getAccessTradeCredentialReadiness();
    assert.deepEqual(invalid, {
      configured: false, credentialsPresent: true, credentialFormatValid: false,
      source: 'ENVIRONMENT', reason: 'CREDENTIAL_FORMAT_INVALID',
    });
    process.env.ACCESS_TRADE_API_KEY = 'test-access-key-123';
    const configured = await accessTrade.getAccessTradeCredentialReadiness();
    assert.equal(configured.configured, true);
    assert.equal(configured.credentialFormatValid, true);
    const adapter = sourcePlatform.createAccessTradeSourceAdapter({
      configured: async () => true,
      credentialReadiness: async () => configured,
      healthProbe: async () => { throw new accessTrade.AccessTradeRequestError('timeout', [], 'fixture timeout'); },
    });
    const timeout = await adapter.healthCheck({ probe: true });
    assert.equal(timeout.configured, true);
    assert.equal(timeout.ready, false);
    assert.equal(timeout.readinessProbeStatus, 'FAILED');
    assert.equal(timeout.status, 'degraded');
    const rateLimitedAdapter = sourcePlatform.createAccessTradeSourceAdapter({
      configured: async () => true,
      credentialReadiness: async () => configured,
      healthProbe: async () => {
        throw new accessTrade.AccessTradeRequestError('rate_limited', [
          { endpoint: 'datafeed', durationMs: 1, statusCode: 429, resultType: 'rate_limited', itemCount: 0 },
        ], 'fixture rate limit');
      },
    });
    const rateLimited = await rateLimitedAdapter.healthCheck({ probe: true });
    assert.equal(rateLimited.status, 'rate_limited');
    assert.equal(rateLimited.readinessProbeStatus, 'RATE_LIMITED');
  });

  await test('Free-only Gemini policy does not block local product recovery work', async () => {
    await reset();
    const route = await providers.routeProviderExecution({
      capability: 'candidate-review', requestedMode: 'AUTO', provider: 'gemini', providerAdapterAvailable: true,
      localMode: 'LOCAL_RULES', allowLocalFallback: true, allowPaidFallback: true,
    });
    assert.equal(route.executionMode, 'LOCAL_RULES');
    assert.equal(route.provider, 'local');
    assert.equal(route.aiRequests, 0);
    assert.equal(route.fallbackReason, 'SAFETY_POLICY_BLOCKED');

    const localRecovery = {
      ...readyProduct('local-recovery'), status: 'draft', lifecycleState: 'RETRY_SCHEDULED',
      nextAutomaticAction: 'VERIFY_PRODUCT_URL', publicBlockReason: 'canonical_url_unverified',
      publicBlockReasons: ['canonical_url_unverified'], autoPublishEligible: false,
    };
    const scheduled = await rechecks.scheduleSafeProductRechecks([localRecovery], { now: Date.now() });
    assert.equal(scheduled.created, 1);
    const recheck = (await store.getAllAutomationJobs()).find(job => job.id === scheduled.createdJobIds[0]);
    assert.equal(recheck.type, 'RECHECK_PRODUCT_HEALTH');
    assert.equal(recheck.payload.healthTarget, 'link');
  });

  await test('recovery canary has a viable fenced permit path; its block-cleared guard boundary is not a deadlock proof', async () => {
    await reset();
    const nowMs = Date.now();
    process.env.RECOVERY_CANARY = 'ACTIVE';
    const workerRole = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'm3-1-3-recovery-worker', instanceId: 'm3-1-3-recovery-worker-instance', now: nowMs, leaseMs: 60_000,
    });
    const schedulerRole = await runtimeRoles.acquireRuntimeRole({
      role: 'SCHEDULER', ownerId: 'm3-1-3-recovery-scheduler', instanceId: 'm3-1-3-recovery-scheduler-instance', now: nowMs, leaseMs: 60_000,
    });
    assert.equal(workerRole.acquired, true);
    assert.equal(schedulerRole.acquired, true);
    const applied = await store.applyRuntimePublishBlock({
      reasonCodes: ['M3_1_3_FIXTURE_RUNTIME_BLOCK'], evaluationId: 'm3-1-3-recovery-apply',
      evaluatedAt: new Date(nowMs).toISOString(), degradeMode: false,
    }, 'm3-1-3-test');
    const initial = await recovery.ensureRuntimeRecoveryState({
      publishBlockedByRuntime: true, reasons: ['M3_1_3_FIXTURE_RUNTIME_BLOCK'], nowMs,
    });
    await recovery.updateRuntimeRecoveryState({
      expectedStateVersion: initial.stateVersion, nowMs,
      mutate: current => ({
        ...current, state: 'RECOVERY_OBSERVING', currentApplicableReasons: [], consecutiveHealthyCount: 1,
        lastHealthyEvaluation: new Date(nowMs).toISOString(), lastHealthyEvaluationId: 'm3-1-3-recovery-evidence',
        evidenceSummary: {
          measurementState: 'RECOVERY', evaluationStatus: 'PASS', evaluatedAt: new Date(nowMs).toISOString(),
          maximumEvidenceAgeMs: 120_000, reasonCodes: [], terminalJobSamples: 20, pickupLatencyP95Ms: 5_000,
          pendingQueueAgeMs: 0, publicationAttempts: 0, monitorOutcomes: 0, publicProducts: 0,
        },
      }),
    });
    const input = {
      operationId: 'm3-1-3-recovery-operation', productId: 'm3-1-3-recovery-product', jobId: 'm3-1-3-recovery-job',
      claimToken: 'm3-1-3-test-recovery-claim', ownership: workerRole.ownership,
      readinessSnapshotHash: 'e'.repeat(64), productEligibleExceptRuntime: true, nowMs,
    };
    const issued = await recoveryCanary.issueRuntimeRecoveryCanaryPermit(input);
    assert.equal(issued.allowed, true);
    assert.equal((await recovery.getRuntimeRecoveryState()).state, 'HALF_OPEN');
    const cleared = await store.clearRuntimePublishReasons({
      reasonCodes: ['M3_1_3_FIXTURE_RUNTIME_BLOCK'], expectedChangedAt: applied.control.changedAt,
      expectedRuntimeReasons: applied.control.publishRuntimeReasons, reason: 'M3_1_3_FIXTURE_CLEAR', evaluationId: 'm3-1-3-recovery-clear',
    }, 'm3-1-3-test');
    assert.equal(cleared.status, 'CLEARED');
    const denied = await recoveryCanary.issueRuntimeRecoveryCanaryPermit({
      ...input, operationId: 'm3-1-3-recovery-after-clear', productId: 'm3-1-3-recovery-after-clear-product', jobId: 'm3-1-3-recovery-after-clear-job',
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reasonCode, 'RECOVERY_CANARY_RUNTIME_BLOCK_REQUIRED');
  });

  console.log(`M3.1.3 product/publication recovery tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
