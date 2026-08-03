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
 * Owns exactly one claimed job's renewal timer. It never overlaps renewal
 * attempts and tolerates only one bounded storage failure before failing
 * closed. Timers are injected so lifecycle tests do not need wall-clock waits.
 */
export function startAutomationJobLeaseRenewal(options: {
  leaseMs: number;
  initialLeaseExpiresAt?: string;
  parentSignal?: AbortSignal;
  renew: () => Promise<AutomationJobLeaseRenewalAttempt>;
  onAuthorityLost: (reasonCode: AutomationJobLeaseLossReason) => void;
  onEvent?: (event: AutomationJobLeaseRenewalEvent, input: {
    reasonCode: string;
    consecutiveFailures: number;
    delayMs?: number;
    leaseExpiresAt?: string;
  }) => void;
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
  ) => options.onEvent?.(event, {
    reasonCode,
    consecutiveFailures,
    ...(delayMs === undefined ? {} : { delayMs }),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
  });

  const clearScheduledTimer = () => {
    if (timer === undefined) return;
    runtime.clearTimeout(timer);
    timer = undefined;
  };

  const onParentAbort = () => {
    stopped = true;
    clearScheduledTimer();
  };

  const loseAuthority = (reasonCode: AutomationJobLeaseLossReason) => {
    if (authorityLost || stopped) return;
    authorityLost = true;
    authorityLostReason = reasonCode;
    stopped = true;
    clearScheduledTimer();
    options.parentSignal?.removeEventListener('abort', onParentAbort);
    emit('job_ownership_lost', reasonCode);
    options.onAuthorityLost(reasonCode);
  };

  const schedule = (delayMs: number) => {
    if (stopped || options.parentSignal?.aborted) return;
    clearScheduledTimer();
    const boundedDelayMs = Math.max(1, Math.floor(delayMs));
    timer = runtime.setTimeout(() => {
      timer = undefined;
      if (stopped || inFlight || options.parentSignal?.aborted) return;
      const attempt = async () => {
        try {
          const renewal = await options.renew();
          if (stopped) return;
          if (!renewal.renewed) {
            emit('job_lease_renewal_failed', renewal.reasonCode || 'JOB_CLAIM_MISSING');
            loseAuthority(renewal.reasonCode || 'JOB_CLAIM_MISSING');
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
            emit('job_lease_renewed', 'JOB_LEASE_RENEWED', undefined, renewal.leaseExpiresAt);
          }
          const jitterMs = Math.floor(intervalMs * 0.1 * Math.max(0, Math.min(1, runtime.random())));
          const remainingSafeMs = knownLeaseExpiresAt - nowMs - safetyMarginMs;
          if (remainingSafeMs <= 0) {
            loseAuthority('JOB_LEASE_EXPIRED');
            return;
          }
          schedule(Math.min(intervalMs + jitterMs, Math.max(1, remainingSafeMs)));
        } catch {
          if (stopped) return;
          consecutiveFailures += 1;
          emit('job_lease_renewal_failed', 'JOB_LEASE_RENEWAL_STORAGE_FAILURE');
          const retryBaseMs = Math.max(10, Math.min(1_000, Math.floor(intervalMs / 4)));
          const retryDelayMs = Math.max(1, Math.min(
            intervalMs,
            retryBaseMs * 2 ** Math.max(0, consecutiveFailures - 1),
          ));
          const remainingSafeMs = knownLeaseExpiresAt - runtime.now() - safetyMarginMs;
          if (consecutiveFailures >= 2 || retryDelayMs >= remainingSafeMs) {
            loseAuthority('JOB_LEASE_RENEWAL_STORAGE_FAILURE');
            return;
          }
          emit('worker_retry_backoff_applied', 'JOB_LEASE_RENEWAL_TRANSIENT_FAILURE', retryDelayMs);
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

  if (options.parentSignal?.aborted) onParentAbort();
  else options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  emit('job_lease_renewal_started', 'JOB_LEASE_RENEWAL_STARTED', intervalMs, new Date(knownLeaseExpiresAt).toISOString());
  schedule(intervalMs);

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
