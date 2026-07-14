'use client';

import { useCallback, useEffect, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import styles from '../operations.module.css';

type Control = { workerPaused: boolean; schedulerPaused: boolean; killSwitch: boolean; reason?: string; changedAt?: string; timezone: string };
type Action = 'pause_worker' | 'resume_worker' | 'pause_scheduler' | 'resume_scheduler' | 'enable_kill_switch' | 'disable_kill_switch';
const ACTION_LABELS: Record<Action, string> = { pause_worker: 'Tạm dừng bộ xử lý nền', resume_worker: 'Tiếp tục bộ xử lý nền', pause_scheduler: 'Tạm dừng lịch tự động', resume_scheduler: 'Tiếp tục lịch tự động', enable_kill_switch: 'Bật dừng khẩn cấp', disable_kill_switch: 'Tắt dừng khẩn cấp' };

export default function SafetySettingsPage() {
  const [control, setControl] = useState<Control | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/automation/control', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể tải cài đặt.');
      setControl(body.data);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể tải cài đặt.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!action) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setAction(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [action, busy]);

  async function submit() {
    if (!action || reason.trim().length < 8) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/automation/control', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, reason: reason.trim(), confirmed: true }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.message || 'Không thể cập nhật cài đặt.');
      setControl(body.data);
      setMessage(`${ACTION_LABELS[action]} đã được áp dụng và ghi vào nhật ký kiểm soát.`);
      setAction(null);
      setReason('');
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể cập nhật cài đặt. Dữ liệu chưa thay đổi.');
    } finally {
      setBusy(false);
    }
  }

  const isEmergencyAction = action === 'enable_kill_switch';
  return <main className={styles.page} aria-busy={loading}>
    <header className={styles.header}><div><h1>Cài đặt an toàn</h1><p>Điều khiển bộ xử lý nền, lịch chạy tự động và dừng khẩn cấp. Mọi thay đổi đều yêu cầu lý do và được ghi vào nhật ký kiểm soát.</p></div><button className={styles.button} onClick={() => void load()} disabled={loading}><DashboardIcon name="refresh" size={16} />Làm mới</button></header>
    {message && <div className={`${styles.notice} ${styles.successPanel}`} role="status">{message}</div>}
    {error && <div className={`${styles.notice} ${styles.errorBox}`} role="alert">{error} Dữ liệu hiện tại không bị thay đổi.</div>}
    {loading && !control && <div className={styles.notice}>Đang tải cài đặt an toàn...</div>}
    {control && <div className={styles.grid}>
      <section className={`${styles.panel} ${styles.infoPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="settings" size={19} />Điều khiển vận hành</h2></div><div className={styles.healthList}><div className={styles.healthRow}><div><span className={styles.name}>Bộ xử lý nền</span><span className={styles.muted}>Không nhận tác vụ mới khi tạm dừng; tác vụ đang chạy được kết thúc an toàn.</span></div><button className={control.workerPaused ? styles.primary : styles.warningButton} onClick={() => setAction(control.workerPaused ? 'resume_worker' : 'pause_worker')}>{control.workerPaused ? 'Tiếp tục' : 'Tạm dừng'}</button></div><div className={styles.healthRow}><div><span className={styles.name}>Lịch chạy tự động</span><span className={styles.muted}>Không tạo tác vụ mới khi tạm dừng; hàng chờ hiện có được giữ nguyên.</span></div><button className={control.schedulerPaused ? styles.primary : styles.warningButton} onClick={() => setAction(control.schedulerPaused ? 'resume_scheduler' : 'pause_scheduler')}>{control.schedulerPaused ? 'Tiếp tục' : 'Tạm dừng'}</button></div></div></section>

      <section className={`${styles.panel} ${styles.dangerPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="emergency" size={19} />Dừng khẩn cấp</h2><span className={`${styles.badge} ${control.killSwitch ? styles.error : styles.success}`}>{control.killSwitch ? 'Đang bật' : 'Đang tắt'}</span></div><div className={styles.notice}>Chặn lịch tự động, việc nhận tác vụ mới, lời gọi AI bên ngoài và thao tác đăng. Website công khai vẫn tiếp tục phục vụ.</div><div style={{ padding: 16 }}><button className={control.killSwitch ? styles.button : styles.danger} onClick={() => setAction(control.killSwitch ? 'disable_kill_switch' : 'enable_kill_switch')}><DashboardIcon name="emergency" size={16} />{control.killSwitch ? 'Tắt dừng khẩn cấp' : 'Bật dừng khẩn cấp'}</button></div></section>

      <section className={`${styles.panel} ${styles.successPanel}`}><div className={styles.panelHeader}><h2><DashboardIcon name="lock" size={19} />Chính sách được bảo vệ</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Chế độ an toàn</span><strong>Luôn bật</strong></div><div className={styles.healthRow}><span>Chỉ dùng dịch vụ miễn phí</span><strong>Đang bật</strong></div><div className={styles.healthRow}><span>Đăng an toàn</span><strong>Đang bật</strong></div><div className={styles.healthRow}><span>Thao tác rủi ro cao</span><strong>Cần phê duyệt</strong></div></div></section>

      <section className={styles.panel}><div className={styles.panelHeader}><h2><DashboardIcon name="task" size={19} />Thông tin thay đổi gần nhất</h2></div><div className={styles.healthList}><div className={styles.healthRow}><span>Lý do</span><strong>{control.reason || 'Chưa có thay đổi'}</strong></div><div className={styles.healthRow}><span>Thời gian</span><strong>{control.changedAt ? new Date(control.changedAt).toLocaleString('vi-VN') : 'Chưa ghi nhận'}</strong></div><div className={styles.healthRow}><span>Múi giờ</span><strong>Việt Nam (UTC+7)</strong></div></div></section>
    </div>}

    {action && <div className={styles.dialogBackdrop} onMouseDown={event => { if (event.target === event.currentTarget && !busy) setAction(null); }}><section className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="control-title"><h2 id="control-title">{ACTION_LABELS[action]}</h2>{isEmergencyAction ? <><p><strong>Việc sẽ dừng:</strong> lịch tạo tác vụ, worker nhận việc mới, lời gọi AI và đăng sản phẩm.</p><p><strong>Website công khai:</strong> vẫn tiếp tục phục vụ. Tác vụ đang chạy chỉ tiếp tục đến điểm kiểm tra an toàn tiếp theo.</p><p><strong>Người kích hoạt:</strong> tài khoản quản trị đang đăng nhập. Dừng khẩn cấp không tự tắt.</p></> : <p>Thao tác có hiệu lực ở backend và được lưu bền vững. Dữ liệu tác vụ hiện có không bị xóa.</p>}<label htmlFor="control-reason">Lý do<textarea id="control-reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} autoFocus aria-describedby="control-help" /></label><p id="control-help" className={styles.muted}>Nhập ít nhất 8 ký tự để xác nhận và lưu nhật ký.</p><div className={styles.dialogActions}><button className={styles.button} onClick={() => setAction(null)} disabled={busy}>Đóng</button><button className={isEmergencyAction ? styles.danger : styles.primary} disabled={busy || reason.trim().length < 8} onClick={() => void submit()}>{busy ? 'Đang cập nhật' : 'Xác nhận thay đổi'}</button></div></section></div>}
  </main>;
}
