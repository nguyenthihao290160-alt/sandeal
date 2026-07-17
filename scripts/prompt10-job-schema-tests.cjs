/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const tempDir = path.join(root, '.test-tmp', `prompt10-job-schema-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const policies = require('../src/lib/automation/policyRegistry.ts');
  const enqueue = require('../src/lib/automation/enqueue.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  const reconciler = require('../src/lib/automation/reconciler.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_JOB_SCHEMA'); };

  async function reset() {
    for (const collection of [
      'automation-jobs', 'automation-control', 'automation-audit', 'automation-settings', 'products',
      'candidate-queue', 'operation-journal', 'product-lifecycle-events', 'automation-canary',
    ]) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: true, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false, schedulerNextRunAt: undefined,
    }, 'job-schema-test');
  }

  function assertCurrentContract(job, type) {
    const policy = policies.getAutomationPolicy(type);
    assert.equal(job.type, type);
    assert.equal(job.schemaVersion, store.AUTOMATION_JOB_SCHEMA_VERSION);
    assert.equal(job.policyVersion, policy.policyVersion);
    assert.equal(job.handlerVersion, policy.handlerVersion);
    assert.equal(job.botId, policy.botId);
    assert.equal(job.capability, policy.capability);
    assert.equal(job.maxAttempts, policy.retryPolicy.maxAttempts);
    assert.ok(job.id && job.operationId && job.correlationId && job.idempotencyKey);
    assert.equal(job.sourceMetadata.producer, job.requestedBy);
    assert.ok(job.requestedExecutionMode);
    assert.equal(store.validateAutomationJobContract(job, { requireFactoryMetadata: true }).valid, true);
  }

  await test('1. factory creates the current schema contract', async () => {
    await reset();
    const record = store.createAutomationJobRecord({
      type: 'PRODUCT_SCAN', payload: { source: 'local', trigger: 'schema-test' },
      idempotencyKey: 'schema-factory-record-product-scan', requestedBy: 'schema-test',
    }, Date.parse('2026-07-17T01:00:00.000Z'));
    assertCurrentContract(record, 'PRODUCT_SCAN');
    assert.deepEqual(await store.getAllAutomationJobs(), []);
  });

  await test('2. PRODUCT_SCAN producer persists the current schema contract', async () => {
    await reset();
    const created = await enqueue.enqueueBotExecution({
      actor: 'schema-product-scan', mode: 'source_scan', source: 'local', limit: 1,
      trigger: 'system', idempotencyKey: 'schema-producer-product-scan',
    });
    assertCurrentContract(created.job, 'PRODUCT_SCAN');
  });

  await test('3. AUTO_PILOT scheduler producer persists the current schema contract', async () => {
    await reset();
    const now = Date.parse('2026-07-17T02:00:00.000Z');
    await settings.updateAutomationSettings({ enabled: true, intervalHours: 6 });
    await store.updateAutomationControl({ workerHeartbeatAt: new Date(now).toISOString(), schedulerNextRunAt: undefined }, 'job-schema-test');
    assert.equal((await scheduler.runAutomationSchedulerTick(now)).status, 'scheduled');
    assertCurrentContract((await store.getAllAutomationJobs()).find(job => job.type === 'AUTO_PILOT'), 'AUTO_PILOT');
  });

  await test('4. RUNTIME_GUARDIAN scheduler producer persists the current schema contract', async () => {
    await reset();
    const now = Date.parse('2026-07-17T02:30:00.000Z');
    assert.equal((await scheduler.runRuntimeControlSchedulerTick(now)).status, 'scheduled');
    assertCurrentContract((await store.getAllAutomationJobs()).find(job => job.type === 'RUNTIME_GUARDIAN'), 'RUNTIME_GUARDIAN');
  });

  await test('5. AUTO_SAFE_PUBLISH reconciler producer persists the current contract without publishing', async () => {
    await reset();
    const now = new Date().toISOString();
    await store.updateAutomationControl({ mode: 'CANARY', effectiveMode: 'CANARY', publishPaused: false }, 'job-schema-test');
    await adapter.writeCollection('products', [{
      schemaVersion: 2, id: 'schema-ready-product', title: 'Schema-ready source-backed product', slug: 'schema-ready-product',
      description: 'Isolated fixture used only to verify the durable publish-job producer contract.', kind: 'product', recordType: 'PRODUCT',
      lifecycleState: 'READY_FOR_PUBLISH', status: 'needs_review', publicHidden: true, needsVerification: false,
      platform: 'website', source: 'manual', sourceHash: 'schema-ready-source-hash', verifiedSource: true, sourceVerified: true,
      originalUrl: 'https://merchant.example/schema-ready-product', affiliateUrl: 'https://merchant.example/schema-ready-product?ref=fixture',
      imageUrl: 'https://merchant.example/schema-ready-product.jpg', price: 1000000, salePrice: 900000, currency: 'VND',
      riskLevel: 'low', autoPublishEligible: true, publicBlockReasons: [], linkHealthStatus: 'ok', affiliateHealthStatus: 'ok', imageHealthStatus: 'ok',
      evidenceFactIds: ['schema-ready-title', 'schema-ready-price'], evidenceSnapshotHash: 'schema-ready-snapshot',
      duplicateStatus: 'CLEAR', claimValidationStatus: 'VERIFIED', createdAt: now, updatedAt: now,
    }]);
    const result = await reconciler.runAutonomousReconciler();
    assert.equal(result.publishJobs, 1);
    const job = (await store.getAllAutomationJobs()).find(item => item.type === 'AUTO_SAFE_PUBLISH');
    assertCurrentContract(job, 'AUTO_SAFE_PUBLISH');
    const product = (await adapter.readCollection('products'))[0];
    assert.equal(product.status, 'needs_review'); assert.equal(product.publicHidden, true);
  });

  await test('6. missing schema is rejected by the enqueue write gate before persistence', async () => {
    await reset();
    const record = store.createAutomationJobRecord({
      type: 'PRODUCT_SCAN', payload: {}, idempotencyKey: 'schema-missing-before-persist', requestedBy: 'malformed-fixture',
    });
    const malformed = { ...record };
    delete malformed.schemaVersion;
    assert.throws(
      () => store.assertAutomationJobContract(malformed, { requireFactoryMetadata: true }),
      error => error instanceof store.AutomationJobEnqueueError
        && error.code === 'AUTOMATION_JOB_SCHEMA_UNSUPPORTED'
        && error.reasons.some(reason => reason.includes('schemaVersion')),
    );
    assert.deepEqual(await store.getAllAutomationJobs(), []);
  });

  await test('7. unsupported persisted schema is not a valid new worker job', async () => {
    await reset();
    const valid = store.createAutomationJobRecord({
      type: 'PRODUCT_SCAN', payload: {}, idempotencyKey: 'schema-unsupported-before-claim', requestedBy: 'malformed-fixture',
    });
    await adapter.writeCollection('automation-jobs', [{ ...valid, schemaVersion: 1 }]);
    assert.deepEqual(await store.claimAutomationJobs('schema-worker', 1), []);
    const blocked = (await store.getAllAutomationJobs())[0];
    assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.lastErrorCode, 'AUTOMATION_JOB_SCHEMA_UNSUPPORTED');
    const audits = await adapter.readCollection('automation-audit');
    assert.ok(audits.some(event => event.jobId === blocked.id && event.operationType === 'JOB_REJECTED_BEFORE_CLAIM'));
  });

  await test('8. duplicate and idempotency protection remains atomic', async () => {
    await reset();
    const input = { type: 'RUNTIME_GUARDIAN', payload: {}, idempotencyKey: 'schema-idempotent-runtime-guardian', requestedBy: 'scheduler' };
    const attempts = await Promise.all(Array.from({ length: 6 }, () => store.createAutomationJob(input)));
    assert.equal(attempts.filter(item => item.created).length, 1);
    assert.equal(new Set(attempts.map(item => item.job.id)).size, 1);
    assert.equal((await store.getAllAutomationJobs()).length, 1);
  });

  await test('9. malformed producer returns a structured error without crashing the next scheduler tick', async () => {
    await reset();
    await assert.rejects(
      () => store.createAutomationJob({
        type: 'PRODUCT_SCAN', payload: {}, idempotencyKey: 'bad', requestedBy: 'malformed-producer',
      }),
      error => error instanceof store.AutomationJobEnqueueError
        && error.code === 'INVALID_IDEMPOTENCY_KEY'
        && error.reasons.length > 0,
    );
    assert.equal((await store.getAllAutomationJobs()).length, 0);
    assert.ok((await adapter.readCollection('automation-audit')).some(event => event.operationType === 'JOB_ENQUEUE_REJECTED'));
    const tick = await scheduler.runRuntimeControlSchedulerTick(Date.parse('2026-07-17T03:00:00.000Z'));
    assert.equal(tick.status, 'scheduled');
    assertCurrentContract((await store.getAllAutomationJobs())[0], 'RUNTIME_GUARDIAN');
  });

  await test('10. targeted suite writes only to the isolated test data directory', async () => {
    assert.equal(path.resolve(process.env.SANDEAL_DATA_DIR), path.resolve(tempDir));
    const artifacts = fs.readdirSync(tempDir);
    assert.ok(artifacts.includes('automation-jobs.json'));
    assert.ok(artifacts.every(name => !path.isAbsolute(name) && name !== '.data'));
  });

  console.log(`\nPROMPT10 job schema factory: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, tempDir)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
