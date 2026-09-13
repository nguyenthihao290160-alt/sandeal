import { dealFingerprint } from '../deal-intelligence/evaluate';
import { EventJobError, validTime } from '../platform/cloudflareContracts';
import { EXPERIMENT_TYPES, EXPERIMENT_METRICS, type Experiment, type ExperimentSpec, type ExperimentState, type ExperimentMetricDefinition, type ExperimentResultSummary } from './types';

export const EXPERIMENT_LIMITS = { variants: 8, assignments: 10000, metricEvents: 20000, read: 50, cleanup: 10,
  maximumRuntimeMs: 30 * 86_400_000, retentionMs: 30 * 86_400_000, weightTotal: 10000 } as const;
export const EXPERIMENT_METRIC_DEFINITIONS: readonly ExperimentMetricDefinition[] = EXPERIMENT_METRICS.map(metric => ({ metric,
  source: 'AFFILIATE_MONEY_EVENTS', unit: 'UNIQUE_SUBJECT_WITH_ATTRIBUTED_EVENT', productionCollection: false }));
export function validateExperiment(spec: ExperimentSpec): void {
  if (!spec || Object.keys(spec).sort().join(',') !== 'expiresAt,minimumEventsPerVariant,minimumRuntimeMs,minimumSubjectsPerVariant,primaryMetric,productId,startsAt,type,variants,version'
    || !/^[a-z0-9-]{1,160}$/i.test(spec.productId) || !EXPERIMENT_TYPES.includes(spec.type) || !EXPERIMENT_METRICS.includes(spec.primaryMetric)
    || !Number.isSafeInteger(spec.version) || spec.version < 1 || spec.version > 1000000
    || !Array.isArray(spec.variants) || spec.variants.length < 2 || spec.variants.length > EXPERIMENT_LIMITS.variants
    || spec.variants.some(variant => !variant || Object.keys(variant).sort().join(',') !== 'id,weight' || !/^[a-z0-9_-]{1,32}$/i.test(variant.id)
      || !Number.isInteger(variant.weight) || variant.weight <= 0 || variant.weight > EXPERIMENT_LIMITS.weightTotal)
    || new Set(spec.variants.map(variant => variant.id)).size !== spec.variants.length
    || spec.variants.reduce((total, variant) => total + variant.weight, 0) !== EXPERIMENT_LIMITS.weightTotal
    || !Number.isSafeInteger(spec.minimumSubjectsPerVariant) || spec.minimumSubjectsPerVariant < 20 || spec.minimumSubjectsPerVariant > 1000
    || !Number.isSafeInteger(spec.minimumEventsPerVariant) || spec.minimumEventsPerVariant < 5 || spec.minimumEventsPerVariant > spec.minimumSubjectsPerVariant
    || !Number.isSafeInteger(spec.minimumRuntimeMs) || spec.minimumRuntimeMs < 60000 || spec.minimumRuntimeMs > EXPERIMENT_LIMITS.maximumRuntimeMs)
    throw new EventJobError('EXPERIMENT_DEFINITION_REJECTED', 'QUARANTINE');
  validTime(spec.startsAt); validTime(spec.expiresAt);
  if (spec.expiresAt - spec.startsAt < spec.minimumRuntimeMs || spec.expiresAt - spec.startsAt > EXPERIMENT_LIMITS.maximumRuntimeMs)
    throw new EventJobError('EXPERIMENT_TIME_REJECTED', 'QUARANTINE');
}
export function experimentIdentity(spec: ExperimentSpec) {
  validateExperiment(spec);
  const normalized = { ...spec, variants: [...spec.variants].sort((left, right) => left.id.localeCompare(right.id)) };
  const fingerprint = dealFingerprint({ schema: 'shadow-experiment-v1', spec: normalized });
  return { normalized, fingerprint, experimentId: `experiment-${fingerprint}` };
}
export function subjectKey(subjectId: string): string {
  if (typeof subjectId !== 'string' || !/^[a-z0-9_-]{1,160}$/i.test(subjectId)) throw new EventJobError('EXPERIMENT_SUBJECT_REJECTED', 'QUARANTINE');
  return dealFingerprint(['shadow-subject-v1', subjectId]);
}
export function assignVariant(experiment: Experiment, subjectId: string): string {
  const { variants } = experimentIdentity({ productId: experiment.productId, version: experiment.version, type: experiment.type, variants: experiment.variants,
    primaryMetric: experiment.primaryMetric, startsAt: experiment.startsAt, expiresAt: experiment.expiresAt, minimumRuntimeMs: experiment.minimumRuntimeMs,
    minimumSubjectsPerVariant: experiment.minimumSubjectsPerVariant, minimumEventsPerVariant: experiment.minimumEventsPerVariant }).normalized;
  const bucket = Number.parseInt(dealFingerprint([experiment.experimentId, experiment.version, subjectKey(subjectId)]).slice(0, 12), 16) % EXPERIMENT_LIMITS.weightTotal;
  let cumulative = 0;
  for (const variant of variants) { cumulative += variant.weight; if (bucket < cumulative) return variant.id; }
  throw new EventJobError('EXPERIMENT_ASSIGNMENT_REJECTED', 'QUARANTINE');
}
export function validateTransition(current: ExperimentState, next: ExperimentState): void {
  const transitions: Record<ExperimentState, ExperimentState[]> = { DRAFT: ['ELIGIBLE', 'REJECTED'], ELIGIBLE: ['SHADOW', 'REJECTED'],
    SHADOW: ['PAUSED', 'READY_FOR_REVIEW', 'REJECTED'], READY_FOR_REVIEW: ['PAUSED', 'COMPLETED', 'REJECTED'],
    PAUSED: ['SHADOW', 'REJECTED'], COMPLETED: [], REJECTED: [], ACTIVE: [] };
  if (!transitions[current]?.includes(next) || next === 'ACTIVE') throw new EventJobError('EXPERIMENT_TRANSITION_REJECTED', 'QUARANTINE');
}
export function summarizeExperiment(experiment: Experiment, variants: ExperimentResultSummary['variants'], now: number): ExperimentResultSummary {
  validTime(now);
  if (now < experiment.startsAt || variants.length !== experiment.variants.length
    || new Set(variants.map(variant => variant.variantId)).size !== variants.length
    || variants.some(variant => !experiment.variants.some(expected => expected.id === variant.variantId)
      || [variant.subjects, variant.clicks, variant.conversions].some(value => !Number.isSafeInteger(value) || value < 0 || value > EXPERIMENT_LIMITS.assignments)
      || variant.clicks > variant.subjects || variant.conversions > variant.subjects)) throw new EventJobError('EXPERIMENT_SUMMARY_REJECTED', 'QUARANTINE');
  const sampleSize = variants.reduce((total, variant) => total + variant.subjects, 0);
  const minimumEvidenceMet = variants.every(variant => variant.subjects >= experiment.minimumSubjectsPerVariant
    && (experiment.primaryMetric === 'CLICK' ? variant.clicks : variant.conversions) >= experiment.minimumEventsPerVariant);
  const runtimeMet = now - experiment.startsAt >= experiment.minimumRuntimeMs;
  const completionMet = experiment.state === 'COMPLETED' || now >= experiment.expiresAt;
  return { experimentId: experiment.experimentId, outcome: minimumEvidenceMet && runtimeMet && completionMet ? 'SUFFICIENT_EVIDENCE' : 'INCONCLUSIVE',
    sampleSize, exposureCount: sampleSize, exposureKind: 'SHADOW_ASSIGNMENT_NOT_PRODUCTION_EXPOSURE', variants, minimumEvidenceMet, runtimeMet, completionMet,
    statisticalSignificance: 'NOT_IMPLEMENTED', productionRolloutAllowed: false, winner: null };
}
