/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');

const crypto = require('node:crypto');
const os = require('node:os');

const {
    processAutomationBatch,
    runContinuousWorkerPool,
} = require('../src/lib/automation/worker.ts');

const {
    getAutomationSettings,
} = require('../src/lib/storage/automationSettings.ts');

const {
    acquireRuntimeRole,
    heartbeatRuntimeRole,
    releaseRuntimeRole,
    DEFAULT_ROLE_LEASE_MS,
} = require('../src/lib/automation/runtimeRoles.ts');

const {
    isContinuousWorkerPoolEnabled,
    isCriticalWorkerSchedulingEnabled,
} = require('../src/lib/automation/featureRollout.ts');

const {
    validateRuntimeRoleReleaseIdentity,
} = require('../src/lib/releaseIdentity.ts');

const hostname = os.hostname();
const workerId = `worker:${hostname}`;
const instanceId =
    `${workerId}:${process.pid}:${crypto.randomUUID()}`;

const processStartedAt = new Date(
    Date.now() - Math.floor(process.uptime() * 1_000),
).toISOString();

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
const WORKER_TICK_BACKOFF_BASE_MS = 5_000;
const WORKER_TICK_BACKOFF_MAX_MS = 30_000;

let stopping = false;
let roleLeaseLost = false;
let forcedShutdown = false;

let activeRoleHeartbeat;
let shutdownDeadlineTimer;

let knownRoleLeaseExpiresAtMs = 0;

const shutdownController = new AbortController();

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
     * heartbeatRuntimeRole() captures its production timestamp only after the
     * durable role transaction has gained authority over ROLE_COLLECTION.
     *
     * Therefore heartbeatStartedAtMs + leaseMs is a conservative lower bound
     * for the actual durable expiry.
     *
     * Never use Promise completion time here. A slow storage operation could
     * otherwise make the local watchdog believe the lease lasts longer than
     * the durable lease actually does.
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

function requestRoleLoss(
    reasonCode,
    details = {},
) {
    if (roleLeaseLost) return;

    roleLeaseLost = true;
    stopping = true;
    process.exitCode = 1;

    shutdownController.abort(
        'WORKER_FENCING_REJECTED',
    );

    armShutdownDeadline(
        'WORKER_ROLE_LOST_DRAIN_TIMEOUT',
    );

    console.error(JSON.stringify({
        type: 'worker_role_lost',
        workerId: instanceId,
        reasonCode,
        ...details,
    }));
}

/*
 * Keep these registrations in this exact single-line form because the
 * regression suite verifies that both shutdown signals remain wired.
 */
process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

function wait(milliseconds, signal) {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve('aborted');
            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener(
                'abort',
                onAbort,
            );

            resolve('elapsed');
        }, Math.max(
            0,
            Number(milliseconds) || 0,
        ));

        const onAbort = () => {
            clearTimeout(timer);
            resolve('aborted');
        };

        signal?.addEventListener(
            'abort',
            onAbort,
            { once: true },
        );
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
                'WORKER',
                ownership,
            ));

    activeRoleHeartbeat = operation;

    /*
     * Promise.race() does not cancel the real storage operation.
     *
     * Keep the underlying operation tracked until it settles, preventing two
     * concurrent role heartbeat transactions.
     *
     * A late false is authoritative evidence that the durable WORKER role is
     * no longer owned by this process.
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
                    'WORKER_FENCING_REJECTED',
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

async function waitForWorkerRole(releaseId) {
    let lastConflictLogAt = 0;

    while (!stopping) {
        const result = await acquireRuntimeRole({
            role: 'WORKER',
            ownerId: workerId,
            instanceId,
            hostname,
            pid: process.pid,
            processStartedAt,
            releaseId,
        });

        if (
            result.acquired
            && result.ownership
        ) {
            return result;
        }

        const now = Date.now();

        if (
            now - lastConflictLogAt
            >= 60_000
        ) {
            console.warn(JSON.stringify({
                type: 'worker_role_wait',
                workerId: instanceId,
                reasonCode:
                    result.reason
                    || 'ROLE_ALREADY_ACTIVE',
                activeHolderId:
                result.lease.holderId,
                activeInstanceId:
                result.lease.instanceId,
                leaseExpiresAt:
                result.lease.leaseExpiresAt,
            }));

            lastConflictLogAt = now;
        }

        /*
         * A one-shot probe reports the live owner without waiting for expiry.
         */
        if (once) return null;

        const expiresIn =
            Date.parse(
                result.lease.leaseExpiresAt || '',
            ) - now;

        const delayMs = Math.max(
            1_000,
            Math.min(
                15_000,
                Number.isFinite(expiresIn)
                    ? expiresIn + 250
                    : 5_000,
            ),
        );

        await wait(
            delayMs,
            shutdownController.signal,
        );
    }

    return null;
}

(async () => {
    let releaseIdentity;

    try {
        releaseIdentity =
            validateRuntimeRoleReleaseIdentity(
                'WORKER',
            );

        console.log(JSON.stringify({
            type: 'runtime_release_identity_validated',
            role: 'WORKER',
            releaseId:
            releaseIdentity.releaseId,
            releaseSource:
            releaseIdentity.releaseSource,
            releaseMismatch:
            releaseIdentity.releaseMismatch,
            reasonCode:
                'RELEASE_IDENTITY_VALIDATED',
        }));
    } catch (error) {
        console.error(JSON.stringify({
            type:
                'runtime_release_identity_rejected',
            role: 'WORKER',
            reasonCode:
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
        }));

        throw error;
    }

    const role = await waitForWorkerRole(
        releaseIdentity.releaseId,
    );

    if (!role?.ownership) {
        if (shutdownDeadlineTimer) {
            clearTimeout(
                shutdownDeadlineTimer,
            );
        }

        return;
    }

    const ownership = role.ownership;

    noteRoleLeaseExpiry(
        role.lease.leaseExpiresAt
        || role.lease.expiresAt,
    );

    /*
     * Defensive fallback only. A correctly acquired role should always contain
     * a valid expiry. Invalid metadata must never disable fail-closed behavior.
     */
    if (!hasKnownRoleLeaseExpiry()) {
        knownRoleLeaseExpiresAtMs =
            Date.now() + DEFAULT_ROLE_LEASE_MS;
    }

    console.log(JSON.stringify({
        type: 'worker_role_acquired',
        workerId: instanceId,
        reasonCode:
            role.event || 'ACQUIRED',
        fencingToken:
        ownership.fencingToken,
        takeoverCount:
        role.lease.takeoverCount,
        releaseId:
        role.lease.releaseId,
        leaseExpiresAt:
            new Date(
                knownRoleLeaseExpiresAtMs,
            ).toISOString(),
    }));

    let roleHeartbeatBusy = false;
    let roleHeartbeatFailures = 0;

    /*
     * Independent role lease watchdog.
     *
     * If the real storage heartbeat hangs after the caller-facing timeout,
     * activeRoleHeartbeat deliberately prevents a second concurrent heartbeat.
     * This watchdog guarantees fail-closed before the last confirmed role lease
     * enters its unsafe window.
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
                'WORKER_ROLE_LEASE_SAFETY_WINDOW_EXHAUSTED',
                {
                    source:
                        'ROLE_HEARTBEAT_WATCHDOG',
                    activeHeartbeat:
                        Boolean(activeRoleHeartbeat),
                    consecutiveFailures:
                    roleHeartbeatFailures,
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
                roleHeartbeatBusy
                || activeRoleHeartbeat
                || stopping
            ) {
                return;
            }

            roleHeartbeatBusy = true;

            void boundedRoleHeartbeat(
                ownership,
            )
                .then(renewed => {
                    if (renewed) {
                        roleHeartbeatFailures = 0;
                        return;
                    }

                    roleHeartbeatFailures += 1;

                    /*
                     * A clean false is authoritative: this instance no longer owns
                     * the durable WORKER role.
                     */
                    requestRoleLoss(
                        'WORKER_FENCING_REJECTED',
                        {
                            consecutiveFailures:
                            roleHeartbeatFailures,
                            source:
                                'ROLE_HEARTBEAT_REJECTED',
                        },
                    );
                })
                .catch(error => {
                    roleHeartbeatFailures += 1;

                    const reasonCode =
                        error instanceof Error
                            ? error.message
                            : 'UNKNOWN_ERROR';

                    console.error(JSON.stringify({
                        type:
                            'worker_role_heartbeat_failed',
                        workerId: instanceId,
                        reasonCode,
                        consecutiveFailures:
                        roleHeartbeatFailures,
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
                    }));

                    /*
                     * Two independently failed attempts fail closed immediately.
                     *
                     * If the first underlying operation never settles, another
                     * heartbeat is not started concurrently; the independent
                     * watchdog handles that case.
                     */
                    if (
                        roleHeartbeatFailures >= 2
                    ) {
                        requestRoleLoss(
                            'WORKER_FENCING_REJECTED',
                            {
                                consecutiveFailures:
                                roleHeartbeatFailures,
                                source: reasonCode,
                            },
                        );
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
                const settings =
                    await getAutomationSettings();

                const concurrency = Math.max(
                    1,
                    Math.min(
                        4,
                        Number(
                            settings.maxConcurrency,
                        ) || 1,
                    ),
                );

                const criticalSchedulingActive =
                    isCriticalWorkerSchedulingEnabled();

                const continuousPoolActive =
                    isContinuousWorkerPoolEnabled()
                    || criticalSchedulingActive;

                result = continuousPoolActive
                    ? await runContinuousWorkerPool({
                        workerId: instanceId,
                        ownership,
                        maxConcurrency: concurrency,

                        maximumClaims: Math.max(
                            1,
                            Math.min(
                                50,
                                Number(
                                    settings.maxItemsPerRun,
                                ) || concurrency,
                            ),
                        ),

                        criticalReservedCapacity:
                            concurrency > 1 ? 1 : 0,

                        priorityScheduling:
                            criticalSchedulingActive
                                ? 'ALL_CRITICAL'
                                : 'RUNTIME_GUARDIAN_ONLY',

                        shouldStop:
                            () =>
                                stopping
                                || roleLeaseLost,

                        shutdownSignal:
                        shutdownController.signal,

                        drainTimeoutMs:
                        SHUTDOWN_DRAIN_TIMEOUT_MS,
                    })
                    : await processAutomationBatch(
                        instanceId,
                        concurrency,
                        ownership,
                        {
                            shutdownSignal:
                            shutdownController.signal,
                        },
                    );

                tickFailureCount = 0;

                if (
                    continuousPoolActive
                    && !result.drained
                ) {
                    forcedShutdown = true;

                    console.error(JSON.stringify({
                        type: 'worker_shutdown',
                        workerId: instanceId,
                        phase: 'drain_timeout',
                        peakInFlight:
                            Math.max(
                                0,
                                result.peakInFlight,
                            ),
                        reasonCode:
                            'WORKER_SHUTDOWN_DRAIN_TIMEOUT',
                    }));

                    break;
                }
            } catch (error) {
                const reasonCode =
                    error instanceof Error
                        ? error.message
                        : 'UNKNOWN_ERROR';

                console.error(JSON.stringify({
                    type: 'worker_tick_failed',
                    workerId: instanceId,
                    reasonCode,
                }));

                if (
                    reasonCode.includes(
                        'WORKER_FENCING_REJECTED',
                    )
                    || reasonCode.includes(
                        'ROLE_FENCE_LOST',
                    )
                ) {
                    requestRoleLoss(
                        'WORKER_FENCING_REJECTED',
                        {
                            source:
                                'WORKER_TICK_FAILED',
                            detail: reasonCode,
                        },
                    );

                    break;
                }

                tickFailureCount += 1;

                if (
                    !once
                    && !stopping
                ) {
                    const exponent = Math.min(
                        4,
                        Math.max(
                            0,
                            tickFailureCount - 1,
                        ),
                    );

                    const baseDelayMs = Math.min(
                        WORKER_TICK_BACKOFF_MAX_MS,
                        WORKER_TICK_BACKOFF_BASE_MS
                        * 2 ** exponent,
                    );

                    const jitterMs = Math.floor(
                        baseDelayMs
                        * 0.1
                        * Math.random(),
                    );

                    const delayMs = Math.min(
                        WORKER_TICK_BACKOFF_MAX_MS,
                        baseDelayMs + jitterMs,
                    );

                    console.warn(JSON.stringify({
                        type:
                            'worker_retry_backoff_applied',
                        workerId: instanceId,
                        delayMs,
                        consecutiveFailures:
                        tickFailureCount,
                        reasonCode:
                            'WORKER_TICK_FAILED',
                    }));

                    await wait(
                        delayMs,
                        shutdownController.signal,
                    );
                }

                if (once) {
                    throw error;
                }

                continue;
            }

            const now = Date.now();

            if (
                once
                || result.claimed > 0
                || now - lastIdleLogAt
                >= 60_000
            ) {
                console.log(JSON.stringify({
                    type:
                        result.claimed
                            ? 'worker_tick'
                            : 'worker_idle',
                    ...result,
                    idleDelayMs:
                        result.claimed
                            ? 0
                            : idleDelayMs,
                }));

                if (!result.claimed) {
                    lastIdleLogAt = now;
                }
            }

            idleDelayMs = result.claimed
                ? 500
                : Math.min(
                    10_000,
                    Math.ceil(
                        idleDelayMs * 1.6,
                    ),
                );

            if (
                !once
                && !stopping
            ) {
                await wait(
                    idleDelayMs,
                    shutdownController.signal,
                );
            }
        } while (
            !once
            && !stopping
            );
    } finally {
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

            console.error(JSON.stringify({
                type:
                    'worker_role_heartbeat_drain_failed',
                workerId: instanceId,
                reasonCode:
                    'ROLE_HEARTBEAT_DRAIN_TIMEOUT',
            }));
        }

        let released = false;

        /*
         * Never release authority after this process has concluded that the
         * WORKER role was lost.
         */
        if (
            roleHeartbeatDrained
            && !roleLeaseLost
            && !forcedShutdown
        ) {
            try {
                released =
                    await releaseRuntimeRole(
                        'WORKER',
                        ownership,
                    );
            } catch (error) {
                process.exitCode = 1;

                console.error(JSON.stringify({
                    type:
                        'worker_role_release_failed',
                    workerId: instanceId,
                    reasonCode:
                        error instanceof Error
                            ? error.message
                            : 'UNKNOWN_ERROR',
                }));
            }
        }

        if (shutdownDeadlineTimer) {
            clearTimeout(
                shutdownDeadlineTimer,
            );

            shutdownDeadlineTimer =
                undefined;
        }

        console.log(JSON.stringify({
            type:
                'worker_shutdown_drain_completed',
            workerId: instanceId,
            phase: 'completed',
            released,
            roleHeartbeatDrained,
            roleLeaseLost,
            forced: forcedShutdown,

            reasonCode:
                forcedShutdown
                    ? 'WORKER_SHUTDOWN_DRAIN_TIMEOUT'
                    : roleLeaseLost
                        ? 'WORKER_ROLE_LOST'
                        : 'WORKER_SHUTDOWN_COMPLETED',
        }));

        if (forcedShutdown) {
            setImmediate(
                () => process.exit(1),
            );
        }
    }
})().catch(error => {
    console.error(JSON.stringify({
        type: 'worker_failed',
        workerId: instanceId,

        reasonCode:
            error instanceof Error
                ? error.message
                : 'UNKNOWN_ERROR',
    }));

    process.exitCode = 1;
});
