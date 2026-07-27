/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = path.join(process.cwd(), '.test-tmp', `master-m2-slo-runnable-${process.pid}-${Date.now()}`);
fs.mkdirSync(testRoot, { recursive: true });
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.SLO_RUNNABLE_AT_V2 = 'ACTIVE';
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

function iso(value) {
  return new Date(value).toISOString();
}

function attempt(id, values) {
  return {
    schemaVersion: 1,
    id,
    jobId: `job-${id}`,
    jobType: 'PROCESS_CANDIDATE',
    operationId: `operation-${id}`,
    attemptNumber: 1,
    runnableAt: values.runnableAt,
    runnableReason: values.runnableReason,
    createdAt: values.createdAt,
    scheduledAt: values.scheduledAt,
    retryEligibleAt: values.retryEligibleAt,
    claimedAt: values.claimedAt,
    claimTokenHash: `hash-${id}`,
    workerId: 'fixture-worker',
  };
}

function pendingJob(id, values) {
  return {
    schemaVersion: 2,
    policyVersion: 'automation-policy-v1',
    handlerVersion: 'handler-v1',
    id,
    type: 'PROCESS_CANDIDATE',
    status: 'PENDING',
    payload: {},
    priority: 50,
    idempotencyKey: `key-${id}`,
    operationId: `operation-${id}`,
    requestedBy: 'scheduler',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 0,
    maxAttempts: 3,
    queuedAt: values.createdAt,
    scheduledAt: values.scheduledAt,
    runnableAt: values.runnableAt,
    runnableReason: values.runnableReason,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt || values.createdAt,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const slo = require('../src/lib/automation/sloErrorBudget.ts');
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const windowStart = now - 60_000;

  await test('an immediately runnable job measures pickup from createdAt', async () => {
    const observation = slo.derivePickupLatencyObservation({
      createdAt: iso(now - 10_000),
      scheduledAt: iso(now - 10_000),
      claimedAt: iso(now - 7_500),
    }, windowStart, now);
    assert.equal(observation.runnableReason, 'CREATED_AT');
    assert.equal(observation.latencyMs, 2_500);
  });

  await test('a future-scheduled job excludes time before scheduledAt', async () => {
    const observation = slo.derivePickupLatencyObservation({
      createdAt: iso(now - 120_000),
      scheduledAt: iso(now - 8_000),
      claimedAt: iso(now - 3_000),
    }, windowStart, now);
    assert.equal(observation.runnableReason, 'SCHEDULED_AT');
    assert.equal(observation.latencyMs, 5_000);
  });

  await test('scheduledAt equal to createdAt remains immediately runnable', async () => {
    const timestamp = iso(now - 9_000);
    const observation = slo.derivePickupLatencyObservation({
      createdAt: timestamp,
      scheduledAt: timestamp,
      claimedAt: iso(now - 8_000),
    }, windowStart, now);
    assert.equal(observation.runnableReason, 'CREATED_AT');
    assert.equal(observation.latencyMs, 1_000);
  });

  await test('a retry attempt measures pickup from retry eligibility', async () => {
    const observation = slo.derivePickupLatencyObservation({
      createdAt: iso(now - 300_000),
      scheduledAt: iso(now - 300_000),
      retryEligibleAt: iso(now - 6_000),
      claimedAt: iso(now - 2_000),
    }, windowStart, now);
    assert.equal(observation.runnableReason, 'RETRY_ELIGIBLE_AT');
    assert.equal(observation.retryAttempt, true);
    assert.equal(observation.latencyMs, 4_000);
  });

  await test('a recently completed old job is excluded when runnable and claim events are outside the window', async () => {
    const observation = slo.derivePickupLatencyObservation({
      createdAt: iso(now - 600_000),
      scheduledAt: iso(now - 600_000),
      claimedAt: iso(now - 590_000),
      completedAt: iso(now - 1_000),
    }, windowStart, now);
    assert.equal(observation, null);
  });

  await test('missing or invalid claim timestamps are excluded without zero coercion', async () => {
    assert.equal(slo.derivePickupLatencyObservation({
      createdAt: iso(now - 10_000),
      scheduledAt: iso(now - 10_000),
      claimedAt: 'invalid-timestamp',
    }, windowStart, now), null);
    assert.equal(slo.derivePickupLatencyObservation({
      createdAt: 'invalid-created-at',
      scheduledAt: 'invalid-scheduled-at',
    }, windowStart, now), null);
  });

  await test('negative pickup latency is excluded', async () => {
    assert.equal(slo.derivePickupLatencyObservation({
      createdAt: iso(now - 5_000),
      scheduledAt: iso(now - 5_000),
      claimedAt: iso(now - 6_000),
    }, windowStart, now), null);
  });

  await test('true queue congestion remains visible when claim enters the window', async () => {
    const observation = slo.derivePickupLatencyObservation({
      createdAt: iso(now - 120_000),
      scheduledAt: iso(now - 120_000),
      claimedAt: iso(now - 30_000),
    }, windowStart, now);
    assert.equal(observation.latencyMs, 90_000);
  });

  await test('policy-delayed work measures only its runnable interval', async () => {
    const observation = slo.derivePickupLatencyObservation({
      createdAt: iso(now - 200_000),
      scheduledAt: iso(now - 20_000),
      claimedAt: iso(now - 15_000),
    }, windowStart, now);
    assert.equal(observation.runnableReason, 'SCHEDULED_AT');
    assert.equal(observation.latencyMs, 5_000);
  });

  await test('measurement window boundaries are inclusive and outside events are excluded exactly', async () => {
    assert.equal(slo.derivePickupLatencyObservation({
      createdAt: iso(windowStart),
      scheduledAt: iso(windowStart),
      claimedAt: iso(windowStart),
    }, windowStart, now).latencyMs, 0);
    assert.equal(slo.derivePickupLatencyObservation({
      createdAt: iso(now),
      scheduledAt: iso(now),
      claimedAt: iso(now),
    }, windowStart, now).latencyMs, 0);
    assert.equal(slo.derivePickupLatencyObservation({
      createdAt: iso(windowStart - 2_000),
      scheduledAt: iso(windowStart - 2_000),
      claimedAt: iso(windowStart - 1),
    }, windowStart, now), null);
    assert.equal(slo.derivePickupLatencyObservation({
      createdAt: iso(now + 1),
      scheduledAt: iso(now + 1),
      claimedAt: iso(now + 2),
    }, windowStart, now), null);
  });

  await test('active SLO measurement reports attempt latency, retry latency, and never-claimed queue age separately', async () => {
    await adapter.writeCollection('automation-jobs', [
      pendingJob('pending-runnable', {
        createdAt: iso(now - 40_000),
        scheduledAt: iso(now - 40_000),
        runnableAt: iso(now - 40_000),
        runnableReason: 'CREATED_AT',
      }),
      pendingJob('pending-future', {
        createdAt: iso(now - 40_000),
        scheduledAt: iso(now + 20_000),
        runnableAt: iso(now + 20_000),
        runnableReason: 'SCHEDULED_AT',
      }),
      {
        ...pendingJob('old-completed', {
          createdAt: iso(now - 600_000),
          scheduledAt: iso(now - 600_000),
          runnableAt: iso(now - 600_000),
          runnableReason: 'CREATED_AT',
          updatedAt: iso(now - 1_000),
        }),
        status: 'SUCCEEDED',
        attemptCount: 1,
        claimedAt: iso(now - 590_000),
        completedAt: iso(now - 1_000),
      },
    ]);
    await adapter.writeCollection('automation-job-attempts', [
      attempt('immediate', {
        createdAt: iso(now - 15_000),
        scheduledAt: iso(now - 15_000),
        runnableAt: iso(now - 15_000),
        runnableReason: 'CREATED_AT',
        claimedAt: iso(now - 10_000),
      }),
      attempt('retry', {
        createdAt: iso(now - 600_000),
        scheduledAt: iso(now - 600_000),
        retryEligibleAt: iso(now - 12_000),
        runnableAt: iso(now - 12_000),
        runnableReason: 'RETRY_ELIGIBLE_AT',
        claimedAt: iso(now - 2_000),
      }),
      attempt('invalid', {
        createdAt: iso(now - 5_000),
        scheduledAt: iso(now - 5_000),
        runnableAt: iso(now - 5_000),
        runnableReason: 'CREATED_AT',
        claimedAt: 'invalid',
      }),
    ]);
    for (const collection of [
      'runtime-health',
      'publication-audit',
      'automation-outbound-events',
      'products',
    ]) await adapter.writeCollection(collection, []);

    const measurement = await slo.measureAutomationSlo({
      now,
      windowMs: 60_000,
      minimumSamples: 1,
    });
    assert.equal(measurement.pickupLatencyMode, 'RUNNABLE_AT');
    assert.equal(measurement.pickupLatencyFeatureMode, 'ACTIVE');
    assert.equal(measurement.sourceCounts.pickupAttempts, 2);
    assert.equal(measurement.sourceCounts.retryPickupAttempts, 1);
    assert.equal(measurement.pickupLatencyP50Ms, 5_000);
    assert.equal(measurement.pickupLatencyP95Ms, 10_000);
    assert.equal(measurement.retryPickupLatencyP95Ms, 10_000);
    assert.equal(measurement.pendingQueueCount, 1);
    assert.equal(measurement.pendingQueueAgeMs, 40_000);
    assert.equal(measurement.sourceCounts.neverClaimedPending, 1);
  });

  await test('a missing latest attempt record falls back to committed job context without duplicating an older attempt', async () => {
    const jobId = 'retry-attempt-journal-interrupted';
    await adapter.writeCollection('automation-jobs', [{
      ...pendingJob(jobId, {
        createdAt: iso(now - 600_000),
        scheduledAt: iso(now - 8_000),
        runnableAt: iso(now - 8_000),
        runnableReason: 'RETRY_ELIGIBLE_AT',
        updatedAt: iso(now - 1_000),
      }),
      status: 'SUCCEEDED',
      attemptCount: 2,
      claimedAt: iso(now - 3_000),
      completedAt: iso(now - 1_000),
    }]);
    await adapter.writeCollection('automation-job-attempts', [{
      ...attempt('older-attempt', {
        createdAt: iso(now - 600_000),
        scheduledAt: iso(now - 600_000),
        runnableAt: iso(now - 600_000),
        runnableReason: 'CREATED_AT',
        claimedAt: iso(now - 590_000),
      }),
      jobId,
      attemptNumber: 1,
    }]);
    const measurement = await slo.measureAutomationSlo({
      now,
      windowMs: 60_000,
      minimumSamples: 1,
    });
    assert.equal(measurement.sourceCounts.pickupAttempts, 1);
    assert.equal(measurement.sourceCounts.retryPickupAttempts, 1);
    assert.equal(measurement.pickupLatencyP95Ms, 5_000);
  });

  console.log(`\nM2 runnableAt SLO semantics: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
