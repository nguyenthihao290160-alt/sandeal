'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import styles from '../operations.module.css';

type Health = {
  liveness: string;
  readiness: string;
  killSwitch: boolean;
  updatedAt: string;
  policy: { safeMode: boolean; freeOnly: boolean; safePublish: boolean; allowPaidAi: boolean };
  worker: { status: string; heartbeatAt: string | null; workerId: string | null; currentJobId: string | null };
  scheduler: { status: string; lastRunAt: string | null; nextRunAt: string | null; timezone: string };
  queue: Record<string, number>;
  aiUsage: { requests: number; requestLimit: number; tokens: number; tokenLimit: number; blocked: number };
  circuits: { provider: string; state: string; consecutiveFailures: number; nextProbeAt?: string }[];
  providers?: { gemini: 'configured' | 'not_configured'; accessTrade: 'configured' | 'not_configured' };
};

const STATE: Record<string, string> = { active: 'Đang hoạt động', paused: 'Đã tạm dừng', not_configured: 'Chưa cấu hình', unverified: 'Không thể xác minh', stale: 'Có lỗi', CLOSED: 'Hoạt động bình thường', OPEN: 'Đang tự ngắt do lỗi liên tiếp', HALF_OPEN: 'Đang kiểm tra phục hồi' };
function stateClass(value: string) { if (['active', 'CLOSED'].includes(value)) return `${styles.badge} ${styles.success}`; if (['paused', 'not_configured', 'unverified', 'HALF_OPEN'].includes(value)) return `${styles.badge} ${styles.warning}`; return `${styles.badge} ${styles.error}`; }
function when(value: string | null) { return value ? new Date(value).toLocaleString('vi-VN') : 'Chưa ghi nhận'; }

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
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const geminiConfigured = health?.providers?.gemini === 'configured';
  return <main className={styles.page} aria-busy={loading}>
    <header className={styles.header}><div><h1>Sức khỏe hệ thống</h1><p>Một nguồn trạng thái duy nhất cho hàng chờ, bộ xử lý nền, lịch tự động, hạn mức AI và quy tắc an toàn.</p></div><button className={styles.button} onClick={() => void load()} disabled={loading}><DashboardIcon name="refresh" size={16} />{loading ? 'Đang kiểm tra' : 'Làm mới'}</button></header>
    {loading && !health && <div className={styles.notice}>Đang kiểm tra tình trạng hệ thống...</div>}
    {error && <div className={`${styles.notice} ${styles.errorBox}`} role="alert"><strong>Không thể xác minh tình trạng hệ thống.</strong> {error} Dữ liệu không bị thay đổi. <button className={styles.button} onClick={() => void load()}>Thử lại</button></div>}
    {health && <>
      <section className={styles.statusRow}>
        <article className={styles.metric}><div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="health" size={20} /></span><span>Khả năng phục vụ</span></div><strong>{STATE[health.readiness] || 'Không thể xác minh'}</strong></article>
        <article className={styles.metric}><div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="queue" size={20} /></span><span>Tác vụ đang chờ</span></div><strong>{(health.queue.PENDING || 0) + (health.queue.RETRY_SCHEDULED || 0)}</strong></article>
        <article className={styles.metric}><div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="ai" size={20} /></span><span>Yêu cầu AI hôm nay</span></div><strong>{health.aiUsage.requests}/{health.aiUsage.requestLimit}</strong></article>
        <article className={styles.metric}><div className={styles.metricTop}><span className={styles.metricIcon}><DashboardIcon name="emergency" size={20} /></span><span>Dừng khẩn cấp</span></div><strong>{health.killSwitch ? 'Đang bật' : 'Đang tắt'}</strong></article>
      </section>

      <div className={styles.grid}>
        <section className={`${styles.panel} ${health.worker.status === 'active' ? styles.successPanel : health.worker.status === 'stale' ? styles.dangerPanel : styles.warningPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="worker" size={19} />Bộ xử lý nền</h2><span className={stateClass(health.worker.status)}>{STATE[health.worker.status] || 'Không thể xác minh'}</span></div><div className={styles.healthList}><div className={styles.healthRow}><span>Tín hiệu gần nhất</span><strong>{when(health.worker.heartbeatAt)}</strong></div><div className={styles.healthRow}><span>Tác vụ hiện tại</span><strong>{health.worker.currentJobId || 'Không có'}</strong></div><div className={styles.healthRow}><span>Định danh bộ xử lý</span><strong>{health.worker.workerId || 'Chưa ghi nhận'}</strong></div></div>{health.worker.status === 'unverified' && <div className={styles.notice}><DashboardIcon name="warning" size={16} /> Chưa nhận được tín hiệu bộ xử lý. Hãy khởi động worker rồi thử lại.</div>}</section>

        <section className={`${styles.panel} ${health.scheduler.status === 'active' ? styles.successPanel : health.scheduler.status === 'stale' ? styles.dangerPanel : styles.warningPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="scheduler" size={19} />Lịch chạy tự động</h2><span className={stateClass(health.scheduler.status)}>{STATE[health.scheduler.status] || 'Không thể xác minh'}</span></div><div className={styles.healthList}><div className={styles.healthRow}><span>Lần chạy gần nhất</span><strong>{when(health.scheduler.lastRunAt)}</strong></div><div className={styles.healthRow}><span>Lần chạy tiếp theo</span><strong>{when(health.scheduler.nextRunAt)}</strong></div><div className={styles.healthRow}><span>Múi giờ</span><strong>Việt Nam (UTC+7)</strong></div></div>{health.scheduler.status === 'unverified' && <div className={styles.notice}><DashboardIcon name="warning" size={16} /> Chưa nhận được tín hiệu lịch tự động. Hãy khởi động scheduler rồi thử lại.</div>}</section>

        <section className={`${styles.panel} ${styles.successPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="security" size={19} />Quy tắc an toàn</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Chế độ an toàn</span><strong>{health.policy.safeMode ? 'Đang bật' : 'Đã tắt'}</strong></div><div className={styles.healthRow}><span>Chỉ dùng dịch vụ miễn phí</span><strong>{health.policy.freeOnly ? 'Đang bật' : 'Đã tắt'}</strong></div><div className={styles.healthRow}><span>Đăng an toàn</span><strong>{health.policy.safePublish ? 'Đang bật' : 'Đã tắt'}</strong></div><div className={styles.healthRow}><span>Dịch vụ AI có thể tính phí</span><strong>{health.policy.allowPaidAi ? 'Được phép' : 'Bị chặn'}</strong></div></div></section>

        <section className={`${styles.panel} ${styles.infoPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="health" size={19} />Tự ngắt khi lỗi liên tiếp</h2></div><div className={styles.healthList}>{health.circuits.map(circuit => { const configured = circuit.provider !== 'gemini' || geminiConfigured; const status = configured ? circuit.state : 'not_configured'; return <div className={styles.healthRow} key={circuit.provider}><span>{circuit.provider === 'gemini' ? 'Kết nối Gemini' : 'Chế độ tự động'}</span><span className={stateClass(status)}>{STATE[status] || 'Không thể xác minh'}</span></div>; })}<div className={styles.healthRow}><span>Nguồn sản phẩm AccessTrade</span><span className={stateClass(health.providers?.accessTrade === 'configured' ? 'active' : 'not_configured')}>{health.providers?.accessTrade === 'configured' ? 'Đã cấu hình' : 'Chưa cấu hình'}</span></div></div></section>
      </div>
      <p className={styles.muted}>Cập nhật gần nhất: {new Date(health.updatedAt).toLocaleString('vi-VN')}</p>
    </>}
  </main>;
}
