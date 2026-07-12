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

export type ProductKind =
  | "product"
  | "voucher"
  | "campaign"
  | "deal"
  | "store_offer"
  | "unknown";

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

export type ProductScoreLabel =
  | "Bỏ qua"
  | "Cần xem xét"
  | "Nên làm"
  | "Ưu tiên cao";

export interface Product {
  id: string;
  title: string;
  slug: string;
  description?: string;

  kind: ProductKind;
  platform: ProductPlatform;
  source: ProductSource;

  originalUrl?: string;
  affiliateUrl?: string;
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
  affiliateHealthStatus?: LinkHealthStatus;
  affiliateLinkErrors?: string;
  imageHealthStatus?: LinkHealthStatus;
  imageLastCheckedAt?: string;
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
  publicBlockReason?: string;
  autoPublished?: boolean;
  needsVerification?: boolean;
  qualityScore?: number;
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

export type LinkHealthStatus = 'ok' | 'redirect_ok' | 'timeout' | 'not_found' | 'server_error' | 'affiliate_error' | 'image_broken' | 'product_unavailable' | 'needs_manual_check';

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
