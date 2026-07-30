'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import { requestClientJson } from '@/lib/dashboard/clientRequest';
import {
  appHealthRequestFailureMessage,
  appHealthRefreshFailed,
  appHealthRefreshStarted,
  appHealthRefreshSucceeded,
  initialAppHealthRefreshState,
} from '@/lib/dashboard/appHealthRefreshState';
import styles from '../operations.module.css';

type Capability = {
  operationalStatus: 'OPERATIONAL' | 'PAUSED' | 'DEGRADED' | 'STOPPED';
  publishingStatus: 'READY' | 'PAUSED' | 'BLOCKED';
  aiStatus: 'READY' | 'LIMITED' | 'BLOCKED' | 'UNAVAILABLE';
  emergencyStatus: 'OFF' | 'ON';
  overallStatus: 'OPERATIONAL' | 'LIMITED' | 'PAUSED' | 'EMERGENCY_STOP';
  overallLabel: string;
  summary: string;
  pausedComponents: string[];
  operationalReasons: string[];
  publishingReasons: string[];
  aiReasons: string[];
  technicalReasonCodes: string[];
};

type Health = {
  generatedAt: string;
  partial: boolean;
  components: Record<string, {
    status: 'available' | 'degraded' | 'unavailable' | 'insufficient_data';
    checkedAt: string;
    stale: boolean;
    reasonCode: string;
  }>;
  release: {
    releaseId: string;
    embeddedBuildId: string;
    runtimeReleaseId: string;
    gitCommitSha: string | null;
    publicBuildId: string;
    releaseMismatch: boolean;
  };
  liveness?: string;
  readiness: string;
  killSwitch: boolean;
  updatedAt: string;
  overallLabel?: string;
  capabilities?: Capability;
  policy: { safeMode: boolean; freeOnly: boolean; safePublish: boolean; allowPaidAi: boolean };
  control?: {
    publishPaused: boolean;
    publishPausedByOperator?: boolean;
    publishBlockedByRuntime?: boolean;
    publishBlockedByPolicy?: boolean;
  };
  runtime?: {
    dataStatus?: 'CURRENT' | 'STALE';
    publishSafe: boolean;
    reasons: string[];
    historicalReasons?: string[];
    checkedAt: string;
  } | null;
  worker: { status: string; heartbeatAt: string | null; heartbeatAgeMs: number | null; heartbeatSource: string; staleAgeMs: number | null; releaseId: string | null; workerId: string | null; currentJobId: string | null };
  scheduler: { status: string; heartbeatAt: string | null; heartbeatAgeMs: number | null; heartbeatSource: string; staleAgeMs: number | null; releaseId: string | null; lastRunAt: string | null; nextRunAt: string | null; timezone: string; scheduleState: string; scheduleWarning: string | null };
  queue: Record<string, number>;
  aiUsage: { requests: number; requestLimit: number; tokens: number; tokenLimit: number; blocked: number };
  circuits: { provider: string; state: string; consecutiveFailures: number; nextProbeAt?: string }[];
  providers?: { gemini: string; accessTrade: string };
  productFlow?: {
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
    };
    recentHistory: {
      latestSourceIngestionJob: { id: string; type: string; status: string; updatedAt: string } | null;
      recentSourceIngestionSuccessCount: number | null;
      recentSourceIngestionFailureCount: number | null;
      latestCandidateProcessingJob: { id: string; type: string; status: string; updatedAt: string } | null;
      recentCandidateProcessingSuccessCount: number | null;
      recentCandidateProcessingFailureCount: number | null;
      latestRealPublicationAttempt: { id: string; type: string; status: string; updatedAt: string } | null;
      latestRealPublication: { productId: string; publishedAt: string } | null;
      latestPostPublishMonitor: { id: string; type: string; status: string; updatedAt: string } | null;
    };
    blockers: {
      topProductBlockerReasonCodes: Array<{ reasonCode: string; count: number }>;
      topMissingEvidenceFields: Array<{ field: string; count: number }>;
    };
    sourceReadiness: {
      status: string;
      configured: boolean;
      ready: boolean;
      reasonCode: string;
    };
    accessTradeReadinessReason: string;
    aiReadiness: {
      status: string;
      configured: boolean;
      ready: boolean;
      reasonCode: string;
    };
    runtimePublishingBlocked: boolean;
    rechecks: { awaitingExecution: number | null; duplicateSuppressed: number | null };
    emptyHomepage: { classification: string; labelVi: string };
  } | null;
  projectionMaintenance?: {
    status: string;
    jobId: string | null;
    attemptCount: number;
    maximumAttempts: number;
    nextRetryAt: string | null;
    duplicateRequestsSuppressed: number;
    reasonCodes: string[];
  } | null;
  operational: {
    currentActiveReasons: string[];
    currentPolicyReasons?: string[];
    projectionQualityWarnings?: string[];
    historicalAuditReasons: string[];
    reasonReconciliation?: {
      evaluatedAt: string;
      transitions: Array<{
        reasonCode: string;
        previousState: string;
        resultingState: string;
        transitionType: string;
        evidenceReasonCodes: string[];
      }>;
    };
    recovery: {
      state: string;
      consecutiveHealthyCount: number;
      requiredHealthyCount: number;
      lastHealthyEvaluation?: string;
      lastResetReason?: string;
      currentApplicableReasons: string[];
      updatedAt: string;
      reasonProgress?: Array<{
        reasonCode: string;
        metricKey: string;
        measurement: string;
        consecutiveHealthyCount: number;
        requiredHealthyCount: number;
        lastHealthyEvaluation?: string;
        lastFailedEvaluation?: string;
        lastResetReason?: string;
        lastEvidenceRevision?: string;
      }>;
    } | null;
    canary: {
      featureMode: string;
      activeCount: number;
      maximumActive: number;
      latest: {
        permitId: string;
        status: string;
        issuedAt: string;
        expiresAt: string;
        outcomeReasonCode: string | null;
      } | null;
    };
    slo: {
      dataStatus: string;
      evaluationStatus: string | null;
      windowStartedAt: string;
      windowEndedAt: string;
      pickupLatencyP50Ms: number | null;
      pickupLatencyP95Ms: number | null;
      historicalPickupLatencyP50Ms: number | null;
      historicalPickupLatencyP95Ms: number | null;
      historicalPickupSampleCount: number;
      currentPickupLatencyP50Ms: number | null;
      currentPickupLatencyP95Ms: number | null;
      currentPickupSampleCount: number;
      excludedLegacyPickupCount: number;
      insufficientPickupTimestampCount: number;
      pickupMeasurementSemantics: { historical: string; current: string };
      pickupRolloutBoundary: { cohort: string; startedAt: string | null };
      pickupReleaseBoundary: { releaseId: string; startedAt: string | null };
      pendingQueueAgeMs: number | null;
      pendingQueueCount: number;
      pickupLatencyMode: string;
      pickupLatencyFeatureMode: string;
    } | null;
    workerPool: {
      featureMode: string;
      configuredMode: string;
      effectiveMode: string;
      effectiveModeSource: string;
      implementationActive: boolean;
      maximumSlots: number;
      activeSlots: number;
      availableSlots: number;
      criticalReservedCapacity: number;
      activeCriticalSlots: number;
      activeNormalSlots: number;
      normalAvailableSlots: number;
      rolloutCohort: string;
      disabledReason: string | null;
      activationControl: string;
      capacityExceeded: boolean;
    };
    release: {
      embeddedReleaseId: string;
      runtimeReleaseId: string;
      gitCommitSha: string | null;
      publicBuildId: string;
      workerReleaseId: string | null;
      schedulerReleaseId: string | null;
      matchStatus: 'MATCH' | 'MISMATCH' | 'UNVERIFIED';
      mismatchReasons: string[];
    };
    operatorControls: {
      publishBlockedByOperator: boolean;
      publishBlockedByRuntime: boolean;
      publishBlockedByPolicy: boolean;
      effectivePublishPaused: boolean;
      emergencyStop: boolean;
    };
    featureRollouts: Array<{
      feature: string;
      mode: string;
      defaultMode: string;
      configured: boolean;
      valid: boolean;
      reasonCode?: string;
    }>;
  } | null;
  jobReadModel?: {
    stale: boolean;
    availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
    evidenceClassification?: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';
    reasonCodes: string[];
  } | null;
};

const STATE: Record<string, string> = {
  active: 'Đang hoạt động',
  paused: 'Đã tạm dừng',
  degraded: 'Hoạt động có giới hạn',
  not_configured: 'Chưa cấu hình',
  configured: 'Đã cấu hình, chưa sẵn sàng',
  configured_not_ready: 'Đã cấu hình, chưa sẵn sàng',
  adapter_unavailable: 'Adapter chưa sẵn sàng',
  unavailable: 'Không khả dụng',
  blocked_by_policy: 'Bị chặn bởi chính sách',
  ready: 'Sẵn sàng',
  unverified: 'Chưa xác minh',
  stale: 'Tín hiệu đã cũ',
  disabled: 'Đã tắt',
  CLOSED: 'Hoạt động bình thường',
  OPEN: 'Tự ngắt do lỗi liên tiếp',
  HALF_OPEN: 'Đang kiểm tra phục hồi',
};

const PUBLISHING_LABELS: Record<Capability['publishingStatus'], string> = {
  READY: 'Đang hoạt động',
  BLOCKED: 'Đang bị chặn',
  PAUSED: 'Đã tạm dừng',
};

const AI_LABELS: Record<Capability['aiStatus'], string> = {
  READY: 'Sẵn sàng',
  LIMITED: 'Hoạt động có giới hạn',
  BLOCKED: 'Bị chặn bởi chính sách',
  UNAVAILABLE: 'Chưa sẵn sàng',
};

const COMPONENT_LABELS: Record<string, string> = {
  core: 'Dữ liệu vận hành cốt lõi',
  historySummary: 'Bản tổng hợp hàng đợi',
  providerGemini: 'Nhà cung cấp AI',
  providerAccessTrade: 'Nguồn AccessTrade',
  runtime: 'Bản chụp Runtime Guardian',
  operational: 'Sức khỏe vận hành',
  slo: 'Bằng chứng SLO',
};

COMPONENT_LABELS.productFlow = 'Chẩn đoán luồng sản phẩm';
COMPONENT_LABELS.projectionMaintenance = 'Bảo trì phép chiếu Job Health';

const COMPONENT_STATUS_LABELS: Record<Health['components'][string]['status'], string> = {
  available: 'Đã xác minh',
  degraded: 'Bằng chứng chưa đầy đủ',
  unavailable: 'Không thể xác minh',
  insufficient_data: 'Chưa đủ dữ liệu',
};

function diagnosticCount(value: number | null | undefined) {
  return value === null || value === undefined ? 'Không xác định' : value.toLocaleString('vi-VN');
}

function stateClass(value: string) {
  if (['active', 'ready', 'CLOSED', 'CLOSED_HEALTHY', 'READY', 'OPERATIONAL', 'PASS', 'MATCH', 'ACTIVE', 'OFF'].includes(value)) return `${styles.badge} ${styles.success}`;
  if (['paused', 'degraded', 'configured', 'configured_not_ready', 'not_configured', 'unverified', 'HALF_OPEN', 'RECOVERY_OBSERVING', 'RECOVERED_PENDING_CONFIRMATION', 'PAUSED', 'BLOCKED', 'LIMITED', 'UNVERIFIED', 'SHADOW', 'OBSERVE', 'CANARY'].includes(value)) {
    return `${styles.badge} ${styles.warning}`;
  }
  return `${styles.badge} ${styles.error}`;
}

function when(value: string | null) {
  return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa ghi nhận';
}

function duration(value: number | null) {
  if (value === null) return 'Chưa có dữ liệu';
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} giây`;
}

export default function SystemHealthPage() {
  const [refreshState, setRefreshState] = useState(() => initialAppHealthRefreshState<Health>());
  const [loading, setLoading] = useState(true);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const health = refreshState.snapshot;
  const error = refreshState.message;
  const load = useCallback(async () => {
    requestRef.current?.abort(new DOMException('Superseded health request', 'AbortError'));
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    setLoading(true);
    setRefreshState(current => appHealthRefreshStarted(current));
    try {
      const body = await requestClientJson<{ ok: boolean; message?: string; data?: Health }>('/api/automation/health', {
        cache: 'no-store',
        signal: controller.signal,
        timeoutMs: 20_000,
        maximumResponseBytes: 512 * 1024,
      });
      if (!body.ok || !body.data) throw new Error(body.message || 'Không thể xác minh trạng thái hệ thống.');
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      const staleProjection = body.data.jobReadModel?.stale === true
        || body.data.components.historySummary?.stale === true;
      const incompleteProjection = body.data.jobReadModel?.evidenceClassification === 'INCOMPLETE'
        || body.data.jobReadModel?.evidenceClassification === 'UNAVAILABLE';
      const partialMessage = body.data.partial
        ? staleProjection
          ? 'Bản tổng hợp hàng đợi đã cũ; các thành phần đã xác minh vẫn được hiển thị.'
          : incompleteProjection
            ? 'Bằng chứng hàng đợi chưa đầy đủ; số không không được hiểu là không có tác vụ.'
            : 'Một số thành phần đang suy giảm hoặc chưa có đủ dữ liệu; đây không phải trạng thái khỏe đầy đủ.'
        : '';
      setRefreshState(current => appHealthRefreshSucceeded(current, body.data!, {
        receivedAt: new Date().toISOString(),
        stale: staleProjection,
        message: partialMessage,
      }));
    } catch (cause) {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) {
        setRefreshState(current => appHealthRefreshFailed(
          current,
          appHealthRequestFailureMessage(cause),
        ));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort(new DOMException('Health page unmounted', 'AbortError'));
    };
  }, [load]);

  const capability = health?.capabilities;
  const overallLabel = capability?.overallLabel || health?.overallLabel || STATE[health?.readiness || 'unverified'] || 'Chưa xác minh';
  const publishingStatus = capability?.publishingStatus
    || (health?.control?.publishPaused ? 'PAUSED' : health?.runtime?.publishSafe === false ? 'BLOCKED' : 'READY');
  const aiStatus = capability?.aiStatus || (health?.providers?.gemini === 'ready' ? 'READY' : 'LIMITED');
  const operational = health?.operational;
  const recovery = operational?.recovery;
  const slo = operational?.slo;
  const productFlow = health?.productFlow;
  const componentIssues = Object.entries(health?.components || {})
    .filter(([, component]) => component.status !== 'available');

  return (
    <main className={styles.page} aria-busy={loading}>
      <header className={styles.header}>
        <div>
          <h1>Sức khỏe hệ thống</h1>
          <p>Tách riêng vận hành, Đăng an toàn, AI và dừng khẩn cấp để trạng thái của một chức năng không bị hiểu nhầm là toàn hệ thống đã dừng.</p>
        </div>
        <button className={styles.button} onClick={() => void load()} disabled={loading}>
          <DashboardIcon name="refresh" size={16} />{loading ? 'Đang kiểm tra' : 'Làm mới'}
        </button>
      </header>

      {loading && !health && <div className={styles.notice} role="status" aria-live="polite">Đang kiểm tra tình trạng hệ thống...</div>}
      {loading && health && <div className={styles.notice} role="status" aria-live="polite">Đang làm mới; bản chụp hiện tại vẫn được hiển thị.</div>}
      {error && (
        <div
          className={`${styles.notice} ${health && refreshState.stale ? styles.warning : styles.errorBox}`}
          role={health ? 'status' : 'alert'}
          aria-live="polite"
        >
          <strong>{refreshState.stale
            ? 'Đang hiển thị bản chụp cũ.'
            : health?.partial
              ? 'Sức khỏe một phần.'
              : 'Không thể xác minh tình trạng hệ thống.'}</strong> {error}{' '}
          <button className={styles.button} onClick={() => void load()}>Thử lại</button>
        </div>
      )}

      {health && (
        <>
          {componentIssues.length > 0 && (
            <section className={`${styles.notice} ${styles.warning}`} aria-label="Bằng chứng sức khỏe chưa đầy đủ">
              <strong>Một số bằng chứng chưa đầy đủ.</strong>
              <ul>
                {componentIssues.map(([name, component]) => (
                  <li key={name} data-reason-code={component.reasonCode}>
                    {COMPONENT_LABELS[name] || name}: {COMPONENT_STATUS_LABELS[component.status]}
                    {' '}(<code>{component.reasonCode}</code>)
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className={styles.statusRow} aria-label="Tổng quan capability">
            <article className={styles.metric}>
              <div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="health" size={20} /></span><span>Khả năng phục vụ</span></div>
              <strong>{overallLabel}</strong>
            </article>
            <article className={styles.metric}>
              <div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="security" size={20} /></span><span>Đăng an toàn</span></div>
              <strong>{PUBLISHING_LABELS[publishingStatus]}</strong>
            </article>
            <article className={styles.metric}>
              <div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="ai" size={20} /></span><span>Khả năng AI</span></div>
              <strong>{AI_LABELS[aiStatus]}</strong>
            </article>
            <article className={styles.metric}>
              <div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="emergency" size={20} /></span><span>Dừng khẩn cấp</span></div>
              <strong>{health.killSwitch ? 'Đang bật' : 'Đang tắt'}</strong>
            </article>
          </section>

          {capability?.summary && <div className={styles.notice} role="status">{capability.summary}</div>}

          <div className={styles.grid}>
            <section className={`${styles.panel} ${health.worker.status === 'active' ? styles.successPanel : health.worker.status === 'stale' ? styles.dangerPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}><h2><DashboardIcon name="worker" size={19} />Bộ xử lý nền</h2><span className={stateClass(health.worker.status)}>{STATE[health.worker.status] || 'Chưa xác minh'}</span></div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Tín hiệu gần nhất</span><strong>{when(health.worker.heartbeatAt)}</strong></div>
                <div className={styles.healthRow}><span>Tuổi / nguồn heartbeat</span><strong>{health.worker.heartbeatAgeMs === null ? 'Chưa có' : `${Math.round(health.worker.heartbeatAgeMs / 1000)} giây`} · {health.worker.heartbeatSource}</strong></div>
                <div className={styles.healthRow}><span>Release</span><strong>{health.worker.releaseId?.slice(0, 12) || 'Chưa ghi nhận'}</strong></div>
                <div className={styles.healthRow}><span>Tác vụ hiện tại</span><strong>{health.worker.currentJobId || 'Không có'}</strong></div>
                <div className={styles.healthRow}><span>Định danh bộ xử lý</span><strong>{health.worker.workerId || 'Chưa ghi nhận'}</strong></div>
              </div>
              {health.worker.status === 'unverified' && <div className={styles.notice}><DashboardIcon name="warning" size={16} /> Chưa nhận được tín hiệu bộ xử lý.</div>}
            </section>

            <section className={`${styles.panel} ${health.scheduler.status === 'active' ? styles.successPanel : health.scheduler.status === 'stale' ? styles.dangerPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}><h2><DashboardIcon name="scheduler" size={19} />Lịch chạy tự động</h2><span className={stateClass(health.scheduler.status)}>{STATE[health.scheduler.status] || 'Chưa xác minh'}</span></div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Heartbeat hiện tại</span><strong>{when(health.scheduler.heartbeatAt)}</strong></div>
                <div className={styles.healthRow}><span>Tuổi / nguồn heartbeat</span><strong>{health.scheduler.heartbeatAgeMs === null ? 'Chưa có' : `${Math.round(health.scheduler.heartbeatAgeMs / 1000)} giây`} · {health.scheduler.heartbeatSource}</strong></div>
                <div className={styles.healthRow}><span>Release</span><strong>{health.scheduler.releaseId?.slice(0, 12) || 'Chưa ghi nhận'} / web {health.release.releaseId.slice(0, 12)}</strong></div>
                <div className={styles.healthRow}><span>Lần chạy gần nhất</span><strong>{when(health.scheduler.lastRunAt)}</strong></div>
                <div className={styles.healthRow}><span>Lần chạy tiếp theo</span><strong>{when(health.scheduler.nextRunAt)} · {health.scheduler.scheduleState}</strong></div>
                <div className={styles.healthRow}><span>Múi giờ</span><strong>Việt Nam (UTC+7)</strong></div>
              </div>
              {health.scheduler.status === 'unverified' && <div className={styles.notice}><DashboardIcon name="warning" size={16} /> Chưa nhận được tín hiệu lịch tự động.</div>}
            </section>

            <section className={`${styles.panel} ${publishingStatus === 'READY' ? styles.successPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}><h2><DashboardIcon name="security" size={19} />Đăng an toàn</h2><span className={stateClass(publishingStatus)}>{PUBLISHING_LABELS[publishingStatus]}</span></div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Pause bởi người vận hành</span><strong>{health.control?.publishPausedByOperator ? 'Có' : 'Không'}</strong></div>
                <div className={styles.healthRow}><span>Runtime đang chặn</span><strong>{health.control?.publishBlockedByRuntime || health.runtime?.publishSafe === false ? 'Có' : 'Không'}</strong></div>
                <div className={styles.healthRow}><span>Policy đang chặn</span><strong>{health.control?.publishBlockedByPolicy ? 'Có' : 'Không'}</strong></div>
              </div>
              {capability?.publishingReasons?.length ? <div className={styles.notice}>{capability.publishingReasons.join(' ')}</div> : null}
            </section>

            <section className={`${styles.panel} ${aiStatus === 'READY' ? styles.successPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}><h2><DashboardIcon name="ai" size={19} />AI & nhà cung cấp</h2><span className={stateClass(aiStatus)}>{AI_LABELS[aiStatus]}</span></div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Gemini</span><span className={stateClass(health.providers?.gemini || 'unverified')}>{STATE[health.providers?.gemini || 'unverified'] || 'Chưa xác minh'}</span></div>
                <div className={styles.healthRow}><span>AccessTrade</span><span className={stateClass(health.providers?.accessTrade || 'not_configured')}>{STATE[health.providers?.accessTrade || 'not_configured'] || 'Chưa xác minh'}</span></div>
                <div className={styles.healthRow}><span>Yêu cầu AI hôm nay</span><strong>{health.aiUsage.requests}/{health.aiUsage.requestLimit}</strong></div>
              </div>
              {capability?.aiReasons?.length ? <div className={styles.notice}>{capability.aiReasons.join(' ')}</div> : null}
            </section>
          </div>

          <div className={styles.grid}>
            <section className={`${styles.panel} ${recovery?.state === 'CLOSED_HEALTHY' ? styles.successPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}>
                <h2><DashboardIcon name="health" size={19} />Phục hồi Runtime Guardian</h2>
                <span className={stateClass(recovery?.state || 'unverified')}>{recovery?.state || 'Chưa có trạng thái'}</span>
              </div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Tiến độ khỏe liên tiếp</span><strong>{recovery ? `${recovery.consecutiveHealthyCount}/${recovery.requiredHealthyCount}` : 'Chưa có dữ liệu'}</strong></div>
                <div className={styles.healthRow}><span>Lần đánh giá khỏe gần nhất</span><strong>{when(recovery?.lastHealthyEvaluation || null)}</strong></div>
                <div className={styles.healthRow}><span>Lý do reset gần nhất</span><strong>{recovery?.lastResetReason || 'Không có'}</strong></div>
                <div className={styles.healthRow}><span>Canary phục hồi</span><strong>{operational?.canary.featureMode || 'OFF'} · {operational?.canary.activeCount || 0}/{operational?.canary.maximumActive || 1}</strong></div>
                <div className={styles.healthRow}><span>Permit gần nhất</span><strong>{operational?.canary.latest ? `${operational.canary.latest.status} · ${operational.canary.latest.permitId}` : 'Không có'}</strong></div>
                {recovery?.reasonProgress?.map(progress => (
                  <div className={styles.healthRow} key={progress.reasonCode}>
                    <span>{progress.reasonCode}</span>
                    <strong>
                      {progress.consecutiveHealthyCount}/{progress.requiredHealthyCount}
                      {' · '}{progress.measurement}
                      {progress.lastHealthyEvaluation ? ` · ${when(progress.lastHealthyEvaluation)}` : ''}
                    </strong>
                  </div>
                ))}
              </div>
            </section>

            <section className={`${styles.panel} ${slo?.evaluationStatus === 'PASS' ? styles.successPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}>
                <h2><DashboardIcon name="queue" size={19} />SLO vận hành</h2>
                <span className={stateClass(slo?.evaluationStatus || 'unverified')}>{slo ? `${slo.evaluationStatus || 'CHƯA ĐÁNH GIÁ'} / ${slo.dataStatus}` : 'Chưa đo'}</span>
              </div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}>
                  <span>Pickup hiện tại P50 / P95</span>
                  <strong>
                    {duration(slo?.currentPickupLatencyP50Ms ?? null)} / {duration(slo?.currentPickupLatencyP95Ms ?? null)}
                    {' · '}{slo?.currentPickupSampleCount || 0} mẫu
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Pickup lịch sử P50 / P95</span>
                  <strong>
                    {duration(slo?.historicalPickupLatencyP50Ms ?? null)} / {duration(slo?.historicalPickupLatencyP95Ms ?? null)}
                    {' · '}{slo?.historicalPickupSampleCount || 0} mẫu
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Mẫu loại trừ / thiếu timestamp</span>
                  <strong>{slo?.excludedLegacyPickupCount || 0} / {slo?.insufficientPickupTimestampCount || 0}</strong>
                </div>
                <div className={styles.healthRow}><span>Tuổi hàng đợi chưa được claim</span><strong>{duration(slo?.pendingQueueAgeMs ?? null)} · {slo?.pendingQueueCount || 0} job</strong></div>
                <div className={styles.healthRow}>
                  <span>Ngữ nghĩa pickup</span>
                  <strong>
                    {slo?.pickupMeasurementSemantics
                      ? `${slo.pickupMeasurementSemantics.current} · lịch sử ${slo.pickupMeasurementSemantics.historical}`
                      : slo?.pickupLatencyMode || 'Chưa có'}
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Biên release / rollout</span>
                  <strong>
                    {slo?.pickupReleaseBoundary?.releaseId?.slice(0, 12) || 'Chưa có'}
                    {' · '}{slo?.pickupRolloutBoundary?.cohort || slo?.pickupLatencyFeatureMode || 'SHADOW'}
                  </strong>
                </div>
                <div className={styles.healthRow}><span>Cửa sổ SLO</span><strong>{slo ? `${when(slo.windowStartedAt)} — ${when(slo.windowEndedAt)}` : 'Chưa có dữ liệu'}</strong></div>
              </div>
            </section>

            <section className={`${styles.panel} ${operational?.release.matchStatus === 'MATCH' ? styles.successPanel : operational?.release.matchStatus === 'MISMATCH' ? styles.dangerPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}>
                <h2><DashboardIcon name="security" size={19} />Danh tính bản phát hành</h2>
                <span className={stateClass(operational?.release.matchStatus || 'unverified')}>{operational?.release.matchStatus || 'UNVERIFIED'}</span>
              </div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Web embedded</span><strong>{operational?.release.embeddedReleaseId.slice(0, 12) || 'Chưa ghi nhận'}</strong></div>
                <div className={styles.healthRow}><span>Web runtime</span><strong>{operational?.release.runtimeReleaseId.slice(0, 12) || 'Chưa ghi nhận'}</strong></div>
                <div className={styles.healthRow}><span>Worker lease</span><strong>{operational?.release.workerReleaseId?.slice(0, 12) || 'Chưa ghi nhận'}</strong></div>
                <div className={styles.healthRow}><span>Scheduler lease</span><strong>{operational?.release.schedulerReleaseId?.slice(0, 12) || 'Chưa ghi nhận'}</strong></div>
                <div className={styles.healthRow}><span>Public build</span><strong>{operational?.release.publicBuildId.slice(0, 12) || 'Chưa ghi nhận'}</strong></div>
              </div>
            </section>

            <section className={`${styles.panel} ${operational?.workerPool.capacityExceeded ? styles.dangerPanel : styles.successPanel}`}>
              <div className={styles.panelHeader}>
                <h2><DashboardIcon name="worker" size={19} />Pool thực thi Worker</h2>
                <span className={stateClass(operational?.workerPool.effectiveMode || 'OFF')}>{operational?.workerPool.effectiveMode || 'OFF'}</span>
              </div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Chế độ cấu hình / hiệu lực</span><strong>{operational?.workerPool.configuredMode || 'OFF'} / {operational?.workerPool.effectiveMode || 'OFF'}</strong></div>
                <div className={styles.healthRow}><span>Nguồn chế độ hiệu lực</span><strong>{operational?.workerPool.effectiveModeSource || 'SAFE_DEFAULT'}</strong></div>
                <div className={styles.healthRow}><span>Pool thực sự hoạt động</span><strong>{operational?.workerPool.implementationActive ? 'Có' : 'Không'}</strong></div>
                <div className={styles.healthRow}><span>Slot đang dùng / tối đa</span><strong>{operational?.workerPool.activeSlots || 0}/{operational?.workerPool.maximumSlots || 0}</strong></div>
                <div className={styles.healthRow}><span>Slot còn trống</span><strong>{operational?.workerPool.availableSlots || 0}</strong></div>
                <div className={styles.healthRow}><span>Critical / normal đang chạy</span><strong>{operational?.workerPool.activeCriticalSlots || 0} / {operational?.workerPool.activeNormalSlots || 0}</strong></div>
                <div className={styles.healthRow}><span>Critical dự phòng / normal còn trống</span><strong>{operational?.workerPool.criticalReservedCapacity || 0} / {operational?.workerPool.normalAvailableSlots || 0}</strong></div>
                <div className={styles.healthRow}><span>Rollout cohort</span><strong>{operational?.workerPool.rolloutCohort || 'WORKER_POOL:OFF'}</strong></div>
                <div className={styles.healthRow}><span>Lý do chưa hoạt động</span><strong>{operational?.workerPool.disabledReason || 'Không có'}</strong></div>
              </div>
            </section>
          </div>

          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2><DashboardIcon name="warning" size={19} />Lý do vận hành</h2></div>
            <div className={styles.healthList}>
              <div className={styles.healthRow}>
                <span>Runtime hiện tại có thẩm quyền</span>
                <strong>
                  {operational?.currentActiveReasons.length
                    ? operational.currentActiveReasons.map(reason => {
                      const transition = operational.reasonReconciliation?.transitions
                        .find(item => item.reasonCode === reason);
                      return transition?.transitionType === 'RETAINED_FAIL_CLOSED'
                        ? `${reason} (đang chờ đối soát: ${transition.evidenceReasonCodes.join('|') || 'thiếu bằng chứng'})`
                        : reason;
                    }).join(', ')
                    : 'Không có'}
                </strong>
              </div>
              <div className={styles.healthRow}><span>Chặn policy hiện tại</span><strong>{operational?.currentPolicyReasons?.join(', ') || 'Không có'}</strong></div>
              <div className={styles.healthRow}><span>Cảnh báo chất lượng projection</span><strong>{operational?.projectionQualityWarnings?.join(', ') || 'Không có'}</strong></div>
              <div className={styles.healthRow}><span>Lịch sử audit</span><strong>{operational?.historicalAuditReasons.join(', ') || 'Không có'}</strong></div>
              <div className={styles.healthRow}>
                <span>Bảo trì Job Health</span>
                <strong>
                  {health.projectionMaintenance
                    ? `${health.projectionMaintenance.status} · ${health.projectionMaintenance.attemptCount}/${health.projectionMaintenance.maximumAttempts} · trùng bị chặn ${health.projectionMaintenance.duplicateRequestsSuppressed}`
                    : 'Chưa có'}
                </strong>
              </div>
            </div>
          </section>

          <section className={`${styles.panel} ${productFlow?.completeness === 'COMPLETE' ? styles.successPanel : styles.warningPanel}`}>
            <div className={styles.panelHeader}>
              <h2><DashboardIcon name="queue" size={19} />Chẩn đoán luồng sản phẩm</h2>
              <span className={stateClass(productFlow?.completeness === 'COMPLETE' ? 'PASS' : 'unverified')}>
                {productFlow?.completeness || 'UNKNOWN'}
              </span>
            </div>
            {productFlow ? (
              <div className={styles.healthList}>
                <div className={styles.healthRow}>
                  <span>Vì sao trang chủ chưa có sản phẩm</span>
                  <strong>{productFlow.emptyHomepage.classification} · {productFlow.emptyHomepage.labelVi}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Sản phẩm canonical / published / public</span>
                  <strong>
                    {diagnosticCount(productFlow.currentState.totalCanonicalProducts)}
                    {' / '}{diagnosticCount(productFlow.currentState.totalPublishedProducts)}
                    {' / '}{diagnosticCount(productFlow.currentState.totalPubliclyProjectedProducts)}
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Ứng viên active / gần đây</span>
                  <strong>{diagnosticCount(productFlow.currentState.totalActiveCandidates)} / {diagnosticCount(productFlow.currentState.totalRecentCandidates)}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Đủ điều kiện nhưng runtime chặn</span>
                  <strong>{diagnosticCount(productFlow.currentState.productsEligibleExceptForRuntimeBlocking)}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Thiếu bằng chứng / policy / cách ly</span>
                  <strong>
                    {diagnosticCount(productFlow.currentState.productsBlockedByMissingEvidence)}
                    {' / '}{diagnosticCount(productFlow.currentState.productsBlockedByProductPolicy)}
                    {' / '}{diagnosticCount(productFlow.currentState.productsQuarantined)}
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Cần recheck / manual / blocker vĩnh viễn</span>
                  <strong>
                    {diagnosticCount(productFlow.currentState.productsRequiringRecheck)}
                    {' / '}{diagnosticCount(productFlow.currentState.productsRequiringManualInput)}
                    {' / '}{diagnosticCount(productFlow.currentState.productsWithPermanentBlockers)}
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Source AccessTrade</span>
                  <strong>{productFlow.sourceReadiness.status} · {productFlow.accessTradeReadinessReason}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>AI (tách riêng)</span>
                  <strong>{productFlow.aiReadiness.status} · {productFlow.aiReadiness.reasonCode}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Source ingestion thành công / lỗi (24 giờ)</span>
                  <strong>
                    {diagnosticCount(productFlow.recentHistory.recentSourceIngestionSuccessCount)}
                    {' / '}{diagnosticCount(productFlow.recentHistory.recentSourceIngestionFailureCount)}
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Candidate processing thành công / lỗi (24 giờ)</span>
                  <strong>
                    {diagnosticCount(productFlow.recentHistory.recentCandidateProcessingSuccessCount)}
                    {' / '}{diagnosticCount(productFlow.recentHistory.recentCandidateProcessingFailureCount)}
                  </strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Recheck đang chờ / trùng bị chặn</span>
                  <strong>{diagnosticCount(productFlow.rechecks.awaitingExecution)} / {diagnosticCount(productFlow.rechecks.duplicateSuppressed)}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Blocker hàng đầu</span>
                  <strong>{productFlow.blockers.topProductBlockerReasonCodes.map(item => `${item.reasonCode}:${item.count}`).join(', ') || 'Không có'}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Bằng chứng thiếu hàng đầu</span>
                  <strong>{productFlow.blockers.topMissingEvidenceFields.map(item => `${item.field}:${item.count}`).join(', ') || 'Không có'}</strong>
                </div>
                <div className={styles.healthRow}>
                  <span>Lần thử publish thật / monitor gần nhất</span>
                  <strong>
                    {productFlow.recentHistory.latestRealPublicationAttempt?.status || 'Chưa có'}
                    {' / '}{productFlow.recentHistory.latestPostPublishMonitor?.status || 'Chưa có'}
                  </strong>
                </div>
              </div>
            ) : (
              <div className={styles.notice}>Chưa đủ dữ liệu chẩn đoán; hệ thống không coi đây là trạng thái không có sản phẩm.</div>
            )}
          </section>

          {(capability?.technicalReasonCodes.length || operational?.historicalAuditReasons.length || operational?.featureRollouts.length) ? (
            <details className={styles.details}>
              <summary>Giải thích trạng thái và rollout kỹ thuật</summary>
              <dl>
                <dt>PASS</dt><dd>Tất cả metric áp dụng đã được đo và đạt mục tiêu.</dd>
                <dt>BREACH</dt><dd>Ít nhất một metric an toàn đang vi phạm mục tiêu.</dd>
                <dt>INSUFFICIENT_DATA</dt><dd>Chưa đủ bằng chứng; hệ thống không coi đây là trạng thái khỏe.</dd>
                <dt>NOT_APPLICABLE</dt><dd>Metric không có đối tượng hợp lệ để đo, không phải bằng chứng khỏe giả.</dd>
                <dt>BOOTSTRAP</dt><dd>Chưa có đủ telemetry ban đầu để đánh giá.</dd>
                <dt>RECOVERY</dt><dd>Đang đánh giá phục hồi bằng các metric thực sự áp dụng.</dd>
                <dt>HALF_OPEN</dt><dd>Chỉ permit canary được giới hạn mới có thể thử đường publish bình thường.</dd>
                <dt>Rollout</dt><dd>{operational?.featureRollouts.map(item => `${item.feature}=${item.mode}${item.valid ? '' : ' (INVALID)'}`).join(', ') || 'Không có'}</dd>
                <dt>Release mismatch</dt><dd>{operational?.release.mismatchReasons.join(', ') || 'Không có'}</dd>
                <dt>Hàng đợi chờ</dt><dd>{(health.queue.PENDING || 0) + (health.queue.RETRY_SCHEDULED || 0)}</dd>
              </dl>
            </details>
          ) : null}
          <p className={styles.muted}>Cập nhật gần nhất: {new Date(health.updatedAt).toLocaleString('vi-VN')}</p>
        </>
      )}
    </main>
  );
}
