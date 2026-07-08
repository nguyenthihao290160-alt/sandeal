// ===========================================
// Source Scout Bot
// Finds candidate products from real sources
// ===========================================

import type { Product, ProductKind } from '../types';
import { BotContext } from './context';
import { listProducts, createProduct, getAllProducts } from '../storage/products';
import { classifyProductKind } from '../sourceItemClassifier';
import {
  isAccessTradeConfigured,
  searchAccessTrade,
} from '../integrations/accesstrade';

type SourceName = 'local' | 'accesstrade' | 'manual' | 'all';

type AccessTradeRawItem = Record<string, unknown>;

type AccessTradeSearchResult = {
  items?: AccessTradeRawItem[];
  products?: AccessTradeRawItem[];
  vouchers?: AccessTradeRawItem[];
  campaigns?: AccessTradeRawItem[];
  data?: {
    items?: AccessTradeRawItem[];
    products?: AccessTradeRawItem[];
    vouchers?: AccessTradeRawItem[];
    campaigns?: AccessTradeRawItem[];
  };
};

type MutableProductDraft = Partial<Product> & Record<string, unknown>;

type SourceCollectionKind = 'product' | 'voucher' | 'campaign' | 'unknown';

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
];

const ACCESS_TRADE_ID_KEYS = [
  'sourceId',
  'source_id',
  'externalId',
  'external_id',
  'id',
  'productId',
  'product_id',
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
  'affiliateLink',
  'affiliate_link',
  'trackingLink',
  'tracking_link',
  'deeplink',
  'deepLink',
  'link',
];

const ACCESS_TRADE_ORIGINAL_URL_KEYS = [
  'originalUrl',
  'original_url',
  'productUrl',
  'product_url',
  'url',
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
  'merchant',
  'merchantName',
  'merchant_name',
  'shop',
  'shopName',
  'shop_name',
  'advertiser',
  'advertiserName',
  'advertiser_name',
];

const ACCESS_TRADE_CATEGORY_KEYS = [
  'category',
  'categoryName',
  'category_name',
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

function normalizeText(value: unknown): string {
  return getText(value)
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
    const value = getText(getPathValue(item, key));
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
    { collectionKind: 'unknown', items: payload.data?.items },
    { collectionKind: 'product', items: payload.data?.products },
    { collectionKind: 'voucher', items: payload.data?.vouchers },
    { collectionKind: 'campaign', items: payload.data?.campaigns },
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
      collectionKind === 'voucher' ||
      collectionKind === 'campaign'
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
      ]) || 'unknown'
  ).toLowerCase();
}

function normalizePlatformText(value: string): string {
  const lower = value.toLowerCase();

  if (lower.includes('shopee')) return 'shopee';
  if (lower.includes('lazada')) return 'lazada';
  if (lower.includes('tiktok')) return 'tiktok_shop';
  if (lower.includes('access')) return 'accesstrade';

  return 'other';
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

  const productDraft = {
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
    publicHidden: isNonProduct,
    needsVerification,
    aiApproved: false,
    approvalMode: 'manual_or_auto_safe_required',

    status: 'needs_review',

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
    checkBeforeBuy: [
      'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
      'Giá và ưu đãi có thể thay đổi theo thời điểm.',
    ],

    complianceStatus: 'needs_edit',
    contentPackageStatus: 'none',
  } as MutableProductDraft;

  return productDraft;
}

export class SourceScoutBot {
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  async scanSource(source: SourceName, limit: number): Promise<Product[]> {
    const totalLimit = Math.min(Math.max(limit || 10, 1), 20);
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
      note: 'Only real product-like candidates are returned to next pipeline steps. Voucher/campaign/store offers stay internal.',
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

      const totalLimit = Math.min(Math.max(limit || 10, 1), 20);
      const perKeywordLimit = Math.min(5, Math.max(3, totalLimit));

      const pipelineCandidates: Product[] = [];

      let savedInternalCount = 0;
      let returnedCount = 0;
      let duplicateCount = 0;
      let skippedCount = 0;
      let keywordsScanned = 0;
      let skippedFromPublicCount = 0;

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
        if (savedInternalCount >= totalLimit) break;

        keywordsScanned += 1;

        await this.ctx.info('Scanning AccessTrade keyword', {
          keyword,
          limit: perKeywordLimit,
          remainingSlots: totalLimit - savedInternalCount,
        });

        let searchResult: unknown;

        try {
          searchResult = await searchAccessTrade({
            keyword,
            limit: perKeywordLimit,
            kind: 'all',
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
          if (savedInternalCount >= totalLimit) break;

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

            if (isProductLikeKind(draftKind)) {
              pipelineCandidates.push(saved);
            }

            if (rawSourceId) seenExternalIds.add(rawSourceId);
            if (finalAffiliateUrl) seenUrls.add(normalizeUrl(finalAffiliateUrl));
            if (finalOriginalUrl) seenUrls.add(normalizeUrl(finalOriginalUrl));
            if (finalUrl) seenUrls.add(normalizeUrl(finalUrl));
            if (normalizedTitle) seenTitles.add(normalizedTitle);

            await this.ctx.info('AccessTrade saved needs_review', {
              keyword,
              productId: saved.id,
              sourceId: rawSourceId || null,
              title: mappedTitle,
              kind: draftKind || 'unknown',
              rawSourceKind: productDraft.rawSourceKind,
              publicHidden: Boolean(productDraft.publicHidden),
              needsVerification: Boolean(productDraft.needsVerification),
              returnedToPipeline: isProductLikeKind(draftKind),
            });
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
        duplicateCount,
        skippedCount,
        skippedFromPublicCount,
        productsFound: kindCounters.productsFound,
        vouchersFound: kindCounters.vouchersFound,
        campaignsFound: kindCounters.campaignsFound,
        storeOffersFound: kindCounters.storeOffersFound,
        unknownFound: kindCounters.unknownFound,
      });

      return pipelineCandidates;
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