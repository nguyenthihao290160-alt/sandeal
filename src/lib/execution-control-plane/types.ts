export type Environment = 'LOCAL' | 'TEST' | 'PREVIEW' | 'STAGING' | 'PRODUCTION';
export type ExecutionMode = 'SHADOW' | 'DRY_RUN' | 'REVIEW_REQUIRED' | 'DISABLED';
export type RiskLevel = 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ApprovalRequirement = 'NOT_REQUIRED' | 'REQUIRED';
export type RollbackRequirement = 'NOT_REQUIRED' | 'REQUIRED' | 'NOT_POSSIBLE';

export type CapabilityName = string;

export interface ExecutionProposal {
  id: string;
  origin: 'AUTHENTICATED_PROVIDER_API' | 'TEST_FIXTURE';
  proposalType: string;
  capability: CapabilityName;
  sourceSubsystem: string;
  sourceRecordId: string;
  targetEntityId: string | null;
  targetUrl: string | null;
  parameters: Record<string, unknown>;
  rollbackEvidenceId: string | null;
  changeWindowId: string | null;
  environment: Environment;
  executionMode: ExecutionMode;
  riskLevel: RiskLevel;
  reasonCodes: string[];
  evidenceRefs: string[];
  policyVersion: string;
  algorithmVersion: string;
  requestedAt: number;
  expiresAt: number;
  approvalRequirement: ApprovalRequirement;
  rollbackRequirement: RollbackRequirement;
  evidenceFingerprint: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED' | 'EXECUTED' | 'FAILED';
}

export interface ExecutionApproval {
  id: string;
  proposalId: string;
  environment: Environment;
  capability: CapabilityName;
  riskLevel: RiskLevel;
  evidenceFingerprint: string;
  approverId: string | null;
  proposalFingerprint: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
  createdAt: number;
  expiresAt: number;
}

export interface ExecutionSideEffect {
  effectType: string;
  target: string;
  risk: RiskLevel;
  reversible: boolean;
  requiresApproval: boolean;
  productionMutation: boolean;
  externalCall: boolean;
  dryRunOnly: boolean;
  payload: Record<string, unknown>;
}

export type PreflightResultType =
  | 'PASS'
  | 'BLOCKED_POLICY'
  | 'BLOCKED_KILL_SWITCH'
  | 'BLOCKED_PERMISSION'
  | 'BLOCKED_APPROVAL'
  | 'BLOCKED_STALE'
  | 'BLOCKED_ENVIRONMENT'
  | 'BLOCKED_EVIDENCE'
  | 'BLOCKED_CAPABILITY'
  | 'BLOCKED_ROLLBACK'
  | 'BLOCKED_TARGET'
  | 'BLOCKED_BINDING'
  | 'BLOCKED_WINDOW'
  | 'REVIEW_REQUIRED';

export interface ExecutionReceipt {
  id: string;
  proposalId: string;
  executionMode: ExecutionMode;
  preflightResult: PreflightResultType;
  wouldExecute: boolean;
  blockedEffects: boolean;
  riskLevel: RiskLevel;
  approvalState: 'NOT_REQUIRED' | 'APPROVED' | 'MISSING' | 'EXPIRED' | 'REVOKED' | 'STALE_FINGERPRINT' | 'INVALID_ENVIRONMENT' | 'INVALID_BINDING';
  rollbackAvailable: boolean;
  fingerprint: string;
  timestamp: number;
  wouldEffects: ExecutionSideEffect[];
}

export interface RollbackPlan {
  proposalId: string;
  proposalFingerprint: string;
  capability: CapabilityName;
  evidenceId: string;
  environment: Environment;
  targetEntityId: string;
  originalStateEvidence: Record<string, unknown>;
  targetState: Record<string, unknown>;
  reversalSteps: Record<string, unknown>[];
  preconditions: string[];
  limitations: string[];
}

export interface ExecutionTarget {
  id: string;
  environment: Environment;
  url: string | null;
  version: string;
  policyProductId: string;
  provider: 'accesstrade' | 'shopee' | null;
  platform: 'shopee' | 'tiktok' | null;
}

export interface PriorStateEvidence {
  id: string;
  capability: CapabilityName;
  targetEntityId: string;
  environment: Environment;
  targetVersion: string;
  capturedAt: number;
  expiresAt: number;
  state: unknown;
  stateFingerprint: string;
}

export type RecoverableStateEvidence = PriorStateEvidence & (
  | { capability: 'PROPOSE_CONTENT_REFRESH'; state: { title: string; canonical: string | null; content: string } }
  | { capability: 'PROPOSE_EXPERIMENT'; state: { configuration: ExperimentSpec } }
);

export interface ChangeWindow {
  id: string;
  environment: Environment;
  capabilities: string[];
  status: 'OPEN' | 'CLOSED';
  startsAt: number;
  endsAt: number;
}

export interface ExecutionAuditRecord {
  id: string;
  proposalId: string;
  eventType: string;
  timestamp: number;
  payload: Record<string, unknown>;
}
import type { ExperimentSpec } from '../experiments/types';
