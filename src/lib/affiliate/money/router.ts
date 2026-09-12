import type { Product } from '../../types';
import { isPublicSafeProductAt } from '../../publicProductFilter';
import { normalizeProductIdentityUrl } from '../../storage/productIdentity';
import { MONEY_LIMITS, type NormalizedAffiliateOffer, type ProviderObservation } from './types';
import { safeMoneyUrl, safeAffiliateDestination, validOfferProvenance } from './validation';

export interface MoneyRouteCandidate { offerId: string; reasons: string[]; score: number[] }
export interface MoneyRouteResult { selected: NormalizedAffiliateOffer | null; reason: string; candidates: MoneyRouteCandidate[] }
export function selectMoneyRoute(product: Product, observations: ProviderObservation[], allowedHosts: readonly string[], now = Date.now(), resolvers: readonly string[] = []): MoneyRouteResult {
  const offers = (product.offers || []).flatMap(offer => offer.monetization ? [offer.monetization] : []);
  const candidates = offers.map(offer => {
    const reasons: string[] = [], observation = observations.find(row => row.health.provider === offer.provider);
    if (!isPublicSafeProductAt(product, now) || product.runtimeRecoveryCanaryObservationPending === true) reasons.push('REJECTED_UNPUBLISHED');
    if (!['accesstrade', 'tiktok'].includes(offer.provider)) reasons.push('REJECTED_PROVIDER_DISABLED');
    if (!observation || !observation.health.enabled || !observation.health.ready || observation.health.state !== 'READY') reasons.push('REJECTED_PROVIDER_DISABLED');
    if (observation && (!observation.capabilities.discovery || observation.origin !== offer.origin)) reasons.push('REJECTED_PROVIDER_CAPABILITY');
    if (!validOfferProvenance(offer)) reasons.push('REJECTED_SOURCE_PROVENANCE');
    if (!Number.isFinite(offer.sourceConfidence) || offer.sourceConfidence < 75 || offer.sourceConfidence > 100) reasons.push('REJECTED_SOURCE_CONFIDENCE');
    if ((offer.campaignRequired && !offer.campaign?.id) || (offer.campaign && offer.campaign.provider !== offer.provider)) reasons.push('REJECTED_MISSING_IDENTITY');
    if (observation && (!Number.isFinite(Date.parse(observation.health.checkedAt)) || now - Date.parse(observation.health.checkedAt) > MONEY_LIMITS.providerAgeMs || Date.parse(observation.health.checkedAt) > now)) reasons.push('REJECTED_PROVIDER_STALE');
    if (offer.validUntil && Date.parse(offer.validUntil) <= now) reasons.push('REJECTED_EXPIRED');
    if (offer.validFrom && Date.parse(offer.validFrom) > now) reasons.push('REJECTED_NOT_STARTED');
    const age = now - Date.parse(offer.lastVerifiedAt), destinationAge = now - Date.parse(offer.destination.verifiedAt || '');
    if (!Number.isFinite(age) || age < 0 || age > MONEY_LIMITS.offerAgeMs || !Number.isFinite(destinationAge) || destinationAge < 0 || destinationAge > MONEY_LIMITS.offerAgeMs) reasons.push('REJECTED_STALE');
    if (offer.monetizationStatus !== 'ELIGIBLE' || offer.availability !== 'AVAILABLE') reasons.push('REJECTED_UNAVAILABLE');
    if (!offer.merchant?.id || !offer.merchant.domain || safeMoneyUrl(offer.destinationUrl) === null
      || new URL(offer.destinationUrl).hostname !== offer.merchant.domain) reasons.push('REJECTED_MERCHANT_IDENTITY');
    if (offer.productId !== product.id || (offer.productIdentity !== normalizeProductIdentityUrl(product.originalUrl)
      && !(product.sourceMappings || []).some(mapping => normalizeProductIdentityUrl(mapping.normalizedOriginalUrl || mapping.originalUrl) === offer.productIdentity))) reasons.push('REJECTED_PRODUCT_IDENTITY');
    if (offer.destination.state !== 'VERIFIED_PROVIDER' || !safeAffiliateDestination(offer.destination.url, offer.destinationUrl, allowedHosts)) reasons.push('REJECTED_UNSAFE_DESTINATION');
    if (offer.destination.attributionRequired && (!resolvers.includes(offer.provider) || !observation?.capabilities.trackingLink
      || observation.capabilities.clickReference !== 'SUB1')) reasons.push('REJECTED_ATTRIBUTION_UNAVAILABLE');
    const score = [offer.sourceConfidence, Math.max(0, 24 - Math.floor(age / 3600000)), offer.provider === 'accesstrade' ? 1 : 0, offer.commissionAmountEstimate === null ? 0 : 1];
    return { offerId: offer.id, reasons, score };
  });
  const eligible = candidates.filter(candidate => candidate.reasons.length === 0);
  const comparableCurrency = new Set(eligible.map(candidate => offers.find(offer => offer.id === candidate.offerId)!.currency)).size === 1;
  eligible.sort((left, right) => {
    for (let dimension = 0; dimension < left.score.length; dimension++) if (left.score[dimension] !== right.score[dimension]) return right.score[dimension] - left.score[dimension];
    const leftOffer = offers.find(offer => offer.id === left.offerId)!, rightOffer = offers.find(offer => offer.id === right.offerId)!;
    if (comparableCurrency && leftOffer.commissionAmountEstimate !== null && rightOffer.commissionAmountEstimate !== null
      && leftOffer.commissionAmountEstimate !== rightOffer.commissionAmountEstimate) return rightOffer.commissionAmountEstimate - leftOffer.commissionAmountEstimate;
    return left.offerId.localeCompare(right.offerId);
  });
  const selected = eligible.length ? offers.find(offer => offer.id === eligible[0].offerId)! : null;
  return { selected, reason: selected?.provider === 'accesstrade' && selected.platform === 'shopee' ? 'SELECTED_ACCESSTRADE_SHOPEE'
    : eligible.length === 1 ? 'SELECTED_ONLY_ELIGIBLE_PROVIDER' : eligible.length ? 'SELECTED_HIGH_CONFIDENCE' : 'NO_MONETIZABLE_OFFER', candidates };
}
