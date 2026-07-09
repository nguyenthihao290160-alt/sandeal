// ===========================================
// Source Scout Bot
// Finds candidate products from real sources
// AutoPilot mode: safely auto-publishes verified real products only
// ===========================================
// Rules:
// - Safe Mode ON by default.
// - Free Only ON by policy. This bot does not call paid AI.
// - Store offers / vouchers / campaigns are saved internally only.
// - Real products are saved first, then link/image health is checked.
// - Public publish happens only after strict checks pass.

import type { Product, ProductKind } from '../types';
import { BotContext } from './context';
import { listProducts, createProduct, getAllProducts } from '../storage/products';
import { classifyProductKind, looksLikeVoucherOrCampaign } from '../sourceItemClassifier';
import {
  isAccessTradeConfigured,
  searchAccessTrade,
} from '../integrations/accesstrade';
import { checkLinkHealth, checkImageHealth } from './productHealthCheck';

type SourceName = 'local' | 'accesstrade' | 'manual' | 'all';

type AccessTradeRawItem = Record<string, unknown>;

type AccessTradeSearchResult = {
  items?: AccessTradeRawItem[];
  products?: AccessTradeRawItem[];
  vouchers?: AccessTradeRawItem[];
  campaigns?: AccessTradeRawItem[];
  storeOffers?: AccessTradeRawItem[];
  unknown?: AccessTradeRawItem[];
  summary?: Record<string, unknown>;
  data?: {
    items?: AccessTradeRawItem[];
    products?: AccessTradeRawItem[];
    vouchers?: AccessTradeRawItem[];
    campaigns?: AccessTradeRawItem[];
    storeOffers?: AccessTradeRawItem[];
    unknown?: AccessTradeRawItem[];
    summary?: Record<string, unknown>;
  };
};

type MutableProductDraft = Partial<Product> & Record<string, unknown>;

type SourceCollectionKind =
    | 'product'
    | 'deal'
    | 'voucher'
    | 'campaign'
    | 'store_offer'
    | 'unknown';

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

const AUTO_SAFE_MODE = process.env.AI_AUTO_MODE !== 'false';
const AUTO_APPROVE_SAFE_PRODUCTS = process.env.AUTO_APPROVE_SAFE_PRODUCTS !== 'false';
const AUTO_PUBLISH_SAFE_PRODUCTS = process.env.AUTO_PUBLISH_SAFE_PRODUCTS !== 'false';

// Hard policy for this bot.
// Do not wire paid AI/API behavior here.
const FREE_ONLY_ENFORCED = true;
const ALLOW_PAID_AI = false;
const COST_MODE = 'safe_free';

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

const ACCESS_TRADE_ID_KEYS = [
  'sourceId',
  'source_id',
  'externalId',
  'external_id',
  'id',
  'productId',
  'product_id',
  'sku',
  'skuId',
  'sku_id',
  'itemId',
  'item_id',
  'campaignId',
  'campaign_id',
  'offerId',
  'offer_id',
];

const ACCESS_TRADE_TITLE_KEYS = [
  'name',
  'title',
  'productName',
  'product_name',
  'voucherName',
  'voucher_name',
  'campaignName',
  'campaign_name',
  'offerName',
  'offer_name',
];

const ACCESS_TRADE_DESCRIPTION_KEYS = [
  'description',
  'desc',
  'shortDescription',
  'short_description',
  'summary',
  'content',
  'promotion',
];

const ACCESS_TRADE_IMAGE_KEYS = [
  'imageUrl',
  'image_url',
  'image',
  'productImage',
  'product_image',
  'thumbnail',
  'thumbnailUrl',
  'thumbnail_url',
  'logo',
  'banner',
  'image.url',
  'media.image',
];

const ACCESS_TRADE_AFFILIATE_URL_KEYS = [
  'affiliateUrl',
  'affiliate_url',
  'aff_link',
  'affiliateLink',
  'affiliate_link',
  'trackingLink',
  'tracking_link',
  'deeplink',
  'deepLink',
  'deep_link',
];

const ACCESS_TRADE_ORIGINAL_URL_KEYS = [
  'originalUrl',
  'original_url',
  'productUrl',
  'product_url',
  'url',
  'link',
  'landingPage',
  'landing_page',
  'merchantUrl',
  'merchant_url',
];

const ACCESS_TRADE_CURRENT_PRICE_KEYS = [
  'salePrice',
  'sale_price',
  'currentPrice',
  'current_price',
  'discountedPrice',
  'discounted_price',
  'discountPrice',
  'discount_price',
  'discount',
  'priceValue',
  'price_value',
  'price',
];

const ACCESS_TRADE_ORIGINAL_PRICE_KEYS = [
  'originalPrice',
  'original_price',
  'listPrice',
  'list_price',
  'oldPrice',
  'old_price',
  'marketPrice',
  'market_price',
  'priceBeforeDiscount',
  'price_before_discount',
  'price',
];

const ACCESS_TRADE_PLATFORM_KEYS = [
  'platform',
  'network',
  'domain',
  'merchant',
  'merchantName',
  'merchant_name',
  'shop',
  'shopName',
  'shop_name',
  'advertiser',
  'advertiserName',
  'advertiser_name',
  'campaignName',
  'campaign_name',
  'campaign',
];

const ACCESS_TRADE_CATEGORY_KEYS = [
  'cate',
  'category',
  'categoryName',
  'category_name',
  'cat_name',
  'vertical',
  'industry',
];

function getText(value: unknown): string {
  if (typeof value === 'string') return value.trim();

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }

  return '';
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'string') return value.trim();

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = stringifyValue(item);
      if (text) return text;
    }

    return '';
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;

    for (const key of ['url', 'link', 'src', 'name', 'title', 'value']) {
      const text = stringifyValue(record[key]);
      if (text) return text;
    }
  }

  return '';
}

function normalizeText(value: unknown): string {
  return stringifyValue(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
}

function getPathValue(item: AccessTradeRawItem, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = item;

  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') {
      return undefined;
    }

    cursor = (cursor as Record<string, unknown>)[part];
  }

  return cursor;
}

function getRawText(item: AccessTradeRawItem, keys: string[]): string {
  for (const key of keys) {
    const value = stringifyValue(getPathValue(item, key));
    if (value) return value;
  }

  return '';
}

function parsePriceNumber(value: unknown): number | undefined {
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

  const looksLikeVnd =
      /₫|đ|vnd/i.test(trimmed) ||
      /\d+[.,]\d{3}/.test(trimmed) ||
      digitsOnly.length >= 4;

  if (looksLikeVnd) {
    const parsedVnd = Number(digitsOnly);
    return Number.isFinite(parsedVnd) && parsedVnd >= 1000 ? parsedVnd : undefined;
  }

  const normalized = trimmed.replace(',', '.').replace(/[^\d.]/g, '');
  const parsed = Number(normalized);

  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : undefined;
}

function getRawNumber(item: AccessTradeRawItem, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = parsePriceNumber(getPathValue(item, key));
    if (value) return value;
  }

  return undefined;
}

function normalizeTitle(value: unknown): string {
  return normalizeText(value);
}

function normalizeUrl(value: unknown): string {
  return normalizeText(value);
}

function hasRealPositivePrice(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1000;
}

function cloneRawItemWithCollection(
    item: AccessTradeRawItem,
    collectionKind: SourceCollectionKind,
): AccessTradeRawItem {
  return {
    ...item,
    __accessTradeCollection: collectionKind,
  };
}

function extractAccessTradeItems(result: unknown): AccessTradeRawItem[] {
  const payload =
      result && typeof result === 'object'
          ? (result as AccessTradeSearchResult)
          : {};

  const groups: Array<{
    collectionKind: SourceCollectionKind;
    items?: AccessTradeRawItem[];
  }> = [
    { collectionKind: 'unknown', items: payload.items },
    { collectionKind: 'product', items: payload.products },
    { collectionKind: 'voucher', items: payload.vouchers },
    { collectionKind: 'campaign', items: payload.campaigns },
    { collectionKind: 'store_offer', items: payload.storeOffers },
    { collectionKind: 'unknown', items: payload.unknown },
    { collectionKind: 'unknown', items: payload.data?.items },
    { collectionKind: 'product', items: payload.data?.products },
    { collectionKind: 'voucher', items: payload.data?.vouchers },
    { collectionKind: 'campaign', items: payload.data?.campaigns },
    { collectionKind: 'store_offer', items: payload.data?.storeOffers },
    { collectionKind: 'unknown', items: payload.data?.unknown },
  ];

  return groups.flatMap(({ collectionKind, items }) => {
    if (!Array.isArray(items)) return [];

    return items
        .filter((item): item is AccessTradeRawItem => Boolean(item && typeof item === 'object'))
        .map((item) => cloneRawItemWithCollection(item, collectionKind));
  });
}

function toKnownProductKind(value: unknown): ProductKind | null {
  const normalized = normalizeText(value);

  switch (normalized) {
    case 'product':
    case 'deal':
    case 'voucher':
    case 'campaign':
    case 'store_offer':
    case 'unknown':
      return normalized as ProductKind;
    default:
      return null;
  }
}

function getRawKind(item: AccessTradeRawItem): string {
  const collectionKind = normalizeText(item.__accessTradeCollection);

  if (
      collectionKind === 'product' ||
      collectionKind === 'deal' ||
      collectionKind === 'voucher' ||
      collectionKind === 'campaign' ||
      collectionKind === 'store_offer'
  ) {
    return collectionKind;
  }

  return (
      getRawText(item, [
        'sourceItemKind',
        'kind',
        'type',
        'rawSourceKind',
        'categoryType',
        'category_type',
        'sourceType',
        'source_type',
        'itemType',
        'item_type',
        'objectType',
        'object_type',
        '__sandealSourceKind',
        '__sandealEndpoint',
      ]) || 'unknown'
  ).toLowerCase();
}

function normalizePlatformText(value: string): string {
  const lower = value.toLowerCase();

  if (lower.includes('shopee')) return 'shopee';
  if (lower.includes('lazada')) return 'lazada';
  if (lower.includes('tiktok')) return 'tiktok_shop';
  if (lower.includes('tiki')) return 'tiki';
  if (lower.includes('sendo')) return 'sendo';
  if (lower.includes('fahasa')) return 'fahasa';
  if (lower.includes('access')) return 'accesstrade';

  return 'accesstrade';
}

function calculateDiscountPercent(
    currentPrice?: number,
    originalPrice?: number,
): number | undefined {
  if (!currentPrice || !originalPrice) return undefined;
  if (originalPrice <= currentPrice) return undefined;

  const discount = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
  return Number.isFinite(discount) && discount > 0 ? discount : undefined;
}

function isProductLikeKind(kind: ProductKind | string | undefined): boolean {
  return kind === 'product' || kind === 'deal';
}

function isBlockedNonProductKind(kind: ProductKind | string | undefined): boolean {
  return kind === 'voucher' || kind === 'campaign' || kind === 'store_offer' || kind === 'unknown';
}

function getKindCounterKey(kind: ProductKind | string | undefined): string {
  switch (kind) {
    case 'product':
    case 'deal':
      return 'realProducts';
    case 'voucher':
      return 'vouchers';
    case 'campaign':
      return 'campaigns';
    case 'store_offer':
      return 'storeOffers';
    default:
      return 'unknown';
  }
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
      return 'Chưa xác định được đây là sản phẩm thật.';
    default:
      return '';
  }
}

function isUnsafeTitleForAutoPublish(title: string): boolean {
  const normalized = normalizeText(title);

  if (!normalized) return true;

  const blockedTerms = [
    'demo',
    'test',
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
    'giam gia',
    'cho don',
    'don toi thieu',
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

  return blockedTerms.some((term) => normalized.includes(term));
}

function hasSpecificProductTitle(title: string): boolean {
  const text = normalizeText(title);

  if (!text) return false;

  const hasModelOrVariant =
      /\b[a-z0-9]{2,}[-_/]?[a-z0-9]{2,}\b/i.test(title) ||
      /\d+\s?(ml|g|gram|kg|l|lit|cm|mm|inch|w|mah|gb|tb|pack|pcs|vien|chai|hop|tuyp|bo|cai)\b/i.test(text) ||
      /\b(iphone|ipad|macbook|samsung|xiaomi|oppo|vivo|asus|acer|lenovo|dell|hp|sony|lg|dabo|serum|kem|sua tam|sua rua mat|tai nghe|laptop|dien thoai|may loc|noi chien|binh giu nhiet)\b/i.test(text);

  return hasModelOrVariant && !isUnsafeTitleForAutoPublish(title);
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
  const kind = getText(productDraft.sourceItemKind || productDraft.kind);

  const affiliateUrl = getText(productDraft.affiliateUrl);
  const imageUrl = getText(productDraft.imageUrl);
  const url = getText(productDraft.url || productDraft.originalUrl);
  const source = getText(productDraft.source);
  const platform = getText(productDraft.platform);

  const price =
      parsePriceNumber(productDraft.salePrice) ||
      parsePriceNumber(productDraft.price) ||
      parsePriceNumber(productDraft.currentPrice) ||
      parsePriceNumber(productDraft.originalPrice);

  const publicDecision = getText(productDraft.publicDecision);
  const sourceQualityScore = Number(productDraft.sourceQualityScore || productDraft.qualityScore || 0);

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

  if (!title || title.length < 8) {
    return {
      allowed: false,
      reason: 'missing_or_too_short_title',
    };
  }

  if (!hasSpecificProductTitle(title)) {
    return {
      allowed: false,
      reason: 'title_not_specific_enough',
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

  if (!source || source !== 'accesstrade') {
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

  if (!affiliateUrl) {
    return {
      allowed: false,
      reason: 'missing_affiliate_url',
    };
  }

  if (!url) {
    return {
      allowed: false,
      reason: 'missing_product_url',
    };
  }

  if (!imageUrl) {
    return {
      allowed: false,
      reason: 'missing_image',
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

  if (publicDecision && publicDecision !== 'public_candidate') {
    return {
      allowed: false,
      reason: `public_decision_${publicDecision}`,
    };
  }

  if (sourceQualityScore > 0 && sourceQualityScore < 70) {
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

function getBlockedStatus(kind: ProductKind | string | undefined): string {
  if (isProductLikeKind(kind)) return 'needs_review';
  return 'archived';
}

function getPublicDecisionForDraft(
    kind: ProductKind | string | undefined,
    verifiedSource: boolean,
    autoPublishEligible: boolean,
): string {
  if (kind === 'store_offer' || kind === 'voucher' || kind === 'campaign') return 'archived';
  if (kind === 'unknown') return 'needs_review';
  if (autoPublishEligible && verifiedSource) return 'public_candidate';
  return 'needs_review';
}

function buildAccessTradeProductDraft(rawItem: AccessTradeRawItem): MutableProductDraft | null {
  const title = getRawText(rawItem, ACCESS_TRADE_TITLE_KEYS);
  if (!title) return null;

  const sourceId = getRawText(rawItem, ACCESS_TRADE_ID_KEYS);
  const affiliateUrl = getRawText(rawItem, ACCESS_TRADE_AFFILIATE_URL_KEYS);
  const originalUrl = getRawText(rawItem, ACCESS_TRADE_ORIGINAL_URL_KEYS);
  const finalUrl = affiliateUrl || originalUrl;

  if (!finalUrl) return null;

  const imageUrl = getRawText(rawItem, ACCESS_TRADE_IMAGE_KEYS);
  const description = getRawText(rawItem, ACCESS_TRADE_DESCRIPTION_KEYS);
  const rawKind = getRawKind(rawItem);
  const knownKind = toKnownProductKind(rawKind);

  const rawPlatform = getRawText(rawItem, ACCESS_TRADE_PLATFORM_KEYS);
  const platformText = normalizePlatformText(rawPlatform || 'AccessTrade');

  const category = getRawText(rawItem, ACCESS_TRADE_CATEGORY_KEYS);

  const currentPrice = getRawNumber(rawItem, ACCESS_TRADE_CURRENT_PRICE_KEYS);
  const originalPriceRaw = getRawNumber(rawItem, ACCESS_TRADE_ORIGINAL_PRICE_KEYS);

  const originalPrice =
      originalPriceRaw && currentPrice && originalPriceRaw > currentPrice
          ? originalPriceRaw
          : undefined;

  const displayPrice = originalPrice || originalPriceRaw || currentPrice;
  const discountPercent = calculateDiscountPercent(currentPrice, originalPrice);

  const hasPrice =
      hasRealPositivePrice(currentPrice) ||
      hasRealPositivePrice(originalPriceRaw) ||
      hasRealPositivePrice(displayPrice);

  const hasAffiliateUrl = Boolean(affiliateUrl);
  const hasImage = Boolean(imageUrl);

  const classifiedKind =
      knownKind ||
      classifyProductKind({
        title,
        name: title,
        description,
        source: 'accesstrade',
        imageUrl,
        affiliateUrl: affiliateUrl || undefined,
        originalUrl: originalUrl || undefined,
        url: finalUrl,
        price: displayPrice,
        salePrice: currentPrice,
        originalPrice,
        rawSourceKind: rawKind,
        sourceType: 'affiliate',
        raw: rawItem,
      });

  const isProductLike = isProductLikeKind(classifiedKind);
  const nonProductReason = getNonProductReason(classifiedKind);

  const normalizedVerifiedSource = Boolean(rawItem.verifiedSource || rawItem.sourceVerified);
  const normalizedNeedsVerification =
      typeof rawItem.needsVerification === 'boolean' ? Boolean(rawItem.needsVerification) : undefined;

  const normalizedAutoPublishEligible = Boolean(rawItem.autoPublishEligible);
  const normalizedPublicDecision = getText(rawItem.publicDecision);
  const normalizedBlockReason = getText(rawItem.publicBlockReason);
  const normalizedQualityScore = Number(rawItem.qualityScore || rawItem.sourceQualityScore || 0);

  const titleUnsafe = isUnsafeTitleForAutoPublish(title);
  const looksUnsafe = looksLikeVoucherOrCampaign({
    title,
    description,
    rawSourceKind: rawKind,
    source: 'accesstrade',
    raw: rawItem,
  });

  const hasMinimumProductSignals =
      isProductLike &&
      hasAffiliateUrl &&
      hasImage &&
      hasPrice &&
      hasSpecificProductTitle(title) &&
      !titleUnsafe &&
      !looksUnsafe;

  const verifiedSource =
      normalizedVerifiedSource ||
      (hasMinimumProductSignals &&
          normalizedPublicDecision !== 'archived' &&
          !isBlockedNonProductKind(classifiedKind));

  const needsVerification =
      normalizedNeedsVerification ??
      (!verifiedSource || !isProductLike || !hasAffiliateUrl || !hasImage || !hasPrice);

  const publicDecision =
      normalizedPublicDecision ||
      getPublicDecisionForDraft(classifiedKind, verifiedSource, normalizedAutoPublishEligible);

  const publicBlockReason =
      normalizedBlockReason ||
      nonProductReason ||
      (!hasAffiliateUrl
          ? 'Thiếu affiliate link.'
          : !hasImage
              ? 'Thiếu ảnh sản phẩm.'
              : !hasPrice
                  ? 'Thiếu giá sản phẩm.'
                  : !verifiedSource
                      ? 'Nguồn chưa đủ tín hiệu xác minh sản phẩm thật.'
                      : '');

  const baseDraft = {
    title,
    name: title,
    description: description || undefined,

    source: 'accesstrade',
    platform: platformText,

    dataSource: 'accesstrade',
    sourceType: 'affiliate',
    importedFrom: 'accesstrade',
    rawSourceKind: rawKind,
    kind: classifiedKind,
    sourceItemKind: classifiedKind,

    verifiedSource,
    sourceVerified: verifiedSource,
    publicHidden: true,
    needsVerification,
    aiApproved: false,
    autoPublished: false,
    approvalMode: 'manual_or_auto_safe_required',

    status: getBlockedStatus(classifiedKind),

    sourceId: sourceId || undefined,
    externalId: sourceId || undefined,

    affiliateUrl: affiliateUrl || undefined,
    originalUrl: originalUrl || finalUrl,
    url: finalUrl,

    imageUrl: imageUrl || undefined,

    category: category || undefined,

    price: displayPrice,
    salePrice: currentPrice,
    currentPrice,
    originalPrice,
    discountPercent,

    benefits: [],
    tags: [],
    warnings: [
      nonProductReason || 'Không fake giá, ảnh, review, tồn kho hoặc trải nghiệm mua hàng.',
    ].filter(Boolean),
    checkBeforeBuy: [
      'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
      'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
      'SanDeal có thể nhận hoa hồng affiliate nếu bạn mua qua liên kết, giá người mua không đổi.',
    ],

    riskLevel: needsVerification ? 'unknown' : 'low',
    complianceStatus: 'needs_edit',
    contentPackageStatus: 'none',

    affiliateSource: 'accesstrade',

    autoPublishEligible: normalizedAutoPublishEligible || publicDecision === 'public_candidate',
    publicDecision,
    publicBlockReason,
    nonProductReason: nonProductReason || undefined,
    qualityScore: normalizedQualityScore || undefined,
    sourceQualityScore: normalizedQualityScore || undefined,

    autoPublishBlockedReason: publicBlockReason || undefined,

    rawSourceType: 'accesstrade',
    rawData: rawItem.rawData && typeof rawItem.rawData === 'object' ? rawItem.rawData : rawItem,
  } as MutableProductDraft;

  if (!isProductLike || isBlockedNonProductKind(classifiedKind)) {
    baseDraft.status = 'archived';
    baseDraft.publicHidden = true;
    baseDraft.aiApproved = false;
    baseDraft.autoPublished = false;
    baseDraft.needsVerification = true;
    baseDraft.verifiedSource = false;
    baseDraft.sourceVerified = false;
    baseDraft.publicDecision = classifiedKind === 'unknown' ? 'needs_review' : 'archived';
    baseDraft.publicBlockReason = nonProductReason || 'Không phải sản phẩm cụ thể.';
    baseDraft.autoPublishBlockedReason = baseDraft.publicBlockReason;
  }

  return baseDraft;
}

async function runHealthGuardBeforePublish(
    productDraft: MutableProductDraft,
): Promise<HealthGuardDecision> {
  const checkUrl =
      getText(productDraft.affiliateUrl) ||
      getText(productDraft.originalUrl) ||
      getText(productDraft.url);

  if (!checkUrl) {
    return {
      allowed: false,
      reason: 'missing_link_before_health_check',
      blockedBy: 'link',
      updates: {
        linkHealthStatus: 'missing',
        publicHidden: true,
        unpublishedReason: 'Thiếu link sản phẩm hoặc affiliate link.',
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

    const imageUrl = getText(productDraft.imageUrl);

    if (!imageUrl) {
      return {
        allowed: false,
        reason: 'missing_image_before_health_check',
        blockedBy: 'image',
        updates: {
          imageHealthStatus: 'missing',
          publicHidden: true,
          unpublishedReason: 'Thiếu ảnh sản phẩm.',
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
          publicHidden: true,
          unpublishedReason: `Ảnh lỗi: ${imageResult.reason}`,
        },
      };
    }

    return {
      allowed: true,
      reason: 'health_ok',
      updates: {
        linkHealthStatus: 'ok' as Product['linkHealthStatus'],
        imageHealthStatus: 'ok' as Product['imageHealthStatus'],
        linkLastCheckedAt: new Date().toISOString(),
        imageLastCheckedAt: new Date().toISOString(),
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

function markDraftAsAutoPublished(productDraft: MutableProductDraft, reason: string): MutableProductDraft {
  const now = new Date().toISOString();

  return {
    ...productDraft,
    status: 'published',
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
    complianceStatus: 'needs_edit',
    contentPackageStatus: 'generated',
    riskLevel: 'low',
  };
}

function markDraftAsBlocked(
    productDraft: MutableProductDraft,
    reason: string,
    updates?: MutableProductDraft,
): MutableProductDraft {
  const kind = getText(productDraft.kind || productDraft.sourceItemKind);

  return {
    ...productDraft,
    ...(updates || {}),
    status: getBlockedStatus(kind),
    publicHidden: true,
    aiApproved: false,
    autoPublished: false,
    autoPublishBlockedReason: reason,
    publicBlockReason: reason,
    needsVerification: true,
    approvalMode: 'manual_or_auto_safe_required',
  };
}

export class SourceScoutBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async scanSource(source: SourceName, limit: number): Promise<Product[]> {
    const totalLimit = Math.min(Math.max(limit || 10, 1), 30);
    const candidates: Product[] = [];

    if ((source === 'all' || source === 'local') && candidates.length < totalLimit) {
      const localProducts = await this.scanLocalSource(totalLimit - candidates.length);
      candidates.push(...localProducts);
    }

    if ((source === 'all' || source === 'accesstrade') && candidates.length < totalLimit) {
      const atProducts = await this.scanAccessTradeSource(totalLimit - candidates.length);
      candidates.push(...atProducts);
    }

    if ((source === 'all' || source === 'manual') && candidates.length < totalLimit) {
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
          'Verified real products can be auto-published only after link/image health checks. Voucher/campaign/store offers stay internal or archived.',
    });

    return candidates;
  }

  private async scanLocalSource(limit: number): Promise<Product[]> {
    if (limit <= 0) return [];

    try {
      await this.ctx.info('Scanning local source');

      const allProducts = await listProducts();
      const candidates = allProducts
          .filter((product) => product.source === 'manual' && product.status === 'draft')
          .slice(0, limit);

      await this.ctx.info('Local source scan complete', { count: candidates.length });
      return candidates;
    } catch (error) {
      await this.ctx.error('Local source scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async scanAccessTradeSource(limit: number): Promise<Product[]> {
    if (limit <= 0) return [];

    try {
      await this.ctx.info('Checking AccessTrade token status', {
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
      const internalSaveLimit = Math.min(totalLimit * 3, 90);
      const perKeywordLimit = Math.min(10, Math.max(5, totalLimit));

      const pipelineCandidates: Product[] = [];

      let foundCount = 0;
      let savedInternalCount = 0;
      let duplicateCount = 0;
      let skippedCount = 0;
      let keywordsScanned = 0;

      let autoPublishedCount = 0;
      let candidatesCount = 0;
      let needsReviewCount = 0;
      let archivedCount = 0;
      let blockedByLinkCount = 0;
      let blockedByImageCount = 0;

      const kindCounters: Record<string, number> = {
        realProducts: 0,
        vouchers: 0,
        campaigns: 0,
        storeOffers: 0,
        unknown: 0,
      };

      const existingProducts = await getAllProducts();

      const seenExternalIds = new Set<string>();
      const seenUrls = new Set<string>();
      const seenTitles = new Set<string>();

      for (const product of existingProducts) {
        const productRecord = product as Product & Record<string, unknown>;

        const sourceId = getText(productRecord.sourceId);
        const externalId = getText(productRecord.externalId);
        const affiliateUrl = normalizeUrl(productRecord.affiliateUrl);
        const originalUrl = normalizeUrl(productRecord.originalUrl);
        const url = normalizeUrl(productRecord.url);
        const title = normalizeTitle(productRecord.title);

        if (sourceId) seenExternalIds.add(sourceId);
        if (externalId) seenExternalIds.add(externalId);
        if (affiliateUrl) seenUrls.add(affiliateUrl);
        if (originalUrl) seenUrls.add(originalUrl);
        if (url) seenUrls.add(url);
        if (title) seenTitles.add(title);
      }

      for (const keyword of ACCESS_TRADE_KEYWORDS) {
        if (pipelineCandidates.length >= totalLimit && savedInternalCount >= totalLimit) break;
        if (savedInternalCount >= internalSaveLimit) break;

        keywordsScanned += 1;

        await this.ctx.info('Scanning AccessTrade keyword', {
          keyword,
          limit: perKeywordLimit,
          remainingPipelineSlots: Math.max(totalLimit - pipelineCandidates.length, 0),
          remainingInternalSlots: Math.max(internalSaveLimit - savedInternalCount, 0),
          safeMode: AUTO_SAFE_MODE,
          freeOnly: FREE_ONLY_ENFORCED,
          costMode: COST_MODE,
        });

        let searchResult: unknown;

        try {
          searchResult = await searchAccessTrade({
            keyword,
            limit: perKeywordLimit,
            kind: 'all',
            imageOnly: false,
            affiliateLinkOnly: false,
          });
        } catch (error) {
          skippedCount += 1;
          await this.ctx.error('AccessTrade keyword search failed', {
            keyword,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const rawItems = extractAccessTradeItems(searchResult);
        foundCount += rawItems.length;

        await this.ctx.info('AccessTrade keyword returned', {
          keyword,
          count: rawItems.length,
          summary:
              searchResult && typeof searchResult === 'object'
                  ? (searchResult as AccessTradeSearchResult).summary || null
                  : null,
        });

        for (const rawItem of rawItems) {
          if (savedInternalCount >= internalSaveLimit) break;

          const productDraftInitial = buildAccessTradeProductDraft(rawItem);

          if (!productDraftInitial) {
            skippedCount += 1;
            await this.ctx.warn('AccessTrade item skipped', {
              keyword,
              reason: 'missing_title_or_link',
            });
            continue;
          }

          let productDraft = productDraftInitial;

          const draftKind = getText(productDraft.sourceItemKind || productDraft.kind) as ProductKind;
          const kindCounterKey = getKindCounterKey(draftKind);
          kindCounters[kindCounterKey] = (kindCounters[kindCounterKey] || 0) + 1;

          const rawSourceId = getText(productDraft.sourceId);
          const mappedTitle = getText(productDraft.title);
          const finalAffiliateUrl = getText(productDraft.affiliateUrl);
          const finalOriginalUrl = getText(productDraft.originalUrl);
          const finalUrl = getText(productDraft.url);
          const normalizedTitle = normalizeTitle(mappedTitle);

          const isDuplicate =
              Boolean(rawSourceId && seenExternalIds.has(rawSourceId)) ||
              Boolean(finalAffiliateUrl && seenUrls.has(normalizeUrl(finalAffiliateUrl))) ||
              Boolean(finalOriginalUrl && seenUrls.has(normalizeUrl(finalOriginalUrl))) ||
              Boolean(finalUrl && seenUrls.has(normalizeUrl(finalUrl))) ||
              Boolean(normalizedTitle && seenTitles.has(normalizedTitle));

          if (isDuplicate) {
            duplicateCount += 1;
            await this.ctx.info('AccessTrade duplicate skipped', {
              keyword,
              sourceId: rawSourceId || null,
              title: mappedTitle || null,
              kind: draftKind || 'unknown',
            });
            continue;
          }

          const autoDecision = decideSafeAutoPublish(productDraft);

          if (autoDecision.allowed) {
            const healthDecision = await runHealthGuardBeforePublish(productDraft);

            productDraft = {
              ...productDraft,
              ...healthDecision.updates,
            };

            if (healthDecision.allowed) {
              productDraft = markDraftAsAutoPublished(
                  productDraft,
                  'auto_published_verified_real_product_link_image_ok',
              );
            } else {
              productDraft = markDraftAsBlocked(productDraft, healthDecision.reason, healthDecision.updates);

              if (healthDecision.blockedBy === 'link') {
                blockedByLinkCount += 1;
              } else if (healthDecision.blockedBy === 'image') {
                blockedByImageCount += 1;
              }

              await this.ctx.warn('Auto-publish blocked by Product Health Guard', {
                keyword,
                title: mappedTitle,
                kind: draftKind,
                reason: healthDecision.reason,
                blockedBy: healthDecision.blockedBy || null,
              });
            }
          } else {
            productDraft = markDraftAsBlocked(productDraft, autoDecision.reason);
          }

          try {
            if (productDraft.price === 0) productDraft.price = undefined;
            if (productDraft.salePrice === 0) productDraft.salePrice = undefined;
            if (productDraft.currentPrice === 0) productDraft.currentPrice = undefined;
            if (productDraft.originalPrice === 0) productDraft.originalPrice = undefined;

            const saved = await createProduct(
                productDraft as Parameters<typeof createProduct>[0],
            );

            savedInternalCount += 1;

            const savedRecord = saved as Product & Record<string, unknown>;
            const autoPublished = Boolean(savedRecord.autoPublished || productDraft.autoPublished);
            const savedStatus = getText(savedRecord.status || productDraft.status);

            if (autoPublished || savedStatus === 'published') {
              autoPublishedCount += 1;
            } else if (isProductLikeKind(draftKind)) {
              needsReviewCount += 1;
            } else {
              archivedCount += 1;
            }

            if (isProductLikeKind(draftKind)) {
              candidatesCount += 1;
              pipelineCandidates.push(saved);
            }

            if (rawSourceId) seenExternalIds.add(rawSourceId);
            if (finalAffiliateUrl) seenUrls.add(normalizeUrl(finalAffiliateUrl));
            if (finalOriginalUrl) seenUrls.add(normalizeUrl(finalOriginalUrl));
            if (finalUrl) seenUrls.add(normalizeUrl(finalUrl));
            if (normalizedTitle) seenTitles.add(normalizedTitle);

            await this.ctx.info(
                autoPublished ? 'AccessTrade auto-published safe product' : 'AccessTrade saved internal item',
                {
                  keyword,
                  productId: saved.id,
                  sourceId: rawSourceId || null,
                  title: mappedTitle,
                  kind: draftKind || 'unknown',
                  status: savedStatus || productDraft.status,
                  rawSourceKind: productDraft.rawSourceKind,
                  publicHidden: Boolean(productDraft.publicHidden),
                  needsVerification: Boolean(productDraft.needsVerification),
                  verifiedSource: Boolean(productDraft.verifiedSource || productDraft.sourceVerified),
                  aiApproved: Boolean(productDraft.aiApproved),
                  autoPublished,
                  autoPublishReason:
                      getText(productDraft.autoPublishReason) ||
                      getText(productDraft.autoPublishBlockedReason) ||
                      getText(productDraft.publicBlockReason) ||
                      null,
                  publicDecision: getText(productDraft.publicDecision) || null,
                  publicBlockReason: getText(productDraft.publicBlockReason) || null,
                  nonProductReason: getText(productDraft.nonProductReason) || null,
                  linkHealthStatus: getText(productDraft.linkHealthStatus) || null,
                  imageHealthStatus: getText(productDraft.imageHealthStatus) || null,
                  returnedToPipeline: isProductLikeKind(draftKind),
                },
            );
          } catch (error) {
            skippedCount += 1;
            await this.ctx.error('AccessTrade item save failed', {
              keyword,
              sourceId: rawSourceId || null,
              title: mappedTitle || null,
              kind: draftKind || 'unknown',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      await this.ctx.info('AccessTrade keyword scan complete', {
        requestedLimit: limit,
        keywordsScanned,

        found: foundCount,
        saved: savedInternalCount,
        candidates: candidatesCount,

        realProducts: kindCounters.realProducts,
        storeOffers: kindCounters.storeOffers,
        vouchers: kindCounters.vouchers,
        campaigns: kindCounters.campaigns,
        unknown: kindCounters.unknown,

        autoPublished: autoPublishedCount,
        needsReview: needsReviewCount,
        archived: archivedCount,

        blockedByLink: blockedByLinkCount,
        blockedByImage: blockedByImageCount,
        duplicatesSkipped: duplicateCount,
        skipped: skippedCount,

        safeMode: AUTO_SAFE_MODE,
        freeOnly: FREE_ONLY_ENFORCED,
        allowPaidAi: ALLOW_PAID_AI,
        costMode: COST_MODE,
        autoApproveSafeProducts: AUTO_APPROVE_SAFE_PRODUCTS,
        autoPublishSafeProducts: AUTO_PUBLISH_SAFE_PRODUCTS,
      });

      return pipelineCandidates.slice(0, totalLimit);
    } catch (error) {
      await this.ctx.error('AccessTrade source scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async scanManualSource(limit: number): Promise<Product[]> {
    if (limit <= 0) return [];

    try {
      await this.ctx.info('Scanning manual product submissions');

      await this.ctx.info('Manual source scan complete', { count: 0 });
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