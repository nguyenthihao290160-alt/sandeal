import { readBoundedCollection, runTransaction } from '../storage/adapter';
import { listCandidateQueue, type CandidateQueueItem } from '../storage/candidateQueue';
import { getAutomationSettings } from '../storage/automationSettings';
import type { CommerceUrlProbeEvidence, Product } from '../types';
import { derivePersistedPriceTruth } from '../autonomous/priceTruthEngine';
import { listDomainCircuitStates, type DomainCircuitState, type DomainCircuitStatus } from '../bots/domainCircuitBreaker';
import {
  computeSourceDiversity,
  sourceIdentityStatus,
  type SourceDiversitySummary,
  type SourceIdentityStatus,
} from './sourceIdentity';

const STATE_COLLECTION = 'source-reliability-state';
const MAX_PRODUCTS = 10_000;

export interface SourceIngestionState {
  id: string;
  provider: string;
  ingestionSkipped: boolean;
  reasonCode: string;
  observed: number;
  selected: number;
  skipped: number;
  nextEligibleAt?: string;
  operationId?: string;
  updatedAt: string;
}

export interface SourceReliabilityRow {
  id: string;
  provider: string;
  campaign: string;
  affiliateGatewayDomain: string;
  merchantDomain: string;
  identityStatus: SourceIdentityStatus;
  selectable: boolean;
  affiliateCircuitState: SourceCircuitState;
  merchantCircuitState: SourceCircuitState;
  circuitState: SourceCircuitState;
  sourceConnectivityHealth: SourceHealthState;
  affiliateGatewayHealth: SourceHealthState;
  merchantHealth: SourceHealthState;
  priceFreshness: PriceFreshnessState;
  imageHealth: ProductEvidenceHealth;
  contentReadiness: ProductReadinessState;
  reviewReadiness: ProductReadinessState;
  publicationEligibility: PublicationEligibilityState;
  affiliateGatewayLastCheckedAt?: string;
  merchantLastCheckedAt?: string;
  lastSuccessfulProbe?: string;
  lastFailedProbe?: string;
  /** Legacy compatibility: transport-only current reason. */
  reasonCode?: string;
  transportReasonCode?: string;
  affiliateGatewayReasonCode?: string;
  merchantReasonCode?: string;
  candidateReasonCodes: string[];
  productReadinessReasonCodes: string[];
  rawDiagnosticReasonCodes: string[];
  nextProbeAt?: string;
  pending: number;
  delayed: number;
  discarded: number;
  quarantined: number;
  published: number;
  ingestionSkipped: boolean;
  ingestionSkipReason?: string;
}

export type SourceCircuitState = DomainCircuitStatus | 'UNKNOWN';
export type SourceHealthState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
export type PriceFreshnessState = 'FRESH' | 'AGING' | 'STALE' | 'UNVERIFIED' | 'MIXED' | 'UNKNOWN';
export type ProductEvidenceHealth = 'HEALTHY' | 'UNHEALTHY' | 'MIXED' | 'UNKNOWN';
export type ProductReadinessState = 'READY' | 'BLOCKED' | 'MIXED' | 'UNKNOWN';
export type PublicationEligibilityState = 'ELIGIBLE' | 'INELIGIBLE' | 'MIXED' | 'UNKNOWN';

export interface SourceReliabilityReport {
  generatedAt: string;
  rows: SourceReliabilityRow[];
  controls: {
    maximumPerMerchant: number;
    maximumPerCampaign: number;
    pausedDomains: string[];
    pausedCampaigns: string[];
  };
  ingestion: SourceIngestionState[];
  diversity?: SourceDiversitySummary;
  lastAutoPilotOutcome?: string;
  lastDiscoveryAt?: string;
  nextProbeAt?: string;
  recommendedNextAction?: string;
  sourceIdentityCompleteness?: 'COMPLETE' | 'INCOMPLETE';
}

function domainFromUrl(value: string | undefined): string {
  try { return new URL(value || '').hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return 'unknown'; }
}

function gatewayFromCandidate(candidate: CandidateQueueItem): string {
  return candidate.affiliateGatewayDomain
    || candidate.sourceEvidence?.affiliate.affiliateGatewayDomain
    || domainFromUrl(candidate.payload.affiliateUrl);
}

function merchantFromCandidate(candidate: CandidateQueueItem): string {
  return candidate.payload.merchantIdentity
    || candidate.merchantDomain
    || candidate.sourceEvidence?.merchant?.merchantDomain
    || candidate.payload.merchantDomain
    || domainFromUrl(candidate.payload.canonicalProductUrl || candidate.payload.originalUrl);
}

function latest(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function atLeastAsRecent(value: string | undefined, current: string | undefined): boolean {
  const nextTime = Date.parse(value || '');
  const currentTime = Date.parse(current || '');
  return Number.isFinite(nextTime) && (!Number.isFinite(currentTime) || nextTime >= currentTime);
}

function appendReason(reasons: string[], value: string | undefined): void {
  const normalized = String(value || '').trim().slice(0, 160);
  if (!normalized || reasons.includes(normalized) || reasons.length >= 50) return;
  reasons.push(normalized);
}

function probeHealth(evidence: CommerceUrlProbeEvidence): SourceHealthState {
  if (evidence.classification === 'HEALTHY') return 'HEALTHY';
  return evidence.retryable ? 'DEGRADED' : 'UNHEALTHY';
}

function updateProbeTimes(
  row: SourceReliabilityRow,
  evidence: CommerceUrlProbeEvidence | undefined,
  role: 'AFFILIATE_GATEWAY' | 'MERCHANT',
): void {
  if (!evidence) return;
  appendReason(row.rawDiagnosticReasonCodes, evidence.reasonCode);
  if (evidence.classification === 'HEALTHY') row.lastSuccessfulProbe = latest(row.lastSuccessfulProbe, evidence.checkedAt);
  else {
    row.lastFailedProbe = latest(row.lastFailedProbe, evidence.checkedAt);
  }
  row.nextProbeAt = latest(row.nextProbeAt, evidence.retryAfter);
  if (role === 'AFFILIATE_GATEWAY' && atLeastAsRecent(evidence.checkedAt, row.affiliateGatewayLastCheckedAt)) {
    row.affiliateGatewayLastCheckedAt = evidence.checkedAt;
    row.affiliateGatewayHealth = probeHealth(evidence);
    row.affiliateGatewayReasonCode = evidence.classification === 'HEALTHY' ? undefined : evidence.reasonCode;
  }
  if (role === 'MERCHANT' && atLeastAsRecent(evidence.checkedAt, row.merchantLastCheckedAt)) {
    row.merchantLastCheckedAt = evidence.checkedAt;
    row.merchantHealth = probeHealth(evidence);
    row.merchantReasonCode = evidence.classification === 'HEALTHY' ? undefined : evidence.reasonCode;
  }
}

function applyCircuitHealth(
  row: SourceReliabilityRow,
  circuit: DomainCircuitState | undefined,
  role: 'AFFILIATE_GATEWAY' | 'MERCHANT',
): void {
  if (!circuit) return;
  let health: SourceHealthState | undefined;
  let reasonCode: string | undefined;
  let observedAt: string | undefined;
  if (circuit.state === 'OPEN') {
    health = 'UNHEALTHY';
    reasonCode = circuit.lastFailureCode
      || (role === 'MERCHANT' ? 'MERCHANT_CIRCUIT_OPEN' : 'AFFILIATE_GATEWAY_CIRCUIT_OPEN');
    observedAt = latest(circuit.lastFailureAt, circuit.updatedAt);
  } else if (circuit.state === 'HALF_OPEN') {
    health = 'DEGRADED';
    reasonCode = circuit.lastFailureCode
      || (role === 'MERCHANT' ? 'MERCHANT_CIRCUIT_HALF_OPEN' : 'AFFILIATE_GATEWAY_CIRCUIT_HALF_OPEN');
    observedAt = latest(circuit.lastFailureAt, circuit.updatedAt);
  } else if (circuit.lastSuccessAt) {
    observedAt = latest(circuit.lastSuccessAt, circuit.lastFailureAt);
    const successIsNewest = !circuit.lastFailureAt
      || Date.parse(circuit.lastSuccessAt) >= Date.parse(circuit.lastFailureAt);
    health = successIsNewest ? 'HEALTHY' : 'DEGRADED';
    reasonCode = successIsNewest ? undefined : circuit.lastFailureCode;
  }
  if (!health || !observedAt) return;

  if (role === 'MERCHANT' && atLeastAsRecent(observedAt, row.merchantLastCheckedAt)) {
    row.merchantLastCheckedAt = observedAt;
    row.merchantHealth = health;
    row.merchantReasonCode = reasonCode;
  }
  if (role === 'AFFILIATE_GATEWAY' && atLeastAsRecent(observedAt, row.affiliateGatewayLastCheckedAt)) {
    row.affiliateGatewayLastCheckedAt = observedAt;
    row.affiliateGatewayHealth = health;
    row.affiliateGatewayReasonCode = reasonCode;
  }
}

function rowKey(provider: string, campaign: string, gateway: string, merchant: string): string {
  return `${provider}|${campaign}|${gateway}|${merchant}`.toLowerCase();
}

function createRow(provider: string, campaign: string, gateway: string, merchant: string): SourceReliabilityRow {
  const identityStatus = sourceIdentityStatus({ providerId: provider, campaignName: campaign, merchantDomain: merchant });
  return {
    id: rowKey(provider, campaign, gateway, merchant),
    provider, campaign, affiliateGatewayDomain: gateway, merchantDomain: merchant,
    identityStatus,
    selectable: identityStatus === 'COMPLETE',
    affiliateCircuitState: 'UNKNOWN', merchantCircuitState: 'UNKNOWN', circuitState: 'UNKNOWN',
    sourceConnectivityHealth: 'UNKNOWN', affiliateGatewayHealth: 'UNKNOWN', merchantHealth: 'UNKNOWN',
    priceFreshness: 'UNKNOWN', imageHealth: 'UNKNOWN', contentReadiness: 'UNKNOWN',
    reviewReadiness: 'UNKNOWN', publicationEligibility: 'UNKNOWN',
    candidateReasonCodes: [], productReadinessReasonCodes: [], rawDiagnosticReasonCodes: [],
    pending: 0, delayed: 0, discarded: 0, quarantined: 0, published: 0,
    ingestionSkipped: false,
  };
}

function mergeProductState<T extends string>(current: T, next: T, unknown: T, mixed: T): T {
  if (next === unknown) return current;
  if (current === unknown) return next;
  if (current === next || current === mixed) return current;
  return mixed;
}

function priceFreshness(product: Partial<Product>): PriceFreshnessState {
  const truth = derivePersistedPriceTruth(product);
  if (truth.state === 'STALE') return 'STALE';
  if (truth.isVerified && (truth.state === 'FRESH' || truth.state === 'AGING')) return truth.state;
  if (truth.state === 'CONFLICTED' || truth.state === 'ANOMALOUS' || truth.state === 'UNAVAILABLE') return 'UNVERIFIED';
  return Number(product.salePrice || product.price) > 0 ? 'UNVERIFIED' : 'UNKNOWN';
}

const HEALTHY_PRODUCT_STATUS = new Set(['ok', 'healthy', 'valid', 'available', 'pass', 'passed']);
const UNHEALTHY_PRODUCT_STATUS = new Set([
  'broken', 'broken_link', 'not_found', 'not_allowed', 'forbidden', 'timeout', 'image_broken',
  'server_error', 'error', 'failed', 'dead', 'unavailable', 'missing', 'invalid', 'blocked',
]);

function productEvidenceHealth(value: unknown): ProductEvidenceHealth {
  const normalized = String(value || '').trim().toLowerCase();
  if (HEALTHY_PRODUCT_STATUS.has(normalized)) return 'HEALTHY';
  if (UNHEALTHY_PRODUCT_STATUS.has(normalized)) return 'UNHEALTHY';
  return 'UNKNOWN';
}

function productReasonCodes(product: Partial<Product>): string[] {
  return [...new Set([
    ...(product.lastEligibilityDecision?.reasonCodes || []),
    ...(product.quarantineReasons || []),
    ...(product.publicBlockReasons || []),
  ].map(String).map(value => value.trim()).filter(Boolean))].slice(0, 50);
}

function updateProductReadiness(row: SourceReliabilityRow, product: Partial<Product>): void {
  const reasons = productReasonCodes(product);
  for (const reason of reasons) {
    appendReason(row.productReadinessReasonCodes, reason);
    appendReason(row.rawDiagnosticReasonCodes, reason);
  }

  row.priceFreshness = mergeProductState(row.priceFreshness, priceFreshness(product), 'UNKNOWN', 'MIXED');
  row.imageHealth = mergeProductState(row.imageHealth, productEvidenceHealth(product.imageHealthStatus), 'UNKNOWN', 'MIXED');

  const contentBlocked = reasons.some(reason => /content|original|description/i.test(reason));
  const hasContentEvidence = Boolean(String(product.description || '').trim() || product.generatedContent || product.reviewContent);
  const contentState: ProductReadinessState = contentBlocked ? 'BLOCKED' : hasContentEvidence ? 'READY' : 'UNKNOWN';
  row.contentReadiness = mergeProductState(row.contentReadiness, contentState, 'UNKNOWN', 'MIXED');

  const reviewBlocked = reasons.some(reason => /review|claim|original/i.test(reason));
  const reviewState: ProductReadinessState = reviewBlocked || product.reviewContent && product.reviewContent.reviewStatus !== 'approved'
    ? 'BLOCKED'
    : product.reviewContent?.reviewStatus === 'approved' ? 'READY' : 'UNKNOWN';
  row.reviewReadiness = mergeProductState(row.reviewReadiness, reviewState, 'UNKNOWN', 'MIXED');

  const explicitlyIneligible = product.lastEligibilityDecision?.eligible === false
    || product.publicBlocked === true
    || reasons.length > 0;
  const publicationState: PublicationEligibilityState = explicitlyIneligible
    ? 'INELIGIBLE'
    : product.lastEligibilityDecision?.eligible === true
      || product.status === 'published' && product.publicHidden === false ? 'ELIGIBLE' : 'UNKNOWN';
  row.publicationEligibility = mergeProductState(row.publicationEligibility, publicationState, 'UNKNOWN', 'MIXED');
}

export function sourceReliabilityEvent(
  event: string,
  details: {
    provider?: string;
    campaign?: string;
    domain?: string;
    role?: string;
    reasonCode?: string;
    operationId?: string;
    correlationId?: string;
    jobId?: string;
    elapsedMs?: number;
    nextProbeAt?: string;
  },
): void {
  console.info(JSON.stringify({
    event: event.slice(0, 120),
    provider: details.provider?.slice(0, 80),
    campaign: details.campaign?.slice(0, 160),
    domain: details.domain?.toLowerCase().slice(0, 253),
    role: details.role,
    reasonCode: details.reasonCode?.slice(0, 160),
    operationId: details.operationId?.slice(0, 160),
    correlationId: details.correlationId?.slice(0, 160),
    jobId: details.jobId?.slice(0, 160),
    elapsedMs: Number.isFinite(details.elapsedMs) ? Math.max(0, Math.round(details.elapsedMs!)) : undefined,
    nextProbeAt: details.nextProbeAt,
    observedAt: new Date().toISOString(),
  }));
}

export async function recordSourceIngestionState(input: Omit<SourceIngestionState, 'id' | 'updatedAt'>): Promise<SourceIngestionState> {
  const now = new Date().toISOString();
  const state: SourceIngestionState = {
    ...input,
    id: `provider:${input.provider.toLowerCase()}`,
    updatedAt: now,
  };
  await runTransaction<SourceIngestionState>(STATE_COLLECTION, items => {
    const index = items.findIndex(item => item.id === state.id);
    if (index >= 0) items[index] = state; else items.push(state);
    return items;
  });
  if (input.ingestionSkipped && input.reasonCode === 'NO_HEALTHY_PRODUCT_SOURCE') {
    sourceReliabilityEvent('no_healthy_product_source', {
      provider: input.provider,
      reasonCode: input.reasonCode,
      operationId: input.operationId,
      nextProbeAt: input.nextEligibleAt,
    });
  }
  return state;
}

export async function listSourceIngestionStates(): Promise<SourceIngestionState[]> {
  return readBoundedCollection<SourceIngestionState>(STATE_COLLECTION, { maximumItems: 100, maximumBytes: 512 * 1024 });
}

export async function getSourceReliabilityReport(): Promise<SourceReliabilityReport> {
  const [candidates, products, circuits, ingestion, settings] = await Promise.all([
    listCandidateQueue(),
    readBoundedCollection<Partial<Product>>('products', { maximumItems: MAX_PRODUCTS, maximumBytes: 32 * 1024 * 1024 }),
    listDomainCircuitStates(),
    listSourceIngestionStates(),
    getAutomationSettings(),
  ]);
  const rows = new Map<string, SourceReliabilityRow>();
  const getRow = (provider: string, campaign: string, gateway: string, merchant: string) => {
    const key = rowKey(provider, campaign, gateway, merchant);
    const existing = rows.get(key);
    if (existing) return existing;
    const created = createRow(provider, campaign, gateway, merchant);
    rows.set(key, created);
    return created;
  };

  for (const candidate of candidates) {
    const provider = String(candidate.source || 'unknown');
    const campaign = String(candidate.payload.campaignName || candidate.payload.affiliateUrlCampaignId || 'uncategorized');
    const row = getRow(provider, campaign, gatewayFromCandidate(candidate), merchantFromCandidate(candidate));
    if (candidate.status === 'pending' || candidate.status === 'processing' || candidate.status === 'needs_review') row.pending++;
    if (candidate.status === 'delayed') row.delayed++;
    if (candidate.status === 'discarded' || candidate.status === 'failed') row.discarded++;
    appendReason(row.candidateReasonCodes, candidate.terminalReason || candidate.delayReason);
    appendReason(row.rawDiagnosticReasonCodes, candidate.terminalReason || candidate.delayReason);
    row.nextProbeAt = latest(row.nextProbeAt, candidate.nextAttemptAt);
    updateProbeTimes(row, candidate.sourceEvidence?.affiliate, 'AFFILIATE_GATEWAY');
    updateProbeTimes(row, candidate.sourceEvidence?.merchant, 'MERCHANT');
  }

  for (const product of products) {
    const provider = String(product.source || 'unknown');
    const campaign = String(product.campaignName || product.affiliateUrlCampaignId || 'uncategorized');
    const gateway = product.affiliateGatewayDomain || product.sourceEvidence?.affiliate.affiliateGatewayDomain || domainFromUrl(product.affiliateUrl);
    const merchant = product.merchantIdentity || product.merchantDomain || product.sourceEvidence?.merchant?.merchantDomain || domainFromUrl(product.canonicalProductUrl || product.originalUrl);
    const row = getRow(provider, campaign, gateway, merchant);
    if (product.lifecycleState === 'QUARANTINED' || product.status === 'archived' || product.publicBlocked) row.quarantined++;
    if (product.status === 'published' && product.publicHidden === false && !product.publicBlocked) row.published++;
    updateProductReadiness(row, product);
    updateProbeTimes(row, product.sourceEvidence?.affiliate, 'AFFILIATE_GATEWAY');
    updateProbeTimes(row, product.sourceEvidence?.merchant, 'MERCHANT');
  }

  // A fully rejected discovery pool has no candidate/product row of its own.
  // Materialize the provider state so NO_HEALTHY_PRODUCT_SOURCE remains
  // visible instead of collapsing into an empty dashboard.
  for (const state of ingestion) {
    const providerRows = [...rows.values()].filter(row => row.provider === state.provider);
    if (providerRows.length === 0) {
      const row = getRow(state.provider, 'uncategorized', 'unknown', 'unknown');
      row.ingestionSkipped = state.ingestionSkipped;
      row.ingestionSkipReason = state.ingestionSkipped ? state.reasonCode : undefined;
      appendReason(row.rawDiagnosticReasonCodes, state.reasonCode);
      row.nextProbeAt = latest(row.nextProbeAt, state.nextEligibleAt);
    }
  }

  for (const row of rows.values()) {
    const affiliateCircuit = circuits.find(item => item.role === 'AFFILIATE_GATEWAY' && item.domain === row.affiliateGatewayDomain);
    const merchantCircuit = circuits.find(item => item.role === 'MERCHANT' && item.domain === row.merchantDomain);
    row.affiliateCircuitState = affiliateCircuit?.state || 'UNKNOWN';
    row.merchantCircuitState = merchantCircuit?.state || 'UNKNOWN';
    row.circuitState = row.merchantCircuitState === 'OPEN' || row.affiliateCircuitState === 'OPEN' ? 'OPEN'
      : row.merchantCircuitState === 'HALF_OPEN' || row.affiliateCircuitState === 'HALF_OPEN' ? 'HALF_OPEN'
        : row.merchantCircuitState === 'CLOSED' || row.affiliateCircuitState === 'CLOSED' ? 'CLOSED' : 'UNKNOWN';
    row.lastSuccessfulProbe = latest(row.lastSuccessfulProbe, latest(affiliateCircuit?.lastSuccessAt, merchantCircuit?.lastSuccessAt));
    row.lastFailedProbe = latest(row.lastFailedProbe, latest(affiliateCircuit?.lastFailureAt, merchantCircuit?.lastFailureAt));
    row.nextProbeAt = latest(row.nextProbeAt, latest(affiliateCircuit?.nextProbeAt, merchantCircuit?.nextProbeAt));

    applyCircuitHealth(row, merchantCircuit, 'MERCHANT');
    applyCircuitHealth(row, affiliateCircuit, 'AFFILIATE_GATEWAY');
    appendReason(row.rawDiagnosticReasonCodes, merchantCircuit?.lastFailureCode);
    appendReason(row.rawDiagnosticReasonCodes, affiliateCircuit?.lastFailureCode);

    const transportStates = [row.merchantHealth];
    if (row.affiliateGatewayDomain !== 'unknown') transportStates.push(row.affiliateGatewayHealth);
    row.sourceConnectivityHealth = transportStates.includes('UNHEALTHY') ? 'UNHEALTHY'
      : transportStates.includes('DEGRADED') ? 'DEGRADED'
        : transportStates.every(state => state === 'HEALTHY') ? 'HEALTHY' : 'UNKNOWN';
    row.transportReasonCode = row.merchantReasonCode || row.affiliateGatewayReasonCode;
    row.reasonCode = row.transportReasonCode;
    row.selectable = row.identityStatus === 'COMPLETE'
      && !settings.pausedSourceDomains.includes(row.merchantDomain)
      && !settings.pausedSourceCampaigns.includes(row.campaign)
      && row.circuitState !== 'OPEN'
      && row.circuitState !== 'HALF_OPEN';
  }

  const rowList = [...rows.values()];
  const completeRows = rowList.filter(row => row.identityStatus === 'COMPLETE');
  const discovered = completeRows.map(r => ({ campaignName: r.campaign, merchantDomain: r.merchantDomain }));
  const eligible = completeRows.filter(r => r.selectable)
    .map(r => ({ campaignName: r.campaign, merchantDomain: r.merchantDomain }));
  // Transport diversity is evidence truth, not an operator-policy projection.
  // A paused source remains transport-healthy while being intentionally
  // excluded from the separately reported eligible diversity.
  const healthy = completeRows.filter(r => r.sourceConnectivityHealth === 'HEALTHY')
    .map(r => ({ campaignName: r.campaign, merchantDomain: r.merchantDomain }));
  const providersChecked = new Set(completeRows.map(r => r.provider)).size;
  const diversity = computeSourceDiversity(discovered, eligible, healthy, providersChecked);

  const lastIngestion = ingestion.sort((a, b) => Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0'))[0];
  const lastAutoPilotOutcome = lastIngestion?.reasonCode;
  const lastDiscoveryAt = lastIngestion?.updatedAt;
  const nextProbeAt = rowList.map(r => r.nextProbeAt).filter((v): v is string => Boolean(v)).sort()[0] || lastIngestion?.nextEligibleAt;
  const recommendedNextAction = completeRows.length === 0 && rowList.length > 0
    ? 'COMPLETE_SOURCE_IDENTITY'
    : diversity.status === 'INSUFFICIENT_SOURCE_DIVERSITY' || diversity.status === 'SINGLE_SOURCE'
    ? 'CONFIGURE_ADDITIONAL_PRODUCT_SOURCE'
    : rowList.some(r => r.circuitState === 'OPEN') ? 'WAIT_FOR_CIRCUIT_RECOVERY' : 'NONE';
  const sourceIdentityCompleteness = rowList.some(r => r.identityStatus === 'IDENTITY_INCOMPLETE') ? 'INCOMPLETE' : 'COMPLETE';

  return {
    generatedAt: new Date().toISOString(),
    rows: rowList.sort((left, right) =>
      Number(right.ingestionSkipped) - Number(left.ingestionSkipped)
      || Number(right.identityStatus === 'IDENTITY_INCOMPLETE') - Number(left.identityStatus === 'IDENTITY_INCOMPLETE')
      || Number(right.sourceConnectivityHealth !== 'HEALTHY') - Number(left.sourceConnectivityHealth !== 'HEALTHY')
      || right.delayed + right.discarded + right.quarantined - (left.delayed + left.discarded + left.quarantined)
      || left.id.localeCompare(right.id)).slice(0, 500),
    controls: {
      maximumPerMerchant: settings.sourceMaxPerMerchant,
      maximumPerCampaign: settings.sourceMaxPerCampaign,
      pausedDomains: settings.pausedSourceDomains,
      pausedCampaigns: settings.pausedSourceCampaigns,
    },
    ingestion,
    diversity,
    lastAutoPilotOutcome,
    lastDiscoveryAt,
    nextProbeAt,
    recommendedNextAction,
    sourceIdentityCompleteness,
  };
}
