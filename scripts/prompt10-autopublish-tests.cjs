/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-autopublish-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');
let passed = 0; let failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); } }

function readyProduct(id, overrides = {}) {
  const now = new Date().toISOString();
  const base = {
    schemaVersion: 2, id, title: `Verified autonomous Bluetooth headset ${id}`, slug: `verified-autonomous-headset-${id}`,
    description: `Source-backed product ${id} with verified price, URLs, image, identity, and editorial evidence.`,
    kind: 'product', recordType: 'PRODUCT', lifecycleState: 'READY_FOR_PUBLISH', platform: 'website', source: 'manual',
    originalUrl: `https://merchant.example/product/${id}`, affiliateUrl: `https://merchant.example/product/${id}?affiliate=fixture`, imageUrl: `https://merchant.example/image/${id}.jpg`,
    price: 1500000, salePrice: 1200000, currency: 'VND', category: 'Audio', brand: 'Fixture', sku: `AUTO-${id}`, specifications: { connection: 'Bluetooth', warranty: '12 months' },
    tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review', publicHidden: true, needsVerification: true, autoPublished: false,
    verifiedSource: true, sourceVerified: true, autoPublishEligible: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok', linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now,
    duplicateStatus: 'CLEAR', claimValidationStatus: 'VERIFIED', evidenceCoverage: .95, evidenceFactIds: ['title', 'price', 'source', 'links', 'image'], evidenceSnapshotAt: now, evidenceSnapshotHash: `evidence-${id}`,
    confidences: { classification: .99, source: .98, price: .96, image: .96, health: .98, duplicate: .99, contentEvidenceCoverage: .95, editorial: .94, publish: .94, calculatedAt: now, ruleVersion: 'confidence-v1' },
    sourceHash: crypto.createHash('sha256').update(`source-${id}`).digest('hex'), createdAt: now, updatedAt: now,
    ...overrides,
  };
  const editorial = require('../src/lib/editorialReview.ts');
  return { ...base, reviewContent: editorial.generateEditorialReview(base, [], now) };
}

async function publishJob(store, product, suffix, payload = {}, requestedBy = 'scheduler', riskLevel) {
  const policy = require('../src/lib/autonomous/publishPolicy.ts');
  return store.createAutomationJob({
    type: 'AUTO_SAFE_PUBLISH', payload: { productId: product.id, readinessSnapshotHash: policy.readinessSnapshotHash(product), ...payload },
    idempotencyKey: `auto-publish-test-${suffix}`, operationId: `auto-publish-operation-${suffix}`, requestedBy, riskLevel, priority: 95,
  });
}

async function hydratePersistedEvidence(product, now = new Date().toISOString()) {
  const evidence = require('../src/lib/autonomous/evidenceGraph.ts');
  const captured = await evidence.captureProductEvidence(product, now);
  return {
    ...product,
    evidenceCoverage: captured.coverage,
    evidenceFactIds: captured.snapshot.evidenceIds,
    evidenceSnapshotAt: captured.snapshot.createdAt,
    evidenceSnapshotHash: captured.snapshot.snapshotHash,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const products = require('../src/lib/storage/products.ts');
  const store = require('../src/lib/automation/store.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const canary = require('../src/lib/automation/canaryController.ts');
  const journal = require('../src/lib/automation/operationJournal.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const sourceQuality = require('../src/lib/autonomous/sourceQuality.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_AUTOPUBLISH'); };
  async function reset(mode = 'AUTONOMOUS') {
    for (const collection of ['products', 'evidence-facts', 'product-lifecycle-events', 'automation-jobs', 'automation-control', 'automation-audit', 'automation-canary', 'operation-journal', 'automation-outbound-events', 'publication-audit', 'source-quality']) await adapter.writeCollection(collection, []);
    await settings.updateAutomationSettings({ launchEnabled: true });
    await store.updateAutomationControl({ mode, effectiveMode: mode, publishPaused: false, ingestionPaused: false, workerPaused: false, schedulerPaused: false, killSwitch: false }, 'autopublish-test');
  }

  await test('eligible product auto-publishes without approval or user action', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('happy')); await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'happy');
    assert.equal(queued.job.status, 'PENDING'); assert.equal(queued.job.approvalStatus, 'NOT_REQUIRED');
    const run = await worker.processAutomationBatch('auto-publish-worker-1', 1);
    assert.equal(run.succeeded, 1);
    const published = await products.getProductById(product.id);
    assert.equal(published.status, 'published'); assert.equal(published.publicHidden, false); assert.equal(published.lifecycleState, 'PUBLISHED');
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 1);
    assert.equal((await sourceQuality.getSourceQualitySnapshot(product.source)).counters.publishedProducts, 1);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 1);
    const lifecycleEvents = (await adapter.readCollection('product-lifecycle-events')).filter(event => event.productId === product.id);
    assert.deepEqual(lifecycleEvents.map(event => `${event.previousState}->${event.nextState}:${event.status}`), [
      'READY_FOR_PUBLISH->PUBLISHING:APPLIED',
      'PUBLISHING->PUBLISHED:APPLIED',
    ]);
    assert.ok(lifecycleEvents.every(event => event.actor.jobId === queued.job.id && event.actor.jobType === 'AUTO_SAFE_PUBLISH'));
  });

  await test('restricted high-risk product quarantines and never becomes public', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('high-risk', { riskLevel: 'high' })); await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'high-risk');
    const blockedRun = await worker.processAutomationBatch('auto-publish-worker-2', 1);
    assert.equal(blockedRun.succeeded, 1, JSON.stringify({ blockedRun, job: await store.getAutomationJob(queued.job.id) }));
    const blocked = await products.getProductById(product.id);
    assert.equal(blocked.status, 'needs_review'); assert.equal(blocked.publicHidden, true); assert.equal(blocked.lifecycleState, 'QUARANTINED');
    assert.ok(blocked.quarantineReasons.includes('risk_not_low'));
    const lifecycleEvents = (await adapter.readCollection('product-lifecycle-events')).filter(event => event.productId === product.id);
    assert.deepEqual(lifecycleEvents.map(event => `${event.previousState}->${event.nextState}`), ['READY_FOR_PUBLISH->QUARANTINED']);
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
  });

  await test('client-created AUTO_SAFE_PUBLISH cannot forge an autonomous actor', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('forged')); await adapter.writeCollection('products', [product]);
    await publishJob(store, product, 'forged', {}, 'dashboard-admin');
    assert.equal((await worker.processAutomationBatch('auto-publish-worker-3', 1)).failed, 1);
    const current = await products.getProductById(product.id);
    assert.notEqual(current.status, 'published'); assert.equal(current.publicHidden, true);
  });

  await test('crash after READY to PUBLISHING reuses the original readiness snapshot and publishes once', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('transition-crash')); await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'transition-crash', { simulateCrashAfterPublishingTransition: true });
    assert.equal((await worker.processAutomationBatch('auto-publish-worker-transition-crash-1', 1)).failed, 1);
    const afterCrash = await products.getProductById(product.id);
    assert.equal(afterCrash.lifecycleState, 'PUBLISHING'); assert.notEqual(afterCrash.status, 'published'); assert.equal(afterCrash.publicHidden, true);
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
    await adapter.runTransaction('automation-jobs', jobs => { const job = jobs.find(item => item.id === queued.job.id); job.nextRetryAt = new Date(0).toISOString(); return jobs; });
    const recovery = await worker.processAutomationBatch('auto-publish-worker-transition-crash-2', 1);
    assert.equal(recovery.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const published = await products.getProductById(product.id);
    assert.equal(published.lifecycleState, 'PUBLISHED'); assert.equal(published.status, 'published');
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === product.id && item.action === 'published').length, 1);
    assert.equal((await adapter.readCollection('product-lifecycle-events')).filter(event => event.productId === product.id).length, 2);
  });

  await test('retry reconciles a pending READY to PUBLISHING event after event-first product-write crash', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('pending-transition')); await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'pending-transition');
    const claimed = (await store.claimAutomationJobs('auto-publish-worker-pending-1', 1))[0];
    assert.equal(claimed.id, queued.job.id);
    const lifecycle = require('../src/lib/autonomous/lifecycleStore.ts');
    await assert.rejects(() => lifecycle.persistLifecycleTransition({
      productId: product.id,
      to: 'PUBLISHING',
      actor: { type: 'worker', id: 'auto-publish-worker-pending-1', jobId: claimed.id, jobType: claimed.type },
      transitionKey: `auto-safe-publish:${claimed.id}:publishing`,
      operationId: claimed.operationId,
      reasonCodes: ['persisted_evidence_verified'],
      testFailurePoint: 'AFTER_PRODUCT_WRITE',
    }), /SIMULATED_LIFECYCLE_CRASH_AFTER_PRODUCT_WRITE/);
    assert.equal((await products.getProductById(product.id)).lifecycleState, 'PUBLISHING');
    assert.equal((await adapter.readCollection('product-lifecycle-events')).find(event => event.productId === product.id).status, 'PENDING');
    await store.failAutomationJob(claimed.id, 'auto-publish-worker-pending-1', 'TEMPORARY_ERROR', new Error('simulated worker crash'), { nextRetryAt: new Date(0).toISOString() });
    await adapter.runTransaction('automation-jobs', jobs => { const job = jobs.find(item => item.id === claimed.id); job.nextRetryAt = new Date(0).toISOString(); return jobs; });
    const recovery = await worker.processAutomationBatch('auto-publish-worker-pending-2', 1);
    assert.equal(recovery.succeeded, 1, JSON.stringify(await store.getAutomationJob(claimed.id)));
    const published = await products.getProductById(product.id);
    assert.equal(published.lifecycleState, 'PUBLISHED'); assert.equal(published.status, 'published');
    const events = (await adapter.readCollection('product-lifecycle-events')).filter(event => event.productId === product.id);
    assert.deepEqual(events.map(event => `${event.previousState}->${event.nextState}:${event.status}`), [
      'READY_FOR_PUBLISH->PUBLISHING:APPLIED',
      'PUBLISHING->PUBLISHED:APPLIED',
    ]);
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === product.id && item.action === 'published').length, 1);
  });

  await test('crash after product write resumes with one event, monitor, audit, and stable publishedAt', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('crash')); await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'crash', { simulateCrashAfterProductWrite: true });
    assert.equal((await worker.processAutomationBatch('auto-publish-worker-crash-1', 1)).failed, 1);
    const afterCrash = await products.getProductById(product.id);
    assert.equal(afterCrash.status, 'published'); assert.equal(afterCrash.lifecycleState, 'PUBLISHING'); const publishedAt = afterCrash.publishedAt;
    assert.equal((await products.getPublicProducts()).some(item => item.id === product.id), false);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);
    await adapter.runTransaction('automation-jobs', jobs => { const job = jobs.find(item => item.id === queued.job.id); job.nextRetryAt = new Date(0).toISOString(); return jobs; });
    const recoveryRun = await worker.processAutomationBatch('auto-publish-worker-crash-2', 1);
    assert.equal(recoveryRun.succeeded, 1, JSON.stringify({ recoveryRun, job: await store.getAutomationJob(queued.job.id) }));
    const recovered = await products.getProductById(product.id);
    assert.equal(recovered.publishedAt, publishedAt); assert.equal(recovered.lifecycleState, 'PUBLISHED');
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 1);
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === product.id && item.action === 'published').length, 1);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 1);
    assert.equal((await adapter.readCollection('product-lifecycle-events')).filter(event => event.productId === product.id).length, 2);
  });

  await test('an effect owned by another execution blocks success until explicit release, then replays exactly once', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('owned-event')); await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'owned-event');
    const publishPolicy = require('../src/lib/autonomous/publishPolicy.ts');
    const snapshotHash = publishPolicy.readinessSnapshotHash(product);
    const effectKey = `publish-effect:${product.id}:${snapshotHash}`;
    await journal.ensureOperationJournal({
      operationId: queued.job.operationId,
      jobId: queued.job.id,
      operationType: 'AUTO_SAFE_PUBLISH',
      effects: [
        { id: 'publish-product', description: 'Publish canonical product exactly once.', idempotencyKey: effectKey, intendedValue: { productId: product.id, snapshotHash } },
        { id: 'outbound-event', description: 'Emit one publication event.', idempotencyKey: `${effectKey}:event` },
        { id: 'monitor-job', description: 'Create one post-publish monitoring chain.', idempotencyKey: `${effectKey}:monitor` },
      ],
    });
    assert.equal((await journal.claimJournalEffect(queued.job.operationId, 'outbound-event', 'competing-owner')).status, 'CLAIMED');
    const blockedRun = await worker.processAutomationBatch('auto-publish-worker-owned-event-1', 1);
    assert.equal(blockedRun.failed, 1);
    assert.equal((await store.getAutomationJob(queued.job.id)).status, 'RETRY_SCHEDULED');
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);
    const blockedJournal = await journal.getOperationJournal(queued.job.operationId);
    const eventEffect = blockedJournal.intendedEffects.find(effect => effect.id === 'outbound-event');
    assert.equal(eventEffect.status, 'IN_PROGRESS');
    assert.equal(eventEffect.ownerId, 'competing-owner');

    await journal.failJournalEffect(queued.job.operationId, 'outbound-event', new Error('simulated owner crash'), { ownerId: 'competing-owner' });
    await adapter.runTransaction('automation-jobs', jobs => { const job = jobs.find(item => item.id === queued.job.id); job.nextRetryAt = new Date(0).toISOString(); return jobs; });
    const replay = await worker.processAutomationBatch('auto-publish-worker-owned-event-2', 1);
    assert.equal(replay.succeeded, 1);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 1);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 1);
    assert.equal((await journal.getOperationJournal(queued.job.operationId)).reconciliationStatus, 'CONSISTENT');
  });

  await test('forged evidence summary is quarantined from persisted facts without publication side effects', async () => {
    await reset();
    const valid = await hydratePersistedEvidence(readyProduct('forged-evidence'));
    const product = { ...valid, evidenceCoverage: 1, evidenceFactIds: ['forged-fact-id'], evidenceSnapshotHash: 'f'.repeat(64), evidenceSnapshotAt: new Date().toISOString() };
    await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'forged-evidence');
    const run = await worker.processAutomationBatch('auto-publish-worker-forged-evidence', 1);
    assert.equal(run.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const blocked = await products.getProductById(product.id);
    assert.equal(blocked.lifecycleState, 'QUARANTINED'); assert.equal(blocked.publicHidden, true);
    assert.ok(blocked.quarantineReasons.includes('persisted_evidence_unverified'));
    assert.ok(blocked.quarantineReasons.includes('evidence_snapshot_active_set_mismatch'));
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
  });

  await test('expired persisted evidence is quarantined even when product coverage summary says complete', async () => {
    await reset(); const product = await hydratePersistedEvidence(readyProduct('expired-evidence')); await adapter.writeCollection('products', [product]);
    await adapter.runTransaction('evidence-facts', facts => { for (const fact of facts.filter(item => item.productId === product.id)) fact.status = 'EXPIRED'; return facts; });
    const queued = await publishJob(store, product, 'expired-evidence');
    const run = await worker.processAutomationBatch('auto-publish-worker-expired-evidence', 1);
    assert.equal(run.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const blocked = await products.getProductById(product.id);
    assert.equal(blocked.lifecycleState, 'QUARANTINED');
    assert.ok(blocked.quarantineReasons.includes('snapshot_evidence_inactive_or_expired'));
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
  });

  await test('foreign product evidence fact cannot be attached to a publish snapshot', async () => {
    await reset();
    const product = await hydratePersistedEvidence(readyProduct('foreign-owner'));
    const foreign = await hydratePersistedEvidence(readyProduct('foreign-source'));
    const foreignFactId = foreign.evidenceFactIds[0];
    const forged = { ...product, evidenceFactIds: [...product.evidenceFactIds, foreignFactId] };
    await adapter.writeCollection('products', [forged, foreign]);
    const queued = await publishJob(store, forged, 'foreign-owner');
    const run = await worker.processAutomationBatch('auto-publish-worker-foreign-evidence', 1);
    assert.equal(run.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const blocked = await products.getProductById(product.id);
    assert.equal(blocked.lifecycleState, 'QUARANTINED');
    assert.ok(blocked.quarantineReasons.includes('snapshot_evidence_owner_mismatch'), JSON.stringify(blocked.quarantineReasons));
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
  });

  await test('conflicting active canonical facts invalidate an otherwise fresh persisted snapshot', async () => {
    await reset(); let product = await hydratePersistedEvidence(readyProduct('conflicting-facts'));
    const evidence = require('../src/lib/autonomous/evidenceGraph.ts');
    const now = new Date().toISOString();
    await evidence.captureEvidenceFact({
      productId: product.id, field: 'title', value: 'Conflicting title from another observation', sourceType: 'SOURCE_API', sourceId: product.sourceId || product.id,
      sourceUrl: product.originalUrl, observedAt: now, verificationMethod: 'source_payload', confidence: .98, status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), ruleVersion: evidence.EVIDENCE_RULE_VERSION,
    }, { capturedAt: now });
    const facts = await evidence.listProductEvidence(product.id);
    const snapshot = evidence.buildEvidenceSnapshot(product.id, facts);
    product = { ...product, evidenceFactIds: snapshot.evidenceIds, evidenceSnapshotHash: snapshot.snapshotHash, evidenceSnapshotAt: snapshot.createdAt };
    await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'conflicting-facts');
    const run = await worker.processAutomationBatch('auto-publish-worker-conflicting-facts', 1);
    assert.equal(run.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const blocked = await products.getProductById(product.id);
    assert.equal(blocked.lifecycleState, 'QUARANTINED');
    assert.ok(blocked.quarantineReasons.includes('canonical_fact_conflict:title'), JSON.stringify(blocked.quarantineReasons));
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
  });

  await test('canonical product mutation after evidence capture is detected server-side', async () => {
    await reset(); const valid = await hydratePersistedEvidence(readyProduct('canonical-mismatch'));
    const product = { ...valid, title: 'Mutated canonical title after snapshot capture' };
    await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'canonical-mismatch');
    const run = await worker.processAutomationBatch('auto-publish-worker-canonical-mismatch', 1);
    assert.equal(run.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const blocked = await products.getProductById(product.id);
    assert.equal(blocked.lifecycleState, 'QUARANTINED');
    assert.ok(blocked.quarantineReasons.includes('canonical_fact_mismatch:title'), JSON.stringify(blocked.quarantineReasons));
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
  });

  await test('CANARY wave 1 publishes at most three products and pauses the fourth', async () => {
    await reset('CANARY'); await canary.recordSuccessfulShadowCycle();
    const fixtures = [];
    for (const id of ['c1', 'c2', 'c3', 'c4']) fixtures.push(await hydratePersistedEvidence(readyProduct(id)));
    await adapter.writeCollection('products', fixtures);
    for (const item of fixtures) await publishJob(store, item, `canary-${item.id}`);
    const run = await worker.processAutomationBatch('auto-publish-worker-canary', 10);
    assert.equal(run.succeeded, 4);
    const saved = await products.getAllProducts();
    assert.equal(saved.filter(item => item.status === 'published').length, 3);
    assert.equal(saved.find(item => item.id === 'c4').lifecycleState, 'READY_FOR_PUBLISH');
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 3);
  });

  await test('CANARY preserves a completed-write recovery slot until the same effect finishes', async () => {
    await reset('CANARY'); await canary.recordSuccessfulShadowCycle();
    const recoveryProduct = await hydratePersistedEvidence(readyProduct('canary-recovery'));
    await adapter.writeCollection('products', [recoveryProduct]);
    const recoveryJob = await publishJob(store, recoveryProduct, 'canary-recovery', { simulateCrashAfterProductWrite: true });
    assert.equal((await worker.processAutomationBatch('auto-publish-worker-canary-crash', 1)).failed, 1);
    assert.equal((await products.getProductById(recoveryProduct.id)).lifecycleState, 'PUBLISHING');
    const canaryAfterCrash = await canary.getCanaryState();
    assert.equal(canaryAfterCrash.reservedEffectKeys.length, 1);

    const fillers = [];
    for (const id of ['canary-fill-1', 'canary-fill-2', 'canary-fill-3']) fillers.push(await hydratePersistedEvidence(readyProduct(id)));
    await adapter.writeCollection('products', [await products.getProductById(recoveryProduct.id), ...fillers]);
    for (const product of fillers) await publishJob(store, product, product.id);
    const fillerRun = await worker.processAutomationBatch('auto-publish-worker-canary-fill', 3);
    assert.equal(fillerRun.succeeded, 3);
    assert.equal((await products.getAllProducts()).filter(product => product.status === 'published' && product.lifecycleState === 'PUBLISHED').length, 2);

    await adapter.runTransaction('automation-jobs', jobs => { const job = jobs.find(item => item.id === recoveryJob.job.id); job.nextRetryAt = new Date(0).toISOString(); return jobs; });
    const recovered = await worker.processAutomationBatch('auto-publish-worker-canary-recover', 1);
    assert.equal(recovered.succeeded, 1, JSON.stringify(await store.getAutomationJob(recoveryJob.job.id)));
    assert.equal((await products.getProductById(recoveryProduct.id)).lifecycleState, 'PUBLISHED');
    assert.equal((await products.getAllProducts()).filter(product => product.status === 'published' && product.lifecycleState === 'PUBLISHED').length, 3);
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === recoveryProduct.id && item.action === 'published').length, 1);
  });

  console.log(`\nPROMPT10 Gate 5 auto publish: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
