/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const allowedTempRoot = path.resolve(process.cwd(), '.test-tmp');
const testRoot = path.join(allowedTempRoot, `worker-job-lease-hotfix-${process.pid}-${Date.now()}`);
if (path.dirname(path.resolve(testRoot)) !== allowedTempRoot) throw new Error('UNSAFE_TEST_ROOT');
fs.mkdirSync(testRoot, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_BUILD_COMMIT = 'f'.repeat(40);
process.env.SANDEAL_RELEASE_ID = 'f'.repeat(40);
process.env.GIT_COMMIT_SHA = 'f'.repeat(40);
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = 'f'.repeat(40);
process.env.ALLOW_PAID_AI = 'false';
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

class FakeClock {
  constructor(now = 1_000_000) {
    this.current = now;
    this.nextId = 1;
    this.timers = new Map();
    this.runtime = {
      now: () => this.current,
      random: () => 0,
      setTimeout: (callback, milliseconds) => {
        const handle = { id: this.nextId++, unref() {} };
        this.timers.set(handle.id, {
          handle,
          callback,
          dueAt: this.current + Math.max(0, Number(milliseconds) || 0),
        });
        return handle;
      },
      clearTimeout: handle => {
        if (handle && typeof handle.id === 'number') this.timers.delete(handle.id);
      },
    };
  }

  sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(String(signal.reason || 'ABORTED')));
        return;
      }
      const timer = this.runtime.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        this.runtime.clearTimeout(timer);
        reject(new Error(String(signal.reason || 'ABORTED')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async flush() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  }

  async advance(milliseconds) {
    const target = this.current + milliseconds;
    while (true) {
      const next = [...this.timers.values()]
        .filter(timer => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.handle.id - right.handle.id)[0];
      if (!next) break;
      this.current = next.dueAt;
      this.timers.delete(next.handle.id);
      next.callback();
      await this.flush();
    }
    this.current = target;
    await this.flush();
  }
}

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

async function main() {
  const lease = require('../src/lib/automation/jobLeaseRenewal.ts');
  const adapter = require('../src/lib/storage/adapter.ts');
  const store = require('../src/lib/automation/store.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const worker = require('../src/lib/automation/worker.ts');

  async function reset() {
    await Promise.all(COLLECTIONS.map(collection => adapter.writeCollection(collection, [])));
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      workerPaused: false,
      schedulerPaused: false,
      ingestionPaused: false,
      killSwitch: false,
      publishPaused: true,
    }, 'worker-lease-hotfix-test');
  }

  async function createJob(suffix, type = 'HEALTH_CHECK') {
    return store.createAutomationJob({
      type,
      payload: {},
      idempotencyKey: `worker-lease-hotfix-${type.toLowerCase()}-${suffix}`,
      operationId: `worker-lease-hotfix-operation-${suffix}`,
      requestedBy: 'worker-lease-hotfix-test',
      priority: type === 'RUNTIME_GUARDIAN' ? 100 : 50,
      dryRun: false,
    });
  }

  function startFakeRenewal(clock, input = {}) {
    const controller = input.controller || new AbortController();
    const events = [];
    let renewals = 0;
    const handle = lease.startAutomationJobLeaseRenewal({
      leaseMs: input.leaseMs || 90,
      initialLeaseExpiresAt: new Date(clock.current + (input.leaseMs || 90)).toISOString(),
      parentSignal: controller.signal,
      runtime: clock.runtime,
      renew: async () => {
        renewals += 1;
        return input.renew
          ? input.renew(renewals)
          : { renewed: true, leaseExpiresAt: new Date(clock.current + (input.leaseMs || 90)).toISOString() };
      },
      onAuthorityLost: reason => controller.abort(reason),
      onEvent: (event, eventInput) => events.push({ event, at: clock.current, ...eventInput }),
      successLogEveryMs: input.leaseMs || 90,
    });
    return { controller, events, handle, renewals: () => renewals };
  }

  await test('long mocked handler survives several leases and completes exactly once', async () => {
    const clock = new FakeClock();
    const lifecycle = startFakeRenewal(clock);
    let completions = 0;
    let timeoutOrRequeue = 0;
    const handler = clock.sleep(260, lifecycle.controller.signal).then(() => {
      completions += 1;
    }).catch(() => {
      timeoutOrRequeue += 1;
    });
    await clock.advance(260);
    await handler;
    await lifecycle.handle.stop();
    assert.ok(lifecycle.renewals() >= 7, `renewals=${lifecycle.renewals()}`);
    assert.equal(completions, 1);
    assert.equal(timeoutOrRequeue, 0);
    assert.equal(lifecycle.handle.authorityLost, false);
  });

  await test('concurrent jobs renew independently and one completion stops only its timer', async () => {
    const clock = new FakeClock();
    const first = startFakeRenewal(clock);
    const second = startFakeRenewal(clock);
    await clock.advance(70);
    const firstAtStop = first.renewals();
    const secondAtStop = second.renewals();
    await first.handle.stop();
    await clock.advance(100);
    assert.equal(first.renewals(), firstAtStop);
    assert.ok(second.renewals() > secondAtStop);
    await second.handle.stop();
  });

  await test('stale worker ownership loss aborts its handler and rejects stale completion', async () => {
    const clock = new FakeClock();
    const durable = { claimToken: 'new-token', owner: 'new-worker', status: 'RUNNING', completions: 0 };
    const lifecycle = startFakeRenewal(clock, {
      renew: async () => ({ renewed: false, reasonCode: 'JOB_FENCING_MISMATCH' }),
    });
    const handler = clock.sleep(120, lifecycle.controller.signal).then(() => {
      if (durable.claimToken === 'old-token') durable.completions += 1;
    }).catch(() => undefined);
    await clock.advance(40);
    await handler;
    assert.equal(lifecycle.controller.signal.aborted, true);
    assert.equal(lifecycle.handle.authorityLostReason, 'JOB_FENCING_MISMATCH');
    assert.equal(durable.completions, 0);
    assert.equal(durable.owner, 'new-worker');
  });

  await test('claim-token mismatch and role loss both fail closed', async () => {
    for (const reasonCode of ['JOB_CLAIM_TOKEN_MISMATCH', 'WORKER_ROLE_LOST']) {
      const clock = new FakeClock();
      const lifecycle = startFakeRenewal(clock, {
        renew: async () => ({ renewed: false, reasonCode }),
      });
      await clock.advance(40);
      assert.equal(lifecycle.controller.signal.aborted, true);
      assert.equal(lifecycle.handle.authorityLostReason, reasonCode);
    }
  });

  await test('one transient storage error retries with delay and then recovers', async () => {
    const clock = new FakeClock();
    const attempts = [];
    const lifecycle = startFakeRenewal(clock, {
      renew: async count => {
        attempts.push(clock.current);
        if (count === 1) throw new Error('TRANSIENT_STORAGE_FAILURE');
        return { renewed: true, leaseExpiresAt: new Date(clock.current + 90).toISOString() };
      },
    });
    await clock.advance(55);
    assert.equal(attempts.length, 2);
    assert.ok(attempts[1] - attempts[0] >= 10, JSON.stringify(attempts));
    assert.equal(lifecycle.handle.authorityLost, false);
    assert.ok(lifecycle.events.some(event => event.event === 'worker_retry_backoff_applied'));
    await lifecycle.handle.stop();
  });

  await test('persistent storage failure aborts after two spaced attempts without a busy loop', async () => {
    const clock = new FakeClock();
    const attempts = [];
    const lifecycle = startFakeRenewal(clock, {
      renew: async () => {
        attempts.push(clock.current);
        throw new Error('PERSISTENT_STORAGE_FAILURE');
      },
    });
    await clock.advance(80);
    assert.deepEqual(attempts.length, 2);
    assert.ok(attempts[1] > attempts[0]);
    assert.equal(lifecycle.handle.authorityLostReason, 'JOB_LEASE_RENEWAL_STORAGE_FAILURE');
    assert.equal(clock.timers.size, 0);
  });

  await test('shutdown aborts the handler and removes renewal timers deterministically', async () => {
    const clock = new FakeClock();
    const parent = new AbortController();
    const lifecycle = startFakeRenewal(clock, { controller: parent });
    const handler = clock.sleep(200, parent.signal).catch(error => error.message);
    await clock.advance(20);
    parent.abort('WORKER_SHUTDOWN_REQUESTED');
    await lifecycle.handle.stop();
    assert.equal(await handler, 'WORKER_SHUTDOWN_REQUESTED');
    assert.equal(clock.timers.size, 0);
    assert.equal(lifecycle.renewals(), 0);
  });

  await test('SIGINT and SIGTERM arm one bounded shutdown drain', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'automation-worker.cjs'), 'utf8');
    assert.match(source, /process\.on\('SIGINT',[\s\S]*process\.on\('SIGTERM'/);
    assert.match(source, /shutdownController\.abort\('WORKER_SHUTDOWN_REQUESTED'\)[\s\S]*armShutdownDeadline\('WORKER_SHUTDOWN_DRAIN_TIMEOUT'\)/);
    assert.match(source, /SHUTDOWN_DRAIN_TIMEOUT_MS = 12_000[\s\S]*process\.exit\(1\)/);
  });

  await test('durable renewal keeps a healthy job running past its original lease', async () => {
    await reset();
    const created = await createJob('healthy-long');
    const claimAt = Math.max(Date.now(), Date.parse(created.job.scheduledAt));
    const [claimed] = await store.claimAutomationJobs('healthy-worker', 1, 90, claimAt);
    const renewal = await store.renewAutomationJobClaimLease(created.job.id, 'healthy-worker', 90, {
      claimToken: claimed.claimToken,
      attemptCount: claimed.attemptCount,
      releaseId: claimed.releaseId,
    }, claimAt + 30);
    assert.equal(renewal.renewed, true);
    assert.deepEqual(await store.claimAutomationJobs('recovery-worker', 1, 90, claimAt + 91), []);
    const durable = await store.getAutomationJob(created.job.id);
    assert.equal(durable.status, 'RUNNING');
    assert.equal(durable.attemptCount, 1);
  });

  await test('batch integration renews a claimed sibling while it waits behind a long handler', async () => {
    await reset();
    await createJob('sequential-first');
    await createJob('sequential-second');
    let executionCount = 0;
    let releaseFirstStart;
    const firstStarted = new Promise(resolve => { releaseFirstStart = resolve; });
    const batch = worker.processAutomationBatch('sequential-worker', 2, undefined, {
      jobLeaseMs: 300,
      executeJobOverride: async () => {
        executionCount += 1;
        if (executionCount === 1) {
          releaseFirstStart();
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        return { executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES' };
      },
    });
    await firstStarted;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(await store.claimAutomationJobs('competing-worker', 2, 300, Date.now()), []);
    const result = await batch;
    assert.equal(result.succeeded, 2);
    assert.equal(executionCount, 2);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.status === 'SUCCEEDED').length, 2);
  });

  await test('batch shutdown abort leaves the claim for safe expiry recovery instead of handler failure', async () => {
    await reset();
    const created = await createJob('shutdown-batch');
    const shutdown = new AbortController();
    let releaseStart;
    const started = new Promise(resolve => { releaseStart = resolve; });
    const batch = worker.processAutomationBatch('shutdown-worker', 1, undefined, {
      jobLeaseMs: 300,
      shutdownSignal: shutdown.signal,
      executeJobOverride: async (job, context) => {
        releaseStart();
        await new Promise((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
        return {};
      },
    });
    await started;
    shutdown.abort('WORKER_SHUTDOWN_REQUESTED');
    const result = await batch;
    const durable = await store.getAutomationJob(created.job.id);
    assert.equal(result.skipped, 1);
    assert.equal(durable.status, 'RUNNING');
    assert.notEqual(durable.lastErrorCode, 'HANDLER_TIMEOUT');
    assert.notEqual(durable.lastErrorCode, 'PROVIDER_TIMEOUT');
    const heartbeat = (await adapter.readCollection('automation-job-heartbeats'))
      .find(item => item.jobId === created.job.id);
    const recoverAt = Math.max(
      Date.parse(durable.leaseExpiresAt),
      Date.parse(heartbeat?.leaseExpiresAt || ''),
    ) + 1;
    await store.claimAutomationJobs('shutdown-recovery-worker', 1, 300, recoverAt);
    assert.equal((await store.getAutomationJob(created.job.id)).status, 'RETRY_SCHEDULED');
  });

  await test('durable claim-token mismatch cannot renew or complete the job', async () => {
    await reset();
    const created = await createJob('claim-mismatch');
    const base = Math.max(Date.now(), Date.parse(created.job.scheduledAt));
    const [claimed] = await store.claimAutomationJobs('claim-worker', 1, 90, base);
    const renewal = await store.renewAutomationJobClaimLease(created.job.id, 'claim-worker', 90, {
      claimToken: 'wrong-token',
      attemptCount: claimed.attemptCount,
      releaseId: claimed.releaseId,
    }, base + 20);
    assert.equal(renewal.renewed, false);
    assert.equal(renewal.reasonCode, 'JOB_CLAIM_TOKEN_MISMATCH');
    assert.equal(await store.completeAutomationJob(created.job.id, 'claim-worker', { stale: true }, {
      claimToken: 'wrong-token',
      attemptCount: claimed.attemptCount,
      releaseId: claimed.releaseId,
    }), null);
    assert.equal((await store.getAutomationJob(created.job.id)).status, 'RUNNING');
  });

  await test('runtime role takeover rejects the old worker renewal and completion', async () => {
    await reset();
    const base = Date.now();
    const oldRole = await roles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'old-owner', instanceId: 'old-instance', leaseMs: 5_000, now: base,
    });
    const created = await createJob('role-takeover');
    const [claimed] = await store.claimAutomationJobs('old-instance', 1, 90, Date.now(), oldRole.ownership);
    const replacement = await roles.acquireRuntimeRole({
      role: 'WORKER', ownerId: 'new-owner', instanceId: 'new-instance', leaseMs: 5_000, now: base + 6_000,
    });
    assert.equal(replacement.event, 'TAKEN_OVER');
    const renewal = await store.renewAutomationJobClaimLease(
      created.job.id,
      'old-instance',
      90,
      { claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, releaseId: claimed.releaseId, ownership: oldRole.ownership },
      base + 6_001,
    );
    assert.equal(renewal.renewed, false);
    assert.equal(renewal.reasonCode, 'WORKER_ROLE_LOST');
    await assert.rejects(() => store.completeAutomationJob(created.job.id, 'old-instance', { stale: true }, {
      claimToken: claimed.claimToken,
      attemptCount: claimed.attemptCount,
      releaseId: claimed.releaseId,
      ownership: oldRole.ownership,
    }), /WORKER_FENCING_REJECTED/);
    assert.equal((await store.getAutomationJob(created.job.id)).status, 'RUNNING');
  });

  await test('a genuinely abandoned lease is recovered once and max attempts terminalize once', async () => {
    await reset();
    const created = await createJob('abandoned-max');
    let now = Math.max(Date.now(), Date.parse(created.job.scheduledAt));
    let [claimed] = await store.claimAutomationJobs('abandoned-worker', 1, 90, now);
    const events = [];
    const originalLog = console.log;
    console.log = value => {
      try { events.push(JSON.parse(String(value))); } catch { /* non-JSON test output */ }
    };
    try {
      while (claimed) {
        const attemptBeforeRecovery = claimed.attemptCount;
        now += 91;
        await store.claimAutomationJobs('recovery-worker', 1, 90, now);
        const recovered = await store.getAutomationJob(created.job.id);
        assert.equal(recovered.attemptCount, attemptBeforeRecovery);
        if (recovered.status === 'FAILED') break;
        now = Date.parse(recovered.nextRetryAt);
        [claimed] = await store.claimAutomationJobs('abandoned-worker', 1, 90, now);
      }
      await store.claimAutomationJobs('recovery-worker', 1, 90, now + 1_000);
    } finally {
      console.log = originalLog;
    }
    const terminal = await store.getAutomationJob(created.job.id);
    assert.equal(terminal.status, 'FAILED');
    assert.equal(terminal.attemptCount, terminal.maxAttempts);
    assert.equal(terminal.lastErrorCode, 'LEASE_EXPIRED');
    assert.equal(events.filter(event => event.type === 'job_terminal_timeout' && event.reasonCode === 'LEASE_EXPIRED_MAX_ATTEMPTS').length, 1);
  });

  await test('genuine handler failure remains distinct from lease abandonment', async () => {
    await reset();
    const created = await createJob('handler-failure');
    const [claimed] = await store.claimAutomationJobs('handler-worker', 1, 90, Date.now());
    const failedJob = await store.failAutomationJob(created.job.id, 'handler-worker', 'VALIDATION_FAILED', new Error('fixture validation failed'), {
      claimToken: claimed.claimToken,
      attemptCount: claimed.attemptCount,
      releaseId: claimed.releaseId,
    });
    assert.equal(failedJob.lastErrorCode, 'VALIDATION_FAILED');
    assert.notEqual(failedJob.lastErrorCode, 'LEASE_EXPIRED');
  });

  await test('empty-lane polling backs off while another lane is busy', async () => {
    let guardianStarted = false;
    let emptyClaims = 0;
    const result = await worker.runContinuousWorkerPool({
      workerId: 'polling-backoff-worker',
      maxConcurrency: 2,
      maximumClaims: 2,
      criticalReservedCapacity: 1,
      stopPollMs: 10,
      lanePollMs: 100,
      laneMaximumPollMs: 400,
      runBatch: async (workerId, ownership, options) => {
        if (options.claimLane === 'RUNTIME_GUARDIAN' && !guardianStarted) {
          guardianStarted = true;
          await new Promise(resolve => setTimeout(resolve, 450));
          return { workerId, claimed: 1, criticalClaimed: 1, normalClaimed: 0, succeeded: 1, failed: 0, skipped: 0, waitingManual: 0, waitingChildren: 0 };
        }
        emptyClaims += 1;
        return { workerId, claimed: 0, criticalClaimed: 0, normalClaimed: 0, succeeded: 0, failed: 0, skipped: 0, waitingManual: 0, waitingChildren: 0 };
      },
    });
    assert.equal(result.claimed, 1);
    assert.ok(emptyClaims <= 5, `emptyClaims=${emptyClaims}`);
  });

  await test('active Runtime Guardian work is deduplicated', async () => {
    await reset();
    const first = await createJob('guardian-one', 'RUNTIME_GUARDIAN');
    const second = await createJob('guardian-two', 'RUNTIME_GUARDIAN');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'RUNTIME_GUARDIAN').length, 1);
  });

  console.log(`\nWorker job lease hotfix: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(process.cwd(), testRoot)}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    const resolved = path.resolve(testRoot);
    if (path.dirname(resolved) !== allowedTempRoot || !path.basename(resolved).startsWith('worker-job-lease-hotfix-')) {
      throw new Error(`REFUSING_UNSAFE_TEST_CLEANUP:${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
