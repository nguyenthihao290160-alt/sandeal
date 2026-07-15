import { createHash } from 'crypto';
import { AccessTradeRequestError, isAccessTradeConfigured, mapAccessTradeToProduct, searchAccessTrade, type AccessTradeResultType, type NormalizedAccessTradeItem } from '../integrations/accesstrade';
import { getAutomationSettings } from '../storage/automationSettings';
import { claimCandidateBatch, enqueueCandidate, finishCandidate, getQueueStats, listCandidateQueue, type CandidatePayload, type CandidateQueueItem } from '../storage/candidateQueue';
import { getAllProducts, publicationIdempotencyKey, saveCanonicalProduct, upsertCanonicalProduct } from '../storage/products';
import { readCollection, writeCollection } from '../storage/adapter';
import { createAutomationJob } from '../automation/store';
import { checkImageHealth, checkLinkHealth } from './productHealthCheck';
import type { Product } from '../types';
import { generateEditorialReview, isReviewIndexable, shouldRegenerateReview, textSimilarity, validateReviewClaims } from '../editorialReview';
import { generateGeminiEditorialReview } from '../ai/geminiEditorialProvider';
import { listAvailableGeminiModels } from '../ai/geminiCredentialRouter';
import { scoreCandidateReadiness } from './candidateReadiness';
import { isDomainCircuitOpen, recordDomainHealth } from './domainCircuitBreaker';
import { evaluateSafePublish } from '../safePublish';

const KEYWORD_COLLECTION = 'source-keyword-state';
const RUNTIME_COLLECTION = 'pipeline-runtime';
const USAGE_COLLECTION = 'pipeline-daily-usage';

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

interface KeywordStat { keyword: string; found: number; valid: number; published: number; empty: number; cursor: number; lastUsedAt?: string; }
interface RuntimeState { id: string; currentConcurrency: number; rateLimitUntil?: string; timeoutStreak: number; updatedAt: string; }
export interface DailyPipelineUsage { id: string; sourceRequests: number; candidatesFound: number; candidatesQueued: number; networkChecks: number; productsReviewed: number; productsPublished: number; updatedAt: string; }

export function selectOperationMode(publicProductCount: number): OperationMode {
  return publicProductCount < 100 ? 'bootstrap' : 'steady';
}

function emptyCounters(): PipelineCounters {
  return { sourceRequests: 0, found: 0, queued: 0, reviewed: 0, created: 0, updated: 0, unchanged: 0, duplicate: 0, skippedCooldown: 0, published: 0, needsReview: 0, failed: 0, discarded: 0, networkChecks: 0, queueSize: 0,
    reviewQueued: 0, reviewGenerated: 0, reviewApproved: 0, reviewNeedsReview: 0, reviewRejected: 0, reviewStale: 0,
    claimValidationFailed: 0, duplicateContentSkipped: 0, seoReady: 0, seoBlocked: 0, indexable: 0, noindex: 0, sitemapIncluded: 0 };
}

function todayInVietnam(): string { return new Date(Date.now() + 7 * 60 * 60_000).toISOString().slice(0, 10); }
export async function getDailyPipelineUsage(): Promise<DailyPipelineUsage> {
  const id = todayInVietnam();
  return (await readCollection<DailyPipelineUsage>(USAGE_COLLECTION)).find((item) => item.id === id)
    || { id, sourceRequests: 0, candidatesFound: 0, candidatesQueued: 0, networkChecks: 0, productsReviewed: 0, productsPublished: 0, updatedAt: new Date().toISOString() };
}
async function recordDailyUsage(counters: PipelineCounters): Promise<void> {
  const current = await getDailyPipelineUsage();
  current.sourceRequests += counters.sourceRequests;
  current.candidatesFound += counters.found;
  current.candidatesQueued += counters.queued;
  current.networkChecks += counters.networkChecks;
  current.productsReviewed += counters.reviewed;
  current.productsPublished += counters.published;
  current.updatedAt = new Date().toISOString();
  const all = (await readCollection<DailyPipelineUsage>(USAGE_COLLECTION)).filter((item) => item.id !== current.id).slice(-6);
  await writeCollection(USAGE_COLLECTION, [...all, current]);
}

function hashPayload(payload: CandidatePayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validHttpUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol); } catch { return false; }
}

function toPayload(item: NormalizedAccessTradeItem): CandidatePayload {
  return {
    title: item.name, description: item.description || undefined, kind: item.kind,
    platform: item.platform, originalUrl: item.canonicalProductUrl || item.originalUrl,
    affiliateUrl: item.affiliateUrl, imageUrl: item.imageUrl,
    imageCandidates: item.imageCandidates.filter(Boolean).slice(0, 6),
    price: item.price || undefined, salePrice: item.salePrice || undefined,
    currency: 'VND', category: item.category || undefined,
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

async function loadKeywordStats(keywords: string[]): Promise<KeywordStat[]> {
  const stored = await readCollection<KeywordStat>(KEYWORD_COLLECTION);
  return keywords.map((keyword, cursor) => stored.find((item) => item.keyword === keyword) || { keyword, found: 0, valid: 0, published: 0, empty: 0, cursor });
}

function selectKeywords(stats: KeywordStat[], count: number): KeywordStat[] {
  const neverUsed = stats.filter((item) => !item.lastUsedAt);
  const ranked = [...stats].sort((a, b) => (b.published * 5 + b.valid * 2 + b.found - b.empty * 3) - (a.published * 5 + a.valid * 2 + a.found - a.empty * 3) || Date.parse(a.lastUsedAt || '1970-01-01') - Date.parse(b.lastUsedAt || '1970-01-01'));
  const exploration = neverUsed.slice(0, Math.max(1, Math.floor(count / 4)));
  return [...new Map([...exploration, ...ranked].map((item) => [item.keyword, item])).values()].slice(0, count);
}

export async function scanSourcesToQueue(mode: OperationMode, deadlineMs = Date.now() + 240_000): Promise<PipelineCounters & { resultTypes: Partial<Record<AccessTradeResultType, number>>; retryAfter?: string }> {
  const counters = emptyCounters();
  const resultTypes: Partial<Record<AccessTradeResultType, number>> = {};
  let retryAfter: string | undefined;
  const settings = await getAutomationSettings();
  const usage = await getDailyPipelineUsage();
  const sourceBudgetRemaining = Math.max(0, settings.sourceRequestBudgetPerDay - usage.sourceRequests);
  if (!(await isAccessTradeConfigured())) return { ...counters, resultTypes, retryAfter };
  if (sourceBudgetRemaining <= 0) return { ...counters, resultTypes, retryAfter };
  const keywordCount = mode === 'bootstrap' ? settings.bootstrapKeywordCount : settings.steadyKeywordCount;
  const candidateLimit = mode === 'bootstrap' ? settings.bootstrapCandidateLimit : settings.steadyCandidateLimit;
  const stats = await loadKeywordStats(settings.sourceKeywords);
  const selected = selectKeywords(stats, keywordCount);
  const products = await getAllProducts();
  let timeoutStreak = 0;

  for (const stat of selected) {
    if (Date.now() >= deadlineMs || counters.found >= candidateLimit || counters.sourceRequests >= sourceBudgetRemaining) break;
    stat.lastUsedAt = new Date().toISOString();
    try {
      const result = await searchAccessTrade({ keyword: stat.keyword, kind: 'product', limit: Math.min(50, candidateLimit - counters.found) });
      counters.sourceRequests += result.requests.reduce((total, request) => total + (request.attempts || 1), 0);
      for (const request of result.requests) resultTypes[request.resultType] = (resultTypes[request.resultType] || 0) + 1;
      timeoutStreak = 0;
      stat.found += result.items.length;
      if (!result.items.length) stat.empty++;
      counters.found += result.items.length;
      for (const item of result.items) {
        const payload = toPayload(item);
        const reject = fastReject(payload);
        if (reject) { counters.discarded++; continue; }
        stat.valid++;
        const sourceHash = hashPayload(payload);
        const existing = products.find((product) =>
          (product.source === 'accesstrade' && (product.sourceId === item.id || product.externalId === item.id)) ||
          product.originalUrl === payload.originalUrl || product.affiliateUrl === payload.affiliateUrl,
        );
        if (existing?.sourceHash === sourceHash) { counters.duplicate++; counters.unchanged++; continue; }
        if (existing?.sourceHealthCooldownUntil && Date.parse(existing.sourceHealthCooldownUntil) > Date.now()) { counters.skippedCooldown++; continue; }
        const complete = [payload.title, payload.price || payload.salePrice, payload.originalUrl, payload.affiliateUrl, payload.imageUrl].filter(Boolean).length;
        const priority = complete * 20 + (payload.verifiedSource ? 20 : 0) + Math.min(19, stat.published * 2 + stat.valid);
        const readiness = scoreCandidateReadiness(payload);
        const queued = await enqueueCandidate({ source: 'accesstrade', sourceId: item.id, priority, readinessScore: readiness.score, lane: readiness.lane, contentHash: sourceHash, sourceHash, keyword: stat.keyword, payload });
        if (queued.queued) { counters.queued++; counters.reviewQueued++; } else { counters.duplicate++; counters.unchanged++; }
      }
    } catch (error) {
      if (error instanceof AccessTradeRequestError) {
        counters.sourceRequests += error.requests.reduce((total, request) => total + (request.attempts || 1), 0);
        retryAfter = error.requests.map((request) => request.retryAfter).filter((value): value is string => Boolean(value)).sort().at(-1) || retryAfter;
        resultTypes[error.resultType] = (resultTypes[error.resultType] || 0) + 1;
        if (error.resultType === 'timeout') timeoutStreak++; else timeoutStreak = 0;
        if (['unauthorized', 'forbidden', 'rate_limited'].includes(error.resultType) || timeoutStreak >= 2) break;
      } else counters.failed++;
    }
  }
  await writeCollection(KEYWORD_COLLECTION, stats);
  counters.queueSize = (await getQueueStats()).total;
  await recordDailyUsage(counters);
  return { ...counters, resultTypes, retryAfter };
}

function cooldownFor(statuses: string[], attempts = 1): number {
  if (statuses.includes('rate_limited')) return 60 * 60_000;
  if (statuses.some((status) => ['timeout', 'server_error', 'dns_error', 'error'].includes(status))) return Math.min(48 * 60 * 60_000, 60 * 60_000 * 2 ** Math.min(5, attempts));
  if (statuses.some((status) => ['broken', 'image_broken'].includes(status))) return 24 * 60 * 60_000;
  return 4 * 60 * 60_000;
}

async function reviewOne(item: CandidateQueueItem, counters: PipelineCounters): Promise<void> {
  const { payload } = item;
  try {
    if (await isDomainCircuitOpen(payload.originalUrl) || await isDomainCircuitOpen(payload.affiliateUrl) || await isDomainCircuitOpen(payload.imageUrl)) {
      await finishCandidate(item.id, { status: 'delayed', delayReason: 'domain_circuit_open', nextAttemptAt: new Date(Date.now() + 30 * 60_000).toISOString() }); return;
    }
    const productHealth = await checkLinkHealth(payload.originalUrl); counters.networkChecks++;
    const affiliateHealth = await checkLinkHealth(payload.affiliateUrl); counters.networkChecks++;
    let imageUrl = payload.imageUrl;
    let imageHealth = await checkImageHealth(imageUrl); counters.networkChecks++;
    if (!imageHealth.ok) {
      for (const candidate of payload.imageCandidates || []) {
        if (candidate === imageUrl) continue;
        const fallback = await checkImageHealth(candidate); counters.networkChecks++;
        if (fallback.ok) { imageUrl = candidate; imageHealth = fallback; break; }
      }
    }
    const statuses = [productHealth.status, affiliateHealth.status, imageHealth.status];
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
      if (publishSettings.safePublish && evaluateSafePublish(finalProduct).eligible) {
        await createAutomationJob({
          type: 'SAFE_PUBLISH',
          payload: { productId: finalProduct.id, candidateId: item.id },
          idempotencyKey: `safe-publish:${publicationIdempotencyKey(finalProduct)}`,
          operationId: `pipeline:${item.id}`,
          requestedBy: 'scheduler',
          riskLevel: 'HIGH',
          dryRun: false,
          maxAttempts: 2,
          approvalReason: 'Sản phẩm đã qua kiểm tra tự động nhưng chỉ được public sau phê duyệt Safe Publish.',
        });
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
    } else {
      counters.needsReview++; counters.noindex++;
      const confirmedBroken = statuses.some((status) => ['broken', 'image_broken', 'invalid_image', 'not_found'].includes(status));
      const retryExhausted = !healthy && item.attempts >= 6;
      await finishCandidate(item.id, {
        status: confirmedBroken ? 'discarded' : healthy || retryExhausted ? 'needs_review' : 'delayed',
        delayReason: confirmedBroken ? 'confirmed_broken' : retryExhausted ? 'retry_budget_exhausted' : finalProduct.publicBlockReason,
        nextAttemptAt: confirmedBroken || retryExhausted ? undefined : finalProduct.sourceHealthCooldownUntil,
      });
    }
  } catch (error) {
    counters.failed++;
    await finishCandidate(item.id, { status: item.attempts >= 3 ? 'failed' : 'delayed', delayReason: error instanceof Error ? error.message : 'review_error', nextAttemptAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString() });
  }
}

export async function processReviewQueue(mode: OperationMode, deadlineMs = Date.now() + 240_000, batchOverride?: number): Promise<PipelineCounters & { currentConcurrency: number }> {
  const counters = emptyCounters();
  const settings = await getAutomationSettings();
  const usage = await getDailyPipelineUsage();
  const remainingNetworkChecks = Math.max(0, settings.networkCheckBudgetPerDay - usage.networkChecks);
  const runtime = (await readCollection<RuntimeState>(RUNTIME_COLLECTION))[0] || { id: 'runtime', currentConcurrency: 3, timeoutStreak: 0, updatedAt: new Date().toISOString() };
  const batchLimit = batchOverride || (mode === 'bootstrap' ? settings.bootstrapReviewBatch : settings.steadyReviewBatch);
  const batch = await claimCandidateBatch(Math.min(batchLimit, Math.floor(remainingNetworkChecks / 8)));
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
      const productHealth = await checkLinkHealth(product.originalUrl || ''); counters.networkChecks++;
      const affiliateHealth = await checkLinkHealth(product.affiliateUrl || ''); counters.networkChecks++;
      const imageHealth = await checkImageHealth(product.imageUrl || ''); counters.networkChecks++;
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
