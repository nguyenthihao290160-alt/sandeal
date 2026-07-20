import type { EditorialClaim, Product, ReviewQualityAssessment } from './types';
import { PRODUCT_INTELLIGENCE_CONFIG } from './product-intelligence/config';
import { REVIEW_THRESHOLDS } from './editorialReview';

export const REVIEW_QUALITY_POLICY_VERSION = 'review-quality-v1';

const GOOD_HEALTH = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
const AFFILIATE_DISCLOSURE = /(?:hoa\s+hồng|affiliate|liên\s+kết\s+tiếp\s+thị)/i;
const PROMOTIONAL_CLAIMS = /(?:tốt\s+nhất|rẻ\s+nhất|số\s+một|duy\s+nhất|đảm\s+bảo|chắc\s+chắn)/i;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function validTimestamp(value?: string): number | null {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreFreshness(value: string | undefined, maximumAgeDays: number, now: number): number {
  const parsed = validTimestamp(value);
  if (parsed === null || parsed > now + 60_000) return 0;
  const age = now - parsed;
  if (age <= maximumAgeDays * 86_400_000) return 100;
  if (age <= maximumAgeDays * 2 * 86_400_000) return 50;
  return 0;
}

function claimsWithEvidence(claims: EditorialClaim[]): number {
  if (!claims.length) return 100;
  return clamp(claims.filter(claim => claim.evidenceFactIds.length > 0).length / claims.length * 100);
}

function normalized(value: string | undefined): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Deterministic review assessment. It never creates claims, ratings, prices, or evidence. */
export function evaluateReviewQuality(product: Partial<Product>, now = Date.now()): ReviewQualityAssessment {
  const review = product.reviewContent;
  const criticalIssues: string[] = [];
  const warnings: string[] = [];
  if (!review) {
    return {
      qualityScore: 0,
      trustScore: 0,
      freshnessScore: 0,
      completenessScore: 0,
      usefulnessScore: 0,
      sourceCoverageScore: 0,
      balancedReviewScore: 0,
      criticalIssues: ['review_missing'],
      warnings: [],
      nextRequiredAction: 'PREPARE_REVIEW',
      evaluatedAt: new Date(now).toISOString(),
      reviewPolicyVersion: REVIEW_QUALITY_POLICY_VERSION,
    };
  }

  const factualClaims = [...review.factualClaims, ...review.strengths, ...review.limitations]
    .filter(claim => claim.claimType !== 'unknown');
  const evidenceClaims = [...factualClaims, ...review.inferredClaims]
    .filter(claim => claim.claimType === 'factual' || claim.claimType === 'inferred');
  const factIds = new Set(review.keyFacts.map(fact => fact.id));
  const unsupported = evidenceClaims.filter(claim => claim.evidenceFactIds.length === 0
    || claim.evidenceFactIds.some(factId => !factIds.has(factId)));
  const evidenceSources = review.evidenceSources.filter(source => source.name.trim() && source.fields.length > 0);
  const sourcedFacts = review.keyFacts.filter(fact => fact.sourceName.trim() && fact.sourceField.trim());
  const sourceCoverageScore = clamp((
    Math.min(1, evidenceSources.length / 2) * 45
    + (review.keyFacts.length ? sourcedFacts.length / review.keyFacts.length : 0) * 30
    + claimsWithEvidence(evidenceClaims) * 0.25
  ));

  const completenessScore = clamp(
    Number(review.reviewSummary.trim().length >= 80) * 15
    + Number(review.reviewVerdict.trim().length >= 30) * 15
    + Number(review.suitableFor.length > 0) * 12
    + Number(review.notSuitableFor.length > 0) * 12
    + Number(review.strengths.length > 0) * 12
    + Number(review.limitations.length > 0) * 12
    + Number(review.keyFacts.length > 0) * 12
    + Number(evidenceSources.length > 0) * 10,
  );
  const usefulnessScore = clamp(
    Number(review.reviewVerdict.trim().length >= 30) * 25
    + Number(review.suitableFor.length > 0) * 20
    + Number(review.notSuitableFor.length > 0) * 20
    + Number(review.buyingConsiderations.length > 0) * 20
    + Number(review.strengths.length > 0 && review.limitations.length > 0) * 15,
  );
  const balancedReviewScore = clamp(
    Number(review.strengths.length > 0) * 40
    + Number(review.limitations.length > 0) * 40
    + Number(review.suitableFor.length > 0 && review.notSuitableFor.length > 0) * 20,
  );

  const disclosurePresent = AFFILIATE_DISCLOSURE.test(review.reviewDisclosure);
  const sourceHashCurrent = Boolean(review.sourceHash && product.sourceHash && review.sourceHash === product.sourceHash);
  const methodTrust = review.reviewMethod !== 'hands_on_test' ? 100 : 0;
  const trustScore = clamp(
    sourceCoverageScore * 0.35
    + claimsWithEvidence(evidenceClaims) * 0.3
    + Number(disclosurePresent) * 15
    + Number(sourceHashCurrent) * 10
    + methodTrust * 0.1,
  );

  const reviewFreshness = scoreFreshness(review.contentUpdatedAt || review.reviewedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.editorialDays, now);
  const priceFreshness = scoreFreshness(product.priceObservedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.priceDays, now);
  const linkFreshness = Math.min(
    scoreFreshness(product.linkLastCheckedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.linkDays, now),
    scoreFreshness(product.affiliateLastCheckedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.linkDays, now),
    scoreFreshness(product.imageLastCheckedAt, PRODUCT_INTELLIGENCE_CONFIG.freshness.linkDays, now),
  );
  const freshnessScore = clamp(reviewFreshness * 0.4 + priceFreshness * 0.3 + linkFreshness * 0.3);
  const qualityScore = clamp(completenessScore * 0.3 + trustScore * 0.3 + freshnessScore * 0.2 + usefulnessScore * 0.2);

  const contentText = [review.reviewSummary, review.reviewVerdict, ...review.buyingConsiderations, ...evidenceClaims.map(claim => claim.text)].join(' ').trim();
  // Buying considerations can legitimately tell readers to "Ä‘áº£m báº£o" or
  // "cháº¯c cháº¯n" something before purchasing. Those imperatives are not
  // promotional product claims, so only inspect editorial assertions here.
  const promotionalClaimText = [
    review.reviewSummary,
    review.reviewVerdict,
    ...evidenceClaims.map(claim => claim.text),
  ].join(' ').trim();
  if (review.reviewStatus !== 'approved') criticalIssues.push('review_not_approved');
  if (review.reviewStatus === 'stale' || !sourceHashCurrent) criticalIssues.push('review_source_stale');
  if (contentText.length < 280) criticalIssues.push('review_thin_content');
  if (unsupported.length > 0) criticalIssues.push('unsupported_claims');
  if (review.unknownClaims.length > 0) warnings.push('unknown_claims_disclosed');
  if (!disclosurePresent) criticalIssues.push('affiliate_disclosure_missing');
  if (review.reviewMethod === 'hands_on_test') criticalIssues.push('hands_on_evidence_unavailable');
  if (!review.limitations.length || !review.notSuitableFor.length) criticalIssues.push('review_unbalanced');
  if (PROMOTIONAL_CLAIMS.test(promotionalClaimText)) criticalIssues.push('unsupported_promotional_claim');
  if (normalized(review.reviewSummary) === normalized(product.description) && review.reviewSummary.trim().length > 0) criticalIssues.push('duplicate_source_copy');
  if (priceFreshness === 0 || ['STALE', 'CONFLICTED', 'ANOMALOUS', 'UNAVAILABLE'].includes(String(product.priceTruthState || ''))) criticalIssues.push('price_stale_or_unverified');
  if (!GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''))) criticalIssues.push('product_url_unverified');
  if (!GOOD_HEALTH.has(String(product.affiliateHealthStatus || ''))) criticalIssues.push('affiliate_url_unverified');
  if (!GOOD_HEALTH.has(String(product.imageHealthStatus || ''))) criticalIssues.push('image_unverified');
  if (review.contentQualityScore < REVIEW_THRESHOLDS.contentQualityScore) criticalIssues.push('low_content_quality');
  if (review.originalityScore < REVIEW_THRESHOLDS.originalityScore) criticalIssues.push('low_originality');
  if (review.seoReadinessScore < REVIEW_THRESHOLDS.seoReadinessScore) criticalIssues.push('low_seo_readiness');
  criticalIssues.push(...review.reviewBlockReasons);
  if (sourceCoverageScore < 70) warnings.push('source_coverage_low');
  if (reviewFreshness === 50) warnings.push('review_aging');
  if (priceFreshness === 50) warnings.push('price_aging');
  if (linkFreshness === 50) warnings.push('health_verification_aging');
  if (qualityScore < 75) criticalIssues.push('review_quality_below_threshold');

  const uniqueCritical = [...new Set(criticalIssues)];
  const uniqueWarnings = [...new Set(warnings)];
  const nextRequiredAction = uniqueCritical.some(issue => /claim|source|duplicate|hands_on/.test(issue))
    ? 'VERIFY_REVIEW_EVIDENCE'
    : uniqueCritical.some(issue => /price|url|image/.test(issue))
      ? 'RECHECK_PRODUCT_DATA'
      : uniqueCritical.length
        ? 'REVISE_REVIEW'
        : 'READY';

  return {
    qualityScore,
    trustScore,
    freshnessScore,
    completenessScore,
    usefulnessScore,
    sourceCoverageScore,
    balancedReviewScore,
    criticalIssues: uniqueCritical,
    warnings: uniqueWarnings,
    nextRequiredAction,
    evaluatedAt: new Date(now).toISOString(),
    reviewPolicyVersion: REVIEW_QUALITY_POLICY_VERSION,
  };
}
