import { createHash } from 'node:crypto';
import { isPublicSafeProductAt } from '../publicProductFilter';
import { evaluatePublicOffer } from '../autonomous/offerIntelligence';
import { selectMoneyRoute } from '../affiliate/money/router';
import { MONEY_LIMITS } from '../affiliate/money/types';
import { EventJobError, validTime } from '../platform/cloudflareContracts';
import { DEAL_CONFIG, boundedScore, unitConfidence, validateDealConfig, type DealConfig } from './config';
import { evidenceTime, freshness, priceEvidence, validPrice } from './priceEvidence';
import type { DealEvaluation, DealFreshness, DealInput, DealPriority, PublishRecommendation } from './types';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, field]) => `${JSON.stringify(key)}:${stable(field)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function dealFingerprint(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

export function evaluateDeal(input: DealInput, config: DealConfig = DEAL_CONFIG): DealEvaluation {
  validateDealConfig(config); validTime(input.now);
  const { product, now } = input;
  if (input.evidenceRevision !== undefined && (!Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision < 1)) throw new EventJobError('DEAL_EVIDENCE_REVISION_INVALID', 'QUARANTINE');
  if (!/^[a-z0-9-]{1,160}$/i.test(product.id) || (product.offers || []).length > config.limits.offers || input.providers.length > 2
    || input.history.length > config.limits.samples + 1 || input.revenue.length > MONEY_LIMITS.snapshotDays) throw new EventJobError('DEAL_INPUT_BOUND', 'QUARANTINE');
  const price = priceEvidence(product, input.history, now, config);
  const { reasons, risks, ...priceFields } = price;
  const eligibleOffers = (product.offers || []).filter(offer => input.testOnly || offer.monetization?.origin !== 'TEST_FIXTURE');
  const providers = input.providers.filter(row => input.testOnly || row.origin !== 'TEST_FIXTURE');
  const safe = isPublicSafeProductAt(product, now) && product.runtimeRecoveryCanaryObservationPending !== true;
  if (!safe) risks.push('PUBLICATION_GATE_DENIED');
  const route = selectMoneyRoute({ ...product, offers: eligibleOffers }, providers, input.allowedHosts, now);
  let selected = route.selected;
  const selectedPublic = eligibleOffers.find(offer => offer.monetization?.id === selected?.id);
  if (selected && selectedPublic) {
    const confidenceValues = [selectedPublic.confidence, selectedPublic.sourceConfidence, selectedPublic.priceConfidence].filter(value => value !== undefined);
    if (confidenceValues.some(value => !Number.isFinite(value) || value! < 0 || value! > 1)) {
      risks.push('CONFIDENCE_SCALE_MISMATCH'); selected = null;
    } else if (!evaluatePublicOffer(selectedPublic, now).eligible) { risks.push('PUBLIC_OFFER_GATE_DENIED'); selected = null; }
    else if (selected.currency !== product.currency || !validPrice(selected.price, config) || selected.price !== price.currentPrice) {
      risks.push('OFFER_PRICE_OR_CURRENCY_MISMATCH'); selected = null;
    } else if ([selected.validFrom, selected.validUntil].some(time => time !== null && evidenceTime(time) === undefined)) {
      risks.push('INVALID_OFFER_VALIDITY'); selected = null;
    }
  }
  if (!selected) {
    risks.push('NO_SAFE_MONETIZATION_PATH');
    for (const candidate of route.candidates) risks.push(...candidate.reasons);
  } else {
    reasons.push('SAFE_MONETIZATION_PATH', 'FRESH_OFFER');
    if (selected.provider === 'accesstrade' && selected.platform === 'shopee') reasons.push('ACCESSTRADE_SHOPEE_VALID');
  }
  const productFreshness = freshness(product.priceObservedAt, now, config);
  if (productFreshness === 'UNKNOWN') risks.push('PRODUCT_VERIFICATION_UNKNOWN');
  if (productFreshness === 'STALE') risks.push('PRODUCT_VERIFICATION_STALE');
  const evidenceOffer = selected || [...eligibleOffers].sort((left, right) => left.id.localeCompare(right.id)).find(offer => offer.monetization)?.monetization;
  const offerConfig = { ...config, freshness: { ...config.freshness, freshMs: config.freshness.offerFreshMs, staleMs: config.freshness.offerStaleMs } };
  const offerFreshness = freshness(evidenceOffer?.lastVerifiedAt, now, offerConfig);
  const destinationFreshness = freshness(evidenceOffer?.destination.verifiedAt, now, offerConfig);
  if (offerFreshness === 'STALE' || destinationFreshness === 'STALE') risks.push('STALE_OFFER');
  const freshPoints = (state: DealFreshness) => state === 'FRESH' ? 100 : state === 'AGING' ? config.points.aging : 0;
  const freshnessScore = boundedScore(Math.min(freshPoints(price.priceFreshness), freshPoints(productFreshness)));
  const offerQualityScore = selected ? boundedScore(selected.sourceConfidence) : 0;
  const knownCommission = selected && ((typeof selected.commissionRate === 'number' && Number.isFinite(selected.commissionRate)
    && selected.commissionRate >= 0 && selected.commissionRate <= 100) || (typeof selected.commissionAmountEstimate === 'number'
    && Number.isFinite(selected.commissionAmountEstimate) && selected.commissionAmountEstimate >= 0 && selected.commissionAmountEstimate <= config.limits.amount));
  if (knownCommission) reasons.push('KNOWN_COMMISSION_TERMS_NOT_PAID_REVENUE');
  const monetizationScore = selected ? boundedScore(config.points.safeRoute + (knownCommission ? config.points.knownCommission : 0)) : 0;
  const identity = product.sourceVerified === true && product.priceVerificationStatus === 'VERIFIED' ? 1 : 0;
  if (!identity) risks.push('PRICE_SOURCE_UNVERIFIED');
  let confidence = unitConfidence(price.historyConfidence * config.confidence.history + freshnessScore / 100 * config.confidence.freshness
    + offerQualityScore / 100 * config.confidence.offer + identity * config.confidence.identity);
  if (price.historyConfidence < config.confidence.high) confidence = Math.min(config.confidence.limitedCap, confidence);
  if (price.currentPrice === undefined || !price.observedAt || !identity) confidence = Math.min(config.confidence.medium, confidence);
  const evidenceQualityScore = boundedScore(confidence * 100);
  if (price.historyConfidence < config.confidence.high) risks.push('LOW_EVIDENCE');
  const from = new Date(now - (MONEY_LIMITS.snapshotDays - 1) * Number(config.dayMs)).toISOString().slice(0, 10);
  const through = new Date(now).toISOString().slice(0, 10);
  const revenueValid = input.revenue.every(row => row.scope === 'PRODUCT' && row.scopeId === product.id && row.currency === config.currency
    && /^\d{4}-\d\d-\d\d$/.test(row.day) && row.day >= from && row.day <= through
    && [row.clicks, row.conversions, row.unknownAmounts, row.asOfSequence, ...Object.values(row.amountsMinor)].every(value => Number.isSafeInteger(value) && value >= 0 && value <= config.limits.amount));
  if (!revenueValid) risks.push('INVALID_REVENUE_EVIDENCE');
  const revenue = revenueValid && selected && input.revenue.length ? {
    conversions: input.revenue.reduce((sum, row) => sum + row.conversions, 0),
    approvedMinor: input.revenue.reduce((sum, row) => sum + row.amountsMinor.APPROVED, 0),
    paidMinor: input.revenue.reduce((sum, row) => sum + row.amountsMinor.PAID, 0),
    currency: String(config.currency), asOfSequence: Math.max(...input.revenue.map(row => row.asOfSequence)),
  } : undefined;
  const verifiedRevenue = revenue && (revenue.paidMinor > 0 || revenue.approvedMinor > 0);
  const revenueEvidenceScore = revenue ? (verifiedRevenue ? 100 : revenue.conversions > 0 ? 50 : 0) : undefined;
  if (verifiedRevenue) reasons.push('VERIFIED_COMMISSION_EVIDENCE');
  else if (revenue && revenue.conversions > 0) reasons.push('CONVERSION_EVIDENCE_AVAILABLE');
  else reasons.push('REVENUE_EVIDENCE_UNKNOWN');
  const penalties = Object.entries(config.penalties).filter(([code]) => risks.includes(code)).map(([code, points]) => ({ code, points }));
  const riskPenalty = penalties.reduce((sum, penalty) => sum + penalty.points, 0);
  const dealScore = boundedScore((price.priceQualityScore * config.weights.price + freshnessScore * config.weights.freshness
    + offerQualityScore * config.weights.offer + monetizationScore * config.weights.monetization + evidenceQualityScore * config.weights.evidence) / 100
    + (revenueEvidenceScore || 0) / 100 * config.points.revenueBonus - riskPenalty);
  const refresh = price.priceFreshness !== 'FRESH' || productFreshness !== 'FRESH' || risks.some(code => /STALE|EXPIRED/.test(code));
  const blocked = !safe || !selected || price.currentPrice === undefined || !identity;
  const publishRecommendation: PublishRecommendation = blocked ? (refresh && safe ? 'REFRESH_FIRST' : 'REJECT')
    : refresh ? 'REFRESH_FIRST' : confidence >= config.confidence.high && dealScore >= config.priority.high ? 'PUBLISH' : 'HOLD';
  const priority: DealPriority = blocked ? 'REJECT' : refresh ? 'LOW' : publishRecommendation === 'PUBLISH'
    ? dealScore >= config.priority.top ? 'TOP' : 'HIGH' : dealScore >= config.priority.normal ? 'NORMAL' : 'LOW';
  const boundaries = [Math.floor(now / config.freshness.refreshMs) * config.freshness.refreshMs];
  const futureBoundaries = [(Math.floor(now / config.freshness.refreshMs) + 1) * config.freshness.refreshMs];
  for (const value of [price.observedAt, product.priceObservedAt, selected?.lastVerifiedAt, selected?.destination.verifiedAt]) {
    const time = evidenceTime(value);
    if (time !== undefined && time <= now) {
      boundaries.push(time);
      for (const age of [config.freshness.freshMs + 1, config.freshness.staleMs + 1]) (time + age <= now ? boundaries : futureBoundaries).push(time + age);
    }
  }
  for (const observation of providers) {
    const time = evidenceTime(observation.health.checkedAt);
    if (time !== undefined && time <= now) {
      boundaries.push(time); (time + MONEY_LIMITS.providerAgeMs + 1 <= now ? boundaries : futureBoundaries).push(time + MONEY_LIMITS.providerAgeMs + 1);
    }
  }
  for (const value of [evidenceOffer?.lastVerifiedAt, evidenceOffer?.destination.verifiedAt]) {
    const time = evidenceTime(value);
    if (time !== undefined && time <= now) for (const age of [config.freshness.offerFreshMs + 1, config.freshness.offerStaleMs + 1])
      (time + age <= now ? boundaries : futureBoundaries).push(time + age);
  }
  for (const row of input.history.slice(0, config.limits.samples)) {
    const time = evidenceTime(row.capturedAt);
    if (time !== undefined && time <= now) for (const days of Object.values(config.windows))
      (time + days * Number(config.dayMs) + 1 <= now ? boundaries : futureBoundaries).push(time + days * Number(config.dayMs) + 1);
  }
  const expires = evidenceTime(selected?.validUntil);
  if (expires !== undefined && expires > now) futureBoundaries.push(expires);
  const evaluatedAt = new Date(Math.max(...boundaries)).toISOString();
  const result = {
    ...priceFields, productId: product.id, evaluatedAt, validUntil: new Date(Math.min(...futureBoundaries)).toISOString(),
    priceObservationAgeMs: price.observedAt ? Date.parse(evaluatedAt) - Date.parse(price.observedAt) : undefined,
    timeSinceLastObservedChangeMs: price.lastObservedChangeAt ? Date.parse(evaluatedAt) - Date.parse(price.lastObservedChangeAt) : undefined,
    origin: input.testOnly ? 'TEST_FIXTURE' as const : 'AUTHENTICATED_PROVIDER_API' as const,
    productFreshness, offerFreshness, destinationFreshness, freshnessScore, offerQualityScore, monetizationScore, evidenceQualityScore,
    revenueEvidenceScore, revenueEvidence: revenue,
    monetizationState: !selected ? 'NO_MONETIZATION_PATH' as const : verifiedRevenue ? 'VERIFIED_REVENUE_EVIDENCE' as const
      : knownCommission || (revenue?.conversions || 0) > 0 ? 'MONETIZATION_EVIDENCE_AVAILABLE' as const : 'MONETIZATION_PATH_AVAILABLE' as const,
    penalties, riskPenalty, dealScore, confidence, confidenceBand: confidence >= config.confidence.high ? 'HIGH' as const : confidence >= config.confidence.medium ? 'MEDIUM' as const : 'LOW' as const,
    priority, publishRecommendation, selectedOfferId: selected?.id, provider: selected?.provider, platform: selected?.platform,
    merchantId: selected?.merchant.id, campaignId: selected?.campaign?.id,
    reasonCodes: [...new Set(reasons)].sort(), riskCodes: [...new Set(risks)].sort(),
    signals: [{ code: 'PRICE_QUALITY', score: price.priceQualityScore }, { code: 'FRESHNESS', score: freshnessScore },
      { code: 'OFFER_QUALITY', score: offerQualityScore }, { code: 'MONETIZATION', score: monetizationScore },
      { code: 'EVIDENCE_QUALITY', score: evidenceQualityScore }, { code: 'REVENUE_EVIDENCE', score: revenueEvidenceScore }],
    evidenceVersion: String(config.evidenceVersion), algorithmVersion: String(config.algorithmVersion),
  };
  return { ...result, evidenceFingerprint: dealFingerprint({ result, config,
    evidenceRevision: input.evidenceRevision,
    productEvidence: { id: product.id, source: product.source, sourceVerified: product.sourceVerified, priceVerificationStatus: product.priceVerificationStatus },
    selectedEvidence: selected ? { id: selected.id, lastVerifiedAt: selected.lastVerifiedAt, destinationVerifiedAt: selected.destination.verifiedAt,
      sourceEvidence: selected.sourceEvidence,
      commissionRate: selected.commissionRate, commissionAmountEstimate: selected.commissionAmountEstimate, campaign: selected.campaign,
      availability: selected.availability, validFrom: selected.validFrom, validUntil: selected.validUntil, origin: selected.origin } : undefined,
    history: input.history.map(row => [row.id, row.capturedAt, row.price, row.salePrice, row.currency, row.availability, row.source]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    route: route.candidates.map(candidate => [candidate.offerId, candidate.reasons, candidate.score]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))) }) };
}
