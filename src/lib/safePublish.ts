import type { Product, ProductRiskLevel } from './types';
import { evaluateProductEligibility } from './productEligibility';

export interface SafePublishResult {
  eligible: boolean;
  decision: 'published' | 'needs_review';
  reasons: string[];
  qualityScore: number;
  riskLevel: ProductRiskLevel;
  needsVerification: boolean;
}

export function evaluateSafePublish(product: Partial<Product>, now = Date.now()): SafePublishResult {
  const evaluation = evaluateProductEligibility(product, now);
  const eligible = evaluation.eligibleForPublish;
  const riskLevel: ProductRiskLevel = product.riskLevel || 'unknown';
  return {
    eligible,
    decision: eligible ? 'published' : 'needs_review',
    reasons: evaluation.criticalBlockers,
    qualityScore: evaluation.qualityScore,
    riskLevel,
    needsVerification: !eligible,
  };
}

export function applySafePublishDecision(product: Product, now = new Date().toISOString()): Product {
  const evaluatedAt = Date.parse(now);
  const evaluationNow = Number.isFinite(evaluatedAt) ? evaluatedAt : Date.now();
  const evaluation = evaluateSafePublish(product, evaluationNow);
  if (evaluation.eligible) {
    const published: Product = {
      ...product,
      status: 'published',
      publicDecision: 'published',
      publicHidden: false,
      publicBlocked: false,
      publicBlockReason: undefined,
      publicBlockReasons: [],
      needsVerification: false,
      autoPublished: true,
      qualityScore: evaluation.qualityScore,
      riskLevel: evaluation.riskLevel,
      publishedAt: product.status === 'published' ? (product.publishedAt || now) : now,
      lifecycleState: 'PUBLISHED',
      lifecycleUpdatedAt: now,
    };
    const eligibility = evaluateProductEligibility(published, evaluationNow);
    return { ...published, eligibility, reviewQuality: eligibility.reviewQuality };
  }
  const blocked: Product = {
    ...product,
    status: 'needs_review',
    publicDecision: 'needs_review',
    publicHidden: true,
    publicBlocked: true,
    publicBlockReason: evaluation.reasons.join(', '),
    publicBlockReasons: evaluation.reasons,
    needsVerification: true,
    autoPublished: false,
    qualityScore: evaluation.qualityScore,
    riskLevel: evaluation.riskLevel,
  };
  const eligibility = evaluateProductEligibility(blocked, evaluationNow);
  return { ...blocked, eligibility, reviewQuality: eligibility.reviewQuality };
}
