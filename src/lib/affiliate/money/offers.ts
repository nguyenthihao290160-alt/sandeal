import type { AffiliateProduct, AffiliateProvider } from '../types';
import type { DomainStorage } from '../../storage/domainStorage';
import type { Product, ProductOffer, ProductSource } from '../../types';
import { normalizeProductIdentityUrl } from '../../storage/productIdentity';
import { MONEY_LIMITS, MoneyError, type EvidenceOrigin, type NormalizedAffiliateOffer } from './types';
import { moneyCurrency, moneyHash, moneyId, moneyOrigin, moneyTime, offerPlatform, offerSourceEvidence, safeMoneyUrl, supportedMoneyProvider, validOfferProvenance } from './validation';

function optionalAmount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MONEY_LIMITS.amountMinor) throw new MoneyError('MALFORMED_PROVIDER_AMOUNT', 'QUARANTINE');
  return value;
}
function optionalTime(value: unknown): string | null { return value == null ? null : moneyTime(value); }

export function normalizeAffiliateOffer(product: Product, item: AffiliateProduct, origin: EvidenceOrigin, testOnly = false): NormalizedAffiliateOffer {
  supportedMoneyProvider(item.provider); moneyOrigin(origin, testOnly); moneyId(item.externalId);
  if (!item.sourcePayload || typeof item.sourcePayload !== 'object' || Array.isArray(item.sourcePayload)) throw new MoneyError('MALFORMED_OFFER', 'QUARANTINE');
  const source = item.sourcePayload as Record<string, unknown>;
  if (item.source !== (item.provider === 'tiktok' ? 'accesstrade_tiktok_shop' : 'accesstrade')) throw new MoneyError('PROVIDER_PROVENANCE_MISMATCH', 'QUARANTINE');
  const destinationUrl = safeMoneyUrl(item.productUrl), identity = normalizeProductIdentityUrl(item.productUrl);
  const canonical = normalizeProductIdentityUrl(product.originalUrl);
  const mapped = (product.sourceMappings || []).some(mapping => normalizeProductIdentityUrl(mapping.normalizedOriginalUrl || mapping.originalUrl) === identity);
  if (!destinationUrl || !identity || (identity !== canonical && !mapped)) throw new MoneyError('PRODUCT_IDENTITY_MISMATCH', 'QUARANTINE');
  const merchantDomain = typeof source.merchantDomain === 'string' ? source.merchantDomain.toLowerCase() : '';
  if (!merchantDomain || merchantDomain !== new URL(destinationUrl).hostname) throw new MoneyError('MISSING_OR_MISMATCHED_MERCHANT', 'QUARANTINE');
  const { platform, platformBasis } = offerPlatform(source, merchantDomain);
  const sourceEvidence = offerSourceEvidence(item.provider, source, item.externalId, platformBasis);
  const campaignId = source.affiliateUrlCampaignId ? moneyId(source.affiliateUrlCampaignId) : null;
  const campaignRequired = platform === 'shopee' || source.campaignRequired === true;
  if (campaignRequired && !campaignId) throw new MoneyError('MISSING_CAMPAIGN_IDENTITY', 'QUARANTINE');
  const verifiedAt = moneyTime(source.affiliateUrlFetchedAt ?? source.fetchedAt);
  const affiliateUrl = safeMoneyUrl(item.affiliateUrl);
  const verified = source.affiliateUrlSource === 'provider_api' && source.affiliateUrlStatus === 'available' && source.verifiedSource === true;
  const sourceConfidence = source.verifiedSource === true ? 100 : 0;
  const commissionRate = optionalAmount(source.commissionRate);
  if (commissionRate !== null && commissionRate > 100) throw new MoneyError('INVALID_COMMISSION_RATE', 'QUARANTINE');
  const offer: NormalizedAffiliateOffer = {
    id: `offer-${moneyHash(JSON.stringify([item.provider, item.externalId, platform, merchantDomain, campaignId]))}`, provider: item.provider, externalId: item.externalId,
    platform, sourceEvidence, campaignRequired,
    productExternalId: item.externalId, productId: product.id, productIdentity: identity,
    merchant: { id: `merchant-${moneyHash(merchantDomain)}`, domain: merchantDomain, externalId: source.shopId ? moneyId(source.shopId) : null },
    campaign: campaignId ? { id: campaignId, provider: item.provider } : null,
    destinationUrl, destination: { url: affiliateUrl, state: verified && affiliateUrl ? 'VERIFIED_PROVIDER' : 'UNAVAILABLE',
      verifiedAt: verified ? verifiedAt : null, attributionRequired: source.attributionRequired === true },
    price: optionalAmount(item.price), originalPrice: optionalAmount(source.price), currency: moneyCurrency(item.currency),
    commissionRate, commissionAmountEstimate: optionalAmount(source.commissionAmount),
    validFrom: optionalTime(source.validFrom), validUntil: optionalTime(source.validUntil),
    availability: source.available === true ? 'AVAILABLE' : source.available === false ? 'UNAVAILABLE' : 'UNKNOWN',
    lastVerifiedAt: verifiedAt, sourceConfidence, monetizationStatus: verified && affiliateUrl ? 'ELIGIBLE' : 'UNAVAILABLE', origin,
  };
  if (!validOfferProvenance(offer)) throw new MoneyError('MISSING_OR_INVALID_SOURCE_EVIDENCE', 'QUARANTINE');
  return offer;
}
function projectedOffer(offer: NormalizedAffiliateOffer): ProductOffer {
  return { id: offer.id, source: offer.provider, merchant: offer.merchant.domain, affiliateUrl: offer.destination.url || '',
    price: offer.price ?? undefined, originalPrice: offer.originalPrice ?? undefined, currency: offer.currency === 'VND' ? 'VND' : undefined,
    observedAt: offer.lastVerifiedAt, expiresAt: offer.validUntil ?? undefined, health: 'UNKNOWN', confidence: offer.sourceConfidence / 100,
    primary: false, destinationUrl: offer.destinationUrl, monetization: offer };
}
export async function persistNormalizedOffers(domain: DomainStorage, productId: string, offers: NormalizedAffiliateOffer[]) {
  if (!offers.length || offers.length > MONEY_LIMITS.offers || offers.some(offer => offer.productId !== productId)) throw new MoneyError('INVALID_OFFER_BATCH');
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await domain.getProduct(productId);
    if (!stored) throw new MoneyError('PRODUCT_NOT_FOUND');
    const merged = new Map((stored.value.offers || []).map(offer => [offer.id, offer]));
    for (const offer of offers) {
      if (normalizeProductIdentityUrl(stored.value.originalUrl) !== offer.productIdentity
        && !(stored.value.sourceMappings || []).some(mapping => normalizeProductIdentityUrl(mapping.normalizedOriginalUrl || mapping.originalUrl) === offer.productIdentity)) throw new MoneyError('PRODUCT_IDENTITY_CHANGED');
      const previous = merged.get(offer.id)?.monetization;
      if (previous && previous.lastVerifiedAt > offer.lastVerifiedAt) throw new MoneyError('OLDER_OFFER_OBSERVATION');
      for (const [storedId, storedOffer] of merged) {
        const legacy = storedOffer.monetization;
        if (legacy && !legacy.sourceEvidence && legacy.provider === offer.provider && legacy.externalId === offer.externalId
          && legacy.merchant.domain === offer.merchant.domain && legacy.campaign?.id === offer.campaign?.id) {
          if (legacy.lastVerifiedAt > offer.lastVerifiedAt) throw new MoneyError('OLDER_OFFER_OBSERVATION');
          merged.delete(storedId);
        }
      }
      merged.set(offer.id, projectedOffer(offer));
    }
    if (merged.size > MONEY_LIMITS.offers) throw new MoneyError('OFFER_LIMIT_REACHED');
    const next = [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
    if (JSON.stringify(next) === JSON.stringify(stored.value.offers)) return;
    const result = await domain.replaceProduct({ ...stored.value, offers: next }, stored.version);
    if (result.status === 'APPLIED') return;
    if (result.status !== 'CONFLICT' || result.reason !== 'VERSION') throw new MoneyError('OFFER_PERSISTENCE_REJECTED');
  }
  throw new MoneyError('OFFER_WRITE_CONTENTION', 'RETRYABLE');
}
export async function discoverNormalizedOffers(provider: AffiliateProvider, domain: DomainStorage, input: {
  keyword?: string; limit: number; origin?: EvidenceOrigin; testOnly?: boolean;
}) {
  supportedMoneyProvider(provider.id);
  if (!provider.getCapabilities().discovery) throw new MoneyError('DISCOVERY_UNAVAILABLE');
  const health = await provider.healthCheck();
  if (health.provider !== provider.id || !health.ready || !health.enabled || health.state !== 'READY') throw new MoneyError('PROVIDER_DISABLED');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new MoneyError('INVALID_DISCOVERY_BOUND');
  const response = await provider.discoverProducts({ keyword: input.keyword, limit: input.limit });
  if (!response.ok) throw new MoneyError(response.error.reason, response.error.retryable ? 'RETRYABLE' : 'FINAL');
  if (response.provider !== provider.id || !Array.isArray(response.data.products) || response.data.products.length > input.limit) throw new MoneyError('MALFORMED_DISCOVERY', 'QUARANTINE');
  const offers: NormalizedAffiliateOffer[] = [], unmatched: string[] = [];
  for (const item of response.data.products) {
    if (item.provider !== provider.id) throw new MoneyError('PROVIDER_MISMATCH', 'QUARANTINE');
    const matches = await domain.findProductIdentity({ source: item.source as ProductSource, sourceId: moneyId(item.externalId),
      normalizedOriginalUrl: normalizeProductIdentityUrl(item.productUrl) });
    if (matches.length !== 1) { unmatched.push(item.externalId); continue; }
    offers.push(normalizeAffiliateOffer(matches[0].value, item, input.origin || 'AUTHENTICATED_PROVIDER_API', input.testOnly));
  }
  for (const productId of [...new Set(offers.map(offer => offer.productId))]) await persistNormalizedOffers(domain, productId, offers.filter(offer => offer.productId === productId));
  return { offers, unmatched, requestCount: response.data.requestCount };
}
