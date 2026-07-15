'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import {
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
import type { ContentDraft, ContentWorkflowStatus, EditorialCheckResult } from '@/lib/product-intelligence/types';
import type { VerifiedProductFact } from '@/lib/types';
import { ContentEditor } from './content-editor';

type ContentApiItem = {
  id?: string;
  productId?: string;
  productTitle?: string;
  title?: string;
  contentWorkflowStatus?: ContentWorkflowStatus;
  status?: ContentWorkflowStatus;
  workflowStatus?: ContentWorkflowStatus;
  opportunityScore?: number;
  qualityBand?: string;
  source?: string;
  assignee?: string;
  warnings?: string[];
  dataIssues?: string[];
  publicationStatus?: string;
  publishStatus?: string;
  reviewStatus?: string;
  draftId?: string;
  updatedAt?: string;
  scheduledAt?: string;
  draft?: ContentDraft;
  editorialCheck?: EditorialCheckResult;
  evidenceFacts?: VerifiedProductFact[];
  product?: { id: string; title: string; opportunityScore?: number; qualityBand?: string; source?: string; contentWorkflowStatus?: ContentWorkflowStatus; updatedAt?: string };
};

type ContentResponse = ContentApiItem[] | {
  items?: ContentApiItem[];
  products?: ContentApiItem[];
  drafts?: ContentDraft[];
  summary?: Record<string, number>;
  updatedAt?: string;
};

type ContentRow = {
  key: string;
  productId: string;
  productTitle: string;
  status: ContentWorkflowStatus;
  opportunityScore?: number;
  qualityBand?: string;
  source?: string;
  assignee?: string;
  warnings: string[];
  publicationStatus?: string;
  updatedAt?: string;
  scheduledAt?: string;
  draft?: ContentDraft;
  editorialCheck?: EditorialCheckResult;
  evidenceFacts: VerifiedProductFact[];
};

type ViewMode = 'list' | 'kanban' | 'calendar';
type ContentJobTracking = { jobId: string; operationId: string; status: string; trackingRoute: string };

const STATUS_LABELS: Record<ContentWorkflowStatus, string> = {
  insufficient_data: 'Chưa đủ dữ liệu',
  ready_for_draft: 'Sẵn sàng tạo nháp',
  drafting: 'Đang soạn',
  needs_verification: 'Cần xác minh',
  pending_review: 'Chờ kiểm duyệt',
  approved: 'Đã duyệt',
  scheduled: 'Đã lên lịch',
  published: 'Đã đăng',
  stale: 'Lỗi thời',
  blocked: 'Bị chặn',
  archived: 'Đã lưu trữ',
};

const KANBAN_COLUMNS: Array<{ id: string; label: string; statuses: ContentWorkflowStatus[] }> = [
  { id: 'data', label: 'Chuẩn bị dữ liệu', statuses: ['insufficient_data', 'ready_for_draft'] },
  { id: 'draft', label: 'Soạn và xác minh', statuses: ['drafting', 'needs_verification', 'stale'] },
  { id: 'review', label: 'Kiểm duyệt', statuses: ['pending_review', 'approved'] },
  { id: 'delivery', label: 'Lên lịch và hoàn tất', statuses: ['scheduled', 'published', 'blocked', 'archived'] },
];

function isWorkflowStatus(value: unknown): value is ContentWorkflowStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS_LABELS, value);
}

function normalizeRows(response: ContentResponse | null): ContentRow[] {
  if (!response) return [];
  const drafts = Array.isArray(response) ? [] : response.drafts || [];
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
  const draftsByProduct = new Map(drafts.map((draft) => [draft.productId, draft]));
  let raw: ContentApiItem[];
  if (Array.isArray(response)) raw = response;
  else if (response.items) raw = response.items;
  else if (response.products) raw = response.products;
  else raw = (response.drafts || []).map((draft) => ({ productId: draft.productId, draft }));

  return raw.flatMap((item, index) => {
    const itemProductId = item.productId || item.product?.id || '';
    const draft = item.draft
      || (item.draftId ? draftsById.get(item.draftId) : undefined)
      || (itemProductId ? draftsByProduct.get(itemProductId) : undefined)
      || (item.productId && item.id && 'claims' in item ? item as unknown as ContentDraft : undefined);
    const productId = itemProductId || draft?.productId || '';
    if (!productId) return [];
    const rawStatus = item.workflowStatus || item.contentWorkflowStatus || item.status || item.product?.contentWorkflowStatus || draft?.status;
    const status = isWorkflowStatus(rawStatus) ? rawStatus : 'insufficient_data';
    return [{
      key: item.id || item.draftId || draft?.id || `${productId}-${index}`,
      productId,
      productTitle: item.productTitle || item.product?.title || item.title || draft?.title || 'Sản phẩm chưa có tên',
      status,
      opportunityScore: item.opportunityScore ?? item.product?.opportunityScore,
      qualityBand: item.qualityBand || item.product?.qualityBand,
      source: item.source || item.product?.source,
      assignee: item.assignee || draft?.assignee,
      warnings: item.warnings || item.dataIssues || [],
      publicationStatus: item.publicationStatus || item.publishStatus,
      updatedAt: item.updatedAt || draft?.updatedAt || item.product?.updatedAt,
      scheduledAt: item.scheduledAt || draft?.scheduledAt,
      draft,
      editorialCheck: item.editorialCheck,
      evidenceFacts: item.evidenceFacts || [],
    }];
  });
}

function statusTone(status: ContentWorkflowStatus): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  if (['approved', 'published'].includes(status)) return 'success';
  if (['ready_for_draft', 'drafting', 'scheduled'].includes(status)) return 'info';
  if (['needs_verification', 'pending_review', 'stale'].includes(status)) return 'warning';
  if (status === 'blocked') return 'danger';
  return 'neutral';
}

export default function ContentPage() {
  const resource = useDashboardResource<ContentResponse>('/api/dashboard/content');
  const [view, setView] = useState<ViewMode>('list');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const rows = useMemo(() => normalizeRows(resource.data), [resource.data]);
  const visible = useMemo(() => rows.filter((row) => {
    if (status && row.status !== status) return false;
    return !query || row.productTitle.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi'));
  }), [query, rows, status]);
  const selectedRow = useMemo(() => rows.find(row => row.draft?.id === selectedDraftId), [rows, selectedDraftId]);

  const runAction = async (row: ContentRow, action: 'create_local_draft' | 'editorial_check') => {
    setBusy(`${action}:${row.productId}`);
    setActionError('');
    setNotice('');
    try {
      const result = await dashboardRequest<ContentJobTracking>('/api/dashboard/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action === 'create_local_draft' ? 'create_local' : 'check', productId: row.productId, draftId: row.draft?.id }),
      });
      setNotice(action === 'create_local_draft' ? `Đã đưa khung local vào hàng chờ (${result.operationId}).` : `Đã đưa Editorial Guard vào hàng chờ (${result.operationId}).`);
      resource.reload();
    } catch (issue) {
      setActionError(issue instanceof Error ? issue.message : 'Không thể thực hiện thao tác nội dung.');
    } finally {
      setBusy('');
    }
  };

  const ready = rows.filter((row) => row.status === 'ready_for_draft').length;
  const review = rows.filter((row) => row.status === 'pending_review').length;
  const blocked = rows.filter((row) => row.status === 'blocked').length;

  return (
    <main className={styles.page}>
      <DashboardPageHeader
        icon="content"
        eyebrow="Nội dung"
        title="Content Studio"
        description="Chuẩn bị bài đánh giá dựa trên dữ liệu và bằng chứng hiện có. Chế độ local tạo khung bài mà không gọi AI, không bịa phần còn thiếu và không tự public."
        actions={<button type="button" className={styles.secondaryButton} onClick={resource.reload} disabled={resource.loading}><DashboardIcon name="refresh" size={16} />Làm mới</button>}
        meta={<><StatusBadge tone="success">Local draft khả dụng</StatusBadge><StatusBadge tone="warning">Safe Publish vẫn bắt buộc</StatusBadge></>}
      />

      {resource.loading && !resource.data && <DashboardState kind="loading" title="Đang tải Content Studio" />}
      {resource.error && <DashboardState kind="error" description={resource.error} onRetry={resource.reload} />}
      {actionError && <DashboardState kind="error" title="Không thể cập nhật nội dung" description={actionError} />}
      {notice && <div className={styles.notice} role="status"><DashboardIcon name="check" size={17} /><span>{notice}</span></div>}

      {resource.data && (
        <>
          <section className={styles.metrics} aria-label="Tóm tắt Content Studio">
            <MetricCard icon="content" label="Sản phẩm trong Studio" value={rows.length} help="Không phải nội dung đã public" />
            <MetricCard icon="today" label="Sẵn sàng tạo nháp" value={ready} tone={ready ? 'accent' : 'neutral'} help="Có thể tạo khung local" />
            <MetricCard icon="approval" label="Chờ kiểm duyệt" value={review} tone={review ? 'warning' : 'neutral'} help="Cần người có quyền phê duyệt" />
            <MetricCard icon="warning" label="Bị chặn" value={blocked} tone={blocked ? 'danger' : 'neutral'} help="Không thể Safe Publish" />
          </section>

          <div className={styles.toolbar}>
            <label className={`${styles.field} ${styles.fieldGrow}`}><span>Tìm sản phẩm</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tên sản phẩm" /></label>
            <label className={styles.field}><span>Workflow</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Tất cả trạng thái</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <button type="button" className={styles.secondaryButton} disabled={!query && !status} onClick={() => { setQuery(''); setStatus(''); }}>Xóa bộ lọc</button>
            <div className={styles.tabs} aria-label="Chế độ hiển thị">
              <button type="button" className={styles.tab} aria-pressed={view === 'list'} onClick={() => setView('list')}><DashboardIcon name="list" size={15} />Danh sách</button>
              <button type="button" className={styles.tab} aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}><DashboardIcon name="grid" size={15} />Kanban</button>
              <button type="button" className={styles.tab} aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}><DashboardIcon name="calendar" size={15} />Lịch</button>
            </div>
          </div>

          {visible.length === 0 ? <DashboardState kind="empty" title={rows.length ? 'Không có nội dung phù hợp' : 'Content Studio chưa có sản phẩm'} description={rows.length ? 'Hãy xóa hoặc thay đổi bộ lọc.' : 'Đưa sản phẩm đủ dữ liệu vào Studio từ Kết quả bot hoặc Nhập sản phẩm.'} actionHref={rows.length ? undefined : '/dashboard/products'} actionLabel={rows.length ? undefined : 'Mở Kết quả bot'} /> : (
            <>
              {view === 'list' && (
                <Panel title="Danh sách nội dung" icon="list" description={`${visible.length} sản phẩm trong chế độ xem hiện tại.`}>
                  <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Sản phẩm</th><th>Điểm cơ hội</th><th>Workflow</th><th>Nguồn / người xử lý</th><th>Cảnh báo</th><th>Thao tác</th></tr></thead><tbody>{visible.map((row) => <tr key={row.key}><td data-label="Sản phẩm"><strong>{row.productTitle}</strong><small>Cập nhật: {formatDateTime(row.updatedAt)}</small></td><td data-label="Điểm cơ hội"><strong>{Number.isFinite(row.opportunityScore) ? row.opportunityScore : 'Chưa chấm'}</strong><small>Chất lượng: {row.qualityBand || 'Chưa có'}</small></td><td data-label="Workflow"><StatusBadge tone={statusTone(row.status)}>{STATUS_LABELS[row.status]}</StatusBadge>{row.editorialCheck && <small>Editorial Guard: {row.editorialCheck.status}</small>}</td><td data-label="Nguồn / người xử lý">{row.source || 'Chưa rõ nguồn'}<small>{row.assignee || 'Chưa phân công'}</small></td><td data-label="Cảnh báo">{row.warnings.length ? row.warnings.slice(0, 3).join(' · ') : 'Không có cảnh báo'}{row.draft?.claims.some((claim) => claim.type === 'UNVERIFIED') && <small>Có claim chưa xác minh</small>}</td><td data-label="Thao tác"><div className={styles.cellActions}><Link className={styles.textButton} href={`/dashboard/products/${encodeURIComponent(row.productId)}`}>Sản phẩm</Link>{row.status === 'ready_for_draft' && !row.draft && <button type="button" className={styles.textButton} disabled={Boolean(busy)} onClick={() => void runAction(row, 'create_local_draft')}>{busy === `create_local_draft:${row.productId}` ? 'Đang tạo' : 'Tạo khung local'}</button>}{row.draft && <button type="button" className={styles.textButton} onClick={() => setSelectedDraftId(row.draft!.id)}>Mở trình soạn</button>}{row.draft && <button type="button" className={styles.textButton} disabled={Boolean(busy)} onClick={() => void runAction(row, 'editorial_check')}>{busy === `editorial_check:${row.productId}` ? 'Đang kiểm tra' : 'Editorial Guard'}</button>}</div></td></tr>)}</tbody></table></div>
                </Panel>
              )}

              {view === 'kanban' && (
                <Panel title="Kanban nội dung" icon="grid" description="Các cột gom nhóm workflow; trạng thái chi tiết vẫn hiển thị trên từng thẻ.">
                  <div className={styles.kanban}>{KANBAN_COLUMNS.map((column) => { const items = visible.filter((row) => column.statuses.includes(row.status)); return <section className={styles.kanbanColumn} key={column.id}><h3>{column.label}<StatusBadge>{items.length}</StatusBadge></h3><div className={styles.cardList}>{items.length ? items.map((row) => <article className={styles.itemCard} key={row.key}><StatusBadge tone={statusTone(row.status)}>{STATUS_LABELS[row.status]}</StatusBadge><h4>{row.productTitle}</h4><p>Điểm cơ hội: {Number.isFinite(row.opportunityScore) ? row.opportunityScore : 'chưa chấm'} · {row.source || 'chưa rõ nguồn'}</p>{row.status === 'ready_for_draft' && !row.draft && <button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => void runAction(row, 'create_local_draft')}>Tạo khung local</button>}{row.draft && <button type="button" className={styles.secondaryButton} onClick={() => setSelectedDraftId(row.draft!.id)}>Mở trình soạn</button>}<Link className={styles.textButton} href={`/dashboard/products/${encodeURIComponent(row.productId)}`}>Xem sản phẩm</Link></article>) : <p className={styles.help}>Không có nội dung ở nhóm này.</p>}</div></section>; })}</div>
                </Panel>
              )}

              {view === 'calendar' && (
                <Panel title="Lịch nội dung" icon="calendar" description="Chỉ hiển thị nội dung có thời điểm lên lịch thật.">
                  {visible.filter((row) => row.scheduledAt).length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title="Chưa có nội dung được lên lịch" description="SanDeal không tự tạo mốc lịch khi backend chưa có scheduledAt." /></div> : <div className={`${styles.cardList} ${styles.paddedList}`}>{visible.filter((row) => row.scheduledAt).sort((left, right) => Date.parse(left.scheduledAt!) - Date.parse(right.scheduledAt!)).map((row) => <article className={styles.itemCard} key={row.key}><div className={styles.cardMeta}><StatusBadge tone="info">{formatDateTime(row.scheduledAt)}</StatusBadge><StatusBadge tone={statusTone(row.status)}>{STATUS_LABELS[row.status]}</StatusBadge></div><h3>{row.productTitle}</h3><p>{row.assignee ? `Người xử lý: ${row.assignee}` : 'Chưa phân công người xử lý'}</p></article>)}</div>}
                </Panel>
              )}
            </>
          )}

          {selectedRow?.draft && <ContentEditor key={`${selectedRow.draft.id}:${selectedRow.draft.updatedAt}`} draft={selectedRow.draft} productTitle={selectedRow.productTitle} evidenceFacts={selectedRow.evidenceFacts} onClose={() => setSelectedDraftId('')} onChanged={resource.reload} />}

          <div className={`${styles.notice} ${styles.noticeWarning}`}><DashboardIcon name="lock" size={17} /><span>Khung local chỉ chèn dữ liệu đã xác minh và để trống phần thiếu. Claim quan trọng chưa xác minh vẫn bị Editorial Guard và Safe Publish chặn.</span></div>
        </>
      )}
    </main>
  );
}
