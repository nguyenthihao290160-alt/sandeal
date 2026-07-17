import type { PriceTruthState, ProductOffer } from '@/lib/types';

export const OFFER_INTELLIGENCE_RULE_VERSION = 'offer-intelligence-v1';

const FRESH_MS = 24 * 60 * 60_000;
const MAX_AGE_MS = 72 * 60 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;

export interface OfferEvaluation {
  offerId: string;
  eligible: boolean;
  score: number;
  priceState: PriceTruthState;
  reasons: string[];
}

export interface BestPublicOfferSelection {
  offers: ProductOffer[];
  bestOffer?: ProductOffer;
  reasons: string[];
  evaluations: OfferEvaluation[];
  previousPrimaryOfferId?: string;
  switchedFromOfferId?: string;
  fallbackUsed: boolean;
  ruleVersion: string;
}

function bounded(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : fallback;
}

function validAffiliateUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function normalizedHealth(value: ProductOffer['health'] | undefined, fallback: ProductOffer['health']): ProductOffer['health'] {
  return value || fallback;
}

export function evaluatePublicOffer(offer: ProductOffer, now = Date.now()): OfferEvaluation {
  const reasons: string[] = [];
  const observedAt = Date.parse(offer.observedAt);
  const age = Number.isFinite(observedAt) ? now - observedAt : Number.POSITIVE_INFINITY;
  const expiresAt = offer.expiresAt ? Date.parse(offer.expiresAt) : observedAt + MAX_AGE_MS;
  const productLinkHealth = normalizedHealth(offer.productLinkHealth, offer.health);
  const affiliateHealth = normalizedHealth(offer.affiliateHealth, offer.health);
  const sourceConfidence = bounded(offer.sourceConfidence, offer.sourceVerified ? offer.confidence : 0);
  const priceConfidence = bounded(offer.priceConfidence, offer.confidence);
  const merchantQuality = bounded(offer.merchantQuality, 0.5);
  const overallConfidence = bounded(offer.confidence, 0);

  if (offer.sourceVerified !== true) reasons.push('source_not_verified');
  if (sourceConfidence < 0.75) reasons.push('source_confidence_low');
  if (!validAffiliateUrl(offer.affiliateUrl)) reasons.push('affiliate_url_invalid');
  if (productLinkHealth !== 'HEALTHY') reasons.push('product_link_unhealthy');
  if (affiliateHealth !== 'HEALTHY' || offer.health !== 'HEALTHY') reasons.push('affiliate_link_unhealthy');
  if (!Number.isFinite(offer.price) || Number(offer.price) <= 0) reasons.push('price_unavailable');
  if ((offer.currency || 'VND') !== 'VND') reasons.push('currency_unsupported');
  if (priceConfidence < 0.75) reasons.push('price_confidence_low');
  if (overallConfidence < 0.75) reasons.push('offer_confidence_low');
  if (!Number.isFinite(observedAt)) reasons.push('observed_at_invalid');
  else if (age < -CLOCK_SKEW_MS) reasons.push('observation_in_future');
  else if (age > MAX_AGE_MS) reasons.push('price_stale');
  if (!Number.isFinite(expiresAt) || expiresAt <= now) reasons.push('offer_expired');

  const priceState: PriceTruthState = !Number.isFinite(offer.price) || Number(offer.price) <= 0
    ? 'UNAVAILABLE'
    : age <= FRESH_MS ? 'FRESH' : age <= MAX_AGE_MS ? 'AGING' : 'STALE';
  const freshness = age <= FRESH_MS ? 1 : age <= MAX_AGE_MS ? Math.max(0, 1 - (age - FRESH_MS) / (MAX_AGE_MS - FRESH_MS)) : 0;
  const score = sourceConfidence * 0.25
    + freshness * 0.2
    + priceConfidence * 0.2
    + merchantQuality * 0.15
    + overallConfidence * 0.1
    + (productLinkHealth === 'HEALTHY' && affiliateHealth === 'HEALTHY' ? 0.1 : 0);

  return {
    offerId: offer.id,
    eligible: reasons.length === 0,
    score: Number(score.toFixed(6)),
    priceState,
    reasons,
  };
}

export function selectBestPublicOffer(offers: ProductOffer[], now = Date.now()): BestPublicOfferSelection {
  const previousPrimary = offers.find(offer => offer.primary);
  const evaluations = offers.map(offer => evaluatePublicOffer(offer, now));
  const byId = new Map(evaluations.map(evaluation => [evaluation.offerId, evaluation]));
  const ranked = offers.filter(offer => byId.get(offer.id)?.eligible).sort((left, right) => {
    const scoreDifference = (byId.get(right.id)?.score || 0) - (byId.get(left.id)?.score || 0);
    return scoreDifference
      || Number(left.price || Number.MAX_SAFE_INTEGER) - Number(right.price || Number.MAX_SAFE_INTEGER)
      || Date.parse(right.observedAt) - Date.parse(left.observedAt)
      || left.id.localeCompare(right.id);
  });
  const bestOffer = ranked[0];
  const switchedFromOfferId = previousPrimary && previousPrimary.id !== bestOffer?.id ? previousPrimary.id : undefined;
  const fallbackUsed = Boolean(switchedFromOfferId && !byId.get(switchedFromOfferId!)?.eligible && bestOffer);
  const reasons = bestOffer
    ? ['verified_source', 'healthy_product_link', 'healthy_affiliate_link', 'fresh_price', 'merchant_quality_ranked', 'price_confidence_ranked']
    : ['no_healthy_verified_offer'];
  if (fallbackUsed) reasons.push('primary_offer_unhealthy', 'fallback_offer_selected');

  return {
    offers: offers.map(offer => ({ ...offer, primary: offer.id === bestOffer?.id })),
    bestOffer,
    reasons,
    evaluations,
    previousPrimaryOfferId: previousPrimary?.id,
    switchedFromOfferId,
    fallbackUsed,
    ruleVersion: OFFER_INTELLIGENCE_RULE_VERSION,
  };
}
