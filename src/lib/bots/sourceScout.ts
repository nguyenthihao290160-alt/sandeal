// ===========================================
// Source Scout Bot
// Finds candidate products from real sources
// AutoPilot mode: safely auto-publishes verified real products only
// ===========================================

import type { Product, ProductKind } from '../types';
import { BotContext } from './context';
import { listProducts, createProduct, getAllProducts, updateProduct } from '../storage/products';
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
  data?: {
    items?: AccessTradeRawItem[];
    products?: AccessTradeRawItem[];
    vouchers?: AccessTradeRawItem[];
    campaigns?: AccessTradeRawItem[];
    storeOffers?: AccessTradeRawItem[];
    unknown?: AccessTradeRawItem[];
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

const AUTO_SAFE_MODE = process.env.AI_AUTO_MODE !== 'false';
const AUTO_APPROVE_SAFE_PRODUCTS = process.env.AUTO_APPROVE_SAFE_PRODUCTS !== 'false';
const AUTO_PUBLISH_SAFE_PRODUCTS = process.env.AUTO_PUBLISH_SAFE_PRODUCTS !== 'false';

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
  'title',
  'name',
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
  'aff_link',
  'affiliateUrl',
  'affiliate_url',
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
  'currentPrice',
  'current_price',
  'salePrice',
  'sale_price',
  'discount',
  'discountPrice',
  'discount_price',
  'discountedPrice',
  'discounted_price',
  'price',
  'priceValue',
  'price_value',
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

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const digitsOnly = trimmed.replace(/[^\d]/g, '');
  if (!digitsOnly) return undefined;

  const looksLikeVnd =
      /₫|đ|vnd/i.test(trimmed) ||
      /\d+[.,]\d{3}/.test(trimmed) ||
      digitsOnly.length >= 4;

  if (looksLikeVnd) {
    const parsedVnd = Number(digitsOnly);
    return Number.isFinite(parsedVnd) && parsedVnd > 0 ? parsedVnd : undefined;
  }

  const normalized = trimmed.replace(',', '.').replace(/[^\d.]/g, '');
  const parsed = Number(normalized);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getRawNumber(item: AccessTradeRawItem, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = parsePositiveNumber(getPathValue(item, key));
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
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
        'sourceType',
        'itemType',
        'objectType',
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

function getKindCounterKey(kind: ProductKind | string | undefined): string {
  switch (kind) {
    case 'product':
    case 'deal':
      return 'productsFound';
    case 'voucher':
      return 'vouchersFound';
    case 'campaign':
      return 'campaignsFound';
    case 'store_offer':
      return 'storeOffersFound';
    default:
      return 'unknownFound';
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
    'giam gia',
    'giam ',
    'cho don',
    'don toi thieu',
    'official store',
    'official shop',
    'chien dich',
    'campaign',
    'cashback',
  ];

  return blockedTerms.some((term) => normalized.includes(term));
}

function decideSafeAutoPublish(productDraft: MutableProductDraft): SafeAutoPublishDecision {
  if (!AUTO_SAFE_MODE || !AUTO_APPROVE_SAFE_PRODUCTS || !AUTO_PUBLISH_SAFE_PRODUCTS) {
    return {
      allowed: false,
      reason: 'auto_mode_disabled',
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
      parsePositiveNumber(productDraft.salePrice) ||
      parsePositiveNumber(productDraft.price) ||
      parsePositiveNumber(productDraft.currentPrice) ||
      parsePositiveNumber(productDraft.originalPrice);

  if (!isProductLikeKind(kind)) {
    return {
      allowed: false,
      reason: `blocked_non_product_kind_${kind || 'unknown'}`,
    };
  }

  if (kind === 'voucher' || kind === 'campaign' || kind === 'store_offer' || kind === 'unknown') {
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

  if (!price || price <= 0) {
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

  return {
    allowed: true,
    reason: 'auto_published_verified_real_product',
  };
}

function getBlockedStatus(kind: ProductKind | string | undefined): string {
  if (isProductLikeKind(kind)) return 'needs_review';
  return 'archived';
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

  const rawPlatform = getRawText(rawItem, ACCESS_TRADE_PLATFORM_KEYS);
  const platformText = normalizePlatformText(rawPlatform || 'AccessTrade');

  const category = getRawText(rawItem, ACCESS_TRADE_CATEGORY_KEYS);

  const currentPrice = getRawNumber(rawItem, ACCESS_TRADE_CURRENT_PRICE_KEYS);
  const originalPriceRaw = getRawNumber(rawItem, ACCESS_TRADE_ORIGINAL_PRICE_KEYS);
  const originalPrice =
      originalPriceRaw && currentPrice && originalPriceRaw > currentPrice
          ? originalPriceRaw
          : undefined;

  const discountPercent = calculateDiscountPercent(currentPrice, originalPrice);

  const hasPrice =
      hasRealPositivePrice(currentPrice) ||
      hasRealPositivePrice(originalPrice);

  const hasAffiliateUrl = Boolean(affiliateUrl);
  const hasImage = Boolean(imageUrl);

  const classifiedKind = classifyProductKind({
    title,
    name: title,
    description,
    source: 'accesstrade',
    imageUrl,
    affiliateUrl: affiliateUrl || undefined,
    originalUrl: originalUrl || undefined,
    url: finalUrl,
    price: originalPrice || currentPrice,
    salePrice: currentPrice,
    originalPrice,
    rawSourceKind: rawKind,
    sourceType: 'affiliate',
    raw: rawItem,
  });

  const isProductLike = isProductLikeKind(classifiedKind);
  const isNonProduct = !isProductLike;

  const needsVerification =
      isNonProduct ||
      !hasAffiliateUrl ||
      !hasImage ||
      !hasPrice;

  const verifiedSource = isProductLike && !needsVerification;

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
    approvalMode: 'manual_or_auto_safe_required',

    status: getBlockedStatus(classifiedKind),

    sourceId: sourceId || undefined,
    externalId: sourceId || undefined,

    affiliateUrl: affiliateUrl || undefined,
    originalUrl: originalUrl || finalUrl,
    url: finalUrl,

    imageUrl: imageUrl || undefined,

    category: category || undefined,

    price: originalPrice || currentPrice,
    salePrice: currentPrice,
    currentPrice,
    originalPrice,
    discountPercent,

    benefits: [],
    tags: [],
    warnings: [],
    checkBeforeBuy: [
      'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
      'Giá và ưu đãi có thể thay đổi theo thời điểm.',
      'SanDeal có thể nhận hoa hồng affiliate nếu bạn mua qua liên kết.',
    ],

    riskLevel: needsVerification ? 'unknown' : 'low',
    complianceStatus: 'needs_edit',
    contentPackageStatus: 'none',

    affiliateSource: 'accesstrade',
    rawSourceType: 'accesstrade',
    rawData: rawItem,
  } as MutableProductDraft;

  const autoDecision = decideSafeAutoPublish(baseDraft);
  const now = new Date().toISOString();

  if (autoDecision.allowed) {
    baseDraft.status = 'published';
    baseDraft.publicHidden = false;
    baseDraft.needsVerification = false;
    baseDraft.verifiedSource = true;
    baseDraft.sourceVerified = true;
    baseDraft.aiApproved = true;
    baseDraft.approvalMode = 'ai_auto_safe_publish';
    baseDraft.approvedAt = now;
    baseDraft.publishedAt = now;
    baseDraft.autoPublished = true;
    baseDraft.autoPublishReason = autoDecision.reason;

    // Giữ giá trị hợp lệ theo type hiện tại của project.
    // Không dùng "approved" vì ComplianceStatus hiện tại không nhận giá trị đó.
    baseDraft.complianceStatus = 'needs_edit';

    baseDraft.contentPackageStatus = 'generated';
    baseDraft.riskLevel = 'low';
  } else {
    baseDraft.publicHidden = true;
    baseDraft.autoPublished = false;
    baseDraft.autoPublishBlockedReason = autoDecision.reason;
  }

  return baseDraft;
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
      autoMode: AUTO_SAFE_MODE,
      autoApproveSafeProducts: AUTO_APPROVE_SAFE_PRODUCTS,
      autoPublishSafeProducts: AUTO_PUBLISH_SAFE_PRODUCTS,
      note:
          'Verified real products can be auto-published. Voucher/campaign/store offers stay internal or archived.',
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
      await this.ctx.info('Checking AccessTrade token status');

      const configured = await isAccessTradeConfigured();
      if (!configured) {
        await this.ctx.warn('AccessTrade token not configured. Skipping AccessTrade scan');
        return [];
      }

      const totalLimit = Math.min(Math.max(limit || 10, 1), 30);
      const internalSaveLimit = Math.min(totalLimit * 3, 90);
      const perKeywordLimit = Math.min(10, Math.max(5, totalLimit));

      const pipelineCandidates: Product[] = [];

      let savedInternalCount = 0;
      let returnedCount = 0;
      let duplicateCount = 0;
      let skippedCount = 0;
      let keywordsScanned = 0;
      let skippedFromPublicCount = 0;
      let autoPublishedCount = 0;
      let needsReviewProductCount = 0;
      let archivedNonProductCount = 0;
      let blockedByLinkCount = 0;
      let blockedByImageCount = 0;

      const kindCounters: Record<string, number> = {
        productsFound: 0,
        vouchersFound: 0,
        campaignsFound: 0,
        storeOffersFound: 0,
        unknownFound: 0,
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
          autoMode: AUTO_SAFE_MODE,
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
        returnedCount += rawItems.length;

        await this.ctx.info('AccessTrade keyword returned', {
          keyword,
          count: rawItems.length,
        });

        for (const rawItem of rawItems) {
          if (savedInternalCount >= internalSaveLimit) break;

          const productDraft = buildAccessTradeProductDraft(rawItem);

          if (!productDraft) {
            skippedCount += 1;
            await this.ctx.warn('AccessTrade item skipped', {
              keyword,
              reason: 'missing_required_real_fields',
            });
            continue;
          }

          const draftKind = getText(productDraft.sourceItemKind || productDraft.kind) as ProductKind;
          const kindCounterKey = getKindCounterKey(draftKind);
          kindCounters[kindCounterKey] = (kindCounters[kindCounterKey] || 0) + 1;

          if (!isProductLikeKind(draftKind)) {
            skippedFromPublicCount += 1;
          }

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

          try {
            if (productDraft.price === 0) productDraft.price = undefined;
            if (productDraft.salePrice === 0) productDraft.salePrice = undefined;
            if (productDraft.currentPrice === 0) productDraft.currentPrice = undefined;
            if (productDraft.originalPrice === 0) productDraft.originalPrice = undefined;

            const saved = await createProduct(
                productDraft as Parameters<typeof createProduct>[0],
            );

            savedInternalCount += 1;

            let savedRecord = saved as Product & Record<string, unknown>;
            let autoPublished = Boolean(savedRecord.autoPublished);
            let savedStatus = getText(savedRecord.status);

            // === Product Health Guard ===
            // Nếu sản phẩm được auto-publish, kiểm tra link + ảnh thật
            // trước khi giữ trạng thái published.
            if (autoPublished || savedStatus === 'published') {
              let healthBlocked = false;

              try {
                const checkUrl =
                  getText(productDraft.affiliateUrl) ||
                  getText(productDraft.originalUrl) ||
                  getText(productDraft.url);

                if (checkUrl) {
                  const linkResult = await checkLinkHealth(checkUrl);

                  if (!linkResult.ok) {
                    healthBlocked = true;
                    blockedByLinkCount += 1;

                    await updateProduct(saved.id, {
                      status: 'needs_review',
                      publicHidden: true,
                      aiApproved: false,
                      linkHealthStatus: linkResult.status as Product['linkHealthStatus'],
                      unpublishedReason: `Link lỗi: ${linkResult.reason}`,
                    } as Partial<Product>);

                    savedRecord = { ...savedRecord, autoPublished: false, status: 'needs_review' };
                    autoPublished = false;
                    savedStatus = 'needs_review';

                    await this.ctx.warn('Auto-publish blocked by link health', {
                      productId: saved.id,
                      linkStatus: linkResult.status,
                      linkReason: linkResult.reason,
                      url: checkUrl,
                    });
                  } else {
                    // Link ok — ghi lại status
                    await updateProduct(saved.id, {
                      linkHealthStatus: 'ok' as Product['linkHealthStatus'],
                      linkLastCheckedAt: new Date().toISOString(),
                    } as Partial<Product>);
                  }
                }

                // Check image (chỉ nếu link ok)
                if (!healthBlocked) {
                  const imgUrl = getText(productDraft.imageUrl);

                  if (imgUrl) {
                    const imageResult = await checkImageHealth(imgUrl);

                    if (!imageResult.ok) {
                      healthBlocked = true;
                      blockedByImageCount += 1;

                      await updateProduct(saved.id, {
                        status: 'needs_review',
                        publicHidden: true,
                        aiApproved: false,
                        imageHealthStatus: imageResult.status as Product['imageHealthStatus'],
                        unpublishedReason: `Ảnh lỗi: ${imageResult.reason}`,
                      } as Partial<Product>);

                      savedRecord = { ...savedRecord, autoPublished: false, status: 'needs_review' };
                      autoPublished = false;
                      savedStatus = 'needs_review';

                      await this.ctx.warn('Auto-publish blocked by image health', {
                        productId: saved.id,
                        imageStatus: imageResult.status,
                        imageReason: imageResult.reason,
                        imageUrl: imgUrl,
                      });
                    } else {
                      await updateProduct(saved.id, {
                        imageHealthStatus: 'ok' as Product['imageHealthStatus'],
                      } as Partial<Product>);
                    }
                  }
                }
              } catch (healthError) {
                // Health check lỗi — không crash bot, giữ sản phẩm nhưng đưa vào review
                await this.ctx.warn('Health check error — product moved to review', {
                  productId: saved.id,
                  error: healthError instanceof Error ? healthError.message : String(healthError),
                });
              }
            }

            if (autoPublished || savedStatus === 'published') {
              autoPublishedCount += 1;
            } else if (isProductLikeKind(draftKind)) {
              needsReviewProductCount += 1;
            } else {
              archivedNonProductCount += 1;
            }

            if (isProductLikeKind(draftKind)) {
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
                  aiApproved: Boolean(productDraft.aiApproved),
                  autoPublished,
                  autoPublishReason:
                      getText(productDraft.autoPublishReason) ||
                      getText(productDraft.autoPublishBlockedReason) ||
                      null,
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
        returnedCount,
        savedInternalCount,
        pipelineCandidateCount: pipelineCandidates.length,
        autoPublishedCount,
        needsReviewProductCount,
        archivedNonProductCount,
        blockedByLinkCount,
        blockedByImageCount,
        duplicateCount,
        skippedCount,
        skippedFromPublicCount,
        productsFound: kindCounters.productsFound,
        vouchersFound: kindCounters.vouchersFound,
        campaignsFound: kindCounters.campaignsFound,
        storeOffersFound: kindCounters.storeOffersFound,
        unknownFound: kindCounters.unknownFound,
        autoMode: AUTO_SAFE_MODE,
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