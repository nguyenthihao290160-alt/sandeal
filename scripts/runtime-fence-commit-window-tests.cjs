/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
const testRoot = path.join(allowedTempRoot, `runtime-fence-commit-window-${process.pid}-${Date.now()}`);
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });

const releaseId = '6'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within(promise, milliseconds, reason) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeChildEnvironment(overrides) {
  const environment = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    NODE_ENV: 'production',
    SANDEAL_STORAGE_DRIVER: 'file',
    ALLOW_PAID_AI: 'false',
    ...overrides,
  };
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const fileStorage = require('../src/lib/storage/fileStorageAdapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');

  async function reset() {
    fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    for (const collection of COLLECTIONS) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      workerPaused: false,
      schedulerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
      publishPaused: true,
    }, 'runtime-fence-test');
  }

  async function acquireWorker(suffix, options = {}) {
    const workerId = `runtime-fence-worker-${suffix}`;
    const role = await roles.acquireRuntimeRole({
      role: 'WORKER',
      ownerId: `runtime-fence-owner-${suffix}`,
      instanceId: workerId,
      releaseId,
      leaseMs: options.leaseMs || 60_000,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    assert.equal(role.acquired, true);
    assert.ok(role.ownership);
    return { workerId, role };
  }

  async function createJob(suffix) {
    return store.createAutomationJob({
      type: 'HEALTH_CHECK',
      payload: { fixture: suffix },
      idempotencyKey: `runtime-fence:${suffix}`,
      operationId: `runtime-fence:${suffix}`,
      requestedBy: 'runtime-fence-test',
      priority: 50,
      riskLevel: 'LOW',
      dryRun: false,
    });
  }

  function claimGuard(job, ownership) {
    return {
      claimToken: job.claimToken,
      attemptCount: job.attemptCount,
      releaseId: job.releaseId,
      ownership,
    };
  }

  function temporaryJobFiles() {
    return fs.readdirSync(testRoot)
        .filter(name => name.startsWith('automation-jobs.json.tmp.'));
  }

  await test('FileStorage commit guard owns the visible rename and durable sync window', async () => {
    await reset();
    await adapter.writeCollection('commit-window-fixture', [{ id: 'item', value: 1 }]);
    const order = [];
    await adapter.runTransaction('commit-window-fixture', items => {
      items[0].value = 2;
      return items;
    }, {
      operationCategory: 'test_commit_window',
      beforeCommit: () => { order.push('prepared'); },
      withCommitGuard: async (commit, context) => {
        context.authorityAcquired();
        order.push('authority-acquired');
        assert.equal((await adapter.readCollection('commit-window-fixture'))[0].value, 1);
        await commit();
        assert.equal((await adapter.readCollection('commit-window-fixture'))[0].value, 2);
        order.push('authority-released');
      },
    });
    assert.deepEqual(order, ['prepared', 'authority-acquired', 'authority-released']);
  });

  await test('large retained history mutation does not block authoritative lease renewal', async () => {
    await reset();
    const { workerId, role } = await acquireWorker('large-history');
    try {
      const created = await createJob('large-history');
      const seed = (await adapter.readCollection('automation-jobs'))[0];
      const completedAt = new Date(Date.now() - 60_000).toISOString();
      const history = Array.from({ length: 1_999 }, (_, index) => ({
        ...structuredClone(seed),
        id: `runtime-fence-history-${String(index).padStart(4, '0')}`,
        idempotencyKey: `runtime-fence-history-key-${index}`,
        operationId: `runtime-fence-history-operation-${index}`,
        status: 'SUCCEEDED',
        attemptCount: 1,
        result: { fixture: true, index },
        completedAt,
        updatedAt: completedAt,
        claimedAt: undefined,
        claimedBy: undefined,
        claimToken: undefined,
        workerOwnerId: undefined,
        workerInstanceId: undefined,
        workerFencingToken: undefined,
        leaseExpiresAt: undefined,
      }));
      await adapter.writeCollection('automation-jobs', [...history, seed]);
      const [claimed] = await store.claimAutomationJobs(
          workerId, 1, 30_000, Date.now(), role.ownership,
      );
      assert.equal(claimed.id, created.job.id);
      const beforeVersion = claimed.projectionSourceVersion || 0;
      const prepared = deferred();
      const releasePreparation = deferred();
      let paused = false;
      fileStorage.setFileStorageTransactionTestHookForTests(async input => {
        if (!paused
            && input.collection === 'automation-jobs'
            && input.operationCategory === 'automation_job_execution_update'
            && input.phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY') {
          paused = true;
          prepared.resolve();
          await releasePreparation.promise;
        }
      });

      const mutation = store.updateAutomationJobExecution(
          claimed.id,
          workerId,
          { progress: { processed: 1, total: 2, succeeded: 1, skipped: 0, failed: 0, percentage: 50, updatedAt: new Date().toISOString() } },
          claimGuard(claimed, role.ownership),
      );
      await within(prepared.promise, 10_000, 'LARGE_MUTATION_DID_NOT_REACH_PREPARED_BOUNDARY');
      assert.equal(temporaryJobFiles().length, 1);

      const renewalStartedAt = Date.now();
      const renewalDiagnostics = [];
      const originalLog = console.log;
      const originalError = console.error;
      let firstRenewal;
      let secondRenewal;
      try {
        console.log = value => { renewalDiagnostics.push(String(value)); };
        console.error = value => { renewalDiagnostics.push(String(value)); };
        firstRenewal = await within(store.renewAutomationJobClaimLease(
            claimed.id, workerId, 30_000, claimGuard(claimed, role.ownership), Date.now(),
        ), 2_000, 'LEASE_RENEWAL_BLOCKED_BY_SOURCE_PREPARATION');
        secondRenewal = await within(store.renewAutomationJobClaimLease(
            claimed.id, workerId, 30_000, claimGuard(claimed, role.ownership), Date.now(),
        ), 2_000, 'SECOND_LEASE_RENEWAL_BLOCKED_BY_SOURCE_PREPARATION');
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
      assert.equal(firstRenewal.renewed, true);
      assert.equal(secondRenewal.renewed, true);
      assert.ok(Date.now() - renewalStartedAt < 2_000);
      assert.doesNotMatch(
          renewalDiagnostics.join('\n'),
          /ROLE_FENCE_LOCK_TIMEOUT|JOB_LEASE_RENEWAL_STORAGE_FAILURE|job_ownership_lost/,
      );

      releasePreparation.resolve();
      const updated = await within(mutation, 10_000, 'LARGE_MUTATION_DID_NOT_COMMIT');
      assert.ok(updated);
      assert.equal(updated.progress.percentage, 50);
      assert.equal(updated.projectionSourceVersion, beforeVersion + 1);
      const durable = await store.getAutomationJob(claimed.id);
      assert.equal(durable.status, 'RUNNING');
      assert.equal(durable.claimToken, claimed.claimToken);
      const heartbeat = (await adapter.readCollectionPage('automation-job-heartbeats', {
        page: 1, pageSize: 1, filters: { jobId: claimed.id },
      })).items[0];
      assert.equal(heartbeat.claimToken, claimed.claimToken);
      assert.equal(heartbeat.workerFencingToken, role.ownership.fencingToken);
      assert.equal(temporaryJobFiles().length, 0);
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
      await roles.releaseRuntimeRole('WORKER', role.ownership).catch(() => false);
    }
  });

  await test('runtime takeover immediately before commit rejects stale completion and cleans temp state', async () => {
    await reset();
    const base = Date.now();
    const old = await acquireWorker('takeover-old', { leaseMs: 5_000, now: base });
    const created = await createJob('takeover');
    const [claimed] = await store.claimAutomationJobs(
        old.workerId, 1, 30_000, Date.now(), old.role.ownership,
    );
    assert.equal(claimed.id, created.job.id);

    const prepared = deferred();
    const releasePreparation = deferred();
    let paused = false;
    fileStorage.setFileStorageTransactionTestHookForTests(async input => {
      if (!paused
          && input.collection === 'automation-jobs'
          && input.operationCategory === 'automation_job_complete'
          && input.phase === 'PREPARED_BEFORE_COMMIT_AUTHORITY') {
        paused = true;
        prepared.resolve();
        await releasePreparation.promise;
      }
    });
    const staleCompletion = store.completeAutomationJob(
        claimed.id,
        old.workerId,
        { stale: true },
        claimGuard(claimed, old.role.ownership),
    );
    await within(prepared.promise, 5_000, 'STALE_COMPLETION_DID_NOT_REACH_COMMIT_BOUNDARY');
    assert.equal(temporaryJobFiles().length, 1);

    const replacement = await roles.acquireRuntimeRole({
      role: 'WORKER',
      ownerId: 'runtime-fence-owner-takeover-new',
      instanceId: 'runtime-fence-worker-takeover-new',
      releaseId,
      leaseMs: 60_000,
      now: base + 6_000,
    });
    assert.equal(replacement.event, 'TAKEN_OVER');
    releasePreparation.resolve();
    await assert.rejects(
        () => within(staleCompletion, 10_000, 'STALE_COMPLETION_STUCK'),
        /WORKER_FENCING_REJECTED/,
    );
    fileStorage.setFileStorageTransactionTestHookForTests(undefined);

    const durable = await store.getAutomationJob(claimed.id);
    assert.equal(durable.status, 'RUNNING');
    assert.equal(durable.result && durable.result.stale, undefined);
    assert.equal(durable.claimToken, claimed.claimToken);
    assert.equal(temporaryJobFiles().length, 0);
    assert.equal(await roles.isRuntimeRoleOwner('WORKER', replacement.ownership), true);
    await roles.releaseRuntimeRole('WORKER', replacement.ownership);
  });

  await test('job mutation waiting for automation-jobs lock never owns the Worker role fence', async () => {
    await reset();
    const { workerId, role } = await acquireWorker('jobs-lock');
    try {
      const created = await createJob('jobs-lock');
      const [claimed] = await store.claimAutomationJobs(
          workerId, 1, 10_000, Date.now(), role.ownership,
      );
      assert.equal(claimed.id, created.job.id);

      const holderLocked = deferred();
      const releaseHolder = deferred();
      const holder = adapter.runStreamingTransaction('automation-jobs', () => false, {
        operationCategory: 'test_jobs_lock_holder',
        beforeMutation: async () => {
          holderLocked.resolve();
          await releaseHolder.promise;
        },
      });
      await within(holderLocked.promise, 5_000, 'JOBS_LOCK_HOLDER_DID_NOT_START');

      const mutationWaiting = deferred();
      fileStorage.setFileStorageTransactionTestHookForTests(input => {
        if (input.collection === 'automation-jobs'
            && input.operationCategory === 'automation_job_execution_update'
            && input.phase === 'COLLECTION_LOCK_WAIT_STARTED') {
          mutationWaiting.resolve();
        }
      });
      const mutation = store.updateAutomationJobExecution(
          claimed.id,
          workerId,
          { outcomeStatus: 'IN_PROGRESS' },
          claimGuard(claimed, role.ownership),
      );
      await within(mutationWaiting.promise, 5_000, 'MUTATION_DID_NOT_WAIT_FOR_JOBS_LOCK');

      const renewal = await within(store.renewAutomationJobClaimLease(
          claimed.id, workerId, 10_000, claimGuard(claimed, role.ownership), Date.now(),
      ), 2_000, 'LEASE_RENEWAL_BLOCKED_WHILE_MUTATION_WAITED_FOR_JOBS_LOCK');
      assert.equal(renewal.renewed, true);

      releaseHolder.resolve();
      await within(holder, 10_000, 'JOBS_LOCK_HOLDER_STUCK');
      assert.ok(await within(mutation, 10_000, 'WAITING_MUTATION_STUCK'));
    } finally {
      fileStorage.setFileStorageTransactionTestHookForTests(undefined);
      await roles.releaseRuntimeRole('WORKER', role.ownership).catch(() => false);
    }
  });

  await test('concurrent final mutations share one lock order and both terminate', async () => {
    await reset();
    const { workerId, role } = await acquireWorker('concurrent');
    try {
      const first = await createJob('concurrent-first');
      const second = await createJob('concurrent-second');
      const claimed = await store.claimAutomationJobs(
          workerId, 2, 30_000, Date.now(), role.ownership,
      );
      assert.equal(claimed.length, 2);
      const claimedById = new Map(claimed.map(job => [job.id, job]));
      const mutations = Promise.all([first.job.id, second.job.id].map((id, index) => {
        const job = claimedById.get(id);
        return store.updateAutomationJobExecution(
            id,
            workerId,
            { outcomeStatus: 'IN_PROGRESS', progress: { processed: index + 1, total: 2, succeeded: index + 1, skipped: 0, failed: 0, percentage: (index + 1) * 50, updatedAt: new Date().toISOString() } },
            claimGuard(job, role.ownership),
        );
      }));
      const results = await within(mutations, 15_000, 'CONCURRENT_FINAL_MUTATIONS_DEADLOCKED');
      assert.equal(results.every(Boolean), true);
      assert.equal(results[0].id === results[1].id, false);
      const fences = await adapter.readCollection('runtime-role-fencing');
      assert.equal(fences.some(fence => fence.role === 'WORKER' && fence.status === 'ACTIVE'), false);
    } finally {
      await roles.releaseRuntimeRole('WORKER', role.ownership).catch(() => false);
    }
  });

  await test('equivalent execution progress does not rewrite automation-jobs', async () => {
    await reset();
    const { workerId, role } = await acquireWorker('no-op');
    try {
      const created = await createJob('no-op');
      const [claimed] = await store.claimAutomationJobs(
          workerId, 1, 30_000, Date.now(), role.ownership,
      );
      assert.equal(claimed.id, created.job.id);
      const patch = {
        progress: { processed: 1, total: 2, succeeded: 1, skipped: 0, failed: 0, percentage: 50, updatedAt: new Date().toISOString() },
      };
      assert.ok(await store.updateAutomationJobExecution(
          claimed.id, workerId, patch, claimGuard(claimed, role.ownership),
      ));
      const sourcePath = path.join(testRoot, 'automation-jobs.json');
      const before = fs.readFileSync(sourcePath, 'utf8');
      patch.progress.updatedAt = new Date(Date.now() + 1_000).toISOString();
      assert.ok(await store.updateAutomationJobExecution(
          claimed.id, workerId, patch, claimGuard(claimed, role.ownership),
      ));
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), before);
    } finally {
      await roles.releaseRuntimeRole('WORKER', role.ownership).catch(() => false);
    }
  });

  await test('claim, fencing, release, and expired-role mismatches remain fail closed', async () => {
    await reset();
    const { workerId, role } = await acquireWorker('mismatch');
    try {
      const created = await createJob('mismatch');
      const [claimed] = await store.claimAutomationJobs(
          workerId, 1, 30_000, Date.now(), role.ownership,
      );
      assert.equal(claimed.id, created.job.id);
      assert.equal(await store.completeAutomationJob(claimed.id, workerId, { stale: true }, {
        ...claimGuard(claimed, role.ownership),
        claimToken: 'test-wrong-claim-token',
      }), null);
      assert.equal(await store.completeAutomationJob(claimed.id, workerId, { stale: true }, {
        ...claimGuard(claimed, role.ownership),
        releaseId: '7'.repeat(40),
      }), null);
      await assert.rejects(
          () => store.completeAutomationJob(claimed.id, workerId, { stale: true }, {
            ...claimGuard(claimed, role.ownership),
            ownership: { ...role.ownership, fencingToken: role.ownership.fencingToken + 1 },
          }),
          /WORKER_FENCING_REJECTED/,
      );
      const leases = await adapter.readCollection('runtime-role-leases');
      const workerLease = leases.find(item => item.role === 'WORKER');
      workerLease.expiresAt = new Date(Date.now() - 1).toISOString();
      workerLease.leaseExpiresAt = workerLease.expiresAt;
      await adapter.writeCollection('runtime-role-leases', leases);
      await assert.rejects(
          () => store.completeAutomationJob(
              claimed.id, workerId, { stale: true }, claimGuard(claimed, role.ownership),
          ),
          /WORKER_FENCING_REJECTED/,
      );
      const durable = await store.getAutomationJob(claimed.id);
      assert.equal(durable.status, 'RUNNING');
      assert.equal(durable.result && durable.result.stale, undefined);
    } finally {
      await roles.releaseRuntimeRole('WORKER', role.ownership).catch(() => false);
    }
  });

  await test('production Worker and Scheduler reject mismatched release identity before role acquisition', async () => {
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);
    for (const entry of ['automation-worker.cjs', 'automation-scheduler.cjs']) {
      const entryName = entry.replace(/\.cjs$/, '');
      const mismatchRoot = path.join(testRoot, `${entryName}-mismatch`);
      fs.mkdirSync(mismatchRoot, { recursive: true });
      const mismatch = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', entry), '--once'], {
        cwd: process.cwd(),
        env: safeChildEnvironment({
          SANDEAL_DATA_DIR: mismatchRoot,
          SANDEAL_BUILD_MANIFEST_COMMIT: commitA,
          SANDEAL_BUILD_COMMIT: commitB,
          SANDEAL_RELEASE_ID: commitB,
          GIT_COMMIT_SHA: commitB,
          NEXT_PUBLIC_SANDEAL_RELEASE_ID: commitB,
        }),
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(mismatch.status, 1, `${entry} mismatch status: ${mismatch.status}`);
      assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /RELEASE_IDENTITY_MISMATCH/);
      const leasePath = path.join(mismatchRoot, 'runtime-role-leases.json');
      assert.equal(fs.existsSync(leasePath), false, `${entry} created a role lease before mismatch rejection`);

      const matchingRoot = path.join(testRoot, `${entryName}-matching`);
      fs.mkdirSync(matchingRoot, { recursive: true });
      const matching = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', entry), '--once'], {
        cwd: process.cwd(),
        env: safeChildEnvironment({
          SANDEAL_DATA_DIR: matchingRoot,
          SANDEAL_BUILD_MANIFEST_COMMIT: commitB,
          SANDEAL_BUILD_COMMIT: commitB,
          SANDEAL_RELEASE_ID: commitB,
          GIT_COMMIT_SHA: commitB,
          NEXT_PUBLIC_SANDEAL_RELEASE_ID: commitB,
        }),
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(matching.status, 0, `${entry} matching stderr: ${matching.stderr}`);
      assert.match(`${matching.stdout}\n${matching.stderr}`, /RELEASE_IDENTITY_VALIDATED/);
      const leases = JSON.parse(fs.readFileSync(path.join(matchingRoot, 'runtime-role-leases.json'), 'utf8'));
      assert.equal(leases.length, 1);
      assert.equal(leases[0].releaseId, commitB);
      assert.equal(leases[0].status, 'RELEASED');
    }
  });

  console.log(`\nRuntime fence commit-window tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
    .catch(error => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    })
    .finally(() => {
      try {
        const resolved = path.resolve(testRoot);
        if (path.dirname(resolved) !== allowedTempRoot
            || !path.basename(resolved).startsWith('runtime-fence-commit-window-')) {
          throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
      } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
      }
    });
