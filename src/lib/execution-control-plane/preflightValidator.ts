import { DECISION_POLICY_VERSION } from '../decision-os/config';
import { evaluateDecisionPolicy } from '../decision-os/policy';
import type { DecisionContext } from '../decision-os/types';
import type { ExecutionProposal, ExecutionApproval, PreflightResultType, Environment, ExecutionTarget, PriorStateEvidence, ChangeWindow } from './types';
import { getCapability } from './capabilityRegistry';
import { getGlobalKillSwitchState, isDomainDisabled, type KillSwitchSnapshot } from './killSwitch';
import { approvalState } from './approval';
import { proposalFingerprint, validId } from './fingerprint';
import { validTarget } from './targetSafety';
import { recoverablePriorState } from './rollback';
import { validChangeWindow } from './changeWindow';

export interface PreflightContext {
  proposal: ExecutionProposal;
  approval: ExecutionApproval | null;
  currentEnvironment: Environment;
  currentEvidenceFingerprint: string;
  currentProposalFingerprint: string;
  currentPolicy: DecisionContext | null;
  target: ExecutionTarget | null;
  priorState: PriorStateEvidence | null;
  changeWindow: ChangeWindow | null;
  killSwitch: KillSwitchSnapshot | null;
  bindings: { D1: boolean; QUEUE: boolean };
  allowedHosts: readonly string[];
  allowedApproverIds: readonly string[];
  now: number;
}

export function validatePreflight(context: PreflightContext): PreflightResultType {
  try {
    const { proposal, approval, currentEnvironment, now } = context;
    if (!Number.isSafeInteger(now) || now < 0) return 'BLOCKED_STALE';
    if (getGlobalKillSwitchState(context.killSwitch, now) !== 'INACTIVE') return 'BLOCKED_KILL_SWITCH';
    const capability = getCapability(proposal?.capability);
    if (!capability || capability.action !== proposal.proposalType) return 'BLOCKED_CAPABILITY';
    if (currentEnvironment !== proposal.environment || !capability.allowedEnvironments.includes(currentEnvironment)) return 'BLOCKED_ENVIRONMENT';
    if (capability.productionMutation || !capability.allowedModes.includes(proposal.executionMode) || proposal.executionMode === 'DISABLED') return 'BLOCKED_PERMISSION';
    if (isDomainDisabled(capability.domain, context.killSwitch, now)) return 'BLOCKED_KILL_SWITCH';
    if (capability.requiredBindings.some(binding => context.bindings?.[binding] !== true)) return 'BLOCKED_BINDING';
    if (!['PENDING', 'APPROVED'].includes(proposal.status) || !Number.isSafeInteger(proposal.requestedAt) || !Number.isSafeInteger(proposal.expiresAt)
      || proposal.requestedAt > now || proposal.expiresAt <= now || proposal.expiresAt - proposal.requestedAt > 86_400_000
      || context.currentProposalFingerprint !== proposalFingerprint(proposal)
      || context.currentEvidenceFingerprint !== proposal.evidenceFingerprint) return 'BLOCKED_STALE';
    if (!validId(proposal.id) || !validId(proposal.sourceRecordId) || !validId(proposal.sourceSubsystem) || !validId(proposal.algorithmVersion)
      || !['TEST_FIXTURE', 'AUTHENTICATED_PROVIDER_API'].includes(proposal.origin)
      || (proposal.origin === 'TEST_FIXTURE' && !['LOCAL', 'TEST'].includes(currentEnvironment))
      || !Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length === 0 || proposal.evidenceRefs.length > 20
      || !proposal.evidenceRefs.every(validId) || !Array.isArray(proposal.reasonCodes) || proposal.reasonCodes.length > 20
      || !proposal.reasonCodes.every(reason => typeof reason === 'string' && reason.length <= 256)
      || !proposal.parameters || Array.isArray(proposal.parameters) || Object.keys(proposal.parameters).length !== 0) return 'BLOCKED_EVIDENCE';
    if (proposal.riskLevel !== capability.maxRiskLevel || !['REQUIRED', 'NOT_REQUIRED'].includes(proposal.approvalRequirement)
      || !['REQUIRED', 'NOT_REQUIRED', 'NOT_POSSIBLE'].includes(proposal.rollbackRequirement)) return 'BLOCKED_PERMISSION';
    if (!validTarget(proposal, context.target, context.allowedHosts)) return 'BLOCKED_TARGET';
    const policy = context.currentPolicy;
    if (!policy || policy.productId !== context.target?.policyProductId || policy.origin !== proposal.origin
      || policy.decisionPolicyVersion !== DECISION_POLICY_VERSION || proposal.policyVersion !== policy.decisionPolicyVersion
      || policy.evidenceFingerprint !== context.currentEvidenceFingerprint || !Number.isSafeInteger(policy.validUntil) || policy.validUntil <= now
      || !Number.isFinite(Date.parse(policy.decisionTimestamp)) || Date.parse(policy.decisionTimestamp) > now
      || policy.constraints.executionMode !== 'SHADOW' || !policy.constraints.runtimeValid || policy.constraints.securityRisk || policy.constraints.quarantined
      || policy.constraints.systemHealth !== 'AVAILABLE' || !Array.isArray(policy.gates) || !policy.gates.length
      || (context.target?.provider !== null && (policy.money.status !== 'SAFE' || policy.money.provider !== context.target?.provider || policy.money.platform !== context.target?.platform))) return 'BLOCKED_POLICY';
    const currentPolicy = evaluateDecisionPolicy(policy);
    if (!['ALLOW', 'ALLOW_WITH_REVIEW'].includes(currentPolicy.outcome) || !currentPolicy.allowedActions.includes(capability.decisionAction)) return 'BLOCKED_POLICY';
    const state = approvalState(proposal, approval, currentEnvironment, context.allowedApproverIds, now, currentPolicy.reviewRequired);
    if (state === 'INVALID_ENVIRONMENT') return 'BLOCKED_ENVIRONMENT';
    if (state === 'STALE_FINGERPRINT') return 'BLOCKED_STALE';
    if (!['APPROVED', 'NOT_REQUIRED'].includes(state)) return 'BLOCKED_APPROVAL';
    if ((capability.changeWindowRequired || proposal.changeWindowId !== null) && !validChangeWindow(proposal, context.changeWindow, now)) return 'BLOCKED_WINDOW';
    if ((capability.rollbackRequirement === 'REQUIRED' || proposal.rollbackRequirement === 'REQUIRED')
      && (proposal.rollbackRequirement === 'NOT_POSSIBLE' || !recoverablePriorState(proposal, context.target, context.priorState, now))) return 'BLOCKED_ROLLBACK';
    return proposal.executionMode === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'PASS';
  } catch { return 'BLOCKED_EVIDENCE'; }
}
