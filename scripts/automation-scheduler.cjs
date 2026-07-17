/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const crypto = require('node:crypto');
const os = require('node:os');
const { runOwnedSchedulerCycle } = require('../src/lib/automation/scheduler.ts');
const { acquireRuntimeRole, heartbeatRuntimeRole, releaseRuntimeRole } = require('../src/lib/automation/runtimeRoles.ts');
const hostname = os.hostname();
const processStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
const ownerId = `scheduler:${hostname}`;
const instanceId = `${ownerId}:${process.pid}:${crypto.randomUUID()}`;
const once = process.argv.includes('--once');
let stopping = false;
let shutdownSignal = once ? 'once_complete' : 'runtime_complete';
let wakeDelay;

function log(type, details = {}, error = false) {
  const output = JSON.stringify({ type, role: 'SCHEDULER', ownerId, instanceId, pid: process.pid, ...details });
  (error ? console.error : console.log)(output);
}

function requestShutdown(signal) {
  if (stopping) return;
  stopping = true;
  shutdownSignal = signal;
  log('scheduler_shutdown', { phase: 'requested', signal });
  if (wakeDelay) wakeDelay();
}

function waitForNextTick(ms) {
  if (stopping) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { wakeDelay = undefined; resolve(); }, ms);
    wakeDelay = () => { clearTimeout(timer); wakeDelay = undefined; resolve(); };
  });
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

(async () => {
  const role = await acquireRuntimeRole({
    role: 'SCHEDULER', ownerId, instanceId, hostname, pid: process.pid, processStartedAt,
  });
  if (!role.acquired || !role.ownership) {
    log('scheduler_role_rejected', {
      code: 'SCHEDULER_ROLE_ALREADY_ACTIVE',
      activeOwnerId: role.lease.ownerId,
      activeInstanceId: role.lease.instanceId,
      leaseExpiresAt: role.lease.expiresAt,
      fencingToken: role.lease.fencingToken,
    }, true);
    process.exitCode = 1;
    return;
  }
  const ownership = role.ownership;
  if (role.event === 'TAKEN_OVER' && role.staleLease) {
    log('scheduler_role_stale_detected', {
      staleOwnerId: role.staleLease.ownerId,
      staleInstanceId: role.staleLease.instanceId,
      staleHeartbeatAt: role.staleLease.heartbeatAt,
      staleLeaseExpiresAt: role.staleLease.expiresAt,
    });
    log('scheduler_role_taken_over', {
      previousOwnerId: role.staleLease.ownerId,
      previousInstanceId: role.staleLease.instanceId,
      fencingToken: ownership.fencingToken,
    });
  } else {
    log('scheduler_role_acquired', {
      acquiredAt: role.lease.acquiredAt,
      leaseExpiresAt: role.lease.expiresAt,
      fencingToken: ownership.fencingToken,
    });
  }
  let heartbeatBusy = false;
  const roleHeartbeat = setInterval(() => {
    if (stopping || heartbeatBusy) return;
    heartbeatBusy = true;
    void heartbeatRuntimeRole('SCHEDULER', ownership)
      .then(renewed => {
        if (renewed) log('scheduler_role_heartbeat', { fencingToken: ownership.fencingToken });
        else {
          log('scheduler_tick_failed', { code: 'SCHEDULER_ROLE_LOST', message: 'Scheduler lease is no longer owned by this instance.' }, true);
          process.exitCode = 1;
          requestShutdown('ROLE_LOST');
        }
      })
      .catch(error => {
        log('scheduler_tick_failed', { code: 'SCHEDULER_HEARTBEAT_FAILED', message: error instanceof Error ? error.message : 'unknown_error' }, true);
      })
      .finally(() => { heartbeatBusy = false; });
  }, 15_000);
  let lastLogAt = 0;
  let previousState = '';
  try {
    do {
      try {
        const cycle = await runOwnedSchedulerCycle(ownership);
        if (cycle.status === 'role_lost') {
          log('scheduler_tick_failed', { code: 'SCHEDULER_ROLE_LOST', message: 'Scheduler cycle stopped before enqueue because leadership was lost.' }, true);
          process.exitCode = 1;
          requestShutdown('ROLE_LOST');
          break;
        }
        const { guardian, automation, intelligence } = cycle;
        const state = `${guardian.status}:${automation.status}:${intelligence.status}`;
        const now = Date.now();
        if (once || state !== previousState || guardian.status === 'scheduled' || automation.status === 'scheduled' || intelligence.scheduled > 0 || now - lastLogAt >= 5 * 60_000) {
          log('scheduler_tick', { guardian, automation, intelligence });
          lastLogAt = now;
          previousState = state;
        }
      } catch (error) {
        log('scheduler_tick_failed', {
          code: 'SCHEDULER_TICK_FAILED',
          message: error instanceof Error ? error.message : 'unknown_error',
        }, true);
        if (once) process.exitCode = 1;
      }
      if (!once && !stopping) await waitForNextTick(30_000);
    } while (!once && !stopping);
  } finally {
    stopping = true;
    if (wakeDelay) wakeDelay();
    clearInterval(roleHeartbeat);
    const released = await releaseRuntimeRole('SCHEDULER', ownership);
    if (released) log('scheduler_role_released', { fencingToken: ownership.fencingToken });
    log('scheduler_shutdown', { phase: 'completed', signal: shutdownSignal, released });
  }
})().catch(error => {
  log('scheduler_tick_failed', { code: 'SCHEDULER_FATAL', message: error instanceof Error ? error.message : 'unknown_error' }, true);
  process.exitCode = 1;
});
