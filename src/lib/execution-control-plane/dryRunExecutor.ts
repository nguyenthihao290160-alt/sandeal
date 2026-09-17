import type { ExecutionReceipt, ExecutionSideEffect, RollbackPlan } from './types';
import { validatePreflight, type PreflightContext } from './preflightValidator';
import { getCapability } from './capabilityRegistry';
import { approvalState } from './approval';
import { executionId, proposalFingerprint } from './fingerprint';
import { makeRollbackPlan } from './rollback';
import { evaluateDecisionPolicy } from '../decision-os/policy';

export type DryRunContext = PreflightContext;
export function executeDryRun(context: DryRunContext): { receipt: ExecutionReceipt; rollbackPlan: RollbackPlan | null } {
  const { proposal, approval, now } = context;
  const preflightResult = validatePreflight(context), capability = getCapability(proposal.capability), passed = preflightResult === 'PASS';
  let policyReview = true;
  try { policyReview = !context.currentPolicy || evaluateDecisionPolicy(context.currentPolicy).reviewRequired; } catch { policyReview = true; }
  const state = approvalState(proposal, approval, context.currentEnvironment, context.allowedApproverIds, now, policyReview);
  const rollbackPlan = passed && capability?.rollbackRequirement !== 'NOT_POSSIBLE'
    ? makeRollbackPlan(proposal, context.target, context.priorState, now) : null;
  const wouldEffects: ExecutionSideEffect[] = passed && capability ? [{ effectType: `WOULD_EXECUTE_${capability.name}`,
    target: proposal.targetEntityId!, risk: capability.maxRiskLevel, reversible: rollbackPlan !== null,
    requiresApproval: capability.approvalRequirement === 'REQUIRED' || proposal.approvalRequirement === 'REQUIRED' || policyReview,
    productionMutation: false, externalCall: false, dryRunOnly: true, payload: { simulated: true } }] : [];
  const receipt: ExecutionReceipt = { id: executionId(proposal), proposalId: proposal.id, executionMode: 'DRY_RUN',
    preflightResult, wouldExecute: passed, blockedEffects: !passed, riskLevel: proposal.riskLevel,
    approvalState: state,
    rollbackAvailable: rollbackPlan !== null, fingerprint: proposalFingerprint(proposal), timestamp: now, wouldEffects };
  return { receipt, rollbackPlan };
}
