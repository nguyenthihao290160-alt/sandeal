export const EXPERIMENT_TYPES = ['TITLE_VARIANT', 'CTA_VARIANT', 'DEAL_BADGE_VARIANT', 'CARD_LAYOUT_VARIANT', 'SORT_PRIORITY_VARIANT', 'CONTENT_ANGLE_VARIANT'] as const;
export type ExperimentType = typeof EXPERIMENT_TYPES[number];
export const EXPERIMENT_STATES = ['DRAFT', 'ELIGIBLE', 'SHADOW', 'READY_FOR_REVIEW', 'ACTIVE', 'PAUSED', 'COMPLETED', 'REJECTED'] as const;
export type ExperimentState = typeof EXPERIMENT_STATES[number];
export const EXPERIMENT_METRICS = ['CLICK', 'CONVERSION'] as const;
export type ExperimentMetric = typeof EXPERIMENT_METRICS[number];
export interface ExperimentMetricDefinition { metric: ExperimentMetric; source: 'AFFILIATE_MONEY_EVENTS'; unit: 'UNIQUE_SUBJECT_WITH_ATTRIBUTED_EVENT'; productionCollection: false }
export interface ExperimentGuardrail { metric: 'PUBLICATION_SAFETY_FAILURE' | 'PROVIDER_UNAVAILABLE'; maximumFailures: 0; basis: 'CURRENT_POLICY_EVIDENCE' }
export interface ExperimentVariant { id: string; weight: number }
export interface ExperimentSpec {
  productId: string; version: number; type: ExperimentType; variants: ExperimentVariant[]; primaryMetric: ExperimentMetric;
  startsAt: number; expiresAt: number; minimumRuntimeMs: number; minimumSubjectsPerVariant: number; minimumEventsPerVariant: number;
}
export interface Experiment extends ExperimentSpec {
  experimentId: string; definitionFingerprint: string; opportunityId: string; state: ExperimentState; executionMode: 'SHADOW';
  origin: 'TEST_FIXTURE' | 'AUTHENTICATED_PROVIDER_API'; guardrails: ExperimentGuardrail[];
}
export interface ExperimentAssignment {
  experimentId: string; subjectKey: string; variantId: string; version: number; assignedAt: number;
  origin: 'TEST_FIXTURE'; exposureKind: 'SHADOW_ASSIGNMENT_NOT_PRODUCTION_EXPOSURE';
}
export interface ExperimentResultSummary {
  experimentId: string; outcome: 'INCONCLUSIVE' | 'PROMISING' | 'UNDERPERFORMING' | 'SUFFICIENT_EVIDENCE';
  sampleSize: number; exposureCount: number; exposureKind: 'SHADOW_ASSIGNMENT_NOT_PRODUCTION_EXPOSURE';
  variants: { variantId: string; subjects: number; clicks: number; conversions: number; revenue: 'UNKNOWN' }[];
  minimumEvidenceMet: boolean; runtimeMet: boolean; completionMet: boolean; statisticalSignificance: 'NOT_IMPLEMENTED';
  productionRolloutAllowed: false; winner: null;
}
