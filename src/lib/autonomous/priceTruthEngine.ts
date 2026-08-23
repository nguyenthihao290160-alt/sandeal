import type { PriceTruthState, Product, ProductOffer } from '@/lib/types';

export const PRICE_TRUTH_RULE_VERSION = 'price-truth-v2';

export const PRICE_TRUTH_FRESH_MS = 24 * 60 * 60_000;
export const PRICE_TRUTH_AGING_MS = 72 * 60 * 60_000;
const COMPARISON_WINDOW_MS = 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const CONFLICT_RATIO = 0.2;
const LARGE_CHANGE_RATIO = 0.5;
const CORROBORATION_RATIO = 0.1;

export interface DerivedPersistedPriceTruth {
  state: PriceTruthState;
  observedAt?: string;
  ageMs?: number;
  verificationStatus: NonNullable<Product['priceVerificationStatus']>;
  isVerified: boolean;
  isFresh: boolean;
  confidence: number;
  reasons: string[];
}

/**
 * Canonical read-time price truth. Persisted state, provenance verification,
 * and observation age are deliberately combined conservatively so a stale
 * provenance record can never be presented as a fresh price.
 */
export function derivePersistedPriceTruth(
  product: Partial<Product>,
  now = Date.now(),
): DerivedPersistedPriceTruth {
  const value = Number(product.salePrice || product.price || 0);
  const observedAt = product.priceObservedAt;
  const observedMs = Date.parse(observedAt || '');
  const validValue = Number.isFinite(value) && value > 0 && product.currency === 'VND';
  const validObservedAt = Number.isFinite(observedMs) && observedMs <= now + CLOCK_SKEW_MS;
  const ageMs = validObservedAt ? Math.max(0, now - observedMs) : undefined;
  const declaredVerification = product.priceVerificationStatus;
  const provenanceVerification = product.fieldProvenance?.price?.verificationStatus;
  const verificationStates = [declaredVerification, provenanceVerification].filter(Boolean);
  const reasons: string[] = [];

  let state: PriceTruthState;
  if (!validValue) {
    state = 'UNAVAILABLE';
    reasons.push('price_unavailable');
  } else if (!validObservedAt) {
    state = 'STALE';
    reasons.push('price_observation_missing_or_invalid');
  } else if (ageMs! <= PRICE_TRUTH_FRESH_MS) {
    state = 'FRESH';
  } else if (ageMs! <= PRICE_TRUTH_AGING_MS) {
    state = 'AGING';
  } else {
    state = 'STALE';
  }

  const persisted = product.priceTruthState;
  if (persisted === 'CONFLICTED' || declaredVerification === 'CONFLICT' || provenanceVerification === 'CONFLICT') state = 'CONFLICTED';
  else if (persisted === 'ANOMALOUS') state = 'ANOMALOUS';
  else if (persisted === 'UNAVAILABLE' || declaredVerification === 'INVALID' || provenanceVerification === 'INVALID') state = 'UNAVAILABLE';
  else if (persisted === 'STALE' || declaredVerification === 'STALE' || provenanceVerification === 'STALE') state = 'STALE';
  else if (persisted === 'AGING' && state === 'FRESH') state = 'AGING';

  if (ageMs !== undefined) reasons.push(`age_ms:${ageMs}`);
  if (persisted && persisted !== state) reasons.push(`persisted_state:${persisted}`);
  if (declaredVerification && declaredVerification !== 'VERIFIED') reasons.push(`verification:${declaredVerification}`);
  if (provenanceVerification && provenanceVerification !== 'VERIFIED') reasons.push(`provenance:${provenanceVerification}`);
  const hasVerificationEvidence = verificationStates.length > 0;
  const verificationAgrees = hasVerificationEvidence && verificationStates.every(status => status === 'VERIFIED');
  const isVerified = verificationAgrees && (state === 'FRESH' || state === 'AGING');
  const confidenceCeiling = state === 'FRESH' ? 0.97 : state === 'AGING' ? 0.78 : state === 'STALE' ? 0.4 : 0.2;
  const persistedConfidence = Number(product.priceTruthConfidence);
  const confidence = Number(Math.min(
    confidenceCeiling,
    Number.isFinite(persistedConfidence) ? Math.max(0, persistedConfidence) : confidenceCeiling,
  ).toFixed(4));
  return {
    state,
    observedAt: validObservedAt ? observedAt : undefined,
    ageMs,
    verificationStatus: state === 'CONFLICTED' ? 'CONFLICT'
      : state === 'UNAVAILABLE' ? (!validValue
          ? 'MISSING'
          : declaredVerification === 'INVALID' || provenanceVerification === 'INVALID'
            ? 'INVALID'
            : 'UNVERIFIED')
        : state === 'ANOMALOUS' ? 'VERIFYING'
        : state === 'STALE' ? 'STALE'
          : isVerified ? 'VERIFIED'
            : declaredVerification || provenanceVerification || 'UNVERIFIED',
    isVerified,
    isFresh: state === 'FRESH' && isVerified,
    confidence,
    reasons: [...new Set(reasons)],
  };
}

export interface PriceObservation {
  sourceId: string;
  value?: number;
  currency: string;
  observedAt: string;
  evidenceFactId?: string;
  evidenceFactIds?: string[];
  verified?: boolean;
  confidence?: number;
  kind?: 'CURRENT' | 'ORIGINAL';
}

export interface PriceTruthResult {
  state: PriceTruthState;
  confidence: number;
  effectivePrice?: number;
  observedAt?: string;
  discountPercent?: number;
  evidenceFactIds: string[];
  reasons: string[];
  requiresCrossCheck: boolean;
  crossCheckSourceIds: string[];
  ruleVersion: string;
}

interface NormalizedObservation extends PriceObservation {
  value: number;
  observedMs: number;
  confidence: number;
  kind: 'CURRENT' | 'ORIGINAL';
}

function evidenceIds(observation: PriceObservation): string[] {
  return [...new Set([
    ...(observation.evidenceFactIds || []),
    ...(observation.evidenceFactId ? [observation.evidenceFactId] : []),
  ].filter(Boolean))];
}

function normalizeObservation(observation: PriceObservation, now: number): NormalizedObservation | null {
  const value = Number(observation.value);
  const observedMs = Date.parse(observation.observedAt);
  const confidence = Number.isFinite(observation.confidence) ? Math.max(0, Math.min(1, Number(observation.confidence))) : 0.9;
  const verified = observation.verified === true || evidenceIds(observation).length > 0;
  if (!verified || !observation.sourceId.trim() || !Number.isFinite(value) || value <= 0 || observation.currency !== 'VND') return null;
  if (!Number.isFinite(observedMs) || observedMs > now + CLOCK_SKEW_MS) return null;
  return { ...observation, value, observedMs, confidence, kind: observation.kind || 'CURRENT' };
}

function unavailable(reason: string): PriceTruthResult {
  return {
    state: 'UNAVAILABLE',
    confidence: 0,
    evidenceFactIds: [],
    reasons: [reason],
    requiresCrossCheck: false,
    crossCheckSourceIds: [],
    ruleVersion: PRICE_TRUTH_RULE_VERSION,
  };
}

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(1, Math.min(left, right));
}

export function evaluatePriceTruth(
  product: Partial<Product>,
  observations: PriceObservation[] = [],
  now = Date.now(),
): PriceTruthResult {
  const productValue = Number(product.salePrice || product.price || 0);
  const productObservation: PriceObservation | null = productValue > 0 ? {
    sourceId: product.sourceId || product.externalId || product.id || 'canonical',
    value: productValue,
    currency: product.currency || 'VND',
    observedAt: product.priceObservedAt || product.lastSeenAt || product.updatedAt || new Date(now).toISOString(),
    verified: product.verifiedSource === true || product.sourceVerified === true,
    confidence: product.confidences?.price,
    kind: 'CURRENT',
  } : null;
  const input = observations.length ? observations : productObservation ? [productObservation] : [];
  const normalized = input.map(item => normalizeObservation(item, now)).filter((item): item is NormalizedObservation => Boolean(item));
  const current = normalized.filter(item => item.kind === 'CURRENT').sort((left, right) => right.observedMs - left.observedMs || left.sourceId.localeCompare(right.sourceId));
  if (!current.length) return unavailable(input.length ? 'missing_verified_price' : 'price_unavailable');

  const latest = current[0];
  const latestAge = Math.max(0, now - latest.observedMs);
  const contemporaneous = current.filter(item => Math.abs(item.observedMs - latest.observedMs) <= COMPARISON_WINDOW_MS);
  const latestBySource = new Map<string, NormalizedObservation>();
  for (const observation of contemporaneous) if (!latestBySource.has(observation.sourceId)) latestBySource.set(observation.sourceId, observation);
  const independent = [...latestBySource.values()];
  const max = Math.max(...independent.map(item => item.value));
  const min = Math.min(...independent.map(item => item.value));
  const conflicted = independent.length > 1 && relativeDifference(max, min) > CONFLICT_RATIO;
  const previous = current.find(item => item.sourceId === latest.sourceId && item.observedMs < latest.observedMs && item.value !== latest.value);
  const changeRatio = previous ? relativeDifference(latest.value, previous.value) : 0;
  const corroborating = independent.filter(item => item.sourceId !== latest.sourceId && relativeDifference(item.value, latest.value) <= CORROBORATION_RATIO);
  const anomalousWithoutCrossCheck = changeRatio > LARGE_CHANGE_RATIO && corroborating.length === 0;

  let state: PriceTruthState = latestAge <= PRICE_TRUTH_FRESH_MS ? 'FRESH' : latestAge <= PRICE_TRUTH_AGING_MS ? 'AGING' : 'STALE';
  const reasons = [`age_ms:${latestAge}`];
  if (conflicted) {
    state = 'CONFLICTED';
    reasons.push('cross_source_price_conflict');
  } else if (anomalousWithoutCrossCheck) {
    state = 'ANOMALOUS';
    reasons.push('large_price_change_requires_cross_check');
  } else if (changeRatio > LARGE_CHANGE_RATIO) {
    reasons.push('large_price_change_cross_checked');
  }

  const originals = normalized.filter(item => item.kind === 'ORIGINAL')
    .sort((left, right) => Number(right.sourceId === latest.sourceId) - Number(left.sourceId === latest.sourceId) || right.observedMs - left.observedMs);
  const original = originals.find(item => item.value > latest.value);
  const currentEvidence = evidenceIds(latest);
  const originalEvidence = original ? evidenceIds(original) : [];
  const safeState = !['CONFLICTED', 'ANOMALOUS', 'UNAVAILABLE'].includes(state);
  const discountPercent = safeState && original && currentEvidence.length > 0 && originalEvidence.length > 0
    ? Math.round((1 - latest.value / original.value) * 100)
    : undefined;
  if (original && discountPercent === undefined) reasons.push('discount_evidence_incomplete');

  const allEvidenceIds = [...new Set(normalized.flatMap(evidenceIds))].sort();
  const baseConfidence = state === 'FRESH' ? 0.97 : state === 'AGING' ? 0.78 : state === 'STALE' ? 0.4 : 0.2;
  const evidenceConfidence = normalized.reduce((minimum, item) => Math.min(minimum, item.confidence), 1);
  return {
    state,
    confidence: Number(Math.min(baseConfidence, evidenceConfidence).toFixed(4)),
    effectivePrice: safeState ? latest.value : undefined,
    observedAt: latest.observedAt,
    discountPercent,
    evidenceFactIds: allEvidenceIds,
    reasons,
    requiresCrossCheck: state === 'CONFLICTED' || state === 'ANOMALOUS',
    crossCheckSourceIds: corroborating.map(item => item.sourceId).sort(),
    ruleVersion: PRICE_TRUTH_RULE_VERSION,
  };
}

export function offerPriceObservations(offers: ProductOffer[]): PriceObservation[] {
  return offers.flatMap(offer => {
    const sourceId = `${offer.source}:${offer.merchant}:${offer.id}`;
    const verified = offer.sourceVerified === true && Number(offer.priceConfidence ?? offer.confidence) >= 0.75;
    const current: PriceObservation = {
      sourceId,
      value: offer.price,
      currency: offer.currency || 'VND',
      observedAt: offer.observedAt,
      evidenceFactIds: offer.priceEvidenceFactIds,
      verified,
      confidence: offer.priceConfidence ?? offer.confidence,
      kind: 'CURRENT',
    };
    const observations: PriceObservation[] = [current];
    if (Number(offer.previousPrice) > 0 && offer.previousPriceObservedAt) observations.push({
      sourceId,
      value: offer.previousPrice,
      currency: offer.currency || 'VND',
      observedAt: offer.previousPriceObservedAt,
      verified,
      confidence: offer.priceConfidence ?? offer.confidence,
      kind: 'CURRENT',
    });
    if (Number(offer.originalPrice) > 0) observations.push({
      sourceId,
      value: offer.originalPrice,
      currency: offer.currency || 'VND',
      observedAt: offer.observedAt,
      evidenceFactIds: offer.originalPriceEvidenceFactIds,
      verified,
      confidence: offer.priceConfidence ?? offer.confidence,
      kind: 'ORIGINAL',
    });
    return observations;
  });
}

export function priceTruthProductPatch(result: PriceTruthResult): Partial<Product> {
  // A source value becomes VERIFIED only after the price-truth evaluator has
  // retained current, persisted evidence. This deliberately does not infer
  // verification from a price value or source configuration alone.
  const verified = ['FRESH', 'AGING'].includes(result.state)
    && result.requiresCrossCheck === false
    && result.evidenceFactIds.length > 0;
  return {
    priceTruthState: result.state,
    priceObservedAt: result.observedAt,
    priceTruthConfidence: result.confidence,
    priceTruthEffectivePrice: result.effectivePrice,
    priceTruthDiscountPercent: result.discountPercent,
    priceTruthEvidenceFactIds: result.evidenceFactIds,
    priceTruthReasons: result.reasons,
    priceTruthRuleVersion: result.ruleVersion,
    priceTruthRequiresCrossCheck: result.requiresCrossCheck,
    priceVerificationStatus: verified ? 'VERIFIED' as const
      : result.state === 'STALE' ? 'STALE' as const
        : result.state === 'CONFLICTED' ? 'CONFLICT' as const
          : result.state === 'UNAVAILABLE' ? 'UNVERIFIED' as const
            : 'VERIFYING' as const,
  };
}
