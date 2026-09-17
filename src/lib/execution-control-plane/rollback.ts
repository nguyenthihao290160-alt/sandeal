import { executionFingerprint, proposalFingerprint, validId } from './fingerprint';
import { getCapability } from './capabilityRegistry';
import { safeExecutionUrl } from './targetSafety';
import { validateExperiment } from '../experiments/model';
import type { ExperimentSpec } from '../experiments/types';
import type { ExecutionProposal, ExecutionTarget, PriorStateEvidence, RecoverableStateEvidence, RollbackPlan } from './types';

function stateRecord(state: unknown): state is Record<string, unknown> {
  return !!state && typeof state === 'object' && !Array.isArray(state)
    && [Object.prototype, null].includes(Object.getPrototypeOf(state));
}
function capabilityState(proposal: ExecutionProposal, target: ExecutionTarget, state: unknown): boolean {
  if (!stateRecord(state)) return false;
  switch (proposal.capability) {
    case 'PROPOSE_CONTENT_REFRESH':
      return Object.keys(state).sort().join(',') === 'canonical,content,title'
        && typeof state.title === 'string' && state.title.trim().length > 0 && state.title.length <= 512
        && typeof state.content === 'string' && state.content.trim().length > 0 && state.content.length <= 12000
        && (state.canonical === null || (typeof state.canonical === 'string' && safeExecutionUrl(state.canonical, [])));
    case 'PROPOSE_EXPERIMENT': {
      if (Object.keys(state).join(',') !== 'configuration' || !stateRecord(state.configuration)) return false;
      validateExperiment(state.configuration as unknown as ExperimentSpec);
      return state.configuration.productId === target.policyProductId;
    }
    default: return false;
  }
}
export function recoverablePriorState(proposal: ExecutionProposal, target: ExecutionTarget | null, evidence: PriorStateEvidence | null, now: number): evidence is RecoverableStateEvidence {
  try {
    const capability = getCapability(proposal.capability);
    return !!capability && capability.action === proposal.proposalType && !capability.productionMutation
      && capability.rollbackRequirement !== 'NOT_POSSIBLE' && proposal.rollbackRequirement !== 'NOT_POSSIBLE'
      && capability.allowedEnvironments.includes(proposal.environment) && capability.allowedModes.includes(proposal.executionMode)
      && ['PENDING', 'APPROVED'].includes(proposal.status) && Number.isSafeInteger(now) && now >= 0
      && Number.isSafeInteger(proposal.requestedAt) && proposal.requestedAt <= now && proposal.expiresAt > now
      && !!evidence && !!target && validId(evidence.id) && evidence.id === proposal.rollbackEvidenceId
      && evidence.capability === proposal.capability && validId(target.id) && validId(target.version)
      && target.id === proposal.targetEntityId && target.environment === proposal.environment && target.url === proposal.targetUrl
      && evidence.targetEntityId === proposal.targetEntityId && evidence.environment === proposal.environment
      && evidence.targetVersion === target.version && Number.isSafeInteger(evidence.capturedAt) && Number.isSafeInteger(evidence.expiresAt)
      && evidence.capturedAt >= 0 && evidence.capturedAt <= proposal.requestedAt && evidence.expiresAt > now && evidence.expiresAt - evidence.capturedAt <= 86_400_000
      && capabilityState(proposal, target, evidence.state)
      && evidence.stateFingerprint === executionFingerprint(evidence.state);
  } catch { return false; }
}
export function makeRollbackPlan(proposal: ExecutionProposal, target: ExecutionTarget | null, evidence: PriorStateEvidence | null, now: number): RollbackPlan | null {
  if (!recoverablePriorState(proposal, target, evidence, now) || !evidence || !target) return null;
  return { proposalId: proposal.id, proposalFingerprint: proposalFingerprint(proposal), capability: evidence.capability, evidenceId: evidence.id,
    environment: proposal.environment, targetEntityId: target.id, originalStateEvidence: { state: structuredClone(evidence.state), fingerprint: evidence.stateFingerprint },
    targetState: { version: target.version }, reversalSteps: [{ action: evidence.capability === 'PROPOSE_CONTENT_REFRESH'
      ? 'RESTORE_CONTENT_FIELDS' : 'RESTORE_EXPERIMENT_CONFIGURATION', evidenceId: evidence.id }],
    preconditions: ['CAPABILITY_TARGET_ENVIRONMENT_MATCH', 'TARGET_VERSION_MATCHES', 'PRIOR_STATE_STILL_RECOVERABLE'],
    limitations: ['INLINE_STATE_ONLY_NO_REFERENCE_RESOLVER', 'PLAN_ONLY_NO_RESTORE_EXECUTOR', 'NO_EXTERNAL_OR_PRODUCTION_ROLLBACK'] };
}
