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
  identityStatus: SourceIdentityStatus;
  selectable: boolean;
}

export type SourceIdentityStatus = 'COMPLETE' | 'IDENTITY_INCOMPLETE';

export type SourceIngestionTruthReason =
  | 'SOURCE_SCAN_COMPLETED'
  | 'SOURCE_SCAN_NO_NEW_CANDIDATES'
  | 'SOURCE_SCAN_NO_RESULTS'
  | 'SOURCE_SCAN_FAILED'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_RATE_LIMITED'
  | 'SOURCE_INVALID_CREDENTIAL'
  | 'SOURCE_QUOTA_EXHAUSTED'
  | 'SOURCE_CIRCUIT_OPEN'
  | 'SOURCE_POLICY_PAUSED'
  | 'AFFILIATE_LINK_UNAVAILABLE'
  | 'SOURCE_IDENTITY_INCOMPLETE'
  | 'NO_HEALTHY_PRODUCT_SOURCE';

export interface SourceIngestionTruth {
  ingestionSkipped: boolean;
  reasonCode: SourceIngestionTruthReason;
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
  merchantIdentity?: string;
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
    merchantIdentity?: string;
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
    input.merchantIdentity
    || payload.merchantIdentity
    || input.merchantDomain
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
  const identityStatus = sourceIdentityStatus({ providerId, campaignName, merchantDomain });

  return {
    providerId,
    campaignName,
    merchantDomain,
    affiliateGatewayDomain,
    imageHostDomains,
    sourceEndpoint,
    sourceItemId,
    identityStatus,
    selectable: identityStatus === 'COMPLETE',
  };
}

const INCOMPLETE_DIMENSIONS = new Set([
  '',
  'unknown',
  'uncategorized',
  'uncategorized-campaign',
  'none',
  'n/a',
  'na',
]);

function hasKnownDimension(value: string | undefined): boolean {
  return !INCOMPLETE_DIMENSIONS.has(String(value || '').trim().toLowerCase());
}

/**
 * A source can remain visible for diagnostics without being eligible to
 * participate in current selection or diversity. Provider, campaign and
 * merchant are the minimum stable dimensions used by the selector; an
 * affiliate gateway is intentionally not required for direct sources.
 */
export function sourceIdentityStatus(identity: {
  providerId?: string;
  campaignName?: string;
  merchantDomain?: string;
}): SourceIdentityStatus {
  return hasKnownDimension(identity.providerId)
    && hasKnownDimension(identity.campaignName)
    && hasKnownDimension(identity.merchantDomain)
    ? 'COMPLETE'
    : 'IDENTITY_INCOMPLETE';
}

export function isCompleteSourceIdentity(identity: {
  providerId?: string;
  campaignName?: string;
  merchantDomain?: string;
}): boolean {
  return sourceIdentityStatus(identity) === 'COMPLETE';
}

/**
 * Transport/source truth must not be inferred from whether a new product was
 * enqueued. A successful source can legitimately yield only duplicates or
 * products that are not publication-ready.
 */
export function classifySourceIngestionTruth(input: {
  normalizedCount: number;
  completeSourceCount: number;
  transportHealthySourceCount: number;
  selectionEligibleSourceCount?: number;
  policyBlockedSourceCount?: number;
  materializedCount: number;
  timeoutCount?: number;
  rateLimitedCount?: number;
  failureReasonCode?: Extract<SourceIngestionTruthReason,
    | 'SOURCE_SCAN_FAILED'
    | 'SOURCE_INVALID_CREDENTIAL'
    | 'SOURCE_QUOTA_EXHAUSTED'
    | 'SOURCE_CIRCUIT_OPEN'>;
}): SourceIngestionTruth {
  // A scan that did not return a normalizable record must retain the exact
  // provider outcome. It must not be persisted as a successful/completed
  // scan merely because there was no candidate-level evidence to classify.
  if (input.normalizedCount <= 0) {
    if (input.failureReasonCode) {
      return { ingestionSkipped: true, reasonCode: input.failureReasonCode };
    }
    if (Number(input.rateLimitedCount || 0) > 0) {
      return { ingestionSkipped: true, reasonCode: 'SOURCE_RATE_LIMITED' };
    }
    if (Number(input.timeoutCount || 0) > 0) {
      return { ingestionSkipped: true, reasonCode: 'SOURCE_TIMEOUT' };
    }
    return { ingestionSkipped: false, reasonCode: 'SOURCE_SCAN_NO_RESULTS' };
  }
  if (input.normalizedCount > 0 && input.completeSourceCount <= 0) {
    return { ingestionSkipped: true, reasonCode: 'SOURCE_IDENTITY_INCOMPLETE' };
  }
  if (input.completeSourceCount > 0 && input.transportHealthySourceCount <= 0) {
    return { ingestionSkipped: true, reasonCode: 'NO_HEALTHY_PRODUCT_SOURCE' };
  }
  if (input.transportHealthySourceCount > 0
    && input.selectionEligibleSourceCount !== undefined
    && input.selectionEligibleSourceCount <= 0
    && Number(input.policyBlockedSourceCount || 0) > 0) {
    return { ingestionSkipped: true, reasonCode: 'SOURCE_POLICY_PAUSED' };
  }
  if (input.normalizedCount > 0 && input.materializedCount <= 0) {
    return { ingestionSkipped: false, reasonCode: 'SOURCE_SCAN_NO_NEW_CANDIDATES' };
  }
  return { ingestionSkipped: false, reasonCode: 'SOURCE_SCAN_COMPLETED' };
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
  const complete = (items: typeof discovered) => items.filter(item => isCompleteSourceIdentity({
    providerId: 'diversity-input',
    campaignName: item.campaignName,
    merchantDomain: item.merchantDomain,
  }));
  const campaignSet = (items: typeof discovered) => new Set(complete(items).map(i => i.campaignName.toLowerCase()));
  const merchantSet = (items: typeof discovered) => new Set(complete(items).map(i => i.merchantDomain.toLowerCase()));

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
