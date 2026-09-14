import type { ContentEntity, ContentPlan, ContentCoverage, CannibalizationRisk, ContentLifecycleState, ContentRelationship } from '../types';
import type { DecisionOutcome, DecisionAiResult } from '../../decision-os/types';
import type { EvidenceOrigin, AffiliatePlatform } from '../../affiliate/money/types';
import type { OpportunityPriority } from '../../opportunity/types';

export type ContentRefreshPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'NONE' | 'BLOCKED';
export type RefreshEligibility = 'NOT_REQUIRED' | 'ELIGIBLE' | 'ELIGIBLE_HIGH_PRIORITY' | 'REVIEW_REQUIRED' | 'BLOCKED';
export type ChangeSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ContentRefreshReason = 'PRICE_CHANGED' | 'PRICE_INVALID' | 'PRICE_DISAPPEARED' | 'OFFER_CHANGED' | 'OFFER_EXPIRED'
  | 'BEST_OFFER_CHANGED' | 'PRODUCT_FACT_CHANGED' | 'DEAL_SCORE_CHANGED' | 'DEAL_CONFIDENCE_CHANGED' | 'OPPORTUNITY_PRIORITY_CHANGED'
  | 'POLICY_CHANGED' | 'MONEY_ROUTE_CHANGED' | 'ATTRIBUTION_CHANGED' | 'CONTENT_DUPLICATION_FOUND' | 'CANONICAL_CONFLICT'
  | 'CONTENT_STALE' | 'REVENUE_EVIDENCE_UPDATED' | 'PROVIDER_DEGRADED' | 'PROVIDER_UNAVAILABLE' | 'UNSAFE_DESTINATION'
  | 'NO_MATERIAL_CHANGE' | 'MISSING_EVIDENCE' | 'EVIDENCE_INVALID' | 'CANONICAL_RELATIONSHIP_CHANGED' | 'INVALIDATED_FACT'
  | 'CONTENT_COVERAGE_CHANGED' | 'OBSOLETE_CONTENT' | 'POLICY_BLOCKED' | 'INSUFFICIENT_CONFIDENCE' | 'CONTENT_METADATA_CHANGED';
export type ContentLifecycleAction = 'NO_ACTION' | 'REFRESH_CONTENT' | 'REQUEST_PRICE_REFRESH' | 'REQUEST_OFFER_REFRESH'
  | 'REQUEST_CONTENT_REEVALUATION' | 'REQUEST_AI_CONTENT_REVIEW' | 'MERGE_RECOMMENDED' | 'SUPERSEDE_RECOMMENDED'
  | 'ARCHIVE_REVIEW_RECOMMENDED' | 'HUMAN_REVIEW_REQUIRED' | 'BLOCK';
export type LifecycleEvidenceFingerprint = string;
export interface ContentFactEvidence {
  key: string; valueHash: string; evidenceRef: string; valid: boolean;
  section: 'PRODUCT_FACTS' | 'PRICE' | 'OFFER' | 'AFFILIATE_ROUTE';
}
export interface LifecycleEvidence {
  canonicalProductId: string; origin: EvidenceOrigin; contentFingerprint: string;
  dealFingerprint: string; decisionFingerprint: string; opportunityFingerprint: string | null;
  policyVersion: string; policy: DecisionOutcome; opportunityPriority: OpportunityPriority | null;
  routeVersion: string; selectedOfferId: string | null; provider: string | null; platform: AffiliatePlatform | null;
  routeSafe: boolean; destinationUnsafe: boolean; providerHealth: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'COOLDOWN';
  priceVersion: string; price: number | null; priceState: 'FRESH' | 'STALE' | 'UNKNOWN' | 'INVALID';
  offerVersion: string; offerState: 'FRESH' | 'STALE' | 'EXPIRED' | 'MISSING';
  productFactsVersion: string; dealScore: number; dealConfidence: number; contentConfidence: number;
  coverage: ContentCoverage; cannibalizationRisk: CannibalizationRisk;
  relationship: ContentRelationship | null; obsolete: boolean; facts: ContentFactEvidence[];
}
export type ContentValueConfidence = number;
export type ContentBusinessValue = 'HIGH_VALUE' | 'MEDIUM_VALUE' | 'LOW_VALUE' | 'INSUFFICIENT_EVIDENCE' | 'UNKNOWN' | 'BLOCKED';
export interface ContentValueEvidence { currency: string; amountMinor: number; evidenceCount: number }
export interface ContentPerformanceSignal {
  attribution: 'DIRECTLY_ATTRIBUTED' | 'ASSOCIATED' | 'UNATTRIBUTED' | 'UNKNOWN';
  causalImpact: 'NOT_ESTABLISHED'; seoExternalEvidence: 'NOT_AVAILABLE';
}
export interface ContentValueSnapshot extends ContentPerformanceSignal {
  contentEntityId: string; origin: EvidenceOrigin; windowStart: number; windowEnd: number;
  attributedClicks: number; attributedConversions: number;
  approvedCommissionEvidence: ContentValueEvidence[] | null; revenueEvidence: ContentValueEvidence[] | null;
  revenueState: 'NO_REVENUE_OBSERVED' | 'NO_REVENUE_DATA' | 'VERIFIED_ZERO_REVENUE' | 'VERIFIED_REVENUE';
  monetizationEvents: number; dataCompleteness: 'PARTIAL' | 'NO_DATA'; valueConfidence: ContentValueConfidence;
  businessValue: ContentBusinessValue; sourceEventCount: number; evidenceFingerprint: string;
  algorithmVersion: string; generatedAt: number;
}
export interface RefreshBrief {
  contentEntityId: string; currentLifecycleState: ContentLifecycleState; recommendedAction: ContentLifecycleAction;
  materialChangeReasons: ContentRefreshReason[]; factsChanged: string[]; factsInvalidated: string[]; factsStillValid: string[];
  mustRefreshSections: ContentFactEvidence['section'][]; mustPreserveFacts: string[]; mustAvoidClaims: string[];
  newEvidenceRefs: string[]; oldEvidenceRefs: string[]; canonicalTarget: ContentEntity['canonicalTarget'];
  affiliateDisclosureRequired: boolean; priority: ContentRefreshPriority; reasonCodes: ContentRefreshReason[]; riskCodes: ContentRefreshReason[];
}
export interface ContentLifecyclePlan {
  id: string; contentEntityId: string; action: ContentLifecycleAction; executionMode: 'SHADOW'; productionAllowed: false;
  priority: ContentRefreshPriority; eligibility: RefreshEligibility; brief: RefreshBrief;
  relationship: ContentRelationship | null; experimentProposal: { type: 'TITLE_VARIANT'; state: 'DRAFT'; executionMode: 'SHADOW'; requiresHumanReview: true } | null;
}
export interface ContentLifecycleEvaluation {
  id: string; contentEntityId: string; canonicalProductId: string; origin: EvidenceOrigin; algorithmVersion: string;
  evidenceFingerprint: LifecycleEvidenceFingerprint; materialFingerprint: string; severity: ChangeSeverity; materialChange: boolean;
  state: ContentLifecycleState; priority: ContentRefreshPriority; eligibility: RefreshEligibility;
  reasonCodes: ContentRefreshReason[]; riskCodes: ContentRefreshReason[]; decay: ContentRefreshReason[];
  value: ContentValueSnapshot | null; plan: ContentLifecyclePlan; ai: DecisionAiResult; evaluatedAt: number;
}
export type ContentLifecycleAuditRecord = ContentLifecycleEvaluation;
export interface LifecycleInput {
  content: ContentEntity; contentPlan: ContentPlan | null; baseline: LifecycleEvidence | null; current: LifecycleEvidence;
  value: ContentValueSnapshot | null; now: number;
}
export interface RefreshJob { jobId: string; contentEntityId: string; fingerprint: string; algorithmVersion: string; revision: number }
export type RefreshOutcome = 'SHADOW_RECORDED' | 'STALE_JOB_NOOP' | 'DUPLICATE_SAFE';
export type ContentAttributionSource = { kind: 'CLICK'; clickId: string }
  | { kind: 'CONVERSION' | 'COMMISSION'; provider: 'accesstrade' | 'tiktok'; externalId: string };
