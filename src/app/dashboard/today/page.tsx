'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import {
  DashboardPageHeader,
  DashboardDialog,
  DashboardState,
  MetricCard,
  Panel,
  StatusBadge,
  dashboardRequest,
  formatDateTime,
  formatNumber,
  intelligenceStyles as styles,
  useDashboardResource,
} from '@/components/dashboard/intelligence-ui';
import type { RecommendedAction } from '@/lib/product-intelligence/types';

type RecommendationsResponse = RecommendedAction[] | { actions?: RecommendedAction[]; recommendations?: RecommendedAction[]; items?: RecommendedAction[]; updatedAt?: string };
const PRIORITY_ORDER: Record<RecommendedAction['priority'], number> = { critical: 4, high: 3, medium: 2, low: 1 };
const PRIORITY_LABELS: Record<RecommendedAction['priority'], string> = { critical: 'Khẩn cấp', high: 'Ưu tiên cao', medium: 'Ưu tiên vừa', low: 'Ưu tiên thấp' };

function priorityTone(priority: RecommendedAction['priority']): 'danger' | 'warning' | 'info' | 'neutral' {
  return priority === 'critical' ? 'danger' : priority === 'high' ? 'warning' : priority === 'medium' ? 'info' : 'neutral';
}

function safeDashboardHref(value: string): string {
  return value === '/dashboard' || value.startsWith('/dashboard/') ? value : '/dashboard';
}

export default function TodayPage() {
  const resource = useDashboardResource<RecommendationsResponse>('/api/dashboard/recommendations');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [ignoreAction, setIgnoreAction] = useState<RecommendedAction | null>(null);
  const [ignoreReason, setIgnoreReason] = useState('');
  const response = resource.data;
  const actions = useMemo(() => {
    const items = Array.isArray(response) ? response : response?.actions || response?.recommendations || response?.items || [];
    return [...items].filter((item) => item.status !== 'ignored').sort((left, right) => PRIORITY_ORDER[right.priority] - PRIORITY_ORDER[left.priority] || left.createdAt.localeCompare(right.createdAt)).slice(0, 5);
  }, [response]);
  const critical = actions.filter((action) => action.priority === 'critical').length;
  const totalObjects = actions.reduce((total, action) => total + Math.max(0, action.objectCount), 0);

  const updateStatus = async (action: RecommendedAction, status: 'seen' | 'snoozed' | 'ignored', reason?: string) => {
    setBusy(action.id);
    setActionError('');
    try {
      await dashboardRequest('/api/dashboard/recommendations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: action.id, status, reason }),
      });
      setIgnoreAction(null);
      setIgnoreReason('');
      resource.reload();
    } catch (issue) {
      setActionError(issue instanceof Error ? issue.message : 'Không thể cập nhật hành động đề xuất.');
    } finally {
      setBusy('');
    }
  };

  return (
    <main className={styles.page}>
      <DashboardPageHeader
        icon="today"
        eyebrow="Tổng quan"
        title="Việc nên làm hôm nay"
        description="Tối đa năm hành động được ưu tiên từ trạng thái thật của sản phẩm, nguồn, nội dung và vận hành. Mỗi đề xuất nêu rõ lý do và tiêu chí hoàn thành."
        actions={<button type="button" className={styles.secondaryButton} onClick={resource.reload} disabled={resource.loading}><DashboardIcon name="refresh" size={16} />Làm mới</button>}
        meta={<StatusBadge tone="info">Dựa trên dữ liệu hiện tại</StatusBadge>}
      />

      {resource.loading && !response && <DashboardState kind="loading" title="Đang tính việc cần ưu tiên" />}
      {resource.error && <DashboardState kind="error" description={resource.error} onRetry={resource.reload} />}
      {actionError && <DashboardState kind="error" title="Không thể cập nhật đề xuất" description={actionError} />}

      {response && (
        <>
          <section className={styles.metrics} aria-label="Tóm tắt việc nên làm">
            <MetricCard icon="today" label="Hành động hôm nay" value={actions.length} help="Giới hạn tối đa 5" />
            <MetricCard icon="emergency" label="Khẩn cấp" value={critical} tone={critical ? 'danger' : 'neutral'} help="Xử lý trước nếu có" />
            <MetricCard icon="product" label="Đối tượng liên quan" value={formatNumber(totalObjects)} tone="accent" help="Tổng số đối tượng từ đề xuất" />
            <MetricCard icon="check" label="Đã có đường xử lý" value={actions.filter((action) => safeDashboardHref(action.href) === action.href).length} tone="success" help="Đường dẫn nội bộ hợp lệ" />
          </section>

          <Panel title="Danh sách ưu tiên" icon="today" description="Sắp xếp theo mức ưu tiên, sau đó theo thời điểm tạo đề xuất.">
            {actions.length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title="Không có việc cần ưu tiên" description="Backend chưa tạo đề xuất mới từ dữ liệu hiện tại. Bạn có thể kiểm tra cảnh báo hoặc nhập sản phẩm đầu tiên." actionHref="/dashboard/alerts" actionLabel="Xem cảnh báo" /></div> : (
              <div className={styles.actionList}>
                {actions.map((action, index) => (
                  <article className={styles.actionCard} data-priority={action.priority} key={action.id}>
                    <span className={styles.score}>{index + 1}</span>
                    <div>
                      <div className={styles.cardMeta}><StatusBadge tone={priorityTone(action.priority)}>{PRIORITY_LABELS[action.priority]}</StatusBadge><StatusBadge>{action.status === 'new' ? 'Mới' : action.status === 'seen' ? 'Đã xem' : action.status === 'snoozed' ? 'Đã hoãn' : 'Đã bỏ qua'}</StatusBadge></div>
                      <h3>{action.title}</h3>
                      <p>{action.reason}</p>
                      <div className={styles.actionDetails}><span>{formatNumber(action.objectCount)} đối tượng</span><span>{action.estimatedTime}</span><span>Tạo lúc {formatDateTime(action.createdAt)}</span></div>
                      <dl className={styles.definitionList}>
                        <div><dt>Tác động</dt><dd>{action.impact}</dd></div>
                        <div><dt>Hoàn thành khi</dt><dd>{action.completionCriteria}</dd></div>
                      </dl>
                    </div>
                    <div className={styles.cellActions}>
                      <Link className={styles.primaryButton} href={safeDashboardHref(action.href)}><DashboardIcon name="external" size={15} />Mở xử lý</Link>
                      {action.status === 'new' && <button type="button" className={styles.textButton} disabled={busy === action.id} onClick={() => void updateStatus(action, 'seen')}>Đánh dấu đã xem</button>}
                      {action.status !== 'snoozed' && <button type="button" className={styles.textButton} disabled={busy === action.id} onClick={() => void updateStatus(action, 'snoozed')}>Hoãn</button>}
                      <button type="button" className={styles.textButton} disabled={busy === action.id} onClick={() => { setIgnoreAction(action); setIgnoreReason(''); }}>Bỏ qua</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <div className={styles.notice}><DashboardIcon name="lock" size={17} /><span>Mọi thay đổi trạng thái được gửi về backend recommendations. UI không tự ghi trạng thái giả hoặc coi việc mở đường dẫn là đã hoàn thành.</span></div>
        </>
      )}

      <DashboardDialog
        open={Boolean(ignoreAction)}
        title="Bỏ qua đề xuất có lý do"
        description="Đề xuất được chuyển trạng thái, không xóa dữ liệu đã dùng để tính hành động."
        onClose={() => { if (!busy) { setIgnoreAction(null); setIgnoreReason(''); } }}
        actions={<><button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => setIgnoreAction(null)}>Đóng</button><button type="button" className={styles.dangerButton} disabled={!ignoreAction || ignoreReason.trim().length < 5 || Boolean(busy)} onClick={() => ignoreAction && void updateStatus(ignoreAction, 'ignored', ignoreReason.trim())}>{busy ? 'Đang lưu' : 'Xác nhận bỏ qua'}</button></>}
      >
        <label className={styles.formField}><span>Lý do</span><textarea data-autofocus rows={4} value={ignoreReason} onChange={(event) => setIgnoreReason(event.target.value)} placeholder="Nhập ít nhất 5 ký tự" /></label>
      </DashboardDialog>
    </main>
  );
}
