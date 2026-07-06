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
  | "unknown";

export type ProductScoreLabel =
  | "Nên làm ngay"
  | "Cần xác minh"
  | "Không nên làm";

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
