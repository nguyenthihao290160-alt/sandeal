import { createHash } from 'crypto';

import { getFeatureRolloutState, type FeatureRolloutMode } from '@/lib/automation/featureRollout';
import { validateExternalUrl } from './urlSafety';
import type { Product, ProductOffer } from '@/lib/types';

export const COMPLIANCE_OFFER_SCHEMA_VERSION = 1;
export const COMPLIANCE_OFFER_RULE_VERSION = 'compliance-offer-selection-v1';

const MAX_OFFERS = 32;
const MAX_AGE_MS = 72 * 60 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const SAFE_OFFER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/;
const TRACKING_PATTERN = /^(?:aff(?:iliate)?(?:_?(?:id|sid|sub))?|click_?id|sub(?:_?id)?|tracking(?:_?id)?|ref|utm_.+)$/i;

export interface ComplianceOfferEvaluation {
  offerId: string;
  eligible: boolean;
  reasonCodes: string[];
  price: number | null;
  merchantQuality: number;
  confidence: number;
  observedAt: string | null;
  fingerprint: string;
}

export interface ComplianceOfferDecision {
  schemaVersion: number;
  ruleVersion: string;
  selectedOfferId: string | null;
  publicRedirectPath: string | null;
  evaluatedAt: string;
  inputHash: string;
  reasons: string[];
  evaluations: ComplianceOfferEvaluation[];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedConfidence(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

function safeHttpsUrl(value: unknown): URL | null {
  const validation = validateExternalUrl(value);
  if (!validation.safe || !validation.normalizedUrl) return null;
  const url = new URL(validation.normalizedUrl);
  return url.protocol === 'https:' ? url : null;
}

function hostname(value: unknown): string {
  const url = safeHttpsUrl(value);
  return url?.hostname.toLowerCase().replace(/^www\./, '') || '';
}

function normalizedMerchant(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.-]+/g, '')
    .slice(0, 240);
}

function relatedMerchant(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right
    || left.endsWith(`.${right}`)
    || right.endsWith(`.${left}`)
    || normalizedMerchant(left) === normalizedMerchant(right);
}

function evaluateOffer(product: Pick<Product, 'id' | 'originalUrl' | 'merchant' | 'merchantDomain'>, offer: ProductOffer, now: number): ComplianceOfferEvaluation {
  const reasonCodes: string[] = [];
  const affiliate = safeHttpsUrl(offer.affiliateUrl);
  const destination = safeHttpsUrl(offer.destinationUrl || product.originalUrl);
  const expectedMerchant = hostname(product.originalUrl)
    || normalizedMerchant(product.merchantDomain || product.merchant);
  const actualMerchant = hostname(offer.destinationUrl)
    || normalizedMerchant(offer.merchant);
  const observed = Date.parse(offer.observedAt);
  const expires = Date.parse(offer.expiresAt || '');
  const age = Number.isFinite(observed) ? now - observed : Number.POSITIVE_INFINITY;
  const confidence = boundedConfidence(offer.confidence);
  const sourceConfidence = boundedConfidence(offer.sourceConfidence);
  const priceConfidence = boundedConfidence(offer.priceConfidence);
  const merchantQuality = boundedConfidence(offer.merchantQuality);
  const trackingPresent = Boolean(
    affiliate
    && [...affiliate.searchParams.keys()].some(key => TRACKING_PATTERN.test(key)),
  );

  if (!SAFE_OFFER_ID.test(String(offer.id || ''))) reasonCodes.push('offer_id_invalid');
  if (!affiliate) reasonCodes.push('affiliate_url_not_safe_https');
  if (!destination) reasonCodes.push('destination_url_not_safe_https');
  if (!relatedMerchant(actualMerchant, expectedMerchant)) reasonCodes.push('merchant_mismatch');
  if (offer.sourceVerified !== true || sourceConfidence < 0.75) reasonCodes.push('source_not_verified');
  if (
    offer.health !== 'HEALTHY'
    || offer.productLinkHealth && offer.productLinkHealth !== 'HEALTHY'
    || offer.affiliateHealth && offer.affiliateHealth !== 'HEALTHY'
  ) reasonCodes.push('offer_unhealthy');
  if (offer.disclosureVerified !== true || !String(offer.affiliateDisclosure || '').trim()) {
    reasonCodes.push('affiliate_disclosure_unverified');
  }
  if (offer.trackingVerified !== true || !trackingPresent) reasonCodes.push('tracking_unverified');
  if (!Number.isFinite(offer.price) || Number(offer.price) <= 0) reasonCodes.push('price_unavailable');
  if ((offer.currency || 'VND') !== 'VND') reasonCodes.push('currency_unsupported');
  if (priceConfidence < 0.75) reasonCodes.push('price_confidence_low');
  if (confidence < 0.75) reasonCodes.push('offer_confidence_low');
  if (!Number.isFinite(observed)) reasonCodes.push('observed_at_invalid');
  else if (age < -CLOCK_SKEW_MS) reasonCodes.push('observation_in_future');
  else if (age > MAX_AGE_MS) reasonCodes.push('offer_stale');
  if (offer.expiresAt && (!Number.isFinite(expires) || expires <= now)) reasonCodes.push('offer_expired');

  return {
    offerId: String(offer.id || '').slice(0, 240),
    eligible: reasonCodes.length === 0,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    price: Number.isFinite(offer.price) && Number(offer.price) > 0 ? Number(offer.price) : null,
    merchantQuality,
    confidence,
    observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : null,
    fingerprint: hash([
      product.id,
      offer.id,
      affiliate?.hostname || '',
      actualMerchant,
      String(offer.price || ''),
      offer.observedAt,
      String(offer.disclosureVerified === true),
      String(offer.trackingVerified === true),
    ].join('|')),
  };
}

export function selectComplianceFirstOffer(
  product: Pick<Product, 'id' | 'originalUrl' | 'merchant' | 'merchantDomain' | 'offers'>,
  now = Date.now(),
): ComplianceOfferDecision {
  const evaluatedAt = Number.isFinite(now) ? now : Date.now();
  const sourceOffers = product.offers || [];
  const offerLimitExceeded = sourceOffers.length > MAX_OFFERS;
  const offers = sourceOffers.slice(0, MAX_OFFERS);
  const idCounts = new Map<string, number>();
  for (const offer of offers) idCounts.set(offer.id, (idCounts.get(offer.id) || 0) + 1);
  const evaluations = offers.map(offer => {
    const evaluation = evaluateOffer(product, offer, evaluatedAt);
    if ((idCounts.get(offer.id) || 0) > 1) {
      evaluation.eligible = false;
      evaluation.reasonCodes = [...new Set([...evaluation.reasonCodes, 'duplicate_offer_id'])].sort();
    }
    if (offerLimitExceeded) {
      evaluation.eligible = false;
      evaluation.reasonCodes = [...new Set([...evaluation.reasonCodes, 'offer_limit_exceeded'])].sort();
    }
    return evaluation;
  });
  const byId = new Map(evaluations.map(evaluation => [evaluation.offerId, evaluation]));
  const ranked = offers
    .filter(offer => byId.get(offer.id)?.eligible)
    .sort((left, right) => (
      Number(left.price) - Number(right.price)
      || boundedConfidence(right.merchantQuality) - boundedConfidence(left.merchantQuality)
      || boundedConfidence(right.confidence) - boundedConfidence(left.confidence)
      || Date.parse(right.observedAt) - Date.parse(left.observedAt)
      || left.id.localeCompare(right.id)
    ));
  const selected = ranked[0];
  const inputHash = hash(JSON.stringify(evaluations
    .map(item => ({ ...item }))
    .sort((left, right) => left.offerId.localeCompare(right.offerId)
      || left.fingerprint.localeCompare(right.fingerprint))));
  return {
    schemaVersion: COMPLIANCE_OFFER_SCHEMA_VERSION,
    ruleVersion: COMPLIANCE_OFFER_RULE_VERSION,
    selectedOfferId: selected?.id || null,
    publicRedirectPath: selected ? `/go/${encodeURIComponent(product.id)}` : null,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    inputHash,
    reasons: offerLimitExceeded
      ? ['offer_limit_exceeded', 'no_compliant_offer']
      : selected
      ? ['compliance_eligible', 'price_ranked', 'merchant_quality_tiebreak', 'stable_id_tiebreak']
      : ['no_compliant_offer'],
    evaluations,
  };
}

export interface ComplianceOfferApplication {
  product: Product;
  decision: ComplianceOfferDecision;
  mode: FeatureRolloutMode;
  applied: boolean;
}

export function applyComplianceOfferPolicy(
  product: Product,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = Date.now(),
): ComplianceOfferApplication {
  const rollout = getFeatureRolloutState('MULTI_AFFILIATE_OFFER', environment);
  const decision = selectComplianceFirstOffer(product, now);
  const selected = product.offers?.find(offer => offer.id === decision.selectedOfferId);
  const applied = rollout.valid && rollout.mode === 'ACTIVE' && Boolean(selected);
  const suggestion = decision.selectedOfferId && decision.publicRedirectPath
    ? {
        schemaVersion: decision.schemaVersion,
        ruleVersion: decision.ruleVersion,
        selectedOfferId: decision.selectedOfferId,
        publicRedirectPath: decision.publicRedirectPath,
        evaluatedAt: decision.evaluatedAt,
        inputHash: decision.inputHash,
        reasons: decision.reasons,
        rolloutMode: rollout.mode,
        applied,
      }
    : undefined;
  return {
    product: {
      ...product,
      ...(suggestion ? { offerSelectionSuggestion: suggestion } : {}),
      ...(applied && selected ? {
        bestOfferId: selected.id,
        affiliateUrl: selected.affiliateUrl,
        offers: (product.offers || []).map(offer => ({
          ...offer,
          primary: offer.id === selected.id,
        })),
      } : {}),
    },
    decision,
    mode: rollout.mode,
    applied,
  };
}
