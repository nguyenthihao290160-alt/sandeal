export type ContentIntent = 
  | 'PRODUCT'
  | 'DEAL'
  | 'CATEGORY'
  | 'COMPARISON'
  | 'BUYING_GUIDE'
  | 'PRICE_HISTORY'
  | 'HOW_TO'
  | 'INFORMATIONAL'
  | 'BRAND'
  | 'TRANSACTIONAL'
  | 'UNKNOWN';

export type ContentLifecycleState = 
  | 'CURRENT'
  | 'REFRESH_QUEUED'
  | 'REFRESH_REVIEW_REQUIRED'
  | 'SUPERSEDE_CANDIDATE'
  | 'ARCHIVE_CANDIDATE'
  | 'UNKNOWN'
  | 'DRAFT_CANDIDATE'
  | 'SHADOW_PLANNED'
  | 'READY_FOR_REVIEW'
  | 'PUBLISHED_EXISTING'
  | 'STALE'
  | 'REFRESH_CANDIDATE'
  | 'MERGE_CANDIDATE'
  | 'BLOCKED'
  | 'ARCHIVED';

export type ContentAction = 
  | 'NO_ACTION'
  | 'REFRESH_EXISTING_CONTENT'
  | 'UPDATE_PRODUCT_PAGE'
  | 'UPDATE_DEAL_PAGE'
  | 'MERGE_CONTENT'
  | 'CONSOLIDATE_DUPLICATES'
  | 'CREATE_CONTENT_CANDIDATE'
  | 'CREATE_COMPARISON_CANDIDATE'
  | 'CREATE_BUYING_GUIDE_CANDIDATE'
  | 'CREATE_DEAL_ROUNDUP_CANDIDATE'
  | 'REQUEST_MORE_EVIDENCE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'BLOCK';

export type ContentRelationshipType =
  | 'CONTENT_ABOUT_PRODUCT'
  | 'CONTENT_ABOUT_CATEGORY'
  | 'COMPARES_PRODUCT'
  | 'RELATED_TO_CONTENT'
  | 'REFRESHES_CONTENT'
  | 'SUPERSEDES_CONTENT'
  | 'DUPLICATES_CONTENT'
  | 'CANONICAL_OF'
  | 'MERGED_INTO';

export type ContentCoverage =
  | 'NO_COVERAGE'
  | 'PARTIAL_COVERAGE'
  | 'ADEQUATE_COVERAGE'
  | 'STALE_COVERAGE'
  | 'DUPLICATE_COVERAGE'
  | 'BLOCKED_COVERAGE';

export type CannibalizationRisk =
  | 'SAFE'
  | 'OVERLAP'
  | 'HIGH_OVERLAP'
  | 'CANONICAL_CONFLICT'
  | 'MERGE_RECOMMENDED'
  | 'REFRESH_RECOMMENDED'
  | 'BLOCK_NEW_CONTENT';

export type ExternalSeoEvidenceStatus = 
  | 'NOT_AVAILABLE'
  | 'AVAILABLE'
  | 'PENDING'
  | 'STALE';

export interface SeoDemandEvidence {
  status: ExternalSeoEvidenceStatus;
  searchVolume?: number | null; // null/undefined means UNKNOWN, not 0
  keywordDifficulty?: number | null;
  ranking?: number | null;
}

export interface ContentEntity {
  id: string;
  type: string;
  intent: ContentIntent;
  canonicalTarget?: CanonicalTarget;
  lifecycle: ContentLifecycleState;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalTarget {
  url: string;
  entityId: string;
  entityType: string;
}

export interface ContentRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  relationship: ContentRelationshipType;
  reasonCodes: string[];
}

export interface ContentEvidence {
  opportunityId?: string;
  dealEvaluationId?: string;
  decisionId?: string;
  canonicalProductId?: string;
  providerProvenance?: string;
  monetizationSafe: boolean;
  priceEvidenceVersion?: string;
  seoEvidence?: SeoDemandEvidence;
}

export interface ContentCandidate {
  id: string;
  intent: ContentIntent;
  proposedTitle: string;
  proposedSlug: string;
  evidence: ContentEvidence;
}

export interface ContentPlan {
  id: string;
  contentId?: string;
  candidateId?: string;
  action: ContentAction;
  intent: ContentIntent;
  coverage: ContentCoverage;
  cannibalizationRisk: CannibalizationRisk;
  refreshRequired: boolean;
  mustInclude: string[];
  mustAvoid: string[];
  affiliateDisclosureRequired: boolean;
  reasonCodes: string[];
  riskCodes: string[];
  evidenceFingerprint: string;
  algorithmVersion: string;
  targetCanonical?: CanonicalTarget;
  plannedAt: string;
}

export interface ContentBrief {
  contentType: string;
  intent: ContentIntent;
  canonicalEntityIds: string[];
  targetAudienceIntent: string;
  verifiedFacts: string[];
  derivedSignals: string[];
  unknowns: string[];
  mustInclude: string[];
  mustAvoid: string[];
  affiliateDisclosureRequired: boolean;
  priceEvidenceSummary?: import('../deal-intelligence/types').DealPriceEvidence;
  dealEvidenceSummary?: import('../deal-intelligence/types').DealEvaluation;
  opportunitySummary?: import('../opportunity/types').OpportunityEvaluation;
  recommendedInternalLinks: ContentRelationship[];
  canonicalTarget?: string;
  reasonCodes: string[];
  riskCodes: string[];
}
