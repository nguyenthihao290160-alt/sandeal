/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const crypto = require('node:crypto');
const os = require('node:os');
const { processAutomationBatch, runContinuousWorkerPool } = require('../src/lib/automation/worker.ts');
const { getAutomationSettings } = require('../src/lib/storage/automationSettings.ts');
const { acquireRuntimeRole, heartbeatRuntimeRole, releaseRuntimeRole } = require('../src/lib/automation/runtimeRoles.ts');
const { getFeatureRolloutState } = require('../src/lib/automation/featureRollout.ts');

const hostname = os.hostname();
const workerId = `worker:${hostname}`;
const instanceId = `${workerId}:${process.pid}:${crypto.randomUUID()}`;
const processStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
const once = process.argv.includes('--once');
let stopping = false;
let roleLeaseLost = false;
let forcedShutdown = false;
function requestShutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({
    type: 'worker_shutdown',
    workerId: instanceId,
    phase: 'requested',
    signal,
    reasonCode: 'WORKER_SHUTDOWN_REQUESTED',
  }));
}
process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForWorkerRole() {
  let lastConflictLogAt = 0;
  while (!stopping) {
    const result = await acquireRuntimeRole({ role: 'WORKER', ownerId: workerId, instanceId, hostname, pid: process.pid, processStartedAt });
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
    // A one-shot probe must report the live owner without waiting for the
    // lease to expire. The long-running PM2 worker keeps the bounded backoff.
    if (once) return null;
    const expiresIn = Date.parse(result.lease.leaseExpiresAt || '') - now;
    await wait(Math.max(1_000, Math.min(15_000, Number.isFinite(expiresIn) ? expiresIn + 250 : 5_000)));
  }
  return null;
}

(async () => {
  const role = await waitForWorkerRole();
  if (!role?.ownership) return;
  const ownership = role.ownership;
  console.log(JSON.stringify({
    type: 'worker_role_acquired',
    workerId: instanceId,
    reasonCode: role.event || 'ACQUIRED',
    fencingToken: ownership.fencingToken,
    takeoverCount: role.lease.takeoverCount,
    releaseId: role.lease.releaseId,
  }));

  const roleHeartbeat = setInterval(() => {
    void heartbeatRuntimeRole('WORKER', ownership).then(renewed => {
      if (!renewed) {
        roleLeaseLost = true;
        stopping = true;
        console.error(JSON.stringify({ type: 'worker_role_lost', workerId: instanceId, reasonCode: 'WORKER_FENCING_REJECTED' }));
      }
    }).catch(error => {
      console.error(JSON.stringify({ type: 'worker_role_heartbeat_failed', workerId: instanceId, reasonCode: error instanceof Error ? error.message : 'UNKNOWN_ERROR' }));
    });
  }, 15_000);
  roleHeartbeat.unref();

  let lastIdleLogAt = 0;
  let idleDelayMs = 2_000;
  try {
    do {
      let result;
      try {
        const settings = await getAutomationSettings();
        const concurrency = Math.max(1, Math.min(4, Number(settings.maxConcurrency) || 1));
        const continuousPoolActive = getFeatureRolloutState('WORKER_CONTINUOUS_POOL_V2').mode === 'ACTIVE';
        result = continuousPoolActive
          ? await runContinuousWorkerPool({
              workerId: instanceId,
              ownership,
              maxConcurrency: concurrency,
              maximumClaims: Math.max(1, Math.min(50, Number(settings.maxItemsPerRun) || concurrency)),
              criticalReservedCapacity: concurrency > 1 ? 1 : 0,
              shouldStop: () => stopping || roleLeaseLost,
              drainTimeoutMs: 12_000,
            })
          : await processAutomationBatch(instanceId, concurrency, ownership);
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
        const reasonCode = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
        console.error(JSON.stringify({ type: 'worker_tick_failed', workerId: instanceId, reasonCode }));
        if (reasonCode.includes('WORKER_FENCING_REJECTED')) {
          roleLeaseLost = true;
          stopping = true;
          break;
        }
        if (!once && !stopping) await wait(5_000);
        if (once) throw error;
        continue;
      }

      const now = Date.now();
      if (once || result.claimed > 0 || now - lastIdleLogAt >= 60_000) {
        console.log(JSON.stringify({ type: result.claimed ? 'worker_tick' : 'worker_idle', ...result, idleDelayMs: result.claimed ? 0 : idleDelayMs }));
        if (!result.claimed) lastIdleLogAt = now;
      }
      idleDelayMs = result.claimed ? 500 : Math.min(10_000, Math.ceil(idleDelayMs * 1.6));
      if (!once && !stopping) await wait(idleDelayMs);
    } while (!once && !stopping);
  } finally {
    clearInterval(roleHeartbeat);
    const released = !roleLeaseLost && !forcedShutdown
      ? await releaseRuntimeRole('WORKER', ownership)
      : false;
    console.log(JSON.stringify({
      type: 'worker_shutdown',
      workerId: instanceId,
      phase: 'completed',
      released,
      forced: forcedShutdown,
      reasonCode: forcedShutdown ? 'WORKER_SHUTDOWN_DRAIN_TIMEOUT' : 'WORKER_SHUTDOWN_COMPLETED',
    }));
    if (forcedShutdown) setImmediate(() => process.exit(1));
  }
})().catch(error => {
  console.error(JSON.stringify({ type: 'worker_failed', workerId: instanceId, reasonCode: error instanceof Error ? error.message : 'UNKNOWN_ERROR' }));
  process.exitCode = 1;
});
