import { createHash, randomUUID } from 'crypto';
import { AccessTradeRequestError, mapAccessTradeToProduct, type AccessTradeResultType, type NormalizedAccessTradeItem } from '../integrations/accesstrade';
import { getAutomationSettings } from '../storage/automationSettings';
import { claimCandidateBatch, claimCandidateForDurableJob, enqueueCandidate, finishCandidate, getCandidateById, getQueueStats, listCandidateQueue, type CandidatePayload, type CandidateQueueItem, type CandidateQueueStatus } from '../storage/candidateQueue';
import { getAllProducts, publicationIdempotencyKey, saveCanonicalProduct, upsertCanonicalProduct } from '../storage/products';
import { readCollection, runTransaction, writeCollection } from '../storage/adapter';
import { createAutomationJob, getAutomationControl } from '../automation/store';
import { completeJournalEffect } from '../automation/operationJournal';
import { checkImageHealth, checkLinkHealth, productImageValidationState, type ImageCheckResult } from './productHealthCheck';
import type { Product, ProductLifecycleState, ProductOffer, ReviewContent } from '../types';
import { generateEditorialReview, isReviewIndexable, shouldRegenerateReview, textSimilarity, validateReviewClaims } from '../editorialReview';
import { generateGeminiEditorialReview } from '../ai/geminiEditorialProvider';
import { listAvailableGeminiModels } from '../ai/geminiCredentialRouter';
import { scoreCandidateReadiness } from './candidateReadiness';
import { isDomainCircuitOpen, recordDomainHealth } from './domainCircuitBreaker';
import { evaluateSafePublish } from '../safePublish';
import { classifyRecord } from '../autonomous/recordClassification';
import { calculateProductConfidences } from '../autonomous/confidenceEngine';
import { captureProductEvidence, validateClaimsAgainstEvidence, type EvidenceFact } from '../autonomous/evidenceGraph';
import { buildOffer, deriveProductIdentity, identityMatchConfidence, mergeOffers, selectBestPublicOffer } from '../autonomous/productIdentityGraph';
import { evaluatePriceTruth, offerPriceObservations, priceTruthProductPatch } from '../autonomous/priceTruthEngine';
import { persistLifecycleTransition } from '../autonomous/lifecycleStore';
import { readinessSnapshotHash } from '../autonomous/publishPolicy';
import { createDefaultSourceAdapterRegistry, type SourceAdapterRegistry, type SourceProviderStatus } from '../autonomous/sourceAdapterPlatform';
import { applySourceQualityPriority, getSourceQualitySnapshot, recordSourceQualityObservation } from '../autonomous/sourceQuality';
import { vietnamDayKey } from '../automation/timezone';
import {
  commitProductProcessingCapacity,
  getDailyBusinessUsage,
  recordPipelineUsageMetrics,
  reserveProductProcessingCapacity,
  type DailyBusinessUsage,
} from '../automation/businessUsage';

const KEYWORD_COLLECTION = 'source-keyword-state';
const RUNTIME_COLLECTION = 'pipeline-runtime';

export type OperationMode = 'bootstrap' | 'steady';
export interface PipelineCounters {
  sourceRequests: number; found: number; queued: number; reviewed: number;
  created: number; updated: number; unchanged: number; duplicate: number;
  skippedCooldown: number; published: number; needsReview: number; failed: number;
  discarded: number; networkChecks: number; queueSize: number;
  reviewQueued: number; reviewGenerated: number; reviewApproved: number; reviewNeedsReview: number;
  reviewRejected: number; reviewStale: number; claimValidationFailed: number;
  duplicateContentSkipped: number; seoReady: number; seoBlocked: number;
  indexable: number; noindex: number; sitemapIncluded: number;
}

export interface KeywordYieldStat {
  keyword: string;
  requests: number;
  found: number;
  normalized: number;
  fastRejected: number;
  valid: number;
  duplicate: number;
  quarantined: number;
  ready: number;
  published: number;
  noResult: number;
  timeout: number;
  rateLimited: number;
  costPerValidCandidate: number | null;
  cursor: number;
  lastUsedAt?: string;
  nextEligibleAt?: string;
  outcomeKeys?: string[];
}
interface RuntimeState { id: string; currentConcurrency: number; rateLimitUntil?: string; timeoutStreak: number; updatedAt: string; }
export type DailyPipelineUsage = DailyBusinessUsage;

export interface SourceRunMetrics {
  normalized: number;
  rejected: number;
  timeout: number;
  rateLimited: number;
  durationMs: number;
  sourceStatus: SourceProviderStatus;
  reason: string;
  nextEligibleAt?: string;
}

export interface SourceScanOptions {
  registry?: SourceAdapterRegistry;
  runId?: string;
}

export function selectOperationMode(publicProductCount: number): OperationMode {
  return publicProductCount < 100 ? 'bootstrap' : 'steady';
}

function emptyCounters(): PipelineCounters {
  return { sourceRequests: 0, found: 0, queued: 0, reviewed: 0, created: 0, updated: 0, unchanged: 0, duplicate: 0, skippedCooldown: 0, published: 0, needsReview: 0, failed: 0, discarded: 0, networkChecks: 0, queueSize: 0,
    reviewQueued: 0, reviewGenerated: 0, reviewApproved: 0, reviewNeedsReview: 0, reviewRejected: 0, reviewStale: 0,
    claimValidationFailed: 0, duplicateContentSkipped: 0, seoReady: 0, seoBlocked: 0, indexable: 0, noindex: 0, sitemapIncluded: 0 };
}

function todayInVietnam(): string { return vietnamDayKey(); }
export async function getDailyPipelineUsage(now = Date.now()): Promise<DailyPipelineUsage> {
  return getDailyBusinessUsage(now);
}
async function recordDailyUsage(counters: PipelineCounters): Promise<void> {
  await recordPipelineUsageMetrics({
    sourceRequests: counters.sourceRequests,
    candidatesFound: counters.found,
    candidatesQueued: counters.queued,
    networkChecks: counters.networkChecks,
    productsPublished: counters.published,
  });
}

function hashPayload(payload: CandidatePayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validHttpUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol); } catch { return false; }
}

function merchantFromUrl(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'unknown'; }
}

const activeDomainChecks = new Map<string, number>();
const domainWaiters = new Map<string, Array<() => void>>();

async function withDomainConcurrency<T>(value: string, work: () => Promise<T>, limit = 2): Promise<T> {
  const domain = merchantFromUrl(value);
  if ((activeDomainChecks.get(domain) || 0) >= limit) {
    await new Promise<void>(resolve => {
      const waiters = domainWaiters.get(domain) || [];
      waiters.push(resolve);
      domainWaiters.set(domain, waiters);
    });
  }
  activeDomainChecks.set(domain, (activeDomainChecks.get(domain) || 0) + 1);
  try {
    return await work();
  } finally {
    activeDomainChecks.set(domain, Math.max(0, (activeDomainChecks.get(domain) || 1) - 1));
    const next = domainWaiters.get(domain)?.shift();
    if (next) next();
    if (!domainWaiters.get(domain)?.length) domainWaiters.delete(domain);
  }
}

function isLoopbackSmokeUrl(value: string): boolean {
  if (process.env.NODE_ENV !== 'test' || !process.env.SANDEAL_MOCK_SOURCE_URL) return false;
  try { return ['127.0.0.1', 'localhost', '::1'].includes(new URL(value).hostname); }
  catch { return false; }
}

function checkCandidateLink(url: string) {
  if (isLoopbackSmokeUrl(url)) return Promise.resolve({ status: 'ok' as const, ok: true, reason: 'loopback_smoke_fixture', statusCode: 200, finalUrl: url });
  return withDomainConcurrency(url, () => checkLinkHealth(url));
}
function checkCandidateImage(url: string): Promise<ImageCheckResult> {
  if (isLoopbackSmokeUrl(url)) return Promise.resolve({ status: 'ok' as const, ok: true, reason: 'loopback_smoke_fixture', statusCode: 200, contentType: 'image/png' });
  return withDomainConcurrency(url, () => checkImageHealth(url));
}

function toPayload(item: NormalizedAccessTradeItem): CandidatePayload {
  return {
    title: item.name, description: item.description || undefined, kind: item.kind,
    platform: item.platform, originalUrl: item.canonicalProductUrl || item.originalUrl,
    affiliateUrl: item.affiliateUrl, imageUrl: item.imageUrl,
    imageCandidates: item.imageCandidates.filter(Boolean).slice(0, 6),
    price: item.price || undefined, salePrice: item.salePrice || undefined,
    currency: 'VND', category: item.category || undefined,
    rawSourceKind: item.rawSourceKind, nonProductReason: item.nonProductReason,
    campaignName: item.campaignName, commissionRate: item.commissionRate,
    merchant: merchantFromUrl(item.canonicalProductUrl || item.originalUrl || item.affiliateUrl),
    verifiedSource: item.verifiedSource, autoPublishEligible: item.autoPublishEligible,
    sourceQualityScore: item.qualityScore,
  };
}

export function fastReject(payload: CandidatePayload): string | null {
  if (payload.kind !== 'product') return 'not_product';
  if (payload.title.trim().length < 8) return 'missing_title';
  if (!(Number(payload.salePrice || payload.price) > 0)) return 'missing_price';
  if (!validHttpUrl(payload.originalUrl)) return 'missing_product_url';
  if (!validHttpUrl(payload.affiliateUrl)) return 'missing_affiliate_url';
  if (!validHttpUrl(payload.imageUrl)) return 'missing_image';
  return null;
}

function normalizeKeywordStat(keyword: string, cursor: number, stored?: Partial<KeywordYieldStat> & { empty?: number }): KeywordYieldStat {
  const numeric = (key: keyof KeywordYieldStat) => Math.max(0, Number(stored?.[key]) || 0);
  const valid = numeric('valid');
  const requests = numeric('requests');
  return {
    keyword, cursor,
    requests,
    found: numeric('found'),
    normalized: numeric('normalized'),
    fastRejected: numeric('fastRejected'),
    valid,
    duplicate: numeric('duplicate'),
    quarantined: numeric('quarantined'),
    ready: numeric('ready'),
    published: numeric('published'),
    noResult: Math.max(numeric('noResult'), Number(stored?.empty) || 0),
    timeout: numeric('timeout'),
    rateLimited: numeric('rateLimited'),
    costPerValidCandidate: valid > 0 ? Number((requests / valid).toFixed(4)) : null,
    lastUsedAt: stored?.lastUsedAt,
    nextEligibleAt: stored?.nextEligibleAt,
    outcomeKeys: Array.isArray(stored?.outcomeKeys) ? stored.outcomeKeys.filter(item => typeof item === 'string').slice(-1_000) : [],
  };
}

async function loadKeywordStats(keywords: string[]): Promise<KeywordYieldStat[]> {
  const stored = await readCollection<Partial<KeywordYieldStat> & { keyword: string; empty?: number }>(KEYWORD_COLLECTION);
  return keywords.map((keyword, cursor) => normalizeKeywordStat(keyword, cursor, stored.find(item => item.keyword === keyword)));
}

function keywordFamily(keyword: string): string {
  const value = keyword.toLowerCase();
  if (/điện thoại|laptop|bàn phím|chuột|tai nghe|sạc/.test(value)) return 'technology';
  if (/gia dụng|nồi chiên|hút bụi|lọc không khí/.test(value)) return 'home';
  if (/làm đẹp|skincare|serum|chống nắng/.test(value)) return 'beauty';
  if (/mẹ|bé|tã|bỉm/.test(value)) return 'family';
  if (/thời trang|đồng hồ|giày/.test(value)) return 'fashion';
  return value.split(/\s+/)[0] || 'other';
}

function keywordYieldScore(item: KeywordYieldStat): number {
  const validRate = item.normalized ? item.valid / item.normalized : 0;
  const readyRate = item.valid ? item.ready / item.valid : 0;
  const thinRate = item.found ? item.fastRejected / item.found : 0;
  const zeroPenalty = Math.min(1, item.noResult / Math.max(1, item.requests));
  const costPenalty = item.costPerValidCandidate === null ? 0.5 : Math.min(1, item.costPerValidCandidate / 5);
  return validRate * 40 + readyRate * 40 + Math.min(10, item.published * 0.5) - thinRate * 20 - zeroPenalty * 20 - costPenalty * 10;
}

export function selectSourceKeywords(stats: KeywordYieldStat[], count: number, now = Date.now()): KeywordYieldStat[] {
  const eligible = stats.filter(item => !item.nextEligibleAt || Date.parse(item.nextEligibleAt) <= now);
  const neverUsed = eligible.filter(item => !item.lastUsedAt).sort((a, b) => a.cursor - b.cursor);
  const ranked = [...eligible].sort((a, b) => keywordYieldScore(b) - keywordYieldScore(a)
    || Date.parse(a.lastUsedAt || '1970-01-01') - Date.parse(b.lastUsedAt || '1970-01-01'));
  const explorationCount = Math.min(neverUsed.length, Math.max(1, Math.ceil(count * 0.25)));
  const candidates = [...neverUsed.slice(0, explorationCount), ...ranked];
  const selected: KeywordYieldStat[] = [];
  const families = new Map<string, number>();
  for (const item of candidates) {
    if (selected.some(existing => existing.keyword === item.keyword)) continue;
    const family = keywordFamily(item.keyword);
    const familyCount = families.get(family) || 0;
    const hasUnusedFamily = candidates.some(candidate => !selected.some(existing => existing.keyword === candidate.keyword)
      && (families.get(keywordFamily(candidate.keyword)) || 0) < familyCount);
    if (hasUnusedFamily && familyCount > 0) continue;
    selected.push(item);
    families.set(family, familyCount + 1);
    if (selected.length >= count) break;
  }
  return selected;
}

export async function getKeywordYieldReport(limit = 5): Promise<{ top: KeywordYieldStat[]; poor: KeywordYieldStat[]; total: number }> {
  const settings = await getAutomationSettings();
  const stats = await loadKeywordStats(settings.sourceKeywords);
  const used = stats.filter(item => item.requests > 0 || item.lastUsedAt);
  const top = [...used].sort((a, b) => keywordYieldScore(b) - keywordYieldScore(a)).slice(0, limit);
  const poor = [...used].sort((a, b) => keywordYieldScore(a) - keywordYieldScore(b)).slice(0, limit);
  return { top, poor, total: stats.length };
}

async function recordKeywordCandidateOutcome(item: CandidateQueueItem, product?: Product): Promise<void> {
  if (!item.keyword || !product) return;
  const outcome = product.status === 'published' && product.publicHidden === false
    ? 'published'
    : product.lifecycleState === 'READY_FOR_PUBLISH'
      ? 'ready'
      : product.lifecycleState === 'QUARANTINED'
        ? 'quarantined'
        : null;
  if (!outcome) return;
  const key = `${item.id}:${item.sourceHash}:${outcome}`.slice(0, 240);
  await runTransaction<KeywordYieldStat>(KEYWORD_COLLECTION, stored => {
    const index = stored.findIndex(stat => stat.keyword === item.keyword);
    const stat = normalizeKeywordStat(item.keyword!, index >= 0 ? stored[index].cursor : stored.length, index >= 0 ? stored[index] : undefined);
    if (stat.outcomeKeys?.includes(key)) return undefined;
    stat[outcome] += 1;
    stat.outcomeKeys = [...(stat.outcomeKeys || []), key].slice(-1_000);
    if (index >= 0) stored[index] = stat; else stored.push(stat);
    return stored;
  });
}

export async function scanSourcesToQueue(
  mode: OperationMode,
  deadlineMs = Date.now() + 240_000,
  options: SourceScanOptions = {},
): Promise<PipelineCounters & SourceRunMetrics & { resultTypes: Partial<Record<AccessTradeResultType, number>>; retryAfter?: string }> {
  const startedMs = Date.now();
  const counters = emptyCounters();
  const resultTypes: Partial<Record<AccessTradeResultType, number>> = {};
  let retryAfter: string | undefined;
  let normalized = 0;
  let rejected = 0;
  let validCandidates = 0;
  let pricesAvailable = 0;
  let timeout = 0;
  let rateLimited = 0;
  let sourceStatus: SourceProviderStatus = 'not_configured';
  const settings = await getAutomationSettings();
  const usage = await getDailyPipelineUsage();
  const sourceBudgetRemaining = Math.max(0, settings.sourceRequestBudgetPerDay - usage.sourceRequests);
  const registry = options.registry || createDefaultSourceAdapterRegistry();
  const adapter = registry.get<NormalizedAccessTradeItem, NormalizedAccessTradeItem>('accesstrade');
  if (!adapter) {
    return { ...counters, normalized, rejected, timeout, rateLimited, durationMs: Date.now() - startedMs, sourceStatus: 'adapter_unavailable', reason: 'source_adapter_unavailable', resultTypes };
  }
  const sourceHealth = await adapter.healthCheck();
  sourceStatus = sourceHealth.status;
  if (!(await adapter.isConfigured())) {
    return { ...counters, normalized, rejected, timeout, rateLimited, durationMs: Date.now() - startedMs, sourceStatus, reason: 'source_not_configured', resultTypes };
  }
  if (sourceBudgetRemaining <= 0) {
    const nextEligibleAt = new Date(startedMs + 24 * 60 * 60_000).toISOString();
    return { ...counters, normalized, rejected, timeout, rateLimited, durationMs: Date.now() - startedMs, sourceStatus, reason: 'source_budget_exhausted', nextEligibleAt, resultTypes };
  }
  const keywordCount = mode === 'bootstrap' ? settings.bootstrapKeywordCount : settings.steadyKeywordCount;
  const candidateLimit = mode === 'bootstrap' ? settings.bootstrapCandidateLimit : settings.steadyCandidateLimit;
  const stats = await loadKeywordStats(settings.sourceKeywords);
  const selected = selectSourceKeywords(stats, keywordCount, startedMs);
  if (!selected.length) {
    const nextEligibleAt = stats.map(item => item.nextEligibleAt).filter((item): item is string => Boolean(item)).sort()[0];
    return { ...counters, normalized, rejected, timeout, rateLimited, durationMs: Date.now() - startedMs, sourceStatus, reason: 'source_keywords_exhausted', nextEligibleAt, resultTypes };
  }
  const products = await getAllProducts();
  const queuedCandidates = await listCandidateQueue();
  const merchantCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  for (const merchant of [
    ...products.map(product => merchantFromUrl(product.originalUrl || product.affiliateUrl || '')),
    ...queuedCandidates.map(candidate => candidate.payload.merchant || merchantFromUrl(candidate.payload.originalUrl)),
  ]) merchantCounts.set(merchant, (merchantCounts.get(merchant) || 0) + 1);
  for (const category of [
    ...products.map(product => String(product.category || 'uncategorized').toLowerCase()),
    ...queuedCandidates.map(candidate => String(candidate.payload.category || 'uncategorized').toLowerCase()),
  ]) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  const qualitySnapshot = await getSourceQualitySnapshot(adapter.id);
  let timeoutStreak = 0;

  for (const stat of selected) {
    if (Date.now() >= deadlineMs || counters.found >= candidateLimit || counters.sourceRequests >= sourceBudgetRemaining) break;
    stat.lastUsedAt = new Date().toISOString();
    try {
      const result = await adapter.discover({ keyword: stat.keyword, limit: Math.min(50, candidateLimit - counters.found) });
      counters.sourceRequests += result.requests;
      stat.requests += result.requests;
      retryAfter = result.retryAfter || retryAfter;
      for (const [outcome, count] of Object.entries(result.outcomes || {})) {
        if (outcome in resultTypes || ['success_with_results', 'success_empty', 'unauthorized', 'forbidden', 'rate_limited', 'circuit_open', 'timeout', 'network_error', 'upstream_error', 'invalid_response'].includes(outcome)) {
          const typedOutcome = outcome as AccessTradeResultType;
          resultTypes[typedOutcome] = (resultTypes[typedOutcome] || 0) + count;
        }
        if (outcome === 'timeout') { timeout += count; stat.timeout += count; }
        if (outcome === 'rate_limited') { rateLimited += count; stat.rateLimited += count; }
      }
      timeoutStreak = 0;
      stat.found += result.items.length;
      if (!result.items.length) stat.noResult += 1;
      stat.nextEligibleAt = new Date(startedMs + (result.items.length ? settings.intervalHours * 60 * 60_000 : Math.min(48, 3 * 2 ** Math.min(4, stat.noResult)) * 60 * 60_000)).toISOString();
      counters.found += result.items.length;
      for (const sourceItem of result.items) {
        const item = adapter.normalize(sourceItem);
        normalized++;
        stat.normalized += 1;
        const payload = toPayload(item);
        const earlyReason = fastReject(payload);
        if (!earlyReason) { stat.valid++; validCandidates++; } else { rejected++; stat.fastRejected += 1; }
        if (Number(payload.salePrice || payload.price || 0) > 0) pricesAvailable++;
        const sourceHash = hashPayload(payload);
        const existing = products.find((product) =>
          (product.source === adapter.id && (product.sourceId === item.id || product.externalId === item.id)) ||
          product.originalUrl === payload.originalUrl || product.affiliateUrl === payload.affiliateUrl,
        );
        if (existing?.sourceHash === sourceHash) { counters.duplicate++; counters.unchanged++; stat.duplicate += 1; continue; }
        if (existing?.sourceHealthCooldownUntil && Date.parse(existing.sourceHealthCooldownUntil) > Date.now()) { counters.skippedCooldown++; continue; }
        const complete = [payload.title, payload.price || payload.salePrice, payload.originalUrl, payload.affiliateUrl, payload.imageUrl].filter(Boolean).length;
        const merchant = payload.merchant || 'unknown';
        const category = String(payload.category || 'uncategorized').toLowerCase();
        const merchantPenalty = Math.min(40, (merchantCounts.get(merchant) || 0) * 4);
        const categoryBoost = Math.max(0, 12 - Math.min(12, categoryCounts.get(category) || 0));
        const basePriority = Math.max(1, complete * 20 + (payload.verifiedSource ? 20 : 0) + Math.min(19, stat.published * 2 + stat.valid) + categoryBoost - merchantPenalty - (earlyReason ? 25 : 0));
        const priority = applySourceQualityPriority(basePriority, qualitySnapshot).effectivePriority;
        const readiness = scoreCandidateReadiness(payload);
        const queued = await enqueueCandidate({ source: adapter.id as CandidateQueueItem['source'], sourceId: item.id, priority, readinessScore: readiness.score, lane: readiness.lane, contentHash: sourceHash, sourceHash, keyword: stat.keyword, payload });
        if (queued.queued) {
          counters.queued++; counters.reviewQueued++;
          merchantCounts.set(merchant, (merchantCounts.get(merchant) || 0) + 1);
          categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
        } else { counters.duplicate++; counters.unchanged++; stat.duplicate += 1; }
      }
      stat.costPerValidCandidate = stat.valid > 0 ? Number((stat.requests / stat.valid).toFixed(4)) : null;
    } catch (error) {
      if (error instanceof AccessTradeRequestError) {
        const requestCount = error.requests.reduce((total, request) => total + (request.attempts ?? 1), 0);
        counters.sourceRequests += requestCount;
        stat.requests += requestCount;
        retryAfter = error.requests.map((request) => request.retryAfter).filter((value): value is string => Boolean(value)).sort().at(-1) || retryAfter;
        resultTypes[error.resultType] = (resultTypes[error.resultType] || 0) + 1;
        if (error.resultType === 'timeout') { timeoutStreak++; timeout++; stat.timeout += 1; } else timeoutStreak = 0;
        if (error.resultType === 'rate_limited') { rateLimited++; stat.rateLimited += 1; }
        stat.nextEligibleAt = retryAfter || new Date(startedMs + (error.resultType === 'rate_limited' ? 60 : 30) * 60_000).toISOString();
        if (['unauthorized', 'forbidden', 'rate_limited', 'circuit_open'].includes(error.resultType) || timeoutStreak >= 2) break;
      } else {
        counters.failed++;
        const classified = adapter.classifyError(error);
        sourceStatus = classified;
        retryAfter = adapter.retryAfter(error) || retryAfter;
        if (classified === 'rate_limited') { rateLimited++; stat.rateLimited += 1; }
        if (classified === 'degraded' && /timeout|abort/i.test(error instanceof Error ? `${error.name}:${error.message}` : String(error))) { timeout++; stat.timeout += 1; }
        stat.nextEligibleAt = retryAfter || new Date(startedMs + 30 * 60_000).toISOString();
        if (['invalid_credential', 'quota_exhausted', 'rate_limited', 'circuit_open'].includes(classified)) break;
      }
      stat.costPerValidCandidate = stat.valid > 0 ? Number((stat.requests / stat.valid).toFixed(4)) : null;
    }
  }
  await writeCollection(KEYWORD_COLLECTION, stats);
  counters.queueSize = (await getQueueStats()).total;
  await recordDailyUsage(counters);
  await recordSourceQualityObservation(adapter.id, {
    idempotencyKey: (options.runId || `source-scan:${startedMs}:${process.pid}:${randomUUID()}`).slice(0, 200),
    observedAt: new Date(startedMs).toISOString(),
    candidatesObserved: normalized,
    validCandidates,
    pricesChecked: normalized,
    pricesAvailable,
    timeouts: Math.min(timeout, counters.sourceRequests),
    externalRequests: counters.sourceRequests,
  });
  const durationMs = Date.now() - startedMs;
  const reason = rateLimited > 0 ? 'source_rate_limited'
    : timeout > 0 && counters.found === 0 ? 'source_timeout'
    : counters.failed > 0 ? 'source_partial_failure'
    : counters.found === 0 ? 'source_no_results'
    : 'source_scan_completed';
  const nextEligibleAt = retryAfter || (counters.found === 0 ? new Date(startedMs + 15 * 60_000).toISOString() : undefined);
  return { ...counters, normalized, rejected, timeout, rateLimited, durationMs, sourceStatus, reason, nextEligibleAt, resultTypes, retryAfter };
}

function cooldownFor(statuses: string[], attempts = 1): number {
  if (statuses.includes('rate_limited')) return 60 * 60_000;
  if (statuses.some((status) => ['timeout', 'server_error', 'dns_error', 'error'].includes(status))) return Math.min(48 * 60 * 60_000, 60 * 60_000 * 2 ** Math.min(5, attempts));
  if (statuses.some((status) => ['broken', 'image_broken'].includes(status))) return 24 * 60 * 60_000;
  return 4 * 60 * 60_000;
}

interface CandidateReviewOutcome { status: CandidateQueueStatus; terminal: boolean; nextRetryAt?: string; reason?: string; productId?: string }

async function recordCandidateHealthQuality(input: {
  item: CandidateQueueItem;
  productHealthy: boolean;
  affiliateHealthy: boolean;
  imageHealthy: boolean;
  imageChecks: number;
  statuses: string[];
  externalRequests: number;
}): Promise<void> {
  await recordSourceQualityObservation(input.item.source, {
    idempotencyKey: `candidate-health:${input.item.id}:attempt:${input.item.attempts}`.slice(0, 200),
    observedAt: input.item.processingStartedAt || input.item.updatedAt,
    linksChecked: 2,
    healthyLinks: Number(input.productHealthy) + Number(input.affiliateHealthy),
    imagesChecked: input.imageChecks,
    healthyImages: input.imageHealthy ? 1 : 0,
    timeouts: input.externalRequests > 0 ? input.statuses.filter(status => status === 'timeout').length : 0,
    externalRequests: input.externalRequests,
  });
}

export class CandidateRetryScheduledError extends Error {
  constructor(public readonly nextRetryAt: string, public readonly candidateStatus: CandidateQueueStatus, reason?: string) {
    super(`TEMPORARY_ERROR:CANDIDATE_${candidateStatus.toUpperCase()}:${reason || 'retry_scheduled'}`);
    this.name = 'CandidateRetryScheduledError';
  }
}

function attachObservedPriceEvidence(product: Product, offers: ProductOffer[], observedOfferId: string, facts: EvidenceFact[]): ProductOffer[] {
  const currentFact = facts.find(fact => fact.field === (Number(product.salePrice || 0) > 0 ? 'salePrice' : 'price'));
  const originalFact = Number(product.salePrice || 0) > 0 && Number(product.price || 0) > Number(product.salePrice || 0)
    ? facts.find(fact => fact.field === 'price')
    : undefined;
  return offers.map(offer => offer.id === observedOfferId ? {
    ...offer,
    priceEvidenceFactIds: currentFact ? [currentFact.id] : [],
    originalPriceEvidenceFactIds: originalFact ? [originalFact.id] : [],
  } : offer);
}

function kindForRecordType(recordType: Product['recordType']): Product['kind'] {
  if (recordType === 'VOUCHER') return 'voucher';
  if (recordType === 'CAMPAIGN') return 'campaign';
  if (recordType === 'STORE_OFFER' || recordType === 'STORE_PROMOTION') return 'store_offer';
  return recordType === 'PRODUCT' ? 'product' : 'unknown';
}

async function transitionCandidateLifecycle(
  product: Product,
  to: ProductLifecycleState,
  item: CandidateQueueItem,
  workerId: string,
  phase: string,
  reasonCodes: string[] = [],
): Promise<Product> {
  if (product.lifecycleState === to) return product;
  if (!item.durableJobId) throw new Error('CANDIDATE_DURABLE_JOB_REQUIRED');
  const result = await persistLifecycleTransition({
    productId: product.id,
    to,
    actor: { type: 'worker', id: workerId, jobId: item.durableJobId, jobType: 'PROCESS_CANDIDATE' },
    transitionKey: `${item.durableJobId}:${item.sourceHash}:${phase}`.slice(0, 200),
    operationId: `candidate-lifecycle:${item.id}:${item.sourceHash}`.slice(0, 160),
    reasonCodes,
  });
  return result.product;
}

function linkReviewClaimsToEvidence(productId: string, review: ReviewContent, facts: EvidenceFact[]): {
  review: ReviewContent;
  validation: ReturnType<typeof validateClaimsAgainstEvidence>;
} {
  const factIds = new Set(facts.map(fact => fact.id));
  const keyFacts = new Map(review.keyFacts.map(fact => [fact.id, fact]));
  const evidenceForClaim = (ids: string[]): string[] => [...new Set(ids.flatMap(id => {
    if (factIds.has(id)) return [id];
    const keyFact = keyFacts.get(id);
    const fields = keyFact?.sourceField.split(',').map(field => field.trim()).filter(Boolean) || [id];
    return facts.filter(fact => fields.includes(fact.field)).map(fact => fact.id);
  }))];
  const remap = (claims: ReviewContent['factualClaims']) => claims.map(claim => ({ ...claim, evidenceFactIds: evidenceForClaim(claim.evidenceFactIds || []) }));
  const factualClaims = remap(review.factualClaims);
  const inferredClaims = remap(review.inferredClaims);
  const evidenceByClaim = new Map([...factualClaims, ...inferredClaims].map(claim => [claim.id, claim.evidenceFactIds]));
  const remapShared = (claims: ReviewContent['strengths']) => claims.map(claim => ({ ...claim, evidenceFactIds: evidenceByClaim.get(claim.id) || evidenceForClaim(claim.evidenceFactIds || []) }));
  const linked: ReviewContent = {
    ...review,
    factualClaims,
    inferredClaims,
    strengths: remapShared(review.strengths),
    limitations: remapShared(review.limitations),
  };
  const claims = [...factualClaims, ...inferredClaims].map(claim => ({ id: claim.id, evidenceFactIds: claim.evidenceFactIds }));
  return { review: linked, validation: validateClaimsAgainstEvidence(productId, claims, facts) };
}

function candidateRisk(payload: CandidatePayload): Product['riskLevel'] {
  const text = `${payload.title} ${payload.category || ''} ${payload.description || ''}`;
  if (/(?:thuốc kê đơn|nicotine|vũ khí|chất cấm|cờ bạc|hàng giả|chữa bệnh|điều trị|giảm cân)/i.test(text)) return 'high';
  return payload.verifiedSource ? 'low' : 'unknown';
}

async function reviewAutonomousCandidate(item: CandidateQueueItem, counters: PipelineCounters, workerId: string): Promise<CandidateReviewOutcome> {
  const { payload } = item;
  const now = new Date().toISOString();
  const classification = classifyRecord({
    ...payload,
    sourceItemKind: payload.kind,
    rawSourceKind: payload.rawSourceKind,
    sourceId: item.sourceId,
  });
  const allBefore = await getAllProducts();
  const existingForSource = allBefore.find(product => product.source === item.source && (product.sourceId === item.sourceId || product.externalId === item.sourceId));
  const classifiedKind = kindForRecordType(classification.recordType);
  const mapped = mapAccessTradeToProduct({
    id: item.sourceId,
    name: payload.title,
    description: payload.description || '',
    kind: classifiedKind,
    sourceItemKind: classifiedKind,
    platform: payload.platform,
    imageUrl: payload.imageUrl,
    imageCandidates: payload.imageCandidates || [payload.imageUrl],
    originalUrl: payload.originalUrl,
    canonicalProductUrl: payload.originalUrl,
    affiliateUrl: payload.affiliateUrl,
    price: payload.price || 0,
    salePrice: payload.salePrice || 0,
    category: payload.category || '',
    campaignName: payload.campaignName,
    commissionRate: payload.commissionRate,
    rawSourceKind: payload.rawSourceKind || String(payload.kind || 'unknown'),
    nonProductReason: payload.nonProductReason,
    needsVerification: true,
    verifiedSource: payload.verifiedSource,
    publicHidden: true,
    autoPublishEligible: false,
    publicDecision: 'needs_review',
    publicBlockReason: 'autonomous_assessment_pending',
    qualityScore: payload.sourceQualityScore || 0,
  });
  const initialDraft: Partial<Product> = {
    ...mapped,
    sourceId: item.sourceId,
    sourceHash: item.sourceHash,
    contentHash: item.contentHash,
    kind: classifiedKind,
    recordType: classification.recordType,
    classification: { ...classification, classifiedAt: now },
    lifecycleState: existingForSource?.lifecycleState || 'DISCOVERED',
    lifecycleVersion: existingForSource?.lifecycleVersion,
    brand: payload.brand,
    sku: payload.sku,
    gtin: payload.gtin,
    mpn: payload.mpn || payload.model,
    specifications: payload.specifications,
    priceObservedAt: Number(payload.salePrice || payload.price || 0) > 0 ? now : undefined,
    lastSeenAt: now,
    riskLevel: candidateRisk(payload),
    duplicateStatus: existingForSource?.duplicateStatus || 'UNRESOLVED',
    claimValidationStatus: 'MISSING_EVIDENCE',
    autoPublishEligible: false,
    status: 'needs_review',
    publicHidden: true,
    needsVerification: true,
    autoPublished: false,
  };
  initialDraft.identity = deriveProductIdentity(initialDraft);
  const canonical = await upsertCanonicalProduct(initialDraft, { evaluate: false });
  let product = canonical.product;

  if (product.lifecycleState === 'DISCOVERED') product = await transitionCandidateLifecycle(product, 'STAGED', item, workerId, 'staged');

  const incompleteProduct = classification.recordType === 'PRODUCT' && classification.action !== 'ACCEPT';
  if (classification.recordType !== 'PRODUCT' || incompleteProduct) {
    const reasons = classification.recordType !== 'PRODUCT'
      ? [`record_type_${String(classification.recordType).toLowerCase()}`, ...classification.reasons]
      : ['classification_cross_check_failed', ...classification.reasons];
    if (product.lifecycleState === 'STAGED' || product.lifecycleState === 'DISCOVERED') {
      product = await transitionCandidateLifecycle(product, 'QUARANTINED', item, workerId, 'classification-quarantine', reasons);
    }
    const confidences = calculateProductConfidences(product, { classificationConfidence: classification.confidence, evidenceCoverage: 0, now: Date.parse(now) });
    product = (await saveCanonicalProduct(product.id, {
      recordType: classification.recordType,
      classification: { ...classification, classifiedAt: now },
      confidences,
      quarantineReasons: [...new Set([...(product.quarantineReasons || []), ...reasons])],
      nextAutomaticAction: 'RECHECK_QUARANTINED_PRODUCT',
      claimValidationStatus: 'MISSING_EVIDENCE',
      duplicateStatus: 'UNRESOLVED',
      publicHidden: true,
      publicDecision: 'quarantined',
      publicBlockReasons: reasons,
      needsVerification: true,
      autoPublishEligible: false,
    })) || product;
    const evidence = await captureProductEvidence(product, now);
    await saveCanonicalProduct(product.id, {
      evidenceFactIds: evidence.facts.map(fact => fact.id),
      evidenceCoverage: evidence.coverage,
      evidenceSnapshotAt: evidence.snapshot.createdAt,
      evidenceSnapshotHash: evidence.snapshot.snapshotHash,
    });
    counters.reviewed += 1;
    counters.needsReview += 1;
    counters.noindex += 1;
    if (canonical.created) counters.created += 1; else counters.updated += 1;
    const status: CandidateQueueStatus = classification.recordType === 'UNKNOWN' || incompleteProduct ? 'needs_review' : 'discarded';
    await finishCandidate(item.id, { status, delayReason: reasons.join(',') });
    return { status, terminal: true, reason: reasons.join(','), productId: product.id };
  }

  if (product.lifecycleState === 'STAGED') product = await transitionCandidateLifecycle(product, 'CLASSIFIED', item, workerId, 'classified');
  if (product.lifecycleState === 'CLASSIFIED') product = await transitionCandidateLifecycle(product, 'NORMALIZED', item, workerId, 'normalized');

  const otherProducts = (await getAllProducts()).filter(other => other.id !== product.id);
  const identity = deriveProductIdentity({ ...product, ...initialDraft });
  const closestIdentity = otherProducts
    .map(other => ({ product: other, confidence: identityMatchConfidence(identity, other.identity || deriveProductIdentity(other)) }))
    .sort((left, right) => right.confidence - left.confidence)[0];
  const strongDuplicate = closestIdentity && closestIdentity.confidence >= 0.95 ? closestIdentity : undefined;
  if (closestIdentity && closestIdentity.confidence >= 0.55 && closestIdentity.confidence < 0.95) {
    const reasons = ['duplicate_identity_unresolved', `identity_confidence_${closestIdentity.confidence.toFixed(2)}`];
    product = (await saveCanonicalProduct(product.id, { identity, duplicateStatus: 'UNRESOLVED', duplicateConfidence: closestIdentity.confidence })) || product;
    if (['NORMALIZED', 'VERIFYING'].includes(String(product.lifecycleState))) {
      product = await transitionCandidateLifecycle(product, 'QUARANTINED', item, workerId, 'duplicate-quarantine', reasons);
    }
    await saveCanonicalProduct(product.id, { quarantineReasons: reasons, nextAutomaticAction: 'RECHECK_DUPLICATE', publicBlockReasons: reasons, publicHidden: true });
    await finishCandidate(item.id, { status: 'needs_review', delayReason: reasons.join(',') });
    counters.reviewed += 1;
    counters.needsReview += 1;
    counters.noindex += 1;
    if (canonical.created) counters.created += 1; else counters.updated += 1;
    return { status: 'needs_review', terminal: true, reason: reasons.join(','), productId: product.id };
  }
  product = (await saveCanonicalProduct(product.id, {
    identity,
    duplicateStatus: strongDuplicate ? 'MERGED' : 'CLEAR',
    duplicateConfidence: closestIdentity?.confidence || 0,
    duplicateGroupId: strongDuplicate?.product.id,
  })) || product;

  if (product.lifecycleState === 'RETRY_SCHEDULED' || product.lifecycleState === 'QUARANTINED' || product.lifecycleState === 'READY_FOR_PUBLISH') {
    product = await transitionCandidateLifecycle(product, 'VERIFYING', item, workerId, `verification-resume-${item.attempts}`);
  } else if (product.lifecycleState === 'NORMALIZED') {
    product = await transitionCandidateLifecycle(product, 'VERIFYING', item, workerId, 'verifying');
  }

  if (await isDomainCircuitOpen(payload.originalUrl) || await isDomainCircuitOpen(payload.affiliateUrl) || await isDomainCircuitOpen(payload.imageUrl)) {
    const nextRetryAt = new Date(Date.now() + 30 * 60_000).toISOString();
    if (product.lifecycleState === 'VERIFYING') product = await transitionCandidateLifecycle(product, 'RETRY_SCHEDULED', item, workerId, `domain-retry-${item.attempts}`, ['domain_circuit_open']);
    await saveCanonicalProduct(product.id, { sourceHealthCooldownUntil: nextRetryAt, sourceHealthReason: 'domain_circuit_open', nextRetryAt, nextAutomaticAction: 'VERIFY_PRODUCT_HEALTH' });
    await finishCandidate(item.id, { status: 'delayed', delayReason: 'domain_circuit_open', nextAttemptAt: nextRetryAt });
    return { status: 'delayed', terminal: false, nextRetryAt, reason: 'domain_circuit_open', productId: product.id };
  }

  const fixture = process.env.NODE_ENV === 'test' ? payload.isolatedHealthFixture : undefined;
  const fixtureLink = fixture === 'healthy'
    ? { status: 'ok' as const, ok: true, reason: 'isolated_fixture' }
    : fixture === 'confirmed_broken'
      ? { status: 'broken' as const, ok: false, reason: 'isolated_fixture', retryable: false }
      : { status: 'timeout' as const, ok: false, reason: 'isolated_fixture', retryable: true };
  const fixtureImage: ImageCheckResult = fixture === 'healthy'
    ? { status: 'ok' as const, ok: true, reason: 'isolated_fixture', contentType: 'image/jpeg' }
    : fixture === 'confirmed_broken'
      ? { status: 'image_broken' as const, ok: false, reason: 'isolated_fixture', retryable: false }
      : { status: 'timeout' as const, ok: false, reason: 'isolated_fixture', retryable: true };
  const productHealth = fixture ? fixtureLink : await checkCandidateLink(payload.originalUrl); counters.networkChecks += 1;
  const affiliateHealth = fixture ? fixtureLink : await checkCandidateLink(payload.affiliateUrl); counters.networkChecks += 1;
  let imageUrl = payload.imageUrl;
  const primaryImageUrl = imageUrl;
  let imageHealth = fixture ? fixtureImage : await checkCandidateImage(imageUrl); counters.networkChecks += 1;
  let imageChecks = 1;
  if (!imageHealth.ok) {
    for (const candidate of payload.imageCandidates || []) {
      if (candidate === imageUrl) continue;
      const fallback = fixture ? fixtureImage : await checkCandidateImage(candidate); counters.networkChecks += 1;
      imageChecks += 1;
      if (fallback.ok) { imageUrl = candidate; imageHealth = fallback; break; }
    }
  }
  const statuses = [productHealth.status, affiliateHealth.status, imageHealth.status];
  await recordCandidateHealthQuality({
    item,
    productHealthy: productHealth.ok,
    affiliateHealthy: affiliateHealth.ok,
    imageHealthy: imageHealth.ok,
    imageChecks,
    statuses,
    externalRequests: fixture ? 0 : 2 + imageChecks,
  });
  await recordDomainHealth(payload.originalUrl, productHealth.status);
  await recordDomainHealth(payload.affiliateUrl, affiliateHealth.status);
  await recordDomainHealth(imageUrl, imageHealth.status);
  const healthy = productHealth.ok && affiliateHealth.ok && imageHealth.ok;
  const confirmedBroken = statuses.some(status => ['broken', 'image_broken', 'invalid_image', 'not_found', 'too_small', 'too_large', 'dark_image_suspected', 'placeholder'].includes(status));
  const healthPatch: Partial<Product> = {
    imageUrl,
    linkHealthStatus: productHealth.status === 'ok' ? 'ok' : productHealth.status,
    productHealthStatus: productHealth.status,
    affiliateHealthStatus: affiliateHealth.status,
    imageHealthStatus: imageHealth.status === 'ok' ? 'ok' : imageHealth.status,
    imageValidationState: productImageValidationState(imageHealth, imageHealth.ok && imageUrl !== primaryImageUrl),
    imageWidth: imageHealth.width,
    imageHeight: imageHealth.height,
    imageDimensionsVerified: imageHealth.dimensionsVerified,
    linkLastCheckedAt: now,
    affiliateLastCheckedAt: now,
    imageLastCheckedAt: now,
    imageContentType: imageHealth.contentType,
    sourceHealthCooldownUntil: healthy ? undefined : new Date(Date.now() + cooldownFor(statuses, item.attempts)).toISOString(),
    sourceHealthReason: healthy ? undefined : statuses.join(','),
    publicBlockReason: healthy ? '' : statuses.join(','),
  };
  product = (await saveCanonicalProduct(product.id, healthPatch)) || product;
  if (!healthy) {
    const retryExhausted = item.attempts >= 6;
    const reasons = [confirmedBroken ? 'confirmed_broken' : retryExhausted ? 'retry_budget_exhausted' : 'health_check_temporary_failure', ...statuses];
    if (product.lifecycleState === 'VERIFYING') {
      product = await transitionCandidateLifecycle(product, confirmedBroken || retryExhausted ? 'QUARANTINED' : 'RETRY_SCHEDULED', item, workerId, `${confirmedBroken || retryExhausted ? 'health-quarantine' : 'health-retry'}-${item.attempts}`, reasons);
    }
    const nextRetryAt = confirmedBroken || retryExhausted ? undefined : product.sourceHealthCooldownUntil;
    await saveCanonicalProduct(product.id, { quarantineReasons: confirmedBroken || retryExhausted ? reasons : product.quarantineReasons, nextRetryAt, nextAutomaticAction: confirmedBroken || retryExhausted ? 'RECHECK_QUARANTINED_PRODUCT' : 'VERIFY_PRODUCT_HEALTH', publicHidden: true });
    const status: CandidateQueueStatus = confirmedBroken ? 'discarded' : retryExhausted ? 'needs_review' : 'delayed';
    await finishCandidate(item.id, { status, delayReason: reasons.join(','), nextAttemptAt: nextRetryAt });
    return { status, terminal: status !== 'delayed', nextRetryAt, reason: reasons.join(','), productId: product.id };
  }

  const observedOffer = buildOffer(product, now);
  if (strongDuplicate) {
    const mergedSelection = selectBestPublicOffer(mergeOffers(strongDuplicate.product.offers, [observedOffer]), Date.parse(now));
    const mergedPriceTruth = evaluatePriceTruth(strongDuplicate.product, offerPriceObservations(mergedSelection.offers), Date.parse(now));
    const mergedTarget = (await saveCanonicalProduct(strongDuplicate.product.id, {
      offers: mergedSelection.offers,
      bestOfferId: mergedSelection.bestOffer?.id,
      ...priceTruthProductPatch(mergedPriceTruth),
      nextAutomaticAction: strongDuplicate.product.nextAutomaticAction || 'MONITOR_OFFERS',
    })) || strongDuplicate.product;
    if (product.lifecycleState === 'VERIFYING') {
      product = await transitionCandidateLifecycle(product, 'QUARANTINED', item, workerId, 'identity-merged', ['strong_identity_merged_into_canonical']);
    }
    await saveCanonicalProduct(product.id, {
      duplicateStatus: 'MERGED',
      duplicateGroupId: mergedTarget.id,
      publicHidden: true,
      publicBlockReasons: ['merged_duplicate_entity'],
      quarantineReasons: ['merged_duplicate_entity'],
      nextAutomaticAction: 'USE_CANONICAL_PRODUCT',
    });
    await finishCandidate(item.id, { status: 'completed', delayReason: 'strong_identity_merged_into_canonical' });
    counters.reviewed += 1;
    counters.updated += 1;
    return { status: 'completed', terminal: true, reason: 'strong_identity_merged_into_canonical', productId: mergedTarget.id };
  }
  let selectedOffer = selectBestPublicOffer(mergeOffers(product.offers, [observedOffer]), Date.parse(now));
  product = (await saveCanonicalProduct(product.id, {
    offers: selectedOffer.offers,
    bestOfferId: selectedOffer.bestOffer?.id,
    duplicateStatus: 'CLEAR',
    lastHealthyAt: now,
  })) || product;
  const evidence = await captureProductEvidence(product, now);
  selectedOffer = selectBestPublicOffer(
    attachObservedPriceEvidence(product, selectedOffer.offers, observedOffer.id, evidence.facts),
    Date.parse(now),
  );
  const priceTruth = evaluatePriceTruth(product, offerPriceObservations(selectedOffer.offers), Date.parse(now));
  product = (await saveCanonicalProduct(product.id, {
    evidenceFactIds: evidence.facts.map(fact => fact.id),
    evidenceCoverage: evidence.coverage,
    evidenceSnapshotAt: evidence.snapshot.createdAt,
    evidenceSnapshotHash: evidence.snapshot.snapshotHash,
    offers: selectedOffer.offers,
    bestOfferId: selectedOffer.bestOffer?.id,
    ...priceTruthProductPatch(priceTruth),
  })) || product;
  if (product.lifecycleState === 'VERIFYING') product = await transitionCandidateLifecycle(product, 'CONTENT_PREPARING', item, workerId, 'content-preparing');

  const comparisonProducts = (await getAllProducts()).filter(other => other.id !== product.id);
  const localReview = generateEditorialReview(product, comparisonProducts);
  const factCount = localReview.keyFacts.length;
  const profile = { taskType: 'editorial_review' as const, riskLevel: product.riskLevel === 'high' ? 'high' as const : product.riskLevel === 'medium' ? 'medium' as const : 'low' as const, complexityScore: Math.max(31, Math.min(75, 30 + factCount * 5)), factCount, inputTokenEstimate: Math.ceil(JSON.stringify(product).length / 4), candidateLane: item.lane || 'NORMAL_LANE', priority: item.priority, previousFailures: Math.max(0, item.attempts - 1), requiredQuality: 80 };
  const gemini = await generateGeminiEditorialReview(product, profile, await listAvailableGeminiModels(), () => localReview);
  const generatedValidation = gemini ? validateReviewClaims(gemini.review, product) : null;
  const duplicateGenerated = gemini ? comparisonProducts.some(other => other.reviewContent && textSimilarity(`${gemini.review.reviewTitle} ${gemini.review.reviewSummary} ${gemini.review.reviewVerdict}`, `${other.reviewContent.reviewTitle} ${other.reviewContent.reviewSummary} ${other.reviewContent.reviewVerdict}`) >= 0.8) : false;
  const useGemini = Boolean(gemini && generatedValidation?.valid && !duplicateGenerated);
  const linked = linkReviewClaimsToEvidence(product.id, useGemini ? gemini!.review : localReview, evidence.facts);
  const review = linked.review;
  counters.reviewGenerated += 1;
  if (review.reviewStatus === 'approved') counters.reviewApproved += 1; else if (review.reviewStatus === 'rejected') counters.reviewRejected += 1; else counters.reviewNeedsReview += 1;
  if (review.reviewBlockReasons.includes('claim_validation_failed') || review.reviewBlockReasons.includes('unsafe_claim') || !linked.validation.valid) counters.claimValidationFailed += 1;
  if (review.reviewBlockReasons.includes('low_originality')) counters.duplicateContentSkipped += 1;
  const withReview = (await saveCanonicalProduct(product.id, {
    reviewContent: review,
    reviewGeneration: useGemini ? {
      provider: 'gemini', modelId: gemini!.modelId, promptVersion: gemini!.promptVersion,
      generationFingerprint: gemini!.generationFingerprint, responseHash: gemini!.responseHash,
      generatedAt: gemini!.generatedAt, validationResult: 'approved',
    } : {
      provider: 'local', promptVersion: 'local-review-v2', generationFingerprint: product.sourceHash || product.id,
      generatedAt: now, validationResult: 'fallback_local',
    },
    claimValidationStatus: linked.validation.status,
  })) || product;
  const confidences = calculateProductConfidences(withReview, { classificationConfidence: classification.confidence, evidenceCoverage: evidence.coverage, now: Date.parse(now) });
  const readinessReasons: string[] = [];
  if (!isReviewIndexable(withReview)) readinessReasons.push('review_not_indexable');
  if (!linked.validation.valid) readinessReasons.push('claim_evidence_unverified');
  if (confidences.publish < 0.85) readinessReasons.push('publish_confidence_low');
  if (withReview.duplicateStatus !== 'CLEAR') readinessReasons.push('duplicate_unresolved');
  if (withReview.riskLevel !== 'low') readinessReasons.push('risk_not_low');
  if (!withReview.verifiedSource) readinessReasons.push('source_not_verified');
  if (evidence.coverage < 0.8) readinessReasons.push('evidence_coverage_low');
  if (!selectedOffer.bestOffer) readinessReasons.push('healthy_offer_missing');
  if (!['FRESH', 'AGING'].includes(priceTruth.state)) readinessReasons.push('price_truth_unsafe');
  const ready = readinessReasons.length === 0;
  product = (await saveCanonicalProduct(product.id, {
    confidences,
    claimValidationStatus: linked.validation.status,
    autoPublishEligible: ready,
    needsVerification: !ready,
    publicHidden: true,
    publicDecision: ready ? 'ready_for_publish' : 'quarantined',
    publicBlockReasons: readinessReasons,
    quarantineReasons: ready ? [] : readinessReasons,
    nextAutomaticAction: ready ? 'AUTO_SAFE_PUBLISH' : 'RECHECK_QUARANTINED_PRODUCT',
    nextRetryAt: ready ? undefined : new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
  })) || withReview;
  product = await transitionCandidateLifecycle(product, ready ? 'READY_FOR_PUBLISH' : 'QUARANTINED', item, workerId, ready ? 'ready-for-publish' : 'readiness-quarantine', readinessReasons);
  if (ready) counters.seoReady += 1; else { counters.seoBlocked += 1; counters.needsReview += 1; counters.noindex += 1; }

  const publishSettings = await getAutomationSettings();
  const control = await getAutomationControl();
  if (ready && publishSettings.safePublish && ['CANARY', 'AUTONOMOUS'].includes(control.effectiveMode)) {
    const snapshotHash = readinessSnapshotHash(product);
    const child = await createAutomationJob({
      type: 'AUTO_SAFE_PUBLISH',
      payload: { productId: product.id, candidateId: item.id, readinessSnapshotHash: snapshotHash },
      idempotencyKey: `auto-safe-publish:${product.id}:${snapshotHash}`.slice(0, 160),
      operationId: `pipeline:${item.id}:${snapshotHash}`.slice(0, 160),
      requestedBy: 'autopilot-worker',
      parentJobId: item.durableJobId,
      dryRun: false,
    });
    product = (await saveCanonicalProduct(product.id, { relatedJobId: child.job.id, nextAutomaticAction: 'AUTO_SAFE_PUBLISH' })) || product;
  }
  counters.reviewed += 1;
  if (canonical.created) counters.created += 1; else if (canonical.unchanged) counters.unchanged += 1; else counters.updated += 1;
  await finishCandidate(item.id, { status: 'completed', delayReason: ready ? undefined : readinessReasons.join(',') });
  return { status: 'completed', terminal: true, reason: ready ? undefined : readinessReasons.join(','), productId: product.id };
}

async function reviewOne(item: CandidateQueueItem, counters: PipelineCounters): Promise<CandidateReviewOutcome> {
  const { payload } = item;
  try {
    if (await isDomainCircuitOpen(payload.originalUrl) || await isDomainCircuitOpen(payload.affiliateUrl) || await isDomainCircuitOpen(payload.imageUrl)) {
      const nextRetryAt = new Date(Date.now() + 30 * 60_000).toISOString();
      await finishCandidate(item.id, { status: 'delayed', delayReason: 'domain_circuit_open', nextAttemptAt: nextRetryAt });
      return { status: 'delayed', terminal: false, nextRetryAt, reason: 'domain_circuit_open' };
    }
    const fixture = process.env.NODE_ENV === 'test' ? payload.isolatedHealthFixture : undefined;
    const fixtureLink = fixture === 'healthy'
      ? { status: 'ok' as const, ok: true, reason: 'isolated_fixture' }
      : fixture === 'confirmed_broken'
        ? { status: 'broken' as const, ok: false, reason: 'isolated_fixture', retryable: false }
        : { status: 'timeout' as const, ok: false, reason: 'isolated_fixture', retryable: true };
    const fixtureImage = fixture === 'healthy'
      ? { status: 'ok' as const, ok: true, reason: 'isolated_fixture', contentType: 'image/jpeg' }
      : fixture === 'confirmed_broken'
        ? { status: 'image_broken' as const, ok: false, reason: 'isolated_fixture', retryable: false }
        : { status: 'timeout' as const, ok: false, reason: 'isolated_fixture', retryable: true };
    const productHealth = fixture ? fixtureLink : await checkCandidateLink(payload.originalUrl); counters.networkChecks++;
    const affiliateHealth = fixture ? fixtureLink : await checkCandidateLink(payload.affiliateUrl); counters.networkChecks++;
    let imageUrl = payload.imageUrl;
    let imageHealth = fixture ? fixtureImage : await checkCandidateImage(imageUrl); counters.networkChecks++;
    let imageChecks = 1;
    if (!imageHealth.ok) {
      for (const candidate of payload.imageCandidates || []) {
        if (candidate === imageUrl) continue;
        const fallback = fixture ? fixtureImage : await checkCandidateImage(candidate); counters.networkChecks++;
        imageChecks += 1;
        if (fallback.ok) { imageUrl = candidate; imageHealth = fallback; break; }
      }
    }
    const statuses = [productHealth.status, affiliateHealth.status, imageHealth.status];
    await recordCandidateHealthQuality({
      item,
      productHealthy: productHealth.ok,
      affiliateHealthy: affiliateHealth.ok,
      imageHealthy: imageHealth.ok,
      imageChecks,
      statuses,
      externalRequests: fixture ? 0 : 2 + imageChecks,
    });
    await recordDomainHealth(payload.originalUrl, productHealth.status); await recordDomainHealth(payload.affiliateUrl, affiliateHealth.status); await recordDomainHealth(imageUrl, imageHealth.status);
    const healthy = productHealth.ok && affiliateHealth.ok && imageHealth.ok;
    const now = new Date().toISOString();
    const mapped = mapAccessTradeToProduct({
      id: item.sourceId, name: payload.title, description: payload.description || '', kind: payload.kind,
      sourceItemKind: payload.kind, platform: payload.platform, imageUrl, imageCandidates: payload.imageCandidates || [imageUrl],
      originalUrl: payload.originalUrl, canonicalProductUrl: payload.originalUrl, affiliateUrl: payload.affiliateUrl,
      price: payload.price || 0, salePrice: payload.salePrice || 0, category: payload.category || '', rawSourceKind: 'product_feed',
      needsVerification: !payload.autoPublishEligible, verifiedSource: payload.verifiedSource, publicHidden: true,
      autoPublishEligible: payload.autoPublishEligible, publicDecision: payload.autoPublishEligible ? 'public_candidate' : 'needs_review',
      publicBlockReason: payload.autoPublishEligible ? '' : 'source_not_eligible', qualityScore: payload.sourceQualityScore || 0,
    });
    const draft = {
      ...mapped, sourceId: item.sourceId, sourceHash: item.sourceHash, contentHash: item.contentHash,
      imageUrl, linkHealthStatus: productHealth.status === 'ok' ? 'ok' : productHealth.status,
      productHealthStatus: productHealth.status, affiliateHealthStatus: affiliateHealth.status,
      imageHealthStatus: imageHealth.status === 'ok' ? 'ok' : imageHealth.status,
      linkLastCheckedAt: now, affiliateLastCheckedAt: now, imageLastCheckedAt: now,
      imageContentType: imageHealth.contentType,
      sourceHealthCooldownUntil: healthy ? undefined : new Date(Date.now() + cooldownFor(statuses, item.attempts)).toISOString(),
      sourceHealthReason: healthy ? undefined : statuses.join(','),
      publicBlockReason: healthy ? '' : statuses.join(','),
      status: 'needs_review', publicHidden: true, needsVerification: true, autoPublished: false,
    } as Partial<Product>;
    const canonical = await upsertCanonicalProduct(draft, { evaluate: false });
    if (canonical.product.reviewContent?.reviewStatus === 'stale') counters.reviewStale++;
    let finalProduct = canonical.product;
    if (shouldRegenerateReview(canonical.product)) {
      const otherProducts = (await getAllProducts()).filter((product) => product.id !== canonical.product.id);
      const localReview = generateEditorialReview(canonical.product, otherProducts);
      const factCount = localReview.keyFacts.length;
      const profile = { taskType: 'editorial_review' as const, riskLevel: canonical.product.riskLevel === 'high' ? 'high' as const : canonical.product.riskLevel === 'medium' ? 'medium' as const : 'low' as const, complexityScore: Math.max(31, Math.min(75, 30 + factCount * 5)), factCount, inputTokenEstimate: Math.ceil(JSON.stringify(canonical.product).length / 4), candidateLane: item.lane || 'NORMAL_LANE', priority: item.priority, previousFailures: Math.max(0, item.attempts - 1), requiredQuality: 80 };
      const gemini = await generateGeminiEditorialReview(canonical.product, profile, await listAvailableGeminiModels(), () => localReview);
      const generatedValidation = gemini ? validateReviewClaims(gemini.review, canonical.product) : null;
      const duplicateGenerated = gemini ? otherProducts.some((other) => other.reviewContent && textSimilarity(`${gemini.review.reviewTitle} ${gemini.review.reviewSummary} ${gemini.review.reviewVerdict}`, `${other.reviewContent.reviewTitle} ${other.reviewContent.reviewSummary} ${other.reviewContent.reviewVerdict}`) >= 0.8) : false;
      const useGemini = Boolean(gemini && generatedValidation?.valid && !duplicateGenerated);
      const review = useGemini ? gemini!.review : localReview;
      counters.reviewGenerated++;
      if (review.reviewBlockReasons.includes('claim_validation_failed') || review.reviewBlockReasons.includes('unsafe_claim')) counters.claimValidationFailed++;
      if (review.reviewBlockReasons.includes('low_originality')) counters.duplicateContentSkipped++;
      if (review.reviewStatus === 'approved') counters.reviewApproved++; else if (review.reviewStatus === 'rejected') counters.reviewRejected++; else counters.reviewNeedsReview++;
      if (isReviewIndexable({ ...canonical.product, reviewContent: review })) counters.seoReady++; else counters.seoBlocked++;
      const publishSettings = await getAutomationSettings();
      finalProduct = (await saveCanonicalProduct(canonical.product.id, {
        reviewContent: review,
        reviewGeneration: useGemini ? {
          provider: 'gemini', modelId: gemini!.modelId, promptVersion: gemini!.promptVersion,
          generationFingerprint: gemini!.generationFingerprint, responseHash: gemini!.responseHash,
          generatedAt: gemini!.generatedAt, validationResult: 'approved',
        } : {
          provider: 'local', promptVersion: 'local-review-v2',
          generationFingerprint: canonical.product.sourceHash || canonical.product.id,
          generatedAt: new Date().toISOString(), validationResult: 'fallback_local',
        },
        status: 'needs_review', publicHidden: true, needsVerification: true, autoPublished: false,
      })) || canonical.product;
      const control = await getAutomationControl();
      if (publishSettings.safePublish && ['CANARY', 'AUTONOMOUS'].includes(control.effectiveMode) && evaluateSafePublish(finalProduct).eligible) {
        const publishSnapshotKey = publicationIdempotencyKey(finalProduct);
        const child = await createAutomationJob({
          type: 'AUTO_SAFE_PUBLISH',
          payload: { productId: finalProduct.id, candidateId: item.id },
          idempotencyKey: `auto-safe-publish:${publishSnapshotKey}`,
          operationId: `pipeline:${item.id}:${publishSnapshotKey}`.slice(0, 160),
          requestedBy: 'scheduler',
          parentJobId: item.durableJobId,
          dryRun: false,
        });
        finalProduct = (await saveCanonicalProduct(finalProduct.id, { lifecycleState: 'READY_FOR_PUBLISH', relatedJobId: child.job.id, nextAutomaticAction: 'AUTO_SAFE_PUBLISH' })) || finalProduct;
      }
    } else {
      counters.unchanged++;
    }
    counters.reviewed++;
    if (canonical.created) counters.created++; else if (canonical.unchanged) counters.unchanged++; else counters.updated++;
    if (finalProduct.status === 'published' && isReviewIndexable(finalProduct)) {
      counters.published++; counters.indexable++; counters.sitemapIncluded++;
      await finishCandidate(item.id, { status: 'completed' });
      const keywordStats = await loadKeywordStats((await getAutomationSettings()).sourceKeywords);
      const stat = keywordStats.find((entry) => entry.keyword === item.keyword); if (stat) stat.published++;
      await writeCollection(KEYWORD_COLLECTION, keywordStats);
      return { status: 'completed', terminal: true };
    } else {
      counters.needsReview++; counters.noindex++;
      const confirmedBroken = statuses.some((status) => ['broken', 'image_broken', 'invalid_image', 'not_found'].includes(status));
      const retryExhausted = !healthy && item.attempts >= 6;
      const status: CandidateQueueStatus = confirmedBroken ? 'discarded' : healthy || retryExhausted ? 'needs_review' : 'delayed';
      const reason = confirmedBroken ? 'confirmed_broken' : retryExhausted ? 'retry_budget_exhausted' : finalProduct.publicBlockReason;
      const nextRetryAt = confirmedBroken || retryExhausted ? undefined : finalProduct.sourceHealthCooldownUntil;
      await finishCandidate(item.id, { status, delayReason: reason, nextAttemptAt: nextRetryAt });
      return { status, terminal: status !== 'delayed', nextRetryAt, reason };
    }
  } catch (error) {
    counters.failed++;
    const status: CandidateQueueStatus = item.attempts >= 3 ? 'failed' : 'delayed';
    const reason = error instanceof Error ? error.message : 'review_error';
    const nextRetryAt = status === 'delayed' ? new Date(Date.now() + 6 * 60 * 60_000).toISOString() : undefined;
    await finishCandidate(item.id, { status, delayReason: reason, nextAttemptAt: nextRetryAt });
    return { status, terminal: status === 'failed', nextRetryAt, reason };
  }
}

export async function processCandidateFromDurableJob(input: {
  candidateId: string;
  jobId: string;
  operationId: string;
  workerId: string;
}): Promise<PipelineCounters & { candidateStatus: string; productId?: string }> {
  const existing = await getCandidateById(input.candidateId);
  if (!existing) throw new Error('CANDIDATE_NOT_FOUND');
  if (existing.durableJobId !== input.jobId) throw new Error('CANDIDATE_JOB_MISMATCH');
  const item = await claimCandidateForDurableJob(input.candidateId, input.jobId);
  if (!item) throw new Error('CANDIDATE_CLAIM_CONFLICT');
  const counters = emptyCounters();
  const outcome = await reviewAutonomousCandidate(item, counters, input.workerId);
  const finalCandidate = await getCandidateById(input.candidateId);
  const product = outcome.productId
    ? (await getAllProducts()).find(entry => entry.id === outcome.productId)
    : (await getAllProducts()).find(entry => entry.source === item.source && (entry.sourceId === item.sourceId || entry.externalId === item.sourceId));
  if (outcome.terminal) await recordKeywordCandidateOutcome(item, product);
  if (!outcome.terminal && outcome.nextRetryAt) throw new CandidateRetryScheduledError(outcome.nextRetryAt, outcome.status, outcome.reason);
  if (outcome.status === 'failed') throw new Error(`CANDIDATE_TERMINAL_FAILURE:${outcome.reason || 'review_failed'}`);
  await completeJournalEffect(input.operationId, 'canonical-product', product ? { id: product.id, sourceHash: product.sourceHash, status: product.status } : { candidateId: item.id, status: finalCandidate?.status });
  await completeJournalEffect(input.operationId, 'evidence-snapshot', { productId: product?.id, evidenceFactIds: product?.evidenceFactIds || [] });
  const child = product?.relatedJobId ? { jobId: product.relatedJobId } : { skipped: true, mode: (await getAutomationControl()).effectiveMode };
  await completeJournalEffect(input.operationId, 'publish-child', child);
  counters.queueSize = (await getQueueStats()).total;
  return { ...counters, candidateStatus: finalCandidate?.status || 'missing', productId: product?.id };
}

export async function processReviewQueue(mode: OperationMode, deadlineMs = Date.now() + 240_000, batchOverride?: number): Promise<PipelineCounters & { currentConcurrency: number }> {
  const counters = emptyCounters();
  const settings = await getAutomationSettings();
  const usage = await getDailyPipelineUsage();
  const remainingNetworkChecks = Math.max(0, settings.networkCheckBudgetPerDay - usage.networkChecks);
  const runtime = (await readCollection<RuntimeState>(RUNTIME_COLLECTION))[0] || { id: 'runtime', currentConcurrency: 3, timeoutStreak: 0, updatedAt: new Date().toISOString() };
  const batchLimit = batchOverride || (mode === 'bootstrap' ? settings.bootstrapReviewBatch : settings.steadyReviewBatch);
  const requested = Math.min(batchLimit, Math.floor(remainingNetworkChecks / 8));
  const reservationKey = `legacy-review:${todayInVietnam()}:${randomUUID()}`;
  const reservation = await reserveProductProcessingCapacity(reservationKey, requested, settings.maxItemsPerDay);
  if (!reservation.allowed && reservation.units === 0) return { ...counters, currentConcurrency: 0 };
  const batch = await claimCandidateBatch(reservation.units);
  const concurrency = Math.max(1, Math.min(3, settings.maxConcurrency, runtime.currentConcurrency || 3, batch.length || 1));
  let cursor = 0;
  let budgetExhausted = false;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < batch.length && Date.now() < deadlineMs) {
      if (counters.networkChecks >= remainingNetworkChecks) {
        budgetExhausted = true;
        break;
      }
      const item = batch[cursor++];
      await reviewOne(item, counters);
    }
  }));
  for (; cursor < batch.length; cursor++) await finishCandidate(batch[cursor].id, { status: 'pending', delayReason: budgetExhausted ? 'network_budget_exhausted' : 'run_deadline_reached' });
  const processedIds = new Set(batch.map((item) => item.id));
  const recentReasons = (await listCandidateQueue()).filter((item) => processedIds.has(item.id)).map((item) => item.delayReason || '').join(',');
  const rateLimited = recentReasons.includes('rate_limited');
  const timeoutHeavy = recentReasons.split('timeout').length - 1 >= 2;
  runtime.currentConcurrency = rateLimited ? 1
    : timeoutHeavy ? 2
    : Math.min(settings.maxConcurrency, Math.max(3, concurrency + (counters.failed === 0 ? 1 : -1)));
  runtime.updatedAt = new Date().toISOString();
  await writeCollection(RUNTIME_COLLECTION, [runtime]);
  counters.queueSize = (await getQueueStats()).total;
  await commitProductProcessingCapacity(reservationKey, counters.reviewed);
  await recordDailyUsage(counters);
  return { ...counters, currentConcurrency: runtime.currentConcurrency };
}

export async function recheckPublishedProducts(limit: number, deadlineMs: number): Promise<PipelineCounters> {
  const counters = emptyCounters();
  const candidates = (await getAllProducts())
    .filter((product) => product.status === 'published' && product.publicHidden === false)
    .sort((a, b) => Date.parse(a.linkLastCheckedAt || '1970-01-01') - Date.parse(b.linkLastCheckedAt || '1970-01-01'))
    .slice(0, Math.max(1, limit));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
    while (cursor < candidates.length && Date.now() < deadlineMs) {
      const product = candidates[cursor++];
      const productHealth = await checkCandidateLink(product.originalUrl || ''); counters.networkChecks++;
      const affiliateHealth = await checkCandidateLink(product.affiliateUrl || ''); counters.networkChecks++;
      const imageHealth = await checkCandidateImage(product.imageUrl || ''); counters.networkChecks++;
      const healthy = productHealth.ok && affiliateHealth.ok && imageHealth.ok;
      const statuses = [productHealth.status, affiliateHealth.status, imageHealth.status];
      const confirmedBroken = ['broken', 'not_found'].includes(productHealth.status)
        || ['broken', 'not_found'].includes(affiliateHealth.status)
        || ['image_broken', 'invalid_image'].includes(imageHealth.status);
      const preservePublishedHealth = !healthy && !confirmedBroken;
      const saved = await saveCanonicalProduct(product.id, {
        linkHealthStatus: preservePublishedHealth ? product.linkHealthStatus : productHealth.status === 'ok' ? 'ok' : productHealth.status as Product['linkHealthStatus'],
        affiliateHealthStatus: preservePublishedHealth ? product.affiliateHealthStatus : affiliateHealth.status === 'ok' ? 'ok' : affiliateHealth.status as Product['affiliateHealthStatus'],
        imageHealthStatus: preservePublishedHealth ? product.imageHealthStatus : imageHealth.status === 'ok' ? 'ok' : imageHealth.status as Product['imageHealthStatus'],
        linkLastCheckedAt: new Date().toISOString(), affiliateLastCheckedAt: new Date().toISOString(), imageLastCheckedAt: new Date().toISOString(),
        publicBlockReason: healthy || preservePublishedHealth ? '' : statuses.join(','),
        publicBlockReasons: healthy || preservePublishedHealth ? [] : statuses,
        sourceHealthCooldownUntil: healthy ? undefined : new Date(Date.now() + cooldownFor(statuses)).toISOString(),
        sourceHealthReason: healthy ? undefined : statuses.join(','),
      }, { evaluate: !preservePublishedHealth });
      counters.reviewed++;
      if (saved?.status === 'published') counters.published++; else counters.needsReview++;
    }
  }));
  counters.queueSize = (await getQueueStats()).total;
  return counters;
}
