import { selectMoneyRoute } from '../../affiliate/money/router';
import { dealFingerprint } from '../../deal-intelligence/evaluate';
import type { PreparedDeal } from '../../storage/d1/d1DealStore';
import type { DecisionAuditRecord, DecisionContext } from '../../decision-os/types';
import type { OpportunityEvaluation } from '../../opportunity/types';
import type { ContentEntity, ContentPlan, ContentRelationship } from '../types';
import { EventJobError } from '../../platform/cloudflareContracts';
import type { LifecycleEvidence, ContentFactEvidence } from './types';

export function projectLifecycleEvidence(prepared: PreparedDeal, decision: DecisionAuditRecord, context: DecisionContext,
  opportunity: OpportunityEvaluation | null, content: ContentEntity, plan: ContentPlan, relationship: ContentRelationship | null = null): LifecycleEvidence {
  const { product, now, providers, allowedHosts } = prepared.input, deal = prepared.evaluation;
  if (content.canonicalTarget?.entityId !== product.id || decision.productId !== product.id || decision.dealEvaluationId !== deal.evidenceFingerprint
    || (opportunity && (opportunity.productId !== product.id || opportunity.dealEvaluationId !== deal.evidenceFingerprint || opportunity.decisionId !== decision.decisionId)))
    throw new EventJobError('LIFECYCLE_UPSTREAM_CHAIN_INVALID', 'QUARANTINE');
  const route = selectMoneyRoute(product, providers, allowedHosts, now), selected = route.selected;
  const productFacts = { id: product.id, title: product.title, specifications: product.specifications, category: product.category, sourceVerified: product.sourceVerified };
  const productFactsVersion = dealFingerprint(productFacts);
  const routeVersion = dealFingerprint({ selectedOfferId: selected?.id, provider: selected?.provider, platform: selected?.platform,
    destination: selected?.destination.url ? dealFingerprint(selected.destination.url) : null, safe: !!selected });
  const rawPrice = deal.currentPrice ?? product.salePrice ?? product.price ?? null;
  const invalidPrice = rawPrice !== null && (!Number.isFinite(rawPrice) || rawPrice <= 0);
  const price = invalidPrice ? null : rawPrice;
  const priceState = invalidPrice ? 'INVALID' : price === null ? 'UNKNOWN' : ['STALE', 'UNKNOWN'].includes(deal.priceFreshness) ? 'STALE' : 'FRESH';
  const expired = route.candidates.some(candidate => candidate.reasons.includes('REJECTED_EXPIRED'));
  const unsafe = !selected && route.candidates.some(candidate => candidate.reasons.includes('REJECTED_UNSAFE_DESTINATION'));
  const offerState = selected ? (deal.offerFreshness === 'STALE' ? 'STALE' : 'FRESH') : expired ? 'EXPIRED' : 'MISSING';
  const priceVersion = dealFingerprint({ price, state: priceState, observation: deal.observedAt, version: deal.evidenceVersion });
  const offerVersion = dealFingerprint({ id: selected?.id, state: offerState, validUntil: selected?.validUntil, verified: selected?.lastVerifiedAt });
  const facts: ContentFactEvidence[] = [
    { key: 'product-facts', valueHash: productFactsVersion, evidenceRef: productFactsVersion, valid: product.sourceVerified === true, section: 'PRODUCT_FACTS' },
    { key: 'price', valueHash: dealFingerprint(price), evidenceRef: priceVersion, valid: priceState === 'FRESH', section: 'PRICE' },
    { key: 'selected-offer', valueHash: dealFingerprint(selected?.id ?? null), evidenceRef: offerVersion, valid: offerState === 'FRESH', section: 'OFFER' },
    { key: 'affiliate-route', valueHash: routeVersion, evidenceRef: routeVersion, valid: !!selected, section: 'AFFILIATE_ROUTE' },
  ];
  return { canonicalProductId: product.id, origin: deal.origin, contentFingerprint: plan.evidenceFingerprint,
    dealFingerprint: deal.evidenceFingerprint, decisionFingerprint: decision.evidenceFingerprint,
    opportunityFingerprint: opportunity?.evidenceFingerprint ?? null, policyVersion: decision.policyVersion, policy: decision.policy.outcome,
    opportunityPriority: opportunity?.opportunityPriority ?? null, routeVersion, selectedOfferId: selected?.id ?? null,
    provider: selected?.provider ?? null, platform: selected?.platform ?? null, routeSafe: !!selected, destinationUnsafe: unsafe,
    providerHealth: context.providerHealth, priceVersion, price, priceState, offerVersion, offerState, productFactsVersion,
    dealScore: deal.dealScore, dealConfidence: deal.confidence, contentConfidence: product.sourceVerified === true ? deal.confidence : 0,
    coverage: plan.coverage, cannibalizationRisk: plan.cannibalizationRisk, relationship, obsolete: false, facts };
}
