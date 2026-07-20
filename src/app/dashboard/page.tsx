'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DashboardIcon, type DashboardIconName } from '@/components/dashboard/dashboard-icon';
import { BusinessOverview } from '@/components/dashboard/business-overview';
import styles from './dashboard.module.css';

type Range = 'today' | '7d' | '30d';
type Envelope<T> = { ok: boolean; code: string; message: string; data?: T };
type ActivityPoint = { label: string; completed: number; failed: number; retried: number; blocked: number; scanned: number };
type OnboardingStep = { id: string; title: string; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED'; reason: string; cta: string; route: string; completionCriteria: string; updatedAt: string };
type OnboardingRecommendation = Pick<OnboardingStep, 'id' | 'title' | 'reason' | 'route' | 'cta' | 'status'>;
type JobDiagnostic = { id: string; type: string; status: string; outcomeStatus: string | null; updatedAt: string; nextRetryAt: string | null; lastErrorCode: string | null; lastErrorMessage: string | null; reasons: string[]; schemaVersion: number; policyVersion: string; handlerVersion: string };
type RoleDiagnostic = { processStatus: string; activeRole: boolean; roleState: string; owner: string | null; instanceId: string | null; heartbeatAt: string | null; acquiredAt: string | null; leaseAgeMs: number | null; expiresAt: string | null; fencingToken: number | null; takeoverCount: number };
type KeywordYield = { keyword: string; requests: number; found: number; valid: number; ready: number; published: number; noResult: number; timeout: number; rateLimited: number; costPerValidCandidate: number | null; lastUsedAt?: string; nextEligibleAt?: string };
type DashboardData = {
  updatedAt: string; range: Range;
  kpis: { productsProcessed: number; running: number; waiting: number; waitingApproval: number; completionRate: number | null; systemErrors: number };
  activity: ActivityPoint[];
  sourcePerformance: Array<{ name: string; total: number; valid: number; rate: number }>;
  queue: Record<string, number>;
  worker: { status: string; heartbeatAt: string | null; workerId: string | null; currentJobId: string | null };
  scheduler: { status: string; lastRunAt: string | null; nextRunAt: string | null; timezone: string };
  aiUsage: { requests: number; requestLimit: number; tokens: number; tokenLimit: number; blocked: number; freeOnly: boolean };
  circuits: Array<{ provider: string; state: string }>;
  runtime: {
    web: { status: string; checkedAt: string | null };
    worker: RoleDiagnostic;
    scheduler: RoleDiagnostic & { lastContenderState: string; rejectedOwner: string | null; rejectedAt: string | null; historicalErrorLabel: string | null; lastSuccessfulTickAt: string | null; nextRunAt: string | null };
    guardianCheckedAt: string | null; reasons: string[];
  };
  control: { mode: string; effectiveMode: string; publishPaused: boolean; ingestionPaused: boolean; workerPaused: boolean; schedulerPaused: boolean; killSwitch: boolean; launchEnabled: boolean; reason: string | null; safePublish: { state: string; reasons: string[] } };
  pipeline: { sourceRequests: number; sourceFound: number; candidateQueued: number; duplicateRejected: number; validationRejected: number; productCreated: number; productUpdated: number; publishEligible: number; publishBlocked: number; quarantined: number; failed: number; durationMs: number };
  jobs: { productScan: JobDiagnostic | null; autoPilot: JobDiagnostic | null; runtimeGuardian: JobDiagnostic | null; latestError: JobDiagnostic | null };
  providers: Array<{ id: string; status: string; configured: boolean | null; ready: boolean; degraded: boolean; checkedAt: string | null }>;
  business: { publicProducts: number; freshPrice: number; stalePrice: number; healthyAffiliateLinks: number; brokenLinks: number; outboundClicks: number; degradedProviders: string[] };
  inventory: {
    diagnostic: { primaryBlocker: string; secondaryBlockers: string[]; sourceStatus: string; sourceReason: string; publicProductCount: number; totalProductRecords: number; readyForLaunchCount: number; publishBlockedCount: number; quarantineCount: number; duplicateCount: number; invalidCount: number; nextAutomaticAction: string; recommendedOperatorAction: string };
    launchReady: { totalReady: number; readyByCategory: Record<string, number>; readyByMerchant: Record<string, number>; readyByKeyword: Record<string, number>; blockedByReason: Record<string, number>; oldestReady: string | null; newestReady: string | null; estimatedWaveCount: number; targetPublicCount: number; targetReadyProducts: number; progressToTarget: number | null; currentPublicCount: number; inventoryFunnel: { totalSourceRecords: number; productsClassified: number; vouchersCampaignsAndStoreOffersExcluded: number; productsLinkValid: number; productsImageValid: number; productsPriceValid: number; productsDeduped: number; readyForPublish: number; published: number; blocked: number; fixtureRecordsExcluded: number } };
    bootstrap: { profile: 'BOOTSTRAP_LAUNCH'; changes: Array<{ field: string; current: unknown; proposed: unknown }>; estimatedThroughput: { scheduledCyclesPerDay: number; maximumCandidatesPerRun: number; maximumCandidatesPerDay: number; bootstrapCandidatePoolPerScan: number; reviewBatchPerCycle: number; targetReadyProducts: number; firstPublicTarget: number; estimateOnly: true }; warnings: string[] };
    keywords: { top: KeywordYield[]; poor: KeywordYield[]; total: number };
    processing: { processingRatePerMinute: number | null; averageCandidateDurationMs: number | null; queueWaitP50: number | null; queueWaitP95: number | null; networkFailureRate: number | null; validToReadyRate: number | null; readyToPublishedRate: number | null; topBlockReasons: Record<string, number>; sampleSize: number };
  };
  recentActivity: Array<{ id: string; operationId: string; type: string; status: string; requestedBy: string; riskLevel: string; updatedAt: string; durationMs: number | null }>;
  zeroData: boolean;
  onboarding: { compact: boolean; summary: { completed: number; total: number; blocked: number; inProgress: number }; steps: OnboardingStep[]; recommendations: OnboardingRecommendation[]; updatedAt: string };
  groups: {
    workItems: { waitingApproval: number; waitingManual: number; failed: number; openAlerts: number };
    dataReadiness: { products: number; enabledSources: number; pendingSources: number; unscored: number };
    qualityContent: { scored: number; drafts: number; editorialChecked: number };
    botOperations: { running: number; waiting: number; waitingManual: number };
    growth: { published: number; outboundEvents: number; openAlerts: number };
  };
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Chờ xử lý', WAITING_APPROVAL: 'Chờ phê duyệt', WAITING_FOR_MANUAL_INPUT: 'Chờ thông tin thủ công', WAITING_CHILDREN: 'Chờ tác vụ con', RUNNING: 'Đang xử lý', RETRY_SCHEDULED: 'Đang chờ thử lại',
  SUCCEEDED: 'Hoàn thành', FAILED: 'Thất bại', CANCELLED: 'Đã hủy', BLOCKED: 'Bị chặn', PAUSED: 'Đã tạm dừng',
  active: 'Đang hoạt động', paused: 'Đã tạm dừng', stale: 'Mất tín hiệu', unverified: 'Không thể xác minh', not_configured: 'Chưa cấu hình',
};
const TYPE_LABELS: Record<string, string> = {
  PRODUCT_SCAN: 'Quét sản phẩm', AUTO_PILOT: 'Chế độ tự động', SAFE_PUBLISH: 'Đăng an toàn', AI_ANALYSIS: 'Phân tích AI', HEALTH_CHECK: 'Kiểm tra hệ thống',
  IMPORT_PRODUCTS: 'Nhập sản phẩm', RECHECK_PRODUCT_HEALTH: 'Kiểm tra lại link và ảnh', DETECT_DUPLICATES: 'Phát hiện trùng lặp', SCORE_PRODUCTS: 'Chấm điểm sản phẩm',
  CAPTURE_PRICE_HISTORY: 'Ghi nhận lịch sử giá', PREPARE_CONTENT_DRAFT: 'Chuẩn bị khung nội dung', EDITORIAL_CHECK: 'Kiểm tra biên tập', EVALUATE_ALERTS: 'Đánh giá cảnh báo',
  AGGREGATE_GROWTH_METRICS: 'Tổng hợp tăng trưởng', BULK_PRODUCT_OPERATION: 'Thao tác hàng loạt',
};
const RISK_LABELS: Record<string, string> = { LOW: 'Rủi ro thấp', MEDIUM: 'Rủi ro trung bình', HIGH: 'Rủi ro cao', BLOCKER: 'Bị chặn' };

const MODE_LABELS: Record<string, string> = { OBSERVE: 'Chỉ quan sát', SHADOW: 'Chạy bóng an toàn', CANARY: 'Canary có kiểm soát', AUTONOMOUS: 'Tự động có kiểm soát', EMERGENCY_STOP: 'Dừng khẩn cấp' };
const RUNTIME_LABELS: Record<string, string> = { ready: 'Sẵn sàng', alive: 'Đang phục vụ', active: 'Đang giữ vai trò', paused: 'Đã tạm dừng', disabled: 'Chưa bật', stale: 'Mất tín hiệu', missing: 'Không có tiến trình', crashed: 'Đã dừng bất thường', unverified: 'Chưa xác minh', standby: 'Chờ dự phòng', rejected: 'Bị từ chối vai trò', configured: 'Đã cấu hình, chưa sẵn sàng', not_configured: 'Chưa cấu hình', degraded: 'Suy giảm' };
const REASON_LABELS: Record<string, string> = {
  safe_publish_disabled: 'Safe Publish đang tắt', launch_not_enabled: 'Chưa cho phép khởi chạy đăng',
  kill_switch_active: 'Dừng khẩn cấp đang bật', publish_paused: 'Luồng đăng đang tạm dừng',
  effective_mode_not_publishable: 'Chế độ hiệu lực không cho phép đăng',
};

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa có dữ liệu';
}

function formatDuration(value: number | null): string {
  if (value === null) return 'Chưa xác minh';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${Math.round(value / 1000)} giây`;
  return `${Math.round(value / 60_000)} phút`;
}

function JobDiagnosticCard({ title, job }: { title: string; job: JobDiagnostic | null }) {
  return <article className={styles.diagnosticCard}><h3>{title}</h3>{job ? <>
    <div className={styles.diagnosticHeadline}><span className={styles.statusText}>{STATUS_LABELS[job.status] || job.status}</span><time dateTime={job.updatedAt}>{formatTime(job.updatedAt)}</time></div>
    {job.reasons.length ? <p className={styles.reasonText}>Lý do: {job.reasons.join(' · ')}</p> : <p className={styles.mutedText}>Không có lỗi hoặc lý do chặn được ghi nhận.</p>}
    <dl className={styles.compactDetails}><div><dt>Thử lại</dt><dd>{formatTime(job.nextRetryAt)}</dd></div><div><dt>Hợp đồng</dt><dd>schema {job.schemaVersion} · policy {job.policyVersion} · handler {job.handlerVersion}</dd></div></dl>
  </> : <p className={styles.mutedText}>Chưa có tác vụ loại này.</p>}</article>;
}

function OwnerDiagnostics({ data, selectedMode, setSelectedMode, openControl, runDry, submitting }: {
  data: DashboardData; selectedMode: string; setSelectedMode: (mode: string) => void;
  openControl: (input: { action: string; title: string; danger?: boolean; mode?: string; profile?: string }) => void;
  runDry: () => void; submitting: boolean;
}) {
  const pipelineMetrics: Array<[string, string | number]> = [
    ['Yêu cầu nguồn', data.pipeline.sourceRequests], ['Nguồn tìm thấy', data.pipeline.sourceFound], ['Candidate vào hàng', data.pipeline.candidateQueued],
    ['Trùng lặp bị loại', data.pipeline.duplicateRejected], ['Validation bị loại', data.pipeline.validationRejected], ['Sản phẩm tạo', data.pipeline.productCreated],
    ['Sản phẩm cập nhật', data.pipeline.productUpdated], ['Đủ điều kiện đăng', data.pipeline.publishEligible], ['Bị chặn đăng', data.pipeline.publishBlocked],
    ['Quarantine', data.pipeline.quarantined], ['Thất bại', data.pipeline.failed], ['Thời gian', formatDuration(data.pipeline.durationMs)],
  ];
  const businessMetrics: Array<[string, string | number]> = [
    ['Sản phẩm public', data.business.publicProducts], ['Giá fresh', data.business.freshPrice], ['Giá stale / xung đột', data.business.stalePrice],
    ['Affiliate khỏe', data.business.healthyAffiliateLinks], ['Link hỏng', data.business.brokenLinks], ['Outbound click', data.business.outboundClicks],
    ['Provider suy giảm', data.business.degradedProviders.length],
  ];
  const paused = data.control.schedulerPaused || data.control.publishPaused;
  const topBlockers = Object.entries(data.inventory.launchReady.blockedByReason).slice(0, 5);
  const funnel = data.inventory.launchReady.inventoryFunnel;
  const funnelRows = [
    ['Bản ghi nguồn', funnel.totalSourceRecords, '/dashboard/product-sources'],
    ['Phân loại PRODUCT', funnel.productsClassified, '/dashboard/products?pipelineStage=classified'],
    ['Voucher/campaign/store offer đã loại', funnel.vouchersCampaignsAndStoreOffersExcluded, '/dashboard/product-sources'],
    ['Link hợp lệ', funnel.productsLinkValid, '/dashboard/products?pipelineStage=link_valid'],
    ['Ảnh hợp lệ', funnel.productsImageValid, '/dashboard/products?pipelineStage=image_valid'],
    ['Giá hợp lệ', funnel.productsPriceValid, '/dashboard/products?pipelineStage=price_valid'],
    ['Đã chống trùng', funnel.productsDeduped, '/dashboard/products?pipelineStage=deduped'],
    ['Sẵn sàng', funnel.readyForPublish, '/dashboard/products?pipelineStage=ready'],
    ['Đã public', funnel.published, '/dashboard/products?pipelineStage=published'],
    ['Bị chặn', funnel.blocked, '/dashboard/products?pipelineStage=blocked'],
  ] as const;
  return <>
    <section className={styles.metricGroups} aria-label="Chẩn đoán kho sản phẩm ra mắt">
      <article className={styles.panel}>
        <div className={styles.panelHeader}><div><h2><DashboardIcon name="warning" size={19} />Vì sao website chưa có sản phẩm?</h2><p>Chẩn đoán server-side từ source, queue, worker, sản phẩm và cổng publish.</p></div></div>
        <dl className={styles.details}>
          <div><dt>Chặn chính</dt><dd>{data.inventory.diagnostic.primaryBlocker}</dd></div>
          <div><dt>Nguồn</dt><dd>{data.inventory.diagnostic.sourceStatus}</dd></div>
          <div><dt>Public / tổng record</dt><dd>{data.inventory.diagnostic.publicProductCount} / {data.inventory.diagnostic.totalProductRecords}</dd></div>
          <div><dt>Sẵn sàng / bị chặn</dt><dd>{data.inventory.diagnostic.readyForLaunchCount} / {data.inventory.diagnostic.publishBlockedCount}</dd></div>
          <div><dt>Quarantine / trùng / lỗi</dt><dd>{data.inventory.diagnostic.quarantineCount} / {data.inventory.diagnostic.duplicateCount} / {data.inventory.diagnostic.invalidCount}</dd></div>
        </dl>
        {data.inventory.diagnostic.secondaryBlockers.length > 0 && <p className={styles.reasonText}>Chặn phụ: {data.inventory.diagnostic.secondaryBlockers.join(' · ')}</p>}
        <p className={styles.degradedNotice}>{data.inventory.diagnostic.recommendedOperatorAction}</p>
      </article>
      <article className={styles.panel}>
        <div className={styles.panelHeader}><div><h2><DashboardIcon name="product" size={19} />Kho sản phẩm sẵn sàng ra mắt</h2><p>Target là mục tiêu vận hành, không phải số liệu đã đạt.</p></div></div>
        <dl className={styles.details}>
          <div><dt>Sẵn sàng / target</dt><dd>{data.inventory.launchReady.totalReady} / {data.inventory.launchReady.targetReadyProducts}</dd></div>
          <div><dt>Tiến độ</dt><dd>{data.inventory.launchReady.progressToTarget === null ? 'Chưa có dữ liệu' : `${data.inventory.launchReady.progressToTarget}%`}</dd></div>
          <div><dt>Public target đầu</dt><dd>{data.inventory.launchReady.targetPublicCount}</dd></div>
          <div><dt>Số wave ước tính</dt><dd>{data.inventory.launchReady.estimatedWaveCount}</dd></div>
        </dl>
        {topBlockers.length ? <p className={styles.reasonText}>Blocker nhiều nhất: {topBlockers.map(([reason, count]) => `${reason} (${count})`).join(' · ')}</p> : <p className={styles.mutedText}>Chưa có blocker sản phẩm được ghi nhận.</p>}
        <div className={styles.metricList} aria-label="Funnel sản phẩm thật">{funnelRows.map(([label, value, href]) => <Link href={href} key={label}><span>{label}</span><strong>{value}</strong></Link>)}</div>
        {funnel.fixtureRecordsExcluded > 0 && <p className={styles.mutedText}>{funnel.fixtureRecordsExcluded} fixture/test record đã bị loại khỏi readiness.</p>}
        <div className={styles.advancedActions}><button type="button" onClick={() => openControl({ action: 'apply_bootstrap_profile', profile: 'BOOTSTRAP_LAUNCH', title: 'Áp dụng BOOTSTRAP_LAUNCH', danger: true })}>Xem và xác nhận profile bootstrap</button></div>
      </article>
    </section>
    <section className={styles.metricGroups} aria-label="Hiệu suất từ khóa">
      <article className={styles.panel}><div className={styles.panelHeader}><div><h2>Top keyword</h2><p>Ưu tiên theo valid rate, launch-ready rate và chi phí request/candidate.</p></div></div>{data.inventory.keywords.top.length ? <div className={styles.metricList}>{data.inventory.keywords.top.map(item => <div key={item.keyword}><span>{item.keyword}</span><strong>{item.ready}/{item.valid} ready</strong></div>)}</div> : <p className={styles.mutedText}>Chưa đủ dữ liệu keyword để xếp hạng.</p>}</article>
      <article className={styles.panel}><div className={styles.panelHeader}><div><h2>Keyword kém hiệu quả</h2><p>Không suy diễn khi chưa có request thực tế.</p></div></div>{data.inventory.keywords.poor.length ? <div className={styles.metricList}>{data.inventory.keywords.poor.map(item => <div key={item.keyword}><span>{item.keyword}</span><strong>{item.noResult} lần 0 kết quả</strong></div>)}</div> : <p className={styles.mutedText}>Chưa đủ dữ liệu keyword để đánh giá.</p>}</article>
    </section>
    <section className={styles.operationsGrid} aria-label="Trạng thái vận hành thực tế">
      <article className={styles.panel}>
        <div className={styles.panelHeader}><div><h2><DashboardIcon name="health" size={19} />Runtime</h2><p>Trạng thái tiến trình và vai trò chủ động là hai tín hiệu riêng.</p></div></div>
        <dl className={styles.details}>
          <div><dt>Web</dt><dd>{RUNTIME_LABELS[data.runtime.web.status] || data.runtime.web.status}</dd></div>
          <div><dt>Worker / vai trò</dt><dd>{RUNTIME_LABELS[data.runtime.worker.processStatus] || data.runtime.worker.processStatus} · {RUNTIME_LABELS[data.runtime.worker.roleState] || data.runtime.worker.roleState}</dd></div>
          <div><dt>Scheduler / vai trò</dt><dd>{RUNTIME_LABELS[data.runtime.scheduler.processStatus] || data.runtime.scheduler.processStatus} · {RUNTIME_LABELS[data.runtime.scheduler.roleState] || data.runtime.scheduler.roleState}</dd></div>
          <div><dt>Leader</dt><dd>{data.runtime.scheduler.owner || 'Chưa có leader'}</dd></div>
          <div><dt>Heartbeat / hết lease</dt><dd>{formatTime(data.runtime.scheduler.heartbeatAt)} · {formatTime(data.runtime.scheduler.expiresAt)}</dd></div>
          <div><dt>Tuổi lease</dt><dd>{formatDuration(data.runtime.scheduler.leaseAgeMs)}</dd></div>
          <div><dt>Scheduler tick / lần tới</dt><dd>{formatTime(data.runtime.scheduler.lastSuccessfulTickAt)} · {formatTime(data.runtime.scheduler.nextRunAt)}</dd></div>
        </dl>
        {data.runtime.scheduler.lastContenderState === 'rejected' && <div className={styles.degradedNotice} role="status">Một scheduler online đã bị từ chối vai trò vì leader <strong>{data.runtime.scheduler.owner || 'khác'}</strong> còn lease hợp lệ. Tiến trình online không đồng nghĩa đang active.</div>}
        {data.runtime.scheduler.lastContenderState === 'recovered' && <div className={styles.recoveredNotice} role="status"><strong>{data.runtime.scheduler.historicalErrorLabel || 'Lỗi cũ/đã phục hồi'}:</strong> xung đột thuộc instance trước, không làm trạng thái scheduler hiện tại thành lỗi{data.runtime.scheduler.rejectedAt ? ` · ${formatTime(data.runtime.scheduler.rejectedAt)}` : ''}.</div>}
      </article>
      <article className={styles.panel}>
        <div className={styles.panelHeader}><div><h2><DashboardIcon name="settings" size={19} />Automation</h2><p>Chế độ yêu cầu, chế độ hiệu lực và các khóa an toàn.</p></div></div>
        <dl className={styles.details}>
          <div><dt>Chế độ / hiệu lực</dt><dd>{MODE_LABELS[data.control.mode] || data.control.mode} · {MODE_LABELS[data.control.effectiveMode] || data.control.effectiveMode}</dd></div>
          <div><dt>Đăng / ingestion</dt><dd>{data.control.publishPaused ? 'Đăng đang dừng' : 'Đăng chưa bị pause'} · {data.control.ingestionPaused ? 'Nhập đang dừng' : 'Nhập được phép'}</dd></div>
          <div><dt>Worker / scheduler</dt><dd>{data.control.workerPaused ? 'Worker dừng' : 'Worker được phép'} · {data.control.schedulerPaused ? 'Scheduler dừng' : 'Scheduler được phép'}</dd></div>
          <div><dt>Khởi chạy đăng</dt><dd>{data.control.launchEnabled ? 'Đã cho phép' : 'Chưa cho phép'}</dd></div>
          <div><dt>Safe Publish</dt><dd>{data.control.safePublish.state === 'ready' ? 'Sẵn sàng theo policy' : 'Đang bị chặn'}</dd></div>
        </dl>
        {data.control.safePublish.reasons.length > 0 && <p className={styles.reasonText}>Lý do chặn: {data.control.safePublish.reasons.map(item => REASON_LABELS[item] || item).join(' · ')}</p>}
        <div className={styles.primaryControls} aria-label="Ba điều khiển vận hành chính">
          <button type="button" onClick={() => openControl({ action: paused ? 'resume_autopilot' : 'pause_autopilot', title: paused ? 'Tiếp tục automation' : 'Tạm dừng automation' })}>{paused ? 'Tiếp tục' : 'Tạm dừng'}</button>
          <label><span>Chế độ mới</span><select value={selectedMode} onChange={event => setSelectedMode(event.target.value)}><option value="OBSERVE">Chỉ quan sát</option><option value="SHADOW">Chạy bóng an toàn</option><option value="CANARY">Canary có kiểm soát</option><option value="AUTONOMOUS">Tự động có kiểm soát</option></select></label>
          <button type="button" onClick={() => openControl({ action: 'set_mode', mode: selectedMode, title: `Đổi sang ${MODE_LABELS[selectedMode]}`, danger: true })}>Đổi chế độ</button>
          <button type="button" className={styles.dangerButton} onClick={() => openControl({ action: data.control.killSwitch ? 'disable_kill_switch' : 'enable_kill_switch', title: data.control.killSwitch ? 'Tắt dừng khẩn cấp' : 'Dừng khẩn cấp', danger: true })}><DashboardIcon name="emergency" size={16} />{data.control.killSwitch ? 'Tắt Emergency Stop' : 'Emergency Stop'}</button>
        </div>
        {['CANARY', 'AUTONOMOUS'].includes(selectedMode) && <p className={styles.degradedNotice}>Chế độ này cần lý do, xác nhận rõ ràng và pre-canary backup. `launchEnabled` vẫn là một cổng độc lập.</p>}
      </article>
    </section>
    <section className={styles.metricGroups} aria-label="Số liệu pipeline và kinh doanh">
      <article className={styles.panel}><div className={styles.panelHeader}><div><h2><DashboardIcon name="queue" size={19} />Pipeline</h2><p>Số liệu từ durable job trong khoảng đã chọn.</p></div></div><div className={styles.metricList}>{pipelineMetrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></article>
      <article className={styles.panel}><div className={styles.panelHeader}><div><h2><DashboardIcon name="analytics" size={19} />Business</h2><p>Chỉ hiển thị fact đang có; không suy diễn conversion hoặc doanh thu.</p></div></div><div className={styles.metricList}>{businessMetrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className={styles.providerList}>{data.providers.map(provider => <div key={provider.id}><strong>{provider.id}</strong><span>{provider.configured === null ? 'Chưa xác minh cấu hình' : provider.configured ? 'Đã cấu hình' : 'Chưa cấu hình'} · {provider.ready ? 'Sẵn sàng' : 'Chưa sẵn sàng'}</span></div>)}</div></article>
    </section>
    <details className={styles.advancedDiagnostics}>
      <summary>Advanced Diagnostics</summary><p>Thông tin kỹ thuật phục vụ chẩn đoán; không phải tín hiệu thành công trên màn hình chính.</p>
      <div className={styles.diagnosticGrid}><JobDiagnosticCard title="PRODUCT_SCAN gần nhất" job={data.jobs.productScan} /><JobDiagnosticCard title="AUTO_PILOT gần nhất" job={data.jobs.autoPilot} /><JobDiagnosticCard title="RUNTIME_GUARDIAN gần nhất" job={data.jobs.runtimeGuardian} /><JobDiagnosticCard title="Lỗi/chặn gần nhất" job={data.jobs.latestError} /></div>
      <div className={styles.advancedActions}><button type="button" onClick={runDry} disabled={submitting}>{submitting ? 'Đang tạo' : 'Tạo dry-run an toàn'}</button><Link href="/dashboard/queue">Mở hàng chờ phê duyệt</Link><Link href="/dashboard/app-health">Mở health chi tiết</Link></div>
    </details>
  </>;
}

function hasCompletionCriteria(item: OnboardingStep | OnboardingRecommendation): item is OnboardingStep {
  return 'completionCriteria' in item;
}

function ActivityChart({ points }: { points: ActivityPoint[] }) {
  const width = 760; const height = 250; const pad = 34;
  const max = Math.max(1, ...points.flatMap(point => [point.completed, point.failed, point.retried, point.blocked]));
  const position = (value: number, index: number) => ({
    x: pad + (points.length === 1 ? (width - pad * 2) / 2 : index * (width - pad * 2) / (points.length - 1)),
    y: height - pad - value / max * (height - pad * 2),
  });
  const pathFor = (key: keyof Pick<ActivityPoint, 'completed' | 'failed'>) => points.map((point, index) => {
    const { x, y } = position(point[key], index);
    return `${index ? 'L' : 'M'} ${x} ${y}`;
  }).join(' ');
  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="activity-chart-title activity-chart-desc">
        <title id="activity-chart-title">Hoạt động xử lý theo thời gian</title>
        <desc id="activity-chart-desc">So sánh số tác vụ hoàn thành và thất bại theo từng mốc thời gian.</desc>
        {[0, .25, .5, .75, 1].map(value => <line key={value} x1={pad} x2={width - pad} y1={pad + value * (height - pad * 2)} y2={pad + value * (height - pad * 2)} className={styles.gridLine} />)}
        <path d={pathFor('completed')} className={styles.successLine} />
        <path d={pathFor('failed')} className={styles.failureLine} />
        {points.flatMap((point, index) => {
          const completed = position(point.completed, index); const failed = position(point.failed, index);
          return [<circle key={`${point.label}-completed`} cx={completed.x} cy={completed.y} r="4" className={styles.successPoint}><title>{point.label}: {point.completed} tác vụ hoàn thành</title></circle>, <circle key={`${point.label}-failed`} cx={failed.x} cy={failed.y} r="4" className={styles.failurePoint}><title>{point.label}: {point.failed} tác vụ thất bại</title></circle>];
        })}
        {points.map((point, index) => <text key={point.label} x={pad + (points.length === 1 ? (width - pad * 2) / 2 : index * (width - pad * 2) / (points.length - 1))} y={height - 8} textAnchor="middle" className={styles.axisLabel}>{point.label}</text>)}
      </svg>
      <div className={styles.legend}><span><i className={styles.successDot} />Hoàn thành</span><span><i className={styles.failureDot} />Thất bại</span></div>
      <details className={styles.chartTable}><summary>Xem dữ liệu biểu đồ dạng bảng</summary><table><thead><tr><th>Thời gian</th><th>Hoàn thành</th><th>Thất bại</th><th>Thử lại</th><th>Bị chặn</th></tr></thead><tbody>{points.map(point => <tr key={point.label}><td>{point.label}</td><td>{point.completed}</td><td>{point.failed}</td><td>{point.retried}</td><td>{point.blocked}</td></tr>)}</tbody></table></details>
    </div>
  );
}

export default function DashboardPage() {
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [pendingControl, setPendingControl] = useState<{ action: string; title: string; danger?: boolean; mode?: string; profile?: string } | null>(null);
  const [selectedMode, setSelectedMode] = useState('SHADOW');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/automation/dashboard?range=${range}`, { cache: 'no-store', signal });
      const body = await response.json() as Envelope<DashboardData>;
      if (!response.ok || !body.ok || !body.data) throw new Error(body.message || 'Không thể tải bảng điều khiển.');
      setData(body.data);
    } catch (issue) {
      if (signal?.aborted) return;
      setError(issue instanceof Error ? issue.message : 'Không thể tải bảng điều khiển.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [range]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);
  useEffect(() => { if (!pendingControl) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !submitting) { setPendingControl(null); setReason(''); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [pendingControl, submitting]);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 5000); };

  const createDryRun = async () => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/automation/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        type: 'PRODUCT_SCAN', dryRun: true, idempotencyKey: `dashboard:dry:${Date.now()}`, payload: { limit: 10 },
      }) });
      const body = await response.json() as Envelope<unknown>; if (!response.ok || !body.ok) throw new Error(body.message);
      notify('Đã tạo tác vụ chạy thử an toàn. Bộ xử lý nền sẽ thực hiện mà không thay đổi dữ liệu sản phẩm.'); await load();
    } catch (issue) { notify(issue instanceof Error ? issue.message : 'Không thể tạo tác vụ.'); } finally { setSubmitting(false); }
  };

  const applyControl = async () => {
    if (!pendingControl || reason.trim().length < 8) return;
    setSubmitting(true);
    try {
      const response = await fetch('/api/automation/control', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: pendingControl.action, mode: pendingControl.mode, profile: pendingControl.profile, reason: reason.trim(), confirmed: pendingControl.danger === true, confirmedAt: pendingControl.danger === true ? new Date().toISOString() : undefined }) });
      const body = await response.json() as Envelope<unknown>; if (!response.ok || !body.ok) throw new Error(body.message);
      notify(body.message); setPendingControl(null); setReason(''); await load();
    } catch (issue) { notify(issue instanceof Error ? issue.message : 'Không thể cập nhật trạng thái vận hành.'); } finally { setSubmitting(false); }
  };

  const maxQueue = useMemo(() => data ? Math.max(1, data.queue.PENDING || 0, data.queue.RUNNING || 0, data.queue.WAITING_APPROVAL || 0, data.queue.FAILED || 0, data.queue.BLOCKED || 0) : 1, [data]);
  const populatedKpis: Array<{ label: string; value: string | number; help: string; icon: DashboardIconName; tone: string }> = data ? [
    { label: 'Sản phẩm đã xử lý', value: data.kpis.productsProcessed, help: 'Tổng sản phẩm trong kho dữ liệu', icon: 'product', tone: 'indigo' },
    { label: 'Tác vụ đang chạy', value: data.kpis.running, help: 'Tác vụ đã được bộ xử lý nền nhận', icon: 'worker', tone: 'cyan' },
    { label: 'Tác vụ đang chờ', value: data.kpis.waiting, help: 'Gồm chờ xử lý và chờ chạy lại', icon: 'queue', tone: 'amber' },
    { label: 'Chờ phê duyệt', value: data.kpis.waitingApproval, help: 'Tác vụ rủi ro cao cần quản trị viên duyệt', icon: 'approval', tone: 'purple' },
    { label: 'Tỷ lệ hoàn thành', value: data.kpis.completionRate === null ? 'Chưa đủ dữ liệu' : `${data.kpis.completionRate}%`, help: 'Tác vụ hoàn thành trên tổng tác vụ đã kết thúc', icon: 'check', tone: data.kpis.completionRate === null ? 'neutral' : 'green' },
    { label: 'Lỗi hệ thống', value: data.kpis.systemErrors, help: 'Tác vụ thất bại trong hàng chờ', icon: 'warning', tone: 'red' },
  ] : [];
  const zeroDataKpis: typeof populatedKpis = data ? [
    { label: 'Sản phẩm', value: data.groups.dataReadiness.products, help: 'Dữ liệu sản phẩm hiện có', icon: 'product', tone: 'indigo' },
    { label: 'Nguồn đang bật', value: data.groups.dataReadiness.enabledSources, help: 'Nguồn đã thiết lập server-side', icon: 'source', tone: 'cyan' },
    { label: 'Tác vụ đang chờ', value: data.kpis.waiting, help: 'Gồm queue và manual input', icon: 'queue', tone: 'amber' },
    { label: 'Bước bị chặn', value: data.onboarding.summary.blocked, help: 'Cần hoàn tất bước phụ thuộc trước', icon: 'warning', tone: 'red' },
  ] : [];
  const kpis = data?.zeroData ? zeroDataKpis : populatedKpis;

  return <div className={styles.page} aria-busy={loading}>
    {toast && <div className={styles.toast} role="status"><span>{toast}</span><button type="button" onClick={() => setToast('')} aria-label="Đóng thông báo">×</button></div>}
    <header className={styles.header}><div><div className={styles.headerStatus}><span className={data?.control.killSwitch ? styles.dangerDot : styles.okDot} />{data?.control.killSwitch ? 'Dừng khẩn cấp đang bật' : data ? 'Hệ thống sẵn sàng' : 'Đang kiểm tra'}</div><h1>Bảng điều khiển</h1><p>Theo dõi hoạt động bot, tác vụ, nguồn dữ liệu và tình trạng hệ thống.</p>{data && <div className={styles.updated}>Cập nhật gần nhất: {new Date(data.updatedAt).toLocaleString('vi-VN')}</div>}</div><div className={styles.headerActions}><label><span>Khoảng thời gian</span><select value={range} onChange={event => setRange(event.target.value as Range)}><option value="today">Hôm nay</option><option value="7d">7 ngày</option><option value="30d">30 ngày</option></select></label><button type="button" onClick={() => void load()} disabled={loading}><DashboardIcon name="refresh" size={16} />{loading ? 'Đang làm mới' : 'Làm mới'}</button></div></header>
    {error && <section className={styles.error}><h2>Không thể tải bảng điều khiển</h2><p>{error} Dữ liệu hiện tại không bị thay đổi.</p><button type="button" onClick={() => void load()}>Thử lại</button></section>}
    {loading && !data && <div className={styles.skeleton}><span /><span /><span /></div>}
    {data && !data.zeroData && <BusinessOverview />}
    {data && <>
      <section className={styles.kpis} aria-label="Chỉ số chính">{kpis.map(item => <article key={item.label} className={styles[item.tone]} title={item.help}><div className={styles.kpiTop}><span className={styles.kpiIcon}><DashboardIcon name={item.icon} size={22} /></span><span>{item.label}</span></div><strong>{item.value}</strong><small>{item.help}</small></article>)}</section>
      <section className={styles.onboarding} aria-labelledby="onboarding-title"><div className={styles.panelHeader}><div><h2 id="onboarding-title"><DashboardIcon name="today" size={19} />{data.onboarding.compact ? 'Việc nên làm tiếp theo' : 'Bắt đầu vận hành SanDeal'}</h2><p>{data.onboarding.summary.completed}/{data.onboarding.summary.total} bước đã hoàn thành, trạng thái được suy ra từ backend.</p></div><Link href="/dashboard/today">Xem việc hôm nay</Link></div><div className={styles.onboardingList}>{(data.onboarding.compact ? data.onboarding.recommendations : data.onboarding.steps).map(item => <article key={item.id} className={styles.onboardingStep}><div><span className={styles[`step${item.status}`]}>{item.status === 'COMPLETED' ? 'Hoàn thành' : item.status === 'IN_PROGRESS' ? 'Đang thực hiện' : item.status === 'BLOCKED' ? 'Bị chặn' : 'Chưa bắt đầu'}</span><h3>{item.title}</h3></div><p>{item.reason}</p>{hasCompletionCriteria(item) && <small>Hoàn thành khi: {item.completionCriteria}</small>}<Link href={item.route}>{item.cta}</Link></article>)}</div></section>
      <OwnerDiagnostics data={data} selectedMode={selectedMode} setSelectedMode={setSelectedMode} openControl={setPendingControl} runDry={() => void createDryRun()} submitting={submitting} />
      {!data.zeroData && <>
      <section className={styles.mainGrid}><article className={`${styles.panel} ${styles.chartPanel}`}><div className={styles.panelHeader}><div><h2><DashboardIcon name="task" size={19} />Hoạt động xử lý theo thời gian</h2><p>Dữ liệu tác vụ thực tế trong khoảng đã chọn.</p></div></div>{data.activity.length ? <ActivityChart points={data.activity} /> : <div className={styles.empty}><span className={styles.emptyIcon}><DashboardIcon name="task" size={24} /></span><h3>Chưa có hoạt động trong khoảng này</h3><p>Hãy tạo một tác vụ chạy thử an toàn để bắt đầu ghi nhận dữ liệu.</p><button type="button" onClick={() => void createDryRun()} disabled={submitting}>Chạy thử an toàn</button></div>}</article>
        <aside className={styles.panel}><div className={styles.panelHeader}><div><h2>Hiệu suất nổi bật</h2><p>Nguồn sản phẩm theo dữ liệu hợp lệ.</p></div></div>{data.sourcePerformance.length ? <div className={styles.ranking}>{data.sourcePerformance.map(source => <div key={source.name}><div><strong>{source.name}</strong><span>{source.valid}/{source.total} hợp lệ</span></div><div className={styles.progress}><span style={{ width: `${source.rate}%` }} /></div><small>{source.rate}%</small></div>)}</div> : <div className={styles.emptySmall}>Chưa đủ dữ liệu để xếp hạng nguồn.</div>}</aside>
      </section>
      <section className={styles.lowerGrid}>
        <article className={`${styles.panel} ${styles.queuePanel}`}><h2><DashboardIcon name="queue" size={19} />Trạng thái hàng chờ</h2><div className={styles.queueBars}>{[['PENDING','Chờ xử lý'],['RUNNING','Đang xử lý'],['WAITING_APPROVAL','Chờ phê duyệt'],['FAILED','Thất bại'],['BLOCKED','Bị chặn']].map(([key,label]) => <div key={key}><span>{label}</span><div><i style={{ width: `${((data.queue[key] || 0) / maxQueue) * 100}%` }} /></div><strong>{data.queue[key] || 0}</strong></div>)}</div></article>
        <article className={`${styles.panel} ${styles.workerPanel}`}><h2><DashboardIcon name="worker" size={19} />Tình trạng bộ xử lý</h2><dl className={styles.details}><div><dt>Trạng thái</dt><dd>{STATUS_LABELS[data.worker.status] || data.worker.status}</dd></div><div><dt>Tín hiệu gần nhất</dt><dd>{data.worker.heartbeatAt ? new Date(data.worker.heartbeatAt).toLocaleString('vi-VN') : 'Chưa có tín hiệu'}</dd></div><div><dt>Tác vụ hiện tại</dt><dd>{data.worker.currentJobId || 'Không có'}</dd></div></dl></article>
        <article className={`${styles.panel} ${styles.aiPanel}`}><h2><DashboardIcon name="ai" size={19} />Hạn mức sử dụng AI</h2><dl className={styles.details}><div><dt>Yêu cầu đã dùng</dt><dd>{data.aiUsage.requests}/{data.aiUsage.requestLimit}</dd></div><div><dt>Token đã ghi nhận</dt><dd>{data.aiUsage.tokens.toLocaleString('vi-VN')}/{data.aiUsage.tokenLimit.toLocaleString('vi-VN')}</dd></div><div><dt>Bị chặn do hạn mức</dt><dd>{data.aiUsage.blocked}</dd></div><div><dt>Chính sách</dt><dd>{data.aiUsage.freeOnly ? 'Chỉ dùng dịch vụ miễn phí' : 'Cần kiểm tra'}</dd></div></dl></article>
        <article className={`${styles.panel} ${styles.controlPanel}`}><h2><DashboardIcon name="settings" size={19} />Điều khiển nhanh</h2><div className={styles.quickActions}><button type="button" onClick={() => void createDryRun()} disabled={submitting}>Chạy thử an toàn</button><button type="button" onClick={() => setPendingControl({ action: data.control.schedulerPaused ? 'resume_scheduler' : 'pause_scheduler', title: data.control.schedulerPaused ? 'Tiếp tục lịch tự động' : 'Tạm dừng lịch tự động' })}>{data.control.schedulerPaused ? 'Tiếp tục lịch tự động' : 'Tạm dừng lịch tự động'}</button><Link href="/dashboard/queue">Xem hàng chờ phê duyệt</Link><div className={styles.emergencyAction}><button type="button" className={styles.dangerButton} onClick={() => setPendingControl({ action: data.control.killSwitch ? 'disable_kill_switch' : 'enable_kill_switch', title: data.control.killSwitch ? 'Tắt dừng khẩn cấp' : 'Dừng khẩn cấp', danger: true })}><DashboardIcon name="emergency" size={16} />{data.control.killSwitch ? 'Tắt dừng khẩn cấp' : 'Dừng khẩn cấp'}</button></div></div></article>
      </section>
      <section className={styles.panel}><div className={styles.panelHeader}><div><h2><DashboardIcon name="task" size={19} />Lịch sử hoạt động gần đây</h2><p>Tác vụ và kết quả đã được lưu bền vững.</p></div><Link href="/dashboard/ai-bots">Xem tất cả tác vụ</Link></div>{data.recentActivity.length ? <div className={styles.tableWrap}><table><thead><tr><th>Thời gian</th><th>Tác vụ</th><th>Người thực hiện</th><th>Kết quả</th><th>Mức rủi ro</th><th>Thời gian xử lý</th><th>Mã thao tác</th></tr></thead><tbody>{data.recentActivity.map(item => <tr key={item.id}><td>{new Date(item.updatedAt).toLocaleString('vi-VN')}</td><td>{TYPE_LABELS[item.type] || item.type}</td><td>{item.requestedBy === 'scheduler' ? 'Lịch tự động' : 'Quản trị viên'}</td><td>{STATUS_LABELS[item.status] || item.status}</td><td>{RISK_LABELS[item.riskLevel] || item.riskLevel}</td><td>{item.durationMs === null ? 'Chưa có' : `${Math.round(item.durationMs / 1000)} giây`}</td><td><code>{item.operationId}</code></td></tr>)}</tbody></table></div> : <div className={styles.empty}><span className={styles.emptyIcon}><DashboardIcon name="task" size={24} /></span><h3>Chưa có lịch sử hoạt động</h3><p>Tạo một tác vụ chạy thử để xác minh hàng chờ và bắt đầu ghi nhận lịch sử.</p><button type="button" onClick={() => void createDryRun()} disabled={submitting}>Tạo tác vụ chạy thử</button></div>}</section>
      </>}
    </>}
    {pendingControl && <div className={styles.modalBackdrop}><section className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby="control-title"><h2 id="control-title">{pendingControl.title}</h2><p>Thao tác này thay đổi trạng thái vận hành và sẽ được ghi vào nhật ký kiểm soát.</p><label><span>Lý do</span><textarea autoFocus rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label><div className={styles.modalActions}><button type="button" onClick={() => { setPendingControl(null); setReason(''); }} disabled={submitting}>Đóng</button><button type="button" className={pendingControl.danger ? styles.dangerButton : ''} onClick={() => void applyControl()} disabled={submitting || reason.trim().length < 8}>{submitting ? 'Đang cập nhật' : 'Xác nhận'}</button></div></section></div>}
  </div>;
}
