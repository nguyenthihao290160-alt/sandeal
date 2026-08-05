import { readBoundedCollection, runTransaction } from '../storage/adapter';

const COLLECTION = 'domain-circuit-breakers';
const MAX_CIRCUIT_ITEMS = 5_000;
const MAX_CIRCUIT_BYTES = 4 * 1024 * 1024;

export const DOMAIN_CIRCUIT_SCHEMA_VERSION = 3;
export const DOMAIN_CIRCUIT_RULE_VERSION = 'domain-circuit-v3';

export type DomainCircuitRole = 'AFFILIATE_GATEWAY' | 'MERCHANT';
export type DomainCircuitStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface DomainCircuitState {
  schemaVersion: number;
  id: string;
  domain: string;
  role: DomainCircuitRole;
  state: DomainCircuitStatus;
  consecutiveFailures: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  lastFailureCode?: string;
  openedAt?: string;
  openUntil?: string;
  nextProbeAt?: string;
  halfOpenProbeInFlight: boolean;
  ruleVersion: string;
  updatedAt: string;
  /** Backward-compatible v2 aliases. */
  failureStreak: number;
  openedUntil?: string;
  nextRetryAt?: string;
  lastStatus?: string;
}

export interface DomainCircuitDecision {
  allowed: boolean;
  domain?: string;
  role: DomainCircuitRole;
  state: DomainCircuitStatus;
  failureStreak: number;
  consecutiveFailures: number;
  retryAt?: string;
  reason?: 'invalid_domain' | 'circuit_open' | 'half_open_probe_in_flight';
  halfOpenProbe: boolean;
}

export interface RecordDomainHealthOptions {
  retryAfter?: string | number;
  random?: () => number;
  threshold?: number;
  baseDelayMs?: number;
  maximumDelayMs?: number;
  jitterRatio?: number;
  role?: DomainCircuitRole;
  halfOpenLeaseMs?: number;
  correlationId?: string;
  operationId?: string;
  jobId?: string;
}

export interface DomainCircuitDecisionOptions {
  role?: DomainCircuitRole;
  halfOpenLeaseMs?: number;
  correlationId?: string;
  operationId?: string;
  jobId?: string;
}

const TRANSIENT_FAILURES = new Set([
  'timeout', 'request_timeout', 'connect_timeout', 'connection_reset',
  'rate_limited', 'server_error', 'provider_server_error', 'dns_error',
  'dns_failure', 'tls_failure', 'merchant_unreachable', 'not_allowed',
  'forbidden', 'error', 'network_error',
]);
const SUCCESS_STATUSES = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
const CANDIDATE_SPECIFIC_FAILURES = new Set([
  'affiliate_link_not_found', 'affiliate_link_rejected', 'merchant_not_found',
  'broken', 'not_found', 'image_broken', 'invalid_image', 'unsafe_url',
  'invalid_url', 'redirect_loop',
]);
const DEFAULT_THRESHOLD = 3;
const DEFAULT_BASE_DELAY_MS = 15 * 60_000;
const DEFAULT_MAXIMUM_DELAY_MS = 6 * 60 * 60_000;
const DEFAULT_HALF_OPEN_LEASE_MS = 2 * 60_000;

function hostname(value: string): string | null {
  try { return new URL(value).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return null; }
}

function stateId(role: DomainCircuitRole, domain: string): string {
  return `${role}:${domain}`.toLowerCase();
}

function matchingStoredState(
  states: Array<Partial<DomainCircuitState>>,
  domain: string,
  role: DomainCircuitRole,
): Partial<DomainCircuitState> | undefined {
  return states.find(item => item.domain === domain && item.role === role)
    || (role === 'MERCHANT' ? states.find(item => item.domain === domain && !item.role) : undefined);
}

function normalizeState(
  domain: string,
  role: DomainCircuitRole,
  stored?: Partial<DomainCircuitState>,
  now = Date.now(),
): DomainCircuitState {
  const consecutiveFailures = Math.max(0, Number(stored?.consecutiveFailures ?? stored?.failureStreak ?? 0));
  const openUntil = typeof stored?.openUntil === 'string'
    ? stored.openUntil
    : typeof stored?.openedUntil === 'string' ? stored.openedUntil : undefined;
  const nextProbeAt = typeof stored?.nextProbeAt === 'string'
    ? stored.nextProbeAt
    : typeof stored?.nextRetryAt === 'string' ? stored.nextRetryAt : openUntil;
  let inferredState: DomainCircuitStatus = stored?.state === 'OPEN' || stored?.state === 'HALF_OPEN' || stored?.state === 'CLOSED'
    ? stored.state
    : openUntil && Date.parse(openUntil) > now ? 'OPEN' : 'CLOSED';
  let halfOpenProbeInFlight = stored?.halfOpenProbeInFlight === true;
  const openUntilMs = Date.parse(openUntil || '');
  const nextProbeAtMs = Date.parse(nextProbeAt || '');
  if (inferredState === 'OPEN' && (!Number.isFinite(openUntilMs) || openUntilMs <= now)) {
    inferredState = 'HALF_OPEN';
    halfOpenProbeInFlight = false;
  }
  if (inferredState === 'HALF_OPEN' && halfOpenProbeInFlight
    && (!Number.isFinite(nextProbeAtMs) || nextProbeAtMs <= now)) {
    halfOpenProbeInFlight = false;
  }
  const updatedAt = typeof stored?.updatedAt === 'string' ? stored.updatedAt : new Date(now).toISOString();
  const lastFailureCode = typeof stored?.lastFailureCode === 'string'
    ? stored.lastFailureCode
    : typeof stored?.lastStatus === 'string' ? stored.lastStatus.toUpperCase() : undefined;
  return {
    schemaVersion: DOMAIN_CIRCUIT_SCHEMA_VERSION,
    id: stateId(role, domain),
    domain,
    role,
    state: inferredState,
    consecutiveFailures,
    lastFailureAt: typeof stored?.lastFailureAt === 'string' ? stored.lastFailureAt : undefined,
    lastSuccessAt: typeof stored?.lastSuccessAt === 'string' ? stored.lastSuccessAt : undefined,
    lastFailureCode,
    openedAt: typeof stored?.openedAt === 'string' ? stored.openedAt : undefined,
    openUntil,
    nextProbeAt,
    halfOpenProbeInFlight,
    ruleVersion: DOMAIN_CIRCUIT_RULE_VERSION,
    updatedAt,
    failureStreak: consecutiveFailures,
    openedUntil: openUntil,
    nextRetryAt: nextProbeAt,
    lastStatus: typeof stored?.lastStatus === 'string' ? stored.lastStatus : lastFailureCode?.toLowerCase(),
  };
}

function syncLegacyAliases(state: DomainCircuitState): void {
  state.failureStreak = state.consecutiveFailures;
  state.openedUntil = state.openUntil;
  state.nextRetryAt = state.nextProbeAt;
  state.lastStatus = state.lastFailureCode?.toLowerCase();
}

function retryAfterTimestamp(value: string | number | undefined, now: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > now ? value : now + Math.max(0, value);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1_000 : Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined;
}

function maximumDelayMs(options: RecordDomainHealthOptions): number {
  const baseDelayMs = Math.max(1_000, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  return Math.max(baseDelayMs, Math.min(24 * 60 * 60_000, options.maximumDelayMs ?? DEFAULT_MAXIMUM_DELAY_MS));
}

function retryDelayMs(streak: number, options: RecordDomainHealthOptions): number {
  const baseDelayMs = Math.max(1_000, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maximum = maximumDelayMs(options);
  const exponential = Math.min(maximum, baseDelayMs * 2 ** Math.max(0, streak - 1));
  const jitterRatio = Math.max(0, Math.min(0.5, options.jitterRatio ?? 0.2));
  const random = Math.max(0, Math.min(1, (options.random || Math.random)()));
  return Math.min(maximum, exponential + Math.floor(exponential * jitterRatio * random));
}

async function readCircuitStates(): Promise<Array<Partial<DomainCircuitState>>> {
  return readBoundedCollection<Partial<DomainCircuitState>>(COLLECTION, {
    maximumItems: MAX_CIRCUIT_ITEMS,
    maximumBytes: MAX_CIRCUIT_BYTES,
  });
}

function decisionForState(state: DomainCircuitState, now: number, halfOpenLeaseMs: number): DomainCircuitDecision {
  const openUntilMs = Date.parse(state.openUntil || '');
  if (state.state === 'OPEN' && Number.isFinite(openUntilMs) && openUntilMs > now) {
    return {
      allowed: false, domain: state.domain, role: state.role, state: 'OPEN',
      failureStreak: state.consecutiveFailures, consecutiveFailures: state.consecutiveFailures,
      retryAt: state.openUntil, reason: 'circuit_open', halfOpenProbe: false,
    };
  }
  const leaseUntil = Date.parse(state.nextProbeAt || '');
  const inFlight = state.state === 'HALF_OPEN' && state.halfOpenProbeInFlight
    && Number.isFinite(leaseUntil) && leaseUntil > now
    && now - Date.parse(state.updatedAt) <= halfOpenLeaseMs;
  if (inFlight) {
    return {
      allowed: false, domain: state.domain, role: state.role, state: 'HALF_OPEN',
      failureStreak: state.consecutiveFailures, consecutiveFailures: state.consecutiveFailures,
      retryAt: state.nextProbeAt, reason: 'half_open_probe_in_flight', halfOpenProbe: false,
    };
  }
  const needsHalfOpen = state.state === 'HALF_OPEN' || state.state === 'OPEN';
  return {
    allowed: true, domain: state.domain, role: state.role, state: needsHalfOpen ? 'HALF_OPEN' : 'CLOSED',
    failureStreak: state.consecutiveFailures, consecutiveFailures: state.consecutiveFailures,
    retryAt: state.nextProbeAt, halfOpenProbe: needsHalfOpen,
  };
}

function circuitEvent(
  event: 'merchant_circuit_opened' | 'merchant_circuit_half_open' | 'merchant_circuit_closed',
  state: DomainCircuitState,
  options: DomainCircuitDecisionOptions | RecordDomainHealthOptions,
): void {
  console.info(JSON.stringify({
    event,
    correlationId: options.correlationId?.slice(0, 160),
    operationId: options.operationId?.slice(0, 160),
    jobId: options.jobId?.slice(0, 160),
    domain: state.domain,
    role: state.role,
    circuitState: state.state,
    consecutiveFailures: state.consecutiveFailures,
    reasonCode: state.lastFailureCode,
    nextProbeAt: state.nextProbeAt,
    updatedAt: state.updatedAt,
  }));
}

export async function peekDomainCircuitDecision(
  url: string,
  now = Date.now(),
  options: DomainCircuitDecisionOptions = {},
): Promise<DomainCircuitDecision> {
  const role = options.role || 'MERCHANT';
  const domain = hostname(url);
  if (!domain) {
    return { allowed: false, role, state: 'CLOSED', failureStreak: 0, consecutiveFailures: 0, reason: 'invalid_domain', halfOpenProbe: false };
  }
  const states = await readCircuitStates();
  const stored = matchingStoredState(states, domain, role);
  if (!stored) return { allowed: true, domain, role, state: 'CLOSED', failureStreak: 0, consecutiveFailures: 0, halfOpenProbe: false };
  return decisionForState(normalizeState(domain, role, stored, now), now, Math.max(10_000, options.halfOpenLeaseMs || DEFAULT_HALF_OPEN_LEASE_MS));
}

export async function getDomainCircuitDecision(
  url: string,
  now = Date.now(),
  options: DomainCircuitDecisionOptions = {},
): Promise<DomainCircuitDecision> {
  const initial = await peekDomainCircuitDecision(url, now, options);
  if (!initial.allowed || !initial.halfOpenProbe || !initial.domain) return initial;
  const role = options.role || 'MERCHANT';
  const halfOpenLeaseMs = Math.max(10_000, options.halfOpenLeaseMs || DEFAULT_HALF_OPEN_LEASE_MS);
  let output = initial;
  let transitioned: DomainCircuitState | undefined;
  await runTransaction<DomainCircuitState>(COLLECTION, all => {
    const index = all.findIndex(item => item.domain === initial.domain && (item.role === role || role === 'MERCHANT' && !item.role));
    if (index < 0) {
      output = { ...initial, state: 'CLOSED', halfOpenProbe: false };
      return undefined;
    }
    const state = normalizeState(initial.domain!, role, all[index], now);
    const current = decisionForState(state, now, halfOpenLeaseMs);
    if (!current.allowed || !current.halfOpenProbe) {
      output = current;
      return undefined;
    }
    state.state = 'HALF_OPEN';
    state.halfOpenProbeInFlight = true;
    state.openUntil = undefined;
    state.nextProbeAt = new Date(now + halfOpenLeaseMs).toISOString();
    state.updatedAt = new Date(now).toISOString();
    syncLegacyAliases(state);
    all[index] = state;
    transitioned = structuredClone(state);
    output = { ...current, allowed: true, state: 'HALF_OPEN', halfOpenProbe: true, retryAt: state.nextProbeAt };
    return all;
  });
  if (transitioned) circuitEvent('merchant_circuit_half_open', transitioned, options);
  return output;
}

export async function isDomainCircuitOpen(
  url: string,
  now = Date.now(),
  options: DomainCircuitDecisionOptions = {},
): Promise<boolean> {
  return !(await peekDomainCircuitDecision(url, now, options)).allowed;
}

export async function recordDomainHealth(
  url: string,
  status: string,
  now = Date.now(),
  options: RecordDomainHealthOptions = {},
): Promise<DomainCircuitState | null> {
  const domain = hostname(url);
  if (!domain) return null;
  const role = options.role || 'MERCHANT';
  let output!: DomainCircuitState;
  let event: 'merchant_circuit_opened' | 'merchant_circuit_closed' | undefined;
  await runTransaction<DomainCircuitState>(COLLECTION, all => {
    const index = all.findIndex(item => item.domain === domain && (item.role === role || role === 'MERCHANT' && !item.role));
    const state = normalizeState(domain, role, index >= 0 ? all[index] : undefined, now);
    const previousState = state.state;
    const normalizedStatus = String(status || 'unknown').trim().toLowerCase();
    state.updatedAt = new Date(now).toISOString();
    state.halfOpenProbeInFlight = false;

    if (SUCCESS_STATUSES.has(normalizedStatus)) {
      state.state = 'CLOSED';
      state.consecutiveFailures = 0;
      state.openedAt = undefined;
      state.openUntil = undefined;
      state.nextProbeAt = undefined;
      state.lastSuccessAt = state.updatedAt;
      state.lastFailureCode = undefined;
      if (previousState !== 'CLOSED') event = 'merchant_circuit_closed';
    } else if (CANDIDATE_SPECIFIC_FAILURES.has(normalizedStatus)) {
      // A reachable gateway/domain with one bad exact URL is candidate-specific.
      // It proves transport reachability and must never poison every URL on host.
      state.state = 'CLOSED';
      state.consecutiveFailures = 0;
      state.openedAt = undefined;
      state.openUntil = undefined;
      state.nextProbeAt = undefined;
      state.lastFailureAt = state.updatedAt;
      state.lastFailureCode = normalizedStatus.toUpperCase();
      if (previousState !== 'CLOSED') event = 'merchant_circuit_closed';
    } else if (TRANSIENT_FAILURES.has(normalizedStatus)) {
      state.consecutiveFailures += 1;
      state.lastFailureAt = state.updatedAt;
      state.lastFailureCode = normalizedStatus.toUpperCase();
      const exponentialRetryAt = now + retryDelayMs(state.consecutiveFailures, options);
      const providerRetryAtRaw = retryAfterTimestamp(options.retryAfter, now);
      const providerRetryAt = providerRetryAtRaw
        ? Math.min(providerRetryAtRaw, now + maximumDelayMs(options))
        : undefined;
      const retryAt = normalizedStatus === 'rate_limited' && providerRetryAt
        ? providerRetryAt
        : Math.min(now + maximumDelayMs(options), Math.max(exponentialRetryAt, providerRetryAt || 0));
      state.nextProbeAt = new Date(retryAt).toISOString();
      const threshold = Math.max(1, options.threshold ?? DEFAULT_THRESHOLD);
      if (previousState === 'HALF_OPEN' || normalizedStatus === 'rate_limited' || state.consecutiveFailures >= threshold) {
        state.state = 'OPEN';
        state.openedAt = previousState === 'OPEN' ? state.openedAt || state.updatedAt : state.updatedAt;
        state.openUntil = state.nextProbeAt;
        event = 'merchant_circuit_opened';
      } else {
        state.state = 'CLOSED';
        state.openUntil = undefined;
      }
    } else {
      state.lastFailureAt = state.updatedAt;
      state.lastFailureCode = normalizedStatus.toUpperCase().slice(0, 120);
    }

    syncLegacyAliases(state);
    if (index >= 0) all[index] = state; else all.push(state);
    output = structuredClone(state);
    return all;
  });
  if (event) circuitEvent(event, output, options);
  return output;
}

export async function listDomainCircuitStates(): Promise<DomainCircuitState[]> {
  const stored = await readCircuitStates();
  const normalized = new Map<string, DomainCircuitState>();
  for (const item of stored) {
    const domain = String(item.domain || item.id || '').replace(/^(?:affiliate_gateway|merchant):/i, '').toLowerCase();
    if (!domain) continue;
    const role = item.role === 'AFFILIATE_GATEWAY' ? 'AFFILIATE_GATEWAY' : 'MERCHANT';
    const state = normalizeState(domain, role, item);
    normalized.set(state.id, state);
  }
  return [...normalized.values()].sort((left, right) => left.role.localeCompare(right.role) || left.domain.localeCompare(right.domain));
}
