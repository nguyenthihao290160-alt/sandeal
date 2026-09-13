import type { AiDecisionAdvice, DecisionAction, DecisionContext, DecisionPlan, PolicyDecision } from './types';

export function planDecision(context: DecisionContext, policy: PolicyDecision, advice: AiDecisionAdvice | null = null): DecisionPlan {
  const reasonCodes = [...policy.reasonCodes], actions: DecisionAction[] = [];
  let reviewRequired = policy.reviewRequired;
  const accepted = !!advice && policy.allowedActions.includes(advice.recommendedAction);
  if (advice) {
    reasonCodes.push(accepted ? 'AI_ADVICE_ACCEPTED' : 'AI_ADVICE_REJECTED_BY_POLICY');
    if (!accepted) { reviewRequired = true; reasonCodes.push('MANUAL_REVIEW_REQUIRED'); }
  }
  if (policy.outcome === 'QUARANTINE') actions.push('QUARANTINE');
  else if (policy.outcome === 'BLOCK') actions.push('REJECT');
  else {
    if (policy.reasonCodes.includes('PRICE_STALE')) actions.push('REQUEST_REFRESH_PRICE');
    if (policy.reasonCodes.includes('OFFER_STALE')) actions.push('REQUEST_REFRESH_OFFER');
    if (policy.reasonCodes.some(code => ['PROVIDER_DEGRADED', 'PROVIDER_UNAVAILABLE'].includes(code))) actions.push('REQUEST_PROVIDER_RECHECK');
    if (actions.length || policy.reasonCodes.includes('EVIDENCE_CHANGED')) actions.push('REQUEST_REEVALUATION');
    if (reviewRequired) actions.push('MARK_REVIEW_REQUIRED');
    if (!actions.length) actions.push(accepted ? advice!.recommendedAction : policy.outcome === 'ALLOW'
      && context.publishRecommendation === 'PUBLISH' ? 'MARK_PUBLISH_CANDIDATE' : 'HOLD');
  }
  return { executionMode: 'SHADOW', outcome: policy.outcome, actions: [...new Set(actions)], reviewRequired,
    reasonCodes: [...new Set(reasonCodes)].sort(), riskCodes: [...policy.riskCodes] };
}
