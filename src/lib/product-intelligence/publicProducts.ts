import type { Product } from '@/lib/types';
import { getProductBySlug, getPublishedProducts } from '@/lib/storage/products';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { selectRelatedProducts } from '@/lib/seo/productSeo';
import { listPriceHistory, calculatePriceStatistics } from './priceHistory';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';

export interface PublicProductCardDto {
  id: string;
  slug: string;
  title: string;
  imageUrl?: string;
  platform: string;
  category?: string;
  currentPrice?: number;
  originalPrice?: number;
  currency: 'VND';
  discountPercent?: number;
  dealScore?: number;
  dealBand?: Product['dealBand'];
  qualityScore?: number;
  verifiedSource: boolean;
  priceUpdatedAt?: string;
  sourceLabel: string;
  outboundHref: string;
}

export interface PublicProductDetailDto extends PublicProductCardDto {
  description?: string;
  brand?: string;
  gallery?: string[];
  dealReasons: string[];
  dataIssues: string[];
  reviewContent?: PublicReviewContentDto;
  specifications?: Record<string, string | number>;
  updatedAt: string;
  related: PublicProductCardDto[];
  priceHistory: Array<{ capturedAt: string; price: number }>;
}

export interface PublicReviewContentDto {
  reviewStatus: string;
  reviewDisclosure: string;
  reviewTitle: string;
  reviewSummary: string;
  reviewVerdict: string;
  suitableFor: string[];
  notSuitableFor: string[];
  buyingConsiderations: string[];
  keyFacts: Array<{ id: string; label: string; value: string | number }>;
  strengths: Array<{ text: string }>;
  limitations: Array<{ text: string }>;
  evidenceSources: Array<{ name: string; fields: string[]; checkedAt?: string }>;
  reviewedAt: string;
  contentUpdatedAt: string;
}

export interface PublicComparisonDto extends PublicProductCardDto {
  brand?: string;
  specifications?: Record<string, string | number>;
  strengths?: string[];
  limitations?: string[];
  updatedAt: string;
}

export interface PublicProductQuery {
  q?: string;
  platform?: Product['platform'];
  category?: string;
  priceMin?: number;
  priceMax?: number;
  qualityBand?: NonNullable<Product['qualityBand']>;
  opportunityBand?: NonNullable<Product['opportunityBand']>;
  dealBand?: NonNullable<Product['dealBand']>;
  hasImage?: boolean;
  verifiedSource?: boolean;
  updatedWithin?: number;
  sort: 'updated_desc' | 'deal_desc' | 'quality_desc' | 'price_asc' | 'price_desc' | 'discount_desc';
  page: number;
  pageSize: number;
}

export interface PublicSearchResult {
  items: PublicProductCardDto[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  filters: PublicProductQuery;
  facets: { categories: Array<{ name: string; count: number }>; platforms: Array<{ name: string; count: number }> };
}

export interface PublicHomepageData {
  featured: PublicProductCardDto[];
  priceDrops: PublicProductCardDto[];
  recentlyUpdated: PublicProductCardDto[];
  categories: Array<{ name: string; count: number }>;
  totalProducts: number;
  verifiedSourceCount: number;
}

export class PublicProductQueryError extends Error {
  constructor(public readonly field: string, message = 'INVALID_FILTER') { super(message); }
}

const ALLOWED = new Set(['q', 'platform', 'category', 'priceMin', 'priceMax', 'qualityBand', 'opportunityBand', 'dealBand', 'hasImage', 'verifiedSource', 'updatedWithin', 'sort', 'page', 'pageSize']);
const PLATFORMS = new Set(['shopee', 'tiktok_shop', 'lazada', 'accesstrade', 'website', 'other']);
const QUALITY_BANDS = new Set(['good', 'fair', 'needs_data', 'poor', 'blocked']);
const OPPORTUNITY_BANDS = new Set(['priority', 'recommended', 'consider', 'low', 'blocked']);
const DEAL_BANDS = new Set(['featured', 'consider', 'normal', 'verify', 'ineligible']);
const SORTS = new Set(['updated_desc', 'deal_desc', 'quality_desc', 'price_asc', 'price_desc', 'discount_desc']);

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new PublicProductQueryError(key);
  const value = values[0]?.trim();
  return value || undefined;
}

function integer(value: string | undefined, field: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new PublicProductQueryError(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new PublicProductQueryError(field);
  return parsed;
}

function money(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new PublicProductQueryError(field);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000_000_000) throw new PublicProductQueryError(field);
  return parsed;
}

function boolean(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new PublicProductQueryError(field);
  return value === 'true';
}

export function parsePublicProductQuery(params: URLSearchParams): PublicProductQuery {
  for (const key of params.keys()) if (!ALLOWED.has(key)) throw new PublicProductQueryError(key, 'UNKNOWN_FILTER');
  const platform = one(params, 'platform');
  const qualityBand = one(params, 'qualityBand');
  const opportunityBand = one(params, 'opportunityBand');
  const dealBand = one(params, 'dealBand');
  const sort = one(params, 'sort') || 'updated_desc';
  if (platform && !PLATFORMS.has(platform)) throw new PublicProductQueryError('platform');
  if (qualityBand && !QUALITY_BANDS.has(qualityBand)) throw new PublicProductQueryError('qualityBand');
  if (opportunityBand && !OPPORTUNITY_BANDS.has(opportunityBand)) throw new PublicProductQueryError('opportunityBand');
  if (dealBand && !DEAL_BANDS.has(dealBand)) throw new PublicProductQueryError('dealBand');
  if (!SORTS.has(sort)) throw new PublicProductQueryError('sort');
  const q = one(params, 'q'); const category = one(params, 'category');
  if (q && q.length > 120) throw new PublicProductQueryError('q');
  if (category && category.length > 120) throw new PublicProductQueryError('category');
  const priceMin = money(one(params, 'priceMin'), 'priceMin');
  const priceMax = money(one(params, 'priceMax'), 'priceMax');
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) throw new PublicProductQueryError('priceMin');
  const updatedWithinValue = one(params, 'updatedWithin');
  const updatedWithin = updatedWithinValue === undefined ? undefined : integer(updatedWithinValue, 'updatedWithin', 30, 365);
  return {
    q, platform: platform as Product['platform'] | undefined, category, priceMin, priceMax,
    qualityBand: qualityBand as PublicProductQuery['qualityBand'],
    opportunityBand: opportunityBand as PublicProductQuery['opportunityBand'],
    dealBand: dealBand as PublicProductQuery['dealBand'],
    hasImage: boolean(one(params, 'hasImage'), 'hasImage'),
    verifiedSource: boolean(one(params, 'verifiedSource'), 'verifiedSource'),
    updatedWithin, sort: sort as PublicProductQuery['sort'],
    page: integer(one(params, 'page'), 'page', 1, 100_000),
    pageSize: integer(one(params, 'pageSize'), 'pageSize', 12, CONFIG.limits.publicPageSize),
  };
}

function sourceLabel(product: Product): string {
  return ({ manual: 'Nhập thủ công', accesstrade: 'AccessTrade', shopee_affiliate: 'Shopee Affiliate', tiktok_shop: 'TikTok Shop', lazada_affiliate: 'Lazada Affiliate', csv: 'CSV', other: 'Nguồn đối tác' } as Record<string, string>)[product.source] || 'Nguồn đối tác';
}

function price(product: Product): number | undefined {
  const current = Number(product.salePrice || product.price || 0);
  return current > 0 && Number.isFinite(current) ? current : undefined;
}

export function toPublicProductCardDto(product: Product): PublicProductCardDto {
  const current = price(product);
  const original = product.price && current && product.price > current ? product.price : undefined;
  return {
    id: product.id, slug: product.slug, title: product.title, imageUrl: product.imageUrl,
    platform: product.platform, category: product.category, currentPrice: current, originalPrice: original,
    currency: 'VND', discountPercent: original && current ? Math.round((1 - current / original) * 100) : undefined,
    dealScore: product.dealScore, dealBand: product.dealBand, qualityScore: product.qualityScore,
    verifiedSource: product.verifiedSource === true || product.sourceVerified === true,
    priceUpdatedAt: product.priceLastChangedAt || product.lastSeenAt || product.updatedAt,
    sourceLabel: sourceLabel(product), outboundHref: `/go/${encodeURIComponent(product.id)}`,
  };
}

function toPublicReviewContentDto(review: NonNullable<Product['reviewContent']>): PublicReviewContentDto {
  return {
    reviewStatus: review.reviewStatus,
    reviewDisclosure: review.reviewDisclosure,
    reviewTitle: review.reviewTitle,
    reviewSummary: review.reviewSummary,
    reviewVerdict: review.reviewVerdict,
    suitableFor: review.suitableFor.slice(0, 30),
    notSuitableFor: review.notSuitableFor.slice(0, 30),
    buyingConsiderations: review.buyingConsiderations.slice(0, 30),
    keyFacts: review.keyFacts.slice(0, 100).map(fact => ({ id: fact.id, label: fact.label, value: fact.value })),
    strengths: review.strengths.slice(0, 30).map(claim => ({ text: claim.text })),
    limitations: review.limitations.slice(0, 30).map(claim => ({ text: claim.text })),
    evidenceSources: review.evidenceSources.slice(0, 30).map(source => ({
      name: source.name,
      fields: source.fields.slice(0, 50),
      checkedAt: source.checkedAt,
    })),
    reviewedAt: review.reviewedAt,
    contentUpdatedAt: review.contentUpdatedAt,
  };
}

function filterProducts(products: Product[], query: PublicProductQuery): Product[] {
  const q = query.q?.toLocaleLowerCase('vi'); const cutoff = query.updatedWithin ? Date.now() - query.updatedWithin * 86_400_000 : undefined;
  return products.filter(product => {
    const current = price(product);
    if (q && !`${product.title} ${product.description || ''} ${(product.tags || []).join(' ')}`.toLocaleLowerCase('vi').includes(q)) return false;
    if (query.platform && product.platform !== query.platform) return false;
    if (query.category && product.category !== query.category) return false;
    if (query.priceMin !== undefined && (!current || current < query.priceMin)) return false;
    if (query.priceMax !== undefined && (!current || current > query.priceMax)) return false;
    if (query.qualityBand && product.qualityBand !== query.qualityBand) return false;
    if (query.opportunityBand && product.opportunityBand !== query.opportunityBand) return false;
    if (query.dealBand && product.dealBand !== query.dealBand) return false;
    if (query.hasImage !== undefined && Boolean(product.imageUrl) !== query.hasImage) return false;
    if (query.verifiedSource !== undefined && Boolean(product.verifiedSource || product.sourceVerified) !== query.verifiedSource) return false;
    if (cutoff && Date.parse(product.lastSeenAt || product.updatedAt) < cutoff) return false;
    return true;
  });
}

function sortProducts(products: Product[], sort: PublicProductQuery['sort']): Product[] {
  return [...products].sort((a, b) => {
    if (sort === 'deal_desc') return (b.dealScore || 0) - (a.dealScore || 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (sort === 'quality_desc') return (b.qualityScore || 0) - (a.qualityScore || 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (sort === 'price_asc') return (price(a) || Number.MAX_SAFE_INTEGER) - (price(b) || Number.MAX_SAFE_INTEGER);
    if (sort === 'price_desc') return (price(b) || 0) - (price(a) || 0);
    if (sort === 'discount_desc') return (toPublicProductCardDto(b).discountPercent || 0) - (toPublicProductCardDto(a).discountPercent || 0);
    return Date.parse(b.lastSeenAt || b.updatedAt) - Date.parse(a.lastSeenAt || a.updatedAt);
  });
}

function counts(products: Product[], field: 'category' | 'platform') {
  const result = new Map<string, number>();
  for (const product of products) {
    const value = product[field]; if (value) result.set(value, (result.get(value) || 0) + 1);
  }
  return [...result.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'));
}

export async function queryPublicProducts(params: URLSearchParams): Promise<PublicSearchResult> {
  const query = parsePublicProductQuery(params);
  const filtered = sortProducts(filterProducts(await getPublishedProducts(), query), query.sort);
  const totalItems = filtered.length; const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
  const page = Math.min(query.page, totalPages); const start = (page - 1) * query.pageSize;
  return {
    items: filtered.slice(start, start + query.pageSize).map(toPublicProductCardDto),
    pagination: { page, pageSize: query.pageSize, totalItems, totalPages },
    filters: { ...query, page }, facets: { categories: counts(filtered, 'category'), platforms: counts(filtered, 'platform') },
  };
}

export async function getPublicHomepageData(): Promise<PublicHomepageData> {
  const products = await getPublishedProducts();
  const featured = products.filter(product => (product.qualityScore || 0) >= CONFIG.thresholds.qualityFair && ['featured', 'consider'].includes(String(product.dealBand || '')))
    .sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0)).slice(0, 8).map(toPublicProductCardDto);
  const priceDrops: Product[] = [];
  for (const product of products.slice(0, 100)) {
    const snapshots = await listPriceHistory(product.id, 30); const stats = calculatePriceStatistics(product.id, snapshots);
    if ((stats.lastChange || 0) < 0) priceDrops.push(product);
    if (priceDrops.length >= 8) break;
  }
  return {
    featured,
    priceDrops: priceDrops.map(toPublicProductCardDto),
    recentlyUpdated: [...products].sort((a, b) => Date.parse(b.lastSeenAt || b.updatedAt) - Date.parse(a.lastSeenAt || a.updatedAt)).slice(0, 8).map(toPublicProductCardDto),
    categories: counts(products, 'category'),
    totalProducts: products.length,
    verifiedSourceCount: products.filter(product => product.verifiedSource || product.sourceVerified).length,
  };
}

export async function getPublicProductBySlugSafe(slug: string): Promise<{ product: Product; detail: PublicProductDetailDto } | null> {
  const product = await getProductBySlug(slug);
  if (!product || !isPublicSafeProduct(product)) return null;
  const all = await getPublishedProducts();
  const related = selectRelatedProducts(product, all, 4).map(toPublicProductCardDto);
  const snapshots = await listPriceHistory(product.id, 365);
  return {
    product,
    detail: {
      ...toPublicProductCardDto(product), description: product.description, brand: product.brand,
      gallery: product.gallery?.filter(Boolean).slice(0, 8), dealReasons: product.dealReasons || [], dataIssues: product.dataIssues || [],
      reviewContent: product.reviewContent ? toPublicReviewContentDto(product.reviewContent) : undefined,
      specifications: product.specifications, updatedAt: product.updatedAt, related,
      priceHistory: snapshots.map(snapshot => ({ capturedAt: snapshot.capturedAt, price: Number(snapshot.salePrice || snapshot.price || 0) })).filter(point => point.price > 0),
    },
  };
}

export async function getPublicComparison(ids: string[]): Promise<PublicComparisonDto[]> {
  const selectedIds = [...new Set(ids.map(String).filter(Boolean))].slice(0, CONFIG.limits.comparisonProducts);
  const products = await getPublishedProducts();
  return selectedIds.map(id => products.find(product => product.id === id)).filter((product): product is Product => Boolean(product)).map(product => ({
    ...toPublicProductCardDto(product), brand: product.brand, specifications: product.specifications,
    strengths: product.reviewContent?.strengths.map(item => item.text), limitations: product.reviewContent?.limitations.map(item => item.text), updatedAt: product.updatedAt,
  }));
}
