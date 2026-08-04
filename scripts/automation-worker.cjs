/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');

const crypto = require('node:crypto');
const os = require('node:os');

const { processAutomationBatch, runContinuousWorkerPool } = require('../src/lib/automation/worker.ts');
const { getAutomationSettings } = require('../src/lib/storage/automationSettings.ts');
const {
  acquireRuntimeRole,
  heartbeatRuntimeRole,
  releaseRuntimeRole,
} = require('../src/lib/automation/runtimeRoles.ts');
const {
  isContinuousWorkerPoolEnabled,
  isCriticalWorkerSchedulingEnabled,
} = require('../src/lib/automation/featureRollout.ts');

const hostname = os.hostname();
const workerId = `worker:${hostname}`;
const instanceId = `${workerId}:${process.pid}:${crypto.randomUUID()}`;
const processStartedAt = new Date(
    Date.now() - Math.floor(process.uptime() * 1_000),
).toISOString();

const once = process.argv.includes('--once');
const ROLE_HEARTBEAT_INTERVAL_MS = 15_000;
const ROLE_HEARTBEAT_TIMEOUT_MS = 5_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 12_000;
const WORKER_TICK_BACKOFF_BASE_MS = 5_000;
const WORKER_TICK_BACKOFF_MAX_MS = 30_000;

let stopping = false;
let roleLeaseLost = false;
let forcedShutdown = false;
let activeRoleHeartbeat;
let shutdownDeadlineTimer;

const shutdownController = new AbortController();

function armShutdownDeadline(reasonCode) {
  if (shutdownDeadlineTimer) return;
  shutdownDeadlineTimer = setTimeout(() => {
    forcedShutdown = true;
    console.error(JSON.stringify({
      type: 'worker_shutdown',
      workerId: instanceId,
      phase: 'drain_timeout',
      reasonCode,
    }));
    process.exit(1);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS);
}

function requestShutdown(signal) {
  if (stopping) return;
  stopping = true;
  shutdownController.abort('WORKER_SHUTDOWN_REQUESTED');
  armShutdownDeadline('WORKER_SHUTDOWN_DRAIN_TIMEOUT');
  console.log(JSON.stringify({
    type: 'worker_shutdown_drain_started',
    workerId: instanceId,
    phase: 'requested',
    signal,
    reasonCode: 'WORKER_SHUTDOWN_REQUESTED',
  }));
}

function requestRoleLoss(reasonCode, details = {}) {
  if (roleLeaseLost) return;
  roleLeaseLost = true;
  stopping = true;
  shutdownController.abort('WORKER_FENCING_REJECTED');
  armShutdownDeadline('WORKER_ROLE_LOST_DRAIN_TIMEOUT');
  console.error(JSON.stringify({
    type: 'worker_role_lost',
    workerId: instanceId,
    reasonCode,
    ...details,
  }));
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

function wait(milliseconds, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('elapsed');
    }, Math.max(0, Number(milliseconds) || 0));

    const onAbort = () => {
      clearTimeout(timer);
      resolve('aborted');
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function boundedRoleHeartbeat(ownership) {
  if (activeRoleHeartbeat) {
    return Promise.reject(new Error('ROLE_HEARTBEAT_IN_FLIGHT'));
  }

  const operation = Promise.resolve()
      .then(() => heartbeatRuntimeRole('WORKER', ownership));

  activeRoleHeartbeat = operation;
  void operation
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (activeRoleHeartbeat === operation) activeRoleHeartbeat = undefined;
      });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
        () => reject(new Error('ROLE_HEARTBEAT_TIMEOUT')),
        ROLE_HEARTBEAT_TIMEOUT_MS,
    );
    timer.unref?.();
  });

  return Promise.race([operation, timeout])
      .finally(() => clearTimeout(timer));
}

async function drainActiveRoleHeartbeat() {
  const operation = activeRoleHeartbeat;
  if (!operation) return true;

  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), ROLE_HEARTBEAT_TIMEOUT_MS);
    timer.unref?.();
  });

  const drained = await Promise.race([
    operation.then(() => true, () => true),
    timeout,
  ]);
  clearTimeout(timer);
  return drained;
}

async function waitForWorkerRole() {
  let lastConflictLogAt = 0;

  while (!stopping) {
    const result = await acquireRuntimeRole({
      role: 'WORKER',
      ownerId: workerId,
      instanceId,
      hostname,
      pid: process.pid,
      processStartedAt,
    });

    if (result.acquired && result.ownership) return result;

    const now = Date.now();
    if (now - lastConflictLogAt >= 60_000) {
      console.warn(JSON.stringify({
        type: 'worker_role_wait',
        workerId: instanceId,
        reasonCode: result.reason || 'ROLE_ALREADY_ACTIVE',
        activeHolderId: result.lease.holderId,
        activeInstanceId: result.lease.instanceId,
        leaseExpiresAt: result.lease.leaseExpiresAt,
      }));
      lastConflictLogAt = now;
    }

    // A one-shot probe reports the live owner without waiting for expiry.
    if (once) return null;

    const expiresIn = Date.parse(result.lease.leaseExpiresAt || '') - now;
    const delayMs = Math.max(
        1_000,
        Math.min(
            15_000,
            Number.isFinite(expiresIn) ? expiresIn + 250 : 5_000,
        ),
    );
    await wait(delayMs, shutdownController.signal);
  }

  return null;
}

(async () => {
  const role = await waitForWorkerRole();
  if (!role?.ownership) {
    if (shutdownDeadlineTimer) clearTimeout(shutdownDeadlineTimer);
    return;
  }

  const ownership = role.ownership;
  console.log(JSON.stringify({
    type: 'worker_role_acquired',
    workerId: instanceId,
    reasonCode: role.event || 'ACQUIRED',
    fencingToken: ownership.fencingToken,
    takeoverCount: role.lease.takeoverCount,
    releaseId: role.lease.releaseId,
  }));

  let roleHeartbeatBusy = false;
  let roleHeartbeatFailures = 0;

  const roleHeartbeat = setInterval(() => {
    if (roleHeartbeatBusy || activeRoleHeartbeat || stopping) return;

    roleHeartbeatBusy = true;
    void boundedRoleHeartbeat(ownership)
        .then(renewed => {
          if (renewed) {
            roleHeartbeatFailures = 0;
            return;
          }

          roleHeartbeatFailures += 1;
          requestRoleLoss('WORKER_FENCING_REJECTED', {
            consecutiveFailures: roleHeartbeatFailures,
            source: 'ROLE_HEARTBEAT_REJECTED',
          });
        })
        .catch(error => {
          roleHeartbeatFailures += 1;
          const reasonCode = error instanceof Error
              ? error.message
              : 'UNKNOWN_ERROR';

          console.error(JSON.stringify({
            type: 'worker_role_heartbeat_failed',
            workerId: instanceId,
            reasonCode,
            consecutiveFailures: roleHeartbeatFailures,
          }));

          // A thrown storage/timeout failure can be transient. Two consecutive
          // failures fail closed before the role lease can become ambiguous.
          if (roleHeartbeatFailures >= 2) {
            requestRoleLoss('WORKER_FENCING_REJECTED', {
              consecutiveFailures: roleHeartbeatFailures,
              source: reasonCode,
            });
          }
        })
        .finally(() => {
          roleHeartbeatBusy = false;
        });
  }, ROLE_HEARTBEAT_INTERVAL_MS);

  roleHeartbeat.unref?.();

  let lastIdleLogAt = 0;
  let idleDelayMs = 2_000;
  let tickFailureCount = 0;

  try {
    do {
      let result;

      try {
        const settings = await getAutomationSettings();
        const concurrency = Math.max(
            1,
            Math.min(4, Number(settings.maxConcurrency) || 1),
        );
        const criticalSchedulingActive = isCriticalWorkerSchedulingEnabled();
        const continuousPoolActive =
            isContinuousWorkerPoolEnabled() || criticalSchedulingActive;

        result = continuousPoolActive
            ? await runContinuousWorkerPool({
              workerId: instanceId,
              ownership,
              maxConcurrency: concurrency,
              maximumClaims: Math.max(
                  1,
                  Math.min(
                      50,
                      Number(settings.maxItemsPerRun) || concurrency,
                  ),
              ),
              criticalReservedCapacity: concurrency > 1 ? 1 : 0,
              priorityScheduling: criticalSchedulingActive
                  ? 'ALL_CRITICAL'
                  : 'RUNTIME_GUARDIAN_ONLY',
              shouldStop: () => stopping || roleLeaseLost,
              shutdownSignal: shutdownController.signal,
              drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
            })
            : await processAutomationBatch(
                instanceId,
                concurrency,
                ownership,
                { shutdownSignal: shutdownController.signal },
            );

        tickFailureCount = 0;

        if (continuousPoolActive && !result.drained) {
          forcedShutdown = true;
          console.error(JSON.stringify({
            type: 'worker_shutdown',
            workerId: instanceId,
            phase: 'drain_timeout',
            peakInFlight: Math.max(0, result.peakInFlight),
            reasonCode: 'WORKER_SHUTDOWN_DRAIN_TIMEOUT',
          }));
          break;
        }
      } catch (error) {
        const reasonCode = error instanceof Error
            ? error.message
            : 'UNKNOWN_ERROR';

        console.error(JSON.stringify({
          type: 'worker_tick_failed',
          workerId: instanceId,
          reasonCode,
        }));

        if (reasonCode.includes('WORKER_FENCING_REJECTED')) {
          requestRoleLoss('WORKER_FENCING_REJECTED', {
            source: 'WORKER_TICK_FAILED',
          });
          break;
        }

        tickFailureCount += 1;

        if (!once && !stopping) {
          const exponent = Math.min(4, Math.max(0, tickFailureCount - 1));
          const baseDelayMs = Math.min(
              WORKER_TICK_BACKOFF_MAX_MS,
              WORKER_TICK_BACKOFF_BASE_MS * 2 ** exponent,
          );
          const jitterMs = Math.floor(baseDelayMs * 0.1 * Math.random());
          const delayMs = Math.min(
              WORKER_TICK_BACKOFF_MAX_MS,
              baseDelayMs + jitterMs,
          );

          console.warn(JSON.stringify({
            type: 'worker_retry_backoff_applied',
            workerId: instanceId,
            delayMs,
            consecutiveFailures: tickFailureCount,
            reasonCode: 'WORKER_TICK_FAILED',
          }));

          await wait(delayMs, shutdownController.signal);
        }

        if (once) throw error;
        continue;
      }

      const now = Date.now();
      if (once || result.claimed > 0 || now - lastIdleLogAt >= 60_000) {
        console.log(JSON.stringify({
          type: result.claimed ? 'worker_tick' : 'worker_idle',
          ...result,
          idleDelayMs: result.claimed ? 0 : idleDelayMs,
        }));
        if (!result.claimed) lastIdleLogAt = now;
      }

      idleDelayMs = result.claimed
          ? 500
          : Math.min(10_000, Math.ceil(idleDelayMs * 1.6));

      if (!once && !stopping) {
        await wait(idleDelayMs, shutdownController.signal);
      }
    } while (!once && !stopping);
  } finally {
    clearInterval(roleHeartbeat);

    const roleHeartbeatDrained = await drainActiveRoleHeartbeat();
    if (!roleHeartbeatDrained) {
      forcedShutdown = true;
      console.error(JSON.stringify({
        type: 'worker_role_heartbeat_drain_failed',
        workerId: instanceId,
        reasonCode: 'ROLE_HEARTBEAT_DRAIN_TIMEOUT',
      }));
    }

    let released = false;
    if (roleHeartbeatDrained && !roleLeaseLost && !forcedShutdown) {
      try {
        released = await releaseRuntimeRole('WORKER', ownership);
      } catch (error) {
        console.error(JSON.stringify({
          type: 'worker_role_release_failed',
          workerId: instanceId,
          reasonCode: error instanceof Error
              ? error.message
              : 'UNKNOWN_ERROR',
        }));
      }
    }

    if (shutdownDeadlineTimer) clearTimeout(shutdownDeadlineTimer);

    console.log(JSON.stringify({
      type: 'worker_shutdown_drain_completed',
      workerId: instanceId,
      phase: 'completed',
      released,
      roleHeartbeatDrained,
      forced: forcedShutdown,
      reasonCode: forcedShutdown
          ? 'WORKER_SHUTDOWN_DRAIN_TIMEOUT'
          : 'WORKER_SHUTDOWN_COMPLETED',
    }));

    if (forcedShutdown) setImmediate(() => process.exit(1));
  }
})().catch(error => {
  console.error(JSON.stringify({
    type: 'worker_failed',
    workerId: instanceId,
    reasonCode: error instanceof Error
        ? error.message
        : 'UNKNOWN_ERROR',
  }));
  process.exitCode = 1;
});
