import { executionFingerprint, validId } from '../execution-control-plane/fingerprint';
import { safePayload } from '../storage/d1/d1StorageAdapter';
import { EVENT_LIMITS } from '../platform/cloudflareContracts';
import type { BindingContract, ResourceBudget, RuntimeContract, ReleaseDependency, ReleaseMigration } from './types';

export const RELEASE_ALGORITHM_VERSION = 'release-rehearsal-v1';
export const RELEASE_LIMITS = Object.freeze({ sourceFiles: 2048, artifactFiles: 4096, artifactBytes: 64 * 1024 * 1024,
  migrations: 50, migrationStatements: 100, members: 20, journalRead: 20, certificateMs: 300_000 });
export const REQUIRED_GATES = Object.freeze(['CLEAN_MIGRATION', 'UPGRADE_MIGRATION', 'DATA_PRESERVATION', 'ROLLBACK_DRILL',
  'KILL_SWITCH_DRILL', 'KILL_SWITCH_UNKNOWN_DRILL', 'EMERGENCY_STOP_DRILL', 'SECURITY_TESTS', 'REGRESSIONS',
  'TYPESCRIPT', 'ESLINT', 'SECRET_SCAN', 'DIFF_CHECK']);
export const ABORT_CONDITIONS = Object.freeze(['MIGRATION_FAILURE', 'BINDING_FAILURE', 'PRODUCTION_MUTATION_ATTEMPT',
  'KILL_SWITCH_ACTIVE_OR_UNKNOWN', 'FAILURE_THRESHOLD_EXCEEDED', 'MONEY_INVARIANT_FAILURE', 'SECURITY_FAILURE',
  'ARTIFACT_MISMATCH', 'POLICY_MISMATCH', 'STALE_APPROVAL', 'ROLLBACK_UNAVAILABLE']);
export const DEFAULT_BUDGET: Readonly<ResourceBudget> = Object.freeze({ queueBatch: EVENT_LIMITS.queueBatch, d1Batch: 100,
  proposals: 20, approvalBacklog: 20, routeScope: 20, attempts: EVENT_LIMITS.attempts, dispatches: EVENT_LIMITS.dispatches,
  retryDelayMs: EVENT_LIMITS.redeliveryMs, workerRequestsPerMinute: 60, queueMessagesPerMinute: 10, d1ReadsPerWork: 50, d1WritesPerWork: 10 });
export const LOCAL_BINDINGS: Readonly<BindingContract> = Object.freeze({ d1: Object.freeze(['DB']), queues: Object.freeze(['JOB_QUEUE']), assets: Object.freeze(['ASSETS']),
  databaseReferences: Object.freeze(['sandeal-runtime-local']), queueReferences: Object.freeze(['sandeal-local-jobs']),
  crons: Object.freeze(['*/5 * * * *']), secretReferences: Object.freeze([]) });
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function exactKeys(value: unknown, keys: string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
export function assertSafeRelease(value: unknown): void { safePayload(value, 768 * 1024); }
export function validBindings(value: BindingContract): boolean {
  return exactKeys(value, Object.keys(LOCAL_BINDINGS)) && executionFingerprint(value) === executionFingerprint(LOCAL_BINDINGS);
}
export function validBudget(budget: ResourceBudget): boolean {
  if (!exactKeys(budget, Object.keys(DEFAULT_BUDGET))) return false;
  const caps = { queueBatch: 10, d1Batch: 100, proposals: 20, approvalBacklog: 20, routeScope: 20, attempts: 3, dispatches: 5 };
  return Object.entries(caps).every(([key, maximum]) => Number.isSafeInteger(budget[key as keyof ResourceBudget])
    && Number(budget[key as keyof ResourceBudget]) > 0 && Number(budget[key as keyof ResourceBudget]) <= maximum)
    && Number.isSafeInteger(budget.retryDelayMs) && budget.retryDelayMs >= EVENT_LIMITS.redeliveryMs && budget.retryDelayMs <= 300_000
    && ['workerRequestsPerMinute', 'queueMessagesPerMinute', 'd1ReadsPerWork', 'd1WritesPerWork'].every(key => {
      const value = budget[key as keyof ResourceBudget]; return value === null || (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000);
    });
}
export function resourceClass(budget: ResourceBudget, artifactBytes: number): 'LOW' | 'MODERATE' | 'HIGH' | 'UNKNOWN' {
  if (!validBudget(budget) || !Number.isSafeInteger(artifactBytes) || artifactBytes < 0
    || [budget.workerRequestsPerMinute, budget.queueMessagesPerMinute, budget.d1ReadsPerWork, budget.d1WritesPerWork].includes(null)) return 'UNKNOWN';
  if (budget.workerRequestsPerMinute! > 1000 || budget.queueMessagesPerMinute! > 100 || budget.d1ReadsPerWork! > 500 || budget.d1WritesPerWork! > 100
    || artifactBytes > RELEASE_LIMITS.artifactBytes) return 'HIGH';
  return budget.workerRequestsPerMinute! <= 60 && budget.queueMessagesPerMinute! <= 10 && budget.d1ReadsPerWork! <= 50
    && budget.d1WritesPerWork! <= 10 && artifactBytes <= 16 * 1024 * 1024 ? 'LOW' : 'MODERATE';
}
export function validRuntime(value: RuntimeContract): boolean {
  return exactKeys(value, ['version', 'configFingerprint', 'runtime', 'localOnly', 'production', 'executionMode', 'directShopeeEnabled',
    'aiExecutionEnabled', 'autopilotEnabled', 'moneyEngineEnabled', 'budget']) && validId(value.version) && isHash(value.configFingerprint)
    && value.runtime === 'cloudflare' && value.localOnly === true && value.production === false && value.executionMode === 'SHADOW'
    && value.directShopeeEnabled === false && value.aiExecutionEnabled === false && value.autopilotEnabled === false
    && value.moneyEngineEnabled === false && validBudget(value.budget);
}
export function dependencyOrder(dependencies: ReleaseDependency[]): string[] {
  if (!Array.isArray(dependencies) || dependencies.length < 1 || dependencies.length > 20) throw new Error('RELEASE_DAG_BOUND');
  const members = new Map(dependencies.map(member => [member.id, member])), active = new Set<string>(), visited = new Set<string>(), order: string[] = [];
  if (members.size !== dependencies.length) throw new Error('RELEASE_DAG_DUPLICATE');
  function visit(id: string) {
    if (active.has(id)) throw new Error('RELEASE_DAG_CYCLE');
    if (visited.has(id)) return;
    const member = members.get(id);
    if (!member || !validId(id) || !Array.isArray(member.dependsOn) || member.dependsOn.length > 20
      || new Set(member.dependsOn).size !== member.dependsOn.length) throw new Error('RELEASE_DAG_INVALID');
    active.add(id); for (const dependency of [...member.dependsOn].sort()) visit(dependency);
    active.delete(id); visited.add(id); order.push(id);
  }
  for (const id of [...members.keys()].sort()) visit(id);
  return order;
}
export function migrationSetFingerprint(migrations: ReleaseMigration[]): string { return executionFingerprint(migrations); }
