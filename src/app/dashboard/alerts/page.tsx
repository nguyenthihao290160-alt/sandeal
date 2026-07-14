'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import {
  DashboardDialog,
  DashboardPageHeader,
  DashboardState,
  MetricCard,
  Panel,
  StatusBadge,
  dashboardRequest,
  formatDateTime,
  intelligenceStyles as styles,
  useDashboardResource,
} from '@/components/dashboard/intelligence-ui';
import type { AlertSeverity, AlertStatus, ProductAlert } from '@/lib/product-intelligence/types';

type AlertsResponse = ProductAlert[] | {
  alerts?: ProductAlert[];
  items?: ProductAlert[];
  summary?: Partial<Record<AlertSeverity | AlertStatus, number>> & { total?: number; unresolved?: number };
  updatedAt?: string;
};

const SEVERITY_LABELS: Record<AlertSeverity, string> = { info: 'Thông tin', attention: 'Cần chú ý', important: 'Quan trọng', critical: 'Khẩn cấp' };
const STATUS_LABELS: Record<AlertStatus, string> = { new: 'Mới', acknowledged: 'Đã xem', in_progress: 'Đang xử lý', resolved: 'Đã giải quyết', ignored: 'Đã bỏ qua' };

function severityTone(severity: AlertSeverity): 'info' | 'warning' | 'danger' {
  return severity === 'critical' ? 'danger' : severity === 'important' || severity === 'attention' ? 'warning' : 'info';
}

function statusTone(status: AlertStatus): 'info' | 'warning' | 'success' | 'neutral' {
  if (status === 'resolved') return 'success';
  if (status === 'ignored') return 'neutral';
  if (status === 'in_progress') return 'warning';
  return 'info';
}

export default function AlertsPage() {
  const resource = useDashboardResource<AlertsResponse>('/api/dashboard/alerts');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [ignoreAlert, setIgnoreAlert] = useState<ProductAlert | null>(null);
  const [ignoreReason, setIgnoreReason] = useState('');
  const response = resource.data;
  const alerts = useMemo(() => Array.isArray(response) ? response : response?.alerts || response?.items || [], [response]);
  const visible = useMemo(() => alerts.filter((alert) => (!severity || alert.severity === severity) && (!status || alert.status === status)), [alerts, severity, status]);
  const openAlerts = alerts.filter((alert) => !['resolved', 'ignored'].includes(alert.status));
  const critical = openAlerts.filter((alert) => alert.severity === 'critical').length;
  const important = openAlerts.filter((alert) => alert.severity === 'important').length;
  const summary = Array.isArray(response) ? undefined : response?.summary;

  const updateAlert = async (alert: ProductAlert, nextStatus: AlertStatus, reason?: string) => {
    setBusy(alert.id);
    setActionError('');
    try {
      await dashboardRequest('/api/dashboard/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alert.id, status: nextStatus, reason }),
      });
      setIgnoreAlert(null);
      setIgnoreReason('');
      resource.reload();
    } catch (issue) {
      setActionError(issue instanceof Error ? issue.message : 'Không thể cập nhật cảnh báo.');
    } finally {
      setBusy('');
    }
  };

  return (
    <main className={styles.page}>
      <DashboardPageHeader
        icon="alert"
        eyebrow="Vận hành"
        title="Trung tâm cảnh báo"
        description="Tập trung các vấn đề cần xử lý từ dữ liệu, liên kết, worker và scheduler. Cảnh báo được chống trùng ở backend và mặc định chỉ hiển thị trong ứng dụng."
        actions={<button type="button" className={styles.secondaryButton} onClick={resource.reload} disabled={resource.loading}><DashboardIcon name="refresh" size={16} />Làm mới</button>}
        meta={<><StatusBadge tone="info">Thông báo trong ứng dụng</StatusBadge><StatusBadge tone="success">Không gửi webhook thật</StatusBadge></>}
      />

      {resource.loading && !response && <DashboardState kind="loading" title="Đang tải cảnh báo" />}
      {resource.error && <DashboardState kind="error" description={resource.error} onRetry={resource.reload} />}
      {actionError && <DashboardState kind="error" title="Không thể cập nhật cảnh báo" description={actionError} />}

      {response && (
        <>
          <section className={styles.metrics} aria-label="Tóm tắt cảnh báo">
            <MetricCard icon="alert" label="Chưa xử lý" value={summary?.unresolved ?? openAlerts.length} tone={openAlerts.length ? 'warning' : 'success'} help="Không gồm đã giải quyết hoặc bỏ qua" />
            <MetricCard icon="emergency" label="Khẩn cấp" value={summary?.critical ?? critical} tone={critical ? 'danger' : 'neutral'} help="Cần ưu tiên kiểm tra" />
            <MetricCard icon="warning" label="Quan trọng" value={summary?.important ?? important} tone={important ? 'warning' : 'neutral'} help="Có thể ảnh hưởng vận hành hoặc public data" />
            <MetricCard icon="check" label="Đã giải quyết" value={summary?.resolved ?? alerts.filter((alert) => alert.status === 'resolved').length} tone="success" help="Đã có trạng thái xử lý" />
          </section>

          <div className={styles.toolbar}>
            <label className={styles.field}><span>Mức độ</span><select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">Tất cả</option>{Object.entries(SEVERITY_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label className={styles.field}><span>Trạng thái</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Tất cả</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <button type="button" className={styles.secondaryButton} disabled={!severity && !status} onClick={() => { setSeverity(''); setStatus(''); }}>Xóa bộ lọc</button>
          </div>

          <Panel title="Cảnh báo cần theo dõi" icon="alert" description={`${visible.length} cảnh báo phù hợp bộ lọc.`}>
            {visible.length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title={alerts.length ? 'Không có cảnh báo phù hợp' : 'Chưa có cảnh báo'} description={alerts.length ? 'Hãy thay đổi hoặc xóa bộ lọc.' : 'Chưa ghi nhận vấn đề trong lần đánh giá gần nhất.'} /></div> : (
              <div className={styles.alertList}>
                {visible.map((alert) => (
                  <article className={styles.alertCard} data-severity={alert.severity} key={alert.id}>
                    <span className={styles.alertIcon}><DashboardIcon name={alert.severity === 'critical' ? 'emergency' : 'alert'} size={19} /></span>
                    <div>
                      <div className={styles.cardMeta}><StatusBadge tone={severityTone(alert.severity)}>{SEVERITY_LABELS[alert.severity]}</StatusBadge><StatusBadge tone={statusTone(alert.status)}>{STATUS_LABELS[alert.status]}</StatusBadge><span className={styles.help}>{formatDateTime(alert.createdAt)}</span></div>
                      <h3>{alert.title}</h3>
                      <p>{alert.message}</p>
                      {alert.suggestedAction && <div className={styles.notice}><DashboardIcon name="today" size={16} /><span><strong>Hành động đề xuất:</strong> {alert.suggestedAction}</span></div>}
                      <div className={styles.actionDetails}><span>{alert.entityType}{alert.entityId ? ` · ${alert.entityId}` : ''}</span><span>Mã thao tác: {alert.operationId}</span>{alert.cooldownUntil && <span>Cooldown đến {formatDateTime(alert.cooldownUntil)}</span>}</div>
                    </div>
                    <div className={styles.cellActions}>
                      {alert.entityType === 'product' && alert.entityId && <Link className={styles.textButton} href={`/dashboard/products/${encodeURIComponent(alert.entityId)}`}>Mở sản phẩm</Link>}
                      {alert.status === 'new' && <button type="button" className={styles.textButton} disabled={busy === alert.id} onClick={() => void updateAlert(alert, 'acknowledged')}>Đánh dấu đã xem</button>}
                      {!['in_progress', 'resolved', 'ignored'].includes(alert.status) && <button type="button" className={styles.textButton} disabled={busy === alert.id} onClick={() => void updateAlert(alert, 'in_progress')}>Đang xử lý</button>}
                      {!['resolved', 'ignored'].includes(alert.status) && <button type="button" className={styles.textButton} disabled={busy === alert.id} onClick={() => void updateAlert(alert, 'resolved')}>Đã giải quyết</button>}
                      {!['resolved', 'ignored'].includes(alert.status) && <button type="button" className={styles.textButton} disabled={busy === alert.id} onClick={() => { setIgnoreAlert(alert); setIgnoreReason(''); }}>Bỏ qua</button>}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}

      <DashboardDialog
        open={Boolean(ignoreAlert)}
        title="Bỏ qua cảnh báo có lý do"
        description="Cảnh báo chỉ được chuyển trạng thái; dữ liệu nguồn và lịch sử cảnh báo không bị xóa."
        onClose={() => { if (!busy) { setIgnoreAlert(null); setIgnoreReason(''); } }}
        actions={<><button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => setIgnoreAlert(null)}>Đóng</button><button type="button" className={styles.dangerButton} disabled={!ignoreAlert || ignoreReason.trim().length < 5 || Boolean(busy)} onClick={() => ignoreAlert && void updateAlert(ignoreAlert, 'ignored', ignoreReason.trim())}>{busy ? 'Đang lưu' : 'Xác nhận bỏ qua'}</button></>}
      >
        <label className={styles.formField}><span>Lý do</span><textarea data-autofocus rows={4} value={ignoreReason} onChange={(event) => setIgnoreReason(event.target.value)} placeholder="Nhập ít nhất 5 ký tự" /></label>
      </DashboardDialog>
    </main>
  );
}
