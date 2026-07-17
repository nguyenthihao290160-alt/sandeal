import type { Product, ProductConfidenceSet } from '@/lib/types';

export const CONFIDENCE_RULE_VERSION = 'confidence-engine-v2';
export const PUBLISH_CONFIDENCE_DIMENSIONS = [
  'classification',
  'source',
  'price',
  'image',
  'health',
  'duplicate',
  'contentEvidenceCoverage',
  'editorial',
] as const;

export type PublishConfidenceDimension = (typeof PUBLISH_CONFIDENCE_DIMENSIONS)[number];

export interface ConfidenceEngineInput {
  classificationConfidence?: number;
  evidenceCoverage?: number;
  now?: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function healthConfidence(status?: string): number {
  const normalized = String(status || '').toLowerCase();
  if (['ok', 'healthy', 'redirect_ok', 'redirected'].includes(normalized)) return 0.98;
  if (['timeout', 'rate_limited', 'server_error', 'dns_error', 'unverified', 'unknown'].includes(normalized)) return 0.4;
  if (normalized) return 0.05;
  return 0.2;
}

function editorialConfidence(product: Partial<Product>): number {
  const review = product.reviewContent;
  if (!review) return 0;
  const blockReasons = Array.isArray(review.reviewBlockReasons) ? review.reviewBlockReasons : [];
  if (review.reviewStatus !== 'approved' || blockReasons.length) return clamp(Number(review.editorialConfidence || 0) / 200);
  return clamp(Math.min(
    Number(review.editorialConfidence || 0) / 100,
    Number(review.contentQualityScore || 0) / 100,
    Number(review.originalityScore || 0) / 100,
    Number(review.seoReadinessScore || 0) / 100,
  ));
}

function priceConfidence(product: Partial<Product>, now: number): number {
  const price = Number(product.salePrice || product.price || 0);
  if (!Number.isFinite(price) || price <= 0 || product.currency !== 'VND') return 0;
  const observedAt = Date.parse(product.priceObservedAt || product.lastSeenAt || product.updatedAt || '');
  if (!Number.isFinite(observedAt)) return 0.7;
  if (observedAt > now + 5 * 60_000) return 0.1;
  const age = Math.max(0, now - observedAt);
  if (age <= 24 * 60 * 60_000) return 0.97;
  if (age <= 72 * 60 * 60_000) return 0.82;
  if (age <= 7 * 24 * 60 * 60_000) return 0.55;
  return 0.2;
}

function duplicateConfidence(product: Partial<Product>): number {
  if (product.duplicateStatus === 'CLEAR') return 0.99;
  if (product.duplicateStatus === 'MERGED') return 0.92;
  if (product.duplicateStatus === 'POSSIBLE') return 0.5;
  return 0.05;
}

export function minimumPublishConfidenceDimension(confidences: Pick<ProductConfidenceSet, PublishConfidenceDimension>): {
  dimension: PublishConfidenceDimension;
  value: number;
} {
  return PUBLISH_CONFIDENCE_DIMENSIONS
    .map(dimension => ({ dimension, value: clamp(confidences[dimension]) }))
    .sort((left, right) => left.value - right.value || left.dimension.localeCompare(right.dimension))[0];
}

export function calculateProductConfidences(
  product: Partial<Product>,
  input: ConfidenceEngineInput = {},
): ProductConfidenceSet {
  const now = input.now ?? Date.now();
  const nonProduct = Boolean(product.recordType && product.recordType !== 'PRODUCT')
    || ['voucher', 'campaign', 'store_offer', 'unknown'].includes(String(product.kind || ''));
  const classification = nonProduct
    ? 0
    : clamp(input.classificationConfidence ?? (product.recordType === 'PRODUCT' ? 0.9 : 0.25));
  const source = product.verifiedSource === true || product.sourceVerified === true
    ? clamp(Math.max(0.9, Number(product.qualityScore || 90) / 100))
    : clamp(Number(product.qualityScore || 0) / 200);
  const price = priceConfidence(product, now);
  const image = healthConfidence(product.imageHealthStatus);
  const health = Math.min(
    healthConfidence(product.linkHealthStatus || product.productHealthStatus),
    healthConfidence(product.affiliateHealthStatus),
    image,
  );
  const duplicate = duplicateConfidence(product);
  const contentEvidenceCoverage = clamp(input.evidenceCoverage ?? product.evidenceCoverage ?? 0);
  const editorial = editorialConfidence(product);
  const dimensions = { classification, source, price, image, health, duplicate, contentEvidenceCoverage, editorial };
  const publish = minimumPublishConfidenceDimension(dimensions).value;

  return {
    ...dimensions,
    publish,
    calculatedAt: new Date(now).toISOString(),
    ruleVersion: CONFIDENCE_RULE_VERSION,
  };
}

export function confidenceAction(value: number): 'AUTOMATE' | 'CROSS_CHECK' | 'QUARANTINE' {
  const normalized = clamp(value);
  if (normalized >= 0.85) return 'AUTOMATE';
  if (normalized >= 0.55) return 'CROSS_CHECK';
  return 'QUARANTINE';
}
