'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BulkProductActions } from '@/components/dashboard/bulk-product-actions';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import { SavedViewsToolbar } from '@/components/dashboard/saved-views-toolbar';
import { TaskStatus } from '@/components/dashboard/task-status';
import type { DashboardOperation } from '@/lib/dashboard/operations';
import type { DashboardProductItem, DashboardProductsResult } from '@/lib/dashboard/products';
import type { AutomationJob } from '@/lib/automation/types';
import type { SavedView } from '@/lib/product-intelligence/types';
import styles from './products.module.css';

type Envelope<T> = { ok: boolean; code?: string; message: string; data?: T; fields?: Record<string, string> };
type Toast = { type: 'success' | 'error' | 'info'; message: string };
type ViewMode = 'list' | 'grid';
type OperationMode = 'source_scan' | 'full_safe_run';
type ProductActionTracking = { job: SafeAutomationJob; jobId: string; operationId: string; trackingRoute: string };

const PLATFORM_LABELS: Record<string, string> = { shopee: 'Shopee', tiktok_shop: 'TikTok Shop', lazada: 'Lazada', accesstrade: 'AccessTrade', website: 'Website', other: 'Khác' };
const TYPE_LABELS: Record<string, string> = { product: 'Sản phẩm', deal: 'Ưu đãi sản phẩm', voucher: 'Mã giảm giá (voucher)', campaign: 'Chiến dịch', store_offer: 'Ưu đãi cửa hàng', unknown: 'Chưa phân loại' };
const STATUS_LABELS: Record<string, string> = { draft: 'Bản nháp', needs_review: 'Cần xem xét', approved: 'Đã duyệt', published: 'Đã đăng', archived: 'Đã lưu trữ' };
const SAFE_LABELS: Record<string, string> = { qualified: 'Đủ điều kiện', needs_review: 'Chờ phê duyệt', blocked: 'Bị chặn', published: 'Đã đăng', archived: 'Đã lưu trữ' };
const RISK_LABELS: Record<string, string> = { low: 'Rủi ro thấp', medium: 'Rủi ro trung bình', high: 'Rủi ro cao', unknown: 'Chưa đánh giá' };
const FILTER_KEYS = ['q', 'platform', 'status', 'kind', 'safePublishStatus', 'riskLevel', 'sort', 'page', 'pageSize'] as const;
const SAVED_FILTER_KEYS = ['q', 'platform', 'status', 'kind', 'safePublishStatus', 'riskLevel'] as const;
const PRODUCT_COLUMNS = ['title', 'kind', 'source', 'status', 'price', 'riskLevel'];
type SafeAutomationJob = Omit<AutomationJob, 'payload'>;

function toDashboardOperation(job: SafeAutomationJob): DashboardOperation {
  const statuses: Record<AutomationJob['status'], DashboardOperation['status']> = {
    PENDING: 'pending', WAITING_APPROVAL: 'waiting_approval', RUNNING: 'running', RETRY_SCHEDULED: 'waiting_retry',
    WAITING_FOR_MANUAL_INPUT: 'waiting_manual', SUCCEEDED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', BLOCKED: 'blocked', PAUSED: 'pending',
  };
  const status = statuses[job.status];
  const messages: Record<DashboardOperation['status'], string> = {
    pending: 'Tác vụ đang chờ bộ xử lý nền.', waiting_approval: 'Tác vụ rủi ro cao đang chờ quản trị viên phê duyệt.', waiting_manual: 'Tác vụ cần thông tin đã kiểm chứng từ hộp thư công việc thủ công.', running: 'Bộ xử lý nền đang thực hiện tác vụ.',
    waiting_retry: 'Tác vụ đang chờ chạy lại theo giới hạn an toàn.', completed: 'Tác vụ đã hoàn thành.', failed: job.lastErrorMessage || 'Tác vụ không thể hoàn thành.',
    cancelled: 'Tác vụ đã bị hủy.', blocked: job.lastErrorMessage || 'Tác vụ bị quy tắc an toàn chặn.', unavailable: 'Tạm thời chưa thể cập nhật tác vụ.',
  };
  return { operationId: job.operationId, jobId: job.id, status, progress: job.progress?.percentage ?? (status === 'completed' ? 100 : null),
    result: job.result || null, errorCode: job.lastErrorCode || null, message: messages[status], startedAt: job.startedAt || null,
    completedAt: job.completedAt || null, updatedAt: job.updatedAt, canCancel: ['PENDING','WAITING_APPROVAL','WAITING_FOR_MANUAL_INPUT','RETRY_SCHEDULED','PAUSED'].includes(job.status),
    canRetry: job.status === 'FAILED' && job.attemptCount < job.maxAttempts, requiresApproval: job.status === 'WAITING_APPROVAL' };
}

function formatPrice(value: number | null): string {
  return value === null ? 'Chưa có giá' : `${value.toLocaleString('vi-VN')} đ`;
}

function SafeImage({ item }: { item: DashboardProductItem }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  if (!item.image || failedImage === item.image) return <div className={styles.imageFallback} aria-label="Chưa có ảnh">SP</div>;
  // Remote product hosts are dynamic and cannot be safely allow-listed for next/image.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.productImage} src={item.image} alt={`Ảnh ${item.title}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImage(item.image)} />;
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

function ProductActions({ item, busy, onAction }: { item: DashboardProductItem; busy: string | null; onAction: (action: 'approve' | 'archive', item: DashboardProductItem) => void }) {
  const disabled = busy !== null;
  return (
    <div className={styles.rowActions}>
      <Link href={`/dashboard/products/${item.id}`} className={styles.textButton}>Xem chi tiết</Link>
      {item.status !== 'approved' && item.status !== 'published' && item.status !== 'archived' && (
        <button type="button" className={styles.textButton} disabled={disabled || item.safePublishStatus === 'blocked'} title={item.safePublishStatus === 'blocked' ? item.publish.message : 'Tạo yêu cầu Safe Publish'} onClick={() => onAction('approve', item)}>
          {busy === `approve:${item.id}` ? 'Đang tạo' : 'Safe Publish'}
        </button>
      )}
      {item.status !== 'archived' && <button type="button" className={styles.textButton} disabled={disabled} onClick={() => onAction('archive', item)}>{busy === `archive:${item.id}` ? 'Đang tạo' : 'Lưu trữ'}</button>}
    </div>
  );
}

export default function ProductsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const urlSearch = searchParams.get('q') || '';
  const [searchDraft, setSearchDraft] = useState({ base: urlSearch, value: urlSearch });
  const searchInput = searchDraft.base === urlSearch ? searchDraft.value : urlSearch;
  const [data, setData] = useState<DashboardProductsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [operationDialog, setOperationDialog] = useState<OperationMode | null>(null);
  const [limit, setLimit] = useState(10);
  const [dryRun, setDryRun] = useState(true);
  const [operation, setOperation] = useState<DashboardOperation | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [sourceDialog, setSourceDialog] = useState(false);
  const [sourceCount, setSourceCount] = useState(0);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [publicMessage, setPublicMessage] = useState('Đang kiểm tra cấu hình');
  const [accessTradeReady, setAccessTradeReady] = useState<boolean | null>(null);
  const [sourceFields, setSourceFields] = useState<Record<string, string>>({});
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceForm, setSourceForm] = useState({ name: '', url: '', platform: 'website', kind: 'product', enabled: true, scanSchedule: '', description: '' });
  const dialogFocusRef = useRef<HTMLInputElement>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const showToast = useCallback((type: Toast['type'], message: string) => {
    setToast({ type, message });
    window.setTimeout(() => setToast(null), 6000);
  }, []);

  const updateQuery = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(queryString);
    Object.entries(updates).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    if (!Object.prototype.hasOwnProperty.call(updates, 'page')) next.delete('page');
    const nextQuery = next.toString();
    setSelectedIds([]);
    setRefreshing(true);
    router.replace(`/dashboard/products${nextQuery ? `?${nextQuery}` : ''}`, { scroll: false });
  }, [queryString, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = searchParams.get('q') || '';
      if (searchInput.trim() !== current) updateQuery({ q: searchInput.trim() || null });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchParams, updateQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem('sandeal-products-view');
        if (stored === 'grid' || stored === 'list') setViewMode(stored);
      } catch { /* Storage can be unavailable in private browser contexts. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const selectView = (mode: ViewMode) => {
    setViewMode(mode);
    try { window.localStorage.setItem('sandeal-products-view', mode); } catch { /* Keep in-memory selection. */ }
  };

  const applySavedView = (view: Pick<SavedView, 'filters' | 'sort' | 'columns' | 'viewMode'>) => {
    const next = new URLSearchParams();
    for (const key of SAVED_FILTER_KEYS) {
      const value = view.filters[key];
      if (value !== undefined && value !== '') next.set(key, String(value));
    }
    if (view.sort) next.set('sort', view.sort);
    const nextSearch = next.get('q') || '';
    setSearchDraft({ base: nextSearch, value: nextSearch });
    if (view.viewMode === 'list' || view.viewMode === 'grid') selectView(view.viewMode);
    setSelectedIds([]);
    setRefreshing(true);
    const nextQuery = next.toString();
    router.replace(`/dashboard/products${nextQuery ? `?${nextQuery}` : ''}`, { scroll: false });
  };

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    FILTER_KEYS.forEach((key) => { const value = searchParams.get(key); if (value) params.set(key, value); });
    void fetch(`/api/dashboard/products?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as Envelope<DashboardProductsResult> | null;
        if (!response.ok || !body?.ok || !body.data) throw { code: body?.code || 'UNAVAILABLE', message: body?.message || 'Không thể tải kết quả bot.' };
        setData(body.data);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const issue = reason as { code?: string; message?: string };
        setError({ code: issue.code || 'UNAVAILABLE', message: issue.message || 'Không thể tải kết quả bot. Dữ liệu hiện tại không bị thay đổi. Vui lòng thử lại.' });
      })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); } });
    return () => controller.abort();
  // queryString is the stable URL dependency; searchParams itself changes identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString, refreshKey]);

  const loadConnections = useCallback(async () => {
    const [sourceResponse, configResponse, healthResponse] = await Promise.all([
      fetch('/api/product-sources', { cache: 'no-store' }),
      fetch('/api/dashboard/config', { cache: 'no-store' }),
      fetch('/api/app-health', { cache: 'no-store' }),
    ]);
    const sourceBody = await sourceResponse.json().catch(() => null) as Envelope<unknown[]> | null;
    const configBody = await configResponse.json().catch(() => null) as Envelope<{ publicUrl: string | null }> | null;
    const healthBody = await healthResponse.json().catch(() => null) as Envelope<{ integrations?: { accesstrade?: { configured?: boolean } } }> | null;
    setSourceCount(Array.isArray(sourceBody?.data) ? sourceBody.data.length : 0);
    setPublicUrl(configBody?.data?.publicUrl || null);
    setPublicMessage(configBody?.message || 'Chưa thiết lập địa chỉ trang công khai.');
    setAccessTradeReady(Boolean(healthBody?.data?.integrations?.accesstrade?.configured));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConnections().catch(() => { setAccessTradeReady(false); setPublicMessage('Tạm thời chưa thể kiểm tra cấu hình.'); });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConnections]);
  useEffect(() => {
    if (!operationDialog && !sourceDialog) return;
    const timer = window.setTimeout(() => dialogFocusRef.current?.focus(), 0);
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !operationBusy && !sourceBusy && !busy) { setOperationDialog(null); setSourceDialog(false); } };
    window.addEventListener('keydown', close);
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', close); };
  }, [operationDialog, sourceDialog, operationBusy, sourceBusy, busy]);
  useEffect(() => () => pollAbortRef.current?.abort(), []);

  const refresh = () => { setError(null); setSelectedIds([]); setRefreshing(true); setRefreshKey((value) => value + 1); };

  const runItemAction = async (action: 'approve' | 'archive', item: DashboardProductItem) => {
    setBusy(`${action}:${item.id}`);
    const endpoint = `/api/products/${item.id}/${action}`;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          reason: action === 'approve' ? 'Yêu cầu Safe Publish từ Product Operations' : 'Lưu trữ từ Product Operations',
        }),
      });
      const body = await response.json().catch(() => null) as Envelope<ProductActionTracking> | null;
      if (!response.ok || !body?.ok || !body.data?.job) throw new Error(body?.message || 'Không thể tạo tác vụ. Dữ liệu chưa được thay đổi. Vui lòng thử lại.');
      const next = toDashboardOperation(body.data.job);
      setOperation(next);
      showToast('info', body.message);
      refresh();
      if (!['waiting_approval', 'waiting_manual', 'completed', 'failed', 'cancelled', 'blocked'].includes(next.status)) {
        void pollOperation(body.data.jobId).catch((reason) => setOperation((current) => current ? {
          ...current,
          errorCode: 'STATUS_UNAVAILABLE',
          message: reason instanceof Error ? reason.message : 'Tạm thời không thể cập nhật trạng thái tác vụ.',
        } : current));
      }
    } catch (reason) { showToast('error', reason instanceof Error ? reason.message : 'Không thể thực hiện thao tác. Dữ liệu chưa được thay đổi. Vui lòng thử lại.'); }
    finally { setBusy(null); }
  };

  const pollOperation = async (jobId: string) => {
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    for (let attempt = 0; attempt < 45 && !controller.signal.aborted; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const response = await fetch(`/api/automation/jobs/${jobId}`, { cache: 'no-store', signal: controller.signal });
      const body = await response.json().catch(() => null) as Envelope<SafeAutomationJob> | null;
      if (!response.ok || !body?.data) throw new Error(body?.message || 'Không thể cập nhật trạng thái tác vụ.');
      const next = toDashboardOperation(body.data);
      setOperation(next);
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(next.status)) { if (next.status === 'completed') refresh(); return; }
    }
    if (!controller.signal.aborted) setOperation((current) => current ? { ...current, message: 'Tác vụ vẫn đang xử lý. Việc theo dõi tự động đã dừng sau thời gian giới hạn; dữ liệu không bị thay đổi bởi thao tác theo dõi.' } : current);
  };

  const submitOperation = async () => {
    if (!operationDialog || operationBusy) return;
    setOperationBusy(true);
    try {
      const operationId = crypto.randomUUID();
      const response = await fetch('/api/automation/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        type: operationDialog === 'source_scan' ? 'PRODUCT_SCAN' : 'AUTO_PILOT', dryRun, operationId,
        idempotencyKey: `${operationDialog}:${dryRun ? 'preview' : 'controlled'}:${operationId}`, payload: { limit },
      }) });
      const body = await response.json().catch(() => null) as Envelope<SafeAutomationJob> | null;
      if (!response.ok || !body?.ok || !body.data) throw new Error(body?.message || 'Không thể tạo tác vụ. Dữ liệu chưa được thay đổi.');
      setOperation(toDashboardOperation(body.data)); setOperationDialog(null); showToast('success', body.message);
      if (dryRun) void pollOperation(body.data.id).catch((reason) => setOperation((current) => current ? { ...current, errorCode: 'STATUS_UNAVAILABLE', message: reason instanceof Error ? reason.message : 'Tạm thời không thể cập nhật trạng thái tác vụ.' } : current));
    } catch (reason) { showToast('error', reason instanceof Error ? reason.message : 'Không thể thực hiện tác vụ. Dữ liệu hiện tại không bị thay đổi.'); }
    finally { setOperationBusy(false); }
  };

  const submitSource = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sourceBusy) return;
    setSourceBusy(true); setSourceFields({});
    try {
      const response = await fetch('/api/product-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sourceForm) });
      const body = await response.json().catch(() => null) as Envelope<unknown> | null;
      if (!response.ok || !body?.ok) { setSourceFields(body?.fields || {}); throw new Error(body?.message || 'Không thể lưu nguồn. Dữ liệu chưa được thay đổi.'); }
      showToast('success', body.message); setSourceDialog(false);
      setSourceForm({ name: '', url: '', platform: 'website', kind: 'product', enabled: true, scanSchedule: '', description: '' });
      await loadConnections();
    } catch (reason) { showToast('error', reason instanceof Error ? reason.message : 'Không thể lưu nguồn. Dữ liệu chưa được thay đổi.'); }
    finally { setSourceBusy(false); }
  };

  const clearFilters = () => { setSearchDraft({ base: '', value: '' }); setError(null); setRefreshing(true); router.replace('/dashboard/products', { scroll: false }); };
  const openPublic = () => {
    if (!publicUrl) { showToast('info', `${publicMessage} Dữ liệu hiện tại không bị thay đổi. Vui lòng thiết lập địa chỉ trang công khai trong cấu hình phát hành.`); return; }
    window.open(publicUrl, '_blank', 'noopener,noreferrer');
  };
  const summary = data?.summary;
  const page = data?.pagination.page || 1;
  const totalPages = data?.pagination.totalPages || 1;
  const activeFilterCount = FILTER_KEYS.filter((key) => !['sort', 'page', 'pageSize'].includes(key) && Boolean(searchParams.get(key))).length;
  const activeFilters = activeFilterCount > 0;
  const setFilter = (key: string, value: string) => updateQuery({ [key]: value || null });
  const savedViewFilters = Object.fromEntries(SAVED_FILTER_KEYS.flatMap((key) => {
    const value = searchParams.get(key);
    return value ? [[key, value]] : [];
  })) as Record<string, string>;
  const visibleIds = data?.items.map((item) => item.id) || [];
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const toggleSelection = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const toggleVisibleSelection = () => setSelectedIds(allVisibleSelected ? [] : visibleIds);

  return (
    <div className={styles.productsPage} aria-busy={loading || refreshing}>
      {toast && <div className={`${styles.toast} ${styles[toast.type]}`} role="status">{toast.message}</div>}

      <header className={styles.pageHeader}>
        <div className={styles.headerLead}>
          <span className={styles.pageIcon}><DashboardIcon name="product" size={24} /></span>
          <div>
            <div className={styles.headerMeta}><Badge tone={accessTradeReady ? 'success' : 'warning'}>{accessTradeReady === null ? 'Đang kiểm tra kết nối' : accessTradeReady ? 'Nguồn dữ liệu đã kết nối' : 'Cần thiết lập kết nối'}</Badge><span>Cập nhật gần nhất: {data ? new Date(data.updatedAt).toLocaleString('vi-VN') : 'Chưa có'}</span></div>
            <h1>Kết quả bot</h1>
            <p>Theo dõi sản phẩm đã quét, kết quả kiểm tra an toàn và trạng thái đăng từ dữ liệu backend hiện tại.</p>
          </div>
        </div>
        <button type="button" className={styles.primaryButton} onClick={() => { setDryRun(true); setOperationDialog('source_scan'); }}><DashboardIcon name="product" size={16} />Quét và kiểm tra sản phẩm</button>
      </header>

      <div className={styles.actionBar}>
        <button type="button" className={styles.secondaryButton} onClick={() => { setDryRun(true); setOperationDialog('full_safe_run'); }}><DashboardIcon name="ai" size={16} />Chạy chế độ tự động</button>
        <button type="button" className={styles.secondaryButton} onClick={() => setSourceDialog(true)}><DashboardIcon name="source" size={16} />Thêm nguồn sản phẩm</button>
        <button type="button" className={styles.ghostButton} onClick={openPublic}><DashboardIcon name="external" size={16} />Xem trang công khai</button>
        <button type="button" className={styles.ghostButton} onClick={refresh} disabled={refreshing}><DashboardIcon name="refresh" size={16} />{refreshing ? 'Đang làm mới' : 'Làm mới'}</button>
        <span className={styles.sourceCount}>{sourceCount} nguồn đã lưu</span>
      </div>

      {operation && <TaskStatus operation={operation} />}
      <section className={styles.noticeBand} aria-label="Chế độ vận hành">
        <div><span className={styles.noticeIcon}><DashboardIcon name="security" size={18} /></span><span><strong>Chế độ an toàn</strong><small>Luôn bật</small></span></div>
        <div><span className={styles.noticeIcon}><DashboardIcon name="lock" size={18} /></span><span><strong>Chỉ dùng dịch vụ miễn phí</strong><small>Đang áp dụng</small></span></div>
        <div><span className={styles.noticeIcon}><DashboardIcon name="ai" size={18} /></span><span><strong>Chế độ tự động</strong><small>Bot xử lý có giới hạn</small></span></div>
        <div><span className={styles.noticeIcon}><DashboardIcon name="check" size={18} /></span><span><strong>Đăng an toàn</strong><small>Không vượt quy tắc chặn</small></span></div>
      </section>

      {loading && <div className={styles.pageSkeleton} aria-label="Đang tải"><span /><span /><span /></div>}
      {!loading && error && <section className={styles.errorState} role="alert"><h2>Không thể tải kết quả bot</h2><p>{error.message}</p><p>Dữ liệu hiện tại không bị thay đổi. Vui lòng kiểm tra kết nối rồi thử lại.</p><button type="button" className={styles.secondaryButton} onClick={refresh}>Thử lại</button><details><summary>Chi tiết kỹ thuật</summary><code>{error.code}</code></details></section>}

      {!loading && !error && summary && (
        <>
          <section className={styles.primaryMetrics} aria-label="Tổng quan">
            <article className={styles.metricIndigo}><span className={styles.metricLabel}><i><DashboardIcon name="product" size={20} /></i>Tổng sản phẩm</span><strong>{summary.totalItems}</strong></article>
            <article className={styles.metricGreen}><span className={styles.metricLabel}><i><DashboardIcon name="check" size={20} /></i>Đủ điều kiện</span><strong>{summary.qualifiedForPublish}</strong></article>
            <article className={styles.metricAmber}><span className={styles.metricLabel}><i><DashboardIcon name="approval" size={20} /></i>Cần xem xét</span><strong>{summary.needsReview}</strong></article>
            <article className={styles.metricRed}><span className={styles.metricLabel}><i><DashboardIcon name="warning" size={20} /></i>Bị chặn hoặc có lỗi</span><strong>{summary.blocked + summary.brokenLinks + summary.brokenImages}</strong></article>
          </section>
          <section className={styles.detailMetrics}>
            <div className={styles.categoryPanel}><h2><DashboardIcon name="product" size={18} />Phân loại dữ liệu</h2><dl><div><dt>Sản phẩm thật</dt><dd>{summary.realProducts}</dd></div><div><dt>Ưu đãi cửa hàng</dt><dd>{summary.shopOffers}</dd></div><div><dt>Mã giảm giá (voucher)</dt><dd>{summary.vouchers}</dd></div><div><dt>Chiến dịch</dt><dd>{summary.campaigns}</dd></div><div><dt>Không phải sản phẩm</dt><dd>{summary.rejectedItems}</dd></div></dl></div>
            <div className={styles.publishPanel}><h2><DashboardIcon name="external" size={18} />Quy trình đăng</h2><dl><div><dt>Ứng viên đăng</dt><dd>{summary.publishCandidates}</dd></div><div><dt>Đang đăng</dt><dd>0</dd></div><div><dt>Đã đăng</dt><dd>{summary.published}</dd></div><div><dt>Bị chặn</dt><dd>{summary.blocked}</dd></div></dl></div>
            <div className={styles.qualityPanel}><h2><DashboardIcon name="health" size={18} />Chất lượng dữ liệu</h2><dl><div><dt>Liên kết lỗi</dt><dd>{summary.brokenLinks}</dd></div><div><dt>Ảnh lỗi</dt><dd>{summary.brokenImages}</dd></div><div><dt>Thiếu giá</dt><dd>{summary.missingPrice}</dd></div><div><dt>Đã lưu trữ</dt><dd>{summary.archived}</dd></div></dl></div>
          </section>
        </>
      )}

      {!loading && !error && <section className={styles.resultsSection}>
        <div className={styles.resultsHeader}><div><h2><DashboardIcon name="filter" size={18} />Bộ lọc và kết quả {activeFilterCount > 0 && <span className={styles.filterCount}>{activeFilterCount} đang áp dụng</span>}</h2><p>{data?.pagination.totalItems || 0} kết quả phù hợp</p></div><div className={styles.viewToggle} aria-label="Kiểu hiển thị"><button type="button" aria-pressed={viewMode === 'list'} onClick={() => selectView('list')}><DashboardIcon name="list" size={16} />Danh sách</button><button type="button" aria-pressed={viewMode === 'grid'} onClick={() => selectView('grid')}><DashboardIcon name="grid" size={16} />Dạng lưới</button></div></div>
        <div className={styles.filters}>
          <div className={styles.commonFilters}>
            <label className={styles.searchField}><span>Tìm kiếm</span><input value={searchInput} onChange={(event) => setSearchDraft({ base: urlSearch, value: event.target.value })} placeholder="Tên, nguồn hoặc nền tảng" /></label>
            <label><span>Nền tảng</span><select value={searchParams.get('platform') || ''} onChange={(e) => setFilter('platform', e.target.value)}><option value="">Tất cả</option>{Object.entries(PLATFORM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>Trạng thái</span><select value={searchParams.get('status') || ''} onChange={(e) => setFilter('status', e.target.value)}><option value="">Tất cả</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>Loại dữ liệu</span><select value={searchParams.get('kind') || ''} onChange={(e) => setFilter('kind', e.target.value)}><option value="">Tất cả</option>{Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button type="button" className={styles.clearButton} onClick={clearFilters} disabled={!activeFilters}>Xóa bộ lọc</button>
          </div>
          <details className={styles.advancedFilters}>
            <summary><DashboardIcon name="filter" size={16} />Bộ lọc nâng cao</summary>
            <div className={styles.advancedGrid}>
              <label><span>Đăng an toàn</span><select value={searchParams.get('safePublishStatus') || ''} onChange={(e) => setFilter('safePublishStatus', e.target.value)}><option value="">Tất cả</option>{Object.entries(SAFE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>Mức rủi ro</span><select value={searchParams.get('riskLevel') || ''} onChange={(e) => setFilter('riskLevel', e.target.value)}><option value="">Tất cả</option>{Object.entries(RISK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>Sắp xếp</span><select value={searchParams.get('sort') || 'updated_desc'} onChange={(e) => setFilter('sort', e.target.value)}><option value="updated_desc">Mới cập nhật</option><option value="created_desc">Mới tạo</option><option value="created_asc">Tạo lâu nhất</option><option value="title_asc">Tên A-Z</option><option value="price_desc">Giá cao nhất</option></select></label>
              <label><span>Mỗi trang</span><select value={searchParams.get('pageSize') || '20'} onChange={(e) => setFilter('pageSize', e.target.value)}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label>
            </div>
          </details>
        </div>

        <SavedViewsToolbar
          page="products"
          filters={savedViewFilters}
          sort={searchParams.get('sort') || 'updated_desc'}
          columns={PRODUCT_COLUMNS}
          viewMode={viewMode}
          onApply={applySavedView}
        />

        {visibleIds.length > 0 && <div className={styles.selectionToolbar}>
          <label><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisibleSelection} /><span>Chọn toàn bộ {visibleIds.length} sản phẩm trên trang</span></label>
          <span>{selectedIds.length ? `${selectedIds.length} sản phẩm đã chọn` : 'Chưa chọn sản phẩm'}</span>
        </div>}
        <BulkProductActions productIds={selectedIds} onClear={() => setSelectedIds([])} />

        {data && data.items.length === 0 ? <div className={styles.emptyState}><span className={styles.emptyIcon}><DashboardIcon name="product" size={24} /></span><h3>{activeFilters ? 'Không tìm thấy kết quả' : 'Chưa có sản phẩm'}</h3><p>{activeFilters ? 'Không có sản phẩm phù hợp với bộ lọc hiện tại.' : 'Thêm nguồn sản phẩm hoặc tạo tác vụ chạy thử an toàn để bắt đầu kiểm tra dữ liệu.'}</p>{activeFilters ? <button type="button" className={styles.secondaryButton} onClick={clearFilters}>Xóa bộ lọc</button> : <div className={styles.emptyActions}><button type="button" className={styles.secondaryButton} onClick={() => setSourceDialog(true)}><DashboardIcon name="source" size={16} />Thêm nguồn sản phẩm</button><button type="button" className={styles.ghostButton} onClick={() => { setDryRun(true); setOperationDialog('source_scan'); }}><DashboardIcon name="task" size={16} />Chạy thử an toàn</button></div>}</div> : (
          viewMode === 'list' ? <div className={styles.tableWrap}><table><thead><tr><th>Chọn</th><th>Sản phẩm</th><th>Loại và nguồn</th><th>Trạng thái</th><th>Giá</th><th>Rủi ro</th><th>Thao tác</th></tr></thead><tbody>{data?.items.map((item) => <tr key={item.id}><td className={styles.selectionCell}><input type="checkbox" aria-label={`Chọn ${item.title}`} checked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} /></td><td><div className={styles.productCell}><SafeImage item={item} /><div><Link href={`/dashboard/products/${item.id}`}>{item.title}</Link><small>{item.publish.message}</small></div></div></td><td><Badge>{TYPE_LABELS[item.type]}</Badge><small>{PLATFORM_LABELS[item.platform]} · {item.source}</small></td><td><Badge tone={item.safePublishStatus === 'published' || item.safePublishStatus === 'qualified' ? 'success' : item.safePublishStatus === 'blocked' ? 'danger' : 'warning'}>{SAFE_LABELS[item.safePublishStatus]}</Badge><small>{STATUS_LABELS[item.status]}</small></td><td>{formatPrice(item.price)}</td><td><Badge tone={item.riskLevel === 'high' ? 'danger' : item.riskLevel === 'medium' ? 'warning' : item.riskLevel === 'low' ? 'success' : 'neutral'}>{RISK_LABELS[item.riskLevel]}</Badge></td><td><ProductActions item={item} busy={busy} onAction={runItemAction} /></td></tr>)}</tbody></table></div>
          : <div className={styles.productGrid}>{data?.items.map((item) => <article key={item.id} className={styles.productCard}><SafeImage item={item} /><div className={styles.productCardBody}><label className={styles.cardSelect}><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} /><span>Chọn sản phẩm</span></label><div className={styles.cardBadges}><Badge>{TYPE_LABELS[item.type]}</Badge><Badge tone={item.safePublishStatus === 'published' || item.safePublishStatus === 'qualified' ? 'success' : item.safePublishStatus === 'blocked' ? 'danger' : 'warning'}>{SAFE_LABELS[item.safePublishStatus]}</Badge></div><Link href={`/dashboard/products/${item.id}`} className={styles.cardTitle}>{item.title}</Link><p>{item.publish.message}</p><strong>{formatPrice(item.price)}</strong><ProductActions item={item} busy={busy} onAction={runItemAction} /></div></article>)}</div>
        )}
        {data && data.pagination.totalItems > 0 && <nav className={styles.pagination} aria-label="Phân trang"><button type="button" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1) })}>Trang trước</button><span>Trang {page} / {totalPages}</span><button type="button" disabled={page >= totalPages} onClick={() => updateQuery({ page: String(page + 1) })}>Trang sau</button></nav>}
      </section>}

      {operationDialog && <div className={styles.modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target && !operationBusy) setOperationDialog(null); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="operation-title"><h2 id="operation-title">{operationDialog === 'source_scan' ? 'Quét và kiểm tra sản phẩm' : 'Chạy chế độ tự động'}</h2><p>{operationDialog === 'source_scan' ? 'Hệ thống sẽ kiểm tra sản phẩm, đánh giá độ an toàn và đưa sản phẩm đủ điều kiện vào hàng chờ.' : 'Bot sẽ xử lý số lượng giới hạn trong chế độ an toàn.'}</p><label><span>Số lượng giới hạn</span><input ref={dialogFocusRef} type="number" min={1} max={30} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} /></label><label className={styles.checkbox}><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /><span>Chạy thử an toàn, không thay đổi dữ liệu</span></label>{!dryRun && <div className={styles.warningBox}>Tác vụ có thể thay đổi dữ liệu nên sẽ chuyển sang Hàng chờ phê duyệt. Quy tắc đăng an toàn vẫn chặn sản phẩm không đủ điều kiện.</div>}<div className={styles.modalNote}>Tác vụ được lưu bền vững và do bộ xử lý nền thực hiện. Tác vụ không chạy khi dừng khẩn cấp đang bật.</div><div className={styles.modalActions}><button type="button" className={styles.ghostButton} disabled={operationBusy} onClick={() => setOperationDialog(null)}>Đóng</button><button type="button" className={styles.primaryButton} disabled={operationBusy} onClick={() => void submitOperation()}>{operationBusy ? 'Đang gửi' : dryRun ? 'Bắt đầu chạy thử' : 'Gửi để phê duyệt'}</button></div></section></div>}

      {sourceDialog && <div className={styles.modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target && !sourceBusy) setSourceDialog(false); }}><form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="source-title" onSubmit={submitSource}><h2 id="source-title">Thêm nguồn sản phẩm</h2><div className={styles.formGrid}><label><span>Tên nguồn</span><input ref={dialogFocusRef} value={sourceForm.name} onChange={(e) => setSourceForm({ ...sourceForm, name: e.target.value })} aria-invalid={Boolean(sourceFields.name)} aria-describedby={sourceFields.name ? 'source-name-error' : undefined} />{sourceFields.name && <small id="source-name-error" className={styles.fieldError}>{sourceFields.name}</small>}</label><label><span>Địa chỉ nguồn</span><input type="url" placeholder="https://" value={sourceForm.url} onChange={(e) => setSourceForm({ ...sourceForm, url: e.target.value })} aria-invalid={Boolean(sourceFields.url)} aria-describedby={sourceFields.url ? 'source-url-error' : undefined} />{sourceFields.url && <small id="source-url-error" className={styles.fieldError}>{sourceFields.url}</small>}</label><label><span>Nền tảng</span><select value={sourceForm.platform} onChange={(e) => setSourceForm({ ...sourceForm, platform: e.target.value })}>{Object.entries(PLATFORM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Loại dữ liệu</span><select value={sourceForm.kind} onChange={(e) => setSourceForm({ ...sourceForm, kind: e.target.value })}>{Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Lịch quét (không bắt buộc)</span><input value={sourceForm.scanSchedule} onChange={(e) => setSourceForm({ ...sourceForm, scanSchedule: e.target.value })} placeholder="Ví dụ: mỗi ngày lúc 08:00" /></label><label className={styles.fullField}><span>Mô tả</span><textarea rows={3} value={sourceForm.description} onChange={(e) => setSourceForm({ ...sourceForm, description: e.target.value })} /></label></div><label className={styles.checkbox}><input type="checkbox" checked={sourceForm.enabled} onChange={(e) => setSourceForm({ ...sourceForm, enabled: e.target.checked })} /><span>Bật nguồn sau khi lưu</span></label><p className={styles.modalNote}>Không nhập khóa kết nối hoặc thông tin đăng nhập vào các trường này. Thông tin nhạy cảm phải được lưu trong Kết nối bảo mật.</p><div className={styles.modalActions}><button type="button" className={styles.ghostButton} disabled={sourceBusy} onClick={() => setSourceDialog(false)}>Đóng</button><button type="submit" className={styles.primaryButton} disabled={sourceBusy}>{sourceBusy ? 'Đang lưu' : 'Lưu nguồn'}</button></div></form></div>}

    </div>
  );
}
