import { createHash } from 'node:crypto';
import { validateExternalUrl } from '../../product-intelligence/urlValidation';
import { COMMISSION_STATES, MONEY_LIMITS, MoneyError, type AffiliatePlatform, type Commission, type Conversion, type EvidenceOrigin, type NormalizedAffiliateOffer, type OfferSourceEvidence } from './types';
import type { AffiliateProviderId } from '../types';
import { normalizeProductIdentityUrl } from '../../storage/productIdentity';

export function moneyHash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function moneyId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9:_-]{1,160}$/i.test(value)) throw new MoneyError('INVALID_MONEY_ID', 'QUARANTINE');
  return value;
}
export function moneyTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new MoneyError('INVALID_MONEY_TIME', 'QUARANTINE');
  return value;
}
export function moneyCurrency(value: unknown): string {
  if (!['VND', 'USD', 'EUR'].includes(String(value))) throw new MoneyError('UNSUPPORTED_MONEY_CURRENCY', 'QUARANTINE');
  return String(value);
}
export function supportedMoneyProvider(value: unknown): asserts value is AffiliateProviderId {
  if (!['accesstrade', 'tiktok'].includes(String(value))) throw new MoneyError(value === 'shopee' ? 'SHOPEE_EXTERNAL_ACCESS_UNAVAILABLE' : 'UNKNOWN_PROVIDER');
}
export function moneyOrigin(value: EvidenceOrigin, testOnly: boolean) {
  if (value !== 'AUTHENTICATED_PROVIDER_API' && !(testOnly && value === 'TEST_FIXTURE')) throw new MoneyError('UNVERIFIED_EVIDENCE_ORIGIN', 'QUARANTINE');
}
export function moneyPlatform(value: unknown): AffiliatePlatform {
  if (!['shopee','tiktok_shop','lazada','website','other','unknown'].includes(String(value))) throw new MoneyError('INVALID_AFFILIATE_PLATFORM', 'QUARANTINE');
  return value as AffiliatePlatform;
}
export function offerPlatform(source: Record<string, unknown>, merchantDomain: string) {
  const domainPlatform = /^(?:www\.|m\.)?shopee\.vn$/.test(merchantDomain) ? 'shopee'
    : /^(?:www\.|shop\.|vt\.)?tiktok\.com$/.test(merchantDomain) ? 'tiktok_shop'
      : /^(?:www\.)?lazada\.vn$/.test(merchantDomain) ? 'lazada' : null;
  const declared = source.platform == null || source.platform === 'accesstrade' ? 'unknown' : moneyPlatform(source.platform);
  if (domainPlatform && declared !== 'unknown' && declared !== domainPlatform) throw new MoneyError('PROVIDER_PLATFORM_MISMATCH', 'QUARANTINE');
  if (declared === 'shopee' && domainPlatform !== 'shopee') throw new MoneyError('PLATFORM_DOMAIN_MISMATCH', 'QUARANTINE');
  return { platform: domainPlatform || declared, platformBasis: domainPlatform ? 'MERCHANT_DOMAIN' : declared === 'unknown' ? 'UNAVAILABLE' : 'PROVIDER_FIELD' } as const;
}
export function offerSourceEvidence(provider: AffiliateProviderId, source: Record<string, unknown>, externalId: string, platformBasis: OfferSourceEvidence['platformBasis']): OfferSourceEvidence {
  const expectedSource = provider === 'tiktok' ? 'accesstrade_tiktok_shop' : 'accesstrade';
  if ((source.source != null && source.source !== expectedSource) || (source.provider != null && source.provider !== 'accesstrade')
    || (source.affiliateUrlProvider != null && source.affiliateUrlProvider !== 'accesstrade')
    || (source.canonicalUrlProvider != null && source.canonicalUrlProvider !== 'accesstrade')) throw new MoneyError('PROVIDER_PROVENANCE_MISMATCH', 'QUARANTINE');
  const endpoint = source.sourceEndpoint ?? null, affiliateEndpoint = source.affiliateUrlSourceEndpoint ?? null;
  if ((endpoint !== null && !['datafeed','offers','tiktok_product_feed_v2'].includes(String(endpoint)))
    || (affiliateEndpoint !== null && !['datafeed','offers','tiktok_create_link_v2'].includes(String(affiliateEndpoint)))
    || (provider === 'accesstrade' && (String(endpoint).startsWith('tiktok_') || String(affiliateEndpoint).startsWith('tiktok_')))) throw new MoneyError('SOURCE_ENDPOINT_MISMATCH', 'QUARANTINE');
  return { provider: 'accesstrade', endpoint: endpoint as OfferSourceEvidence['endpoint'], externalItemId: moneyId(source.sourceItemId ?? externalId),
    platformBasis, affiliateEndpoint: affiliateEndpoint as OfferSourceEvidence['affiliateEndpoint'],
    affiliateField: source.affiliateUrlSourceField == null ? null : moneyId(source.affiliateUrlSourceField) };
}
export function validOfferProvenance(offer: NormalizedAffiliateOffer) {
  const evidence = offer.sourceEvidence;
  if (!evidence || evidence.provider !== 'accesstrade' || !evidence.externalItemId || !['accesstrade','tiktok'].includes(offer.provider)) return false;
  try { moneyPlatform(offer.platform); } catch { return false; }
  if (offer.provider === 'tiktok' && offer.platform !== 'tiktok_shop') return false;
  if (offer.platform === 'shopee') return offer.provider === 'accesstrade' && evidence.platformBasis === 'MERCHANT_DOMAIN'
    && /^(?:www\.|m\.)?shopee\.vn$/.test(offer.merchant?.domain || '')
    && ['datafeed','offers'].includes(evidence.endpoint || '') && ['datafeed','offers'].includes(evidence.affiliateEndpoint || '')
    && Boolean(evidence.affiliateField) && offer.campaignRequired === true;
  return true;
}
export function exactObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) {
    throw new MoneyError('MALFORMED_PROVIDER_EVIDENCE', 'QUARANTINE');
  }
}
export function conversionEvidence(value: unknown): Conversion {
  exactObject(value, ['eventId', 'externalId', 'attributionReference', 'occurredAt']);
  return { eventId: moneyId(value.eventId), externalId: moneyId(value.externalId),
    attributionReference: moneyId(value.attributionReference), occurredAt: moneyTime(value.occurredAt) };
}
export function commissionEvidence(value: unknown): Commission {
  exactObject(value, ['eventId', 'externalId', 'conversionExternalId', 'revision', 'state', 'amountMinor', 'currency', 'occurredAt']);
  if (!COMMISSION_STATES.includes(value.state as Commission['state']) || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1 || Number(value.revision) > 100000
    || (value.amountMinor === null ? value.state !== 'UNKNOWN' : !Number.isSafeInteger(value.amountMinor)
      || Number(value.amountMinor) < 0 || Number(value.amountMinor) > MONEY_LIMITS.amountMinor)) throw new MoneyError('INVALID_COMMISSION', 'QUARANTINE');
  return { eventId: moneyId(value.eventId), externalId: moneyId(value.externalId), conversionExternalId: moneyId(value.conversionExternalId),
    revision: Number(value.revision), state: value.state as Commission['state'], amountMinor: value.amountMinor as number | null,
    currency: moneyCurrency(value.currency), occurredAt: moneyTime(value.occurredAt) };
}
export function safeMoneyUrl(value: unknown, allowedHosts?: readonly string[]): string | null {
  const result = validateExternalUrl(value);
  if (!result.safe || !result.normalizedUrl) return null;
  const url = new URL(result.normalizedUrl);
  if (url.protocol !== 'https:' || url.port || (allowedHosts && !allowedHosts.includes(url.hostname))) return null;
  if ([...url.searchParams.keys()].some(key => /^(?:api_?key|secret|password|access_?token|authorization)$/i.test(key))) return null;
  return url.toString();
}
export function safeAffiliateDestination(value: unknown, merchantUrl: string, allowedHosts?: readonly string[]) {
  const destination = safeMoneyUrl(value, allowedHosts);
  if (!destination) return null;
  const parsed = new URL(destination);
  for (const [key, nested] of parsed.searchParams) {
    if (/^(?:url|target|redirect|redirect_uri|destination|u)$/i.test(key)
      && (!safeMoneyUrl(nested) || normalizeProductIdentityUrl(nested) !== normalizeProductIdentityUrl(merchantUrl))) return null;
  }
  return destination;
}
