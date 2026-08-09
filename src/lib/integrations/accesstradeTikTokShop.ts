// AccessTrade TikTok Shop Product Feed V2. Server-side only.

import { createHash } from 'crypto';
import { getDomainCircuitDecision, recordDomainHealth, type DomainCircuitRole } from '@/lib/bots/domainCircuitBreaker';
import { sourceReliabilityEvent } from '@/lib/commerce/sourceReliability';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import { getAccessTradeServerCredential, type NormalizedAccessTradeItem } from './accesstrade';

export const ACCESSTRADE_TIKTOK_SOURCE = 'accesstrade_tiktok_shop' as const;
export const ACCESSTRADE_TIKTOK_SOURCE_LABEL = 'TikTok Shop Affiliate' as const;
export const ACCESSTRADE_TIKTOK_SOURCE_LABEL_VI = 'TikTok Shop qua AccessTrade' as const;
export const ACCESSTRADE_TIKTOK_PRODUCT_ENDPOINT = 'https://api.accesstrade.vn/v2/tiktokshop_product_feeds';
export const ACCESSTRADE_TIKTOK_LINK_ENDPOINT = 'https://api.accesstrade.vn/v2/tiktokshop_product_feeds/create_link';

export const ACCESSTRADE_TIKTOK_BOUNDS = Object.freeze({
  timeoutMs: 12_000,
  maximumAttempts: 3,
  baseBackoffMs: 300,
  maximumBackoffMs: 3_000,
  maximumRetryAfterMs: 10_000,
  maximumResponseBytes: 2 * 1024 * 1024,
  pageSize: 20,
  manualMaximumPages: 3,
  autoPilotMaximumPages: 2,
  maximumPages: 3,
  manualDefaultAcceptedItemBudget: 30,
  manualAcceptedItemBudget: 40,
  autoPilotAcceptedItemBudget: 30,
  rawItemBudget: 160,
  maximumKeywords: 6,
  maximumProductIds: 40,
  maximumTrackingLength: 160,
});

export type AccessTradeTikTokSortStrategy =
  | 'RECOMMENDED'
  | 'BEST_SELLERS'
  | 'LOW_PRICE'
  | 'HIGH_PRICE'
  | 'NEWLY_RELEASED'
  | 'HIGH_COMMISSION_RATE';

export const ACCESSTRADE_TIKTOK_SORT_STRATEGIES: readonly AccessTradeTikTokSortStrategy[] = [
  'RECOMMENDED',
  'BEST_SELLERS',
  'LOW_PRICE',
  'HIGH_PRICE',
  'NEWLY_RELEASED',
  'HIGH_COMMISSION_RATE',
] as const;

const EXTERNAL_SORT_FIELD: Record<AccessTradeTikTokSortStrategy, string> = {
  RECOMMENDED: 'RECOMMENDED',
  BEST_SELLERS: 'BEST_SELLERS',
  LOW_PRICE: 'LOW_PRICE',
  HIGH_PRICE: 'HIGH_PRICE',
  NEWLY_RELEASED: 'NEWLY_RELEASED',
  // V2 documentation has historically shown both COMMISSION and COMMISSIOM.
  // Keep the provider spelling decision at this boundary.
  HIGH_COMMISSION_RATE: 'HIGH_COMMISSION_RATE',
};

export function toAccessTradeTikTokSortField(strategy: AccessTradeTikTokSortStrategy): string {
  return EXTERNAL_SORT_FIELD[strategy];
}

export type AccessTradeTikTokRejectionReason =
  | 'MISSING_PRODUCT_ID'
  | 'MISSING_TITLE'
  | 'MISSING_PRODUCT_URL'
  | 'INVALID_PRODUCT_URL'
  | 'MISSING_IMAGE'
  | 'INVALID_IMAGE'
  | 'INVALID_PRICE'
  | 'UNSUPPORTED_CURRENCY'
  | 'MISSING_SHOP_IDENTITY'
  | 'PRODUCT_UNAVAILABLE'
  | 'SOURCE_SCHEMA_INVALID'
  | 'AFFILIATE_LINK_UNAVAILABLE';

export type AccessTradeTikTokStopReason =
  | 'ACCEPTED_ITEM_BUDGET_REACHED'
  | 'EMPTY_PAGE'
  | 'NO_NEXT_PAGE_TOKEN'
  | 'REPEATED_PAGE_TOKEN'
  | 'MAX_PAGES_REACHED'
  | 'RAW_ITEM_BUDGET_REACHED'
  | 'REQUEST_ABORTED'
  | 'PROVIDER_ERROR';

export type AccessTradeTikTokResultType =
  | 'success_with_results'
  | 'success_empty'
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'unauthorized'
  | 'forbidden'
  | 'upstream_error'
  | 'client_error'
  | 'malformed_json'
  | 'schema_mismatch'
  | 'response_too_large'
  | 'network_error'
  | 'circuit_open';

export interface AccessTradeTikTokCategory {
  id: string;
  name: string;
  parentId?: string;
  leaf: boolean;
}

export interface NormalizedAccessTradeTikTokProduct extends NormalizedAccessTradeItem {
  provider: 'accesstrade';
  source: typeof ACCESSTRADE_TIKTOK_SOURCE;
  sourceLabel: typeof ACCESSTRADE_TIKTOK_SOURCE_LABEL;
  sourceLabelVi: typeof ACCESSTRADE_TIKTOK_SOURCE_LABEL_VI;
  platform: 'tiktok_shop';
  merchantIdentity: string;
  originalPrice?: number;
  currentPrice: number;
  currency: 'VND';
  commissionAmount?: number;
  unitsSold?: number;
  categoryId?: string;
  categoryName?: string;
  categoryChain: AccessTradeTikTokCategory[];
  available?: boolean;
  affiliateState: 'NOT_CREATED' | 'CREATED' | 'UNAVAILABLE';
  /** Ephemeral request accounting; candidate persistence intentionally omits it. */
  affiliateRequestAttempts?: number;
  sourceEndpoint: 'tiktok_product_feed_v2';
}

export interface AccessTradeTikTokRequestLog {
  endpoint: 'tiktok_product_feed_v2' | 'tiktok_create_link_v2';
  page?: number;
  durationMs: number;
  statusCode?: number;
  attempts: number;
  resultType: AccessTradeTikTokResultType;
  itemCount: number;
  retryAfter?: string;
}

export interface AccessTradeTikTokSearchDiagnostics {
  source: typeof ACCESSTRADE_TIKTOK_SOURCE;
  fetched: number;
  normalized: number;
  accepted: number;
  duplicates: number;
  rejectedByReason: Partial<Record<AccessTradeTikTokRejectionReason, number>>;
  pageCount: number;
  stopReason: AccessTradeTikTokStopReason;
  durationMs: number;
  rawItemBudget: number;
  acceptedItemBudget: number;
  maximumPages: number;
  nextPageTokenPresent: boolean;
  previewOnly: boolean;
  persisted: false;
}

export interface AccessTradeTikTokSearchResult {
  items: NormalizedAccessTradeTikTokProduct[];
  requests: AccessTradeTikTokRequestLog[];
  diagnostics: AccessTradeTikTokSearchDiagnostics;
}

export interface AccessTradeTikTokSearchInput {
  sortStrategy?: AccessTradeTikTokSortStrategy;
  titleKeywords?: string[];
  productIds?: string[];
  pageToken?: string;
  limit?: number;
  maximumPages?: number;
  rawItemBudget?: number;
  acceptedItemBudget?: number;
  mode?: 'manual' | 'auto_pilot' | 'probe';
  signal?: AbortSignal;
}

export interface AccessTradeTikTokTracking {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  sub1?: string;
  sub2?: string;
  sub3?: string;
  sub4?: string;
}

export interface AccessTradeTikTokCreateLinkInput {
  productUrl: string;
  productId?: string;
  tracking?: AccessTradeTikTokTracking;
  signal?: AbortSignal;
}

export interface AccessTradeTikTokAffiliateLink {
  url: string;
  sourceField: 'aff_short_url' | 'aff_url';
  fetchedAt: string;
  attempts: number;
  request: AccessTradeTikTokRequestLog;
}

export interface AccessTradeTikTokClientDependencies {
  credential?: string | null | (() => Promise<string | null>);
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  circuit?: boolean;
  /** Deterministic test seam; production remains capped by central bounds. */
  timeoutMs?: number;
  /** Deterministic test seam; production remains capped by central bounds. */
  maximumAttempts?: number;
}

export class AccessTradeTikTokError extends Error {
  constructor(
    public readonly resultType: AccessTradeTikTokResultType,
    message: string,
    public readonly request?: AccessTradeTikTokRequestLog,
  ) {
    super(message);
    this.name = 'AccessTradeTikTokError';
  }
}

type UnknownRecord = Record<string, unknown>;

interface TikTokPage {
  products: unknown[];
  nextPageToken?: string;
  request: AccessTradeTikTokRequestLog;
}

interface RequestOptions {
  endpoint: 'tiktok_product_feed_v2' | 'tiktok_create_link_v2';
  method: 'GET' | 'POST';
  url: URL;
  body?: UnknownRecord;
  signal?: AbortSignal;
  circuitRole: DomainCircuitRole;
  circuitIdentity: string;
}

const SECRET_KEY_PATTERN = /token|secret|password|cookie|authorization|api[_-]?key|credential/i;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function text(value: unknown, maximum = 4_096): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, maximum);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback;
}

function validUrl(value: string): boolean {
  return validateExternalUrl(value).safe;
}

function validTikTokProductUrl(value: string): boolean {
  if (!validUrl(value)) return false;
  const domain = hostname(value);
  return domain === 'tiktok.com' || Boolean(domain?.endsWith('.tiktok.com'));
}

function sameUrl(left: string, right: string): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    first.hash = '';
    second.hash = '';
    return first.href === second.href;
  } catch {
    return false;
  }
}

function hostname(value: string): string | undefined {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return undefined; }
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function normalizedIdentityText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

export function accessTradeTikTokMerchantIdentity(shopId: string | undefined, shopName: string | undefined): string | undefined {
  const id = text(shopId, 180);
  if (id) {
    const normalizedId = id.toLowerCase();
    return /^[a-z0-9][a-z0-9._-]*$/.test(normalizedId)
      ? `tiktok-shop:${normalizedId}`
      : `tiktok-shop-id:${stableHash(id)}`;
  }
  const name = text(shopName, 240);
  if (!name) return undefined;
  const readable = normalizedIdentityText(name).slice(0, 48) || 'shop';
  return `tiktok-shop-name:${readable}:${stableHash(name.toLocaleLowerCase('vi-VN'))}`;
}

function categoryChain(value: unknown): AccessTradeTikTokCategory[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap(entry => {
    const item = record(entry);
    if (!item) return [];
    const id = text(item.id ?? item.category_id, 120);
    const name = text(item.local_name ?? item.name ?? item.category_name, 240);
    if (!id && !name) return [];
    return [{
      id,
      name,
      parentId: text(item.parent_id ?? item.parentId, 120) || undefined,
      leaf: item.is_leaf === true || item.isLeaf === true,
    }];
  });
}

function imageCandidates(item: UnknownRecord): string[] {
  const output: string[] = [];
  const append = (value: unknown) => {
    const candidate = typeof value === 'string' ? value.trim() : text(record(value)?.url ?? record(value)?.image_url);
    if (candidate && validUrl(candidate) && !output.includes(candidate)) output.push(candidate);
  };
  append(item.main_image_url ?? item.mainImageUrl ?? item.image_url ?? item.imageUrl);
  for (const field of ['images', 'image_urls', 'imageUrls', 'gallery']) {
    const values = item[field];
    if (Array.isArray(values)) values.slice(0, 12).forEach(append);
  }
  return output.slice(0, 12);
}

function sanitizedSourceMetadata(item: UnknownRecord): UnknownRecord {
  const allowed = new Set([
    'id', 'product_id', 'title', 'detail_link', 'product_url', 'main_image_url', 'has_inventory',
    'units_sold', 'sale_region', 'updated_at', 'update_time', 'created_at',
  ]);
  const output: UnknownRecord = {};
  for (const [key, value] of Object.entries(item)) {
    if (!allowed.has(key) || SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof value === 'string') output[key] = value.slice(0, 2_000);
    else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') output[key] = value;
  }
  return output;
}

export function normalizeAccessTradeTikTokProduct(raw: unknown):
  | { ok: true; product: NormalizedAccessTradeTikTokProduct }
  | { ok: false; reason: AccessTradeTikTokRejectionReason } {
  const item = record(raw);
  if (!item) return { ok: false, reason: 'SOURCE_SCHEMA_INVALID' };
  const productId = text(item.id ?? item.product_id ?? item.productId, 200);
  if (!productId) return { ok: false, reason: 'MISSING_PRODUCT_ID' };
  const title = text(item.title ?? item.product_name ?? item.productName, 1_000);
  if (!title) return { ok: false, reason: 'MISSING_TITLE' };
  const productUrl = text(item.detail_link ?? item.product_url ?? item.productUrl ?? item.url, 4_096);
  if (!productUrl) return { ok: false, reason: 'MISSING_PRODUCT_URL' };
  if (!validTikTokProductUrl(productUrl)) return { ok: false, reason: 'INVALID_PRODUCT_URL' };
  const images = imageCandidates(item);
  if (!images.length) {
    const supplied = text(item.main_image_url ?? item.mainImageUrl ?? item.image_url ?? item.imageUrl);
    return { ok: false, reason: supplied ? 'INVALID_IMAGE' : 'MISSING_IMAGE' };
  }
  const shop = record(item.shop) || {};
  const shopId = text(shop.id ?? shop.shop_id ?? item.shop_id ?? item.shopId, 200) || undefined;
  const shopName = text(shop.name ?? shop.shop_name ?? item.shop_name ?? item.shopName, 240) || undefined;
  const merchantIdentity = accessTradeTikTokMerchantIdentity(shopId, shopName);
  if (!merchantIdentity) return { ok: false, reason: 'MISSING_SHOP_IDENTITY' };
  const available = typeof item.has_inventory === 'boolean'
    ? item.has_inventory
    : typeof item.hasInventory === 'boolean' ? item.hasInventory : undefined;
  if (available === false) return { ok: false, reason: 'PRODUCT_UNAVAILABLE' };

  const salesPrice = record(item.sales_price ?? item.sale_price ?? item.current_price) || {};
  const originalPrice = record(item.original_price ?? item.list_price) || {};
  const currentPrice = positiveNumber(salesPrice.minimum_amount ?? salesPrice.min_amount ?? salesPrice.amount)
    ?? positiveNumber(originalPrice.minimum_amount ?? originalPrice.min_amount ?? originalPrice.amount);
  if (!currentPrice) return { ok: false, reason: 'INVALID_PRICE' };
  const originalAmount = positiveNumber(originalPrice.minimum_amount ?? originalPrice.min_amount ?? originalPrice.amount);
  const currency = text(salesPrice.currency ?? originalPrice.currency ?? item.currency, 8).toUpperCase() || 'VND';
  if (currency !== 'VND') return { ok: false, reason: 'UNSUPPORTED_CURRENCY' };

  const categories = categoryChain(item.category_chains ?? item.categoryChains ?? item.categories);
  const leafCategory = [...categories].reverse().find(category => category.leaf) || categories.at(-1);
  const commission = record(item.commission) || {};
  const commissionRateHundredths = nonNegativeNumber(commission.rate ?? item.commission_rate ?? item.commissionRate);
  const commissionRate = commissionRateHundredths === undefined
    ? undefined
    : Number((commissionRateHundredths / 100).toFixed(2));
  const commissionAmount = nonNegativeNumber(commission.amount ?? item.commission_amount ?? item.commissionAmount);
  const fetchedAt = new Date().toISOString();
  const updated = text(item.updated_at ?? item.update_time ?? item.updatedAt ?? item.create_time ?? item.created_at, 100);
  const providerUpdatedAt = updated && Number.isFinite(Date.parse(updated)) ? new Date(updated).toISOString() : undefined;
  const merchantDomain = hostname(productUrl);
  const sourceOriginalPrice = originalAmount && originalAmount >= currentPrice ? originalAmount : undefined;
  const canonicalPrice = sourceOriginalPrice || currentPrice;
  const salePrice = sourceOriginalPrice && currentPrice < sourceOriginalPrice ? currentPrice : 0;

  const product: NormalizedAccessTradeTikTokProduct = {
    id: productId,
    name: title,
    description: text(item.description ?? item.desc, 4_096),
    kind: 'product',
    sourceItemKind: 'product',
    provider: 'accesstrade',
    source: ACCESSTRADE_TIKTOK_SOURCE,
    sourceLabel: ACCESSTRADE_TIKTOK_SOURCE_LABEL,
    sourceLabelVi: ACCESSTRADE_TIKTOK_SOURCE_LABEL_VI,
    platform: 'tiktok_shop',
    imageUrl: images[0],
    imageCandidates: images,
    originalUrl: productUrl,
    canonicalProductUrl: productUrl,
    canonicalUrlSource: 'provider_api',
    canonicalUrlProvider: 'accesstrade',
    canonicalUrlSourceEndpoint: 'tiktok_product_feed_v2',
    canonicalUrlSourceField: item.detail_link !== undefined ? 'detail_link' : item.product_url !== undefined ? 'product_url' : 'url',
    canonicalUrlFetchedAt: fetchedAt,
    canonicalUrlStatus: 'available',
    affiliateUrl: '',
    affiliateUrlSource: 'none',
    affiliateUrlProvider: 'accesstrade',
    affiliateUrlSourceEndpoint: 'tiktok_create_link_v2',
    affiliateUrlSourceField: undefined,
    affiliateUrlFetchedAt: undefined,
    affiliateUrlStatus: 'unavailable',
    affiliateState: 'NOT_CREATED',
    price: canonicalPrice,
    salePrice,
    originalPrice: sourceOriginalPrice,
    currentPrice,
    currency: 'VND',
    category: leafCategory?.name || '',
    categoryId: leafCategory?.id || undefined,
    categoryName: leafCategory?.name || undefined,
    categoryChain: categories,
    commissionAmount,
    commissionRate,
    unitsSold: nonNegativeInteger(item.units_sold ?? item.unitsSold),
    available,
    merchant: shopName,
    merchantDomain,
    merchantIdentity,
    shopId,
    shopName,
    campaignName: ACCESSTRADE_TIKTOK_SOURCE,
    providerUpdatedAt,
    sourceEndpoint: 'tiktok_product_feed_v2',
    sourceItemId: productId,
    fetchedAt,
    rawSourceKind: 'tiktok_shop_product_feed_v2',
    normalizationIssues: ['MISSING_AFFILIATE_URL'],
    fieldProvenance: {
      canonicalProductUrl: {
        value: productUrl, source: ACCESSTRADE_TIKTOK_SOURCE, provider: 'accesstrade', endpoint: 'tiktok_product_feed_v2',
        sourceField: item.detail_link !== undefined ? 'detail_link' : item.product_url !== undefined ? 'product_url' : 'url',
        fetchedAt, canonicalizedAt: fetchedAt, verificationStatus: 'UNVERIFIED',
      },
      affiliateUrl: {
        source: ACCESSTRADE_TIKTOK_SOURCE, provider: 'accesstrade', endpoint: 'tiktok_create_link_v2',
        fetchedAt, verificationStatus: 'MISSING', verificationReason: 'AFFILIATE_LINK_NOT_CREATED',
      },
      imageUrl: {
        value: images[0], source: ACCESSTRADE_TIKTOK_SOURCE, provider: 'accesstrade', endpoint: 'tiktok_product_feed_v2',
        sourceField: 'main_image_url', fetchedAt, canonicalizedAt: fetchedAt, verificationStatus: 'UNVERIFIED',
      },
      price: {
        value: currentPrice, source: ACCESSTRADE_TIKTOK_SOURCE, provider: 'accesstrade', endpoint: 'tiktok_product_feed_v2',
        sourceField: positiveNumber(salesPrice.minimum_amount) ? 'sales_price.minimum_amount' : 'original_price.minimum_amount',
        fetchedAt, canonicalizedAt: fetchedAt, verificationStatus: 'UNVERIFIED',
      },
    },
    needsVerification: true,
    verifiedSource: true,
    publicHidden: true,
    autoPublishEligible: false,
    publicDecision: 'needs_review',
    publicBlockReason: 'AFFILIATE_LINK_NOT_CREATED',
    qualityScore: 90,
    rawData: sanitizedSourceMetadata(item),
  };
  return { ok: true, product };
}

function rawProductId(item: UnknownRecord): string {
  return text(item.id ?? item.product_id ?? item.productId, 200);
}

function evidenceScore(item: UnknownRecord): number {
  return Number(Boolean(rawProductId(item))) * 20
    + Number(Boolean(text(item.title))) * 10
    + Number(Boolean(text(item.detail_link ?? item.product_url))) * 10
    + Number(Boolean(text(item.main_image_url))) * 8
    + Number(Boolean(record(item.shop)?.id)) * 6
    + Number(Boolean(record(item.shop)?.name)) * 4
    + Number(Boolean(record(item.sales_price)?.minimum_amount)) * 4
    + Number(Boolean(record(item.original_price)?.minimum_amount)) * 2;
}

function mergeObjects(preferred: UnknownRecord, fallback: UnknownRecord, depth = 0): UnknownRecord {
  const output: UnknownRecord = { ...preferred };
  for (const [key, value] of Object.entries(fallback)) {
    if (output[key] === undefined || output[key] === null || output[key] === '') output[key] = value;
    else if (depth < 1 && record(output[key]) && record(value)) output[key] = mergeObjects(record(output[key])!, record(value)!, depth + 1);
  }
  return output;
}

function mergeRawProducts(left: UnknownRecord, right: UnknownRecord): UnknownRecord {
  const leftScore = evidenceScore(left);
  const rightScore = evidenceScore(right);
  if (rightScore > leftScore) return mergeObjects(right, left);
  if (leftScore > rightScore) return mergeObjects(left, right);
  const leftSignature = JSON.stringify(left);
  const rightSignature = JSON.stringify(right);
  return leftSignature.localeCompare(rightSignature) <= 0 ? mergeObjects(left, right) : mergeObjects(right, left);
}

function retryAfter(response: Response, nowMs: number): { iso?: string; delayMs?: number } {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return {};
  const target = /^\d+$/.test(raw) ? nowMs + Number(raw) * 1_000 : Date.parse(raw);
  if (!Number.isFinite(target) || target <= nowMs) return {};
  const delayMs = Math.min(ACCESSTRADE_TIKTOK_BOUNDS.maximumRetryAfterMs, target - nowMs);
  return { iso: new Date(nowMs + delayMs).toISOString(), delayMs };
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason || new DOMException('Request aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new DOMException('Request aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else setTimeout(() => signal?.removeEventListener('abort', onAbort), Math.max(0, milliseconds) + 1);
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > ACCESSTRADE_TIKTOK_BOUNDS.maximumResponseBytes) {
    throw new AccessTradeTikTokError('response_too_large', 'AccessTrade TikTok response exceeded the byte budget');
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > ACCESSTRADE_TIKTOK_BOUNDS.maximumResponseBytes) {
        await reader.cancel();
        throw new AccessTradeTikTokError('response_too_large', 'AccessTrade TikTok response exceeded the byte budget');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AccessTradeTikTokError('malformed_json', 'AccessTrade TikTok returned malformed JSON'); }
}

async function credentialValue(dependencies: AccessTradeTikTokClientDependencies): Promise<string> {
  const configured = typeof dependencies.credential === 'function'
    ? await dependencies.credential()
    : dependencies.credential !== undefined ? dependencies.credential : await getAccessTradeServerCredential();
  const value = String(configured || '');
  if (!value || value.trim() !== value || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new AccessTradeTikTokError('unauthorized', 'AccessTrade credential is not configured');
  }
  return value;
}

function resultTypeForStatus(status: number): AccessTradeTikTokResultType {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'client_error';
}

async function requestJson(
  options: RequestOptions,
  dependencies: AccessTradeTikTokClientDependencies,
): Promise<{ data: unknown; request: AccessTradeTikTokRequestLog }> {
  const accessKey = await credentialValue(dependencies);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const sleep = dependencies.sleep || defaultSleep;
  const random = dependencies.random || Math.random;
  const now = dependencies.now || Date.now;
  const timeoutMs = boundedInteger(dependencies.timeoutMs, ACCESSTRADE_TIKTOK_BOUNDS.timeoutMs, 1, ACCESSTRADE_TIKTOK_BOUNDS.timeoutMs);
  const maximumAttempts = boundedInteger(dependencies.maximumAttempts, ACCESSTRADE_TIKTOK_BOUNDS.maximumAttempts, 1, ACCESSTRADE_TIKTOK_BOUNDS.maximumAttempts);
  if (options.signal?.aborted) throw new AccessTradeTikTokError('aborted', 'AccessTrade TikTok request aborted');
  if (dependencies.circuit !== false) {
    const decision = await getDomainCircuitDecision(options.url.toString(), now(), {
      role: options.circuitRole,
      identityKey: options.circuitIdentity,
    });
    if (!decision.allowed) {
      throw new AccessTradeTikTokError('circuit_open', 'AccessTrade TikTok operation circuit is open', {
        endpoint: options.endpoint, durationMs: 0, attempts: 0, resultType: 'circuit_open', itemCount: 0, retryAfter: decision.retryAt,
      });
    }
  }

  let lastRequest: AccessTradeTikTokRequestLog | undefined;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const startedAt = now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(options.url, {
        method: options.method,
        headers: {
          Authorization: `Token ${accessKey}`,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      const retry = retryAfter(response, now());
      if (!response.ok) {
        const resultType = resultTypeForStatus(response.status);
        lastRequest = {
          endpoint: options.endpoint, durationMs: Math.max(0, now() - startedAt), statusCode: response.status,
          attempts: attempt, resultType, itemCount: 0, retryAfter: retry.iso,
        };
        const retryable = response.status === 429 || response.status >= 500;
        if (dependencies.circuit !== false && (!retryable || attempt === maximumAttempts)) {
          await recordDomainHealth(options.url.toString(), response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'server_error' : 'error', now(), {
            role: options.circuitRole, identityKey: options.circuitIdentity, retryAfter: retry.iso,
          });
        }
        if (!retryable || attempt >= maximumAttempts) {
          throw new AccessTradeTikTokError(resultType, `AccessTrade TikTok HTTP ${response.status}`, lastRequest);
        }
        const exponential = Math.min(
          ACCESSTRADE_TIKTOK_BOUNDS.maximumBackoffMs,
          ACCESSTRADE_TIKTOK_BOUNDS.baseBackoffMs * 2 ** (attempt - 1),
        );
        await sleep(retry.delayMs ?? exponential + Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, random()))), options.signal);
        continue;
      }
      const data = await boundedJson(response);
      const request: AccessTradeTikTokRequestLog = {
        endpoint: options.endpoint, durationMs: Math.max(0, now() - startedAt), statusCode: response.status,
        attempts: attempt, resultType: 'success_empty', itemCount: 0,
      };
      return { data, request };
    } catch (error) {
      if (error instanceof AccessTradeTikTokError) {
        if (dependencies.circuit !== false && ['malformed_json', 'response_too_large'].includes(error.resultType)) {
          await recordDomainHealth(options.url.toString(), 'invalid_response', now(), {
            role: options.circuitRole,
            identityKey: options.circuitIdentity,
          });
        }
        throw error;
      }
      const aborted = options.signal?.aborted === true;
      const resultType: AccessTradeTikTokResultType = aborted ? 'aborted' : timedOut ? 'timeout' : 'network_error';
      lastRequest = {
        endpoint: options.endpoint, durationMs: Math.max(0, now() - startedAt), attempts: attempt,
        resultType, itemCount: 0,
      };
      if (aborted) throw new AccessTradeTikTokError('aborted', 'AccessTrade TikTok request aborted', lastRequest);
      if (attempt >= maximumAttempts) {
        if (dependencies.circuit !== false) {
          await recordDomainHealth(options.url.toString(), timedOut ? 'timeout' : 'network_error', now(), {
            role: options.circuitRole, identityKey: options.circuitIdentity,
          });
        }
        throw new AccessTradeTikTokError(resultType, timedOut ? 'AccessTrade TikTok request timed out' : 'AccessTrade TikTok network request failed', lastRequest);
      }
      const delay = Math.min(ACCESSTRADE_TIKTOK_BOUNDS.maximumBackoffMs, ACCESSTRADE_TIKTOK_BOUNDS.baseBackoffMs * 2 ** (attempt - 1));
      await sleep(delay + Math.floor(delay * 0.25 * Math.max(0, Math.min(1, random()))), options.signal);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new AccessTradeTikTokError(lastRequest?.resultType || 'network_error', 'AccessTrade TikTok request failed', lastRequest);
}

function parsePage(value: unknown, request: AccessTradeTikTokRequestLog): TikTokPage {
  const envelope = record(value);
  const data = record(envelope?.data);
  if (!envelope || !data || !Array.isArray(data.products) || envelope.status === false) {
    throw new AccessTradeTikTokError('schema_mismatch', 'AccessTrade TikTok response schema is invalid', {
      ...request, resultType: 'schema_mismatch', itemCount: 0,
    });
  }
  const products = data.products;
  const nextPageToken = text(data.next_page_token ?? data.nextPageToken, 2_000) || undefined;
  return {
    products,
    nextPageToken,
    request: { ...request, resultType: products.length ? 'success_with_results' : 'success_empty', itemCount: products.length },
  };
}

function cleanList(values: string[] | undefined, maximumItems: number, maximumLength: number): string[] {
  return [...new Set((values || []).map(value => String(value || '').trim().slice(0, maximumLength)).filter(Boolean))].slice(0, maximumItems);
}

export async function searchAccessTradeTikTokProducts(
  input: AccessTradeTikTokSearchInput = {},
  dependencies: AccessTradeTikTokClientDependencies = {},
): Promise<AccessTradeTikTokSearchResult> {
  const startedAt = (dependencies.now || Date.now)();
  const mode = input.mode || 'manual';
  const defaultMaximumPages = mode === 'auto_pilot'
    ? ACCESSTRADE_TIKTOK_BOUNDS.autoPilotMaximumPages
    : mode === 'probe' ? 1 : ACCESSTRADE_TIKTOK_BOUNDS.manualMaximumPages;
  const defaultAcceptedBudget = mode === 'auto_pilot'
    ? ACCESSTRADE_TIKTOK_BOUNDS.autoPilotAcceptedItemBudget
    : mode === 'probe' ? 10 : ACCESSTRADE_TIKTOK_BOUNDS.manualDefaultAcceptedItemBudget;
  const maximumPages = boundedInteger(input.maximumPages, defaultMaximumPages, 1, ACCESSTRADE_TIKTOK_BOUNDS.maximumPages);
  const rawItemBudget = boundedInteger(input.rawItemBudget, ACCESSTRADE_TIKTOK_BOUNDS.rawItemBudget, 1, ACCESSTRADE_TIKTOK_BOUNDS.rawItemBudget);
  const acceptedItemBudget = boundedInteger(input.acceptedItemBudget, defaultAcceptedBudget, 1, ACCESSTRADE_TIKTOK_BOUNDS.manualAcceptedItemBudget);
  const limit = boundedInteger(input.limit, ACCESSTRADE_TIKTOK_BOUNDS.pageSize, 1, ACCESSTRADE_TIKTOK_BOUNDS.pageSize);
  const titleKeywords = cleanList(input.titleKeywords, ACCESSTRADE_TIKTOK_BOUNDS.maximumKeywords, 160);
  const productIds = cleanList(input.productIds, ACCESSTRADE_TIKTOK_BOUNDS.maximumProductIds, 200);
  const sortStrategy = ACCESSTRADE_TIKTOK_SORT_STRATEGIES.includes(input.sortStrategy || 'RECOMMENDED')
    ? input.sortStrategy || 'RECOMMENDED' : 'RECOMMENDED';
  const requests: AccessTradeTikTokRequestLog[] = [];
  const rawProducts = new Map<string, unknown>();
  const rejectedByReason: Partial<Record<AccessTradeTikTokRejectionReason, number>> = {};
  const seenTokens = new Set<string>();
  let pageToken = text(input.pageToken, 2_000) || undefined;
  if (pageToken) seenTokens.add(pageToken);
  let fetched = 0;
  let duplicates = 0;
  let pageCount = 0;
  let nextPageTokenPresent = false;
  let stopReason: AccessTradeTikTokStopReason = 'MAX_PAGES_REACHED';

  sourceReliabilityEvent('accesstrade_tiktok_search_started', {
    provider: 'accesstrade', campaign: ACCESSTRADE_TIKTOK_SOURCE, reasonCode: `${mode}:${sortStrategy}`,
  });
  try {
    for (let page = 1; page <= maximumPages; page += 1) {
      if (input.signal?.aborted) { stopReason = 'REQUEST_ABORTED'; break; }
      const remainingRawBudget = rawItemBudget - fetched;
      if (remainingRawBudget <= 0) { stopReason = 'RAW_ITEM_BUDGET_REACHED'; break; }
      const url = new URL(ACCESSTRADE_TIKTOK_PRODUCT_ENDPOINT);
      url.searchParams.set('sort_field', toAccessTradeTikTokSortField(sortStrategy));
      url.searchParams.set('limit', String(Math.min(limit, remainingRawBudget)));
      for (const keyword of titleKeywords) url.searchParams.append('title_keywords', keyword);
      for (const productId of productIds) url.searchParams.append('product_ids', productId);
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const response = await requestJson({
        endpoint: 'tiktok_product_feed_v2', method: 'GET', url, signal: input.signal,
        circuitRole: 'SOURCE_API', circuitIdentity: ACCESSTRADE_TIKTOK_SOURCE,
      }, dependencies);
      let received: TikTokPage;
      try {
        received = parsePage(response.data, { ...response.request, page });
      } catch (error) {
        if (dependencies.circuit !== false) {
          await recordDomainHealth(url.toString(), 'invalid_response', (dependencies.now || Date.now)(), {
            role: 'SOURCE_API', identityKey: ACCESSTRADE_TIKTOK_SOURCE,
          });
        }
        throw error;
      }
      if (dependencies.circuit !== false) {
        await recordDomainHealth(url.toString(), 'ok', (dependencies.now || Date.now)(), {
          role: 'SOURCE_API', identityKey: ACCESSTRADE_TIKTOK_SOURCE,
        });
      }
      requests.push(received.request);
      pageCount += 1;
      const pageProducts = received.products.slice(0, remainingRawBudget);
      fetched += pageProducts.length;
      for (let index = 0; index < pageProducts.length; index += 1) {
        const sourceItem = pageProducts[index];
        const item = record(sourceItem);
        const productId = item ? rawProductId(item) : '';
        const key = productId ? `id:${productId}` : `invalid:${page}:${index}`;
        const existing = rawProducts.get(key);
        const existingRecord = record(existing);
        if (existingRecord && item) { duplicates += 1; rawProducts.set(key, mergeRawProducts(existingRecord, item)); }
        else rawProducts.set(key, sourceItem);
      }
      sourceReliabilityEvent('accesstrade_tiktok_page_received', {
        provider: 'accesstrade', campaign: ACCESSTRADE_TIKTOK_SOURCE,
        reasonCode: `page:${page},fetched:${pageProducts.length},unique:${rawProducts.size}`,
        elapsedMs: received.request.durationMs,
      });
      const acceptedSoFar = [...rawProducts.values()].reduce<number>((count, raw) => count + Number(normalizeAccessTradeTikTokProduct(raw).ok), 0);
      nextPageTokenPresent = Boolean(received.nextPageToken);
      if (acceptedSoFar >= acceptedItemBudget) { stopReason = 'ACCEPTED_ITEM_BUDGET_REACHED'; break; }
      if (!pageProducts.length) { stopReason = 'EMPTY_PAGE'; break; }
      if (fetched >= rawItemBudget) { stopReason = 'RAW_ITEM_BUDGET_REACHED'; break; }
      if (!received.nextPageToken) { stopReason = 'NO_NEXT_PAGE_TOKEN'; break; }
      if (seenTokens.has(received.nextPageToken)) { stopReason = 'REPEATED_PAGE_TOKEN'; break; }
      seenTokens.add(received.nextPageToken);
      pageToken = received.nextPageToken;
      if (page >= maximumPages) stopReason = 'MAX_PAGES_REACHED';
    }

    const normalized: NormalizedAccessTradeTikTokProduct[] = [];
    let normalizedCount = 0;
    for (const raw of rawProducts.values()) {
      const result = normalizeAccessTradeTikTokProduct(raw);
      if (!result.ok) {
        rejectedByReason[result.reason] = (rejectedByReason[result.reason] || 0) + 1;
        continue;
      }
      normalizedCount += 1;
      if (normalized.length < acceptedItemBudget) normalized.push(result.product);
    }
    normalized.sort((left, right) => left.id.localeCompare(right.id));
    const diagnostics: AccessTradeTikTokSearchDiagnostics = {
      source: ACCESSTRADE_TIKTOK_SOURCE,
      fetched,
      normalized: normalizedCount,
      accepted: normalized.length,
      duplicates,
      rejectedByReason,
      pageCount,
      stopReason,
      durationMs: Math.max(0, (dependencies.now || Date.now)() - startedAt),
      rawItemBudget,
      acceptedItemBudget,
      maximumPages,
      nextPageTokenPresent,
      previewOnly: true,
      persisted: false,
    };
    sourceReliabilityEvent('accesstrade_tiktok_search_completed', {
      provider: 'accesstrade', campaign: ACCESSTRADE_TIKTOK_SOURCE,
      reasonCode: `fetched:${fetched},accepted:${normalized.length},duplicates:${duplicates},stop:${stopReason}`,
      elapsedMs: diagnostics.durationMs,
    });
    return { items: normalized, requests, diagnostics };
  } catch (error) {
    const request = error instanceof AccessTradeTikTokError ? error.request : undefined;
    sourceReliabilityEvent('accesstrade_tiktok_search_failed', {
      provider: 'accesstrade', campaign: ACCESSTRADE_TIKTOK_SOURCE,
      reasonCode: error instanceof AccessTradeTikTokError ? error.resultType : 'network_error',
      elapsedMs: Math.max(0, (dependencies.now || Date.now)() - startedAt), nextProbeAt: request?.retryAfter,
    });
    throw error;
  }
}

function trackingText(value: string | undefined): string | undefined {
  const result = String(value || '').trim().slice(0, ACCESSTRADE_TIKTOK_BOUNDS.maximumTrackingLength);
  return result || undefined;
}

export async function createAccessTradeTikTokAffiliateLink(
  input: AccessTradeTikTokCreateLinkInput,
  dependencies: AccessTradeTikTokClientDependencies = {},
): Promise<AccessTradeTikTokAffiliateLink> {
  if (!validUrl(input.productUrl)) {
    throw new AccessTradeTikTokError('client_error', 'TikTok product URL is invalid');
  }
  const body: UnknownRecord = { product_url: input.productUrl };
  const productId = text(input.productId, 200);
  if (productId) body.product_id = productId;
  const tracking = input.tracking || {};
  const optional: Array<[string, string | undefined]> = [
    ['utm_source', trackingText(tracking.utmSource)],
    ['utm_medium', trackingText(tracking.utmMedium)],
    ['utm_campaign', trackingText(tracking.utmCampaign)],
    ['utm_content', trackingText(tracking.utmContent)],
    ['sub_1', trackingText(tracking.sub1)],
    ['sub_2', trackingText(tracking.sub2)],
    ['sub_3', trackingText(tracking.sub3)],
    ['sub_4', trackingText(tracking.sub4)],
  ];
  for (const [key, value] of optional) if (value) body[key] = value;
  try {
    const response = await requestJson({
      endpoint: 'tiktok_create_link_v2', method: 'POST', url: new URL(ACCESSTRADE_TIKTOK_LINK_ENDPOINT), body,
      signal: input.signal, circuitRole: 'AFFILIATE_OPERATION', circuitIdentity: `${ACCESSTRADE_TIKTOK_SOURCE}:create_link`,
    }, dependencies);
    const envelope = record(response.data);
    const data = record(envelope?.data);
    if (!envelope || !data || envelope.status === false) {
      if (dependencies.circuit !== false) {
        await recordDomainHealth(ACCESSTRADE_TIKTOK_LINK_ENDPOINT, 'invalid_response', (dependencies.now || Date.now)(), {
          role: 'AFFILIATE_OPERATION', identityKey: `${ACCESSTRADE_TIKTOK_SOURCE}:create_link`,
        });
      }
      throw new AccessTradeTikTokError('schema_mismatch', 'AccessTrade TikTok affiliate response schema is invalid', {
        ...response.request, resultType: 'schema_mismatch', itemCount: 0,
      });
    }
    const shortUrl = text(data.aff_short_url, 4_096);
    const fullUrl = text(data.aff_url, 4_096);
    const sourceField = validUrl(shortUrl) && !sameUrl(shortUrl, input.productUrl)
      ? 'aff_short_url' as const
      : validUrl(fullUrl) && !sameUrl(fullUrl, input.productUrl) ? 'aff_url' as const : undefined;
    const url = sourceField === 'aff_short_url' ? shortUrl : sourceField === 'aff_url' ? fullUrl : '';
    if (!sourceField || !url) {
      if (dependencies.circuit !== false) {
        await recordDomainHealth(ACCESSTRADE_TIKTOK_LINK_ENDPOINT, 'invalid_response', (dependencies.now || Date.now)(), {
          role: 'AFFILIATE_OPERATION', identityKey: `${ACCESSTRADE_TIKTOK_SOURCE}:create_link`,
        });
      }
      throw new AccessTradeTikTokError('schema_mismatch', 'AccessTrade TikTok affiliate link is unavailable', {
        ...response.request, resultType: 'schema_mismatch', itemCount: 0,
      });
    }
    if (dependencies.circuit !== false) {
      await recordDomainHealth(ACCESSTRADE_TIKTOK_LINK_ENDPOINT, 'ok', (dependencies.now || Date.now)(), {
        role: 'AFFILIATE_OPERATION', identityKey: `${ACCESSTRADE_TIKTOK_SOURCE}:create_link`,
      });
    }
    const request = { ...response.request, resultType: 'success_with_results' as const, itemCount: 1 };
    const result = { url, sourceField, fetchedAt: new Date().toISOString(), attempts: request.attempts, request };
    sourceReliabilityEvent('accesstrade_tiktok_link_created', {
      provider: 'accesstrade', campaign: ACCESSTRADE_TIKTOK_SOURCE, domain: hostname(url),
      reasonCode: sourceField, elapsedMs: request.durationMs,
    });
    return result;
  } catch (error) {
    sourceReliabilityEvent('accesstrade_tiktok_link_failed', {
      provider: 'accesstrade', campaign: ACCESSTRADE_TIKTOK_SOURCE,
      reasonCode: error instanceof AccessTradeTikTokError ? error.resultType : 'network_error',
      nextProbeAt: error instanceof AccessTradeTikTokError ? error.request?.retryAfter : undefined,
    });
    throw error;
  }
}

export function withAccessTradeTikTokAffiliateLink(
  product: NormalizedAccessTradeTikTokProduct,
  link: AccessTradeTikTokAffiliateLink,
): NormalizedAccessTradeTikTokProduct {
  return {
    ...product,
    affiliateUrl: link.url,
    affiliateUrlSource: 'provider_api',
    affiliateUrlProvider: 'accesstrade',
    affiliateUrlSourceEndpoint: 'tiktok_create_link_v2',
    affiliateUrlSourceField: link.sourceField,
    affiliateUrlFetchedAt: link.fetchedAt,
    affiliateUrlStatus: 'available',
    affiliateState: 'CREATED',
    affiliateRequestAttempts: link.attempts,
    affiliateLinkReason: undefined,
    normalizationIssues: (product.normalizationIssues || []).filter(reason => reason !== 'MISSING_AFFILIATE_URL'),
    publicBlockReason: 'autonomous_assessment_pending',
    fieldProvenance: {
      ...(product.fieldProvenance || {}),
      affiliateUrl: {
        value: link.url,
        source: ACCESSTRADE_TIKTOK_SOURCE,
        provider: 'accesstrade',
        endpoint: 'tiktok_create_link_v2',
        sourceField: link.sourceField,
        fetchedAt: link.fetchedAt,
        canonicalizedAt: link.fetchedAt,
        verificationStatus: 'UNVERIFIED',
      },
    },
  };
}
