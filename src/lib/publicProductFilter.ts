import type { Product, ProductKind } from './types';
import {
  classifyProductKind,
  looksLikeVoucherOrCampaign,
} from './sourceItemClassifier';

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

const UNSAFE_SOURCE_VALUES = new Set<string>([
  'demo',
  'sample',
  'test',
  'internal',
  'mock',
  'placeholder',
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

function parsePositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1000 ? value : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/%/.test(trimmed)) return undefined;

  const normalizedText = normalizeText(trimmed);

  if (
      normalizedText.includes('mien phi') ||
      normalizedText.includes('free') ||
      normalizedText.includes('lien he') ||
      normalizedText.includes('contact')
  ) {
    return undefined;
  }

  const kMatch = trimmed.match(/^(\d+(?:[.,]\d+)?)\s?k$/i);
  if (kMatch) {
    const parsedK = Number(kMatch[1].replace(',', '.')) * 1000;
    return Number.isFinite(parsedK) && parsedK >= 1000 ? Math.round(parsedK) : undefined;
  }

  const digitsOnly = trimmed.replace(/[^\d]/g, '');
  if (!digitsOnly) return undefined;

  const parsed = Number(digitsOnly);

  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : undefined;
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

  return urls.some((url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()));
}

function hasPlatformOrSource(product: Product): boolean {
  const p = asRecord(product);

  return Boolean(
      normalizeText(p.platform) ||
      normalizeText(p.source) ||
      normalizeText(p.dataSource),
  );
}

function hasRealImage(product: Product): boolean {
  return Boolean(product.imageUrl && String(product.imageUrl).trim());
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

  return priceCandidates.some((value) => Boolean(parsePositiveNumber(value)));
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
        }) || looksLikeVoucherOrCampaign(product.title);

    if ((explicitKind === 'product' || explicitKind === 'deal') && looksUnsafe) {
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

  if (DEMO_TITLES.some((demoTitle) => normalizeText(demoTitle) === normalizedTitle)) {
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

export function isUnsafePublicKind(kind?: ProductKind | string): boolean {
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

/**
 * Với sản phẩm auto/import từ AccessTrade, nếu đã có field linkHealthStatus
 * thì chỉ cho public khi link là OK. Record cũ chưa có field vẫn không crash.
 */
function requiresKnownGoodLinkHealth(product: Product): boolean {
  const p = asRecord(product);

  const source = normalizeText(p.source || p.dataSource || p.platform);
  const importedFrom = normalizeText(p.importedFrom);
  const autoPublished = p.autoPublished === true;

  return (
      autoPublished ||
      source.includes('accesstrade') ||
      importedFrom.includes('accesstrade')
  );
}

function hasKnownGoodLinkHealth(product: Product): boolean {
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
 * Với sản phẩm auto/import từ AccessTrade, nếu đã có field imageHealthStatus
 * thì chỉ cho public khi ảnh là OK. Record cũ chưa có field vẫn không crash.
 */
function requiresKnownGoodImageHealth(product: Product): boolean {
  const p = asRecord(product);

  const source = normalizeText(p.source || p.dataSource || p.platform);
  const importedFrom = normalizeText(p.importedFrom);
  const autoPublished = p.autoPublished === true;

  return (
      autoPublished ||
      source.includes('accesstrade') ||
      importedFrom.includes('accesstrade')
  );
}

function hasKnownGoodImageHealth(product: Product): boolean {
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
      }) || looksLikeVoucherOrCampaign(product.title),
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

function isSourceExplicitlyUnverified(product: Product): boolean {
  const p = asRecord(product);

  return p.verifiedSource === false || p.sourceVerified === false || p.needsVerification === true;
}

function isApprovedOrPublished(product: Product): boolean {
  const status = normalizeText(product.status);

  return status === 'approved' || status === 'published';
}

function hasExplicitNonPublicDecision(product: Product): boolean {
  const p = asRecord(product);
  const publicDecision = normalizeText(p.publicDecision);

  if (!publicDecision) return false;

  return NON_PUBLIC_PUBLIC_DECISIONS.has(publicDecision);
}

function hasLowQualityScore(product: Product): boolean {
  const p = asRecord(product);

  const rawScore = p.sourceQualityScore ?? p.qualityScore;
  const score =
      typeof rawScore === 'number'
          ? rawScore
          : typeof rawScore === 'string'
              ? Number(rawScore)
              : undefined;

  if (score === undefined || !Number.isFinite(score)) return false;

  return score > 0 && score < 70;
}

export function getPublicProductBlockReason(product?: Product | null): string {
  if (!product) return 'Không có dữ liệu sản phẩm.';

  const p = asRecord(product);

  if (!isApprovedOrPublished(product)) {
    return 'Chưa được duyệt hoặc chưa publish.';
  }

  if (hasUnsafeFlags(product)) {
    return (
        normalizeText(p.publicBlockReason) ||
        normalizeText(p.nonProductReason) ||
        normalizeText(p.unpublishedReason) ||
        'Sản phẩm đang bị ẩn/lưu trữ hoặc là dữ liệu demo/test.'
    );
  }

  if (!product.title || !String(product.title).trim()) {
    return 'Thiếu tên sản phẩm.';
  }

  if (looksLikeDemoTitle(product.title)) {
    return 'Tiêu đề giống dữ liệu demo/test/sample.';
  }

  const effectiveKind = getEffectiveKind(product);

  if (isUnsafePublicKind(effectiveKind)) {
    if (effectiveKind === 'store_offer') return 'Chưa phải sản phẩm cụ thể.';
    if (effectiveKind === 'voucher') return 'Voucher/mã giảm giá không public như sản phẩm.';
    if (effectiveKind === 'campaign') return 'Campaign/chương trình khuyến mãi không public như sản phẩm.';
    return 'Chưa xác định được đây là sản phẩm thật.';
  }

  if (effectiveKind !== 'product' && effectiveKind !== 'deal') {
    return 'Loại dữ liệu không phải sản phẩm/deal thật.';
  }

  if (looksUnsafeForPublic(product)) {
    return 'Nội dung giống voucher/campaign/store offer, cần kiểm tra lại.';
  }

  if (isUnsafeSourceValue(p.source) || isUnsafeSourceValue(p.dataSource)) {
    return 'Nguồn dữ liệu là demo/sample/test/internal.';
  }

  if (hasExplicitNonPublicDecision(product)) {
    return (
        normalizeText(p.publicBlockReason) ||
        normalizeText(p.nonProductReason) ||
        normalizeText(p.autoPublishBlockedReason) ||
        'Public decision đang chặn sản phẩm khỏi public.'
    );
  }

  if (!hasPlatformOrSource(product)) {
    return 'Thiếu nền tảng hoặc nguồn dữ liệu.';
  }

  if (!hasExternalUrl(product)) {
    return 'Thiếu link sản phẩm hoặc affiliate link hợp lệ.';
  }

  if (!hasRealImage(product)) {
    return 'Thiếu ảnh sản phẩm.';
  }

  if (!hasRealPrice(product)) {
    return 'Thiếu giá sản phẩm thật.';
  }

  if (isManualUnverified(product)) {
    return 'Sản phẩm nhập tay chưa được xác minh.';
  }

  if (isSourceExplicitlyUnverified(product)) {
    return 'Nguồn sản phẩm chưa được xác minh hoặc đang cần review.';
  }

  if (hasLowQualityScore(product)) {
    return 'Điểm chất lượng nguồn thấp.';
  }

  if (isBrokenOrUnavailable(product)) {
    return normalizeText(p.unpublishedReason) || 'Link sản phẩm lỗi, bị chặn hoặc không khả dụng.';
  }

  if (!hasKnownGoodLinkHealth(product)) {
    return 'Link sản phẩm chưa được kiểm tra OK.';
  }

  if (hasUnsafeImageHealth(product)) {
    return normalizeText(p.unpublishedReason) || 'Ảnh sản phẩm lỗi hoặc không khả dụng.';
  }

  if (!hasKnownGoodImageHealth(product)) {
    return 'Ảnh sản phẩm chưa được kiểm tra OK.';
  }

  return '';
}

export function isPublicSafeProduct(product?: Product | null): boolean {
  return getPublicProductBlockReason(product) === '';
}