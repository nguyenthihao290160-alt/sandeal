/**
 * Canonical Source Identity — Reusable source identity extraction module.
 *
 * Provides a single, deterministic way to extract source dimensions from
 * candidates, products, and queue items. Used consistently across the
 * pipeline, reliability reports, source quality, selection, and UI.
 */

export interface CanonicalSourceIdentity {
  providerId: string;
  campaignName: string;
  merchantDomain: string;
  affiliateGatewayDomain: string;
  imageHostDomains: string[];
  sourceEndpoint: string;
  sourceItemId: string;
}

export type SourceDiversityStatus =
  | 'HEALTHY_DIVERSITY'
  | 'LIMITED_DIVERSITY'
  | 'INSUFFICIENT_SOURCE_DIVERSITY'
  | 'SINGLE_SOURCE'
  | 'NO_SOURCE';

export interface SourceDiversitySummary {
  status: SourceDiversityStatus;
  discoveredCampaignCount: number;
  discoveredMerchantCount: number;
  eligibleCampaignCount: number;
  eligibleMerchantCount: number;
  healthyCampaignCount: number;
  healthyMerchantCount: number;
  providersChecked: number;
}

/**
 * Extract hostname from a URL, stripping www. prefix and trailing dot.
 * Returns 'unknown' on invalid input.
 */
export function domainFromUrl(value: string | undefined): string {
  try {
    return new URL(value || '').hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Extract canonical source identity from a payload/candidate/product-like
 * object. This is the single normalization point — all callers should use
 * this instead of duplicating field-precedence logic.
 */
export function extractSourceIdentity(input: {
  source?: string;
  providerId?: string;
  campaignName?: string;
  affiliateUrlCampaignId?: string;
  merchantDomain?: string;
  affiliateGatewayDomain?: string;
  affiliateUrl?: string;
  canonicalProductUrl?: string;
  originalUrl?: string;
  imageUrl?: string;
  imageCandidates?: string[];
  sourceEndpoint?: string;
  sourceItemId?: string;
  sourceId?: string;
  externalId?: string;
  payload?: {
    campaignName?: string;
    affiliateUrlCampaignId?: string;
    merchantDomain?: string;
    affiliateUrl?: string;
    canonicalProductUrl?: string;
    originalUrl?: string;
    imageUrl?: string;
    imageCandidates?: string[];
    sourceEndpoint?: string;
    sourceItemId?: string;
  };
  sourceEvidence?: {
    affiliate?: { affiliateGatewayDomain?: string };
    merchant?: { merchantDomain?: string };
  };
}): CanonicalSourceIdentity {
  const payload = input.payload || {};

  const providerId = normalize(input.source || input.providerId || 'unknown');
  const campaignName = normalize(
    input.campaignName
    || payload.campaignName
    || input.affiliateUrlCampaignId
    || payload.affiliateUrlCampaignId
    || 'uncategorized',
  );

  const merchantDomain = normalize(
    input.merchantDomain
    || payload.merchantDomain
    || input.sourceEvidence?.merchant?.merchantDomain
    || domainFromUrl(input.canonicalProductUrl || payload.canonicalProductUrl || input.originalUrl || payload.originalUrl),
  );

  const affiliateGatewayDomain = normalize(
    input.affiliateGatewayDomain
    || input.sourceEvidence?.affiliate?.affiliateGatewayDomain
    || domainFromUrl(input.affiliateUrl || payload.affiliateUrl),
  );

  const imageUrls = [
    input.imageUrl || payload.imageUrl,
    ...(input.imageCandidates || payload.imageCandidates || []),
  ].filter((url): url is string => Boolean(url));
  const imageHostDomains = [...new Set(imageUrls.map(domainFromUrl).filter(d => d !== 'unknown'))].slice(0, 10);

  const sourceEndpoint = normalize(input.sourceEndpoint || payload.sourceEndpoint || 'unknown');
  const sourceItemId = String(input.sourceItemId || payload.sourceItemId || input.sourceId || input.externalId || '').trim().slice(0, 200);

  return {
    providerId,
    campaignName,
    merchantDomain,
    affiliateGatewayDomain,
    imageHostDomains,
    sourceEndpoint,
    sourceItemId,
  };
}

/**
 * Create a stable key for source identity grouping (provider + campaign + merchant).
 */
export function sourceIdentityKey(identity: Pick<CanonicalSourceIdentity, 'providerId' | 'campaignName' | 'merchantDomain'>): string {
  return `${identity.providerId}|${identity.campaignName}|${identity.merchantDomain}`.toLowerCase();
}

/**
 * Create a source quality key including gateway for full fidelity.
 */
export function sourceQualityKey(identity: Pick<CanonicalSourceIdentity, 'providerId' | 'campaignName' | 'merchantDomain' | 'affiliateGatewayDomain'>): string {
  return `${identity.providerId}|${identity.campaignName}|${identity.affiliateGatewayDomain}|${identity.merchantDomain}`.toLowerCase();
}

/**
 * Compute source diversity summary from a set of discovered source identities.
 */
export function computeSourceDiversity(
  discovered: Array<Pick<CanonicalSourceIdentity, 'campaignName' | 'merchantDomain'>>,
  eligible: Array<Pick<CanonicalSourceIdentity, 'campaignName' | 'merchantDomain'>>,
  healthy: Array<Pick<CanonicalSourceIdentity, 'campaignName' | 'merchantDomain'>>,
  providersChecked: number,
): SourceDiversitySummary {
  const campaignSet = (items: typeof discovered) => new Set(items.map(i => i.campaignName.toLowerCase()));
  const merchantSet = (items: typeof discovered) => new Set(items.map(i => i.merchantDomain.toLowerCase()));

  const discoveredCampaigns = campaignSet(discovered);
  const discoveredMerchants = merchantSet(discovered);
  const eligibleCampaigns = campaignSet(eligible);
  const eligibleMerchants = merchantSet(eligible);
  const healthyCampaigns = campaignSet(healthy);
  const healthyMerchants = merchantSet(healthy);

  let status: SourceDiversityStatus;
  if (discoveredCampaigns.size === 0) {
    status = 'NO_SOURCE';
  } else if (discoveredCampaigns.size === 1 && discoveredMerchants.size === 1) {
    status = 'SINGLE_SOURCE';
  } else if (healthyMerchants.size === 0) {
    status = 'INSUFFICIENT_SOURCE_DIVERSITY';
  } else if (healthyMerchants.size === 1 || healthyCampaigns.size === 1) {
    status = 'LIMITED_DIVERSITY';
  } else {
    status = 'HEALTHY_DIVERSITY';
  }

  return {
    status,
    discoveredCampaignCount: discoveredCampaigns.size,
    discoveredMerchantCount: discoveredMerchants.size,
    eligibleCampaignCount: eligibleCampaigns.size,
    eligibleMerchantCount: eligibleMerchants.size,
    healthyCampaignCount: healthyCampaigns.size,
    healthyMerchantCount: healthyMerchants.size,
    providersChecked,
  };
}

function normalize(value: string): string {
  return String(value || '').trim().toLowerCase().slice(0, 200) || 'unknown';
}
