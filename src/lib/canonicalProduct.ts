import { createHash } from 'crypto';
import type { Product } from './types';
import { applySafePublishDecision } from './safePublish';
import { normalizeReviewContent } from './editorialReview';

const VALID_KINDS = new Set(['product', 'voucher', 'campaign', 'deal', 'store_offer', 'unknown']);
const VALID_STATUSES = new Set(['draft', 'needs_review', 'approved', 'published', 'archived']);

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
