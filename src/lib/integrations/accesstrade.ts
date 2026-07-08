// ===========================================
// AccessTrade Integration â€” Server-side only
// ===========================================
// WARNING: This module must ONLY be imported from server-side code.
// Never import this in client components or pages.
// Checks Token Vault first, then falls back to env config.
// Does NOT fake products. Voucher/campaign/store offers are classified safely.

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

  desc?: string;
  description?: string;
  shortDescription?: string;
  short_description?: string;
  summary?: string;
  content?: string;

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

  category?: string;
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

  [key: string]: unknown;
}

// ---- Functions ----

export async function isAccessTradeConfigured(): Promise<boolean> {
  const vaultKey = await getRawPrimaryCredentialValue('accesstrade');
  if (vaultKey && vaultKey.length > 5) return true;

  const { accessTradeApiKey } = getServerConfig();
  return Boolean(accessTradeApiKey && accessTradeApiKey.length > 5);
}

async function getAccessTradeKey(): Promise<string | null> {
  const vaultKey = await getRawPrimaryCredentialValue('accesstrade');
  if (vaultKey && vaultKey.length > 5) return vaultKey;

  const { accessTradeApiKey } = getServerConfig();
  return accessTradeApiKey || null;
}

export async function searchAccessTrade(
    params: AccessTradeSearchParams,
): Promise<AccessTradeSearchResult> {
  const accessTradeApiKey = await getAccessTradeKey();

  if (!accessTradeApiKey) {
    throw new Error(
        'ChÆ°a cáº¥u hĂ¬nh AccessTrade API key. HĂ£y thĂªm trong Token Vault hoáº·c Ä‘áº·t ACCESS_TRADE_API_KEY trong env.',
    );
  }

  const limit = Math.min(Math.max(params.limit || 10, 1), 50);

  // Current stable endpoint in this project.
  // Note: this endpoint may return vouchers/campaign/store offers. We classify safely below.
  const url = new URL('https://api.accesstrade.vn/v1/offers_informations');

  if (params.keyword) url.searchParams.set('keyword', params.keyword);
  if (params.category) url.searchParams.set('category', params.category);
  url.searchParams.set('limit', String(limit));

  let response: Response;

  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Token ${accessTradeApiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lá»—i káº¿t ná»‘i';
    throw new Error(`KhĂ´ng thá»ƒ láº¥y dá»¯ liá»‡u tá»« AccessTrade. ${message}`);
  }

  if (!response.ok) {
    throw new Error(
        `KhĂ´ng thá»ƒ láº¥y dá»¯ liá»‡u tá»« AccessTrade. Vui lĂ²ng kiá»ƒm tra API key hoáº·c thá»­ láº¡i sau. (HTTP ${response.status})`,
    );
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new Error('Dá»¯ liá»‡u tráº£ vá» tá»« AccessTrade khĂ´ng há»£p lá»‡.');
  }

  const rawItems = extractRawItems(data);
  let items = rawItems.map(normalizeAccessTradeItem);

  if (params.kind && params.kind !== 'all') {
    items = items.filter((item) => item.kind === params.kind);
  }

  if (params.imageOnly) {
    items = items.filter((item) => Boolean(item.imageUrl));
  }

  if (params.affiliateLinkOnly) {
    items = items.filter((item) => Boolean(item.affiliateUrl));
  }

  const products = items.filter((item) => item.kind === 'product' || item.kind === 'deal');
  const vouchers = items.filter((item) => item.kind === 'voucher');
  const campaigns = items.filter((item) => item.kind === 'campaign');
  const storeOffers = items.filter((item) => item.kind === 'store_offer');
  const unknown = items.filter((item) => item.kind === 'unknown');

  const publicEligibleProducts = products.filter(
      (item) => !item.publicHidden && item.verifiedSource && !item.needsVerification,
  ).length;

  const summary = {
    total: items.length,
    products: products.length,
    vouchers: vouchers.length,
    campaigns: campaigns.length,
    storeOffers: storeOffers.length,
    unknown: unknown.length,
    publicEligibleProducts,
    blockedFromPublic: items.length - publicEligibleProducts,
  };

  return {
    items,
    products,
    vouchers,
    campaigns,
    storeOffers,
    unknown,
    summary,
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
    'merchant',
    'merchantName',
    'merchant_name',
    'advertiser',
    'advertiserName',
    'advertiser_name',
    'shop',
    'shopName',
    'shop_name',
  ]);

  const price =
      parseNumber(item.price) ||
      parseNumber(item.currentPrice) ||
      parseNumber(item.current_price) ||
      parseNumber(item.salePrice) ||
      parseNumber(item.sale_price) ||
      0;

  const salePrice =
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

  const verifiedSource =
      isRealProduct &&
      hasRequiredProductData &&
      !titleLooksUnsafe;

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
        /^\[[^\]]+\]\s*-\s*/.test(nameText) ||
        nameText.includes('official store') ||
        nameText.includes('official shop') ||
        nameText.includes('shop') ||
        nameText.includes('store')
    ) {
      return 'store_offer';
    }

    return 'voucher';
  }

  if (rawText.includes('product')) {
    return 'product';
  }

  const hasPrice =
      Boolean(
          parseNumber(item.price) ||
          parseNumber(item.currentPrice) ||
          parseNumber(item.current_price) ||
          parseNumber(item.salePrice) ||
          parseNumber(item.sale_price) ||
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

  if (title && hasUrl && hasImage && (hasPrice || hasProductId)) {
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
    affiliateUrl: getFirstText(item, ['affiliate_url', 'affiliateUrl', 'deep_link', 'deepLink']),
    originalUrl: getFirstText(item, ['url', 'link', 'productUrl', 'product_url']),
    url: getFirstText(item, ['url', 'link', 'productUrl', 'product_url']),
    price: parseNumber(item.price),
    salePrice: parseNumber(item.sale_price),
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
      'Kiá»ƒm tra giĂ¡, phĂ­ váº­n chuyá»ƒn vĂ  Ä‘iá»u kiá»‡n Æ°u Ä‘Ă£i trÆ°á»›c khi mua.',
      'GiĂ¡ vĂ  Æ°u Ä‘Ă£i cĂ³ thá»ƒ thay Ä‘á»•i theo thá»i Ä‘iá»ƒm.',
    ],

    affiliateSource: 'accesstrade',
    campaignName: item.campaignName || undefined,
    commissionNote: item.commissionRate ? `Hoa há»“ng: ${item.commissionRate}%` : undefined,

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

// ---- Helpers ----

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

function getFirstText(item: AccessTradeRawItem, keys: string[]): string {
  for (const key of keys) {
    const value = getPathValue(item, key);

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value).trim();
    }
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

function getItemId(item: AccessTradeRawItem): string {
  return (
      getFirstText(item, [
        'id',
        '_id',
        'sourceId',
        'source_id',
        'externalId',
        'external_id',
        'productId',
        'product_id',
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
      ]) || 'unknown'
  ).toLowerCase();
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[â€“â€”]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
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
      /â‚«|Ä‘|vnd/i.test(trimmed) ||
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


