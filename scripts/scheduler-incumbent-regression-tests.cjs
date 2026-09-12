/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tempDir = path.join(
    root,
    '.test-tmp',
    `scheduler-incumbent-${process.pid}-${Date.now()}`,
);

fs.mkdirSync(tempDir, { recursive: true });

process.env.SANDEAL_DATA_DIR = tempDir;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';

require('./register-typescript.cjs');

const adapter = require('../src/lib/storage/adapter.ts');
const roles = require('../src/lib/automation/runtimeRoles.ts');

const CONTENTION_TIMEOUT_MS = 15_000;
const ALIVE_SENTINEL_MS = 500;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function delay(ms, value) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}

function diagnostics(output, closeResult) {
  return JSON.stringify({
    closeResult,
    stdout: output.stdout.slice(-4_000),
    stderr: output.stderr.slice(-4_000),
  });
}

function waitForOutput(
    child,
    closed,
    output,
    pattern,
    timeoutMs,
) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', inspect);
      child.stderr.off('data', inspect);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const inspect = () => {
      if (pattern.test(`${output.stdout}\n${output.stderr}`)) {
        finish();
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(
          `Timed out waiting for scheduler contention log: ${diagnostics(output)}`,
      ));
    }, timeoutMs);

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);

    void closed.then(closeResult => {
      inspect();
      if (!settled) {
        finish(new Error(
            `Scheduler exited before contention was observed: ${diagnostics(output, closeResult)}`,
        ));
      }
    });

    inspect();
  });
}

function spawnScheduler() {
  const entry = path.join(
      root,
      'scripts',
      'automation-scheduler.cjs',
  );

  /*
   * The IPC channel gives this Windows-safe test a way to ask the child to
   * emit SIGTERM. Unref it in the child so IPC cannot conceal the regression:
   * a scheduler that returns after contention must still exit immediately.
   */
  const wrapper = [
    "process.on('message', message => {",
    "  if (message === 'SIGTERM') process.emit('SIGTERM');",
    '});',
    'process.channel?.unref();',
    `require(${JSON.stringify(entry)});`,
  ].join('\n');

  const child = spawn(
      process.execPath,
      ['-e', wrapper],
      {
        cwd: root,
        env: {
          ...process.env,
          SANDEAL_DATA_DIR: tempDir,
          SANDEAL_STORAGE_DRIVER: 'file',
          NODE_ENV: 'test',
          ALLOW_PAID_AI: 'false',
        },
        stdio: [
          'ignore',
          'pipe',
          'pipe',
          'ipc',
        ],
        windowsHide: true,
      },
  );

  const output = {
    stdout: '',
    stderr: '',
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output.stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    output.stderr += chunk;
  });

  let closeResult;
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      closeResult = { code, signal };
      resolve(closeResult);
    });
  });

  return {
    child,
    closed,
    output,
    getCloseResult: () => closeResult,
  };
}

function requestGracefulShutdown(child) {
  if (!child.connected) return;

  try {
    child.send('SIGTERM', () => undefined);
  } catch {
    // The child may have closed between the connected check and send().
  }
}

async function stopChild(runtime) {
  if (!runtime || runtime.getCloseResult()) return;

  requestGracefulShutdown(runtime.child);

  const timeout = Symbol('shutdown_timeout');
  const result = await Promise.race([
    runtime.closed,
    delay(SHUTDOWN_TIMEOUT_MS, timeout),
  ]);

  if (result !== timeout) return;

  runtime.child.kill('SIGKILL');
  await runtime.closed;
}

async function currentSchedulerLease() {
  const leases = await roles.listRuntimeRoleLeases();
  return leases.find(lease => lease.role === 'SCHEDULER');
}

async function main() {
  let incumbent;
  let runtime;
  let primaryError;

  try {
    await adapter.writeCollection('runtime-role-leases', []);
    await adapter.writeCollection('runtime-role-conflicts', []);
    await adapter.writeCollection('runtime-role-fencing', []);

    incumbent = await roles.acquireRuntimeRole({
      role: 'SCHEDULER',
      ownerId: 'scheduler-incumbent-test',
      instanceId: `scheduler-incumbent-test:${process.pid}`,
      hostname: 'scheduler-incumbent-test-host',
      pid: process.pid,
      leaseMs: 45_000,
    });

    assert.equal(incumbent.acquired, true);
    assert.ok(incumbent.ownership);

    runtime = spawnScheduler();

    await waitForOutput(
        runtime.child,
        runtime.closed,
        runtime.output,
        /"type":"scheduler_role_(?:rejected|wait)"/,
        CONTENTION_TIMEOUT_MS,
    );

    assert.match(
        runtime.output.stderr,
        /SCHEDULER_ROLE_ALREADY_ACTIVE|ROLE_ALREADY_ACTIVE/,
    );

    const sentinel = Symbol('still_alive');
    const earlyExit = await Promise.race([
      runtime.closed,
      delay(ALIVE_SENTINEL_MS, sentinel),
    ]);

    assert.equal(
        earlyExit,
        sentinel,
        `Healthy incumbent contention terminated the long-running scheduler: ${diagnostics(runtime.output, earlyExit)}`,
    );

    assert.equal(
        runtime.output.stdout.includes('"type":"scheduler_tick"'),
        false,
        diagnostics(runtime.output, runtime.getCloseResult()),
    );

    const leaseWhileWaiting = await currentSchedulerLease();
    assert.ok(leaseWhileWaiting);
    assert.equal(
        leaseWhileWaiting.instanceId,
        incumbent.lease.instanceId,
    );
    assert.equal(
        leaseWhileWaiting.fencingToken,
        incumbent.lease.fencingToken,
    );
    assert.equal(leaseWhileWaiting.status, 'ACTIVE');

    requestGracefulShutdown(runtime.child);

    const shutdownTimeout = Symbol('shutdown_timeout');
    const shutdown = await Promise.race([
      runtime.closed,
      delay(SHUTDOWN_TIMEOUT_MS, shutdownTimeout),
    ]);

    assert.notEqual(
        shutdown,
        shutdownTimeout,
        `Scheduler did not stop within ${SHUTDOWN_TIMEOUT_MS}ms: ${diagnostics(runtime.output)}`,
    );
    assert.deepEqual(
        shutdown,
        { code: 0, signal: null },
        diagnostics(runtime.output, shutdown),
    );

    assert.equal(
        runtime.output.stdout.includes('"type":"scheduler_tick"'),
        false,
        diagnostics(runtime.output, shutdown),
    );

    const leaseAfterShutdown = await currentSchedulerLease();
    assert.ok(leaseAfterShutdown);
    assert.equal(
        leaseAfterShutdown.instanceId,
        incumbent.lease.instanceId,
    );
    assert.equal(
        leaseAfterShutdown.fencingToken,
        incumbent.lease.fencingToken,
    );
    assert.equal(leaseAfterShutdown.status, 'ACTIVE');
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await stopChild(runtime);
    } catch (error) {
      if (!primaryError) primaryError = error;
    }

    if (incumbent?.ownership) {
      try {
        const released = await roles.releaseRuntimeRole(
            'SCHEDULER',
            incumbent.ownership,
        );

        if (!released && !primaryError) {
          primaryError = new Error(
              'Failed to release seeded Scheduler incumbent lease.',
          );
        }
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }
  }

  if (primaryError) throw primaryError;

  console.log(
      'PASS long-running scheduler waits behind a healthy incumbent without stealing authority',
  );
  console.log(`Isolated artifacts: ${path.relative(root, tempDir)}`);
}

main().catch(error => {
  console.error(
      `FAIL long-running scheduler waits behind a healthy incumbent without stealing authority\n${error && error.stack ? error.stack : error}`,
  );
  console.error(`Isolated artifacts: ${path.relative(root, tempDir)}`);
  process.exitCode = 1;
});
