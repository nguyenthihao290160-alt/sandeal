/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
const testRoot = path.join(
  allowedTempRoot,
  `claim-recovery-cpu-${process.pid}-${Date.now()}`,
);
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });

const releaseId = 'c'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '2000';
process.env.SANDEAL_BUILD_MANIFEST_COMMIT = releaseId;
process.env.SANDEAL_BUILD_COMMIT = releaseId;
process.env.SANDEAL_RELEASE_ID = releaseId;
process.env.GIT_COMMIT_SHA = releaseId;
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = releaseId;
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

const COLLECTIONS = [
  'automation-jobs',
  'automation-job-attempts',
  'automation-job-heartbeats',
  'automation-job-projections',
  'automation-job-list-projections-v2',
  'automation-job-health-summary-v1',
  'automation-job-projection-manifest-v1',
  'automation-job-projection-maintenance-v1',
  'automation-job-projection-rebuild-staging-v1',
  'automation-control',
  'automation-audit',
  'runtime-role-leases',
  'runtime-role-conflicts',
  'runtime-role-fencing',
  'automation-settings',
  'business-usage',
  'products',
  'candidate-queue',
];

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

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    bytes: stat.size,
    modifiedAtMs: stat.mtimeMs,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}

function automationJobArtifacts() {
  return fs.readdirSync(testRoot)
      .filter(name => name.startsWith('automation-jobs.json'))
      .sort();
}

function snapshotAutomationJobArtifacts() {
  return Object.fromEntries(automationJobArtifacts().map(name => [
    name,
    snapshotFile(path.join(testRoot, name)),
  ]));
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const fileStorage = require('../src/lib/storage/fileStorageAdapter.ts');
  const store = require('../src/lib/automation/store.ts');

  async function quiet(work) {
    const originalInfo = console.info;
    console.info = () => undefined;
    try {
      return await work();
    } finally {
      console.info = originalInfo;
    }
  }

  async function reset() {
    fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    await Promise.all(COLLECTIONS.map(collection => adapter.writeCollection(collection, [])));
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      workerPaused: false,
      schedulerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
      publishPaused: true,
    }, 'claim-recovery-cpu-test');
  }

  function jobRecord(id, now, overrides = {}) {
    const record = store.createAutomationJobRecord({
      type: 'HEALTH_CHECK',
      payload: { fixture: id },
      idempotencyKey: `claim-recovery-key-${id}`.slice(0, 160),
      operationId: `claim-recovery-operation-${id}`.slice(0, 160),
      requestedBy: 'claim-recovery-cpu-test',
      priority: 50,
      riskLevel: 'LOW',
      dryRun: false,
      scheduledAt: iso(now - 60_000),
    }, now - 60_000);
    return {
      ...record,
      id,
      correlationId: `claim-recovery-correlation-${id}`.slice(0, 160),
      idempotencyKey: `claim-recovery-key-${id}`.slice(0, 160),
      operationId: `claim-recovery-operation-${id}`.slice(0, 160),
      ...overrides,
    };
  }

  function terminalHistory(count, now, prefix) {
    return Array.from({ length: count }, (_, index) => {
      const id = `${prefix}-${String(index).padStart(4, '0')}`;
      const completedAt = iso(now - 30_000 + index);
      return jobRecord(id, now, {
        status: 'SUCCEEDED',
        attemptCount: 1,
        result: { fixture: true, sequence: index },
        startedAt: iso(now - 50_000 + index),
        completedAt,
        updatedAt: completedAt,
        projectionSourceVersion: 1,
        projectionSourceSequence: undefined,
      });
    });
  }

  async function seedRetainedHistory(now, activeJob, prefix) {
    await reset();
    const terminalCount = 2_000 - (activeJob ? 1 : 0);
    const jobs = terminalHistory(terminalCount, now, prefix);
    if (activeJob) {
      activeJob.projectionSourceVersion = 1;
      activeJob.projectionSourceSequence = undefined;
      jobs.push(activeJob);
    }
    await adapter.writeCollection('automation-jobs', jobs);
    const manifest = await quiet(() => store.rebuildAutomationJobReadModelsFromDurable(
        jobs,
        now,
        { maximumCatchUpPasses: 1, sleep: async () => undefined },
    ));
    assert.equal(manifest.durableJobCount, 2_000);
    assert.equal(manifest.currentStateComplete, true);
    assert.equal(manifest.inFlightSyncTokens.length, 0);
    return jobs;
  }

  function monitorClaimTransactions() {
    const phases = [];
    fileStorage.setFileStorageTransactionTestHookForTests(input => {
      if (input.collection === 'automation-jobs'
          && input.operationCategory === 'automation_job_claim_recovery') {
        phases.push(input.phase);
      }
    });
    return {
      phases,
      lockAttempts: () => phases.filter(phase => phase === 'COLLECTION_LOCK_WAIT_STARTED').length,
      commits: () => phases.filter(phase => phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY').length,
    };
  }

  await test('2,000 retained terminal jobs use a read-only empty plan with zero source writes', async () => {
    const now = Date.now();
    await seedRetainedHistory(now, null, 'empty-history');
    const jobsPath = path.join(testRoot, 'automation-jobs.json');
    const manifestPath = path.join(testRoot, 'automation-job-projection-manifest-v1.json');
    const sourceBefore = snapshotFile(jobsPath);
    const manifestBefore = snapshotFile(manifestPath);
    const artifactsBefore = snapshotAutomationJobArtifacts();
    const monitor = monitorClaimTransactions();
    const diagnostics = [];
    const originalInfo = console.info;
    console.info = value => diagnostics.push(String(value));
    const startedAt = performance.now();
    try {
      for (let index = 0; index < 20; index += 1) {
        const claimed = await store.claimAutomationJobs(
            'empty-plan-worker', 1, 60_000, now + index,
        );
        assert.deepEqual(claimed, []);
      }
    } finally {
      console.info = originalInfo;
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    const durationMs = performance.now() - startedAt;
    assert.equal(monitor.lockAttempts(), 0);
    assert.equal(monitor.commits(), 0);
    assert.deepEqual(snapshotFile(jobsPath), sourceBefore);
    assert.deepEqual(snapshotFile(manifestPath), manifestBefore);
    assert.deepEqual(snapshotAutomationJobArtifacts(), artifactsBefore);
    assert.doesNotMatch(
        diagnostics.join('\n'),
        /"collection":"automation-jobs"[^\n]*"status":"COMMITTED"/,
    );
    assert.ok(durationMs < 5_000, `EMPTY_CLAIM_CYCLES_TOO_SLOW:${durationMs.toFixed(1)}ms`);

    // If compact projection evidence is unavailable, the fallback is still a
    // read-only durable scan. It may parse retained history, but it must not
    // enter the source collection write lock or materialize a temp file.
    await adapter.writeCollection('automation-job-projection-manifest-v1', []);
    const fallbackSourceBefore = snapshotFile(jobsPath);
    const fallbackArtifactsBefore = snapshotAutomationJobArtifacts();
    const fallbackMonitor = monitorClaimTransactions();
    try {
      assert.deepEqual(
          await store.claimAutomationJobs('empty-fallback-worker', 1, 60_000, now + 100),
          [],
      );
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(fallbackMonitor.lockAttempts(), 0);
    assert.deepEqual(snapshotFile(jobsPath), fallbackSourceBefore);
    assert.deepEqual(snapshotAutomationJobArtifacts(), fallbackArtifactsBefore);
    console.log(`  empty_claim_cycles=20 duration_ms=${durationMs.toFixed(1)} source_writes=0`);
  });

  await test('one runnable job among 2,000 retained jobs produces one atomic claim commit', async () => {
    const now = Date.now();
    const runnable = jobRecord('single-runnable', now, {
      scheduledAt: iso(now - 1_000),
      createdAt: iso(now - 2_000),
      updatedAt: iso(now - 2_000),
    });
    await seedRetainedHistory(now, runnable, 'single-history');
    const monitor = monitorClaimTransactions();
    let claimed;
    try {
      claimed = await store.claimAutomationJobs('single-claim-worker', 1, 60_000, now);
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, runnable.id);
    assert.equal(monitor.lockAttempts(), 1);
    assert.equal(monitor.commits(), 1);
    const durable = await store.getAutomationJob(runnable.id);
    assert.equal(durable.status, 'RUNNING');
    assert.equal(durable.claimedBy, 'single-claim-worker');
    assert.ok(durable.claimToken);
    assert.equal(durable.attemptCount, 1);
  });

  await test('fresh authoritative heartbeat prevents recovery; true expiry commits recovery once', async () => {
    const now = Date.now();
    const running = jobRecord('expired-running', now, {
      status: 'RUNNING',
      attemptCount: 1,
      claimedBy: 'abandoned-worker',
      claimedAt: iso(now - 20_000),
      claimToken: 'test-claim-recovery-expired-token',
      heartbeatAt: iso(now - 10_000),
      leaseExpiresAt: iso(now - 1_000),
      startedAt: iso(now - 20_000),
      updatedAt: iso(now - 10_000),
    });
    await seedRetainedHistory(now, running, 'expired-history');
    const heartbeat = {
      id: running.id,
      jobId: running.id,
      workerId: running.claimedBy,
      claimToken: running.claimToken,
      status: 'RUNNING',
      attemptCount: running.attemptCount,
      releaseId: running.releaseId,
      heartbeatAt: iso(now),
      leaseExpiresAt: iso(now + 30_000),
    };
    await adapter.writeCollection('automation-job-heartbeats', [heartbeat]);

    let monitor = monitorClaimTransactions();
    try {
      assert.deepEqual(
          await store.claimAutomationJobs('recovery-worker', 1, 60_000, now),
          [],
      );
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(monitor.lockAttempts(), 0);
    assert.equal((await store.getAutomationJob(running.id)).status, 'RUNNING');

    await adapter.writeCollection('automation-job-heartbeats', [{
      ...heartbeat,
      heartbeatAt: iso(now - 2_000),
      leaseExpiresAt: iso(now - 1),
    }]);
    monitor = monitorClaimTransactions();
    try {
      assert.deepEqual(
          await store.claimAutomationJobs('recovery-worker', 1, 60_000, now),
          [],
      );
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(monitor.lockAttempts(), 1);
    assert.equal(monitor.commits(), 1);
    const recovered = await store.getAutomationJob(running.id);
    assert.equal(recovered.status, 'RETRY_SCHEDULED');
    assert.equal(recovered.lastErrorCode, 'LEASE_EXPIRED');
    assert.equal(recovered.attemptCount, 1);
    assert.equal((await adapter.readCollection('automation-job-heartbeats')).length, 0);

    const afterRecovery = monitorClaimTransactions();
    try {
      assert.deepEqual(
          await store.claimAutomationJobs('recovery-worker', 1, 60_000, now + 1),
          [],
      );
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(afterRecovery.lockAttempts(), 0);
    assert.equal((await store.getAutomationJob(running.id)).attemptCount, 1);
  });

  await test('concurrent same-worker claim cycles serialize and never double-claim', async () => {
    const now = Date.now();
    const runnable = jobRecord('concurrent-runnable', now, {
      scheduledAt: iso(now - 1_000),
      createdAt: iso(now - 2_000),
      updatedAt: iso(now - 2_000),
    });
    await seedRetainedHistory(now, runnable, 'concurrent-history');
    const monitor = monitorClaimTransactions();
    let results;
    try {
      results = await Promise.all([
        store.claimAutomationJobs('shared-claim-worker', 1, 60_000, now),
        store.claimAutomationJobs('shared-claim-worker', 1, 60_000, now),
      ]);
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    assert.equal(results.flat().length, 1);
    assert.equal(results.flat()[0].id, runnable.id);
    assert.equal(monitor.lockAttempts(), 1);
    assert.equal(monitor.commits(), 1);
    const durable = await store.getAutomationJob(runnable.id);
    assert.equal(durable.status, 'RUNNING');
    assert.equal(durable.claimedBy, 'shared-claim-worker');
    assert.equal(durable.attemptCount, 1);
    const attempts = await adapter.readCollection('automation-job-attempts');
    assert.equal(attempts.filter(attempt => attempt.jobId === runnable.id).length, 1);
  });

  fileStorage.setFileStorageTransactionTestHookForTests(undefined);
  console.log(`\nClaim/recovery CPU regression: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
