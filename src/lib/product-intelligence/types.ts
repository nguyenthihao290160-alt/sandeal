import type { Product, ProductPlatform, ProductSource } from '@/lib/types';

export type QualityBand = 'good' | 'fair' | 'needs_data' | 'poor' | 'blocked';
export type OpportunityBand = 'priority' | 'recommended' | 'consider' | 'low' | 'blocked';
export type DealBand = 'featured' | 'consider' | 'normal' | 'verify' | 'ineligible';

export interface ScoreRule {
  code: string;
  label: string;
  points: number;
  maximum: number;
  status: 'passed' | 'failed' | 'warning' | 'blocker';
  recommendation?: string;
}

export interface QualityScoreResult {
  score: number;
  band: QualityBand;
  passedRules: string[];
  failedRules: string[];
  warnings: string[];
  blockers: string[];
  recommendations: string[];
  breakdown: Record<string, number>;
  rules: ScoreRule[];
  version: string;
  calculatedAt: string;
}

export interface OpportunityScoreResult {
  score: number;
  band: OpportunityBand;
  reasons: string[];
  warnings: string[];
  breakdown: Record<string, number>;
  version: string;
  calculatedAt: string;
}

export interface DealScoreResultV2 {
  dealScore: number;
  dealBand: DealBand;
  reasons: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  confidence: 'high' | 'medium' | 'low' | 'none';
  breakdown: Record<string, number>;
  calculatedAt: string;
  version: string;
}

export interface PriceSnapshot {
  id: string;
  productId: string;
  source: ProductSource;
  price?: number;
  salePrice?: number;
  currency: 'VND';
  availability: 'available' | 'unavailable' | 'unknown';
  capturedAt: string;
  operationId: string;
  sourceHash: string;
}

export interface PriceStatistics {
  productId: string;
  current?: number;
  lowest?: number;
  highest?: number;
  average?: number;
  lastChange?: number;
  lastChangePercent?: number;
  changeCount: number;
  trackingDays: number;
  snapshots: number;
}

export interface DuplicateCandidate {
  productId: string;
  confidence: number;
  matchedSignals: string[];
  differentSignals: string[];
  reason: string;
}

export interface DuplicateGroup {
  id: string;
  productIds: string[];
  candidates: DuplicateCandidate[];
  suggestedPrimaryId: string;
  confidence: number;
  status: 'pending' | 'kept_separate' | 'merged' | 'ignored';
  reason?: string;
  calculatedAt: string;
  algorithmVersion: string;
  operationId: string;
  mergeHistory?: Array<{
    operationId: string;
    primaryId: string;
    secondaryIds: string[];
    metadataBackup: Array<Partial<Product> & Pick<Product, 'id'>>;
    mergedAt: string;
  }>;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewHistory?: Array<{
    operationId: string;
    status: 'kept_separate' | 'ignored';
    reason: string;
    actor: string;
    reviewedAt: string;
  }>;
}

export interface ImportRowResult {
  row: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  action: 'create' | 'update' | 'duplicate' | 'skip';
  normalized?: Partial<Product>;
}

export interface ImportPreview {
  previewId: string;
  expiresAt: string;
  rows: ImportRowResult[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  creates: number;
  updates: number;
  suspectedDuplicates: number;
  truncated: boolean;
  publicSideEffect: false;
}

export interface ManualUrlPreview {
  valid: boolean;
  normalizedUrl?: string;
  hostname?: string;
  status: 'metadata_required' | 'blocked';
  reason: string;
  adapterSupported: false;
  publicSideEffect: false;
}

export interface PendingManualSource {
  id: string;
  originalUrl: string;
  canonicalUrl: string;
  hostname: string;
  title: string;
  affiliateUrl?: string;
  imageUrl?: string;
  price?: number;
  salePrice?: number;
  platform: ProductPlatform;
  source: 'manual';
  category?: string;
  brand?: string;
  sku?: string;
  externalId?: string;
  status: 'pending_review';
  adapterSupported: false;
  metadataSubmitted: true;
  publicSideEffect: false;
  createdBy: string;
  operationId: string;
  createdAt: string;
  updatedAt: string;
}

export type ContentWorkflowStatus = NonNullable<Product['contentWorkflowStatus']>;
export type DraftClaimType = 'VERIFIED_SOURCE' | 'DERIVED' | 'AI_DRAFT' | 'HUMAN_CONFIRMED' | 'UNVERIFIED';

export interface ContentDraftClaim {
  id: string;
  field: string;
  text: string;
  type: DraftClaimType;
  evidenceFactIds: string[];
}

export interface ContentDraft {
  id: string;
  productId: string;
  status: ContentWorkflowStatus;
  title: string;
  summary: string;
  verdict: string;
  strengths: string[];
  limitations: string[];
  suitableFor: string[];
  notSuitableFor: string[];
  buyingNotes: string[];
  verifiedSpecifications: Record<string, string | number>;
  faq: Array<{ question: string; answer: string }>;
  metaTitle: string;
  metaDescription: string;
  slug: string;
  affiliateDisclosure: string;
  claims: ContentDraftClaim[];
  assignee?: string;
  scheduledAt?: string;
  lastEditorialCheck?: EditorialCheckResult;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EditorialIssue {
  code: string;
  field: string;
  severity: 'warning' | 'error' | 'blocker';
  message: string;
  suggestedFix: string;
}

export interface EditorialCheckResult {
  status: 'READY' | 'NEEDS_EDIT' | 'NEEDS_VERIFICATION' | 'BLOCKED';
  issues: EditorialIssue[];
  checkedAt: string;
}

export interface OutboundEvent {
  id: string;
  eventType:
    | 'view'
    | 'click'
    | 'PUBLIC_SEARCH'
    | 'SEARCH_NO_RESULT'
    | 'CATEGORY_VIEW'
    | 'PRODUCT_CARD_VIEW'
    | 'PRODUCT_CARD_CLICK'
    | 'PRODUCT_DETAIL_VIEW'
    | 'PRICE_HISTORY_OPEN'
    | 'COMPARE_ADD'
    | 'COMPARE_OPEN'
    | 'OUTBOUND_CLICK'
    | 'GUIDE_VIEW';
  productId?: string;
  source?: string;
  campaign?: string;
  contentPageId?: string;
  contextKey?: string;
  resultCount?: number;
  timestamp: string;
  referrerCategory: 'search' | 'social' | 'internal' | 'direct' | 'other';
  deviceCategory?: 'mobile' | 'tablet' | 'desktop' | 'other';
}

export interface GrowthDaily {
  id: string;
  day: string;
  views: number;
  clicks: number;
  ctr?: number;
  listViews?: number;
  detailViews?: number;
  outboundClicks?: number;
  searches?: number;
  noResultSearches?: number;
  compareOpens?: number;
  productClicks: Record<string, number>;
  sourceClicks: Record<string, number>;
  contentClicks: Record<string, number>;
  updatedAt: string;
}

export type AlertSeverity = 'info' | 'attention' | 'important' | 'critical';
export type AlertStatus = 'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'ignored';

export interface ProductAlert {
  id: string;
  deduplicationKey: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  entityType: string;
  entityId?: string;
  operationId: string;
  suggestedAction: string;
  status: AlertStatus;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  ignoredReason?: string;
  cooldownUntil?: string;
}

export interface RecommendedAction {
  id: string;
  deduplicationKey: string;
  title: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  objectCount: number;
  impact: string;
  estimatedTime: string;
  href: string;
  completionCriteria: string;
  status: 'new' | 'seen' | 'snoozed' | 'ignored';
  createdAt: string;
  cooldownUntil?: string;
  ignoredReason?: string;
}

export interface SavedView {
  id: string;
  name: string;
  page: 'products' | 'quality' | 'duplicates' | 'content' | 'tasks' | 'alerts';
  filters: Record<string, string | number | boolean>;
  sort?: string;
  columns: string[];
  viewMode: 'list' | 'grid' | 'table' | 'kanban' | 'calendar';
  createdBy: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
