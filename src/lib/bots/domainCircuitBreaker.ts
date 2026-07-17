import { readCollection, runTransaction } from '../storage/adapter';

const COLLECTION = 'domain-circuit-breakers';
export const DOMAIN_CIRCUIT_SCHEMA_VERSION = 2;
export const DOMAIN_CIRCUIT_RULE_VERSION = 'domain-circuit-v2';

export interface DomainCircuitState {
  schemaVersion: number;
  id: string;
  domain: string;
  failureStreak: number;
  openedUntil?: string;
  nextRetryAt?: string;
  lastStatus?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  ruleVersion: string;
  updatedAt: string;
}

export interface DomainCircuitDecision {
  allowed: boolean;
  domain?: string;
  failureStreak: number;
  retryAt?: string;
  reason?: 'invalid_domain' | 'circuit_open';
}

export interface RecordDomainHealthOptions {
  retryAfter?: string | number;
  random?: () => number;
  threshold?: number;
  baseDelayMs?: number;
  maximumDelayMs?: number;
  jitterRatio?: number;
}

const TRIP_STATUSES = new Set(['timeout', 'rate_limited', 'server_error', 'dns_error', 'not_allowed', 'forbidden', 'error']);
const SUCCESS_STATUSES = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
const DEFAULT_THRESHOLD = 3;
const DEFAULT_BASE_DELAY_MS = 15 * 60_000;
const DEFAULT_MAXIMUM_DELAY_MS = 6 * 60 * 60_000;

function hostname(value: string): string | null {
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
}

function normalizeState(domain: string, stored?: Partial<DomainCircuitState>, now = Date.now()): DomainCircuitState {
  return {
    schemaVersion: DOMAIN_CIRCUIT_SCHEMA_VERSION,
    id: domain,
    domain,
    failureStreak: Math.max(0, Number(stored?.failureStreak || 0)),
    openedUntil: typeof stored?.openedUntil === 'string' ? stored.openedUntil : undefined,
    nextRetryAt: typeof stored?.nextRetryAt === 'string' ? stored.nextRetryAt : undefined,
    lastStatus: typeof stored?.lastStatus === 'string' ? stored.lastStatus : undefined,
    lastFailureAt: typeof stored?.lastFailureAt === 'string' ? stored.lastFailureAt : undefined,
    lastSuccessAt: typeof stored?.lastSuccessAt === 'string' ? stored.lastSuccessAt : undefined,
    ruleVersion: DOMAIN_CIRCUIT_RULE_VERSION,
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : new Date(now).toISOString(),
  };
}

function retryAfterTimestamp(value: string | number | undefined, now: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > now ? value : now + Math.max(0, value);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined;
}

function retryDelayMs(streak: number, options: RecordDomainHealthOptions): number {
  const baseDelayMs = Math.max(1_000, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maximumDelayMs = Math.max(baseDelayMs, options.maximumDelayMs ?? DEFAULT_MAXIMUM_DELAY_MS);
  const exponential = Math.min(maximumDelayMs, baseDelayMs * 2 ** Math.max(0, streak - 1));
  const jitterRatio = Math.max(0, Math.min(0.5, options.jitterRatio ?? 0.2));
  const random = Math.max(0, Math.min(1, (options.random || Math.random)()));
  return Math.min(maximumDelayMs, exponential + Math.floor(exponential * jitterRatio * random));
}

export async function getDomainCircuitDecision(url: string, now = Date.now()): Promise<DomainCircuitDecision> {
  const domain = hostname(url);
  if (!domain) return { allowed: false, failureStreak: 0, reason: 'invalid_domain' };
  const stored = (await readCollection<DomainCircuitState>(COLLECTION)).find(item => item.domain === domain);
  const state = normalizeState(domain, stored, now);
  const retryAtMs = Date.parse(state.openedUntil || '');
  if (Number.isFinite(retryAtMs) && retryAtMs > now) {
    return { allowed: false, domain, failureStreak: state.failureStreak, retryAt: state.openedUntil, reason: 'circuit_open' };
  }
  return { allowed: true, domain, failureStreak: state.failureStreak, retryAt: state.nextRetryAt };
}

export async function isDomainCircuitOpen(url: string, now = Date.now()): Promise<boolean> {
  return !(await getDomainCircuitDecision(url, now)).allowed;
}

export async function recordDomainHealth(
  url: string,
  status: string,
  now = Date.now(),
  options: RecordDomainHealthOptions = {},
): Promise<DomainCircuitState | null> {
  const domain = hostname(url);
  if (!domain) return null;
  let output!: DomainCircuitState;
  await runTransaction<DomainCircuitState>(COLLECTION, all => {
    const index = all.findIndex(item => item.domain === domain);
    const state = normalizeState(domain, index >= 0 ? all[index] : undefined, now);
    const normalizedStatus = String(status || 'unknown').toLowerCase();
    state.lastStatus = normalizedStatus;
    state.updatedAt = new Date(now).toISOString();

    if (SUCCESS_STATUSES.has(normalizedStatus)) {
      state.failureStreak = 0;
      state.openedUntil = undefined;
      state.nextRetryAt = undefined;
      state.lastSuccessAt = state.updatedAt;
    } else if (TRIP_STATUSES.has(normalizedStatus)) {
      state.failureStreak += 1;
      state.lastFailureAt = state.updatedAt;
      const exponentialRetryAt = now + retryDelayMs(state.failureStreak, options);
      const providerRetryAt = retryAfterTimestamp(options.retryAfter, now);
      const retryAt = normalizedStatus === 'rate_limited' && providerRetryAt
        ? providerRetryAt
        : Math.max(exponentialRetryAt, providerRetryAt || 0);
      state.nextRetryAt = new Date(retryAt).toISOString();
      const threshold = Math.max(1, options.threshold ?? DEFAULT_THRESHOLD);
      if (normalizedStatus === 'rate_limited' || state.failureStreak >= threshold) state.openedUntil = state.nextRetryAt;
    } else {
      state.failureStreak = 0;
      state.openedUntil = undefined;
      state.nextRetryAt = undefined;
    }

    if (index >= 0) all[index] = state; else all.push(state);
    output = structuredClone(state);
    return all;
  });
  return output;
}

export async function listDomainCircuitStates(): Promise<DomainCircuitState[]> {
  return (await readCollection<DomainCircuitState>(COLLECTION))
    .map(state => normalizeState(state.domain || state.id, state))
    .sort((left, right) => left.domain.localeCompare(right.domain));
}
