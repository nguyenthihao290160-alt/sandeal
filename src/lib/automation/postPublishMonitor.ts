import { createHash } from 'node:crypto';
import {
  checkLinkHealth,
  resolveHealthyImageCandidate,
  type LinkCheckResult,
} from '@/lib/bots/productHealthCheck';
import { calculateProductConfidences } from '@/lib/autonomous/confidenceEngine';
import { captureProductHealthEvidence } from '@/lib/autonomous/evidenceGraph';
import {
  getLifecycleTransitionEvent,
  persistLifecycleTransition,
} from '@/lib/autonomous/lifecycleStore';
import {
  readinessSnapshotHash,
  verifyAutonomousPublishEvidence,
} from '@/lib/autonomous/publishPolicy';
import { isReviewIndexable } from '@/lib/editorialReview';
import { evaluateSafePublish } from '@/lib/safePublish';
import { fetchExternalSafely, validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import { getProductById, saveCanonicalProduct } from '@/lib/storage/products';
import type { LinkHealthStatus, Product, ProductLifecycleState, ProductOffer } from '@/lib/types';
import { createAutomationJob, getAutomationControl } from './store';
import type { AutomationJob } from './types';

const RULES_VERSION = 'post-publish-monitor-v2';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HEALTHY_STATUSES = new Set(['ok', 'redirect_ok', 'redirected', 'healthy']);
const PERMANENT_LINK_STATUSES = new Set(['broken', 'not_found']);
const PERMANENT_IMAGE_STATUSES = new Set(['image_broken', 'invalid_image']);
const PERMANENT_REASON = /(?:broken|not_found|image_broken|invalid_image)/;

type MonitorOutcome = 'HEALTHY' | 'TEMPORARY_FAILURE' | 'CONFIRMED_BROKEN';

interface MonitorStatuses {
  product: string;
  affiliate: string;
  image: string;
  publicPage: string;
}

interface MonitorProbeResult {
  outcome: MonitorOutcome;
  statuses: MonitorStatuses;
  externalRequests: number;
  selectedProductUrl: string;
  selectedAffiliateUrl: string;
  selectedImageUrl: string;
  selectedOfferId?: string;
  publicPageUrl: string;
}

interface LinkCandidateResolution {
  selectedUrl: string;
  result: LinkCheckResult;
  attempts: number;
}

function monitorKey(job: AutomationJob, phase: string): string {
  return `post-publish-monitor:${job.id}:${phase}`.slice(0, 200);
}

function stableToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function stableCheckedAt(job: AutomationJob): string {
  const candidates = [job.startedAt, job.claimedAt, job.createdAt];
  return candidates.find(value => value && Number.isFinite(Date.parse(value))) || new Date().toISOString();
}

function sequenceOf(job: AutomationJob): number {
  const value = Number(job.payload.sequence || 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(10_000, Math.floor(value))) : 0;
}

function fixtureOutcome(job: AutomationJob): MonitorOutcome | null {
  if (process.env.NODE_ENV !== 'test') return null;
  const value = String(job.payload.healthOutcome || '');
  return ['HEALTHY', 'TEMPORARY_FAILURE', 'CONFIRMED_BROKEN'].includes(value)
    ? value as MonitorOutcome
    : null;
}

function classifyPublicStatus(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirected';
  if (status === 404 || status === 410) return 'not_found';
  if (status >= 500) return 'server_error';
  if (status === 429) return 'rate_limited';
  return 'not_allowed';
}

function linkCheckOptions() {
  return { resolveDns: process.env.NODE_ENV !== 'test' };
}

async function resolveHealthyLinkCandidate(candidates: Array<string | undefined>): Promise<LinkCandidateResolution> {
  const urls = [...new Set(candidates.map(value => String(value || '').trim()).filter(Boolean))];
  const checked: Array<{ url: string; result: LinkCheckResult }> = [];
  for (const url of urls) {
    const result = await checkLinkHealth(url, linkCheckOptions());
    checked.push({ url, result });
    if (result.ok) return { selectedUrl: url, result, attempts: checked.length };
  }
  const preferred = checked.find(item => item.result.retryable === true) || checked[0];
  return {
    selectedUrl: preferred?.url || urls[0] || '',
    result: preferred?.result || { status: 'error', ok: false, retryable: false, reason: 'No URL candidate' },
    attempts: checked.length,
  };
}

function alternateOffers(product: Product): ProductOffer[] {
  return [...(product.offers || [])]
    .filter(offer => offer.affiliateUrl && offer.affiliateUrl !== product.affiliateUrl)
    .sort((left, right) => {
      const healthRank = (offer: ProductOffer) => offer.health === 'HEALTHY' ? 2 : offer.health === 'DEGRADED' ? 1 : 0;
      return healthRank(right) - healthRank(left)
        || right.confidence - left.confidence
        || Date.parse(right.observedAt) - Date.parse(left.observedAt)
        || left.id.localeCompare(right.id);
    });
}

function configuredPublicPageUrl(product: Product): { url: string; loopback: boolean; configured: boolean } {
  const route = `/deals/${encodeURIComponent(product.slug)}`;
  const configured = String(process.env.SANDEAL_PUBLIC_HEALTH_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || '').trim();
  if (!configured) return { url: route, loopback: false, configured: false };
  try {
    const base = new URL(configured);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      return { url: route, loopback: false, configured: false };
    }
    const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
    if (!loopback) {
      const validation = validateExternalUrl(base.toString());
      if (!validation.safe || !validation.normalizedUrl) return { url: route, loopback: false, configured: false };
      return { url: new URL(route, validation.normalizedUrl).toString(), loopback: false, configured: true };
    }
    return { url: new URL(route, base).toString(), loopback: true, configured: true };
  } catch {
    return { url: route, loopback: false, configured: false };
  }
}

async function probePublicPage(
  job: AutomationJob,
  product: Product,
  expectedPublic: boolean,
): Promise<{ status: string; url: string; externalRequests: number }> {
  const target = configuredPublicPageUrl(product);
  if (!expectedPublic) return { status: 'not_applicable', url: target.url, externalRequests: 0 };
  if (process.env.NODE_ENV === 'test' && job.payload.publicPageStatus !== undefined) {
    const fixture = Number(job.payload.publicPageStatus);
    return {
      status: Number.isFinite(fixture) ? classifyPublicStatus(fixture) : String(job.payload.publicPageStatus || 'unverified'),
      url: target.url,
      externalRequests: 0,
    };
  }
  if (!target.configured) return { status: 'unverified', url: target.url, externalRequests: 0 };
  try {
    if (target.loopback) {
      const response = await fetch(target.url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(8_000),
      });
      return { status: classifyPublicStatus(response.status), url: target.url, externalRequests: 1 };
    }
    const response = await fetchExternalSafely(target.url, { timeoutMs: 8_000, maxBytes: 64 * 1_024, maxRedirects: 3 });
    return { status: classifyPublicStatus(response.response.status), url: response.finalUrl, externalRequests: 1 };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}:${error.message}`.toLowerCase() : String(error).toLowerCase();
    const status = message.includes('timeout') || message.includes('abort')
      ? 'timeout'
      : message.includes('dns')
        ? 'dns_error'
        : 'server_error';
    return { status, url: target.url, externalRequests: 1 };
  }
}

async function probe(job: AutomationJob, product: Product, expectedPublic: boolean): Promise<MonitorProbeResult> {
  const fixture = fixtureOutcome(job);
  let productResolution: LinkCandidateResolution;
  let affiliateResolution: LinkCandidateResolution;
  let imageResolution: Awaited<ReturnType<typeof resolveHealthyImageCandidate>>;
  let selectedOfferId: string | undefined;
  let sourceRequests = 0;

  if (fixture) {
    const linkStatus = fixture === 'HEALTHY' ? 'ok' : fixture === 'TEMPORARY_FAILURE' ? 'timeout' : 'broken';
    const imageStatus = fixture === 'HEALTHY' ? 'ok' : fixture === 'TEMPORARY_FAILURE' ? 'timeout' : 'image_broken';
    productResolution = {
      selectedUrl: String(product.originalUrl || ''),
      result: { status: linkStatus, ok: fixture === 'HEALTHY', retryable: fixture === 'TEMPORARY_FAILURE', reason: 'isolated fixture' },
      attempts: 0,
    };
    affiliateResolution = {
      selectedUrl: String(product.affiliateUrl || ''),
      result: { status: linkStatus, ok: fixture === 'HEALTHY', retryable: fixture === 'TEMPORARY_FAILURE', reason: 'isolated fixture' },
      attempts: 0,
    };
    imageResolution = {
      selectedUrl: String(product.imageUrl || ''),
      result: { status: imageStatus, ok: fixture === 'HEALTHY', retryable: fixture === 'TEMPORARY_FAILURE', reason: 'isolated fixture' },
      checked: [],
      attempts: 0,
    };
  } else {
    productResolution = await resolveHealthyLinkCandidate([
      product.originalUrl,
      product.identity?.canonicalUrl,
    ]);
    const offers = alternateOffers(product);
    affiliateResolution = await resolveHealthyLinkCandidate([
      product.affiliateUrl,
      ...offers.map(offer => offer.affiliateUrl),
    ]);
    selectedOfferId = offers.find(offer => offer.affiliateUrl === affiliateResolution.selectedUrl)?.id;
    imageResolution = await resolveHealthyImageCandidate([product.imageUrl, ...(product.gallery || [])], linkCheckOptions());
    sourceRequests = productResolution.attempts + affiliateResolution.attempts + imageResolution.attempts;
  }

  const publicPage = await probePublicPage(job, product, expectedPublic);
  const statuses: MonitorStatuses = {
    product: productResolution.result.status,
    affiliate: affiliateResolution.result.status,
    image: imageResolution.result.status,
    publicPage: publicPage.status,
  };
  const sourcePermanent = PERMANENT_LINK_STATUSES.has(statuses.product)
    || PERMANENT_LINK_STATUSES.has(statuses.affiliate)
    || PERMANENT_IMAGE_STATUSES.has(statuses.image);
  const publicPermanent = expectedPublic && PERMANENT_LINK_STATUSES.has(statuses.publicPage);
  const sourceHealthy = productResolution.result.ok && affiliateResolution.result.ok && imageResolution.result.ok;
  const publicHealthy = !expectedPublic || HEALTHY_STATUSES.has(statuses.publicPage);
  return {
    outcome: sourceHealthy && publicHealthy ? 'HEALTHY' : sourcePermanent || publicPermanent ? 'CONFIRMED_BROKEN' : 'TEMPORARY_FAILURE',
    statuses,
    externalRequests: sourceRequests + publicPage.externalRequests,
    selectedProductUrl: productResolution.selectedUrl || String(product.originalUrl || ''),
    selectedAffiliateUrl: affiliateResolution.selectedUrl || String(product.affiliateUrl || ''),
    selectedImageUrl: imageResolution.selectedUrl || String(product.imageUrl || ''),
    selectedOfferId,
    publicPageUrl: publicPage.url,
  };
}

async function transitionProduct(
  productId: string,
  to: ProductLifecycleState,
  job: AutomationJob,
  workerId: string,
  phase: string,
  reasonCodes: string[],
): Promise<Product> {
  const result = await persistLifecycleTransition({
    productId,
    to,
    actor: { type: 'worker', id: workerId, jobId: job.id, jobType: job.type },
    transitionKey: monitorKey(job, phase),
    operationId: job.operationId,
    reasonCodes,
    now: stableCheckedAt(job),
  });
  return result.product;
}

async function scheduleNextMonitor(
  job: AutomationJob,
  productId: string,
  delayMs: number,
  sequence: number,
  interval: '15m' | '6h' | '24h' | 'periodic',
  reason: string,
  retry: boolean,
): Promise<string> {
  const scheduledAt = new Date(Date.parse(stableCheckedAt(job)) + delayMs).toISOString();
  const identity = stableToken(productId);
  const child = await createAutomationJob({
    type: 'POST_PUBLISH_MONITOR',
    payload: { productId, sequence, interval, reason },
    idempotencyKey: `monitor:${identity}:${job.id}:${reason}:${sequence}`.slice(0, 160),
    operationId: `monitor-chain:${identity}:${job.operationId}`.slice(0, 160),
    parentJobId: job.id,
    requestedBy: 'autopilot-worker',
    priority: reason === 'broken-confirmation' ? 85 : 60,
    scheduledAt,
  });
  await saveCanonicalProduct(productId, {
    monitoringScheduledAt: scheduledAt,
    nextRetryAt: retry ? scheduledAt : undefined,
    relatedJobId: child.job.id,
    nextAutomaticAction: retry ? 'RECHECK_PRODUCT_HEALTH' : 'POST_PUBLISH_MONITOR',
  });
  return child.job.id;
}

function healthReason(statuses: MonitorStatuses): string {
  return [statuses.product, statuses.affiliate, statuses.image, `public:${statuses.publicPage}`].join(',');
}

function productStatus(value: string): LinkHealthStatus {
  return (value === 'redirected' ? 'redirect_ok' : value) as LinkHealthStatus;
}

function withSelectedOffer(product: Product, result: MonitorProbeResult): Pick<Product, 'offers' | 'bestOfferId'> {
  if (!result.selectedOfferId) return { offers: product.offers || [], bestOfferId: product.bestOfferId };
  return {
    offers: (product.offers || []).map(offer => ({ ...offer, primary: offer.id === result.selectedOfferId })),
    bestOfferId: result.selectedOfferId,
  };
}

async function persistObservation(
  product: Product,
  result: MonitorProbeResult,
  checkedAt: string,
  observationId: string,
): Promise<Product> {
  const observedProduct: Product = {
    ...product,
    originalUrl: result.selectedProductUrl,
    affiliateUrl: result.selectedAffiliateUrl,
    imageUrl: result.selectedImageUrl,
    linkHealthStatus: productStatus(result.statuses.product),
    affiliateHealthStatus: productStatus(result.statuses.affiliate),
    imageHealthStatus: productStatus(result.statuses.image),
    ...withSelectedOffer(product, result),
  };
  const evidence = await captureProductHealthEvidence(observedProduct, {
    observationId,
    checkedAt,
    productUrl: result.selectedProductUrl,
    affiliateUrl: result.selectedAffiliateUrl,
    imageUrl: result.selectedImageUrl,
    productStatus: result.statuses.product,
    affiliateStatus: result.statuses.affiliate,
    imageStatus: result.statuses.image,
    publicPageUrl: result.publicPageUrl,
    publicPageStatus: result.statuses.publicPage,
  });
  let confidences = calculateProductConfidences(observedProduct, {
    evidenceCoverage: evidence.coverage,
    now: Date.parse(checkedAt),
  });
  if (!['ok', 'redirected', 'not_applicable'].includes(result.statuses.publicPage)) {
    confidences = { ...confidences, health: Math.min(confidences.health, 0.4), publish: Math.min(confidences.publish, 0.4) };
  }
  const saved = await saveCanonicalProduct(product.id, {
    originalUrl: result.selectedProductUrl,
    affiliateUrl: result.selectedAffiliateUrl,
    imageUrl: result.selectedImageUrl,
    linkHealthStatus: productStatus(result.statuses.product),
    affiliateHealthStatus: productStatus(result.statuses.affiliate),
    imageHealthStatus: productStatus(result.statuses.image),
    ...withSelectedOffer(product, result),
    linkLastCheckedAt: checkedAt,
    affiliateLastCheckedAt: checkedAt,
    imageLastCheckedAt: checkedAt,
    evidenceFactIds: evidence.snapshot.evidenceIds,
    evidenceCoverage: evidence.coverage,
    evidenceSnapshotAt: evidence.snapshot.createdAt,
    evidenceSnapshotHash: evidence.snapshot.snapshotHash,
    confidences,
  });
  if (!saved) throw new Error('POST_PUBLISH_MONITOR_PRODUCT_WRITE_FAILED');
  return saved;
}

function recoveryReadinessReasons(product: Product, evidenceValid: boolean, evidenceReasons: string[]): string[] {
  const safe = evaluateSafePublish({ ...product, autoPublishEligible: true, lifecycleState: 'READY_FOR_PUBLISH' });
  const reasons = [...safe.reasons];
  if (!evidenceValid) reasons.push('persisted_evidence_unverified', ...evidenceReasons);
  if (product.recordType !== 'PRODUCT') reasons.push('record_type_not_product');
  if (product.riskLevel !== 'low') reasons.push('risk_not_low');
  if (product.duplicateStatus !== 'CLEAR') reasons.push('duplicate_unresolved');
  if (product.claimValidationStatus !== 'VERIFIED') reasons.push('claim_evidence_unverified');
  if (Number(product.confidences?.publish || 0) < 0.85) reasons.push('publish_confidence_low');
  if (!isReviewIndexable(product)) reasons.push('review_not_indexable');
  return [...new Set(reasons)];
}

async function ensureRepublishChild(job: AutomationJob, product: Product): Promise<string | undefined> {
  const control = await getAutomationControl();
  if (!['CANARY', 'AUTONOMOUS'].includes(control.effectiveMode) || control.publishPaused || control.killSwitch) return undefined;
  const snapshot = readinessSnapshotHash(product);
  const identity = stableToken(product.id);
  const child = await createAutomationJob({
    type: 'AUTO_SAFE_PUBLISH',
    payload: { productId: product.id, readinessSnapshotHash: snapshot, recovery: true },
    idempotencyKey: `republish:${identity}:${job.id}:${snapshot.slice(0, 32)}`.slice(0, 160),
    operationId: `republish:${identity}:${job.id}`.slice(0, 160),
    parentJobId: job.id,
    requestedBy: 'autopilot-worker',
    priority: 90,
  });
  await saveCanonicalProduct(product.id, { relatedJobId: child.job.id });
  return child.job.id;
}

async function hideConfirmedProduct(
  job: AutomationJob,
  workerId: string,
  product: Product,
  result: MonitorProbeResult,
): Promise<{ product: Product; childJobId: string }> {
  let current = product;
  const existingHiddenEvent = await getLifecycleTransitionEvent(monitorKey(job, 'hidden'));
  if (current.lifecycleState === 'HIDDEN' && existingHiddenEvent) {
    // The durable transitions already completed before a worker crash. Rebuild
    // the same result and child key without attempting HIDDEN -> CONFIRMED_BROKEN.
  } else if (current.lifecycleState !== 'CONFIRMED_BROKEN') {
    current = await transitionProduct(current.id, 'CONFIRMED_BROKEN', job, workerId, 'confirmed-broken', ['permanent_failure_confirmed']);
  }
  if (current.lifecycleState !== 'HIDDEN') {
    current = await transitionProduct(current.id, 'HIDDEN', job, workerId, 'hidden', ['confirmed_broken_auto_hide']);
  }
  const checkedAt = stableCheckedAt(job);
  const reason = healthReason(result.statuses);
  const saved = await saveCanonicalProduct(current.id, {
    linkHealthStatus: productStatus(result.statuses.product),
    affiliateHealthStatus: productStatus(result.statuses.affiliate),
    imageHealthStatus: productStatus(result.statuses.image),
    status: 'needs_review',
    publicHidden: true,
    needsVerification: true,
    autoPublished: false,
    autoPublishEligible: false,
    publicDecision: 'quarantined',
    hiddenAt: checkedAt,
    hiddenReason: 'confirmed_broken',
    publicBlockReason: reason,
    publicBlockReasons: [result.statuses.product, result.statuses.affiliate, result.statuses.image, result.statuses.publicPage],
    quarantineReasons: [...new Set([...(current.quarantineReasons || []), 'confirmed_broken'])],
    consecutiveHealthFailures: Math.max(2, Number(current.consecutiveHealthFailures || 0)),
    sourceHealthReason: reason,
    nextAutomaticAction: 'RECHECK_HIDDEN_PRODUCT',
  });
  if (!saved) throw new Error('POST_PUBLISH_MONITOR_HIDE_WRITE_FAILED');
  const childJobId = await scheduleNextMonitor(job, current.id, DAY, sequenceOf(job) + 1, '24h', 'hidden-recheck', true);
  return { product: saved, childJobId };
}

export async function executePostPublishMonitor(job: AutomationJob, workerId: string): Promise<Record<string, unknown>> {
  const productId = typeof job.payload.productId === 'string' ? job.payload.productId : '';
  if (!productId) throw new Error('VALIDATION_PRODUCT_ID_REQUIRED');
  if (!workerId || job.status !== 'RUNNING' || job.claimedBy !== workerId) throw new Error('POST_PUBLISH_MONITOR_DURABLE_CLAIM_REQUIRED');
  let product = await getProductById(productId);
  if (!product) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');

  const checkedAt = stableCheckedAt(job);
  const sequence = sequenceOf(job);
  const startedPublic = product.status === 'published' && product.publicHidden === false;
  const startEvent = await getLifecycleTransitionEvent(monitorKey(job, 'rechecking'));
  const degradedEvent = await getLifecycleTransitionEvent(monitorKey(job, 'degraded'));
  const terminalEvent = degradedEvent
    || await getLifecycleTransitionEvent(monitorKey(job, 'retry-scheduled'))
    || await getLifecycleTransitionEvent(monitorKey(job, 'confirmed-broken'))
    || await getLifecycleTransitionEvent(monitorKey(job, 'healthy-published'))
    || await getLifecycleTransitionEvent(monitorKey(job, 'ready-for-publish'));
  const originState = startEvent?.previousState || degradedEvent?.previousState || product.lifecycleState || 'STAGED';
  const recoveryFlow = ['HIDDEN', 'QUARANTINED'].includes(originState);

  if (product.lifecycleState === 'CONFIRMED_BROKEN') {
    const fallbackStatuses: MonitorStatuses = { product: 'broken', affiliate: 'broken', image: 'image_broken', publicPage: 'not_found' };
    const finalized = await hideConfirmedProduct(job, workerId, product, {
      outcome: 'CONFIRMED_BROKEN', statuses: fallbackStatuses, externalRequests: 0,
      selectedProductUrl: String(product.originalUrl || ''), selectedAffiliateUrl: String(product.affiliateUrl || ''),
      selectedImageUrl: String(product.imageUrl || ''), publicPageUrl: configuredPublicPageUrl(product).url,
    });
    return {
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'local',
      outcome: 'CONFIRMED_BROKEN', hidden: true, childJobId: finalized.childJobId,
      statuses: fallbackStatuses, rulesVersion: RULES_VERSION, aiRequests: 0, externalRequests: 0,
    };
  }

  if (!startEvent && !terminalEvent && ['DEGRADED', 'HIDDEN', 'QUARANTINED', 'RETRY_SCHEDULED'].includes(String(product.lifecycleState))) {
    product = await transitionProduct(productId, 'RECHECKING', job, workerId, 'rechecking', ['scheduled_health_recheck']);
  }

  const priorPermanentFailure = PERMANENT_REASON.test(String(product.sourceHealthReason || ''));
  const probeResult = await probe(job, product, startedPublic && !recoveryFlow);
  product = await persistObservation(product, probeResult, checkedAt, job.id);
  const reason = healthReason(probeResult.statuses);

  if (probeResult.outcome === 'HEALTHY') {
    product = (await saveCanonicalProduct(productId, {
      linkHealthStatus: productStatus(probeResult.statuses.product),
      affiliateHealthStatus: productStatus(probeResult.statuses.affiliate),
      imageHealthStatus: productStatus(probeResult.statuses.image),
      consecutiveHealthFailures: 0,
      lastHealthyAt: checkedAt,
      sourceHealthReason: undefined,
      sourceHealthCooldownUntil: undefined,
      nextRetryAt: undefined,
    })) || product;

    if (recoveryFlow) {
      const evidence = await verifyAutonomousPublishEvidence(product, Date.parse(checkedAt));
      const readinessReasons = recoveryReadinessReasons(product, evidence.valid, evidence.reasons);
      if (readinessReasons.length) {
        product = await transitionProduct(productId, 'QUARANTINED', job, workerId, 'quarantined', readinessReasons);
        await saveCanonicalProduct(productId, {
          status: 'needs_review', publicHidden: true, needsVerification: true, autoPublished: false,
          autoPublishEligible: false, publicDecision: 'quarantined', quarantineReasons: readinessReasons,
          nextAutomaticAction: 'RECHECK_QUARANTINED_PRODUCT',
        });
        const childJobId = await scheduleNextMonitor(job, productId, DAY, sequence + 1, '24h', 'quarantine-recheck', true);
        return {
          executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'local',
          outcome: 'HEALTHY', recovered: false, quarantined: true, readinessReasons, childJobId,
          statuses: probeResult.statuses, rulesVersion: RULES_VERSION, evidenceCoverage: evidence.coverage,
          aiRequests: 0, externalRequests: probeResult.externalRequests,
        };
      }
      product = await transitionProduct(productId, 'READY_FOR_PUBLISH', job, workerId, 'ready-for-publish', ['hidden_product_health_and_evidence_recovered']);
      product = (await saveCanonicalProduct(productId, {
        status: 'needs_review', publicHidden: true, needsVerification: false, autoPublished: false,
        autoPublishEligible: true, publicDecision: 'ready_for_publish', hiddenReason: undefined,
        publicBlockReason: undefined, publicBlockReasons: [], quarantineReasons: [],
        nextAutomaticAction: 'AUTO_SAFE_PUBLISH', nextRetryAt: undefined,
      })) || product;
      const childJobId = await ensureRepublishChild(job, product);
      return {
        executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'local',
        outcome: 'HEALTHY', recovered: true, childJobId, statuses: probeResult.statuses,
        rulesVersion: RULES_VERSION, evidenceCoverage: evidence.coverage,
        aiRequests: 0, externalRequests: probeResult.externalRequests,
      };
    }

    if (product.lifecycleState === 'RECHECKING' || await getLifecycleTransitionEvent(monitorKey(job, 'healthy-published'))) {
      product = await transitionProduct(productId, 'PUBLISHED', job, workerId, 'healthy-published', ['post_publish_health_recovered']);
    }
    await saveCanonicalProduct(productId, {
      status: 'published', publicHidden: false, needsVerification: false, autoPublished: true,
      publicDecision: 'published', hiddenReason: undefined, publicBlockReason: undefined, publicBlockReasons: [],
      nextAutomaticAction: 'POST_PUBLISH_MONITOR',
    });
    const interval = sequence === 0 ? '6h' : sequence === 1 ? '24h' : 'periodic';
    const delay = sequence === 0 ? 6 * HOUR : DAY;
    const childJobId = await scheduleNextMonitor(job, productId, delay, sequence + 1, interval, 'periodic', false);
    return {
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'local',
      outcome: 'HEALTHY', recovered: false, childJobId, statuses: probeResult.statuses,
      rulesVersion: RULES_VERSION, aiRequests: 0, externalRequests: probeResult.externalRequests,
    };
  }

  const failures = terminalEvent
    ? Math.max(1, Number(product.consecutiveHealthFailures || 0))
    : Math.max(0, Number(product.consecutiveHealthFailures || 0)) + 1;
  const retainPublic = startedPublic && !recoveryFlow;
  await saveCanonicalProduct(productId, {
    consecutiveHealthFailures: failures,
    sourceHealthReason: reason,
    status: retainPublic ? 'published' : 'needs_review',
    publicHidden: !retainPublic,
    needsVerification: !retainPublic,
    autoPublished: retainPublic,
    nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH',
  });

  const firstPublicFailure = originState === 'PUBLISHED' || Boolean(degradedEvent);
  const repeatedPermanent = probeResult.outcome === 'CONFIRMED_BROKEN'
    && priorPermanentFailure
    && !degradedEvent
    && !firstPublicFailure;
  if (probeResult.outcome === 'CONFIRMED_BROKEN' && repeatedPermanent) {
    const hidden = await hideConfirmedProduct(job, workerId, product, probeResult);
    return {
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'local',
      outcome: 'CONFIRMED_BROKEN', hidden: true, childJobId: hidden.childJobId,
      statuses: probeResult.statuses, rulesVersion: RULES_VERSION,
      aiRequests: 0, externalRequests: probeResult.externalRequests,
    };
  }

  if (firstPublicFailure) {
    product = await transitionProduct(productId, 'DEGRADED', job, workerId, 'degraded', [
      probeResult.outcome === 'CONFIRMED_BROKEN' ? 'permanent_failure_requires_confirmation' : 'temporary_post_publish_failure',
    ]);
  } else {
    product = await transitionProduct(productId, 'RETRY_SCHEDULED', job, workerId, 'retry-scheduled', [
      probeResult.outcome === 'CONFIRMED_BROKEN' ? 'permanent_failure_requires_confirmation' : 'temporary_health_failure',
    ]);
  }
  const permanentConfirmation = probeResult.outcome === 'CONFIRMED_BROKEN';
  const delay = permanentConfirmation ? 15 * MINUTE : Math.min(6 * HOUR, 15 * MINUTE * 2 ** Math.min(4, failures - 1));
  const childJobId = await scheduleNextMonitor(
    job, productId, delay, sequence + 1, delay >= 6 * HOUR ? '6h' : '15m',
    permanentConfirmation ? 'broken-confirmation' : 'temporary-retry', true,
  );
  return {
    executionStatus: 'COMPLETED_WITH_LOCAL_RULES', executionMode: 'LOCAL_RULES', provider: 'local',
    outcome: probeResult.outcome, retainedPublic: retainPublic, childJobId,
    statuses: probeResult.statuses, rulesVersion: RULES_VERSION,
    aiRequests: 0, externalRequests: probeResult.externalRequests,
  };
}
