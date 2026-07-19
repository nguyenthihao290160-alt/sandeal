import { isPublicSafeProduct, getPublicProductBlockReason } from '@/lib/publicProductFilter';
import type {
  Product,
  ProductKind,
  ProductPlatform,
  ProductRiskLevel,
  ProductStatus,
} from '@/lib/types';

export const DASHBOARD_PRODUCT_SORTS = [
  'updated_desc',
  'created_desc',
  'created_asc',
  'title_asc',
  'price_desc',
] as const;

export const SAFE_PUBLISH_STATUSES = [
  'qualified',
  'needs_review',
  'blocked',
  'published',
  'archived',
] as const;
export const PIPELINE_STAGES = ['classified', 'link_valid', 'image_valid', 'price_valid', 'deduped', 'ready', 'published', 'blocked'] as const;

export type DashboardProductSort = (typeof DASHBOARD_PRODUCT_SORTS)[number];
export type SafePublishStatus = (typeof SAFE_PUBLISH_STATUSES)[number];
export type DashboardPipelineStage = (typeof PIPELINE_STAGES)[number];

export interface DashboardProductQuery {
  q?: string;
  platform?: ProductPlatform;
  status?: ProductStatus;
  kind?: ProductKind;
  riskLevel?: ProductRiskLevel;
  safePublishStatus?: SafePublishStatus;
  pipelineStage?: DashboardPipelineStage;
  sort: DashboardProductSort;
  page: number;
  pageSize: number;
}

export interface DashboardProductItem {
  id: string;
  title: string;
  source: string;
  platform: ProductPlatform;
  type: ProductKind;
  status: ProductStatus;
  safePublishStatus: SafePublishStatus;
  riskLevel: ProductRiskLevel;
  image: string | null;
  url: string | null;
  price: number | null;
  originalPrice: number | null;
  createdAt: string;
  updatedAt: string;
  review: {
    score: number | null;
    needsReview: boolean;
    message: string;
  };
  publish: {
    eligible: boolean;
    publishedAt: string | null;
    message: string;
  };
  health: {
    link: string | null;
    image: string | null;
  };
}

export interface DashboardProductSummary {
  totalItems: number;
  qualifiedForPublish: number;
  needsReview: number;
  rejectedItems: number;
  realProducts: number;
  shopOffers: number;
  vouchers: number;
  campaigns: number;
  published: number;
  publishCandidates: number;
  blocked: number;
  /**
   * Additive operational signals, not a distinct-product count. A product may
   * contribute once for blocked status, once for a broken link, and once for a
   * broken image.
   */
  blockingSignals: number;
  brokenLinks: number;
  brokenImages: number;
  missingPrice: number;
  archived: number;
}

export interface DashboardProductsResult {
  items: DashboardProductItem[];
  summary: DashboardProductSummary;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  filters: DashboardProductQuery;
  updatedAt: string;
}

const PLATFORMS = new Set<ProductPlatform>([
  'shopee', 'tiktok_shop', 'lazada', 'accesstrade', 'website', 'other',
]);
const STATUSES = new Set<ProductStatus>([
  'draft', 'needs_review', 'approved', 'published', 'archived',
]);
const KINDS = new Set<ProductKind>([
  'product', 'voucher', 'campaign', 'deal', 'store_offer', 'unknown',
]);
const RISKS = new Set<ProductRiskLevel>(['low', 'medium', 'high', 'unknown']);
const BROKEN = new Set([
  'broken', 'broken_link', 'not_found', 'forbidden', 'timeout', 'error',
  'failed', 'dead', 'unavailable', 'missing', 'invalid', 'blocked',
  'image_broken', 'invalid_image',
]);

function positiveInteger(value: string | null, fallback: number): number | null {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseDashboardProductQuery(searchParams: URLSearchParams):
  | { ok: true; query: DashboardProductQuery }
  | { ok: false; message: string } {
  const q = (searchParams.get('q') || '').trim();
  const platform = searchParams.get('platform');
  const status = searchParams.get('status');
  const kind = searchParams.get('kind');
  const riskLevel = searchParams.get('riskLevel');
  const safePublishStatus = searchParams.get('safePublishStatus');
  const pipelineStage = searchParams.get('pipelineStage');
  const sort = searchParams.get('sort') || 'updated_desc';
  const page = positiveInteger(searchParams.get('page'), 1);
  const requestedPageSize = positiveInteger(searchParams.get('pageSize'), 20);

  if (q.length > 120) return { ok: false, message: 'Từ khóa tìm kiếm không được dài quá 120 ký tự.' };
  if (platform && !PLATFORMS.has(platform as ProductPlatform)) return { ok: false, message: 'Bộ lọc nền tảng không hợp lệ.' };
  if (status && !STATUSES.has(status as ProductStatus)) return { ok: false, message: 'Bộ lọc trạng thái không hợp lệ.' };
  if (kind && !KINDS.has(kind as ProductKind)) return { ok: false, message: 'Bộ lọc loại dữ liệu không hợp lệ.' };
  if (riskLevel && !RISKS.has(riskLevel as ProductRiskLevel)) return { ok: false, message: 'Bộ lọc mức rủi ro không hợp lệ.' };
  if (safePublishStatus && !SAFE_PUBLISH_STATUSES.includes(safePublishStatus as SafePublishStatus)) return { ok: false, message: 'Bộ lọc đăng an toàn không hợp lệ.' };
  if (pipelineStage && !PIPELINE_STAGES.includes(pipelineStage as DashboardPipelineStage)) return { ok: false, message: 'Bộ lọc giai đoạn pipeline không hợp lệ.' };
  if (!DASHBOARD_PRODUCT_SORTS.includes(sort as DashboardProductSort)) return { ok: false, message: 'Cách sắp xếp không hợp lệ.' };
  if (page === null) return { ok: false, message: 'Số trang không hợp lệ.' };
  if (requestedPageSize === null || requestedPageSize > 50) return { ok: false, message: 'Số sản phẩm mỗi trang phải từ 1 đến 50.' };

  return {
    ok: true,
    query: {
      q: q || undefined,
      platform: platform as ProductPlatform || undefined,
      status: status as ProductStatus || undefined,
      kind: kind as ProductKind || undefined,
      riskLevel: riskLevel as ProductRiskLevel || undefined,
      safePublishStatus: safePublishStatus as SafePublishStatus || undefined,
      pipelineStage: pipelineStage as DashboardPipelineStage || undefined,
      sort: sort as DashboardProductSort,
      page,
      pageSize: requestedPageSize,
    },
  };
}

function safePublishStatus(product: Product): SafePublishStatus {
  if (product.status === 'archived') return 'archived';
  if (isPublicSafeProduct(product)) return product.status === 'published' ? 'published' : 'qualified';
  if (product.status === 'needs_review' || product.riskLevel === 'high') return 'needs_review';
  return 'blocked';
}

function publicMessage(product: Product, eligible: boolean): string {
  if (eligible) return product.status === 'published'
    ? 'Sản phẩm đang được hiển thị công khai.'
    : 'Sản phẩm đã vượt qua kiểm tra đăng an toàn.';
  if (product.status === 'archived') return 'Sản phẩm đã được lưu trữ.';
  return getPublicProductBlockReason(product) || product.publicBlockReason ||
    'Sản phẩm cần được kiểm tra thêm trước khi đăng.';
}

export function toDashboardProductItem(product: Product): DashboardProductItem {
  const eligible = isPublicSafeProduct(product);
  const message = publicMessage(product, eligible);
  return {
    id: product.id,
    title: product.title || 'Sản phẩm chưa có tên',
    source: product.source || 'other',
    platform: product.platform || 'other',
    type: product.kind || 'unknown',
    status: product.status || 'draft',
    safePublishStatus: safePublishStatus(product),
    riskLevel: product.riskLevel || 'unknown',
    image: product.imageUrl || null,
    url: product.affiliateUrl || product.originalUrl || null,
    price: Number.isFinite(product.salePrice) ? product.salePrice! : Number.isFinite(product.price) ? product.price! : null,
    originalPrice: Number.isFinite(product.price) ? product.price! : null,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    review: {
      score: Number.isFinite(product.score) ? product.score! : null,
      needsReview: product.status === 'needs_review' || product.riskLevel === 'high',
      message,
    },
    publish: {
      eligible,
      publishedAt: product.publishedAt || null,
      message,
    },
    health: {
      link: product.linkHealthStatus || null,
      image: product.imageHealthStatus || null,
    },
  };
}

function includesSearch(item: DashboardProductItem, q: string): boolean {
  const needle = q.toLocaleLowerCase('vi');
  return [item.title, item.source, item.platform, item.type]
    .some((value) => String(value).toLocaleLowerCase('vi').includes(needle));
}

function sortItems(items: DashboardProductItem[], sort: DashboardProductSort): void {
  items.sort((a, b) => {
    if (sort === 'created_asc') return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (sort === 'created_desc') return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (sort === 'title_asc') return a.title.localeCompare(b.title, 'vi');
    if (sort === 'price_desc') return (b.price || 0) - (a.price || 0);
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function buildDashboardProducts(products: Product[], query: DashboardProductQuery): DashboardProductsResult {
  const goodHealth = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
  const matchesPipeline = (product: Product) => {
    if (!query.pipelineStage) return true;
    const classified = product.recordType === 'PRODUCT';
    const linkValid = classified && goodHealth.has(String(product.linkHealthStatus || product.productHealthStatus || ''));
    const imageValid = linkValid && goodHealth.has(String(product.imageHealthStatus || ''));
    const priceValid = imageValid && Number(product.salePrice || product.price || 0) > 0;
    const deduped = priceValid && product.duplicateStatus === 'CLEAR';
    if (query.pipelineStage === 'classified') return classified;
    if (query.pipelineStage === 'link_valid') return linkValid;
    if (query.pipelineStage === 'image_valid') return imageValid;
    if (query.pipelineStage === 'price_valid') return priceValid;
    if (query.pipelineStage === 'deduped') return deduped;
    if (query.pipelineStage === 'ready') return classified && product.lifecycleState === 'READY_FOR_PUBLISH' && !isPublicSafeProduct(product);
    if (query.pipelineStage === 'published') return isPublicSafeProduct(product);
    return classified && product.lifecycleState !== 'READY_FOR_PUBLISH' && !isPublicSafeProduct(product);
  };
  const filtered = products.filter(matchesPipeline).map(toDashboardProductItem).filter((item) => {
    if (query.q && !includesSearch(item, query.q)) return false;
    if (query.platform && item.platform !== query.platform) return false;
    if (query.status && item.status !== query.status) return false;
    if (query.kind && item.type !== query.kind) return false;
    if (query.riskLevel && item.riskLevel !== query.riskLevel) return false;
    if (query.safePublishStatus && item.safePublishStatus !== query.safePublishStatus) return false;
    return true;
  });

  sortItems(filtered, query.sort);
  const realKinds = new Set<ProductKind>(['product', 'deal']);
  const blocked = filtered.filter((item) => item.safePublishStatus === 'blocked').length;
  const brokenLinks = filtered.filter((item) => item.health.link && BROKEN.has(item.health.link)).length;
  const brokenImages = filtered.filter((item) => item.health.image && BROKEN.has(item.health.image)).length;
  const summary: DashboardProductSummary = {
    totalItems: filtered.length,
    qualifiedForPublish: filtered.filter((item) => item.publish.eligible).length,
    needsReview: filtered.filter((item) => item.safePublishStatus === 'needs_review').length,
    rejectedItems: filtered.filter((item) => !realKinds.has(item.type)).length,
    realProducts: filtered.filter((item) => realKinds.has(item.type)).length,
    shopOffers: filtered.filter((item) => item.type === 'store_offer').length,
    vouchers: filtered.filter((item) => item.type === 'voucher').length,
    campaigns: filtered.filter((item) => item.type === 'campaign').length,
    published: filtered.filter((item) => item.safePublishStatus === 'published').length,
    publishCandidates: filtered.filter((item) => item.safePublishStatus === 'qualified').length,
    blocked,
    blockingSignals: blocked + brokenLinks + brokenImages,
    brokenLinks,
    brokenImages,
    missingPrice: filtered.filter((item) => item.price === null).length,
    archived: filtered.filter((item) => item.safePublishStatus === 'archived').length,
  };
  const totalPages = Math.max(1, Math.ceil(filtered.length / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const start = (page - 1) * query.pageSize;

  return {
    items: filtered.slice(start, start + query.pageSize),
    summary,
    pagination: { page, pageSize: query.pageSize, totalItems: filtered.length, totalPages },
    filters: { ...query, page },
    updatedAt: new Date().toISOString(),
  };
}
