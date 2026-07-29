import {
  generateId,
  readBoundedCollectionSnapshot,
  readCollection,
  runTransaction,
} from '@/lib/storage/adapter';
import { getAllProducts } from '@/lib/storage/products';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';
import { getAiUsage, getAutomationControl, getCircuit } from '@/lib/automation/store';
import { readBoundedAutomationJobStatuses } from '@/lib/automation/jobHealthSummary';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import type { Product } from '@/lib/types';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type { PriceSnapshot, ProductAlert, RecommendedAction } from './types';

const ALERTS = 'product-alerts';
const ACTIONS = 'recommended-actions';
const JOB_EVIDENCE_ALERT_TYPES = new Set<ProductAlert['type']>([
  'queue_backlog',
  'worker_stale',
  'task_failure_spike',
]);
const PRODUCT_EVIDENCE_ALERT_TYPES = new Set<ProductAlert['type']>([
  'duplicate_product',
  'low_quality',
  'broken_link',
  'broken_affiliate_link',
  'broken_image',
  'stale_content',
  'strong_price_variation',
  'public_recheck',
]);
const PRODUCT_GROUP_EVIDENCE_ALERT_TYPES = new Set<ProductAlert['type']>([
  'price_history_building',
  'stale_price',
]);
const VERIFIED_HEALTH_STATUSES = new Set(['ok', 'redirect_ok']);
const FAILURE_ALERT_WINDOW_MS = 24 * 60 * 60_000;
const AUTO_RESOLUTION_OBSERVATIONS_REQUIRED = 2;
const AUTO_RESOLUTION_MAX_OBSERVATION_GAP_MS = 10 * 60_000;
const MAX_EVIDENCE_FUTURE_SKEW_MS = 60_000;
const ALERT_READ_MAXIMUM_BYTES = 32 * 1024 * 1024;

type StoredProductAlert = ProductAlert & {
  resolutionEvidenceState?: 'ACTIVE' | 'UNKNOWN' | 'PASS_PENDING' | 'PASS_CONFIRMED';
  clearObservationCount?: number;
  lastClearObservationAt?: string;
  lastClearObservationOperationId?: string;
  lastClearObservationReleaseId?: string;
  lastClearEvidenceReasonCode?: string;
  lastClearEvidenceScope?: string;
  lastAutoResolutionEvidence?: {
    kind: 'AUTOMATED_RECHECK';
    reasonCode: string;
    scope: string;
    observationCount: number;
    requiredObservationCount: number;
    checkedAt: string;
    operationId: string;
    releaseId: string;
  };
};

interface PositiveAlertResolutionEvidence {
  reasonCode: string;
  scope: string;
}

interface AlertResolutionContext {
  now: number;
  jobRead: Awaited<ReturnType<typeof readBoundedAutomationJobStatuses>>;
  backlog: number;
  workerExpected: boolean;
  workerHeartbeatAt: number | null;
  schedulerExpected: boolean;
  schedulerHeartbeatAt: number | null;
  recentFailed: number;
  accessTradeValid: boolean;
  killSwitch: boolean;
  aiWithinLimit: boolean;
  circuitStates: Map<string, string>;
  latestSourceObservation: Map<Product['source'], number>;
  evaluatedProducts: Map<string, Product>;
  priceHistoryByProduct: Map<string, PriceSnapshot[]>;
  releaseId: string | null;
}

export interface AlertEvaluationResult {
  active: number;
  created: number;
  reopened: number;
  resolved: number;
  resolutionDeferred: number;
  jobEvidence: {
    status: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';
    reasonCodes: string[];
    currentStateComplete: boolean;
    historyComplete: boolean;
    truncated: boolean;
    retentionBoundary: { field: 'updatedAt'; oldestRetainedAt: string } | null;
  };
}

type AlertDraft = Omit<ProductAlert, 'id' | 'groupKey' | 'createdAt' | 'updatedAt' | 'firstSeenAt' | 'lastSeenAt' | 'occurrenceCount' | 'autoResolve' | 'recommendedAction' | 'status' | 'acknowledgedAt' | 'resolvedAt' | 'ignoredReason' | 'cooldownUntil' | 'suppressionUntil'>;

function alert(input: AlertDraft): AlertDraft { return input; }

function timestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cooldownActive(value: string | undefined, now: number): boolean {
  const parsed = timestamp(value);
  return parsed !== null && parsed > now;
}

function currentEvidenceTime(
  value: number | null,
  now: number,
  maximumAgeMs: number,
  notBefore: number | null = null,
): boolean {
  return value !== null
    && value <= now + MAX_EVIDENCE_FUTURE_SKEW_MS
    && now - value <= maximumAgeMs
    && (notBefore === null || value >= notBefore);
}

function hasPositiveJobResolutionEvidence(
  type: ProductAlert['type'],
  read: Awaited<ReturnType<typeof readBoundedAutomationJobStatuses>>,
  now: number,
): boolean {
  if (!JOB_EVIDENCE_ALERT_TYPES.has(type)) return true;
  if (type === 'queue_backlog' || type === 'worker_stale') {
    return read.currentStateComplete;
  }
  if (read.historyComplete) return true;
  const retainedFrom = Date.parse(read.retentionBoundary?.oldestRetainedAt || '');
  return read.currentStateComplete
    && Number.isFinite(retainedFrom)
    && retainedFrom <= now - FAILURE_ALERT_WINDOW_MS;
}

function positiveAlertResolutionEvidence(
  item: ProductAlert,
  context: AlertResolutionContext,
): PositiveAlertResolutionEvidence | null {
  if (item.type === 'credential_missing') {
    return context.accessTradeValid
      ? { reasonCode: 'CREDENTIAL_VALID', scope: 'credential:accesstrade' }
      : null;
  }
  if (item.type === 'queue_backlog') {
    return hasPositiveJobResolutionEvidence(item.type, context.jobRead, context.now)
      && context.backlog < 25
      ? { reasonCode: 'QUEUE_BELOW_ALERT_THRESHOLD', scope: 'automation:current_jobs' }
      : null;
  }
  if (item.type === 'worker_stale') {
    const workerHealthy = !context.workerExpected
      || currentEvidenceTime(context.workerHeartbeatAt, context.now, 90_000);
    return hasPositiveJobResolutionEvidence(item.type, context.jobRead, context.now) && workerHealthy
      ? { reasonCode: 'WORKER_HEARTBEAT_CURRENT_OR_NOT_REQUIRED', scope: 'automation:worker' }
      : null;
  }
  if (item.type === 'scheduler_stale') {
    const schedulerHealthy = !context.schedulerExpected
      || currentEvidenceTime(
        context.schedulerHeartbeatAt,
        context.now,
        2 * 60 * 60_000,
      );
    return schedulerHealthy
      ? { reasonCode: 'SCHEDULER_HEARTBEAT_CURRENT_OR_NOT_REQUIRED', scope: 'automation:scheduler' }
      : null;
  }
  if (item.type === 'kill_switch') {
    return context.killSwitch
      ? null
      : { reasonCode: 'KILL_SWITCH_DISABLED', scope: 'automation:control' };
  }
  if (item.type === 'task_failure_spike') {
    return hasPositiveJobResolutionEvidence(item.type, context.jobRead, context.now)
      && context.recentFailed < 3
      ? { reasonCode: 'FAILURE_RATE_BELOW_ALERT_THRESHOLD', scope: 'automation:last_24_hours' }
      : null;
  }
  if (item.type === 'ai_limit') {
    return context.aiWithinLimit
      ? { reasonCode: 'AI_USAGE_BELOW_ALERT_THRESHOLD', scope: 'ai:current_budget_day' }
      : null;
  }
  if (item.type === 'circuit_open') {
    const provider = String(item.entityId || '').trim();
    const state = provider ? context.circuitStates.get(provider) : undefined;
    return state && state !== 'OPEN'
      ? { reasonCode: 'CIRCUIT_NOT_OPEN', scope: `circuit:${provider}` }
      : null;
  }
  if (item.type === 'source_stale') {
    const source = String(item.entityId || '') as Product['source'];
    const observedAt = context.latestSourceObservation.get(source);
    const alertLastSeenAt = timestamp(item.lastSeenAt);
    return currentEvidenceTime(
      observedAt ?? null,
      context.now,
      CONFIG.freshness.productDays * 86_400_000,
      alertLastSeenAt,
    )
      ? { reasonCode: 'SOURCE_OBSERVATION_CURRENT', scope: `source:${source}` }
      : null;
  }
  if (PRODUCT_EVIDENCE_ALERT_TYPES.has(item.type)) {
    const productId = String(item.entityId || '').trim();
    const product = productId ? context.evaluatedProducts.get(productId) : undefined;
    if (!product) return null;
    const alertLastSeenAt = timestamp(item.lastSeenAt);
    const productUpdatedAt = timestamp(product.updatedAt);
    const updatedAfterAlert = currentEvidenceTime(
      productUpdatedAt,
      context.now,
      CONFIG.freshness.productDays * 86_400_000,
      alertLastSeenAt,
    );
    if (item.type === 'duplicate_product') {
      return updatedAfterAlert
        && Number.isFinite(product.duplicateConfidence)
        && Number(product.duplicateConfidence) < CONFIG.thresholds.duplicateMedium
        ? { reasonCode: 'DUPLICATE_CONFIDENCE_BELOW_THRESHOLD', scope: `product:${productId}` }
        : null;
    }
    if (item.type === 'low_quality') {
      return updatedAfterAlert
        && Number.isFinite(product.qualityScore)
        && Number(product.qualityScore) >= CONFIG.thresholds.qualityNeedsData
        && product.qualityBand !== 'blocked'
        ? { reasonCode: 'PRODUCT_QUALITY_ABOVE_ALERT_THRESHOLD', scope: `product:${productId}` }
        : null;
    }
    if (item.type === 'broken_link' || item.type === 'broken_affiliate_link' || item.type === 'broken_image') {
      const status = item.type === 'broken_link'
        ? product.linkHealthStatus
        : item.type === 'broken_affiliate_link'
          ? product.affiliateHealthStatus
          : product.imageHealthStatus;
      const checkedAt = timestamp(item.type === 'broken_link'
        ? product.linkLastCheckedAt
        : item.type === 'broken_affiliate_link'
          ? product.affiliateLastCheckedAt
          : product.imageLastCheckedAt);
      return VERIFIED_HEALTH_STATUSES.has(String(status || ''))
        && currentEvidenceTime(
          checkedAt,
          context.now,
          CONFIG.freshness.linkDays * 86_400_000,
          alertLastSeenAt,
        )
        ? { reasonCode: 'PRODUCT_HEALTH_RECHECK_PASSED', scope: `product:${productId}` }
        : null;
    }
    if (item.type === 'stale_content') {
      if (product.contentWorkflowStatus !== 'published') {
        return updatedAfterAlert
          ? { reasonCode: 'CONTENT_NO_LONGER_PUBLISHED', scope: `product:${productId}` }
          : null;
      }
      const checkedAt = timestamp(product.lastEditorialCheckAt);
      return currentEvidenceTime(
        checkedAt,
        context.now,
        CONFIG.freshness.editorialDays * 86_400_000,
        alertLastSeenAt,
      )
        ? { reasonCode: 'EDITORIAL_RECHECK_CURRENT', scope: `product:${productId}` }
        : null;
    }
    if (item.type === 'strong_price_variation') {
      const movement = latestPriceMovement(context.priceHistoryByProduct.get(productId) || []);
      if (!movement) return null;
      const capturedAt = timestamp(movement.capturedAt);
      return capturedAt !== null
        && movement.percent < CONFIG.thresholds.strongPriceMovementPercent
        && currentEvidenceTime(
          capturedAt,
          context.now,
          CONFIG.freshness.priceDays * 86_400_000,
          alertLastSeenAt,
        )
        ? { reasonCode: 'PRICE_VARIATION_NO_LONGER_ACTIVE', scope: `product:${productId}` }
        : null;
    }
    if (item.type === 'public_recheck') {
      if (product.status !== 'published') {
        return updatedAfterAlert
          ? { reasonCode: 'PRODUCT_NO_LONGER_PUBLIC', scope: `product:${productId}` }
          : null;
      }
      const priceObservedTimes = [
        timestamp(product.priceLastChangedAt),
        ...(context.priceHistoryByProduct.get(productId) || []).map(snapshot => timestamp(snapshot.capturedAt)),
      ].filter((value): value is number => value !== null);
      const priceObservedAt = priceObservedTimes.length ? Math.max(...priceObservedTimes) : undefined;
      return publicRecheckReasons(product, context.now, priceObservedAt).length === 0
        ? { reasonCode: 'PUBLIC_PRODUCT_RECHECK_CURRENT', scope: `product:${productId}` }
        : null;
    }
    return null;
  }
  if (PRODUCT_GROUP_EVIDENCE_ALERT_TYPES.has(item.type)) {
    const relatedIds = [...new Set((item.relatedEntityIds || []).map(String).filter(Boolean))];
    const alertLastSeenAt = timestamp(item.lastSeenAt);
    if (!relatedIds.length || alertLastSeenAt === null) return null;
    const allHavePositivePriceEvidence = relatedIds.every(id => {
      const product = context.evaluatedProducts.get(id);
      if (!product) return false;
      const snapshots = (context.priceHistoryByProduct.get(id) || [])
        .filter(snapshot => effectiveSnapshotPrice(snapshot) !== null && timestamp(snapshot.capturedAt) !== null);
      if (item.type === 'price_history_building') {
        const latest = Math.max(...snapshots.map(snapshot => timestamp(snapshot.capturedAt)!), -1);
        return snapshots.length >= 2 && currentEvidenceTime(
          latest,
          context.now,
          CONFIG.freshness.priceDays * 86_400_000,
          alertLastSeenAt,
        );
      }
      const evidenceTimes = [
        timestamp(product.priceLastChangedAt),
        ...snapshots.map(snapshot => timestamp(snapshot.capturedAt)),
      ].filter((value): value is number => value !== null);
      const latest = evidenceTimes.length ? Math.max(...evidenceTimes) : null;
      return currentEvidenceTime(
        latest,
        context.now,
        CONFIG.freshness.priceDays * 86_400_000,
        alertLastSeenAt,
      );
    });
    return allHavePositivePriceEvidence
      ? {
          reasonCode: item.type === 'price_history_building'
            ? 'PRICE_HISTORY_MINIMUM_REACHED'
            : 'PRICE_EVIDENCE_CURRENT',
          scope: `product_group:${relatedIds.slice(0, 20).join(',')}`,
        }
      : null;
  }
  return null;
}

function resetClearObservations(item: StoredProductAlert, state: 'ACTIVE' | 'UNKNOWN'): void {
  item.resolutionEvidenceState = state;
  item.clearObservationCount = 0;
  item.lastClearObservationAt = undefined;
  item.lastClearObservationOperationId = undefined;
  item.lastClearObservationReleaseId = undefined;
  item.lastClearEvidenceReasonCode = undefined;
  item.lastClearEvidenceScope = undefined;
}

function effectiveSnapshotPrice(snapshot: PriceSnapshot): number | null {
  const value = Number(snapshot.salePrice || snapshot.price || 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function latestPriceMovement(snapshots: PriceSnapshot[]): { capturedAt: string; percent: number; previous: number; current: number } | null {
  const ordered = [...snapshots]
    .filter(item => timestamp(item.capturedAt) !== null && effectiveSnapshotPrice(item) !== null)
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
  const latest = ordered[0];
  if (!latest) return null;
  const current = effectiveSnapshotPrice(latest)!;
  const previousSnapshot = ordered.slice(1).find(item => effectiveSnapshotPrice(item) !== current);
  if (!previousSnapshot) return null;
  const previous = effectiveSnapshotPrice(previousSnapshot)!;
  return { capturedAt: latest.capturedAt, percent: Math.abs((current - previous) / previous) * 100, previous, current };
}

function publicRecheckReasons(product: Product, now: number, priceObservedAt?: number): string[] {
  if (product.status !== 'published') return [];
  const reasons: string[] = [];
  const linkCheckedAt = timestamp(product.linkLastCheckedAt);
  if (!currentEvidenceTime(linkCheckedAt, now, CONFIG.freshness.linkDays * 86_400_000)) reasons.push('link');
  if (product.imageUrl) {
    const imageCheckedAt = timestamp(product.imageLastCheckedAt);
    if (!currentEvidenceTime(imageCheckedAt, now, CONFIG.freshness.linkDays * 86_400_000)) reasons.push('image');
  }
  const editorialCheckedAt = timestamp(product.lastEditorialCheckAt);
  if (!currentEvidenceTime(editorialCheckedAt, now, CONFIG.freshness.editorialDays * 86_400_000)) reasons.push('editorial');
  const priceCheckedAt = priceObservedAt ?? timestamp(product.lastSeenAt || product.priceLastChangedAt || product.updatedAt);
  if (!currentEvidenceTime(priceCheckedAt, now, CONFIG.freshness.priceDays * 86_400_000)) reasons.push('price');
  return reasons;
}

export async function evaluateAlerts(operationId: string, now = Date.now()): Promise<AlertEvaluationResult> {
  const [products, priceHistory, jobRead, control, settings, accessTrade, aiUsage, geminiCircuit, automationCircuit] = await Promise.all([
    getAllProducts(), readCollection<PriceSnapshot>('price-history'),
    readBoundedAutomationJobStatuses(),
    getAutomationControl(), getAutomationSettings(),
    getPrimaryCredential('accesstrade'), getAiUsage(now), getCircuit('gemini'), getCircuit('autopilot'),
  ]);
  const jobs = jobRead.items;
  const jobEvidenceStatus = jobRead.evidenceClassification;
  const drafts: AlertDraft[] = [];
  const nowIso = new Date(now).toISOString();
  if (!accessTrade || accessTrade.status !== 'valid') drafts.push(alert({
    deduplicationKey: 'credential:accesstrade', type: 'credential_missing', severity: 'important',
    title: 'Cần thiết lập kết nối AccessTrade', message: 'Chưa có credential AccessTrade hợp lệ; đồng bộ nguồn này chưa thể chạy.',
    entityType: 'credential', entityId: 'accesstrade', operationId, suggestedAction: 'Mở Kết nối bảo mật và kiểm tra AccessTrade.',
  }));
  const backlog = jobs.filter(job => ['PENDING', 'RETRY_SCHEDULED', 'WAITING_APPROVAL'].includes(job.status)).length;
  if (backlog >= 25) drafts.push(alert({
    deduplicationKey: 'automation:queue-backlog', type: 'queue_backlog', severity: backlog >= 100 ? 'critical' : 'important',
    title: 'Hàng chờ tác vụ đang tăng', message: `${backlog} tác vụ đang chờ hoặc cần phê duyệt.`, entityType: 'automation',
    operationId, suggestedAction: 'Kiểm tra worker và hàng chờ phê duyệt.',
  }));
  const workerExpected = !control.workerPaused && jobs.some(job => ['PENDING', 'RETRY_SCHEDULED', 'RUNNING'].includes(job.status));
  const workerHeartbeatAt = timestamp(control.workerHeartbeatAt);
  if (workerExpected && (workerHeartbeatAt === null || now - workerHeartbeatAt > 90_000)) drafts.push(alert({
    deduplicationKey: 'automation:worker-stale', type: 'worker_stale', severity: 'critical', title: 'Worker mất tín hiệu',
    message: workerHeartbeatAt === null
      ? 'Hàng chờ có tác vụ có thể chạy nhưng worker chưa từng ghi heartbeat.'
      : 'Worker không cập nhật heartbeat trong thời gian cho phép.', entityType: 'automation', operationId,
    suggestedAction: 'Kiểm tra tiến trình worker và task đang giữ lease.',
  }));
  const schedulerExpected = settings.enabled && !control.schedulerPaused;
  const schedulerHeartbeatAt = timestamp(control.schedulerHeartbeatAt);
  if (schedulerExpected && (schedulerHeartbeatAt === null || now - schedulerHeartbeatAt > 2 * 60 * 60_000)) drafts.push(alert({
    deduplicationKey: 'automation:scheduler-stale', type: 'scheduler_stale', severity: 'important', title: 'Scheduler mất tín hiệu',
    message: schedulerHeartbeatAt === null ? 'Scheduler đang bật nhưng chưa từng ghi heartbeat.' : 'Scheduler đang bật nhưng heartbeat đã cũ.', entityType: 'automation', operationId,
    suggestedAction: 'Kiểm tra tiến trình scheduler và lịch chạy kế tiếp.',
  }));
  if (control.killSwitch) drafts.push(alert({
    deduplicationKey: 'automation:kill-switch', type: 'kill_switch', severity: 'critical', title: 'Dừng khẩn cấp đang bật',
    message: control.reason || 'Mọi side effect tự động đang bị chặn.', entityType: 'automation', operationId,
    suggestedAction: 'Xác minh nguyên nhân trước khi tắt kill switch.',
  }));
  const recentFailed = jobs.filter(job => job.status === 'FAILED' && job.completedAt && now - Date.parse(job.completedAt) <= 86_400_000).length;
  if (recentFailed >= 3) drafts.push(alert({
    deduplicationKey: 'automation:failure-spike', type: 'task_failure_spike', severity: recentFailed >= 10 ? 'critical' : 'important',
    title: 'Tác vụ lỗi tăng', message: `${recentFailed} tác vụ thất bại trong 24 giờ.`, entityType: 'automation', operationId,
    suggestedAction: 'Mở danh sách tác vụ lỗi và xem mã lỗi đã làm sạch.',
  }));
  if (aiUsage.requests >= aiUsage.requestLimit * 0.8 || aiUsage.tokens >= aiUsage.tokenLimit * 0.8) drafts.push(alert({
    deduplicationKey: `ai:limit:${aiUsage.day}`, type: 'ai_limit', severity: 'attention', title: 'AI gần hạn mức',
    message: 'Mức sử dụng AI local policy đã đạt ít nhất 80% giới hạn ngày.', entityType: 'ai_usage', entityId: aiUsage.day, operationId,
    suggestedAction: 'Ưu tiên workflow local và hoãn tác vụ AI không cấp thiết.',
  }));
  for (const circuit of [geminiCircuit, automationCircuit]) if (circuit.state === 'OPEN') drafts.push(alert({
    deduplicationKey: `circuit:${circuit.provider}`, type: 'circuit_open', severity: 'important', title: `Circuit breaker ${circuit.provider} đang mở`,
    message: 'Provider bị tạm chặn sau nhiều lỗi liên tiếp.', entityType: 'circuit', entityId: circuit.provider, operationId,
    suggestedAction: 'Chờ cooldown hoặc xử lý lỗi provider trước khi probe lại.',
  }));

  const trackedSources = new Set<Product['source']>(['accesstrade', 'shopee_affiliate', 'tiktok_shop', 'lazada_affiliate']);
  const latestSourceObservation = new Map<Product['source'], number>();
  for (const product of products) {
    if (!trackedSources.has(product.source)) continue;
    const observedAt = timestamp(product.lastSeenAt || product.updatedAt);
    if (observedAt !== null) latestSourceObservation.set(product.source, Math.max(observedAt, latestSourceObservation.get(product.source) || 0));
  }
  for (const [source, observedAt] of latestSourceObservation) {
    if (now - observedAt <= CONFIG.freshness.productDays * 86_400_000) continue;
    const ageDays = Math.max(1, Math.floor((now - observedAt) / 86_400_000));
    drafts.push(alert({
      deduplicationKey: `source:${source}:stale`, type: 'source_stale', severity: ageDays >= CONFIG.freshness.productDays * 2 ? 'important' : 'attention',
      title: 'Nguồn sản phẩm chưa cập nhật', message: `Nguồn ${source} không có sản phẩm được ghi nhận mới trong ${ageDays} ngày.`,
      entityType: 'source', entityId: source, operationId, suggestedAction: 'Kiểm tra credential, checkpoint và tác vụ đồng bộ nguồn.',
    }));
  }

  const priceHistoryByProduct = new Map<string, PriceSnapshot[]>();
  for (const snapshot of priceHistory) {
    const history = priceHistoryByProduct.get(snapshot.productId) || [];
    history.push(snapshot);
    priceHistoryByProduct.set(snapshot.productId, history);
  }

  const buildingPriceHistory: Product[] = [];
  const stalePriceProducts: Product[] = [];
  const evaluatedProducts = products.slice(0, 2_000);
  for (const product of evaluatedProducts) {
    const productPriceHistory = priceHistoryByProduct.get(product.id) || [];
    const observedPriceTimes = [timestamp(product.lastSeenAt), timestamp(product.priceLastChangedAt),
      ...productPriceHistory.map(item => timestamp(item.capturedAt))].filter((value): value is number => value !== null);
    if (!observedPriceTimes.length) {
      const updatedAt = timestamp(product.updatedAt);
      if (updatedAt !== null) observedPriceTimes.push(updatedAt);
    }
    const priceObservedAt = observedPriceTimes.length ? Math.max(...observedPriceTimes) : undefined;
    if ((product.duplicateConfidence || 0) >= CONFIG.thresholds.duplicateMedium) drafts.push(alert({
      deduplicationKey: `product:${product.id}:duplicate`, type: 'duplicate_product', severity: (product.duplicateConfidence || 0) >= CONFIG.thresholds.duplicateHigh ? 'important' : 'attention',
      title: 'Sản phẩm có khả năng trùng', message: `${product.title} có confidence trùng ${Math.round((product.duplicateConfidence || 0) * 100)}%.`,
      entityType: 'product', entityId: product.id, operationId, suggestedAction: 'Mở nhóm trùng và chọn bản chính.',
    }));
    if (typeof product.qualityScore === 'number' && product.qualityScore < CONFIG.thresholds.qualityNeedsData) drafts.push(alert({
      deduplicationKey: `product:${product.id}:quality`, type: 'low_quality', severity: product.qualityBand === 'blocked' ? 'important' : 'attention',
      title: 'Chất lượng dữ liệu thấp', message: `${product.title} có Quality Score ${product.qualityScore}.`, entityType: 'product', entityId: product.id,
      operationId, suggestedAction: 'Bổ sung field theo recommendations của Quality Score.',
    }));
    const productStartedAt = timestamp(product.createdAt || product.updatedAt);
    const productAge = productStartedAt === null ? Number.POSITIVE_INFINITY : now - productStartedAt;
    if (productPriceHistory.length < 2 && productAge <= CONFIG.freshness.priceDays * 86_400_000) {
      buildingPriceHistory.push(product);
    } else if (priceObservedAt !== undefined && now - priceObservedAt > CONFIG.freshness.priceDays * 86_400_000) {
      stalePriceProducts.push(product);
    }
    if (['broken', 'not_found', 'product_unavailable', 'affiliate_error'].includes(String(product.linkHealthStatus || ''))) drafts.push(alert({
      deduplicationKey: `product:${product.id}:link`, type: 'broken_link', severity: product.status === 'published' ? 'critical' : 'important', title: 'Link sản phẩm lỗi',
      message: `${product.title} có trạng thái link ${product.linkHealthStatus}.`, entityType: 'product', entityId: product.id, operationId,
      suggestedAction: 'Kiểm tra lại link; ẩn khỏi public nếu không còn an toàn.',
    }));
    if (['broken', 'not_found', 'product_unavailable', 'affiliate_error'].includes(String(product.affiliateHealthStatus || ''))) drafts.push(alert({
      deduplicationKey: `product:${product.id}:affiliate-link`, type: 'broken_affiliate_link', severity: product.status === 'published' ? 'critical' : 'important', title: 'Link tiếp thị liên kết lỗi',
      message: `${product.title} có trạng thái affiliate ${product.affiliateHealthStatus}.`, entityType: 'product', entityId: product.id, operationId,
      suggestedAction: 'Đưa link vào hàng chờ kiểm tra lại trước khi tiếp tục dùng CTA.',
    }));
    if (['image_broken', 'invalid_image', 'not_found'].includes(String(product.imageHealthStatus || ''))) drafts.push(alert({
      deduplicationKey: `product:${product.id}:image`, type: 'broken_image', severity: 'attention', title: 'Ảnh sản phẩm lỗi',
      message: `${product.title} cần ảnh nguồn hợp lệ.`, entityType: 'product', entityId: product.id, operationId,
      suggestedAction: 'Bổ sung ảnh và chạy kiểm tra ảnh.',
    }));
    if (product.contentWorkflowStatus === 'published' && product.lastEditorialCheckAt && now - Date.parse(product.lastEditorialCheckAt) > CONFIG.freshness.editorialDays * 86_400_000) drafts.push(alert({
      deduplicationKey: `product:${product.id}:stale-content`, type: 'stale_content', severity: 'attention', title: 'Bài đánh giá đã cũ',
      message: `${product.title} cần chạy lại Editorial Guard.`, entityType: 'product', entityId: product.id, operationId,
      suggestedAction: 'Mở Content Studio và xác minh lại nội dung.',
    }));
    const movement = latestPriceMovement(productPriceHistory);
    if (movement && movement.percent >= CONFIG.thresholds.strongPriceMovementPercent
      && now - Date.parse(movement.capturedAt) <= CONFIG.freshness.priceDays * 86_400_000) drafts.push(alert({
      deduplicationKey: `product:${product.id}:price-variation`, type: 'strong_price_variation', severity: movement.percent >= 40 ? 'important' : 'attention',
      title: 'Giá ghi nhận biến động mạnh', message: `${product.title} thay đổi ${Math.round(movement.percent)}% giữa hai mức giá gần nhất trong lịch sử nội bộ SanDeal.`,
      entityType: 'product', entityId: product.id, operationId, suggestedAction: 'Xác minh giá gốc, giá hiện tại và nguồn trước khi dùng Deal Score.',
    }));
    const recheckReasons = publicRecheckReasons(product, now, priceObservedAt);
    if (recheckReasons.length) drafts.push(alert({
      deduplicationKey: `product:${product.id}:public-recheck`, type: 'public_recheck', severity: recheckReasons.includes('link') ? 'important' : 'attention',
      title: 'Sản phẩm public cần kiểm tra lại', message: `${product.title} có ${recheckReasons.length} nhóm dữ liệu public cần xác minh lại (${recheckReasons.join(', ')}).`,
      entityType: 'product', entityId: product.id, operationId, suggestedAction: 'Chạy health check và Editorial Guard; giữ nguyên Safe Publish gate.',
    }));
  }

  if (buildingPriceHistory.length) drafts.push(alert({
    deduplicationKey: 'group:products:price-history-building', type: 'price_history_building', severity: 'info',
    title: 'Sản phẩm mới đang tích lũy lịch sử giá',
    message: `${buildingPriceHistory.length} sản phẩm mới chưa đủ lịch sử giá — không cần xử lý ngay.`,
    entityType: 'product_group', operationId, suggestedAction: 'Hệ thống sẽ tự ghi thêm snapshot theo lịch; chỉ kiểm tra nếu trạng thái kéo dài quá thời hạn.',
    relatedEntityIds: buildingPriceHistory.map(product => product.id).slice(0, 500),
  }));
  if (stalePriceProducts.length) drafts.push(alert({
    deduplicationKey: 'group:products:stale-price', type: 'stale_price', severity: 'attention', title: 'Nhóm sản phẩm cần kiểm tra lại giá',
    message: `${stalePriceProducts.length} sản phẩm chưa có giá mới trong ${CONFIG.freshness.priceDays} ngày.`, entityType: 'product_group',
    operationId, suggestedAction: 'Chạy tác vụ snapshot giá theo nhóm và kiểm tra lỗi provider trước khi xử lý từng sản phẩm.',
    relatedEntityIds: stalePriceProducts.map(product => product.id).slice(0, 500),
  }));

  let created = 0; let reopened = 0; let resolved = 0; let resolutionDeferred = 0;
  const activeKeys = new Set(drafts.map(item => item.deduplicationKey));
  const releaseIdentity = getReleaseIdentity();
  const resolutionReleaseId = releaseIdentity.releaseMismatch
    || releaseIdentity.releaseId === 'unavailable'
    ? null
    : releaseIdentity.releaseId;
  const resolutionContext: AlertResolutionContext = {
    now,
    jobRead,
    backlog,
    workerExpected,
    workerHeartbeatAt,
    schedulerExpected,
    schedulerHeartbeatAt,
    recentFailed,
    accessTradeValid: Boolean(accessTrade && accessTrade.status === 'valid'),
    killSwitch: control.killSwitch,
    aiWithinLimit: aiUsage.requests < aiUsage.requestLimit * 0.8
      && aiUsage.tokens < aiUsage.tokenLimit * 0.8,
    circuitStates: new Map([
      [geminiCircuit.provider, geminiCircuit.state],
      [automationCircuit.provider, automationCircuit.state],
    ]),
    latestSourceObservation,
    evaluatedProducts: new Map(evaluatedProducts.map(product => [product.id, product])),
    priceHistoryByProduct,
    releaseId: resolutionReleaseId,
  };
  await runTransaction<StoredProductAlert>(ALERTS, items => {
    for (const draft of drafts) {
      const existing = items.find(item => item.deduplicationKey === draft.deduplicationKey);
      if (!existing) {
        items.push({
          ...draft, id: generateId(), groupKey: draft.deduplicationKey, recommendedAction: draft.suggestedAction,
          status: 'new', createdAt: nowIso, updatedAt: nowIso, firstSeenAt: nowIso, lastSeenAt: nowIso,
          occurrenceCount: Math.max(1, draft.relatedEntityIds?.length || 1), autoResolve: true,
          resolutionEvidenceState: 'ACTIVE', clearObservationCount: 0,
        }); created += 1;
      } else if (existing.status === 'resolved' || (existing.status === 'ignored' && !cooldownActive(existing.cooldownUntil, now))) {
        Object.assign(existing, draft, {
          status: 'new', acknowledgedAt: undefined, resolvedAt: undefined, ignoredReason: undefined, cooldownUntil: undefined, updatedAt: nowIso,
          groupKey: draft.deduplicationKey, recommendedAction: draft.suggestedAction,
          firstSeenAt: existing.firstSeenAt || existing.createdAt, lastSeenAt: nowIso,
          occurrenceCount: Math.max(1, draft.relatedEntityIds?.length || 1), autoResolve: true,
        });
        resetClearObservations(existing, 'ACTIVE');
        reopened += 1;
      } else if (!['resolved', 'ignored'].includes(existing.status)) {
        Object.assign(existing, draft, {
          updatedAt: nowIso, groupKey: draft.deduplicationKey, recommendedAction: draft.suggestedAction,
          firstSeenAt: existing.firstSeenAt || existing.createdAt, lastSeenAt: nowIso,
          occurrenceCount: Math.max(1, draft.relatedEntityIds?.length || 1), autoResolve: true,
        });
        resetClearObservations(existing, 'ACTIVE');
      } else {
        resetClearObservations(existing, 'ACTIVE');
      }
    }
    for (const existing of items) {
      if (!activeKeys.has(existing.deduplicationKey) && !['resolved', 'ignored'].includes(existing.status)) {
        const evidence = positiveAlertResolutionEvidence(existing, resolutionContext);
        if (!evidence) {
          resetClearObservations(existing, 'UNKNOWN');
          resolutionDeferred += 1;
          continue;
        }
        if (!resolutionContext.releaseId) {
          resetClearObservations(existing, 'UNKNOWN');
          resolutionDeferred += 1;
          continue;
        }
        const evidenceScope = evidence.scope.slice(0, 500);
        const previousObservedAt = Date.parse(existing.lastClearObservationAt || '');
        const previousCount = Math.max(0, existing.clearObservationCount || 0);
        const previousObservationCompatible = previousCount > 0
          && Number.isFinite(previousObservedAt)
          && now > previousObservedAt
          && now - previousObservedAt <= AUTO_RESOLUTION_MAX_OBSERVATION_GAP_MS
          && existing.lastClearObservationReleaseId === resolutionContext.releaseId
          && existing.lastClearEvidenceReasonCode === evidence.reasonCode
          && existing.lastClearEvidenceScope === evidenceScope;
        if (previousCount > 0 && !previousObservationCompatible) {
          resetClearObservations(existing, 'UNKNOWN');
        }
        const newObservation = existing.lastClearObservationOperationId !== operationId;
        if (newObservation) {
          existing.clearObservationCount = Math.min(
            AUTO_RESOLUTION_OBSERVATIONS_REQUIRED,
            Math.max(0, existing.clearObservationCount || 0) + 1,
          );
          existing.lastClearObservationAt = nowIso;
          existing.lastClearObservationOperationId = operationId;
          existing.lastClearObservationReleaseId = resolutionContext.releaseId;
          existing.lastClearEvidenceReasonCode = evidence.reasonCode;
          existing.lastClearEvidenceScope = evidenceScope;
        }
        if ((existing.clearObservationCount || 0) < AUTO_RESOLUTION_OBSERVATIONS_REQUIRED) {
          existing.resolutionEvidenceState = 'PASS_PENDING';
          existing.updatedAt = nowIso;
          resolutionDeferred += 1;
          continue;
        }
        existing.status = 'resolved'; existing.resolvedAt = nowIso; existing.updatedAt = nowIso;
        existing.cooldownUntil = undefined;
        existing.resolutionEvidenceState = 'PASS_CONFIRMED';
        existing.lastAutoResolutionEvidence = {
          kind: 'AUTOMATED_RECHECK',
          reasonCode: evidence.reasonCode,
          scope: evidenceScope,
          observationCount: existing.clearObservationCount || AUTO_RESOLUTION_OBSERVATIONS_REQUIRED,
          requiredObservationCount: AUTO_RESOLUTION_OBSERVATIONS_REQUIRED,
          checkedAt: nowIso,
          operationId: operationId.slice(0, 200),
          releaseId: resolutionContext.releaseId,
        };
        resolved += 1;
      }
    }
    const retentionCutoff = now - CONFIG.retention.resolvedAlertDays * 86_400_000;
    return items.filter(item => !item.resolvedAt || Date.parse(item.resolvedAt) >= retentionCutoff).slice(-CONFIG.limits.alerts);
  });
  const active = (await listAlerts({ limit: CONFIG.limits.alerts })).filter(item => !['resolved', 'ignored'].includes(item.status)).length;
  return {
    active,
    created,
    reopened,
    resolved,
    resolutionDeferred,
    jobEvidence: {
      status: jobEvidenceStatus,
      reasonCodes: jobRead.reasonCodes.length
        ? jobRead.reasonCodes
        : jobEvidenceStatus === 'COMPLETE'
          ? []
          : [jobEvidenceStatus === 'UNAVAILABLE'
            ? 'JOB_READ_MODEL_UNAVAILABLE'
            : 'JOB_READ_MODEL_INCOMPLETE'],
      currentStateComplete: jobRead.currentStateComplete,
      historyComplete: jobRead.historyComplete,
      truncated: jobRead.truncated,
      retentionBoundary: jobRead.retentionBoundary,
    },
  };
}

export async function readAlertDashboardView(options: {
  status?: ProductAlert['status'];
  limit?: number;
} = {}) {
  const limit = Math.max(1, Math.min(options.limit || 100, 500));
  const snapshot = await readBoundedCollectionSnapshot<ProductAlert>(ALERTS, {
    maximumItems: CONFIG.limits.alerts,
    maximumBytes: ALERT_READ_MAXIMUM_BYTES,
  });
  if (!snapshot.metadata.collectionPresent) {
    throw new Error('ALERT_COLLECTION_UNAVAILABLE');
  }

  const validStatuses = new Set<ProductAlert['status']>([
    'new',
    'acknowledged',
    'in_progress',
    'resolved',
    'ignored',
  ]);
  const validItems = snapshot.items.filter(item =>
    item
    && typeof item.id === 'string'
    && typeof item.deduplicationKey === 'string'
    && typeof item.updatedAt === 'string'
    && validStatuses.has(item.status));
  if (validItems.length !== snapshot.items.length) {
    throw new Error('ALERT_COLLECTION_INVALID_RECORD');
  }

  const unique = new Map<string, ProductAlert>();
  for (const item of [...validItems].sort((left, right) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt))) {
    if (!unique.has(item.deduplicationKey)) unique.set(item.deduplicationKey, item);
  }
  const retained = [...unique.values()];
  const active = retained
    .filter(item => !['resolved', 'ignored'].includes(item.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const historical = retained
    .filter(item => ['resolved', 'ignored'].includes(item.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const selected = options.status
    ? retained
        .filter(item => item.status === options.status)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    : [...active, ...historical];
  const items = selected.slice(0, limit);
  const returnedHistoricalCount = items.filter(item =>
    ['resolved', 'ignored'].includes(item.status)).length;

  return {
    items,
    summary: {
      total: null,
      retainedTotal: retained.length,
      matchingRetainedCount: selected.length,
      returnedCount: items.length,
      limit,
      bounded: true,
      hasMore: selected.length > items.length,
      truncated: selected.length > items.length,
      source: 'bounded_alert_collection',
      unresolved: active.length,
      critical: active.filter(item => item.severity === 'critical').length,
      important: active.filter(item => item.severity === 'important').length,
      resolved: null,
      resolvedRetained: historical.filter(item => item.status === 'resolved').length,
    },
    evidence: {
      status: 'COMPLETE' as const,
      source: 'bounded_alert_collection',
      collectionPresent: true,
      currentStateComplete: true,
      historyComplete: false,
      reasonCodes: ['ALERT_HISTORY_RETENTION_BOUNDED'],
      retainedRecordCount: retained.length,
      duplicateRecordsSuppressed: validItems.length - retained.length,
    },
    history: {
      total: null,
      retainedCount: historical.length,
      returnedCount: returnedHistoricalCount,
      limit,
      bounded: true,
      hasMore: historical.length > returnedHistoricalCount,
      source: 'bounded_retained_alert_history',
      retentionDays: CONFIG.retention.resolvedAlertDays,
    },
  };
}

export async function listAlerts(options: { status?: ProductAlert['status']; limit?: number } = {}): Promise<ProductAlert[]> {
  const items = await readCollection<ProductAlert>(ALERTS);
  const unique = new Map<string, ProductAlert>();
  for (const item of items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    if (!unique.has(item.deduplicationKey)) unique.set(item.deduplicationKey, item);
  }
  let result = [...unique.values()];
  if (options.status) result = result.filter(item => item.status === options.status);
  return result.slice(0, Math.max(1, Math.min(options.limit || 100, CONFIG.limits.alerts)));
}

export async function updateAlertStatuses(ids: string[], status: ProductAlert['status'], reason?: string, nowMs = Date.now()): Promise<ProductAlert[]> {
  if (status === 'ignored' && String(reason || '').trim().length < 5) throw new Error('REASON_REQUIRED');
  if (status === 'resolved') throw new Error('RECHECK_EVIDENCE_REQUIRED');
  const targets = new Set(ids.map(id => String(id).trim()).filter(Boolean).slice(0, 100));
  if (!targets.size) return [];
  const updated: ProductAlert[] = [];
  await runTransaction<StoredProductAlert>(ALERTS, items => {
    const now = new Date(nowMs).toISOString();
    for (const item of items) {
      if (!targets.has(item.id)) continue;
      item.status = status; item.updatedAt = now; item.lastSeenAt ||= item.updatedAt; item.firstSeenAt ||= item.createdAt;
      item.groupKey ||= item.deduplicationKey; item.recommendedAction ||= item.suggestedAction; item.autoResolve ??= true;
      item.occurrenceCount ||= 1;
      resetClearObservations(item, 'UNKNOWN');
      if (status === 'new') { item.acknowledgedAt = undefined; item.resolvedAt = undefined; item.ignoredReason = undefined; item.cooldownUntil = undefined; }
      if (status === 'acknowledged') { item.acknowledgedAt = now; item.resolvedAt = undefined; item.ignoredReason = undefined; item.cooldownUntil = undefined; }
      if (status === 'in_progress') { item.resolvedAt = undefined; item.ignoredReason = undefined; item.cooldownUntil = undefined; }
      if (status === 'ignored') {
        item.resolvedAt = undefined; item.ignoredReason = reason!.trim().slice(0, 500);
        item.cooldownUntil = new Date(nowMs + CONFIG.cooldown.alertHours * 60 * 60_000).toISOString();
        item.suppressionUntil = item.cooldownUntil;
      }
      updated.push({ ...item });
    }
    return items;
  });
  return updated;
}

export async function updateAlertStatus(id: string, status: ProductAlert['status'], reason?: string, nowMs = Date.now()): Promise<ProductAlert | null> {
  return (await updateAlertStatuses([id], status, reason, nowMs))[0] || null;
}

export async function generateRecommendedActions(now = Date.now()): Promise<RecommendedAction[]> {
  const [products, alerts, accessTrade] = await Promise.all([getAllProducts(), listAlerts({ limit: 500 }), getPrimaryCredential('accesstrade')]);
  const drafts: Array<Omit<RecommendedAction, 'id' | 'createdAt' | 'status'>> = [];
  const activeAlerts = alerts.filter(item => !['resolved', 'ignored'].includes(item.status));
  if (!accessTrade || accessTrade.status !== 'valid') drafts.push({
    deduplicationKey: 'today:connect-accesstrade', title: 'Hoàn tất kết nối AccessTrade', reason: 'Nguồn AccessTrade chưa có credential hợp lệ.', priority: 'high', objectCount: 1,
    impact: 'Mở khóa đồng bộ nguồn đã cấu hình.', estimatedTime: '5–10 phút', href: '/dashboard/token-vault', completionCriteria: 'Credential AccessTrade được kiểm tra hợp lệ.',
  });
  if (!products.length) drafts.push({
    deduplicationKey: 'today:import-first-product', title: 'Nhập sản phẩm đầu tiên', reason: 'Kho sản phẩm đang trống.', priority: 'high', objectCount: 0,
    impact: 'Tạo dữ liệu đầu vào cho toàn bộ workflow.', estimatedTime: '5 phút', href: '/dashboard/import', completionCriteria: 'Có ít nhất một sản phẩm nhập hợp lệ, chưa public.',
  });
  const brokenLinks = activeAlerts.filter(item => item.type === 'broken_link' || item.type === 'broken_affiliate_link');
  if (brokenLinks.length) drafts.push({
    deduplicationKey: 'today:broken-links', title: 'Kiểm tra link lỗi', reason: `${brokenLinks.length} link đang có cảnh báo.`, priority: brokenLinks.some(item => item.severity === 'critical') ? 'critical' : 'high',
    objectCount: brokenLinks.length, impact: 'Giảm CTA hỏng trên nội dung public.', estimatedTime: '10–30 phút', href: '/dashboard/alerts?type=broken_link', completionCriteria: 'Không còn cảnh báo link lỗi đang mở.',
  });
  const duplicates = activeAlerts.filter(item => item.type === 'duplicate_product');
  if (duplicates.length) drafts.push({
    deduplicationKey: 'today:duplicates', title: 'Xử lý nhóm nghi trùng', reason: `${duplicates.length} sản phẩm cần quyết định giữ hoặc hợp nhất.`, priority: 'high', objectCount: duplicates.length,
    impact: 'Tránh public và so sánh trùng dữ liệu.', estimatedTime: '10–20 phút', href: '/dashboard/quality?tab=duplicates', completionCriteria: 'Các nhóm confidence cao đã có quyết định.',
  });
  const staleSources = activeAlerts.filter(item => item.type === 'source_stale');
  if (staleSources.length) drafts.push({
    deduplicationKey: 'today:stale-sources', title: 'Kiểm tra nguồn chưa cập nhật', reason: `${staleSources.length} nguồn không có quan sát sản phẩm mới trong ngưỡng cấu hình.`, priority: 'high', objectCount: staleSources.length,
    impact: 'Khôi phục dữ liệu đầu vào và checkpoint của nguồn.', estimatedTime: '10–20 phút', href: '/dashboard/product-sources', completionCriteria: 'Nguồn có lần ghi nhận mới hoặc được tạm dừng có lý do.',
  });
  const publicRechecks = activeAlerts.filter(item => item.type === 'public_recheck');
  if (publicRechecks.length) drafts.push({
    deduplicationKey: 'today:public-recheck', title: 'Kiểm tra lại sản phẩm đang public', reason: `${publicRechecks.length} sản phẩm public có dữ liệu health, giá hoặc biên tập đã cũ.`, priority: 'high', objectCount: publicRechecks.length,
    impact: 'Giữ nội dung public trong giới hạn Safe Publish.', estimatedTime: '15–30 phút', href: '/dashboard/alerts?type=public_recheck', completionCriteria: 'Không còn cảnh báo public cần kiểm tra lại đang mở.',
  });
  const priceVariations = activeAlerts.filter(item => item.type === 'strong_price_variation');
  if (priceVariations.length) drafts.push({
    deduplicationKey: 'today:price-variation', title: 'Xác minh giá biến động mạnh', reason: `${priceVariations.length} sản phẩm có thay đổi lớn giữa hai snapshot giá gần nhất.`, priority: 'medium', objectCount: priceVariations.length,
    impact: 'Giảm nguy cơ dùng giá gốc bất thường trong Deal Score.', estimatedTime: '10–20 phút', href: '/dashboard/price-history', completionCriteria: 'Snapshot và nguồn giá của các sản phẩm đã được xác minh.',
  });
  const missingPrice = products.filter(product => !Number(product.price || product.salePrice || 0));
  if (missingPrice.length) drafts.push({
    deduplicationKey: 'today:missing-price', title: 'Bổ sung giá sản phẩm', reason: `${missingPrice.length} sản phẩm chưa có giá hợp lệ.`, priority: 'medium', objectCount: missingPrice.length,
    impact: 'Cải thiện Quality Score và mở khóa Deal Score.', estimatedTime: '10–30 phút', href: '/dashboard/products?qualityBand=blocked', completionCriteria: 'Sản phẩm mục tiêu có giá VND được xác minh.',
  });
  const highOpportunity = products.filter(product => (product.opportunityScore || 0) >= CONFIG.thresholds.opportunityPriority && product.contentWorkflowStatus !== 'published');
  if (highOpportunity.length) drafts.push({
    deduplicationKey: 'today:high-opportunity', title: 'Chuẩn bị nội dung ưu tiên cao', reason: `${highOpportunity.length} sản phẩm có Opportunity Score cao.`, priority: 'medium', objectCount: highOpportunity.length,
    impact: 'Đưa dữ liệu tốt vào Content Studio.', estimatedTime: '15–45 phút', href: '/dashboard/content?opportunityBand=priority', completionCriteria: 'Sản phẩm đã có draft hoặc quyết định tạm hoãn.',
  });
  if (activeAlerts.some(item => item.type === 'worker_stale')) drafts.push({
    deduplicationKey: 'today:worker-stale', title: 'Xử lý cảnh báo worker', reason: 'Worker không còn heartbeat mới.', priority: 'critical', objectCount: 1,
    impact: 'Khôi phục xử lý queue bền vững.', estimatedTime: '5–15 phút', href: '/dashboard/app-health', completionCriteria: 'Worker heartbeat trở lại trạng thái khỏe.',
  });
  if (activeAlerts.some(item => item.type === 'scheduler_stale')) drafts.push({
    deduplicationKey: 'today:scheduler-stale', title: 'Khôi phục scheduler', reason: 'Scheduler được cấu hình hoạt động nhưng chưa có heartbeat mới.', priority: 'high', objectCount: 1,
    impact: 'Khôi phục lịch chấm điểm, health check và tổng hợp dữ liệu.', estimatedTime: '5–15 phút', href: '/dashboard/automation', completionCriteria: 'Scheduler có heartbeat mới hoặc được tạm dừng rõ ràng.',
  });
  const selected = drafts.sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.priority) - ['critical', 'high', 'medium', 'low'].indexOf(b.priority));
  let result: RecommendedAction[] = [];
  await runTransaction<RecommendedAction>(ACTIONS, items => {
    const currentByKey = new Map<string, RecommendedAction>();
    for (const item of [...items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))) {
      if (!currentByKey.has(item.deduplicationKey)) currentByKey.set(item.deduplicationKey, item);
    }
    const visible: RecommendedAction[] = [];
    for (const draft of selected) {
      let current = currentByKey.get(draft.deduplicationKey);
      if (!current) {
        current = { ...draft, id: generateId(), status: 'new', createdAt: new Date(now).toISOString() };
        items.push(current);
        currentByKey.set(draft.deduplicationKey, current);
      } else if ((current.status === 'snoozed' || current.status === 'ignored') && cooldownActive(current.cooldownUntil, now)) {
        continue;
      } else {
        const reactivate = current.status === 'snoozed' || current.status === 'ignored';
        Object.assign(current, draft, reactivate ? { status: 'new', cooldownUntil: undefined, ignoredReason: undefined } : {});
      }
      if (visible.length < 5 && current.status !== 'snoozed' && current.status !== 'ignored') visible.push({ ...current });
    }
    result = visible;
    return items.slice(-500);
  });
  return result;
}

export async function updateRecommendedAction(id: string, status: RecommendedAction['status'], reason?: string, nowMs = Date.now()): Promise<RecommendedAction | null> {
  if (status === 'ignored' && String(reason || '').trim().length < 5) throw new Error('REASON_REQUIRED');
  let updated: RecommendedAction | null = null;
  await runTransaction<RecommendedAction>(ACTIONS, items => {
    const item = items.find(action => action.id === id); if (!item) return undefined;
    item.status = status;
    if (status === 'new' || status === 'seen') { item.cooldownUntil = undefined; item.ignoredReason = undefined; }
    if (status === 'snoozed' || status === 'ignored') item.cooldownUntil = new Date(nowMs + CONFIG.cooldown.recommendationHours * 60 * 60_000).toISOString();
    if (status === 'ignored') item.ignoredReason = reason!.trim().slice(0, 500);
    updated = { ...item }; return items;
  });
  return updated;
}
