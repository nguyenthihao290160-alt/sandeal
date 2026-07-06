// ===========================================
// AccessTrade Integration — Server-side only
// ===========================================
// WARNING: This module must ONLY be imported from server-side code.
// Never import this in client components or pages.

import { getServerConfig } from '../config';
import type { Product, ProductKind, ProductPlatform } from '../types';

// ---- Types ----

export interface AccessTradeSearchParams {
  keyword?: string;
  category?: string;
  platform?: string;
  kind?: 'product' | 'voucher' | 'campaign' | 'all';
  limit?: number;
  imageOnly?: boolean;
  affiliateLinkOnly?: boolean;
}

export interface NormalizedAccessTradeItem {
  id: string;
  name: string;
  description: string;
  kind: ProductKind;
  platform: ProductPlatform;
  imageUrl: string;
  originalUrl: string;
  affiliateUrl: string;
  price: number;
  salePrice: number;
  category: string;
  commissionRate?: number;
  campaignName?: string;
  needsVerification: boolean;
  rawData?: Record<string, unknown>;
}

export interface AccessTradeSearchResult {
  items: NormalizedAccessTradeItem[];
  summary: {
    total: number;
    products: number;
    vouchers: number;
    campaigns: number;
    unknown: number;
  };
}

// ---- Raw API response types ----

interface AccessTradeRawItem {
  id?: string;
  _id?: string;
  name?: string;
  title?: string;
  desc?: string;
  description?: string;
  image?: string;
  image_url?: string;
  thumbnail?: string;
  url?: string;
  link?: string;
  final_url?: string;
  affiliate_url?: string;
  deep_link?: string;
  price?: number | string;
  sale_price?: number | string;
  discount_price?: number | string;
  category?: string;
  cat_name?: string;
  commission?: number | string;
  commission_rate?: number | string;
  merchant?: string;
  campaign_name?: string;
  campaign?: string;
  coupon_code?: string;
  voucher_code?: string;
  type?: string;
  // Allow other unknown properties
  [key: string]: unknown;
}

// ---- Functions ----

/**
 * Check if AccessTrade API key is configured.
 */
export function isAccessTradeConfigured(): boolean {
  const { accessTradeApiKey } = getServerConfig();
  return !!accessTradeApiKey && accessTradeApiKey.length > 5;
}

/**
 * Search AccessTrade for products/vouchers/campaigns.
 * Server-side only — never call from frontend.
 */
export async function searchAccessTrade(params: AccessTradeSearchParams): Promise<AccessTradeSearchResult> {
  const { accessTradeApiKey } = getServerConfig();

  if (!accessTradeApiKey) {
    throw new Error('Chưa cấu hình AccessTrade API key trên server.');
  }

  const url = new URL('https://api.accesstrade.vn/v1/offers_informations');

  if (params.keyword) url.searchParams.set('keyword', params.keyword);
  if (params.category) url.searchParams.set('category', params.category);
  if (params.limit) url.searchParams.set('limit', String(params.limit));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Token ${accessTradeApiKey}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lỗi kết nối';
    throw new Error(`Không thể lấy dữ liệu từ AccessTrade. ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      `Không thể lấy dữ liệu từ AccessTrade. Vui lòng kiểm tra API key hoặc thử lại sau. (HTTP ${response.status})`
    );
  }

  let data: { data?: AccessTradeRawItem[]; d?: AccessTradeRawItem[]; items?: AccessTradeRawItem[] };
  try {
    data = await response.json();
  } catch {
    throw new Error('Dữ liệu trả về từ AccessTrade không hợp lệ.');
  }

  const rawItems: AccessTradeRawItem[] = data.data || data.d || data.items || [];

  let items = rawItems.map(normalizeAccessTradeItem);

  // Apply client-side filters
  if (params.kind && params.kind !== 'all') {
    items = items.filter(item => item.kind === params.kind);
  }
  if (params.imageOnly) {
    items = items.filter(item => !!item.imageUrl);
  }
  if (params.affiliateLinkOnly) {
    items = items.filter(item => !!item.affiliateUrl);
  }

  const summary = {
    total: items.length,
    products: items.filter(i => i.kind === 'product').length,
    vouchers: items.filter(i => i.kind === 'voucher').length,
    campaigns: items.filter(i => i.kind === 'campaign').length,
    unknown: items.filter(i => i.kind === 'unknown').length,
  };

  return { items, summary };
}

/**
 * Normalize a raw AccessTrade item into a consistent structure.
 */
export function normalizeAccessTradeItem(item: AccessTradeRawItem): NormalizedAccessTradeItem {
  const kind = detectAccessTradeItemKind(item);
  const price = parseNumber(item.price) || parseNumber(item.sale_price) || 0;
  const salePrice = parseNumber(item.discount_price) || parseNumber(item.sale_price) || 0;

  const name = item.name || item.title || '';
  const description = item.desc || item.description || '';
  const imageUrl = item.image || item.image_url || item.thumbnail || '';
  const originalUrl = item.url || item.link || item.final_url || '';
  const affiliateUrl = item.affiliate_url || item.deep_link || '';
  const category = item.category || item.cat_name || '';
  const campaignName = item.campaign_name || item.campaign || item.merchant || '';
  const commissionRate = parseNumber(item.commission_rate) || parseNumber(item.commission);

  // Determine if item needs manual verification
  const needsVerification = !name || !imageUrl || kind === 'unknown';

  return {
    id: String(item.id || item._id || Date.now()),
    name,
    description,
    kind,
    platform: 'accesstrade',
    imageUrl,
    originalUrl,
    affiliateUrl,
    price,
    salePrice,
    category,
    commissionRate: commissionRate || undefined,
    campaignName: campaignName || undefined,
    needsVerification,
  };
}

/**
 * Detect whether an AccessTrade item is a product, voucher, or campaign.
 */
export function detectAccessTradeItemKind(item: AccessTradeRawItem): ProductKind {
  const type = (item.type || '').toLowerCase();

  // Explicit type from API
  if (type.includes('voucher') || type.includes('coupon')) return 'voucher';
  if (type.includes('campaign') || type.includes('offer')) return 'campaign';
  if (type.includes('product')) return 'product';

  // Check for voucher indicators
  if (item.coupon_code || item.voucher_code) return 'voucher';

  // Check for enough product-like fields
  const hasPrice = !!(item.price || item.sale_price);
  const hasImage = !!(item.image || item.image_url || item.thumbnail);
  const hasName = !!(item.name || item.title);

  if (hasPrice && hasImage && hasName) return 'product';
  if (item.campaign_name || item.campaign) return 'campaign';

  return 'unknown';
}

/**
 * Map a normalized AccessTrade item to a Product creation input.
 */
export function mapAccessTradeToProduct(item: NormalizedAccessTradeItem): Omit<Product, 'id' | 'slug' | 'createdAt' | 'updatedAt'> {
  return {
    title: item.name,
    description: item.description || undefined,
    kind: item.kind,
    platform: 'accesstrade',
    source: 'accesstrade',
    originalUrl: item.originalUrl || undefined,
    affiliateUrl: item.affiliateUrl || undefined,
    imageUrl: item.imageUrl || undefined,
    gallery: [],
    price: item.price || undefined,
    salePrice: item.salePrice || undefined,
    currency: 'VND',
    category: item.category || undefined,
    tags: [],
    benefits: [],
    warnings: [],
    affiliateSource: 'accesstrade',
    campaignName: item.campaignName || undefined,
    commissionNote: item.commissionRate ? `Hoa hồng: ${item.commissionRate}%` : undefined,
    riskLevel: item.needsVerification ? 'unknown' : 'low',
    status: item.needsVerification ? 'needs_review' : 'needs_review',
    externalId: item.id,
    rawSourceType: 'accesstrade',
  };
}

// ---- Helpers ----

function parseNumber(val: unknown): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const num = Number(val);
  return isNaN(num) ? undefined : num;
}
