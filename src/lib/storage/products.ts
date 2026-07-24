// ===========================================
// Product Storage
// ===========================================

import type {
  Product,
  CreateProductInput,
  ProductFilters,
  ProductSourceDuplicateEvidence,
  ProductSourceMapping,
} from '../types';
import { createHash } from 'crypto';
import { readCollection, writeCollection, deleteOne, generateId, runTransaction } from './adapter';
import { normalizeProductForPublic } from '../productNormalizer';
import { isPublicSafeProduct } from '../publicProductFilter';
import { evaluateCanonicalProduct, normalizeCanonicalProduct, stableProductHash } from '../canonicalProduct';
import { isReviewIndexable } from '../editorialReview';
import { getOperationEnvironment, runGuardedOperation, sanitizeErrorMessage, type OperationEnvironment } from '../safety/operationGuard';
import { isStorageError } from './storageErrors';

const COLLECTION = 'products';
let productWriteChain: Promise<unknown> = Promise.resolve();

function withProductWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = productWriteChain.then(work, work);
  productWriteChain = next.then(() => undefined, () => undefined);
  return next;
}

async function readCanonicalProducts(): Promise<Product[]> {
  return (await readCollection<Partial<Product>>(COLLECTION)).map((item) => normalizeCanonicalProduct(item));
}

export class DuplicateProductError extends Error {
  readonly code = 'DUPLICATE_PRODUCT';
  readonly existingProductId: string;
  readonly existingProductUrl: string;
  readonly mergeResult: { updatedFields: string[]; unchangedFields: string[] };

  constructor(product: Product, mergeResult: { updatedFields: string[]; unchangedFields: string[] }) {
    super('duplicate_product');
    this.name = 'DuplicateProductError';
    this.existingProductId = product.id;
    this.existingProductUrl = `/dashboard/products/${encodeURIComponent(product.id)}`;
    this.mergeResult = mergeResult;
  }
}

function normalizedDuplicateUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|aff|affiliate|ref|source|campaign|clickid|subid)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return undefined;
  }
}

function duplicateKeys(product: Partial<Product>): Set<string> {
  const keys = new Set<string>();
  const sourceItemId = product.sourceItemId || product.sourceId || product.externalId;
  if (product.source && sourceItemId) keys.add(`source:${product.source}:${String(sourceItemId).trim().toLowerCase()}`);
  const canonicalUrl = normalizedDuplicateUrl(product.canonicalProductUrl || product.originalUrl);
  if (canonicalUrl) keys.add(`canonical:${canonicalUrl}`);
  const affiliateUrl = normalizedDuplicateUrl(product.affiliateUrl);
  if (affiliateUrl) keys.add(`affiliate:${affiliateUrl}`);
  const merchant = (product.merchantDomain || (() => {
    try { return canonicalUrl ? new URL(canonicalUrl).hostname : ''; } catch { return ''; }
  })()).toLowerCase();
  const title = product.title?.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Title is only a fallback when neither side has a stable source/URL key;
  // otherwise two variants sharing a merchant title must remain distinct.
  if (!keys.size && merchant && title && title.length >= 16) keys.add(`merchant-title:${merchant}:${title}`);
  return keys;
}

export function productsAreCanonicalDuplicates(left: Partial<Product>, right: Partial<Product>): boolean {
  const leftKeys = duplicateKeys(left);
  return [...duplicateKeys(right)].some(key => leftKeys.has(key));
}

function mergeDuplicateCandidate(existing: Product, candidate: CreateProductInput): { product: Product; updatedFields: string[]; unchangedFields: string[] } {
  const updates: Partial<Product> = {};
  const updatedFields: string[] = [];
  const unchangedFields: string[] = [];
  const fields: Array<keyof Product> = [
    'originalUrl', 'canonicalProductUrl', 'affiliateUrl', 'affiliateDestinationUrl',
    'imageUrl', 'price', 'salePrice', 'sourceId', 'sourceItemId', 'externalId', 'sourceEndpoint',
    'sourceFetchedAt', 'merchant', 'merchantDomain', 'rawSourceKind', 'sourceItemKind',
    'shopId', 'shopName', 'sku', 'providerUpdatedAt', 'sourceNormalizationIssues',
    'canonicalUrlSource', 'canonicalUrlProvider', 'canonicalUrlSourceEndpoint',
    'canonicalUrlSourceField', 'canonicalUrlFetchedAt', 'affiliateUrlSource',
    'affiliateUrlProvider', 'affiliateUrlSourceEndpoint', 'affiliateUrlSourceField',
    'affiliateUrlCampaignId', 'affiliateUrlFetchedAt', 'deepLinkSupported',
    'priceObservedAt',
  ];
  const sameSource = existing.source === candidate.source;
  const sourceIdentityFields = new Set<keyof Product>([
    'sourceId', 'sourceItemId', 'externalId', 'sourceEndpoint', 'sourceFetchedAt', 'rawSourceKind', 'sourceItemKind',
  ]);
  for (const field of fields) {
    const current = existing[field];
    const incoming = (candidate as Partial<Product>)[field];
    if (sourceIdentityFields.has(field) && !sameSource) {
      if (incoming !== undefined) unchangedFields.push(String(field));
      continue;
    }
    if ((current === undefined || current === null || current === '') && incoming !== undefined && incoming !== null && incoming !== '') {
      (updates as Record<string, unknown>)[field] = incoming;
      updatedFields.push(String(field));
    } else if (incoming !== undefined) {
      unchangedFields.push(String(field));
    }
  }
  if (sameSource && existing.source !== 'manual' && candidate.verifiedSource === true && existing.verifiedSource !== true) {
    updates.verifiedSource = true;
    updates.sourceVerified = true;
    updatedFields.push('verifiedSource');
  }
  if (sameSource && existing.source !== 'manual' && (candidate.sourceQualityScore || 0) > (existing.sourceQualityScore || 0)) {
    updates.sourceQualityScore = candidate.sourceQualityScore;
    updatedFields.push('sourceQualityScore');
  }
  const canonicalAdopted = updatedFields.includes('originalUrl') || updatedFields.includes('canonicalProductUrl');
  const affiliateAdopted = updatedFields.includes('affiliateUrl');
  const priceAdopted = updatedFields.includes('price') || updatedFields.includes('salePrice');
  if ((sameSource || canonicalAdopted) && existing.canonicalUrlStatus !== 'verified' && candidate.canonicalUrlStatus
    && (!existing.canonicalUrlStatus || existing.canonicalUrlStatus === 'unavailable')) {
    updates.canonicalUrlStatus = candidate.canonicalUrlStatus;
    updatedFields.push('canonicalUrlStatus');
  }
  if ((sameSource || affiliateAdopted) && existing.affiliateUrlStatus !== 'verified' && candidate.affiliateUrlStatus
    && (!existing.affiliateUrlStatus || existing.affiliateUrlStatus === 'unavailable')) {
    updates.affiliateUrlStatus = candidate.affiliateUrlStatus;
    updatedFields.push('affiliateUrlStatus');
  }
  if ((sameSource || priceAdopted) && existing.priceVerificationStatus !== 'VERIFIED' && candidate.priceVerificationStatus
    && (!existing.priceVerificationStatus || existing.priceVerificationStatus === 'MISSING')) {
    updates.priceVerificationStatus = candidate.priceVerificationStatus;
    updatedFields.push('priceVerificationStatus');
  }
  const mergedProvenance = { ...(existing.fieldProvenance || {}) };
  const adoptedProvenanceFields = new Set([
    ...(canonicalAdopted ? ['canonicalProductUrl'] : []),
    ...(affiliateAdopted ? ['affiliateUrl'] : []),
    ...(updatedFields.includes('imageUrl') ? ['imageUrl'] : []),
    ...(priceAdopted ? ['price'] : []),
  ]);
  let provenanceChanged = false;
  for (const [field, provenance] of Object.entries(candidate.fieldProvenance || {})) {
    const current = mergedProvenance[field];
    const currentVerified = current?.verificationStatus === 'VERIFIED';
    const incomingVerified = provenance.verificationStatus === 'VERIFIED';
    const protectsManualEvidence = !adoptedProvenanceFields.has(field)
      && (existing.source === 'manual' || current?.source === 'manual' || current?.provider === 'manual');
    const actualValue = field === 'canonicalProductUrl' ? existing.canonicalProductUrl || existing.originalUrl
      : field === 'affiliateUrl' ? existing.affiliateUrl
        : field === 'imageUrl' ? existing.imageUrl
          : field === 'price' ? existing.salePrice || existing.price
            : undefined;
    const incomingMatchesActual = actualValue === undefined || actualValue === null || actualValue === ''
      || String(actualValue) === String(provenance.value ?? '');
    if (!protectsManualEvidence && incomingMatchesActual
      && (!current || (!currentVerified && incomingVerified) || (!currentVerified && !current.value && provenance.value))) {
      mergedProvenance[field] = provenance;
      provenanceChanged = true;
      if (!updatedFields.includes(`fieldProvenance.${field}`)) updatedFields.push(`fieldProvenance.${field}`);
    }
  }
  if (provenanceChanged) updates.fieldProvenance = mergedProvenance;
  if (candidate.rawData) {
    const currentRaw = existing.rawData || {};
    const missingRawEntries = Object.entries(candidate.rawData).filter(([key, value]) =>
      value !== undefined && value !== null && value !== ''
      && (currentRaw[key] === undefined || currentRaw[key] === null || currentRaw[key] === ''));
    if (missingRawEntries.length) {
      updates.rawData = { ...currentRaw, ...Object.fromEntries(missingRawEntries) };
      updatedFields.push(...missingRawEntries.map(([key]) => `rawData.${key}`));
    }
  }
  return {
    product: updatedFields.length ? normalizeCanonicalProduct({ ...existing, ...updates, id: existing.id, updatedAt: new Date().toISOString() }) : existing,
    updatedFields,
    unchangedFields,
  };
}

/** List products with optional filters */
export async function listProducts(filters?: ProductFilters): Promise<Product[]> {
  let products = await readCanonicalProducts();

  if (!filters) return products;

  if (filters.q) {
    const q = filters.q.toLowerCase();
    products = products.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.description?.toLowerCase().includes(q)) ||
      ((Array.isArray(p.tags) ? p.tags : []).some(t => t.toLowerCase().includes(q)))
    );
  }
  if (filters.platform) {
    products = products.filter(p => p.platform === filters.platform);
  }
  if (filters.source) {
    products = products.filter(p => p.source === filters.source);
  }
  if (filters.status) {
    products = products.filter(p => p.status === filters.status);
  }
  if (filters.kind) {
    products = products.filter(p => p.kind === filters.kind);
  }
  if (filters.riskLevel) {
    products = products.filter(p => p.riskLevel === filters.riskLevel);
  }
  if (filters.minScore !== undefined) {
    products = products.filter(p => (p.score ?? 0) >= filters.minScore!);
  }

  return products;
}

export async function getAllProducts(): Promise<Product[]> {
  return readCanonicalProducts();
}

export async function getProductById(id: string): Promise<Product | null> {
  return (await readCanonicalProducts()).find((item) => item.id === id) ?? null;
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const products = await readCanonicalProducts();
  return products.find(p => p.slug === slug) ?? null;
}


export async function getPublishedProducts(): Promise<Product[]> {
  const products = await readCanonicalProducts();
  const filtered = products.filter(isPublicSafeProduct);
  // Normalize to ensure consistent public schema
  return filtered.map(p => normalizeProductForPublic(p));
}

export async function getPublicProducts(filters?: ProductFilters): Promise<Product[]> {
  let products = await readCanonicalProducts();
  if (filters) {
    // reuse existing listProducts filtering by delegating
    products = await listProducts(filters);
  }
  const filtered = products.filter(isPublicSafeProduct);
  return filtered.map(p => normalizeProductForPublic(p));
}

function requestsPublicProductState(updates: Partial<Product>): boolean {
  return updates.status === 'published' || updates.publicHidden === false || updates.autoPublished === true;
}

function invalidateChangedUrlHealth(
  previous: Product,
  updates: Partial<Product>,
  verifiedHealthUpdate = false,
): Partial<Product> {
  const originalUrlChanged = Object.prototype.hasOwnProperty.call(updates, 'originalUrl')
    && updates.originalUrl !== previous.originalUrl;
  const canonicalUrlChanged = Object.prototype.hasOwnProperty.call(updates, 'canonicalProductUrl')
    && updates.canonicalProductUrl !== previous.canonicalProductUrl;
  const productUrlChanged = originalUrlChanged || canonicalUrlChanged;
  const affiliateUrlChanged = Object.prototype.hasOwnProperty.call(updates, 'affiliateUrl')
    && updates.affiliateUrl !== previous.affiliateUrl;
  if ((!productUrlChanged && !affiliateUrlChanged) || verifiedHealthUpdate) return updates;
  const reasons = new Set(previous.publicBlockReasons || []);
  if (productUrlChanged) reasons.add('product_url_unhealthy');
  if (affiliateUrlChanged) reasons.add('affiliate_url_unhealthy');
  const reason = productUrlChanged && affiliateUrlChanged
    ? 'Product URL và affiliate URL đã thay đổi; bắt buộc kiểm tra lại.'
    : productUrlChanged
      ? 'Product URL đã thay đổi; bắt buộc kiểm tra lại.'
      : 'Affiliate URL đã thay đổi; bắt buộc kiểm tra lại.';
  return {
    ...updates,
    ...(productUrlChanged ? {
      linkHealthStatus: 'unknown' as const,
      linkLastCheckedAt: undefined,
      productUrlHttpStatus: undefined,
      productUrlFinalUrl: undefined,
      productUrlFinalDomain: undefined,
      productUrlHealthReason: reason,
      productUrlErrorCode: 'URL_CHANGED_RECHECK_REQUIRED',
      productUrlTimedOut: false,
      canonicalUrlVerifiedAt: undefined,
      canonicalUrlStatus: updates.canonicalProductUrl || updates.originalUrl ? 'unverified' as const : 'unavailable' as const,
    } : {}),
    ...(affiliateUrlChanged ? {
      affiliateHealthStatus: 'unknown' as const,
      affiliateLastCheckedAt: undefined,
      affiliateUrlHttpStatus: undefined,
      affiliateUrlFinalUrl: undefined,
      affiliateUrlFinalDomain: undefined,
      affiliateUrlHealthReason: reason,
      affiliateUrlErrorCode: 'URL_CHANGED_RECHECK_REQUIRED',
      affiliateUrlTimedOut: false,
      affiliateUrlVerifiedAt: undefined,
      affiliateUrlStatus: updates.affiliateUrl ? 'unverified' as const : 'unavailable' as const,
    } : {}),
    status: previous.status === 'archived' ? 'archived' : 'needs_review',
    publicHidden: true,
    publicBlocked: true,
    needsVerification: true,
    autoPublishEligible: false,
    publicDecision: previous.status === 'archived' ? previous.publicDecision : 'blocked',
    publicBlockReason: reason,
    publicBlockReasons: [...reasons],
    unpublishedReason: reason,
  };
}

export async function createProduct(data: CreateProductInput): Promise<Product> {
  if (requestsPublicProductState(data as Partial<Product>)) throw new Error('SAFE_PUBLISH_JOB_REQUIRED');
  return withProductWrite(async () => {
    let created: Product | null = null;
    let duplicate: { product: Product; updatedFields: string[]; unchangedFields: string[] } | null = null;
    await runTransaction<Partial<Product>>(COLLECTION, stored => {
      const products = stored.map(item => normalizeCanonicalProduct(item));
      const existingIndex = products.findIndex(item => productsAreCanonicalDuplicates(item, data));
      if (existingIndex >= 0) {
        duplicate = mergeDuplicateCandidate(products[existingIndex], data);
        if (duplicate.updatedFields.length) products[existingIndex] = duplicate.product;
        return duplicate.updatedFields.length ? products : undefined;
      }
      const id = generateId();
      const now = new Date().toISOString();
      created = normalizeCanonicalProduct({
        ...data,
        id,
        slug: ensureUniqueSlug(generateSlug(data.title), products, id),
        createdAt: now,
        updatedAt: now,
      });
      products.push(created);
      return products;
    });
    const duplicateResult = duplicate as { product: Product; updatedFields: string[]; unchangedFields: string[] } | null;
    if (duplicateResult) {
      try {
        await runTransaction<Record<string, unknown>>('product-duplicate-merge-audit', items => [...items.slice(-999), {
          id: generateId(),
          existingProductId: duplicateResult.product.id,
          source: data.source,
          sourceItemId: data.sourceItemId || data.sourceId || data.externalId,
          updatedFields: duplicateResult.updatedFields,
          unchangedFields: duplicateResult.unchangedFields,
          createdAt: new Date().toISOString(),
        }]);
      } catch (error) {
        console.error(JSON.stringify({
          type: 'product_duplicate_merge_audit_failed',
          productId: duplicateResult.product.id,
          reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'UNKNOWN_ERROR'),
        }));
      }
      throw new DuplicateProductError(duplicateResult.product, {
        updatedFields: duplicateResult.updatedFields,
        unchangedFields: duplicateResult.unchangedFields,
      });
    }
    if (!created) throw new Error('PRODUCT_CREATE_NOT_COMMITTED');
    return created;
  });
}

export class SourceCandidateMappingConflictError extends Error {
  readonly code = 'SOURCE_CANDIDATE_MAPPING_CONFLICT';
  constructor() {
    super('source_candidate_mapping_conflict');
    this.name = 'SourceCandidateMappingConflictError';
  }
}

export interface SourceCandidateMappingResult {
  canonicalProductId: string;
  canonicalIdentifier: string;
  outcome: 'CREATED' | 'EXISTING_ENRICHED' | 'EXISTING_UNCHANGED';
  duplicateEvidence: ProductSourceDuplicateEvidence[];
  enrichedFields: string[];
  unchangedFields: string[];
  preservedFields: string[];
  notUpdatedFields: Array<{
    field: string;
    reason: 'EXISTING_EVIDENCE_STRONGER' | 'EXISTING_VALUE_PRESERVED';
  }>;
  technicalFields: {
    updatedPaths: string[];
    unchangedPaths: string[];
  };
}

export interface SourceCandidateUpsertResult {
  product: Product;
  created: boolean;
  unchanged: boolean;
  mapping: SourceCandidateMappingResult;
}

const TRACKING_QUERY_KEYS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid']);

export function normalizeProductIdentityUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

function mappingDomain(normalizedUrl: string | null): string | undefined {
  if (!normalizedUrl) return undefined;
  try {
    return new URL(normalizedUrl).hostname;
  } catch {
    return undefined;
  }
}

function candidateEvidence(product: Product, source: Product['source'], sourceId: string, normalizedOriginalUrl: string | null): ProductSourceDuplicateEvidence[] {
  const evidence: ProductSourceDuplicateEvidence[] = [];
  const mappings = Array.isArray(product.sourceMappings) ? product.sourceMappings : [];
  if (
    (product.source === source && (product.sourceId === sourceId || product.externalId === sourceId))
    || mappings.some((mapping) => mapping.source === source && mapping.sourceId === sourceId)
  ) {
    evidence.push('SOURCE_ID_EXACT');
  }
  if (normalizedOriginalUrl) {
    const productUrls = [
      normalizeProductIdentityUrl(product.originalUrl),
      ...mappings.map((mapping) => mapping.normalizedOriginalUrl || normalizeProductIdentityUrl(mapping.originalUrl)),
    ].filter(Boolean);
    if (productUrls.includes(normalizedOriginalUrl)) evidence.push('CANONICAL_URL_EXACT');
  }
  return evidence;
}

function buildSourceMapping(
  draft: Partial<Product>,
  sourceId: string,
  originalUrl: string | undefined,
  normalizedOriginalUrl: string | null,
  duplicateEvidence: ProductSourceDuplicateEvidence[],
  previous: ProductSourceMapping | undefined,
  now: string,
): ProductSourceMapping {
  return {
    source: draft.source || 'other',
    sourceId,
    externalId: String(draft.externalId || sourceId),
    originalUrl: previous?.originalUrl || originalUrl,
    normalizedOriginalUrl: previous?.normalizedOriginalUrl || normalizedOriginalUrl || undefined,
    affiliateUrl: previous?.affiliateUrl || draft.affiliateUrl,
    merchant: previous?.merchant || draft.merchant,
    domain: previous?.domain || mappingDomain(normalizedOriginalUrl),
    duplicateEvidence: [...new Set([...(previous?.duplicateEvidence || []), ...duplicateEvidence])],
    sourceVerified: previous?.sourceVerified === true || draft.sourceVerified === true || draft.verifiedSource === true,
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
  };
}

function sourceCandidateEnrichmentLabel(field: string): string {
  const labels: Record<string, string> = {
    sourceId: 'mã bản ghi nguồn',
    sourceItemId: 'mã sản phẩm từ nguồn',
    externalId: 'mã đối chiếu nhà cung cấp',
    sourceEndpoint: 'điểm cuối nguồn',
    sourceFetchedAt: 'thời điểm lấy dữ liệu nguồn',
    rawSourceKind: 'phân loại gốc của nguồn',
    sourceItemKind: 'loại bản ghi nguồn',
    originalUrl: 'liên kết sản phẩm gốc',
    canonicalProductUrl: 'liên kết sản phẩm chuẩn',
    canonicalUrlStatus: 'trạng thái liên kết sản phẩm',
    canonicalUrlSource: 'nguồn liên kết sản phẩm',
    canonicalUrlProvider: 'nhà cung cấp liên kết sản phẩm',
    canonicalUrlSourceEndpoint: 'điểm cuối liên kết sản phẩm',
    canonicalUrlSourceField: 'trường liên kết sản phẩm',
    canonicalUrlFetchedAt: 'thời điểm lấy liên kết sản phẩm',
    imageUrl: 'ảnh sản phẩm',
    affiliateUrl: 'liên kết tiếp thị',
    affiliateDestinationUrl: 'đích liên kết tiếp thị',
    affiliateUrlStatus: 'trạng thái liên kết tiếp thị',
    affiliateUrlSource: 'nguồn liên kết tiếp thị',
    affiliateUrlProvider: 'nhà cung cấp liên kết tiếp thị',
    affiliateUrlSourceEndpoint: 'điểm cuối liên kết tiếp thị',
    affiliateUrlSourceField: 'trường liên kết tiếp thị',
    affiliateUrlCampaignId: 'mã chiến dịch tiếp thị',
    affiliateUrlFetchedAt: 'thời điểm lấy liên kết tiếp thị',
    deepLinkSupported: 'khả năng tạo deep-link',
    merchant: 'nhà bán',
    merchantDomain: 'miền nhà bán',
    shopId: 'mã gian hàng',
    shopName: 'tên gian hàng',
    sku: 'mã SKU',
    providerUpdatedAt: 'thời điểm nguồn cập nhật',
    sourceNormalizationIssues: 'ghi chú chuẩn hoá nguồn',
    price: 'giá từ nguồn',
    salePrice: 'giá khuyến mãi từ nguồn',
    priceObservedAt: 'thời điểm quan sát giá',
    priceVerificationStatus: 'trạng thái xác minh giá',
    verifiedSource: 'xác minh nguồn',
    sourceQualityScore: 'điểm chất lượng nguồn',
  };
  if (field.startsWith('fieldProvenance.')) {
    return `bằng chứng nguồn cho ${sourceCandidateEnrichmentLabel(field.slice('fieldProvenance.'.length))}`;
  }
  if (field.startsWith('rawData.')) return 'metadata nguồn còn thiếu';
  return labels[field] || 'dữ liệu nguồn bổ sung';
}

function sourceCandidateOperatorFields(fields: string[]): string[] {
  return [...new Set(fields.map(sourceCandidateEnrichmentLabel))];
}

function sourceCandidateNotUpdatedFields(existing: Product, fields: string[]) {
  const evidenceField = (path: string): string => {
    if (path.startsWith('fieldProvenance.')) return path.slice('fieldProvenance.'.length);
    if (['originalUrl', 'canonicalProductUrl', 'canonicalUrlStatus'].includes(path)) return 'canonicalProductUrl';
    if (path.startsWith('affiliate')) return 'affiliateUrl';
    if (path === 'imageUrl') return 'imageUrl';
    if (['price', 'salePrice', 'priceVerificationStatus', 'priceObservedAt'].includes(path)) return 'price';
    return path;
  };
  const unique = new Map<string, 'EXISTING_EVIDENCE_STRONGER' | 'EXISTING_VALUE_PRESERVED'>();
  for (const path of fields) {
    const field = sourceCandidateEnrichmentLabel(path);
    const provenance = existing.fieldProvenance?.[evidenceField(path)];
    const reason = provenance?.verificationStatus === 'VERIFIED'
      ? 'EXISTING_EVIDENCE_STRONGER'
      : 'EXISTING_VALUE_PRESERVED';
    if (!unique.has(field) || reason === 'EXISTING_EVIDENCE_STRONGER') unique.set(field, reason);
  }
  return [...unique].map(([field, reason]) => ({ field, reason }));
}

/**
 * Resolves a source candidate by exact source identity or exact canonical URL.
 * Titles, keywords and affiliate URLs are deliberately excluded from identity.
 */
export async function upsertSourceCandidateProduct(draft: Partial<Product>): Promise<SourceCandidateUpsertResult> {
  if (requestsPublicProductState(draft)) throw new Error('SAFE_PUBLISH_JOB_REQUIRED');
  const sourceId = String(draft.sourceId || draft.externalId || '').trim().slice(0, 240);
  if (!sourceId || !draft.source || !draft.title) throw new Error('SOURCE_CANDIDATE_IDENTITY_REQUIRED');
  const source = draft.source;

  return withProductWrite(async () => {
    const affiliateIdentity = normalizeProductIdentityUrl(draft.affiliateUrl);
    const requestedOriginal = typeof draft.originalUrl === 'string' ? draft.originalUrl : undefined;
    const normalizedRequestedOriginal = normalizeProductIdentityUrl(requestedOriginal);
    // An affiliate/tracking URL is evidence metadata, never a canonical identity.
    const originalUrl = normalizedRequestedOriginal && normalizedRequestedOriginal !== affiliateIdentity ? requestedOriginal : undefined;
    const normalizedOriginalUrl = originalUrl ? normalizedRequestedOriginal : null;
    let result: SourceCandidateUpsertResult | null = null;
    let audit: {
      productId: string;
      duplicateEvidence: ProductSourceDuplicateEvidence[];
      updatedFields: string[];
      unchangedFields: string[];
      createdAt: string;
    } | null = null;

    // This storage transaction is the cross-process idempotency boundary. Two
    // concurrent saves re-evaluate identity against the same committed
    // revision; only one can create the canonical product.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = null;
      audit = null;
      try {
        await runTransaction<Partial<Product>>(COLLECTION, stored => {
          const products = stored.map(item => normalizeCanonicalProduct(item));
          const matches: Array<{ index: number; evidence: ProductSourceDuplicateEvidence[] }> = [];
          for (let index = 0; index < products.length; index += 1) {
            const evidence = candidateEvidence(products[index], source, sourceId, normalizedOriginalUrl);
            if (evidence.length) matches.push({ index, evidence });
          }
          if (matches.length > 1) throw new SourceCandidateMappingConflictError();
          const matchIndex = matches[0]?.index ?? -1;
          const duplicateEvidence = matches[0]?.evidence || [];
          const now = new Date().toISOString();

          if (matchIndex < 0) {
            const id = generateId();
            const sourceMapping = buildSourceMapping(draft, sourceId, originalUrl, normalizedOriginalUrl, [], undefined, now);
            const product = normalizeCanonicalProduct({
              ...draft,
              sourceId,
              externalId: String(draft.externalId || sourceId),
              originalUrl,
              sourceMappings: [sourceMapping],
              id,
              slug: ensureUniqueSlug(generateSlug(String(draft.title)), products, id),
              createdAt: now,
              updatedAt: now,
            });
            products.push(product);
            result = {
              product,
              created: true,
              unchanged: false,
              mapping: {
                canonicalProductId: product.id,
                canonicalIdentifier: product.id.slice(0, 8),
                outcome: 'CREATED',
                duplicateEvidence: [],
                enrichedFields: [],
                unchangedFields: [],
                preservedFields: [],
                notUpdatedFields: [],
                technicalFields: { updatedPaths: [], unchangedPaths: [] },
              },
            };
            return products;
          }

          const existing = products[matchIndex];
          const mappings = Array.isArray(existing.sourceMappings) ? existing.sourceMappings : [];
          const mappingIndex = mappings.findIndex((mapping) => mapping.source === draft.source && mapping.sourceId === sourceId);
          const nextMapping = buildSourceMapping(
            draft,
            sourceId,
            originalUrl,
            normalizedOriginalUrl,
            duplicateEvidence,
            mappingIndex >= 0 ? mappings[mappingIndex] : undefined,
            now,
          );
          const nextMappings = [...mappings];
          if (mappingIndex >= 0) nextMappings[mappingIndex] = nextMapping;
          else nextMappings.push(nextMapping);

          // Only missing values or stronger evidence are adopted. Existing verified
          // evidence remains authoritative and every decision is returned/audited.
          const duplicateMerge = mergeDuplicateCandidate(existing, draft as CreateProductInput);
          const enrichedFields = sourceCandidateOperatorFields(duplicateMerge.updatedFields);
          const preservedFields = sourceCandidateOperatorFields(duplicateMerge.unchangedFields);
          const mappingChanged = mappingIndex < 0 || JSON.stringify(mappings[mappingIndex]) !== JSON.stringify(nextMapping);
          const changed = duplicateMerge.updatedFields.length > 0 || mappingChanged;
          const merged = normalizeCanonicalProduct({
            ...duplicateMerge.product,
            id: existing.id,
            sourceMappings: nextMappings,
            updatedAt: changed ? now : existing.updatedAt,
          });
          products[matchIndex] = merged;
          result = {
            product: merged,
            created: false,
            unchanged: enrichedFields.length === 0,
            mapping: {
              canonicalProductId: merged.id,
              canonicalIdentifier: merged.id.slice(0, 8),
              outcome: enrichedFields.length ? 'EXISTING_ENRICHED' : 'EXISTING_UNCHANGED',
              duplicateEvidence,
              enrichedFields,
              unchangedFields: duplicateMerge.unchangedFields,
              preservedFields,
              notUpdatedFields: sourceCandidateNotUpdatedFields(existing, duplicateMerge.unchangedFields),
              technicalFields: {
                updatedPaths: duplicateMerge.updatedFields,
                unchangedPaths: duplicateMerge.unchangedFields,
              },
            },
          };
          audit = {
            productId: merged.id,
            duplicateEvidence,
            updatedFields: duplicateMerge.updatedFields,
            unchangedFields: duplicateMerge.unchangedFields,
            createdAt: now,
          };
          return changed ? products : undefined;
        });
        break;
      } catch (error) {
        const retryableConflict = isStorageError(error) && error.code === 'MONGO_TRANSACTION_CONFLICT';
        if (!retryableConflict || attempt === 2) throw error;
      }
    }

    const committedResult = result as SourceCandidateUpsertResult | null;
    if (!committedResult) throw new Error('SOURCE_CANDIDATE_UPSERT_NOT_COMMITTED');
    const committedAudit = audit as {
      productId: string;
      duplicateEvidence: ProductSourceDuplicateEvidence[];
      updatedFields: string[];
      unchangedFields: string[];
      createdAt: string;
    } | null;
    if (!committedAudit) return committedResult;
    try {
      await runTransaction<Record<string, unknown>>('product-duplicate-merge-audit', items => [...items.slice(-999), {
        id: generateId(),
        existingProductId: committedAudit.productId,
        source: draft.source,
        sourceItemId: sourceId,
        duplicateEvidence: committedAudit.duplicateEvidence,
        updatedFields: committedAudit.updatedFields,
        unchangedFields: committedAudit.unchangedFields,
        createdAt: committedAudit.createdAt,
      }]);
    } catch (error) {
      console.error(JSON.stringify({
        type: 'product_duplicate_merge_audit_failed',
        productId: committedAudit.productId,
        reasonCode: sanitizeErrorMessage(error instanceof Error ? error.message : 'UNKNOWN_ERROR'),
      }));
    }
    return committedResult;
  });
}

export async function updateProduct(id: string, updates: Partial<Product>): Promise<Product | null> {
  if (requestsPublicProductState(updates)) throw new Error('SAFE_PUBLISH_JOB_REQUIRED');
  return saveCanonicalProduct(id, updates);
}

export async function saveCanonicalProduct(
  id: string,
  updates: Partial<Product>,
  options: { evaluate?: boolean; verifiedHealthUpdate?: boolean } = {},
): Promise<Product | null> {
  if (options.evaluate === true) throw new Error('SAFE_PUBLISH_JOB_REQUIRED');
  return withProductWrite(async () => {
    let saved: Product | null = null;
    await runTransaction<Partial<Product>>(COLLECTION, stored => {
      const products = stored.map(item => normalizeCanonicalProduct(item));
      const index = products.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const alreadyPublic = products[index].status === 'published' && products[index].publicHidden === false;
      if (requestsPublicProductState(updates) && !alreadyPublic) throw new Error('SAFE_PUBLISH_JOB_REQUIRED');
      const now = new Date().toISOString();
      const guardedUpdates = invalidateChangedUrlHealth(products[index], updates, options.verifiedHealthUpdate === true);
      const merged = { ...products[index], ...guardedUpdates, id, updatedAt: now };
      const before = JSON.stringify({ ...products[index], updatedAt: undefined });
      const after = JSON.stringify({ ...merged, updatedAt: undefined });
      if (before === after) {
        saved = products[index];
        return undefined;
      }
      products[index] = normalizeCanonicalProduct(merged, now);
      saved = products[index];
      return products;
    });
    return saved;
  });
}

export async function upsertCanonicalProduct(
  draft: Partial<Product>,
  options: { evaluate?: boolean; verifiedHealthUpdate?: boolean } = {},
): Promise<{ product: Product; created: boolean; unchanged: boolean }> {
  if (requestsPublicProductState(draft) || options.evaluate === true) throw new Error('SAFE_PUBLISH_JOB_REQUIRED');
  return withProductWrite(async () => {
    let output: { product: Product; created: boolean; unchanged: boolean } | null = null;
    await runTransaction<Partial<Product>>(COLLECTION, stored => {
      const products = stored.map(item => normalizeCanonicalProduct(item));
      const sourceId = String(draft.sourceId || draft.externalId || '');
      const hash = draft.sourceHash || draft.contentHash || stableProductHash(draft);
      const index = products.findIndex((item) =>
        (sourceId && item.source === draft.source && (item.sourceId === sourceId || item.externalId === sourceId)) ||
        (draft.originalUrl && item.originalUrl === draft.originalUrl) ||
        (draft.affiliateUrl && item.affiliateUrl === draft.affiliateUrl),
      );
      if (index >= 0 && products[index].sourceHash === hash) {
        output = { product: products[index], created: false, unchanged: true };
        return undefined;
      }
      const now = new Date().toISOString();
      if (index >= 0) {
        const sourceChanged = products[index].sourceHash !== hash;
        const staleReview = sourceChanged && products[index].reviewContent
          ? { ...products[index].reviewContent, reviewStatus: 'stale' as const }
          : products[index].reviewContent;
        const guardedDraft = invalidateChangedUrlHealth(products[index], draft, options.verifiedHealthUpdate === true);
        const merged = { ...products[index], ...guardedDraft, reviewContent: draft.reviewContent || staleReview, id: products[index].id, sourceHash: hash, contentHash: hash, updatedAt: now };
        products[index] = normalizeCanonicalProduct(merged, now);
        output = { product: products[index], created: false, unchanged: false };
        return products;
      }
      const requestedSlug = draft.slug || generateStableSlug(String(draft.title || 'san-pham'), hash);
      const uniqueSlug = ensureUniqueSlug(requestedSlug, products, hash);
      const base = {
        ...draft,
        id: String(draft.id || generateId()),
        slug: uniqueSlug,
        sourceHash: hash,
        contentHash: hash,
        createdAt: now,
        updatedAt: now,
      };
      const product = normalizeCanonicalProduct(base, now);
      products.push(product);
      output = { product, created: true, unchanged: false };
      return products;
    });
    if (!output) throw new Error('PRODUCT_UPSERT_NOT_COMMITTED');
    return output;
  });
}

export interface PublicationOperationContext {
  runId?: string;
  candidateId?: string;
  actor?: string;
  environment?: OperationEnvironment;
  jobId?: string;
  workerId?: string;
  operationId?: string;
  /** @deprecated A caller-provided boolean is not accepted as publish approval. */
  approval?: boolean;
  dryRun?: boolean;
  idempotencyKey?: string;
  publicationEffectKey?: string;
}

async function requireDurablePublishAuthorization(
  productId: string,
  context: PublicationOperationContext,
) {
  if (!context.jobId || !context.workerId) throw new Error('SAFE_PUBLISH_JOB_REQUIRED');
  const [{ getAutomationControl, getAutomationJob }, { getAutomationSettings }] = await Promise.all([
    import('../automation/store'),
    import('./automationSettings'),
  ]);
  const [job, control, settings] = await Promise.all([
    getAutomationJob(context.jobId),
    getAutomationControl(),
    getAutomationSettings(),
  ]);
  if (control.killSwitch) throw new Error('KILL_SWITCH_ACTIVE');
  if (!settings.safePublish || !settings.freeOnly || settings.allowPaidAi) {
    throw new Error('SAFE_PUBLISH_POLICY_BLOCKED');
  }
  if (control.publishPaused) throw new Error('PUBLISH_LANE_PAUSED');
  if (!settings.launchEnabled) throw new Error('PUBLISH_LAUNCH_DISABLED');
  if (!['CANARY', 'AUTONOMOUS'].includes(control.effectiveMode)) throw new Error('PUBLISH_MODE_BLOCKED');
  if (!job || !['SAFE_PUBLISH', 'AUTO_SAFE_PUBLISH'].includes(job.type) || job.status !== 'RUNNING') {
    throw new Error('PUBLISH_JOB_INVALID');
  }
  if (job.dryRun || context.dryRun) throw new Error('DRY_RUN_PUBLISH_BLOCKED');
  if (job.claimedBy !== context.workerId) throw new Error('PUBLISH_WORKER_MISMATCH');
  if (job.workerInstanceId && job.workerFencingToken) {
    const { isRuntimeRoleOwner } = await import('../automation/runtimeRoles');
    const ownsCurrentLease = await isRuntimeRoleOwner('WORKER', {
      ownerId: job.workerOwnerId || '',
      instanceId: job.workerInstanceId,
      fencingToken: job.workerFencingToken,
    });
    if (!ownsCurrentLease) throw new Error('WORKER_FENCING_REJECTED');
  }
  if (job.type === 'SAFE_PUBLISH') {
    if (job.approvalStatus !== 'APPROVED' || !job.approvedBy) throw new Error('APPROVAL_REQUIRED');
    if (job.approvalExpiresAt && Date.parse(job.approvalExpiresAt) <= Date.now()) throw new Error('APPROVAL_EXPIRED');
  } else {
    const { getAutomationPolicy } = await import('../automation/policyRegistry');
    const policy = getAutomationPolicy('AUTO_SAFE_PUBLISH');
    if (!policy.autonomousAllowed || policy.publishPermission !== 'AUTONOMOUS_GUARDED' || policy.approvalMode !== 'NEVER') throw new Error('AUTONOMOUS_PUBLISH_POLICY_BLOCKED');
    if (job.riskLevel !== 'LOW' || job.approvalStatus !== 'NOT_REQUIRED') throw new Error('AUTONOMOUS_RISK_BLOCKED');
    if (!['scheduler', 'autonomous-reconciler', 'autopilot-worker'].includes(job.requestedBy)) throw new Error('AUTONOMOUS_ACTOR_BLOCKED');
  }
  if (job.payload.productId !== productId) throw new Error('SAFE_PUBLISH_TARGET_MISMATCH');
  if (context.idempotencyKey && context.idempotencyKey !== job.idempotencyKey) {
    throw new Error('SAFE_PUBLISH_IDEMPOTENCY_MISMATCH');
  }
  return { job, actor: job.type === 'SAFE_PUBLISH' ? job.approvedBy! : context.workerId, autonomous: job.type === 'AUTO_SAFE_PUBLISH' };
}

export function publicationIdempotencyKey(product: Product): string {
  const gateState = JSON.stringify({
    id: product.id,
    sourceHash: product.sourceHash || product.contentHash || '',
    reviewHash: product.reviewContent?.reviewContentHash || '',
    reviewStatus: product.reviewContent?.reviewStatus || '',
    linkHealthStatus: product.linkHealthStatus || '',
    affiliateHealthStatus: product.affiliateHealthStatus || '',
    imageHealthStatus: product.imageHealthStatus || '',
    riskLevel: product.riskLevel,
    verifiedSource: product.verifiedSource === true,
    autoPublishEligible: product.autoPublishEligible === true,
    publicBlockReasons: product.publicBlockReasons || [],
    status: product.status,
  });
  return createHash('sha256').update(gateState).digest('hex');
}

export async function publishCanonicalProductTransaction(id: string, updates: Partial<Product>, audit: PublicationOperationContext = {}): Promise<Product | null> {
  return withProductWrite(async () => {
    const authorization = await requireDurablePublishAuthorization(id, audit);
    const job = authorization.job;
    const products = await readCanonicalProducts(); const index = products.findIndex((item) => item.id === id); if (index < 0) return null;
    const previous = products[index]; const now = new Date().toISOString();
    const publicationEffectKey = audit.publicationEffectKey || job.idempotencyKey;
    if (previous.publicationEffectKey === publicationEffectKey && previous.status === 'published' && previous.publicHidden === false) return previous;
    if (authorization.autonomous && previous.lifecycleState !== 'PUBLISHING') {
      throw new Error('AUTONOMOUS_LIFECYCLE_NOT_PUBLISHING');
    }
    const requestedSlug = updates.slug || previous.slug || generateStableSlug(previous.title, previous.sourceHash || previous.id);
    const candidate = evaluateCanonicalProduct({
      ...previous,
      ...updates,
      id,
      publicationEffectKey,
      publicationJobId: job.id,
      lifecycleState: authorization.autonomous ? 'PUBLISHING' : 'PUBLISHED',
      lifecycleUpdatedAt: authorization.autonomous ? previous.lifecycleUpdatedAt : now,
      slug: ensureUniqueSlug(requestedSlug, products.filter((item) => item.id !== id), previous.sourceHash || previous.id),
      updatedAt: now,
    }, now);
    const guarded = await runGuardedOperation({
      operationType: 'safe_publish',
      operationId: job.operationId,
      actor: authorization.actor,
      environment: audit.environment || getOperationEnvironment(),
      target: id,
      approval: true,
      riskLevel: candidate.status === 'published' ? 'HIGH' : 'MEDIUM',
      dryRun: audit.dryRun,
      idempotencyKey: job.idempotencyKey,
    }, async () => {
      let committed = false;
      try {
        await runTransaction<Partial<Product>>(COLLECTION, stored => {
          const currentProducts = stored.map(item => normalizeCanonicalProduct(item));
          const currentIndex = currentProducts.findIndex(item => item.id === id);
          if (currentIndex < 0) throw new Error('canonical_product_disappeared');
          if (currentProducts[currentIndex].updatedAt !== previous.updatedAt) throw new Error('PRODUCT_CHANGED_DURING_PUBLISH');
          currentProducts[currentIndex] = candidate;
          committed = true;
          return currentProducts;
        });
        const confirmed = (await readCanonicalProducts()).find((item) => item.id === id);
        if (!confirmed) throw new Error('canonical_readback_failed');
        // Autonomous publication remains fail-closed while the durable lifecycle
        // transition is PUBLISHING. Validate the state that becomes visible only
        // after the worker finalizes PUBLISHING -> PUBLISHED.
        const publicProjection = authorization.autonomous && confirmed.lifecycleState === 'PUBLISHING'
          ? { ...confirmed, lifecycleState: 'PUBLISHED' as const }
          : confirmed;
        if (candidate.status === 'published' && (!isPublicSafeProduct(publicProjection) || !isReviewIndexable(confirmed))) throw new Error('public_selector_inconsistent');
        await appendPublicationAudit({ operationId: job.operationId, runId: audit.runId || job.id, candidateId: audit.candidateId, productId: id, action: candidate.status === 'published' ? 'published' : 'publish_blocked', previousState: previous.status, nextState: candidate.status, reasonCodes: candidate.publicBlockReasons || [], sourceHash: candidate.sourceHash, reviewVersion: candidate.reviewContent?.reviewVersion, riskLevel: candidate.status === 'published' ? 'HIGH' : 'MEDIUM', dryRun: false, timestamp: now });
        return confirmed;
      } catch (error) {
        if (committed) {
          await runTransaction<Partial<Product>>(COLLECTION, stored => {
            const currentProducts = stored.map(item => normalizeCanonicalProduct(item));
            const currentIndex = currentProducts.findIndex(item => item.id === id);
            if (currentIndex < 0) return undefined;
            const current = currentProducts[currentIndex];
            if (current.publicationEffectKey !== publicationEffectKey || current.updatedAt !== candidate.updatedAt) return undefined;
            currentProducts[currentIndex] = previous;
            return currentProducts;
          });
        }
        await appendPublicationAudit({ operationId: job.operationId, runId: audit.runId || job.id, candidateId: audit.candidateId, productId: id, action: 'rolled_back', previousState: previous.status, nextState: previous.status, reasonCodes: [sanitizeErrorMessage(error instanceof Error ? error.message : 'publication_error')], sourceHash: previous.sourceHash, reviewVersion: previous.reviewContent?.reviewVersion, riskLevel: 'HIGH', dryRun: false, timestamp: now });
        throw error;
      }
    });
    return guarded.status === 'COMPLETED' ? guarded.value : previous;
  });
}

interface PublicationAudit { operationId?: string; runId: string; candidateId?: string; productId: string; action: string; previousState: string; nextState: string; reasonCodes: string[]; sourceHash?: string; reviewVersion?: number; riskLevel: 'MEDIUM' | 'HIGH'; dryRun: boolean; timestamp: string; }
async function appendPublicationAudit(event: PublicationAudit): Promise<void> {
  await runTransaction<PublicationAudit>('publication-audit', (existing) => [...existing.slice(-999), event]);
}

function generateStableSlug(title: string, seed: string): string {
  const base = slugBase(title) || 'san-pham';
  return `${base}-${String(seed).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10) || 'product'}`.slice(0, 96);
}
function ensureUniqueSlug(requested: string, products: Product[], seed: string): string {
  const normalized = slugBase(requested) || generateStableSlug('san-pham', seed);
  if (!products.some((item) => item.slug === normalized)) return normalized;
  const suffix = String(seed).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'duplicate';
  const candidate = `${normalized.slice(0, Math.max(1, 95 - suffix.length))}-${suffix}`;
  return products.some((item) => item.slug === candidate) ? '' : candidate;
}
function slugBase(title: string): string { return title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }

export async function deleteProduct(id: string): Promise<boolean> {
  return deleteOne<Product>(COLLECTION, id);
}

export async function approveProduct(id: string): Promise<Product | null> {
  return updateProduct(id, { status: 'approved' });
}

export async function archiveProduct(id: string): Promise<Product | null> {
  return updateProduct(id, { status: 'archived' });
}

export async function getProductStats(): Promise<{
  total: number;
  draft: number;
  needsReview: number;
  approved: number;
  published: number;
  archived: number;
}> {
  const products = await readCanonicalProducts();
  return {
    total: products.length,
    draft: products.filter(p => p.status === 'draft').length,
    needsReview: products.filter(p => p.status === 'needs_review').length,
    approved: products.filter(p => p.status === 'approved').length,
    published: products.filter(p => p.status === 'published').length,
    archived: products.filter(p => p.status === 'archived').length,
  };
}

/** Generate URL-safe slug from title */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) + '-' + Date.now().toString(36);
}

/** Seed some sample products for development */
export async function seedSampleProducts(): Promise<void> {
  const existing = await readCollection<Product>(COLLECTION);
  if (existing.length > 0) return;

  const now = new Date().toISOString();
  const samples: Product[] = [
    {
      id: generateId(),
      title: 'Tai nghe Bluetooth TWS Pro Max',
      slug: 'tai-nghe-bluetooth-tws-pro-max-' + Date.now().toString(36),
      description: 'Tai nghe không dây chống ồn, pin 30 giờ, phù hợp nghe nhạc và họp online.',
      kind: 'product',
      platform: 'shopee',
      source: 'manual',
      originalUrl: 'https://shopee.vn/product/example1',
      affiliateUrl: '',
      imageUrl: '',
      gallery: [],
      price: 299000,
      salePrice: 179000,
      currency: 'VND',
      priceNote: 'Giá có thể thay đổi theo thời gian',
      category: 'Công nghệ',
      tags: ['tai nghe', 'bluetooth', 'giảm giá'],
      benefits: ['Chống ồn chủ động', 'Pin 30 giờ', 'Kết nối Bluetooth 5.3'],
      painPoints: ['Muốn nghe nhạc không dây', 'Cần tai nghe cho họp online'],
      targetAudience: ['Dân văn phòng', 'Sinh viên'],
      warnings: [],
      contentAngles: ['Review trung thực', 'So sánh giá'],
      complianceNotes: [],
      affiliateSource: 'shopee',
      score: 72,
      scoreLabel: 'Ưu tiên cao',
      scoreReasons: ['Có hình ảnh', 'Có link affiliate', 'Giá hấp dẫn'],
      scoreWarnings: [],
      riskLevel: 'low',
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId(),
      title: 'Bộ dưỡng da Vitamin C serum',
      slug: 'bo-duong-da-vitamin-c-serum-' + Date.now().toString(36),
      description: 'Serum dưỡng sáng da, giúp da đều màu theo thông tin nhà sản xuất.',
      kind: 'product',
      platform: 'tiktok_shop',
      source: 'manual',
      originalUrl: 'https://tiktok.com/shop/example2',
      affiliateUrl: '',
      imageUrl: '',
      gallery: [],
      price: 189000,
      salePrice: 142000,
      currency: 'VND',
      category: 'Làm đẹp',
      tags: ['skincare', 'vitamin c', 'serum'],
      benefits: ['Dưỡng sáng da', 'Giúp da đều màu'],
      warnings: [],
      riskLevel: 'medium',
      status: 'needs_review',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId(),
      title: 'Balo laptop chống nước 15.6 inch',
      slug: 'balo-laptop-chong-nuoc-' + Date.now().toString(36),
      description: 'Balo đựng laptop chống nước, nhiều ngăn tiện dụng cho dân văn phòng.',
      kind: 'product',
      platform: 'lazada',
      source: 'manual',
      originalUrl: 'https://lazada.vn/products/example3',
      affiliateUrl: '',
      imageUrl: '',
      gallery: [],
      price: 450000,
      salePrice: 380000,
      currency: 'VND',
      category: 'Phụ kiện',
      tags: ['balo', 'laptop', 'chống nước'],
      benefits: ['Chống nước', 'Nhiều ngăn tiện dụng', 'Phù hợp laptop 15.6 inch'],
      warnings: [],
      riskLevel: 'low',
      status: 'approved',
      createdAt: now,
      updatedAt: now,
    },
  ];

  await writeCollection(COLLECTION, samples);
}
