import { dealFingerprint } from '../../deal-intelligence/evaluate';
import { emptyAiResult } from '../../decision-os/reasoner';
import { EventJobError, validTime } from '../../platform/cloudflareContracts';
import { LIFECYCLE_CONFIG, fingerprintToken, lifecycleId, validateLifecycleConfig, type LifecycleConfig } from './config';
import type { ContentLifecycleState } from '../types';
import type { ChangeSeverity, ContentRefreshReason, LifecycleEvidence, LifecycleInput, ContentLifecycleEvaluation,
  ContentLifecycleAction, ContentRefreshPriority, RefreshEligibility } from './types';

const severityOrder: ChangeSeverity[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const lifecycleStates: ContentLifecycleState[] = ['CURRENT', 'STALE', 'REFRESH_CANDIDATE', 'REFRESH_QUEUED', 'REFRESH_REVIEW_REQUIRED',
  'MERGE_CANDIDATE', 'SUPERSEDE_CANDIDATE', 'ARCHIVE_CANDIDATE', 'BLOCKED', 'UNKNOWN'];
export function validateLifecycleTransition(from: ContentLifecycleState, to: ContentLifecycleState, reevaluated: boolean, evidenceChanged: boolean) {
  if (![...lifecycleStates, 'PUBLISHED_EXISTING', 'DRAFT_CANDIDATE', 'SHADOW_PLANNED', 'READY_FOR_REVIEW', 'ARCHIVED'].includes(from)
    || !lifecycleStates.includes(to) || (!reevaluated && from !== to && !(from === 'REFRESH_CANDIDATE' && to === 'REFRESH_QUEUED'))
    || (['BLOCKED', 'ARCHIVE_CANDIDATE', 'SUPERSEDE_CANDIDATE'].includes(from) && from !== to && (!reevaluated || !evidenceChanged)))
    throw new EventJobError('INVALID_LIFECYCLE_TRANSITION', 'QUARANTINE');
}
export function validateLifecycleEvidence(evidence: LifecycleEvidence, config: LifecycleConfig = LIFECYCLE_CONFIG) {
  lifecycleId(evidence.canonicalProductId);
  for (const token of [evidence.contentFingerprint, evidence.dealFingerprint, evidence.decisionFingerprint, evidence.routeVersion,
    evidence.priceVersion, evidence.offerVersion, evidence.productFactsVersion]) fingerprintToken(token);
  if (evidence.opportunityFingerprint !== null) fingerprintToken(evidence.opportunityFingerprint);
  if (!['ALLOW', 'ALLOW_WITH_REVIEW', 'HOLD', 'BLOCK', 'QUARANTINE'].includes(evidence.policy)
    || !['AUTHENTICATED_PROVIDER_API', 'TEST_FIXTURE'].includes(evidence.origin)
    || !['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'COOLDOWN'].includes(evidence.providerHealth)
    || !['FRESH', 'STALE', 'UNKNOWN', 'INVALID'].includes(evidence.priceState)
    || !['FRESH', 'STALE', 'EXPIRED', 'MISSING'].includes(evidence.offerState)
    || !['accesstrade', 'tiktok', null].includes(evidence.provider)
    || !['shopee', 'tiktok_shop', 'lazada', 'website', 'other', 'unknown', null].includes(evidence.platform)
    || (evidence.provider === 'tiktok' && evidence.platform !== 'tiktok_shop')
    || (evidence.platform === 'shopee' && evidence.provider !== 'accesstrade')
    || (evidence.routeSafe && (!evidence.selectedOfferId || !evidence.provider || !evidence.platform || evidence.destinationUnsafe))
    || !['P0', 'P1', 'P2', 'P3', 'BLOCKED', null].includes(evidence.opportunityPriority)
    || !['NO_COVERAGE', 'PARTIAL_COVERAGE', 'ADEQUATE_COVERAGE', 'STALE_COVERAGE', 'DUPLICATE_COVERAGE', 'BLOCKED_COVERAGE'].includes(evidence.coverage)
    || !['SAFE', 'OVERLAP', 'HIGH_OVERLAP', 'CANONICAL_CONFLICT', 'MERGE_RECOMMENDED', 'REFRESH_RECOMMENDED', 'BLOCK_NEW_CONTENT'].includes(evidence.cannibalizationRisk)
    || !/^[a-z0-9-]{1,80}$/i.test(evidence.policyVersion)
    || [evidence.routeSafe, evidence.destinationUnsafe, evidence.obsolete].some(value => typeof value !== 'boolean')
    || !Number.isFinite(evidence.dealScore) || evidence.dealScore < 0 || evidence.dealScore > 100
    || [evidence.dealConfidence, evidence.contentConfidence].some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || (evidence.price !== null && (!Number.isFinite(evidence.price) || evidence.price <= 0))
    || (evidence.priceState === 'FRESH' && evidence.price === null)
    || !Array.isArray(evidence.facts) || evidence.facts.length > config.facts
    || new Set(evidence.facts.map(fact => fact.key)).size !== evidence.facts.length)
    throw new EventJobError('INVALID_LIFECYCLE_EVIDENCE', 'QUARANTINE');
  for (const fact of evidence.facts) {
    if (!/^[a-z0-9_.-]{1,100}$/i.test(fact.key) || !['PRICE', 'PRODUCT_FACTS', 'OFFER', 'AFFILIATE_ROUTE'].includes(fact.section)
      || typeof fact.valid !== 'boolean') throw new EventJobError('INVALID_CONTENT_FACT', 'QUARANTINE');
    fingerprintToken(fact.valueHash); fingerprintToken(fact.evidenceRef);
  }
}
export function materialChanges(previous: LifecycleEvidence | null, current: LifecycleEvidence, config: LifecycleConfig = LIFECYCLE_CONFIG) {
  validateLifecycleConfig(config); validateLifecycleEvidence(current, config);
  if (previous) validateLifecycleEvidence(previous, config);
  const changes: { reason: ContentRefreshReason; severity: ChangeSeverity }[] = [];
  const add = (condition: boolean, reason: ContentRefreshReason, severity: ChangeSeverity) => { if (condition) changes.push({ reason, severity }); };
  add(['BLOCK', 'QUARANTINE'].includes(current.policy), 'POLICY_BLOCKED', 'CRITICAL');
  add(current.destinationUnsafe, 'UNSAFE_DESTINATION', 'CRITICAL');
  add(current.priceState === 'INVALID', 'PRICE_INVALID', 'CRITICAL');
  add(current.cannibalizationRisk === 'CANONICAL_CONFLICT', 'CANONICAL_CONFLICT', 'CRITICAL');
  add(current.offerState === 'EXPIRED', 'OFFER_EXPIRED', 'HIGH');
  add(current.offerState === 'MISSING', 'OFFER_CHANGED', 'HIGH');
  add(current.priceState === 'STALE' || current.offerState === 'STALE', 'CONTENT_STALE', 'HIGH');
  add(current.providerHealth === 'UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'HIGH');
  add(['DEGRADED', 'COOLDOWN'].includes(current.providerHealth), 'PROVIDER_DEGRADED', 'MEDIUM');
  add(current.coverage === 'DUPLICATE_COVERAGE', 'CONTENT_DUPLICATION_FOUND', 'HIGH');
  add(current.obsolete, 'OBSOLETE_CONTENT', 'HIGH');
  if (previous) {
    add(previous.contentFingerprint !== current.contentFingerprint, 'CONTENT_METADATA_CHANGED', 'LOW');
    add(previous.price !== null && current.price === null, 'PRICE_DISAPPEARED', 'HIGH');
    add(current.price !== null && (previous.price === null || Math.abs(current.price - previous.price) / previous.price >= config.priceChangeRatio), 'PRICE_CHANGED', 'MEDIUM');
    add(previous.selectedOfferId !== current.selectedOfferId, 'BEST_OFFER_CHANGED', 'HIGH');
    add(previous.routeVersion !== current.routeVersion, 'MONEY_ROUTE_CHANGED', 'HIGH');
    add(previous.productFactsVersion !== current.productFactsVersion, 'PRODUCT_FACT_CHANGED', 'HIGH');
    add(Math.abs(previous.dealScore - current.dealScore) >= config.dealScoreChange, 'DEAL_SCORE_CHANGED', 'MEDIUM');
    add(Math.abs(previous.dealConfidence - current.dealConfidence) >= config.dealConfidenceChange, 'DEAL_CONFIDENCE_CHANGED', 'MEDIUM');
    add(previous.opportunityPriority !== current.opportunityPriority, 'OPPORTUNITY_PRIORITY_CHANGED', 'MEDIUM');
    add(previous.policy !== current.policy, 'POLICY_CHANGED', ['HOLD', 'ALLOW_WITH_REVIEW'].includes(current.policy) ? 'HIGH' : 'MEDIUM');
    add(previous.coverage !== current.coverage, 'CONTENT_COVERAGE_CHANGED', 'MEDIUM');
    add(dealFingerprint(previous.relationship) !== dealFingerprint(current.relationship), 'CANONICAL_RELATIONSHIP_CHANGED', 'HIGH');
    add(previous.facts.some(fact => fact.valid && !current.facts.some(next => next.key === fact.key && next.valid)), 'INVALIDATED_FACT', 'HIGH');
  }
  const severity = changes.reduce((highest, change) => severityOrder.indexOf(change.severity) > severityOrder.indexOf(highest) ? change.severity : highest, 'NONE' as ChangeSeverity);
  return { severity, reasons: [...new Set(changes.map(change => change.reason))].sort(), material: severityOrder.indexOf(severity) >= severityOrder.indexOf('MEDIUM') };
}
export function evaluateLifecycle(input: LifecycleInput, config: LifecycleConfig = LIFECYCLE_CONFIG): ContentLifecycleEvaluation {
  validateLifecycleConfig(config); validTime(input.now); lifecycleId(input.content?.id);
  const { content, current, baseline, value } = input;
  validateLifecycleEvidence(current, config);
  if (content.canonicalTarget?.entityId !== current.canonicalProductId || (baseline && (baseline.canonicalProductId !== current.canonicalProductId || baseline.origin !== current.origin))
    || (input.contentPlan?.contentId && input.contentPlan.contentId !== content.id)
    || (value && (value.contentEntityId !== content.id || value.origin !== current.origin || value.windowEnd > input.now)))
    throw new EventJobError('LIFECYCLE_IDENTITY_MISMATCH', 'QUARANTINE');
  if (value && (value.algorithmVersion !== config.attributionVersion || !Number.isFinite(value.valueConfidence) || value.valueConfidence < 0 || value.valueConfidence > 1
    || [value.attributedClicks, value.attributedConversions, value.sourceEventCount, value.monetizationEvents].some(count => !Number.isSafeInteger(count) || count < 0)
    || value.windowStart >= value.windowEnd || value.generatedAt > input.now
    || [...(value.revenueEvidence ?? []), ...(value.approvedCommissionEvidence ?? [])].some(evidence => !Number.isSafeInteger(evidence.amountMinor) || evidence.amountMinor < 0
      || !Number.isSafeInteger(evidence.evidenceCount) || evidence.evidenceCount < 1 || !['VND', 'USD', 'EUR'].includes(evidence.currency))))
    throw new EventJobError('INVALID_CONTENT_VALUE_EVIDENCE', 'QUARANTINE');
  const change = materialChanges(baseline, current, config), reasons = [...change.reasons], risks: ContentRefreshReason[] = [];
  const missing = !baseline || !input.contentPlan || !current.opportunityFingerprint || !current.opportunityPriority;
  let action: ContentLifecycleAction = 'NO_ACTION', state: ContentLifecycleState = 'CURRENT', eligibility: RefreshEligibility = 'NOT_REQUIRED', priority: ContentRefreshPriority = 'NONE';
  if (['BLOCK', 'QUARANTINE'].includes(current.policy) || current.destinationUnsafe || current.priceState === 'INVALID' || input.contentPlan?.action === 'BLOCK' || current.coverage === 'BLOCKED_COVERAGE') {
    action = 'BLOCK'; state = 'BLOCKED'; eligibility = 'BLOCKED'; priority = 'BLOCKED';
    risks.push(...reasons, 'POLICY_BLOCKED');
  } else if (missing || current.cannibalizationRisk === 'CANONICAL_CONFLICT' || ['HOLD', 'ALLOW_WITH_REVIEW'].includes(current.policy)
    || current.opportunityPriority === 'BLOCKED' || current.contentConfidence < config.minimumEvidenceConfidence
    || ['HIGH_OVERLAP', 'OVERLAP'].includes(current.cannibalizationRisk)) {
    action = 'HUMAN_REVIEW_REQUIRED'; state = 'REFRESH_REVIEW_REQUIRED'; eligibility = 'REVIEW_REQUIRED';
    priority = change.severity === 'CRITICAL' ? 'P0' : 'P1';
    if (missing) risks.push('MISSING_EVIDENCE');
    if (current.contentConfidence < config.minimumEvidenceConfidence) risks.push('INSUFFICIENT_CONFIDENCE');
  } else if (current.relationship && ((current.relationship.sourceId === content.id && ['MERGED_INTO', 'DUPLICATES_CONTENT'].includes(current.relationship.relationship))
    || (current.relationship.targetId === content.id && current.relationship.relationship === 'SUPERSEDES_CONTENT'))) {
    action = current.relationship.relationship === 'SUPERSEDES_CONTENT' ? 'SUPERSEDE_RECOMMENDED' : 'MERGE_RECOMMENDED';
    state = action === 'SUPERSEDE_RECOMMENDED' ? 'SUPERSEDE_CANDIDATE' : 'MERGE_CANDIDATE'; eligibility = 'REVIEW_REQUIRED'; priority = 'P1';
  } else if (current.obsolete) {
    action = 'ARCHIVE_REVIEW_RECOMMENDED'; state = 'ARCHIVE_CANDIDATE'; eligibility = 'REVIEW_REQUIRED'; priority = 'P1';
  } else if (change.material) {
    if (current.priceState !== 'FRESH') action = 'REQUEST_PRICE_REFRESH';
    else if (!current.routeSafe || current.offerState !== 'FRESH' || current.providerHealth !== 'AVAILABLE') action = 'REQUEST_OFFER_REFRESH';
    else if (current.coverage === 'DUPLICATE_COVERAGE') action = 'HUMAN_REVIEW_REQUIRED';
    else action = 'REFRESH_CONTENT';
    state = action === 'REFRESH_CONTENT' ? 'REFRESH_CANDIDATE' : 'STALE';
    const base = change.severity === 'CRITICAL' ? 0 : change.severity === 'HIGH' ? 1 : 2;
    const bonus = current.opportunityPriority === 'P0' || (value?.businessValue === 'HIGH_VALUE' && (value.revenueEvidence?.some(evidence => evidence.amountMinor > 0) ?? false)) ? config.valuePriorityBonus : 0;
    priority = `P${Math.max(change.severity === 'CRITICAL' ? 0 : 1, base - bonus)}` as ContentRefreshPriority;
    eligibility = action === 'REFRESH_CONTENT' ? (priority === 'P0' || priority === 'P1' ? 'ELIGIBLE_HIGH_PRIORITY' : 'ELIGIBLE') : 'REVIEW_REQUIRED';
  }
  if (!reasons.length) reasons.push('NO_MATERIAL_CHANGE');
  const safeFacts = current.facts.map(fact => ({ ...fact, valid: fact.valid && (fact.section === 'PRICE' ? current.priceState === 'FRESH'
    : fact.section === 'OFFER' ? current.offerState === 'FRESH' : fact.section === 'AFFILIATE_ROUTE' ? current.routeSafe : true) }));
  const oldFacts = baseline?.facts || [], changed = safeFacts.filter(fact => !oldFacts.some(old => old.key === fact.key && old.valueHash === fact.valueHash));
  const invalidated = oldFacts.filter(fact => !safeFacts.some(next => next.key === fact.key && next.valid && next.valueHash === fact.valueHash));
  const valid = safeFacts.filter(fact => fact.valid && oldFacts.some(old => old.key === fact.key && old.valueHash === fact.valueHash));
  const fingerprint = dealFingerprint({ contentId: content.id, canonical: content.canonicalTarget, baseline, current,
    plan: input.contentPlan?.evidenceFingerprint ?? null, value: value?.evidenceFingerprint ?? null, config });
  const id = `lifecycle-${fingerprint}`, sortedRisks = [...new Set(risks)].sort();
  const brief = { contentEntityId: content.id, currentLifecycleState: content.lifecycle, recommendedAction: action,
    materialChangeReasons: reasons, factsChanged: changed.map(fact => fact.key), factsInvalidated: invalidated.map(fact => fact.key),
    factsStillValid: valid.map(fact => fact.key), mustRefreshSections: [...new Set([...changed, ...invalidated].map(fact => fact.section))],
    mustPreserveFacts: valid.map(fact => fact.evidenceRef), mustAvoidClaims: ['UNVERIFIED_DISCOUNT', 'BEST_PRICE_WITHOUT_COMPARATIVE_EVIDENCE', 'UNVERIFIED_AVAILABILITY', 'UNVERIFIED_STRUCTURED_OFFER', 'AI_PROSE_AS_FACT', 'SEO_PERFORMANCE_WITHOUT_EVIDENCE'],
    newEvidenceRefs: safeFacts.filter(fact => fact.valid).map(fact => fact.evidenceRef), oldEvidenceRefs: oldFacts.map(fact => fact.evidenceRef),
    canonicalTarget: content.canonicalTarget, affiliateDisclosureRequired: true, priority, reasonCodes: reasons, riskCodes: sortedRisks };
  return { id, contentEntityId: content.id, canonicalProductId: current.canonicalProductId, origin: current.origin,
    algorithmVersion: config.algorithmVersion, evidenceFingerprint: fingerprint,
    materialFingerprint: dealFingerprint({ reasons, action, state, price: reasons.includes('PRICE_CHANGED') ? current.price : null,
      route: current.routeVersion, facts: current.productFactsVersion, policy: current.policy, relationship: current.relationship,
      priority, valueClass: value?.businessValue ?? 'UNKNOWN', opportunityPriority: current.opportunityPriority,
      dealScore: reasons.includes('DEAL_SCORE_CHANGED') ? current.dealScore : null,
      dealConfidence: reasons.includes('DEAL_CONFIDENCE_CHANGED') ? current.dealConfidence : null,
      priceState: current.priceState, offerState: current.offerState, providerHealth: current.providerHealth, coverage: current.coverage }),
    severity: change.severity, materialChange: change.material, state, priority, eligibility, reasonCodes: reasons, riskCodes: sortedRisks,
    decay: reasons.filter(reason => ['CONTENT_STALE', 'OFFER_EXPIRED', 'UNSAFE_DESTINATION', 'CANONICAL_CONFLICT', 'POLICY_BLOCKED', 'INVALIDATED_FACT', 'OBSOLETE_CONTENT'].includes(reason)),
    value, plan: { id: `lifecycle-plan-${fingerprint}`, contentEntityId: content.id, action, executionMode: 'SHADOW', productionAllowed: false,
      priority, eligibility, brief, relationship: action === 'MERGE_RECOMMENDED' || action === 'SUPERSEDE_RECOMMENDED' ? current.relationship : null,
      experimentProposal: action === 'REFRESH_CONTENT' && current.policy === 'ALLOW' ? { type: 'TITLE_VARIANT', state: 'DRAFT', executionMode: 'SHADOW', requiresHumanReview: true } : null },
    ai: emptyAiResult('DISABLED', 'AI_DISABLED', 'OPTIONAL_REVIEWER'), evaluatedAt: input.now };
}
