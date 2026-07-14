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
  formatPercent,
  intelligenceStyles as styles,
  useDashboardResource,
} from '@/components/dashboard/intelligence-ui';
import type { DuplicateGroup, QualityBand } from '@/lib/product-intelligence/types';

type QualityProduct = {
  id: string;
  title: string;
  source?: string;
  platform?: string;
  qualityScore?: number;
  qualityBand?: QualityBand;
  opportunityScore?: number;
  opportunityBand?: string;
  dealScore?: number;
  dealBand?: string;
  duplicateConfidence?: number;
  dataIssues?: string[];
  recommendedActions?: string[];
  scoreCalculatedAt?: string;
};

type QualityResponse = {
  summary?: {
    total?: number;
    averageQualityScore?: number;
    good?: number;
    fair?: number;
    needsData?: number;
    poor?: number;
    blocked?: number;
    duplicateGroups?: number;
    suspectedDuplicates?: number;
  };
  products?: QualityProduct[];
  items?: QualityProduct[];
  duplicateGroups?: DuplicateGroupView[];
  groups?: DuplicateGroupView[];
  pagination?: { page: number; pageSize: number; totalItems: number; totalPages: number };
  updatedAt?: string;
};

type DuplicateGroupView = Omit<DuplicateGroup, 'mergeHistory'> & {
  products: Array<{
    id: string;
    title: string;
    source: string;
    platform: string;
    qualityScore?: number;
    status: string;
    verifiedSource: boolean;
    updatedAt: string;
  }>;
  hasMergeHistory: boolean;
};

type DuplicateMergePreview = {
  groupId: string;
  primaryId: string;
  secondaryIds: string[];
  filledFields: string[];
  conflicts: string[];
  businessDataChanged: false;
  requiresApproval: true;
};

type DuplicateJobResult = {
  jobId: string;
  operationId: string;
  status: string;
  approvalStatus: string;
};

const BAND_LABELS: Record<string, string> = {
  good: 'Tốt', fair: 'Khá', needs_data: 'Cần bổ sung', poor: 'Kém', blocked: 'Bị chặn',
};

function bandTone(value?: string): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  if (value === 'good' || value === 'priority' || value === 'featured') return 'success';
  if (value === 'fair' || value === 'recommended' || value === 'consider') return 'info';
  if (value === 'needs_data' || value === 'verify' || value === 'normal') return 'warning';
  if (value === 'poor' || value === 'blocked' || value === 'ineligible') return 'danger';
  return 'neutral';
}

function confidencePercent(value: number): number {
  return value <= 1 ? value * 100 : value;
}

function duplicateStatusLabel(status: DuplicateGroup['status']): string {
  if (status === 'pending') return 'Chờ xem xét';
  if (status === 'kept_separate') return 'Giữ riêng';
  if (status === 'ignored') return 'Đã bỏ qua';
  return 'Đã hợp nhất';
}

function DuplicateGroupReviewCard({ group, onChanged }: { group: DuplicateGroupView; onChanged: () => void }) {
  const [primaryId, setPrimaryId] = useState(group.suggestedPrimaryId);
  const [preview, setPreview] = useState<DuplicateMergePreview | null>(null);
  const [reason, setReason] = useState(group.reason || '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'apply' | 'keep' | 'ignore' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [job, setJob] = useState<DuplicateJobResult | null>(null);

  const runPreview = async () => {
    setBusy('preview'); setError(''); setMessage(''); setJob(null);
    try {
      const result = await dashboardRequest<DuplicateMergePreview>('/api/dashboard/quality', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'merge_preview', groupId: group.id, primaryId }),
      });
      setPreview(result); setConfirmed(false);
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Không thể xem trước hợp nhất.'); }
    finally { setBusy(null); }
  };

  const applyMerge = async () => {
    if (!preview || !confirmed) return;
    setBusy('apply'); setError(''); setMessage('');
    try {
      const result = await dashboardRequest<DuplicateJobResult>('/api/dashboard/quality', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'merge_apply', groupId: group.id, primaryId, confirmed: true,
          idempotencyKey: `duplicate-merge:${group.id}:${primaryId}:${crypto.randomUUID()}`,
        }),
      });
      setJob(result);
      setMessage('Đã tạo tác vụ rủi ro HIGH. Metadata chưa thay đổi cho đến khi tác vụ được phê duyệt và worker xử lý.');
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Không thể tạo tác vụ hợp nhất.'); }
    finally { setBusy(null); }
  };

  const saveReview = async (action: 'review_keep' | 'review_ignore') => {
    if (reason.trim().length < 5) { setError('Vui lòng nhập lý do có ít nhất 5 ký tự.'); return; }
    setBusy(action === 'review_keep' ? 'keep' : 'ignore'); setError(''); setMessage(''); setJob(null);
    try {
      await dashboardRequest<DuplicateGroupView>('/api/dashboard/quality', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, groupId: group.id, reason }),
      });
      setMessage(action === 'review_keep' ? 'Đã ghi nhận quyết định giữ riêng các sản phẩm.' : 'Đã bỏ qua cảnh báo cùng lý do.');
      onChanged();
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Không thể lưu quyết định xem xét.'); }
    finally { setBusy(null); }
  };

  return (
    <article className={styles.itemCard}>
      <div className={styles.cardMeta}><StatusBadge tone={confidencePercent(group.confidence) >= 90 ? 'danger' : confidencePercent(group.confidence) >= 65 ? 'warning' : 'neutral'}>Confidence {formatPercent(confidencePercent(group.confidence))}</StatusBadge><StatusBadge>{duplicateStatusLabel(group.status)}</StatusBadge><span className={styles.help}>Thuật toán {group.algorithmVersion}</span></div>
      <h3>{group.productIds.length} sản phẩm trong nhóm</h3>
      <p className={styles.help}>{group.reason || group.candidates.map(candidate => candidate.reason).filter(Boolean).join(' · ') || 'Backend chưa cung cấp lý do tổng hợp.'}</p>
      <div className={styles.cardMeta}>{group.candidates.flatMap(candidate => candidate.matchedSignals).slice(0, 8).map((signal, index) => <StatusBadge tone="info" key={`${group.id}-${signal}-${index}`}>{signal}</StatusBadge>)}</div>

      <div className={styles.formGrid}>
        <label className={`${styles.formField} ${styles.formFull}`}><span>Chọn bản chính</span><select value={primaryId} onChange={(event) => { setPrimaryId(event.target.value); setPreview(null); setConfirmed(false); setJob(null); }} disabled={group.status === 'merged' || Boolean(busy)}>{group.products.map(product => <option value={product.id} key={product.id}>{product.title} · Q{product.qualityScore ?? '—'} · {product.source}</option>)}</select></label>
        {group.products.map(product => <div className={styles.notice} key={product.id}><DashboardIcon name={product.id === primaryId ? 'check' : 'product'} size={17} /><span><strong>{product.title}</strong><br />{product.platform} · {product.verifiedSource ? 'Nguồn đã xác minh' : 'Nguồn chưa xác minh'} · cập nhật {formatDateTime(product.updatedAt)}</span></div>)}
        <div className={`${styles.formFull} ${styles.buttonRow}`}><Link className={styles.textButton} href={`/dashboard/products/${encodeURIComponent(primaryId)}`}>Xem sản phẩm đã chọn</Link><button type="button" className={styles.secondaryButton} disabled={group.status === 'merged' || Boolean(busy)} onClick={() => void runPreview()}>{busy === 'preview' ? 'Đang tạo preview' : 'Xem trước hợp nhất'}</button></div>
      </div>

      {preview && <div className={styles.panelBody}>
        <div className={styles.notice}><DashboardIcon name="compare" size={18} /><span><strong>Preview không có side effect.</strong> Bản chính sẽ được bổ sung {preview.filledFields.length} field; {preview.conflicts.length} field xung đột vẫn giữ giá trị của bản chính.</span></div>
        <p><strong>Field được bổ sung:</strong> {preview.filledFields.length ? preview.filledFields.join(' · ') : 'Không có'}</p>
        <p><strong>Field xung đột:</strong> {preview.conflicts.length ? preview.conflicts.join(' · ') : 'Không có'}</p>
        <p><strong>Bản phụ sẽ lưu trữ sau phê duyệt:</strong> {preview.secondaryIds.join(' · ')}</p>
        <label className={styles.formField}><span><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Tôi xác nhận tạo tác vụ HIGH; thao tác vẫn phải được phê duyệt riêng.</span></label>
        <div className={styles.buttonRow}><button type="button" className={styles.primaryButton} disabled={!confirmed || Boolean(busy) || Boolean(job)} onClick={() => void applyMerge()}>{busy === 'apply' ? 'Đang tạo tác vụ' : 'Gửi hợp nhất để phê duyệt'}</button></div>
      </div>}

      {group.status !== 'merged' && <div className={styles.formGrid}>
        <label className={`${styles.formField} ${styles.formFull}`}><span>Lý do giữ riêng hoặc bỏ qua *</span><textarea minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ghi rõ khác biệt hoặc lý do nghiệp vụ" /></label>
        <div className={`${styles.formFull} ${styles.buttonRow}`}><button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => void saveReview('review_keep')}>{busy === 'keep' ? 'Đang lưu' : 'Giữ cả hai'}</button><button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => void saveReview('review_ignore')}>{busy === 'ignore' ? 'Đang lưu' : 'Bỏ qua cảnh báo'}</button></div>
      </div>}

      {error && <div className={`${styles.notice} ${styles.noticeWarning}`} role="alert"><DashboardIcon name="warning" size={17} /><span>{error}</span></div>}
      {message && <div className={styles.notice} aria-live="polite"><DashboardIcon name="check" size={17} /><span>{message}{job ? ` Trạng thái: ${job.status}; approval: ${job.approvalStatus}.` : ''}</span></div>}
      {job && <div className={styles.buttonRow}><Link className={styles.secondaryButton} href="/dashboard/queue">Mở hàng chờ phê duyệt</Link></div>}
    </article>
  );
}

export default function QualityPage() {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const resource = useDashboardResource<QualityResponse>(`/api/dashboard/quality?page=${page}&pageSize=${pageSize}`);
  const [query, setQuery] = useState('');
  const [band, setBand] = useState('');
  const data = resource.data;
  const products = useMemo(() => data?.products || data?.items || [], [data]);
  const groups = data?.duplicateGroups || data?.groups || [];
  const visibleProducts = useMemo(() => products.filter((product) => {
    if (band && product.qualityBand !== band) return false;
    if (query && !product.title.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi'))) return false;
    return true;
  }), [band, products, query]);
  const summary = data?.summary;
  const average = summary?.averageQualityScore ?? (products.length
    ? Math.round(products.reduce((total, product) => total + (product.qualityScore || 0), 0) / products.length)
    : null);

  return (
    <main className={styles.page}>
      <DashboardPageHeader
        icon="duplicate"
        eyebrow="Sản phẩm"
        title="Chất lượng và trùng lặp"
        description="Ưu tiên các sản phẩm thiếu dữ liệu và xem nhóm nghi trùng từ kết quả chấm điểm deterministic. Không sản phẩm nào bị tự động xóa hoặc hợp nhất tại đây."
        actions={<button type="button" className={styles.secondaryButton} onClick={resource.reload} disabled={resource.loading}><DashboardIcon name="refresh" size={16} />Làm mới</button>}
        meta={data?.updatedAt ? <>Cập nhật: {formatDateTime(data.updatedAt)}</> : undefined}
      />

      {resource.loading && !data && <DashboardState kind="loading" title="Đang tải chất lượng dữ liệu" />}
      {resource.error && <DashboardState kind="error" description={resource.error} onRetry={resource.reload} />}

      {data && (
        <>
          <section className={styles.metrics} aria-label="Tóm tắt chất lượng">
            <MetricCard icon="product" label="Sản phẩm đã đánh giá" value={summary?.total ?? products.length} help="Dữ liệu backend hiện có" />
            <MetricCard icon="health" label="Quality Score trung bình" value={average ?? 'Chưa có'} tone={average !== null && average >= 70 ? 'success' : average !== null && average < 45 ? 'danger' : 'warning'} help="Không phải điểm đánh giá người dùng" />
            <MetricCard icon="warning" label="Cần bổ sung hoặc bị chặn" value={(summary?.needsData || 0) + (summary?.poor || 0) + (summary?.blocked || 0)} tone="warning" help="Cần xử lý dữ liệu trước" />
            <MetricCard icon="duplicate" label="Nhóm nghi trùng" value={summary?.duplicateGroups ?? groups.length} tone={groups.length ? 'warning' : 'neutral'} help={`${summary?.suspectedDuplicates ?? 0} sản phẩm cần xem xét`} />
          </section>

          <div className={styles.toolbar} aria-label="Bộ lọc chất lượng">
            <label className={`${styles.field} ${styles.fieldGrow}`}><span>Tìm sản phẩm</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nhập tên sản phẩm" /></label>
            <label className={styles.field}><span>Quality band</span><select value={band} onChange={(event) => setBand(event.target.value)}><option value="">Tất cả</option>{Object.entries(BAND_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <button type="button" className={styles.secondaryButton} disabled={!query && !band} onClick={() => { setQuery(''); setBand(''); }}>Xóa bộ lọc</button>
          </div>

          <Panel title="Sản phẩm cần theo dõi" icon="health" description={`${visibleProducts.length} sản phẩm phù hợp bộ lọc hiện tại.`}>
            {visibleProducts.length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title="Không có sản phẩm phù hợp" description={products.length ? 'Hãy xóa hoặc thay đổi bộ lọc.' : 'Chưa có kết quả chấm điểm chất lượng trong storage.'} actionHref={products.length ? undefined : '/dashboard/import'} actionLabel={products.length ? undefined : 'Nhập sản phẩm'} /></div> : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Sản phẩm</th><th>Quality</th><th>Opportunity</th><th>Deal</th><th>Vấn đề dữ liệu</th><th>Hành động</th></tr></thead>
                  <tbody>{visibleProducts.map((product) => (
                    <tr key={product.id}>
                      <td data-label="Sản phẩm"><strong>{product.title}</strong><small>{product.source || 'Chưa rõ nguồn'}{product.platform ? ` · ${product.platform}` : ''}</small></td>
                      <td data-label="Quality"><div className={styles.cardMeta}><span className={styles.score}>{Number.isFinite(product.qualityScore) ? product.qualityScore : '—'}</span><StatusBadge tone={bandTone(product.qualityBand)}>{BAND_LABELS[product.qualityBand || ''] || 'Chưa chấm'}</StatusBadge></div></td>
                      <td data-label="Opportunity"><strong>{Number.isFinite(product.opportunityScore) ? product.opportunityScore : '—'}</strong><small>{product.opportunityBand || 'Chưa chấm'}</small></td>
                      <td data-label="Deal"><strong>{Number.isFinite(product.dealScore) ? product.dealScore : '—'}</strong><small>{product.dealBand || 'Chưa chấm'}</small></td>
                      <td data-label="Vấn đề">{product.dataIssues?.length ? product.dataIssues.slice(0, 3).join(' · ') : 'Không ghi nhận vấn đề'}{product.duplicateConfidence !== undefined && <small>Khả năng trùng: {formatPercent(confidencePercent(product.duplicateConfidence))}</small>}</td>
                      <td data-label="Hành động"><div className={styles.cellActions}><Link className={styles.textButton} href={`/dashboard/products/${encodeURIComponent(product.id)}`}>Xem chi tiết</Link>{product.recommendedActions?.[0] && <small>{product.recommendedActions[0]}</small>}</div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {data.pagination && data.pagination.totalItems > 0 && <div className={styles.panelBody}><nav className={styles.buttonRow} aria-label="Phân trang chất lượng"><button type="button" className={styles.secondaryButton} disabled={data.pagination.page <= 1 || resource.loading} onClick={() => setPage(current => Math.max(1, current - 1))}>Trang trước</button><span className={styles.help}>Trang {data.pagination.page} / {data.pagination.totalPages} · {data.pagination.totalItems} sản phẩm</span><button type="button" className={styles.secondaryButton} disabled={data.pagination.page >= data.pagination.totalPages || resource.loading} onClick={() => setPage(current => current + 1)}>Trang sau</button></nav></div>}
          </Panel>

          <Panel title="Nhóm nghi trùng" icon="duplicate" description="Confidence và tín hiệu chỉ hỗ trợ quyết định; hợp nhất cần preview, queue và approval riêng.">
            {groups.length === 0 ? <div className={styles.panelBody}><DashboardState kind="empty" title="Chưa có nhóm nghi trùng" description="Không có cảnh báo trùng từ lần đánh giá hiện tại." /></div> : (
              <div className={`${styles.cardList} ${styles.paddedList}`}>
                {groups.map(group => <DuplicateGroupReviewCard group={group} key={group.id} onChanged={resource.reload} />)}
              </div>
            )}
          </Panel>
        </>
      )}
    </main>
  );
}
