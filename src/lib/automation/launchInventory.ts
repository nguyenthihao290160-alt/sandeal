import { createDefaultSourceAdapterRegistry, type SourceHealth, type SourceProviderStatus } from '@/lib/autonomous/sourceAdapterPlatform';
import { evaluateAutonomousPublish, verifyAutonomousPublishEvidence } from '@/lib/autonomous/publishPolicy';
import { isReviewIndexable } from '@/lib/editorialReview';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { getKeywordYieldReport } from '@/lib/bots/productPipeline';
import { getLatestRuntimeHealth } from './runtimeGuardian';
import {
  appendAutomationAudit,
  getAllAutomationJobs,
  getAutomationControl,
  getAutomationQueueStats,
} from './store';
import {
  getAutomationSettings,
  sanitizeAutomationSettings,
  updateAutomationSettings,
  type AutomationSettings,
} from '@/lib/storage/automationSettings';
import { getQueueStats, listCandidateQueue } from '@/lib/storage/candidateQueue';
import { getAllProducts } from '@/lib/storage/products';
import type { AutomationJob } from './types';
import type { Product } from '@/lib/types';

export const BOOTSTRAP_LAUNCH_PROFILE = Object.freeze({
  intervalHours: 3,
  maxItemsPerRun: 50,
  maxItemsPerDay: 200,
  bootstrapKeywordCount: 12,
  bootstrapCandidateLimit: 100,
  bootstrapReviewBatch: 20,
  maxConcurrency: 4,
  maxRunDurationMs: 600_000,
  sourceRequestBudgetPerDay: 2_000,
  networkCheckBudgetPerDay: 5_000,
  generationConcurrency: 2,
  safePublish: true,
  freeOnly: true,
  allowPaidAi: false,
  costMode: 'safe_free',
  launchEnabled: false,
}) satisfies Readonly<Partial<AutomationSettings>>;

const TARGET_READY_PRODUCTS = 100;
const FIRST_PUBLIC_TARGET = 50;
const GOOD_HEALTH = new Set(['ok', 'healthy', 'redirect_ok', 'redirected']);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validUrl(value?: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value || '').protocol); } catch { return false; }
}

function merchant(product: Partial<Product>): string {
  try { return new URL(product.originalUrl || product.affiliateUrl || '').hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return 'unknown'; }
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator * 100).toFixed(2)) : null;
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export async function previewBootstrapLaunchProfile() {
  const current = await getAutomationSettings();
  const proposed = sanitizeAutomationSettings({ ...current, ...BOOTSTRAP_LAUNCH_PROFILE });
  const changes = Object.entries(BOOTSTRAP_LAUNCH_PROFILE).flatMap(([key]) => {
    const field = key as keyof AutomationSettings;
    return JSON.stringify(current[field]) === JSON.stringify(proposed[field]) ? [] : [{ field, current: current[field], proposed: proposed[field] }];
  });
  const cyclesPerDay = Math.floor(24 / proposed.intervalHours);
  return {
    profile: 'BOOTSTRAP_LAUNCH' as const,
    current,
    proposed,
    changes,
    estimatedThroughput: {
      scheduledCyclesPerDay: cyclesPerDay,
      maximumCandidatesPerRun: proposed.maxItemsPerRun,
      maximumCandidatesPerDay: proposed.maxItemsPerDay,
      bootstrapCandidatePoolPerScan: proposed.bootstrapCandidateLimit,
      reviewBatchPerCycle: proposed.bootstrapReviewBatch,
      targetReadyProducts: TARGET_READY_PRODUCTS,
      firstPublicTarget: FIRST_PUBLIC_TARGET,
      estimateOnly: true,
    },
    warnings: [
      'Sản lượng thực tế phụ thuộc dữ liệu nguồn, rate limit, health, dedupe và evidence; không cam kết đủ 200 candidate/ngày.',
      'Profile giữ launchEnabled=false; không bật CANARY, AUTONOMOUS hoặc publish.',
      'Owner phải xác nhận server-side trước khi apply.',
    ],
  };
}

export async function applyBootstrapLaunchProfile(input: { actor: string; reason: string; confirmed: boolean }) {
  if (!input.confirmed) throw new Error('BOOTSTRAP_PROFILE_CONFIRMATION_REQUIRED');
  if (input.reason.trim().length < 8) throw new Error('BOOTSTRAP_PROFILE_REASON_REQUIRED');
  const preview = await previewBootstrapLaunchProfile();
  const next = await updateAutomationSettings(BOOTSTRAP_LAUNCH_PROFILE);
  const canaryController = await import('./canaryController');
  const currentCanary = await canaryController.getCanaryState();
  if (!currentCanary.controlledLaunch) {
    await canaryController.activateControlledLaunch({ actor: input.actor, reason: input.reason });
  }
  await appendAutomationAudit({
    correlationId: `bootstrap-profile:${Date.now()}`,
    operationId: `bootstrap-profile:${Date.now()}`,
    operationType: 'BOOTSTRAP_PROFILE_APPLIED',
    actor: input.actor,
    target: 'automation-settings',
    previousState: JSON.stringify(preview.current),
    nextState: JSON.stringify(next),
    risk: 'MEDIUM',
    result: { profile: 'BOOTSTRAP_LAUNCH', changedFields: preview.changes.map(change => change.field), launchEnabled: next.launchEnabled },
    reasons: [input.reason],
    dryRun: false,
    attempts: 1,
  });
  return { ...preview, applied: true as const, next };
}

function preliminaryLaunchBlockers(product: Product, now: number): string[] {
  const reasons: string[] = [];
  const title = String(product.title || '').trim();
  const observedAt = Date.parse(product.lastSeenAt || product.updatedAt || '');
  if (product.recordType !== 'PRODUCT') reasons.push('record_type_not_product');
  if (product.classification?.action !== 'ACCEPT') reasons.push('classification_not_accepted');
  if (product.lifecycleState !== 'READY_FOR_PUBLISH') reasons.push('lifecycle_not_ready');
  if (product.verifiedSource !== true && product.sourceVerified !== true) reasons.push('source_not_verified');
  if (title.length < 8 || /^(?:sản phẩm|deal|khuyến mãi|ưu đãi|voucher)\b/i.test(title)) reasons.push('title_not_specific');
  if (!(Number(product.salePrice || product.price) > 0)) reasons.push('price_missing');
  if (!validUrl(product.originalUrl) || !GOOD_HEALTH.has(String(product.linkHealthStatus || product.productHealthStatus || ''))) reasons.push('product_link_blocked');
  if (!validUrl(product.affiliateUrl) || !GOOD_HEALTH.has(String(product.affiliateHealthStatus || ''))) reasons.push('affiliate_link_blocked');
  if (!validUrl(product.imageUrl) || !GOOD_HEALTH.has(String(product.imageHealthStatus || ''))) reasons.push('image_blocked');
  if (product.duplicateStatus !== 'CLEAR') reasons.push('duplicate_unresolved');
  if (product.riskLevel !== 'low') reasons.push('risk_not_low');
  if (Number(product.evidenceCoverage || 0) < 0.8) reasons.push('evidence_coverage_low');
  if (product.claimValidationStatus !== 'VERIFIED') reasons.push('claim_evidence_unverified');
  if (!['FRESH', 'AGING'].includes(String(product.priceTruthState || ''))) reasons.push('price_truth_unsafe');
  if (!Number.isFinite(observedAt) || now - observedAt > 14 * 24 * 60 * 60_000) reasons.push('product_stale');
  if (!isReviewIndexable(product)) reasons.push('seo_not_indexable');
  if (product.sourceHealthCooldownUntil && Date.parse(product.sourceHealthCooldownUntil) > now) reasons.push('cooldown_active');
  if (product.lifecycleState === 'QUARANTINED' || product.publicDecision === 'quarantined') reasons.push('product_quarantined');
  if (product.publicBlockReasons?.length) reasons.push(...product.publicBlockReasons);
  return [...new Set(reasons)];
}

function estimatedWaveCount(totalReady: number): number {
  if (totalReady <= 0) return 0;
  if (totalReady <= 10) return 1;
  if (totalReady <= 35) return 2;
  return 2 + Math.ceil((totalReady - 35) / 50);
}

export async function buildLaunchReadyReport() {
  const now = Date.now();
  const [products, candidates] = await Promise.all([getAllProducts(), listCandidateQueue()]);
  const candidateKeyword = new Map(candidates.map(candidate => [`${candidate.source}:${candidate.sourceId}`, candidate.keyword || 'unknown']));
  const ready: Product[] = [];
  const blockers = new Map<string, number>();

  for (const product of products.filter(item => !(item.status === 'published' && item.publicHidden === false))) {
    const reasons = preliminaryLaunchBlockers(product, now);
    if (!reasons.length) {
      const evidence = await verifyAutonomousPublishEvidence(product, now);
      const decision = evaluateAutonomousPublish(product, {
        mode: 'CANARY', killSwitch: false, publishPaused: false,
        workerId: 'launch-readiness-report', jobType: 'AUTO_SAFE_PUBLISH', jobClaimedBy: 'launch-readiness-report',
        withinBudget: true, withinCanaryWave: true, now,
      }, evidence);
      if (decision.eligible) ready.push(product);
      else reasons.push(...decision.reasons);
    }
    for (const reason of new Set(reasons)) blockers.set(reason, (blockers.get(reason) || 0) + 1);
  }

  const group = (selector: (product: Product) => string) => Object.fromEntries([...ready.reduce((map, product) => {
    const key = selector(product) || 'unknown'; map.set(key, (map.get(key) || 0) + 1); return map;
  }, new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const timestamps = ready.map(product => product.lifecycleUpdatedAt || product.updatedAt).filter((value): value is string => Boolean(value)).sort();
  const publicCount = products.filter(isPublicSafeProduct).length;
  return {
    totalReady: ready.length,
    readyByCategory: group(product => String(product.category || 'unknown')),
    readyByMerchant: group(product => merchant(product)),
    readyByKeyword: group(product => candidateKeyword.get(`${product.source}:${product.sourceId || product.externalId || ''}`) || 'unknown'),
    blockedByReason: Object.fromEntries([...blockers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    oldestReady: timestamps[0] || null,
    newestReady: timestamps.at(-1) || null,
    estimatedWaveCount: estimatedWaveCount(ready.length),
    targetPublicCount: FIRST_PUBLIC_TARGET,
    targetReadyProducts: TARGET_READY_PRODUCTS,
    progressToTarget: percentage(ready.length, TARGET_READY_PRODUCTS),
    currentPublicCount: publicCount,
  };
}

function latestJob(jobs: AutomationJob[], types: AutomationJob['type'][]): AutomationJob | undefined {
  return [...jobs].filter(job => types.includes(job.type)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function sourceBlocker(status: SourceProviderStatus, reason: string): string | null {
  if (reason === 'source_scan_completed') return 'SOURCE_READY';
  if (reason === 'source_budget_exhausted') return 'SOURCE_BUDGET_EXHAUSTED';
  if (reason === 'source_no_results') return 'SOURCE_NO_RESULTS';
  if (reason === 'source_timeout') return 'SOURCE_TIMEOUT';
  if (reason === 'source_keywords_exhausted') return 'SOURCE_KEYWORDS_EXHAUSTED';
  const map: Partial<Record<SourceProviderStatus, string>> = {
    not_configured: 'SOURCE_NOT_CONFIGURED', configured: 'SOURCE_CONFIGURED_NOT_PROBED', ready: 'SOURCE_READY',
    invalid_credential: 'SOURCE_INVALID_CREDENTIAL', rate_limited: 'SOURCE_RATE_LIMITED', circuit_open: 'SOURCE_CIRCUIT_OPEN',
    quota_exhausted: 'SOURCE_BUDGET_EXHAUSTED', degraded: 'SOURCE_DEGRADED', last_check_failed: 'SOURCE_DEGRADED',
    adapter_unavailable: 'SOURCE_DEGRADED',
  };
  return map[status] || null;
}

function operatorRecommendation(code: string): string {
  const recommendations: Record<string, string> = {
    SOURCE_NOT_CONFIGURED: 'Cấu hình hoặc xác minh AccessTrade; nếu chưa sẵn sàng, dùng Import Center với datafeed được phép.',
    SOURCE_CONFIGURED_NOT_PROBED: 'Chạy probe nguồn có kiểm soát trước khi bật ingestion.',
    SOURCE_NO_RESULTS: 'Xem keyword kém hiệu quả và dùng datafeed được owner phê duyệt nếu nguồn tiếp tục trả 0.',
    INGESTION_PAUSED: 'Owner xem trước BOOTSTRAP_LAUNCH và chỉ apply sau khi xác nhận.',
    SCHEDULER_PAUSED: 'Xác minh worker/scheduler rồi owner mới tiếp tục scheduler trong SHADOW.',
    WORKER_MISSING: 'Khởi động đúng một worker bằng runtime opt-in sau deployment được duyệt.',
    WORKER_STALE: 'Kiểm tra heartbeat/lease worker trước khi tạo thêm tác vụ.',
    NO_CANDIDATES: 'Chạy source scan có budget hoặc import datafeed thật đã được phép.',
    PRODUCTS_READY_FOR_LAUNCH: 'Giữ SHADOW, kiểm tra health và phê duyệt Wave 1 tối đa 10 sản phẩm.',
    MODE_OBSERVE: 'Chỉ đổi mode sau backup, health evidence và xác nhận owner; build này không tự đổi mode.',
    MODE_SHADOW: 'Tiếp tục tích lũy launch-ready pool và health evidence trước Wave 1.',
    LAUNCH_DISABLED: 'Giữ launch disabled cho tới controlled deployment và xác nhận wave.',
    NO_ELIGIBLE_PRODUCTS: 'Xử lý các blocker link, ảnh, giá, evidence, duplicate và freshness theo báo cáo launch-ready.',
  };
  return recommendations[code] || 'Mở dashboard để xử lý blocker đầu tiên; không bulk publish hoặc bỏ qua Safe Publish.';
}

export async function buildZeroProductDiagnostic() {
  const [jobs, products, candidateCounts, candidates, jobCounts, settings, control, runtime, launchReady] = await Promise.all([
    getAllAutomationJobs(), getAllProducts(), getQueueStats(), listCandidateQueue(), getAutomationQueueStats(),
    getAutomationSettings(), getAutomationControl(), getLatestRuntimeHealth(), buildLaunchReadyReport(),
  ]);
  const sourceJob = latestJob(jobs, ['AUTO_PILOT', 'PRODUCT_SCAN']);
  const sourceResult = object(sourceJob?.result);
  const sourceAdapter = createDefaultSourceAdapterRegistry().get('accesstrade');
  const adapterHealth: SourceHealth = sourceAdapter
    ? await sourceAdapter.healthCheck().catch(() => ({ status: 'last_check_failed', configured: false, ready: false }))
    : { status: 'adapter_unavailable', configured: false, ready: false };
  const sourceStatus = String(sourceResult.sourceStatus || runtime?.providers.accessTrade || adapterHealth.status) as SourceProviderStatus;
  const sourceReason = String(sourceResult.sourceReason || sourceResult.reason || adapterHealth.reason || 'source_not_probed');
  const sourceCode = sourceBlocker(sourceStatus, sourceReason);
  const publicProductCount = products.filter(isPublicSafeProduct).length;
  const quarantineCount = products.filter(product => product.lifecycleState === 'QUARANTINED' || product.publicDecision === 'quarantined').length;
  const duplicateCount = products.filter(product => product.duplicateStatus && product.duplicateStatus !== 'CLEAR').length
    + candidates.filter(candidate => /duplicate/i.test(candidate.delayReason || '')).length;
  const invalidCount = products.filter(product => product.recordType && product.recordType !== 'PRODUCT').length
    + candidates.filter(candidate => ['failed', 'discarded'].includes(candidate.status) && !/duplicate/i.test(candidate.delayReason || '')).length;
  const publishBlockedCount = Math.max(0, products.length - publicProductCount - launchReady.totalReady);
  const workerHeartbeat = Date.parse(control.workerHeartbeatAt || '');
  const workerMissing = !control.workerHeartbeatAt;
  const workerStale = !workerMissing && (!Number.isFinite(workerHeartbeat) || Date.now() - workerHeartbeat > 90_000);
  const blockers: string[] = [];

  if (publicProductCount === 0 && launchReady.totalReady > 0) {
    blockers.push(control.killSwitch ? 'KILL_SWITCH' : control.publishPaused ? 'PUBLISH_PAUSED' : !settings.launchEnabled ? 'LAUNCH_DISABLED'
      : control.effectiveMode === 'OBSERVE' ? 'MODE_OBSERVE' : control.effectiveMode === 'SHADOW' ? 'MODE_SHADOW' : 'PRODUCTS_READY_FOR_LAUNCH');
  } else if (publicProductCount === 0 && products.length > 0) {
    blockers.push('NO_ELIGIBLE_PRODUCTS');
  } else if (publicProductCount === 0 && candidateCounts.total > 0) {
    if (control.killSwitch) blockers.push('KILL_SWITCH');
    if (control.workerPaused) blockers.push('INGESTION_PAUSED');
    if (workerMissing) blockers.push('WORKER_MISSING'); else if (workerStale) blockers.push('WORKER_STALE');
    if (candidateCounts.processing) blockers.push('CANDIDATES_PROCESSING');
    else if (candidateCounts.delayed || candidateCounts.failed) blockers.push('CANDIDATES_RETRY');
    else blockers.push('CANDIDATES_WAITING');
  } else if (publicProductCount === 0) {
    if (sourceCode && sourceCode !== 'SOURCE_READY') blockers.push(sourceCode);
    if (!settings.enabled) blockers.push('INGESTION_PAUSED');
    if (control.schedulerPaused) blockers.push('SCHEDULER_PAUSED');
    if (workerMissing) blockers.push('WORKER_MISSING'); else if (workerStale) blockers.push('WORKER_STALE');
    blockers.push('NO_CANDIDATES');
  }
  if (settings.maxItemsPerDay <= 0) blockers.push('DAILY_LIMIT_REACHED');
  if (control.killSwitch) blockers.push('KILL_SWITCH');
  if (!settings.launchEnabled) blockers.push('LAUNCH_DISABLED');
  if (control.effectiveMode === 'OBSERVE') blockers.push('MODE_OBSERVE');
  if (control.effectiveMode === 'SHADOW') blockers.push('MODE_SHADOW');
  const uniqueBlockers = [...new Set(blockers)];
  const primaryBlocker = publicProductCount > 0 ? 'NONE' : uniqueBlockers[0] || 'NO_CANDIDATES';
  const latestWorkerSuccess = [...jobs].filter(job => job.status === 'SUCCEEDED' && job.claimedBy).sort((a, b) => Date.parse(b.completedAt || b.updatedAt) - Date.parse(a.completedAt || a.updatedAt))[0];
  const sourceMetrics = object(sourceResult.sourceMetrics);
  return {
    primaryBlocker,
    secondaryBlockers: uniqueBlockers.filter(code => code !== primaryBlocker),
    sourceStatus: sourceCode || 'SOURCE_DEGRADED',
    sourceReason,
    sourceCheckedAt: String(sourceResult.sourceCheckedAt || sourceJob?.completedAt || sourceJob?.updatedAt || adapterHealth.checkedAt || '') || null,
    publicProductCount,
    totalProductRecords: products.length,
    candidateQueue: candidateCounts,
    jobQueue: jobCounts,
    readyForLaunchCount: launchReady.totalReady,
    publishBlockedCount,
    quarantineCount,
    duplicateCount,
    invalidCount,
    lastSourceRun: sourceJob ? {
      jobId: sourceJob.id, status: sourceJob.status, checkedAt: sourceJob.completedAt || sourceJob.updatedAt,
      found: Number(object(sourceResult.summary).found || 0), queued: Number(object(sourceResult.summary).queued || 0),
      normalized: Number(sourceMetrics.normalized || 0), reason: sourceReason,
    } : null,
    lastWorkerSuccess: latestWorkerSuccess?.completedAt || latestWorkerSuccess?.updatedAt || null,
    lastSchedulerSuccess: control.schedulerLastRunAt || null,
    nextAutomaticAction: primaryBlocker === 'PRODUCTS_READY_FOR_LAUNCH' ? 'PREVIEW_WAVE_1'
      : primaryBlocker === 'NO_ELIGIBLE_PRODUCTS' ? 'REVIEW_LAUNCH_BLOCKERS'
        : ['SOURCE_NOT_CONFIGURED', 'SOURCE_NO_RESULTS', 'SOURCE_DEGRADED'].includes(primaryBlocker) ? 'OPEN_APPROVED_DATAFEED_IMPORT'
          : 'RESOLVE_PRIMARY_BLOCKER',
    recommendedOperatorAction: operatorRecommendation(primaryBlocker),
  };
}

export async function buildCandidateProcessingMetrics(launchReadyCount?: number) {
  const [jobs, candidates, products] = await Promise.all([getAllAutomationJobs(), listCandidateQueue(), getAllProducts()]);
  const processJobs = jobs.filter(job => job.type === 'PROCESS_CANDIDATE');
  const terminal = processJobs.filter(job => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(job.status));
  const durations = terminal.map(job => Date.parse(job.completedAt || job.updatedAt) - Date.parse(job.startedAt || job.createdAt)).filter(value => Number.isFinite(value) && value >= 0);
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const waits = processJobs.map(job => {
    const candidate = candidateById.get(String(job.payload.candidateId || ''));
    return candidate && job.startedAt ? Date.parse(job.startedAt) - Date.parse(candidate.createdAt) : Number.NaN;
  }).filter(value => Number.isFinite(value) && value >= 0);
  const span = terminal.length > 1
    ? Math.max(...terminal.map(job => Date.parse(job.completedAt || job.updatedAt))) - Math.min(...terminal.map(job => Date.parse(job.startedAt || job.createdAt)))
    : 0;
  const ready = launchReadyCount ?? (await buildLaunchReadyReport()).totalReady;
  const published = products.filter(isPublicSafeProduct).length;
  const reasons = new Map<string, number>();
  for (const candidate of candidates) for (const reason of String(candidate.delayReason || '').split(',').filter(Boolean)) reasons.set(reason, (reasons.get(reason) || 0) + 1);
  return {
    processingRatePerMinute: span > 0 ? Number((terminal.length / (span / 60_000)).toFixed(2)) : null,
    averageCandidateDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    queueWaitP50: percentile(waits, 0.5),
    queueWaitP95: percentile(waits, 0.95),
    networkFailureRate: percentage(terminal.filter(job => job.status === 'FAILED' && /timeout|network|dns|rate/i.test(`${job.lastErrorCode || ''}:${job.lastErrorMessage || ''}`)).length, terminal.length),
    validToReadyRate: percentage(ready, candidates.filter(candidate => ['completed', 'needs_review', 'discarded'].includes(candidate.status)).length),
    readyToPublishedRate: percentage(published, ready + published),
    topBlockReasons: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)),
    sampleSize: terminal.length,
  };
}

export async function buildLaunchInventoryOverview() {
  const [diagnostic, launchReady, bootstrap, keywords] = await Promise.all([
    buildZeroProductDiagnostic(), buildLaunchReadyReport(), previewBootstrapLaunchProfile(), getKeywordYieldReport(5),
  ]);
  return { diagnostic, launchReady, bootstrap, keywords, processing: await buildCandidateProcessingMetrics(launchReady.totalReady) };
}
