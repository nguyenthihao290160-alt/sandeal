import type { Product } from '@/lib/types';
import { getAllProducts } from '@/lib/storage/products';
import { validateExternalUrl } from './urlSafety';

export type AffiliateLinkStatus = 'healthy' | 'warning' | 'broken' | 'unchecked' | 'unsafe';

export interface AffiliateLinkAdminDto {
  productId: string;
  title: string;
  provider: string;
  campaign?: string;
  originalUrl?: string;
  affiliateUrl?: string;
  canonicalUrl?: string;
  redirectTarget?: string;
  trackingParameters: string[];
  trackingCode?: string;
  status: AffiliateLinkStatus;
  lastCheckedAt?: string;
  warnings: string[];
}

export interface AffiliateLinkQuery {
  q?: string;
  provider?: string;
  status?: AffiliateLinkStatus;
  sort: 'status' | 'recent' | 'title';
  page: number;
  pageSize: number;
}

const STATUS_VALUES = new Set<AffiliateLinkStatus>(['healthy', 'warning', 'broken', 'unchecked', 'unsafe']);
const SORT_VALUES = new Set<AffiliateLinkQuery['sort']>(['status', 'recent', 'title']);
const SECRET_PARAMETER = /token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|credential/i;
const TRACKING_PARAMETER = /^(?:aff(?:iliate)?(?:_?id)?|sub(?:_?id)?|click_?id|tracking|campaign|utm_(?:source|medium|campaign|content|term))$/i;
const STRIP_FROM_CANONICAL = /^(?:aff(?:iliate)?(?:_?id)?|sub(?:_?id)?|click_?id|tracking|campaign|utm_)/i;
const BROKEN = new Set(['broken', 'not_found', 'product_unavailable', 'affiliate_error']);
const WARNING = new Set(['not_allowed', 'unverified', 'rate_limited', 'server_error', 'timeout', 'dns_error', 'error', 'unknown', 'forbidden', 'needs_manual_check']);

function validDate(value?: string): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function normalizedUrl(value?: string): URL | null {
  const result = validateExternalUrl(value);
  return result.safe && result.normalizedUrl ? new URL(result.normalizedUrl) : null;
}

function browserSafeUrl(value?: string, canonical = false): string | undefined {
  const url = normalizedUrl(value);
  if (!url) return undefined;
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAMETER.test(key) || (canonical && STRIP_FROM_CANONICAL.test(key))) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.toString();
}

function relatedHostname(left: URL | null, right: URL | null): boolean {
  if (!left || !right) return true;
  const a = left.hostname.toLowerCase();
  const b = right.hostname.toLowerCase();
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function trackingDetails(value?: string): { names: string[]; code?: string } {
  const url = normalizedUrl(value);
  if (!url) return { names: [] };
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => TRACKING_PARAMETER.test(key) && !SECRET_PARAMETER.test(key))
    .slice(0, 12);
  const names = [...new Set(entries.map(([key]) => key.slice(0, 64)))];
  const first = entries.find(([, item]) => item.trim());
  return { names, code: first ? `${first[0]}=${first[1].slice(0, 80)}` : undefined };
}

function providerName(product: Product): string {
  return String(product.affiliateSource || product.source || product.platform || 'other').trim().slice(0, 80) || 'other';
}

export function toAffiliateLinkAdminDto(product: Product): AffiliateLinkAdminDto {
  const original = normalizedUrl(product.originalUrl);
  const affiliate = normalizedUrl(product.affiliateUrl);
  const warnings: string[] = [];
  const originalProvided = Boolean(product.originalUrl?.trim());
  const affiliateProvided = Boolean(product.affiliateUrl?.trim());
  if (originalProvided && !original) warnings.push('URL nguồn không an toàn hoặc không hợp lệ.');
  if (affiliateProvided && !affiliate) warnings.push('URL tiếp thị liên kết không an toàn hoặc không hợp lệ.');
  if (!affiliateProvided) warnings.push('Chưa có URL tiếp thị liên kết; CTA sẽ chỉ dùng URL nguồn nếu sản phẩm đủ điều kiện.');
  if (original && affiliate && !relatedHostname(original, affiliate)) warnings.push('Tên miền affiliate khác tên miền nguồn; cần xác minh đích redirect.');

  const health = String(product.affiliateHealthStatus || product.linkHealthStatus || '');
  if (BROKEN.has(health)) warnings.push(`Health check ghi nhận trạng thái ${health}.`);
  else if (WARNING.has(health)) warnings.push(`Health check chưa thể xác nhận link (${health}).`);
  const tracking = trackingDetails(product.affiliateUrl);
  if (affiliate && tracking.names.length === 0) warnings.push('Không phát hiện tham số tracking chuẩn trong query; link vẫn cần được xác minh theo provider.');

  let status: AffiliateLinkStatus = 'unchecked';
  if ((originalProvided && !original) || (affiliateProvided && !affiliate)) status = 'unsafe';
  else if (BROKEN.has(health)) status = 'broken';
  else if (WARNING.has(health) || !affiliateProvided || (original && affiliate && !relatedHostname(original, affiliate))) status = 'warning';
  else if (['ok', 'redirect_ok'].includes(health) && (affiliate || original)) status = 'healthy';

  return {
    productId: product.id.slice(0, 160),
    title: String(product.title || 'Sản phẩm chưa có tên').slice(0, 240),
    provider: providerName(product),
    campaign: product.campaignName?.trim().slice(0, 160) || undefined,
    originalUrl: browserSafeUrl(product.originalUrl),
    affiliateUrl: browserSafeUrl(product.affiliateUrl),
    canonicalUrl: browserSafeUrl(original ? product.originalUrl : product.affiliateUrl, true),
    redirectTarget: browserSafeUrl(affiliate ? product.affiliateUrl : product.originalUrl),
    trackingParameters: tracking.names,
    trackingCode: tracking.code,
    status,
    lastCheckedAt: validDate(product.affiliateLastCheckedAt || product.linkLastCheckedAt),
    warnings: warnings.slice(0, 10),
  };
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`INVALID_${field.toUpperCase()}`);
  return parsed;
}

export function parseAffiliateLinkQuery(params: URLSearchParams): AffiliateLinkQuery {
  const allowed = new Set(['q', 'provider', 'status', 'sort', 'page', 'pageSize']);
  for (const key of params.keys()) if (!allowed.has(key)) throw new Error('INVALID_FILTER');
  const q = params.get('q')?.trim();
  const provider = params.get('provider')?.trim();
  const status = params.get('status')?.trim() as AffiliateLinkStatus | undefined;
  const sort = (params.get('sort')?.trim() || 'status') as AffiliateLinkQuery['sort'];
  if (q && q.length > 120) throw new Error('INVALID_Q');
  if (provider && (provider.length > 80 || !/^[\p{L}\p{N}._ -]+$/u.test(provider))) throw new Error('INVALID_PROVIDER');
  if (status && !STATUS_VALUES.has(status)) throw new Error('INVALID_STATUS');
  if (!SORT_VALUES.has(sort)) throw new Error('INVALID_SORT');
  return {
    q: q || undefined,
    provider: provider || undefined,
    status,
    sort,
    page: boundedInteger(params.get('page'), 1, 1, 100_000, 'page'),
    pageSize: boundedInteger(params.get('pageSize'), 20, 1, 50, 'pageSize'),
  };
}

export async function listAffiliateLinks(query: AffiliateLinkQuery) {
  const allItems = (await getAllProducts()).map(toAffiliateLinkAdminDto);
  const providers = [...new Set(allItems.map(item => item.provider))].sort((left, right) => left.localeCompare(right, 'vi'));
  let items = allItems;
  if (query.q) {
    const search = query.q.toLocaleLowerCase('vi');
    items = items.filter(item => [item.productId, item.title, item.provider, item.campaign || ''].some(value => value.toLocaleLowerCase('vi').includes(search)));
  }
  if (query.provider) items = items.filter(item => item.provider === query.provider);
  if (query.status) items = items.filter(item => item.status === query.status);
  const rank: Record<AffiliateLinkStatus, number> = { unsafe: 0, broken: 1, warning: 2, unchecked: 3, healthy: 4 };
  items.sort((left, right) => {
    if (query.sort === 'title') return left.title.localeCompare(right.title, 'vi');
    if (query.sort === 'recent') return Date.parse(right.lastCheckedAt || '1970-01-01') - Date.parse(left.lastCheckedAt || '1970-01-01');
    return rank[left.status] - rank[right.status] || left.title.localeCompare(right.title, 'vi');
  });
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const summary = {
    total: allItems.length,
    healthy: allItems.filter(item => item.status === 'healthy').length,
    warning: allItems.filter(item => item.status === 'warning').length,
    broken: allItems.filter(item => item.status === 'broken').length,
    unchecked: allItems.filter(item => item.status === 'unchecked').length,
    unsafe: allItems.filter(item => item.status === 'unsafe').length,
  };
  return {
    items: items.slice((page - 1) * query.pageSize, page * query.pageSize),
    pagination: { page, pageSize: query.pageSize, totalItems, totalPages },
    summary,
    providers,
  };
}
