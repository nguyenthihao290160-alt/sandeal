'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import styles from '../operations.module.css';

type RunLog = {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  message?: string;
  error?: string;
  summary?: Record<string, number>;
};

type ScheduleState = {
  settings: { enabled: boolean; intervalHours: number; maxItemsPerRun: number; maxItemsPerDay: number; safePublish: boolean; freeOnly: boolean; allowPaidAi: boolean };
  currentStatus: string;
  nextRunAt: string | null;
  dailyUsage: number;
  dailyRemaining: number;
  recentRuns: RunLog[];
  queue?: { pending: number; processing: number; delayed: number; needs_review: number };
  publicationBlocks?: Array<[string, number]>;
};

type AutomationTruth = {
  status: 'HEALTHY' | 'DEGRADED' | 'INCONSISTENT' | 'INACTIVE'; checkedAt: string; timezone: 'Asia/Ho_Chi_Minh';
  scheduler: { state: string; ownerId: string | null; heartbeatAt: string | null; leaseExpiresAt: string | null; fencingToken: number | null; nextRunAt: string | null; lastTickAt: string | null; active: boolean };
  worker: { state: string; ownerIds: string[]; latestHeartbeatAt: string | null; activeWorkers: number; staleWorkers: number };
  queue: { pending: number; running: number; retrying: number; failed: number; deadLetter: number; completedRecent: number; oldestPendingAt: string | null };
  dailyUsage: { day: string; processed: number; limit: number | null; remaining: number | null };
  inconsistencies: Array<{ code: string; severity: string; message: string; evidence: Record<string, unknown>; detectedAt: string }>;
};
type DialogAction = 'enable_schedule' | 'pause_scheduler' | 'resume_scheduler' | 'save_settings';

const STATUS_LABELS: Record<string, string> = {
  active: 'Đang hoạt động', paused: 'Đã tạm dừng', not_configured: 'Chưa cấu hình',
  unverified: 'Không thể xác minh', stale: 'Có lỗi', running: 'Đang xử lý', idle: 'Đang chờ',
};
const RUN_LABELS: Record<string, string> = { completed: 'Hoàn thành', failed: 'Thất bại', skipped: 'Đã bỏ qua', running: 'Đang xử lý' };
const TRIGGER_LABELS: Record<string, string> = { manual: 'Quản trị viên', scheduler: 'Lịch tự động', startup: 'Khởi động hệ thống' };

function formatTime(value?: string | null) {
  if (!value) return 'Chưa ghi nhận';
  return new Date(value).toLocaleString('vi-VN');
}

export default function AutomationDashboard() {
  const [state, setState] = useState<ScheduleState | null>(null);
  const [truth, setTruth] = useState<AutomationTruth | null>(null);
  const [draft, setDraft] = useState({ intervalHours: 6, maxItemsPerRun: 10, maxItemsPerDay: 30 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<DialogAction | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [scheduleResponse, truthResponse] = await Promise.all([
        fetch('/api/ai-bots/schedule', { cache: 'no-store' }),
        fetch('/api/automation/truth', { cache: 'no-store' }),
      ]);
      const scheduleBody = await scheduleResponse.json();
      const truthBody = await truthResponse.json();
      if (!scheduleResponse.ok) throw new Error(scheduleBody.error || 'Không thể tải cấu hình lịch tự động.');
      if (!truthResponse.ok || !truthBody.ok) throw new Error(truthBody.message || 'Không thể xác minh lịch tự động.');
      setState(scheduleBody);
      setTruth(truthBody.data);
      setDraft({ intervalHours: scheduleBody.settings.intervalHours, maxItemsPerRun: scheduleBody.settings.maxItemsPerRun, maxItemsPerDay: scheduleBody.settings.maxItemsPerDay });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể tải trang tự động hóa.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!dialog) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { setDialog(null); setReason(''); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [dialog, busy]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 4500);
  };

  async function createDryRun() {
    setBusy(true);
    try {
      const response = await fetch('/api/automation/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'AUTO_PILOT', dryRun: true, idempotencyKey: `automation:preview:${new Date().toISOString().slice(0, 16)}`, payload: { limit: Math.min(20, state?.settings.maxItemsPerRun || 10) } }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể tạo tác vụ chạy thử.');
      notify('Đã tạo tác vụ chạy thử an toàn. Dữ liệu sản phẩm không bị thay đổi.');
      await load();
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'Không thể tạo tác vụ.'} Dữ liệu hiện tại không bị thay đổi.`);
    } finally {
      setBusy(false);
    }
  }

  async function submitDialog() {
    if (!dialog || reason.trim().length < 8) return;
    setBusy(true);
    try {
      const scheduleMutation = dialog === 'enable_schedule' || dialog === 'save_settings';
      const response = scheduleMutation
        ? await fetch('/api/ai-bots/schedule', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...(dialog === 'enable_schedule' ? { enabled: true } : draft), reason: reason.trim(), confirmed: true }),
          })
        : await fetch('/api/automation/control', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: dialog, reason: reason.trim(), confirmed: true }),
          });
      const body = await response.json();
      if (!response.ok || (scheduleMutation ? body.success !== true : body.ok !== true)) throw new Error(body.error || body.message || 'Không thể cập nhật lịch tự động.');
      notify(dialog === 'save_settings' ? 'Đã lưu giới hạn xử lý và ghi nhật ký kiểm soát.' : 'Đã cập nhật trạng thái lịch tự động.');
      setDialog(null);
      setReason('');
      await load();
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'Không thể cập nhật lịch tự động.'} Dữ liệu chưa được thay đổi.`);
    } finally {
      setBusy(false);
    }
  }

  const schedulerStatus = truth?.scheduler.active ? 'active'
    : truth?.status === 'INCONSISTENT' ? 'stale'
      : truth?.scheduler.state === 'PAUSED' ? 'paused'
        : (state?.settings.enabled ? 'unverified' : 'not_configured');
  const schedulerAction: DialogAction = !state?.settings.enabled ? 'enable_schedule' : schedulerStatus === 'paused' ? 'resume_scheduler' : 'pause_scheduler';
  const actionLabel = schedulerAction === 'enable_schedule' ? 'Bật lịch tự động' : schedulerAction === 'resume_scheduler' ? 'Tiếp tục lịch tự động' : 'Tạm dừng lịch tự động';

  return <main className={styles.page} aria-busy={loading}>
    {toast && <div className="toast-container"><div className="toast toast-success" role="status">{toast}</div></div>}
    <header className={styles.header}>
      <div><h1>Tự động hóa</h1><p>Quản lý lịch xử lý có giới hạn, tạo tác vụ chạy thử và theo dõi trạng thái bằng dữ liệu backend.</p></div>
      <div className={styles.actions}><button className={styles.button} onClick={() => void load()} disabled={loading}><DashboardIcon name="refresh" size={16} />Làm mới</button></div>
    </header>
    {error && <div className={`${styles.notice} ${styles.errorBox}`} role="alert">{error} Vui lòng kiểm tra kết nối rồi thử lại.</div>}
    {loading && !state && <div className={styles.notice}>Đang tải trạng thái lịch tự động...</div>}
    {state && <>
      <section className={styles.grid}>
        <article className={`${styles.panel} ${schedulerStatus === 'active' ? styles.successPanel : schedulerStatus === 'paused' ? styles.warningPanel : schedulerStatus === 'stale' ? styles.dangerPanel : styles.infoPanel}`}>
          <div className={styles.panelHeader}><h2><DashboardIcon name="scheduler" size={19} />Lịch chạy tự động</h2><span className={`${styles.badge} ${schedulerStatus === 'active' ? styles.success : schedulerStatus === 'stale' ? styles.error : styles.warning}`}>{STATUS_LABELS[schedulerStatus] || 'Không thể xác minh'}</span></div>
          <div className={styles.healthList}>
            <div className={styles.healthRow}><span>Lần chạy tiếp theo</span><strong>{formatTime(truth?.scheduler.nextRunAt || state.nextRunAt)}</strong></div>
            <div className={styles.healthRow}><span>Đã xử lý hôm nay</span><strong>{truth?.dailyUsage.processed ?? state.dailyUsage}/{truth?.dailyUsage.limit ?? state.settings.maxItemsPerDay}</strong></div>
            <div className={styles.healthRow}><span>Tác vụ đang chờ</span><strong>{truth ? truth.queue.pending + truth.queue.retrying : (state.queue?.pending || 0) + (state.queue?.delayed || 0)}</strong></div>
            <div className={styles.healthRow}><span>Timezone</span><strong>{truth?.timezone || 'Asia/Ho_Chi_Minh'}</strong></div>
            <div className={styles.healthRow}><span>Scheduler owner / fencing</span><strong>{truth?.scheduler.ownerId || 'Chưa có'} · {truth?.scheduler.fencingToken ?? '—'}</strong></div>
            <div className={styles.healthRow}><span>Worker ACTIVE</span><strong>{truth?.worker.activeWorkers ?? 0}</strong></div>
          </div>
          <div className={styles.actions} style={{ padding: 16, justifyContent: 'flex-start' }}>
            <button className={schedulerAction === 'pause_scheduler' ? styles.warningButton : styles.primary} onClick={() => setDialog(schedulerAction)} disabled={busy}>{actionLabel}</button>
            <button className={styles.button} onClick={() => void createDryRun()} disabled={busy}><DashboardIcon name="task" size={16} />Chạy thử an toàn</button>
          </div>
          {truth?.status === 'INCONSISTENT' && <div className={`${styles.notice} ${styles.errorBox}`}>Inconsistent — cần kiểm tra. Trạng thái ACTIVE không được suy ra chỉ từ cấu hình lịch.</div>}
        </article>

        <article className={`${styles.panel} ${styles.infoPanel}`}>
          <div className={styles.panelHeader}><h2><DashboardIcon name="settings" size={19} />Giới hạn xử lý</h2></div>
          <div style={{ padding: 16 }}>
            <div className={styles.grid}>
              <div className={styles.field}><label htmlFor="items-per-run">Tối đa mỗi lần</label><input id="items-per-run" type="number" min={1} max={50} value={draft.maxItemsPerRun} onChange={event => setDraft(value => ({ ...value, maxItemsPerRun: Math.max(1, Math.min(50, Number(event.target.value) || 1)) }))} /></div>
              <div className={styles.field}><label htmlFor="items-per-day">Tối đa mỗi ngày</label><input id="items-per-day" type="number" min={1} max={200} value={draft.maxItemsPerDay} onChange={event => setDraft(value => ({ ...value, maxItemsPerDay: Math.max(1, Math.min(200, Number(event.target.value) || 1)) }))} /></div>
              <div className={styles.field}><label htmlFor="interval-hours">Chu kỳ chạy</label><select id="interval-hours" value={draft.intervalHours} onChange={event => setDraft(value => ({ ...value, intervalHours: Number(event.target.value) }))}><option value={3}>Mỗi 3 giờ</option><option value={6}>Mỗi 6 giờ</option><option value={12}>Mỗi 12 giờ</option><option value={24}>Mỗi 24 giờ</option></select></div>
            </div>
            <div className={styles.actions} style={{ marginTop: 14, justifyContent: 'flex-start' }}><button className={styles.primary} onClick={() => setDialog('save_settings')} disabled={busy}>Lưu giới hạn</button></div>
          </div>
        </article>
      </section>

      {truth && <section className={`${styles.panel} ${truth.inconsistencies.length ? styles.warningPanel : styles.successPanel}`}>
        <div className={styles.panelHeader}><h2><DashboardIcon name="warning" size={19} />Operational inconsistencies</h2><span className={styles.badge}>{truth.inconsistencies.length}</span></div>
        {truth.inconsistencies.length ? <div className={styles.healthList}>{truth.inconsistencies.map(item => <div className={styles.healthRow} key={item.code}><span><strong>{item.code}</strong><br />{item.message}</span><code>{JSON.stringify(item.evidence)}</code></div>)}</div> : <div className={styles.notice}>Không phát hiện mâu thuẫn trong snapshot hiện tại.</div>}
      </section>}

      <section className={`${styles.panel} ${styles.successPanel}`}>
        <div className={styles.panelHeader}><h2><DashboardIcon name="lock" size={19} />Chính sách được bảo vệ</h2></div>
        <div className={styles.healthList}>
          <div className={styles.healthRow}><span>Đăng an toàn</span><strong>{state.settings.safePublish ? 'Bắt buộc' : 'Bị chặn bởi cấu hình'}</strong></div>
          <div className={styles.healthRow}><span>Chỉ dùng dịch vụ miễn phí</span><strong>{state.settings.freeOnly ? 'Bắt buộc' : 'Cần quản trị viên kiểm tra'}</strong></div>
          <div className={styles.healthRow}><span>Dịch vụ AI có thể tính phí</span><strong>{state.settings.allowPaidAi ? 'Cần phê duyệt riêng' : 'Đang bị khóa'}</strong></div>
        </div>
        <div className={styles.locked}><DashboardIcon name="lock" size={16} /> Được bảo vệ bởi chính sách hệ thống và không thể bỏ qua từ trình duyệt.</div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><h2><DashboardIcon name="task" size={19} />Nhật ký chạy gần đây</h2></div>
        {state.recentRuns.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Thời gian</th><th>Trạng thái</th><th>Nguồn khởi chạy</th><th>Kết quả</th><th>Chi tiết</th></tr></thead><tbody>{state.recentRuns.map(run => <tr key={run.id}><td>{formatTime(run.startedAt)}</td><td><span className={`${styles.badge} ${run.status === 'completed' ? styles.success : run.status === 'failed' ? styles.error : styles.info}`}>{RUN_LABELS[run.status] || 'Không thể xác minh'}</span></td><td>{TRIGGER_LABELS[run.trigger] || 'Hệ thống'}</td><td>{run.summary ? `${run.summary.saved || 0} đã lưu, ${run.summary.errors || run.summary.skipped || 0} lỗi` : 'Chưa có số liệu'}</td><td>{run.message || run.error || 'Không có chi tiết'}</td></tr>)}</tbody></table></div> : <div className={styles.empty}><span className={styles.emptyIcon}><DashboardIcon name="task" size={22} /></span><h3>Chưa có nhật ký chạy</h3><p>Tạo một tác vụ chạy thử an toàn để xác minh hàng chờ mà không thay đổi dữ liệu sản phẩm.</p><div className={styles.emptyActions}><button className={styles.button} onClick={() => void createDryRun()} disabled={busy}>Chạy thử an toàn</button></div></div>}
      </section>
    </>}

    {dialog && <div className={styles.dialogBackdrop} onMouseDown={event => { if (event.target === event.currentTarget && !busy) { setDialog(null); setReason(''); } }}><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="automation-dialog-title"><h2 id="automation-dialog-title">{dialog === 'save_settings' ? 'Lưu giới hạn xử lý' : actionLabel}</h2><p>Thay đổi được thực hiện ở backend, lưu bền vững và ghi vào nhật ký kiểm soát. Tác vụ hiện có không bị xóa.</p><label htmlFor="automation-reason">Lý do<textarea id="automation-reason" autoFocus rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label><p className={styles.muted}>Nhập ít nhất 8 ký tự.</p><div className={styles.dialogActions}><button className={styles.button} onClick={() => { setDialog(null); setReason(''); }} disabled={busy}>Đóng</button><button className={dialog === 'pause_scheduler' ? styles.warningButton : styles.primary} onClick={() => void submitDialog()} disabled={busy || reason.trim().length < 8}>{busy ? 'Đang cập nhật' : 'Xác nhận'}</button></div></section></div>}
  </main>;
}
