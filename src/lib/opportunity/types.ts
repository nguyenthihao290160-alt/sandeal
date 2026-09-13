import type { DealEvaluation, DealInput } from '../deal-intelligence/types';
import type { DecisionAuditRecord, DecisionContext } from '../decision-os/types';
import type { EvidenceOrigin } from '../affiliate/money/types';

export type OpportunityScore = number;
export type OpportunityConfidence = number;
export const OPPORTUNITY_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'BLOCKED'] as const;
export type OpportunityPriority = typeof OPPORTUNITY_PRIORITIES[number];
export const RESOURCE_ACTIONS = ['NO_RESOURCE', 'REFRESH_PRICE', 'REFRESH_OFFER', 'REQUEST_REEVALUATION',
  'AI_REVIEW_CANDIDATE', 'CONTENT_REVIEW_CANDIDATE', 'EXPERIMENT_CANDIDATE', 'HIGH_PRIORITY_CANDIDATE', 'HUMAN_REVIEW'] as const;
export type ResourceAction = typeof RESOURCE_ACTIONS[number];
export type ResourceClass = 'CHEAP' | 'STANDARD' | 'EXPENSIVE' | 'REVIEW_HEAVY';
export const OPPORTUNITY_REASONS = ['HIGH_DEAL_QUALITY', 'HIGH_DEAL_CONFIDENCE', 'SAFE_MONETIZATION_PATH',
  'KNOWN_COMMISSION_TERMS_NOT_PAID_REVENUE', 'VERIFIED_COMMISSION_EVIDENCE', 'VERIFIED_CONVERSION_EVIDENCE',
  'VERIFIED_REVENUE_EVIDENCE', 'NO_REVENUE_HISTORY', 'NEW_OPPORTUNITY_LIMITED_HISTORY', 'PROVIDER_HEALTHY',
  'ACCESS_TRADE_SHOPEE_VALID', 'OFFER_VALIDITY_KNOWN', 'CONTENT_GAP_DETECTED', 'CONTENT_ALREADY_COVERED',
  'CONTENT_COVERAGE_UNKNOWN', 'EXPLORATION_BONUS_APPLIED', 'AI_REVIEW_NOT_REQUIRED', 'AI_REVIEW_RECOMMENDED',
  'AI_DISABLED', 'TRAFFIC_EVIDENCE_UNKNOWN', 'SHADOW_PROPOSAL_ONLY', 'SEO_EXTERNAL_EVIDENCE_NOT_AVAILABLE'] as const;
export type OpportunityReason = typeof OPPORTUNITY_REASONS[number];
export const OPPORTUNITY_RISKS = ['LOW_DEAL_CONFIDENCE', 'STALE_PRICE', 'STALE_OFFER', 'PROVIDER_DEGRADED',
  'PROVIDER_UNAVAILABLE', 'NO_SAFE_MONEY_ROUTE', 'PUBLICATION_BLOCKED', 'HIGH_REVIEW_COST', 'INSUFFICIENT_EVIDENCE',
  'DUPLICATE_CONTENT_RISK', 'POLICY_BLOCKED', 'POLICY_HELD', 'OFFER_EXPIRES_SOON', 'EVIDENCE_EXPIRED'] as const;
export type OpportunityRisk = typeof OPPORTUNITY_RISKS[number];
export interface OpportunitySignal { code: string; state: 'KNOWN' | 'UNKNOWN'; score: number | null; coverage: number; contribution: number }
export interface ResourceRecommendation { executionMode: 'SHADOW'; actions: ResourceAction[]; resourceClass: ResourceClass; cost: 'UNKNOWN'; estimatedInternalJobs: number }
export interface ExperimentEligibility { state: 'ELIGIBLE_SHADOW' | 'NOT_ELIGIBLE'; reasonCodes: string[]; productionAllowed: false; trafficEvidence: 'UNKNOWN' }
export interface ExperimentProposal { proposalId: string; type: 'TITLE_VARIANT'; state: 'DRAFT'; executionMode: 'SHADOW'; requiresHumanReview: true; opportunityId: string }
export interface MerchantTrustSignal { state: 'UNKNOWN'; basis: 'INSUFFICIENT_MERCHANT_HISTORY' }
export interface OpportunityEvaluation {
  opportunityId: string; productId: string; dealEvaluationId: string; decisionId: string; origin: EvidenceOrigin;
  evaluatedAt: string; validUntil: number; dealScore: number; dealConfidence: number;
  monetizationScore: number; monetizationEvidence: ('MONETIZATION_PATH_ONLY' | 'KNOWN_COMMISSION_TERMS' | 'VERIFIED_COMMISSION_EVIDENCE' | 'VERIFIED_CONVERSION_EVIDENCE' | 'VERIFIED_REVENUE_EVIDENCE')[];
  revenueEvidenceScore: number | null; providerTrustScore: number | null; providerTrust: 'TRUST_HIGH' | 'TRUST_MEDIUM' | 'TRUST_LOW' | 'TRUST_UNKNOWN';
  providerTrustBasis: 'CURRENT_PROVIDER_HEALTH_ONLY'; merchantTrust: MerchantTrustSignal; offerStabilityScore: number | null;
  freshnessScore: number; contentOpportunityScore: number | null; contentOpportunity: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  competitionEvidenceScore: null; seoExternalEvidence: 'NOT_AVAILABLE'; resourceEfficiencyScore: number; explorationBonus: number; riskPenalty: number;
  penalties: { code: OpportunityRisk; points: number }[]; signals: OpportunitySignal[];
  opportunityScore: OpportunityScore; opportunityConfidence: OpportunityConfidence; opportunityPriority: OpportunityPriority;
  recommendedResourceClass: ResourceClass; resourceRecommendation: ResourceRecommendation; experimentEligibility: ExperimentEligibility;
  experimentProposal: ExperimentProposal | null; reasonCodes: OpportunityReason[]; riskCodes: OpportunityRisk[];
  provider: string | null; platform: string | null; newOpportunity: boolean;
  evidenceFingerprint: string; algorithmVersion: string; executionMode: 'SHADOW';
}
export type OpportunityAuditRecord = OpportunityEvaluation;
export interface OpportunityInput { source: DealInput; deal: DealEvaluation; decision: DecisionAuditRecord; context: DecisionContext }
