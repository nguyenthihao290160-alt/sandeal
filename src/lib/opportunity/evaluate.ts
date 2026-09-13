import { dealFingerprint } from '../deal-intelligence/evaluate';
import { evaluateDecisionPolicy } from '../decision-os/policy';
import { MONEY_LIMITS, COMMISSION_STATES } from '../affiliate/money/types';
import { PRODUCT_INTELLIGENCE_CONFIG } from '../product-intelligence/config';
import { validTime, EventJobError } from '../platform/cloudflareContracts';
import { OPPORTUNITY_CONFIG, validateOpportunityConfig, opportunityNumber, boundedOpportunity, type OpportunityConfig } from './config';
import type { OpportunityInput, OpportunityEvaluation, OpportunityReason, OpportunityRisk, OpportunitySignal, ResourceAction, ResourceClass } from './types';

export function evaluateOpportunity(input: OpportunityInput, config: OpportunityConfig = OPPORTUNITY_CONFIG): OpportunityEvaluation {
  validateOpportunityConfig(config);
  if (!input?.source || !input.deal || !input.decision || !input.context) throw new EventJobError('OPPORTUNITY_REQUIRED_EVIDENCE_MISSING', 'QUARANTINE');
  const { source, deal, decision, context } = input, { product, now } = source;
  validTime(now);
  const origin = source.testOnly === true ? 'TEST_FIXTURE' : 'AUTHENTICATED_PROVIDER_API';
  if (!product || product.id !== deal.productId || product.id !== decision.productId || product.id !== context.productId
    || decision.dealEvaluationId !== deal.evidenceFingerprint || context.dealEvaluationId !== deal.evidenceFingerprint
    || decision.decisionId !== context.decisionId || decision.evidenceFingerprint !== context.evidenceFingerprint
    || !/^[a-f0-9]{64}$/.test(deal.evidenceFingerprint) || [deal.origin, decision.origin, context.origin].some(value => value !== origin)
    || decision.plan.executionMode !== 'SHADOW' || decision.policyVersion !== context.decisionPolicyVersion
    || dealFingerprint(decision.policy) !== dealFingerprint(evaluateDecisionPolicy(context))
    || decision.dealScore !== deal.dealScore || decision.dealConfidence !== deal.confidence
    || context.dealScore !== deal.dealScore || context.dealConfidence !== deal.confidence
    || decision.validUntil !== context.validUntil || source.revenue.length > MONEY_LIMITS.snapshotDays)
    throw new EventJobError('OPPORTUNITY_EVIDENCE_MISMATCH', 'QUARANTINE');
  for (const timestamp of [deal.evaluatedAt, decision.createdAt, product.createdAt]) {
    const time = Date.parse(timestamp);
    if (!Number.isSafeInteger(time) || time < 0 || time > now) throw new EventJobError('OPPORTUNITY_FUTURE_OR_INVALID_TIME', 'QUARANTINE');
  }
  for (const value of [deal.dealScore, deal.freshnessScore, deal.monetizationScore, deal.offerQualityScore]) opportunityNumber(value, 100);
  opportunityNumber(deal.confidence, 1);
  for (const value of [decision.validUntil, Date.parse(deal.validUntil)]) validTime(value);
  const seenDays = new Set<string>();
  for (const row of source.revenue) {
    if (row.scope !== 'PRODUCT' || row.scopeId !== product.id || row.currency !== product.currency || row.currency !== 'VND'
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !Number.isFinite(Date.parse(row.day)) || new Date(row.day).toISOString().slice(0, 10) !== row.day
      || row.day > new Date(now).toISOString().slice(0, 10) || row.day < new Date(Math.max(0, now - 30 * 86_400_000)).toISOString().slice(0, 10)
      || seenDays.has(row.day) || !row.amountsMinor || Object.keys(row.amountsMinor).sort().join(',') !== [...COMMISSION_STATES].sort().join(','))
      throw new EventJobError('INVALID_OPPORTUNITY_REVENUE', 'QUARANTINE');
    seenDays.add(row.day);
    for (const value of [row.clicks, row.conversions, row.unknownAmounts, row.asOfSequence, ...Object.values(row.amountsMinor)]) {
      opportunityNumber(value, MONEY_LIMITS.amountMinor);
      if (!Number.isSafeInteger(value)) throw new EventJobError('INVALID_OPPORTUNITY_REVENUE', 'QUARANTINE');
    }
    if (row.asOfSequence < 1) throw new EventJobError('INVALID_OPPORTUNITY_REVENUE', 'QUARANTINE');
  }
  const reasons: OpportunityReason[] = ['SEO_EXTERNAL_EVIDENCE_NOT_AVAILABLE', 'TRAFFIC_EVIDENCE_UNKNOWN'];
  const risks: OpportunityRisk[] = [];
  const allowed = ['ALLOW', 'ALLOW_WITH_REVIEW'].includes(decision.policy.outcome);
  const expired = decision.validUntil <= now || Date.parse(deal.validUntil) <= now;
  const safe = context.money.status === 'SAFE' && context.money.selectedOfferId === deal.selectedOfferId;
  const selected = product.offers?.find(offer => offer.monetization?.id === context.money.selectedOfferId)?.monetization;
  if (safe && (!selected || selected.origin !== origin)) throw new EventJobError('OPPORTUNITY_MONEY_EVIDENCE_MISSING', 'QUARANTINE');
  if (deal.dealScore >= config.minimumDealScore) reasons.push('HIGH_DEAL_QUALITY');
  if (deal.confidence >= config.highConfidence) reasons.push('HIGH_DEAL_CONFIDENCE'); else risks.push('LOW_DEAL_CONFIDENCE');
  if (safe) reasons.push('SAFE_MONETIZATION_PATH'); else risks.push('NO_SAFE_MONEY_ROUTE');
  if (!context.publication.ready) risks.push('PUBLICATION_BLOCKED');
  if (['BLOCK', 'QUARANTINE'].includes(decision.policy.outcome)) risks.push('POLICY_BLOCKED');
  if (decision.policy.outcome === 'HOLD') risks.push('POLICY_HELD');
  if (expired) risks.push('EVIDENCE_EXPIRED');
  if (deal.priceFreshness !== 'FRESH' || deal.productFreshness !== 'FRESH') risks.push('STALE_PRICE');
  if (deal.offerFreshness !== 'FRESH') risks.push('STALE_OFFER');
  const hardBlocked = risks.some(code => ['POLICY_BLOCKED', 'PUBLICATION_BLOCKED', 'NO_SAFE_MONEY_ROUTE', 'EVIDENCE_EXPIRED'].includes(code))
    || deal.publishRecommendation === 'REJECT' || context.constraints.securityRisk || context.constraints.quarantined || !context.constraints.runtimeValid;
  const conversions = source.revenue.reduce((total, row) => total + row.conversions, 0);
  const approved = source.revenue.reduce((total, row) => total + row.amountsMinor.APPROVED + row.amountsMinor.PAID, 0);
  const knownRevenue = source.revenue.length > 0;
  const monetizationEvidence: OpportunityEvaluation['monetizationEvidence'] = safe ? ['MONETIZATION_PATH_ONLY'] : [];
  const terms = selected && (selected.commissionRate != null || selected.commissionAmountEstimate != null);
  if (selected?.commissionRate != null) opportunityNumber(selected.commissionRate, 100);
  if (selected?.commissionAmountEstimate != null) opportunityNumber(selected.commissionAmountEstimate, MONEY_LIMITS.amountMinor);
  if (safe && terms) { monetizationEvidence.push('KNOWN_COMMISSION_TERMS'); reasons.push('KNOWN_COMMISSION_TERMS_NOT_PAID_REVENUE'); }
  if (safe && conversions > 0) { monetizationEvidence.push('VERIFIED_CONVERSION_EVIDENCE'); reasons.push('VERIFIED_CONVERSION_EVIDENCE'); }
  if (safe && approved > 0) {
    monetizationEvidence.push('VERIFIED_COMMISSION_EVIDENCE', 'VERIFIED_REVENUE_EVIDENCE');
    reasons.push('VERIFIED_COMMISSION_EVIDENCE', 'VERIFIED_REVENUE_EVIDENCE');
  }
  if (monetizationEvidence.length > 1) monetizationEvidence.splice(monetizationEvidence.indexOf('MONETIZATION_PATH_ONLY'), 1);
  const monetizationScore = safe ? boundedOpportunity(config.points.path + (terms ? config.points.commissionTerms : 0)
    + (approved > 0 ? config.points.commissionEvidence : 0)) : 0;
  const sampleStrength = boundedOpportunity(Math.log1p(Math.min(conversions, config.revenueSampleCap)) / Math.log1p(config.revenueSampleCap), 1);
  const revenueEvidenceScore = knownRevenue ? boundedOpportunity((approved > 0 ? 50 : 0) + sampleStrength * 50) : null;
  const newOpportunity = !knownRevenue || conversions === 0;
  if (!knownRevenue) reasons.push('NO_REVENUE_HISTORY');
  if (newOpportunity) reasons.push('NEW_OPPORTUNITY_LIMITED_HISTORY');
  const observation = source.providers.find(row => row.origin === origin && row.health.provider === context.money.provider);
  const healthTime = Date.parse(observation?.health.checkedAt || '');
  if (observation && (!Number.isSafeInteger(healthTime) || healthTime > now)) throw new EventJobError('OPPORTUNITY_PROVIDER_TIME_INVALID', 'QUARANTINE');
  const providerTrustScore = !observation ? null : context.providerHealth === 'AVAILABLE' ? 100
    : context.providerHealth === 'DEGRADED' ? config.points.degradedTrust : 0;
  if (context.providerHealth === 'AVAILABLE') reasons.push('PROVIDER_HEALTHY');
  else risks.push(context.providerHealth === 'DEGRADED' ? 'PROVIDER_DEGRADED' : 'PROVIDER_UNAVAILABLE');
  if (safe && context.money.provider === 'accesstrade' && context.money.platform === 'shopee') reasons.push('ACCESS_TRADE_SHOPEE_VALID');
  const expiry = selected?.validUntil ? Date.parse(selected.validUntil) : null;
  if (expiry !== null && !Number.isSafeInteger(expiry)) throw new EventJobError('OPPORTUNITY_OFFER_TIME_INVALID', 'QUARANTINE');
  const remaining = expiry === null ? null : Math.max(0, expiry - now);
  const offerStabilityScore = remaining === null ? null : remaining <= config.shortOfferMs ? config.points.shortOffer : remaining <= config.stableOfferMs ? 65 : 100;
  if (remaining !== null) reasons.push('OFFER_VALIDITY_KNOWN');
  if (remaining !== null && remaining <= config.shortOfferMs) risks.push('OFFER_EXPIRES_SOON');
  if (product.duplicateConfidence !== undefined) opportunityNumber(product.duplicateConfidence, 1);
  const duplicate = ['POSSIBLE', 'UNRESOLVED', 'MERGED'].includes(product.duplicateStatus || '') || !!product.duplicateGroupId
    || (product.duplicateConfidence ?? 0) >= PRODUCT_INTELLIGENCE_CONFIG.thresholds.duplicateMedium;
  const contentState = product.contentPackageStatus;
  const canonicalCovered = context.publication.ready && !!product.slug && product.reviewContent?.reviewStatus === 'approved';
  const complete = !!product.title && !!(product.categoryId || product.category) && product.sourceVerified === true && deal.historicalSampleCount > 0;
  const contentOpportunityScore = duplicate ? 0 : canonicalCovered || contentState === 'approved' || contentState === 'generated' ? config.points.contentCovered
    : contentState === 'none' ? (complete ? config.points.contentGap : config.points.contentIncomplete) : null;
  if (duplicate) risks.push('DUPLICATE_CONTENT_RISK');
  reasons.push(contentOpportunityScore === null ? 'CONTENT_COVERAGE_UNKNOWN' : contentState === 'none' && !duplicate && !canonicalCovered ? 'CONTENT_GAP_DETECTED' : 'CONTENT_ALREADY_COVERED');
  const review = decision.policy.reviewRequired;
  const jobs = Number(risks.includes('STALE_PRICE')) + Number(risks.includes('STALE_OFFER')) + Number(expired) + Number(review);
  const recommendedResourceClass: ResourceClass = review ? 'REVIEW_HEAVY' : jobs >= 2 ? 'EXPENSIVE' : jobs === 1 ? 'STANDARD' : 'CHEAP';
  if (review) risks.push('HIGH_REVIEW_COST');
  const resourceEfficiencyScore = review ? config.points.reviewEfficiency : boundedOpportunity(100 - jobs * config.points.efficiencyPerJob);
  const explorationBonus = newOpportunity && safe && allowed && !hardBlocked && deal.dealScore >= config.minimumDealScore ? config.explorationMax : 0;
  if (explorationBonus) reasons.push('EXPLORATION_BONUS_APPLIED');
  const opportunityConfidence = boundedOpportunity(deal.confidence * config.confidence.deal + Number(safe) * config.confidence.monetization
    + sampleStrength * config.confidence.revenue + Number(providerTrustScore !== null && now - healthTime <= MONEY_LIMITS.providerAgeMs) * config.confidence.provider
    + Number(offerStabilityScore !== null) * config.confidence.offer + Number(contentOpportunityScore !== null) * config.confidence.content, 1);
  if (opportunityConfidence < config.highConfidence) risks.push('INSUFFICIENT_EVIDENCE');
  const values = { deal: deal.dealScore, dealConfidence: deal.confidence * 100, monetization: monetizationScore,
    revenue: revenueEvidenceScore, provider: providerTrustScore, offer: offerStabilityScore, freshness: deal.freshnessScore,
    content: contentOpportunityScore, efficiency: resourceEfficiencyScore };
  const signals: OpportunitySignal[] = Object.entries(values).map(([code, score]) => ({ code, state: score === null ? 'UNKNOWN' : 'KNOWN', score,
    coverage: score === null ? 0 : 1, contribution: boundedOpportunity((score ?? 0) * config.weights[code as keyof typeof values] / 100) }));
  const penalties = Object.entries(config.penalties).filter(([code]) => risks.includes(code as OpportunityRisk)).map(([code, points]) => ({ code: code as OpportunityRisk, points }));
  const riskPenalty = penalties.reduce((total, penalty) => total + penalty.points, 0);
  const opportunityScore = boundedOpportunity(signals.reduce((total, signal) => total + signal.contribution, 0) + explorationBonus - riskPenalty);
  const opportunityPriority = hardBlocked ? 'BLOCKED' : !allowed ? 'P3' : opportunityScore >= config.topScore
    && opportunityConfidence >= config.highConfidence && deal.dealScore >= config.minimumDealScore ? 'P0'
    : opportunityScore >= config.highScore && opportunityConfidence >= config.highConfidence && deal.dealScore >= config.minimumDealScore ? 'P1'
      : opportunityScore >= config.normalScore ? 'P2' : 'P3';
  const eligible = !hardBlocked && allowed && safe && context.publication.ready && context.providerHealth === 'AVAILABLE'
    && opportunityConfidence >= config.experimentConfidence && ['P0', 'P1'].includes(opportunityPriority)
    && !duplicate && !risks.some(code => ['STALE_PRICE', 'STALE_OFFER', 'OFFER_EXPIRES_SOON'].includes(code));
  const actions: ResourceAction[] = hardBlocked ? ['NO_RESOURCE'] : risks.includes('STALE_PRICE') ? ['REFRESH_PRICE'] : risks.includes('STALE_OFFER') ? ['REFRESH_OFFER']
    : !allowed ? ['REQUEST_REEVALUATION'] : review ? ['HUMAN_REVIEW'] : ['P0', 'P1'].includes(opportunityPriority) ? ['HIGH_PRIORITY_CANDIDATE'] : ['NO_RESOURCE'];
  if (!hardBlocked && allowed && ['P0', 'P1', 'P2'].includes(opportunityPriority) && reasons.includes('CONTENT_GAP_DETECTED')
    && decision.policy.allowedActions.includes('MARK_CONTENT_CANDIDATE')) actions.push('CONTENT_REVIEW_CANDIDATE');
  if (eligible) actions.push('EXPERIMENT_CANDIDATE');
  reasons.push('AI_DISABLED', 'AI_REVIEW_NOT_REQUIRED');
  const future = [decision.validUntil, Date.parse(deal.validUntil), (Math.floor(now / config.validityMs) + 1) * config.validityMs,
    ...(expiry === null ? [] : [expiry, expiry - config.shortOfferMs, expiry - config.stableOfferMs])].filter(time => time > now);
  const validUntil = expired ? now : Math.min(...future);
  const semanticEvidence = { deal: deal.evidenceFingerprint, decision: decision.evidenceFingerprint, policy: decision.policy,
    money: context.money, revenue: source.revenue.map(row => ({ ...row })).sort((left, right) => left.day.localeCompare(right.day)),
    providerHealth: observation ? { provider: observation.health.provider, state: observation.health.state, checkedAt: observation.health.checkedAt } : null,
    content: { contentState: contentState ?? 'UNKNOWN', canonicalCovered, complete, duplicate, reviewHash: product.reviewContent?.reviewContentHash ?? null },
    values, opportunityConfidence, opportunityPriority, risks: [...new Set(risks)].sort(), explorationBonus, validUntil, config, origin };
  const evidenceFingerprint = dealFingerprint(semanticEvidence), opportunityId = `opportunity-${evidenceFingerprint}`;
  if (eligible) reasons.push('SHADOW_PROPOSAL_ONLY');
  return { opportunityId, productId: product.id, dealEvaluationId: deal.evidenceFingerprint, decisionId: decision.decisionId, origin,
    evaluatedAt: deal.evaluatedAt, validUntil, dealScore: deal.dealScore, dealConfidence: deal.confidence, monetizationScore, monetizationEvidence,
    revenueEvidenceScore, providerTrustScore, providerTrust: providerTrustScore === null ? 'TRUST_UNKNOWN' : providerTrustScore >= 80 ? 'TRUST_HIGH' : providerTrustScore >= 50 ? 'TRUST_MEDIUM' : 'TRUST_LOW',
    providerTrustBasis: 'CURRENT_PROVIDER_HEALTH_ONLY', merchantTrust: { state: 'UNKNOWN', basis: 'INSUFFICIENT_MERCHANT_HISTORY' }, offerStabilityScore,
    freshnessScore: deal.freshnessScore, contentOpportunityScore, contentOpportunity: contentOpportunityScore === null ? 'UNKNOWN' : contentOpportunityScore >= 80 ? 'HIGH' : contentOpportunityScore >= 50 ? 'MEDIUM' : 'LOW',
    competitionEvidenceScore: null, seoExternalEvidence: 'NOT_AVAILABLE', resourceEfficiencyScore, explorationBonus, riskPenalty, penalties, signals,
    opportunityScore, opportunityConfidence, opportunityPriority, recommendedResourceClass,
    resourceRecommendation: { executionMode: 'SHADOW', actions, resourceClass: recommendedResourceClass, cost: 'UNKNOWN', estimatedInternalJobs: jobs },
    experimentEligibility: { state: eligible ? 'ELIGIBLE_SHADOW' : 'NOT_ELIGIBLE', reasonCodes: eligible ? ['SHADOW_PROPOSAL_ONLY', 'TRAFFIC_EVIDENCE_UNKNOWN'] : [...new Set([...risks, 'MINIMUM_OPPORTUNITY_EVIDENCE_REQUIRED'])].sort(), productionAllowed: false, trafficEvidence: 'UNKNOWN' },
    experimentProposal: eligible ? { proposalId: `proposal-${evidenceFingerprint}`, type: 'TITLE_VARIANT', state: 'DRAFT', executionMode: 'SHADOW', requiresHumanReview: true, opportunityId } : null,
    reasonCodes: [...new Set(reasons)].sort(), riskCodes: [...new Set(risks)].sort(), provider: context.money.provider, platform: context.money.platform,
    newOpportunity, evidenceFingerprint, algorithmVersion: config.algorithmVersion, executionMode: 'SHADOW' };
}
