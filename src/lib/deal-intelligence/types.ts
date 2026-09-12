import type { Product } from '../types';
import type { PriceSnapshot } from '../product-intelligence/types';
import type { ProviderObservation, RevenueSnapshot, EvidenceOrigin, AffiliatePlatform } from '../affiliate/money/types';

export type DealScore = number;
export type DealConfidence = number;
export type DealPriority = 'TOP' | 'HIGH' | 'NORMAL' | 'LOW' | 'REJECT';
export type PublishRecommendation = 'PUBLISH' | 'REFRESH_FIRST' | 'HOLD' | 'REJECT';
export type DealFreshness = 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';
export type DealReason = string;
export interface DealSignal { code: DealReason; score?: number; value?: number | string; }
export interface DealPriceEvidence {
  currentPrice?: number;
  currency?: string;
  observedAt?: string;
  priceFreshness: DealFreshness;
  historicalLow?: number;
  historicalMaximum?: number;
  historicalMedian?: number;
  historicalSampleCount: number;
  historicalCoverageDays: number;
  shortLow?: number;
  mediumLow?: number;
  referencePrice?: number;
  referencePriceSource?: 'OBSERVED_30D_MEDIAN';
  distanceFromLowPercent?: number;
  distanceFromMedianPercent?: number;
  lastObservedChangeAt?: string;
  nominalDiscountPercent?: number;
  discountPercent?: number;
  discountConfidence: DealConfidence;
  historyConfidence: DealConfidence;
  priceQualityScore: DealScore;
  invalidSamples: number;
  reasons: DealReason[];
  risks: DealReason[];
}
export interface DealEvaluation extends Omit<DealPriceEvidence, 'reasons' | 'risks'> {
  productId: string;
  evaluatedAt: string;
  priceObservationAgeMs?: number;
  timeSinceLastObservedChangeMs?: number;
  validUntil: string;
  origin: EvidenceOrigin;
  productFreshness: DealFreshness;
  offerFreshness: DealFreshness;
  destinationFreshness: DealFreshness;
  freshnessScore: DealScore;
  offerQualityScore: DealScore;
  monetizationScore: DealScore;
  evidenceQualityScore: DealScore;
  revenueEvidenceScore?: DealScore;
  revenueEvidence?: { conversions: number; approvedMinor: number; paidMinor: number; currency: string; asOfSequence: number };
  monetizationState: 'NO_MONETIZATION_PATH' | 'MONETIZATION_PATH_AVAILABLE' | 'MONETIZATION_EVIDENCE_AVAILABLE' | 'VERIFIED_REVENUE_EVIDENCE';
  riskPenalty: number;
  penalties: { code: DealReason; points: number }[];
  dealScore: DealScore;
  confidence: DealConfidence;
  confidenceBand: 'HIGH' | 'MEDIUM' | 'LOW';
  priority: DealPriority;
  publishRecommendation: PublishRecommendation;
  selectedOfferId?: string;
  provider?: string;
  platform?: AffiliatePlatform;
  merchantId?: string;
  campaignId?: string;
  reasonCodes: DealReason[];
  riskCodes: DealReason[];
  signals: DealSignal[];
  evidenceFingerprint: string;
  evidenceVersion: string;
  algorithmVersion: string;
}
export interface DealInput {
  product: Product;
  history: PriceSnapshot[];
  providers: ProviderObservation[];
  revenue: RevenueSnapshot[];
  allowedHosts: readonly string[];
  now: number;
  testOnly?: boolean;
  evidenceRevision?: number;
}
