/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const testRoot = path.join(root, '.test-tmp', `master-m6-integration-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = path.join(testRoot, 'data');
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.NODE_ENV = 'test';
require('./register-typescript.cjs');

const adapter = require('../src/lib/storage/adapter.ts');
const correlation = require('../src/lib/automation/correlationTrace.ts');

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

const timestamp = '2026-07-26T08:00:00.000Z';
const operationId = 'publish:trace-raw-123';
const publishJobId = 'job-raw-publish-123';
const monitorJobId = 'job-raw-monitor-123';
const productId = 'product-raw-123';

function publishJob(overrides = {}) {
  return {
    schemaVersion: 2,
    policyVersion: 'policy-v1',
    handlerVersion: 'handler-v1',
    id: publishJobId,
    type: 'AUTO_SAFE_PUBLISH',
    status: 'SUCCEEDED',
    payload: {
      productId,
      accessToken: 'test-fixture-payload-secret-must-not-leak',
    },
    result: {
      provider: 'local',
      productId,
      authorization: 'Bearer result-secret-must-not-leak',
    },
    disclosure: {
      status: 'COMPLETED_WITH_LOCAL_RULES',
      requestedMode: 'AUTO',
      executionMode: 'LOCAL_RULES',
      provider: 'local',
      warnings: [],
      limitations: [],
      aiRequests: 0,
      externalRequests: 0,
      completedSteps: ['publication'],
      pendingSteps: [],
      completedAt: timestamp,
    },
    priority: 90,
    idempotencyKey: 'publish-trace',
    operationId,
    requestedBy: 'test',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'HIGH',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: timestamp,
    scheduledAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    ...overrides,
  };
}

function monitorJob() {
  return {
    ...publishJob({
      id: monitorJobId,
      type: 'POST_PUBLISH_MONITOR',
      status: 'PENDING',
      payload: { productId, publicationEffectKey: 'effect-raw-123' },
      result: undefined,
      disclosure: undefined,
      operationId: 'monitor:product-raw-123:effect-raw-123',
      parentJobId: publishJobId,
      attemptCount: 0,
      completedAt: undefined,
    }),
  };
}

async function seedCompleteTrace() {
  await adapter.writeCollection('automation-jobs', [publishJob(), monitorJob()]);
  await adapter.writeCollection('automation-job-attempts', [{
    schemaVersion: 1,
    id: `${publishJobId}:attempt:1`,
    jobId: publishJobId,
    jobType: 'AUTO_SAFE_PUBLISH',
    operationId,
    attemptNumber: 1,
    runnableAt: timestamp,
    runnableReason: 'CREATED_AT',
    createdAt: timestamp,
    scheduledAt: timestamp,
    claimedAt: timestamp,
    claimTokenHash: 'claim-token-hash',
    workerId: 'worker-raw-123',
  }]);
  await adapter.writeCollection('automation-audit', [{
    schemaVersion: 2,
    id: 'automation-audit-raw-123',
    correlationId: operationId,
    operationId,
    jobId: publishJobId,
    operationType: 'AUTO_SAFE_PUBLISH',
    actor: 'worker-raw-123',
    target: productId,
    nextState: 'SUCCEEDED',
    result: { apiKey: 'test-fixture-audit-secret-must-not-leak' },
    reasons: ['PUBLICATION_COMPLETED_RAW_REASON'],
    risk: 'HIGH',
    dryRun: false,
    attempts: 1,
    createdAt: timestamp,
  }]);
  await adapter.writeCollection('operation-journal', [{
    schemaVersion: 2,
    id: 'journal-raw-123',
    operationId,
    jobId: publishJobId,
    operationType: 'AUTO_SAFE_PUBLISH',
    contractHash: 'contract-hash',
    intendedEffects: [],
    completedEffects: ['publish-product', 'publication-audit', 'outbound-event', 'monitor-job'],
    pendingEffects: [],
    idempotencyKeys: ['secret-idempotency-key-must-not-leak'],
    intendedChecksums: {},
    actualChecksums: {},
    checksums: {},
    reconciliationStatus: 'CONSISTENT',
    createdAt: timestamp,
    updatedAt: timestamp,
  }]);
  await adapter.writeCollection('publication-audit', [{
    schemaVersion: 2,
    id: 'publication-audit-raw-123',
    effectKey: 'effect-raw-123',
    operationId,
    runId: publishJobId,
    jobId: publishJobId,
    productId,
    action: 'published',
    previousState: 'needs_review',
    nextState: 'published',
    reasonCodes: ['PUBLICATION_COMPLETED_RAW_REASON'],
    riskLevel: 'HIGH',
    dryRun: false,
    timestamp,
  }]);
}

async function run() {
  await test('Complete publication trace joins every durable layer using redacted stable references', async () => {
    await seedCompleteTrace();
    const trace = await correlation.getRedactedCorrelationTrace(operationId);
    assert.equal(trace.schemaVersion, 1);
    assert.equal(trace.operationKind, 'AUTO_SAFE_PUBLISH');
    assert.equal(trace.complete, true);
    assert.deepEqual(trace.missingStages, []);
    for (const stage of [
      'JOB',
      'ATTEMPT',
      'PROVIDER',
      'AUTOMATION_AUDIT',
      'OPERATION_JOURNAL',
      'PUBLICATION_AUDIT',
      'MONITOR',
    ]) assert.ok(trace.counts[stage] >= 1, stage);
    const serialized = JSON.stringify(trace);
    for (const sensitive of [
      operationId,
      publishJobId,
      monitorJobId,
      productId,
      'worker-raw-123',
      'payload-secret-must-not-leak',
      'result-secret-must-not-leak',
      'audit-secret-must-not-leak',
      'PUBLICATION_COMPLETED_RAW_REASON',
      'secret-idempotency-key-must-not-leak',
    ]) assert.equal(serialized.includes(sensitive), false, sensitive);
    assert.ok(serialized.includes('"provider":"local"'));
  });

  await test('Incomplete trace reports missing layers without fabricating evidence', async () => {
    const incompleteOperation = 'publish:incomplete-123';
    await adapter.writeCollection('automation-jobs', [
      publishJob({
        id: 'incomplete-job',
        operationId: incompleteOperation,
        status: 'PENDING',
        result: undefined,
        disclosure: undefined,
      }),
    ]);
    for (const collection of [
      'automation-job-attempts',
      'automation-audit',
      'operation-journal',
      'publication-audit',
    ]) await adapter.writeCollection(collection, []);
    const trace = await correlation.getRedactedCorrelationTrace(incompleteOperation);
    assert.equal(trace.complete, false);
    assert.equal(trace.counts.JOB, 1);
    assert.equal(trace.counts.PROVIDER, 0);
    assert.ok(trace.missingStages.includes('ATTEMPT'));
    assert.ok(trace.missingStages.includes('PUBLICATION_AUDIT'));
    assert.ok(trace.missingStages.includes('MONITOR'));
  });

  await test('Trace projection bounds each collection layer', async () => {
    await seedCompleteTrace();
    await adapter.writeCollection('automation-audit', Array.from({ length: 75 }, (_, index) => ({
      schemaVersion: 2,
      id: `audit-${index}`,
      correlationId: operationId,
      operationId,
      jobId: publishJobId,
      operationType: 'AUTO_SAFE_PUBLISH',
      actor: 'worker',
      nextState: 'SUCCEEDED',
      reasons: [],
      risk: 'LOW',
      dryRun: false,
      attempts: 1,
      createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
    })));
    const trace = await correlation.getRedactedCorrelationTrace(operationId);
    assert.equal(trace.counts.AUTOMATION_AUDIT, 50);
    assert.ok(trace.stages.length < 256);
  });

  await test('Correlation identifiers are strictly validated and never interpreted as storage queries', async () => {
    for (const invalid of [
      '',
      '../automation-jobs',
      'operation?token=secret',
      'x'.repeat(161),
    ]) {
      await assert.rejects(
        () => correlation.getRedactedCorrelationTrace(invalid),
        /CORRELATION_ID_INVALID/,
      );
    }
  });

  await test('Authenticated audit route keeps correlation mode behind the existing auth check', async () => {
    const source = fs.readFileSync(
      path.join(root, 'src', 'app', 'api', 'automation', 'audit', 'route.ts'),
      'utf8',
    );
    assert.ok(source.indexOf('await requireAuth(request)') < source.indexOf("get('operationId')"));
    assert.ok(source.includes('getRedactedCorrelationTrace(operationId)'));
    assert.ok(source.includes("code: 'VALIDATION_ERROR'"));
  });

  console.log(`\nM6 integration tests: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, testRoot)}`);
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
