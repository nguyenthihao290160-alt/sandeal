import { createHash } from 'node:crypto';
import type { Product, ProductIdentity, ProductOffer } from '@/lib/types';

export const IDENTITY_SCHEMA_VERSION = 2;
export const IDENTITY_RULE_VERSION = 'product-identity-v2';
export const OFFER_RULE_VERSION = 'offer-selection-v2';

export type IdentityStrategy = 'GTIN' | 'SOURCE_ID' | 'EXTERNAL_ID' | 'CANONICAL_URL' | 'MERCHANT_SKU' | 'BRAND_MODEL' | 'MERCHANT_TITLE' | 'IMAGE' | 'INSUFFICIENT';

export interface ResolvedProductIdentity extends ProductIdentity {
  schemaVersion: number;
  identityKey: string;
  identityStrategy: IdentityStrategy;
  identityStrength: number;
  sourceNamespace?: string;
}

export interface VersionedProductOffer extends ProductOffer {
  schemaVersion: number;
  offerKey: string;
  observationHash: string;
  ruleVersion: string;
}

const TRACKING_KEYS = /^(?:utm_.+|aff(?:iliate)?(?:_?id)?|click_?id|sub(?:_?id)?|tracking|ref|referrer|campaign_?id)$/i;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeIdentityText(value?: string): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeCode(value?: string): string | undefined {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  return normalized || undefined;
}

function normalizeGtin(value?: string): string | undefined {
  const normalized = String(value || '').replace(/\D/g, '');
  return [8, 12, 13, 14].includes(normalized.length) ? normalized : undefined;
}

export function canonicalizeProductUrl(value?: string): string | undefined {
  try {
    const url = new URL(value || '');
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) if (TRACKING_KEYS.test(key)) url.searchParams.delete(key);
    const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = '';
    for (const [key, item] of sorted) url.searchParams.append(key, item);
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return undefined;
  }
}

function merchantFromUrl(value?: string): string | undefined {
  try { return new URL(value || '').hostname.toLowerCase().replace(/^www\./, ''); } catch { return undefined; }
}

function chooseStrongestIdentity(input: {
  gtin?: string;
  sourceNamespace?: string;
  sourceId?: string;
  externalId?: string;
  canonicalUrl?: string;
  merchant?: string;
  sku?: string;
  brand?: string;
  model?: string;
  normalizedTitle: string;
  imageFingerprint?: string;
}): { strategy: IdentityStrategy; key: string; strength: number } {
  if (input.gtin) return { strategy: 'GTIN', key: `gtin:${input.gtin}`, strength: 1 };
  if (input.sourceNamespace && input.sourceId) return { strategy: 'SOURCE_ID', key: `source:${input.sourceNamespace}:${input.sourceId}`, strength: 0.99 };
  if (input.sourceNamespace && input.externalId) return { strategy: 'EXTERNAL_ID', key: `external:${input.sourceNamespace}:${input.externalId}`, strength: 0.985 };
  if (input.canonicalUrl) return { strategy: 'CANONICAL_URL', key: `url:${input.canonicalUrl}`, strength: 0.98 };
  if (input.merchant && input.sku) return { strategy: 'MERCHANT_SKU', key: `sku:${input.merchant}:${input.sku}`, strength: 0.95 };
  if (input.brand && input.model) return { strategy: 'BRAND_MODEL', key: `model:${input.brand}:${input.model}`, strength: 0.9 };
  if (input.merchant && input.normalizedTitle) return { strategy: 'MERCHANT_TITLE', key: `title:${input.merchant}:${input.normalizedTitle}`, strength: 0.78 };
  if (input.imageFingerprint) return { strategy: 'IMAGE', key: `image:${input.imageFingerprint}`, strength: 0.7 };
  return { strategy: 'INSUFFICIENT', key: `unknown:${input.normalizedTitle || 'empty'}`, strength: 0.2 };
}

export function deriveProductIdentity(product: Partial<Product>): ResolvedProductIdentity {
  const canonicalUrl = canonicalizeProductUrl(product.originalUrl);
  const normalizedTitle = normalizeIdentityText(product.title);
  const sourceNamespace = normalizeIdentityText(String(product.source || '')) || undefined;
  const merchant = merchantFromUrl(product.originalUrl);
  const gtin = normalizeGtin(product.gtin);
  const sku = normalizeCode(product.sku);
  const brandKey = normalizeIdentityText(product.brand);
  const modelKey = normalizeIdentityText(product.mpn);
  const imageFingerprint = product.imageUrl ? hash(canonicalizeProductUrl(product.imageUrl) || product.imageUrl) : undefined;
  const strongest = chooseStrongestIdentity({
    gtin,
    sourceNamespace,
    sourceId: normalizeCode(product.sourceId),
    externalId: normalizeCode(product.externalId),
    canonicalUrl,
    merchant,
    sku,
    brand: brandKey || undefined,
    model: modelKey || undefined,
    normalizedTitle,
    imageFingerprint,
  });
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    sourceId: product.sourceId,
    externalId: product.externalId,
    canonicalUrl,
    affiliateUrl: product.affiliateUrl,
    sku,
    brand: product.brand,
    model: product.mpn,
    gtin,
    normalizedTitle,
    merchant,
    imageFingerprint,
    identityKey: strongest.key,
    identityHash: hash(strongest.key),
    identityStrategy: strongest.strategy,
    identityStrength: strongest.strength,
    sourceNamespace,
    ruleVersion: IDENTITY_RULE_VERSION,
  };
}

function resolved(identity: ProductIdentity): Partial<ResolvedProductIdentity> {
  return identity as ResolvedProductIdentity;
}

export function identityMatchConfidence(left: ProductIdentity, right: ProductIdentity): number {
  const leftResolved = resolved(left);
  const rightResolved = resolved(right);
  if (leftResolved.identityKey && rightResolved.identityKey && leftResolved.identityKey === rightResolved.identityKey) {
    return Math.min(leftResolved.identityStrength || 0.99, rightResolved.identityStrength || 0.99);
  }
  const leftGtin = normalizeGtin(left.gtin);
  const rightGtin = normalizeGtin(right.gtin);
  if (leftGtin && rightGtin && leftGtin === rightGtin) return 1;
  const sameSourceNamespace = leftResolved.sourceNamespace && rightResolved.sourceNamespace && leftResolved.sourceNamespace === rightResolved.sourceNamespace;
  if (sameSourceNamespace && left.sourceId && right.sourceId && normalizeCode(left.sourceId) === normalizeCode(right.sourceId)) return 0.99;
  if (sameSourceNamespace && left.externalId && right.externalId && normalizeCode(left.externalId) === normalizeCode(right.externalId)) return 0.985;
  if (left.canonicalUrl && right.canonicalUrl && canonicalizeProductUrl(left.canonicalUrl) === canonicalizeProductUrl(right.canonicalUrl)) return 0.98;
  if (left.sku && right.sku && normalizeCode(left.sku) === normalizeCode(right.sku) && left.merchant && left.merchant === right.merchant) return 0.95;
  const sameModel = left.model && right.model && normalizeIdentityText(left.model) === normalizeIdentityText(right.model);
  const sameBrand = left.brand && right.brand && normalizeIdentityText(left.brand) === normalizeIdentityText(right.brand);
  if (sameModel && sameBrand) return 0.9;
  const titleMatch = Boolean(left.normalizedTitle && left.normalizedTitle === right.normalizedTitle);
  if (titleMatch && sameBrand) return 0.86;
  if (titleMatch && left.merchant && left.merchant === right.merchant) return 0.78;
  if (titleMatch) return 0.55;
  return 0;
}

function offerIdentityKey(offer: ProductOffer): string {
  const versioned = offer as VersionedProductOffer;
  if (versioned.offerKey) return versioned.offerKey;
  const canonicalAffiliate = canonicalizeProductUrl(offer.affiliateUrl) || offer.affiliateUrl;
  return hash(`${normalizeIdentityText(offer.source)}|${normalizeIdentityText(offer.merchant)}|${canonicalAffiliate}`);
}

function offerObservationHash(offer: ProductOffer, key = offerIdentityKey(offer)): string {
  const versioned = offer as VersionedProductOffer;
  return versioned.observationHash || hash(JSON.stringify({
    offerKey: key,
    price: offer.price || null,
    originalPrice: offer.originalPrice || null,
    voucher: offer.voucher || null,
    affiliateUrl: offer.affiliateUrl,
    health: offer.health,
    productLinkHealth: offer.productLinkHealth || null,
    affiliateHealth: offer.affiliateHealth || null,
    sourceVerified: offer.sourceVerified === true,
    sourceConfidence: offer.sourceConfidence ?? null,
    merchantQuality: offer.merchantQuality ?? null,
    priceConfidence: offer.priceConfidence ?? null,
    observedAt: offer.observedAt,
    expiresAt: offer.expiresAt || null,
    confidence: offer.confidence,
  }));
}

export function buildOffer(product: Partial<Product>, observedAt = new Date().toISOString()): VersionedProductOffer {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) throw new Error('OFFER_OBSERVED_AT_INVALID');
  const merchant = merchantFromUrl(product.originalUrl) || String(product.source || 'unknown');
  const source = String(product.source || 'other');
  const numericPrice = Number(product.salePrice || product.price || 0);
  const price = Number.isFinite(numericPrice) && numericPrice > 0 ? numericPrice : undefined;
  const numericOriginalPrice = Number(product.price || 0);
  const originalPrice = Number.isFinite(numericOriginalPrice) && numericOriginalPrice > 0 ? numericOriginalPrice : undefined;
  const toOfferHealth = (value?: string): ProductOffer['health'] => {
    const status = String(value || '').toLowerCase();
    if (['ok', 'healthy', 'redirect_ok'].includes(status)) return 'HEALTHY';
    if (['broken', 'not_found', 'invalid', 'blocked', 'image_broken', 'invalid_image'].includes(status)) return 'BROKEN';
    if (['timeout', 'rate_limited', 'server_error', 'dns_error'].includes(status)) return 'DEGRADED';
    return 'UNKNOWN';
  };
  const productLinkHealth = toOfferHealth(product.linkHealthStatus);
  const affiliateHealth = toOfferHealth(product.affiliateHealthStatus);
  const sourceVerified = product.verifiedSource === true || product.sourceVerified === true;
  const sourceConfidence = product.confidences?.source ?? (sourceVerified ? 0.98 : 0.5);
  const priceConfidence = product.confidences?.price ?? (price ? (sourceVerified ? 0.95 : 0.5) : 0);
  const merchantQuality = Math.max(0, Math.min(1, sourceConfidence * 0.7 + (productLinkHealth === 'HEALTHY' && affiliateHealth === 'HEALTHY' ? 0.3 : 0)));
  const confidence = Math.min(
    sourceConfidence,
    priceConfidence,
    productLinkHealth === 'HEALTHY' ? 0.98 : productLinkHealth === 'BROKEN' ? 0.05 : productLinkHealth === 'DEGRADED' ? 0.4 : 0.3,
    affiliateHealth === 'HEALTHY' ? 0.98 : affiliateHealth === 'BROKEN' ? 0.05 : affiliateHealth === 'DEGRADED' ? 0.4 : 0.3,
  );
  const affiliateUrl = String(product.affiliateUrl || '');
  const canonicalAffiliate = canonicalizeProductUrl(affiliateUrl) || affiliateUrl;
  const offerKey = hash(`${normalizeIdentityText(source)}|${normalizeIdentityText(merchant)}|${canonicalAffiliate}`);
  const base: ProductOffer = {
    id: `offer-${offerKey.slice(0, 20)}`,
    source,
    merchant,
    price,
    originalPrice: originalPrice && (!price || originalPrice >= price) ? originalPrice : undefined,
    affiliateUrl,
    health: affiliateHealth,
    productLinkHealth,
    affiliateHealth,
    sourceVerified,
    sourceConfidence,
    merchantQuality,
    priceConfidence,
    currency: 'VND',
    observedAt,
    expiresAt: new Date(observedMs + 72 * 60 * 60_000).toISOString(),
    confidence,
    primary: false,
  };
  return {
    ...base,
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    offerKey,
    observationHash: offerObservationHash(base, offerKey),
    ruleVersion: OFFER_RULE_VERSION,
  };
}

function versionOffer(offer: ProductOffer): VersionedProductOffer {
  const offerKey = offerIdentityKey(offer);
  return {
    ...offer,
    id: `offer-${offerKey.slice(0, 20)}`,
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    offerKey,
    observationHash: offerObservationHash(offer, offerKey),
    ruleVersion: (offer as VersionedProductOffer).ruleVersion || OFFER_RULE_VERSION,
  };
}

export function mergeOffers(existing: ProductOffer[] = [], incoming: ProductOffer[]): VersionedProductOffer[] {
  const byKey = new Map<string, VersionedProductOffer>();
  for (const candidate of [...existing, ...incoming].map(versionOffer)) {
    const previous = byKey.get(candidate.offerKey);
    if (!previous) {
      byKey.set(candidate.offerKey, candidate);
      continue;
    }
    if (previous.observationHash === candidate.observationHash) continue;
    const previousTime = Date.parse(previous.observedAt);
    const candidateTime = Date.parse(candidate.observedAt);
    const replace = candidateTime > previousTime
      || (candidateTime === previousTime && (candidate.confidence > previous.confidence
        || (candidate.confidence === previous.confidence && candidate.observationHash > previous.observationHash)));
    if (replace) {
      const priceChanged = Number(previous.price || 0) > 0
        && Number(candidate.price || 0) > 0
        && previous.price !== candidate.price;
      byKey.set(candidate.offerKey, {
        ...candidate,
        previousPrice: priceChanged ? previous.price : candidate.previousPrice ?? previous.previousPrice,
        previousPriceObservedAt: priceChanged ? previous.observedAt : candidate.previousPriceObservedAt ?? previous.previousPriceObservedAt,
      });
    }
  }
  return [...byKey.values()].sort((left, right) => right.confidence - left.confidence || Date.parse(right.observedAt) - Date.parse(left.observedAt) || left.id.localeCompare(right.id));
}

export { selectBestPublicOffer } from './offerIntelligence';
