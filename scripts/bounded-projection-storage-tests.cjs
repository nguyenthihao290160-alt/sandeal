/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-bounded-projection-'));
const saved = {
  SANDEAL_DATA_DIR: process.env.SANDEAL_DATA_DIR,
  SANDEAL_STORAGE_DRIVER: process.env.SANDEAL_STORAGE_DRIVER,
  SANDEAL_JOB_PROJECTION_LIMIT: process.env.SANDEAL_JOB_PROJECTION_LIMIT,
};
const present = Object.fromEntries(
  Object.keys(saved).map(key => [key, Object.prototype.hasOwnProperty.call(process.env, key)]),
);

process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '500';
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

function iso(value) {
  return new Date(value).toISOString();
}

function job(index, now, overrides = {}) {
  const createdAt = iso(now - 10_000 + index);
  return {
    schemaVersion: 2,
    policyVersion: 'test-policy',
    handlerVersion: 'test-handler',
    id: `job-${index}`,
    type: 'PROCESS_CANDIDATE',
    status: 'SUCCEEDED',
    payload: {
      candidateId: `candidate-${index}`,
      productId: `product-${index}`,
      token: 'must-not-remain-in-projection-payload',
    },
    result: { candidateStatus: 'completed', productId: `product-${index}` },
    priority: 50,
    idempotencyKey: `bounded-projection-test-${index}`,
    operationId: `operation-${index}`,
    requestedBy: 'scheduler',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 3,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    runnableAt: createdAt,
    runnableReason: 'CREATED_AT',
    claimedAt: iso(now - 9_000 + index),
    startedAt: iso(now - 9_000 + index),
    completedAt: iso(now - 8_000 + index),
    createdAt,
    updatedAt: iso(now - 8_000 + index),
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const health = require('../src/lib/automation/jobHealthSummary.ts');
  const store = require('../src/lib/automation/store.ts');
  const now = Date.now();

  await test('a missing legacy projection is incomplete rather than authoritative empty', async () => {
    const read = await health.readBoundedAutomationJobProjections();
    assert.equal(read.collectionPresent, false);
    assert.equal(read.currentStateComplete, false);
    assert.equal(read.historyComplete, false);
    assert.equal(read.evidenceClassification, 'INCOMPLETE');
    assert.ok(read.reasonCodes.includes('JOB_PROJECTION_COLLECTION_MISSING'));
  });

  await test('a capped projection without a manifest is truncated and never complete', async () => {
    const projections = Array.from({ length: 500 }, (_, index) => (
      store.projectAutomationJobListItem(job(index, now))
    ));
    await adapter.writeCollection('automation-job-list-projections-v2', projections);
    const read = await health.readBoundedAutomationJobProjections();
    assert.equal(read.truncated, true);
    assert.equal(read.currentStateComplete, false);
    assert.equal(read.historyComplete, false);
    assert.equal(read.coverageComplete, false);
    assert.ok(read.retentionBoundary);
  });

  await test('an explicit durable rebuild establishes complete current and sub-cap history evidence', async () => {
    const durable = [
      job(1, now, {
        result: {
          candidateStatus: 'completed',
          productId: 'product-1',
          durableOnly: 'x'.repeat(100_000),
          token: 'must-not-remain-in-projection-result',
        },
      }),
      job(2, now),
      job(3, now),
    ];
    await adapter.writeCollection('automation-jobs', durable);
    const manifest = await store.rebuildAutomationJobReadModelsFromDurable(durable, now);
    assert.equal(manifest.currentStateComplete, true);
    assert.equal(manifest.historyComplete, true);
    assert.equal(manifest.durableJobCount, 3);
    assert.equal(manifest.retainedJobCount, 3);

    const listRead = await health.readBoundedAutomationJobProjections();
    const statusRead = await health.readBoundedAutomationJobStatuses();
    assert.equal(listRead.evidenceClassification, 'COMPLETE');
    assert.equal(statusRead.evidenceClassification, 'COMPLETE');
    assert.equal(listRead.currentStateComplete, true);
    assert.equal(statusRead.historyComplete, true);
    assert.equal(statusRead.items[0].resourceCandidateId.startsWith('candidate-'), true);
    assert.equal(statusRead.items[0].resourceProductIds[0].startsWith('product-'), true);
    const compact = statusRead.items.find(item => item.id === 'job-1');
    assert.ok(compact);
    assert.deepEqual(compact.payload, {});
    assert.equal(JSON.stringify(compact.payload).includes('must-not-remain'), false);
    assert.equal(compact.result.candidateStatus, 'completed');
    assert.equal(compact.result.productId, 'product-1');
    assert.equal(Object.hasOwn(compact.result, 'durableOnly'), false);
    assert.equal(JSON.stringify(compact.result).includes('must-not-remain'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') < 8 * 1024);
  });

  await test('same-count projection corruption is detected by the manifest fingerprint', async () => {
    const statuses = await adapter.readCollection('automation-job-projections');
    statuses[0] = { ...statuses[0], id: 'corrupted-projection-id' };
    await adapter.writeCollection('automation-job-projections', statuses);
    const read = await health.readBoundedAutomationJobStatuses();
    assert.equal(read.currentStateComplete, false);
    assert.ok(read.reasonCodes.includes('JOB_STATUS_PROJECTION_MANIFEST_FINGERPRINT_MISMATCH'));
  });

  await test('a projection at the retention cap never reports complete history', async () => {
    const durable = Array.from({ length: 500 }, (_, index) => job(index, now));
    await adapter.writeCollection('automation-jobs', durable);
    const manifest = await store.rebuildAutomationJobReadModelsFromDurable(durable, now + 1_000);
    const read = await health.readBoundedAutomationJobStatuses();
    assert.equal(manifest.currentStateComplete, true);
    assert.equal(manifest.historyComplete, false);
    assert.equal(read.currentStateComplete, true);
    assert.equal(read.historyComplete, false);
    assert.equal(read.truncated, true);
    assert.equal(read.evidenceClassification, 'INCOMPLETE');
  });

  await test('manifest count mismatch cannot promote an empty projection to current state', async () => {
    await adapter.writeCollection('automation-job-projections', []);
    const read = await health.readBoundedAutomationJobStatuses();
    assert.equal(read.collectionPresent, true);
    assert.equal(read.currentStateComplete, false);
    assert.equal(read.historyComplete, false);
    assert.ok(read.reasonCodes.includes('JOB_STATUS_PROJECTION_MANIFEST_COUNT_MISMATCH'));
  });

  await test('a stale caller snapshot cannot establish an authoritative rebuild manifest', async () => {
    const supplied = [job(600, now)];
    await adapter.writeCollection('automation-jobs', [...supplied, job(601, now)]);
    const manifest = await store.rebuildAutomationJobReadModelsFromDurable(supplied, now + 1_500);
    assert.equal(manifest.baselineEstablished, false);
    assert.equal(manifest.currentStateComplete, false);
    assert.equal(manifest.historyComplete, false);
  });

  await test('pickup latency excludes legacy createdAt and startedAt fallbacks', () => {
    const projection = store.projectAutomationJobListItem(job(700, now, {
      runnableAt: undefined,
      claimedAt: undefined,
      startedAt: iso(now - 1_000),
    }));
    const summary = health.buildAutomationJobHealthSummary([projection], { now });
    assert.equal(summary.pickupLatency.sampleCount, 0);
    assert.equal(summary.pickupLatency.p50Ms, null);
    assert.equal(summary.pickupLatency.insufficientEvidenceCount, 1);
  });

  await test('an older refresh cannot overwrite a newer summary source snapshot', async () => {
    const durable = [job(800, now)];
    await adapter.writeCollection('automation-jobs', durable);
    await store.rebuildAutomationJobReadModelsFromDurable(durable, now + 2_000);
    const newer = await health.refreshAutomationJobHealthSummary(now + 3_000);
    const attemptedOlder = await health.refreshAutomationJobHealthSummary(now + 1_000);
    assert.equal(attemptedOlder.updatedAt, newer.updatedAt);
    assert.equal(attemptedOlder.sourceUpdatedAt, newer.sourceUpdatedAt);
  });

  await test('a stored healthy summary verifies bounded projection coherence on every read', async () => {
    const durable = [job(810, now)];
    await adapter.writeCollection('automation-jobs', durable);
    await store.rebuildAutomationJobReadModelsFromDurable(durable, now + 3_100);
    await health.refreshAutomationJobHealthSummary(now + 3_200);
    const projections = await adapter.readCollection('automation-job-list-projections-v2');
    projections[0] = { ...projections[0], status: 'FAILED' };
    await adapter.writeCollection('automation-job-list-projections-v2', projections);

    const view = await health.getAutomationJobHealthView(now + 3_300);
    assert.equal(view.currentStateComplete, false);
    assert.equal(view.evidenceClassification, 'INCOMPLETE');
    assert.ok(view.reasonCodes.includes('JOB_PROJECTION_MANIFEST_FINGERPRINT_MISMATCH'));
  });

  await test('heartbeat refreshes compact evidence without invalidating the manifest fingerprint', async () => {
    const claimToken = 'claim-token-heartbeat';
    const running = job(820, Date.now(), {
      status: 'RUNNING',
      completedAt: undefined,
      claimedBy: 'worker-heartbeat',
      claimToken,
      heartbeatAt: iso(Date.now() - 1_000),
      leaseExpiresAt: iso(Date.now() + 30_000),
    });
    await adapter.writeCollection('automation-jobs', [running]);
    await adapter.writeCollection('automation-job-heartbeats', [{
      id: 'heartbeat-820',
      jobId: running.id,
      workerId: 'worker-heartbeat',
      claimToken,
      heartbeatAt: running.heartbeatAt,
      leaseExpiresAt: running.leaseExpiresAt,
    }]);
    await store.rebuildAutomationJobReadModelsFromDurable([running], Date.now());
    await health.refreshAutomationJobHealthSummary(Date.now());

    assert.equal(await store.heartbeatAutomationJob(
      running.id,
      'worker-heartbeat',
      60_000,
      claimToken,
    ), true);
    const projection = await health.readBoundedAutomationJobProjections();
    assert.equal(projection.currentStateComplete, true);
    assert.equal(projection.evidenceClassification, 'COMPLETE');
  });

  await test('a stored healthy summary cannot outlive an invalidated projection manifest', async () => {
    const durable = [job(830, now)];
    await adapter.writeCollection('automation-jobs', durable);
    await store.rebuildAutomationJobReadModelsFromDurable(durable, now + 3_900);
    await health.refreshAutomationJobHealthSummary(now + 3_950);
    const token = await health.beginAutomationJobProjectionSync(now + 4_000);
    const view = await health.getAutomationJobHealthView(now + 4_001);
    assert.equal(view.currentStateComplete, false);
    assert.equal(view.evidenceClassification, 'INCOMPLETE');
    assert.ok(view.reasonCodes.includes('JOB_HEALTH_SUMMARY_MANIFEST_MISMATCH'));
    await health.finishAutomationJobProjectionSync(token, {
      success: false,
      inserted: false,
      listProjectionCount: 0,
      statusProjectionCount: 0,
      listProjectionFingerprint: health.automationJobProjectionFingerprint([]),
      statusProjectionFingerprint: health.automationJobProjectionFingerprint([]),
      activeJobCount: 0,
      retainedTerminalCount: 0,
      retentionLimitReached: false,
      currentStateTruncated: false,
      sourceUpdatedAt: null,
      retentionBoundary: null,
    }, now + 4_002);
  });

  await test('normal health reads never parse durable automation-jobs history', async () => {
    await adapter.writeCollection('automation-jobs', Array.from({ length: 1_000 }, (_, index) => (
      job(1_000 + index, now, { payload: { evidence: 'x'.repeat(1_000) } })
    )));
    const fsPromises = require('node:fs').promises;
    const originalReadFile = fsPromises.readFile;
    let durableReads = 0;
    fsPromises.readFile = async function instrumentedReadFile(target, ...args) {
      if (path.basename(String(target)) === 'automation-jobs.json') durableReads += 1;
      return originalReadFile.call(this, target, ...args);
    };
    try {
      await health.getAutomationJobHealthView(now + 3_001);
      assert.equal(durableReads, 0);
    } finally {
      fsPromises.readFile = originalReadFile;
    }
  });

  console.log(`\nBounded projection/storage: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  failed += 1;
  console.error(`FAIL setup\n${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
}).finally(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (present[key]) process.env[key] = value;
    else delete process.env[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
