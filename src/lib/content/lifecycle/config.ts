import { EventJobError, validTime } from '../../platform/cloudflareContracts';

export const LIFECYCLE_CONFIG = Object.freeze({
  algorithmVersion: 'content-lifecycle-v1', attributionVersion: 'content-attribution-v1',
  priceChangeRatio: 0.03, dealScoreChange: 10, dealConfidenceChange: 0.15,
  minimumEvidenceConfidence: 0.6, highValueConversions: 5, mediumValueConversions: 2,
  confidenceSample: 20, maximumValueConfidence: 0.9, valuePriorityBonus: 1,
  clickConfidenceWeight: 0.4, conversionConfidenceWeight: 0.3, revenueConfidenceWeight: 0.2, confidenceDecimals: 4,
  batch: 5, read: 20, contentsPerProduct: 16, facts: 32, auditPerContent: 256,
  attributionPerContent: 20000, valueDays: 31, currencies: 3,
  coalesceMs: 30000, cooldownMs: 3600000, dayMs: 86400000,
  maxAiReviewCandidates: 1, maxMergeReviews: 2, aiEnabled: false,
});
export type LifecycleConfig = { [Key in keyof typeof LIFECYCLE_CONFIG]: typeof LIFECYCLE_CONFIG[Key] extends number ? number
  : typeof LIFECYCLE_CONFIG[Key] extends boolean ? boolean : string };
export function validateLifecycleConfig(config: LifecycleConfig) {
  if (!/^content-lifecycle-v[1-9][0-9]*$/.test(config.algorithmVersion) || config.attributionVersion !== LIFECYCLE_CONFIG.attributionVersion
    || config.aiEnabled !== false || Object.keys(config).sort().join() !== Object.keys(LIFECYCLE_CONFIG).sort().join())
    throw new EventJobError('LIFECYCLE_CONFIG_REJECTED', 'QUARANTINE');
  for (const [key, value] of Object.entries(config)) {
    const expected = LIFECYCLE_CONFIG[key as keyof LifecycleConfig];
    if (typeof value !== typeof expected || (typeof value === 'number' && (!Number.isFinite(value) || value <= 0 || value > Number(expected))))
      throw new EventJobError('LIFECYCLE_CONFIG_BOUND', 'QUARANTINE');
  }
  for (const key of ['batch', 'read', 'contentsPerProduct', 'facts', 'auditPerContent', 'attributionPerContent', 'valueDays', 'currencies',
    'maxAiReviewCandidates', 'maxMergeReviews', 'confidenceDecimals'] as const) if (!Number.isInteger(config[key])) throw new EventJobError('LIFECYCLE_CONFIG_BOUND', 'QUARANTINE');
}
export function lifecycleId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,160}$/i.test(value)) throw new EventJobError('INVALID_CONTENT_ID', 'QUARANTINE');
  return value;
}
export function fingerprintToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new EventJobError('INVALID_LIFECYCLE_FINGERPRINT', 'QUARANTINE');
  return value;
}
export function valueWindow(start: number, end: number, now: number, config: LifecycleConfig = LIFECYCLE_CONFIG) {
  validTime(start); validTime(end); validTime(now);
  if (start >= end || end > now || end - start > config.valueDays * config.dayMs || start % config.dayMs)
    throw new EventJobError('CONTENT_VALUE_WINDOW_INVALID', 'QUARANTINE');
}
