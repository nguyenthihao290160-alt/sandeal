// ===========================================
// AccessTrade Integration — Server-side only
// ===========================================
// WARNING:
// - This module must ONLY be imported from server-side code.
// - Never import this in client components.
// - Never expose API keys to frontend.
// - Does NOT fake products.
// - Product feed items are preferred.
// - Voucher/campaign/store offers are stored internally only and blocked from public.

import { getServerConfig } from '../config';
import { getRawPrimaryCredentialValue } from '../storage/tokenVault';
import type { Product, ProductKind, ProductPlatform } from '../types';
import { classifyProductKind, looksLikeVoucherOrCampaign } from '../sourceItemClassifier';

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

export interface NormalizedAccessTradeItem {
  id: string;
  name: string;
  description: string;
  kind: ProductKind;
  sourceItemKind: ProductKind;
  platform: ProductPlatform;
  imageUrl: string;
  originalUrl: string;
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
    publicEligibleProducts: number;
    blockedFromPublic: number;
  };
}

type AccessTradeEndpointKind = 'datafeed' | 'offers';

interface AccessTradeFetchResult {
  endpoint: AccessTradeEndpointKind;
  ok: boolean;
  items: AccessTradeRawItem[];
  status?: number;
  error?: string;
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

    throw new Error(
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

  const publicEligibleProducts = products.filter(
      (item) => !item.publicHidden && item.verifiedSource && !item.needsVerification,
  ).length;

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
      publicEligibleProducts,
      blockedFromPublic: items.length - publicEligibleProducts,
    },
  };
}

export function normalizeAccessTradeItem(
    item: AccessTradeRawItem,
): NormalizedAccessTradeItem {
  const name = getFirstText(item, [
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
    'image',
    'image_url',
    'imageUrl',
    'productImage',
    'product_image',
    'thumbnail',
    'thumbnail_url',
    'thumbnailUrl',
    'logo',
    'banner',
  ]);

  const originalUrl = getFirstText(item, [
    'url',
    'link',
    'final_url',
    'finalUrl',
    'originalUrl',
    'original_url',
    'productUrl',
    'product_url',
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
      parseNumber(item.price) ||
      parseNumber(item.currentPrice) ||
      parseNumber(item.current_price) ||
      parseNumber(item.originalPrice) ||
      parseNumber(item.original_price) ||
      parseNumber(item.listPrice) ||
      parseNumber(item.list_price) ||
      parseNumber(item.marketPrice) ||
      parseNumber(item.market_price) ||
      0;

  const salePrice =
      parseNumber(item.discount) ||
      parseNumber(item.discount_price) ||
      parseNumber(item.discountPrice) ||
      parseNumber(item.discountedPrice) ||
      parseNumber(item.discounted_price) ||
      parseNumber(item.salePrice) ||
      parseNumber(item.sale_price) ||
      price ||
      0;

  const commissionRate =
      parseNumber(item.commission_rate) ||
      parseNumber(item.commissionRate) ||
      parseNumber(item.commission);

  const rawSourceKind = getRawSourceKind(item);
  const kind = detectAccessTradeItemKind(item);
  const isRealProduct = kind === 'product' || kind === 'deal';

  const hasRequiredProductData =
      Boolean(name) &&
      Boolean(imageUrl) &&
      Boolean(affiliateUrl || originalUrl) &&
      (price > 0 || salePrice > 0);

  const titleLooksUnsafe = looksLikeVoucherOrCampaign({
    title: name,
    description,
    rawSourceKind,
    source: 'accesstrade',
    raw: item,
  });

  const isDatafeedProduct = item.__sandealEndpoint === 'datafeed' && hasDatafeedProductSignals(item);

  const verifiedSource =
      isRealProduct &&
      hasRequiredProductData &&
      (isDatafeedProduct || !titleLooksUnsafe);

  const needsVerification = !verifiedSource || !isRealProduct;
  const publicHidden = !verifiedSource || !isRealProduct;

  return {
    id: getItemId(item),
    name,
    description,
    kind,
    sourceItemKind: kind,
    platform: 'accesstrade',
    imageUrl,
    originalUrl,
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
    rawData: item,
  };
}

export function detectAccessTradeItemKind(item: AccessTradeRawItem): ProductKind {
  const rawSourceKind = getRawSourceKind(item);

  const title = getFirstText(item, [
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

  const nameText = normalizeText(title);

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

  if (item.__sandealEndpoint === 'datafeed' && hasDatafeedProductSignals(item)) {
    return 'product';
  }

  if (
      rawText.includes('product') ||
      rawText.includes('datafeed') ||
      rawText.includes('product_feed')
  ) {
    if (hasProductSignals(item)) {
      return 'product';
    }
  }

  if (rawText.includes('voucher') || rawText.includes('coupon')) {
    return 'voucher';
  }

  if (rawText.includes('campaign')) {
    return 'campaign';
  }

  if (
      rawText.includes('store_offer') ||
      rawText.includes('store offer') ||
      rawText.includes('shop offer')
  ) {
    return 'store_offer';
  }

  if (item.coupon_code || item.voucher_code || item.voucherCode || item.couponCode) {
    return 'voucher';
  }

  const looksLikeOffer = looksLikeVoucherOrCampaign({
    title,
    description,
    rawSourceKind,
    source: 'accesstrade',
    raw: item,
  });

  if (looksLikeOffer) {
    if (
        /^\[[^\]]+\]\s*-\s*/.test(title.trim()) ||
        nameText.includes('official store') ||
        nameText.includes('official shop') ||
        nameText.includes('shop') ||
        nameText.includes('store')
    ) {
      return 'store_offer';
    }

    return 'voucher';
  }

  if (hasProductSignals(item)) {
    return 'product';
  }

  if (item.campaign_name || item.campaign || item.campaignName) {
    return 'campaign';
  }

  return classifyProductKind({
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
    price: parseNumber(item.price),
    salePrice: parseNumber(item.discount) || parseNumber(item.sale_price),
    rawSourceKind,
    sourceType: 'affiliate',
    raw: item,
  });
}

export function mapAccessTradeToProduct(
    item: NormalizedAccessTradeItem,
): Omit<Product, 'id' | 'slug' | 'createdAt' | 'updatedAt'> {
  const isRealProduct = item.kind === 'product' || item.kind === 'deal';

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
    warnings: [],
    checkBeforeBuy: [
      'Kiểm tra giá, phí vận chuyển và điều kiện ưu đãi trước khi mua.',
      'Giá và ưu đãi có thể thay đổi theo thời điểm.',
    ],

    affiliateSource: 'accesstrade',
    campaignName: item.campaignName || undefined,
    commissionNote: item.commissionRate ? `Hoa hồng: ${item.commissionRate}%` : undefined,

    riskLevel: item.needsVerification ? 'unknown' : 'low',
    status: 'needs_review',

    externalId: item.id,
    sourceId: item.id,

    verifiedSource: item.verifiedSource,
    sourceVerified: item.verifiedSource,
    publicHidden: !isRealProduct || item.publicHidden,
    needsVerification: item.needsVerification,

    aiApproved: false,
    approvalMode: 'manual_or_auto_safe_required',

    complianceStatus: 'needs_edit',
    contentPackageStatus: 'none',

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
  let response: Response;

  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lỗi kết nối';

    return {
      endpoint,
      ok: false,
      items: [],
      error: message,
    };
  }

  if (!response.ok) {
    return {
      endpoint,
      ok: false,
      items: [],
      status: response.status,
      error: `HTTP ${response.status}`,
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

  const items = extractRawItems(data).map((item) => ({
    ...item,
    __sandealEndpoint: endpoint,
    __sandealSourceKind: sourceKind,
    __sandealEndpointUrl: sanitizeEndpointUrl(url),
  }));

  return {
    endpoint,
    ok: true,
    items,
    status: response.status,
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
            getRawValueText(item.rawData, 'campaign'),
          ].join(' '),
      );

      return haystack.includes(keyword);
    });
  }

  const category = normalizeText(params.category);
  if (category) {
    filtered = filtered.filter((item) => {
      const haystack = normalizeText([item.category, item.name, item.description].join(' '));
      return haystack.includes(category) || haystack.includes(toAsciiSlug(category));
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
            getRawValueText(item.rawData, 'campaign'),
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
    const aWeight = kindWeight[a.kind] ?? 10;
    const bWeight = kindWeight[b.kind] ?? 10;

    if (aWeight !== bWeight) return aWeight - bWeight;

    const aComplete = Number(Boolean(a.name && a.imageUrl && (a.affiliateUrl || a.originalUrl)));
    const bComplete = Number(Boolean(b.name && b.imageUrl && (b.affiliateUrl || b.originalUrl)));

    if (aComplete !== bComplete) return bComplete - aComplete;

    return a.name.localeCompare(b.name);
  });
}

// ---- Product signal helpers ----

function hasDatafeedProductSignals(item: AccessTradeRawItem): boolean {
  const hasOfficialProductId = Boolean(
      getFirstText(item, ['product_id', 'productId', 'sku', 'skuId', 'sku_id']),
  );

  const hasOfficialProductUrl = Boolean(getFirstText(item, ['url', 'aff_link']));
  const hasOfficialProductImage = Boolean(getFirstText(item, ['image']));
  const hasOfficialProductPrice = Boolean(parseNumber(item.price) || parseNumber(item.discount));

  return hasOfficialProductId && hasOfficialProductUrl && hasOfficialProductImage && hasOfficialProductPrice;
}

function hasProductSignals(item: AccessTradeRawItem): boolean {
  const title = getFirstText(item, ['name', 'title', 'productName', 'product_name']);

  const hasPrice = Boolean(
      parseNumber(item.price) ||
      parseNumber(item.currentPrice) ||
      parseNumber(item.current_price) ||
      parseNumber(item.salePrice) ||
      parseNumber(item.sale_price) ||
      parseNumber(item.discount) ||
      parseNumber(item.discount_price) ||
      parseNumber(item.discountPrice),
  );

  const hasImage = Boolean(
      getFirstText(item, [
        'image',
        'image_url',
        'imageUrl',
        'productImage',
        'product_image',
        'thumbnail',
        'thumbnail_url',
        'thumbnailUrl',
      ]),
  );

  const hasUrl = Boolean(
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
        'url',
        'link',
        'productUrl',
        'product_url',
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

  return Boolean(title && hasUrl && hasImage && (hasPrice || hasProductId));
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
  return (
      getFirstText(item, [
        'product_id',
        'productId',
        'sku',
        'skuId',
        'sku_id',
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
      ]) || `accesstrade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
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
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
}

function toAsciiSlug(value: string): string {
  return normalizeText(value)
      .replace(/đ/g, 'd')
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
  return cloned.toString();
}

function getRawValueText(rawData: NormalizedAccessTradeItem['rawData'], key: string): string {
  if (!rawData || typeof rawData !== 'object') return '';

  const value = (rawData as Record<string, unknown>)[key];

  return stringifyValue(value);
}