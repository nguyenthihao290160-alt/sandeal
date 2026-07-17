/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempDir = path.join(process.cwd(), '.test-tmp', `prompt10-foundation-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.AUTO_PUBLISH_ENABLED = 'false';
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

function safeProduct(overrides = {}) {
  const now = new Date().toISOString();
  const product = {
    schemaVersion: 2,
    id: 'foundation-product',
    title: 'Tai nghe Bluetooth SanDeal verified fixture',
    slug: 'tai-nghe-bluetooth-sandeal-verified-fixture',
    description: 'Source-backed fixture with verified price, merchant links, and product specifications.',
    kind: 'product', recordType: 'PRODUCT', lifecycleState: 'READY_FOR_PUBLISH',
    platform: 'website', source: 'manual',
    originalUrl: 'https://merchant.example/products/foundation-product',
    affiliateUrl: 'https://merchant.example/products/foundation-product?affiliate=fixture',
    imageUrl: 'https://merchant.example/images/foundation-product.jpg',
    price: 1500000, salePrice: 1200000, currency: 'VND', category: 'Audio', brand: 'Fixture', sku: 'FIXTURE-10',
    specifications: { connection: 'Bluetooth', warranty: '12 months' },
    tags: [], benefits: [], warnings: [], riskLevel: 'low', status: 'needs_review',
    verifiedSource: true, sourceVerified: true, autoPublishEligible: true, publicHidden: true, needsVerification: true,
    linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
    linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now,
    duplicateStatus: 'CLEAR', claimValidationStatus: 'VERIFIED', evidenceCoverage: 0.94,
    evidenceSnapshotAt: now, evidenceSnapshotHash: 'evidence-fixture-v1', evidenceFactIds: ['title', 'price', 'source', 'links', 'image'],
    confidences: { classification: 0.99, source: 0.98, price: 0.96, image: 0.96, health: 0.96, duplicate: 0.99, contentEvidenceCoverage: 0.94, editorial: 0.92, publish: 0.93, calculatedAt: now, ruleVersion: 'confidence-v1' },
    sourceHash: 'foundation-source-hash', createdAt: now, updatedAt: now,
    ...overrides,
  };
  const editorial = require('../src/lib/editorialReview.ts');
  return { ...product, reviewContent: editorial.generateEditorialReview(product, [], now) };
}

function context(overrides = {}) {
  return { mode: 'CANARY', killSwitch: false, publishPaused: false, workerId: 'worker-10', jobType: 'AUTO_SAFE_PUBLISH', jobClaimedBy: 'worker-10', withinBudget: true, withinCanaryWave: true, ...overrides };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const policies = require('../src/lib/automation/policyRegistry.ts');
  const registry = require('../src/lib/automation/botRegistry.ts');
  const store = require('../src/lib/automation/store.ts');
  const publish = require('../src/lib/autonomous/publishPolicy.ts');
  const migrations = require('../src/lib/autonomous/migrations.ts');
  const schemaMigrations = require('../src/lib/autonomous/schemaMigrations.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const dashboard = require('../src/lib/automation/dashboard.ts');
  const settingsStore = require('../src/lib/storage/automationSettings.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const providerRouter = require('../src/lib/automation/providerRouter.ts');

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_FOUNDATION'); };

  await test('AutomationPolicyRegistry covers every durable job type with versioned contracts', () => {
    const entries = policies.listAutomationPolicies();
    const expectedJobTypes = [
      'PRODUCT_SCAN', 'AUTO_PILOT', 'PROCESS_CANDIDATE', 'AUTO_SAFE_PUBLISH', 'POST_PUBLISH_MONITOR',
      'RECONCILE_AUTOMATION', 'RUNTIME_GUARDIAN', 'SAFE_PUBLISH', 'AI_ANALYSIS', 'HEALTH_CHECK',
      'IMPORT_PRODUCTS', 'RECHECK_PRODUCT_HEALTH', 'DETECT_DUPLICATES', 'SCORE_PRODUCTS',
      'CAPTURE_PRICE_HISTORY', 'PREPARE_CONTENT_DRAFT', 'EDITORIAL_CHECK', 'EVALUATE_ALERTS',
      'AGGREGATE_GROWTH_METRICS', 'BULK_PRODUCT_OPERATION',
    ];
    assert.equal(new Set(entries.map(item => item.jobType)).size, entries.length);
    assert.deepEqual(entries.map(item => item.jobType).sort(), expectedJobTypes.sort());
    for (const item of entries) {
      assert.equal(item.policyVersion, policies.AUTOMATION_POLICY_VERSION);
      assert.ok(item.capability && item.handlerVersion && item.idempotencyStrategy);
      assert.ok(item.retryPolicy.maxAttempts >= 1);
      assert.ok(Array.isArray(item.writeScope));
    }
  });

  await test('Bot Registry derives enforcement fields from Policy Registry', () => {
    const policyEntries = policies.listAutomationPolicies();
    for (const policy of policyEntries) {
      const bot = registry.getBotRegistryEntry(policy.botId);
      assert.ok(bot && bot.enabled, `${policy.jobType}:${policy.botId}`);
      assert.equal(bot.jobType, policy.jobType);
      assert.equal(bot.capability, policy.capability);
      assert.equal(bot.risk, policy.defaultRisk, bot.id);
      assert.equal(bot.approvalRequired, policy.approvalMode === 'REQUIRED', bot.id);
      assert.deepEqual(bot.writeScope, policy.writeScope, bot.id);
      assert.deepEqual(bot.fallback, policy.fallbackPolicy, bot.id);
      const defaults = registry.getJobRegistryDefaults(policy.jobType, {});
      assert.equal(defaults.botId, policy.botId);
      assert.equal(defaults.capability, policy.capability);
      assert.deepEqual(defaults.writeScope, policy.writeScope);
      assert.equal(defaults.externalSideEffect, policy.externalSideEffect);
    }
  });

  await test('every created job snapshots policy into worker-enforced execution disclosure', async () => {
    await adapter.writeCollection('automation-jobs', []);
    for (const policy of policies.listAutomationPolicies()) {
      const created = await store.createAutomationJob({
        type: policy.jobType, payload: {}, idempotencyKey: `policy-contract-${policy.jobType.toLowerCase().replaceAll('_', '-')}`,
        requestedBy: 'foundation-contract', riskLevel: policy.defaultRisk,
      });
      const job = created.job;
      assert.equal(job.schemaVersion, 2, policy.jobType);
      assert.equal(job.policyVersion, policy.policyVersion, policy.jobType);
      assert.equal(job.handlerVersion, policy.handlerVersion, policy.jobType);
      assert.equal(job.botId, policy.botId, policy.jobType);
      assert.equal(job.capability, policy.capability, policy.jobType);
      assert.equal(job.maxAttempts, policy.retryPolicy.maxAttempts, policy.jobType);
      for (const step of job.executionPlan) {
        assert.equal(step.approvalRequired, job.approvalStatus === 'PENDING', policy.jobType);
        assert.deepEqual(step.expectedWrite, policy.writeScope, policy.jobType);
        assert.equal(step.externalCall, policy.externalSideEffect, policy.jobType);
        assert.deepEqual(step.fallback, policy.fallbackPolicy, policy.jobType);
      }
    }
  });

  await test('HIGH risk with approvalMode NEVER does not disclose a fake approval gate', async () => {
    await adapter.writeCollection('automation-jobs', []);
    const created = await store.createAutomationJob({ type: 'EDITORIAL_CHECK', payload: {}, idempotencyKey: 'editorial-policy-never-approval', requestedBy: 'foundation-contract' });
    assert.equal(policies.getAutomationPolicy('EDITORIAL_CHECK').approvalMode, 'NEVER');
    assert.equal(created.job.approvalStatus, 'NOT_REQUIRED');
    assert.equal(created.job.status, 'PENDING');
    assert.ok(created.job.executionPlan.every(step => step.approvalRequired === false));
  });

  await test('scheduler job and dashboard disclosure use the same policy snapshot', async () => {
    await adapter.writeCollection('automation-jobs', []);
    await adapter.writeCollection('automation-control', []);
    await settingsStore.updateAutomationSettings({ enabled: true, intervalHours: 6 });
    await store.updateAutomationControl({ schedulerPaused: false, mode: 'SHADOW', effectiveMode: 'SHADOW', workerHeartbeatAt: new Date().toISOString() }, 'foundation-test');
    const tick = await scheduler.runAutomationSchedulerTick(Date.parse('2026-07-16T00:00:00.000Z'));
    assert.equal(tick.status, 'scheduled');
    const job = (await store.getAllAutomationJobs())[0];
    const policy = policies.getAutomationPolicy('AUTO_PILOT');
    assert.equal(job.policyVersion, policy.policyVersion);
    assert.equal(job.handlerVersion, policy.handlerVersion);
    assert.equal(job.botId, policy.botId);
    assert.equal(job.riskLevel, policy.defaultRisk);
    assert.equal(job.status, 'PENDING');
    const view = await dashboard.buildAutomationDashboard('today');
    const disclosure = view.policy.capabilities.find(item => item.jobType === 'AUTO_PILOT');
    assert.equal(view.policy.version, policy.policyVersion);
    assert.equal(disclosure.handlerVersion, policy.handlerVersion);
    assert.equal(disclosure.approvalMode, policy.approvalMode);
  });

  await test('claim gate blocks a job whose bot snapshot violates policy before worker execution', async () => {
    await adapter.writeCollection('automation-jobs', []);
    await store.updateAutomationControl({ workerPaused: false, killSwitch: false }, 'foundation-test');
    const created = await store.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'prompt10-worker-policy-001', requestedBy: 'test', riskLevel: 'LOW' });
    await adapter.runTransaction('automation-jobs', items => {
      items.find(item => item.id === created.job.id).botId = 'UNREGISTERED_BOT';
      return items;
    });
    const result = await worker.processAutomationBatch('foundation-worker', 1);
    assert.equal(result.claimed, 0); assert.equal(result.failed, 0);
    const blocked = await store.getAutomationJob(created.job.id);
    assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.lastErrorCode, 'SCHEMA_VALIDATION_FAILED');
  });

  await test('claim gate fails closed before worker when a legacy job is missing policy snapshots', async () => {
    await adapter.writeCollection('automation-jobs', []);
    await store.updateAutomationControl({ workerPaused: false, killSwitch: false }, 'foundation-test');
    const created = await store.createAutomationJob({ type: 'HEALTH_CHECK', payload: {}, idempotencyKey: 'prompt10-worker-fail-closed', requestedBy: 'foundation-test' });
    await adapter.runTransaction('automation-jobs', items => {
      const job = items.find(item => item.id === created.job.id);
      delete job.schemaVersion; delete job.policyVersion; delete job.handlerVersion; delete job.botId;
      return items;
    });
    const result = await worker.processAutomationBatch('foundation-fail-closed-worker', 1);
    assert.equal(result.claimed, 0); assert.equal(result.failed, 0);
    const blocked = await store.getAutomationJob(created.job.id);
    assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.lastErrorCode, 'AUTOMATION_JOB_SCHEMA_UNSUPPORTED');
  });

  await test('enabled Runtime Guardian policy has an executable worker handler', async () => {
    await adapter.writeCollection('automation-jobs', []);
    await adapter.writeCollection('runtime-health', []);
    await store.updateAutomationControl({ workerPaused: false, schedulerPaused: true, killSwitch: false }, 'foundation-test');
    const created = await store.createAutomationJob({ type: 'RUNTIME_GUARDIAN', payload: {}, idempotencyKey: 'prompt10-runtime-guardian-handler', requestedBy: 'foundation-test' });
    const result = await worker.processAutomationBatch('foundation-guardian-worker', 1);
    assert.equal(result.succeeded, 1, JSON.stringify(await store.getAutomationJob(created.job.id)));
    assert.equal((await store.getAutomationJob(created.job.id)).status, 'SUCCEEDED');
    assert.equal((await adapter.readCollection('runtime-health')).length, 1);
  });

  await test('SAFE_PUBLISH cannot bypass owner approval by lowering client risk', async () => {
    await adapter.writeCollection('automation-jobs', []);
    const created = await store.createAutomationJob({ type: 'SAFE_PUBLISH', payload: { productId: 'p1' }, idempotencyKey: 'prompt10-safe-policy-001', requestedBy: 'untrusted-client', riskLevel: 'LOW' });
    assert.equal(created.job.status, 'WAITING_APPROVAL');
    assert.equal(created.job.approvalStatus, 'PENDING');
  });

  const negativeCases = [
    ['non-product', { recordType: 'VOUCHER', kind: 'voucher' }, 'not_product'],
    ['high risk', { riskLevel: 'high' }, 'human_review_required'],
    ['missing source', { verifiedSource: false, sourceVerified: false }, 'source_unverified'],
    ['broken product link', { linkHealthStatus: 'broken' }, 'product_url_unhealthy'],
    ['broken affiliate link', { affiliateHealthStatus: 'broken' }, 'affiliate_url_unhealthy'],
    ['broken image', { imageHealthStatus: 'image_broken' }, 'image_unhealthy'],
    ['unresolved duplicate', { duplicateStatus: 'UNRESOLVED' }, 'duplicate_unresolved'],
    ['claim without evidence', { claimValidationStatus: 'MISSING_EVIDENCE' }, 'claim_evidence_unverified'],
    ['stale evidence snapshot', { evidenceSnapshotAt: '2020-01-01T00:00:00.000Z' }, 'evidence_snapshot_stale'],
    ['low publish confidence', { confidences: { ...safeProduct().confidences, publish: 0.2 } }, 'publish_confidence_low'],
    ['wrong execution mode', {}, 'mode_disallows_publish', { mode: 'SHADOW' }],
    ['outside worker', {}, 'durable_worker_required', { workerId: undefined }],
    ['budget exceeded', {}, 'publish_budget_exceeded', { withinBudget: false }],
    ['canary wave exceeded', {}, 'canary_wave_exceeded', { withinCanaryWave: false }],
  ];
  for (const [name, productOverrides, reason, contextOverrides = {}] of negativeCases) {
    await test(`publish invariant rejects ${name}`, () => {
      const result = publish.evaluateAutonomousPublish(safeProduct(productOverrides), context(contextOverrides));
      assert.equal(result.eligible, false);
      assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
    });
  }

  await test('client autoPublishEligible flag alone cannot declare eligibility', () => {
    const product = safeProduct({ evidenceCoverage: 0, evidenceFactIds: [], evidenceSnapshotAt: undefined, confidences: undefined, autoPublishEligible: true });
    const result = publish.evaluateAutonomousPublish(product, context());
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes('evidence_coverage_low'));
  });

  await test('free-only routing never selects a paid or unavailable provider', async () => {
    const decision = await providerRouter.routeProviderExecution({
      capability: 'ANALYZE_WITH_EVIDENCE', requestedMode: 'AUTO', provider: 'gemini', providerAdapterAvailable: false,
      localMode: 'LOCAL_TEMPLATE', allowLocalFallback: true, allowManualFallback: true, allowPaidFallback: false,
      estimatedRequests: 1, estimatedTokens: 100,
    });
    assert.notEqual(decision.executionMode, 'API');
    assert.equal(decision.aiRequests, 0);
  });

  await test('valid server-derived readiness snapshot passes foundation invariant', () => {
    const result = publish.evaluateAutonomousPublish(safeProduct(), context());
    assert.equal(result.eligible, true, JSON.stringify(result.reasons));
    assert.match(result.snapshotHash, /^[a-f0-9]{64}$/);
  });

  await test('schema backfill is dry by default, resumable, and idempotent', async () => {
    const legacy = safeProduct({ schemaVersion: undefined, recordType: undefined, lifecycleState: undefined, status: 'needs_review', publicHidden: true });
    delete legacy.schemaVersion; delete legacy.recordType; delete legacy.lifecycleState;
    await adapter.writeCollection('products', [legacy]);
    await adapter.writeCollection('autonomous-migrations', []);
    const preview = await migrations.runAutonomousSchemaBackfill();
    assert.equal(preview.dryRun, true);
    assert.equal((await adapter.readCollection('products'))[0].schemaVersion, undefined);
    const applied = await migrations.runAutonomousSchemaBackfill({ dryRun: false, limit: 1 });
    assert.equal(applied.migrated, 1);
    const migrated = (await adapter.readCollection('products'))[0];
    assert.equal(migrated.schemaVersion, 2);
    assert.notEqual(migrated.status, 'published');
    const rerun = await migrations.runAutonomousSchemaBackfill({ dryRun: false, limit: 1 });
    assert.equal(rerun.migrated, 0);
    assert.equal(rerun.skipped, 1);
  });

  await test('persisted entity backfill versions candidates/control/audit and blocks legacy executable jobs', async () => {
    const now = new Date().toISOString();
    await adapter.writeCollection('automation-jobs', [{ id: 'legacy-job', type: 'HEALTH_CHECK', status: 'PENDING', payload: {}, riskLevel: 'LOW', approvalStatus: 'NOT_REQUIRED', requestedBy: 'legacy', attemptCount: 0, maxAttempts: 1, createdAt: now, updatedAt: now }]);
    await adapter.writeCollection('automation-control', [{ id: 'automation-control', workerPaused: false, schedulerPaused: false, killSwitch: false, updatedAt: now }]);
    await adapter.writeCollection('automation-audit', [{ id: 'legacy-audit', reasons: [], createdAt: now }]);
    await adapter.writeCollection('candidate-queue', [{ id: 'legacy-candidate', source: 'manual', sourceId: 'legacy', status: 'pending', priority: 1, attempts: 0, createdAt: now, updatedAt: now, contentHash: 'legacy', sourceHash: 'legacy', payload: {} }]);
    await adapter.writeCollection('autonomous-entity-migrations', []);
    const preview = await schemaMigrations.runPersistedEntityBackfill();
    assert.equal(preview.dryRun, true);
    assert.equal((await adapter.readCollection('automation-jobs'))[0].schemaVersion, undefined);
    const applied = await schemaMigrations.runPersistedEntityBackfill({ dryRun: false });
    assert.equal(applied.failed, 0);
    assert.equal((await adapter.readCollection('automation-jobs'))[0].status, 'BLOCKED');
    assert.equal((await adapter.readCollection('automation-jobs'))[0].schemaVersion, 2);
    assert.equal((await adapter.readCollection('automation-control'))[0].schemaVersion, 2);
    assert.equal((await adapter.readCollection('automation-audit'))[0].schemaVersion, 2);
    assert.equal((await adapter.readCollection('candidate-queue'))[0].schemaVersion, 2);
    assert.equal((await adapter.readCollection('automation-audit')).length, 1, 'audit history must be preserved');
    const rerun = await schemaMigrations.runPersistedEntityBackfill({ dryRun: false });
    assert.equal(rerun.migrated, 0);
    assert.equal(rerun.failed, 0);
  });

  console.log(`\nPROMPT10 Gate 1 foundation: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
