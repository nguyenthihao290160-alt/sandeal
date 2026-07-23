'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
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
  release: { releaseId: string };
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
  if (['active', 'ready', 'CLOSED', 'READY', 'OPERATIONAL', 'OFF'].includes(value)) return `${styles.badge} ${styles.success}`;
  if (['paused', 'degraded', 'configured', 'configured_not_ready', 'not_configured', 'unverified', 'HALF_OPEN', 'PAUSED', 'BLOCKED', 'LIMITED'].includes(value)) {
    return `${styles.badge} ${styles.warning}`;
  }
  return `${styles.badge} ${styles.error}`;
}

function when(value: string | null) {
  return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa ghi nhận';
}

export default function SystemHealthPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/automation/health', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể xác minh trạng thái hệ thống.');
      setHealth(body.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể xác minh trạng thái hệ thống.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const capability = health?.capabilities;
  const overallLabel = capability?.overallLabel || health?.overallLabel || STATE[health?.readiness || 'unverified'] || 'Chưa xác minh';
  const publishingStatus = capability?.publishingStatus
    || (health?.control?.publishPaused ? 'PAUSED' : health?.runtime?.publishSafe === false ? 'BLOCKED' : 'READY');
  const aiStatus = capability?.aiStatus || (health?.providers?.gemini === 'ready' ? 'READY' : 'LIMITED');

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

          {(capability?.technicalReasonCodes.length || health.runtime?.historicalReasons?.length) ? (
            <details className={styles.details}>
              <summary>Chi tiết kỹ thuật và lịch sử sự cố</summary>
              <dl>
                <dt>Lý do hiện tại</dt><dd>{capability?.technicalReasonCodes.join(', ') || 'Không có'}</dd>
                <dt>Lịch sử audit</dt><dd>{health.runtime?.historicalReasons?.join(', ') || 'Không có'}</dd>
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
