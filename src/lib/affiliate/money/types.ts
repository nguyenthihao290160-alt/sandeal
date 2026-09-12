import type { AffiliateCapabilities, AffiliateOffer, AffiliateProviderHealth, AffiliateProviderId } from '../types';
import type { ProductPlatform } from '../../types';

export const MONEY_LIMITS = { offers: 50, evidenceBatch: 20, snapshotEvents: 10, snapshotDays: 31,
  offerAgeMs: 86_400_000, providerAgeMs: 3_600_000, amountMinor: 1_000_000_000_000 } as const;
export const COMMISSION_STATES = ['UNKNOWN', 'ESTIMATED', 'PENDING', 'APPROVED', 'REJECTED', 'PAID'] as const;
export type CommissionState = typeof COMMISSION_STATES[number];
export type EvidenceOrigin = 'AUTHENTICATED_PROVIDER_API' | 'TEST_FIXTURE';
export type AffiliatePlatform = Exclude<ProductPlatform, 'accesstrade'> | 'unknown';
export interface OfferSourceEvidence {
  provider: 'accesstrade';
  endpoint: 'datafeed' | 'offers' | 'tiktok_product_feed_v2' | null;
  externalItemId: string;
  platformBasis: 'MERCHANT_DOMAIN' | 'PROVIDER_FIELD' | 'UNAVAILABLE';
  affiliateEndpoint: 'datafeed' | 'offers' | 'tiktok_create_link_v2' | null;
  affiliateField: string | null;
}
export interface Merchant { id: string; domain: string; externalId: string | null }
export interface Campaign { id: string; provider: AffiliateProviderId }
export interface AffiliateDestination {
  url: string | null;
  state: 'VERIFIED_PROVIDER' | 'UNAVAILABLE';
  verifiedAt: string | null;
  attributionRequired: boolean;
}
export interface NormalizedAffiliateOffer extends Omit<AffiliateOffer, 'sourcePayload' | 'price' | 'currency' | 'affiliateUrl'> {
  id: string;
  platform: AffiliatePlatform;
  sourceEvidence: OfferSourceEvidence;
  campaignRequired: boolean;
  productId: string;
  productIdentity: string;
  merchant: Merchant;
  campaign: Campaign | null;
  destinationUrl: string;
  destination: AffiliateDestination;
  price: number | null;
  originalPrice: number | null;
  currency: string;
  commissionRate: number | null;
  commissionAmountEstimate: number | null;
  validFrom: string | null;
  validUntil: string | null;
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  lastVerifiedAt: string;
  sourceConfidence: number;
  monetizationStatus: 'ELIGIBLE' | 'UNAVAILABLE';
  origin: EvidenceOrigin;
}
export interface ProviderObservation {
  health: AffiliateProviderHealth;
  capabilities: AffiliateCapabilities;
  origin: EvidenceOrigin;
}
export interface Attribution { reference: string; transport: 'PROVIDER_SUB1' | 'UNAVAILABLE' }
export interface AffiliateClick {
  id: string;
  productId: string;
  offerId: string;
  provider: AffiliateProviderId;
  platform: AffiliatePlatform;
  merchantId: string;
  campaignId: string | null;
  currency: string;
  createdAt: string;
  attribution: Attribution;
  context: 'DEAL' | 'PRODUCT';
  destinationHash: string;
  origin: EvidenceOrigin;
}
export interface Conversion {
  eventId: string;
  externalId: string;
  attributionReference: string;
  occurredAt: string;
}
export interface Commission {
  eventId: string;
  externalId: string;
  conversionExternalId: string;
  revision: number;
  state: CommissionState;
  amountMinor: number | null;
  currency: string;
  occurredAt: string;
}
export type EvidenceDisposition = { status: 'APPLIED' | 'DUPLICATE' | 'UNMATCHED' | 'QUARANTINED'; code: string };
export type RevenueScope = 'PROVIDER' | 'PLATFORM' | 'MERCHANT' | 'CAMPAIGN' | 'PRODUCT';
export interface RevenueSnapshot {
  day: string;
  scope: RevenueScope;
  scopeId: string;
  currency: string;
  clicks: number;
  conversions: number;
  amountsMinor: Record<CommissionState, number>;
  unknownAmounts: number;
  asOfSequence: number;
}
export class MoneyError extends Error {
  constructor(readonly code: string, readonly classification: 'RETRYABLE' | 'FINAL' | 'QUARANTINE' = 'FINAL') { super(code); }
}
