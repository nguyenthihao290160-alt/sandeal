import type { Product } from '@/lib/types';
import { getProductBySlug, getPublishedProducts } from '@/lib/storage/products';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { selectRelatedProducts } from '@/lib/seo/productSeo';
import { publicTaxonomySlug, type PublicTaxonomyKind } from '@/lib/seo/taxonomySeo';
import { listPriceHistories, listPriceHistory, calculatePriceStatistics } from './priceHistory';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';

export interface PublicProductCardDto {
  id: string;
  slug: string;
  title: string;
  imageUrl?: string;
  platform: string;
  category?: string;
  brand?: string;
  currentPrice?: number;
  originalPrice?: number;
  currency: 'VND';
  discountPercent?: number;
  dealScore?: number;
  dealBand?: Product['dealBand'];
  qualityScore?: number;
  opportunityScore?: number;
  verifiedSource: boolean;
  verifiedAt?: string;
  priceUpdatedAt?: string;
  priceMovement?: PublicPriceMovementDto;
  warnings: string[];
  sourceLabel: string;
  outboundHref: string;
}

export interface PublicPriceMovementDto {
  direction: 'down' | 'up';
  amount: number;
  percent: number;
  capturedAt: string;
}

export interface PublicProductDetailDto extends PublicProductCardDto {
  description?: string;
  brand?: string;
  gallery?: string[];
  dealReasons: string[];
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
  brand?: string;
  priceTrend?: 'down' | 'up';
  priceMin?: number;
  priceMax?: number;
  qualityBand?: NonNullable<Product['qualityBand']>;
  opportunityBand?: NonNullable<Product['opportunityBand']>;
  dealBand?: NonNullable<Product['dealBand']>;
  hasImage?: boolean;
  verifiedSource?: boolean;
  updatedWithin?: number;
  sort: 'updated_desc' | 'deal_desc' | 'quality_desc' | 'price_asc' | 'price_desc' | 'discount_desc' | 'price_drop_desc';
  page: number;
  pageSize: number;
}

export interface PublicSearchResult {
  items: PublicProductCardDto[];
  pagination: { page: number; requestedPage: number; pageSize: number; totalItems: number; totalPages: number; outOfRange: boolean };
  filters: PublicProductQuery;
  facets: { categories: Array<{ name: string; count: number }>; platforms: Array<{ name: string; count: number }> };
}

export interface PublicHomepageData {
  featured: PublicProductCardDto[];
  verifiedRecently: PublicProductCardDto[];
  priceDrops: PublicProductCardDto[];
  highQuality: PublicProductCardDto[];
  recentlyUpdated: PublicProductCardDto[];
  categories: PublicTaxonomySummary[];
  totalProducts: number;
  verifiedSourceCount: number;
}

export class PublicProductQueryError extends Error {
  constructor(public readonly field: string, message = 'INVALID_FILTER') { super(message); }
}

const ALLOWED = new Set(['q', 'platform', 'category', 'brand', 'priceTrend', 'priceMin', 'priceMax', 'qualityBand', 'opportunityBand', 'dealBand', 'hasImage', 'verifiedSource', 'updatedWithin', 'sort', 'page', 'pageSize']);
const PLATFORMS = new Set(['shopee', 'tiktok_shop', 'lazada', 'accesstrade', 'website', 'other']);
const QUALITY_BANDS = new Set(['good', 'fair', 'needs_data', 'poor', 'blocked']);
const OPPORTUNITY_BANDS = new Set(['priority', 'recommended', 'consider', 'low', 'blocked']);
const DEAL_BANDS = new Set(['featured', 'consider', 'normal', 'verify', 'ineligible']);
const SORTS = new Set(['updated_desc', 'deal_desc', 'quality_desc', 'price_asc', 'price_desc', 'discount_desc', 'price_drop_desc']);

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
  const q = one(params, 'q'); const category = one(params, 'category'); const brand = one(params, 'brand');
  const priceTrend = one(params, 'priceTrend');
  if (q && q.length > 120) throw new PublicProductQueryError('q');
  if (category && category.length > 120) throw new PublicProductQueryError('category');
  if (brand && brand.length > 120) throw new PublicProductQueryError('brand');
  if (priceTrend && priceTrend !== 'down' && priceTrend !== 'up') throw new PublicProductQueryError('priceTrend');
  const priceMin = money(one(params, 'priceMin'), 'priceMin');
  const priceMax = money(one(params, 'priceMax'), 'priceMax');
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) throw new PublicProductQueryError('priceMin');
  const updatedWithinValue = one(params, 'updatedWithin');
  const updatedWithin = updatedWithinValue === undefined ? undefined : integer(updatedWithinValue, 'updatedWithin', 30, 365);
  return {
    q, platform: platform as Product['platform'] | undefined, category, brand,
    priceTrend: priceTrend as PublicProductQuery['priceTrend'], priceMin, priceMax,
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

function publicWarnings(product: Product): string[] {
  const issues = (product.dataIssues || []).map(issue => issue.toLowerCase());
  const warnings: string[] = [];
  if (issues.some(issue => issue.includes('price') || issue.includes('discount'))) warnings.push('Giá cần được đối chiếu lại tại nhà bán.');
  if (issues.some(issue => issue.includes('merged_duplicate'))) warnings.push('Dữ liệu đã được hợp nhất từ bản ghi trùng và kiểm tra lại.');
  return warnings.slice(0, 2);
}

export interface PublicTaxonomySummary {
  name: string;
  slug: string;
  count: number;
  lastModified: string;
}

export interface PublicTaxonomyLanding {
  kind: PublicTaxonomyKind;
  taxonomy: PublicTaxonomySummary;
  items: PublicProductCardDto[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number; outOfRange: boolean };
  related: PublicTaxonomySummary[];
  crossLinks: PublicTaxonomySummary[];
}

function publicImageUrls(product: Product): string[] {
  const candidates = [product.imageUrl, ...(product.gallery || [])];
  return [...new Set(candidates.map(value => String(value || '').trim()).filter((value) => {
    if (!value || /(placeholder|sample|demo|fake)/i.test(value)) return false;
    if (value.startsWith('/') && !value.startsWith('//')) return true;
    try {
      const parsed = new URL(value);
      return Boolean(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    } catch {
      return false;
    }
  }))].slice(0, 8);
}

export function toPublicProductCardDto(product: Product, movement?: PublicPriceMovementDto): PublicProductCardDto {
  const current = price(product);
  const original = product.price && current && product.price > current ? product.price : undefined;
  return {
    id: product.id, slug: product.slug, title: product.title, imageUrl: product.imageUrl,
    platform: product.platform, category: product.category, brand: product.brand, currentPrice: current, originalPrice: original,
    currency: 'VND', discountPercent: original && current ? Math.round((1 - current / original) * 100) : undefined,
    dealScore: product.dealScore, dealBand: product.dealBand, qualityScore: product.qualityScore, opportunityScore: product.opportunityScore,
    verifiedSource: product.verifiedSource === true || product.sourceVerified === true,
    verifiedAt: product.reviewContent?.reviewedAt || product.scoreCalculatedAt || product.linkLastCheckedAt,
    priceUpdatedAt: product.priceLastChangedAt || product.lastSeenAt || product.updatedAt,
    priceMovement: movement,
    warnings: publicWarnings(product),
    sourceLabel: sourceLabel(product), outboundHref: `/go/${encodeURIComponent(product.id)}`,
  };
}

function latestPriceMovement(productId: string, snapshots: Awaited<ReturnType<typeof listPriceHistory>>): PublicPriceMovementDto | undefined {
  const statistics = calculatePriceStatistics(productId, snapshots);
  if (!statistics.lastChange || !statistics.lastChangePercent || !snapshots.length) return undefined;
  return {
    direction: statistics.lastChange < 0 ? 'down' : 'up',
    amount: Math.abs(statistics.lastChange),
    percent: Math.abs(statistics.lastChangePercent),
    capturedAt: snapshots[snapshots.length - 1].capturedAt,
  };
}

async function priceMovements(products: Product[]): Promise<Map<string, PublicPriceMovementDto>> {
  const histories = await listPriceHistories(products.map(product => product.id), 30);
  const movements = new Map<string, PublicPriceMovementDto>();
  for (const product of products) {
    const movement = latestPriceMovement(product.id, histories.get(product.id) || []);
    if (movement) movements.set(product.id, movement);
  }
  return movements;
}

function toPublicReviewContentDto(review: NonNullable<Product['reviewContent']>): PublicReviewContentDto {
  const sensitiveFact = /(url|link|image|affiliate|credential|token|secret|authorization|raw)/i;
  return {
    reviewStatus: review.reviewStatus,
    reviewDisclosure: review.reviewDisclosure,
    reviewTitle: review.reviewTitle,
    reviewSummary: review.reviewSummary,
    reviewVerdict: review.reviewVerdict,
    suitableFor: review.suitableFor.slice(0, 30),
    notSuitableFor: review.notSuitableFor.slice(0, 30),
    buyingConsiderations: review.buyingConsiderations.slice(0, 30),
    keyFacts: review.keyFacts
      .filter(fact => !sensitiveFact.test(fact.id) && !sensitiveFact.test(fact.label)
        && !(typeof fact.value === 'string' && /^https?:\/\//i.test(fact.value.trim())))
      .slice(0, 100)
      .map(fact => ({ id: fact.id, label: fact.label, value: fact.value })),
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

function filterProducts(products: Product[], query: PublicProductQuery, movements: Map<string, PublicPriceMovementDto>): Product[] {
  const q = query.q?.toLocaleLowerCase('vi'); const cutoff = query.updatedWithin ? Date.now() - query.updatedWithin * 86_400_000 : undefined;
  return products.filter(product => {
    const current = price(product);
    const searchable = `${product.title} ${product.description || ''} ${product.brand || ''} ${product.sku || ''} ${product.category || ''} ${product.source} ${product.platform} ${(product.tags || []).join(' ')} ${Object.values(product.specifications || {}).join(' ')}`.toLocaleLowerCase('vi');
    if (q && !searchable.includes(q)) return false;
    if (query.platform && product.platform !== query.platform) return false;
    if (query.category && product.category !== query.category) return false;
    if (query.brand && product.brand !== query.brand) return false;
    if (query.priceTrend && movements.get(product.id)?.direction !== query.priceTrend) return false;
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

function sortProducts(products: Product[], sort: PublicProductQuery['sort'], movements: Map<string, PublicPriceMovementDto>): Product[] {
  return [...products].sort((a, b) => {
    if (sort === 'deal_desc') return (b.dealScore || 0) - (a.dealScore || 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (sort === 'quality_desc') return (b.qualityScore || 0) - (a.qualityScore || 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (sort === 'price_asc') return (price(a) || Number.MAX_SAFE_INTEGER) - (price(b) || Number.MAX_SAFE_INTEGER);
    if (sort === 'price_desc') return (price(b) || 0) - (price(a) || 0);
    if (sort === 'discount_desc') return (toPublicProductCardDto(b).discountPercent || 0) - (toPublicProductCardDto(a).discountPercent || 0);
    if (sort === 'price_drop_desc') return (movements.get(b.id)?.percent || 0) - (movements.get(a.id)?.percent || 0);
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

export function summarizePublicTaxonomies(products: Product[], field: 'category' | 'brand'): PublicTaxonomySummary[] {
  const grouped = new Map<string, PublicTaxonomySummary>();
  for (const product of products) {
    const name = String(product[field] || '').trim();
    const slug = publicTaxonomySlug(name);
    if (!name || !slug) continue;
    const modified = product.reviewContent?.contentUpdatedAt || product.publishedAt || product.createdAt;
    const current = grouped.get(slug);
    if (!current) {
      grouped.set(slug, { name, slug, count: 1, lastModified: modified });
      continue;
    }
    current.count += 1;
    if (Date.parse(modified) > Date.parse(current.lastModified)) current.lastModified = modified;
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'));
}

export async function listPublicTaxonomies(kind: PublicTaxonomyKind): Promise<PublicTaxonomySummary[]> {
  return summarizePublicTaxonomies(await getPublishedProducts(), kind);
}

export async function getPublicTaxonomyLanding(
  kind: PublicTaxonomyKind,
  slug: string,
  page: number,
  pageSize = 12,
): Promise<PublicTaxonomyLanding | null> {
  const products = await getPublishedProducts();
  const summaries = summarizePublicTaxonomies(products, kind);
  const taxonomy = summaries.find(item => item.slug === slug);
  if (!taxonomy) return null;
  const field = kind;
  const matching = products.filter(product => publicTaxonomySlug(String(product[field] || '')) === slug);
  const movements = await priceMovements(matching);
  const sorted = sortProducts(matching, 'updated_desc', movements);
  const safePageSize = Math.max(1, Math.min(pageSize, CONFIG.limits.publicPageSize));
  const totalPages = Math.max(1, Math.ceil(sorted.length / safePageSize));
  const outOfRange = page < 1 || page > totalPages;
  const start = (page - 1) * safePageSize;
  const items = outOfRange ? [] : sorted.slice(start, start + safePageSize)
    .map(product => toPublicProductCardDto(product, movements.get(product.id)));
  const crossField = kind === 'category' ? 'brand' : 'category';
  return {
    kind,
    taxonomy,
    items,
    pagination: { page, pageSize: safePageSize, totalItems: sorted.length, totalPages, outOfRange },
    related: summaries.filter(item => item.slug !== slug).slice(0, 8),
    crossLinks: summarizePublicTaxonomies(matching, crossField).slice(0, 8),
  };
}

export async function queryPublicProducts(params: URLSearchParams): Promise<PublicSearchResult> {
  const query = parsePublicProductQuery(params);
  const products = await getPublishedProducts();
  const movements = await priceMovements(products);
  const filtered = sortProducts(filterProducts(products, query, movements), query.sort, movements);
  const totalItems = filtered.length; const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
  const page = Math.min(query.page, totalPages); const start = (page - 1) * query.pageSize;
  return {
    items: filtered.slice(start, start + query.pageSize).map(product => toPublicProductCardDto(product, movements.get(product.id))),
    pagination: { page, requestedPage: query.page, pageSize: query.pageSize, totalItems, totalPages, outOfRange: query.page > totalPages },
    filters: { ...query, page }, facets: { categories: counts(filtered, 'category'), platforms: counts(filtered, 'platform') },
  };
}

export async function getPublicHomepageData(): Promise<PublicHomepageData> {
  const products = await getPublishedProducts();
  const movements = await priceMovements(products);
  const card = (product: Product) => toPublicProductCardDto(product, movements.get(product.id));
  const featured = products.filter(product => (product.qualityScore || 0) >= CONFIG.thresholds.qualityFair && ['featured', 'consider'].includes(String(product.dealBand || '')))
    .sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0)).slice(0, 8).map(card);
  const priceDrops = products.filter(product => movements.get(product.id)?.direction === 'down')
    .sort((a, b) => (movements.get(b.id)?.percent || 0) - (movements.get(a.id)?.percent || 0)).slice(0, 8);
  return {
    featured,
    verifiedRecently: [...products].filter(product => product.verifiedSource || product.sourceVerified)
      .sort((a, b) => Date.parse(b.reviewContent?.reviewedAt || b.updatedAt) - Date.parse(a.reviewContent?.reviewedAt || a.updatedAt)).slice(0, 8).map(card),
    priceDrops: priceDrops.map(card),
    highQuality: [...products].filter(product => typeof product.qualityScore === 'number')
      .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)).slice(0, 8).map(card),
    recentlyUpdated: [...products].sort((a, b) => Date.parse(b.lastSeenAt || b.updatedAt) - Date.parse(a.lastSeenAt || a.updatedAt)).slice(0, 8).map(card),
    categories: summarizePublicTaxonomies(products, 'category'),
    totalProducts: products.length,
    verifiedSourceCount: products.filter(product => product.verifiedSource || product.sourceVerified).length,
  };
}

export async function getPublicProductBySlugSafe(slug: string): Promise<{ product: Product; detail: PublicProductDetailDto } | null> {
  const product = await getProductBySlug(slug);
  if (!product || !isPublicSafeProduct(product)) return null;
  const all = await getPublishedProducts();
  const related = selectRelatedProducts(product, all, 4).map(productItem => toPublicProductCardDto(productItem));
  const snapshots = await listPriceHistory(product.id, 365);
  const movement = latestPriceMovement(product.id, snapshots);
  return {
    product,
    detail: {
      ...toPublicProductCardDto(product, movement), description: product.description, brand: product.brand,
      gallery: publicImageUrls(product), dealReasons: product.dealReasons || [],
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
