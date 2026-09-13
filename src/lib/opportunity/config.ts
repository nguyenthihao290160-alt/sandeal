import { EventJobError } from '../platform/cloudflareContracts';

export const OPPORTUNITY_CONFIG = {
  algorithmVersion: 'opportunity-engine-v1', evidenceVersion: 'opportunity-evidence-v1', contentVersion: 'product-content-coverage-v1',
  weights: { deal: 38, dealConfidence: 7, monetization: 14, revenue: 8, provider: 8, offer: 6, freshness: 7, content: 7, efficiency: 5 },
  confidence: { deal: 0.35, monetization: 0.15, revenue: 0.15, provider: 0.1, offer: 0.1, content: 0.15 },
  points: { path: 60, commissionTerms: 20, commissionEvidence: 20, degradedTrust: 35, shortOffer: 25,
    contentGap: 100, contentCovered: 30, contentIncomplete: 55, efficiencyPerJob: 20, reviewEfficiency: 20 },
  penalties: { LOW_DEAL_CONFIDENCE: 4, STALE_PRICE: 5, STALE_OFFER: 5, PROVIDER_DEGRADED: 5,
    DUPLICATE_CONTENT_RISK: 5, HIGH_REVIEW_COST: 3, OFFER_EXPIRES_SOON: 3 },
  topScore: 88, highScore: 74, normalScore: 50, highConfidence: 0.8, minimumDealScore: 70,
  experimentConfidence: 0.8, explorationMax: 4, revenueSampleCap: 20, shortOfferMs: 3_600_000,
  stableOfferMs: 21_600_000, validityMs: 3_600_000, readLimit: 50, workLimit: 10,
} as const;
type Shape<Value> = { -readonly [Key in keyof Value]: Value[Key] extends number ? number : Value[Key] extends string ? string : Shape<Value[Key]> };
export type OpportunityConfig = Shape<typeof OPPORTUNITY_CONFIG>;
export function validateOpportunityConfig(config: OpportunityConfig): void {
  const shape = (value: unknown, template: unknown): boolean => !!value && typeof value === 'object'
    && Object.keys(value).sort().join(',') === Object.keys(template as object).sort().join(',')
    && Object.entries(template as object).every(([key, sample]) => typeof sample === 'object'
      ? shape((value as Record<string, unknown>)[key], sample) : typeof (value as Record<string, unknown>)[key] === typeof sample);
  const numbers = (value: object): number[] => Object.values(value).flatMap(field => typeof field === 'object' ? numbers(field) : typeof field === 'number' ? [field] : []);
  if (!shape(config, OPPORTUNITY_CONFIG) || numbers(config).some(value => !Number.isFinite(value) || value < 0 || value > 86_400_000)
    || !/^opportunity-engine-v[1-9][0-9]*$/.test(config.algorithmVersion)
    || config.evidenceVersion !== OPPORTUNITY_CONFIG.evidenceVersion || config.contentVersion !== OPPORTUNITY_CONFIG.contentVersion
    || Object.values(config.weights).reduce((total, value) => total + value, 0) !== 100
    || Math.abs(Object.values(config.confidence).reduce((total, value) => total + value, 0) - 1) > 1e-9
    || config.weights.revenue > 8 || config.weights.deal < 35 || config.explorationMax > 4
    || config.topScore > 100 || config.topScore <= config.highScore || config.highScore <= config.normalScore || config.normalScore <= 0
    || config.minimumDealScore < 70 || config.minimumDealScore > 100 || config.highConfidence < 0.75 || config.highConfidence > 1
    || config.experimentConfidence < 0.8 || config.experimentConfidence > 1 || config.revenueSampleCap < 10 || config.revenueSampleCap > 100
    || config.shortOfferMs < 60_000 || config.stableOfferMs <= config.shortOfferMs || config.validityMs < 60_000 || config.validityMs > 3_600_000
    || [config.readLimit, config.workLimit, config.revenueSampleCap].some(value => !Number.isSafeInteger(value))
    || config.readLimit < 1 || config.readLimit > 50 || config.workLimit < 1 || config.workLimit > 10
    || Object.values(config.points).some(value => value > 100) || Object.values(config.penalties).some(value => value > 10))
    throw new EventJobError('INVALID_OPPORTUNITY_CONFIG', 'QUARANTINE');
}
export function opportunityNumber(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum)
    throw new EventJobError('INVALID_OPPORTUNITY_EVIDENCE', 'QUARANTINE');
  return value;
}
export function boundedOpportunity(value: number, maximum = 100): number {
  if (!Number.isFinite(value)) throw new EventJobError('INVALID_OPPORTUNITY_SCORE', 'QUARANTINE');
  return Math.round(Math.max(0, Math.min(maximum, value)) * 10000) / 10000;
}
