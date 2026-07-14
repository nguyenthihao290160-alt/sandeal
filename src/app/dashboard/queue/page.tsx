'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import type { AutomationJob, AutomationJobType } from '@/lib/automation/types';
import styles from '../operations.module.css';

type SafeJob = Omit<AutomationJob, 'payload'>;
const TYPES: Record<AutomationJobType, string> = { PRODUCT_SCAN: 'Quét sản phẩm', AUTO_PILOT: 'Chế độ tự động', SAFE_PUBLISH: 'Đăng an toàn', AI_ANALYSIS: 'Phân tích AI', HEALTH_CHECK: 'Kiểm tra hệ thống' };

export default function ApprovalQueuePage() {
  const [items, setItems] = useState<SafeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<{ job: SafeJob; action: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/automation/jobs?status=WAITING_APPROVAL&page=1&pageSize=50', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể tải yêu cầu phê duyệt.');
      setItems(body.data.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể tải yêu cầu phê duyệt.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setSelected(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [selected, busy]);

  async function submit() {
    if (!selected || reason.trim().length < 5) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/automation/jobs/${selected.job.id}/${selected.action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể cập nhật phê duyệt.');
      setSelected(null);
      setReason('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể cập nhật phê duyệt. Dữ liệu chưa thay đổi.');
    } finally {
      setBusy(false);
    }
  }

  return <main className={styles.page} aria-busy={loading}>
    <header className={styles.header}><div><h1>Hàng chờ phê duyệt</h1><p>Xem xét tác vụ rủi ro cao trước khi bộ xử lý nền nhận việc. Tác vụ bị chặn không thể được duyệt để vượt quy tắc an toàn.</p></div><button className={styles.button} onClick={() => void load()} disabled={loading}><DashboardIcon name="refresh" size={16} />Làm mới</button></header>
    {error && <div className={`${styles.notice} ${styles.errorBox}`} role="alert">{error} Dữ liệu hiện tại không bị thay đổi.</div>}
    <section className={`${styles.panel} ${styles.infoPanel}`}>
      <div className={styles.panelHeader}><h2><DashboardIcon name="approval" size={19} />Yêu cầu đang chờ</h2><span className={styles.badge}>{items.length} yêu cầu</span></div>
      {loading ? <div className={styles.empty}>Đang tải yêu cầu...</div> : items.length === 0 ? <div className={styles.empty}><span className={styles.emptyIcon}><DashboardIcon name="approval" size={22} /></span><h3>Không có tác vụ cần phê duyệt</h3><p>Các tác vụ có rủi ro cao sẽ xuất hiện tại đây. Tác vụ bị chặn tuyệt đối không thể được duyệt, và yêu cầu phê duyệt có thời hạn.</p><div className={styles.emptyActions}><Link className={styles.button} href="/dashboard/ai-bots">Xem tác vụ</Link><Link className={styles.primary} href="/dashboard/automation">Chạy thử an toàn</Link></div></div> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Phạm vi</th><th>Người yêu cầu</th><th>Rủi ro</th><th>Hết hạn</th><th>Thao tác</th></tr></thead><tbody>{items.map(job => <tr key={job.id}><td><span className={styles.name}>{TYPES[job.type]}</span><span className={styles.muted}>Mã thao tác: {job.operationId.slice(0, 12)}</span></td><td>{job.requestedBy}</td><td><span className={`${styles.badge} ${styles.warning}`}>Rủi ro cao</span></td><td>{job.approvalExpiresAt ? new Date(job.approvalExpiresAt).toLocaleString('vi-VN') : 'Không xác định'}</td><td><div className={styles.actions}><button className={styles.primary} onClick={() => setSelected({ job, action: 'approve' })}>Phê duyệt</button><button className={styles.button} onClick={() => setSelected({ job, action: 'reject' })}>Từ chối</button></div></td></tr>)}</tbody></table></div>}
    </section>
    {selected && <div className={styles.dialogBackdrop} onMouseDown={event => { if (event.target === event.currentTarget && !busy) setSelected(null); }}><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="approval-title"><h2 id="approval-title">{selected.action === 'approve' ? 'Phê duyệt tác vụ' : 'Từ chối tác vụ'}</h2><p>Đối tượng: {TYPES[selected.job.type]}. {selected.action === 'approve' ? 'Tác vụ được đưa lại vào hàng chờ và chỉ chạy khi các quy tắc an toàn vẫn hợp lệ.' : 'Tác vụ bị hủy và không tạo tác động bên ngoài.'}</p><label htmlFor="approval-reason">Lý do<textarea id="approval-reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} autoFocus aria-describedby="approval-help" /></label><p id="approval-help" className={styles.muted}>Nhập ít nhất 5 ký tự để lưu vào nhật ký kiểm soát.</p><div className={styles.dialogActions}><button className={styles.button} onClick={() => setSelected(null)} disabled={busy}>Đóng</button><button className={selected.action === 'approve' ? styles.primary : styles.danger} disabled={busy || reason.trim().length < 5} onClick={() => void submit()}>{busy ? 'Đang cập nhật' : 'Xác nhận'}</button></div></section></div>}
  </main>;
}
