// ===========================================
// Shared Types for SanDeal / ReviewPilot AI
// ===========================================

// ---- Products ----

export type ProductPlatform =
  | "shopee"
  | "tiktok_shop"
  | "lazada"
  | "accesstrade"
  | "website"
  | "other";

export type ProductSource =
  | "manual"
  | "accesstrade"
  | "shopee_affiliate"
  | "tiktok_shop"
  | "lazada_affiliate"
  | "csv"
  | "other";

export type ProductStatus =
  | "draft"
  | "needs_review"
  | "approved"
  | "published"
  | "archived";

export type ProductRiskLevel =
  | "low"
  | "medium"
  | "high"
  | "unknown";

export type CandidateLane =
  | 'FAST_LANE'
  | 'NORMAL_LANE'
  | 'RETRY_LANE'
  | 'HUMAN_REVIEW_LANE'
  | 'REJECTED_LANE';

export type ProductKind =
  | "product"
  | "voucher"
  | "campaign"
  | "deal"
  | "store_offer"
  | "unknown";

export type ClassifiedProductRecordType =
  | 'PRODUCT'
  | 'VOUCHER'
  | 'CAMPAIGN'
  | 'STORE_OFFER'
  | 'CATEGORY_OR_LANDING_PAGE'
  | 'UNKNOWN';

// Legacy values remain readable so existing persisted records fail closed while
// the deterministic classifier only emits ClassifiedProductRecordType values.
export type ProductRecordType =
  | ClassifiedProductRecordType
  | 'STORE_PROMOTION'
  | 'CONTENT_ONLY';

export type ProductLifecycleState =
  | 'DISCOVERED'
  | 'STAGED'
  | 'CLASSIFIED'
  | 'NORMALIZED'
  | 'VERIFYING'
  | 'CONTENT_PREPARING'
  | 'READY_FOR_PUBLISH'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'RETRY_SCHEDULED'
  | 'QUARANTINED'
  | 'DEGRADED'
  | 'RECHECKING'
  | 'CONFIRMED_BROKEN'
  | 'HIDDEN';

export type PriceTruthState = 'FRESH' | 'AGING' | 'STALE' | 'CONFLICTED' | 'ANOMALOUS' | 'UNAVAILABLE';

export interface ProductClassificationSnapshot {
  schemaVersion: number;
  decisionId: string;
  recordType: ClassifiedProductRecordType;
  sourceType: string;
  confidence: number;
  reasons: string[];
  signals: string[];
  action: 'ACCEPT' | 'CROSS_CHECK' | 'QUARANTINE';
  ruleVersion: string;
  classifiedAt: string;
}

export interface ProductConfidenceSet {
  classification: number;
  source: number;
  price: number;
  image: number;
  health: number;
  duplicate: number;
  contentEvidenceCoverage: number;
  editorial: number;
  publish: number;
  calculatedAt: string;
  ruleVersion: string;
}

export interface ProductIdentity {
  sourceId?: string;
  externalId?: string;
  canonicalUrl?: string;
  affiliateUrl?: string;
  sku?: string;
  brand?: string;
  model?: string;
  gtin?: string;
  normalizedTitle: string;
  merchant?: string;
  imageFingerprint?: string;
  identityHash: string;
  ruleVersion: string;
}

export interface ProductOffer {
  id: string;
  source: string;
  merchant: string;
  price?: number;
  originalPrice?: number;
  previousPrice?: number;
  previousPriceObservedAt?: string;
  voucher?: string;
  affiliateUrl: string;
  health: 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'UNKNOWN';
  productLinkHealth?: 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'UNKNOWN';
  affiliateHealth?: 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'UNKNOWN';
  sourceVerified?: boolean;
  sourceConfidence?: number;
  merchantQuality?: number;
  priceConfidence?: number;
  currency?: 'VND';
  priceEvidenceFactIds?: string[];
  originalPriceEvidenceFactIds?: string[];
  observedAt: string;
  expiresAt?: string;
  confidence: number;
  primary: boolean;
}

export type ReviewStatus = 'pending' | 'generated' | 'needs_review' | 'approved' | 'rejected' | 'stale';
export type ReviewerType = 'automated_editorial' | 'human_editorial' | 'mixed';
export type ReviewMethod = 'source_data_analysis' | 'technical_verification' | 'comparative_data_analysis' | 'hands_on_test';

export interface VerifiedProductFact {
  id: string;
  label: string;
  value: string | number;
  sourceField: string;
  sourceName: string;
  verifiedAt?: string;
}

export interface EditorialClaim {
  id: string;
  text: string;
  claimType: 'factual' | 'inferred' | 'unknown';
  evidenceFactIds: string[];
  confidence: 'high' | 'medium' | 'low' | 'unknown';
}

export interface ReviewEvidenceSource {
  name: string;
  fields: string[];
  checkedAt?: string;
}

export interface ReviewContent {
  reviewStatus: ReviewStatus;
  reviewVersion: number;
  reviewMethod: ReviewMethod;
  reviewerType: ReviewerType;
  reviewDisclosure: string;
  reviewTitle: string;
  reviewSummary: string;
  reviewVerdict: string;
  suitableFor: string[];
  notSuitableFor: string[];
  keyFacts: VerifiedProductFact[];
  strengths: EditorialClaim[];
  limitations: EditorialClaim[];
  buyingConsiderations: string[];
  factualClaims: EditorialClaim[];
  inferredClaims: EditorialClaim[];
  unknownClaims: EditorialClaim[];
  evidenceSources: ReviewEvidenceSource[];
  sourceConfidence: 'high' | 'medium' | 'low';
  dataQualityScore: number;
  productSafetyScore: number;
  contentQualityScore: number;
  originalityScore: number;
  seoReadinessScore: number;
  editorialConfidence: number;
  reviewBlockReasons: string[];
  reviewedAt: string;
  contentUpdatedAt: string;
  sourceHash: string;
  reviewContentHash: string;
}

export interface ReviewQualityAssessment {
  qualityScore: number;
  trustScore: number;
  freshnessScore: number;
  completenessScore: number;
  usefulnessScore: number;
  sourceCoverageScore: number;
  balancedReviewScore: number;
  criticalIssues: string[];
  warnings: string[];
  nextRequiredAction: string;
  evaluatedAt: string;
  reviewPolicyVersion: string;
}

export interface ProductEligibilitySnapshot {
  eligibleForReview: boolean;
  eligibleForCanary: boolean;
  eligibleForPublish: boolean;
  eligibleForPublic: boolean;
  qualityScore: number;
  criticalBlockers: string[];
  warningBlockers: string[];
  nextRequiredAction: string;
  evaluatedAt: string;
  policyVersion: string;
  reviewQuality: ReviewQualityAssessment;
}

export type ProductScoreLabel =
  | "Bỏ qua"
  | "Cần xem xét"
  | "Nên làm"
  | "Ưu tiên cao";

export interface Product {
  schemaVersion?: number;
  id: string;
  title: string;
  slug: string;
  description?: string;

  kind: ProductKind;
  platform: ProductPlatform;
  source: ProductSource;

  originalUrl?: string;
  affiliateUrl?: string;
  affiliateUrlSource?: 'provider_api' | 'manual' | 'none';
  affiliateUrlProvider?: 'accesstrade' | 'manual';
  affiliateUrlSourceEndpoint?: string;
  affiliateUrlSourceField?: string;
  affiliateUrlCampaignId?: string;
  affiliateUrlFetchedAt?: string;
  affiliateUrlVerifiedAt?: string;
  deepLinkSupported?: boolean;
  affiliateLinkReason?: string;
  imageUrl?: string;
  gallery?: string[];

  price?: number;
  salePrice?: number;
  currency: "VND";
  priceNote?: string;

  category?: string;
  tags: string[];

  benefits: string[];
  painPoints?: string[];
  targetAudience?: string[];
  warnings: string[];
  contentAngles?: string[];
  complianceNotes?: string[];

  affiliateSource?: string;
  campaignName?: string;
  commissionNote?: string;
  affiliateDisclosure?: string;

  score?: number;
  scoreLabel?: ProductScoreLabel;
  scoreReasons?: string[];
  scoreWarnings?: string[];

  riskLevel: ProductRiskLevel;
  status: ProductStatus;

  externalId?: string;
  rawSourceType?: string;

  // Bot infrastructure fields
  linkHealthStatus?: LinkHealthStatus;
  linkLastCheckedAt?: string;
  linkFailureCount?: number;
  productUrlHttpStatus?: number;
  productUrlFinalUrl?: string;
  productUrlFinalDomain?: string;
  productUrlHealthReason?: string;
  productUrlErrorCode?: string;
  productUrlTimedOut?: boolean;
  affiliateHealthStatus?: LinkHealthStatus;
  affiliateLinkErrors?: string;
  affiliateUrlHttpStatus?: number;
  affiliateUrlFinalUrl?: string;
  affiliateUrlFinalDomain?: string;
  affiliateUrlHealthReason?: string;
  affiliateUrlErrorCode?: string;
  affiliateUrlTimedOut?: boolean;
  imageHealthStatus?: LinkHealthStatus;
  imageLastCheckedAt?: string;
  imageValidationState?: 'VALID' | 'BROKEN' | 'HOTLINK_BLOCKED' | 'TIMEOUT' | 'INVALID_CONTENT_TYPE' | 'TOO_SMALL' | 'DARK_IMAGE_SUSPECTED' | 'PLACEHOLDER' | 'FALLBACK_USED';
  imageWidth?: number;
  imageHeight?: number;
  imageDimensionsVerified?: boolean;
  archivedReason?: string;
  unpublishedReason?: string;
  contentPackageStatus?: 'none' | 'generated' | 'approved';
  complianceStatus?: ComplianceStatus;
  complianceIssues?: ComplianceIssue[];
  generatedContent?: ContentPackage;
  dataCompleteness?: number; // 0-100, calculated during normalization

  // Source health resilience — cooldown for stale/dead items
  sourceHealthCooldownUntil?: string; // ISO timestamp when item is safe to recheck
  sourceHealthReason?: string; // reason for cooldown (e.g. "image_404_stale", "timeout", "affiliate_unverified")
  sourceHealthSkipUntil?: string; // ISO timestamp to skip duplicate checks

  // Canonical automation/publication fields. Legacy JSON is normalized safely.
  sourceId?: string;
  contentHash?: string;
  sourceHash?: string;
  verifiedSource?: boolean;
  sourceVerified?: boolean;
  autoPublishEligible?: boolean;
  publicDecision?: string;
  publicHidden?: boolean;
  publicBlocked?: boolean;
  publicBlockReason?: string;
  publicBlockReasons?: string[];
  autoPublished?: boolean;
  needsVerification?: boolean;
  qualityScore?: number;
  qualityBand?: 'good' | 'fair' | 'needs_data' | 'poor' | 'blocked';
  opportunityScore?: number;
  opportunityBand?: 'priority' | 'recommended' | 'consider' | 'low' | 'blocked';
  scoreVersion?: string;
  scoreCalculatedAt?: string;
  scoreBreakdown?: Record<string, number>;
  dealScore?: number;
  dealBand?: 'featured' | 'consider' | 'normal' | 'verify' | 'ineligible';
  dealReasons?: string[];
  dealConfidence?: 'high' | 'medium' | 'low' | 'none';
  priceLastChangedAt?: string;
  lastSeenAt?: string;
  availability?: 'available' | 'unavailable' | 'unknown';
  duplicateGroupId?: string;
  duplicateConfidence?: number;
  contentWorkflowStatus?:
    | 'insufficient_data'
    | 'ready_for_draft'
    | 'drafting'
    | 'needs_verification'
    | 'pending_review'
    | 'approved'
    | 'scheduled'
    | 'published'
    | 'stale'
    | 'blocked'
    | 'archived';
  lastEditorialCheckAt?: string;
  analyticsSummary?: {
    views: number;
    clicks: number;
    ctr?: number;
    updatedAt: string;
  };
  dataIssues?: string[];
  recommendedActions?: string[];
  publishedAt?: string;
  productHealthStatus?: string;
  affiliateLastCheckedAt?: string;
  imageContentType?: string;
  brand?: string;
  sku?: string;
  gtin?: string;
  mpn?: string;
  specifications?: Record<string, string | number>;
  reviewContent?: ReviewContent;
  reviewQuality?: ReviewQualityAssessment;
  eligibility?: ProductEligibilitySnapshot;
  reviewGeneration?: { provider: 'gemini' | 'local'; modelId?: string; promptVersion: string; generationFingerprint: string; responseHash?: string; generatedAt: string; validationResult: 'approved' | 'fallback_local' };

  // Prompt 10 migration-safe autonomous commerce fields.
  recordType?: ProductRecordType;
  classification?: ProductClassificationSnapshot;
  lifecycleState?: ProductLifecycleState;
  lifecycleVersion?: string;
  lifecycleUpdatedAt?: string;
  quarantineReasons?: string[];
  nextAutomaticAction?: string;
  nextRetryAt?: string;
  relatedJobId?: string;
  evidenceFactIds?: string[];
  evidenceCoverage?: number;
  evidenceSnapshotAt?: string;
  evidenceSnapshotHash?: string;
  confidences?: ProductConfidenceSet;
  identity?: ProductIdentity;
  offers?: ProductOffer[];
  bestOfferId?: string;
  priceTruthState?: PriceTruthState;
  priceObservedAt?: string;
  priceTruthConfidence?: number;
  priceTruthEffectivePrice?: number;
  priceTruthDiscountPercent?: number;
  priceTruthEvidenceFactIds?: string[];
  priceTruthReasons?: string[];
  priceTruthRuleVersion?: string;
  priceTruthRequiresCrossCheck?: boolean;
  duplicateStatus?: 'CLEAR' | 'POSSIBLE' | 'UNRESOLVED' | 'MERGED';
  claimValidationStatus?: 'VERIFIED' | 'PARTIAL' | 'UNSAFE' | 'MISSING_EVIDENCE';
  publicationEffectKey?: string;
  publicationJobId?: string;
  monitoringScheduledAt?: string;
  consecutiveHealthFailures?: number;
  lastHealthyAt?: string;
  hiddenAt?: string;
  hiddenReason?: string;

  createdAt: string;
  updatedAt: string;
}

/** Input for creating a product — omits auto-generated fields */
export type CreateProductInput = Omit<Product, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

/** Filters for listing products */
export interface ProductFilters {
  q?: string;
  platform?: ProductPlatform;
  source?: ProductSource;
  status?: ProductStatus;
  kind?: ProductKind;
  riskLevel?: ProductRiskLevel;
  minScore?: number;
}

// ---- Token Vault ----

export type TokenPlatform =
  | 'gemini'
  | 'accesstrade'
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'youtube'
  | 'tiktok'
  | 'shopee'
  | 'lazada';

export type TokenCredentialType =
  | 'api_key'
  | 'user_token'
  | 'page_token'
  | 'app_id'
  | 'app_secret'
  | 'client_id'
  | 'client_secret'
  | 'access_token'
  | 'refresh_token';

export type TokenStatus = 'unchecked' | 'valid' | 'error' | 'expired' | 'missing_permission';
export type TokenLabel = 'primary' | 'backup' | 'disabled' | 'error';

export interface StoredToken {
  id: string;
  platform: TokenPlatform;
  credentialType: TokenCredentialType;
  value: string; // stored encrypted/raw on server, NEVER sent to frontend
  maskedValue: string; // safe for frontend
  label: TokenLabel;
  status: TokenStatus;
  statusMessage?: string;
  createdAt: string;
  lastCheckedAt?: string;
}

/** Token data safe for frontend (no raw value) */
export type SafeToken = Omit<StoredToken, 'value'>;

// ---- Content ----

export type ContentTargetPlatform = 'tiktok' | 'facebook_reels' | 'youtube_shorts' | 'instagram_reels' | 'blog_post' | 'facebook_post';
export type ContentType = 'review' | 'deal_alert' | 'comparison' | 'tips' | 'short_video_script' | 'caption' | 'hashtag_set';
export type ContentTone = 'natural' | 'professional' | 'friendly' | 'soft_sell';
export type ContentLength = '15s' | '30s' | '60s' | 'blog_short' | 'blog_long';
export type ContentComplianceStatus = 'safe' | 'needs_review' | 'blocked';

export interface ContentItem {
  id: string;
  productId: string;
  targetPlatform: ContentTargetPlatform;
  contentType: ContentType;
  tone: ContentTone;
  length: ContentLength;
  hook: string;
  script: string;
  caption: string;
  hashtags: string[];
  cta: string;
  complianceNotes: string;
  affiliateDisclosure: string;
  riskWarnings: string[];
  complianceStatus: ContentComplianceStatus;
  status: 'draft' | 'approved' | 'exported';
  createdAt: string;
  updatedAt: string;
}

// ---- Jobs / Scheduler ----

export type JobStatus = 'draft' | 'waiting_review' | 'scheduled' | 'exported' | 'published' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  productId: string;
  contentId?: string;
  platform: ContentTargetPlatform;
  contentType: ContentType;
  scheduledAt: string;
  status: JobStatus;
  errorMessage?: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

// ---- Channels ----

export type ChannelType = 'facebook_page' | 'instagram' | 'threads' | 'tiktok' | 'youtube_shorts' | 'website_blog' | 'manual_export';

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  connected: boolean;
  tokenId?: string;
  requiredPermissions: string[];
  status: 'connected' | 'disconnected' | 'error' | 'token_expired';
  lastSyncAt?: string;
}

// ---- AI Bot Infrastructure ----

export type BotName = 
  | 'orchestrator'
  | 'source_scout'
  | 'deal_hunter'
  | 'product_normalizer'
  | 'image_resolver'
  | 'gemini_analyst'
  | 'deal_scorer'
  | 'content_review'
  | 'compliance_guard'
  | 'link_health'
  | 'product_cleanup'
  | 'content_package'
  | 'app_health';

export type BotRunMode =
  | 'source_scan'
  | 'deal_hunt'
  | 'gemini_analysis'
  | 'content_review'
  | 'link_health'
  | 'cleanup'
  | 'score_only'
  | 'full_safe_run';

export type BotRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BotRunLog {
  id: string;
  runId: string;
  botName: BotName;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface BotRun {
  id: string;
  mode: BotRunMode;
  source: 'local' | 'accesstrade' | 'manual' | 'all';
  limit: number;
  status: BotRunStatus;
  startedAt: string;
  completedAt?: string;
  candidatesFound: number;
  productsSaved: number;
  contentPackagesGenerated: number;
  linksChecked: number;
  productsArchived: number;
  errorCount: number;
  logs: BotRunLog[];
}

export type LinkHealthStatus = 'ok' | 'redirect_ok' | 'broken' | 'not_allowed' | 'unverified' | 'rate_limited' | 'server_error' | 'timeout' | 'dns_error' | 'error' | 'unknown' | 'not_found' | 'affiliate_error' | 'image_broken' | 'invalid_image' | 'forbidden' | 'hotlink_blocked' | 'too_small' | 'too_large' | 'dark_image_suspected' | 'placeholder' | 'fallback_used' | 'product_unavailable' | 'needs_manual_check';

export interface LinkHealthCheck {
  id: string;
  productId: string;
  productUrlStatus: LinkHealthStatus;
  productUrlHttpCode?: number;
  affiliateUrlStatus?: LinkHealthStatus;
  affiliateUrlHttpCode?: number;
  imageUrlStatus?: LinkHealthStatus;
  checkedAt: string;
  failureCount: number;
  lastFailureReason?: string;
}

export type ComplianceIssue =
  | 'fake_personal_experience'
  | 'exaggerated_claims'
  | 'missing_affiliate_disclosure'
  | 'missing_price_change_note'
  | 'invented_price'
  | 'invented_discount'
  | 'invented_stock'
  | 'risky_wording'
  | 'missing_data';

export type ComplianceStatus = 'safe' | 'needs_edit' | 'blocked';

export interface ComplianceCheckResult {
  status: ComplianceStatus;
  issues: ComplianceIssue[];
  safeRewrite?: string;
  checkedAt: string;
}

export interface DealScoringCriteria {
  hasRealImage: boolean;
  hasCurrentPrice: boolean;
  hasOriginalPrice: boolean;
  discountPercent?: number;
  hasAffiliateUrl: boolean;
  trustedSource: boolean;
  dataCompleteness: number; // 0-100
  lowRisk: boolean;
  contentPotential: boolean;
}

export interface DealScoreResult {
  score: number; // 0-100
  label: 'Bỏ qua' | 'Cần xem xét' | 'Nên làm' | 'Ưu tiên cao';
  reasons: string[];
  criteria: DealScoringCriteria;
}

export interface ContentPackage {
  id: string;
  productId: string;
  websiteTitle: string;
  websiteReview: string;
  bulletPoints: string[];
  shortCaption: string;
  socialCaption?: string;
  hashtags: string[];
  cta: string;
  contentAngle: string;
  affiliateNote: string;
  imageUrl?: string;
  productUrl: string;
  affiliateUrl?: string;
  complianceStatus: ComplianceStatus;
  complianceIssues: ComplianceIssue[];
  generatedAt: string;
}

export interface BotTeamStatus {
  aiBotsEnabled: boolean;
  contentBotEnabled: boolean;
  linkHealthBotEnabled: boolean;
  cleanupBotEnabled: boolean;
  lastBotRunStatus?: BotRunStatus;
  lastBotRunAt?: string;
  productCount: number;
  approvedProductCount: number;
  reviewProductCount: number;
  brokenLinkCount: number;
  contentPackageCount: number;
  hasGeminiPrimaryToken: boolean;
  hasAccessTradePrimaryToken: boolean;
  sourceReady?: boolean;
  publicSafeProductCount?: number;
  safeMode: boolean;
  freeOnly: boolean;
  autoPublish: boolean;
}
