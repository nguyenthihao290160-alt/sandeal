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
import { listProducts, createProduct, updateProduct, getAllProducts, getProductById } from '../storage/products';
import { looksLikeVoucherOrCampaign } from '../sourceItemClassifier';
import {
  isAccessTradeConfigured,
  mapAccessTradeToProduct,
  searchAccessTrade,
  type NormalizedAccessTradeItem,
} from '../integrations/accesstrade';
import { checkLinkHealth, checkImageHealth, checkSourcePreflight } from './productHealthCheck';

type SourceName = 'local' | 'accesstrade' | 'manual' | 'all';

type MutableProductDraft = Partial<Product> & Record<string, unknown>;

type SafeAutoPublishDecision = {
  allowed: boolean;
  reason: string;
};

export type ScanCounters = {
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

  // Source quality resilience
  validCandidates: number;
  cooldownSkipped: number;
  staleImage: number;
  staleProductUrl: number;
  staleAffiliate: number;
  affiliateUnverified: number;
  malformedSource: number;
  timeout: number;
  needsImageFallback: number;
};

type ExistingProductIndex = {
  externalIds: Map<string, Product>;
  urls: Map<string, Product>;
  fallbackKeys: Map<string, Product>;
};

const AUTO_SAFE_MODE = process.env.AI_AUTO_MODE !== 'false';
const AUTO_APPROVE_SAFE_PRODUCTS = process.env.AUTO_APPROVE_SAFE_PRODUCTS !== 'false';
// Source Scout can identify candidates, but only a durable SAFE_PUBLISH job may make them public.
const AUTO_PUBLISH_SAFE_PRODUCTS = false;

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

    validCandidates: 0,
    cooldownSkipped: 0,
    staleImage: 0,
    staleProductUrl: 0,
    staleAffiliate: 0,
    affiliateUnverified: 0,
    malformedSource: 0,
    timeout: 0,
    needsImageFallback: 0,
  };
}

/**
 * Check if a product is currently in cooldown (stale/dead source).
 * Returns true if cooldown is active and should skip this item.
 */
function isInSourceCooldown(product: Product): boolean {
  if (!product.sourceHealthCooldownUntil) return false;

  const cooldownUntil = new Date(product.sourceHealthCooldownUntil).getTime();
  const now = Date.now();

  return cooldownUntil > now;
}

/**
 * Calculate cooldown duration in milliseconds based on failure reason.
 */
function calculateCooldownDuration(reason: string | undefined): number {
  if (!reason) return 0;

  switch (reason) {
    // Definitively dead — 24h cooldown
    case 'image_404_stale':
    case 'product_url_404_stale':
    case 'stale_image':
    case 'stale_product_url':
    case 'stale_affiliate':
    case 'broken':
    case 'image_broken':
    case 'invalid_image':
      return 24 * 60 * 60 * 1000; // 24 hours

    // Recoverable errors — 6h cooldown
    case 'timeout':
    case 'temporary_error':
    case 'server_error':
    case 'dns_error':
    case 'error':
      return 6 * 60 * 60 * 1000; // 6 hours

    // Access restricted / anti-bot — 4h cooldown (NOT dead, can retry)
    case 'affiliate_unverified':
    case 'forbidden':
    case 'not_allowed':
    case 'affiliate_error':
      return 4 * 60 * 60 * 1000; // 4 hours

    // Rate limited — 1h cooldown
    case 'rate_limited':
      return 1 * 60 * 60 * 1000; // 1 hour

    default:
      return 0;
  }
}

/**
 * Set cooldown on a product due to stale/dead source.
 */
function markSourceCooldown(
  product: MutableProductDraft,
  reason: string,
  cooldownHours?: number,
): MutableProductDraft {
  const durationMs = cooldownHours
    ? cooldownHours * 60 * 60 * 1000
    : calculateCooldownDuration(reason);

  const cooldownUntil = new Date(Date.now() + durationMs).toISOString();

  return {
    ...product,
    sourceHealthCooldownUntil: cooldownUntil,
    sourceHealthReason: reason,
    sourceHealthSkipUntil: cooldownUntil,
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
          // Check internal save limit (we may continue processing even after this)
          if (counters.saved >= internalSaveLimit && counters.validCandidates > 0) {
            break;
          }

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

          // 1. Merge dữ liệu AccessTrade
          const existingProduct = findDuplicateItem(item, existingIndex);
          if (existingProduct) {
            counters.duplicate += 1;

            // Check if existing item is in cooldown
            if (isInSourceCooldown(existingProduct)) {
              counters.cooldownSkipped += 1;
              await this.ctx.info('AccessTrade duplicate in cooldown - skipping health checks', {
                keyword,
                sourceId: item.id || null,
                title: item.name || null,
                reason: existingProduct.sourceHealthReason,
                cooldownUntil: existingProduct.sourceHealthCooldownUntil,
              });
              continue;
            }

            const newData: Partial<Product> = {};
            if (productDraft.price && productDraft.price !== existingProduct.price) newData.price = productDraft.price;
            if (productDraft.salePrice && productDraft.salePrice !== existingProduct.salePrice) newData.salePrice = productDraft.salePrice;
            if (productDraft.imageUrl && isValidHttpUrl(productDraft.imageUrl) && productDraft.imageUrl !== existingProduct.imageUrl) newData.imageUrl = productDraft.imageUrl;
            if (productDraft.affiliateUrl && isValidHttpUrl(productDraft.affiliateUrl) && productDraft.affiliateUrl !== existingProduct.affiliateUrl) newData.affiliateUrl = productDraft.affiliateUrl;
            if (productDraft.originalUrl && isValidHttpUrl(productDraft.originalUrl) && productDraft.originalUrl !== existingProduct.originalUrl) newData.originalUrl = productDraft.originalUrl;
            
            // Mark a flag to track if we need to call updateProduct
            productDraft._hasChanges = Object.keys(newData).length > 0;

            // Preserve good existing data (like status, verified, approved)
            productDraft = {
              ...(existingProduct as MutableProductDraft),
              ...newData,
              // Update timestamps if there are changes
              updatedAt: Object.keys(newData).length > 0 ? new Date().toISOString() : existingProduct.updatedAt,
            };
          }

          // SOURCE PREFLIGHT: Quick validation before storage
          const imageUrl = getText(productDraft.imageUrl);
          const productUrl = getText(productDraft.originalUrl || productDraft.url);
          const affiliateUrl = getText(productDraft.affiliateUrl);
          const title = getText(productDraft.title);

          const preflightResult = await checkSourcePreflight(title, imageUrl, productUrl, affiliateUrl);

          if (!preflightResult.valid) {
            // Mark as stale with cooldown instead of completely skipping
            await this.ctx.warn('AccessTrade item failed preflight - marking cooldown', {
              keyword,
              sourceId: item.id || null,
              title,
              reason: preflightResult.status,
              cooldownHours: preflightResult.cooldownDurationHours,
            });

            // Update counters based on preflight failure
            switch (preflightResult.status) {
              case 'stale_image':
                counters.staleImage += 1;
                break;
              case 'stale_product_url':
                counters.staleProductUrl += 1;
                break;
              case 'stale_affiliate':
                counters.staleAffiliate += 1;
                break;
              case 'affiliate_unverified':
                counters.affiliateUnverified += 1;
                break;
              case 'malformed_url':
                counters.malformedSource += 1;
                break;
              case 'missing_field':
                counters.malformedSource += 1;
                break;
              default:
                counters.malformedSource += 1;
            }

            try {
              // Persist cooldown marker instead of completely skipping
              let saved: Product;
              productDraft = markSourceCooldown(
                productDraft,
                preflightResult.status,
                preflightResult.cooldownDurationHours,
              );

              if (existingProduct) {
                saved = await updateProduct(existingProduct.id, productDraft as Partial<Product>) as Product;
                if (!saved) continue;
                counters.updated += 1;
              } else {
                saved = await createProduct(productDraft as Parameters<typeof createProduct>[0]);
                counters.created += 1;
              }
              counters.saved += 1;
            } catch (error) {
              await this.ctx.error('Failed to mark source cooldown', {
                sourceId: item.id || null,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            // Continue to next item instead of stopping
            continue;
          }

          // Preflight passed - this is a valid candidate
          counters.validCandidates += 1;
          if (pipelineCandidates.length >= totalLimit) break;

          try {
            // 2. Persist product draft
            let saved: Product;
            if (existingProduct) {
             const hasChanges = productDraft._hasChanges === true;
             delete productDraft._hasChanges;
             if (hasChanges) {
               saved = await updateProduct(existingProduct.id, productDraft as Partial<Product>) as Product;
               if (!saved) {
                 counters.skipped += 1;
                 continue;
               }
               counters.updated += 1;
             } else {
               // No actual changes to persistent fields, skip db update
               saved = existingProduct;
             }
            } else {
             delete productDraft._hasChanges;
             saved = await createProduct(productDraft as Parameters<typeof createProduct>[0]);
             counters.created += 1;
            }
            counters.saved += 1;

            // 3. Reload canonical product (or use saved if no changes)
            const canonical = saved;

            const isRealProduct = isProductLikeKind(kind);
            const originalUrl = isValidHttpUrl(canonical.originalUrl || '') ? canonical.originalUrl : undefined;
            const affiliateUrl = isValidHttpUrl(canonical.affiliateUrl || '') ? canonical.affiliateUrl : undefined;
            const imageUrl = isValidHttpUrl(canonical.imageUrl || '') ? canonical.imageUrl : undefined;
            // Image candidates from AT item for fallback
            const imageCandidatesList: string[] = Array.isArray(item.imageCandidates)
              ? item.imageCandidates.filter((u: string) => isValidHttpUrl(u))
              : [];
            // Canonical product URL decoded from affiliate deeplink (if available)
            const canonicalProductUrl: string | undefined =
              item.canonicalProductUrl && isValidHttpUrl(item.canonicalProductUrl)
                ? item.canonicalProductUrl
                : undefined;

            const healthUpdates: MutableProductDraft = {
              linkLastCheckedAt: new Date().toISOString(),
            } as MutableProductDraft;
            let isHealthOk = false;
            let blockReason: string | undefined = undefined;
            let blockedBy = '';

            const autoDecision = decideSafeAutoPublish(canonical as unknown as MutableProductDraft);

            if (autoDecision.allowed && isRealProduct) {
              if (!affiliateUrl && !originalUrl) {
                blockReason = 'Thiếu cả Product URL và Affiliate URL';
                blockedBy = 'link';
              } else if (!imageUrl && imageCandidatesList.length === 0) {
                blockReason = 'Thiếu Ảnh (imageUrl)';
                blockedBy = 'image';
              } else {
                // 4. Check affiliate URL first (this is what users click — always prefer this)
                // For AccessTrade deeplinks, affiliate URL returning HTML 200 is NORMAL
                const primaryLinkUrl = affiliateUrl || originalUrl!;
                const linkResult = await checkLinkHealth(primaryLinkUrl);
                healthUpdates.linkHealthStatus = linkResult.status as Product['linkHealthStatus'];
                healthUpdates.affiliateHealthStatus = linkResult.status as Product['linkHealthStatus'];

                // 5. Also check product URL (originalUrl) for reference only — timeout here does NOT block
                let productUrlOk = true;
                if (originalUrl && originalUrl !== affiliateUrl) {
                  const prodResult = await checkLinkHealth(originalUrl);
                  // Only block on definitive errors (404 = 'broken', 403 = 'not_allowed') — timeout/error is recoverable
                  if (prodResult.status === 'broken' || prodResult.status === 'not_allowed') {
                    productUrlOk = false;
                    healthUpdates.linkHealthStatus = prodResult.status as Product['linkHealthStatus'];
                  } else if (prodResult.ok) {
                    // If product URL is also ok, note it
                    healthUpdates.linkHealthStatus = 'ok' as Product['linkHealthStatus'];
                  }
                  // timeout, error, unknown => don't override affiliate's ok status
                }

                // 6. Image health with candidate fallback
                let resolvedImageUrl = imageUrl;
                let imageOk = false;

                if (resolvedImageUrl) {
                  const imageResult = await checkImageHealth(resolvedImageUrl);
                  if (imageResult.ok) {
                    imageOk = true;
                    healthUpdates.imageHealthStatus = 'ok' as Product['imageHealthStatus'];
                  } else {
                    healthUpdates.imageHealthStatus = imageResult.status as Product['imageHealthStatus'];
                    // Try fallback image candidates
                    for (const candidateUrl of imageCandidatesList) {
                      if (candidateUrl === resolvedImageUrl) continue; // already tried
                      const candidateResult = await checkImageHealth(candidateUrl);
                      if (candidateResult.ok) {
                        imageOk = true;
                        resolvedImageUrl = candidateUrl;
                        healthUpdates.imageUrl = candidateUrl;
                        healthUpdates.imageHealthStatus = 'ok' as Product['imageHealthStatus'];
                        counters.needsImageFallback += 1;
                        await this.ctx.info('Image fallback succeeded', {
                          keyword,
                          productId: canonical.id,
                          primaryImageFailed: imageUrl,
                          fallbackImage: candidateUrl,
                        });
                        break;
                      }
                    }
                    if (!imageOk) {
                      // All images failed — but if only timeout, don't mark as hard broken
                      const isTimeoutOnly = (imageResult.status as string) === 'timeout';
                      if (!isTimeoutOnly) {
                        blockReason = `Ảnh lỗi: ${imageResult.reason} (đã thử ${imageCandidatesList.length + 1} ảnh)`;
                        blockedBy = 'image';
                        Object.assign(healthUpdates, markSourceCooldown(healthUpdates, imageResult.status));
                      }
                      // For timeout-only image failures: don't block, allow publish with warning
                    }
                  }
                } else if (imageCandidatesList.length > 0) {
                  // No primary image but have candidates — try them
                  for (const candidateUrl of imageCandidatesList) {
                    const candidateResult = await checkImageHealth(candidateUrl);
                    if (candidateResult.ok) {
                      imageOk = true;
                      resolvedImageUrl = candidateUrl;
                      healthUpdates.imageUrl = candidateUrl;
                      healthUpdates.imageHealthStatus = 'ok' as Product['imageHealthStatus'];
                      counters.needsImageFallback += 1;
                      break;
                    }
                  }
                  if (!imageOk) {
                    blockReason = 'Không có ảnh hợp lệ (đã thử tất cả candidates)';
                    blockedBy = 'image';
                  }
                }

                // Evaluate overall health result
                if (!linkResult.ok) {
                  // Classify link failure by severity
                  const linkStatus = linkResult.status as string;
                  const isDefinitelyDead = linkStatus === 'broken'; // 404/410 only
                  const isRecoverable =
                    linkStatus === 'timeout' ||
                    linkStatus === 'dns_error' ||
                    linkStatus === 'server_error' ||
                    linkStatus === 'rate_limited' ||
                    linkStatus === 'not_allowed' ||  // 403 anti-bot — not necessarily dead
                    linkStatus === 'forbidden' ||    // legacy alias
                    linkStatus === 'error';

                  if (isRecoverable && productUrlOk) {
                    // Recoverable: affiliate had transient error but product URL is accessible
                    // Allow publish — set cooldown to re-check later, but don't block now
                    healthUpdates.affiliateLinkErrors = `Affiliate link tạm thời lỗi (${linkStatus}, recoverable): ${linkResult.reason}`;
                    Object.assign(healthUpdates, markSourceCooldown({}, linkResult.status));
                    // isHealthOk will be evaluated below based on blockReason
                  } else if (isDefinitelyDead) {
                    // 404/410: definitively dead — block and set long cooldown
                    blockReason = `Affiliate/Link chết (404/410): ${linkResult.reason}`;
                    blockedBy = 'link';
                    Object.assign(healthUpdates, markSourceCooldown(healthUpdates, linkResult.status));
                    healthUpdates.affiliateLinkErrors = `Affiliate link chết: ${linkResult.reason}`;
                  } else {
                    // Recoverable but no product URL fallback — block with short cooldown
                    blockReason = `Affiliate/Link lỗi (${linkStatus}): ${linkResult.reason}`;
                    blockedBy = 'link';
                    Object.assign(healthUpdates, markSourceCooldown(healthUpdates, linkResult.status));
                    healthUpdates.affiliateLinkErrors = `Affiliate link lỗi: ${linkResult.reason}`;
                  }
                } else {
                  healthUpdates.affiliateLinkErrors = undefined;
                }


                if (!blockReason && (imageOk || (!imageUrl && imageCandidatesList.length === 0))) {
                  isHealthOk = true;
                }
              }
            } else {
              blockReason = autoDecision.reason || 'Không đủ điều kiện kiểm tra (thiếu URL/Ảnh)';
              blockedBy = 'auto_decision';
            }

            // 7. Define finalUpdates (combining healthUpdates + status fields)
            let finalUpdates: MutableProductDraft = { ...healthUpdates };

            if (isHealthOk) {
               // Candidate is ready for the separate durable Safe Publish gate.
               finalUpdates = {
                 ...finalUpdates,
                 status: 'needs_review',
                 publicHidden: true,
                 needsVerification: true,
                 verifiedSource: true,
                 aiApproved: false,
                 autoPublished: false,
                 autoPublishReason: undefined,
                 autoPublishBlockedReason: 'safe_publish_approval_required',
                 publicBlockReason: 'safe_publish_approval_required',
                 unpublishedReason: 'Đang chờ tác vụ Safe Publish được phê duyệt.',
               };
            } else {
               // Blocked
               finalUpdates = {
                 ...finalUpdates,
                 status: getBlockedStatus(kind),
                 publicHidden: true,
                 needsVerification: true,
                 aiApproved: false,
                 autoPublished: false,
                 autoPublishReason: undefined,
                 autoPublishBlockedReason: blockReason,
                 publicBlockReason: blockReason,
                 unpublishedReason: blockReason,
               };
               
               if (blockedBy === 'link' || blockedBy === 'affiliate_link') counters.blockedByLink += 1;
               else if (blockedBy === 'image') counters.blockedByImage += 1;
               else counters.healthErrors += 1;
            }

            // 8. Persist trạng thái cuối cùng
            await updateProduct(canonical.id, finalUpdates as Partial<Product>);

            // 12. Reload lại record đã persist
            const finalRecord = await getProductById(canonical.id) as Product & Record<string, unknown>;
            if (!finalRecord) continue;

            // 13. Update run log and summary
            const autoPublished = Boolean(finalRecord.autoPublished);
            const savedStatus = getText(finalRecord.status);

            if (autoPublished || savedStatus === 'published') {
              counters.published += 1;
            } else if (isProductLikeKind(kind)) {
              counters.needsReview += 1;
            } else {
              counters.archived += 1;
            }

            if (isProductLikeKind(kind)) {
              counters.candidates += 1;
              pipelineCandidates.push(finalRecord as Product);
            }

            if (!existingProduct) {
              addItemToIndex(item, finalRecord as Product, existingIndex);
            }

            await this.ctx.info(
                existingProduct 
                  ? 'AccessTrade updated existing item' 
                  : (autoPublished ? 'AccessTrade auto-published safe product' : 'AccessTrade saved internal item'),
                {
                  keyword,
                  productId: finalRecord.id,
                  sourceId: item.id || null,
                  title: item.name,
                  kind,
                  status: savedStatus,
                  publicHidden: Boolean(finalRecord.publicHidden),
                  needsVerification: Boolean(finalRecord.needsVerification),
                  verifiedSource: Boolean(finalRecord.verifiedSource),
                  aiApproved: Boolean(finalRecord.aiApproved),
                  autoPublished,
                  autoPublishReason: getText(finalRecord.autoPublishReason) || getText(finalRecord.autoPublishBlockedReason) || getText(finalRecord.publicBlockReason) || null,
                  linkHealthStatus: getText(finalRecord.linkHealthStatus) || null,
                  affiliateHealthStatus: getText(finalRecord.affiliateHealthStatus) || null,
                  imageHealthStatus: getText(finalRecord.imageHealthStatus) || null,
                  qualityScore: finalRecord.qualityScore ?? null,
                  imageCandidatesCount: imageCandidatesList.length,
                  canonicalProductUrlDecoded: canonicalProductUrl || null,
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
        needsImageFallback: counters.needsImageFallback,

        duplicate: counters.duplicate,
        cooldownSkipped: counters.cooldownSkipped,
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
