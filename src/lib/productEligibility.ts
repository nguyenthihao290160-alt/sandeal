import type { Product, ProductEligibilitySnapshot } from './types';
import { looksLikeVoucherOrCampaign } from './sourceItemClassifier';
import { PRODUCT_INTELLIGENCE_CONFIG } from './product-intelligence/config';
import {
  ACCESS_TRADE_AFFILIATE_URL_FIELDS,
  ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS,
} from './integrations/accesstrade';
import { evaluateReviewQuality } from './reviewQuality';
import { canonicalBlockerCodes } from './productBlockers';

export const PRODUCT_ELIGIBILITY_POLICY_VERSION = 'product-eligibility-v2';

const GOOD_HEALTH = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
const PROHIBITED_TERMS = /(?:thuoc\s+ke\s+don|nicotine|vu\s+khi|chat\s+cam|hang\s+gia|co\s+bac)/i;
const HIGH_RISK_TERMS = /(?:thuoc\b|thiet\s+bi\s+y\s+te|giam\s+can|chua\s+benh|dieu\s+tri|an\s+toan\s+cho\s+tre)/i;
const NON_BLOCKING_STORED_REASONS = new Set([
  'safe_publish_approval_required',
  'needs_review',
  'review_required',
]);
const RECALCULATED_REASONS = new Set([
  'not_product',
  'archived',
  'invalid_title',
  'invalid_slug',
  'missing_product_url',
  'product_url_unhealthy',
  'product_health_stale',
  'missing_affiliate_url',
  'affiliate_url_unhealthy',
  'affiliate_health_stale',
  'affiliate_provenance_missing',
  'missing_image',
  'image_unhealthy',
  'image_health_stale',
  'missing_price',
  'price_unverified',
  'price_stale',
  'source_unverified',
  'canonical_provenance_missing',
  'canonical_url_unverified',
  'affiliate_url_unverified',
  'cooldown',
  'duplicate_unresolved',
  'review_quality_unready',
  'image_http_not_200',
  'image_content_type_invalid',
  'merchant_quarantined_30shinestore',
  'review_missing',
  'review_not_approved',
  'review_source_stale',
  'review_thin_content',
  'unsupported_claims',
  'affiliate_disclosure_missing',
  'hands_on_evidence_unavailable',
  'review_unbalanced',
  'unsupported_promotional_claim',
  'duplicate_source_copy',
  'price_stale_or_unverified',
  'product_url_unverified',
  'image_unverified',
  'low_content_quality',
  'low_originality',
  'low_seo_readiness',
  'review_quality_below_threshold',
  'claims_unverified',
  'auto_publish_ineligible',
  'human_review_required',
  'prohibited_product',
  'public_blocked',
]);

function validHttpUrl(value?: string): boolean {
  try {
    const parsed = new URL(value || '');
    return Boolean(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function checkedRecently(value: string | undefined, days: number, now: number): boolean {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed <= now + 60_000 && now - parsed <= days * 86_400_000;
}

function urlContainsDomain(value: string | undefined, domain: string, depth = 0): boolean {
  if (depth > 4) return false;
  try {
    const parsed = new URL(value || '');
    const host = parsed.hostname.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) return true;
    for (const key of ['url', 'deeplink', 'target', 'destination', 'redirect']) {
      const nested = parsed.searchParams.get(key);
      if (nested && urlContainsDomain(nested, domain, depth + 1)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isAccessTrade(product: Partial<Product>): boolean {
  return product.source === 'accesstrade' || product.platform === 'accesstrade';
}

function dataQualityScore(product: Partial<Product>): number {
  const title = String(product.title || '').trim();
  const price = Number(product.salePrice || product.price || 0);
  let score = 0;
  if (title.length >= 8) score += 12;
  if (title.length >= 16 && title.length <= 180) score += 8;
  if (price > 0 && product.currency === 'VND') score += 15;
  if (validHttpUrl(product.canonicalProductUrl || product.originalUrl)) score += 10;
  if (GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''))) score += 10;
  if (validHttpUrl(product.affiliateUrl)) score += 8;
  if (GOOD_HEALTH.has(String(product.affiliateHealthStatus || ''))) score += 8;
  if (validHttpUrl(product.imageUrl)) score += 8;
  if (GOOD_HEALTH.has(String(product.imageHealthStatus || ''))) score += 8;
  if (product.verifiedSource === true || product.sourceVerified === true) score += 8;
  if (product.riskLevel === 'low') score += 5;
  return Math.max(0, Math.min(100, score));
}

export function eligibilityBlockerMessage(reason: string): string {
  const messages: Record<string, string> = {
    not_product: 'Record chưa được phân loại là sản phẩm.',
    merchant_quarantined_30shinestore: 'Merchant 30shinestore đang được quarantine mềm.',
    source_unverified: 'Nguồn sản phẩm chưa được xác minh.',
    missing_product_url: 'Thiếu Product URL hợp lệ.',
    product_url_unhealthy: 'Product URL chưa khỏe.',
    product_health_stale: 'Kết quả Product URL đã stale hoặc chưa có.',
    missing_affiliate_url: 'Thiếu Affiliate URL hợp lệ.',
    affiliate_url_unhealthy: 'Affiliate URL chưa khỏe.',
    affiliate_health_stale: 'Kết quả Affiliate URL đã stale hoặc chưa có.',
    affiliate_provenance_missing: 'Affiliate URL AccessTrade thiếu provenance API/field allowlist.',
    missing_image: 'Thiếu ảnh hợp lệ.',
    image_unhealthy: 'Ảnh chưa khỏe.',
    image_health_stale: 'Kết quả kiểm tra ảnh đã stale hoặc chưa có.',
    missing_price: 'Giá không hợp lệ.',
    price_unverified: 'Giá chưa có mốc xác minh.',
    price_stale: 'Giá đã stale hoặc có xung đột.',
    review_quality_unready: 'Review chưa vượt cổng chất lượng deterministic.',
    auto_publish_ineligible: 'Candidate chưa được phép đi qua Safe Publish.',
    human_review_required: 'Sản phẩm cần người duyệt vì mức rủi ro.',
    public_hidden: 'Record đang bị ẩn khỏi public.',
    public_blocked: 'Record đang bị chặn khỏi public.',
  };
  Object.assign(messages, {
    canonical_provenance_missing: 'Product URL AccessTrade thiếu provenance API/field hợp lệ.',
    canonical_url_unverified: 'Product URL chưa được xác minh.',
    affiliate_url_unverified: 'Affiliate URL chưa được xác minh.',
    image_http_not_200: 'Ảnh không trả về HTTP 200.',
    image_content_type_invalid: 'Phản hồi ảnh không có Content-Type image/*.',
  });
  return messages[reason] || reason.replace(/_/g, ' ');
}

/** Single operational eligibility truth shared by scan, dashboard, publish, and public filtering. */
export function evaluateProductEligibility(product: Partial<Product>, now = Date.now()): ProductEligibilitySnapshot {
  const dataBlockers: string[] = [];
  const publishBlockers: string[] = [];
  const warningBlockers: string[] = [];
  const title = String(product.title || '').trim();
  const policyText = `${title} ${product.category || ''} ${product.description || ''}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const reviewQuality = evaluateReviewQuality(product, now);
  const canonicalProductUrl = product.canonicalProductUrl || product.originalUrl;
  const isThirtyShine = urlContainsDomain(canonicalProductUrl, '30shinestore.com')
    || urlContainsDomain(product.affiliateUrl, '30shinestore.com');

  if (product.kind !== 'product' || (product.recordType && product.recordType !== 'PRODUCT') || looksLikeVoucherOrCampaign(product as Product)) dataBlockers.push('not_product');
  if (isThirtyShine || product.lifecycleState === 'QUARANTINED' || product.quarantineReasons?.includes('merchant_quarantined_30shinestore')) dataBlockers.push('merchant_quarantined_30shinestore');
  if (product.status === 'archived') dataBlockers.push('archived');
  if (title.length < 8) dataBlockers.push('invalid_title');
  if (!String(product.slug || '').trim()) dataBlockers.push('invalid_slug');
  if (product.verifiedSource !== true && product.sourceVerified !== true) dataBlockers.push('source_unverified');

  if (!validHttpUrl(canonicalProductUrl)) dataBlockers.push('missing_product_url');
  if (!GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''))) dataBlockers.push('product_url_unhealthy');
  if (!checkedRecently(product.linkLastCheckedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.linkDays, now)) dataBlockers.push('product_health_stale');
  if (product.canonicalUrlStatus !== 'verified') dataBlockers.push('canonical_url_unverified');
  if (isAccessTrade(product) && (
    product.canonicalUrlSource !== 'provider_api'
    || product.canonicalUrlProvider !== 'accesstrade'
    || product.canonicalUrlSourceEndpoint !== 'datafeed'
    || !product.canonicalUrlSourceField
    || !(ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS as readonly string[]).includes(product.canonicalUrlSourceField)
  )) dataBlockers.push('canonical_provenance_missing');
  if (!validHttpUrl(product.affiliateUrl)) dataBlockers.push('missing_affiliate_url');
  if (!GOOD_HEALTH.has(String(product.affiliateHealthStatus || ''))) dataBlockers.push('affiliate_url_unhealthy');
  if (!checkedRecently(product.affiliateLastCheckedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.linkDays, now)) dataBlockers.push('affiliate_health_stale');
  if (product.affiliateUrlStatus !== 'verified') dataBlockers.push('affiliate_url_unverified');
  if (isAccessTrade(product) && (
    product.affiliateUrlSource !== 'provider_api'
    || product.affiliateUrlProvider !== 'accesstrade'
    || product.affiliateUrlSourceEndpoint !== 'datafeed'
    || !product.affiliateUrlSourceField
    || !(ACCESS_TRADE_AFFILIATE_URL_FIELDS as readonly string[]).includes(product.affiliateUrlSourceField)
    || product.deepLinkSupported === false
  )) dataBlockers.push('affiliate_provenance_missing');

  if (!validHttpUrl(product.imageUrl)) dataBlockers.push('missing_image');
  if (!GOOD_HEALTH.has(String(product.imageHealthStatus || ''))) dataBlockers.push('image_unhealthy');
  if (!checkedRecently(product.imageLastCheckedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.linkDays, now)) dataBlockers.push('image_health_stale');
  if (product.imageUrlHttpStatus !== 200) dataBlockers.push('image_http_not_200');
  if (!String(product.imageContentType || '').toLowerCase().startsWith('image/')) dataBlockers.push('image_content_type_invalid');

  const price = Number(product.salePrice || product.price || 0);
  if (!Number.isFinite(price) || price <= 0 || product.currency !== 'VND') dataBlockers.push('missing_price');
  const priceObserved = Date.parse(product.priceObservedAt || '');
  const priceVerified = product.priceVerificationStatus === 'VERIFIED'
    || (product.priceVerificationStatus === undefined && product.priceTruthState === 'FRESH' && Number.isFinite(priceObserved));
  if (!priceVerified) dataBlockers.push('price_unverified');
  if (!Number.isFinite(priceObserved)
    || now - priceObserved > PRODUCT_INTELLIGENCE_CONFIG.freshness.priceDays * 86_400_000
    || ['STALE', 'CONFLICTED', 'ANOMALOUS', 'UNAVAILABLE'].includes(String(product.priceTruthState || ''))) dataBlockers.push('price_stale');
  if (product.sourceHealthCooldownUntil && Date.parse(product.sourceHealthCooldownUntil) > now) dataBlockers.push('cooldown');
  if (product.duplicateStatus && product.duplicateStatus !== 'CLEAR') dataBlockers.push('duplicate_unresolved');

  if (reviewQuality.criticalIssues.length > 0) publishBlockers.push('review_quality_unready', ...reviewQuality.criticalIssues.map(issue => `review:${issue}`));
  // Approved review claims are validated against review.keyFacts by the review
  // quality engine. The separate canonical claim status belongs to the
  // autonomous evidence graph and must not contradict a valid editorial set.
  if (product.claimValidationStatus && product.claimValidationStatus !== 'VERIFIED'
    && (!product.reviewContent || reviewQuality.criticalIssues.length > 0)) publishBlockers.push('claims_unverified');
  if (product.autoPublishEligible !== true) publishBlockers.push('auto_publish_ineligible');
  if (product.riskLevel === 'high' || product.riskLevel === 'unknown' || HIGH_RISK_TERMS.test(policyText)) publishBlockers.push('human_review_required');
  if (PROHIBITED_TERMS.test(policyText)) publishBlockers.push('prohibited_product');

  const storedReasons = canonicalBlockerCodes(product.currentBlockers?.length ? product.currentBlockers : product.publicBlockReasons)
    // Known rule output is recalculated from current data above. Unknown/manual
    // policy blockers remain fail-closed until an explicit workflow clears them.
    .filter(reason => !NON_BLOCKING_STORED_REASONS.has(reason)
      && !RECALCULATED_REASONS.has(reason));
  publishBlockers.push(...storedReasons);
  if (product.publicBlocked === true && !product.publicBlockReasons?.length
    && product.publicBlockReason && !NON_BLOCKING_STORED_REASONS.has(product.publicBlockReason)) publishBlockers.push('public_blocked');

  if (!product.productUrlFinalDomain) warningBlockers.push('product_final_domain_missing');
  if (!product.affiliateUrlFinalDomain) warningBlockers.push('affiliate_final_domain_missing');
  if (product.priceTruthState === 'AGING') warningBlockers.push('price_aging');
  if (product.riskLevel === 'medium') warningBlockers.push('medium_risk');
  warningBlockers.push(...reviewQuality.warnings.map(warning => `review:${warning}`));

  const uniqueData = canonicalBlockerCodes(dataBlockers);
  const criticalBlockers = canonicalBlockerCodes([...uniqueData, ...publishBlockers]);
  const uniqueWarnings = canonicalBlockerCodes(warningBlockers);
  const eligibleForReview = uniqueData.length === 0;
  const eligibleForCanary = criticalBlockers.length === 0;
  const eligibleForPublish = eligibleForCanary;
  const finalizedLifecycle = product.schemaVersion !== 2 || product.autoPublished !== true
    || ['PUBLISHED', 'DEGRADED', 'RECHECKING', 'RETRY_SCHEDULED'].includes(String(product.lifecycleState || ''));
  const eligibleForPublic = eligibleForPublish
    && product.status === 'published'
    && product.publicHidden === false
    && product.publicBlocked !== true
    && finalizedLifecycle;

  const nextRequiredAction = criticalBlockers.some(reason => /quarant|archived/.test(reason)) ? 'KEEP_QUARANTINED'
    : criticalBlockers.some(reason => /not_product|invalid_title|invalid_slug/.test(reason)) ? 'CLASSIFY_PRODUCT'
      : criticalBlockers.some(reason => /product_url|affiliate_url|provenance|health_stale/.test(reason)) ? 'RECHECK_LINKS'
        : criticalBlockers.some(reason => /image/.test(reason)) ? 'RECHECK_IMAGE'
          : criticalBlockers.some(reason => /price/.test(reason)) ? 'VERIFY_PRICE'
            : criticalBlockers.some(reason => /source/.test(reason)) ? 'VERIFY_SOURCE'
              : criticalBlockers.some(reason => /review|claim/.test(reason)) ? (reviewQuality.nextRequiredAction === 'READY' ? 'VERIFY_REVIEW_EVIDENCE' : reviewQuality.nextRequiredAction)
                : criticalBlockers.some(reason => /risk|prohibited/.test(reason)) ? 'HUMAN_REVIEW'
                  : criticalBlockers.includes('auto_publish_ineligible') ? 'MARK_PUBLISH_CANDIDATE'
                    : product.status !== 'published' ? 'SAFE_PUBLISH_REVIEW' : 'READY';

  return {
    eligibleForReview,
    eligibleForCanary,
    eligibleForPublish,
    eligibleForPublic,
    qualityScore: dataQualityScore(product),
    criticalBlockers,
    warningBlockers: uniqueWarnings,
    nextRequiredAction,
    evaluatedAt: new Date(now).toISOString(),
    policyVersion: PRODUCT_ELIGIBILITY_POLICY_VERSION,
    reviewQuality,
  };
}
