import { readCollection, writeCollection } from '../storage/adapter';

const COLLECTION = 'domain-circuit-breakers';
export interface DomainCircuitState { id: string; domain: string; failureStreak: number; openedUntil?: string; lastStatus?: string; updatedAt: string; }
const TRIP_STATUSES = new Set(['timeout', 'rate_limited', 'server_error', 'dns_error', 'not_allowed']);

export async function isDomainCircuitOpen(url: string, now = Date.now()): Promise<boolean> {
  const domain = hostname(url); if (!domain) return true;
  const state = (await readCollection<DomainCircuitState>(COLLECTION)).find((item) => item.domain === domain);
  return Boolean(state?.openedUntil && Date.parse(state.openedUntil) > now);
}

export async function recordDomainHealth(url: string, status: string, now = Date.now()): Promise<void> {
  const domain = hostname(url); if (!domain) return;
  const all = await readCollection<DomainCircuitState>(COLLECTION); let state = all.find((item) => item.domain === domain);
  if (!state) { state = { id: domain, domain, failureStreak: 0, updatedAt: new Date(now).toISOString() }; all.push(state); }
  state.failureStreak = TRIP_STATUSES.has(status) ? state.failureStreak + 1 : 0;
  state.openedUntil = state.failureStreak >= 3 ? new Date(now + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(4, state.failureStreak - 3))).toISOString() : undefined;
  state.lastStatus = status; state.updatedAt = new Date(now).toISOString(); await writeCollection(COLLECTION, all);
}
function hostname(value: string): string | null { try { return new URL(value).hostname.toLowerCase(); } catch { return null; } }
