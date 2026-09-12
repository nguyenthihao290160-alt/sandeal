export const AFFILIATE_PROVIDER_CONTRACT_VERSION = 'affiliate-provider-v1';

export type AffiliateProviderId = 'accesstrade' | 'tiktok' | 'shopee';

export type AffiliateProviderOperation =
  | 'discoverProducts'
  | 'getProduct'
  | 'getOffers'
  | 'getPromotions'
  | 'createTrackingLink'
  | 'syncTransactions'
  | 'syncCommissions';

export type AffiliateProviderHealthState =
  | 'READY'
  | 'CONFIGURED_NOT_VERIFIED'
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'DISABLED_NO_CREDENTIALS'
  | 'PENDING_EXTERNAL_ACCESS'
  | 'DEGRADED'
  | 'INVALID_CONFIGURATION';

export interface AffiliateProviderHealth {
  provider: AffiliateProviderId;
  state: AffiliateProviderHealthState;
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  credentialsPresent: boolean;
  checkedAt: string;
  reasonCode?: string;
}

export type AffiliateProviderUnavailableReason =
  | 'DISABLED'
  | 'MISSING_CREDENTIALS'
  | 'PENDING_EXTERNAL_ACCESS'
  | 'NOT_IMPLEMENTED'
  | 'NOT_SUPPORTED'
  | 'INVALID_CONFIGURATION'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN_PROVIDER';

export interface AffiliateProviderUnavailable {
  ok: false;
  provider: string;
  error: {
    type: 'PROVIDER_UNAVAILABLE';
    operation: AffiliateProviderOperation;
    reason: AffiliateProviderUnavailableReason;
    state: AffiliateProviderHealthState;
    retryable: boolean;
  };
}

export interface AffiliateProviderSuccess<T> {
  ok: true;
  provider: AffiliateProviderId;
  data: T;
}

export type AffiliateProviderResult<T> =
  | AffiliateProviderSuccess<T>
  | AffiliateProviderUnavailable;

export interface AffiliateProduct<TSource = unknown> {
  provider: AffiliateProviderId;
  externalId: string;
  title: string;
  productUrl: string;
  affiliateUrl?: string;
  imageUrl?: string;
  price?: number;
  currency?: string;
  source: string;
  sourcePayload: TSource;
}

export interface AffiliateOffer<TSource = unknown> {
  provider: AffiliateProviderId;
  externalId: string;
  productExternalId?: string;
  affiliateUrl?: string;
  price?: number;
  currency?: string;
  sourcePayload: TSource;
}

export interface AffiliatePromotion<TSource = unknown> {
  provider: AffiliateProviderId;
  externalId: string;
  title: string;
  startsAt?: string;
  endsAt?: string;
  sourcePayload: TSource;
}

export interface AffiliateDiscoveryInput {
  keyword?: string;
  limit?: number;
  strategy?: string;
}

export interface AffiliateDiscoveryResult<TSource = unknown> {
  products: AffiliateProduct<TSource>[];
  requestCount: number;
  retryAfter?: string;
}

export interface AffiliateTrackingLinkInput {
  productUrl: string;
  productExternalId?: string;
  tracking?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    sub1?: string;
    sub2?: string;
    sub3?: string;
    sub4?: string;
  };
  signal?: AbortSignal;
}

export interface AffiliateTrackingLink {
  url: string;
  createdAt: string;
  source: 'provider_api' | 'provider_payload';
}

export interface AffiliateCapabilities {
  discovery: boolean;
  trackingLink: boolean;
  conversionEvidence: boolean;
  commissionEvidence: boolean;
  clickReference: 'SUB1' | 'UNAVAILABLE';
}

export interface AffiliateSyncInput {
  since?: string;
  cursor?: string;
  limit?: number;
}

export interface AffiliateSyncResult<TSource = unknown> {
  records: TSource[];
  nextCursor?: string;
  requestCount: number;
}

export interface AffiliateProvider<TProductSource = unknown> {
  readonly id: AffiliateProviderId;
  readonly contractVersion: typeof AFFILIATE_PROVIDER_CONTRACT_VERSION;
  getCapabilities(): AffiliateCapabilities;
  discoverProducts(
    input?: AffiliateDiscoveryInput,
  ): Promise<AffiliateProviderResult<AffiliateDiscoveryResult<TProductSource>>>;
  getProduct(
    externalId: string,
  ): Promise<AffiliateProviderResult<AffiliateProduct<TProductSource> | null>>;
  getOffers(
    externalId: string,
  ): Promise<AffiliateProviderResult<AffiliateOffer[]>>;
  getPromotions(
    input?: { limit?: number },
  ): Promise<AffiliateProviderResult<AffiliatePromotion[]>>;
  createTrackingLink(
    input: AffiliateTrackingLinkInput,
  ): Promise<AffiliateProviderResult<AffiliateTrackingLink>>;
  syncTransactions(
    input?: AffiliateSyncInput,
  ): Promise<AffiliateProviderResult<AffiliateSyncResult>>;
  syncCommissions(
    input?: AffiliateSyncInput,
  ): Promise<AffiliateProviderResult<AffiliateSyncResult>>;
  healthCheck(): Promise<AffiliateProviderHealth>;
}

export function providerUnavailable(
  provider: string,
  operation: AffiliateProviderOperation,
  reason: AffiliateProviderUnavailableReason,
  state: AffiliateProviderHealthState,
  retryable = false,
): AffiliateProviderUnavailable {
  return {
    ok: false,
    provider,
    error: {
      type: 'PROVIDER_UNAVAILABLE',
      operation,
      reason,
      state,
      retryable,
    },
  };
}

export function providerSuccess<T>(
  provider: AffiliateProviderId,
  data: T,
): AffiliateProviderSuccess<T> {
  return { ok: true, provider, data };
}
