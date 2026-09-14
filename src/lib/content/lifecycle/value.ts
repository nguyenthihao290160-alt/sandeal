import { dealFingerprint } from '../../deal-intelligence/evaluate';
import { EventJobError } from '../../platform/cloudflareContracts';
import type { EvidenceOrigin } from '../../affiliate/money/types';
import { LIFECYCLE_CONFIG, lifecycleId, valueWindow } from './config';
import type { ContentValueSnapshot } from './types';

export interface ContentValueBucket {
  day: number; currency: string; clicks: number; conversions: number; approvedMinor: number; paidMinor: number;
  approvedCount: number; paidCount: number; commissionEvents: number; sourceEvents: number; lastSequence: number;
}
export function buildContentValue(contentEntityId: string, origin: EvidenceOrigin, start: number, end: number, now: number, buckets: ContentValueBucket[]): ContentValueSnapshot {
  lifecycleId(contentEntityId); valueWindow(start, end, now);
  if (buckets.length > LIFECYCLE_CONFIG.valueDays * LIFECYCLE_CONFIG.currencies
    || new Set(buckets.map(bucket => `${bucket.day}:${bucket.currency}`)).size !== buckets.length)
    throw new EventJobError('CONTENT_VALUE_BUCKET_BOUND', 'QUARANTINE');
  for (const bucket of buckets) if (bucket.day < start || bucket.day >= end || bucket.day % LIFECYCLE_CONFIG.dayMs
    || !['VND', 'USD', 'EUR'].includes(bucket.currency)
    || Object.entries(bucket).some(([key, value]) => key !== 'currency' && (!Number.isSafeInteger(value) || Number(value) < 0)))
    throw new EventJobError('CONTENT_VALUE_BUCKET_INVALID', 'QUARANTINE');
  const sum = (key: Exclude<keyof ContentValueBucket, 'currency'>) => {
    const value = buckets.reduce((total, bucket) => total + bucket[key], 0);
    if (!Number.isSafeInteger(value)) throw new EventJobError('CONTENT_VALUE_OVERFLOW', 'QUARANTINE');
    return value;
  };
  const clicks = sum('clicks'), conversions = sum('conversions'), sourceEvents = sum('sourceEvents');
  const monetary = (kind: 'approved' | 'paid') => ['VND', 'USD', 'EUR'].flatMap(currency => {
    const matching = buckets.filter(bucket => bucket.currency === currency);
    const evidenceCount = matching.reduce((total, bucket) => total + bucket[kind === 'paid' ? 'paidCount' : 'approvedCount'], 0);
    const amountMinor = matching.reduce((total, bucket) => total + bucket[kind === 'paid' ? 'paidMinor' : 'approvedMinor'], 0);
    if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(evidenceCount)) throw new EventJobError('CONTENT_VALUE_OVERFLOW', 'QUARANTINE');
    return evidenceCount > 0 ? [{ currency, evidenceCount, amountMinor }] : [];
  });
  const approved = monetary('approved'), paid = monetary('paid'), revenue = paid.some(evidence => evidence.amountMinor > 0);
  const confidence = sourceEvents === 0 ? 0 : Math.min(LIFECYCLE_CONFIG.maximumValueConfidence,
    Math.min(1, clicks / LIFECYCLE_CONFIG.confidenceSample) * LIFECYCLE_CONFIG.clickConfidenceWeight
    + Math.min(1, conversions / LIFECYCLE_CONFIG.highValueConversions) * LIFECYCLE_CONFIG.conversionConfidenceWeight
    + (paid.length ? LIFECYCLE_CONFIG.revenueConfidenceWeight : 0));
  const businessValue = conversions >= LIFECYCLE_CONFIG.highValueConversions && revenue ? 'HIGH_VALUE'
    : conversions >= LIFECYCLE_CONFIG.mediumValueConversions ? 'MEDIUM_VALUE' : sourceEvents ? 'INSUFFICIENT_EVIDENCE' : 'UNKNOWN';
  return { contentEntityId, origin, windowStart: start, windowEnd: end, attributedClicks: clicks, attributedConversions: conversions,
    approvedCommissionEvidence: approved.length ? approved : null, revenueEvidence: paid.length ? paid : null,
    revenueState: revenue ? 'VERIFIED_REVENUE' : sum('commissionEvents') ? 'NO_REVENUE_OBSERVED' : 'NO_REVENUE_DATA',
    monetizationEvents: sum('commissionEvents'), dataCompleteness: sourceEvents ? 'PARTIAL' : 'NO_DATA', valueConfidence: Number(confidence.toFixed(LIFECYCLE_CONFIG.confidenceDecimals)),
    businessValue, sourceEventCount: sourceEvents, evidenceFingerprint: dealFingerprint({ contentEntityId, origin, start, endDay: Math.floor(end / LIFECYCLE_CONFIG.dayMs),
      buckets: [...buckets].sort((left, right) => left.day - right.day || left.currency.localeCompare(right.currency)), version: LIFECYCLE_CONFIG.attributionVersion }),
    algorithmVersion: LIFECYCLE_CONFIG.attributionVersion, generatedAt: now,
    attribution: sourceEvents ? 'DIRECTLY_ATTRIBUTED' : 'UNKNOWN', causalImpact: 'NOT_ESTABLISHED', seoExternalEvidence: 'NOT_AVAILABLE' };
}
