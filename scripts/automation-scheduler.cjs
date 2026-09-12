/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');

const crypto = require('node:crypto');
const os = require('node:os');

const {
  runOwnedSchedulerCycle,
} = require('../src/lib/automation/scheduler.ts');

const {
  acquireRuntimeRole,
  heartbeatRuntimeRole,
  releaseRuntimeRole,
  DEFAULT_ROLE_LEASE_MS,
} = require('../src/lib/automation/runtimeRoles.ts');

const {
  validateRuntimeRoleReleaseIdentity,
} = require('../src/lib/releaseIdentity.ts');

const hostname = os.hostname();

const processStartedAt = new Date(
    Date.now() - Math.floor(process.uptime() * 1_000),
).toISOString();

const ownerId = `scheduler:${hostname}`;

const instanceId =
    `${ownerId}:${process.pid}:${crypto.randomUUID()}`;

const once = process.argv.includes('--once');

const ROLE_HEARTBEAT_INTERVAL_MS = 15_000;
const ROLE_HEARTBEAT_TIMEOUT_MS = 5_000;

const ROLE_HEARTBEAT_SAFETY_MARGIN_MS = Math.max(
    5_000,
    Math.min(
        15_000,
        Math.floor(DEFAULT_ROLE_LEASE_MS / 3),
    ),
);

const ROLE_HEARTBEAT_WATCHDOG_INTERVAL_MS = Math.max(
    1_000,
    Math.min(
        5_000,
        Math.floor(ROLE_HEARTBEAT_INTERVAL_MS / 3),
    ),
);

const SHUTDOWN_DRAIN_TIMEOUT_MS = 12_000;

let stopping = false;
let roleLeaseLost = false;
let forcedShutdown = false;

let shutdownSignal =
    once ? 'once_complete' : 'runtime_complete';

let wakeDelay;
let activeRoleHeartbeat;
let shutdownDeadlineTimer;

let knownRoleLeaseExpiresAtMs = 0;

function log(
    type,
    details = {},
    error = false,
) {
  const output = JSON.stringify({
    type,
    role: 'SCHEDULER',
    ownerId,
    instanceId,
    pid: process.pid,
    ...details,
  });

  (error ? console.error : console.log)(output);
}

function hasKnownRoleLeaseExpiry() {
  return Number.isFinite(
      knownRoleLeaseExpiresAtMs,
  ) && knownRoleLeaseExpiresAtMs > 0;
}

function noteRoleLeaseExpiry(expiresAt) {
  const parsed = Date.parse(expiresAt || '');

  if (!Number.isFinite(parsed)) return;

  knownRoleLeaseExpiresAtMs = parsed;
}

function noteSuccessfulRoleHeartbeat(
    heartbeatStartedAtMs,
) {
  /*
   * heartbeatRuntimeRole() captures its production timestamp no earlier than
   * this heartbeat attempt. startedAt + leaseMs is therefore a conservative
   * lower bound for the durable lease expiry.
   *
   * Do not use Promise completion time here. A slow storage operation could
   * otherwise make the watchdog believe the lease lasts longer than it does.
   */
  knownRoleLeaseExpiresAtMs =
      heartbeatStartedAtMs + DEFAULT_ROLE_LEASE_MS;
}

function roleLeaseSafetyWindowExhausted(
    nowMs = Date.now(),
) {
  if (!hasKnownRoleLeaseExpiry()) {
    return true;
  }

  return nowMs + ROLE_HEARTBEAT_SAFETY_MARGIN_MS
      >= knownRoleLeaseExpiresAtMs;
}

function armShutdownDeadline(reasonCode) {
  if (shutdownDeadlineTimer) return;

  shutdownDeadlineTimer = setTimeout(() => {
    forcedShutdown = true;
    process.exitCode = 1;

    log(
        'scheduler_shutdown',
        {
          phase: 'drain_timeout',
          signal: shutdownSignal,
          reasonCode,
        },
        true,
    );

    process.exit(1);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS);

  shutdownDeadlineTimer.unref?.();
}

function wakeSchedulerDelay() {
  if (!wakeDelay) return;

  wakeDelay();
}

function requestShutdown(signal) {
  if (stopping) return;

  stopping = true;
  shutdownSignal = signal;

  armShutdownDeadline(
      'SCHEDULER_SHUTDOWN_DRAIN_TIMEOUT',
  );

  log('scheduler_shutdown', {
    phase: 'requested',
    signal,
    reasonCode: 'SCHEDULER_SHUTDOWN_REQUESTED',
  });

  wakeSchedulerDelay();
}

function requestRoleLoss(
    reasonCode,
    details = {},
) {
  if (roleLeaseLost) return;

  roleLeaseLost = true;
  stopping = true;
  shutdownSignal = 'ROLE_LOST';
  process.exitCode = 1;

  armShutdownDeadline(
      'SCHEDULER_ROLE_LOST_DRAIN_TIMEOUT',
  );

  log(
      'scheduler_role_lost',
      {
        reasonCode,
        ...details,
      },
      true,
  );

  wakeSchedulerDelay();
}

function waitForNextTick(ms) {
  if (stopping) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      wakeDelay = undefined;
      resolve();
    }, ms);

    wakeDelay = () => {
      clearTimeout(timer);
      wakeDelay = undefined;
      resolve();
    };
  });
}

function boundedRoleHeartbeat(ownership) {
  if (activeRoleHeartbeat) {
    return Promise.reject(
        new Error('ROLE_HEARTBEAT_IN_FLIGHT'),
    );
  }

  const heartbeatStartedAtMs = Date.now();

  const operation = Promise.resolve()
      .then(() =>
          heartbeatRuntimeRole(
              'SCHEDULER',
              ownership,
          ));

  activeRoleHeartbeat = operation;

  /*
   * Promise.race() does not cancel the real storage operation.
   *
   * Keep the underlying heartbeat tracked until it actually settles so a
   * second heartbeat is never started concurrently.
   *
   * A late false response is authoritative evidence that this scheduler no
   * longer owns the durable role. It must fail closed even if the caller-facing
   * 5-second timeout already fired earlier.
   */
  void operation
      .then(
          renewed => {
            if (renewed) {
              noteSuccessfulRoleHeartbeat(
                  heartbeatStartedAtMs,
              );

              return;
            }

            requestRoleLoss(
                'SCHEDULER_ROLE_LOST',
                {
                  source:
                      'ROLE_HEARTBEAT_LATE_REJECTION',
                },
            );
          },
          () => undefined,
      )
      .finally(() => {
        if (
            activeRoleHeartbeat === operation
        ) {
          activeRoleHeartbeat = undefined;
        }
      });

  let timer;

  const timeout = new Promise(
      (_, reject) => {
        timer = setTimeout(
            () => reject(
                new Error(
                    'ROLE_HEARTBEAT_TIMEOUT',
                ),
            ),
            ROLE_HEARTBEAT_TIMEOUT_MS,
        );

        timer.unref?.();
      },
  );

  return Promise.race([
    operation,
    timeout,
  ]).finally(() => {
    clearTimeout(timer);
  });
}

async function drainActiveRoleHeartbeat() {
  const operation = activeRoleHeartbeat;

  if (!operation) return true;

  let timer;

  const timeout = new Promise(resolve => {
    timer = setTimeout(
        () => resolve(false),
        ROLE_HEARTBEAT_TIMEOUT_MS,
    );

    timer.unref?.();
  });

  const drained = await Promise.race([
    operation.then(
        () => true,
        () => true,
    ),
    timeout,
  ]);

  clearTimeout(timer);

  return drained;
}

process.on(
    'SIGINT',
    () => requestShutdown('SIGINT'),
);

process.on(
    'SIGTERM',
    () => requestShutdown('SIGTERM'),
);

(async () => {
  let releaseIdentity;

  try {
    releaseIdentity =
        validateRuntimeRoleReleaseIdentity(
            'SCHEDULER',
        );

    log(
        'runtime_release_identity_validated',
        {
          releaseId:
          releaseIdentity.releaseId,
          releaseSource:
          releaseIdentity.releaseSource,
          releaseMismatch:
          releaseIdentity.releaseMismatch,
          reasonCode:
              'RELEASE_IDENTITY_VALIDATED',
        },
    );
  } catch (error) {
    log(
        'runtime_release_identity_rejected',
        {
          code:
              error && error.code
                  ? error.code
                  : 'RELEASE_IDENTITY_UNAVAILABLE',

          releaseId:
              error && error.releaseId
                  ? error.releaseId
                  : 'unavailable',

          releaseSource:
              error && error.releaseSource
                  ? error.releaseSource
                  : 'unavailable',

          releaseMismatchReasons:
              error
              && Array.isArray(
                  error.releaseMismatchReasons,
              )
                  ? error.releaseMismatchReasons
                      .slice(0, 12)
                  : [],
        },
        true,
    );

    throw error;
  }

  const acquireRole = () => acquireRuntimeRole({
    role: 'SCHEDULER',
    ownerId,
    instanceId,
    hostname,
    pid: process.pid,
    processStartedAt,
    releaseId: releaseIdentity.releaseId,
  });

  let role = await acquireRole();
  while (
      !role.acquired
      || !role.ownership
  ) {
    log(
        'scheduler_role_rejected',
        {
          code:
              'SCHEDULER_ROLE_ALREADY_ACTIVE',

          activeOwnerId:
          role.lease.ownerId,

          activeInstanceId:
          role.lease.instanceId,

          leaseExpiresAt:
          role.lease.expiresAt,

          fencingToken:
          role.lease.fencingToken,
        },
        true,
    );

    if (once) {
      process.exitCode = 1;
      return;
    }
    // Contention is expected for a standby. Retry through the same durable
    // acquisition gate; never tick or renew the incumbent's lease.
    await waitForNextTick(30_000);
    if (stopping) return;
    role = await acquireRole();
  }

  const ownership = role.ownership;

  noteRoleLeaseExpiry(
      role.lease.leaseExpiresAt
      || role.lease.expiresAt,
  );

  /*
   * Defensive fallback only.
   *
   * A successfully acquired role should always contain a valid expiry.
   * Invalid metadata must never disable fail-closed behavior.
   */
  if (!hasKnownRoleLeaseExpiry()) {
    knownRoleLeaseExpiresAtMs =
        Date.now() + DEFAULT_ROLE_LEASE_MS;
  }

  if (
      role.event === 'TAKEN_OVER'
      && role.staleLease
  ) {
    log(
        'scheduler_role_stale_detected',
        {
          staleOwnerId:
          role.staleLease.ownerId,

          staleInstanceId:
          role.staleLease.instanceId,

          staleHeartbeatAt:
          role.staleLease.heartbeatAt,

          staleLeaseExpiresAt:
          role.staleLease.expiresAt,
        },
    );

    log(
        'scheduler_role_taken_over',
        {
          previousOwnerId:
          role.staleLease.ownerId,

          previousInstanceId:
          role.staleLease.instanceId,

          fencingToken:
          ownership.fencingToken,

          leaseExpiresAt:
              new Date(
                  knownRoleLeaseExpiresAtMs,
              ).toISOString(),
        },
    );
  } else {
    log(
        'scheduler_role_acquired',
        {
          acquiredAt:
          role.lease.acquiredAt,

          leaseExpiresAt:
              new Date(
                  knownRoleLeaseExpiresAtMs,
              ).toISOString(),

          fencingToken:
          ownership.fencingToken,
        },
    );
  }

  let heartbeatBusy = false;
  let heartbeatFailures = 0;

  /*
   * Independent fail-closed watchdog.
   *
   * If the real heartbeat Promise remains hung after the caller-facing
   * timeout, activeRoleHeartbeat deliberately blocks another concurrent role
   * mutation. This watchdog guarantees shutdown before the last confirmed
   * durable lease enters its unsafe window.
   */
  const roleHeartbeatWatchdog =
      setInterval(() => {
        if (
            stopping
            || roleLeaseLost
        ) {
          return;
        }

        if (
            !roleLeaseSafetyWindowExhausted()
        ) {
          return;
        }

        requestRoleLoss(
            'SCHEDULER_ROLE_LEASE_SAFETY_WINDOW_EXHAUSTED',
            {
              source:
                  'ROLE_HEARTBEAT_WATCHDOG',

              activeHeartbeat:
                  Boolean(activeRoleHeartbeat),

              consecutiveFailures:
              heartbeatFailures,

              leaseExpiresAt:
                  hasKnownRoleLeaseExpiry()
                      ? new Date(
                          knownRoleLeaseExpiresAtMs,
                      ).toISOString()
                      : 'unknown',

              safetyMarginMs:
              ROLE_HEARTBEAT_SAFETY_MARGIN_MS,
            },
        );
      }, ROLE_HEARTBEAT_WATCHDOG_INTERVAL_MS);

  roleHeartbeatWatchdog.unref?.();

  const roleHeartbeat =
      setInterval(() => {
        if (
            stopping
            || heartbeatBusy
            || activeRoleHeartbeat
        ) {
          return;
        }

        heartbeatBusy = true;

        void boundedRoleHeartbeat(
            ownership,
        )
            .then(renewed => {
              if (renewed) {
                heartbeatFailures = 0;

                log(
                    'scheduler_role_heartbeat',
                    {
                      fencingToken:
                      ownership.fencingToken,

                      leaseExpiresAt:
                          hasKnownRoleLeaseExpiry()
                              ? new Date(
                                  knownRoleLeaseExpiresAtMs,
                              ).toISOString()
                              : 'unknown',
                    },
                );

                return;
              }

              heartbeatFailures += 1;

              /*
               * A clean false response is authoritative.
               *
               * The durable role no longer belongs to this scheduler, so
               * fail closed immediately.
               */
              requestRoleLoss(
                  'SCHEDULER_ROLE_LOST',
                  {
                    source:
                        'ROLE_HEARTBEAT_REJECTED',

                    consecutiveFailures:
                    heartbeatFailures,
                  },
              );
            })
            .catch(error => {
              heartbeatFailures += 1;

              const reasonCode =
                  error instanceof Error
                      ? error.message
                      : 'UNKNOWN_ERROR';

              log(
                  'scheduler_tick_failed',
                  {
                    code:
                        'SCHEDULER_HEARTBEAT_FAILED',

                    message:
                    reasonCode,

                    consecutiveFailures:
                    heartbeatFailures,

                    activeHeartbeat:
                        Boolean(
                            activeRoleHeartbeat,
                        ),

                    leaseExpiresAt:
                        hasKnownRoleLeaseExpiry()
                            ? new Date(
                                knownRoleLeaseExpiresAtMs,
                            ).toISOString()
                            : 'unknown',
                  },
                  true,
              );

              /*
               * Two independently failed attempts cause immediate fail-closed.
               *
               * If the first real storage operation never settles, no second
               * heartbeat is started concurrently. The watchdog handles that
               * case before the last confirmed lease becomes unsafe.
               */
              if (
                  heartbeatFailures >= 2
              ) {
                requestRoleLoss(
                    'SCHEDULER_ROLE_LOST',
                    {
                      source:
                      reasonCode,

                      consecutiveFailures:
                      heartbeatFailures,
                    },
                );
              }
            })
            .finally(() => {
              heartbeatBusy = false;
            });
      }, ROLE_HEARTBEAT_INTERVAL_MS);

  roleHeartbeat.unref?.();

  let lastLogAt = 0;
  let previousState = '';

  try {
    do {
      try {
        const cycle =
            await runOwnedSchedulerCycle(
                ownership,
            );

        if (
            cycle.status === 'role_lost'
        ) {
          log(
              'scheduler_tick_failed',
              {
                code:
                    'SCHEDULER_ROLE_LOST',

                message:
                    'Scheduler cycle stopped before enqueue because leadership was lost.',
              },
              true,
          );

          requestRoleLoss(
              'SCHEDULER_ROLE_LOST',
              {
                source:
                    'OWNED_SCHEDULER_CYCLE',
              },
          );

          break;
        }

        const {
          guardian,
          reconciliation,
          automation,
          intelligence,
        } = cycle;

        const state =
            `${guardian.status}:`
            + `${reconciliation.status}:`
            + `${automation.status}:`
            + `${intelligence.status}`;

        const now = Date.now();

        if (
            once
            || state !== previousState
            || guardian.status === 'scheduled'
            || reconciliation.status === 'scheduled'
            || automation.status === 'scheduled'
            || intelligence.scheduled > 0
            || now - lastLogAt >= 5 * 60_000
        ) {
          log(
              'scheduler_tick',
              {
                guardian,
                reconciliation,
                automation,
                intelligence,
              },
          );

          lastLogAt = now;
          previousState = state;
        }
      } catch (error) {
        const reasonCode =
            error instanceof Error
                ? error.message
                : 'unknown_error';

        log(
            'scheduler_tick_failed',
            {
              code:
                  'SCHEDULER_TICK_FAILED',

              message:
              reasonCode,
            },
            true,
        );

        if (
            reasonCode.includes(
                'ROLE_FENCE_LOST',
            )
            || reasonCode.includes(
                'WORKER_FENCING_REJECTED',
            )
            || reasonCode.includes(
                'SCHEDULER_ROLE_LOST',
            )
        ) {
          requestRoleLoss(
              'SCHEDULER_ROLE_LOST',
              {
                source:
                    'SCHEDULER_TICK_FAILED',

                detail:
                reasonCode,
              },
          );

          break;
        }

        if (once) {
          process.exitCode = 1;
        }
      }

      if (
          !once
          && !stopping
      ) {
        await waitForNextTick(
            30_000,
        );
      }
    } while (
        !once
        && !stopping
        );
  } finally {
    stopping = true;

    wakeSchedulerDelay();

    clearInterval(
        roleHeartbeat,
    );

    clearInterval(
        roleHeartbeatWatchdog,
    );

    const roleHeartbeatDrained =
        await drainActiveRoleHeartbeat();

    if (!roleHeartbeatDrained) {
      forcedShutdown = true;
      process.exitCode = 1;

      log(
          'scheduler_role_heartbeat_drain_failed',
          {
            reasonCode:
                'ROLE_HEARTBEAT_DRAIN_TIMEOUT',
          },
          true,
      );
    }

    let released = false;

    /*
     * Never release authority after this process has concluded that the
     * SCHEDULER role was lost.
     */
    if (
        roleHeartbeatDrained
        && !roleLeaseLost
        && !forcedShutdown
    ) {
      try {
        released =
            await releaseRuntimeRole(
                'SCHEDULER',
                ownership,
            );

        if (released) {
          log(
              'scheduler_role_released',
              {
                fencingToken:
                ownership.fencingToken,
              },
          );
        }
      } catch (error) {
        process.exitCode = 1;

        log(
            'scheduler_role_release_failed',
            {
              reasonCode:
                  error instanceof Error
                      ? error.message
                      : 'UNKNOWN_ERROR',
            },
            true,
        );
      }
    }

    if (shutdownDeadlineTimer) {
      clearTimeout(
          shutdownDeadlineTimer,
      );

      shutdownDeadlineTimer =
          undefined;
    }

    log(
        'scheduler_shutdown',
        {
          phase:
              'completed',

          signal:
          shutdownSignal,

          released,

          roleHeartbeatDrained,

          roleLeaseLost,

          forced:
          forcedShutdown,

          reasonCode:
              forcedShutdown
                  ? 'SCHEDULER_SHUTDOWN_DRAIN_TIMEOUT'
                  : roleLeaseLost
                      ? 'SCHEDULER_ROLE_LOST'
                      : 'SCHEDULER_SHUTDOWN_COMPLETED',
        },
        forcedShutdown || roleLeaseLost,
    );

    if (forcedShutdown) {
      setImmediate(
          () => process.exit(1),
      );
    }
  }
})().catch(error => {
  log(
      'scheduler_tick_failed',
      {
        code:
            'SCHEDULER_FATAL',

        message:
            error instanceof Error
                ? error.message
                : 'unknown_error',
      },
      true,
  );

  process.exitCode = 1;
});
