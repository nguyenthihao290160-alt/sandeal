import { readBoundedCollection, runTransaction } from '../storage/adapter';
import { listCandidateQueue, type CandidateQueueItem } from '../storage/candidateQueue';
import { getAutomationSettings } from '../storage/automationSettings';
import type { CommerceUrlProbeEvidence, Product } from '../types';
import { listDomainCircuitStates, type DomainCircuitStatus } from '../bots/domainCircuitBreaker';
import { computeSourceDiversity, type SourceDiversitySummary } from './sourceIdentity';

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
  affiliateCircuitState: DomainCircuitStatus;
  merchantCircuitState: DomainCircuitStatus;
  circuitState: DomainCircuitStatus;
  lastSuccessfulProbe?: string;
  lastFailedProbe?: string;
  reasonCode?: string;
  nextProbeAt?: string;
  pending: number;
  delayed: number;
  discarded: number;
  quarantined: number;
  published: number;
  ingestionSkipped: boolean;
  ingestionSkipReason?: string;
}

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
  return candidate.merchantDomain
    || candidate.sourceEvidence?.merchant?.merchantDomain
    || candidate.payload.merchantDomain
    || domainFromUrl(candidate.payload.canonicalProductUrl || candidate.payload.originalUrl);
}

function latest(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function updateProbeTimes(row: SourceReliabilityRow, evidence: CommerceUrlProbeEvidence | undefined): void {
  if (!evidence) return;
  if (evidence.classification === 'HEALTHY') row.lastSuccessfulProbe = latest(row.lastSuccessfulProbe, evidence.checkedAt);
  else {
    row.lastFailedProbe = latest(row.lastFailedProbe, evidence.checkedAt);
    if (!row.reasonCode || Date.parse(evidence.checkedAt) >= Date.parse(row.lastFailedProbe || '')) row.reasonCode = evidence.reasonCode;
  }
  row.nextProbeAt = latest(row.nextProbeAt, evidence.retryAfter);
}

function rowKey(provider: string, campaign: string, gateway: string, merchant: string): string {
  return `${provider}|${campaign}|${gateway}|${merchant}`.toLowerCase();
}

function createRow(provider: string, campaign: string, gateway: string, merchant: string): SourceReliabilityRow {
  return {
    id: rowKey(provider, campaign, gateway, merchant),
    provider, campaign, affiliateGatewayDomain: gateway, merchantDomain: merchant,
    affiliateCircuitState: 'CLOSED', merchantCircuitState: 'CLOSED', circuitState: 'CLOSED',
    pending: 0, delayed: 0, discarded: 0, quarantined: 0, published: 0,
    ingestionSkipped: false,
  };
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
    row.reasonCode = candidate.terminalReason || candidate.delayReason || row.reasonCode;
    row.nextProbeAt = latest(row.nextProbeAt, candidate.nextAttemptAt);
    updateProbeTimes(row, candidate.sourceEvidence?.affiliate);
    updateProbeTimes(row, candidate.sourceEvidence?.merchant);
  }

  for (const product of products) {
    const provider = String(product.source || 'unknown');
    const campaign = String(product.campaignName || product.affiliateUrlCampaignId || 'uncategorized');
    const gateway = product.affiliateGatewayDomain || product.sourceEvidence?.affiliate.affiliateGatewayDomain || domainFromUrl(product.affiliateUrl);
    const merchant = product.merchantDomain || product.sourceEvidence?.merchant?.merchantDomain || domainFromUrl(product.canonicalProductUrl || product.originalUrl);
    const row = getRow(provider, campaign, gateway, merchant);
    if (product.lifecycleState === 'QUARANTINED' || product.status === 'archived' || product.publicBlocked) row.quarantined++;
    if (product.status === 'published' && product.publicHidden === false && !product.publicBlocked) row.published++;
    row.reasonCode = product.lastEligibilityDecision?.reasonCodes?.[0]
      || product.quarantineReasons?.[0]
      || product.publicBlockReasons?.[0]
      || row.reasonCode;
    updateProbeTimes(row, product.sourceEvidence?.affiliate);
    updateProbeTimes(row, product.sourceEvidence?.merchant);
  }

  // A fully rejected discovery pool has no candidate/product row of its own.
  // Materialize the provider state so NO_HEALTHY_PRODUCT_SOURCE remains
  // visible instead of collapsing into an empty dashboard.
  for (const state of ingestion) {
    const row = getRow(state.provider, 'all campaigns', 'unknown', 'unknown');
    row.ingestionSkipped = state.ingestionSkipped;
    row.ingestionSkipReason = state.ingestionSkipped ? state.reasonCode : undefined;
    row.reasonCode ||= state.reasonCode;
    row.nextProbeAt = latest(row.nextProbeAt, state.nextEligibleAt);
  }

  for (const row of rows.values()) {
    const affiliateCircuit = circuits.find(item => item.role === 'AFFILIATE_GATEWAY' && item.domain === row.affiliateGatewayDomain);
    const merchantCircuit = circuits.find(item => item.role === 'MERCHANT' && item.domain === row.merchantDomain);
    row.affiliateCircuitState = affiliateCircuit?.state || 'CLOSED';
    row.merchantCircuitState = merchantCircuit?.state || 'CLOSED';
    row.circuitState = row.merchantCircuitState !== 'CLOSED' ? row.merchantCircuitState : row.affiliateCircuitState;
    row.lastSuccessfulProbe = latest(row.lastSuccessfulProbe, latest(affiliateCircuit?.lastSuccessAt, merchantCircuit?.lastSuccessAt));
    row.lastFailedProbe = latest(row.lastFailedProbe, latest(affiliateCircuit?.lastFailureAt, merchantCircuit?.lastFailureAt));
    row.reasonCode ||= merchantCircuit?.lastFailureCode || affiliateCircuit?.lastFailureCode;
    row.nextProbeAt = latest(row.nextProbeAt, latest(affiliateCircuit?.nextProbeAt, merchantCircuit?.nextProbeAt));
    const providerState = ingestion.find(item => item.provider === row.provider);
    row.ingestionSkipped = providerState?.ingestionSkipped === true;
    row.ingestionSkipReason = providerState?.ingestionSkipped ? providerState.reasonCode : undefined;
  }

  const rowList = [...rows.values()];
  const discovered = rowList.map(r => ({ campaignName: r.campaign, merchantDomain: r.merchantDomain }));
  const eligible = rowList.filter(r => !settings.pausedSourceDomains.includes(r.merchantDomain) && !settings.pausedSourceCampaigns.includes(r.campaign))
    .map(r => ({ campaignName: r.campaign, merchantDomain: r.merchantDomain }));
  const healthy = rowList.filter(r => r.circuitState === 'CLOSED' && !settings.pausedSourceDomains.includes(r.merchantDomain) && !settings.pausedSourceCampaigns.includes(r.campaign))
    .map(r => ({ campaignName: r.campaign, merchantDomain: r.merchantDomain }));
  const providersChecked = new Set(rowList.map(r => r.provider)).size;
  const diversity = computeSourceDiversity(discovered, eligible, healthy, providersChecked);

  return {
    generatedAt: new Date().toISOString(),
    rows: rowList.sort((left, right) =>
      Number(right.ingestionSkipped) - Number(left.ingestionSkipped)
      || Number(right.circuitState !== 'CLOSED') - Number(left.circuitState !== 'CLOSED')
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
  };
}
