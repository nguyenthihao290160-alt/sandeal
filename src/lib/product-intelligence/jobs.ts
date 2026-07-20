import type { AutomationJob } from '@/lib/automation/types';
import { getAutomationControl, getAutomationJob } from '@/lib/automation/store';
import type { Product } from '@/lib/types';
import { getAllProducts, getProductById, saveCanonicalProduct } from '@/lib/storage/products';
import {
  checkLinkHealth,
  resolveHealthyImageCandidate,
  type ImageCandidateResolution,
  type LinkCheckResult,
} from '@/lib/bots/productHealthCheck';
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

async function recheckHealth(job: AutomationJob) {
  const products = await selectedProducts(job.payload);
  const requestedTarget = stringValue(job.payload.healthTarget, 20);
  const narrowedTarget = new Set(['link', 'affiliate', 'image']).has(requestedTarget);
  const checkLinks = !narrowedTarget || requestedTarget === 'link';
  const checkAffiliate = !narrowedTarget || requestedTarget === 'affiliate';
  const checkImages = !narrowedTarget || requestedTarget === 'image';
  if (job.dryRun) return {
    preview: true,
    inspected: products.length,
    healthTarget: requestedTarget || 'all',
    estimatedRequests: products.reduce((sum, item) => sum
      + Number(checkLinks && Boolean(item.originalUrl))
      + Number(checkAffiliate && Boolean(item.affiliateUrl))
      + Number(checkImages && Boolean(item.imageUrl)), 0),
    businessDataChanged: false,
  };
  let checked = 0; let valid = 0; let blocked = 0; let failed = 0; let quarantined = 0;
  let circuitSkipped = 0; let fallbackImages = 0; let retryScheduled = 0; let externalRequests = 0;
  for (const product of products) {
    const updates: Partial<Product> = {};
    try {
      await assertJobMayContinue(job);
      const retryTimes: string[] = [];
      const failureReasons: string[] = [];
      const goodHealth = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);
      let productUrlHealthy = !checkLinks && goodHealth.has(String(product.linkHealthStatus || product.productHealthStatus || ''));
      let affiliateUrlHealthy = !checkAffiliate && goodHealth.has(String(product.affiliateHealthStatus || ''));
      if (checkLinks && product.originalUrl) {
        const checkedLink = await checkLinkWithDomainCircuit(product.originalUrl);
        const result = checkedLink.result;
        productUrlHealthy = result.ok;
        updates.linkHealthStatus = result.status as Product['linkHealthStatus']; updates.linkLastCheckedAt = new Date().toISOString();
        updates.productUrlHttpStatus = result.statusCode;
        updates.productUrlFinalUrl = result.finalUrl;
        updates.productUrlFinalDomain = finalDomain(result.finalUrl || product.originalUrl);
        updates.productUrlHealthReason = result.reason.slice(0, 500);
        updates.productUrlErrorCode = result.errorCode;
        updates.productUrlTimedOut = result.timedOut === true;
        if (!result.ok) {
          failed += 1;
          failureReasons.push(`link:${result.status}`);
          if (result.retryable && checkedLink.retryAt) retryTimes.push(checkedLink.retryAt);
        }
        if (checkedLink.circuitSkipped) circuitSkipped += 1;
        else externalRequests += 1;
        await assertJobMayContinue(job);
      } else if (checkLinks) {
        failed += 1;
        updates.linkHealthStatus = 'error';
        updates.linkLastCheckedAt = new Date().toISOString();
        updates.productUrlHealthReason = 'Thiếu product URL hợp lệ.';
        updates.productUrlErrorCode = 'MISSING_PRODUCT_URL';
        failureReasons.push('link:error');
      }
      if (checkAffiliate && product.affiliateUrl) {
        const checkedLink = await checkLinkWithDomainCircuit(product.affiliateUrl);
        const result = checkedLink.result;
        const support = accessTradeAffiliateSupport(product);
        affiliateUrlHealthy = result.ok && support.supported;
        updates.affiliateHealthStatus = (affiliateUrlHealthy ? result.status : support.supported ? result.status : 'not_allowed') as Product['affiliateHealthStatus'];
        updates.affiliateLastCheckedAt = new Date().toISOString();
        updates.affiliateUrlHttpStatus = result.statusCode;
        updates.affiliateUrlFinalUrl = result.finalUrl;
        updates.affiliateUrlFinalDomain = finalDomain(result.finalUrl || product.affiliateUrl);
        updates.affiliateUrlHealthReason = (support.reason || result.reason).slice(0, 500);
        updates.affiliateUrlErrorCode = support.supported ? result.errorCode : 'DEEPLINK_NOT_SUPPORTED';
        updates.affiliateUrlTimedOut = result.timedOut === true;
        updates.affiliateLinkErrors = affiliateUrlHealthy ? undefined : (support.reason || result.reason).slice(0, 500);
        if (!affiliateUrlHealthy) {
          failed += 1;
          failureReasons.push(`affiliate:${support.supported ? result.status : 'deeplink_not_supported'}`);
          if (result.retryable && checkedLink.retryAt) retryTimes.push(checkedLink.retryAt);
        }
        if (checkedLink.circuitSkipped) circuitSkipped += 1;
        else externalRequests += 1;
        await assertJobMayContinue(job);
      } else if (checkAffiliate) {
        failed += 1;
        updates.affiliateHealthStatus = 'error';
        updates.affiliateLastCheckedAt = new Date().toISOString();
        updates.affiliateUrlHealthReason = 'Nhà cung cấp không trả về tracking URL/deep-link.';
        updates.affiliateUrlErrorCode = 'MISSING_AFFILIATE_URL';
        updates.affiliateLinkErrors = 'Nhà cung cấp không trả về tracking URL/deep-link.';
        failureReasons.push('affiliate:error');
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
        const result = checkedImages.resolution.result;
        updates.imageHealthStatus = (result.ok ? 'ok' : result.status) as Product['imageHealthStatus']; updates.imageLastCheckedAt = new Date().toISOString();
        if (checkedImages.resolution.selectedUrl && checkedImages.resolution.selectedUrl !== product.imageUrl) {
          updates.imageUrl = checkedImages.resolution.selectedUrl;
          fallbackImages += 1;
        }
        if (!result.ok) {
          failed += 1;
          failureReasons.push(`image:${result.status}`);
          if (result.retryable && checkedImages.retryAt) retryTimes.push(checkedImages.retryAt);
        }
        circuitSkipped += checkedImages.circuitSkipped;
        externalRequests += checkedImages.resolution.attempts;
        await assertJobMayContinue(job);
      }
      const support = accessTradeAffiliateSupport(product);
      if (!support.supported) affiliateUrlHealthy = false;
      const isThirtyShine = urlContainsDomain(product.originalUrl, '30shinestore.com')
        || urlContainsDomain(product.affiliateUrl, '30shinestore.com');
      const urlBlockers = (product.publicBlockReasons || []).filter(reason => ![
        'product_url_unhealthy', 'affiliate_url_unhealthy', 'merchant_quarantined_30shinestore',
      ].includes(reason));
      if (!productUrlHealthy) urlBlockers.push('product_url_unhealthy');
      if (!affiliateUrlHealthy) urlBlockers.push('affiliate_url_unhealthy');
      if (isThirtyShine) urlBlockers.push('merchant_quarantined_30shinestore');
      const urlUnsafe = !productUrlHealthy || !affiliateUrlHealthy || isThirtyShine;
      const urlReason = !support.supported
        ? support.reason
        : !productUrlHealthy
          ? updates.productUrlHealthReason || 'Product URL không hợp lệ.'
          : !affiliateUrlHealthy
            ? updates.affiliateUrlHealthReason || 'Affiliate URL không hợp lệ.'
            : isThirtyShine
              ? 'Record 30shinestore được lưu trữ an toàn và không được Safe Publish.'
              : undefined;
      updates.publicBlockReasons = [...new Set(urlBlockers)];
      updates.publicBlocked = urlUnsafe || urlBlockers.length > 0;
      if (urlUnsafe) {
        blocked += 1;
        updates.publicHidden = true;
        updates.needsVerification = true;
        updates.autoPublishEligible = false;
        updates.publicDecision = isThirtyShine ? 'archived' : 'blocked';
        updates.publicBlockReason = urlReason;
        updates.unpublishedReason = urlReason;
      } else {
        valid += 1;
        updates.publicBlockReason = urlBlockers[0];
      }
      if (isThirtyShine) {
        quarantined += 1;
        updates.status = 'archived';
        updates.lifecycleState = 'QUARANTINED';
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
      } else if (Object.keys(updates).length) {
        updates.sourceHealthReason = undefined;
        updates.sourceHealthCooldownUntil = undefined;
      }
      if (Object.keys(updates).length) await saveCanonicalProduct(product.id, updates);
      checked += 1;
    } catch (error) {
      if (isJobStop(error)) throw error;
      failed += 1;
    }
  }
  return {
    checked,
    inspected: checked,
    valid,
    blocked,
    failed,
    quarantined,
    circuitSkipped,
    fallbackImages,
    retryScheduled,
    externalRequests,
    healthTarget: requestedTarget || 'all',
    businessDataChanged: checked > 0,
  };
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
