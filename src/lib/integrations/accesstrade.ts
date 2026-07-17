// ===========================================
// AccessTrade Integration — Server-side only
// ===========================================
// WARNING:
// - This module must ONLY be imported from server-side code.
// - Never import this in client components.
// - Never expose API keys to frontend.
// - Never fake products, prices, stock, images, reviews, or experience.
// - Product/datafeed items are preferred.
// - Voucher/campaign/store offers are stored internally only and blocked from public.
// - Public auto-publish must be decided again by SourceScout + ProductHealthGuard.

import { getServerConfig } from '../config';
import { getRawPrimaryCredentialValue } from '../storage/tokenVault';
import type { Product, ProductKind, ProductPlatform } from '../types';
import { classifyProductKind, looksLikeVoucherOrCampaign } from '../sourceItemClassifier';
import { getDomainCircuitDecision, recordDomainHealth } from '../bots/domainCircuitBreaker';

// ---- Types ----

export interface AccessTradeSearchParams {
  keyword?: string;
  category?: string;
  platform?: string;
  kind?: 'product' | 'voucher' | 'campaign' | 'store_offer' | 'unknown' | 'all';
  limit?: number;
  imageOnly?: boolean;
  affiliateLinkOnly?: boolean;
}

export type AccessTradePublicDecision =
    | 'public_candidate'
    | 'needs_review'
    | 'blocked'
    | 'archived';

export interface NormalizedAccessTradeItem {
  id: string;
  name: string;
  description: string;
  kind: ProductKind;
  sourceItemKind: ProductKind;
  platform: ProductPlatform;
  imageUrl: string;
  imageCandidates: string[];   // All image URLs from raw payload, ordered by priority
  originalUrl: string;
  canonicalProductUrl?: string; // Decoded from affiliate deeplink if available
  affiliateUrl: string;
  price: number;
  salePrice: number;
  category: string;
  commissionRate?: number;
  campaignName?: string;
  rawSourceKind: string;

  needsVerification: boolean;
  verifiedSource: boolean;
  publicHidden: boolean;

  autoPublishEligible: boolean;
  publicDecision: AccessTradePublicDecision;
  publicBlockReason: string;
  nonProductReason?: string;
  qualityScore: number;

  rawData?: Record<string, unknown>;
}

export interface AccessTradeSearchResult {
  items: NormalizedAccessTradeItem[];
  products: NormalizedAccessTradeItem[];
  vouchers: NormalizedAccessTradeItem[];
  campaigns: NormalizedAccessTradeItem[];
  storeOffers: NormalizedAccessTradeItem[];
  unknown: NormalizedAccessTradeItem[];
  summary: {
    total: number;
    products: number;
    vouchers: number;
    campaigns: number;
    storeOffers: number;
    unknown: number;
    realProducts: number;
    nonProducts: number;
    publicEligibleProducts: number;
    publicCandidates: number;
    needsReview: number;
    archived: number;
    blockedFromPublic: number;
  };
  requests: AccessTradeRequestLog[];
}

export type AccessTradeResultType =
  | 'success_with_results' | 'success_empty' | 'timeout' | 'rate_limited'
  | 'unauthorized' | 'forbidden' | 'upstream_error' | 'malformed_response' | 'network_error' | 'circuit_open';

export interface AccessTradeRequestLog {
  endpoint: string;
  durationMs: number;
  statusCode?: number;
  resultType: AccessTradeResultType;
  itemCount: number;
  retryAfter?: string;
  attempts?: number;
}

export class AccessTradeRequestError extends Error {
  constructor(public readonly resultType: AccessTradeResultType, public readonly requests: AccessTradeRequestLog[], message: string) {
    super(message);
    this.name = 'AccessTradeRequestError';
  }
}

type AccessTradeEndpointKind = 'datafeed' | 'offers';

interface AccessTradeFetchResult {
  endpoint: AccessTradeEndpointKind;
  ok: boolean;
  items: AccessTradeRawItem[];
  status?: number;
  error?: string;
  request?: AccessTradeRequestLog;
  attempts?: number;
}

function toRequestLog(result: AccessTradeFetchResult): AccessTradeRequestLog {
  if (result.request) return result.request;
  return {
    endpoint: result.endpoint,
    durationMs: 0,
    statusCode: result.status,
    resultType: result.ok ? (result.items.length ? 'success_with_results' : 'success_empty') : 'malformed_response',
    itemCount: result.items.length,
    attempts: result.attempts ?? 1,
  };
}

// ---- Raw API response types ----

interface AccessTradeRawItem {
  id?: string;
  _id?: string;
  sourceId?: string;
  source_id?: string;
  externalId?: string;
  external_id?: string;
  productId?: string;
  product_id?: string;
  campaignId?: string;
  campaign_id?: string;
  offerId?: string;
  offer_id?: string;
  sku?: string;
  skuId?: string;
  sku_id?: string;
  itemId?: string;
  item_id?: string;

  name?: string;
  title?: string;
  productName?: string;
  product_name?: string;
  voucherName?: string;
  voucher_name?: string;
  campaignName?: string;
  campaign_name?: string;
  offerName?: string;
  offer_name?: string;

  desc?: string | null;
  description?: string | null;
  shortDescription?: string | null;
  short_description?: string | null;
  summary?: string | null;
  content?: string | null;
  promotion?: string | null;

  image?: string;
  image_url?: string;
  imageUrl?: string;
  productImage?: string;
  product_image?: string;
  thumbnail?: string;
  thumbnail_url?: string;
  thumbnailUrl?: string;
  logo?: string;
  banner?: string;

  url?: string;
  link?: string;
  final_url?: string;
  finalUrl?: string;
  originalUrl?: string;
  original_url?: string;
  productUrl?: string;
  product_url?: string;
  landingPage?: string;
  landing_page?: string;
  merchantUrl?: string;
  merchant_url?: string;

  aff_link?: string;
  affiliate_url?: string;
  affiliateUrl?: string;
  affiliate_link?: string;
  affiliateLink?: string;
  tracking_link?: string;
  trackingLink?: string;
  deep_link?: string;
  deepLink?: string;
  deeplink?: string;

  price?: number | string;
  sale_price?: number | string;
  salePrice?: number | string;
  currentPrice?: number | string;
  current_price?: number | string;
  discount?: number | string;
  discount_price?: number | string;
  discountPrice?: number | string;
  discountedPrice?: number | string;
  discounted_price?: number | string;
  originalPrice?: number | string;
  original_price?: number | string;
  listPrice?: number | string;
  list_price?: number | string;
  oldPrice?: number | string;
  old_price?: number | string;
  marketPrice?: number | string;
  market_price?: number | string;
  discount_amount?: number | string;
  discount_rate?: number | string;
  status_discount?: number | string;

  category?: string;
  cate?: string;
  categoryName?: string;
  category_name?: string;
  cat_name?: string;
  vertical?: string;
  industry?: string;

  commission?: number | string;
  commission_rate?: number | string;
  commissionRate?: number | string;

  merchant?: string;
  merchantName?: string;
  merchant_name?: string;
  advertiser?: string;
  advertiserName?: string;
  advertiser_name?: string;
  shop?: string;
  shopName?: string;
  shop_name?: string;
  campaign?: string;
  campaign_name_text?: string;
  domain?: string;

  coupon_code?: string;
  voucher_code?: string;
  voucherCode?: string;
  couponCode?: string;

  type?: string;
  kind?: string;
  itemType?: string;
  item_type?: string;
  sourceType?: string;
  source_type?: string;
  categoryType?: string;
  category_type?: string;
  objectType?: string;
  object_type?: string;

  update_time?: string;
  updated_at?: string;
  created_at?: string;

  __sandealEndpoint?: AccessTradeEndpointKind;
  __sandealSourceKind?: string;
  __sandealEndpointUrl?: string;

  [key: string]: unknown;
}

// ---- Public functions ----

export async function isAccessTradeConfigured(): Promise<boolean> {
  const vaultKey = await getRawPrimaryCredentialValue('accesstrade');
  if (vaultKey && vaultKey.length > 5) return true;

  const { accessTradeApiKey } = getServerConfig();
  return Boolean(accessTradeApiKey && accessTradeApiKey.length > 5);
}

export async function searchAccessTrade(
    params: AccessTradeSearchParams,
): Promise<AccessTradeSearchResult> {
  const accessTradeApiKey = await getAccessTradeKey();

  if (!accessTradeApiKey) {
    throw new Error(
        'Chưa cấu hình AccessTrade API key. Hãy thêm trong Token Vault hoặc đặt ACCESS_TRADE_API_KEY trong env.',
    );
  }

  const limit = Math.min(Math.max(params.limit || 20, 1), 50);
  const fetchLimit = Math.min(Math.max(limit * 4, 50), 200);

  const shouldFetchProducts =
      !params.kind ||
      params.kind === 'all' ||
      params.kind === 'product' ||
      params.kind === 'unknown';

  const shouldFetchOffers =
      !params.kind ||
      params.kind === 'all' ||
      params.kind === 'voucher' ||
      params.kind === 'campaign' ||
      params.kind === 'store_offer' ||
      params.kind === 'unknown';

  const fetchResults: AccessTradeFetchResult[] = [];

  if (shouldFetchProducts) {
    fetchResults.push(await fetchAccessTradeDatafeeds(accessTradeApiKey, params, fetchLimit));
  }

  if (shouldFetchOffers) {
    fetchResults.push(await fetchAccessTradeOffers(accessTradeApiKey, params, fetchLimit));
  }

  const successfulResults = fetchResults.filter((result) => result.ok);

  if (!successfulResults.length) {
    const errorMessage = fetchResults
        .map((result) => `${result.endpoint}: ${result.error || `HTTP ${result.status || 'unknown'}`}`)
        .join(' | ');

    const requests = fetchResults.map(toRequestLog);
    const terminal = requests.find((item) => ['unauthorized', 'forbidden', 'rate_limited', 'circuit_open'].includes(item.resultType)) || requests[0];
    throw new AccessTradeRequestError(
        terminal?.resultType || 'network_error',
        requests,
        `Không thể lấy dữ liệu từ AccessTrade. Vui lòng kiểm tra API key hoặc thử lại sau. ${errorMessage}`,
    );
  }

  const rawItems = dedupeRawItems(successfulResults.flatMap((result) => result.items));

  let items = rawItems.map(normalizeAccessTradeItem);

  items = applySearchFilters(items, params);
  items = applyRequestedKindFilter(items, params.kind);

  if (params.imageOnly) {
    items = items.filter((item) => Boolean(item.imageUrl));
  }

  if (params.affiliateLinkOnly) {
    items = items.filter((item) => Boolean(item.affiliateUrl));
  }

  items = sortAccessTradeItems(items).slice(0, limit);

  const products = items.filter((item) => item.kind === 'product' || item.kind === 'deal');
  const vouchers = items.filter((item) => item.kind === 'voucher');
  const campaigns = items.filter((item) => item.kind === 'campaign');
  const storeOffers = items.filter((item) => item.kind === 'store_offer');
  const unknown = items.filter((item) => item.kind === 'unknown');

  const publicEligibleProducts = products.filter((item) => item.autoPublishEligible).length;
  const publicCandidates = items.filter((item) => item.publicDecision === 'public_candidate').length;
  const needsReview = items.filter((item) => item.publicDecision === 'needs_review').length;
  const archived = items.filter((item) => item.publicDecision === 'archived').length;

  return {
    items,
    products,
    vouchers,
    campaigns,
    storeOffers,
    unknown,
    summary: {
      total: items.length,
      products: products.length,
      vouchers: vouchers.length,
      campaigns: campaigns.length,
      storeOffers: storeOffers.length,
      unknown: unknown.length,
      realProducts: products.length,
      nonProducts: vouchers.length + campaigns.length + storeOffers.length + unknown.length,
      publicEligibleProducts,
      publicCandidates,
      needsReview,
      archived,
      blockedFromPublic: items.length - publicEligibleProducts,
    },
    requests: fetchResults.map(toRequestLog),
  };
}

export function normalizeAccessTradeItem(
    item: AccessTradeRawItem,
): NormalizedAccessTradeItem {
  const name = getFirstText(item, [
    'productName',
    'product_name',
    'title',
    'name',
    'voucherName',
    'voucher_name',
    'offerName',
    'offer_name',
    'campaignName',
    'campaign_name',
  ]);

  const description = getFirstText(item, [
    'desc',
    'description',
    'shortDescription',
    'short_description',
    'summary',
    'content',
    'promotion',
  ]);

  const imageUrl = getFirstText(item, [
    'productImage',
    'product_image',
    'image',
    'image_url',
    'imageUrl',
    'thumbnail',
    'thumbnail_url',
    'thumbnailUrl',
    'logo',
    'banner',
  ]);

  // Collect ALL image URL candidates from raw payload for fallback logic
  const imageCandidates: string[] = [];
  const imageFieldOrder = [
    'productImage', 'product_image', 'image', 'image_url', 'imageUrl',
    'thumbnail', 'thumbnail_url', 'thumbnailUrl', 'logo', 'banner',
    'coverImage', 'cover_image', 'heroImage', 'hero_image',
    'gallery', 'images', 'photos',
  ];
  for (const field of imageFieldOrder) {
    const val = getFirstText(item, [field]);
    if (val && isValidHttpUrl(val) && !imageCandidates.includes(val)) {
      imageCandidates.push(val);
    }
  }
  // Also extract from arrays like gallery/images if present
  const galleryField = (item as Record<string, unknown>).gallery;
  if (Array.isArray(galleryField)) {
    for (const entry of galleryField) {
      const entryUrl = typeof entry === 'string' ? entry.trim() : (typeof entry === 'object' && entry ? String((entry as Record<string, unknown>).url ?? '') : '');
      if (entryUrl && isValidHttpUrl(entryUrl) && !imageCandidates.includes(entryUrl)) {
        imageCandidates.push(entryUrl);
      }
    }
  }

  const originalUrl = getFirstText(item, [
    'productUrl',
    'product_url',
    'originalUrl',
    'original_url',
    'final_url',
    'finalUrl',
    'url',
    'link',
    'landingPage',
    'landing_page',
    'merchantUrl',
    'merchant_url',
  ]);

  const affiliateUrl = getFirstText(item, [
    'aff_link',
    'affiliate_url',
    'affiliateUrl',
    'affiliate_link',
    'affiliateLink',
    'tracking_link',
    'trackingLink',
    'deep_link',
    'deepLink',
    'deeplink',
  ]);

  const category = getFirstText(item, [
    'cate',
    'category',
    'categoryName',
    'category_name',
    'cat_name',
    'vertical',
    'industry',
  ]);

  const campaignName = getFirstText(item, [
    'campaign_name',
    'campaignName',
    'campaign',
    'campaign_name_text',
    'merchant',
    'merchantName',
    'merchant_name',
    'advertiser',
    'advertiserName',
    'advertiser_name',
    'shop',
    'shopName',
    'shop_name',
    'domain',
  ]);

  const price =
      parsePriceNumber(item.price) ||
      parsePriceNumber(item.currentPrice) ||
      parsePriceNumber(item.current_price) ||
      parsePriceNumber(item.originalPrice) ||
      parsePriceNumber(item.original_price) ||
      parsePriceNumber(item.listPrice) ||
      parsePriceNumber(item.list_price) ||
      parsePriceNumber(item.oldPrice) ||
      parsePriceNumber(item.old_price) ||
      parsePriceNumber(item.marketPrice) ||
      parsePriceNumber(item.market_price) ||
      0;

  const salePrice =
      parsePriceNumber(item.salePrice) ||
      parsePriceNumber(item.sale_price) ||
      parsePriceNumber(item.discountedPrice) ||
      parsePriceNumber(item.discounted_price) ||
      parsePriceNumber(item.discount_price) ||
      parsePriceNumber(item.discountPrice) ||
      parsePriceNumber(item.currentPrice) ||
      parsePriceNumber(item.current_price) ||
      0;

  const commissionRate =
      parseNumber(item.commission_rate) ||
      parseNumber(item.commissionRate) ||
      parseNumber(item.commission);

  const rawSourceKind = getRawSourceKind(item);
  const kind = detectAccessTradeItemKind(item);
  const isRealProduct = kind === 'product' || kind === 'deal';

  const completeness = getProductCompleteness({
    name,
    imageUrl,
    originalUrl,
    affiliateUrl,
    price,
    salePrice,
  });

  const titleLooksUnsafe = looksLikeVoucherOrCampaign({
    title: name,
    description,
    rawSourceKind,
    source: 'accesstrade',
    raw: item,
  });

  const hardNonProductKind = getHardNonProductKind(item, name, description, rawSourceKind);
  const isDatafeedProduct = item.__sandealEndpoint === 'datafeed' && hasDatafeedProductSignals(item);
  const hasStrongProductSource =
      isDatafeedProduct ||
      normalizeText(rawSourceKind).includes('product_feed') ||
      normalizeText(rawSourceKind).includes('datafeed');

  const hasStrongProductSignals = hasProductSignals(item);
  const nonProductReason = getNonProductReason(kind, hardNonProductKind);

  const verifiedSource =
      isRealProduct &&
      completeness.hasTitle &&
      completeness.hasImage &&
      completeness.hasUrl &&
      completeness.hasPrice &&
      hasStrongProductSignals &&
      hasStrongProductSource &&
      !titleLooksUnsafe &&
      !hardNonProductKind;

  const qualityScore = computeSourceQualityScore({
    kind,
    verifiedSource,
    isDatafeedProduct,
    hasStrongProductSignals,
    completeness,
    titleLooksUnsafe,
    hardNonProductKind,
  });

  const publicBlockReason = getPublicBlockReason({
    kind,
    verifiedSource,
    completeness,
    titleLooksUnsafe,
    hardNonProductKind,
    nonProductReason,
    qualityScore,
  });

  const publicDecision = getPublicDecision({
    kind,
    verifiedSource,
    publicBlockReason,
    qualityScore,
  });

  const autoPublishEligible = publicDecision === 'public_candidate';
  const needsVerification = !autoPublishEligible;

  // Try to decode real product URL from affiliate deeplink query params
  const canonicalProductUrl = decodeProductUrlFromAffiliateLink(affiliateUrl) || undefined;

  // Integration layer never exposes an item directly.
  // SourceScout must run link + image health checks before publicHidden can become false.
  const publicHidden = true;

  return {
    id: getItemId(item),
    name,
    description,
    kind,
    sourceItemKind: kind,
    platform: 'accesstrade',
    imageUrl,
    imageCandidates,
    originalUrl,
    canonicalProductUrl,
    affiliateUrl,
    price,
    salePrice,
    category,
    commissionRate: commissionRate || undefined,
    campaignName: campaignName || undefined,
    rawSourceKind,
    needsVerification,
    verifiedSource,
    publicHidden,
    autoPublishEligible,
    publicDecision,
    publicBlockReason,
    nonProductReason,
    qualityScore,
    rawData: item,
  };
}

/**
 * Try to extract the actual product URL from an affiliate deeplink.
 * AccessTrade deeplinks often encode the target URL as a query parameter:
 * https://pub.accesstrade.vn/deep_link/xxx?url=https%3A%2F%2Fshopee.vn%2F...
 *
 * Returns the decoded URL if valid, or null if not decodable.
 */
export function decodeProductUrlFromAffiliateLink(affiliateUrl: string): string | null {
  if (!affiliateUrl || !isValidHttpUrl(affiliateUrl)) return null;

  try {
    const parsed = new URL(affiliateUrl);
    // Common params that contain the real destination URL
    const destParams = ['url', 'deeplink', 'target', 'destination', 'redirect', 'landing', 'to', 'href', 'link', 'u'];

    for (const param of destParams) {
      const value = parsed.searchParams.get(param);
      if (value && isValidHttpUrl(value)) {
        return value;
      }
      // Also try URL-decoded version
      try {
        const decoded = decodeURIComponent(value ?? '');
        if (decoded && isValidHttpUrl(decoded)) {
          return decoded;
        }
      } catch { /* ignore */ }
    }

    // Some links encode destination in path: /deep_link/campaignId/productUrl
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    for (const part of pathParts) {
      try {
        const decoded = decodeURIComponent(part);
        if (isValidHttpUrl(decoded)) {
          return decoded;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return null;
}

export function detectAccessTradeItemKind(item: AccessTradeRawItem): ProductKind {
  const rawSourceKind = getRawSourceKind(item);

  const title = getFirstText(item, [
    'productName',
    'product_name',
    'title',
    'name',
    'voucherName',
    'voucher_name',
    'campaignName',
    'campaign_name',
    'offerName',
    'offer_name',
  ]);

  const description = getFirstText(item, [
    'desc',
    'description',
    'shortDescription',
    'short_description',
    'summary',
    'content',
    'promotion',
  ]);

  const rawText = normalizeText(
      [
        rawSourceKind,
        item.type,
        item.kind,
        item.itemType,
        item.item_type,
        item.sourceType,
        item.source_type,
        item.categoryType,
        item.category_type,
        item.objectType,
        item.object_type,
        item.__sandealEndpoint,
        item.__sandealSourceKind,
      ].join(' '),
  );

  const hardNonProductKind = getHardNonProductKind(item, title, description, rawSourceKind);

  if (hardNonProductKind) {
    return hardNonProductKind;
  }

  if (item.__sandealEndpoint === 'datafeed' && hasDatafeedProductSignals(item)) {
    return 'product';
  }

  if (
      rawText.includes('product') ||
      rawText.includes('datafeed') ||
      rawText.includes('product feed') ||
      rawText.includes('product_feed')
  ) {
    if (hasProductSignals(item)) {
      return 'product';
    }
  }

  const looksLikeOffer = looksLikeVoucherOrCampaign({
    title,
    description,
    rawSourceKind,
    source: 'accesstrade',
    raw: item,
  });

  if (looksLikeOffer) {
    if (isStoreOfferText(title, description, rawSourceKind)) {
      return 'store_offer';
    }

    if (isCampaignText(title, description, rawSourceKind)) {
      return 'campaign';
    }

    return 'voucher';
  }

  if (hasProductSignals(item)) {
    return 'product';
  }

  if (item.campaign_name || item.campaign || item.campaignName) {
    return 'campaign';
  }

  const classified = classifyProductKind({
    title,
    name: title,
    description,
    source: 'accesstrade',
    imageUrl: getFirstText(item, ['image', 'image_url', 'imageUrl', 'thumbnail']),
    affiliateUrl: getFirstText(item, [
      'aff_link',
      'affiliate_url',
      'affiliateUrl',
      'deep_link',
      'deepLink',
    ]),
    originalUrl: getFirstText(item, ['url', 'link', 'productUrl', 'product_url']),
    url: getFirstText(item, ['url', 'link', 'productUrl', 'product_url']),
    price: parsePriceNumber(item.price),
    salePrice: parsePriceNumber(item.sale_price) || parsePriceNumber(item.salePrice),
    rawSourceKind,
    sourceType: 'affiliate',
    raw: item,
  });

  const classifiedNonProductKind = getHardNonProductKind(item, title, description, rawSourceKind);
  if (classifiedNonProductKind) return classifiedNonProductKind;

  return classified;
}

export function mapAccessTradeToProduct(
    item: NormalizedAccessTradeItem,
): Omit<Product, 'id' | 'slug' | 'createdAt' | 'updatedAt'> {
  const isRealProduct = item.kind === 'product' || item.kind === 'deal';
  const shouldArchive = item.publicDecision === 'archived' || !isRealProduct;
  const status = shouldArchive ? 'archived' : 'needs_review';

  const product = {
    title: item.name,
    description: item.description || undefined,

    kind: item.kind,
    sourceItemKind: item.kind,

    platform: 'accesstrade',
    source: 'accesstrade',
    dataSource: 'accesstrade',
    importedFrom: 'accesstrade',
    sourceType: 'affiliate',
    rawSourceKind: item.rawSourceKind,

    originalUrl: item.originalUrl || undefined,
    affiliateUrl: item.affiliateUrl || undefined,
    url: item.affiliateUrl || item.originalUrl || undefined,

    imageUrl: item.imageUrl || undefined,
    gallery: [],

    price: item.price || undefined,
    salePrice: item.salePrice || undefined,
    currency: 'VND',

    category: item.category || undefined,
    tags: [],
    benefits: [],
    warnings: [
      'SanDeal không tự tạo giá, ảnh, tồn kho hoặc trải nghiệm mua hàng.',
      'Sản phẩm/ưu đãi cần được kiểm tra lại trước khi hiển thị công khai.',
    ],
    checkBeforeBuy: [
      'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
      'Giá, tồn kho và ưu đãi có thể thay đổi theo thời điểm.',
      'SanDeal có thể nhận hoa hồng tiếp thị liên kết, giá người mua không đổi.',
    ],

    affiliateSource: 'accesstrade',
    campaignName: item.campaignName || undefined,
    commissionNote: item.commissionRate ? `Hoa hồng: ${item.commissionRate}%` : undefined,

    riskLevel: item.needsVerification ? 'unknown' : 'low',
    status,

    externalId: item.id,
    sourceId: item.id,

    verifiedSource: item.verifiedSource,
    sourceVerified: item.verifiedSource,

    // Always keep imported records hidden at the integration boundary.
    // SourceScout is the only layer allowed to unhide after strict health checks.
    publicHidden: true,
    needsVerification: item.needsVerification,
    healthCheckRequired: isRealProduct,

    aiApproved: false,
    autoPublished: false,
    approvalMode: 'manual_or_auto_safe_required',

    complianceStatus: 'needs_edit',
    contentPackageStatus: 'none',

    autoPublishEligible: item.autoPublishEligible,
    publicDecision: item.publicDecision,
    publicBlockReason: item.publicBlockReason,
    nonProductReason: item.nonProductReason,
    qualityScore: item.qualityScore,
    sourceQualityScore: item.qualityScore,

    rawSourceType: 'accesstrade',
    rawData: item.rawData,
  } as Omit<Product, 'id' | 'slug' | 'createdAt' | 'updatedAt'> & Record<string, unknown>;

  return product;
}

// ---- AccessTrade fetchers ----

async function getAccessTradeKey(): Promise<string | null> {
  const vaultKey = await getRawPrimaryCredentialValue('accesstrade');
  if (vaultKey && vaultKey.length > 5) return vaultKey;

  const { accessTradeApiKey } = getServerConfig();
  return accessTradeApiKey || null;
}

async function fetchAccessTradeDatafeeds(
    apiKey: string,
    params: AccessTradeSearchParams,
    limit: number,
): Promise<AccessTradeFetchResult> {
  const url = new URL('https://api.accesstrade.vn/v1/datafeeds');

  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', '1');

  const domain = resolveAccessTradeDomain(params.platform);
  const campaign = resolveAccessTradeCampaign(params.platform);

  if (domain) {
    url.searchParams.set('domain', domain);
  } else if (campaign) {
    url.searchParams.set('campaign', campaign);
  }

  if (params.category) {
    url.searchParams.set('cate', toAsciiSlug(params.category));
  }
  if (params.keyword) url.searchParams.set('keyword', params.keyword);

  return fetchAccessTradeEndpoint(apiKey, url, 'datafeed', 'product_feed');
}

async function fetchAccessTradeOffers(
    apiKey: string,
    params: AccessTradeSearchParams,
    limit: number,
): Promise<AccessTradeFetchResult> {
  const url = new URL('https://api.accesstrade.vn/v1/offers_informations');

  url.searchParams.set('limit', String(limit));

  if (params.keyword) {
    url.searchParams.set('keyword', params.keyword);
  }

  if (params.category) {
    url.searchParams.set('category', params.category);
  }

  return fetchAccessTradeEndpoint(apiKey, url, 'offers', 'offer_feed');
}

async function fetchAccessTradeEndpoint(
    apiKey: string,
    url: URL,
    endpoint: AccessTradeEndpointKind,
    sourceKind: string,
): Promise<AccessTradeFetchResult> {
  const MAX_RETRIES = 1;
  const TIMEOUT_MS = 15_000;
  const circuit = await getDomainCircuitDecision(url.toString());
  if (!circuit.allowed) {
    return {
      endpoint,
      ok: false,
      items: [],
      error: `Source circuit open until ${circuit.retryAt || 'next probe'}`,
      request: {
        endpoint,
        durationMs: 0,
        resultType: 'circuit_open',
        itemCount: 0,
        retryAfter: circuit.retryAt,
        attempts: 0,
      },
    };
  }
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    let response: Response | undefined;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      if (attempt >= MAX_RETRIES) await recordDomainHealth(url.toString(), isTimeout ? 'timeout' : 'error');
      
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 500)));
        continue;
      }
      
      const message = err instanceof Error ? err.message : 'Lỗi kết nối';
      return {
        endpoint,
        ok: false,
        items: [],
        error: isTimeout ? `Request timeout after ${TIMEOUT_MS / 1000} seconds` : message,
        request: { endpoint, durationMs: Date.now() - startedAt, resultType: isTimeout ? 'timeout' : 'network_error', itemCount: 0, attempts: attempt + 1 },
      };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      if (attempt < MAX_RETRIES && response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 500)));
        continue;
      }
      const resultType: AccessTradeResultType = response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden'
        : response.status === 429 ? 'rate_limited'
        : response.status >= 500 ? 'upstream_error' : 'network_error';
      const retryAfterHeader = response.headers.get('retry-after') || undefined;
      const retryAfterMs = retryAfterHeader
        ? (/^\d+$/.test(retryAfterHeader) ? Date.now() + Number(retryAfterHeader) * 1000 : Date.parse(retryAfterHeader))
        : NaN;
      const retryAfter = Number.isFinite(retryAfterMs) ? new Date(retryAfterMs).toISOString() : undefined;
      if (response.status === 429) {
        await recordDomainHealth(url.toString(), 'rate_limited', Date.now(), { retryAfter });
      } else if (response.status >= 500) {
        await recordDomainHealth(url.toString(), 'server_error');
      }
      return {
        endpoint,
        ok: false,
        items: [],
        status: response.status,
        error: `HTTP ${response.status}`,
        request: { endpoint, durationMs: Date.now() - startedAt, statusCode: response.status, resultType, itemCount: 0, retryAfter, attempts: attempt + 1 },
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return {
        endpoint,
        ok: false,
        items: [],
        status: response.status,
        error: 'Dữ liệu trả về không phải JSON hợp lệ.',
      };
    }

    const items = extractRawItems(data).map((rawItem) => ({
      ...rawItem,
      __sandealEndpoint: endpoint,
      __sandealSourceKind: sourceKind,
      __sandealEndpointUrl: sanitizeEndpointUrl(url),
    }));
    await recordDomainHealth(url.toString(), 'ok');

    return {
      endpoint,
      ok: true,
      items,
      status: response.status,
      attempts: attempt + 1,
    };
  }
  
  return {
    endpoint,
    ok: false,
    items: [],
    error: 'Max retries exceeded',
  };
}

// ---- Filters and sort ----

function applyRequestedKindFilter(
    items: NormalizedAccessTradeItem[],
    requestedKind?: AccessTradeSearchParams['kind'],
): NormalizedAccessTradeItem[] {
  if (!requestedKind || requestedKind === 'all') return items;

  if (requestedKind === 'product') {
    return items.filter((item) => item.kind === 'product' || item.kind === 'deal');
  }

  return items.filter((item) => item.kind === requestedKind);
}

function applySearchFilters(
    items: NormalizedAccessTradeItem[],
    params: AccessTradeSearchParams,
): NormalizedAccessTradeItem[] {
  let filtered = items;

  const keyword = normalizeText(params.keyword);
  if (keyword) {
    filtered = filtered.filter((item) => {
      const haystack = normalizeText(
          [
            item.name,
            item.description,
            item.category,
            item.campaignName,
            item.rawSourceKind,
            getRawValueText(item.rawData, 'domain'),
            getRawValueText(item.rawData, 'merchant'),
            getRawValueText(item.rawData, 'merchantName'),
            getRawValueText(item.rawData, 'campaign'),
            getRawValueText(item.rawData, 'campaign_name'),
            getRawValueText(item.rawData, 'shop'),
            getRawValueText(item.rawData, 'shopName'),
          ].join(' '),
      );

      return matchesSearchQuery(haystack, keyword);
    });
  }

  const category = normalizeText(params.category);
  if (category) {
    filtered = filtered.filter((item) => {
      const haystack = normalizeText([item.category, item.name, item.description].join(' '));
      return matchesSearchQuery(haystack, category);
    });
  }

  const platform = normalizeText(params.platform);
  if (platform && platform !== 'all' && platform !== 'accesstrade') {
    filtered = filtered.filter((item) => {
      const haystack = normalizeText(
          [
            item.platform,
            item.campaignName,
            item.originalUrl,
            item.affiliateUrl,
            getRawValueText(item.rawData, 'domain'),
            getRawValueText(item.rawData, 'merchant'),
            getRawValueText(item.rawData, 'merchantName'),
            getRawValueText(item.rawData, 'campaign'),
            getRawValueText(item.rawData, 'campaign_name'),
            getRawValueText(item.rawData, 'shop'),
            getRawValueText(item.rawData, 'shopName'),
          ].join(' '),
      );

      return haystack.includes(platform) || haystack.includes(platform.replace(/\s+/g, ''));
    });
  }

  return filtered;
}

function sortAccessTradeItems(items: NormalizedAccessTradeItem[]): NormalizedAccessTradeItem[] {
  const kindWeight: Record<string, number> = {
    product: 0,
    deal: 1,
    store_offer: 2,
    voucher: 3,
    campaign: 4,
    unknown: 5,
  };

  return [...items].sort((a, b) => {
    if (a.autoPublishEligible !== b.autoPublishEligible) {
      return Number(b.autoPublishEligible) - Number(a.autoPublishEligible);
    }

    if (a.qualityScore !== b.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }

    const aWeight = kindWeight[a.kind] ?? 10;
    const bWeight = kindWeight[b.kind] ?? 10;

    if (aWeight !== bWeight) return aWeight - bWeight;

    const aComplete = Number(Boolean(a.name && a.imageUrl && (a.affiliateUrl || a.originalUrl)));
    const bComplete = Number(Boolean(b.name && b.imageUrl && (b.affiliateUrl || b.originalUrl)));

    if (aComplete !== bComplete) return bComplete - aComplete;

    return a.name.localeCompare(b.name, 'vi');
  });
}

// ---- Product signal helpers ----

function hasDatafeedProductSignals(item: AccessTradeRawItem): boolean {
  const hasOfficialProductId = Boolean(
      getFirstText(item, ['product_id', 'productId', 'sku', 'skuId', 'sku_id', 'itemId', 'item_id']),
  );

  const hasOfficialProductUrl = isValidHttpUrl(
      getFirstText(item, ['productUrl', 'product_url', 'url', 'aff_link', 'affiliate_url', 'affiliateUrl']),
  );

  const hasOfficialProductImage = isValidHttpUrl(
      getFirstText(item, ['productImage', 'product_image', 'image', 'image_url', 'imageUrl', 'thumbnail']),
  );

  const hasOfficialProductPrice = Boolean(
      parsePriceNumber(item.price) ||
      parsePriceNumber(item.sale_price) ||
      parsePriceNumber(item.salePrice) ||
      parsePriceNumber(item.discountedPrice) ||
      parsePriceNumber(item.discounted_price) ||
      parsePriceNumber(item.currentPrice) ||
      parsePriceNumber(item.current_price),
  );

  const title = getFirstText(item, ['productName', 'product_name', 'title', 'name']);
  const rawSourceKind = getRawSourceKind(item);
  const hardNonProductKind = getHardNonProductKind(item, title, '', rawSourceKind);

  return (
      hasOfficialProductId &&
      hasOfficialProductUrl &&
      hasOfficialProductImage &&
      hasOfficialProductPrice &&
      !hardNonProductKind
  );
}

function hasProductSignals(item: AccessTradeRawItem): boolean {
  const title = getFirstText(item, ['productName', 'product_name', 'title', 'name']);
  const description = getFirstText(item, [
    'desc',
    'description',
    'shortDescription',
    'short_description',
    'summary',
    'content',
    'promotion',
  ]);
  const rawSourceKind = getRawSourceKind(item);

  const hasPrice = Boolean(
      parsePriceNumber(item.price) ||
      parsePriceNumber(item.currentPrice) ||
      parsePriceNumber(item.current_price) ||
      parsePriceNumber(item.salePrice) ||
      parsePriceNumber(item.sale_price) ||
      parsePriceNumber(item.discountedPrice) ||
      parsePriceNumber(item.discounted_price) ||
      parsePriceNumber(item.discount_price) ||
      parsePriceNumber(item.discountPrice),
  );

  const hasImage = isValidHttpUrl(
      getFirstText(item, [
        'productImage',
        'product_image',
        'image',
        'image_url',
        'imageUrl',
        'thumbnail',
        'thumbnail_url',
        'thumbnailUrl',
      ]),
  );

  const hasUrl = isValidHttpUrl(
      getFirstText(item, [
        'aff_link',
        'affiliate_url',
        'affiliateUrl',
        'affiliate_link',
        'affiliateLink',
        'tracking_link',
        'trackingLink',
        'deep_link',
        'deepLink',
        'deeplink',
        'productUrl',
        'product_url',
        'url',
        'link',
      ]),
  );

  const hasProductId = Boolean(
      getFirstText(item, [
        'productId',
        'product_id',
        'sku',
        'skuId',
        'sku_id',
        'itemId',
        'item_id',
      ]),
  );

  const hardNonProductKind = getHardNonProductKind(item, title, description, rawSourceKind);

  return Boolean(title && hasUrl && hasImage && hasPrice && (hasProductId || hasSpecificProductTitle(title)) && !hardNonProductKind);
}

function hasSpecificProductTitle(title: string): boolean {
  const text = normalizeText(title);

  if (!text) return false;

  const hasModelOrVariant =
      /\b[a-z0-9]{2,}[-_/]?[a-z0-9]{2,}\b/i.test(title) ||
      /\d+\s?(ml|g|gram|kg|l|lit|cm|mm|inch|w|mah|gb|tb|pack|pcs|vien|chai|hop|tuyp|bo|cai)\b/i.test(text) ||
      /\b(iphone|ipad|macbook|samsung|xiaomi|oppo|vivo|asus|acer|lenovo|dell|hp|sony|lg|dabo|serum|kem|sua tam|sua rua mat|tai nghe|laptop|dien thoai|may loc|noi chien|binh giu nhiet)\b/i.test(text);

  const tooGenericOffer =
      text.includes('giam gia') ||
      text.includes('uu dai') ||
      text.includes('khuyen mai') ||
      text.includes('voucher') ||
      text.includes('ma giam') ||
      text.includes('hoan tien') ||
      text.includes('cashback');

  return hasModelOrVariant && !tooGenericOffer;
}

interface ProductCompletenessInput {
  name: string;
  imageUrl: string;
  originalUrl: string;
  affiliateUrl: string;
  price: number;
  salePrice: number;
}

interface ProductCompleteness {
  hasTitle: boolean;
  hasImage: boolean;
  hasUrl: boolean;
  hasAffiliateUrl: boolean;
  hasPrice: boolean;
}

function getProductCompleteness(input: ProductCompletenessInput): ProductCompleteness {
  return {
    hasTitle: Boolean(input.name && input.name.trim().length >= 5),
    hasImage: isValidHttpUrl(input.imageUrl),
    hasUrl: isValidHttpUrl(input.affiliateUrl) || isValidHttpUrl(input.originalUrl),
    hasAffiliateUrl: isValidHttpUrl(input.affiliateUrl),
    hasPrice: Boolean((input.price && input.price > 0) || (input.salePrice && input.salePrice > 0)),
  };
}

function computeSourceQualityScore(input: {
  kind: ProductKind;
  verifiedSource: boolean;
  isDatafeedProduct: boolean;
  hasStrongProductSignals: boolean;
  completeness: ProductCompleteness;
  titleLooksUnsafe: boolean;
  hardNonProductKind: ProductKind | null;
}): number {
  let score = 0;

  if (input.kind === 'product' || input.kind === 'deal') score += 20;
  if (input.verifiedSource) score += 30;
  if (input.isDatafeedProduct) score += 20;
  if (input.hasStrongProductSignals) score += 15;

  if (input.completeness.hasTitle) score += 5;
  if (input.completeness.hasImage) score += 5;
  if (input.completeness.hasUrl) score += 5;
  if (input.completeness.hasAffiliateUrl) score += 5;
  if (input.completeness.hasPrice) score += 5;

  if (input.titleLooksUnsafe) score -= 30;
  if (input.hardNonProductKind) score -= 40;

  return Math.max(0, Math.min(100, score));
}

function getPublicBlockReason(input: {
  kind: ProductKind;
  verifiedSource: boolean;
  completeness: ProductCompleteness;
  titleLooksUnsafe: boolean;
  hardNonProductKind: ProductKind | null;
  nonProductReason?: string;
  qualityScore: number;
}): string {
  if (input.kind === 'store_offer') return input.nonProductReason || 'Chưa phải sản phẩm cụ thể.';
  if (input.kind === 'voucher') return input.nonProductReason || 'Voucher/mã giảm giá không public như sản phẩm.';
  if (input.kind === 'campaign') return input.nonProductReason || 'Campaign/chương trình khuyến mãi không public như sản phẩm.';
  if (input.kind === 'unknown') return 'Chưa xác định được đây là sản phẩm thật.';

  if (input.hardNonProductKind) {
    return getNonProductReason(input.hardNonProductKind, input.hardNonProductKind) || 'Không phải sản phẩm cụ thể.';
  }

  if (!input.completeness.hasTitle) return 'Thiếu tên sản phẩm cụ thể.';
  if (!input.completeness.hasPrice) return 'Thiếu giá hoặc giá khuyến mãi.';
  if (!input.completeness.hasImage) return 'Thiếu ảnh sản phẩm hoặc URL ảnh không hợp lệ.';
  if (!input.completeness.hasUrl) return 'Thiếu link sản phẩm/affiliate hoặc URL không hợp lệ.';
  if (input.titleLooksUnsafe) return 'Tiêu đề giống voucher/campaign/store offer, cần kiểm tra thủ công.';
  if (!input.verifiedSource) return 'Nguồn chưa đủ tín hiệu xác minh sản phẩm thật.';
  if (input.qualityScore < 70) return 'Điểm nguồn thấp, cần xem xét thêm.';

  return '';
}

function getPublicDecision(input: {
  kind: ProductKind;
  verifiedSource: boolean;
  publicBlockReason: string;
  qualityScore: number;
}): AccessTradePublicDecision {
  if (input.kind === 'store_offer' || input.kind === 'voucher' || input.kind === 'campaign') {
    return 'archived';
  }

  if (input.kind === 'unknown') {
    return 'needs_review';
  }

  if (input.verifiedSource && !input.publicBlockReason && input.qualityScore >= 70) {
    return 'public_candidate';
  }

  return 'needs_review';
}

function getNonProductReason(
    kind: ProductKind,
    hardNonProductKind?: ProductKind | null,
): string | undefined {
  const resolvedKind = hardNonProductKind || kind;

  if (resolvedKind === 'store_offer') return 'Chưa phải sản phẩm cụ thể.';
  if (resolvedKind === 'voucher') return 'Voucher/mã giảm giá không public như sản phẩm.';
  if (resolvedKind === 'campaign') return 'Campaign/chương trình khuyến mãi không public như sản phẩm.';
  if (resolvedKind === 'unknown') return 'Chưa rõ loại dữ liệu nguồn.';

  return undefined;
}

function getHardNonProductKind(
    item: AccessTradeRawItem,
    title: string,
    description: string,
    rawSourceKind: string,
): ProductKind | null {
  const rawText = normalizeText(
      [
        rawSourceKind,
        item.type,
        item.kind,
        item.itemType,
        item.item_type,
        item.sourceType,
        item.source_type,
        item.categoryType,
        item.category_type,
        item.objectType,
        item.object_type,
        item.__sandealEndpoint,
        item.__sandealSourceKind,
      ].join(' '),
  );

  if (rawText.includes('voucher') || rawText.includes('coupon')) {
    return 'voucher';
  }

  if (rawText.includes('campaign')) {
    return 'campaign';
  }

  if (
      rawText.includes('store_offer') ||
      rawText.includes('store offer') ||
      rawText.includes('shop offer') ||
      rawText.includes('offer_feed')
  ) {
    if (!hasProductSignalsWithoutNonProductCheck(item)) {
      return isVoucherText(title, description, rawSourceKind) ? 'voucher' : 'store_offer';
    }
  }

  if (item.coupon_code || item.voucher_code || item.voucherCode || item.couponCode) {
    return 'voucher';
  }

  const strongDatafeedProduct =
      item.__sandealEndpoint === 'datafeed' &&
      hasProductSignalsWithoutNonProductCheck(item) &&
      Boolean(
          getFirstText(item, [
            'product_id',
            'productId',
            'sku',
            'skuId',
            'sku_id',
            'itemId',
            'item_id',
          ]),
      );

  // For a strong datafeed product, use title-only heuristics to avoid
  // misclassifying a real product because its description mentions a shop-wide offer.
  const heuristicDescription = strongDatafeedProduct ? '' : description;

  if (isStoreOfferText(title, heuristicDescription, rawSourceKind)) {
    return 'store_offer';
  }

  if (isVoucherText(title, heuristicDescription, rawSourceKind)) {
    return 'voucher';
  }

  if (isCampaignText(title, heuristicDescription, rawSourceKind)) {
    return 'campaign';
  }

  return null;
}

function hasProductSignalsWithoutNonProductCheck(item: AccessTradeRawItem): boolean {
  const title = getFirstText(item, ['productName', 'product_name', 'title', 'name']);

  const hasPrice = Boolean(
      parsePriceNumber(item.price) ||
      parsePriceNumber(item.currentPrice) ||
      parsePriceNumber(item.current_price) ||
      parsePriceNumber(item.salePrice) ||
      parsePriceNumber(item.sale_price) ||
      parsePriceNumber(item.discountedPrice) ||
      parsePriceNumber(item.discounted_price) ||
      parsePriceNumber(item.discount_price) ||
      parsePriceNumber(item.discountPrice),
  );

  const hasImage = isValidHttpUrl(
      getFirstText(item, [
        'productImage',
        'product_image',
        'image',
        'image_url',
        'imageUrl',
        'thumbnail',
        'thumbnail_url',
        'thumbnailUrl',
      ]),
  );

  const hasUrl = isValidHttpUrl(
      getFirstText(item, [
        'aff_link',
        'affiliate_url',
        'affiliateUrl',
        'affiliate_link',
        'affiliateLink',
        'tracking_link',
        'trackingLink',
        'deep_link',
        'deepLink',
        'deeplink',
        'productUrl',
        'product_url',
        'url',
        'link',
      ]),
  );

  const hasProductId = Boolean(
      getFirstText(item, [
        'productId',
        'product_id',
        'sku',
        'skuId',
        'sku_id',
        'itemId',
        'item_id',
      ]),
  );

  return Boolean(title && hasUrl && hasImage && hasPrice && (hasProductId || hasSpecificProductTitle(title)));
}

function isStoreOfferText(title: string, description: string, rawSourceKind: string): boolean {
  const text = normalizeText([title, description, rawSourceKind].join(' '));

  if (!text) return false;

  const hasMerchantPrefix = /^\s*\[[^\]]+\]\s*-\s*/.test(title);
  const mentionsStore =
      text.includes('official store') ||
      text.includes('official shop') ||
      text.includes('store') ||
      text.includes('shop') ||
      text.includes('cua hang') ||
      text.includes('gian hang') ||
      text.includes('thuong hieu');

  const storeWideOffer =
      text.includes('toan shop') ||
      text.includes('toan san') ||
      text.includes('tat ca san pham') ||
      text.includes('don tu') ||
      text.includes('nhap ma') ||
      text.includes('giam toi da') ||
      text.includes('uu dai shop') ||
      text.includes('khuyen mai shop');

  const genericDiscountTitle =
      text.startsWith('giam ') ||
      text.includes('- giam ') ||
      text.includes(' giam ') ||
      text.includes('uu dai ') ||
      text.includes('khuyen mai ') ||
      text.includes('sale ') ||
      text.includes('flash sale');

  return Boolean((hasMerchantPrefix && genericDiscountTitle) || (mentionsStore && storeWideOffer));
}

function isVoucherText(title: string, description: string, rawSourceKind: string): boolean {
  const text = normalizeText([title, description, rawSourceKind].join(' '));

  if (!text) return false;

  return (
      text.includes('voucher') ||
      text.includes('coupon') ||
      text.includes('ma giam') ||
      text.includes('ma uu dai') ||
      text.includes('ma khuyen mai') ||
      text.includes('coupon code') ||
      text.includes('voucher code') ||
      text.includes('promo code') ||
      text.includes('nhap ma') ||
      text.includes('code giam')
  );
}

function isCampaignText(title: string, description: string, rawSourceKind: string): boolean {
  const text = normalizeText([title, description, rawSourceKind].join(' '));

  if (!text) return false;

  return (
      text.includes('campaign') ||
      text.includes('chien dich') ||
      text.includes('chuong trinh') ||
      text.includes('su kien') ||
      text.includes('mega sale') ||
      text.includes('brand day') ||
      text.includes('double day') ||
      text.includes('ngay hoi mua sam')
  );
}

// ---- Raw extraction helpers ----

function extractRawItems(data: unknown): AccessTradeRawItem[] {
  if (Array.isArray(data)) {
    return data.filter(isRawItem);
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as Record<string, unknown>;

  const candidates = [
    record.data,
    record.d,
    record.items,
    record.results,
    record.offers,
    record.products,
    record.vouchers,
    record.campaigns,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRawItem);
    }
  }

  if (record.data && typeof record.data === 'object') {
    const nested = record.data as Record<string, unknown>;
    const nestedCandidates = [
      nested.items,
      nested.results,
      nested.offers,
      nested.products,
      nested.vouchers,
      nested.campaigns,
    ];

    for (const candidate of nestedCandidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter(isRawItem);
      }
    }
  }

  return [];
}

function isRawItem(value: unknown): value is AccessTradeRawItem {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function dedupeRawItems(items: AccessTradeRawItem[]): AccessTradeRawItem[] {
  const seen = new Set<string>();
  const unique: AccessTradeRawItem[] = [];

  for (const item of items) {
    const key = getRawDedupeKey(item);

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function getRawDedupeKey(item: AccessTradeRawItem): string {
  return normalizeText(
      getFirstText(item, [
        'product_id',
        'productId',
        'sku',
        'skuId',
        'sku_id',
        'itemId',
        'item_id',
        'id',
        '_id',
        'sourceId',
        'source_id',
        'externalId',
        'external_id',
        'offerId',
        'offer_id',
        'aff_link',
        'affiliate_url',
        'affiliateUrl',
        'url',
        'link',
        'productUrl',
        'product_url',
        'name',
        'title',
      ]) || JSON.stringify(item).slice(0, 160),
  );
}

// ---- Generic helpers ----

function getFirstText(item: AccessTradeRawItem, keys: string[]): string {
  for (const key of keys) {
    const value = getPathValue(item, key);
    const text = stringifyValue(value);

    if (text) return text;
  }

  return '';
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

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = stringifyValue(entry);
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

function getItemId(item: AccessTradeRawItem): string {
  const officialId = getFirstText(item, [
    'product_id',
    'productId',
    'sku',
    'skuId',
    'sku_id',
    'itemId',
    'item_id',
    'id',
    '_id',
    'sourceId',
    'source_id',
    'externalId',
    'external_id',
    'campaignId',
    'campaign_id',
    'offerId',
    'offer_id',
  ]);

  if (officialId) return officialId;

  const fingerprint = normalizeText(
      [
        item.__sandealEndpoint,
        getFirstText(item, ['aff_link', 'affiliate_url', 'affiliateUrl']),
        getFirstText(item, ['productUrl', 'product_url', 'url', 'link']),
        getFirstText(item, ['productName', 'product_name', 'title', 'name']),
      ].join('|'),
  );

  return `accesstrade-${stableHash(fingerprint || JSON.stringify(item).slice(0, 500))}`;
}

function getRawSourceKind(item: AccessTradeRawItem): string {
  return (
      getFirstText(item, [
        '__sandealSourceKind',
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
        '__sandealEndpoint',
      ]) || 'unknown'
  ).toLowerCase();
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

function toAsciiSlug(value: string): string {
  return normalizeText(value)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
}

function parseNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

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

function parsePriceNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1000 ? Math.round(value) : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

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

  const kMatch = trimmed.match(/(\d+(?:[.,]\d+)?)\s?k\b/i);
  if (kMatch) {
    const parsedK = Number(kMatch[1].replace(',', '.')) * 1000;
    return Number.isFinite(parsedK) && parsedK >= 1000 ? Math.round(parsedK) : undefined;
  }

  // Prefer the first complete price token so ranges such as
  // "1.299.000 - 1.599.000" do not become one huge invalid number.
  const groupedPriceMatch = trimmed.match(/\d{1,3}(?:[.,]\d{3})+/);
  if (groupedPriceMatch) {
    const parsedGrouped = Number(groupedPriceMatch[0].replace(/[^\d]/g, ''));
    return Number.isFinite(parsedGrouped) && parsedGrouped >= 1000
        ? parsedGrouped
        : undefined;
  }

  const plainNumberMatch = trimmed.match(/\d{4,}/);
  if (plainNumberMatch) {
    const parsedPlain = Number(plainNumberMatch[0]);
    return Number.isFinite(parsedPlain) && parsedPlain >= 1000
        ? parsedPlain
        : undefined;
  }

  return undefined;
}

function isValidHttpUrl(value: unknown): boolean {
  const text = stringifyValue(value);

  if (!text) return false;

  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function matchesSearchQuery(haystackValue: string, queryValue: string): boolean {
  const haystack = normalizeText(haystackValue);
  const query = normalizeText(queryValue);

  if (!query) return true;
  if (haystack.includes(query)) return true;

  const tokens = query
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);

  if (!tokens.length) return false;

  return tokens.every((token) => haystack.includes(token));
}

function stableHash(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function resolveAccessTradeDomain(platform?: string): string | null {
  const value = normalizeText(platform);

  if (!value || value === 'all' || value === 'accesstrade') return null;

  if (value.includes('.')) return value;

  const domainMap: Record<string, string> = {
    lazada: 'lazada.vn',
    tiki: 'tiki.vn',
    shopee: 'shopee.vn',
    sendo: 'sendo.vn',
    fahasa: 'fahasa.com',
  };

  return domainMap[value] || null;
}

function resolveAccessTradeCampaign(platform?: string): string | null {
  const value = normalizeText(platform);

  if (!value || value === 'all' || value === 'accesstrade') return null;
  if (resolveAccessTradeDomain(platform)) return null;

  return value;
}

function sanitizeEndpointUrl(url: URL): string {
  const cloned = new URL(url.toString());

  for (const key of ['token', 'access_token', 'api_key', 'apikey', 'key']) {
    cloned.searchParams.delete(key);
  }

  return cloned.toString();
}

function getRawValueText(rawData: NormalizedAccessTradeItem['rawData'], key: string): string {
  if (!rawData || typeof rawData !== 'object') return '';

  const value = (rawData as Record<string, unknown>)[key];

  return stringifyValue(value);
}
