'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutomationJob, AutomationJobStatus, AutomationJobType } from '@/lib/automation/types';
import styles from '../operations.module.css';

type SafeJob = Omit<AutomationJob, 'payload'>;
type JobsResponse = { ok: boolean; message: string; data?: { items: SafeJob[]; pagination: { page: number; totalItems: number; totalPages: number } } };
const STATUS_LABELS: Record<AutomationJobStatus, string> = { PENDING: 'Chờ xử lý', WAITING_APPROVAL: 'Chờ phê duyệt', RUNNING: 'Đang xử lý', RETRY_SCHEDULED: 'Đang chờ chạy lại', SUCCEEDED: 'Hoàn thành', FAILED: 'Thất bại', CANCELLED: 'Đã hủy', BLOCKED: 'Bị chặn', PAUSED: 'Đã tạm dừng' };
const TYPE_LABELS: Record<AutomationJobType, string> = { PRODUCT_SCAN: 'Quét sản phẩm', AUTO_PILOT: 'Chế độ tự động', SAFE_PUBLISH: 'Đăng an toàn', AI_ANALYSIS: 'Phân tích AI', HEALTH_CHECK: 'Kiểm tra hệ thống' };

function badge(status: AutomationJobStatus) {
  if (status === 'SUCCEEDED') return `${styles.badge} ${styles.success}`;
  if (status === 'FAILED' || status === 'BLOCKED' || status === 'CANCELLED') return `${styles.badge} ${styles.error}`;
  if (status === 'RUNNING' || status === 'RETRY_SCHEDULED') return `${styles.badge} ${styles.info}`;
  return `${styles.badge} ${styles.warning}`;
}

export default function AutomationJobsPage() {
  const [jobs, setJobs] = useState<SafeJob[]>([]);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [action, setAction] = useState<{ job: SafeJob; name: 'cancel' | 'retry' } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const query = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (status) query.set('status', status); if (type) query.set('type', type);
    try {
      const response = await fetch(`/api/automation/jobs?${query}`, { cache: 'no-store' });
      const body = await response.json() as JobsResponse;
      if (!response.ok || !body.ok || !body.data) throw new Error(body.message || 'Không thể tải tác vụ.');
      setJobs(body.data.items); setPages(body.data.pagination.totalPages); setTotal(body.data.pagination.totalItems);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể tải tác vụ. Dữ liệu hiện tại không bị thay đổi.'); }
    finally { setLoading(false); }
  }, [page, status, type]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { if (!action) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setAction(null); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [action, busy]);
  const counts = useMemo(() => ({ running: jobs.filter(job => job.status === 'RUNNING').length, waiting: jobs.filter(job => ['PENDING','RETRY_SCHEDULED'].includes(job.status)).length, approval: jobs.filter(job => job.status === 'WAITING_APPROVAL').length, failed: jobs.filter(job => ['FAILED','BLOCKED'].includes(job.status)).length }), [jobs]);

  async function createDryRun() {
    setBusy('create'); setError('');
    try {
      const key = `dashboard-dry-${new Date().toISOString().slice(0, 16)}`;
      const response = await fetch('/api/automation/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'PRODUCT_SCAN', dryRun: true, idempotencyKey: key, payload: { limit: 20 } }) });
      const body = await response.json() as { ok: boolean; message: string };
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể tạo tác vụ chạy thử.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể tạo tác vụ chạy thử. Dữ liệu không bị thay đổi.'); }
    finally { setBusy(''); }
  }

  async function submitAction() {
    if (!action) return; setBusy(action.job.id); setError('');
    try {
      const response = await fetch(`/api/automation/jobs/${action.job.id}/${action.name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() || 'Thao tác từ bảng điều khiển' }) });
      const body = await response.json() as { ok: boolean; message: string };
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể cập nhật tác vụ.');
      setAction(null); setReason(''); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể cập nhật tác vụ. Dữ liệu hiện tại không bị thay đổi.'); }
    finally { setBusy(''); }
  }

  return <main className={styles.page} aria-busy={loading}>
    <header className={styles.header}><div><h1>Tác vụ và tiến độ</h1><p>Theo dõi hàng chờ bền vững, tiến độ xử lý và các lần chạy lại. Tác vụ vẫn được lưu khi web hoặc bộ xử lý khởi động lại.</p></div><div className={styles.actions}><button className={styles.button} onClick={() => void load()} disabled={loading}>Làm mới</button><button className={styles.primary} onClick={() => void createDryRun()} disabled={busy === 'create'}>{busy === 'create' ? 'Đang tạo...' : 'Chạy thử an toàn'}</button></div></header>
    <section className={styles.statusRow} aria-label="Tổng quan tác vụ"><div className={styles.metric}><span>Đang xử lý</span><strong>{counts.running}</strong></div><div className={styles.metric}><span>Đang chờ</span><strong>{counts.waiting}</strong></div><div className={styles.metric}><span>Chờ phê duyệt</span><strong>{counts.approval}</strong></div><div className={styles.metric}><span>Thất bại hoặc bị chặn</span><strong>{counts.failed}</strong></div></section>
    {error && <div className={`${styles.notice} ${styles.errorBox}`} role="alert">{error} Vui lòng làm mới hoặc kiểm tra Sức khỏe hệ thống.</div>}
    <div className={styles.filters}><div className={styles.field}><label htmlFor="job-status">Trạng thái</label><select id="job-status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">Tất cả trạng thái</option>{Object.entries(STATUS_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className={styles.field}><label htmlFor="job-type">Loại tác vụ</label><select id="job-type" value={type} onChange={event => { setType(event.target.value); setPage(1); }}><option value="">Tất cả loại tác vụ</option>{Object.entries(TYPE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></div><button className={styles.button} onClick={() => { setStatus(''); setType(''); setPage(1); }}>Xóa bộ lọc</button></div>
    <section className={styles.panel}><div className={styles.panelHeader}><h2>Danh sách tác vụ</h2><span className={styles.muted}>{total} kết quả</span></div>{loading ? <div className={styles.empty}>Đang tải tác vụ...</div> : jobs.length === 0 ? <div className={styles.empty}>Chưa có tác vụ phù hợp. Chạy thử an toàn để kiểm tra luồng mà không thay đổi dữ liệu.</div> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Tác vụ</th><th>Trạng thái</th><th>Rủi ro</th><th>Tiến độ</th><th>Cập nhật</th><th>Thao tác</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td><span className={styles.name}>{TYPE_LABELS[job.type]}</span><span className={styles.muted}>Mã thao tác: {job.operationId.slice(0, 12)}</span><details className={styles.details}><summary>Chi tiết kỹ thuật</summary><dl><dt>Mã tác vụ</dt><dd>{job.id}</dd><dt>Số lần chạy</dt><dd>{job.attemptCount}/{job.maxAttempts}</dd>{job.lastErrorCode && <><dt>Mã lỗi</dt><dd>{job.lastErrorCode}</dd></>}</dl></details></td><td><span className={badge(job.status)}>{STATUS_LABELS[job.status]}</span></td><td>{job.riskLevel === 'HIGH' ? 'Rủi ro cao' : job.riskLevel === 'BLOCKER' ? 'Bị chặn' : job.riskLevel === 'MEDIUM' ? 'Rủi ro trung bình' : 'Rủi ro thấp'}</td><td>{job.dryRun ? 'Chạy thử an toàn' : 'Thực thi có kiểm soát'}</td><td>{new Date(job.updatedAt).toLocaleString('vi-VN')}</td><td><div className={styles.actions}>{['PENDING','WAITING_APPROVAL','RETRY_SCHEDULED','PAUSED'].includes(job.status) && <button className={styles.button} disabled={busy === job.id} onClick={() => setAction({ job, name: 'cancel' })}>Hủy</button>}{job.status === 'FAILED' && job.attemptCount < job.maxAttempts && <button className={styles.button} disabled={busy === job.id} onClick={() => setAction({ job, name: 'retry' })}>Chạy lại</button>}</div></td></tr>)}</tbody></table></div>}<div className={styles.pagination}><button className={styles.button} disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Trang trước</button><span className={styles.muted}>Trang {page}/{pages}</span><button className={styles.button} disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Trang sau</button></div></section>
    {action && <div className={styles.dialogBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setAction(null); }}><div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="job-dialog-title"><h2 id="job-dialog-title">{action.name === 'cancel' ? 'Xác nhận hủy tác vụ' : 'Xác nhận chạy lại tác vụ'}</h2><p>{TYPE_LABELS[action.job.type]} sẽ {action.name === 'cancel' ? 'không được xử lý tiếp' : 'được đưa trở lại hàng chờ'}. Tác vụ đã hoàn thành không bị thay đổi.</p><label>Lý do<textarea value={reason} onChange={event => setReason(event.target.value)} rows={3} autoFocus /></label><div className={styles.dialogActions}><button className={styles.button} onClick={() => setAction(null)}>Đóng</button><button className={action.name === 'cancel' ? styles.danger : styles.primary} disabled={busy === action.job.id} onClick={() => void submitAction()}>Xác nhận</button></div></div></div>}
  </main>;
}
