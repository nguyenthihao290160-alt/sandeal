'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import { clientRequestMessage, requestClientJson } from '@/lib/dashboard/clientRequest';
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
  operational: {
    currentActiveReasons: string[];
    historicalAuditReasons: string[];
    recovery: {
      state: string;
      consecutiveHealthyCount: number;
      requiredHealthyCount: number;
      lastHealthyEvaluation?: string;
      lastResetReason?: string;
      currentApplicableReasons: string[];
      updatedAt: string;
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
      pendingQueueAgeMs: number | null;
      pendingQueueCount: number;
      pickupLatencyMode: string;
      pickupLatencyFeatureMode: string;
    } | null;
    workerPool: {
      featureMode: string;
      maximumSlots: number;
      activeSlots: number;
      availableSlots: number;
      criticalReservedCapacity: number;
      activeCriticalSlots: number;
      activeNormalSlots: number;
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
  };
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
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const load = useCallback(async () => {
    requestRef.current?.abort(new DOMException('Superseded health request', 'AbortError'));
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    setLoading(true);
    setError('');
    try {
      const body = await requestClientJson<{ ok: boolean; message?: string; data?: Health }>('/api/automation/health', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!body.ok || !body.data) throw new Error(body.message || 'Không thể xác minh trạng thái hệ thống.');
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      setHealth(body.data);
    } catch (cause) {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) {
        setError(clientRequestMessage(cause, 'Không thể xác minh trạng thái hệ thống.'));
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

      {loading && !health && <div className={styles.notice}>Đang kiểm tra tình trạng hệ thống...</div>}
      {error && (
        <div className={`${styles.notice} ${styles.errorBox}`} role="alert">
          <strong>Không thể xác minh tình trạng hệ thống.</strong> {error} Dữ liệu không bị thay đổi.{' '}
          <button className={styles.button} onClick={() => void load()}>Thử lại</button>
        </div>
      )}

      {health && (
        <>
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
              </div>
            </section>

            <section className={`${styles.panel} ${slo?.evaluationStatus === 'PASS' ? styles.successPanel : styles.warningPanel}`}>
              <div className={styles.panelHeader}>
                <h2><DashboardIcon name="queue" size={19} />SLO vận hành</h2>
                <span className={stateClass(slo?.evaluationStatus || 'unverified')}>{slo ? `${slo.evaluationStatus || 'CHƯA ĐÁNH GIÁ'} / ${slo.dataStatus}` : 'Chưa đo'}</span>
              </div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Pickup P50 / P95</span><strong>{duration(slo?.pickupLatencyP50Ms ?? null)} / {duration(slo?.pickupLatencyP95Ms ?? null)}</strong></div>
                <div className={styles.healthRow}><span>Tuổi hàng đợi chưa được claim</span><strong>{duration(slo?.pendingQueueAgeMs ?? null)} · {slo?.pendingQueueCount || 0} job</strong></div>
                <div className={styles.healthRow}><span>Ngữ nghĩa pickup</span><strong>{slo?.pickupLatencyMode || 'Chưa có'} · rollout {slo?.pickupLatencyFeatureMode || 'SHADOW'}</strong></div>
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
                <span className={stateClass(operational?.workerPool.featureMode || 'OFF')}>{operational?.workerPool.featureMode || 'OFF'}</span>
              </div>
              <div className={styles.healthList}>
                <div className={styles.healthRow}><span>Slot đang dùng / tối đa</span><strong>{operational?.workerPool.activeSlots || 0}/{operational?.workerPool.maximumSlots || 0}</strong></div>
                <div className={styles.healthRow}><span>Slot còn trống</span><strong>{operational?.workerPool.availableSlots || 0}</strong></div>
                <div className={styles.healthRow}><span>Critical / normal đang chạy</span><strong>{operational?.workerPool.activeCriticalSlots || 0} / {operational?.workerPool.activeNormalSlots || 0}</strong></div>
                <div className={styles.healthRow}><span>Critical capacity có thể mượn</span><strong>{operational?.workerPool.criticalReservedCapacity || 0}</strong></div>
              </div>
            </section>
          </div>

          <section className={styles.panel}>
            <div className={styles.panelHeader}><h2><DashboardIcon name="warning" size={19} />Lý do vận hành</h2></div>
            <div className={styles.healthList}>
              <div className={styles.healthRow}><span>Lý do hiện tại (CURRENT ACTIVE REASONS)</span><strong>{operational?.currentActiveReasons.join(', ') || 'Không có'}</strong></div>
              <div className={styles.healthRow}><span>Lịch sử audit (HISTORICAL AUDIT REASONS)</span><strong>{operational?.historicalAuditReasons.join(', ') || 'Không có'}</strong></div>
            </div>
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
