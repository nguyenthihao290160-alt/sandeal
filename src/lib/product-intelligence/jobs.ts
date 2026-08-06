import type { AutomationJob } from '@/lib/automation/types';
import { getAutomationControl, getAutomationJobAuthoritySnapshot } from '@/lib/automation/store';
import { isRuntimeRoleOwner } from '@/lib/automation/runtimeRoles';
import { throwIfExecutionAborted } from '@/lib/automation/executionBudget';
import type { CommerceSourceEvidence, CommerceUrlProbeEvidence, Product, ProductFieldProvenance } from '@/lib/types';
import { saveCanonicalProduct } from '@/lib/storage/products';
import { readCollectionPage, runTransaction, scanCollection } from '@/lib/storage/adapter';
import { normalizeCanonicalProduct } from '@/lib/canonicalProduct';
import {
  productImageValidationState,
  resolveHealthyImageCandidate,
  type ImageCandidateResolution,
  type LinkCheckResult,
} from '@/lib/bots/productHealthCheck';
import {
  ACCESS_TRADE_AFFILIATE_URL_FIELDS,
  ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS,
  extractAccessTradeAffiliateDestination,
  isAccessTradeTrackingUrl,
} from '@/lib/integrations/accesstrade';
import { eligibilityBlockerMessage, evaluateProductEligibility } from '@/lib/productEligibility';
import {
  isFailClosedProductBlocker,
  preserveFailClosedProductBlockers,
} from '@/lib/productBlockers';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { getDomainCircuitDecision, recordDomainHealth } from '@/lib/bots/domainCircuitBreaker';
import {
  commerceProbeBlockerCode,
  commerceProbeToLegacyLinkResult,
  probeCommerceUrl,
  type CommerceUrlProbeResult,
  type CommerceUrlProbeRole,
} from '@/lib/commerce/urlProbe';
import { sourceReliabilityEvent } from '@/lib/commerce/sourceReliability';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import { applyImportBatch, escapeCsvCell, getImportBatch } from './importer';
import { detectDuplicateGroups, applyDuplicateMerge } from './dedupe';
import { calculateProductScores } from './scoring';
import { capturePriceSnapshot, getPriceStatistics } from './priceHistory';
import { createLocalContentDraft, editorialCheckDraft, listContentDrafts } from './contentStudio';
import { aggregateGrowthMetrics } from './growth';
import { evaluateAlerts } from './alerts';
import { getAlertIncident, recordServerIncidentRecheck, synchronizeAlertIncidents } from './alertIncidents';

const JOB_TYPES = new Set([
  'IMPORT_PRODUCTS', 'RECHECK_PRODUCT_HEALTH', 'DETECT_DUPLICATES', 'SCORE_PRODUCTS', 'CAPTURE_PRICE_HISTORY',
  'PREPARE_CONTENT_DRAFT', 'EDITORIAL_CHECK', 'EVALUATE_ALERTS', 'AGGREGATE_GROWTH_METRICS', 'BULK_PRODUCT_OPERATION',
]);
const REPROCESS_AUDIT_COLLECTION = 'product-reprocess-audit';

export interface ProductReprocessAudit {
  id: string;
  operationId: string;
  jobId: string;
  productId: string;
  actor: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED';
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ProductIntelligenceExecutionOptions {
  signal?: AbortSignal;
  deadline?: number;
  fetchImpl?: typeof fetch;
  resolveDns?: boolean;
}

function stringValue(value: unknown, maximum = 160): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function productIds(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.productIds)
    ? [...new Set(payload.productIds.map(value => stringValue(value)).filter(Boolean))].slice(0, CONFIG.limits.batchProducts)
    : [];
}

function payloadLimit(payload: Record<string, unknown>): number {
  const requested = Number(payload.limit);
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(CONFIG.limits.batchProducts, Math.floor(requested)))
    : CONFIG.limits.batchProducts;
}

function stableCursor(value: unknown): number {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric)) return Math.abs(numeric);
  const text = String(value || '');
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

/** Stable rotation prevents recurring scheduler jobs from repeatedly selecting the first batch. */
export function selectDeterministicProductBatch(
  products: Product[],
  payload: Record<string, unknown>,
): Product[] {
  const ordered = [...products].sort((left, right) => left.id.localeCompare(right.id));
  if (!ordered.length) return [];
  const limit = Math.min(payloadLimit(payload), ordered.length);
  const hasExplicitCursor = payload.cursor !== undefined && payload.cursor !== null && payload.cursor !== '';
  const cursorSource = hasExplicitCursor ? payload.cursor : payload.scheduleBucket;
  const baseCursor = stableCursor(cursorSource);
  const start = hasExplicitCursor
    ? baseCursor % ordered.length
    : ((baseCursor % ordered.length) * limit) % ordered.length;
  return Array.from({ length: limit }, (_, index) => ordered[(start + index) % ordered.length]);
}

const PRODUCT_COLLECTION = 'products';
const PRODUCT_WINDOW_PAGE_SIZE = Math.min(CONFIG.limits.batchProducts, 100);

async function readProductsByIds(ids: string[], signal?: AbortSignal): Promise<Product[]> {
  const wanted = new Set(ids);
  const found = new Map<string, Product>();
  await scanCollection<Partial<Product>>(PRODUCT_COLLECTION, raw => {
    throwIfExecutionAborted(signal);
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id && wanted.has(id)) {
      found.set(id, normalizeCanonicalProduct(raw));
      wanted.delete(id);
    }
  });
  return ids.map(id => found.get(id)).filter((item): item is Product => Boolean(item));
}

async function selectedProducts(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Product[]> {
  const ids = productIds(payload);
  if (ids.length) return selectDeterministicProductBatch(await readProductsByIds(ids, signal), payload);

  // Scheduled jobs use a bounded source-order window. The file adapter scans
  // the JSON array incrementally and retains only one page; Mongo uses the
  // equivalent bounded query. This keeps the cursor deterministic across
  // cycles without materializing the complete product collection.
  throwIfExecutionAborted(signal);
  const requestedLimit = Math.min(payloadLimit(payload), PRODUCT_WINDOW_PAGE_SIZE);
  const firstPage = await readCollectionPage<Partial<Product>>(PRODUCT_COLLECTION, {
    page: 1,
    pageSize: requestedLimit,
  });
  const totalItems = firstPage.totalItems;
  if (!totalItems) return [];
  const limit = Math.min(requestedLimit, totalItems);
  const hasExplicitCursor = payload.cursor !== undefined && payload.cursor !== null && payload.cursor !== '';
  const cursorSource = hasExplicitCursor ? payload.cursor : payload.scheduleBucket;
  const baseCursor = stableCursor(cursorSource);
  const start = hasExplicitCursor
    ? baseCursor % totalItems
    : ((baseCursor % totalItems) * limit) % totalItems;
  const pages = new Map<number, Product[]>();
  pages.set(1, firstPage.items.map(item => normalizeCanonicalProduct(item)));
  const loadPage = async (page: number): Promise<Product[]> => {
    const cached = pages.get(page);
    if (cached) return cached;
    throwIfExecutionAborted(signal);
    const result = await readCollectionPage<Partial<Product>>(PRODUCT_COLLECTION, {
      page,
      pageSize: limit,
    });
    const normalized = result.items.map(item => normalizeCanonicalProduct(item));
    pages.set(page, normalized);
    return normalized;
  };

  const selected: Product[] = [];
  for (let offset = 0; offset < limit; offset += 1) {
    throwIfExecutionAborted(signal);
    const absoluteIndex = (start + offset) % totalItems;
    const page = Math.floor(absoluteIndex / limit) + 1;
    const pageItems = await loadPage(page);
    const item = pageItems[absoluteIndex % limit];
    if (!item) throw new Error('PRODUCT_SELECTION_SOURCE_CHANGED');
    selected.push(item);
  }
  return selected;
}

async function assertJobMayContinue(job: AutomationJob, options: ProductIntelligenceExecutionOptions = {}): Promise<void> {
  throwIfExecutionAborted(options.signal);
  const [control, latest] = await Promise.all([getAutomationControl(), getAutomationJobAuthoritySnapshot(job.id)]);
  if (control.killSwitch) throw new Error('KILL_SWITCH_ACTIVE');
  // The exported intelligence runner is also used by the bounded operator
  // reprocess/test path, which supplies an ephemeral RUNNING record rather
  // than a claimed durable worker job. Durable Worker executions always carry
  // a claim token and take the fenced branch below.
  if (!job.claimToken) return;
  if (!latest) throw new Error('JOB_AUTHORITY_UNAVAILABLE');
  if (latest.status === 'CANCELLED') throw new Error('JOB_CANCELLED');
  if (latest.status !== 'RUNNING'
    || latest.claimToken !== job.claimToken
    || latest.attemptCount !== job.attemptCount
    || (job.releaseId && latest.releaseId !== job.releaseId)) {
    throw new Error('WORKER_FENCING_REJECTED');
  }
  if (job.workerInstanceId && job.workerFencingToken) {
    const owner = await isRuntimeRoleOwner('WORKER', {
      ownerId: job.workerOwnerId || '',
      instanceId: job.workerInstanceId,
      fencingToken: job.workerFencingToken,
    });
    if (!owner) throw new Error('WORKER_FENCING_REJECTED');
  }
}

function isJobStop(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'KILL_SWITCH_ACTIVE'
    || message === 'JOB_CANCELLED'
    || message === 'WORKER_FENCING_REJECTED';
}

async function scoreProducts(job: AutomationJob, execution: ProductIntelligenceExecutionOptions = {}) {
  const products = await selectedProducts(job.payload, execution.signal);
  if (job.dryRun) return { preview: true, inspected: products.length, businessDataChanged: false, externalSideEffect: false };
  let updated = 0;
  for (const product of products) {
    await assertJobMayContinue(job, execution);
    const history = await getPriceStatistics(product.id);
    const scores = calculateProductScores(product, history);
    throwIfExecutionAborted(execution.signal);
    await saveCanonicalProduct(product.id, {
      qualityScore: scores.quality.score,
      qualityBand: scores.quality.band,
      opportunityScore: scores.opportunity.score,
      opportunityBand: scores.opportunity.band,
      score: scores.opportunity.score,
      scoreVersion: scores.opportunity.version,
      scoreCalculatedAt: scores.opportunity.calculatedAt,
      scoreBreakdown: Object.fromEntries([
        ...Object.entries(scores.quality.breakdown).map(([key, value]) => [`quality_${key}`, value]),
        ...Object.entries(scores.opportunity.breakdown).map(([key, value]) => [`opportunity_${key}`, value]),
        ...Object.entries(scores.deal.breakdown).map(([key, value]) => [`deal_${key}`, value]),
      ]),
      dealScore: scores.deal.dealScore,
      dealBand: scores.deal.dealBand,
      dealReasons: scores.deal.reasons,
      dealConfidence: scores.deal.confidence,
      dataIssues: [...new Set([...scores.quality.failedRules, ...scores.quality.warnings, ...scores.quality.blockers])],
      recommendedActions: [...new Set([...scores.quality.recommendations, ...scores.opportunity.warnings])],
    });
    updated += 1;
  }
  return { inspected: products.length, updated, businessDataChanged: updated > 0 };
}

interface ResilientLinkResult {
  result: LinkCheckResult;
  retryAt?: string;
  circuitSkipped: boolean;
  probe?: CommerceUrlProbeResult;
}

async function checkLinkWithDomainCircuit(
  url: string,
  probeRole: CommerceUrlProbeRole,
  now = Date.now(),
  options: ProductIntelligenceExecutionOptions = {},
  identifiers: { jobId?: string; operationId?: string } = {},
): Promise<ResilientLinkResult> {
  throwIfExecutionAborted(options.signal);
  const circuitRole = probeRole === 'AFFILIATE' ? 'AFFILIATE_GATEWAY' : 'MERCHANT';
  const decision = await getDomainCircuitDecision(url, now, { role: circuitRole, ...identifiers });
  if (!decision.allowed) {
    return {
      result: {
        status: 'timeout',
        ok: false,
        retryable: true,
        reason: decision.reason === 'half_open_probe_in_flight'
          ? 'One bounded half-open probe is already in flight.'
          : `Domain circuit open until ${decision.retryAt || 'the next retry window'}`,
        errorCode: probeRole === 'AFFILIATE' ? 'AFFILIATE_GATEWAY_CIRCUIT_OPEN' : 'MERCHANT_CIRCUIT_OPEN',
      },
      retryAt: decision.retryAt,
      circuitSkipped: true,
    };
  }

  const probe = await probeCommerceUrl(url, {
    role: probeRole,
    signal: options.signal,
    jobId: identifiers.jobId,
    operationId: identifiers.operationId,
    fetchImpl: options.fetchImpl,
    resolveDns: options.resolveDns,
  });
  const result = commerceProbeToLegacyLinkResult(probe);
  const circuitStatus = probe.classification === 'HEALTHY'
    ? 'healthy'
    : probe.retryable && probe.classification === 'AFFILIATE_LINK_REJECTED'
      ? 'network_error'
      : probe.classification.toLowerCase();
  const state = await recordDomainHealth(url, circuitStatus, now, {
    role: circuitRole,
    retryAfter: probe.retryAfter,
    ...identifiers,
  });
  return {
    result,
    retryAt: result.ok ? undefined : state?.nextRetryAt,
    circuitSkipped: false,
    probe,
  };
}

interface ResilientImageResult {
  resolution: ImageCandidateResolution;
  retryAt?: string;
  circuitSkipped: number;
}

async function resolveImagesWithDomainCircuits(
  candidates: Array<string | undefined>,
  now = Date.now(),
  options: ProductIntelligenceExecutionOptions = {},
): Promise<ResilientImageResult> {
  const urls = [...new Set(candidates.map(value => String(value || '').trim()).filter(Boolean))];
  const allowed: string[] = [];
  const skippedRetryTimes: string[] = [];
  let circuitSkipped = 0;

  for (const url of urls) {
    throwIfExecutionAborted(options.signal);
    const decision = await getDomainCircuitDecision(url, now);
    if (!decision.allowed && decision.reason === 'circuit_open') {
      circuitSkipped += 1;
      if (decision.retryAt) skippedRetryTimes.push(decision.retryAt);
    } else {
      allowed.push(url);
    }
  }

  if (!allowed.length) {
    return {
      resolution: {
        result: {
          status: 'timeout',
          ok: false,
          retryable: true,
          reason: urls.length ? 'All image candidate domains have open circuits' : 'No image candidate',
        },
        checked: [],
        attempts: 0,
      },
      retryAt: latestTimestamp(skippedRetryTimes),
      circuitSkipped,
    };
  }

  const resolution = await resolveHealthyImageCandidate(allowed, { signal: options.signal });
  const retryTimes = [...skippedRetryTimes];
  for (const checked of resolution.checked) {
    const state = await recordDomainHealth(checked.url, checked.result.status, now);
    if (!checked.result.ok && checked.result.retryable && state?.nextRetryAt) retryTimes.push(state.nextRetryAt);
  }
  return {
    resolution,
    retryAt: resolution.result.ok ? undefined : latestTimestamp(retryTimes),
    circuitSkipped,
  };
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  const latest = values.reduce((maximum, value) => {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
  }, 0);
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

function finalDomain(value?: string): string | undefined {
  try { return new URL(value || '').hostname.toLowerCase().replace(/^www\./, '') || undefined; } catch { return undefined; }
}

function persistedCommerceProbe(result: CommerceUrlProbeResult): CommerceUrlProbeEvidence {
  return {
    classification: result.classification,
    httpStatus: result.httpStatus,
    normalizedFinalUrl: result.normalizedFinalUrl,
    affiliateGatewayDomain: result.affiliateGatewayDomain,
    merchantDomain: result.merchantDomain,
    redirectCount: result.redirectCount,
    elapsedMs: result.elapsedTimeMs,
    retryable: result.retryable,
    reasonCode: result.reasonCode,
    checkedAt: result.checkedAt,
    retryAfter: result.retryAfter,
    queryParameterNames: result.diagnostics.requested.queryParameterNames,
  };
}

function mergedCommerceSourceEvidence(
  product: Product,
  affiliateProbe?: CommerceUrlProbeResult,
  merchantProbe?: CommerceUrlProbeResult,
): CommerceSourceEvidence | undefined {
  const affiliate = affiliateProbe ? persistedCommerceProbe(affiliateProbe) : product.sourceEvidence?.affiliate;
  const merchant = merchantProbe ? persistedCommerceProbe(merchantProbe) : product.sourceEvidence?.merchant;
  if (!affiliate || !merchant) return undefined;
  const checkedTimes = [affiliate.checkedAt, merchant.checkedAt].map(value => Date.parse(value));
  if (checkedTimes.some(value => !Number.isFinite(value))) return undefined;
  return {
    schemaVersion: 1,
    ruleVersion: 'commerce-source-v1',
    checkedAt: new Date(Math.max(...checkedTimes)).toISOString(),
    // Partial rechecks must not make older evidence fresh. Expire from the
    // older of the two independently verified links.
    expiresAt: new Date(Math.min(...checkedTimes) + 6 * 60 * 60_000).toISOString(),
    affiliate,
    merchant,
  };
}

export function accessTradeAffiliateSupport(product: Partial<Product>): { supported: boolean; reason?: string } {
  if (product.source !== 'accesstrade' && product.platform !== 'accesstrade') return { supported: true };
  if (!product.affiliateUrl) return { supported: false, reason: 'Nhà cung cấp không trả về tracking URL/deep-link.' };
  if (product.affiliateUrlSource !== 'provider_api'
    || product.affiliateUrlProvider !== 'accesstrade'
    || product.affiliateUrlSourceEndpoint !== 'datafeed'
    || !product.affiliateUrlSourceField
    || !(ACCESS_TRADE_AFFILIATE_URL_FIELDS as readonly string[]).includes(product.affiliateUrlSourceField)) {
    return { supported: false, reason: 'Affiliate URL AccessTrade không có provenance API/field trong allowlist.' };
  }
  let legacySynthesized = false;
  try {
    const parsed = new URL(product.affiliateUrl);
    legacySynthesized = parsed.hostname.toLowerCase() === 'go.isclix.com' && /\/deep[_-]?link(?:\/|$)/i.test(parsed.pathname);
  } catch { /* malformed URL is rejected by the health checker */ }
  if (legacySynthesized && product.affiliateUrlSource !== 'provider_api' && product.deepLinkSupported !== true) {
    return { supported: false, reason: 'Nhà cung cấp không cho phép deep-link.' };
  }
  if (product.affiliateLinkReason === 'provider_deeplink_not_supported') {
    return { supported: false, reason: 'Nhà cung cấp không cho phép deep-link.' };
  }
  return { supported: true };
}

function domainsRelated(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function affiliateFinalDomainAllowed(product: Partial<Product>, finalUrl: string | undefined): boolean {
  if (!finalUrl) return false;
  if (isAccessTradeTrackingUrl(finalUrl)) return true;
  const finalHost = finalDomain(finalUrl);
  const destination = product.affiliateDestinationUrl || extractAccessTradeAffiliateDestination(product.affiliateUrl);
  const allowedHosts = [
    finalDomain(destination),
    finalDomain(product.canonicalProductUrl || product.originalUrl),
    product.merchantDomain?.toLowerCase().replace(/^www\./, ''),
  ].filter((value): value is string => Boolean(value));
  return allowedHosts.some(host => domainsRelated(finalHost, host));
}

function canonicalFinalDomainAllowed(product: Partial<Product>, canonicalUrl: string, finalUrl: string | undefined): boolean {
  const finalHost = finalDomain(finalUrl || canonicalUrl);
  const allowedHosts = [
    finalDomain(canonicalUrl),
    product.merchantDomain?.toLowerCase().replace(/^www\./, ''),
  ].filter((value): value is string => Boolean(value));
  return allowedHosts.some(host => domainsRelated(finalHost, host));
}

function setFieldProvenance(
  product: Product,
  updates: Partial<Product>,
  field: string,
  patch: Partial<ProductFieldProvenance> & Pick<ProductFieldProvenance, 'verificationStatus'>,
): void {
  const current = updates.fieldProvenance || product.fieldProvenance || {};
  updates.fieldProvenance = {
    ...current,
    [field]: {
      ...(current[field] || {}),
      source: current[field]?.source || product.source,
      ...patch,
    },
  };
}

export function accessTradeCanonicalSupport(product: Partial<Product>): { supported: boolean; reason?: string } {
  if (product.source !== 'accesstrade' && product.platform !== 'accesstrade') return { supported: true };
  const canonicalUrl = product.canonicalProductUrl || product.originalUrl;
  if (!canonicalUrl) return { supported: false, reason: 'Nhà cung cấp không trả về canonical product URL.' };
  if (isAccessTradeTrackingUrl(canonicalUrl)) {
    return { supported: false, reason: 'Tracking URL không được dùng làm canonical product URL.' };
  }
  if (product.canonicalUrlSource !== 'provider_api'
    || product.canonicalUrlProvider !== 'accesstrade'
    || product.canonicalUrlSourceEndpoint !== 'datafeed'
    || !product.canonicalUrlSourceField
    || !(ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS as readonly string[]).includes(product.canonicalUrlSourceField)) {
    return { supported: false, reason: 'Canonical URL AccessTrade không có provenance API/field trong allowlist.' };
  }
  return { supported: true };
}

function operationalHealthSignature(product: Partial<Product>): string {
  return JSON.stringify({
    canonicalProductUrl: product.canonicalProductUrl,
    canonicalUrlStatus: product.canonicalUrlStatus,
    canonicalUrlVerifiedAt: product.canonicalUrlVerifiedAt,
    linkHealthStatus: product.linkHealthStatus,
    productUrlHttpStatus: product.productUrlHttpStatus,
    productUrlFinalUrl: product.productUrlFinalUrl,
    productUrlFinalDomain: product.productUrlFinalDomain,
    productUrlErrorCode: product.productUrlErrorCode,
    productUrlTimedOut: product.productUrlTimedOut,
    affiliateHealthStatus: product.affiliateHealthStatus,
    affiliateUrlHttpStatus: product.affiliateUrlHttpStatus,
    affiliateUrlFinalUrl: product.affiliateUrlFinalUrl,
    affiliateUrlFinalDomain: product.affiliateUrlFinalDomain,
    affiliateUrlErrorCode: product.affiliateUrlErrorCode,
    affiliateUrlTimedOut: product.affiliateUrlTimedOut,
    affiliateUrlStatus: product.affiliateUrlStatus,
    quarantinedAffiliateUrl: product.quarantinedAffiliateUrl,
    imageUrl: product.imageUrl,
    imageHealthStatus: product.imageHealthStatus,
    imageValidationState: product.imageValidationState,
    imageUrlHttpStatus: product.imageUrlHttpStatus,
    imageUrlFinalUrl: product.imageUrlFinalUrl,
    imageUrlHealthReason: product.imageUrlHealthReason,
    publicHidden: product.publicHidden,
    publicBlocked: product.publicBlocked,
    publicBlockReason: product.publicBlockReason,
    publicBlockReasons: [...(product.publicBlockReasons || [])].sort(),
    lifecycleState: product.lifecycleState,
    status: product.status,
  });
}

function reprocessAuditSnapshot(product: Partial<Product>): Record<string, unknown> {
  return {
    canonicalProductUrl: product.canonicalProductUrl || product.originalUrl || null,
    canonicalUrlSource: product.canonicalUrlSource || 'none',
    canonicalUrlProvider: product.canonicalUrlProvider || null,
    canonicalUrlSourceField: product.canonicalUrlSourceField || null,
    canonicalUrlStatus: product.canonicalUrlStatus || 'unavailable',
    canonicalUrlVerifiedAt: product.canonicalUrlVerifiedAt || null,
    productUrlHttpStatus: product.productUrlHttpStatus ?? null,
    productUrlFinalUrl: product.productUrlFinalUrl || null,
    productUrlHealthReason: product.productUrlHealthReason || null,
    affiliateUrl: product.affiliateUrl || null,
    affiliateUrlSource: product.affiliateUrlSource || 'none',
    affiliateUrlProvider: product.affiliateUrlProvider || null,
    affiliateUrlSourceField: product.affiliateUrlSourceField || null,
    affiliateUrlStatus: product.affiliateUrlStatus || 'unavailable',
    affiliateUrlVerifiedAt: product.affiliateUrlVerifiedAt || null,
    affiliateUrlHttpStatus: product.affiliateUrlHttpStatus ?? null,
    affiliateUrlFinalUrl: product.affiliateUrlFinalUrl || null,
    affiliateUrlHealthReason: product.affiliateUrlHealthReason || null,
    quarantinedAffiliateUrl: product.quarantinedAffiliateUrl || null,
    imageUrl: product.imageUrl || null,
    imageHealthStatus: product.imageHealthStatus || 'unknown',
    imageUrlHttpStatus: product.imageUrlHttpStatus ?? null,
    imageUrlFinalUrl: product.imageUrlFinalUrl || null,
    imageContentType: product.imageContentType || null,
    price: product.price ?? null,
    salePrice: product.salePrice ?? null,
    sourceVerified: product.sourceVerified === true || product.verifiedSource === true,
    status: product.status || 'needs_review',
    lifecycleState: product.lifecycleState || 'STAGED',
    publicHidden: product.publicHidden !== false,
    publicBlocked: product.publicBlocked === true,
    publicBlockReasons: product.publicBlockReasons || [],
  };
}

async function startReprocessAudit(job: AutomationJob, product: Product): Promise<void> {
  const now = new Date().toISOString();
  const operationId = job.operationId || job.id;
  const id = `${operationId}:${product.id}`.slice(0, 240);
  await runTransaction<ProductReprocessAudit>(REPROCESS_AUDIT_COLLECTION, items => {
    if (items.some(item => item.id === id)) return undefined;
    items.push({
      id,
      operationId,
      jobId: job.id,
      productId: product.id,
      actor: job.requestedBy || 'unknown-operator',
      status: 'STARTED',
      before: reprocessAuditSnapshot(product),
      createdAt: now,
    });
    return items;
  });
}

async function finishReprocessAudit(
  job: AutomationJob,
  product: Product,
  status: 'COMPLETED' | 'FAILED',
  error?: unknown,
): Promise<void> {
  const operationId = job.operationId || job.id;
  const id = `${operationId}:${product.id}`.slice(0, 240);
  await runTransaction<ProductReprocessAudit>(REPROCESS_AUDIT_COLLECTION, items => {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) return undefined;
    if (items[index].status === 'COMPLETED' && status === 'COMPLETED') return undefined;
    items[index] = {
      ...items[index],
      status,
      after: reprocessAuditSnapshot(product),
      error: error ? String(error instanceof Error ? error.message : error).slice(0, 500) : undefined,
      completedAt: new Date().toISOString(),
    };
    return items;
  });
}

export class ProductHealthPersistenceError extends Error {
  readonly code = 'STORAGE_ERROR';
  constructor(readonly result: Record<string, unknown>) {
    super('Product health persistence failed; terminal success is not allowed.');
    this.name = 'ProductHealthPersistenceError';
  }
}

export function shouldRetainPublicAfterTransientHealthCheck(input: {
  wasPublicSafe: boolean;
  confirmedBroken: boolean;
  retryScheduled: boolean;
  operationalBlockers: string[];
  priorFailureCount: number;
}): boolean {
  return input.wasPublicSafe
    && !input.confirmedBroken
    && input.retryScheduled
    && input.priorFailureCount === 0
    && input.operationalBlockers.length > 0
    && input.operationalBlockers.every(reason =>
      /product_url|canonical_url|affiliate|image|health|cooldown/i.test(reason));
}

async function recheckHealth(job: AutomationJob, execution: ProductIntelligenceExecutionOptions = {}) {
  const startedAt = Date.now();
  const products = await selectedProducts(job.payload, execution.signal);
  const requestedTarget = stringValue(job.payload.healthTarget, 20);
  const narrowedTarget = new Set(['link', 'affiliate', 'image']).has(requestedTarget);
  const checkLinks = !narrowedTarget || requestedTarget === 'link';
  const checkAffiliate = !narrowedTarget || requestedTarget === 'affiliate';
  const checkImages = !narrowedTarget || requestedTarget === 'image';
  const total = products.length;
  if (job.dryRun) return {
    preview: true,
    total,
    processed: 0,
    healthy: 0,
    unhealthy: 0,
    quarantined: 0,
    unchanged: 0,
    skipped: total,
    failed: 0,
    durationMs: Date.now() - startedAt,
    checked: 0,
    inspected: total,
    valid: 0,
    blocked: 0,
    healthTarget: requestedTarget || 'all',
    estimatedRequests: products.reduce((sum, item) => sum
      + Number(checkLinks && Boolean(item.canonicalProductUrl || item.originalUrl))
      + Number(checkAffiliate && Boolean(item.affiliateUrl))
      + Number(checkImages && Boolean(item.imageUrl)), 0),
    businessDataChanged: false,
  };

  let processed = 0; let healthy = 0; let unhealthy = 0; let failed = 0; let quarantined = 0; let unchanged = 0; let skipped = 0;
  let circuitSkipped = 0; let fallbackImages = 0; let retryScheduled = 0; let externalRequests = 0;
  const persistenceErrors: string[] = [];

  const resultSnapshot = () => ({
    total,
    processed,
    healthy,
    unhealthy,
    quarantined,
    unchanged,
    skipped,
    failed,
    durationMs: Date.now() - startedAt,
    checked: processed,
    inspected: processed,
    valid: healthy,
    blocked: unhealthy,
    circuitSkipped,
    fallbackImages,
    retryScheduled,
    externalRequests,
    healthTarget: requestedTarget || 'all',
    persistenceErrors: persistenceErrors.slice(0, 20),
    businessDataChanged: processed > unchanged,
  });

  for (const product of products) {
    throwIfExecutionAborted(execution.signal);
    const updates: Partial<Product> = {};
    const wasPublicSafe = isPublicSafeProduct(product);
    try {
      await assertJobMayContinue(job, execution);
      const operationId = job.operationId || job.id;
      if (product.lastReprocessOperationId === operationId) {
        await startReprocessAudit(job, product);
        await finishReprocessAudit(job, product, 'COMPLETED');
        skipped += 1;
        continue;
      }
      await startReprocessAudit(job, product);
      const retryTimes: string[] = [];
      const failureReasons: string[] = [];
      const sourceReasonCodes: string[] = [];
      let merchantCommerceProbe: CommerceUrlProbeResult | undefined;
      let affiliateCommerceProbe: CommerceUrlProbeResult | undefined;
      const normalizationIssues = new Set(product.sourceNormalizationIssues || []);
      const goodHealth = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
      let affiliateUrlHealthy = !checkAffiliate && goodHealth.has(String(product.affiliateHealthStatus || ''));
      const effectivePrice = product.salePrice || product.price;
      const priceObservedAt = Date.parse(product.priceObservedAt || product.sourceFetchedAt || '');
      const priceStale = Number.isFinite(priceObservedAt) && Date.now() - priceObservedAt > 7 * 24 * 60 * 60_000;
      const invalidSourcePrice = !effectivePrice && (
        normalizationIssues.has('INVALID_PRICE')
        || product.fieldProvenance?.price?.verificationStatus === 'INVALID'
      );
      updates.priceVerificationStatus = !effectivePrice ? invalidSourcePrice ? 'INVALID' : 'MISSING'
        : priceStale ? 'STALE'
          : product.priceVerificationStatus === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
      setFieldProvenance(product, updates, 'price', {
        value: effectivePrice ?? product.fieldProvenance?.price?.value,
        verificationStatus: updates.priceVerificationStatus,
        verificationReason: !effectivePrice
          ? invalidSourcePrice ? 'PRICE_FORMAT_INVALID' : 'PRICE_MISSING'
          : priceStale ? 'PRICE_STALE'
            : product.priceVerificationStatus === 'VERIFIED' ? undefined : 'PRICE_SOURCE_OBSERVATION_NOT_INDEPENDENTLY_VERIFIED',
      });
      if (!effectivePrice) failureReasons.push(invalidSourcePrice ? 'price:invalid' : 'price:missing');
      else if (updates.priceVerificationStatus !== 'VERIFIED') failureReasons.push(`price:${updates.priceVerificationStatus.toLowerCase()}`);

      const canonicalUrl = product.canonicalProductUrl || product.originalUrl;
      const canonicalSupport = accessTradeCanonicalSupport(product);
      if (checkLinks && canonicalUrl) {
        const checkedLink = await checkLinkWithDomainCircuit(canonicalUrl, 'MERCHANT', Date.now(), execution, {
          jobId: job.id,
          operationId: job.operationId,
        });
        merchantCommerceProbe = checkedLink.probe;
        const linkResult = checkedLink.result;
        const canonicalDestinationSupported = !isAccessTradeTrackingUrl(linkResult.finalUrl || canonicalUrl);
        const canonicalDomainAllowed = canonicalFinalDomainAllowed(product, canonicalUrl, linkResult.finalUrl);
        const canonicalHealthy = linkResult.ok && canonicalSupport.supported && canonicalDestinationSupported && canonicalDomainAllowed;
        const canonicalReason = canonicalSupport.reason
          || (!canonicalDestinationSupported
            ? 'Canonical URL resolved to a tracking host.'
            : !canonicalDomainAllowed
              ? 'Canonical URL chuyển hướng tới domain ngoài allowlist của sản phẩm.'
              : linkResult.reason);
        updates.canonicalProductUrl = canonicalUrl;
        updates.originalUrl = canonicalUrl;
        updates.linkHealthStatus = (canonicalHealthy ? linkResult.status : linkResult.ok ? 'unknown' : linkResult.status) as Product['linkHealthStatus'];
        updates.linkLastCheckedAt = new Date().toISOString();
        updates.productUrlHttpStatus = linkResult.statusCode;
        updates.productUrlFinalUrl = linkResult.finalUrl;
        updates.productUrlFinalDomain = finalDomain(linkResult.finalUrl || canonicalUrl);
        updates.productUrlHealthReason = canonicalReason.slice(0, 500);
        updates.productUrlErrorCode = canonicalSupport.supported
          ? canonicalDestinationSupported
            ? canonicalDomainAllowed ? linkResult.errorCode : 'CANONICAL_FINAL_DOMAIN_NOT_ALLOWED'
            : 'CANONICAL_RESOLVED_TO_TRACKING'
          : 'CANONICAL_PROVENANCE_REQUIRED';
        updates.productUrlTimedOut = linkResult.timedOut === true;
        updates.canonicalUrlVerifiedAt = canonicalHealthy ? new Date().toISOString() : undefined;
        updates.canonicalUrlStatus = canonicalHealthy ? 'verified' : linkResult.retryable ? 'unverified' : 'invalid';
        setFieldProvenance(product, updates, 'canonicalProductUrl', {
          value: canonicalUrl,
          verificationStatus: canonicalHealthy ? 'VERIFIED' : linkResult.retryable ? 'UNVERIFIED' : 'INVALID',
          verifiedAt: canonicalHealthy ? updates.canonicalUrlVerifiedAt : undefined,
          verificationReason: canonicalReason,
        });
        if (!canonicalHealthy) {
          failureReasons.push(`link:${canonicalSupport.supported ? linkResult.status : 'provenance_required'}`);
          sourceReasonCodes.push(!canonicalSupport.supported
            ? 'CANONICAL_PROVENANCE_REQUIRED'
            : !canonicalDestinationSupported
              ? 'MERCHANT_RESOLVED_TO_AFFILIATE_GATEWAY'
              : !canonicalDomainAllowed
                ? 'MERCHANT_FINAL_DOMAIN_REJECTED'
                : checkedLink.probe
                  ? commerceProbeBlockerCode(checkedLink.probe, 'MERCHANT')
                  : linkResult.errorCode || 'MERCHANT_CIRCUIT_OPEN');
          if (linkResult.retryable && checkedLink.retryAt) retryTimes.push(checkedLink.retryAt);
        }
        if (checkedLink.circuitSkipped) circuitSkipped += 1;
        else externalRequests += 1;
        await assertJobMayContinue(job, execution);
      } else if (checkLinks) {
        const invalidSourceUrl = normalizationIssues.has('INVALID_CANONICAL_URL')
          || product.fieldProvenance?.canonicalProductUrl?.verificationStatus === 'INVALID';
        updates.linkHealthStatus = 'error';
        updates.linkLastCheckedAt = new Date().toISOString();
        updates.productUrlHealthReason = invalidSourceUrl
          ? 'Nguồn có product URL nhưng định dạng không hợp lệ.'
          : 'Thiếu product URL hợp lệ.';
        updates.productUrlErrorCode = invalidSourceUrl ? 'INVALID_PRODUCT_URL' : 'MISSING_PRODUCT_URL';
        updates.productUrlTimedOut = false;
        updates.canonicalUrlVerifiedAt = undefined;
        updates.canonicalUrlStatus = invalidSourceUrl ? 'invalid' : 'unavailable';
        setFieldProvenance(product, updates, 'canonicalProductUrl', {
          value: product.fieldProvenance?.canonicalProductUrl?.value,
          verificationStatus: invalidSourceUrl ? 'INVALID' : 'MISSING',
          verificationReason: updates.productUrlHealthReason,
        });
        failureReasons.push(invalidSourceUrl ? 'link:invalid' : 'link:missing');
        sourceReasonCodes.push(invalidSourceUrl ? 'INVALID_MERCHANT_URL' : 'MISSING_MERCHANT_URL');
      }

      const support = accessTradeAffiliateSupport(product);
      if (checkAffiliate && product.affiliateUrl && support.supported) {
        const checkedLink = await checkLinkWithDomainCircuit(product.affiliateUrl, 'AFFILIATE', Date.now(), execution, {
          jobId: job.id,
          operationId: job.operationId,
        });
        affiliateCommerceProbe = checkedLink.probe;
        const linkResult = checkedLink.result;
        const finalDomainAllowed = affiliateFinalDomainAllowed(product, linkResult.finalUrl || product.affiliateUrl);
        affiliateUrlHealthy = linkResult.ok && finalDomainAllowed;
        const affiliateReason = finalDomainAllowed ? linkResult.reason : 'Affiliate URL chuyển hướng tới domain ngoài allowlist của sản phẩm.';
        updates.affiliateHealthStatus = (affiliateUrlHealthy
          ? linkResult.status
          : linkResult.ok ? 'not_allowed' : linkResult.status) as Product['affiliateHealthStatus'];
        updates.affiliateLastCheckedAt = new Date().toISOString();
        updates.affiliateUrlHttpStatus = linkResult.statusCode;
        updates.affiliateUrlFinalUrl = linkResult.finalUrl;
        updates.affiliateUrlFinalDomain = finalDomain(linkResult.finalUrl || product.affiliateUrl);
        updates.affiliateUrlHealthReason = affiliateReason.slice(0, 500);
        updates.affiliateUrlErrorCode = finalDomainAllowed ? linkResult.errorCode : 'AFFILIATE_FINAL_DOMAIN_NOT_ALLOWED';
        updates.affiliateUrlTimedOut = linkResult.timedOut === true;
        updates.affiliateUrlVerifiedAt = affiliateUrlHealthy ? new Date().toISOString() : undefined;
        updates.affiliateUrlStatus = affiliateUrlHealthy ? 'verified' : linkResult.retryable ? 'unverified' : 'invalid';
        updates.affiliateLinkErrors = affiliateUrlHealthy ? undefined : affiliateReason.slice(0, 500);
        setFieldProvenance(product, updates, 'affiliateUrl', {
          value: product.affiliateUrl,
          verificationStatus: affiliateUrlHealthy ? 'VERIFIED' : linkResult.retryable ? 'UNVERIFIED' : 'INVALID',
          verifiedAt: affiliateUrlHealthy ? updates.affiliateUrlVerifiedAt : undefined,
          verificationReason: affiliateReason,
        });
        if (!affiliateUrlHealthy) {
          failureReasons.push(`affiliate:${finalDomainAllowed ? linkResult.status : 'final_domain_not_allowed'}`);
          sourceReasonCodes.push(!finalDomainAllowed
            ? 'AFFILIATE_FINAL_DOMAIN_REJECTED'
            : checkedLink.probe
              ? commerceProbeBlockerCode(checkedLink.probe, 'AFFILIATE')
              : linkResult.errorCode || 'AFFILIATE_GATEWAY_CIRCUIT_OPEN');
          if (linkResult.retryable && checkedLink.retryAt) retryTimes.push(checkedLink.retryAt);
        }
        if (checkedLink.circuitSkipped) circuitSkipped += 1;
        else externalRequests += 1;
        await assertJobMayContinue(job, execution);
      } else if (checkAffiliate && product.affiliateUrl && !support.supported) {
        affiliateUrlHealthy = false;
        updates.quarantinedAffiliateUrl = {
          url: product.affiliateUrl,
          reason: support.reason || 'Affiliate URL provenance is unavailable.',
          quarantinedAt: new Date().toISOString(),
          provider: product.affiliateUrlProvider,
          sourceField: product.affiliateUrlSourceField,
        };
        // Keep source evidence intact. Missing provenance is UNVERIFIED, not
        // MISSING, and must never erase the provider tracking URL.
        updates.affiliateUrlStatus = 'unverified';
        updates.affiliateHealthStatus = 'not_allowed';
        updates.affiliateLastCheckedAt = new Date().toISOString();
        updates.affiliateUrlVerifiedAt = undefined;
        updates.affiliateUrlHttpStatus = undefined;
        updates.affiliateUrlFinalUrl = undefined;
        updates.affiliateUrlFinalDomain = undefined;
        updates.affiliateUrlHealthReason = (support.reason || 'Affiliate URL provenance is unavailable.').slice(0, 500);
        updates.affiliateUrlErrorCode = 'AFFILIATE_PROVENANCE_REQUIRED';
        updates.affiliateUrlTimedOut = false;
        updates.affiliateLinkErrors = updates.affiliateUrlHealthReason;
        setFieldProvenance(product, updates, 'affiliateUrl', {
          value: product.affiliateUrl,
          provider: product.affiliateUrlProvider,
          endpoint: product.affiliateUrlSourceEndpoint,
          sourceField: product.affiliateUrlSourceField,
          verificationStatus: 'UNVERIFIED',
          verificationReason: updates.affiliateUrlHealthReason,
        });
        failureReasons.push('affiliate:provenance_required');
        sourceReasonCodes.push('AFFILIATE_PROVENANCE_REQUIRED');
      } else if (checkAffiliate) {
        const invalidSourceAffiliate = normalizationIssues.has('INVALID_AFFILIATE_URL')
          || product.fieldProvenance?.affiliateUrl?.verificationStatus === 'INVALID';
        affiliateUrlHealthy = false;
        updates.affiliateHealthStatus = 'error';
        updates.affiliateLastCheckedAt = new Date().toISOString();
        updates.affiliateUrlHealthReason = invalidSourceAffiliate
          ? 'Nhà cung cấp trả tracking URL/deep-link không đúng định dạng.'
          : 'Nhà cung cấp không trả về tracking URL/deep-link.';
        updates.affiliateUrlErrorCode = invalidSourceAffiliate ? 'INVALID_AFFILIATE_URL' : 'MISSING_AFFILIATE_URL';
        updates.affiliateUrlTimedOut = false;
        updates.affiliateUrlVerifiedAt = undefined;
        updates.affiliateUrlStatus = invalidSourceAffiliate ? 'invalid' : 'unavailable';
        updates.affiliateLinkErrors = updates.affiliateUrlHealthReason;
        setFieldProvenance(product, updates, 'affiliateUrl', {
          value: product.fieldProvenance?.affiliateUrl?.value,
          verificationStatus: invalidSourceAffiliate ? 'INVALID' : 'MISSING',
          verificationReason: updates.affiliateUrlHealthReason,
        });
        failureReasons.push(invalidSourceAffiliate ? 'affiliate:invalid' : 'affiliate:missing');
        sourceReasonCodes.push(invalidSourceAffiliate ? 'INVALID_AFFILIATE_URL' : 'MISSING_AFFILIATE_URL');
      } else if (!support.supported) {
        affiliateUrlHealthy = false;
      }

      if (checkImages && product.imageUrl) {
        const rawCandidates = Array.isArray((product as Product & { imageCandidates?: unknown[] }).imageCandidates)
          ? (product as Product & { imageCandidates?: unknown[] }).imageCandidates!.map(value => String(value || ''))
          : [];
        const checkedImages = await resolveImagesWithDomainCircuits([
          product.imageUrl,
          ...rawCandidates,
          ...(product.gallery || []),
        ], Date.now(), execution);
        const imageResult = checkedImages.resolution.result;
        const fallbackUsed = Boolean(checkedImages.resolution.selectedUrl && checkedImages.resolution.selectedUrl !== product.imageUrl);
        updates.imageHealthStatus = (imageResult.ok ? 'ok' : imageResult.status) as Product['imageHealthStatus'];
        updates.imageLastCheckedAt = new Date().toISOString();
        updates.imageValidationState = productImageValidationState(imageResult, fallbackUsed);
        updates.imageContentType = imageResult.contentType;
        updates.imageWidth = imageResult.width;
        updates.imageHeight = imageResult.height;
        updates.imageDimensionsVerified = imageResult.dimensionsVerified;
        updates.imageUrlHttpStatus = imageResult.statusCode;
        updates.imageUrlFinalUrl = imageResult.finalUrl || checkedImages.resolution.selectedUrl || product.imageUrl;
        updates.imageUrlHealthReason = imageResult.reason.slice(0, 500);
        setFieldProvenance(product, updates, 'imageUrl', {
          value: checkedImages.resolution.selectedUrl || product.imageUrl,
          verificationStatus: imageResult.ok ? 'VERIFIED' : imageResult.retryable ? 'UNVERIFIED' : 'INVALID',
          verifiedAt: imageResult.ok ? new Date().toISOString() : undefined,
          verificationReason: imageResult.reason,
        });
        if (fallbackUsed && checkedImages.resolution.selectedUrl) {
          updates.imageUrl = checkedImages.resolution.selectedUrl;
          fallbackImages += 1;
        }
        if (!imageResult.ok) {
          failureReasons.push(`image:${imageResult.status}`);
          if (imageResult.retryable && checkedImages.retryAt) retryTimes.push(checkedImages.retryAt);
        }
        circuitSkipped += checkedImages.circuitSkipped;
        externalRequests += checkedImages.resolution.attempts;
        await assertJobMayContinue(job, execution);
      } else if (checkImages) {
        const invalidSourceImage = normalizationIssues.has('INVALID_IMAGE_URL')
          || product.fieldProvenance?.imageUrl?.verificationStatus === 'INVALID';
        updates.imageHealthStatus = 'error';
        updates.imageLastCheckedAt = new Date().toISOString();
        updates.imageValidationState = 'BROKEN';
        updates.imageUrlHttpStatus = undefined;
        updates.imageUrlFinalUrl = undefined;
        updates.imageUrlHealthReason = invalidSourceImage
          ? 'Nguồn có image URL nhưng định dạng không hợp lệ.'
          : 'Thiếu image URL hợp lệ.';
        setFieldProvenance(product, updates, 'imageUrl', {
          value: product.fieldProvenance?.imageUrl?.value,
          verificationStatus: invalidSourceImage ? 'INVALID' : 'MISSING',
          verificationReason: updates.imageUrlHealthReason,
        });
        failureReasons.push(invalidSourceImage ? 'image:invalid' : 'image:missing');
      }

      const sourceEvidence = mergedCommerceSourceEvidence(product, affiliateCommerceProbe, merchantCommerceProbe);
      if (sourceEvidence) {
        updates.sourceReliabilityVersion = 'commerce-source-v1';
        updates.sourceEvidence = sourceEvidence;
        updates.affiliateGatewayDomain = sourceEvidence.affiliate.affiliateGatewayDomain || product.affiliateGatewayDomain;
        updates.merchantDomain = sourceEvidence.merchant?.merchantDomain || product.merchantDomain;
      }
      const uniqueSourceReasonCodes = [...new Set(sourceReasonCodes)];
      const blockersCheckedAt = new Date().toISOString();
      if (uniqueSourceReasonCodes.length > 0 && !wasPublicSafe) {
        updates.status = product.status === 'archived' ? 'archived' : 'needs_review';
        updates.lifecycleState = 'QUARANTINED';
        updates.lifecycleUpdatedAt = blockersCheckedAt;
        updates.quarantineReasons = [...new Set([
          ...(product.quarantineReasons || []),
          ...uniqueSourceReasonCodes,
        ])];
        updates.publicHidden = true;
        updates.publicBlocked = true;
        updates.publicDecision = 'quarantined';
        updates.publicBlockReason = uniqueSourceReasonCodes.join(',');
        updates.autoPublishEligible = false;
        updates.needsVerification = true;
      }

      const eligibility = evaluateProductEligibility({ ...product, ...updates }, Date.now());
      const blockers = eligibility.criticalBlockers;
      const operationalBlockers = blockers.filter(reason => ![
        'auto_publish_ineligible', 'human_review_required', 'prohibited_product',
      ].includes(reason));
      const healthUnsafe = operationalBlockers.length > 0;
      const publishUnsafe = blockers.length > 0;
      const permanentFailure = ['broken', 'image_broken', 'invalid_image', 'placeholder'].some(status => [
        updates.linkHealthStatus,
        updates.affiliateHealthStatus,
        updates.imageHealthStatus,
      ].includes(status as Product['linkHealthStatus']));
      const retainPublicAfterTransientFailure = shouldRetainPublicAfterTransientHealthCheck({
        wasPublicSafe,
        confirmedBroken: permanentFailure,
        retryScheduled: retryTimes.length > 0,
        operationalBlockers,
        priorFailureCount: Math.max(0, Number(product.consecutiveHealthFailures || 0)),
      });
      const healthReason = blockers.length ? blockers.map(eligibilityBlockerMessage).join(' · ').slice(0, 500) : undefined;

      updates.eligibility = eligibility;
      updates.reviewQuality = eligibility.reviewQuality;
      const reconciledBlockers = preserveFailClosedProductBlockers(product, [...blockers, ...uniqueSourceReasonCodes], blockersCheckedAt);
      updates.currentBlockers = reconciledBlockers.map(blocker => ({
        ...blocker,
        source: isFailClosedProductBlocker(blocker) ? blocker.source : 'PRODUCT_HEALTH_RULES',
        message: isFailClosedProductBlocker(blocker)
          ? blocker.message
          : eligibilityBlockerMessage(blocker.code),
      }));
      const failClosedBlockers = reconciledBlockers.filter(isFailClosedProductBlocker);
      const failClosedCodes = failClosedBlockers.map(blocker => blocker.code);
      updates.blockersCheckedAt = blockersCheckedAt;
      updates.publicBlockReasons = updates.currentBlockers.map(blocker => blocker.code);
      updates.publicBlocked = failClosedCodes.length > 0 || (publishUnsafe && !retainPublicAfterTransientFailure);
      updates.publicBlockReason = failClosedCodes.length > 0 ? failClosedCodes.join(',') : healthReason;
      if (publishUnsafe) {
        if (retainPublicAfterTransientFailure) {
          updates.publicHidden = false;
          updates.needsVerification = false;
          updates.autoPublishEligible = product.autoPublishEligible;
          updates.publicDecision = product.publicDecision;
          updates.unpublishedReason = product.unpublishedReason;
        } else {
          updates.publicHidden = true;
          updates.needsVerification = true;
          updates.autoPublishEligible = false;
          updates.publicDecision = 'blocked';
          updates.unpublishedReason = healthReason;
        }
        if (healthUnsafe && (product.status === 'published' || ['PUBLISHED', 'DEGRADED', 'RECHECKING'].includes(String(product.lifecycleState || '')))) {
          updates.lifecycleState = permanentFailure ? 'CONFIRMED_BROKEN' : 'DEGRADED';
          updates.lifecycleUpdatedAt = new Date().toISOString();
        }
      }

      if (uniqueSourceReasonCodes.length > 0 && !wasPublicSafe) {
        updates.nextAutomaticAction = retryTimes.length > 0
          ? 'VERIFY_PRODUCT_HEALTH'
          : 'RECHECK_QUARANTINED_PRODUCT';
        updates.lastEligibilityDecision = {
          eligible: false,
          reasonCodes: uniqueSourceReasonCodes,
          checkedAt: blockersCheckedAt,
          ruleVersion: 'commerce-source-v1',
          jobId: job.id,
        };
        if (product.lifecycleState !== 'QUARANTINED'
          || uniqueSourceReasonCodes.some(code => !product.quarantineReasons?.includes(code))) {
          sourceReliabilityEvent('product_quarantined_source_unhealthy', {
            provider: String(product.source || product.platform || 'unknown'),
            campaign: product.campaignName,
            domain: updates.merchantDomain || finalDomain(product.canonicalProductUrl || product.originalUrl),
            role: 'MERCHANT',
            reasonCode: uniqueSourceReasonCodes.join(',').slice(0, 160),
            correlationId: product.id,
            operationId: job.operationId,
            jobId: job.id,
          });
        }
      }

      if (failureReasons.length) {
        updates.consecutiveHealthFailures = Math.max(0, Number(product.consecutiveHealthFailures || 0)) + 1;
        updates.sourceHealthReason = failureReasons.join(',').slice(0, 500);
        const retryAt = latestTimestamp(retryTimes);
        if (retryAt) {
          updates.sourceHealthCooldownUntil = retryAt;
          updates.nextRetryAt = retryAt;
          updates.nextAutomaticAction = 'RECHECK_PRODUCT_HEALTH';
          retryScheduled += 1;
        } else if (permanentFailure) {
          updates.nextRetryAt = undefined;
          updates.nextAutomaticAction = 'MANUAL_REVIEW_CONFIRMED_BROKEN';
        }
      } else {
        updates.consecutiveHealthFailures = 0;
        updates.sourceHealthReason = undefined;
        updates.sourceHealthCooldownUntil = undefined;
        updates.nextRetryAt = undefined;
      }

      // A generic reprocess is never an applicable superseding workflow for
      // an operator/manual, unknown, policy, permanent, or external-evidence
      // blocker. Keep the serving state blocked even if this run happens to
      // observe healthy transport for the other fields. Apply this after
      // retry bookkeeping so a protected blocker cannot be downgraded to an
      // automatic retry by a partial observation.
      if (failClosedCodes.length > 0) {
        updates.status = product.status === 'archived' ? 'archived' : 'needs_review';
        updates.publicHidden = true;
        updates.needsVerification = true;
        updates.autoPublishEligible = false;
        updates.autoPublished = false;
        updates.publicDecision = product.status === 'archived' ? 'archived' : 'blocked';
        updates.unpublishedReason = failClosedCodes.join(',');
        updates.nextAutomaticAction = 'WAITING_MANUAL_REVIEW';
        updates.nextRetryAt = undefined;
        updates.quarantineReasons = [...new Set([...(product.quarantineReasons || []), ...failClosedCodes])];
        if (product.status === 'published') {
          updates.lifecycleState = 'QUARANTINED';
          updates.lifecycleUpdatedAt = blockersCheckedAt;
        }
      }

      updates.lastReprocessOperationId = operationId;
      updates.lastReprocessedAt = new Date().toISOString();
      const beforeSignature = operationalHealthSignature(product);
      await assertJobMayContinue(job, execution);
      throwIfExecutionAborted(execution.signal);
      const persisted = await saveCanonicalProduct(product.id, updates, { verifiedHealthUpdate: true });
      if (!persisted) throw new Error(`STORAGE_ERROR: product ${product.id} disappeared before health persistence`);
      await finishReprocessAudit(job, persisted, 'COMPLETED');
      if (operationalHealthSignature(persisted) === beforeSignature) unchanged += 1;
       if (healthUnsafe || failClosedCodes.length > 0) unhealthy += 1;
       else healthy += 1;
       if (persisted.lifecycleState === 'QUARANTINED') quarantined += 1;
      processed += 1;
    } catch (error) {
      if (isJobStop(error)) throw error;
      const latest = await readProductsByIds([product.id], execution.signal).then(items => items[0] || null).catch(() => null);
      await finishReprocessAudit(job, latest || product, 'FAILED', error).catch(() => undefined);
      failed += 1;
      persistenceErrors.push(`${product.id}:${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    }
  }

  if (failed > 0) throw new ProductHealthPersistenceError(resultSnapshot());
  return resultSnapshot();
}

async function capturePrices(job: AutomationJob, execution: ProductIntelligenceExecutionOptions = {}) {
  const products = await selectedProducts(job.payload, execution.signal);
  if (job.dryRun) return { preview: true, inspected: products.length, eligible: products.filter(item => Number(item.price || item.salePrice || 0) > 0).length, businessDataChanged: false };
  let created = 0; let unchanged = 0;
  for (const product of products) {
    await assertJobMayContinue(job, execution);
    const result = await capturePriceSnapshot(product, job.operationId, { forceCheckpoint: job.payload.forceCheckpoint === true });
    if (result.created) {
      created += 1;
      if (result.priceChanged && result.snapshot) {
        await assertJobMayContinue(job, execution);
        throwIfExecutionAborted(execution.signal);
        await saveCanonicalProduct(product.id, { priceLastChangedAt: result.snapshot.capturedAt });
      }
    } else unchanged += 1;
  }
  return { inspected: products.length, created, unchanged, businessDataChanged: created > 0 };
}

async function prepareDrafts(job: AutomationJob, execution: ProductIntelligenceExecutionOptions = {}) {
  const products = await selectedProducts(job.payload, execution.signal);
  if (job.dryRun) return { preview: true, inspected: products.length, localTemplate: true, aiRequests: 0, businessDataChanged: false };
  const goodHealth = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
  let created = 0; let blockedByUrlHealth = 0;
  for (const product of products) {
    await assertJobMayContinue(job, execution);
    if (product.publicBlocked === true
      || !goodHealth.has(String(product.linkHealthStatus || product.productHealthStatus || ''))
      || !goodHealth.has(String(product.affiliateHealthStatus || ''))) {
      blockedByUrlHealth += 1;
      continue;
    }
    throwIfExecutionAborted(execution.signal);
    await createLocalContentDraft(product.id, job.requestedBy);
    created += 1;
  }
  return { inspected: products.length, created, blockedByUrlHealth, provider: 'local', aiRequests: 0, businessDataChanged: created > 0 };
}

async function editorialChecks(job: AutomationJob, execution: ProductIntelligenceExecutionOptions = {}) {
  const requested = stringValue(job.payload.draftId);
  const drafts = requested ? (await listContentDrafts()).filter(item => item.id === requested) : (await listContentDrafts()).slice(0, CONFIG.limits.batchProducts);
  if (job.dryRun) return { preview: true, drafts: drafts.length, businessDataChanged: false };
  const results = [];
  for (const draft of drafts) {
    await assertJobMayContinue(job, execution);
    results.push({ draftId: draft.id, result: await editorialCheckDraft(draft.id) });
  }
  return { checked: results.length, ready: results.filter(item => item.result.status === 'READY').length, blocked: results.filter(item => item.result.status === 'BLOCKED').length, businessDataChanged: results.length > 0 };
}

export async function previewBulkOperation(payload: Record<string, unknown>) {
  const action = stringValue(payload.action, 80);
  const allowed = new Set(['recheck_link', 'recheck_image', 'rescore', 'price_snapshot', 'content_draft', 'assign_category', 'add_tag', 'archive', 'export_csv', 'merge_duplicates']);
  if (!allowed.has(action)) throw new Error('INVALID_BULK_ACTION');
  const ids = productIds(payload); if (!ids.length && action !== 'merge_duplicates') throw new Error('PRODUCT_IDS_REQUIRED');
  const products = await readProductsByIds(ids);
  return {
    action,
    requested: ids.length,
    valid: products.map(item => item.id),
    skipped: ids.filter(id => !products.some(item => item.id === id)),
    expectedImpact: action === 'archive' || action === 'merge_duplicates' ? 'HIGH' : action === 'export_csv' ? 'NONE' : 'MEDIUM',
    estimatedAiUsage: 0,
    requiresApproval: action === 'archive' || action === 'merge_duplicates',
    businessDataChanged: false,
  };
}

async function bulkOperation(job: AutomationJob, execution: ProductIntelligenceExecutionOptions = {}) {
  const preview = await previewBulkOperation(job.payload);
  if (job.dryRun) return { preview: true, ...preview };
  const action = preview.action;
  if (action === 'merge_duplicates') {
    await assertJobMayContinue(job, execution);
    const groupId = stringValue(job.payload.groupId); const primaryId = stringValue(job.payload.primaryId);
    if (!groupId || !primaryId) throw new Error('MERGE_INPUT_REQUIRED');
    return { ...(await applyDuplicateMerge(groupId, primaryId, job.operationId)), businessDataChanged: true };
  }
  const products = await readProductsByIds(preview.valid, execution.signal);
  if (action === 'recheck_link' || action === 'recheck_image') return recheckHealth({
    ...job,
    payload: {
      productIds: preview.valid,
      limit: job.payload.limit,
      healthTarget: action === 'recheck_link' ? 'link' : 'image',
    },
  }, execution);
  if (action === 'rescore') return scoreProducts({ ...job, payload: { productIds: preview.valid } }, execution);
  if (action === 'price_snapshot') return capturePrices({ ...job, payload: { productIds: preview.valid } }, execution);
  if (action === 'content_draft') return prepareDrafts({ ...job, payload: { productIds: preview.valid } }, execution);
  if (action === 'export_csv') {
    const header = 'id,title,platform,category,price,salePrice,qualityScore,opportunityScore,dealScore';
    const rows = products.map(item => [item.id, item.title, item.platform, item.category, item.price, item.salePrice, item.qualityScore, item.opportunityScore, item.dealScore].map(escapeCsvCell).join(','));
    return { exported: products.length, csv: [header, ...rows].join('\n').slice(0, 12_000), businessDataChanged: false };
  }
  let changed = 0;
  for (const product of products) {
    await assertJobMayContinue(job, execution);
    if (action === 'assign_category') {
      const category = stringValue(job.payload.category, 120); if (!category) throw new Error('CATEGORY_REQUIRED');
      throwIfExecutionAborted(execution.signal);
      await saveCanonicalProduct(product.id, { category }); changed += 1;
    } else if (action === 'add_tag') {
      const tag = stringValue(job.payload.tag, 80); if (!tag) throw new Error('TAG_REQUIRED');
      throwIfExecutionAborted(execution.signal);
      await saveCanonicalProduct(product.id, { tags: [...new Set([...(product.tags || []), tag])].slice(0, 50) }); changed += 1;
    } else if (action === 'archive') {
      throwIfExecutionAborted(execution.signal);
      await saveCanonicalProduct(product.id, { status: 'archived', publicHidden: true, archivedReason: 'bulk_archived', autoPublished: false }); changed += 1;
    }
  }
  return { action, changed, businessDataChanged: changed > 0 };
}

export async function executeProductIntelligenceJob(
  job: AutomationJob,
  execution: ProductIntelligenceExecutionOptions = {},
): Promise<Record<string, unknown>> {
  if (!JOB_TYPES.has(job.type)) throw new Error('UNSUPPORTED_PRODUCT_INTELLIGENCE_JOB');
  if (job.type === 'IMPORT_PRODUCTS') {
    const previewId = stringValue(job.payload.previewId);
    if (!previewId) throw new Error('IMPORT_PREVIEW_REQUIRED');
    const batch = await getImportBatch(previewId); if (!batch) throw new Error('IMPORT_PREVIEW_EXPIRED');
    if (job.dryRun) return { preview: true, rows: batch.rows.length, publicSideEffect: false, businessDataChanged: false };
    await assertJobMayContinue(job);
     throwIfExecutionAborted(execution.signal);
     return applyImportBatch(previewId, job.operationId, {
      parentJobId: job.id,
      requestedBy: job.requestedBy,
      approvedSource: job.payload.approvedSource === true && job.payload.ownerConfirmed === true,
    });
  }
  if (job.type === 'RECHECK_PRODUCT_HEALTH') {
    const result = await recheckHealth(job, execution);
    const incidentId = stringValue(job.payload.incidentId);
    if (!incidentId || job.dryRun) return result;
    const before = (await getAlertIncident(incidentId))?.affectedCount || 0;
    throwIfExecutionAborted(execution.signal);
    await evaluateAlerts(job.operationId, Date.now(), execution);
    throwIfExecutionAborted(execution.signal);
    await synchronizeAlertIncidents();
    const checked = await recordServerIncidentRecheck({
      incidentId, checker: 'product-health-remediation', checkerVersion: 'prompt12-v1', affectedCountBefore: before,
      metadata: { jobId: job.id, checked: result.checked, failed: result.failed, healthTarget: result.healthTarget },
    });
    return { ...result, incidentRecheck: { incidentId, status: checked.status, evidenceStatus: checked.evidenceStatus, affectedCount: checked.affectedCount } };
  }
  if (job.type === 'DETECT_DUPLICATES') {
    const products = await selectedProducts(job.payload, execution.signal);
    if (!job.dryRun) await assertJobMayContinue(job, execution);
    const result = await detectDuplicateGroups(products, job.operationId, { dryRun: job.dryRun });
    return { groups: result.groups.length, compared: result.compared, lowConfidencePairs: result.lowConfidencePairs, businessDataChanged: result.changed };
  }
  if (job.type === 'SCORE_PRODUCTS') return scoreProducts(job, execution);
  if (job.type === 'CAPTURE_PRICE_HISTORY') return capturePrices(job, execution);
  if (job.type === 'PREPARE_CONTENT_DRAFT') return prepareDrafts(job, execution);
  if (job.type === 'EDITORIAL_CHECK') return editorialChecks(job, execution);
  if (job.type === 'EVALUATE_ALERTS') {
    if (job.dryRun) return { preview: true, businessDataChanged: false };
    await assertJobMayContinue(job, execution);
    throwIfExecutionAborted(execution.signal);
    const alertResult = await evaluateAlerts(job.operationId, Date.now(), execution);
    throwIfExecutionAborted(execution.signal);
    const incidentResult = await synchronizeAlertIncidents();
    throwIfExecutionAborted(execution.signal);
    return { ...alertResult, incidents: incidentResult, businessDataChanged: true };
  }
  if (job.type === 'AGGREGATE_GROWTH_METRICS') {
    if (job.dryRun) return { preview: true, businessDataChanged: false };
    await assertJobMayContinue(job, execution);
    const result = await aggregateGrowthMetrics();
    throwIfExecutionAborted(execution.signal);
    return { ...result, businessDataChanged: true };
  }
  if (job.type === 'BULK_PRODUCT_OPERATION') return bulkOperation(job, execution);
  throw new Error('UNSUPPORTED_PRODUCT_INTELLIGENCE_JOB');
}
