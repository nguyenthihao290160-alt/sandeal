/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
const suiteRoot = path.join(
  allowedTempRoot,
  `active-job-history-archive-${process.pid}-${Date.now()}`,
);
if (path.dirname(path.resolve(suiteRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(suiteRoot, { recursive: true });

const releaseId = '8'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
process.env.SANDEAL_JOB_PROJECTION_LIMIT = '2500';
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function directorySnapshot(root, predicate = () => true) {
  return Object.fromEntries(fs.readdirSync(root)
      .filter(predicate)
      .sort()
      .map(name => {
        const target = path.join(root, name);
        const stat = fs.statSync(target);
        return [name, stat.isFile() ? {
          bytes: stat.size,
          hash: sha256(fs.readFileSync(target)),
        } : { directory: true }];
      }));
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const fileStorage = require('../src/lib/storage/fileStorageAdapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const history = require('../src/lib/automation/jobHistoryArchive.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');

  async function scenario(name) {
    const root = path.join(suiteRoot, name);
    if (path.dirname(path.resolve(root)) !== suiteRoot) throw new Error('UNSAFE_SCENARIO_ROOT');
    fs.mkdirSync(root, { recursive: true });
    process.env.SANDEAL_DATA_DIR = root;
    fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    store.setAutomationJobArchiveTestHookForTests(undefined);
    for (const collection of COLLECTIONS) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      workerPaused: false,
      schedulerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
      publishPaused: true,
    }, 'active-job-history-test');
    return root;
  }

  function jobRecord(id, nowMs, overrides = {}) {
    const created = store.createAutomationJobRecord({
      type: 'HEALTH_CHECK',
      payload: { fixture: id },
      idempotencyKey: `archive-key-${id}`.slice(0, 160),
      operationId: `archive-operation-${id}`.slice(0, 160),
      requestedBy: 'active-job-history-test',
      priority: 50,
      riskLevel: 'LOW',
      dryRun: false,
      scheduledAt: iso(nowMs - 60_000),
    }, nowMs - 60_000);
    return {
      ...created,
      id,
      idempotencyKey: `archive-key-${id}`.slice(0, 160),
      operationId: `archive-operation-${id}`.slice(0, 160),
      correlationId: `archive-correlation-${id}`.slice(0, 160),
      ...overrides,
    };
  }

  function terminalJob(id, nowMs, status = 'CANCELLED', overrides = {}) {
    const completedAt = iso(nowMs - 30_000);
    return jobRecord(id, nowMs, {
      status,
      attemptCount: 1,
      startedAt: iso(nowMs - 50_000),
      completedAt,
      cancelledAt: status === 'CANCELLED' ? completedAt : undefined,
      result: { fixture: true, id },
      updatedAt: completedAt,
      ...overrides,
    });
  }

  async function rebuild(jobs, nowMs) {
    return store.rebuildAutomationJobReadModelsFromDurable(
        jobs,
        nowMs,
        { maximumCatchUpPasses: 1, sleep: async () => undefined },
    );
  }

  function monitorFileStorageHistoryAccess() {
    const target = fileStorage.fileStorageAdapter;
    const methodNames = [
      'readCollection',
      'scanCollection',
      'readBoundedCollection',
      'readBoundedCollectionSnapshot',
      'readCollectionPage',
      'writeCollection',
      'runTransaction',
      'runStreamingTransaction',
    ];
    const originals = new Map();
    const calls = [];
    for (const methodName of methodNames) {
      const original = target[methodName];
      originals.set(methodName, original);
      target[methodName] = function monitored(collection, ...args) {
        if (String(collection).startsWith('automation-job-history')) {
          calls.push({ methodName, collection: String(collection) });
        }
        return original.call(this, collection, ...args);
      };
    }
    return {
      calls,
      restore() {
        for (const [methodName, original] of originals) target[methodName] = original;
      },
    };
  }

  await test('2,000 historical jobs migrate losslessly and real/empty claims never read archive segments', async () => {
    const root = await scenario('large-hot-path');
    const now = Date.now();
    const historical = Array.from({ length: 2_000 }, (_, index) => terminalJob(
        `history-${String(index).padStart(4, '0')}`,
        now - index,
    ));
    const runnable = jobRecord('history-runnable', now, {
      scheduledAt: iso(now - 5_000),
      createdAt: iso(now - 10_000),
      updatedAt: iso(now - 10_000),
    });
    const source = [...historical, runnable];
    await adapter.writeCollection('automation-jobs', source);
    const projectionManifest = await rebuild(source, now);
    assert.equal(projectionManifest.durableJobCount, 2_001);
    assert.equal(projectionManifest.activeJobCount, 1);
    const protectedCollections = {
      'automation-job-heartbeats': [{
        id: historical[0].id,
        jobId: historical[0].id,
        workerId: 'historical-worker',
        claimToken: 'historical-claim-token',
        status: 'RUNNING',
        heartbeatAt: iso(now),
        leaseExpiresAt: iso(now + 60_000),
      }],
      'automation-audit': [{
        id: 'history-audit-sentinel',
        operationId: historical[0].operationId,
        jobId: historical[0].id,
        marker: 'must-remain-byte-equivalent',
      }],
      'runtime-role-leases': [{
        schemaVersion: 3,
        id: 'WORKER',
        role: 'WORKER',
        ownerId: 'released-history-owner',
        instanceId: 'released-history-instance',
        holderId: 'released-history-instance',
        releaseId,
        status: 'RELEASED',
        acquiredAt: iso(now - 120_000),
        startedAt: iso(now - 120_000),
        heartbeatAt: iso(now - 60_000),
        expiresAt: iso(now - 30_000),
        leaseExpiresAt: iso(now - 30_000),
        fencingToken: 1,
        takeoverCount: 0,
        updatedAt: iso(now - 30_000),
      }],
      'runtime-role-fencing': [{ id: 'history-fence-sentinel', marker: 'must-remain-byte-equivalent' }],
    };
    for (const [collection, items] of Object.entries(protectedCollections)) {
      await adapter.writeCollection(collection, items);
    }

    const beforeDryRun = directorySnapshot(root);
    const preview = await store.compactAutomationJobs({
      nowMs: now,
      retentionDays: 0,
      minimumTerminalJobs: 0,
      batchSize: 250,
      maximumBatches: 10,
    });
    assert.equal(preview.apply, false);
    assert.equal(preview.eligibleTerminalJobs, 2_000);
    assert.equal(preview.removableJobs, 2_000);
    assert.equal(preview.backupRef, undefined);
    assert.deepEqual(directorySnapshot(root), beforeDryRun);

    const migrationStarted = performance.now();
    const applied = await store.compactAutomationJobs({
      apply: true,
      nowMs: now,
      retentionDays: 0,
      minimumTerminalJobs: 0,
      batchSize: 250,
      maximumBatches: 10,
      actor: 'active-job-history-test',
    });
    const migrationMs = performance.now() - migrationStarted;
    assert.equal(applied.removableJobs, 2_000);
    assert.equal(applied.remainingEligibleJobs, 0);
    assert.equal(applied.archiveVerified, true);
    assert.equal(applied.recordCountsVerified, true);
    assert.equal(applied.backupVerified, true);
    assert.equal(applied.backupFingerprint, applied.sourceFingerprintBefore);
    assert.equal(applied.selectedFingerprint, history.automationJobHistoryBatchFingerprint(historical));
    assert.ok(applied.backupRef && fs.existsSync(applied.backupRef));
    assert.equal(JSON.parse(fs.readFileSync(applied.backupRef, 'utf8')).length, 2_001);
    for (const [collection, items] of Object.entries(protectedCollections)) {
      assert.deepEqual(await adapter.readCollection(collection), items);
    }
    assert.equal((await adapter.readCollection('automation-jobs')).length, 1);
    assert.equal((await adapter.readCollection('automation-jobs'))[0].id, runnable.id);
    const archiveManifest = await history.readAutomationJobHistoryManifest();
    assert.equal(archiveManifest.archivedVersions, 2_000);
    assert.equal(archiveManifest.statusCounts.CANCELLED, 2_000);
    assert.ok(archiveManifest.segments.length <= history.AUTOMATION_JOB_HISTORY_LIMITS.shardCount);
    assert.equal((await store.getAllAutomationJobs()).length, 2_001);
    assert.equal((await store.getAutomationJob(historical[1_234].id)).status, 'CANCELLED');

    const secondApply = await store.compactAutomationJobs({
      apply: true,
      nowMs: now,
      retentionDays: 0,
      minimumTerminalJobs: 0,
      batchSize: 250,
      maximumBatches: 10,
    });
    assert.equal(secondApply.removableJobs, 0);
    assert.equal(secondApply.backupRef, undefined);
    assert.equal(secondApply.archivedVersionsAfter, 2_000);

    const historyBeforeClaim = directorySnapshot(
        root,
        name => name.startsWith('automation-job-history'),
    );
    const storageMonitor = monitorFileStorageHistoryAccess();
    const claimPhases = [];
    fileStorage.setFileStorageTransactionTestHookForTests(input => {
      if (input.collection === 'automation-jobs'
          && input.operationCategory === 'automation_job_claim_recovery') claimPhases.push(input.phase);
    });
    let claimed;
    const claimStarted = performance.now();
    try {
      claimed = await store.claimAutomationJobs('archive-hot-worker', 1, 60_000, now);
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
      storageMonitor.restore();
    }
    const claimMs = performance.now() - claimStarted;
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, runnable.id);
    assert.equal(claimed[0].claimedBy, 'archive-hot-worker');
    assert.ok(claimed[0].claimToken);
    assert.equal(claimed[0].attemptCount, 1);
    assert.equal(claimed[0].releaseId, releaseId);
    assert.equal(claimPhases.filter(phase => phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY').length, 1);
    assert.deepEqual(storageMonitor.calls, []);
    assert.deepEqual(directorySnapshot(
        root,
        name => name.startsWith('automation-job-history'),
    ), historyBeforeClaim);
    assert.ok(claimMs < 3_000, `ACTIVE_CLAIM_TOO_SLOW:${claimMs.toFixed(1)}ms`);

    const completed = await store.completeAutomationJob(
        claimed[0].id,
        'archive-hot-worker',
        { complete: true },
        {
          claimToken: claimed[0].claimToken,
          attemptCount: claimed[0].attemptCount,
          releaseId: claimed[0].releaseId,
        },
    );
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal((await adapter.readCollection('automation-jobs')).length, 0);
    assert.equal((await store.getAutomationJob(runnable.id)).status, 'SUCCEEDED');
    const duplicate = await store.createAutomationJob({
      type: runnable.type,
      payload: { duplicate: true },
      idempotencyKey: runnable.idempotencyKey,
      operationId: 'archive-duplicate-operation',
      requestedBy: 'active-job-history-test',
      riskLevel: 'LOW',
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.code, 'ALREADY_PROCESSED');
    assert.equal(duplicate.job.id, runnable.id);

    const emptyHistoryBefore = directorySnapshot(root, name => name.startsWith('automation-job-history'));
    const emptyActiveAndProjectionBefore = directorySnapshot(root, name => (
      name.startsWith('automation-jobs')
      || name.startsWith('automation-job-projection-')
      || name.startsWith('automation-job-list-projections')
    ));
    const emptyMonitor = monitorFileStorageHistoryAccess();
    const emptyPhases = [];
    fileStorage.setFileStorageTransactionTestHookForTests(input => {
      if (input.collection === 'automation-jobs'
          && input.operationCategory === 'automation_job_claim_recovery') emptyPhases.push(input.phase);
    });
    const emptyStarted = performance.now();
    try {
      for (let index = 0; index < 20; index += 1) {
        assert.deepEqual(
            await store.claimAutomationJobs('archive-empty-worker', 1, 60_000, now + index + 1),
            [],
        );
      }
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
      emptyMonitor.restore();
    }
    const emptyMs = performance.now() - emptyStarted;
    assert.equal(emptyPhases.filter(phase => phase === 'COLLECTION_LOCK_WAIT_STARTED').length, 0);
    assert.deepEqual(emptyMonitor.calls, []);
    assert.deepEqual(directorySnapshot(root, name => name.startsWith('automation-job-history')), emptyHistoryBefore);
    assert.deepEqual(directorySnapshot(root, name => (
      name.startsWith('automation-jobs')
      || name.startsWith('automation-job-projection-')
      || name.startsWith('automation-job-list-projections')
    )), emptyActiveAndProjectionBefore);
    assert.ok(emptyMs < 3_000, `EMPTY_ACTIVE_CYCLES_TOO_SLOW:${emptyMs.toFixed(1)}ms`);

    const expired = jobRecord('history-expired-running', now, {
      status: 'RUNNING',
      attemptCount: 1,
      maxAttempts: 3,
      claimedBy: 'history-abandoned-worker',
      claimToken: 'history-abandoned-claim',
      claimedAt: iso(now - 90_000),
      heartbeatAt: iso(now - 90_000),
      leaseExpiresAt: iso(now - 60_000),
      releaseId,
      updatedAt: iso(now - 60_000),
    });
    await adapter.writeCollection('automation-jobs', [expired]);
    await store.rebuildAutomationJobReadModelsFromDurable(
        null,
        now,
        { maximumCatchUpPasses: 1, sleep: async () => undefined },
    );
    const recoveryMonitor = monitorFileStorageHistoryAccess();
    const recoveryPhases = [];
    fileStorage.setFileStorageTransactionTestHookForTests(input => {
      if (input.collection === 'automation-jobs'
          && input.operationCategory === 'automation_job_claim_recovery') recoveryPhases.push(input.phase);
    });
    try {
      assert.deepEqual(
          await store.claimAutomationJobs('archive-recovery-worker', 1, 60_000, now),
          [],
      );
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
      recoveryMonitor.restore();
    }
    const recovered = (await adapter.readCollection('automation-jobs'))[0];
    assert.equal(recovered.id, expired.id);
    assert.equal(recovered.status, 'RETRY_SCHEDULED');
    assert.equal(recovered.attemptCount, 1);
    assert.equal(recoveryPhases.filter(phase => phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY').length, 1);
    assert.deepEqual(recoveryMonitor.calls, []);
    console.log(`  migration_ms=${migrationMs.toFixed(1)} claim_ms=${claimMs.toFixed(1)} empty_cycles_ms=${emptyMs.toFixed(1)}`);
  });

  await test('migration apply refuses a fresh Worker or Scheduler role lease without mutating jobs', async () => {
    await scenario('migration-role-guard');
    const now = Date.now();
    const terminal = terminalJob('migration-role-guard-terminal', now, 'FAILED');
    await adapter.writeCollection('automation-jobs', [terminal]);
    const acquired = await roles.acquireRuntimeRole({
      role: 'WORKER',
      ownerId: 'migration-role-guard-owner',
      instanceId: 'migration-role-guard-instance',
      releaseId,
      leaseMs: 60_000,
      now,
    });
    assert.equal(acquired.acquired, true);
    const jobsBefore = await adapter.readCollection('automation-jobs');
    const leasesBefore = await adapter.readCollection('runtime-role-leases');
    await assert.rejects(
        () => store.compactAutomationJobs({
          apply: true,
          nowMs: now + 1,
          retentionDays: 0,
          minimumTerminalJobs: 0,
        }),
        /AUTOMATION_JOB_COMPACTION_ROLE_ACTIVE:WORKER/,
    );
    assert.deepEqual(await adapter.readCollection('automation-jobs'), jobsBefore);
    assert.deepEqual(await adapter.readCollection('runtime-role-leases'), leasesBefore);
    assert.equal(await history.readAutomationJobHistoryManifest(), null);
    await roles.releaseRuntimeRole('WORKER', acquired.ownership, now + 2);
  });

  await test('terminal archival is exactly-once and crash before archive commit leaves active source intact', async () => {
    const root = await scenario('crash-before-archive');
    const created = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { crash: 'before' },
      idempotencyKey: 'archive-crash-before-key',
      operationId: 'archive-crash-before-operation',
      requestedBy: 'active-job-history-test',
      riskLevel: 'LOW',
    });
    const [claimed] = await store.claimAutomationJobs('archive-crash-before-worker', 1);
    fileStorage.setFileStorageTransactionTestHookForTests(input => {
      if (input.collection.startsWith(history.AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX)
          && input.phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY') {
        throw new Error('TEST_CRASH_BEFORE_ARCHIVE_COMMIT');
      }
    });
    try {
      assert.ok(await store.completeAutomationJob(
          created.job.id,
          'archive-crash-before-worker',
          { terminal: true },
          {
            claimToken: claimed.claimToken,
            attemptCount: claimed.attemptCount,
            releaseId: claimed.releaseId,
          },
      ));
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    }
    const active = await adapter.readCollection('automation-jobs');
    assert.equal(active.length, 1);
    assert.equal(active[0].status, 'SUCCEEDED');
    assert.equal(await history.readAutomationJobHistoryManifest(), null);
    assert.equal(fs.readdirSync(root).some(name => name.includes('.tmp.')), false);

    const resumed = await store.archiveTerminalAutomationJob(created.job.id);
    assert.equal(resumed.status, 'ARCHIVED_AND_REMOVED');
    assert.equal((await adapter.readCollection('automation-jobs')).length, 0);
    const manifest = await history.readAutomationJobHistoryManifest();
    assert.equal(manifest.archivedVersions, 1);
    const repeated = await store.archiveTerminalAutomationJob(created.job.id);
    assert.equal(repeated.status, 'ALREADY_ARCHIVED');
    assert.equal((await history.readAutomationJobHistoryManifest()).archivedVersions, 1);
  });

  await test('crash after archive durability resumes removal without duplicate history', async () => {
    await scenario('crash-after-archive');
    const created = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { crash: 'after' },
      idempotencyKey: 'archive-crash-after-key',
      operationId: 'archive-crash-after-operation',
      requestedBy: 'active-job-history-test',
      riskLevel: 'LOW',
    });
    const [claimed] = await store.claimAutomationJobs('archive-crash-after-worker', 1);
    store.setAutomationJobArchiveTestHookForTests(input => {
      if (input.phase === 'ARCHIVE_DURABLE_BEFORE_ACTIVE_REMOVAL') {
        throw new Error('TEST_CRASH_AFTER_ARCHIVE_COMMIT');
      }
    });
    try {
      assert.ok(await store.completeAutomationJob(
          created.job.id,
          'archive-crash-after-worker',
          { terminal: true },
          {
            claimToken: claimed.claimToken,
            attemptCount: claimed.attemptCount,
            releaseId: claimed.releaseId,
          },
      ));
    } finally {
      store.setAutomationJobArchiveTestHookForTests(undefined);
    }
    assert.equal((await adapter.readCollection('automation-jobs')).length, 1);
    assert.equal((await history.readAutomationJobHistoryManifest()).archivedVersions, 1);
    const resumed = await store.archiveTerminalAutomationJob(created.job.id);
    assert.equal(resumed.activeRemoved, true);
    assert.equal((await history.readAutomationJobHistoryManifest()).archivedVersions, 1);
    assert.equal((await store.getAutomationJob(created.job.id)).result.terminal, true);
  });

  await test('malformed archive fails closed and never removes the active terminal record', async () => {
    const root = await scenario('malformed-archive');
    const now = Date.now();
    const terminal = terminalJob('malformed-terminal', now, 'FAILED', {
      maxAttempts: 1,
      lastErrorCode: 'TEST_FAILURE',
    });
    await adapter.writeCollection('automation-jobs', [terminal]);
    const collection = history.automationJobHistorySegmentCollection(terminal.id);
    await adapter.writeCollection(collection, [{ id: 'malformed-record' }]);
    await assert.rejects(
        () => store.archiveTerminalAutomationJob(terminal.id),
        /AUTOMATION_JOB_HISTORY_RECORD_INVALID/,
    );
    assert.equal((await adapter.readCollection('automation-jobs'))[0].id, terminal.id);
    assert.equal(fs.readdirSync(root).some(name => name.startsWith(`${collection}.json.tmp.`)), false);
  });

  await test('stale Worker fencing cannot archive or remove a terminal record after role takeover', async () => {
    await scenario('stale-worker');
    const base = Date.now();
    const old = await roles.acquireRuntimeRole({
      role: 'WORKER',
      ownerId: 'archive-old-owner',
      instanceId: 'archive-old-instance',
      releaseId,
      leaseMs: 5_000,
      now: base,
    });
    assert.equal(old.acquired, true);
    const created = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { stale: true },
      idempotencyKey: 'archive-stale-worker-key',
      operationId: 'archive-stale-worker-operation',
      requestedBy: 'active-job-history-test',
      riskLevel: 'LOW',
    });
    const workerId = old.ownership.instanceId;
    const [claimed] = await store.claimAutomationJobs(
        workerId,
        1,
        30_000,
        Date.now() + 1_000,
        old.ownership,
    );
    assert.ok(claimed);
    process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'false';
    try {
      assert.ok(await store.completeAutomationJob(
          created.job.id,
          workerId,
          { terminal: true },
          {
            claimToken: claimed.claimToken,
            attemptCount: claimed.attemptCount,
            releaseId: claimed.releaseId,
            ownership: old.ownership,
          },
      ));
    } finally {
      process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
    }
    const replacement = await roles.acquireRuntimeRole({
      role: 'WORKER',
      ownerId: 'archive-new-owner',
      instanceId: 'archive-new-instance',
      releaseId,
      leaseMs: 60_000,
      now: base + 6_000,
    });
    assert.equal(replacement.event, 'TAKEN_OVER');
    await assert.rejects(
        () => store.archiveTerminalAutomationJob(created.job.id, { ownership: old.ownership }),
        /WORKER_FENCING_REJECTED/,
    );
    assert.equal((await adapter.readCollection('automation-jobs')).length, 1);
    assert.equal(await history.readAutomationJobHistoryManifest(), null);
    const recovered = await store.archiveTerminalAutomationJob(
        created.job.id,
        { ownership: replacement.ownership },
    );
    assert.equal(recovered.status, 'ARCHIVED_AND_REMOVED');
    assert.equal(await roles.isRuntimeRoleOwner('WORKER', replacement.ownership), true);
    await roles.releaseRuntimeRole('WORKER', replacement.ownership);
  });

  await test('workflow-linked terminal children remain active until the parent graph is terminal', async () => {
    await scenario('workflow-protection');
    const now = Date.now();
    const parent = jobRecord('archive-parent', now, {
      type: 'AUTO_PILOT',
      status: 'WAITING_CHILDREN',
      checkpoint: {
        version: 1,
        completedSteps: [],
        pendingSteps: ['child'],
        outputs: {},
        executionModes: [],
        inputHash: 'workflow-input',
        updatedAt: iso(now),
      },
    });
    const child = terminalJob('archive-child', now, 'SUCCEEDED', {
      parentJobId: parent.id,
      idempotencyKey: 'archive-child-success-key',
    });
    await adapter.writeCollection('automation-jobs', [parent, child]);
    await rebuild([parent, child], now);
    const childArchive = await store.archiveTerminalAutomationJob(child.id);
    assert.equal(childArchive.status, 'ARCHIVED_RETAINED_FOR_WORKFLOW');
    assert.equal((await adapter.readCollection('automation-jobs')).length, 2);
    const completedParent = await store.completeAutomationParentJob(
        parent.id,
        'active-job-history-test',
        { total: 1, byStatus: { SUCCEEDED: 1 } },
    );
    assert.equal(completedParent.status, 'SUCCEEDED');
    assert.equal((await adapter.readCollection('automation-jobs')).length, 0);
    assert.equal((await store.getAutomationJob(parent.id)).status, 'SUCCEEDED');
    assert.equal((await store.getAutomationJob(child.id)).status, 'SUCCEEDED');
  });

  await test('archived details, bounded lists, correlation lookup, and projection rebuild remain compatible', async () => {
    await scenario('read-compatibility');
    const created = await store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { historyRead: true },
      idempotencyKey: 'archive-history-read-key',
      operationId: 'archive-history-read-operation',
      requestedBy: 'active-job-history-test',
      riskLevel: 'LOW',
    });
    const [claimed] = await store.claimAutomationJobs('archive-history-read-worker', 1);
    await store.completeAutomationJob(
        created.job.id,
        'archive-history-read-worker',
        { provider: 'local', complete: true },
        {
          claimToken: claimed.claimToken,
          attemptCount: claimed.attemptCount,
          releaseId: claimed.releaseId,
        },
    );
    assert.equal((await adapter.readCollection('automation-jobs')).length, 0);
    const detail = await store.getAutomationJob(created.job.id);
    assert.equal(detail.result.complete, true);
    const list = await store.listAutomationJobs({ page: 1, pageSize: 20 });
    assert.ok(list.items.some(item => item.id === created.job.id && item.status === 'SUCCEEDED'));
    const correlated = await store.findAutomationJobsForCorrelation({
      operationId: created.job.operationId,
      limit: 20,
    });
    assert.equal(correlated.length, 1);
    assert.equal(correlated[0].id, created.job.id);
    const rebuilt = await store.rebuildAutomationJobReadModelsFromDurable(
        null,
        Date.now(),
        { maximumCatchUpPasses: 1, sleep: async () => undefined },
    );
    assert.equal(rebuilt.durableJobCount, 1);
    assert.equal(rebuilt.activeJobCount, 0);
    assert.equal((await store.getAllAutomationJobs()).length, 1);
  });

  await test('concurrent cross-worker claims remain atomic after the active/history split', async () => {
    await scenario('concurrent-claim');
    const now = Date.now();
    const runnable = jobRecord('archive-concurrent-runnable', now, {
      scheduledAt: iso(now - 1_000),
      createdAt: iso(now - 2_000),
      updatedAt: iso(now - 2_000),
    });
    await adapter.writeCollection('automation-jobs', [runnable]);
    await rebuild([runnable], now);
    const results = await Promise.all([
      store.claimAutomationJobs('archive-concurrent-a', 1, 60_000, now),
      store.claimAutomationJobs('archive-concurrent-b', 1, 60_000, now),
    ]);
    assert.equal(results.flat().length, 1);
    assert.equal(results.flat()[0].id, runnable.id);
    const durable = await adapter.readCollection('automation-jobs');
    assert.equal(durable.length, 1);
    assert.equal(durable[0].status, 'RUNNING');
    assert.equal(durable[0].attemptCount, 1);
  });

  fileStorage.setFileStorageTransactionTestHookForTests(undefined);
  store.setAutomationJobArchiveTestHookForTests(undefined);
  process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
  console.log(`\nActive job history archive regression: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), suiteRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
