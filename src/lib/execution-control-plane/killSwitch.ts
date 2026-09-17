export type KillSwitchState = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';
export interface DomainKillSwitches {
  CONTENT_EXECUTION_DISABLED: boolean;
  EXPERIMENT_EXECUTION_DISABLED: boolean;
  AFFILIATE_WRITE_DISABLED: boolean;
  DEPLOYMENT_DISABLED: boolean;
  DNS_DISABLED: boolean;
}
export const KILL_SWITCH_DOMAINS: readonly (keyof DomainKillSwitches)[] = Object.freeze([
  'CONTENT_EXECUTION_DISABLED', 'EXPERIMENT_EXECUTION_DISABLED', 'AFFILIATE_WRITE_DISABLED', 'DEPLOYMENT_DISABLED', 'DNS_DISABLED',
]);
export interface KillSwitchSnapshot {
  state: KillSwitchState;
  domains: DomainKillSwitches;
  revision: number;
  observedAt: number;
  expiresAt: number;
}
export function getGlobalKillSwitchState(snapshot?: KillSwitchSnapshot | null, now = Date.now()): KillSwitchState {
  if (snapshot?.state === 'ACTIVE') return 'ACTIVE';
  if (!snapshot || snapshot.state !== 'INACTIVE' || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
    || !Number.isSafeInteger(snapshot.observedAt) || !Number.isSafeInteger(snapshot.expiresAt)
    || snapshot.observedAt > now || snapshot.expiresAt <= now || snapshot.expiresAt - snapshot.observedAt > 300_000
    || !KILL_SWITCH_DOMAINS.every(domain => snapshot.domains && Object.hasOwn(snapshot.domains, domain) && typeof snapshot.domains[domain] === 'boolean')) return 'UNKNOWN';
  return 'INACTIVE';
}
export function isDomainDisabled(domain: keyof DomainKillSwitches, snapshot?: KillSwitchSnapshot | null, now = Date.now()): boolean {
  return getGlobalKillSwitchState(snapshot, now) !== 'INACTIVE' || !KILL_SWITCH_DOMAINS.includes(domain) || snapshot?.domains[domain] !== false;
}
