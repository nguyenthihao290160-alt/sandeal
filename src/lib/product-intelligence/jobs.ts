import type { AutomationJob } from '@/lib/automation/types';
import { getAutomationControl, getAutomationJob } from '@/lib/automation/store';
import type { Product } from '@/lib/types';
import { getAllProducts, getProductById, saveCanonicalProduct } from '@/lib/storage/products';
import { runTransaction } from '@/lib/storage/adapter';
import {
  checkLinkHealth,
  productImageValidationState,
  resolveHealthyImageCandidate,
  type ImageCandidateResolution,
  type LinkCheckResult,
} from '@/lib/bots/productHealthCheck';
import {
  ACCESS_TRADE_AFFILIATE_URL_FIELDS,
  ACCESS_TRADE_CANONICAL_PRODUCT_URL_FIELDS,
  isAccessTradeTrackingUrl,
} from '@/lib/integrations/accesstrade';
import { eligibilityBlockerMessage, evaluateProductEligibility } from '@/lib/productEligibility';
import { getDomainCircuitDecision, recordDomainHealth } from '@/lib/bots/domainCircuitBreaker';
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

async function selectedProducts(payload: Record<string, unknown>): Promise<Product[]> {
  const ids = productIds(payload);
  const products = ids.length ? (await Promise.all(ids.map(getProductById))).filter((item): item is Product => Boolean(item)) : await getAllProducts();
  return selectDeterministicProductBatch(products, payload);
}

async function assertJobMayContinue(job: AutomationJob): Promise<void> {
  const [control, latest] = await Promise.all([getAutomationControl(), getAutomationJob(job.id)]);
  if (control.killSwitch) throw new Error('KILL_SWITCH_ACTIVE');
  if (latest?.status === 'CANCELLED') throw new Error('JOB_CANCELLED');
}

function isJobStop(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'KILL_SWITCH_ACTIVE' || message === 'JOB_CANCELLED';
}

async function scoreProducts(job: AutomationJob) {
  const products = await selectedProducts(job.payload);
  if (job.dryRun) return { preview: true, inspected: products.length, businessDataChanged: false, externalSideEffect: false };
  let updated = 0;
  for (const product of products) {
    await assertJobMayContinue(job);
    const history = await getPriceStatistics(product.id);
    const scores = calculateProductScores(product, history);
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
}

async function checkLinkWithDomainCircuit(url: string, now = Date.now()): Promise<ResilientLinkResult> {
  const decision = await getDomainCircuitDecision(url, now);
  if (!decision.allowed && decision.reason === 'circuit_open') {
    return {
      result: {
        status: 'timeout',
        ok: false,
        retryable: true,
        reason: `Domain circuit open until ${decision.retryAt || 'the next retry window'}`,
      },
      retryAt: decision.retryAt,
      circuitSkipped: true,
    };
  }

  const result = await checkLinkHealth(url);
  const state = await recordDomainHealth(url, result.status, now, { retryAfter: result.retryAfter });
  return {
    result,
    retryAt: result.ok ? undefined : state?.nextRetryAt,
    circuitSkipped: false,
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
): Promise<ResilientImageResult> {
  const urls = [...new Set(candidates.map(value => String(value || '').trim()).filter(Boolean))];
  const allowed: string[] = [];
  const skippedRetryTimes: string[] = [];
  let circuitSkipped = 0;

  for (const url of urls) {
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

  const resolution = await resolveHealthyImageCandidate(allowed);
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

function urlContainsDomain(value: string | undefined, domain: string): boolean {
  try {
    const host = new URL(value || '').hostname.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) return true;
    for (const key of ['url', 'deeplink', 'target', 'destination', 'redirect']) {
      const nested = new URL(value || '').searchParams.get(key);
      if (nested && urlContainsDomain(nested, domain)) return true;
    }
  } catch { /* malformed URLs are handled by the health checker */ }
  return false;
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

async function recheckHealth(job: AutomationJob) {
  const startedAt = Date.now();
  const products = await selectedProducts(job.payload);
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
    const updates: Partial<Product> = {};
    try {
      await assertJobMayContinue(job);
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
      const goodHealth = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
      let affiliateUrlHealthy = !checkAffiliate && goodHealth.has(String(product.affiliateHealthStatus || ''));

      const canonicalUrl = product.canonicalProductUrl || product.originalUrl;
      const canonicalSupport = accessTradeCanonicalSupport(product);
      if (checkLinks && canonicalUrl) {
        const checkedLink = await checkLinkWithDomainCircuit(canonicalUrl);
        const linkResult = checkedLink.result;
        const canonicalDestinationSupported = !isAccessTradeTrackingUrl(linkResult.finalUrl || canonicalUrl);
        const canonicalHealthy = linkResult.ok && canonicalSupport.supported && canonicalDestinationSupported;
        const canonicalReason = canonicalSupport.reason
          || (!canonicalDestinationSupported ? 'Canonical URL resolved to a tracking host.' : linkResult.reason);
        updates.canonicalProductUrl = canonicalUrl;
        updates.originalUrl = canonicalUrl;
        updates.linkHealthStatus = (canonicalHealthy ? linkResult.status : linkResult.ok ? 'unknown' : linkResult.status) as Product['linkHealthStatus'];
        updates.linkLastCheckedAt = new Date().toISOString();
        updates.productUrlHttpStatus = linkResult.statusCode;
        updates.productUrlFinalUrl = linkResult.finalUrl;
        updates.productUrlFinalDomain = finalDomain(linkResult.finalUrl || canonicalUrl);
        updates.productUrlHealthReason = canonicalReason.slice(0, 500);
        updates.productUrlErrorCode = canonicalSupport.supported
          ? canonicalDestinationSupported ? linkResult.errorCode : 'CANONICAL_RESOLVED_TO_TRACKING'
          : 'CANONICAL_PROVENANCE_REQUIRED';
        updates.productUrlTimedOut = linkResult.timedOut === true;
        updates.canonicalUrlVerifiedAt = canonicalHealthy ? new Date().toISOString() : undefined;
        updates.canonicalUrlStatus = canonicalHealthy ? 'verified' : linkResult.retryable ? 'unverified' : 'invalid';
        if (!canonicalHealthy) {
          failureReasons.push(`link:${canonicalSupport.supported ? linkResult.status : 'provenance_required'}`);
          if (linkResult.retryable && checkedLink.retryAt) retryTimes.push(checkedLink.retryAt);
        }
        if (checkedLink.circuitSkipped) circuitSkipped += 1;
        else externalRequests += 1;
        await assertJobMayContinue(job);
      } else if (checkLinks) {
        updates.linkHealthStatus = 'error';
        updates.linkLastCheckedAt = new Date().toISOString();
        updates.productUrlHealthReason = 'Thiếu product URL hợp lệ.';
        updates.productUrlErrorCode = 'MISSING_PRODUCT_URL';
        updates.productUrlTimedOut = false;
        updates.canonicalUrlVerifiedAt = undefined;
        updates.canonicalUrlStatus = 'unavailable';
        failureReasons.push('link:missing');
      }

      const support = accessTradeAffiliateSupport(product);
      if (checkAffiliate && product.affiliateUrl && support.supported) {
        const checkedLink = await checkLinkWithDomainCircuit(product.affiliateUrl);
        const linkResult = checkedLink.result;
        affiliateUrlHealthy = linkResult.ok;
        const affiliateReason = linkResult.reason;
        updates.affiliateHealthStatus = linkResult.status as Product['affiliateHealthStatus'];
        updates.affiliateLastCheckedAt = new Date().toISOString();
        updates.affiliateUrlHttpStatus = linkResult.statusCode;
        updates.affiliateUrlFinalUrl = linkResult.finalUrl;
        updates.affiliateUrlFinalDomain = finalDomain(linkResult.finalUrl || product.affiliateUrl);
        updates.affiliateUrlHealthReason = affiliateReason.slice(0, 500);
        updates.affiliateUrlErrorCode = linkResult.errorCode;
        updates.affiliateUrlTimedOut = linkResult.timedOut === true;
        updates.affiliateUrlVerifiedAt = affiliateUrlHealthy ? new Date().toISOString() : undefined;
        updates.affiliateUrlStatus = affiliateUrlHealthy ? 'verified' : linkResult.retryable ? 'unverified' : 'invalid';
        updates.affiliateLinkErrors = affiliateUrlHealthy ? undefined : affiliateReason.slice(0, 500);
        if (!affiliateUrlHealthy) {
          failureReasons.push(`affiliate:${linkResult.status}`);
          if (linkResult.retryable && checkedLink.retryAt) retryTimes.push(checkedLink.retryAt);
        }
        if (checkedLink.circuitSkipped) circuitSkipped += 1;
        else externalRequests += 1;
        await assertJobMayContinue(job);
      } else if (checkAffiliate && product.affiliateUrl && !support.supported) {
        affiliateUrlHealthy = false;
        updates.quarantinedAffiliateUrl = {
          url: product.affiliateUrl,
          reason: support.reason || 'Affiliate URL provenance is unavailable.',
          quarantinedAt: new Date().toISOString(),
          provider: product.affiliateUrlProvider,
          sourceField: product.affiliateUrlSourceField,
        };
        updates.affiliateUrl = undefined;
        updates.affiliateUrlSource = 'none';
        updates.affiliateUrlProvider = undefined;
        updates.affiliateUrlSourceEndpoint = undefined;
        updates.affiliateUrlSourceField = undefined;
        updates.affiliateUrlStatus = 'unavailable';
        updates.deepLinkSupported = false;
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
        failureReasons.push('affiliate:provenance_required');
      } else if (checkAffiliate) {
        affiliateUrlHealthy = false;
        updates.affiliateHealthStatus = 'error';
        updates.affiliateLastCheckedAt = new Date().toISOString();
        updates.affiliateUrlHealthReason = 'Nhà cung cấp không trả về tracking URL/deep-link.';
        updates.affiliateUrlErrorCode = 'MISSING_AFFILIATE_URL';
        updates.affiliateUrlTimedOut = false;
        updates.affiliateUrlVerifiedAt = undefined;
        updates.affiliateUrlStatus = 'unavailable';
        updates.affiliateLinkErrors = 'Nhà cung cấp không trả về tracking URL/deep-link.';
        failureReasons.push('affiliate:missing');
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
        ]);
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
        await assertJobMayContinue(job);
      } else if (checkImages) {
        updates.imageHealthStatus = 'error';
        updates.imageLastCheckedAt = new Date().toISOString();
        updates.imageValidationState = 'BROKEN';
        updates.imageUrlHttpStatus = undefined;
        updates.imageUrlFinalUrl = undefined;
        updates.imageUrlHealthReason = 'Thiếu image URL hợp lệ.';
        failureReasons.push('image:missing');
      }

      const isThirtyShine = urlContainsDomain(canonicalUrl, '30shinestore.com')
        || urlContainsDomain(product.affiliateUrl, '30shinestore.com');
      const eligibility = evaluateProductEligibility({ ...product, ...updates }, Date.now());
      const blockers = eligibility.criticalBlockers;
      const operationalBlockers = blockers.filter(reason => ![
        'auto_publish_ineligible', 'human_review_required', 'prohibited_product',
      ].includes(reason) && !reason.startsWith('stored:'));
      const healthUnsafe = operationalBlockers.length > 0;
      const publishUnsafe = blockers.length > 0;
      const healthReason = blockers.length ? blockers.map(eligibilityBlockerMessage).join(' · ').slice(0, 500) : undefined;

      updates.eligibility = eligibility;
      updates.reviewQuality = eligibility.reviewQuality;
      updates.publicBlockReasons = blockers;
      updates.publicBlocked = publishUnsafe;
      updates.publicBlockReason = healthReason;
      if (publishUnsafe) {
        updates.publicHidden = true;
        updates.needsVerification = true;
        updates.autoPublishEligible = false;
        updates.publicDecision = isThirtyShine ? 'archived' : 'blocked';
        updates.unpublishedReason = healthReason;
        if (healthUnsafe && !isThirtyShine && (product.status === 'published' || ['PUBLISHED', 'DEGRADED', 'RECHECKING'].includes(String(product.lifecycleState || '')))) {
          const permanentFailure = ['broken', 'image_broken', 'invalid_image', 'placeholder'].some(status => [
            updates.linkHealthStatus,
            updates.affiliateHealthStatus,
            updates.imageHealthStatus,
          ].includes(status as Product['linkHealthStatus']));
          updates.lifecycleState = permanentFailure ? 'CONFIRMED_BROKEN' : 'DEGRADED';
          updates.lifecycleUpdatedAt = new Date().toISOString();
        }
      }

      if (isThirtyShine) {
        updates.status = 'archived';
        updates.lifecycleState = 'QUARANTINED';
        updates.lifecycleUpdatedAt = new Date().toISOString();
        updates.archivedReason = 'merchant_quarantined_30shinestore';
        updates.quarantineReasons = [...new Set([...(product.quarantineReasons || []), 'merchant_quarantined_30shinestore'])];
      }

      if (failureReasons.length) {
        updates.sourceHealthReason = failureReasons.join(',').slice(0, 500);
        const retryAt = latestTimestamp(retryTimes);
        if (retryAt) {
          updates.sourceHealthCooldownUntil = retryAt;
          retryScheduled += 1;
        }
      } else {
        updates.sourceHealthReason = undefined;
        updates.sourceHealthCooldownUntil = undefined;
      }

      updates.lastReprocessOperationId = operationId;
      updates.lastReprocessedAt = new Date().toISOString();
      const beforeSignature = operationalHealthSignature(product);
      const persisted = await saveCanonicalProduct(product.id, updates, { verifiedHealthUpdate: true });
      if (!persisted) throw new Error(`STORAGE_ERROR: product ${product.id} disappeared before health persistence`);
      await finishReprocessAudit(job, persisted, 'COMPLETED');
      if (operationalHealthSignature(persisted) === beforeSignature) unchanged += 1;
      if (healthUnsafe) unhealthy += 1;
      else healthy += 1;
      if (isThirtyShine) quarantined += 1;
      processed += 1;
    } catch (error) {
      if (isJobStop(error)) throw error;
      const latest = await getProductById(product.id).catch(() => null);
      await finishReprocessAudit(job, latest || product, 'FAILED', error).catch(() => undefined);
      failed += 1;
      persistenceErrors.push(`${product.id}:${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    }
  }

  if (failed > 0) throw new ProductHealthPersistenceError(resultSnapshot());
  return resultSnapshot();
}

async function capturePrices(job: AutomationJob) {
  const products = await selectedProducts(job.payload);
  if (job.dryRun) return { preview: true, inspected: products.length, eligible: products.filter(item => Number(item.price || item.salePrice || 0) > 0).length, businessDataChanged: false };
  let created = 0; let unchanged = 0;
  for (const product of products) {
    await assertJobMayContinue(job);
    const result = await capturePriceSnapshot(product, job.operationId, { forceCheckpoint: job.payload.forceCheckpoint === true });
    if (result.created) {
      created += 1;
      if (result.priceChanged && result.snapshot) {
        await assertJobMayContinue(job);
        await saveCanonicalProduct(product.id, { priceLastChangedAt: result.snapshot.capturedAt });
      }
    } else unchanged += 1;
  }
  return { inspected: products.length, created, unchanged, businessDataChanged: created > 0 };
}

async function prepareDrafts(job: AutomationJob) {
  const products = await selectedProducts(job.payload);
  if (job.dryRun) return { preview: true, inspected: products.length, localTemplate: true, aiRequests: 0, businessDataChanged: false };
  const goodHealth = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
  let created = 0; let blockedByUrlHealth = 0;
  for (const product of products) {
    await assertJobMayContinue(job);
    if (product.publicBlocked === true
      || !goodHealth.has(String(product.linkHealthStatus || product.productHealthStatus || ''))
      || !goodHealth.has(String(product.affiliateHealthStatus || ''))) {
      blockedByUrlHealth += 1;
      continue;
    }
    await createLocalContentDraft(product.id, job.requestedBy);
    created += 1;
  }
  return { inspected: products.length, created, blockedByUrlHealth, provider: 'local', aiRequests: 0, businessDataChanged: created > 0 };
}

async function editorialChecks(job: AutomationJob) {
  const requested = stringValue(job.payload.draftId);
  const drafts = requested ? (await listContentDrafts()).filter(item => item.id === requested) : (await listContentDrafts()).slice(0, CONFIG.limits.batchProducts);
  if (job.dryRun) return { preview: true, drafts: drafts.length, businessDataChanged: false };
  const results = [];
  for (const draft of drafts) {
    await assertJobMayContinue(job);
    results.push({ draftId: draft.id, result: await editorialCheckDraft(draft.id) });
  }
  return { checked: results.length, ready: results.filter(item => item.result.status === 'READY').length, blocked: results.filter(item => item.result.status === 'BLOCKED').length, businessDataChanged: results.length > 0 };
}

export async function previewBulkOperation(payload: Record<string, unknown>) {
  const action = stringValue(payload.action, 80);
  const allowed = new Set(['recheck_link', 'recheck_image', 'rescore', 'price_snapshot', 'content_draft', 'assign_category', 'add_tag', 'archive', 'export_csv', 'merge_duplicates']);
  if (!allowed.has(action)) throw new Error('INVALID_BULK_ACTION');
  const ids = productIds(payload); if (!ids.length && action !== 'merge_duplicates') throw new Error('PRODUCT_IDS_REQUIRED');
  const products = (await Promise.all(ids.map(getProductById))).filter((item): item is Product => Boolean(item));
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

async function bulkOperation(job: AutomationJob) {
  const preview = await previewBulkOperation(job.payload);
  if (job.dryRun) return { preview: true, ...preview };
  const action = preview.action;
  if (action === 'merge_duplicates') {
    await assertJobMayContinue(job);
    const groupId = stringValue(job.payload.groupId); const primaryId = stringValue(job.payload.primaryId);
    if (!groupId || !primaryId) throw new Error('MERGE_INPUT_REQUIRED');
    return { ...(await applyDuplicateMerge(groupId, primaryId, job.operationId)), businessDataChanged: true };
  }
  const products = (await Promise.all(preview.valid.map(getProductById))).filter((item): item is Product => Boolean(item));
  if (action === 'recheck_link' || action === 'recheck_image') return recheckHealth({
    ...job,
    payload: {
      productIds: preview.valid,
      limit: job.payload.limit,
      healthTarget: action === 'recheck_link' ? 'link' : 'image',
    },
  });
  if (action === 'rescore') return scoreProducts({ ...job, payload: { productIds: preview.valid } });
  if (action === 'price_snapshot') return capturePrices({ ...job, payload: { productIds: preview.valid } });
  if (action === 'content_draft') return prepareDrafts({ ...job, payload: { productIds: preview.valid } });
  if (action === 'export_csv') {
    const header = 'id,title,platform,category,price,salePrice,qualityScore,opportunityScore,dealScore';
    const rows = products.map(item => [item.id, item.title, item.platform, item.category, item.price, item.salePrice, item.qualityScore, item.opportunityScore, item.dealScore].map(escapeCsvCell).join(','));
    return { exported: products.length, csv: [header, ...rows].join('\n').slice(0, 12_000), businessDataChanged: false };
  }
  let changed = 0;
  for (const product of products) {
    await assertJobMayContinue(job);
    if (action === 'assign_category') {
      const category = stringValue(job.payload.category, 120); if (!category) throw new Error('CATEGORY_REQUIRED');
      await saveCanonicalProduct(product.id, { category }); changed += 1;
    } else if (action === 'add_tag') {
      const tag = stringValue(job.payload.tag, 80); if (!tag) throw new Error('TAG_REQUIRED');
      await saveCanonicalProduct(product.id, { tags: [...new Set([...(product.tags || []), tag])].slice(0, 50) }); changed += 1;
    } else if (action === 'archive') {
      await saveCanonicalProduct(product.id, { status: 'archived', publicHidden: true, archivedReason: 'bulk_archived', autoPublished: false }); changed += 1;
    }
  }
  return { action, changed, businessDataChanged: changed > 0 };
}

export async function executeProductIntelligenceJob(job: AutomationJob): Promise<Record<string, unknown>> {
  if (!JOB_TYPES.has(job.type)) throw new Error('UNSUPPORTED_PRODUCT_INTELLIGENCE_JOB');
  if (job.type === 'IMPORT_PRODUCTS') {
    const previewId = stringValue(job.payload.previewId);
    if (!previewId) throw new Error('IMPORT_PREVIEW_REQUIRED');
    const batch = await getImportBatch(previewId); if (!batch) throw new Error('IMPORT_PREVIEW_EXPIRED');
    if (job.dryRun) return { preview: true, rows: batch.rows.length, publicSideEffect: false, businessDataChanged: false };
    await assertJobMayContinue(job);
    return applyImportBatch(previewId, job.operationId, {
      parentJobId: job.id,
      requestedBy: job.requestedBy,
      approvedSource: job.payload.approvedSource === true && job.payload.ownerConfirmed === true,
    });
  }
  if (job.type === 'RECHECK_PRODUCT_HEALTH') {
    const result = await recheckHealth(job);
    const incidentId = stringValue(job.payload.incidentId);
    if (!incidentId || job.dryRun) return result;
    const before = (await getAlertIncident(incidentId))?.affectedCount || 0;
    await evaluateAlerts(job.operationId);
    await synchronizeAlertIncidents();
    const checked = await recordServerIncidentRecheck({
      incidentId, checker: 'product-health-remediation', checkerVersion: 'prompt12-v1', affectedCountBefore: before,
      metadata: { jobId: job.id, checked: result.checked, failed: result.failed, healthTarget: result.healthTarget },
    });
    return { ...result, incidentRecheck: { incidentId, status: checked.status, evidenceStatus: checked.evidenceStatus, affectedCount: checked.affectedCount } };
  }
  if (job.type === 'DETECT_DUPLICATES') {
    const products = await selectedProducts(job.payload);
    if (!job.dryRun) await assertJobMayContinue(job);
    const result = await detectDuplicateGroups(products, job.operationId, { dryRun: job.dryRun });
    return { groups: result.groups.length, compared: result.compared, lowConfidencePairs: result.lowConfidencePairs, businessDataChanged: result.changed };
  }
  if (job.type === 'SCORE_PRODUCTS') return scoreProducts(job);
  if (job.type === 'CAPTURE_PRICE_HISTORY') return capturePrices(job);
  if (job.type === 'PREPARE_CONTENT_DRAFT') return prepareDrafts(job);
  if (job.type === 'EDITORIAL_CHECK') return editorialChecks(job);
  if (job.type === 'EVALUATE_ALERTS') {
    if (job.dryRun) return { preview: true, businessDataChanged: false };
    await assertJobMayContinue(job);
    const alertResult = await evaluateAlerts(job.operationId);
    const incidentResult = await synchronizeAlertIncidents();
    return { ...alertResult, incidents: incidentResult, businessDataChanged: true };
  }
  if (job.type === 'AGGREGATE_GROWTH_METRICS') {
    if (job.dryRun) return { preview: true, businessDataChanged: false };
    await assertJobMayContinue(job);
    return { ...(await aggregateGrowthMetrics()), businessDataChanged: true };
  }
  if (job.type === 'BULK_PRODUCT_OPERATION') return bulkOperation(job);
  throw new Error('UNSUPPORTED_PRODUCT_INTELLIGENCE_JOB');
}
