/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const allowedTempRoot = path.resolve(root, '.test-tmp');
const testRoot = path.join(
    allowedTempRoot,
    `scheduler-role-heartbeat-${process.pid}-${Date.now()}`,
);

function assertSafeTestPath(target, expectedPrefix) {
  const resolved = path.resolve(target);
  if (
      path.dirname(resolved) !== allowedTempRoot
      || !path.basename(resolved).startsWith(expectedPrefix)
  ) {
    throw new Error(`UNSAFE_TEST_PATH:${resolved}`);
  }
  return resolved;
}

assertSafeTestPath(testRoot, 'scheduler-role-heartbeat-');
fs.mkdirSync(testRoot, { recursive: true });

const releaseId = '7'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = testRoot;
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_BUILD_MANIFEST_COMMIT = releaseId;
process.env.SANDEAL_BUILD_COMMIT = releaseId;
process.env.SANDEAL_RELEASE_ID = releaseId;
process.env.GIT_COMMIT_SHA = releaseId;
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = releaseId;
process.env.ALLOW_PAID_AI = 'false';
process.env.SANDEAL_ROLE_FENCE_LEASE_MS = '15000';
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
    console.error(
        `FAIL ${name}\n${error && error.stack ? error.stack : error}`,
    );
  }
}

function safeChildEnvironment(dataDir) {
  const environment = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'ComSpec',
    'PATHEXT',
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    NODE_ENV: 'test',
    SANDEAL_DATA_DIR: dataDir,
    SANDEAL_STORAGE_DRIVER: 'file',
    SANDEAL_BUILD_MANIFEST_COMMIT: releaseId,
    SANDEAL_BUILD_COMMIT: releaseId,
    SANDEAL_RELEASE_ID: releaseId,
    GIT_COMMIT_SHA: releaseId,
    NEXT_PUBLIC_SANDEAL_RELEASE_ID: releaseId,
    ALLOW_PAID_AI: 'false',
    SANDEAL_ROLE_FENCE_LEASE_MS: '15000',
  };
}

function removeTestDirectory(target, expectedPrefix) {
  const safeTarget = assertSafeTestPath(target, expectedPrefix);
  fs.rmSync(safeTarget, { recursive: true, force: true });
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const fileStorage = require('../src/lib/storage/fileStorageAdapter.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const store = require('../src/lib/automation/store.ts');

  global.fetch = async () => {
    throw new Error('NETWORK_FORBIDDEN_IN_SCHEDULER_HEARTBEAT_TEST');
  };

  async function reset() {
    fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    for (const collection of COLLECTIONS) {
      await adapter.writeCollection(collection, []);
    }
    await store.updateAutomationControl({
      mode: 'SHADOW',
      effectiveMode: 'SHADOW',
      workerPaused: false,
      schedulerPaused: true,
      ingestionPaused: false,
      killSwitch: false,
      publishPaused: true,
    }, 'scheduler-heartbeat-test');
  }

  await test(
      'entrypoint and owned cycle never overlap Scheduler role-heartbeat transactions',
      () => {
        const childRoot = path.join(
            allowedTempRoot,
            `scheduler-role-heartbeat-child-${process.pid}-${Date.now()}`,
        );
        assertSafeTestPath(childRoot, 'scheduler-role-heartbeat-child-');
        fs.mkdirSync(childRoot, { recursive: true });

        const harness = String.raw`
          require(${JSON.stringify(path.join(root, 'scripts', 'register-typescript.cjs'))});
          const fileStorage = require(${JSON.stringify(path.join(root, 'src', 'lib', 'storage', 'fileStorageAdapter.ts'))});
          const roles = require(${JSON.stringify(path.join(root, 'src', 'lib', 'automation', 'runtimeRoles.ts'))});

          let roleLockAcquisitions = 0;
          let roleWaitStarts = 0;
          let heartbeatCalls = 0;
          let activeHeartbeatCalls = 0;
          let peakHeartbeatCalls = 0;
          let heldRoleHeartbeatTransaction = false;
          let transactionOverlapObserved = false;

          const originalHeartbeat = roles.heartbeatRuntimeRole;
          roles.heartbeatRuntimeRole = async (...args) => {
            heartbeatCalls += 1;
            activeHeartbeatCalls += 1;
            peakHeartbeatCalls = Math.max(
                peakHeartbeatCalls,
                activeHeartbeatCalls,
            );
            try {
              return await originalHeartbeat(...args);
            } finally {
              activeHeartbeatCalls -= 1;
            }
          };

          const originalIsRuntimeRoleOwner = roles.isRuntimeRoleOwner;
          roles.isRuntimeRoleOwner = async (...args) => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return originalIsRuntimeRoleOwner(...args);
          };

          fileStorage.setFileStorageTransactionTestHookForTests(
              async input => {
                if (input.collection !== 'runtime-role-leases') return;
                if (input.phase === 'COLLECTION_LOCK_WAIT_STARTED') {
                  roleWaitStarts += 1;
                  if (heldRoleHeartbeatTransaction) {
                    transactionOverlapObserved = true;
                  }
                }
                if (input.phase === 'COLLECTION_LOCK_ACQUIRED') {
                  roleLockAcquisitions += 1;
                  if (roleLockAcquisitions === 2) {
                    heldRoleHeartbeatTransaction = true;
                    await new Promise(resolve => setTimeout(resolve, 150));
                    heldRoleHeartbeatTransaction = false;
                  }
                }
              },
          );

          const originalSetInterval = global.setInterval;
          global.setInterval = (fn, milliseconds, ...args) =>
            originalSetInterval(
                fn,
                milliseconds === 15_000 ? 5 : milliseconds,
                ...args,
            );

          global.fetch = async () => {
            throw new Error('NETWORK_FORBIDDEN_IN_SCHEDULER_HEARTBEAT_CHILD');
          };

          process.on('exit', () => {
            console.log(JSON.stringify({
              type: 'scheduler_role_heartbeat_overlap_probe',
              heartbeatCalls,
              peakHeartbeatCalls,
              roleWaitStarts,
              roleLockAcquisitions,
              transactionOverlapObserved,
            }));
          });

          require(${JSON.stringify(path.join(root, 'scripts', 'automation-scheduler.cjs'))});
        `;

        let result;
        try {
          result = spawnSync(
              process.execPath,
              ['-e', harness, '--', '--once'],
              {
                cwd: root,
                env: safeChildEnvironment(childRoot),
                encoding: 'utf8',
                timeout: 20_000,
                windowsHide: true,
                maxBuffer: 2 * 1024 * 1024,
              },
          );
        } finally {
          removeTestDirectory(
              childRoot,
              'scheduler-role-heartbeat-child-',
          );
        }

        assert.equal(result.error, undefined, result.error?.stack);
        assert.equal(result.status, 0, result.stderr || result.stdout);

        const markerLine = result.stdout
            .split(/\r?\n/)
            .find(line => line.includes(
                '"type":"scheduler_role_heartbeat_overlap_probe"',
            ));
        assert.ok(markerLine, result.stdout);
        const marker = JSON.parse(markerLine);
        assert.ok(marker.heartbeatCalls >= 1, JSON.stringify(marker));
        assert.ok(marker.roleLockAcquisitions >= 3, JSON.stringify(marker));
        assert.deepEqual(
            {
              peakHeartbeatCalls: marker.peakHeartbeatCalls,
              transactionOverlapObserved:
                  marker.transactionOverlapObserved,
            },
            {
              peakHeartbeatCalls: 1,
              transactionOverlapObserved: false,
            },
            JSON.stringify(marker),
        );
      },
  );

  await test(
      'owned Scheduler cycle retains a persisted fail-closed authority assertion',
      async () => {
        await reset();
        const now = Date.now();
        const leader = await roles.acquireRuntimeRole({
          role: 'SCHEDULER',
          ownerId: 'scheduler-heartbeat-leader',
          instanceId: 'scheduler-heartbeat-leader:1',
          releaseId,
          leaseMs: 45_000,
          now,
        });
        assert.equal(leader.acquired, true);
        try {
          const result = await scheduler.runOwnedSchedulerCycle({
            ownerId: 'scheduler-heartbeat-stale',
            instanceId: 'scheduler-heartbeat-stale:1',
            fencingToken: leader.ownership.fencingToken + 1,
            releaseId,
          }, now + 1);
          assert.equal(result.status, 'role_lost');
          assert.equal(
              (await adapter.readCollection('automation-jobs')).length,
              0,
          );
        } finally {
          await roles.releaseRuntimeRole('SCHEDULER', leader.ownership);
        }
      },
  );

  await test(
      'owned Scheduler cycle authority assertion does not renew or extend its lease',
      async () => {
        await reset();
        const now = Date.now();
        const acquired = await roles.acquireRuntimeRole({
          role: 'SCHEDULER',
          ownerId: 'scheduler-heartbeat-owned',
          instanceId: 'scheduler-heartbeat-owned:1',
          releaseId,
          leaseMs: 45_000,
          now,
        });
        assert.equal(acquired.acquired, true);
        try {
          const before = (await roles.listRuntimeRoleLeases())
              .find(lease => lease.role === 'SCHEDULER');
          assert.ok(before);
          adapter.resetStorageDiagnostics();

          const cycle = await scheduler.runOwnedSchedulerCycle(
              acquired.ownership,
              now + 10,
          );
          const diagnostics = adapter.getStorageDiagnosticsSnapshot();
          const after = (await roles.listRuntimeRoleLeases())
              .find(lease => lease.role === 'SCHEDULER');
          assert.equal(cycle.status, 'completed');
          assert.ok(after);
          assert.deepEqual(
              {
                heartbeatAtUnchanged:
                    after.heartbeatAt === before.heartbeatAt,
                expiresAtUnchanged:
                    after.expiresAt === before.expiresAt,
                leaseExpiresAtUnchanged:
                    after.leaseExpiresAt === before.leaseExpiresAt,
                updatedAtUnchanged:
                    after.updatedAt === before.updatedAt,
                roleHeartbeatRenewalCount:
                    diagnostics.roleHeartbeatRenewalCount,
              },
              {
                heartbeatAtUnchanged: true,
                expiresAtUnchanged: true,
                leaseExpiresAtUnchanged: true,
                updatedAtUnchanged: true,
                roleHeartbeatRenewalCount: 0,
              },
          );
        } finally {
          await roles.releaseRuntimeRole('SCHEDULER', acquired.ownership);
        }
      },
  );

  console.log(
      `Scheduler role-heartbeat regression tests: ${passed} passed, ${failed} failed`,
  );
  if (failed) process.exitCode = 1;
}

main()
    .catch(error => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    })
    .finally(() => {
      try {
        removeTestDirectory(testRoot, 'scheduler-role-heartbeat-');
      } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
      }
    });
