'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DashboardIcon } from '@/components/dashboard/dashboard-icon';
import type { AffiliateLinkAdminDto, AffiliateLinkStatus } from '@/lib/product-intelligence/affiliateLinks';
import styles from './affiliate-links.module.css';

type LinkResponse = {
  items: AffiliateLinkAdminDto[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  summary: Record<AffiliateLinkStatus | 'total', number>;
  providers: string[];
};

const STATUS_LABELS: Record<AffiliateLinkStatus, string> = {
  healthy: 'Đã xác minh',
  warning: 'Cần chú ý',
  broken: 'Link lỗi',
  unchecked: 'Chưa kiểm tra',
  unsafe: 'Không an toàn',
};

function displayUrl(value?: string) {
  if (!value) return 'Chưa có';
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  } catch {
    return 'Không hợp lệ';
  }
}

export default function AffiliateLinksPage() {
  const [draftQuery, setDraftQuery] = useState('');
  const [draftProvider, setDraftProvider] = useState('');
  const [draftStatus, setDraftStatus] = useState('');
  const [filters, setFilters] = useState({ q: '', provider: '', status: '' });
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<LinkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20', sort: 'status' });
    if (filters.q) params.set('q', filters.q);
    if (filters.provider) params.set('provider', filters.provider);
    if (filters.status) params.set('status', filters.status);
    return `/api/dashboard/affiliate-links?${params.toString()}`;
  }, [filters, page]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError('');
      fetch(queryUrl, { cache: 'no-store', signal: controller.signal })
        .then(async response => {
          const body = await response.json() as { ok?: boolean; message?: string; data?: LinkResponse };
          if (!response.ok || body.ok === false || !body.data) throw new Error(body.message || 'Không thể tải link tiếp thị liên kết.');
          return body.data;
        })
        .then(next => {
          setData(next);
          setSelected(current => new Set([...current].filter(id => next.items.some(item => item.productId === id))));
        })
        .catch(issue => {
          if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : 'Không thể tải link tiếp thị liên kết.');
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [queryUrl, reload]);

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setSelected(new Set());
    setFilters({ q: draftQuery.trim(), provider: draftProvider, status: draftStatus });
  };

  const clearFilters = () => {
    setDraftQuery(''); setDraftProvider(''); setDraftStatus(''); setFilters({ q: '', provider: '', status: '' }); setPage(1); setSelected(new Set());
  };

  const queueRecheck = async (productIds: string[]) => {
    if (!productIds.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/dashboard/affiliate-links', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recheck', productIds }),
      });
      const body = await response.json() as { ok?: boolean; code?: string; message?: string; data?: { operationId: string; accepted: string[]; skipped: unknown[] } };
      if (!response.ok || body.ok === false || !body.data) throw new Error(body.message || 'Không thể tạo tác vụ kiểm tra link.');
      setNotice(`Đã đưa ${body.data.accepted.length} link vào hàng chờ. Operation ID: ${body.data.operationId}`);
      setSelected(new Set());
      setReload(value => value + 1);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Không thể tạo tác vụ kiểm tra link.');
    } finally {
      setBusy(false);
    }
  };

  const pageIds = data?.items.map(item => item.productId) || [];
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selected.has(id));

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.headerIcon}><DashboardIcon name="external" size={25} /></span>
        <div>
          <span className={styles.eyebrow}>Hiệu quả tăng trưởng</span>
          <h1>Link tiếp thị liên kết</h1>
          <p>Kiểm tra URL, trạng thái health và tracking từ dữ liệu sản phẩm thật. HTTP request chỉ tạo job bền vững; worker mới thực hiện kiểm tra mạng.</p>
        </div>
        <button className={styles.secondaryButton} type="button" onClick={() => setReload(value => value + 1)} disabled={loading}>
          <DashboardIcon name="refresh" size={16} /> Làm mới
        </button>
      </header>

      {data && (
        <section className={styles.metrics} aria-label="Tóm tắt link tiếp thị liên kết">
          <article><span>Tổng link sản phẩm</span><strong>{data.summary.total}</strong></article>
          <article data-tone="success"><span>Đã xác minh</span><strong>{data.summary.healthy}</strong></article>
          <article data-tone="warning"><span>Cần chú ý</span><strong>{data.summary.warning + data.summary.unchecked}</strong></article>
          <article data-tone="danger"><span>Lỗi / không an toàn</span><strong>{data.summary.broken + data.summary.unsafe}</strong></article>
        </section>
      )}

      <form className={styles.filters} onSubmit={applyFilters}>
        <label><span>Tìm kiếm</span><input value={draftQuery} onChange={event => setDraftQuery(event.target.value)} maxLength={120} placeholder="Tên, mã sản phẩm, campaign" /></label>
        <label><span>Provider</span><select value={draftProvider} onChange={event => setDraftProvider(event.target.value)}><option value="">Tất cả provider</option>{(data?.providers || []).map(provider => <option key={provider} value={provider}>{provider}</option>)}</select></label>
        <label><span>Trạng thái</span><select value={draftStatus} onChange={event => setDraftStatus(event.target.value)}><option value="">Tất cả trạng thái</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className={styles.filterActions}><button className={styles.primaryButton} type="submit"><DashboardIcon name="filter" size={16} /> Áp dụng</button><button className={styles.textButton} type="button" onClick={clearFilters} disabled={!filters.q && !filters.provider && !filters.status}>Xóa lọc</button></div>
      </form>

      <div className={styles.bulkBar}>
        <label><input type="checkbox" checked={allPageSelected} onChange={event => setSelected(event.target.checked ? new Set(pageIds) : new Set())} aria-label="Chọn tất cả link trên trang" /> Chọn trang hiện tại</label>
        <span aria-live="polite">Đã chọn {selected.size} link</span>
        <button className={styles.primaryButton} type="button" disabled={busy || selected.size === 0} onClick={() => void queueRecheck([...selected])}><DashboardIcon name="queue" size={16} /> {busy ? 'Đang tạo job…' : 'Đưa vào hàng chờ kiểm tra'}</button>
      </div>

      {notice && <div className={styles.notice} role="status"><DashboardIcon name="check" size={18} /><span>{notice}</span></div>}
      {error && <div className={styles.error} role="alert"><DashboardIcon name="warning" size={18} /><span>{error}</span></div>}
      {loading && !data && <div className={styles.loading} aria-busy="true" aria-label="Đang tải link"><span /><span /><span /></div>}

      {!loading && data?.items.length === 0 && <section className={styles.empty}><DashboardIcon name="search" size={28} /><h2>Không có link phù hợp</h2><p>Hãy xóa bộ lọc hoặc bổ sung URL trong dữ liệu sản phẩm.</p><Link href="/dashboard/products">Mở danh sách sản phẩm</Link></section>}

      {data && data.items.length > 0 && (
        <section className={styles.list} aria-label="Danh sách link tiếp thị liên kết">
          {data.items.map(item => (
            <article className={styles.card} key={item.productId}>
              <div className={styles.cardSelect}><input type="checkbox" checked={selected.has(item.productId)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(item.productId); else next.delete(item.productId); return next; })} aria-label={`Chọn ${item.title}`} /></div>
              <div className={styles.cardMain}>
                <div className={styles.cardHeading}><div><h2>{item.title}</h2><p>{item.provider}{item.campaign ? ` · ${item.campaign}` : ''}</p></div><span className={styles.status} data-status={item.status}>{STATUS_LABELS[item.status]}</span></div>
                <dl className={styles.linkDetails}>
                  <div><dt>URL nguồn</dt><dd title={item.originalUrl}>{displayUrl(item.originalUrl)}</dd></div>
                  <div><dt>Affiliate URL</dt><dd title={item.affiliateUrl}>{displayUrl(item.affiliateUrl)}</dd></div>
                  <div><dt>Canonical</dt><dd title={item.canonicalUrl}>{displayUrl(item.canonicalUrl)}</dd></div>
                  <div><dt>Đích redirect dự kiến</dt><dd title={item.redirectTarget}>{displayUrl(item.redirectTarget)}</dd></div>
                  <div><dt>Tracking</dt><dd>{item.trackingParameters.length ? item.trackingParameters.join(', ') : 'Chưa phát hiện'}{item.trackingCode ? ` · ${item.trackingCode}` : ''}</dd></div>
                  <div><dt>Kiểm tra gần nhất</dt><dd>{item.lastCheckedAt ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.lastCheckedAt)) : 'Chưa có dữ liệu'}</dd></div>
                </dl>
                {item.warnings.length > 0 && <ul className={styles.warnings}>{item.warnings.map(warning => <li key={warning}><DashboardIcon name="warning" size={14} />{warning}</li>)}</ul>}
              </div>
              <div className={styles.cardActions}><Link href={`/dashboard/products/${encodeURIComponent(item.productId)}`}>Xem sản phẩm</Link><button type="button" disabled={busy || !item.affiliateUrl} onClick={() => void queueRecheck([item.productId])}>Kiểm tra lại</button></div>
            </article>
          ))}
        </section>
      )}

      {data && data.pagination.totalPages > 1 && <nav className={styles.pagination} aria-label="Phân trang link"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))}>Trang trước</button><span>Trang {data.pagination.page} / {data.pagination.totalPages} · {data.pagination.totalItems} kết quả</span><button type="button" disabled={page >= data.pagination.totalPages || loading} onClick={() => setPage(value => value + 1)}>Trang sau</button></nav>}
    </main>
  );
}
