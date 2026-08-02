import type { AutomationJobType } from './types';

export type AutomationExecutionAbortCode =
  | 'HANDLER_TIMEOUT'
  | 'WORKER_FENCING_REJECTED'
  | 'JOB_CANCELLED'
  | 'KILL_SWITCH_ACTIVE'
  | 'WORKER_SHUTDOWN_REQUESTED'
  | 'STORAGE_LOCK_CONTENTION';

export class AutomationExecutionAborted extends Error {
  readonly code: AutomationExecutionAbortCode;

  constructor(code: AutomationExecutionAbortCode, message = code) {
    super(message);
    this.name = 'AutomationExecutionAborted';
    this.code = code;
  }
}

export interface AutomationExecutionBudget {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly timeoutMs: number;
  abort(code: AutomationExecutionAbortCode): void;
  throwIfAborted(): void;
  dispose(): void;
}

const DEFAULT_TIMEOUTS: Partial<Record<AutomationJobType, number>> = {
  PROCESS_CANDIDATE: 15 * 60_000,
  RECHECK_PRODUCT_HEALTH: 8 * 60_000,
  EVALUATE_ALERTS: 5 * 60_000,
  RUNTIME_GUARDIAN: 2 * 60_000,
  POST_PUBLISH_MONITOR: 3 * 60_000,
  AUTO_SAFE_PUBLISH: 3 * 60_000,
  AI_ANALYSIS: 3 * 60_000,
};

function configuredTimeout(jobType: AutomationJobType): number {
  const override = Number(process.env.SANDEAL_HANDLER_TIMEOUT_MS);
  const fallback = DEFAULT_TIMEOUTS[jobType] || 5 * 60_000;
  // An operator may tighten the budget, but the application never accepts an
  // unbounded or arbitrarily large handler deadline on a small VPS.
  return Math.max(1_000, Math.min(15 * 60_000, Number.isFinite(override) && override > 0 ? override : fallback));
}

function abortCode(value: unknown): AutomationExecutionAbortCode {
  return value === 'WORKER_FENCING_REJECTED'
    || value === 'JOB_CANCELLED'
    || value === 'KILL_SWITCH_ACTIVE'
    || value === 'WORKER_SHUTDOWN_REQUESTED'
    || value === 'STORAGE_LOCK_CONTENTION'
    ? value
    : 'HANDLER_TIMEOUT';
}

export function createAutomationExecutionBudget(
  jobType: AutomationJobType,
  parentSignal?: AbortSignal,
): AutomationExecutionBudget {
  const controller = new AbortController();
  const timeoutMs = configuredTimeout(jobType);
  const deadline = Date.now() + timeoutMs;
  let abortReason: AutomationExecutionAbortCode = 'HANDLER_TIMEOUT';
  const onParentAbort = () => {
    abortReason = abortCode(parentSignal?.reason);
    if (!controller.signal.aborted) controller.abort(abortReason);
  };
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    abortReason = 'HANDLER_TIMEOUT';
    if (!controller.signal.aborted) controller.abort(abortReason);
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    deadline,
    timeoutMs,
    abort(code) {
      abortReason = code;
      if (!controller.signal.aborted) controller.abort(code);
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw new AutomationExecutionAborted(abortReason);
      if (Date.now() >= deadline) {
        abortReason = 'HANDLER_TIMEOUT';
        if (!controller.signal.aborted) controller.abort(abortReason);
        throw new AutomationExecutionAborted('HANDLER_TIMEOUT');
      }
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

export function throwIfExecutionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = abortCode(signal.reason);
  throw new AutomationExecutionAborted(reason);
}

export function remainingExecutionMs(deadline: number, fallback = 1_000): number {
  return Math.max(1, Math.min(fallback, deadline - Date.now()));
}
