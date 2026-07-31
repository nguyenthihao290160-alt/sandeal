import { getGeminiProviderReadiness, type GeminiProviderReadiness } from '@/lib/ai/geminiProviderStatus';
import {
  createDefaultSourceAdapterRegistry,
  type SourceHealth,
} from '@/lib/autonomous/sourceAdapterPlatform';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { readBoundedCollectionSnapshot } from '@/lib/storage/adapter';
import type { CandidateQueueItem } from '@/lib/storage/candidateQueue';
import type { Product } from '@/lib/types';
import {
  AUTOMATION_JOB_PROJECTION_VERSION,
  readBoundedAutomationJobStatuses,
  type AutomationJobHealthView,
  type BoundedAutomationJobStatusRead,
  type ProjectionEvidenceClassification,
} from './jobHealthSummary';
import { getAutomationControl } from './store';
import type {
  AutomationControlState,
  AutomationJobStatus,
  AutomationJobStatusProjection,
  AutomationJobType,
} from './types';

export const PRODUCT_FLOW_DIAGNOSTIC_VERSION = 'product-flow-diagnostic-v1';
const CURRENT_STATE_MAXIMUM_ITEMS = 5_000;
const CURRENT_STATE_MAXIMUM_BYTES = 32 * 1_024 * 1_024;
const RECENT_WINDOW_MS = 24 * 60 * 60_000;
const STALE_PROJECTION_MS = 24 * 60 * 60_000;
const MAX_TOP_REASONS = 10;

export type EmptyHomepageClassification =
  | 'NO_SOURCE_INGESTION'
  | 'SOURCE_NOT_READY'
  | 'NO_CANDIDATES'
  | 'CANDIDATES_WAITING'
  | 'CANDIDATE_PROCESSING_FAILED'
  | 'PRODUCTS_MISSING_EVIDENCE'
  | 'PRODUCTS_QUARANTINED'
  | 'PRODUCTS_REQUIRE_RECHECK'
  | 'PRODUCTS_ELIGIBLE_RUNTIME_BLOCKED'
  | 'PRODUCTS_ELIGIBLE_POLICY_BLOCKED'
  | 'NO_PRODUCT_MEETS_PUBLIC_ELIGIBILITY'
  | 'PUBLIC_PROJECTION_MISMATCH'
  | 'UNKNOWN_INCOMPLETE_DATA';

export const EMPTY_HOMEPAGE_LABELS_VI: Readonly<Record<EmptyHomepageClassification, string>> = {
  NO_SOURCE_INGESTION: 'Chưa ghi nhận lần nạp dữ liệu nguồn nào.',
  SOURCE_NOT_READY: 'Nguồn sản phẩm chưa sẵn sàng.',
  NO_CANDIDATES: 'Chưa có ứng viên sản phẩm.',
  CANDIDATES_WAITING: 'Ứng viên đang chờ hoặc đang được xử lý.',
  CANDIDATE_PROCESSING_FAILED: 'Xử lý ứng viên gần đây bị lỗi.',
  PRODUCTS_MISSING_EVIDENCE: 'Sản phẩm còn thiếu bằng chứng bắt buộc.',
  PRODUCTS_QUARANTINED: 'Sản phẩm đang bị cách ly.',
  PRODUCTS_REQUIRE_RECHECK: 'Sản phẩm cần được kiểm tra lại.',
  PRODUCTS_ELIGIBLE_RUNTIME_BLOCKED: 'Có sản phẩm đủ điều kiện nhưng runtime đang chặn xuất bản.',
  PRODUCTS_ELIGIBLE_POLICY_BLOCKED: 'Có sản phẩm bị chính sách chặn xuất bản.',
  NO_PRODUCT_MEETS_PUBLIC_ELIGIBILITY: 'Chưa có sản phẩm đáp ứng đầy đủ điều kiện công khai.',
  PUBLIC_PROJECTION_MISMATCH: 'Trạng thái sản phẩm và phép chiếu công khai không khớp.',
  UNKNOWN_INCOMPLETE_DATA: 'Chưa đủ dữ liệu để xác định nguyên nhân.',
};

export interface BoundedCurrentStateRead<T> {
  items: T[];
  complete: boolean;
  collectionPresent: boolean;
  reasonCodes: string[];
}

export interface ProductFlowJobReference {
  id: string;
  type: AutomationJobType;
  status: AutomationJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastErrorCode: string | null;
}

export interface ProductFlowDiagnostics {
  generatedAt: string;
  projectionVersion: typeof PRODUCT_FLOW_DIAGNOSTIC_VERSION;
  jobProjectionVersion: typeof AUTOMATION_JOB_PROJECTION_VERSION | null;
  completeness: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
  stale: boolean;
  reasonCodes: string[];
  currentState: {
    totalCanonicalProducts: number | null;
    totalActiveCandidates: number | null;
    totalRecentCandidates: number | null;
    totalPublishedProducts: number | null;
    totalPubliclyProjectedProducts: number | null;
    productsEligibleExceptForRuntimeBlocking: number | null;
    productsBlockedByMissingEvidence: number | null;
    productsBlockedByProductPolicy: number | null;
    productsQuarantined: number | null;
    productsRequiringRecheck: number | null;
    productsRequiringManualInput: number | null;
    productsWithPermanentBlockers: number | null;
    publicProjectionMismatchCount: number | null;
  };
  recentHistory: {
    windowStartedAt: string;
    windowEndedAt: string;
    latestSourceIngestionJob: ProductFlowJobReference | null;
    recentSourceIngestionSuccessCount: number | null;
    recentSourceIngestionFailureCount: number | null;
    latestCandidateProcessingJob: ProductFlowJobReference | null;
    recentCandidateProcessingSuccessCount: number | null;
    recentCandidateProcessingFailureCount: number | null;
    latestEligibilityEvaluation: {
      productId: string;
      evaluatedAt: string;
      eligibleForPublish: boolean;
      eligibleForPublic: boolean;
      blockerReasonCodes: string[];
    } | null;
    latestRealPublicationAttempt: ProductFlowJobReference | null;
    latestBlockedPublicationDecision: {
      productId: string;
      jobId: string;
      recordedAt: string;
      reasonCodes: string[];
      runtimeReasonCodes: string[];
      productReasonCodes: string[];
    } | null;
    latestRealPublication: {
      productId: string;
      publishedAt: string;
      status: Product['status'];
      lifecycleState: Product['lifecycleState'] | null;
    } | null;
    latestPostPublishMonitor: ProductFlowJobReference | null;
  };
  blockers: {
    topProductBlockerReasonCodes: Array<{ reasonCode: string; count: number }>;
    topMissingEvidenceFields: Array<{ field: string; count: number }>;
  };
  sourceReadiness: {
    status: SourceHealth['status'];
    configured: boolean;
    ready: boolean;
    reasonCode: string;
    checkedAt: string | null;
  };
  accessTradeReadinessReason: string;
  aiReadiness: {
    status: GeminiProviderReadiness['status'];
    configured: boolean;
    ready: boolean;
    reasonCode: GeminiProviderReadiness['reason'];
  };
  runtimePublishingBlocked: boolean;
  rechecks: {
    awaitingExecution: number | null;
    duplicateSuppressed: number | null;
  };
  emptyHomepage: {
    classification: EmptyHomepageClassification;
    labelVi: string;
  };
  evidence: {
    productState: {
      complete: boolean;
      collectionPresent: boolean;
      reasonCodes: string[];
    };
    candidateState: {
      complete: boolean;
      collectionPresent: boolean;
      reasonCodes: string[];
    };
    jobHistory: {
      classification: ProjectionEvidenceClassification;
      currentStateComplete: boolean;
      historyComplete: boolean;
      reasonCodes: string[];
    };
  };
}

export interface ProductFlowDiagnosticInputs {
  products: BoundedCurrentStateRead<Product>;
  candidates: BoundedCurrentStateRead<CandidateQueueItem>;
  jobs: BoundedAutomationJobStatusRead;
  sourceHealth: SourceHealth;
  aiReadiness: GeminiProviderReadiness;
  control: AutomationControlState;
}

function parsed(value: string | undefined): number | null {
  const result = Date.parse(value || '');
  return Number.isFinite(result) ? result : null;
}

function latest<T>(items: T[], timestamp: (item: T) => string | undefined): T | null {
  return [...items].sort((left, right) => {
    const difference = (parsed(timestamp(right)) ?? -1) - (parsed(timestamp(left)) ?? -1);
    return difference || JSON.stringify(left).localeCompare(JSON.stringify(right));
  })[0] || null;
}

function safeReasonCode(value: unknown, fallback: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Z0-9_:-]/gi, '_')
    .toUpperCase()
    .slice(0, 120);
  return normalized || fallback;
}

function sourceReasonCode(health: SourceHealth): string {
  if (!health.configured || health.status === 'not_configured') return 'ACCESS_TRADE_NOT_CONFIGURED';
  if (health.ready && health.status === 'ready') return 'ACCESS_TRADE_READY';
  const reason = safeReasonCode(health.reason, '');
  if (reason === 'LIVE_PROBE_NOT_RUN') return 'ACCESS_TRADE_LIVE_PROBE_NOT_RUN';
  if (reason === 'HEALTH_PROBE_UNAVAILABLE') return 'ACCESS_TRADE_HEALTH_PROBE_UNAVAILABLE';
  if (reason === 'HEALTH_PROBE_FAILED') return 'ACCESS_TRADE_HEALTH_PROBE_FAILED';
  return `ACCESS_TRADE_${safeReasonCode(health.status, 'NOT_READY')}`;
}

function jobReference(job: AutomationJobStatusProjection | null): ProductFlowJobReference | null {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || null,
    lastErrorCode: job.lastErrorCode || null,
  };
}

function countReasons(values: Iterable<string>): Array<{ reasonCode: string; count: number }> {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const reasonCode = safeReasonCode(raw, 'UNSPECIFIED_BLOCKER');
    counts.set(reasonCode, (counts.get(reasonCode) || 0) + 1);
  }
  return [...counts]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((left, right) => right.count - left.count || left.reasonCode.localeCompare(right.reasonCode))
    .slice(0, MAX_TOP_REASONS);
}

function missingEvidenceFields(product: Product): string[] {
  const missing: string[] = [];
  if (!product.source || product.source === 'other') missing.push('source');
  if (!String(product.canonicalProductUrl || product.originalUrl || '').trim()) missing.push('canonicalProductUrl');
  if (!String(product.affiliateUrl || '').trim()) missing.push('affiliateUrl');
  if (!String(product.imageUrl || '').trim()) missing.push('imageUrl');
  if (!(Number(product.salePrice || product.price) > 0)) missing.push('price');
  if (product.verifiedSource !== true && product.sourceVerified !== true) missing.push('sourceVerification');
  if (!['ok', 'healthy', 'redirect_ok', 'redirected'].includes(String(product.linkHealthStatus || product.productHealthStatus || ''))) {
    missing.push('linkHealth');
  }
  if (!['ok', 'healthy', 'redirect_ok', 'redirected'].includes(String(product.affiliateHealthStatus || ''))) {
    missing.push('affiliateHealth');
  }
  if (!['ok', 'healthy'].includes(String(product.imageHealthStatus || ''))) missing.push('imageHealth');
  if (!product.eligibility) missing.push('eligibility');
  if (!product.reviewContent || product.reviewContent.reviewStatus !== 'approved') missing.push('approvedReview');
  return [...new Set(missing)];
}

function productReasonCodes(product: Product, missing: string[]): string[] {
  const stored = [
    ...(product.currentBlockers || []).map(blocker => blocker.code),
    ...(product.publicBlockReasons || []),
    ...(product.eligibility?.criticalBlockers || []),
    ...(product.quarantineReasons || []),
    ...(product.publicBlockReason ? [product.publicBlockReason] : []),
  ];
  return [...new Set([
    ...stored.map(reason => safeReasonCode(reason, 'UNSPECIFIED_BLOCKER')),
    ...missing.map(field => `MISSING_${safeReasonCode(field, 'EVIDENCE')}`),
  ])];
}

function isQuarantined(product: Product): boolean {
  return product.lifecycleState === 'QUARANTINED'
    || product.publicDecision === 'quarantined'
    || Boolean(product.quarantineReasons?.length);
}

function isPermanentBlocker(product: Product): boolean {
  return product.status === 'archived'
    || product.lifecycleState === 'CONFIRMED_BROKEN'
    || Boolean(product.archivedReason)
    || (product.recordType !== undefined && product.recordType !== 'PRODUCT')
    || product.eligibility?.criticalBlockers.some(reason =>
      /prohibited|permanent|confirmed_broken|invalid_product_kind|non_product/i.test(reason)) === true;
}

function requiresManualInput(product: Product): boolean {
  return product.status === 'needs_review'
    || /manual|human|operator|review/i.test(String(product.nextAutomaticAction || ''))
    || product.eligibility?.criticalBlockers.some(reason => /manual|human_review|compliance/i.test(reason)) === true;
}

function requiresRecheck(product: Product): boolean {
  return !isPermanentBlocker(product)
    && !requiresManualInput(product)
    && (
      /recheck|verify|retry/i.test(String(product.nextAutomaticAction || ''))
      || product.lifecycleState === 'RETRY_SCHEDULED'
      || Boolean(product.nextRetryAt)
    );
}

function isProductPolicyBlocked(product: Product): boolean {
  return (product.currentBlockers || []).some(blocker => blocker.category === 'POLICY')
    || product.eligibility?.criticalBlockers.some(reason =>
      /policy|compliance|prohibited|human_review|merchant|quarantine/i.test(reason)) === true;
}

function publicationEligible(product: Product): boolean {
  return product.recordType === 'PRODUCT'
    && product.eligibility?.eligibleForPublish === true
    && product.eligibility?.eligibleForPublic === true
    && !isQuarantined(product)
    && !isPermanentBlocker(product)
    && !isProductPolicyBlocked(product);
}

function publicationProjectionMismatch(product: Product): boolean {
  return product.status === 'published'
    && product.publicHidden === false
    && product.eligibility?.eligibleForPublic === true
    && !isPublicSafeProduct(product);
}

function recentJobs(
  jobs: AutomationJobStatusProjection[],
  types: ReadonlySet<AutomationJobType>,
  windowStartedAt: number,
): AutomationJobStatusProjection[] {
  return jobs.filter(job =>
    types.has(job.type)
    && job.dryRun !== true
    && (parsed(job.updatedAt) ?? -1) >= windowStartedAt);
}

function classifyEmptyHomepage(input: {
  complete: boolean;
  sourceReady: boolean;
  sourceJobKnown: boolean;
  totalProducts: number;
  totalCandidates: number;
  activeCandidates: number;
  candidateSuccesses: number;
  candidateFailures: number;
  missingEvidence: number;
  quarantined: number;
  recheck: number;
  runtimeEligible: number;
  policyBlocked: number;
  projectionMismatch: number;
}): EmptyHomepageClassification {
  if (!input.complete) return 'UNKNOWN_INCOMPLETE_DATA';
  if (input.projectionMismatch > 0) return 'PUBLIC_PROJECTION_MISMATCH';
  if (!input.sourceReady && input.totalProducts === 0 && input.totalCandidates === 0) return 'SOURCE_NOT_READY';
  if (!input.sourceJobKnown && input.totalProducts === 0 && input.totalCandidates === 0) return 'NO_SOURCE_INGESTION';
  if (input.totalCandidates === 0 && input.totalProducts === 0) return 'NO_CANDIDATES';
  if (input.activeCandidates > 0) return 'CANDIDATES_WAITING';
  if (input.candidateFailures > 0 && input.candidateSuccesses === 0 && input.totalProducts === 0) {
    return 'CANDIDATE_PROCESSING_FAILED';
  }
  if (input.runtimeEligible > 0) return 'PRODUCTS_ELIGIBLE_RUNTIME_BLOCKED';
  if (input.missingEvidence > 0) return 'PRODUCTS_MISSING_EVIDENCE';
  if (input.quarantined > 0) return 'PRODUCTS_QUARANTINED';
  if (input.recheck > 0) return 'PRODUCTS_REQUIRE_RECHECK';
  if (input.policyBlocked > 0) return 'PRODUCTS_ELIGIBLE_POLICY_BLOCKED';
  return 'NO_PRODUCT_MEETS_PUBLIC_ELIGIBILITY';
}

export function deriveProductFlowDiagnostics(
  input: ProductFlowDiagnosticInputs,
  now = Date.now(),
): ProductFlowDiagnostics {
  const generatedAt = new Date(now).toISOString();
  const windowStartedAtMs = now - RECENT_WINDOW_MS;
  const windowStartedAt = new Date(windowStartedAtMs).toISOString();
  const productsComplete = input.products.complete;
  const candidatesComplete = input.candidates.complete;
  const jobsCurrentComplete = input.jobs.currentStateComplete;
  const retainedHistoryBoundary = parsed(
    input.jobs.retentionBoundary?.oldestRetainedAt
      || input.jobs.observedRange.earliestUpdatedAt
      || undefined,
  );
  const recentJobHistoryComplete = input.jobs.historyComplete
    || (retainedHistoryBoundary !== null && retainedHistoryBoundary <= windowStartedAtMs);
  const allComplete = productsComplete && candidatesComplete && jobsCurrentComplete && recentJobHistoryComplete;
  const anyKnown = productsComplete || candidatesComplete || jobsCurrentComplete;
  const completeness: ProductFlowDiagnostics['completeness'] = allComplete
    ? 'COMPLETE'
    : anyKnown ? 'PARTIAL' : 'UNKNOWN';

  const products = productsComplete ? input.products.items : [];
  const candidates = candidatesComplete ? input.candidates.items : [];
  const jobs = jobsCurrentComplete ? input.jobs.items : [];
  const sourceTypes = new Set<AutomationJobType>(['AUTO_PILOT', 'PRODUCT_SCAN']);
  const candidateTypes = new Set<AutomationJobType>(['PROCESS_CANDIDATE']);
  const publicationTypes = new Set<AutomationJobType>(['AUTO_SAFE_PUBLISH', 'SAFE_PUBLISH']);
  const monitorTypes = new Set<AutomationJobType>(['POST_PUBLISH_MONITOR']);
  const sourceJobs = jobs.filter(job => sourceTypes.has(job.type) && job.dryRun !== true);
  const candidateJobs = jobs.filter(job => candidateTypes.has(job.type) && job.dryRun !== true);
  const publicationJobs = jobs.filter(job => publicationTypes.has(job.type) && job.dryRun !== true);
  const monitorJobs = jobs.filter(job => monitorTypes.has(job.type) && job.dryRun !== true);
  const recentSourceJobs = recentJobs(jobs, sourceTypes, windowStartedAtMs);
  const recentCandidateJobs = recentJobs(jobs, candidateTypes, windowStartedAtMs);
  const activeCandidateStatuses = new Set(['pending', 'processing', 'delayed']);
  const activeCandidates = candidates.filter(candidate => activeCandidateStatuses.has(candidate.status));
  const recentCandidates = candidates.filter(candidate => (parsed(candidate.createdAt) ?? -1) >= windowStartedAtMs);
  const missingByProduct = products.map(product => ({ product, fields: missingEvidenceFields(product) }));
  const productsMissingEvidence = missingByProduct.filter(entry => entry.fields.length > 0);
  const quarantinedProducts = products.filter(isQuarantined);
  const recheckProducts = products.filter(requiresRecheck);
  const manualProducts = products.filter(requiresManualInput);
  const permanentlyBlockedProducts = products.filter(isPermanentBlocker);
  const policyBlockedProducts = products.filter(isProductPolicyBlocked);
  const eligibleProducts = missingByProduct
    .filter(entry => entry.fields.length === 0 && publicationEligible(entry.product))
    .map(entry => entry.product);
  const publiclyProjectedProducts = products.filter(isPublicSafeProduct);
  const publishedProducts = products.filter(product => product.status === 'published' || product.lifecycleState === 'PUBLISHED');
  const projectionMismatches = products.filter(publicationProjectionMismatch);
  const latestEligibilityProduct = latest(
    products.filter(product => Boolean(product.eligibility?.evaluatedAt)),
    product => product.eligibility?.evaluatedAt,
  );
  const blockedPublicationProduct = latest(
    products.filter(product => Boolean(product.lastBlockedPublicationDecision?.recordedAt)),
    product => product.lastBlockedPublicationDecision?.recordedAt,
  );
  const latestPublishedProduct = latest(
    products.filter(product => Boolean(product.publishedAt)),
    product => product.publishedAt,
  );
  const blockerReasons = missingByProduct.flatMap(({ product, fields }) => productReasonCodes(product, fields));
  const missingFields = missingByProduct.flatMap(entry => entry.fields);
  const currentRechecks = jobs.filter(job =>
    job.type === 'RECHECK_PRODUCT_HEALTH'
    && ['PENDING', 'RUNNING', 'RETRY_SCHEDULED'].includes(job.status));
  const recentReconciler = latest(
    jobs.filter(job => job.type === 'RECONCILE_AUTOMATION' && job.status === 'SUCCEEDED'),
    job => job.completedAt || job.updatedAt,
  );
  const duplicateSuppressedValue = Number(recentReconciler?.result?.duplicateRechecksSuppressed);
  const duplicateSuppressed = Number.isInteger(duplicateSuppressedValue) && duplicateSuppressedValue >= 0
    ? duplicateSuppressedValue
    : null;
  const sourceReason = sourceReasonCode(input.sourceHealth);
  const candidateSuccessCount = recentCandidateJobs.filter(job => job.status === 'SUCCEEDED').length;
  const candidateFailureCount = recentCandidateJobs.filter(job =>
    ['FAILED', 'BLOCKED', 'CANCELLED'].includes(job.status)).length;
  const classification = classifyEmptyHomepage({
    complete: allComplete,
    sourceReady: input.sourceHealth.ready,
    sourceJobKnown: sourceJobs.length > 0,
    totalProducts: products.length,
    totalCandidates: candidates.length,
    activeCandidates: activeCandidates.length,
    candidateSuccesses: candidateSuccessCount,
    candidateFailures: candidateFailureCount,
    missingEvidence: productsMissingEvidence.length,
    quarantined: quarantinedProducts.length,
    recheck: recheckProducts.length,
    runtimeEligible: input.control.publishBlockedByRuntime ? eligibleProducts.length : 0,
    policyBlocked: policyBlockedProducts.length,
    projectionMismatch: projectionMismatches.length,
  });
  const manifestUpdatedAt = parsed(input.jobs.manifestUpdatedAt || undefined);
  const stale = input.jobs.reasonCodes.includes('PRODUCT_FLOW_JOB_PROJECTION_STALE')
    || (manifestUpdatedAt !== null && now - manifestUpdatedAt > STALE_PROJECTION_MS);
  const unknownProductCount = productsComplete ? undefined : null;
  const unknownCandidateCount = candidatesComplete ? undefined : null;
  const unknownJobCount = jobsCurrentComplete && recentJobHistoryComplete ? undefined : null;
  const countOrUnknown = (count: number, unknown: null | undefined): number | null => unknown === null ? null : count;
  const latestBlocked = blockedPublicationProduct?.lastBlockedPublicationDecision;

  return {
    generatedAt,
    projectionVersion: PRODUCT_FLOW_DIAGNOSTIC_VERSION,
    jobProjectionVersion: input.jobs.projectionVersion,
    completeness,
    stale,
    reasonCodes: [...new Set([
      ...input.products.reasonCodes,
      ...input.candidates.reasonCodes,
      ...input.jobs.reasonCodes,
      ...(stale ? ['PRODUCT_FLOW_JOB_PROJECTION_STALE'] : []),
    ])].sort(),
    currentState: {
      totalCanonicalProducts: countOrUnknown(products.length, unknownProductCount),
      totalActiveCandidates: countOrUnknown(activeCandidates.length, unknownCandidateCount),
      totalRecentCandidates: countOrUnknown(recentCandidates.length, unknownCandidateCount),
      totalPublishedProducts: countOrUnknown(publishedProducts.length, unknownProductCount),
      totalPubliclyProjectedProducts: countOrUnknown(publiclyProjectedProducts.length, unknownProductCount),
      productsEligibleExceptForRuntimeBlocking: countOrUnknown(eligibleProducts.length, unknownProductCount),
      productsBlockedByMissingEvidence: countOrUnknown(productsMissingEvidence.length, unknownProductCount),
      productsBlockedByProductPolicy: countOrUnknown(policyBlockedProducts.length, unknownProductCount),
      productsQuarantined: countOrUnknown(quarantinedProducts.length, unknownProductCount),
      productsRequiringRecheck: countOrUnknown(recheckProducts.length, unknownProductCount),
      productsRequiringManualInput: countOrUnknown(manualProducts.length, unknownProductCount),
      productsWithPermanentBlockers: countOrUnknown(permanentlyBlockedProducts.length, unknownProductCount),
      publicProjectionMismatchCount: countOrUnknown(projectionMismatches.length, unknownProductCount),
    },
    recentHistory: {
      windowStartedAt,
      windowEndedAt: generatedAt,
      latestSourceIngestionJob: jobsCurrentComplete ? jobReference(latest(sourceJobs, job => job.updatedAt)) : null,
      recentSourceIngestionSuccessCount: countOrUnknown(
        recentSourceJobs.filter(job => job.status === 'SUCCEEDED').length,
        unknownJobCount,
      ),
      recentSourceIngestionFailureCount: countOrUnknown(
        recentSourceJobs.filter(job => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(job.status)).length,
        unknownJobCount,
      ),
      latestCandidateProcessingJob: jobsCurrentComplete ? jobReference(latest(candidateJobs, job => job.updatedAt)) : null,
      recentCandidateProcessingSuccessCount: countOrUnknown(candidateSuccessCount, unknownJobCount),
      recentCandidateProcessingFailureCount: countOrUnknown(candidateFailureCount, unknownJobCount),
      latestEligibilityEvaluation: latestEligibilityProduct?.eligibility
        ? {
            productId: latestEligibilityProduct.id,
            evaluatedAt: latestEligibilityProduct.eligibility.evaluatedAt,
            eligibleForPublish: latestEligibilityProduct.eligibility.eligibleForPublish,
            eligibleForPublic: latestEligibilityProduct.eligibility.eligibleForPublic,
            blockerReasonCodes: latestEligibilityProduct.eligibility.criticalBlockers
              .map(reason => safeReasonCode(reason, 'UNSPECIFIED_BLOCKER'))
              .slice(0, MAX_TOP_REASONS),
          }
        : null,
      latestRealPublicationAttempt: jobsCurrentComplete
        ? jobReference(latest(publicationJobs, job => job.updatedAt))
        : null,
      latestBlockedPublicationDecision: latestBlocked && blockedPublicationProduct
        ? {
            productId: blockedPublicationProduct.id,
            jobId: latestBlocked.jobId,
            recordedAt: latestBlocked.recordedAt,
            reasonCodes: latestBlocked.reasonCodes.slice(0, MAX_TOP_REASONS),
            runtimeReasonCodes: latestBlocked.runtimeReasonCodes.slice(0, MAX_TOP_REASONS),
            productReasonCodes: latestBlocked.productReasonCodes.slice(0, MAX_TOP_REASONS),
          }
        : null,
      latestRealPublication: latestPublishedProduct?.publishedAt
        ? {
            productId: latestPublishedProduct.id,
            publishedAt: latestPublishedProduct.publishedAt,
            status: latestPublishedProduct.status,
            lifecycleState: latestPublishedProduct.lifecycleState || null,
          }
        : null,
      latestPostPublishMonitor: jobsCurrentComplete
        ? jobReference(latest(monitorJobs, job => job.updatedAt))
        : null,
    },
    blockers: {
      topProductBlockerReasonCodes: countReasons(blockerReasons),
      topMissingEvidenceFields: countReasons(missingFields).map(item => ({
        field: item.reasonCode.toLowerCase(),
        count: item.count,
      })),
    },
    sourceReadiness: {
      status: input.sourceHealth.status,
      configured: input.sourceHealth.configured,
      ready: input.sourceHealth.ready,
      reasonCode: sourceReason,
      checkedAt: input.sourceHealth.checkedAt || null,
    },
    accessTradeReadinessReason: sourceReason,
    aiReadiness: {
      status: input.aiReadiness.status,
      configured: input.aiReadiness.configured,
      ready: input.aiReadiness.productionReadyConnections > 0,
      reasonCode: input.aiReadiness.reason,
    },
    runtimePublishingBlocked: input.control.publishBlockedByRuntime === true,
    rechecks: {
      awaitingExecution: jobsCurrentComplete ? currentRechecks.length : null,
      duplicateSuppressed,
    },
    emptyHomepage: {
      classification,
      labelVi: EMPTY_HOMEPAGE_LABELS_VI[classification],
    },
    evidence: {
      productState: {
        complete: productsComplete,
        collectionPresent: input.products.collectionPresent,
        reasonCodes: input.products.reasonCodes,
      },
      candidateState: {
        complete: candidatesComplete,
        collectionPresent: input.candidates.collectionPresent,
        reasonCodes: input.candidates.reasonCodes,
      },
      jobHistory: {
        classification: input.jobs.evidenceClassification,
        currentStateComplete: input.jobs.currentStateComplete,
        historyComplete: input.jobs.historyComplete,
        reasonCodes: input.jobs.reasonCodes,
      },
    },
  };
}

async function boundedCurrentState<T>(
  collection: string,
  unavailableReason: string,
): Promise<BoundedCurrentStateRead<T>> {
  try {
    const snapshot = await readBoundedCollectionSnapshot<T>(collection, {
      maximumItems: CURRENT_STATE_MAXIMUM_ITEMS,
      maximumBytes: CURRENT_STATE_MAXIMUM_BYTES,
    });
    return {
      items: snapshot.items,
      complete: true,
      collectionPresent: snapshot.metadata.collectionPresent,
      reasonCodes: [],
    };
  } catch (error) {
    const boundExceeded = error instanceof Error && /LIMIT_EXCEEDED|BOUND/i.test(error.message);
    return {
      items: [],
      complete: false,
      collectionPresent: false,
      reasonCodes: [boundExceeded ? `${unavailableReason}_BOUND_EXCEEDED` : `${unavailableReason}_UNAVAILABLE`],
    };
  }
}

function unavailableJobReadFromProjectionStatus(
  status: AutomationJobHealthView,
): BoundedAutomationJobStatusRead {
  return {
    items: [],
    availability: status.projectionStatus === 'UNKNOWN' ? 'UNAVAILABLE' : 'DEGRADED',
    reasonCodes: [...new Set([
      ...status.reasonCodes.map(code => code.replace(/^JOB_PROJECTION_/, 'JOB_STATUS_PROJECTION_')),
      'JOB_STATUS_PROJECTION_CURRENT_STATE_INCOMPLETE',
    ])],
    evidenceClassification: status.projectionStatus === 'UNKNOWN' ? 'UNAVAILABLE' : 'INCOMPLETE',
    source: 'job-status-projection-v1',
    collectionPresent: status.collectionPresent,
    currentStateComplete: false,
    historyComplete: false,
    truncated: status.truncated,
    observedRange: status.observedRange,
    retentionBoundary: status.retentionBoundary,
    manifestRebuiltAt: status.projectionEvidence.manifestRebuiltAt,
    manifestReleaseId: status.projectionEvidence.manifestReleaseId,
    manifestUpdatedAt: status.projectionEvidence.manifestUpdatedAt,
    projectionVersion: status.projectionEvidence.projectionVersion,
    sourceRevision: status.sourceRevision,
    summaryRevision: status.summaryRevision,
    projectionFingerprint: status.projectionFingerprint,
    generatedAt: status.projectionEvidence.generatedAt,
    recordCounts: status.recordCounts,
    completeness: {
      ...status.completeness,
      currentStateComplete: false,
      historyComplete: false,
    },
    coverageComplete: false,
  };
}

export async function buildProductFlowDiagnostics(
  now = Date.now(),
  dependencies: {
    readProducts?: () => Promise<BoundedCurrentStateRead<Product>>;
    readCandidates?: () => Promise<BoundedCurrentStateRead<CandidateQueueItem>>;
    readJobs?: () => Promise<BoundedAutomationJobStatusRead>;
    getSourceHealth?: () => Promise<SourceHealth>;
    getAiReadiness?: () => Promise<GeminiProviderReadiness>;
    getControl?: () => Promise<AutomationControlState>;
    projectionStatus?: AutomationJobHealthView;
  } = {},
): Promise<ProductFlowDiagnostics> {
  const accessTrade = createDefaultSourceAdapterRegistry().get('accesstrade');
  const canReadJobProjection = !dependencies.projectionStatus
    || ['VALID', 'STALE'].includes(dependencies.projectionStatus.projectionStatus);
  const [products, candidates, jobsRead, sourceHealth, aiReadiness, control] = await Promise.all([
    dependencies.readProducts?.() || boundedCurrentState<Product>('products', 'PRODUCT_STATE'),
    dependencies.readCandidates?.() || boundedCurrentState<CandidateQueueItem>('candidate-queue', 'CANDIDATE_STATE'),
    canReadJobProjection
      ? dependencies.readJobs?.() || readBoundedAutomationJobStatuses()
      : Promise.resolve(unavailableJobReadFromProjectionStatus(dependencies.projectionStatus!)),
    dependencies.getSourceHealth?.()
      || accessTrade?.healthCheck({ probe: false })
      || Promise.resolve<SourceHealth>({
        status: 'adapter_unavailable',
        configured: false,
        ready: false,
        reason: 'adapter_unavailable',
      }),
    dependencies.getAiReadiness?.() || getGeminiProviderReadiness(now),
    dependencies.getControl?.() || getAutomationControl(),
  ]);
  const jobs = dependencies.projectionStatus?.projectionStatus === 'STALE'
    ? {
        ...jobsRead,
        reasonCodes: [...new Set([...jobsRead.reasonCodes, 'PRODUCT_FLOW_JOB_PROJECTION_STALE'])],
      }
    : jobsRead;
  return deriveProductFlowDiagnostics({
    products,
    candidates,
    jobs,
    sourceHealth,
    aiReadiness,
    control,
  }, now);
}
