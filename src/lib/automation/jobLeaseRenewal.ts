export type AutomationJobLeaseLossReason =
    | 'WORKER_ROLE_LOST'
    | 'JOB_NOT_RUNNING'
    | 'JOB_CLAIM_MISSING'
    | 'JOB_CLAIM_TOKEN_MISMATCH'
    | 'JOB_WORKER_MISMATCH'
    | 'JOB_FENCING_MISMATCH'
    | 'JOB_LEASE_EXPIRED'
    | 'JOB_LEASE_RENEWAL_STORAGE_FAILURE';

export interface AutomationJobLeaseRenewalAttempt {
  renewed: boolean;
  reasonCode?: AutomationJobLeaseLossReason;
  leaseExpiresAt?: string;
}

export interface AutomationJobLeaseRenewalRuntime {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export type AutomationJobLeaseRenewalEvent =
    | 'job_lease_renewal_started'
    | 'job_lease_renewed'
    | 'job_lease_renewal_failed'
    | 'job_ownership_lost'
    | 'worker_retry_backoff_applied';

export interface AutomationJobLeaseRenewalEventInput {
  reasonCode: string;
  consecutiveFailures: number;
  delayMs?: number;
  leaseExpiresAt?: string;
  errorCode?: string;
}

export interface AutomationJobLeaseRenewalHandle {
  readonly authorityLost: boolean;
  readonly authorityLostReason?: AutomationJobLeaseLossReason;
  stop(): Promise<void>;
}

const defaultRuntime: AutomationJobLeaseRenewalRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timer => clearTimeout(timer),
};

function normalizeRuntimeRandom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function classifyLeaseRenewalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/WORKER_FENCING_REJECTED|ROLE_FENCE_LOST|ROLE_AUTHORITY/i.test(message)) {
    return 'ROLE_AUTHORITY_FAILURE';
  }
  if (/LOCK_TIMEOUT|LOCK TIMEOUT|TIMED OUT WAITING FOR.*LOCK/i.test(message)) {
    return 'STORAGE_LOCK_TIMEOUT';
  }
  if (/EACCES|EPERM|PERMISSION DENIED/i.test(message)) {
    return 'STORAGE_PERMISSION_DENIED';
  }
  if (/ENOSPC|NO SPACE LEFT/i.test(message)) {
    return 'STORAGE_NO_SPACE';
  }
  if (/EROFS|READ-ONLY FILE SYSTEM/i.test(message)) {
    return 'STORAGE_READ_ONLY';
  }
  if (/ENOENT|FILE NOT FOUND|NO SUCH FILE/i.test(message)) {
    return 'STORAGE_FILE_MISSING';
  }
  if (/JSON|SERIALIZ|PARSE|UNEXPECTED TOKEN/i.test(message)) {
    return 'STORAGE_SERIALIZATION_FAILURE';
  }
  if (/EIO|INPUT\/OUTPUT|I\/O ERROR/i.test(message)) {
    return 'STORAGE_IO_FAILURE';
  }
  return 'STORAGE_UNKNOWN_FAILURE';
}

export function normalizeAutomationJobLeaseMs(value: number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
      ? Math.max(30, Math.min(5 * 60_000, Math.floor(parsed)))
      : 60_000;
}

export function automationJobLeaseRenewalIntervalMs(leaseMs: number): number {
  const effectiveLeaseMs = normalizeAutomationJobLeaseMs(leaseMs);
  return Math.max(10, Math.min(20_000, Math.floor(effectiveLeaseMs / 3)));
}

/**
 * Owns exactly one claimed job's renewal timer. Renewal attempts never overlap.
 * Transient storage failures are retried with bounded exponential backoff only
 * while the last confirmed lease still has a safe validity window. Authority
 * is failed closed before that safe window is exhausted.
 */
export function startAutomationJobLeaseRenewal(options: {
  leaseMs: number;
  initialLeaseExpiresAt?: string;
  parentSignal?: AbortSignal;
  renew: () => Promise<AutomationJobLeaseRenewalAttempt>;
  onAuthorityLost: (reasonCode: AutomationJobLeaseLossReason) => void;
  onEvent?: (
      event: AutomationJobLeaseRenewalEvent,
      input: AutomationJobLeaseRenewalEventInput,
  ) => void;
  runtime?: AutomationJobLeaseRenewalRuntime;
  successLogEveryMs?: number;
}): AutomationJobLeaseRenewalHandle {
  const runtime = options.runtime || defaultRuntime;
  const leaseMs = normalizeAutomationJobLeaseMs(options.leaseMs);
  const intervalMs = automationJobLeaseRenewalIntervalMs(leaseMs);
  const safetyMarginMs = Math.max(5, Math.min(5_000, Math.floor(leaseMs / 6)));
  const successLogEveryMs = Math.max(leaseMs, options.successLogEveryMs || 5 * 60_000);
  const parsedInitialExpiry = Date.parse(options.initialLeaseExpiresAt || '');

  let knownLeaseExpiresAt = Number.isFinite(parsedInitialExpiry)
      ? parsedInitialExpiry
      : runtime.now() + leaseMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let authorityLost = false;
  let authorityLostReason: AutomationJobLeaseLossReason | undefined;
  let consecutiveFailures = 0;
  let lastSuccessLogAt = 0;

  const emit = (
      event: AutomationJobLeaseRenewalEvent,
      reasonCode: string,
      delayMs?: number,
      leaseExpiresAt?: string,
      errorCode?: string,
  ): void => {
    if (!options.onEvent) return;
    try {
      options.onEvent(event, {
        reasonCode,
        consecutiveFailures,
        ...(delayMs === undefined ? {} : { delayMs }),
        ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Diagnostics must never change lease ownership or timer behavior.
    }
  };

  const clearScheduledTimer = (): void => {
    if (timer === undefined) return;
    runtime.clearTimeout(timer);
    timer = undefined;
  };

  const onParentAbort = (): void => {
    stopped = true;
    clearScheduledTimer();
  };

  const loseAuthority = (
      reasonCode: AutomationJobLeaseLossReason,
      errorCode?: string,
  ): void => {
    if (authorityLost || stopped) return;
    authorityLost = true;
    authorityLostReason = reasonCode;
    stopped = true;
    clearScheduledTimer();
    options.parentSignal?.removeEventListener('abort', onParentAbort);
    emit('job_ownership_lost', reasonCode, undefined, undefined, errorCode);
    options.onAuthorityLost(reasonCode);
  };

  const schedule = (delayMs: number): void => {
    if (stopped || options.parentSignal?.aborted) return;
    clearScheduledTimer();

    const boundedDelayMs = Math.max(1, Math.floor(delayMs));
    timer = runtime.setTimeout(() => {
      timer = undefined;
      if (stopped || inFlight || options.parentSignal?.aborted) return;

      const attempt = async (): Promise<void> => {
        try {
          const renewal = await options.renew();
          if (stopped) return;

          if (!renewal.renewed) {
            const reasonCode = renewal.reasonCode || 'JOB_CLAIM_MISSING';
            emit('job_lease_renewal_failed', reasonCode);
            loseAuthority(reasonCode);
            return;
          }

          consecutiveFailures = 0;
          const renewedExpiry = Date.parse(renewal.leaseExpiresAt || '');
          knownLeaseExpiresAt = Number.isFinite(renewedExpiry)
              ? renewedExpiry
              : runtime.now() + leaseMs;

          const nowMs = runtime.now();
          if (!lastSuccessLogAt || nowMs - lastSuccessLogAt >= successLogEveryMs) {
            lastSuccessLogAt = nowMs;
            emit(
                'job_lease_renewed',
                'JOB_LEASE_RENEWED',
                undefined,
                renewal.leaseExpiresAt,
            );
          }

          const jitterMs = Math.floor(
              intervalMs * 0.1 * normalizeRuntimeRandom(runtime.random()),
          );
          const remainingSafeMs = knownLeaseExpiresAt - nowMs - safetyMarginMs;
          if (remainingSafeMs <= 0) {
            loseAuthority('JOB_LEASE_EXPIRED');
            return;
          }

          schedule(Math.min(intervalMs + jitterMs, Math.max(1, remainingSafeMs)));
        } catch (error) {
          if (stopped) return;

          consecutiveFailures += 1;
          const errorCode = classifyLeaseRenewalError(error);
          emit(
              'job_lease_renewal_failed',
              'JOB_LEASE_RENEWAL_STORAGE_FAILURE',
              undefined,
              undefined,
              errorCode,
          );

          const retryBaseMs = Math.max(
              10,
              Math.min(1_000, Math.floor(intervalMs / 4)),
          );
          const exponent = Math.min(8, Math.max(0, consecutiveFailures - 1));
          const retryDelayMs = Math.max(
              1,
              Math.min(intervalMs, retryBaseMs * 2 ** exponent),
          );
          const remainingSafeMs = knownLeaseExpiresAt
              - runtime.now()
              - safetyMarginMs;

          if (remainingSafeMs <= 0 || retryDelayMs >= remainingSafeMs) {
            loseAuthority('JOB_LEASE_RENEWAL_STORAGE_FAILURE', errorCode);
            return;
          }

          emit(
              'worker_retry_backoff_applied',
              'JOB_LEASE_RENEWAL_TRANSIENT_FAILURE',
              retryDelayMs,
              undefined,
              errorCode,
          );
          schedule(retryDelayMs);
        }
      };

      inFlight = attempt().finally(() => {
        inFlight = undefined;
      });
      void inFlight.catch(() => undefined);
    }, boundedDelayMs);

    timer.unref?.();
  };

  if (options.parentSignal?.aborted) {
    onParentAbort();
  } else {
    options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  emit(
      'job_lease_renewal_started',
      'JOB_LEASE_RENEWAL_STARTED',
      intervalMs,
      new Date(knownLeaseExpiresAt).toISOString(),
  );

  const initialRemainingSafeMs = knownLeaseExpiresAt
      - runtime.now()
      - safetyMarginMs;
  if (initialRemainingSafeMs <= 0) {
    loseAuthority('JOB_LEASE_EXPIRED');
  } else {
    schedule(Math.min(intervalMs, initialRemainingSafeMs));
  }

  return {
    get authorityLost() {
      return authorityLost;
    },
    get authorityLostReason() {
      return authorityLostReason;
    },
    async stop() {
      stopped = true;
      clearScheduledTimer();
      options.parentSignal?.removeEventListener('abort', onParentAbort);
      await inFlight?.catch(() => undefined);
    },
  };
}
