import { getCapability } from './capabilityRegistry';
import { proposalFingerprint, validId } from './fingerprint';
import type { Environment, ExecutionApproval, ExecutionProposal, ExecutionReceipt } from './types';

export function approvalState(proposal: ExecutionProposal, approval: ExecutionApproval | null, environment: Environment,
  approvers: readonly string[], now: number, policyReview = false): ExecutionReceipt['approvalState'] {
  const capability = getCapability(proposal.capability);
  if (!capability) return 'MISSING';
  if (capability.approvalRequirement === 'NOT_REQUIRED' && proposal.approvalRequirement === 'NOT_REQUIRED' && !policyReview) return 'NOT_REQUIRED';
  if (!approval) return 'MISSING';
  if (approval.status === 'REVOKED') return 'REVOKED';
  if (approval.environment !== environment) return 'INVALID_ENVIRONMENT';
  if (approval.proposalId !== proposal.id || approval.capability !== proposal.capability || approval.riskLevel !== proposal.riskLevel
    || !validId(approval.id) || !validId(approval.approverId) || !approvers.includes(approval.approverId)
    || approval.status !== 'APPROVED') return 'INVALID_BINDING';
  if (!Number.isSafeInteger(approval.createdAt) || !Number.isSafeInteger(approval.expiresAt)
    || approval.createdAt < proposal.requestedAt || approval.createdAt > now || approval.expiresAt <= now
    || approval.expiresAt > proposal.expiresAt || approval.expiresAt <= approval.createdAt) return 'EXPIRED';
  if (approval.proposalFingerprint !== proposalFingerprint(proposal) || approval.evidenceFingerprint !== proposal.evidenceFingerprint) return 'STALE_FINGERPRINT';
  return 'APPROVED';
}
