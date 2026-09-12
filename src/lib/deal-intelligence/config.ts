import { EventJobError } from '../platform/cloudflareContracts';

export const DEAL_CONFIG = {
  algorithmVersion: 'deal-intelligence-v1',
  evidenceVersion: 'deal-evidence-v1',
  currency: 'VND',
  dayMs: 86_400_000,
  windows: { shortDays: 7, mediumDays: 14, referenceDays: 30 },
  limits: { samples: 180, offers: 50, ranking: 50, work: 10, amount: 1e12 },
  freshness: { freshMs: 86_400_000, staleMs: 259_200_000, offerFreshMs: 21_600_000, offerStaleMs: 86_400_000, refreshMs: 3_600_000 },
  history: { strongSamples: 7, strongDays: 7, outlierRatio: 4, nearLowRatio: 1.03, verifiedListTolerance: 0.05, strongDiscount: 0.25 },
  weights: { price: 40, freshness: 15, offer: 15, monetization: 15, evidence: 15 },
  points: { priceBaseline: 40, priceDiscount: 50, nearLow: 10, aging: 50, safeRoute: 85, knownCommission: 15, revenueBonus: 3 },
  confidence: { history: 0.6, freshness: 0.15, offer: 0.15, identity: 0.1, high: 0.8, medium: 0.5, limitedCap: 0.65 },
  penalties: { STALE_PRICE: 15, LOW_EVIDENCE: 5, NO_SAFE_MONETIZATION_PATH: 15, PRICE_ABOVE_REFERENCE: 10, UNVERIFIED_LIST_DISCOUNT: 5 },
  priority: { top: 85, high: 70, normal: 50 },
} as const;

type ConfigShape<Configuration> = { [Key in keyof Configuration]: Configuration[Key] extends number ? number
  : Configuration[Key] extends string ? string : ConfigShape<Configuration[Key]> };
export type DealConfig = ConfigShape<typeof DEAL_CONFIG>;

export function validateDealConfig(config: DealConfig): void {
  const shapeMatches = (value: unknown, baseline: unknown): boolean => {
    if (!baseline || typeof baseline !== 'object') return typeof value === typeof baseline;
    return !!value && typeof value === 'object' && Object.keys(value).sort().join(',') === Object.keys(baseline).sort().join(',')
      && Object.entries(baseline).every(([key, field]) => shapeMatches((value as Record<string, unknown>)[key], field));
  };
  if (!shapeMatches(config, DEAL_CONFIG)) throw new EventJobError('INVALID_DEAL_CONFIG', 'QUARANTINE');
  const numbers = Object.values(config).flatMap(value => typeof value === 'object' ? Object.values(value) : typeof value === 'number' ? [value] : []);
  if (numbers.some(value => typeof value === 'number' && (!Number.isFinite(value) || value <= 0))
    || !/^deal-intelligence-v[1-9][0-9]*$/.test(config.algorithmVersion) || config.currency !== 'VND' || config.dayMs !== 86_400_000
    || Object.values(config.weights).reduce((sum, value) => sum + value, 0) !== 100
    || Math.abs(config.confidence.history + config.confidence.freshness + config.confidence.offer + config.confidence.identity - 1) > 1e-9
    || config.confidence.high > 1 || config.confidence.medium >= config.confidence.high || config.confidence.limitedCap >= config.confidence.high
    || config.windows.shortDays > config.windows.mediumDays || config.windows.mediumDays > config.windows.referenceDays || config.windows.referenceDays > 30
    || config.freshness.freshMs >= config.freshness.staleMs || config.freshness.offerFreshMs >= config.freshness.offerStaleMs
    || config.freshness.offerStaleMs > 86_400_000 || config.freshness.refreshMs < 60_000
    || config.limits.samples > 180 || config.limits.offers > 50 || config.limits.ranking > 50 || config.limits.work > 10
    || [...Object.values(config.windows), config.history.strongSamples, config.history.strongDays].some(value => !Number.isInteger(value))
    || Object.values(config.limits).some(value => !Number.isSafeInteger(value))
    || config.points.revenueBonus > 3 || config.priority.top > 100 || config.priority.high >= config.priority.top || config.priority.normal >= config.priority.high) {
    throw new EventJobError('INVALID_DEAL_CONFIG', 'QUARANTINE');
  }
}

export function boundedScore(value: number): number {
  if (!Number.isFinite(value)) throw new EventJobError('INVALID_DEAL_SCORE', 'QUARANTINE');
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

export function unitConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new EventJobError('INVALID_DEAL_CONFIDENCE', 'QUARANTINE');
  return Math.round(value * 10_000) / 10_000;
}
