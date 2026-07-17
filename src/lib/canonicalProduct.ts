import { createHash } from 'crypto';
import type { Product } from './types';
import { applySafePublishDecision } from './safePublish';
import { normalizeReviewContent } from './editorialReview';

const VALID_KINDS = new Set(['product', 'voucher', 'campaign', 'deal', 'store_offer', 'unknown']);
const VALID_STATUSES = new Set(['draft', 'needs_review', 'approved', 'published', 'archived']);

function legacyRecordType(input: Partial<Product>): NonNullable<Product['recordType']> {
  if (input.recordType) return input.recordType;
  if (input.kind === 'product' || input.kind === 'deal') return 'PRODUCT';
  if (input.kind === 'voucher') return 'VOUCHER';
  if (input.kind === 'campaign') return 'CAMPAIGN';
  if (input.kind === 'store_offer') return 'STORE_PROMOTION';
  return 'UNKNOWN';
}

function legacyLifecycle(input: Partial<Product>, safelyPublished: boolean): NonNullable<Product['lifecycleState']> {
  if (input.lifecycleState) return input.lifecycleState;
  if (safelyPublished) return 'PUBLISHED';
  if (input.status === 'archived') return 'HIDDEN';
  if (input.status === 'approved') return 'READY_FOR_PUBLISH';
  return 'STAGED';
}

export function stableProductHash(product: Partial<Product>): string {
  const value = JSON.stringify({
    source: product.source || '', sourceId: product.sourceId || product.externalId || '',
    title: String(product.title || '').trim(), price: product.price || 0,
    salePrice: product.salePrice || 0, originalUrl: product.originalUrl || '',
    affiliateUrl: product.affiliateUrl || '', imageUrl: product.imageUrl || '',
    category: product.category || '', brand: product.brand || '', sku: product.sku || '',
    gtin: product.gtin || '', mpn: product.mpn || '', specifications: product.specifications || {},
  });
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeCanonicalProduct(input: Partial<Product>, now = new Date().toISOString()): Product {
  const legacyPublished = input.status === 'published';
  const safelyPublished = legacyPublished && input.publicHidden === false && input.needsVerification === false;
  const kind = VALID_KINDS.has(String(input.kind)) ? input.kind! : 'unknown';
  const status = VALID_STATUSES.has(String(input.status)) ? input.status! : 'needs_review';
  const reviewContent = normalizeReviewContent(input.reviewContent, input.sourceHash || input.contentHash || '');
  return {
    ...input,
    schemaVersion: 2,
    id: String(input.id || ''),
    title: String(input.title || '').trim(),
    slug: String(input.slug || ''),
    kind,
    platform: input.platform || 'other',
    source: input.source || 'other',
    currency: 'VND',
    tags: Array.isArray(input.tags) ? input.tags : [],
    benefits: Array.isArray(input.benefits) ? input.benefits : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    riskLevel: input.riskLevel || 'unknown',
    status: safelyPublished ? 'published' : (status === 'published' ? 'needs_review' : status),
    recordType: legacyRecordType(input),
    lifecycleState: legacyLifecycle(input, safelyPublished),
    lifecycleVersion: input.lifecycleVersion || 'product-lifecycle-v1',
    lifecycleUpdatedAt: input.lifecycleUpdatedAt || input.updatedAt || now,
    quarantineReasons: Array.isArray(input.quarantineReasons) ? [...new Set(input.quarantineReasons.map(String).filter(Boolean))] : [],
    evidenceFactIds: Array.isArray(input.evidenceFactIds) ? [...new Set(input.evidenceFactIds.map(String).filter(Boolean))] : [],
    offers: Array.isArray(input.offers) ? input.offers : [],
    duplicateStatus: input.duplicateStatus || (input.duplicateGroupId ? 'POSSIBLE' : safelyPublished ? 'CLEAR' : 'UNRESOLVED'),
    claimValidationStatus: input.claimValidationStatus || 'MISSING_EVIDENCE',
    publicHidden: safelyPublished ? false : input.publicHidden !== false,
    publicDecision: safelyPublished ? 'published' : (input.publicDecision || 'needs_review'),
    publicBlockReasons: Array.isArray(input.publicBlockReasons)
      ? [...new Set(input.publicBlockReasons.map(String).filter(Boolean))]
      : String(input.publicBlockReason || '').split(',').map((reason) => reason.trim()).filter(Boolean),
    needsVerification: safelyPublished ? false : input.needsVerification !== false,
    autoPublished: safelyPublished ? input.autoPublished === true : false,
    contentHash: input.contentHash || stableProductHash(input),
    sourceHash: input.sourceHash || input.contentHash || stableProductHash(input),
    reviewContent,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  } as Product;
}

export function evaluateCanonicalProduct(input: Partial<Product>, now = new Date().toISOString()): Product {
  return applySafePublishDecision(normalizeCanonicalProduct(input, now), now);
}
