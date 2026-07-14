'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DashboardIcon, type DashboardIconName } from '@/components/dashboard/dashboard-icon';
import { BusinessOverview } from '@/components/dashboard/business-overview';
import styles from './dashboard.module.css';

type Range = 'today' | '7d' | '30d';
type Envelope<T> = { ok: boolean; code: string; message: string; data?: T };
type ActivityPoint = { label: string; completed: number; failed: number; retried: number; blocked: number; scanned: number };
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
  control: { workerPaused: boolean; schedulerPaused: boolean; killSwitch: boolean; reason: string | null };
  recentActivity: Array<{ id: string; operationId: string; type: string; status: string; requestedBy: string; riskLevel: string; updatedAt: string; durationMs: number | null }>;
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Chờ xử lý', WAITING_APPROVAL: 'Chờ phê duyệt', RUNNING: 'Đang xử lý', RETRY_SCHEDULED: 'Đang chờ thử lại',
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
  const [pendingControl, setPendingControl] = useState<{ action: string; title: string; danger?: boolean } | null>(null);
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
      const response = await fetch('/api/automation/control', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: pendingControl.action, reason: reason.trim(), confirmed: pendingControl.danger === true }) });
      const body = await response.json() as Envelope<unknown>; if (!response.ok || !body.ok) throw new Error(body.message);
      notify(body.message); setPendingControl(null); setReason(''); await load();
    } catch (issue) { notify(issue instanceof Error ? issue.message : 'Không thể cập nhật trạng thái vận hành.'); } finally { setSubmitting(false); }
  };

  const maxQueue = useMemo(() => data ? Math.max(1, data.queue.PENDING || 0, data.queue.RUNNING || 0, data.queue.WAITING_APPROVAL || 0, data.queue.FAILED || 0, data.queue.BLOCKED || 0) : 1, [data]);
  const kpis: Array<{ label: string; value: string | number; help: string; icon: DashboardIconName; tone: string }> = data ? [
    { label: 'Sản phẩm đã xử lý', value: data.kpis.productsProcessed, help: 'Tổng sản phẩm trong kho dữ liệu', icon: 'product', tone: 'indigo' },
    { label: 'Tác vụ đang chạy', value: data.kpis.running, help: 'Tác vụ đã được bộ xử lý nền nhận', icon: 'worker', tone: 'cyan' },
    { label: 'Tác vụ đang chờ', value: data.kpis.waiting, help: 'Gồm chờ xử lý và chờ chạy lại', icon: 'queue', tone: 'amber' },
    { label: 'Chờ phê duyệt', value: data.kpis.waitingApproval, help: 'Tác vụ rủi ro cao cần quản trị viên duyệt', icon: 'approval', tone: 'purple' },
    { label: 'Tỷ lệ hoàn thành', value: data.kpis.completionRate === null ? 'Chưa đủ dữ liệu' : `${data.kpis.completionRate}%`, help: 'Tác vụ hoàn thành trên tổng tác vụ đã kết thúc', icon: 'check', tone: data.kpis.completionRate === null ? 'neutral' : 'green' },
    { label: 'Lỗi hệ thống', value: data.kpis.systemErrors, help: 'Tác vụ thất bại trong hàng chờ', icon: 'warning', tone: 'red' },
  ] : [];

  return <div className={styles.page} aria-busy={loading}>
    {toast && <div className={styles.toast} role="status">{toast}</div>}
    <header className={styles.header}><div><div className={styles.headerStatus}><span className={data?.control.killSwitch ? styles.dangerDot : styles.okDot} />{data?.control.killSwitch ? 'Dừng khẩn cấp đang bật' : data ? 'Hệ thống sẵn sàng' : 'Đang kiểm tra'}</div><h1>Bảng điều khiển</h1><p>Theo dõi hoạt động bot, tác vụ, nguồn dữ liệu và tình trạng hệ thống.</p>{data && <div className={styles.updated}>Cập nhật gần nhất: {new Date(data.updatedAt).toLocaleString('vi-VN')}</div>}</div><div className={styles.headerActions}><label><span>Khoảng thời gian</span><select value={range} onChange={event => setRange(event.target.value as Range)}><option value="today">Hôm nay</option><option value="7d">7 ngày</option><option value="30d">30 ngày</option></select></label><button type="button" onClick={() => void load()} disabled={loading}><DashboardIcon name="refresh" size={16} />{loading ? 'Đang làm mới' : 'Làm mới'}</button></div></header>
    {error && <section className={styles.error}><h2>Không thể tải bảng điều khiển</h2><p>{error} Dữ liệu hiện tại không bị thay đổi.</p><button type="button" onClick={() => void load()}>Thử lại</button></section>}
    {loading && !data && <div className={styles.skeleton}><span /><span /><span /></div>}
    <BusinessOverview />
    {data && <>
      <section className={styles.kpis} aria-label="Chỉ số chính">{kpis.map(item => <article key={item.label} className={styles[item.tone]} title={item.help}><div className={styles.kpiTop}><span className={styles.kpiIcon}><DashboardIcon name={item.icon} size={22} /></span><span>{item.label}</span></div><strong>{item.value}</strong><small>{item.help}</small></article>)}</section>
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
    {pendingControl && <div className={styles.modalBackdrop}><section className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby="control-title"><h2 id="control-title">{pendingControl.title}</h2><p>Thao tác này thay đổi trạng thái vận hành và sẽ được ghi vào nhật ký kiểm soát.</p><label><span>Lý do</span><textarea autoFocus rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label><div className={styles.modalActions}><button type="button" onClick={() => { setPendingControl(null); setReason(''); }} disabled={submitting}>Đóng</button><button type="button" className={pendingControl.danger ? styles.dangerButton : ''} onClick={() => void applyControl()} disabled={submitting || reason.trim().length < 8}>{submitting ? 'Đang cập nhật' : 'Xác nhận'}</button></div></section></div>}
  </div>;
}
