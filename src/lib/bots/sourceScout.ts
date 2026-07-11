// ===========================================
// Source Scout Bot
// Finds candidate products from real sources
// AutoPilot mode: safely auto-publishes verified real products only
// ===========================================
// Rules:
// - Safe Mode ON by default.
// - Free Only ON by policy. This bot does not call paid AI.
// - AccessTrade product/datafeed items are prioritized.
// - Voucher / campaign / store offer / unknown items never auto-publish.
// - A real product is health-checked before its final public state is saved.
// - No fake product, price, image, stock, review, or user experience.

import type { Product, ProductKind } from '../types';
import { BotContext } from './context';
import { listProducts, createProduct, updateProduct, getAllProducts } from '../storage/products';
import { looksLikeVoucherOrCampaign } from '../sourceItemClassifier';
import {
  isAccessTradeConfigured,
  mapAccessTradeToProduct,
  searchAccessTrade,
  type NormalizedAccessTradeItem,
} from '../integrations/accesstrade';
import { checkLinkHealth, checkImageHealth } from './productHealthCheck';

type SourceName = 'local' | 'accesstrade' | 'manual' | 'all';

type MutableProductDraft = Partial<Product> & Record<string, unknown>;

type SafeAutoPublishDecision = {
  allowed: boolean;
  reason: string;
};

type HealthGuardDecision = {
  allowed: boolean;
  reason: string;
  blockedBy?: 'link' | 'image' | 'health_error';
  updates: MutableProductDraft;
};

type ScanCounters = {
  found: number;
  created: number;
  updated: number;
  saved: number;
  candidates: number;
  realProducts: number;
  storeOffers: number;
  vouchers: number;
  campaigns: number;
  unknown: number;
  published: number;
  needsReview: number;
  archived: number;
  blockedByLink: number;
  blockedByImage: number;
  healthErrors: number;
  duplicate: number;
  skipped: number;
};

type ExistingProductIndex = {
  externalIds: Map<string, Product>;
  urls: Map<string, Product>;
  fallbackKeys: Map<string, Product>;
};

const AUTO_SAFE_MODE = process.env.AI_AUTO_MODE !== 'false';
const AUTO_APPROVE_SAFE_PRODUCTS = process.env.AUTO_APPROVE_SAFE_PRODUCTS !== 'false';
const AUTO_PUBLISH_SAFE_PRODUCTS = process.env.AUTO_PUBLISH_SAFE_PRODUCTS !== 'false';

// Hard policy for this bot.
// Do not wire paid AI/API behavior here.
const FREE_ONLY_ENFORCED = true;
const ALLOW_PAID_AI = false;
const COST_MODE = 'safe_free';

// Source Scout should prioritize real product/datafeed results.
// The AccessTrade dashboard can still search "all" kinds for inspection.
const ACCESS_TRADE_SCAN_KIND = 'product' as const;

const ACCESS_TRADE_KEYWORDS = [
  'iphone',
  'điện thoại',
  'laptop',
  'tai nghe',
  'máy lọc không khí',
  'nồi chiên không dầu',
  'skincare',
  'kem chống nắng',
  'mẹ và bé',
  'gia dụng',
  'thời trang',
  'đồng hồ',
  'bàn phím',
  'chuột không dây',
  'sạc dự phòng',
  'máy hút bụi',
  'máy xay sinh tố',
  'tã em bé',
  'sữa tắm',
  'serum',
];

const NON_PUBLIC_KINDS = new Set<string>([
  'voucher',
  'campaign',
  'store_offer',
  'unknown',
]);

const GENERIC_OR_UNSAFE_TITLE_TERMS = [
  'demo',
  'test product',
  'san pham test',
  'sample',
  'internal',
  'placeholder',
  'fake',
  'voucher',
  'coupon',
  'ma giam gia',
  'ma uu dai',
  'ma khuyen mai',
  'code giam',
  'nhap ma',
  'official store',
  'official shop',
  'uu dai shop',
  'khuyen mai shop',
  'chien dich',
  'campaign',
  'cashback',
  'hoan tien',
  'toan shop',
  'toan san',
  'tat ca san pham',
];

function getText(value: unknown): string {
  if (typeof value === 'string') return value.trim();

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }

  return '';
}

function normalizeText(value: unknown): string {
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

function parsePriceNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1000 ? value : undefined;
  }

  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();

  if (!trimmed || /%/.test(trimmed)) return undefined;

  const normalizedText = normalizeText(trimmed);

  if (
      normalizedText.includes('mien phi') ||
      normalizedText.includes('free') ||
      normalizedText.includes('lien he') ||
      normalizedText.includes('contact')
  ) {
    return undefined;
  }

  const kMatch = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*k$/i);

  if (kMatch) {
    const parsedK = Number(kMatch[1].replace(',', '.')) * 1000;
    return Number.isFinite(parsedK) && parsedK >= 1000
        ? Math.round(parsedK)
        : undefined;
  }

  // For ranges such as "1.299.000 - 1.599.000", use the first valid amount.
  const firstSegment = trimmed.split(/\s*(?:-|–|—|~|đến|toi|to)\s*/i)[0]?.trim() || trimmed;
  const digitsOnly = firstSegment.replace(/[^\d]/g, '');

  if (!digitsOnly) return undefined;

  const parsed = Number(digitsOnly);

  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : undefined;
}

function isValidHttpUrl(value: unknown): boolean {
  const text = getText(value);

  if (!text) return false;

  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function normalizeComparableUrl(value: unknown): string {
  const text = getText(value);

  if (!text) return '';

  try {
    const url = new URL(text);
    url.hash = '';

    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return normalizeText(text).replace(/\/+$/, '');
  }
}

function isProductLikeKind(kind: ProductKind | string | undefined): boolean {
  return kind === 'product' || kind === 'deal';
}

function isBlockedNonProductKind(kind: ProductKind | string | undefined): boolean {
  return !kind || NON_PUBLIC_KINDS.has(kind);
}

function getNonProductReason(kind: ProductKind | string | undefined): string {
  switch (kind) {
    case 'store_offer':
      return 'Chưa phải sản phẩm cụ thể.';
    case 'voucher':
      return 'Voucher/mã giảm giá không public như sản phẩm.';
    case 'campaign':
      return 'Campaign/chương trình khuyến mãi không public như sản phẩm.';
    case 'unknown':
    default:
      return 'Chưa xác định được đây là sản phẩm thật.';
  }
}

function isUnsafeTitleForAutoPublish(title: string): boolean {
  const normalized = normalizeText(title);

  if (!normalized) return true;

  if (GENERIC_OR_UNSAFE_TITLE_TERMS.some((term) => normalized.includes(term))) {
    return true;
  }

  const merchantOfferMatch = title.match(/^\s*\[[^\]]+\]\s*-\s*(.+)$/);
  const offerBody = normalizeText(merchantOfferMatch?.[1] || '');
  const startsLikeGenericOffer =
      offerBody.startsWith('giam ') ||
      offerBody.startsWith('uu dai ') ||
      offerBody.startsWith('khuyen mai ') ||
      offerBody.startsWith('flash sale ') ||
      offerBody.startsWith('sale ');

  return Boolean(merchantOfferMatch && startsLikeGenericOffer);
}

function hasSpecificProductTitle(title: string): boolean {
  const normalized = normalizeText(title);

  if (!normalized || normalized.length < 8) return false;
  if (isUnsafeTitleForAutoPublish(title)) return false;

  const meaningfulWords = normalized
      .split(/\s+/)
      .filter((word) => word.length >= 2);

  if (meaningfulWords.length < 2) return false;

  const hasDigitOrVariant =
      /\d/.test(normalized) ||
      /\b(?:pro|max|plus|ultra|mini|lite|air|series|gen|version|v\d+)\b/i.test(normalized);

  const hasKnownProductWord =
      /\b(?:iphone|ipad|macbook|dien thoai|laptop|tai nghe|ban phim|chuot|sac|pin|serum|kem|sua tam|sua rua mat|dau goi|may loc|noi chien|may hut bui|may xay|dong ho|balo|quan|ao|giay|dep|ta|bim|binh|noi|chao)\b/i.test(
          normalized,
      );

  return hasDigitOrVariant || hasKnownProductWord || meaningfulWords.length >= 4;
}

function getDraftKind(productDraft: MutableProductDraft): ProductKind | string {
  return getText(productDraft.sourceItemKind || productDraft.kind) || 'unknown';
}

function getDraftPrice(productDraft: MutableProductDraft): number | undefined {
  return (
      parsePriceNumber(productDraft.salePrice) ||
      parsePriceNumber(productDraft.currentPrice) ||
      parsePriceNumber(productDraft.price) ||
      parsePriceNumber(productDraft.originalPrice)
  );
}

function getDraftUrl(productDraft: MutableProductDraft): string {
  const candidates = [
    productDraft.affiliateUrl,
    productDraft.originalUrl,
    productDraft.url,
  ];

  for (const candidate of candidates) {
    if (isValidHttpUrl(candidate)) return getText(candidate);
  }

  return '';
}

function getDraftQualityScore(productDraft: MutableProductDraft): number {
  const raw = productDraft.sourceQualityScore ?? productDraft.qualityScore;
  const score = typeof raw === 'number' ? raw : Number(raw || 0);

  return Number.isFinite(score) ? score : 0;
}

function decideSafeAutoPublish(productDraft: MutableProductDraft): SafeAutoPublishDecision {
  if (!AUTO_SAFE_MODE || !AUTO_APPROVE_SAFE_PRODUCTS || !AUTO_PUBLISH_SAFE_PRODUCTS) {
    return {
      allowed: false,
      reason: 'auto_mode_disabled',
    };
  }

  if (!FREE_ONLY_ENFORCED || ALLOW_PAID_AI) {
    return {
      allowed: false,
      reason: 'free_only_guard_failed',
    };
  }

  const title = getText(productDraft.title);
  const description = getText(productDraft.description);
  const rawSourceKind = getText(productDraft.rawSourceKind);
  const kind = getDraftKind(productDraft);
  const source = normalizeText(productDraft.source);
  const platform = getText(productDraft.platform);
  const imageUrl = getText(productDraft.imageUrl);
  const productUrl = getDraftUrl(productDraft);
  const price = getDraftPrice(productDraft);
  const publicDecision = normalizeText(productDraft.publicDecision);
  const sourceQualityScore = getDraftQualityScore(productDraft);

  if (!isProductLikeKind(kind)) {
    return {
      allowed: false,
      reason: `blocked_non_product_kind_${kind || 'unknown'}`,
    };
  }

  if (isBlockedNonProductKind(kind)) {
    return {
      allowed: false,
      reason: `blocked_kind_${kind}`,
    };
  }

  if (!title || !hasSpecificProductTitle(title)) {
    return {
      allowed: false,
      reason: 'missing_or_non_specific_product_title',
    };
  }

  if (isUnsafeTitleForAutoPublish(title)) {
    return {
      allowed: false,
      reason: 'title_looks_like_voucher_campaign_or_store_offer',
    };
  }

  const looksUnsafe = looksLikeVoucherOrCampaign({
    title,
    description,
    rawSourceKind,
    source: source || 'accesstrade',
    raw: productDraft,
  });

  if (looksUnsafe) {
    return {
      allowed: false,
      reason: 'classifier_detected_voucher_or_campaign',
    };
  }

  if (source !== 'accesstrade') {
    return {
      allowed: false,
      reason: 'source_not_verified_for_auto_publish',
    };
  }

  if (!platform) {
    return {
      allowed: false,
      reason: 'missing_platform',
    };
  }

  if (!productUrl) {
    return {
      allowed: false,
      reason: 'missing_or_invalid_product_url',
    };
  }

  if (!isValidHttpUrl(imageUrl)) {
    return {
      allowed: false,
      reason: 'missing_or_invalid_image_url',
    };
  }

  if (!price || price < 1000) {
    return {
      allowed: false,
      reason: 'missing_real_price',
    };
  }

  if (Boolean(productDraft.needsVerification)) {
    return {
      allowed: false,
      reason: 'needs_verification',
    };
  }

  if (!Boolean(productDraft.verifiedSource || productDraft.sourceVerified)) {
    return {
      allowed: false,
      reason: 'source_not_verified',
    };
  }

  if (!Boolean(productDraft.autoPublishEligible)) {
    return {
      allowed: false,
      reason: 'source_item_not_auto_publish_eligible',
    };
  }

  if (publicDecision && publicDecision !== 'public_candidate') {
    return {
      allowed: false,
      reason: `public_decision_${publicDecision}`,
    };
  }

  if (sourceQualityScore < 70) {
    return {
      allowed: false,
      reason: 'source_quality_score_too_low',
    };
  }

  return {
    allowed: true,
    reason: 'safe_candidate_waiting_health_check',
  };
}

function getBlockedStatus(kind: ProductKind | string | undefined): Product['status'] {
  return (isProductLikeKind(kind) ? 'needs_review' : 'archived') as Product['status'];
}

function getNormalizedItemKind(item: NormalizedAccessTradeItem): ProductKind {
  return item.sourceItemKind || item.kind || 'unknown';
}

function buildAccessTradeProductDraft(
    item: NormalizedAccessTradeItem,
): MutableProductDraft | null {
  const title = getText(item.name);

  if (!title) return null;

  const mapped = mapAccessTradeToProduct(item) as MutableProductDraft;
  const kind = getNormalizedItemKind(item);
  const isRealProduct = isProductLikeKind(kind);
  const isNonProduct = isBlockedNonProductKind(kind);

  const affiliateUrl = isValidHttpUrl(item.affiliateUrl)
      ? item.affiliateUrl
      : undefined;

  const originalUrl = isValidHttpUrl(item.originalUrl)
      ? item.originalUrl
      : undefined;

  const finalUrl = affiliateUrl || originalUrl;
  const imageUrl = isValidHttpUrl(item.imageUrl)
      ? item.imageUrl
      : undefined;

  const price = parsePriceNumber(item.price);
  const salePrice = parsePriceNumber(item.salePrice);

  const blockReason =
      getText(item.publicBlockReason) ||
      getText(item.nonProductReason) ||
      (!finalUrl
          ? 'Thiếu link sản phẩm hoặc affiliate link hợp lệ.'
          : !imageUrl
              ? 'Thiếu ảnh sản phẩm hợp lệ.'
              : !price && !salePrice
                  ? 'Thiếu giá sản phẩm thật.'
                  : !item.verifiedSource
                      ? 'Nguồn chưa đủ tín hiệu xác minh sản phẩm thật.'
                      : '');

  const nonProductReason = isNonProduct
      ? getText(item.nonProductReason) || getNonProductReason(kind)
      : undefined;

  const publicDecision = isNonProduct
      ? kind === 'unknown'
          ? 'needs_review'
          : 'archived'
      : item.publicDecision;

  const draft: MutableProductDraft = {
    ...mapped,

    title,
    name: title,
    description: item.description || undefined,

    kind,
    sourceItemKind: kind,
    rawSourceKind: item.rawSourceKind,

    source: 'accesstrade',
    dataSource: 'accesstrade',
    importedFrom: 'accesstrade',
    sourceType: 'affiliate',
    platform: item.platform || 'accesstrade',

    sourceId: item.id,
    externalId: item.id,

    affiliateUrl,
    originalUrl,
    url: finalUrl,

    imageUrl,

    price,
    salePrice,

    verifiedSource: isRealProduct && item.verifiedSource,
    sourceVerified: isRealProduct && item.verifiedSource,
    needsVerification:
        !isRealProduct ||
        !item.verifiedSource ||
        !item.autoPublishEligible ||
        item.needsVerification,

    status: getBlockedStatus(kind),
    publicHidden: true,
    aiApproved: false,
    autoPublished: false,
    approvalMode: 'manual_or_auto_safe_required',

    autoPublishEligible: isRealProduct && item.autoPublishEligible,
    publicDecision,
    publicBlockReason: blockReason || undefined,
    nonProductReason,
    autoPublishBlockedReason: blockReason || undefined,

    qualityScore: item.qualityScore,
    sourceQualityScore: item.qualityScore,

    benefits: [],
    tags: [],
    warnings: [
      nonProductReason ||
      'Không fake giá, ảnh, review, tồn kho hoặc trải nghiệm mua hàng.',
    ],
    checkBeforeBuy: [
      'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
      'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
      'SanDeal có thể nhận hoa hồng affiliate nếu bạn mua qua liên kết, giá người mua không đổi.',
    ],

    riskLevel: item.needsVerification ? 'unknown' : 'low',
    complianceStatus: 'needs_edit',
    contentPackageStatus: 'none',

    affiliateSource: 'accesstrade',
    rawSourceType: 'accesstrade',
    rawData: item.rawData,
  };

  if (isNonProduct) {
    draft.status = getBlockedStatus(kind);
    draft.publicHidden = true;
    draft.aiApproved = false;
    draft.autoPublished = false;
    draft.autoPublishEligible = false;
    draft.needsVerification = true;
    draft.verifiedSource = false;
    draft.sourceVerified = false;
    draft.publicDecision = kind === 'unknown' ? 'needs_review' : 'archived';
    draft.publicBlockReason = nonProductReason;
    draft.autoPublishBlockedReason = nonProductReason;
  }

  return draft;
}

async function runHealthGuardBeforePublish(
    productDraft: MutableProductDraft,
): Promise<HealthGuardDecision> {
  const checkUrl = getDraftUrl(productDraft);

  if (!checkUrl) {
    return {
      allowed: false,
      reason: 'missing_or_invalid_link_before_health_check',
      blockedBy: 'link',
      updates: {
        publicHidden: true,
        unpublishedReason: 'Thiếu link sản phẩm hoặc affiliate link hợp lệ.',
      },
    };
  }

  const imageUrl = getText(productDraft.imageUrl);

  if (!isValidHttpUrl(imageUrl)) {
    return {
      allowed: false,
      reason: 'missing_or_invalid_image_before_health_check',
      blockedBy: 'image',
      updates: {
        publicHidden: true,
        unpublishedReason: 'Thiếu ảnh sản phẩm hợp lệ.',
      },
    };
  }

  try {
    const linkResult = await checkLinkHealth(checkUrl);

    if (!linkResult.ok) {
      return {
        allowed: false,
        reason: `Link lỗi: ${linkResult.reason}`,
        blockedBy: 'link',
        updates: {
          linkHealthStatus: linkResult.status as Product['linkHealthStatus'],
          linkLastCheckedAt: new Date().toISOString(),
          publicHidden: true,
          unpublishedReason: `Link lỗi: ${linkResult.reason}`,
        },
      };
    }

    const imageResult = await checkImageHealth(imageUrl);

    if (!imageResult.ok) {
      return {
        allowed: false,
        reason: `Ảnh lỗi: ${imageResult.reason}`,
        blockedBy: 'image',
        updates: {
          imageHealthStatus: imageResult.status as Product['imageHealthStatus'],
          imageLastCheckedAt: new Date().toISOString(),
          publicHidden: true,
          unpublishedReason: `Ảnh lỗi: ${imageResult.reason}`,
        },
      };
    }

    const now = new Date().toISOString();

    return {
      allowed: true,
      reason: 'health_ok',
      updates: {
        linkHealthStatus: 'ok' as Product['linkHealthStatus'],
        imageHealthStatus: 'ok' as Product['imageHealthStatus'],
        linkLastCheckedAt: now,
        imageLastCheckedAt: now,
      },
    };
  } catch (error) {
    return {
      allowed: false,
      reason: `health_check_error: ${error instanceof Error ? error.message : String(error)}`,
      blockedBy: 'health_error',
      updates: {
        publicHidden: true,
        unpublishedReason: 'Lỗi khi kiểm tra link/ảnh, cần xem xét thủ công.',
      },
    };
  }
}

function markDraftAsAutoPublished(
    productDraft: MutableProductDraft,
    reason: string,
    healthUpdates: MutableProductDraft,
): MutableProductDraft {
  const now = new Date().toISOString();

  return {
    ...productDraft,
    ...healthUpdates,

    status: 'published' as Product['status'],
    publicHidden: false,

    needsVerification: false,
    verifiedSource: true,
    sourceVerified: true,

    aiApproved: true,
    approvalMode: 'ai_auto_safe_publish',
    approvedAt: now,
    publishedAt: now,

    autoPublished: true,
    autoPublishReason: reason,
    autoPublishBlockedReason: undefined,

    publicDecision: 'published',
    publicBlockReason: undefined,

    // Do not claim generated content when Source Scout did not generate it.
    contentPackageStatus: 'none',
    complianceStatus: 'needs_edit',
    riskLevel: 'low',
  };
}

function markDraftAsBlocked(
    productDraft: MutableProductDraft,
    reason: string,
    updates?: MutableProductDraft,
): MutableProductDraft {
  const kind = getDraftKind(productDraft);

  return {
    ...productDraft,
    ...(updates || {}),

    status: getBlockedStatus(kind),
    publicHidden: true,

    aiApproved: false,
    autoPublished: false,

    autoPublishReason: null,
    autoPublishBlockedReason: reason,
    publicBlockReason: reason,

    needsVerification: true,
    approvalMode: 'manual_or_auto_safe_required',
  };
}

function getKindCounterKey(kind: ProductKind | string | undefined): keyof Pick<
    ScanCounters,
    'realProducts' | 'storeOffers' | 'vouchers' | 'campaigns' | 'unknown'
> {
  switch (kind) {
    case 'product':
    case 'deal':
      return 'realProducts';
    case 'store_offer':
      return 'storeOffers';
    case 'voucher':
      return 'vouchers';
    case 'campaign':
      return 'campaigns';
    default:
      return 'unknown';
  }
}

function getItemFallbackKey(item: NormalizedAccessTradeItem): string {
  const price = item.salePrice || item.price || 0;

  return normalizeText(
      [
        item.name,
        item.platform,
        item.category,
        price,
      ].join('|'),
  );
}

function getProductFallbackKey(product: Product): string {
  const price = product.salePrice || product.price || 0;

  return normalizeText(
      [
        product.title,
        product.platform,
        price,
      ].join('|'),
  );
}

function buildExistingProductIndex(products: Product[]): ExistingProductIndex {
  const index: ExistingProductIndex = {
    externalIds: new Map(),
    urls: new Map(),
    fallbackKeys: new Map(),
  };

  for (const product of products) {
    const rec = product as Product & Record<string, unknown>;

    const externalId = getText(rec.sourceId || rec.externalId || rec.productId);
    if (externalId) {
      index.externalIds.set(externalId, product);
    }

    for (const rawUrl of [
      rec.affiliateUrl,
      rec.originalUrl,
      rec.url,
    ]) {
      const url = normalizeComparableUrl(rawUrl);
      if (url) index.urls.set(url, product);
    }

    const fallbackKey = getProductFallbackKey(product);
    if (fallbackKey) {
      index.fallbackKeys.set(fallbackKey, product);
    }
  }

  return index;
}

function findDuplicateItem(
    item: NormalizedAccessTradeItem,
    index: ExistingProductIndex,
): Product | undefined {
  const externalId = getText(item.id);

  if (externalId && index.externalIds.has(externalId)) {
    return index.externalIds.get(externalId);
  }

  const comparableUrls = [
    normalizeComparableUrl(item.affiliateUrl),
    normalizeComparableUrl(item.originalUrl),
  ].filter(Boolean);

  for (const url of comparableUrls) {
    if (index.urls.has(url)) {
      return index.urls.get(url);
    }
  }

  // Use title/platform/price only as a final fallback when no strong identifier exists.
  if (!externalId && comparableUrls.length === 0) {
    const fallbackKey = getItemFallbackKey(item);
    if (fallbackKey && index.fallbackKeys.has(fallbackKey)) {
      return index.fallbackKeys.get(fallbackKey);
    }
  }

  return undefined;
}

function addItemToIndex(
    item: NormalizedAccessTradeItem,
    savedProduct: Product,
    index: ExistingProductIndex,
): void {
  const externalId = getText(item.id);

  if (externalId) {
    index.externalIds.set(externalId, savedProduct);
  }

  for (const rawUrl of [
    item.affiliateUrl,
    item.originalUrl,
  ]) {
    const url = normalizeComparableUrl(rawUrl);
    if (url) index.urls.set(url, savedProduct);
  }

  const fallbackKey = getItemFallbackKey(item);

  if (fallbackKey) {
    index.fallbackKeys.set(fallbackKey, savedProduct);
  }
}

function createEmptyScanCounters(): ScanCounters {
  return {
    found: 0,
    created: 0,
    updated: 0,
    saved: 0,
    candidates: 0,

    realProducts: 0,
    storeOffers: 0,
    vouchers: 0,
    campaigns: 0,
    unknown: 0,

    published: 0,
    needsReview: 0,
    archived: 0,

    blockedByLink: 0,
    blockedByImage: 0,
    healthErrors: 0,

    duplicate: 0,
    skipped: 0,
  };
}

export class SourceScoutBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async scanSource(source: SourceName, limit: number): Promise<{ candidates: Product[]; summary: ScanCounters }> {
    const totalLimit = Math.min(Math.max(limit || 10, 1), 30);
    const candidates: Product[] = [];
    const summary = createEmptyScanCounters();

    if ((source === 'all' || source === 'local') && candidates.length < totalLimit) {
      const localProducts = await this.scanLocalSource(totalLimit - candidates.length);
      candidates.push(...localProducts);
    }

    if ((source === 'all' || source === 'accesstrade') && candidates.length < totalLimit) {
      const atProducts = await this.scanAccessTradeSource(totalLimit - candidates.length, summary);
      candidates.push(...atProducts);
    }

    if (source === 'manual' && candidates.length < totalLimit) {
      const manualProducts = await this.scanManualSource(totalLimit - candidates.length);
      candidates.push(...manualProducts);
    }

    await this.ctx.info('Source scan complete', {
      source,
      requestedLimit: limit,
      candidatesFound: candidates.length,

      safeMode: AUTO_SAFE_MODE,
      freeOnly: FREE_ONLY_ENFORCED,
      allowPaidAi: ALLOW_PAID_AI,
      costMode: COST_MODE,

      autoApproveSafeProducts: AUTO_APPROVE_SAFE_PRODUCTS,
      autoPublishSafeProducts: AUTO_PUBLISH_SAFE_PRODUCTS,

      note:
          'Only verified real products can auto-publish after link/image health checks. Voucher/campaign/store offers remain internal or archived.',
    });

    return { candidates, summary };
  }

  private async scanLocalSource(limit: number): Promise<Product[]> {
    if (limit <= 0) return [];

    try {
      await this.ctx.info('Scanning local source');

      const allProducts = await listProducts();
      const candidates = allProducts
          .filter((product) => product.source === 'manual' && product.status === 'draft')
          .slice(0, limit);

      await this.ctx.info('Local source scan complete', {
        count: candidates.length,
      });

      return candidates;
    } catch (error) {
      await this.ctx.error('Local source scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  private async scanAccessTradeSource(limit: number, summary: ScanCounters): Promise<Product[]> {
    if (limit <= 0) return [];

    const counters = summary;

    try {
      await this.ctx.info('Checking AccessTrade token status', {
        scanMode: 'real_products_only',
        requestedKind: ACCESS_TRADE_SCAN_KIND,

        safeMode: AUTO_SAFE_MODE,
        freeOnly: FREE_ONLY_ENFORCED,
        allowPaidAi: ALLOW_PAID_AI,
        costMode: COST_MODE,
      });

      const configured = await isAccessTradeConfigured();

      if (!configured) {
        await this.ctx.warn('AccessTrade token not configured. Skipping AccessTrade scan');
        return [];
      }

      const totalLimit = Math.min(Math.max(limit || 10, 1), 30);
      const internalSaveLimit = Math.min(Math.max(totalLimit * 3, 15), 90);
      const perKeywordLimit = Math.min(12, Math.max(5, totalLimit));

      const pipelineCandidates: Product[] = [];

      const existingProducts = await getAllProducts();
      const existingIndex = buildExistingProductIndex(existingProducts);

      let keywordsScanned = 0;

      for (const keyword of ACCESS_TRADE_KEYWORDS) {
        if (pipelineCandidates.length >= totalLimit) break;
        if (counters.saved >= internalSaveLimit) break;

        keywordsScanned += 1;

        await this.ctx.info('Scanning AccessTrade real-product keyword', {
          keyword,
          requestedKind: ACCESS_TRADE_SCAN_KIND,
          limit: perKeywordLimit,

          remainingPipelineSlots: Math.max(totalLimit - pipelineCandidates.length, 0),
          remainingInternalSlots: Math.max(internalSaveLimit - counters.saved, 0),

          safeMode: AUTO_SAFE_MODE,
          freeOnly: FREE_ONLY_ENFORCED,
          costMode: COST_MODE,
        });

        let items: NormalizedAccessTradeItem[] = [];

        try {
          const searchResult = await searchAccessTrade({
            keyword,
            limit: perKeywordLimit,
            kind: ACCESS_TRADE_SCAN_KIND,
            imageOnly: false,
            affiliateLinkOnly: false,
          });

          items = Array.isArray(searchResult.items)
              ? searchResult.items
              : [];

          counters.found += items.length;

          await this.ctx.info('AccessTrade real-product keyword returned', {
            keyword,
            count: items.length,
            summary: searchResult.summary,
          });
        } catch (error) {
          counters.skipped += 1;

          await this.ctx.error('AccessTrade keyword search failed', {
            keyword,
            error: error instanceof Error ? error.message : String(error),
          });

          continue;
        }

        for (const item of items) {
          if (pipelineCandidates.length >= totalLimit) break;
          if (counters.saved >= internalSaveLimit) break;

          const kind = getNormalizedItemKind(item);
          const kindCounterKey = getKindCounterKey(kind);
          counters[kindCounterKey] += 1;

          let productDraft = buildAccessTradeProductDraft(item);

          if (!productDraft) {
            counters.skipped += 1;
            await this.ctx.warn('AccessTrade item skipped', {
              keyword,
              sourceId: item.id || null,
              title: item.name || null,
              kind,
              reason: 'missing_title',
            });
            continue;
          }

          const existingProduct = findDuplicateItem(item, existingIndex);
          if (existingProduct) {
            counters.duplicate += 1;
            // Merge draft into existing product (keep new values over old values!)
            productDraft = {
              ...(existingProduct as MutableProductDraft),
              ...productDraft, // Apply new mapped fields OVER existing!
              id: existingProduct.id,
              // Fallback to old values if new ones are invalid or missing
              price: productDraft.price || existingProduct.price,
              salePrice: productDraft.salePrice || existingProduct.salePrice,
              imageUrl: isValidHttpUrl(productDraft.imageUrl) ? productDraft.imageUrl : existingProduct.imageUrl,
              affiliateUrl: isValidHttpUrl(productDraft.affiliateUrl) ? productDraft.affiliateUrl : existingProduct.affiliateUrl,
              originalUrl: isValidHttpUrl(productDraft.originalUrl) ? productDraft.originalUrl : existingProduct.originalUrl,
              updatedAt: new Date().toISOString(),
            };
          }

          const autoDecision = decideSafeAutoPublish(productDraft);

          if (autoDecision.allowed) {
            const healthDecision = await runHealthGuardBeforePublish(productDraft);

            if (healthDecision.allowed) {
              productDraft = markDraftAsAutoPublished(
                  productDraft,
                  'auto_published_verified_real_product_link_image_ok',
                  healthDecision.updates,
              );
            } else {
              productDraft = markDraftAsBlocked(
                  productDraft,
                  healthDecision.reason,
                  healthDecision.updates,
              );

              if (healthDecision.blockedBy === 'link') counters.blockedByLink += 1;
              else if (healthDecision.blockedBy === 'image') counters.blockedByImage += 1;
              else if (healthDecision.blockedBy === 'health_error') counters.healthErrors += 1;
            }
          } else {
            productDraft = markDraftAsBlocked(productDraft, autoDecision.reason);
          }

          try {
            let saved: Product;
            if (existingProduct) {
              saved = await updateProduct(existingProduct.id, productDraft as Partial<Product>) as Product;
              if (!saved) {
                // If update failed/returned null, fallback to skipping
                counters.skipped += 1;
                continue;
              }
              counters.updated += 1;
            } else {
              saved = await createProduct(productDraft as Parameters<typeof createProduct>[0]);
              counters.created += 1;
            }

            counters.saved += 1;

            const savedRecord = saved as Product & Record<string, unknown>;
            const autoPublished = Boolean(savedRecord.autoPublished || productDraft.autoPublished);
            const savedStatus = getText(savedRecord.status || productDraft.status);

            if (autoPublished || savedStatus === 'published') {
              counters.published += 1;
            } else if (isProductLikeKind(kind)) {
              counters.needsReview += 1;
            } else {
              counters.archived += 1;
            }

            if (isProductLikeKind(kind)) {
              counters.candidates += 1;
              pipelineCandidates.push(saved);
            }

            if (!existingProduct) {
              addItemToIndex(item, saved, existingIndex);
            }

            await this.ctx.info(
                existingProduct 
                  ? 'AccessTrade updated existing item' 
                  : (autoPublished ? 'AccessTrade auto-published safe product' : 'AccessTrade saved internal item'),
                {
                  keyword,
                  productId: saved.id,
                  sourceId: item.id || null,
                  title: item.name,
                  kind,
                  status: savedStatus || productDraft.status,
                  rawSourceKind: item.rawSourceKind,
                  publicHidden: Boolean(productDraft.publicHidden),
                  needsVerification: Boolean(productDraft.needsVerification),
                  verifiedSource: Boolean(productDraft.verifiedSource || productDraft.sourceVerified),
                  aiApproved: Boolean(productDraft.aiApproved),
                  autoPublished,
                  autoPublishReason: getText(productDraft.autoPublishReason) || getText(productDraft.autoPublishBlockedReason) || getText(productDraft.publicBlockReason) || null,
                  publicDecision: getText(productDraft.publicDecision) || null,
                  publicBlockReason: getText(productDraft.publicBlockReason) || null,
                  nonProductReason: getText(productDraft.nonProductReason) || null,
                  linkHealthStatus: getText(productDraft.linkHealthStatus) || null,
                  imageHealthStatus: getText(productDraft.imageHealthStatus) || null,
                  qualityScore: getDraftQualityScore(productDraft) ?? null,
                  returnedToPipeline: isProductLikeKind(kind),
                  isDuplicateRefresh: Boolean(existingProduct),
                },
            );
          } catch (error) {
            counters.skipped += 1;
            await this.ctx.error('AccessTrade item save failed', {
              keyword,
              sourceId: item.id || null,
              title: item.name || null,
              kind,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      await this.ctx.info('AccessTrade real-product scan complete', {
        requestedLimit: limit,
        requestedKind: ACCESS_TRADE_SCAN_KIND,
        keywordsScanned,

        found: counters.found,
        saved: counters.saved,
        candidates: counters.candidates,

        realProducts: counters.realProducts,
        storeOffers: counters.storeOffers,
        vouchers: counters.vouchers,
        campaigns: counters.campaigns,
        unknown: counters.unknown,

        published: counters.published,
        needsReview: counters.needsReview,
        archived: counters.archived,

        blockedByLink: counters.blockedByLink,
        blockedByImage: counters.blockedByImage,
        healthErrors: counters.healthErrors,

        duplicate: counters.duplicate,
        skipped: counters.skipped,

        safeMode: AUTO_SAFE_MODE,
        freeOnly: FREE_ONLY_ENFORCED,
        allowPaidAi: ALLOW_PAID_AI,
        costMode: COST_MODE,

        autoApproveSafeProducts: AUTO_APPROVE_SAFE_PRODUCTS,
        autoPublishSafeProducts: AUTO_PUBLISH_SAFE_PRODUCTS,

        note:
            'Source Scout requests product-only AccessTrade results. Voucher/campaign/store-offer inspection remains available in the dashboard.',
      });

      return pipelineCandidates.slice(0, totalLimit);
    } catch (error) {
      await this.ctx.error('AccessTrade source scan failed', {
        error: error instanceof Error ? error.message : String(error),

        safeMode: AUTO_SAFE_MODE,
        freeOnly: FREE_ONLY_ENFORCED,
        allowPaidAi: ALLOW_PAID_AI,
        costMode: COST_MODE,
      });

      return [];
    }
  }

  private async scanManualSource(limit: number): Promise<Product[]> {
    if (limit <= 0) return [];

    try {
      await this.ctx.info('Scanning manual product submissions');

      await this.ctx.info('Manual source scan complete', {
        count: 0,
      });

      return [];
    } catch (error) {
      await this.ctx.error('Manual source scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }
}

export async function createSourceScout(runId: string): Promise<SourceScoutBot> {
  return new SourceScoutBot(new BotContext(runId, 'source_scout'));
}
