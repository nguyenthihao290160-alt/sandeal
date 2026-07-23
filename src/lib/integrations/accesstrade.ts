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
import { validateExternalUrl } from '../product-intelligence/urlSafety';

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

export type AccessTradeDiagnosticState =
  | 'RESULTS_RETURNED'
  | 'PROVIDER_EMPTY'
  | 'PROVIDER_DATA_REJECTED';

export type AccessTradeRejectionReason =
  | 'INVALID_RECORD'
  | 'EXTRACTION_FAILED'
  | 'NORMALIZATION_FAILED'
  | 'MISSING_IDENTITY'
  | 'MISSING_TITLE'
  | 'INVALID_URL'
  | 'UNSAFE_DESTINATION'
  | 'IMAGE_REQUIRED'
  | 'AFFILIATE_LINK_REQUIRED'
  | 'TYPE_MISMATCH'
  | 'KEYWORD_MISMATCH'
  | 'CATEGORY_MISMATCH'
  | 'PLATFORM_MISMATCH'
  | 'DUPLICATE'
  | 'RESULT_LIMIT'
  | 'UNSUPPORTED_CLASSIFICATION'
  | 'UNSAFE_PROVIDER_DATA';

export type AccessTradeReviewReason =
  | 'MISSING_NAME'
  | 'MISSING_CANONICAL_URL'
  | 'INVALID_CANONICAL_URL'
  | 'MISSING_AFFILIATE_URL'
  | 'INVALID_AFFILIATE_URL'
  | 'MISSING_IMAGE'
  | 'INVALID_IMAGE_URL'
  | 'INVALID_PRICE'
  | 'MISSING_PRICE';

export interface AccessTradeSearchDiagnostics {
  state: AccessTradeDiagnosticState;
  providerStatusCode?: number;
  providerResultType: AccessTradeResultType;
  providerReportedItemCount: number;
  rawItemCount: number;
  extractedItemCount: number;
  normalizedItemCount: number;
  classifiedProductCount: number;
  classifiedVoucherCount: number;
  classifiedCampaignCount: number;
  classifiedStoreOfferCount: number;
  classifiedUnknownCount: number;
  acceptedCount: number;
  returnedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  filteredCount: number;
  limitedCount: number;
  rejectedByReason: Partial<Record<AccessTradeRejectionReason, number>>;
  reviewByReason: Partial<Record<AccessTradeReviewReason, number>>;
}

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
  canonicalProductUrl?: string;
  canonicalUrlSource?: 'provider_api' | 'none';
  canonicalUrlProvider?: 'accesstrade';
  canonicalUrlSourceEndpoint?: 'datafeed' | 'offers';
  canonicalUrlSourceField?: string;
  canonicalUrlFetchedAt?: string;
  canonicalUrlStatus?: 'available' | 'unavailable';
  affiliateUrl: string;
  affiliateDestinationUrl?: string;
  affiliateUrlSource?: 'provider_api' | 'none';
  affiliateUrlProvider?: 'accesstrade';
  affiliateUrlSourceEndpoint?: 'datafeed' | 'offers';
  affiliateUrlSourceField?: string;
  affiliateUrlCampaignId?: string;
  affiliateUrlFetchedAt?: string;
  affiliateUrlStatus?: 'available' | 'unavailable';
  deepLinkSupported?: boolean;
  affiliateLinkReason?: string;
  price: number;
  salePrice: number;
  category: string;
  merchant?: string;
  commissionRate?: number;
  campaignName?: string;
  merchantDomain?: string;
  shopId?: string;
  shopName?: string;
  sku?: string;
  providerUpdatedAt?: string;
  discount?: number | string;
  discountAmount?: number | string;
  discountRate?: number | string;
  discountStatus?: number | string;
  sourceEndpoint?: 'datafeed' | 'offers';
  sourceItemId?: string;
  fetchedAt?: string;
  rawSourceKind: string;
  normalizationIssues?: AccessTradeReviewReason[];
  fieldProvenance?: NonNullable<Product['fieldProvenance']>;

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
    fetched: number;
    accepted: number;
    rejected: number;
    truncatedByLimit: number;
    rejectionCounters: AccessTradeRejectionCounters;
  };
  requests: AccessTradeRequestLog[];
  diagnostics: AccessTradeSearchDiagnostics;
}

export interface AccessTradeRejectionCounters {
  keywordMismatch: number;
  categoryMismatch: number;
  platformMismatch: number;
  kindMismatch: number;
  missingImage: number;
  missingAffiliateUrl: number;
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
  observedEnvelopeFields?: string[];
  observedItemFields?: string[];
  observedCanonicalUrlFields?: string[];
  observedAffiliateUrlFields?: string[];
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
  rawItemCount?: number;
  extractedItemCount?: number;
  providerReportedItemCount?: number;
  extractionRejectedByReason?: Partial<Record<AccessTradeRejectionReason, number>>;
  payloadObservation?: Pick<AccessTradeRequestLog,
    'observedEnvelopeFields' | 'observedItemFields' | 'observedCanonicalUrlFields' | 'observedAffiliateUrlFields'>;
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
    ...result.payloadObservation,
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
  shop_id?: string;
  shopId?: string;
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
  __sandealFetchedAt?: string;

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

  return buildAccessTradeSearchResult(successfulResults, fetchResults.map(toRequestLog), params, limit);
}

interface ProcessAccessTradePayloadOptions {
  endpoint?: AccessTradeEndpointKind;
  sourceKind?: string;
  statusCode?: number;
  fetchedAt?: string;
}

/**
 * Pure provider-payload entry point used by regression tests and diagnostics.
 * It deliberately performs no credential lookup and no provider request.
 */
export function processAccessTradePayload(
    payload: unknown,
    params: AccessTradeSearchParams = {},
    options: ProcessAccessTradePayloadOptions = {},
): AccessTradeSearchResult {
  const endpoint = options.endpoint || 'datafeed';
  const sourceKind = options.sourceKind || (endpoint === 'datafeed' ? 'product_feed' : 'offer_feed');
  const statusCode = options.statusCode ?? 200;
  const fetchedAt = options.fetchedAt || new Date(0).toISOString();
  const extraction = extractAccessTradePayload(payload);
  const observation = observeAccessTradePayload(payload, extraction.items);
  const items = extraction.items.map((item) => ({
    ...item,
    __sandealEndpoint: endpoint,
    __sandealSourceKind: sourceKind,
    __sandealFetchedAt: fetchedAt,
  }));
  const request: AccessTradeRequestLog = {
    endpoint,
    durationMs: 0,
    statusCode,
    resultType: extraction.rawItemCount > 0 ? 'success_with_results' : 'success_empty',
    itemCount: extraction.extractedItemCount,
    attempts: 1,
    ...observation,
  };
  const fetchResult: AccessTradeFetchResult = {
    endpoint,
    ok: true,
    items,
    status: statusCode,
    request,
    rawItemCount: extraction.rawItemCount,
    extractedItemCount: extraction.extractedItemCount,
    providerReportedItemCount: extraction.providerReportedItemCount,
    extractionRejectedByReason: extraction.rejectedByReason,
  };
  const limit = Math.min(Math.max(params.limit || 20, 1), 50);
  return buildAccessTradeSearchResult([fetchResult], [request], params, limit);
}

function buildAccessTradeSearchResult(
    successfulResults: AccessTradeFetchResult[],
    requests: AccessTradeRequestLog[],
    params: AccessTradeSearchParams,
    limit: number,
): AccessTradeSearchResult {
  const rejectedByReason: Partial<Record<AccessTradeRejectionReason, number>> = {};
  const reviewByReason: Partial<Record<AccessTradeReviewReason, number>> = {};
  const increment = <T extends string>(bucket: Partial<Record<T, number>>, reason: T, amount = 1) => {
    bucket[reason] = (bucket[reason] || 0) + amount;
  };

  for (const result of successfulResults) {
    for (const [reason, count] of Object.entries(result.extractionRejectedByReason || {})) {
      if (count) increment(rejectedByReason, reason as AccessTradeRejectionReason, count);
    }
  }

  const normalized: NormalizedAccessTradeItem[] = [];
  for (const rawItem of successfulResults.flatMap((result) => result.items)) {
    if (!hasStableCandidateIdentity(rawItem)) {
      increment(rejectedByReason, 'MISSING_IDENTITY');
      continue;
    }
    try {
      const item = normalizeAccessTradeItem(rawItem);
      normalized.push(item);
      for (const reason of item.normalizationIssues || []) increment(reviewByReason, reason);
    } catch {
      increment(rejectedByReason, 'NORMALIZATION_FAILED');
    }
  }

  const { items: uniqueItems, duplicateCount } = dedupeNormalizedItems(normalized);
  if (duplicateCount) increment(rejectedByReason, 'DUPLICATE', duplicateCount);

  const classifiedProductCount = uniqueItems.filter((item) => item.kind === 'product' || item.kind === 'deal').length;
  const classifiedVoucherCount = uniqueItems.filter((item) => item.kind === 'voucher').length;
  const classifiedCampaignCount = uniqueItems.filter((item) => item.kind === 'campaign').length;
  const classifiedStoreOfferCount = uniqueItems.filter((item) => item.kind === 'store_offer').length;
  const classifiedUnknownCount = uniqueItems.filter((item) => item.kind === 'unknown').length;

  let items = filterAccessTradeItems(uniqueItems, params, rejectedByReason);
  items = sortAccessTradeItems(items);
  const acceptedCount = items.length;
  const limitedCount = Math.max(0, items.length - limit);
  if (limitedCount) increment(rejectedByReason, 'RESULT_LIMIT', limitedCount);
  items = items.slice(0, limit);

  const products = items.filter((item) => item.kind === 'product' || item.kind === 'deal');
  const vouchers = items.filter((item) => item.kind === 'voucher');
  const campaigns = items.filter((item) => item.kind === 'campaign');
  const storeOffers = items.filter((item) => item.kind === 'store_offer');
  const unknown = items.filter((item) => item.kind === 'unknown');

  const publicEligibleProducts = products.filter((item) => item.autoPublishEligible).length;
  const publicCandidates = items.filter((item) => item.publicDecision === 'public_candidate').length;
  const needsReview = items.filter((item) => item.publicDecision === 'needs_review').length;
  const archived = items.filter((item) => item.publicDecision === 'archived').length;
  const rejectionCounters = toAccessTradeRejectionCounters(rejectedByReason);
  const fetched = successfulResults.reduce(
    (sum, result) => sum + (result.rawItemCount ?? result.items.length),
    0,
  );
  const rejected = Object.entries(rejectedByReason)
    .filter(([reason]) => reason !== 'RESULT_LIMIT')
    .reduce((sum, [, count]) => sum + (count || 0), 0);

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
      fetched,
      accepted: acceptedCount,
      rejected,
      truncatedByLimit: limitedCount,
      rejectionCounters,
    },
    requests,
    diagnostics: buildAccessTradeDiagnostics({
      successfulResults,
      requests,
      normalizedItemCount: normalized.length,
      classifiedProductCount,
      classifiedVoucherCount,
      classifiedCampaignCount,
      classifiedStoreOfferCount,
      classifiedUnknownCount,
      acceptedCount,
      returnedCount: items.length,
      duplicateCount,
      limitedCount,
      rejectedByReason,
      reviewByReason,
    }),
  };
}

function buildAccessTradeDiagnostics(input: {
  successfulResults: AccessTradeFetchResult[];
  requests: AccessTradeRequestLog[];
  normalizedItemCount: number;
  classifiedProductCount: number;
  classifiedVoucherCount: number;
  classifiedCampaignCount: number;
  classifiedStoreOfferCount: number;
  classifiedUnknownCount: number;
  acceptedCount: number;
  returnedCount: number;
  duplicateCount: number;
  limitedCount: number;
  rejectedByReason: Partial<Record<AccessTradeRejectionReason, number>>;
  reviewByReason: Partial<Record<AccessTradeReviewReason, number>>;
}): AccessTradeSearchDiagnostics {
  const rawItemCount = input.successfulResults.reduce(
      (sum, result) => sum + (result.rawItemCount ?? result.items.length),
      0,
  );
  const extractedItemCount = input.successfulResults.reduce(
      (sum, result) => sum + (result.extractedItemCount ?? result.items.length),
      0,
  );
  const providerReportedItemCount = input.successfulResults.reduce(
      (sum, result) => sum + (result.providerReportedItemCount ?? result.request?.itemCount ?? result.items.length),
      0,
  );
  // A response limit is not a rejected provider record: it remains observable
  // through limitedCount without inflating parser/filter rejection totals.
  const rejectedCount = Object.entries(input.rejectedByReason)
      .filter(([reason]) => reason !== 'RESULT_LIMIT')
      .reduce((sum, [, value]) => sum + (value || 0), 0);
  const filteredCount = [
    'KEYWORD_MISMATCH',
    'CATEGORY_MISMATCH',
    'PLATFORM_MISMATCH',
    'TYPE_MISMATCH',
    'MISSING_TITLE',
    'INVALID_URL',
    'UNSAFE_DESTINATION',
    'IMAGE_REQUIRED',
    'AFFILIATE_LINK_REQUIRED',
  ].reduce((sum, reason) => sum + (input.rejectedByReason[reason as AccessTradeRejectionReason] || 0), 0);
  const providerRequest = input.requests.find((request) => request.statusCode && request.statusCode >= 200 && request.statusCode < 300)
    || input.requests[0];
  const providerHasData = providerReportedItemCount > 0 || rawItemCount > 0 || extractedItemCount > 0;

  return {
    state: input.returnedCount > 0
      ? 'RESULTS_RETURNED'
      : providerHasData
        ? 'PROVIDER_DATA_REJECTED'
        : 'PROVIDER_EMPTY',
    providerStatusCode: providerRequest?.statusCode,
    providerResultType: providerRequest?.resultType || (providerHasData ? 'success_with_results' : 'success_empty'),
    providerReportedItemCount,
    rawItemCount,
    extractedItemCount,
    normalizedItemCount: input.normalizedItemCount,
    classifiedProductCount: input.classifiedProductCount,
    classifiedVoucherCount: input.classifiedVoucherCount,
    classifiedCampaignCount: input.classifiedCampaignCount,
    classifiedStoreOfferCount: input.classifiedStoreOfferCount,
    classifiedUnknownCount: input.classifiedUnknownCount,
    acceptedCount: input.acceptedCount,
    returnedCount: input.returnedCount,
    rejectedCount,
    duplicateCount: input.duplicateCount,
    filteredCount,
    limitedCount: input.limitedCount,
    rejectedByReason: input.rejectedByReason,
    reviewByReason: input.reviewByReason,
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

  const imageFields = [
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
  ] as const;
  const rawImageUrl = getFirstText(item, imageFields);
  const imageSourceField = imageFields.find((field) => Boolean(getFirstText(item, [field])));
  const imageUrl = normalizeAccessTradeImageUrl(rawImageUrl);

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
    const normalized = normalizeAccessTradeImageUrl(val);
    if (normalized && !imageCandidates.includes(normalized)) {
      imageCandidates.push(normalized);
    }
  }
  // Also extract from arrays like gallery/images if present
  const galleryField = (item as Record<string, unknown>).gallery;
  if (Array.isArray(galleryField)) {
    for (const entry of galleryField) {
      const entryUrl = typeof entry === 'string' ? entry.trim() : (typeof entry === 'object' && entry ? String((entry as Record<string, unknown>).url ?? '') : '');
      const normalized = normalizeAccessTradeImageUrl(entryUrl);
      if (normalized && !imageCandidates.includes(normalized)) {
        imageCandidates.push(normalized);
      }
    }
  }

  const canonicalResolution = resolveAccessTradeCanonicalProductUrl(item);
  const originalUrl = canonicalResolution.canonicalProductUrl;
  const affiliateResolution = resolveAccessTradeAffiliateUrl(item);
  const affiliateUrl = affiliateResolution.affiliateUrl;
  const affiliateDestinationUrl = extractAccessTradeAffiliateDestination(affiliateUrl);
  const rawCanonicalUrl = getFirstText(item, ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS);
  const rawAffiliateUrl = getFirstText(item, ACCESS_TRADE_AFFILIATE_URL_FIELDS);

  const category = getFirstText(item, [
    'cate',
    'category',
    'categoryName',
    'category_name',
    'cat_name',
    'vertical',
    'industry',
  ]);

  const merchant = getFirstText(item, [
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

  const campaignName = getFirstText(item, [
    'campaign_name',
    'campaignName',
    'campaign',
    'campaign_name_text',
  ]);

  const shopId = getFirstText(item, ['shop_id', 'shopId']);
  const shopName = getFirstText(item, ['shop_name', 'shopName', 'shop']);
  const sku = getFirstText(item, ['sku', 'skuId', 'sku_id']);
  const providerUpdatedAt = getFirstText(item, ['update_time', 'updated_at']);

  const priceFields = [
    'price', 'currentPrice', 'current_price', 'originalPrice', 'original_price',
    'listPrice', 'list_price', 'oldPrice', 'old_price', 'marketPrice', 'market_price',
  ] as const;
  const salePriceFields = [
    'salePrice', 'sale_price', 'discountedPrice', 'discounted_price',
    'discount_price', 'discountPrice', 'discount', 'currentPrice', 'current_price',
  ] as const;
  const rawPriceValue = getFirstText(item, priceFields);
  const rawSalePriceValue = getFirstText(item, salePriceFields);
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
  const priceSourceField = priceFields.find((field) => Boolean(parsePriceNumber(item[field])));

  const salePrice =
      parsePriceNumber(item.salePrice) ||
      parsePriceNumber(item.sale_price) ||
      parsePriceNumber(item.discountedPrice) ||
      parsePriceNumber(item.discounted_price) ||
      parsePriceNumber(item.discount_price) ||
      parsePriceNumber(item.discountPrice) ||
      parsePriceNumber(item.discount) ||
      parsePriceNumber(item.currentPrice) ||
      parsePriceNumber(item.current_price) ||
      0;
  const salePriceSourceField = salePriceFields.find((field) => Boolean(parsePriceNumber(item[field])));

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

  const normalizationIssues: AccessTradeReviewReason[] = [];
  if (!name) normalizationIssues.push('MISSING_NAME');
  if (!rawCanonicalUrl) normalizationIssues.push('MISSING_CANONICAL_URL');
  else if (!originalUrl) normalizationIssues.push('INVALID_CANONICAL_URL');
  if (!rawAffiliateUrl) normalizationIssues.push('MISSING_AFFILIATE_URL');
  else if (!affiliateUrl) normalizationIssues.push('INVALID_AFFILIATE_URL');
  if (!rawImageUrl) normalizationIssues.push('MISSING_IMAGE');
  else if (!imageUrl) normalizationIssues.push('INVALID_IMAGE_URL');
  if (!price && !salePrice) {
    normalizationIssues.push(rawPriceValue || rawSalePriceValue ? 'INVALID_PRICE' : 'MISSING_PRICE');
  }

  const fetchedAt = item.__sandealFetchedAt;
  const fieldProvenance: NonNullable<Product['fieldProvenance']> = {
    title: {
      value: name || undefined,
      source: 'accesstrade',
      sourceField: ['productName', 'product_name', 'title', 'name'].find((field) => Boolean(getFirstText(item, [field]))),
      provider: 'accesstrade', endpoint: item.__sandealEndpoint, fetchedAt,
      verificationStatus: name ? 'UNVERIFIED' : 'MISSING',
    },
    canonicalProductUrl: {
      value: originalUrl || rawCanonicalUrl || undefined,
      source: 'accesstrade', sourceField: canonicalResolution.field,
      provider: 'accesstrade', endpoint: item.__sandealEndpoint, fetchedAt,
      canonicalizedAt: originalUrl ? fetchedAt : undefined,
      verificationStatus: originalUrl ? 'UNVERIFIED' : rawCanonicalUrl ? 'INVALID' : 'MISSING',
      verificationReason: canonicalResolution.reason,
    },
    affiliateUrl: {
      value: affiliateUrl || rawAffiliateUrl || undefined,
      source: 'accesstrade', sourceField: affiliateResolution.field,
      provider: 'accesstrade', endpoint: item.__sandealEndpoint, fetchedAt,
      canonicalizedAt: affiliateUrl ? fetchedAt : undefined,
      verificationStatus: affiliateUrl ? 'UNVERIFIED' : rawAffiliateUrl ? 'INVALID' : 'MISSING',
      verificationReason: affiliateResolution.reason,
    },
    imageUrl: {
      value: imageUrl || rawImageUrl || undefined,
      source: 'accesstrade', sourceField: imageSourceField,
      provider: 'accesstrade', endpoint: item.__sandealEndpoint, fetchedAt,
      canonicalizedAt: imageUrl ? fetchedAt : undefined,
      verificationStatus: imageUrl ? 'UNVERIFIED' : rawImageUrl ? 'INVALID' : 'MISSING',
    },
    price: {
      value: salePrice || price || rawSalePriceValue || rawPriceValue || undefined,
      source: 'accesstrade',
      sourceField: salePriceSourceField || priceSourceField
        || salePriceFields.find((field) => Boolean(getFirstText(item, [field])))
        || priceFields.find((field) => Boolean(getFirstText(item, [field]))),
      provider: 'accesstrade', endpoint: item.__sandealEndpoint, fetchedAt,
      canonicalizedAt: salePrice || price ? fetchedAt : undefined,
      verificationStatus: salePrice || price ? 'UNVERIFIED' : rawSalePriceValue || rawPriceValue ? 'INVALID' : 'MISSING',
      verificationReason: salePrice || price ? undefined : rawSalePriceValue || rawPriceValue ? 'PRICE_FORMAT_INVALID' : 'PRICE_MISSING',
    },
  };

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
    canonicalProductUrl: originalUrl || undefined,
    canonicalUrlSource: canonicalResolution.source,
    canonicalUrlProvider: originalUrl ? 'accesstrade' : undefined,
    canonicalUrlSourceEndpoint: item.__sandealEndpoint,
    canonicalUrlSourceField: canonicalResolution.field,
    canonicalUrlFetchedAt: item.__sandealFetchedAt,
    canonicalUrlStatus: canonicalResolution.status,
    affiliateUrl,
    affiliateDestinationUrl,
    affiliateUrlSource: affiliateResolution.source,
    affiliateUrlProvider: affiliateUrl ? 'accesstrade' : undefined,
    affiliateUrlSourceEndpoint: item.__sandealEndpoint,
    affiliateUrlSourceField: affiliateResolution.field,
    affiliateUrlCampaignId: getFirstText(item, ['campaign_id', 'campaignId']) || undefined,
    affiliateUrlFetchedAt: item.__sandealFetchedAt,
    affiliateUrlStatus: affiliateResolution.status,
    deepLinkSupported: affiliateResolution.deepLinkSupported,
    affiliateLinkReason: affiliateResolution.reason,
    price,
    salePrice,
    category,
    merchant: merchant || undefined,
    commissionRate: commissionRate || undefined,
    campaignName: campaignName || undefined,
    merchantDomain: normalizeMerchantDomain(getFirstText(item, ['domain']))
      || safeHostname(originalUrl || affiliateDestinationUrl),
    shopId: shopId || undefined,
    shopName: shopName || undefined,
    sku: sku || undefined,
    providerUpdatedAt: providerUpdatedAt || undefined,
    discount: sanitizeScalar(item.discount),
    discountAmount: sanitizeScalar(item.discount_amount),
    discountRate: sanitizeScalar(item.discount_rate),
    discountStatus: sanitizeScalar(item.status_discount),
    sourceEndpoint: item.__sandealEndpoint,
    sourceItemId: getItemId(item),
    fetchedAt: item.__sandealFetchedAt,
    rawSourceKind,
    normalizationIssues,
    fieldProvenance,
    needsVerification,
    verifiedSource,
    publicHidden,
    autoPublishEligible,
    publicDecision,
    publicBlockReason,
    nonProductReason,
    qualityScore,
    rawData: sanitizeAccessTradeRawMetadata(item),
  };
}

/**
 * Only accepts a tracking/deep-link URL returned explicitly by AccessTrade.
 * It intentionally never synthesizes a go.isclix.com/deep_link URL from a
 * campaign id and product URL.
 */
export const ACCESS_TRADE_AFFILIATE_URL_FIELDS = [
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
] as const;

export const ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS = [
  'url',
  'link',
  'product_url',
  'productUrl',
  'final_url',
  'finalUrl',
  'original_url',
  'originalUrl',
  'landing_page',
  'landingPage',
  'merchant_url',
  'merchantUrl',
] as const;

const ACCESS_TRADE_TRACKING_HOSTS = new Set([
  'go.isclix.com',
  'accesstrade.vn',
  'pub.accesstrade.vn',
  'click.accesstrade.vn',
]);

export function isAccessTradeTrackingUrl(value: unknown): boolean {
  const text = stringifyValue(value);
  if (!isValidHttpUrl(text)) return false;
  const hostname = new URL(text).hostname.toLowerCase().replace(/\.$/, '');
  return [...ACCESS_TRADE_TRACKING_HOSTS].some(host => hostname === host || hostname.endsWith(`.${host}`));
}

export function normalizeAccessTradeImageUrl(value: unknown): string {
  const text = stringifyValue(value);
  if (!isValidHttpUrl(text)) return '';
  // Preserve provider evidence exactly. The UI refuses insecure remote images
  // and health checks decide whether an explicit HTTP source is usable; an
  // arbitrary host must never be silently rewritten to HTTPS.
  return new URL(text).href;
}

function safeHostname(value: unknown): string | undefined {
  const text = stringifyValue(value);
  if (!isValidHttpUrl(text)) return undefined;
  return new URL(text).hostname.toLowerCase().replace(/\.$/, '') || undefined;
}

/**
 * URLSearchParams decodes one layer. Deliberately do not call decodeURIComponent
 * again: nested merchant query strings and Unicode must remain byte-stable.
 */
export function extractAccessTradeAffiliateDestination(value: unknown): string | undefined {
  const text = stringifyValue(value);
  if (!isAccessTradeTrackingUrl(text)) return undefined;
  const tracking = new URL(text);
  for (const key of ['url', 'redirect_url', 'redirect', 'target', 'destination', 'deeplink']) {
    const candidate = tracking.searchParams.get(key)?.trim();
    if (!candidate || !isValidHttpUrl(candidate) || isAccessTradeTrackingUrl(candidate)) continue;
    return new URL(candidate).href;
  }
  return undefined;
}

function firstProviderUrl(
    item: AccessTradeRawItem,
    fields: readonly string[],
    accept: (value: string) => boolean = () => true,
): { url: string; field?: string } {
  for (const field of fields) {
    const value = getFirstText(item, [field]);
    if (value && isValidHttpUrl(value) && accept(value)) return { url: new URL(value).href, field };
  }
  return { url: '' };
}

/** Canonical merchant URLs must come from a provider product/landing field. */
export function resolveAccessTradeCanonicalProductUrl(
    item: Record<string, unknown>,
): { canonicalProductUrl: string; source: 'provider_api' | 'none'; status: 'available' | 'unavailable'; field?: string; reason?: string } {
  const affiliateValues = new Set(ACCESS_TRADE_AFFILIATE_URL_FIELDS
    .map(field => getFirstText(item as AccessTradeRawItem, [field]))
    .filter(isValidHttpUrl)
    .map(value => new URL(value).href));
  const resolved = firstProviderUrl(
      item as AccessTradeRawItem,
      ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS,
      value => !isAccessTradeTrackingUrl(value) && !affiliateValues.has(new URL(value).href),
  );
  if (resolved.url) return {
    canonicalProductUrl: resolved.url,
    source: 'provider_api',
    status: 'available',
    field: resolved.field,
  };
  return {
    canonicalProductUrl: '',
    source: 'none',
    status: 'unavailable',
    reason: 'provider_canonical_product_url_unavailable',
  };
}

export function resolveAccessTradeAffiliateUrl(
    item: Record<string, unknown>,
): { affiliateUrl: string; source: 'provider_api' | 'none'; status: 'available' | 'unavailable'; deepLinkSupported?: boolean; field?: string; reason?: string } {
  const resolved = firstProviderUrl(item as AccessTradeRawItem, ACCESS_TRADE_AFFILIATE_URL_FIELDS);
  if (resolved.url) {
    return {
      affiliateUrl: resolved.url,
      source: 'provider_api',
      status: 'available',
      field: resolved.field,
      // A provider-supplied tracking URL is authoritative for this product,
      // but it does not prove that the campaign supports arbitrary deep links.
      // Keep that capability unknown unless the returned field/path says so.
      deepLinkSupported: /deep/i.test(resolved.field || '') || /\/deep[_-]?link(?:\/|$)/i.test(new URL(resolved.url).pathname)
        ? true
        : undefined,
    };
  }
  return {
    affiliateUrl: '',
    source: 'none',
    status: 'unavailable',
    deepLinkSupported: false,
    reason: 'provider_deeplink_not_supported',
  };
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
  const normalizationIssues = new Set(item.normalizationIssues || []);

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

    originalUrl: item.canonicalProductUrl || item.originalUrl || undefined,
    canonicalProductUrl: item.canonicalProductUrl || item.originalUrl || undefined,
    canonicalUrlSource: item.canonicalUrlSource,
    canonicalUrlProvider: item.canonicalUrlProvider,
    canonicalUrlSourceEndpoint: item.canonicalUrlSourceEndpoint,
    canonicalUrlSourceField: item.canonicalUrlSourceField,
    canonicalUrlFetchedAt: item.canonicalUrlFetchedAt,
    canonicalUrlStatus: item.canonicalUrlStatus === 'available'
      ? 'unverified'
      : normalizationIssues.has('INVALID_CANONICAL_URL') ? 'invalid' : 'unavailable',
    affiliateUrl: item.affiliateUrl || undefined,
    affiliateDestinationUrl: item.affiliateDestinationUrl,
    affiliateUrlSource: item.affiliateUrlSource,
    affiliateUrlProvider: item.affiliateUrlProvider,
    affiliateUrlSourceEndpoint: item.affiliateUrlSourceEndpoint,
    affiliateUrlSourceField: item.affiliateUrlSourceField,
    affiliateUrlCampaignId: item.affiliateUrlCampaignId,
    affiliateUrlFetchedAt: item.affiliateUrlFetchedAt,
    affiliateUrlStatus: item.affiliateUrlStatus === 'available'
      ? 'unverified'
      : normalizationIssues.has('INVALID_AFFILIATE_URL') ? 'invalid' : 'unavailable',
    deepLinkSupported: item.deepLinkSupported,
    affiliateLinkReason: item.affiliateLinkReason,
    url: item.canonicalProductUrl || item.originalUrl || undefined,

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
    sourceItemId: item.sourceItemId,
    sourceEndpoint: item.sourceEndpoint,
    sourceFetchedAt: item.fetchedAt,
    merchant: item.merchant,
    merchantDomain: item.merchantDomain,
    shopId: item.shopId,
    shopName: item.shopName,
    sku: item.sku,
    providerUpdatedAt: item.providerUpdatedAt,
    sourceNormalizationIssues: item.normalizationIssues || [],

    verifiedSource: item.verifiedSource,
    sourceVerified: item.verifiedSource,

    // Always keep imported records hidden at the integration boundary.
    // SourceScout is the only layer allowed to unhide after strict health checks.
    publicHidden: true,
    publicBlocked: true,
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
    priceVerificationStatus: item.price || item.salePrice
      ? 'UNVERIFIED'
      : normalizationIssues.has('INVALID_PRICE') ? 'INVALID' : 'MISSING',
    priceObservedAt: item.fetchedAt,

    fieldProvenance: item.fieldProvenance,

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
  const pageSize = params.keyword ? 200 : limit;
  const targetMatches = Math.min(Math.max(params.limit || 20, 1), 50);
  const maxPages = params.keyword ? 5 : 1;
  const combined: AccessTradeFetchResult[] = [];

  const domain = resolveAccessTradeDomain(params.platform);
  const campaign = resolveAccessTradeCampaign(params.platform);
  let matchingRecordCount = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL('https://api.accesstrade.vn/v1/datafeeds');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('page', String(page));
    if (domain) url.searchParams.set('domain', domain);
    else if (campaign) url.searchParams.set('campaign', campaign);
    if (params.category) url.searchParams.set('cate', toAsciiSlug(params.category));

    // The official datafeeds contract has no keyword query parameter. Search
    // is performed locally over bounded pages so an ignored provider parameter
    // cannot silently turn the first page into a false empty result.
    const result = await fetchAccessTradeEndpoint(apiKey, url, 'datafeed', 'product_feed');
    combined.push(result);
    if (!result.ok) break;

    matchingRecordCount += result.items.filter((item) => rawAccessTradeRecordMatchesKeyword(item, params.keyword)).length;
    const pageItemCount = result.rawItemCount ?? result.items.length;
    const reportedTotal = result.providerReportedItemCount ?? pageItemCount;
    if (!params.keyword || matchingRecordCount >= targetMatches || pageItemCount < pageSize || page * pageSize >= reportedTotal) break;
  }

  const successful = combined.filter((result) => result.ok);
  if (!successful.length) return combined[0];

  const items = successful.flatMap((result) => result.items);
  const observedEnvelopeFields = mergeObservedFields(successful, 'observedEnvelopeFields');
  const observedItemFields = mergeObservedFields(successful, 'observedItemFields');
  const observedCanonicalUrlFields = mergeObservedFields(successful, 'observedCanonicalUrlFields');
  const observedAffiliateUrlFields = mergeObservedFields(successful, 'observedAffiliateUrlFields');
  const durationMs = successful.reduce((sum, result) => sum + (result.request?.durationMs || 0), 0);
  const status = successful.at(-1)?.status;
  const rawItemCount = successful.reduce((sum, result) => sum + (result.rawItemCount ?? result.items.length), 0);
  const extractedItemCount = successful.reduce((sum, result) => sum + (result.extractedItemCount ?? result.items.length), 0);
  const providerReportedItemCount = Math.max(...successful.map((result) => result.providerReportedItemCount ?? 0), rawItemCount);
  const extractionRejectedByReason: Partial<Record<AccessTradeRejectionReason, number>> = {};
  for (const result of successful) {
    for (const [reason, count] of Object.entries(result.extractionRejectedByReason || {})) {
      extractionRejectedByReason[reason as AccessTradeRejectionReason] =
        (extractionRejectedByReason[reason as AccessTradeRejectionReason] || 0) + (count || 0);
    }
  }
  const request: AccessTradeRequestLog = {
    endpoint: 'datafeed',
    durationMs,
    statusCode: status,
    resultType: items.length ? 'success_with_results' : 'success_empty',
    itemCount: extractedItemCount,
    attempts: successful.reduce((sum, result) => sum + (result.attempts || result.request?.attempts || 1), 0),
    observedEnvelopeFields,
    observedItemFields,
    observedCanonicalUrlFields,
    observedAffiliateUrlFields,
  };
  return {
    endpoint: 'datafeed', ok: true, items, status, request,
    attempts: request.attempts, rawItemCount, extractedItemCount,
    providerReportedItemCount, extractionRejectedByReason,
    payloadObservation: { observedEnvelopeFields, observedItemFields, observedCanonicalUrlFields, observedAffiliateUrlFields },
  };
}

function mergeObservedFields(
    results: AccessTradeFetchResult[],
    key: 'observedEnvelopeFields' | 'observedItemFields' | 'observedCanonicalUrlFields' | 'observedAffiliateUrlFields',
): string[] {
  return [...new Set(results.flatMap((result) => result.payloadObservation?.[key] || result.request?.[key] || []))]
    .sort()
    .slice(0, key === 'observedItemFields' ? 120 : 80);
}

function rawAccessTradeRecordMatchesKeyword(item: AccessTradeRawItem, keyword?: string): boolean {
  if (!normalizeText(keyword)) return true;
  const searchableFields = [
    'title', 'name', 'product_name', 'productName',
    'description', 'desc', 'short_description', 'shortDescription',
    'category', 'cate', 'category_name', 'categoryName', 'cat_name',
    'merchant', 'merchant_name', 'merchantName', 'shop', 'shop_name', 'shopName', 'domain',
  ];
  return matchesSearchQuery(searchableFields.map((field) => getFirstText(item, [field])).join(' '), keyword || '');
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

    const fetchedAt = new Date().toISOString();
    const extraction = extractAccessTradePayload(data);
    const payloadObservation = observeAccessTradePayload(data, extraction.items);
    const items = extraction.items.map((rawItem) => ({
      ...rawItem,
      __sandealEndpoint: endpoint,
      __sandealSourceKind: sourceKind,
      __sandealEndpointUrl: sanitizeEndpointUrl(url),
      __sandealFetchedAt: fetchedAt,
    }));
    await recordDomainHealth(url.toString(), 'ok');

    return {
      endpoint,
      ok: true,
      items,
      status: response.status,
      attempts: attempt + 1,
      payloadObservation,
      request: {
        endpoint,
        durationMs: Date.now() - startedAt,
        statusCode: response.status,
        resultType: extraction.rawItemCount > 0 ? 'success_with_results' : 'success_empty',
        itemCount: extraction.extractedItemCount,
        attempts: attempt + 1,
        ...payloadObservation,
      },
      rawItemCount: extraction.rawItemCount,
      extractedItemCount: extraction.extractedItemCount,
      providerReportedItemCount: extraction.providerReportedItemCount,
      extractionRejectedByReason: extraction.rejectedByReason,
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

function filterAccessTradeItems(
    items: NormalizedAccessTradeItem[],
    params: AccessTradeSearchParams,
    rejectedByReason: Partial<Record<AccessTradeRejectionReason, number>>,
): NormalizedAccessTradeItem[] {
  const keyword = normalizeText(params.keyword);
  const category = normalizeText(params.category);
  const platform = normalizeText(params.platform);
  const accepted: NormalizedAccessTradeItem[] = [];

  for (const item of items) {
    const reason = getAccessTradeFilterRejection(item, { ...params, keyword, category, platform });
    if (!reason) {
      accepted.push(item);
      continue;
    }
    rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
  }

  return accepted;
}

function getAccessTradeFilterRejection(
    item: NormalizedAccessTradeItem,
    params: AccessTradeSearchParams & { keyword: string; category: string; platform: string },
): AccessTradeRejectionReason | null {
  if (!item.name.trim()) return 'MISSING_TITLE';

  const rawUrls = [
    ...ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS,
    ...ACCESS_TRADE_AFFILIATE_URL_FIELDS,
    'image', 'image_url', 'imageUrl', 'productImage', 'product_image',
    'thumbnail', 'thumbnail_url', 'thumbnailUrl',
  ].map((field) => getRawValueText(item.rawData, field)).filter(Boolean);
  for (const value of rawUrls) {
    const safety = validateExternalUrl(value);
    if (safety.safe) continue;
    if (safety.code === 'PRIVATE_NETWORK' || safety.code === 'CREDENTIALS_NOT_ALLOWED' || safety.code === 'UNSAFE_PORT') {
      return 'UNSAFE_DESTINATION';
    }
    return 'INVALID_URL';
  }

  if (params.kind && params.kind !== 'all') {
    const matchesKind = params.kind === 'product'
      ? item.kind === 'product' || item.kind === 'deal'
      : item.kind === params.kind;
    if (!matchesKind) return 'TYPE_MISMATCH';
  }

  if (params.keyword) {
    const haystack = [
      item.name,
      item.description,
      item.category,
      item.merchant,
      item.shopName,
      item.merchantDomain,
      item.campaignName,
      getRawValueText(item.rawData, 'title'),
      getRawValueText(item.rawData, 'name'),
      getRawValueText(item.rawData, 'product_name'),
      getRawValueText(item.rawData, 'productName'),
      getRawValueText(item.rawData, 'description'),
      getRawValueText(item.rawData, 'desc'),
      getRawValueText(item.rawData, 'category'),
      getRawValueText(item.rawData, 'cate'),
      getRawValueText(item.rawData, 'category_name'),
      getRawValueText(item.rawData, 'merchant'),
      getRawValueText(item.rawData, 'merchant_name'),
      getRawValueText(item.rawData, 'shop'),
      getRawValueText(item.rawData, 'shop_name'),
      getRawValueText(item.rawData, 'domain'),
    ].join(' ');
    if (!matchesSearchQuery(haystack, params.keyword)) return 'KEYWORD_MISMATCH';
  }

  if (params.category) {
    const haystack = [item.category, item.name, item.description].join(' ');
    if (!matchesSearchQuery(haystack, params.category)) return 'CATEGORY_MISMATCH';
  }

  if (params.platform && params.platform !== 'all' && params.platform !== 'accesstrade') {
    const haystack = normalizeText([
      item.platform,
      item.campaignName,
      item.merchant,
      item.shopName,
      item.merchantDomain,
      item.originalUrl,
      item.affiliateUrl,
    ].join(' '));
    if (!haystack.includes(params.platform) && !haystack.includes(params.platform.replace(/\s+/g, ''))) {
      return 'PLATFORM_MISMATCH';
    }
  }

  if (params.imageOnly && !item.imageUrl) return 'IMAGE_REQUIRED';
  if (params.affiliateLinkOnly && !item.affiliateUrl) return 'AFFILIATE_LINK_REQUIRED';

  return null;
}

function toAccessTradeRejectionCounters(
    rejectedByReason: Partial<Record<AccessTradeRejectionReason, number>>,
): AccessTradeRejectionCounters {
  return {
    keywordMismatch: rejectedByReason.KEYWORD_MISMATCH || 0,
    categoryMismatch: rejectedByReason.CATEGORY_MISMATCH || 0,
    platformMismatch: rejectedByReason.PLATFORM_MISMATCH || 0,
    kindMismatch: rejectedByReason.TYPE_MISMATCH || 0,
    missingImage: rejectedByReason.IMAGE_REQUIRED || 0,
    missingAffiliateUrl: rejectedByReason.AFFILIATE_LINK_REQUIRED || 0,
  };
}

export function applyAccessTradeFiltersWithDiagnostics(
    items: NormalizedAccessTradeItem[],
    params: AccessTradeSearchParams,
): { items: NormalizedAccessTradeItem[]; rejectionCounters: AccessTradeRejectionCounters } {
  const rejectedByReason: Partial<Record<AccessTradeRejectionReason, number>> = {};
  return {
    items: filterAccessTradeItems(items, params, rejectedByReason),
    rejectionCounters: toAccessTradeRejectionCounters(rejectedByReason),
  };
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
  const hasName = Boolean(getFirstText(item, ['productName', 'product_name', 'title', 'name']));
  // A malformed URL is still useful source evidence. URL validity affects the
  // review snapshot, not whether a provider datafeed row silently disappears.
  const hasProviderProductUrl = Boolean(getFirstText(item, ['url', 'link', 'productUrl', 'product_url']));
  const hasProviderProductPrice = Boolean(
      parsePriceNumber(item.price) ||
      parsePriceNumber(item.sale_price) ||
      parsePriceNumber(item.salePrice) ||
      parsePriceNumber(item.discountedPrice) ||
      parsePriceNumber(item.discounted_price) ||
      parsePriceNumber(item.currentPrice) ||
      parsePriceNumber(item.current_price),
  );

  return Boolean(
      (hasOfficialProductId && (hasName || hasProviderProductUrl || hasProviderProductPrice)) ||
      (hasName && (hasProviderProductUrl || hasProviderProductPrice)),
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
  hasSecureImage: boolean;
  hasUrl: boolean;
  hasAffiliateUrl: boolean;
  hasPrice: boolean;
}

function getProductCompleteness(input: ProductCompletenessInput): ProductCompleteness {
  const hasImage = isValidHttpUrl(input.imageUrl);
  return {
    hasTitle: Boolean(input.name && input.name.trim().length >= 5),
    hasImage,
    hasSecureImage: hasImage && new URL(input.imageUrl).protocol === 'https:',
    hasUrl: isValidHttpUrl(input.originalUrl),
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
  if ((input.kind === 'product' || input.kind === 'deal') && !input.completeness.hasAffiliateUrl) {
    return 'Provider did not return a valid affiliate/tracking URL.';
  }
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
  if (!input.completeness.hasSecureImage) return 'Ảnh nguồn dùng HTTP nên chỉ được giữ làm bằng chứng; cần URL HTTPS đã kiểm tra trước khi public.';
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
      hasDatafeedProductSignals(item) &&
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

export function observeAccessTradePayload(
    data: unknown,
    suppliedItems?: Array<Record<string, unknown>>,
): Pick<AccessTradeRequestLog,
  'observedEnvelopeFields' | 'observedItemFields' | 'observedCanonicalUrlFields' | 'observedAffiliateUrlFields'> {
  const envelope = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data as Record<string, unknown>).sort().slice(0, 80)
    : [];
  const items = suppliedItems || extractAccessTradePayload(data).items;
  const fields = [...new Set(items.slice(0, 25).flatMap(item => Object.keys(item)))].sort().slice(0, 120);
  const present = (allowlist: readonly string[]) => allowlist.filter(field => fields.includes(field));
  return {
    observedEnvelopeFields: envelope,
    observedItemFields: fields,
    observedCanonicalUrlFields: present(ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS),
    observedAffiliateUrlFields: present(ACCESS_TRADE_AFFILIATE_URL_FIELDS),
  };
}

interface AccessTradePayloadExtraction {
  items: AccessTradeRawItem[];
  rawItemCount: number;
  extractedItemCount: number;
  providerReportedItemCount: number;
  rejectedByReason: Partial<Record<AccessTradeRejectionReason, number>>;
}

const ACCESS_TRADE_ITEM_ARRAY_KEYS = [
  'data',
  'd',
  'items',
  'results',
  'offers',
  'products',
  'vouchers',
  'campaigns',
] as const;

const ACCESS_TRADE_WRAPPER_KEYS = [
  'data',
  'd',
  'payload',
  'response',
  'result',
  'body',
] as const;

/**
 * Extract only through a small allowlist of provider envelope keys. This
 * supports historical wrappers and data.data without recursively accepting an
 * arbitrary array hidden elsewhere in a response.
 */
export function extractAccessTradePayload(data: unknown): AccessTradePayloadExtraction {
  const array = findKnownAccessTradeItemArray(data, 0);
  const providerReportedItemCount = findProviderReportedItemCount(data, 0)
    ?? (array ? array.length : 0);

  if (!array) {
    return {
      items: [],
      rawItemCount: 0,
      extractedItemCount: 0,
      providerReportedItemCount,
      rejectedByReason: providerReportedItemCount > 0
        ? { EXTRACTION_FAILED: providerReportedItemCount }
        : {},
    };
  }

  const items = array.filter(isRawItem);
  const invalidCount = array.length - items.length;
  return {
    items,
    rawItemCount: array.length,
    extractedItemCount: items.length,
    providerReportedItemCount,
    rejectedByReason: invalidCount > 0 ? { INVALID_RECORD: invalidCount } : {},
  };
}

function findKnownAccessTradeItemArray(value: unknown, depth: number): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (depth >= 3 || !value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ACCESS_TRADE_ITEM_ARRAY_KEYS) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const key of ACCESS_TRADE_WRAPPER_KEYS) {
    const nested = record[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const found = findKnownAccessTradeItemArray(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findProviderReportedItemCount(value: unknown, depth: number): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (depth >= 3 || !value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['total', 'total_count', 'totalCount', 'count']) {
    const parsed = Number(record[key]);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 1_000_000) return parsed;
  }
  for (const key of [...ACCESS_TRADE_WRAPPER_KEYS, 'meta', 'pagination'] as const) {
    const nested = record[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const found = findProviderReportedItemCount(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRawItem(value: unknown): value is AccessTradeRawItem {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasStableCandidateIdentity(item: AccessTradeRawItem): boolean {
  const officialId = getFirstText(item, [
    'product_id', 'productId', 'sku', 'skuId', 'sku_id', 'itemId', 'item_id',
    'id', '_id', 'sourceId', 'source_id', 'externalId', 'external_id',
    'campaignId', 'campaign_id', 'offerId', 'offer_id',
  ]);
  if (officialId) return true;

  const name = getFirstText(item, ['productName', 'product_name', 'title', 'name', 'offerName', 'offer_name']);
  const url = getFirstText(item, [
    'url', 'link', 'productUrl', 'product_url', 'aff_link', 'affiliate_url', 'affiliateUrl',
  ]);
  const merchant = getFirstText(item, ['shop_id', 'shopId', 'merchant', 'shop_name', 'shopName', 'domain']);
  const price = parsePriceNumber(item.price) || parsePriceNumber(item.sale_price) || parsePriceNumber(item.salePrice);
  return Boolean((name && (url || merchant || price)) || (url && merchant));
}

function dedupeNormalizedItems(items: NormalizedAccessTradeItem[]): {
  items: NormalizedAccessTradeItem[];
  duplicateCount: number;
} {
  const grouped = new Map<string, NormalizedAccessTradeItem[]>();
  for (const item of items) {
    const key = getNormalizedAccessTradeIdentity(item);
    grouped.set(key, [...(grouped.get(key) || []), item]);
  }
  const unique = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidates]) => mergeNormalizedAccessTradeCandidates(candidates));
  return { items: unique, duplicateCount: items.length - unique.length };
}

function getNormalizedAccessTradeIdentity(item: NormalizedAccessTradeItem): string {
  const kindGroup = item.kind === 'product' || item.kind === 'deal' ? 'product' : item.kind;
  const providerIdentity = normalizeText(item.sourceItemId || item.id);
  if (providerIdentity) return `accesstrade|${kindGroup}|id|${providerIdentity}`;
  const canonical = item.canonicalProductUrl || item.affiliateDestinationUrl || item.affiliateUrl;
  if (canonical) return `accesstrade|${kindGroup}|url|${normalizeText(canonical)}`;
  return `accesstrade|${kindGroup}|fallback|${normalizeText([item.name, item.merchant, item.shopId, item.price, item.salePrice].join('|'))}`;
}

function mergeNormalizedAccessTradeCandidates(candidates: NormalizedAccessTradeItem[]): NormalizedAccessTradeItem {
  const sorted = [...candidates].sort((left, right) => {
    const scoreDifference = normalizedCandidateEvidenceScore(right) - normalizedCandidateEvidenceScore(left);
    if (scoreDifference) return scoreDifference;
    return normalizedCandidateSignature(left).localeCompare(normalizedCandidateSignature(right));
  });
  const primary = sorted[0];
  if (sorted.length === 1) return primary;

  const firstText = (field: keyof NormalizedAccessTradeItem): string | undefined => {
    for (const candidate of sorted) {
      const value = candidate[field];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  };
  const firstNumber = (field: keyof NormalizedAccessTradeItem): number | undefined => {
    for (const candidate of sorted) {
      const value = candidate[field];
      if (typeof value === 'number' && value > 0) return value;
    }
    return undefined;
  };
  const rawData: Record<string, unknown> = {};
  for (const candidate of [...sorted].reverse()) Object.assign(rawData, candidate.rawData || {});
  const imageCandidates = [...new Set(sorted.flatMap((candidate) => candidate.imageCandidates || []).filter(Boolean))];
  const normalizationIssues = [...new Set(sorted.flatMap((candidate) => candidate.normalizationIssues || []))]
    .filter((reason) => {
      if (reason === 'MISSING_NAME') return !firstText('name');
      if (reason === 'MISSING_CANONICAL_URL' || reason === 'INVALID_CANONICAL_URL') return !firstText('canonicalProductUrl');
      if (reason === 'MISSING_AFFILIATE_URL' || reason === 'INVALID_AFFILIATE_URL') return !firstText('affiliateUrl');
      if (reason === 'MISSING_IMAGE' || reason === 'INVALID_IMAGE_URL') return !firstText('imageUrl');
      if (reason === 'MISSING_PRICE' || reason === 'INVALID_PRICE') return !firstNumber('price') && !firstNumber('salePrice');
      return true;
    });

  return {
    ...primary,
    name: firstText('name') || '',
    description: firstText('description') || '',
    imageUrl: firstText('imageUrl') || '',
    imageCandidates,
    originalUrl: firstText('originalUrl') || '',
    canonicalProductUrl: firstText('canonicalProductUrl'),
    affiliateUrl: firstText('affiliateUrl') || '',
    affiliateDestinationUrl: firstText('affiliateDestinationUrl'),
    price: firstNumber('price') || 0,
    salePrice: firstNumber('salePrice') || 0,
    category: firstText('category') || '',
    merchant: firstText('merchant'),
    merchantDomain: firstText('merchantDomain'),
    shopId: firstText('shopId'),
    shopName: firstText('shopName'),
    sku: firstText('sku'),
    campaignName: firstText('campaignName'),
    providerUpdatedAt: firstText('providerUpdatedAt'),
    normalizationIssues,
    rawData,
  };
}

function normalizedCandidateEvidenceScore(item: NormalizedAccessTradeItem): number {
  return (item.sourceEndpoint === 'datafeed' ? 40 : 0)
    + (item.kind === 'product' || item.kind === 'deal' ? 30 : 0)
    + (item.name ? 8 : 0)
    + (item.canonicalProductUrl ? 8 : 0)
    + (item.affiliateUrl ? 6 : 0)
    + (item.imageUrl ? 4 : 0)
    + (item.price || item.salePrice ? 4 : 0)
    + Math.max(0, Math.min(100, item.qualityScore)) / 100;
}

function normalizedCandidateSignature(item: NormalizedAccessTradeItem): string {
  return normalizeText([
    item.sourceEndpoint, item.sourceItemId, item.id, item.name,
    item.canonicalProductUrl, item.affiliateUrl, item.imageUrl,
    item.price, item.salePrice, item.merchant,
  ].join('|'));
}

// ---- Generic helpers ----

function getFirstText(item: AccessTradeRawItem, keys: readonly string[]): string {
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
    return decodeSafeHtmlEntities(value).replace(/\s+/g, ' ').trim().slice(0, 4096);
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

function decodeSafeHtmlEntities(value: string): string {
  return value
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;|&#39;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d{1,7});/g, (match, digits: string) => {
        const codePoint = Number(digits);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      })
      .replace(/&#x([\da-f]{1,6});/gi, (match, digits: string) => {
        const codePoint = Number.parseInt(digits, 16);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      });
}

const ACCESS_TRADE_RAW_METADATA_FIELDS = new Set([
  'id', '_id', 'sourceId', 'source_id', 'externalId', 'external_id',
  'productId', 'product_id', 'sku', 'skuId', 'sku_id', 'itemId', 'item_id',
  'campaignId', 'campaign_id', 'offerId', 'offer_id',
  'name', 'title', 'productName', 'product_name', 'voucherName', 'voucher_name',
  'campaignName', 'campaign_name', 'offerName', 'offer_name',
  'desc', 'description', 'shortDescription', 'short_description', 'summary', 'content', 'promotion',
  'image', 'image_url', 'imageUrl', 'productImage', 'product_image', 'thumbnail', 'thumbnail_url', 'thumbnailUrl',
  'url', 'link', 'final_url', 'finalUrl', 'originalUrl', 'original_url', 'productUrl', 'product_url',
  'landingPage', 'landing_page', 'merchantUrl', 'merchant_url', 'aff_link', 'affiliate_url', 'affiliateUrl',
  'affiliate_link', 'affiliateLink', 'tracking_link', 'trackingLink', 'deep_link', 'deepLink', 'deeplink',
  'price', 'sale_price', 'salePrice', 'currentPrice', 'current_price', 'discount', 'discount_price',
  'discountPrice', 'discountedPrice', 'discounted_price', 'originalPrice', 'original_price', 'listPrice',
  'list_price', 'oldPrice', 'old_price', 'marketPrice', 'market_price', 'discount_amount', 'discount_rate',
  'status_discount', 'category', 'cate', 'categoryName', 'category_name', 'cat_name', 'vertical', 'industry',
  'commission', 'commission_rate', 'commissionRate', 'merchant', 'merchantName', 'merchant_name',
  'advertiser', 'advertiserName', 'advertiser_name', 'shop', 'shop_id', 'shopId', 'shopName', 'shop_name',
  'campaign', 'campaign_name_text', 'domain', 'coupon_code', 'voucher_code', 'voucherCode', 'couponCode',
  'type', 'kind', 'itemType', 'item_type', 'sourceType', 'source_type', 'categoryType', 'category_type',
  'objectType', 'object_type', 'update_time', 'updated_at', 'created_at',
  '__sandealEndpoint', '__sandealSourceKind', '__sandealFetchedAt',
]);
const ACCESS_TRADE_SECRET_FIELD = /token|secret|password|cookie|authorization|api[_-]?key|credential/i;
const ACCESS_TRADE_RAW_METADATA_MAX_BYTES = 32 * 1024;

function sanitizeAccessTradeRawMetadata(item: AccessTradeRawItem): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  let fields = 0;
  let approximateBytes = 2;
  for (const [key, value] of Object.entries(item)) {
    if (!ACCESS_TRADE_RAW_METADATA_FIELDS.has(key) || fields >= 96) continue;
    const sanitized = sanitizeProviderValue(value, 0);
    if (sanitized === undefined) continue;
    const entryBytes = Buffer.byteLength(JSON.stringify([key, sanitized]), 'utf8');
    if (approximateBytes + entryBytes > ACCESS_TRADE_RAW_METADATA_MAX_BYTES) continue;
    safe[key] = sanitized;
    fields += 1;
    approximateBytes += entryBytes;
  }
  return safe;
}

function sanitizeProviderValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return decodeSafeHtmlEntities(value).trim().slice(0, 4096);
  if (depth >= 1) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 12)
        .map((entry) => sanitizeProviderValue(entry, depth + 1))
        .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !ACCESS_TRADE_SECRET_FIELD.test(key))
        .slice(0, 16)
        .map(([key, entry]) => [key.slice(0, 80), sanitizeProviderValue(entry, depth + 1)])
        .filter(([, entry]) => entry !== undefined));
  }
  return undefined;
}

function sanitizeScalar(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const text = stringifyValue(value);
    return text || undefined;
  }
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function normalizeMerchantDomain(value: unknown): string | undefined {
  const text = stringifyValue(value).toLowerCase().replace(/\.$/, '');
  if (!text) return undefined;
  if (isValidHttpUrl(text)) return safeHostname(text);
  const hostname = text.replace(/^\/\//, '').split('/')[0].split(':')[0];
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)
    ? hostname
    : undefined;
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

  if (officialId) {
    return officialId.length <= 200
      ? officialId
      : `accesstrade-${stableHash(officialId)}`;
  }

  const fingerprint = normalizeText(
      [
        getFirstText(item, ['shop_id', 'shopId', 'merchant', 'shop_name', 'shopName', 'domain']),
        getFirstText(item, ['aff_link', 'affiliate_url', 'affiliateUrl']),
        getFirstText(item, ['productUrl', 'product_url', 'url', 'link']),
        getFirstText(item, ['productName', 'product_name', 'title', 'name']),
        getFirstText(item, ['price', 'sale_price', 'salePrice']),
      ].join('|'),
  );

  return `accesstrade-${stableHash(fingerprint || 'stable-empty-provider-record')}`;
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

export function isValidHttpUrl(value: unknown): boolean {
  return validateExternalUrl(stringifyValue(value)).safe;
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
