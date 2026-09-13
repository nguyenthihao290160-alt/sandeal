import { EventJobError } from '../platform/cloudflareContracts';

export const DECISION_POLICY_VERSION = 'decision-policy-v1';
export const DECISION_PROMPT_VERSION = 'decision-reasoner-v1';
export const DECISION_CONFIG = {
  policyVersion: DECISION_POLICY_VERSION, executionMode: 'SHADOW', highScore: 70, lowScore: 40, reviewConfidence: 0.8,
  hardPriceAgeMs: 259_200_000, hardOfferAgeMs: 86_400_000, validityMs: 3_600_000,
  workLimit: 10, readLimit: 50, retentionMs: 30 * 86_400_000,
  ai: { enabled: false, promptVersion: DECISION_PROMPT_VERSION, maxCallsPerBatch: 3, maxAttempts: 2,
    minPriority: 'NORMAL', ambiguityConfidence: 0.8, cooldownMs: 300_000, validityMs: 3_600_000,
    timeoutMs: 5_000, backoffMs: 30_000, maxBackoffMs: 300_000, failureThreshold: 2, budgetWindowMs: 300_000 },
} as const;
type ConfigShape<Value> = { -readonly [Key in keyof Value]: Value[Key] extends number ? number : Value[Key] extends boolean ? boolean
  : Value[Key] extends string ? string : ConfigShape<Value[Key]> };
export type DecisionConfig = ConfigShape<typeof DECISION_CONFIG>;
export function validDecisionConfig(config: DecisionConfig): boolean {
  const shape = (value: unknown, template: unknown): boolean => !!value && typeof value === 'object'
    && Object.keys(value).sort().join(',') === Object.keys(template as object).sort().join(',')
    && Object.entries(template as object).every(([key, sample]) => typeof sample === 'object'
      ? shape((value as Record<string, unknown>)[key], sample) : typeof (value as Record<string, unknown>)[key] === typeof sample);
  if (!shape(config, DECISION_CONFIG)) return false;
  const numbers = [...Object.values(config), ...Object.values(config.ai)].filter(value => typeof value === 'number');
  return numbers.every(value => Number.isFinite(value) && value > 0) && config.executionMode === 'SHADOW'
    && /^decision-policy-v[1-9][0-9]*$/.test(config.policyVersion) && /^decision-reasoner-v[1-9][0-9]*$/.test(config.ai.promptVersion)
    && config.lowScore < config.highScore && config.highScore <= 100 && config.reviewConfidence <= 1
    && config.hardPriceAgeMs <= 259_200_000 && config.hardOfferAgeMs <= 86_400_000 && config.validityMs <= 3_600_000
    && config.workLimit <= 10 && config.readLimit <= 50 && config.retentionMs >= config.validityMs && config.retentionMs <= 30 * 86_400_000
    && [config.workLimit, config.readLimit, config.ai.maxCallsPerBatch, config.ai.maxAttempts, config.ai.failureThreshold].every(Number.isSafeInteger)
    && config.ai.maxCallsPerBatch <= 10 && config.ai.maxAttempts <= 2 && config.ai.timeoutMs <= 10_000
    && config.ai.ambiguityConfidence <= 1 && ['NORMAL', 'HIGH', 'TOP'].includes(config.ai.minPriority)
    && config.ai.cooldownMs >= 1000 && config.ai.validityMs <= config.validityMs && config.ai.validityMs >= config.ai.cooldownMs
    && config.ai.backoffMs >= 1000 && config.ai.maxBackoffMs >= config.ai.backoffMs && config.ai.maxBackoffMs <= 3_600_000
    && config.ai.failureThreshold <= 3 && config.ai.budgetWindowMs >= 60_000 && config.ai.budgetWindowMs <= 3_600_000;
}
export function validateDecisionConfig(config: DecisionConfig): void {
  if (!validDecisionConfig(config)) throw new EventJobError('INVALID_DECISION_CONFIG', 'QUARANTINE');
}
