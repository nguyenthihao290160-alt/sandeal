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
    originalUrl: `https://merchant.example/product/${id}`, canonicalProductUrl: `https://merchant.example/product/${id}`,
    canonicalUrlStatus: 'verified', canonicalUrlVerifiedAt: now,
    affiliateUrl: `https://merchant.example/product/${id}?affiliate=fixture`, affiliateUrlStatus: 'verified', affiliateUrlVerifiedAt: now,
    imageUrl: `https://merchant.example/image/${id}.jpg`, imageUrlHttpStatus: 200, imageContentType: 'image/jpeg',
    price: 1500000, salePrice: 1200000, currency: 'VND', priceObservedAt: now, priceVerificationStatus: 'VERIFIED', priceTruthState: 'FRESH',
    category: 'Audio', brand: 'Fixture', sku: `AUTO-${id}`, specifications: { connection: 'Bluetooth', warranty: '12 months' },
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
  const runtimeRoles = require('../src/lib/automation/runtimeRoles.ts');
  const runtimeRecovery = require('../src/lib/automation/runtimeRecoveryState.ts');
  const recoveryCanary = require('../src/lib/automation/runtimeRecoveryCanary.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_AUTOPUBLISH'); };
  async function reset(mode = 'AUTONOMOUS') {
    delete process.env.RECOVERY_CANARY;
    for (const collection of ['products', 'evidence-facts', 'product-lifecycle-events', 'automation-jobs', 'automation-control', 'automation-audit', 'automation-canary', 'operation-journal', 'automation-outbound-events', 'publication-audit', 'source-quality', 'runtime-role-leases', 'runtime-recovery-state', 'runtime-recovery-canary-permits']) await adapter.writeCollection(collection, []);
    await settings.updateAutomationSettings({ launchEnabled: true });
    await store.updateAutomationControl({ mode, effectiveMode: mode, publishPaused: false, ingestionPaused: false, workerPaused: false, schedulerPaused: false, killSwitch: false }, 'autopublish-test');
    const initial = await canary.getCanaryState();
    const now = new Date().toISOString();
    await adapter.writeCollection('automation-canary', [{
      ...initial, controlledLaunch: true, wave: 1, approvedWave: 1, successfulShadowCycles: Math.max(1, initial.successfulShadowCycles),
      approvedBy: 'autopublish-test', approvedAt: now, approvalReason: 'Isolated controlled launch fixture for durable publication tests.',
      wavePublishedBaseline: initial.publishedEffectKeys.length, paused: false, pauseReasons: [], updatedAt: now,
    }]);
  }

  async function prepareRuntimeRecoveryCanary(suffix, publishPayload = {}) {
    await reset();
    process.env.RECOVERY_CANARY = 'ACTIVE';
    const nowMs = Date.now();
    const workerId = `recovery-canary-worker-${suffix}`;
    const role = await runtimeRoles.acquireRuntimeRole({
      role: 'WORKER',
      ownerId: workerId,
      instanceId: `recovery-canary-instance-${suffix}`,
      leaseMs: 60_000,
      now: nowMs,
    });
    assert.equal(role.acquired, true);
    const schedulerRole = await runtimeRoles.acquireRuntimeRole({
      role: 'SCHEDULER',
      ownerId: `recovery-canary-scheduler-${suffix}`,
      instanceId: `recovery-canary-scheduler-instance-${suffix}`,
      leaseMs: 60_000,
      now: nowMs,
    });
    assert.equal(schedulerRole.acquired, true);
    await store.updateAutomationControl({
      mode: 'AUTONOMOUS',
      effectiveMode: 'AUTONOMOUS',
      publishPausedByOperator: false,
      publishBlockedByRuntime: true,
      publishBlockedByPolicy: false,
      killSwitch: false,
    }, 'runtime-guardian');
    const initialRecovery = await runtimeRecovery.ensureRuntimeRecoveryState({
      publishBlockedByRuntime: true,
      reasons: ['HISTORICAL_RUNTIME_BREACH'],
      nowMs,
    });
    await runtimeRecovery.updateRuntimeRecoveryState({
      expectedStateVersion: initialRecovery.stateVersion,
      nowMs,
      mutate: current => ({
        ...current,
        state: 'RECOVERY_OBSERVING',
        currentApplicableReasons: [],
        consecutiveHealthyCount: 1,
        lastHealthyEvaluation: new Date(nowMs).toISOString(),
        lastHealthyEvaluationId: `recovery-canary-evaluation-${suffix}`,
        evidenceSummary: {
          measurementState: 'RECOVERY',
          evaluationStatus: 'PASS',
          evaluatedAt: new Date(nowMs).toISOString(),
          maximumEvidenceAgeMs: 120_000,
          reasonCodes: [],
          terminalJobSamples: 20,
          pickupLatencyP95Ms: 5_000,
          pendingQueueAgeMs: 0,
          publicationAttempts: 0,
          monitorOutcomes: 0,
          publicProducts: 0,
        },
      }),
    });
    const product = await hydratePersistedEvidence(readyProduct(`recovery-canary-${suffix}`));
    await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, `recovery-canary-${suffix}`, publishPayload);
    return { workerId, ownership: role.ownership, product, queued };
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
    const audits = await adapter.readCollection('publication-audit');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'publish_blocked');
    assert.equal(audits[0].operationId, queued.job.operationId);
    assert.ok(audits[0].productReasonCodes.includes('risk_not_low'));
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);
  });

  await test('blocked publication state resumes after a crash and writes exactly one audit', async () => {
    await reset();
    const product = await hydratePersistedEvidence(readyProduct('blocked-state-crash', { riskLevel: 'high' }));
    await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'blocked-state-crash', { simulateCrashAfterBlockedState: true });
    const firstRun = await worker.processAutomationBatch('auto-publish-worker-blocked-state-crash-1', 1);
    assert.equal(firstRun.failed, 1);
    const afterCrash = await products.getProductById(product.id);
    assert.equal(afterCrash.lifecycleState, 'QUARANTINED');
    assert.equal(afterCrash.publicHidden, true);
    assert.equal(afterCrash.lastBlockedPublicationDecision.operationId, queued.job.operationId);
    assert.equal((await adapter.readCollection('publication-audit')).length, 0);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);

    await adapter.runTransaction('automation-jobs', jobs => {
      const retry = jobs.find(item => item.id === queued.job.id);
      retry.nextRetryAt = new Date(0).toISOString();
      return jobs;
    });
    const replay = await worker.processAutomationBatch('auto-publish-worker-blocked-state-crash-2', 1);
    assert.equal(replay.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const audits = (await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].effectKey, afterCrash.lastBlockedPublicationDecision.effectKey);
    assert.equal((await journal.getOperationJournal(queued.job.operationId)).reconciliationStatus, 'CONSISTENT');
  });

  await test('blocked publication audit replay suppresses a duplicate after an interrupted journal completion', async () => {
    await reset();
    const product = await hydratePersistedEvidence(readyProduct('blocked-audit-crash', { riskLevel: 'high' }));
    await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'blocked-audit-crash', { simulateCrashAfterBlockedAuditWrite: true });
    const firstRun = await worker.processAutomationBatch('auto-publish-worker-blocked-audit-crash-1', 1);
    assert.equal(firstRun.failed, 1);
    const firstAudits = (await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked');
    assert.equal(firstAudits.length, 1);
    const firstAuditId = firstAudits[0].id;
    assert.equal((await products.getPublicProducts()).some(item => item.id === product.id), false);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);

    await adapter.runTransaction('automation-jobs', jobs => {
      const retry = jobs.find(item => item.id === queued.job.id);
      retry.nextRetryAt = new Date(0).toISOString();
      return jobs;
    });
    const replay = await worker.processAutomationBatch('auto-publish-worker-blocked-audit-crash-2', 1);
    assert.equal(replay.succeeded, 1, JSON.stringify(await store.getAutomationJob(queued.job.id)));
    const replayedAudits = (await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked');
    assert.equal(replayedAudits.length, 1);
    assert.equal(replayedAudits[0].id, firstAuditId);
    assert.equal((await journal.getOperationJournal(queued.job.operationId)).reconciliationStatus, 'CONSISTENT');
  });

  await test('a runtime block after a normal journal starts records one separate durable blocked effect', async () => {
    await reset();
    const product = await hydratePersistedEvidence(readyProduct('runtime-block-after-journal'));
    await adapter.writeCollection('products', [product]);
    const queued = await publishJob(store, product, 'runtime-block-after-journal');
    const snapshotHash = require('../src/lib/autonomous/publishPolicy.ts').readinessSnapshotHash(product);
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
    await store.updateAutomationControl({
      publishBlockedByRuntime: true,
      publishPausedByOperator: false,
      publishBlockedByPolicy: false,
    }, 'runtime-guardian');
    const run = await worker.processAutomationBatch('runtime-block-after-journal-worker', 1);
    assert.equal(run.succeeded, 1);
    const audit = (await adapter.readCollection('publication-audit')).find(item => item.action === 'publish_blocked');
    assert.ok(audit);
    assert.ok(audit.reasonCodes.includes('publish_blocked_by_runtime'));
    assert.deepEqual(audit.productReasonCodes, []);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);
    const journals = await adapter.readCollection('operation-journal');
    assert.equal(journals.filter(item => item.operationType === 'AUTO_SAFE_PUBLISH_BLOCKED').length, 1);
    assert.equal(journals.find(item => item.operationType === 'AUTO_SAFE_PUBLISH_BLOCKED').reconciliationStatus, 'CONSISTENT');
  });

  await test('operator publication pause remains distinct from the runtime block in blocked audit evidence', async () => {
    await reset();
    const product = await hydratePersistedEvidence(readyProduct('operator-paused-audit'));
    await adapter.writeCollection('products', [product]);
    await store.updateAutomationControl({
      publishPausedByOperator: true,
      publishBlockedByRuntime: false,
      publishBlockedByPolicy: false,
    }, 'operator-test');
    await publishJob(store, product, 'operator-paused-audit');
    const run = await worker.processAutomationBatch('operator-paused-audit-worker', 1);
    assert.equal(run.succeeded, 1);
    const audit = (await adapter.readCollection('publication-audit')).find(item => item.action === 'publish_blocked');
    assert.ok(audit.reasonCodes.includes('publish_paused_by_operator'));
    assert.equal(audit.runtimeReasonCodes.includes('publish_blocked_by_runtime'), false);
    assert.deepEqual(audit.productReasonCodes, []);
    assert.equal(audit.riskLevel, 'LOW');
    const control = await store.getAutomationControl();
    assert.equal(control.publishPausedByOperator, true);
    assert.equal(control.publishBlockedByRuntime, false);
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
    await store.failAutomationJob(claimed.id, 'auto-publish-worker-pending-1', 'TEMPORARY_ERROR', new Error('simulated worker crash'), {
      nextRetryAt: new Date(0).toISOString(),
      claimToken: claimed.claimToken,
    });
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
    await adapter.writeCollection('publication-audit', []);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);
    await adapter.runTransaction('automation-jobs', jobs => { const job = jobs.find(item => item.id === queued.job.id); job.nextRetryAt = new Date(0).toISOString(); return jobs; });
    const recoveryRun = await worker.processAutomationBatch('auto-publish-worker-crash-2', 1);
    assert.equal(recoveryRun.succeeded, 1, JSON.stringify({ recoveryRun, job: await store.getAutomationJob(queued.job.id) }));
    const recovered = await products.getProductById(product.id);
    assert.equal(recovered.publishedAt, publishedAt); assert.equal(recovered.lifecycleState, 'PUBLISHED');
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 1);
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === product.id && item.action === 'published').length, 1);
    assert.equal((await adapter.readCollection('publication-audit')).find(item => item.productId === product.id).previousState, 'needs_review');
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 1);
    assert.equal((await adapter.readCollection('product-lifecycle-events')).filter(event => event.productId === product.id).length, 2);
    const reconciledJournal = await journal.getOperationJournal(queued.job.operationId);
    assert.equal(reconciledJournal.intendedEffects.find(effect => effect.id === 'publication-audit').status, 'COMPLETED');
    assert.equal(reconciledJournal.reconciliationStatus, 'CONSISTENT');
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
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked').length, 1);
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
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked').length, 1);
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
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked').length, 1);
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
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked').length, 1);
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
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.action === 'publish_blocked').length, 1);
  });

  await test('controlled CANARY wave 1 publishes at most ten products and pauses the eleventh', async () => {
    await reset('CANARY'); await canary.recordSuccessfulShadowCycle();
    const fixtures = [];
    for (const id of Array.from({ length: 11 }, (_, index) => `c${index + 1}`)) fixtures.push(await hydratePersistedEvidence(readyProduct(id)));
    await adapter.writeCollection('products', fixtures);
    for (const item of fixtures) await publishJob(store, item, `canary-${item.id}`);
    const firstRun = await worker.processAutomationBatch('auto-publish-worker-canary', 10);
    const secondRun = await worker.processAutomationBatch('auto-publish-worker-canary', 1);
    assert.equal(firstRun.succeeded, 10); assert.equal(secondRun.succeeded, 1);
    const saved = await products.getAllProducts();
    assert.equal(saved.filter(item => item.status === 'published').length, 10);
    assert.equal(saved.find(item => item.id === 'c11').lifecycleState, 'READY_FOR_PUBLISH');
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 10);
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
    for (const id of Array.from({ length: 10 }, (_, index) => `canary-fill-${index + 1}`)) fillers.push(await hydratePersistedEvidence(readyProduct(id)));
    await adapter.writeCollection('products', [await products.getProductById(recoveryProduct.id), ...fillers]);
    for (const product of fillers) await publishJob(store, product, product.id);
    const fillerRun = await worker.processAutomationBatch('auto-publish-worker-canary-fill', 10);
    assert.equal(fillerRun.succeeded, 10);
    assert.equal((await products.getAllProducts()).filter(product => product.status === 'published' && product.lifecycleState === 'PUBLISHED').length, 9);

    await adapter.runTransaction('automation-jobs', jobs => { const job = jobs.find(item => item.id === recoveryJob.job.id); job.nextRetryAt = new Date(0).toISOString(); return jobs; });
    const recovered = await worker.processAutomationBatch('auto-publish-worker-canary-recover', 1);
    assert.equal(recovered.succeeded, 1, JSON.stringify(await store.getAutomationJob(recoveryJob.job.id)));
    assert.equal((await products.getProductById(recoveryProduct.id)).lifecycleState, 'PUBLISHED');
    assert.equal((await products.getAllProducts()).filter(product => product.status === 'published' && product.lifecycleState === 'PUBLISHED').length, 10);
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === recoveryProduct.id && item.action === 'published').length, 1);
  });

  await test('an enabled recovery canary uses the real publication and monitor path without becoming discoverable early', async () => {
    const fixture = await prepareRuntimeRecoveryCanary('healthy');
    const publishedRun = await worker.processAutomationBatch(fixture.workerId, 1, fixture.ownership);
    assert.equal(publishedRun.succeeded, 1, JSON.stringify(await store.getAutomationJob(fixture.queued.job.id)));
    const observing = await products.getProductById(fixture.product.id);
    assert.equal(observing.status, 'published');
    assert.equal(observing.lifecycleState, 'PUBLISHED');
    assert.equal(observing.runtimeRecoveryCanaryObservationPending, true);
    assert.equal((await products.getPublishedProducts()).some(item => item.id === fixture.product.id), false);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 1);
    const monitorJobs = (await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR');
    assert.equal(monitorJobs.length, 1);
    assert.equal(typeof monitorJobs[0].payload.runtimeRecoveryCanaryPermitId, 'string');

    await adapter.runTransaction('automation-jobs', jobs => {
      const monitor = jobs.find(item => item.id === monitorJobs[0].id);
      monitor.scheduledAt = new Date(0).toISOString();
      monitor.payload.healthOutcome = 'HEALTHY';
      monitor.payload.publicPageStatus = 200;
      return jobs;
    });
    const monitored = await worker.processAutomationBatch(fixture.workerId, 1, fixture.ownership);
    assert.equal(monitored.succeeded, 1);
    const healthy = await products.getProductById(fixture.product.id);
    const permit = await recoveryCanary.getRuntimeRecoveryCanaryPermit(observing.runtimeRecoveryCanaryPermitId);
    assert.equal(healthy.runtimeRecoveryCanaryObservationPending, false);
    const publicFilter = require('../src/lib/publicProductFilter.ts');
    assert.equal((await products.getPublishedProducts()).some(item => item.id === fixture.product.id), true, JSON.stringify({
      reason: publicFilter.getPublicProductBlockReason(healthy),
      status: healthy.status,
      lifecycleState: healthy.lifecycleState,
      publicHidden: healthy.publicHidden,
      publicBlocked: healthy.publicBlocked,
      publicDecision: healthy.publicDecision,
      publicBlockReasons: healthy.publicBlockReasons,
      currentBlockers: healthy.currentBlockers,
      autoPublishEligible: healthy.autoPublishEligible,
      evidenceCoverage: healthy.evidenceCoverage,
      publishConfidence: healthy.confidences?.publish,
    }));
    assert.equal(permit.status, 'SUCCEEDED');
    assert.equal((await store.getAutomationControl()).publishBlockedByRuntime, true);
    assert.equal((await runtimeRecovery.getRuntimeRecoveryState()).state, 'RECOVERY_OBSERVING');
  });

  await test('a recovery canary resumes its committed publication effects exactly once after worker restart', async () => {
    const fixture = await prepareRuntimeRecoveryCanary('restart-replay', { simulateCrashAfterProductWrite: true });
    const firstRun = await worker.processAutomationBatch(fixture.workerId, 1, fixture.ownership);
    assert.equal(firstRun.failed, 1);
    const afterCrash = await products.getProductById(fixture.product.id);
    assert.equal(afterCrash.status, 'published');
    assert.equal(afterCrash.lifecycleState, 'PUBLISHING');
    assert.equal(afterCrash.runtimeRecoveryCanaryObservationPending, true);
    assert.equal((await products.getPublishedProducts()).some(item => item.id === fixture.product.id), false);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 0);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 0);
    const permitAfterCrash = await recoveryCanary.getRuntimeRecoveryCanaryPermit(afterCrash.runtimeRecoveryCanaryPermitId);
    assert.equal(permitAfterCrash.status, 'CONSUMED');

    await adapter.runTransaction('automation-jobs', jobs => {
      const retry = jobs.find(item => item.id === fixture.queued.job.id);
      retry.nextRetryAt = new Date(0).toISOString();
      return jobs;
    });
    const replay = await worker.processAutomationBatch(fixture.workerId, 1, fixture.ownership);
    assert.equal(replay.succeeded, 1, JSON.stringify(await store.getAutomationJob(fixture.queued.job.id)));
    const recovered = await products.getProductById(fixture.product.id);
    assert.equal(recovered.lifecycleState, 'PUBLISHED');
    assert.equal(recovered.runtimeRecoveryCanaryObservationPending, true);
    assert.equal(recovered.runtimeRecoveryCanaryPermitId, permitAfterCrash.id);
    assert.equal((await products.getPublishedProducts()).some(item => item.id === fixture.product.id), false);
    assert.equal((await adapter.readCollection('automation-outbound-events')).length, 1);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'POST_PUBLISH_MONITOR').length, 1);
    assert.equal((await adapter.readCollection('publication-audit')).filter(item => item.productId === fixture.product.id && item.action === 'published').length, 1);
    assert.equal((await recoveryCanary.listRuntimeRecoveryCanaryPermits()).length, 1);
    assert.equal((await journal.getOperationJournal(fixture.queued.job.operationId)).reconciliationStatus, 'CONSISTENT');
  });

  await test('an unhealthy recovery canary is hidden immediately and preserves the runtime block', async () => {
    const fixture = await prepareRuntimeRecoveryCanary('unhealthy');
    const publishedRun = await worker.processAutomationBatch(fixture.workerId, 1, fixture.ownership);
    assert.equal(publishedRun.succeeded, 1);
    const observing = await products.getProductById(fixture.product.id);
    const monitorJob = (await store.getAllAutomationJobs()).find(job => job.type === 'POST_PUBLISH_MONITOR');
    await adapter.runTransaction('automation-jobs', jobs => {
      const monitor = jobs.find(item => item.id === monitorJob.id);
      monitor.scheduledAt = new Date(0).toISOString();
      monitor.payload.healthOutcome = 'TEMPORARY_FAILURE';
      return jobs;
    });
    const monitored = await worker.processAutomationBatch(fixture.workerId, 1, fixture.ownership);
    assert.equal(monitored.succeeded, 1, JSON.stringify(await store.getAutomationJob(monitorJob.id)));
    const hidden = await products.getProductById(fixture.product.id);
    const permit = await recoveryCanary.getRuntimeRecoveryCanaryPermit(observing.runtimeRecoveryCanaryPermitId);
    assert.equal(hidden.lifecycleState, 'HIDDEN');
    assert.equal(hidden.status, 'needs_review');
    assert.equal(hidden.publicHidden, true);
    assert.equal(hidden.runtimeRecoveryCanaryObservationPending, false);
    assert.equal((await products.getPublishedProducts()).some(item => item.id === fixture.product.id), false);
    assert.equal(permit.status, 'FAILED');
    assert.equal((await store.getAutomationControl()).publishBlockedByRuntime, true);
    assert.equal((await runtimeRecovery.getRuntimeRecoveryState()).state, 'OPEN_BLOCKED');
  });

  console.log(`\nPROMPT10 Gate 5 auto publish: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
