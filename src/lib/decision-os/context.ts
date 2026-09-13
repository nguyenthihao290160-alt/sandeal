import { dealFingerprint } from '../deal-intelligence/evaluate';
import { DEAL_CONFIG } from '../deal-intelligence/config';
import { evidenceTime } from '../deal-intelligence/priceEvidence';
import type { DealEvaluation } from '../deal-intelligence/types';
import { isPublicSafeProductAt } from '../publicProductFilter';
import { selectMoneyRoute, type MoneyRouteResult } from '../affiliate/money/router';
import { MONEY_LIMITS } from '../affiliate/money/types';
import { evaluatePublicOffer } from '../autonomous/offerIntelligence';
import { validTime, EventJobError } from '../platform/cloudflareContracts';
import { DECISION_CONFIG, validDecisionConfig, type DecisionConfig } from './config';
import type { DecisionContext, DecisionInput, DecisionReason, DecisionOutcome, DecisionEvidence } from './types';

const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const score = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
function age(value: unknown, now: number): number {
  const timestamp = evidenceTime(value);
  return timestamp === undefined || timestamp > now ? Infinity : now - timestamp;
}
export function buildDecisionContext(input: DecisionInput, requested: DecisionConfig = DECISION_CONFIG): DecisionContext {
  validTime(input.now);
  if (!/^[a-z0-9-]{1,160}$/i.test(input.product.id) || !Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision < 1
    || (input.product.offers?.length || 0) > 50 || input.providers.length > 2 || input.allowedHosts.length > 50)
    throw new EventJobError('DECISION_INPUT_BOUND', 'QUARANTINE');
  const validConfig = validDecisionConfig(requested), config = validConfig ? requested : DECISION_CONFIG;
  const { product, now } = input, deal = input.deal || {} as DealEvaluation, gates: DecisionContext['gates'] = [];
  const gate = (condition: boolean, outcome: DecisionOutcome, reason: DecisionReason) => { if (condition) gates.push({ outcome, reason }); };
  gate(!validConfig || input.constraints.runtimeValid !== true || input.constraints.executionMode !== 'SHADOW', 'BLOCK', 'INVALID_RUNTIME_CONFIGURATION');
  gate(input.constraints.quarantined === true || (product.quarantineReasons?.length || 0) > 0, 'QUARANTINE', 'QUARANTINED_EVIDENCE');
  gate(typeof input.constraints.quarantined !== 'boolean' || typeof input.constraints.securityRisk !== 'boolean', 'BLOCK', 'INVALID_RUNTIME_CONFIGURATION');
  gate(input.constraints.securityRisk === true || product.riskLevel === 'high', 'BLOCK', 'SECURITY_RISK');
  const confidenceValid = [deal.confidence, deal.discountConfidence, deal.historyConfidence].every(unit);
  const corrupt = deal.productId !== product.id || !/^[a-f0-9]{64}$/.test(deal.evidenceFingerprint)
    || deal.algorithmVersion !== DEAL_CONFIG.algorithmVersion || deal.evidenceVersion !== DEAL_CONFIG.evidenceVersion
    || ![deal.dealScore, deal.priceQualityScore, deal.freshnessScore, deal.offerQualityScore, deal.monetizationScore, deal.evidenceQualityScore].every(score)
    || !score(deal.riskPenalty) || (deal.revenueEvidenceScore !== undefined && !score(deal.revenueEvidenceScore))
    || !Number.isSafeInteger(deal.historicalSampleCount) || deal.historicalSampleCount < 0 || deal.historicalSampleCount > 180
    || !['HIGH', 'MEDIUM', 'LOW'].includes(deal.confidenceBand)
    || !['TOP', 'HIGH', 'NORMAL', 'LOW', 'REJECT'].includes(deal.priority) || !['PUBLISH', 'HOLD', 'REFRESH_FIRST', 'REJECT'].includes(deal.publishRecommendation)
    || !Array.isArray(deal.reasonCodes) || !Array.isArray(deal.riskCodes) || deal.reasonCodes.length > 100 || deal.riskCodes.length > 100
    || evidenceTime(deal.validUntil) === undefined || Date.parse(deal.validUntil) <= Date.parse(deal.evaluatedAt) || age(deal.evaluatedAt, now) === Infinity
    || !['FRESH', 'AGING', 'STALE', 'UNKNOWN'].includes(deal.priceFreshness)
    || !['FRESH', 'AGING', 'STALE', 'UNKNOWN'].includes(deal.offerFreshness)
    || (!input.testOnly && deal.origin !== 'AUTHENTICATED_PROVIDER_API')
    || (input.testOnly === true && deal.origin !== 'TEST_FIXTURE');
  gate(corrupt, 'QUARANTINE', 'CORRUPT_DEAL_EVALUATION');
  gate(!confidenceValid, 'QUARANTINE', 'CONFIDENCE_SCALE_MISMATCH');
  const publicationReady = isPublicSafeProductAt(product, now) && product.runtimeRecoveryCanaryObservationPending !== true;
  gate(!publicationReady, 'BLOCK', 'PUBLICATION_GATE_BLOCK');
  const offers = (product.offers || []).filter(offer => input.testOnly || offer.monetization?.origin !== 'TEST_FIXTURE');
  const providers = input.providers.filter(row => input.testOnly || row.origin !== 'TEST_FIXTURE');
  let route: MoneyRouteResult;
  try { route = selectMoneyRoute({ ...product, offers }, providers, input.allowedHosts, now); }
  catch { gate(true, 'QUARANTINE', 'CORRUPT_DEAL_EVALUATION'); route = { selected: null, reason: 'INVALID_INPUT', candidates: [] }; }
  const selected = route.selected;
  const relevant = selected ? offers.filter(offer => offer.monetization?.id === selected.id) : offers.filter(offer => offer.monetization)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const routeReasons = selected ? [] : route.candidates.flatMap(candidate => candidate.reasons);
  gate(routeReasons.includes('REJECTED_UNSAFE_DESTINATION'), 'BLOCK', 'UNSAFE_DESTINATION');
  gate(routeReasons.includes('REJECTED_MERCHANT_IDENTITY'), 'BLOCK', 'MERCHANT_IDENTITY_REQUIRED');
  gate(routeReasons.includes('REJECTED_MISSING_IDENTITY'), 'BLOCK', 'CAMPAIGN_IDENTITY_REQUIRED');
  gate(routeReasons.includes('REJECTED_EXPIRED'), 'BLOCK', 'OFFER_EXPIRED');
  gate(relevant.some(offer => [offer.confidence, offer.sourceConfidence, offer.priceConfidence].some(value => value !== undefined && !unit(value))),
    'QUARANTINE', 'CONFIDENCE_SCALE_MISMATCH');
  gate(relevant.some(offer => offer.monetization && [offer.monetization.validFrom, offer.monetization.validUntil]
    .some(value => value !== null && evidenceTime(value) === undefined)), 'BLOCK', 'INVALID_OFFER_VALIDITY');
  gate(relevant.some(offer => offer.monetization?.provider === 'shopee'), 'BLOCK', 'DIRECT_SHOPEE_DISABLED');
  const observation = providers.find(row => row.health.provider === (selected?.provider || relevant[0]?.monetization?.provider));
  const providerHealth = observation?.health.enabled && observation.health.state === 'DEGRADED' ? 'DEGRADED'
    : observation?.health.enabled && observation.health.ready && observation.health.state === 'READY'
      && age(observation.health.checkedAt, now) <= MONEY_LIMITS.providerAgeMs ? 'AVAILABLE' : 'UNAVAILABLE';
  gate(providerHealth === 'DEGRADED', 'HOLD', 'PROVIDER_DEGRADED');
  gate(providerHealth === 'UNAVAILABLE', 'BLOCK', 'PROVIDER_UNAVAILABLE');
  const refreshOnly = routeReasons.length > 0 && routeReasons.every(reason => ['REJECTED_STALE', 'REJECTED_PROVIDER_STALE', 'REJECTED_PROVIDER_DISABLED'].includes(reason));
  gate(!selected, refreshOnly ? 'HOLD' : 'BLOCK', 'NO_SAFE_MONETIZATION_PATH');
  gate(!!selected && relevant.some(offer => !evaluatePublicOffer(offer, now).eligible), 'BLOCK', 'PUBLICATION_GATE_BLOCK');
  const price = product.salePrice ?? product.price;
  gate(typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1e12 || deal.currentPrice !== price
    || (!!selected && selected.price !== price), 'BLOCK', 'INVALID_PRICE');
  gate(product.currency !== 'VND' || deal.currency !== 'VND' || (!!selected && selected.currency !== 'VND'), 'BLOCK', 'INVALID_CURRENCY');
  const priceAge = Math.max(age(product.priceObservedAt, now), age(deal.observedAt, now));
  const normalizedOffers = relevant.flatMap(offer => offer.monetization ? [offer.monetization] : []);
  const offerAge = normalizedOffers.length ? Math.max(...normalizedOffers.map(offer =>
    Math.max(age(offer.lastVerifiedAt, now), age(offer.destination?.verifiedAt, now)))) : Infinity;
  gate(priceAge > config.hardPriceAgeMs || offerAge > config.hardOfferAgeMs, 'BLOCK', 'CRITICAL_EVIDENCE_EXPIRED');
  gate(priceAge > DEAL_CONFIG.freshness.freshMs || deal.priceFreshness !== 'FRESH', 'HOLD', 'PRICE_STALE');
  gate(offerAge > DEAL_CONFIG.freshness.offerFreshMs || deal.offerFreshness !== 'FRESH', 'HOLD', 'OFFER_STALE');
  gate(Date.parse(deal.validUntil) <= now || (selected !== null && selected.id !== deal.selectedOfferId), 'HOLD', 'EVIDENCE_CHANGED');
  gate(!['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'COOLDOWN'].includes(input.constraints.systemHealth)
    || !/^[a-z0-9_-]{1,80}$/i.test(input.constraints.systemVersion), 'BLOCK', 'INVALID_RUNTIME_CONFIGURATION');
  gate(['UNAVAILABLE', 'COOLDOWN'].includes(input.constraints.systemHealth), 'HOLD', 'SYSTEM_UNAVAILABLE');
  gate(input.constraints.systemHealth === 'DEGRADED', 'ALLOW_WITH_REVIEW', 'SYSTEM_DEGRADED');
  gate(confidenceValid && deal.confidence < config.reviewConfidence, 'ALLOW_WITH_REVIEW', 'DEAL_CONFIDENCE_LOW');
  gate(deal.dealScore < config.lowScore, 'HOLD', 'DEAL_SCORE_LOW');
  gate(deal.dealScore >= config.highScore, 'ALLOW', 'DEAL_SCORE_HIGH');
  gate(deal.publishRecommendation === 'REJECT', 'BLOCK', 'DEAL_REJECTED');
  gate(deal.publishRecommendation === 'REFRESH_FIRST', 'HOLD', 'EVIDENCE_CHANGED');
  gate(deal.publishRecommendation === 'HOLD' && deal.confidence >= config.reviewConfidence, 'HOLD', 'MANUAL_REVIEW_REQUIRED');
  const positiveRevenue = deal.monetizationState === 'VERIFIED_REVENUE_EVIDENCE' && !!deal.revenueEvidence
    && deal.revenueEvidence.currency === 'VND' && [deal.revenueEvidence.conversions, deal.revenueEvidence.approvedMinor,
      deal.revenueEvidence.paidMinor, deal.revenueEvidence.asOfSequence].every(value => Number.isSafeInteger(value) && value >= 0)
    && deal.revenueEvidence.asOfSequence > 0 && deal.revenueEvidence.approvedMinor + deal.revenueEvidence.paidMinor > 0;
  const provenance = selected || relevant[0]?.monetization;
  const evidence: DecisionEvidence = {
    dealEvaluationId: /^[a-f0-9]{64}$/.test(deal.evidenceFingerprint) ? deal.evidenceFingerprint : 'INVALID',
    dealScore: score(deal.dealScore) ? deal.dealScore : 0, dealConfidence: unit(deal.confidence) ? deal.confidence : 0,
    dealPriority: corrupt ? 'REJECT' : deal.priority, publishRecommendation: corrupt ? 'REJECT' : deal.publishRecommendation,
    dealAlgorithmVersion: DEAL_CONFIG.algorithmVersion,
    money: { status: selected ? 'SAFE' : 'UNAVAILABLE', selectedOfferId: selected?.id || null,
      provider: provenance && ['accesstrade', 'tiktok', 'shopee'].includes(provenance.provider) ? provenance.provider : null,
      platform: provenance && ['shopee', 'tiktok_shop', 'other', 'unknown'].includes(provenance.platform) ? provenance.platform : null, version: 'money-router-v1' },
    publication: { ready: publicationReady, version: 'decision-publication-evidence-v1' },
    priceFreshness: corrupt ? 'UNKNOWN' : deal.priceFreshness, offerFreshness: corrupt ? 'UNKNOWN' : deal.offerFreshness,
    providerHealth, revenue: { state: positiveRevenue ? 'POSITIVE' : 'UNKNOWN', version: positiveRevenue ? deal.revenueEvidence!.asOfSequence : 0 },
    constraints: { executionMode: 'SHADOW', systemHealth: ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'COOLDOWN'].includes(input.constraints.systemHealth) ? input.constraints.systemHealth : 'UNAVAILABLE',
      systemVersion: /^[a-z0-9_-]{1,80}$/i.test(input.constraints.systemVersion) ? input.constraints.systemVersion : 'INVALID',
      securityRisk: input.constraints.securityRisk === true, quarantined: input.constraints.quarantined === true, runtimeValid: validConfig && input.constraints.runtimeValid === true },
  };
  const validityMs = config.ai.enabled ? Math.min(config.validityMs, config.ai.validityMs) : config.validityMs;
  const validityEpoch = Math.floor(now / validityMs);
  const fingerprint = dealFingerprint({ evidence, gates, revision: input.evidenceRevision, config, validityEpoch,
    providerVersions: providers.map(row => ({ provider: ['accesstrade', 'tiktok'].includes(row.health.provider) ? row.health.provider : 'unknown',
      state: ['READY', 'DEGRADED'].includes(row.health.state) ? row.health.state : 'UNAVAILABLE', ready: row.health.ready === true, enabled: row.health.enabled === true,
      checkedAt: evidenceTime(row.health.checkedAt) ?? null })).sort((left, right) => left.provider.localeCompare(right.provider)) });
  const boundaries = [(validityEpoch + 1) * validityMs, Date.parse(deal.validUntil),
    ...[product.priceObservedAt, deal.observedAt].map(value => Date.parse(value || '') + DEAL_CONFIG.freshness.freshMs + 1),
    ...relevant.flatMap(offer => [Date.parse(offer.monetization?.lastVerifiedAt || '') + DEAL_CONFIG.freshness.offerFreshMs + 1,
      Date.parse(offer.monetization?.destination?.verifiedAt || '') + DEAL_CONFIG.freshness.offerFreshMs + 1,
      Date.parse(offer.monetization?.validUntil || '')]),
    Date.parse(observation?.health.checkedAt || '') + MONEY_LIMITS.providerAgeMs + 1];
  return { ...evidence, gates, decisionId: `decision-${fingerprint}`, evidenceFingerprint: fingerprint, productId: product.id,
    origin: input.testOnly ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API', decisionTimestamp: new Date(now).toISOString(),
    validUntil: Math.min(...boundaries.filter(value => Number.isFinite(value) && value > now)), decisionPolicyVersion: config.policyVersion,
    promptVersion: config.ai.enabled ? config.ai.promptVersion : null };
}
