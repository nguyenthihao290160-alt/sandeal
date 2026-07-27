import { getFeatureRolloutState, type SandealFeatureFlag } from './featureRollout';
import {
  getProviderDeclaration,
  type ProviderDeclaration,
  type ProviderId,
} from './providerRegistry';
import { classifyProviderFailure, type ProviderFailureCode } from './providerRouter';

const HARD_MAX_PROVIDERS = 3;
const HARD_MAX_TOTAL_ATTEMPTS = 4;
const HARD_MAX_DEADLINE_MS = 60_000;

export interface ProviderFallbackAdapter<TInput> {
  id: ProviderId;
  execute(input: TInput, signal: AbortSignal): Promise<unknown>;
}

export interface ProviderFallbackAttempt {
  providerId: ProviderId;
  attempt: number;
  status: 'SKIPPED' | 'FAILED' | 'SUCCEEDED';
  failureCode?: ProviderFailureCode | 'FEATURE_DISABLED' | 'ADAPTER_UNAVAILABLE';
  retryable: boolean;
  durationMs: number;
}

export interface ProviderFallbackResult<TOutput> {
  ok: boolean;
  output?: TOutput;
  providerId?: ProviderId;
  attempts: ProviderFallbackAttempt[];
  finalFailureCode?: ProviderFailureCode | 'FEATURE_DISABLED' | 'ADAPTER_UNAVAILABLE';
}

export interface ProviderFallbackRequest<TInput, TOutput> {
  capability: string;
  input: TInput;
  providerOrder?: ProviderId[];
  adapters: Array<ProviderFallbackAdapter<TInput>>;
  validateOutput(value: unknown, declaration: ProviderDeclaration): TOutput;
  deadlineMs?: number;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function boundedProviderOrder(input: ProviderId[] | undefined): ProviderId[] {
  const requested = input || ['deterministic-rules', 'local-ai', 'gemini'];
  return [...new Set(requested)].slice(0, HARD_MAX_PROVIDERS);
}

function enabled(
  feature: SandealFeatureFlag | undefined,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  return !feature || getFeatureRolloutState(feature, environment).mode === 'ACTIVE';
}

function retryable(declaration: ProviderDeclaration, code: ProviderFailureCode): boolean {
  return declaration.retry.retryableCodes.includes(code)
    && !declaration.retry.terminalCodes.includes(code);
}

function boundedDelay(declaration: ProviderDeclaration, attempt: number): number {
  if (declaration.retry.baseDelayMs <= 0) return 0;
  return Math.min(
    declaration.retry.maximumDelayMs,
    declaration.retry.baseDelayMs * (2 ** Math.max(0, attempt - 1)),
  );
}

async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  remainingMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('PROVIDER_FALLBACK_TIMEOUT'));
      reject(new Error('PROVIDER_FALLBACK_TIMEOUT'));
    }, Math.max(1, remainingMs));
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeBoundedProviderFallback<TInput, TOutput>(
  request: ProviderFallbackRequest<TInput, TOutput>,
): Promise<ProviderFallbackResult<TOutput>> {
  const now = request.now || Date.now;
  const sleep = request.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadlineMs = Math.max(1, Math.min(HARD_MAX_DEADLINE_MS, request.deadlineMs || 20_000));
  const startedAt = now();
  const attempts: ProviderFallbackAttempt[] = [];
  let totalAttempts = 0;
  let finalFailureCode: ProviderFallbackResult<TOutput>['finalFailureCode'];

  for (const providerId of boundedProviderOrder(request.providerOrder)) {
    const declaration = getProviderDeclaration(providerId);
    if (!declaration.capabilities.includes(request.capability)) continue;
    if (!enabled(declaration.featureFlag, request.environment)) {
      attempts.push({
        providerId,
        attempt: 0,
        status: 'SKIPPED',
        failureCode: 'FEATURE_DISABLED',
        retryable: false,
        durationMs: 0,
      });
      finalFailureCode = 'FEATURE_DISABLED';
      continue;
    }
    const adapter = request.adapters.find(candidate => candidate.id === providerId);
    if (!adapter) {
      attempts.push({
        providerId,
        attempt: 0,
        status: 'SKIPPED',
        failureCode: 'ADAPTER_UNAVAILABLE',
        retryable: false,
        durationMs: 0,
      });
      finalFailureCode = 'ADAPTER_UNAVAILABLE';
      continue;
    }

    const maximumAttempts = Math.min(
      declaration.retry.maximumAttempts,
      HARD_MAX_TOTAL_ATTEMPTS - totalAttempts,
    );
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const remainingMs = deadlineMs - (now() - startedAt);
      if (remainingMs <= 0 || totalAttempts >= HARD_MAX_TOTAL_ATTEMPTS) {
        finalFailureCode = 'TIMEOUT';
        return { ok: false, attempts, finalFailureCode };
      }
      totalAttempts += 1;
      const attemptStartedAt = now();
      try {
        const raw = await withDeadline(
          signal => adapter.execute(request.input, signal),
          remainingMs,
        );
        const output = request.validateOutput(raw, declaration);
        attempts.push({
          providerId,
          attempt,
          status: 'SUCCEEDED',
          retryable: false,
          durationMs: Math.max(0, now() - attemptStartedAt),
        });
        return { ok: true, output, providerId, attempts };
      } catch (error) {
        const failureCode = classifyProviderFailure(error);
        const canRetry = retryable(declaration, failureCode)
          && attempt < maximumAttempts
          && totalAttempts < HARD_MAX_TOTAL_ATTEMPTS;
        attempts.push({
          providerId,
          attempt,
          status: 'FAILED',
          failureCode,
          retryable: canRetry,
          durationMs: Math.max(0, now() - attemptStartedAt),
        });
        finalFailureCode = failureCode;
        if (!canRetry) break;
        const waitMs = boundedDelay(declaration, attempt);
        if (waitMs > 0) {
          const remainingAfterAttempt = deadlineMs - (now() - startedAt);
          if (waitMs >= remainingAfterAttempt) {
            return { ok: false, attempts, finalFailureCode: 'TIMEOUT' };
          }
          await sleep(waitMs);
        }
      }
    }
  }

  return { ok: false, attempts, finalFailureCode };
}
