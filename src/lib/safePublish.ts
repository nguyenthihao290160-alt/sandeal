import type { Product, ProductRiskLevel } from './types';
import { isReviewIndexable } from './editorialReview';

export interface SafePublishResult {
  eligible: boolean;
  decision: 'published' | 'needs_review';
  reasons: string[];
  qualityScore: number;
  riskLevel: ProductRiskLevel;
  needsVerification: boolean;
}

const GOOD_HEALTH = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
const PROHIBITED_TERMS = /(?:thuoc\s+ke\s+don|nicotine|vu\s+khi|chat\s+cam|hang\s+gia|co\s+bac)/i;
const HIGH_RISK_TERMS = /(?:thuoc\b|thiet\s+bi\s+y\s+te|giam\s+can|chua\s+benh|dieu\s+tri|an\s+toan\s+cho\s+tre)/i;

function validHttpUrl(value?: string): boolean {
  try {
    const url = new URL(value || '');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function evaluateSafePublish(product: Partial<Product>): SafePublishResult {
  const reasons: string[] = [];
  const title = String(product.title || '').trim();
  const price = Number(product.salePrice || product.price || 0);
  const productUrl = product.originalUrl;
  const affiliateUrl = product.affiliateUrl;
  const imageUrl = product.imageUrl;

  if (product.kind !== 'product') reasons.push('not_product');
  if (product.verifiedSource !== true && product.sourceVerified !== true) reasons.push('source_unverified');
  if (title.length < 8) reasons.push('invalid_title');
  if (!String(product.slug || '').trim()) reasons.push('invalid_slug');
  if (!Number.isFinite(price) || price <= 0) reasons.push('missing_price');
  if (product.currency !== 'VND') reasons.push('invalid_currency');
  if (!validHttpUrl(productUrl)) reasons.push('missing_product_url');
  if (!validHttpUrl(affiliateUrl)) reasons.push('missing_affiliate_url');
  if (!validHttpUrl(imageUrl)) reasons.push('missing_image');
  if (!GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''))) reasons.push('product_url_unhealthy');
  if (!GOOD_HEALTH.has(String(product.affiliateHealthStatus || ''))) reasons.push('affiliate_url_unhealthy');
  if (!GOOD_HEALTH.has(String(product.imageHealthStatus || ''))) reasons.push('image_unhealthy');
  if (product.sourceHealthCooldownUntil && Date.parse(product.sourceHealthCooldownUntil) > Date.now()) reasons.push('cooldown');
  if (product.autoPublishEligible !== true) reasons.push('auto_publish_ineligible');
  if (!isReviewIndexable(product)) reasons.push('review_not_indexable');

  const policyText = `${title} ${product.category || ''} ${product.description || ''}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  if (PROHIBITED_TERMS.test(policyText)) reasons.push('prohibited_product');
  if (product.riskLevel === 'high' || HIGH_RISK_TERMS.test(policyText)) reasons.push('human_review_required');
  if (product.riskLevel === 'unknown') reasons.push('risk_unclassified');

  let qualityScore = 0;
  if (title.length >= 8) qualityScore += 12;
  if (title.length >= 16 && title.length <= 180) qualityScore += 8;
  if (price > 0) qualityScore += 15;
  if (validHttpUrl(productUrl)) qualityScore += 10;
  if (GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''))) qualityScore += 10;
  if (validHttpUrl(affiliateUrl)) qualityScore += 8;
  if (GOOD_HEALTH.has(String(product.affiliateHealthStatus || ''))) qualityScore += 8;
  if (validHttpUrl(imageUrl)) qualityScore += 8;
  if (GOOD_HEALTH.has(String(product.imageHealthStatus || ''))) qualityScore += 8;
  if (product.verifiedSource === true || product.sourceVerified === true) qualityScore += 8;
  if (product.riskLevel === 'low') qualityScore += 5;
  qualityScore = Math.max(0, Math.min(100, qualityScore));
  if (qualityScore < 80) reasons.push('quality_below_threshold');

  const uniqueReasons = [...new Set(reasons)];
  const eligible = uniqueReasons.length === 0;
  const riskLevel: ProductRiskLevel = product.riskLevel || 'unknown';
  return {
    eligible,
    decision: eligible ? 'published' : 'needs_review',
    reasons: uniqueReasons,
    qualityScore,
    riskLevel,
    needsVerification: !eligible,
  };
}

export function applySafePublishDecision(product: Product, now = new Date().toISOString()): Product {
  const evaluation = evaluateSafePublish(product);
  if (evaluation.eligible) {
    return {
      ...product,
      status: 'published',
      publicDecision: 'published',
      publicHidden: false,
      publicBlockReason: undefined,
      publicBlockReasons: [],
      needsVerification: false,
      autoPublished: true,
      qualityScore: evaluation.qualityScore,
      riskLevel: evaluation.riskLevel,
      publishedAt: product.status === 'published' ? (product.publishedAt || now) : now,
    };
  }
  return {
    ...product,
    status: 'needs_review',
    publicDecision: 'needs_review',
    publicHidden: true,
    publicBlockReason: evaluation.reasons.join(', '),
    publicBlockReasons: evaluation.reasons,
    needsVerification: true,
    autoPublished: false,
    qualityScore: evaluation.qualityScore,
    riskLevel: evaluation.riskLevel,
  };
}
