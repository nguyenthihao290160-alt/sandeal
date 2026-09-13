import { DECISION_ACTIONS, POLICY_OUTCOMES, type DecisionContext, type DecisionOutcome, type DecisionAction, type PolicyDecision } from './types';

export function strongestPolicy(outcomes: readonly DecisionOutcome[]): DecisionOutcome {
  if (outcomes.some(outcome => !POLICY_OUTCOMES.includes(outcome))) return 'QUARANTINE';
  return outcomes.reduce((current, outcome) => POLICY_OUTCOMES.indexOf(outcome) > POLICY_OUTCOMES.indexOf(current) ? outcome : current, 'ALLOW');
}
export function evaluateDecisionPolicy(context: DecisionContext): PolicyDecision {
  const outcome = strongestPolicy(context.gates.map(gate => gate.outcome));
  const reasonCodes = [...new Set(context.gates.map(gate => gate.reason))];
  if (context.publication.ready) reasonCodes.push('PUBLICATION_GATE_PASS');
  if (context.money.status === 'SAFE') reasonCodes.push('SAFE_MONETIZATION_AVAILABLE');
  if (context.providerHealth === 'AVAILABLE') reasonCodes.push('PROVIDER_HEALTHY');
  if (context.money.status === 'SAFE' && context.money.provider === 'accesstrade' && context.money.platform === 'shopee') reasonCodes.push('ACCESSTRADE_SHOPEE_VALID');
  reasonCodes.push(context.revenue.state === 'POSITIVE' ? 'REVENUE_EVIDENCE_POSITIVE' : 'REVENUE_EVIDENCE_UNKNOWN');
  const reviewRequired = outcome === 'ALLOW_WITH_REVIEW' || reasonCodes.some(code => ['MANUAL_REVIEW_REQUIRED', 'PROVIDER_DEGRADED', 'DEAL_CONFIDENCE_LOW'].includes(code));
  if (reviewRequired && !reasonCodes.includes('MANUAL_REVIEW_REQUIRED')) reasonCodes.push('MANUAL_REVIEW_REQUIRED');
  const allowedActions: DecisionAction[] = outcome === 'QUARANTINE' ? ['QUARANTINE'] : outcome === 'BLOCK' ? ['REJECT']
    : ['NO_ACTION', 'HOLD', 'MARK_REVIEW_REQUIRED', 'REQUEST_REFRESH_PRICE', 'REQUEST_REFRESH_OFFER', 'REQUEST_REEVALUATION', 'REQUEST_PROVIDER_RECHECK'];
  if (outcome === 'ALLOW' && context.publishRecommendation === 'PUBLISH') allowedActions.push('MARK_PUBLISH_CANDIDATE', 'MARK_CONTENT_CANDIDATE', 'MARK_HIGH_PRIORITY');
  return { outcome, policyVersion: context.decisionPolicyVersion, reasonCodes: [...new Set(reasonCodes)].sort(),
    riskCodes: [...new Set(context.gates.filter(gate => gate.outcome !== 'ALLOW').map(gate => gate.reason))].sort(), reviewRequired,
    allowedActions, blockedActions: DECISION_ACTIONS.filter(action => !allowedActions.includes(action)) };
}
