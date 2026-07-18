import type { Product, ProductKind } from './types';
import {
  classifyProductKind,
  looksLikeVoucherOrCampaign,
} from './sourceItemClassifier';
import { PRODUCT_INTELLIGENCE_CONFIG } from './product-intelligence/config';

const DEMO_TITLES = [
  'Tai nghe Bluetooth TWS Pro Max',
  'Balo laptop chống nước 15.6 inch',
];

const BROKEN_LINK_STATUSES = new Set<string>([
  'broken',
  'broken_link',
  'not_found',
  'not_allowed',
  'forbidden',
  'timeout',
  'affiliate_error',
  'image_broken',
  'product_unavailable',
  'server_error',
  'error',
  'failed',
  'dead',
  'redirect_error',
  'unavailable',
  'out_of_stock',
  'missing',
  'invalid',
  'blocked',
]);

const SAFE_LINK_STATUSES = new Set<string>([
  'ok',
  'healthy',
  'valid',
  'available',
  'pass',
  'passed',
]);

const BROKEN_IMAGE_STATUSES = new Set<string>([
  'image_broken',
  'invalid_image',
  'forbidden',
  'hotlink_blocked',
  'too_small',
  'too_large',
  'dark_image_suspected',
  'placeholder',
  'timeout',
  'error',
  'failed',
  'broken',
  'not_found',
  'missing',
  'invalid',
  'blocked',
]);

const SAFE_IMAGE_STATUSES = new Set<string>([
  'ok',
  'healthy',
  'valid',
  'available',
  'pass',
  'passed',
]);

const UNCONFIRMED_MONITORING_STATES = new Set<string>([
  'DEGRADED',
  'RECHECKING',
  'RETRY_SCHEDULED',
]);

const UNSAFE_SOURCE_VALUES = new Set<string>([
  'demo',
  'sample',
  'test',
  'internal',
  'mock',
  'placeholder',
  'fake',
]);

const NON_PUBLIC_KINDS = new Set<ProductKind | string>([
  'voucher',
  'campaign',
  'store_offer',
  'unknown',
]);

const NON_PUBLIC_PUBLIC_DECISIONS = new Set<string>([
  'archived',
  'blocked',
  'needs_review',
  'hidden',
  'internal_only',
  'not_public',
]);

type ProductRecord = Product &
    Record<string, unknown> & {
  sourceItemKind?: ProductKind;
  kind?: ProductKind;

  source?: unknown;
  dataSource?: unknown;
  importedFrom?: unknown;
  sourceType?: unknown;
  platform?: unknown;
  rawSourceKind?: unknown;

  verifiedSource?: boolean;
  sourceVerified?: boolean;
  needsVerification?: boolean;

  publicHidden?: boolean;
  archived?: boolean;
  deleted?: boolean;
  hidden?: boolean;

  isDemo?: boolean;
  isSample?: boolean;
  isTest?: boolean;
  isInternal?: boolean;

  linkHealthStatus?: unknown;
  linkHealth?: unknown;
  imageHealthStatus?: unknown;
  imageHealth?: unknown;

  affiliateUrl?: unknown;
  originalUrl?: unknown;
  url?: unknown;
  productUrl?: unknown;
  landingUrl?: unknown;
  landingPage?: unknown;

  currentPrice?: unknown;
  originalPrice?: unknown;
  priceValue?: unknown;

  publicDecision?: unknown;
  publicBlockReason?: unknown;
  nonProductReason?: unknown;
  autoPublishBlockedReason?: unknown;
  unpublishedReason?: unknown;

  autoPublished?: boolean;
  aiApproved?: boolean;

  qualityScore?: unknown;
  sourceQualityScore?: unknown;
};

function asRecord(product: Product): ProductRecord {
  return product as ProductRecord;
}

function normalizeText(value?: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
}

function getDisplayText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1000
        ? value
        : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  if (!trimmed || /%/.test(trimmed)) {
    return undefined;
  }

  const normalizedText = normalizeText(trimmed);

  if (
      normalizedText.includes('mien phi') ||
      normalizedText.includes('free') ||
      normalizedText.includes('lien he') ||
      normalizedText.includes('contact')
  ) {
    return undefined;
  }

  const millionMatch = normalizedText.match(
      /(\d+(?:[.,]\d+)?)\s*(trieu|million)\b/i,
  );

  if (millionMatch) {
    const parsedMillion =
        Number(millionMatch[1].replace(',', '.')) * 1_000_000;

    return Number.isFinite(parsedMillion) && parsedMillion >= 1000
        ? Math.round(parsedMillion)
        : undefined;
  }

  const thousandMatch = normalizedText.match(
      /(\d+(?:[.,]\d+)?)\s*(k|nghin|ngan)\b/i,
  );

  if (thousandMatch) {
    const parsedThousand =
        Number(thousandMatch[1].replace(',', '.')) * 1000;

    return Number.isFinite(parsedThousand) && parsedThousand >= 1000
        ? Math.round(parsedThousand)
        : undefined;
  }

  const groupedNumberMatch = trimmed.match(
      /\d{1,3}(?:[.,]\d{3})+/,
  );

  if (groupedNumberMatch) {
    const groupedValue = Number(
        groupedNumberMatch[0].replace(/[^\d]/g, ''),
    );

    return Number.isFinite(groupedValue) && groupedValue >= 1000
        ? groupedValue
        : undefined;
  }

  const plainNumberMatch = trimmed.match(/\d{4,}/);

  if (plainNumberMatch) {
    const plainValue = Number(plainNumberMatch[0]);

    return Number.isFinite(plainValue) && plainValue >= 1000
        ? plainValue
        : undefined;
  }

  return undefined;
}

function isValidHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;

  const url = value.trim();

  if (!/^https?:\/\//i.test(url)) {
    return false;
  }

  try {
    const parsed = new URL(url);

    return (
        Boolean(parsed.hostname) &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

function hasExternalUrl(product: Product): boolean {
  const p = asRecord(product);

  const urls = [
    p.affiliateUrl,
    p.originalUrl,
    p.url,
    p.productUrl,
    p.landingUrl,
    p.landingPage,
  ];

  return urls.some((url) => isValidHttpUrl(url));
}

function hasAffiliateUrl(product: Product): boolean {
  const p = asRecord(product);

  return isValidHttpUrl(p.affiliateUrl);
}

function hasPlatformOrSource(product: Product): boolean {
  const p = asRecord(product);

  return Boolean(
      normalizeText(p.platform) ||
      normalizeText(p.source) ||
      normalizeText(p.dataSource) ||
      normalizeText(p.importedFrom),
  );
}

function hasRealImage(product: Product): boolean {
  if (!product.imageUrl) return false;

  const imageUrl = String(product.imageUrl).trim();

  if (!imageUrl) return false;

  const normalizedImageUrl = normalizeText(imageUrl);

  if (
      normalizedImageUrl.includes('placeholder') ||
      normalizedImageUrl.includes('sample') ||
      normalizedImageUrl.includes('demo') ||
      normalizedImageUrl.includes('fake')
  ) {
    return false;
  }

  return (
      isValidHttpUrl(imageUrl) ||
      imageUrl.startsWith('/')
  );
}

function hasRealPrice(product: Product): boolean {
  const p = asRecord(product);

  const priceCandidates = [
    product.price,
    product.salePrice,
    p.currentPrice,
    p.originalPrice,
    p.priceValue,
  ];

  return priceCandidates.some(
      (value) => Boolean(parsePositiveNumber(value)),
  );
}

function getEffectiveKind(product: Product): ProductKind {
  const p = asRecord(product);

  const explicitKind = p.sourceItemKind || p.kind;

  if (explicitKind && explicitKind !== 'unknown') {
    const looksUnsafe =
        looksLikeVoucherOrCampaign({
          title: product.title,
          description: product.description,
          rawSourceKind: p.rawSourceKind,
          source: p.source,
          raw: product,
        }) ||
        looksLikeVoucherOrCampaign(product.title);

    if (
        (explicitKind === 'product' || explicitKind === 'deal') &&
        looksUnsafe
    ) {
      return classifyProductKind({
        ...product,
        kind: undefined,
        sourceItemKind: undefined,
      } as Partial<Product>);
    }

    return explicitKind;
  }

  return classifyProductKind({
    ...product,
    kind: undefined,
    sourceItemKind: undefined,
  } as Partial<Product>);
}

function hasUnsafeFlags(product: Product): boolean {
  const p = asRecord(product);

  return Boolean(
      p.publicHidden === true ||
      p.archived === true ||
      p.deleted === true ||
      p.hidden === true ||
      p.isDemo === true ||
      p.isSample === true ||
      p.isTest === true ||
      p.isInternal === true,
  );
}

export function looksLikeDemoTitle(title?: string): boolean {
  if (!title) return false;

  const normalizedTitle = normalizeText(title);

  if (
      DEMO_TITLES.some(
          (demoTitle) =>
              normalizeText(demoTitle) === normalizedTitle,
      )
  ) {
    return true;
  }

  return (
      normalizedTitle.includes('demo') ||
      normalizedTitle.includes('sample') ||
      normalizedTitle.includes('test product') ||
      normalizedTitle.includes('test san pham') ||
      normalizedTitle.includes('san pham test') ||
      normalizedTitle.includes('du lieu test') ||
      normalizedTitle.includes('placeholder') ||
      normalizedTitle.includes('fake')
  );
}

export function isUnsafeSourceValue(source?: unknown): boolean {
  const normalizedSource = normalizeText(source);

  if (!normalizedSource) return false;

  return UNSAFE_SOURCE_VALUES.has(normalizedSource);
}

export function isUnsafePublicKind(
    kind?: ProductKind | string,
): boolean {
  if (!kind) return true;

  return NON_PUBLIC_KINDS.has(kind);
}

function isBrokenOrUnavailable(product: Product): boolean {
  const p = asRecord(product);

  const linkHealthStatus =
      normalizeText(p.linkHealthStatus) ||
      normalizeText(p.linkHealth);

  if (!linkHealthStatus) return false;

  return BROKEN_LINK_STATUSES.has(linkHealthStatus);
}

function isAccessTradeProduct(product: Product): boolean {
  const p = asRecord(product);

  const sourceText = normalizeText(
      [
        p.source,
        p.dataSource,
        p.importedFrom,
        p.platform,
        p.sourceType,
      ].join(' '),
  );

  return (
      sourceText.includes('accesstrade') ||
      sourceText.includes('access trade')
  );
}

/**
 * Sản phẩm tự động hoặc sản phẩm AccessTrade phải có kết quả
 * kiểm tra link OK trước khi xuất hiện ngoài public.
 */
function requiresKnownGoodLinkHealth(
    product: Product,
): boolean {
  const p = asRecord(product);

  return (
      p.autoPublished === true ||
      isAccessTradeProduct(product)
  );
}

function hasKnownGoodLinkHealth(
    product: Product,
): boolean {
  const p = asRecord(product);

  const linkHealthStatus =
      normalizeText(p.linkHealthStatus) ||
      normalizeText(p.linkHealth);

  if (!linkHealthStatus) {
    return !requiresKnownGoodLinkHealth(product);
  }

  return SAFE_LINK_STATUSES.has(linkHealthStatus);
}

function hasUnsafeImageHealth(product: Product): boolean {
  const p = asRecord(product);

  const imageStatus =
      normalizeText(p.imageHealthStatus) ||
      normalizeText(p.imageHealth);

  if (!imageStatus) return false;

  return BROKEN_IMAGE_STATUSES.has(imageStatus);
}

/**
 * A durable auto-publication remains visible while a monitor confirms a first
 * failure. This exemption is deliberately limited to health verdicts: every
 * source, product-kind, duplicate, editorial, and explicit-hide gate remains.
 */
function canRetainPublicDuringUnconfirmedMonitoring(product: Product): boolean {
  return product.schemaVersion === 2
    && product.autoPublished === true
    && product.status === 'published'
    && product.publicHidden === false
    && product.needsVerification === false
    && Boolean(product.publicationEffectKey)
    && Boolean(product.publishedAt && Number.isFinite(Date.parse(product.publishedAt)))
    && UNCONFIRMED_MONITORING_STATES.has(String(product.lifecycleState || ''));
}

/**
 * Sản phẩm tự động hoặc sản phẩm AccessTrade phải có kết quả
 * kiểm tra ảnh OK trước khi xuất hiện ngoài public.
 */
function requiresKnownGoodImageHealth(
    product: Product,
): boolean {
  const p = asRecord(product);

  return (
      p.autoPublished === true ||
      isAccessTradeProduct(product)
  );
}

function hasKnownGoodImageHealth(
    product: Product,
): boolean {
  const p = asRecord(product);

  const imageStatus =
      normalizeText(p.imageHealthStatus) ||
      normalizeText(p.imageHealth);

  if (!imageStatus) {
    return !requiresKnownGoodImageHealth(product);
  }

  return SAFE_IMAGE_STATUSES.has(imageStatus);
}

function looksUnsafeForPublic(product: Product): boolean {
  const p = asRecord(product);

  return Boolean(
      looksLikeVoucherOrCampaign({
        title: product.title,
        description: product.description,
        rawSourceKind: p.rawSourceKind,
        source: p.source,
        raw: product,
      }) ||
      looksLikeVoucherOrCampaign(product.title),
  );
}

function isManualUnverified(product: Product): boolean {
  const p = asRecord(product);

  return (
      normalizeText(p.source) === 'manual' &&
      p.verifiedSource !== true &&
      p.sourceVerified !== true
  );
}

function isSourceExplicitlyUnverified(
    product: Product,
): boolean {
  const p = asRecord(product);

  return (
      p.verifiedSource === false ||
      p.sourceVerified === false ||
      p.needsVerification === true
  );
}

function isPublished(product: Product): boolean {
  const status = normalizeText(product.status);

  return status === 'published';
}

function hasHighDuplicateConfidence(product: Product): boolean {
  const confidence = Number(product.duplicateConfidence);

  return (
      Number.isFinite(confidence) &&
      confidence >= PRODUCT_INTELLIGENCE_CONFIG.thresholds.duplicateHigh
  );
}

function hasExplicitNonPublicDecision(
    product: Product,
): boolean {
  const p = asRecord(product);

  const publicDecision = normalizeText(
      p.publicDecision,
  );

  if (!publicDecision) return false;

  return NON_PUBLIC_PUBLIC_DECISIONS.has(
      publicDecision,
  );
}

function getQualityScore(
    product: Product,
): number | undefined {
  const p = asRecord(product);

  const rawScore =
      p.sourceQualityScore ??
      p.qualityScore;

  if (
      typeof rawScore === 'number' &&
      Number.isFinite(rawScore)
  ) {
    return rawScore;
  }

  if (
      typeof rawScore === 'string' &&
      rawScore.trim()
  ) {
    const parsed = Number(rawScore);

    return Number.isFinite(parsed)
        ? parsed
        : undefined;
  }

  return undefined;
}

function requiresKnownQualityScore(
    product: Product,
): boolean {
  const p = asRecord(product);

  return (
      isAccessTradeProduct(product) ||
      p.autoPublished === true
  );
}

function isRequiredQualityScoreMissing(
    product: Product,
): boolean {
  if (!requiresKnownQualityScore(product)) {
    return false;
  }

  const score = getQualityScore(product);

  return (
      score === undefined ||
      score <= 0
  );
}

function hasLowQualityScore(product: Product): boolean {
  const score = getQualityScore(product);

  if (
      score === undefined ||
      !Number.isFinite(score)
  ) {
    return false;
  }

  return score > 0 && score < 70;
}

function translateInternalBlockReason(
    value: string,
): string {
  const normalized = normalizeText(value);

  if (!normalized) return '';

  if (normalized === 'auto_mode_disabled') {
    return 'AutoPilot đang tắt hoặc chưa cho phép tự public.';
  }

  if (normalized === 'free_only_guard_failed') {
    return 'Free Only Guard chưa đạt yêu cầu.';
  }

  if (
      normalized.startsWith(
          'blocked_non_product_kind_',
      ) ||
      normalized.startsWith('blocked_kind_')
  ) {
    return 'Loại dữ liệu này không phải sản phẩm cụ thể.';
  }

  if (
      normalized ===
      'missing_or_too_short_title'
  ) {
    return 'Thiếu tên sản phẩm hoặc tên quá ngắn.';
  }

  if (
      normalized ===
      'title_not_specific_enough'
  ) {
    return 'Tên chưa đủ cụ thể để xác định sản phẩm thật.';
  }

  if (
      normalized ===
      'title_looks_like_voucher_campaign_or_store_offer'
  ) {
    return 'Tên giống voucher/campaign/ưu đãi shop.';
  }

  if (
      normalized ===
      'classifier_detected_voucher_or_campaign'
  ) {
    return 'Bộ phân loại phát hiện dữ liệu giống voucher hoặc campaign.';
  }

  if (
      normalized ===
      'source_not_verified_for_auto_publish' ||
      normalized ===
      'source_not_verified'
  ) {
    return 'Nguồn sản phẩm chưa được xác minh.';
  }

  if (normalized === 'missing_platform') {
    return 'Thiếu nền tảng hoặc nguồn sản phẩm.';
  }

  if (normalized === 'missing_affiliate_url') {
    return 'Thiếu affiliate link hợp lệ.';
  }

  if (normalized === 'missing_product_url') {
    return 'Thiếu link sản phẩm hợp lệ.';
  }

  if (
      normalized === 'missing_image' ||
      normalized ===
      'missing_image_before_health_check'
  ) {
    return 'Thiếu ảnh sản phẩm.';
  }

  if (normalized === 'missing_real_price') {
    return 'Thiếu giá sản phẩm thật.';
  }

  if (normalized === 'needs_verification') {
    return 'Sản phẩm đang cần xác minh thêm.';
  }

  if (
      normalized.startsWith('public_decision_')
  ) {
    return 'Quyết định Safe Publish hiện đang chặn sản phẩm.';
  }

  if (
      normalized ===
      'source_quality_score_too_low'
  ) {
    return 'Điểm chất lượng nguồn thấp.';
  }

  if (
      normalized ===
      'missing_link_before_health_check'
  ) {
    return 'Thiếu link trước khi kiểm tra sức khoẻ sản phẩm.';
  }

  if (
      normalized.startsWith(
          'health_check_error',
      )
  ) {
    return 'Lỗi khi kiểm tra link hoặc ảnh, cần xem xét lại.';
  }

  return value;
}

function getStoredBlockReason(
    product: Product,
): string {
  const p = asRecord(product);

  const rawReason = getDisplayText(
      p.publicBlockReason,
      p.nonProductReason,
      p.unpublishedReason,
      p.autoPublishBlockedReason,
  );

  return translateInternalBlockReason(
      rawReason,
  );
}

export function getPublicProductBlockReason(
    product?: Product | null,
): string {
  if (!product) {
    return 'Không có dữ liệu sản phẩm.';
  }

  const p = asRecord(product);
  const retainDuringMonitoring = canRetainPublicDuringUnconfirmedMonitoring(product);

  if (!isPublished(product)) {
    return 'Chưa được duyệt hoặc chưa publish.';
  }

  // A schema-v2 autonomous write is not public until its durable lifecycle
  // event is finalized. This keeps the storefront fail-closed across a worker
  // crash after the product write but before PUBLISHING -> PUBLISHED.
  if (
      product.schemaVersion === 2 &&
      product.autoPublished === true &&
      !['PUBLISHED', 'DEGRADED', 'RECHECKING', 'RETRY_SCHEDULED'].includes(String(product.lifecycleState || ''))
  ) {
    return 'Autonomous publication lifecycle is not finalized.';
  }

  if (hasUnsafeFlags(product)) {
    return (
        getStoredBlockReason(product) ||
        'Sản phẩm đang bị ẩn/lưu trữ hoặc là dữ liệu demo/test.'
    );
  }

  if (
      !product.title ||
      !String(product.title).trim()
  ) {
    return 'Thiếu tên sản phẩm.';
  }

  if (looksLikeDemoTitle(product.title)) {
    return 'Tiêu đề giống dữ liệu demo/test/sample.';
  }

  const effectiveKind =
      getEffectiveKind(product);

  if (isUnsafePublicKind(effectiveKind)) {
    if (effectiveKind === 'store_offer') {
      return 'Chưa phải sản phẩm cụ thể.';
    }

    if (effectiveKind === 'voucher') {
      return 'Voucher/mã giảm giá không public như sản phẩm.';
    }

    if (effectiveKind === 'campaign') {
      return 'Campaign/chương trình khuyến mãi không public như sản phẩm.';
    }

    return 'Chưa xác định được đây là sản phẩm thật.';
  }

  if (
      effectiveKind !== 'product' &&
      effectiveKind !== 'deal'
  ) {
    return 'Loại dữ liệu không phải sản phẩm/deal thật.';
  }

  if (looksUnsafeForPublic(product)) {
    return 'Nội dung giống voucher/campaign/store offer, cần kiểm tra lại.';
  }

  if (
      isUnsafeSourceValue(p.source) ||
      isUnsafeSourceValue(p.dataSource) ||
      isUnsafeSourceValue(p.importedFrom)
  ) {
    return 'Nguồn dữ liệu là demo/sample/test/internal.';
  }

  if (
      hasExplicitNonPublicDecision(product)
  ) {
    return (
        getStoredBlockReason(product) ||
        'Public decision đang chặn sản phẩm khỏi public.'
    );
  }

  if (hasHighDuplicateConfidence(product)) {
    return 'Sản phẩm có nguy cơ trùng lặp cao và cần được xử lý trước khi public.';
  }

  if (!hasPlatformOrSource(product)) {
    return 'Thiếu nền tảng hoặc nguồn dữ liệu.';
  }

  if (!hasExternalUrl(product)) {
    return 'Thiếu link sản phẩm hoặc affiliate link hợp lệ.';
  }

  if (
      isAccessTradeProduct(product) &&
      !hasAffiliateUrl(product)
  ) {
    return 'Sản phẩm AccessTrade thiếu affiliate link hợp lệ.';
  }

  if (!hasRealImage(product)) {
    return 'Thiếu ảnh sản phẩm hợp lệ.';
  }

  if (!hasRealPrice(product)) {
    return 'Thiếu giá sản phẩm thật.';
  }

  if (isManualUnverified(product)) {
    return 'Sản phẩm nhập tay chưa được xác minh.';
  }

  if (
      isSourceExplicitlyUnverified(product)
  ) {
    return 'Nguồn sản phẩm chưa được xác minh hoặc đang cần review.';
  }

  if (
      isRequiredQualityScoreMissing(product)
  ) {
    return 'Sản phẩm tự động chưa có điểm chất lượng nguồn hợp lệ.';
  }

  if (hasLowQualityScore(product)) {
    return 'Điểm chất lượng nguồn thấp.';
  }

  if (!retainDuringMonitoring && isBrokenOrUnavailable(product)) {
    return (
        getDisplayText(
            p.unpublishedReason,
            p.publicBlockReason,
        ) ||
        'Link sản phẩm lỗi, bị chặn hoặc không khả dụng.'
    );
  }

  if (!retainDuringMonitoring && !hasKnownGoodLinkHealth(product)) {
    return 'Link sản phẩm chưa được kiểm tra OK.';
  }

  if (!retainDuringMonitoring && hasUnsafeImageHealth(product)) {
    return (
        getDisplayText(
            p.unpublishedReason,
            p.publicBlockReason,
        ) ||
        'Ảnh sản phẩm lỗi hoặc không khả dụng.'
    );
  }

  if (!retainDuringMonitoring && !hasKnownGoodImageHealth(product)) {
    return 'Ảnh sản phẩm chưa được kiểm tra OK.';
  }

  const review = (p.reviewContent && typeof p.reviewContent === 'object' ? p.reviewContent : {}) as Record<string, unknown>;
  if (
      review.reviewStatus !== 'approved' ||
      Number(review.contentQualityScore || 0) < 75 ||
      Number(review.originalityScore || 0) < 70 ||
      Number(review.seoReadinessScore || 0) < 80 ||
      (Array.isArray(review.reviewBlockReasons) && review.reviewBlockReasons.length > 0)
  ) {
    return 'Nội dung đánh giá chưa vượt cổng chất lượng và SEO.';
  }

  return '';
}

export function isPublicSafeProduct(
    product?: Product | null,
): boolean {
  return (
      getPublicProductBlockReason(product) === ''
  );
}
