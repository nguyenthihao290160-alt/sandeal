import { getProviderDeclaration } from '../automation/providerRegistry';
import { dealFingerprint } from '../deal-intelligence/evaluate';
import { DECISION_CONFIG, validateDecisionConfig, type DecisionConfig } from './config';
import { DECISION_SYSTEM_PROMPT, decisionEvidencePack, parseDecisionAdvice, normalizedAiResult } from './prompts';
import { AI_ROLES, type AiRole, type DecisionAiResult, type DecisionContext, type DecisionModelRoles, type PolicyDecision,
  type DecisionAiResponse, type AiAttempt, type DecisionReason } from './types';

export interface DecisionAiJournal {
  cached(key: string, now: number): Promise<DecisionAiResult | null>;
  reserve(key: string, productId: string, now: number, validUntil: number): Promise<boolean>;
  acquireCall(key: string, providerKey: string, productId: string, now: number, config: DecisionConfig): Promise<'ACQUIRED' | 'BUDGET' | 'COOLDOWN'>;
  finishCall(providerKey: string, success: boolean, now: number, config: DecisionConfig): Promise<void>;
  complete(key: string, result: DecisionAiResult): Promise<void>;
}
export interface DecisionAiBatchBudget { remaining: number }
export function createDecisionAiBatch(config: DecisionConfig = DECISION_CONFIG): DecisionAiBatchBudget {
  validateDecisionConfig(config); return { remaining: config.ai.maxCallsPerBatch };
}
export function emptyAiResult(status: DecisionAiResult['status'], reason: DecisionReason, role: AiRole = 'REASONER'): DecisionAiResult {
  return { status, reasonCodes: [reason], advice: null, provider: null, model: null, role, promptVersion: null, attempts: [], cacheHit: false };
}
export function aiUseful(context: DecisionContext, policy: PolicyDecision, config: DecisionConfig): boolean {
  const priorities = ['REJECT', 'LOW', 'NORMAL', 'HIGH', 'TOP'];
  return !['BLOCK', 'QUARANTINE'].includes(policy.outcome) && context.dealScore >= config.lowScore
    && priorities.indexOf(context.dealPriority) >= priorities.indexOf(config.ai.minPriority)
    && (policy.reviewRequired || context.dealConfidence < config.ai.ambiguityConfidence
      || (context.dealScore >= config.highScore && context.publishRecommendation !== 'PUBLISH'));
}
export function modelRoleFingerprint(roles: DecisionModelRoles): string {
  return dealFingerprint(AI_ROLES.map(role => [role, (roles[role] || []).map(binding => [binding.provider.id, binding.model, binding.origin])]));
}
export function validateModelRoles(roles: DecisionModelRoles): boolean {
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return false;
  if (Object.keys(roles).some(role => !AI_ROLES.includes(role as AiRole))) return false;
  return AI_ROLES.every(role => {
    const bindings = roles[role] || [];
    if (!Array.isArray(bindings) || bindings.some(binding => !binding || typeof binding.provider !== 'object' || !binding.provider
      || typeof binding.provider.execute !== 'function' || typeof binding.provider.healthCheck !== 'function')) return false;
    return Array.isArray(bindings) && bindings.length <= 2 && new Set(bindings.map(binding => `${binding.provider.id}:${binding.model}`)).size === bindings.length
      && bindings.every(binding => {
        try {
          const declaration = getProviderDeclaration(binding.provider.id);
          return ['CONFIGURED_RUNTIME', 'TEST_FIXTURE'].includes(binding.origin) && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(binding.model) && declaration.capabilities.includes('ANALYZE_WITH_EVIDENCE')
            && binding.provider.declaration.id === declaration.id && binding.provider.declaration.contractVersion === declaration.contractVersion;
        } catch { return false; }
      });
  });
}
async function deadline<Output>(work: (signal: AbortSignal) => Promise<Output>, timeoutMs: number): Promise<Output> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('AI_TIMEOUT')); }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
function usage(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1e8 ? Number(value) : null; }

export async function reasonDecision(context: DecisionContext, policy: PolicyDecision, journal: DecisionAiJournal,
  roles: DecisionModelRoles = {}, config: DecisionConfig = DECISION_CONFIG, role: AiRole = 'REASONER', now = Date.now(),
  budget: DecisionAiBatchBudget = createDecisionAiBatch(config)): Promise<DecisionAiResult> {
  validateDecisionConfig(config);
  if (!config.ai.enabled) return emptyAiResult('DISABLED', 'AI_DISABLED', role);
  if (!Number.isSafeInteger(now) || context.validUntil <= now || context.decisionPolicyVersion !== config.policyVersion
    || !Number.isSafeInteger(budget.remaining) || budget.remaining < 0 || budget.remaining > config.ai.maxCallsPerBatch)
    return emptyAiResult('AVOIDED', 'AI_NOT_NEEDED', role);
  if (!validateModelRoles(roles) || !AI_ROLES.includes(role)) return emptyAiResult('UNAVAILABLE', 'AI_UNAVAILABLE', role);
  if (context.origin !== 'TEST_FIXTURE' && AI_ROLES.some(modelRole => roles[modelRole]?.some(binding => binding.origin === 'TEST_FIXTURE')))
    return emptyAiResult('UNAVAILABLE', 'AI_UNAVAILABLE', role);
  if (!aiUseful(context, policy, config)) return emptyAiResult('AVOIDED', 'AI_NOT_NEEDED', role);
  const bindings = roles[role] || [];
  if (!bindings.length) return emptyAiResult('UNAVAILABLE', 'AI_UNAVAILABLE', role);
  const key = dealFingerprint([context.origin, context.evidenceFingerprint, config.policyVersion, config.ai.promptVersion, role, modelRoleFingerprint(roles)]);
  const cached = await journal.cached(key, now);
  if (cached) return normalizedAiResult(cached) ? { ...cached, cacheHit: true, reasonCodes: [...new Set([...cached.reasonCodes, 'AI_CACHE_HIT' as const])] }
    : emptyAiResult('INVALID', 'AI_INVALID_OUTPUT', role);
  if (!await journal.reserve(key, context.productId, now, Math.min(context.validUntil, now + config.ai.validityMs)))
    return emptyAiResult('AVOIDED', 'AI_IN_FLIGHT', role);
  const result = emptyAiResult('UNAVAILABLE', 'AI_UNAVAILABLE', role);
  result.promptVersion = config.ai.promptVersion;
  for (const binding of bindings.slice(0, config.ai.maxAttempts)) {
    if (budget.remaining <= 0) { result.reasonCodes.push('AI_BUDGET_EXHAUSTED'); break; }
    budget.remaining--;
    const providerKey = binding.provider.id;
    const acquired = await journal.acquireCall(key, providerKey, context.productId, now, config);
    if (acquired !== 'ACQUIRED') {
      budget.remaining++;
      result.reasonCodes.push(acquired === 'BUDGET' ? 'AI_BUDGET_EXHAUSTED' : 'AI_COOLDOWN');
      if (acquired === 'BUDGET') break;
      continue;
    }
    const started = Date.now();
    const attempt: AiAttempt = { provider: binding.provider.id, model: binding.model, health: 'UNAVAILABLE', status: 'FAILED',
      latencyMs: 0, inputTokens: null, outputTokens: null, cost: 'UNKNOWN' };
    result.attempts.push(attempt);
    let response: DecisionAiResponse | null = null;
    try {
      response = await deadline(async signal => {
        const health = await binding.provider.healthCheck();
        if (health.provider !== binding.provider.id || !health.configured || !health.ready || !['READY', 'DEGRADED'].includes(health.state)
          || !Number.isFinite(Date.parse(health.checkedAt)) || Date.parse(health.checkedAt) > now
          || now - Date.parse(health.checkedAt) > config.ai.cooldownMs) throw new Error('AI_UNAVAILABLE');
        attempt.health = health.state === 'READY' ? 'AVAILABLE' : 'DEGRADED';
        if (signal.aborted) throw new Error('AI_TIMEOUT');
        const output = await binding.provider.execute({ system: DECISION_SYSTEM_PROMPT, evidence: decisionEvidencePack(context, policy),
          role, model: binding.model, promptVersion: config.ai.promptVersion, signal, tools: [] });
        if (!output.ok || output.provider !== binding.provider.id) throw new Error('AI_UNAVAILABLE');
        return output.data;
      }, config.ai.timeoutMs);
    } catch { attempt.health = 'UNAVAILABLE'; }
    attempt.latencyMs = Math.max(0, Math.min(config.ai.timeoutMs + 1000, Date.now() - started));
    attempt.inputTokens = usage(response?.usage?.inputTokens); attempt.outputTokens = usage(response?.usage?.outputTokens);
    const advice = parseDecisionAdvice(response?.output);
    attempt.status = advice ? 'SUCCEEDED' : 'FAILED';
    if (!advice) attempt.health = 'COOLDOWN';
    await journal.finishCall(providerKey, advice !== null, now, config);
    if (advice) {
      result.status = 'VALID'; result.advice = advice; result.provider = binding.provider.id; result.model = binding.model;
      result.reasonCodes = ['AI_PROVIDER_SELECTED'];
      if (bindings.indexOf(binding) > 0) result.reasonCodes.push('AI_FALLBACK_USED');
      break;
    }
    if (response) { result.status = 'INVALID'; result.reasonCodes.push('AI_INVALID_OUTPUT'); break; }
  }
  await journal.complete(key, result);
  return result;
}
