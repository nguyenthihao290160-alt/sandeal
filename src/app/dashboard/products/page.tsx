'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Product, ProductKind } from '@/lib/types';
import { classifyProductKind, looksLikeVoucherOrCampaign } from '@/lib/sourceItemClassifier';

type Toast = {
  type: 'success' | 'error' | 'info';
  message: string;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
};

type ProductRecord = Product & {
  source?: string;
  dataSource?: string;
  sourceItemKind?: ProductKind;
  verifiedSource?: boolean;
  sourceVerified?: boolean;
  publicHidden?: boolean;
  isDemo?: boolean;
  isSample?: boolean;
  isTest?: boolean;
  originalUrl?: string;
  affiliateUrl?: string;
  url?: string;
  productUrl?: string;
  landingUrl?: string;
  linkHealthStatus?: string;
};

const PLATFORM_LABELS: Record<string, string> = {
  shopee: 'Shopee',
  tiktok_shop: 'TikTok Shop',
  lazada: 'Lazada',
  accesstrade: 'AccessTrade',
  website: 'Website',
  other: 'Khác',
};

const STATUS_LABELS: Record<string, { label: string; badge: string }> = {
  draft: { label: 'Nháp', badge: 'badge-neutral' },
  needs_review: { label: 'Cần xem xét', badge: 'badge-warning' },
  approved: { label: 'Đã duyệt', badge: 'badge-success' },
  published: { label: 'Đã xuất bản', badge: 'badge-info' },
  archived: { label: 'Lưu trữ', badge: 'badge-neutral' },
};

const KIND_LABELS: Record<string, string> = {
  product: 'Sản phẩm',
  voucher: 'Voucher',
  campaign: 'Chiến dịch',
  deal: 'Deal',
  store_offer: 'Ưu đãi shop',
  unknown: 'Chưa rõ',
};

const KIND_BADGES: Record<string, string> = {
  product: 'badge-success',
  deal: 'badge-success',
  voucher: 'badge-warning',
  campaign: 'badge-warning',
  store_offer: 'badge-warning',
  unknown: 'badge-neutral',
};

const RISK_LABELS: Record<string, { label: string; badge: string }> = {
  low: { label: 'Thấp', badge: 'badge-success' },
  medium: { label: 'Trung bình', badge: 'badge-warning' },
  high: { label: 'Cao', badge: 'badge-danger' },
  unknown: { label: 'Chưa rõ', badge: 'badge-neutral' },
};

const BROKEN_LINK_STATUSES = new Set([
  'broken',
  'broken_link',
  'not_found',
  'affiliate_error',
  'image_broken',
  'product_unavailable',
  'server_error',
  'error',
  'failed',
  'dead',
  'redirect_error',
  'unavailable',
  'out_of_stock',
]);

function normalizeText(value?: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
}

function getProductRecord(product: Product): ProductRecord {
  return product as ProductRecord;
}

function getEffectiveKind(product: Product): ProductKind {
  const p = getProductRecord(product);
  const explicitKind = p.sourceItemKind || p.kind;

  if (explicitKind && explicitKind !== 'unknown') {
    if (
        (explicitKind === 'product' || explicitKind === 'deal') &&
        (looksLikeVoucherOrCampaign(product) || looksLikeVoucherOrCampaign(product.title))
    ) {
      return classifyProductKind({
        ...product,
        kind: undefined,
        sourceItemKind: undefined,
      } as Partial<Product>);
    }

    return explicitKind;
  }

  return classifyProductKind({
    ...product,
    kind: undefined,
    sourceItemKind: undefined,
  } as Partial<Product>);
}

function getKindLabel(kind: ProductKind): string {
  return KIND_LABELS[kind] || 'Chưa rõ';
}

function getKindBadge(kind: ProductKind): string {
  return KIND_BADGES[kind] || 'badge-neutral';
}

function isRealProductKind(kind: ProductKind): boolean {
  return kind === 'product' || kind === 'deal';
}

function isNonProductKind(kind: ProductKind): boolean {
  return kind === 'voucher' || kind === 'campaign' || kind === 'store_offer' || kind === 'unknown';
}

function getSourceLabel(product: Product): string {
  const p = getProductRecord(product);

  return p.source || p.dataSource || 'unknown';
}

function isVerifiedSource(product: Product): boolean {
  const p = getProductRecord(product);
  const source = normalizeText(getSourceLabel(product));

  return Boolean(p.verifiedSource === true || p.sourceVerified === true || source === 'accesstrade');
}

function isDemoOrTest(product: Product): boolean {
  const p = getProductRecord(product);
  const source = normalizeText(getSourceLabel(product));
  const title = normalizeText(product.title);

  return Boolean(
      p.isDemo === true ||
      p.isSample === true ||
      p.isTest === true ||
      source === 'demo' ||
      source === 'sample' ||
      source === 'test' ||
      title.includes('demo') ||
      title.includes('sample') ||
      title.includes('test product') ||
      title.includes('san pham test'),
  );
}

function hasExternalUrl(product: Product): boolean {
  const p = getProductRecord(product);

  return [p.affiliateUrl, p.originalUrl, p.url, p.productUrl, p.landingUrl].some(
      (url) => typeof url === 'string' && /^https?:\/\//i.test(url),
  );
}

function hasBrokenLink(product: Product): boolean {
  const p = getProductRecord(product);
  const status = normalizeText(p.linkHealthStatus);

  return Boolean(status && BROKEN_LINK_STATUSES.has(status));
}

function canApproveProduct(product: Product): boolean {
  const p = getProductRecord(product);
  const kind = getEffectiveKind(product);
  const status = normalizeText(product.status);
  const source = normalizeText(getSourceLabel(product));

  if (!isRealProductKind(kind)) return false;
  if (status === 'approved' || status === 'published' || status === 'archived') return false;
  if (!product.title || !String(product.title).trim()) return false;
  if (looksLikeVoucherOrCampaign(product) || looksLikeVoucherOrCampaign(product.title)) return false;
  if (isDemoOrTest(product)) return false;
  if (!hasExternalUrl(product)) return false;
  if (source === 'manual' && p.verifiedSource !== true && p.sourceVerified !== true) return false;
  if (hasBrokenLink(product)) return false;

  return true;
}

function getApproveBlockedReason(product: Product): string {
  const p = getProductRecord(product);
  const kind = getEffectiveKind(product);
  const source = normalizeText(getSourceLabel(product));

  if (kind === 'voucher') {
    return 'Mục này là voucher, chưa đủ dữ liệu sản phẩm để public.';
  }

  if (kind === 'campaign') {
    return 'Mục này là chiến dịch, chưa đủ dữ liệu sản phẩm để public.';
  }

  if (kind === 'store_offer') {
    return 'Mục này là ưu đãi shop, chưa phải sản phẩm cụ thể.';
  }

  if (kind === 'unknown') {
    return 'Mục này chưa rõ loại dữ liệu, cần phân loại trước khi duyệt.';
  }

  if (looksLikeVoucherOrCampaign(product) || looksLikeVoucherOrCampaign(product.title)) {
    return 'Tiêu đề giống voucher/chiến dịch, không thể duyệt public.';
  }

  if (!hasExternalUrl(product)) {
    return 'Thiếu link sản phẩm hoặc link affiliate hợp lệ.';
  }

  if (source === 'manual' && p.verifiedSource !== true && p.sourceVerified !== true) {
    return 'Sản phẩm thủ công chưa được xác minh nguồn.';
  }

  if (hasBrokenLink(product)) {
    return 'Link sản phẩm đang lỗi hoặc không khả dụng.';
  }

  if (isDemoOrTest(product)) {
    return 'Dữ liệu demo/test không thể public.';
  }

  return 'Mục này chưa đủ điều kiện duyệt.';
}

function formatPrice(price?: number) {
  if (!price) return '—';

  return `${price.toLocaleString('vi-VN')}₫`;
}

function getStatusLabel(status?: string) {
  return STATUS_LABELS[status || '']?.label || status || 'Không rõ';
}

function getStatusBadge(status?: string) {
  return STATUS_LABELS[status || '']?.badge || 'badge-neutral';
}

function getRiskLabel(riskLevel?: string) {
  return RISK_LABELS[riskLevel || 'unknown']?.label || riskLevel || 'Chưa rõ';
}

function getRiskBadge(riskLevel?: string) {
  return RISK_LABELS[riskLevel || 'unknown']?.badge || 'badge-neutral';
}

function SafeThumb({
                     src,
                     label = 'SP',
                     size = 40,
                     rounded = 'var(--radius-sm)',
                   }: {
  src?: string;
  label?: string;
  size?: number;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  const cleanSrc = src?.trim() || '';

  useEffect(() => {
    setFailed(false);
  }, [cleanSrc]);

  if (!cleanSrc || failed) {
    return (
        <div
            style={{
              width: size,
              height: size,
              borderRadius: rounded,
              background:
                  'radial-gradient(circle at 50% 20%, rgba(34,211,238,0.16), transparent 36%), linear-gradient(135deg, #1a2237, #111827)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: size > 80 ? '18px' : '12px',
              fontWeight: 900,
              color: '#22d3ee',
              flexShrink: 0,
            }}
        >
          {label}
        </div>
    );
  }

  return (
      <div
          style={{
            width: size,
            height: size,
            borderRadius: rounded,
            overflow: 'hidden',
            background: 'var(--bg-tertiary)',
            flexShrink: 0,
          }}
      >
        <img
            src={cleanSrc}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
  );
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'card' | 'table'>('table');
  const [toast, setToast] = useState<Toast | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [botRunning, setBotRunning] = useState(false);

  const [search, setSearch] = useState('');
  const [filterPlatform, setFilterPlatform] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterKind, setFilterKind] = useState('');
  const [filterRisk, setFilterRisk] = useState('');

  const showToast = useCallback((type: Toast['type'], message: string) => {
    setToast({ type, message });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    setSearch(params.get('q') || '');
    setFilterPlatform(params.get('platform') || '');
    setFilterStatus(params.get('status') || '');
    setFilterKind(params.get('kind') || '');
    setFilterRisk(params.get('riskLevel') || '');
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);

    try {
      const params = new URLSearchParams();

      if (search.trim()) params.set('q', search.trim());
      if (filterPlatform) params.set('platform', filterPlatform);
      if (filterStatus) params.set('status', filterStatus);
      if (filterRisk) params.set('riskLevel', filterRisk);

      const res = await fetch(`/api/products?${params.toString()}`, {
        cache: 'no-store',
      });

      const data = (await res.json().catch(() => null)) as ApiEnvelope<Product[]> | null;

      if ((data?.ok || data?.success) && Array.isArray(data.data)) {
        setProducts(data.data);
      } else {
        setProducts([]);
      }
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [search, filterPlatform, filterStatus, filterRisk]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const visibleProducts = useMemo(() => {
    return products.filter((product) => {
      if (!filterKind) return true;

      const inferredKind = getEffectiveKind(product);

      if (filterKind === 'product') return inferredKind === 'product';
      if (filterKind === 'deal') return inferredKind === 'deal';

      return inferredKind === filterKind;
    });
  }, [products, filterKind]);

  const stats = useMemo(() => {
    const published = products.filter((product) => product.status === 'published').length;
    const needsReview = products.filter((product) => product.status === 'needs_review').length;
    const nonProducts = products.filter((product) => isNonProductKind(getEffectiveKind(product))).length;
    const brokenLinks = products.filter((product) => hasBrokenLink(product)).length;

    return {
      total: products.length,
      published,
      needsReview,
      nonProducts,
      brokenLinks,
    };
  }, [products]);

  const clearFilters = () => {
    setSearch('');
    setFilterPlatform('');
    setFilterStatus('');
    setFilterKind('');
    setFilterRisk('');
  };

  const handleRunBot = async (mode: 'source_scan' | 'full_safe_run') => {
    setBotRunning(true);

    try {
      const res = await fetch('/api/ai-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          source: 'all',
          limit: 10,
          costMode: 'safe_free',
          safeMode: true,
          freeOnly: true,
          autoMode: true,
          autoApprove: true,
          autoPublish: true,
          allowPaidAi: false,
        }),
      });

      const data = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null;

      if (!res.ok || (!data?.ok && !data?.success)) {
        throw new Error(data?.message || data?.error || `Không chạy được bot. HTTP ${res.status}`);
      }

      showToast(
          'success',
          mode === 'full_safe_run'
              ? 'Đã chạy AutoPilot toàn bộ. Chỉ sản phẩm thật đạt chuẩn mới được public.'
              : 'Đã chạy quét nguồn. Bot sẽ tự lọc và public an toàn nếu đủ chuẩn.',
      );

      await loadProducts();
    } catch (err) {
      showToast(err instanceof Error ? 'error' : 'error', err instanceof Error ? err.message : 'Không chạy được bot.');
    } finally {
      setBotRunning(false);
    }
  };

  const handleScore = async (id: string) => {
    const res = await fetch(`/api/products/${id}/score`, { method: 'POST' });
    const data = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null;

    if (data?.ok || data?.success) {
      showToast('success', 'Đã chấm điểm sản phẩm.');
      await loadProducts();
    } else {
      showToast('error', data?.message || data?.error || 'Không thể chấm điểm sản phẩm.');
    }
  };

  const handleApprove = async (id: string) => {
    const product = products.find((item) => item.id === id);

    if (product && !canApproveProduct(product)) {
      showToast('error', getApproveBlockedReason(product));
      return;
    }

    const res = await fetch(`/api/products/${id}/approve`, { method: 'POST' });
    const data = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null;

    if (data?.ok || data?.success) {
      showToast('success', 'Đã duyệt sản phẩm.');
      await loadProducts();
    } else {
      showToast('error', data?.message || data?.error || 'Không thể duyệt sản phẩm.');
    }
  };

  const handleArchive = async (id: string) => {
    const res = await fetch(`/api/products/${id}/archive`, { method: 'POST' });
    const data = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null;

    if (data?.ok || data?.success) {
      showToast('success', 'Đã lưu trữ sản phẩm.');
      await loadProducts();
    } else {
      showToast('error', data?.message || data?.error || 'Không thể lưu trữ sản phẩm.');
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const data = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null;

    if (data?.ok || data?.success) {
      showToast('success', 'Đã xoá sản phẩm.');
      setDeleteConfirm(null);
      await loadProducts();
    } else {
      showToast('error', data?.message || data?.error || 'Không thể xoá sản phẩm.');
    }
  };

  const renderKindBadge = (product: Product) => {
    const kind = getEffectiveKind(product);
    const warningText = isNonProductKind(kind) ? 'Chưa phải sản phẩm cụ thể' : null;

    return (
        <div>
          <span className={`badge ${getKindBadge(kind)}`}>{getKindLabel(kind)}</span>
          {warningText && (
              <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>{warningText}</div>
          )}
        </div>
    );
  };

  const renderApproveButton = (product: Product, sizeClass = 'btn-sm') => {
    const status = normalizeText(product.status);

    if (status === 'approved' || status === 'published') {
      return null;
    }

    if (!canApproveProduct(product)) {
      return (
          <button
              type="button"
              className={`btn btn-ghost ${sizeClass}`}
              disabled
              title={getApproveBlockedReason(product)}
          >
            OK
          </button>
      );
    }

    return (
        <button
            type="button"
            className={`btn btn-ghost ${sizeClass}`}
            onClick={() => void handleApprove(product.id)}
            title="Duyệt sản phẩm"
        >
          OK
        </button>
    );
  };

  const renderSourceBadges = (product: Product) => {
    const source = getSourceLabel(product);
    const kind = getEffectiveKind(product);

    return (
        <div
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
        >
          <span>{source}</span>

          {isDemoOrTest(product) && (
              <span
                  style={{
                    fontSize: 10,
                    background: 'rgba(245,158,11,0.1)',
                    color: '#f59e0b',
                    padding: '2px 8px',
                    borderRadius: 6,
                  }}
              >
            Dữ liệu test
          </span>
          )}

          {isVerifiedSource(product) && (
              <span
                  style={{
                    fontSize: 10,
                    background: 'rgba(34,211,238,0.08)',
                    color: '#22d3ee',
                    padding: '2px 8px',
                    borderRadius: 6,
                  }}
              >
            Nguồn thật
          </span>
          )}

          {isNonProductKind(kind) && (
              <span
                  style={{
                    fontSize: 10,
                    background: 'rgba(245,158,11,0.1)',
                    color: '#f59e0b',
                    padding: '2px 8px',
                    borderRadius: 6,
                  }}
              >
            Không public tự động
          </span>
          )}
        </div>
    );
  };

  return (
      <>
        <section className="command-hero" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="command-hero-content">
            <div className="badge badge-purple" style={{ marginBottom: 'var(--space-md)' }}>
              Bot Results & Safe Publish Queue
            </div>

            <h1 className="page-title">Kết quả bot & hàng chờ duyệt</h1>

            <p className="page-subtitle" style={{ maxWidth: 720 }}>
              Theo dõi sản phẩm do bot AI quét được. AutoPilot sẽ tự public sản phẩm thật đạt chuẩn;
              voucher, campaign, ưu đãi shop, dữ liệu thiếu link hoặc rủi ro cao sẽ bị giữ nội bộ.
            </p>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-md)' }}>
              <span className="badge badge-success">Safe Mode ON</span>
              <span className="badge badge-success">Free Only ON</span>
              <span className="badge badge-info">AutoPilot ON</span>
              <span className="badge badge-success">Safe Publish ON</span>
            </div>

            <div className="flex gap-sm" style={{ flexWrap: 'wrap', marginTop: 'var(--space-lg)' }}>
              <button
                  type="button"
                  className="primary-button"
                  disabled={botRunning}
                  onClick={() => void handleRunBot('source_scan')}
              >
                {botRunning ? 'Đang chạy...' : 'Quét nguồn & tự public an toàn'}
              </button>

              <button
                  type="button"
                  className="secondary-button"
                  disabled={botRunning}
                  onClick={() => void handleRunBot('full_safe_run')}
              >
                Chạy AutoPilot toàn bộ
              </button>

              <Link href="/dashboard/product-sources" className="secondary-button">
                + Thêm sản phẩm
              </Link>

              <Link href="/deals" target="_blank" rel="noreferrer" className="secondary-button">
                Xem public site
              </Link>
            </div>
          </div>

          <div className="command-hero-panel">
            <div className="grid grid-2" style={{ minWidth: 320 }}>
              <div className="metric-card">
                <span className="badge badge-info">Tổng item</span>
                <div className="stat-card-value">{stats.total}</div>
              </div>

              <div className="metric-card">
                <span className="badge badge-success">Đã public</span>
                <div className="stat-card-value">{stats.published}</div>
              </div>

              <div className="metric-card">
                <span className="badge badge-warning">Chờ xem xét</span>
                <div className="stat-card-value">{stats.needsReview}</div>
              </div>

              <div className="metric-card">
                <span className="badge badge-neutral">Không public</span>
                <div className="stat-card-value">{stats.nonProducts}</div>
              </div>
            </div>
          </div>
        </section>

        {toast && (
            <div className="toast-container">
              <div className={`toast toast-${toast.type}`}>{toast.message}</div>
            </div>
        )}

        {deleteConfirm && (
            <div className="dialog-overlay" onClick={() => setDeleteConfirm(null)}>
              <div className="dialog" onClick={(event) => event.stopPropagation()}>
                <div className="dialog-title">Xác nhận xoá</div>
                <div className="dialog-message">
                  Bạn chắc chắn muốn xoá sản phẩm này? Hành động không thể hoàn tác.
                </div>
                <div className="dialog-actions">
                  <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>
                    Huỷ
                  </button>
                  <button className="btn btn-danger" onClick={() => void handleDelete(deleteConfirm)}>
                    Xoá sản phẩm
                  </button>
                </div>
              </div>
            </div>
        )}

        <div className="filter-bar">
          <input
              className="input"
              style={{ maxWidth: '280px' }}
              placeholder="Tìm sản phẩm..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
          />

          <select
              className="select"
              style={{ maxWidth: '140px' }}
              value={filterPlatform}
              onChange={(event) => setFilterPlatform(event.target.value)}
          >
            <option value="">Nền tảng</option>
            <option value="shopee">Shopee</option>
            <option value="tiktok_shop">TikTok Shop</option>
            <option value="lazada">Lazada</option>
            <option value="accesstrade">AccessTrade</option>
            <option value="website">Website</option>
          </select>

          <select
              className="select"
              style={{ maxWidth: '140px' }}
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
          >
            <option value="">Trạng thái</option>
            <option value="draft">Nháp</option>
            <option value="needs_review">Cần xem xét</option>
            <option value="approved">Đã duyệt</option>
            <option value="published">Đã xuất bản</option>
            <option value="archived">Lưu trữ</option>
          </select>

          <select
              className="select"
              style={{ maxWidth: '140px' }}
              value={filterKind}
              onChange={(event) => setFilterKind(event.target.value)}
          >
            <option value="">Loại</option>
            <option value="product">Sản phẩm</option>
            <option value="voucher">Voucher</option>
            <option value="campaign">Chiến dịch</option>
            <option value="store_offer">Ưu đãi shop</option>
            <option value="deal">Deal</option>
            <option value="unknown">Chưa rõ</option>
          </select>

          <select
              className="select"
              style={{ maxWidth: '120px' }}
              value={filterRisk}
              onChange={(event) => setFilterRisk(event.target.value)}
          >
            <option value="">Rủi ro</option>
            <option value="low">Thấp</option>
            <option value="medium">Trung bình</option>
            <option value="high">Cao</option>
          </select>

          <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
            Xóa lọc
          </button>

          <div className="view-toggle">
            <button
                type="button"
                className={`view-toggle-btn${viewMode === 'table' ? ' active' : ''}`}
                onClick={() => setViewMode('table')}
            >
              List
            </button>
            <button
                type="button"
                className={`view-toggle-btn${viewMode === 'card' ? ' active' : ''}`}
                onClick={() => setViewMode('card')}
            >
              Grid
            </button>
          </div>
        </div>

        {loading && (
            <div className="loading-state">
              <div className="spinner" />
            </div>
        )}

        {!loading && visibleProducts.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon" style={{ fontSize: '32px', opacity: 0.3 }}>
                P
              </div>
              <div className="empty-state-title">Chưa có sản phẩm nào</div>
              <div className="empty-state-desc">
                {filterKind
                    ? 'Không có mục nào khớp với bộ lọc hiện tại.'
                    : 'Hãy chạy AutoPilot hoặc thêm sản phẩm từ nguồn affiliate.'}
              </div>
              <div className="flex gap-sm" style={{ marginTop: 'var(--space-lg)', justifyContent: 'center' }}>
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={botRunning}
                    onClick={() => void handleRunBot('source_scan')}
                >
                  Quét nguồn
                </button>
                <Link href="/dashboard/product-sources" className="btn btn-secondary">
                  + Thêm sản phẩm
                </Link>
              </div>
            </div>
        )}

        {!loading && visibleProducts.length > 0 && viewMode === 'table' && (
            <div className="table-container">
              <table>
                <thead>
                <tr>
                  <th>Sản phẩm</th>
                  <th>Loại</th>
                  <th>Nền tảng</th>
                  <th>Giá</th>
                  <th>Trạng thái</th>
                  <th>Điểm</th>
                  <th>Rủi ro</th>
                  <th>Hành động</th>
                </tr>
                </thead>

                <tbody>
                {visibleProducts.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <div className="flex items-center gap-sm">
                          <SafeThumb src={product.imageUrl} label="SP" size={40} />

                          <div>
                            <Link
                                href={`/dashboard/products/${product.id}`}
                                style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}
                            >
                              {product.title}
                            </Link>

                            {renderSourceBadges(product)}
                          </div>
                        </div>
                      </td>

                      <td>{renderKindBadge(product)}</td>

                      <td>
                    <span className="badge badge-neutral">
                      {PLATFORM_LABELS[product.platform] || product.platform}
                    </span>
                      </td>

                      <td>
                        <div>
                          {product.salePrice ? (
                              <>
                          <span style={{ fontWeight: 700, color: 'var(--color-accent-light)' }}>
                            {formatPrice(product.salePrice)}
                          </span>
                                {product.price && product.price !== product.salePrice && (
                                    <span
                                        style={{
                                          fontSize: 'var(--text-xs)',
                                          color: 'var(--text-tertiary)',
                                          textDecoration: 'line-through',
                                          marginLeft: '6px',
                                        }}
                                    >
                              {formatPrice(product.price)}
                            </span>
                                )}
                              </>
                          ) : (
                              <span>{formatPrice(product.price)}</span>
                          )}
                        </div>
                      </td>

                      <td>
                    <span className={`badge ${getStatusBadge(product.status)}`}>
                      {getStatusLabel(product.status)}
                    </span>
                      </td>

                      <td>
                        {product.score != null ? (
                            <span
                                className={`score-badge ${
                                    product.score >= 75
                                        ? 'score-badge-green'
                                        : product.score >= 45
                                            ? 'score-badge-yellow'
                                            : 'score-badge-red'
                                }`}
                                style={{ fontSize: '12px', padding: '4px 10px' }}
                            >
                        {product.score}
                      </span>
                        ) : (
                            '—'
                        )}
                      </td>

                      <td>
                    <span className={`badge ${getRiskBadge(product.riskLevel)}`}>
                      {getRiskLabel(product.riskLevel)}
                    </span>
                      </td>

                      <td>
                        <div className="flex gap-xs" style={{ flexWrap: 'wrap' }}>
                          <Link
                              href={`/dashboard/products/${product.id}`}
                              className="btn btn-ghost btn-sm"
                              title="Xem"
                          >
                            View
                          </Link>

                          <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void handleScore(product.id)}
                              title="Chấm điểm"
                          >
                            Score
                          </button>

                          {renderApproveButton(product)}

                          <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void handleArchive(product.id)}
                              title="Lưu trữ"
                          >
                            Arch
                          </button>

                          <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setDeleteConfirm(product.id)}
                              title="Xoá"
                              style={{ color: 'var(--color-danger)' }}
                          >
                            Del
                          </button>
                        </div>
                      </td>
                    </tr>
                ))}
                </tbody>
              </table>
            </div>
        )}

        {!loading && visibleProducts.length > 0 && viewMode === 'card' && (
            <div className="grid grid-3">
              {visibleProducts.map((product) => {
                const kind = getEffectiveKind(product);

                return (
                    <div key={product.id} className="card product-card">
                      <div className="product-card-image">
                        <SafeThumb
                            src={product.imageUrl}
                            label="SP"
                            size={220}
                            rounded="var(--radius-lg)"
                        />

                        <div className="deal-card-platform">
                    <span className="badge badge-neutral">
                      {PLATFORM_LABELS[product.platform] || product.platform}
                    </span>
                        </div>
                      </div>

                      <div style={{ padding: 'var(--space-md)' }}>
                        <Link href={`/dashboard/products/${product.id}`}>
                          <h4 className="deal-card-title">{product.title}</h4>
                        </Link>

                        <div
                            className="flex items-center gap-sm"
                            style={{ margin: 'var(--space-xs) 0', flexWrap: 'wrap' }}
                        >
                    <span
                        className={`badge ${getStatusBadge(product.status)}`}
                        style={{ fontSize: '10px' }}
                    >
                      {getStatusLabel(product.status)}
                    </span>

                          <span className={`badge ${getKindBadge(kind)}`} style={{ fontSize: '10px' }}>
                      {getKindLabel(kind)}
                    </span>

                          <span
                              className={`badge ${getRiskBadge(product.riskLevel)}`}
                              style={{ fontSize: '10px' }}
                          >
                      {getRiskLabel(product.riskLevel)}
                    </span>
                        </div>

                        {isNonProductKind(kind) && (
                            <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 'var(--space-xs)' }}>
                              Chưa phải sản phẩm cụ thể — không public tự động
                            </div>
                        )}

                        <div className="deal-card-price" style={{ fontSize: 'var(--text-lg)' }}>
                          {product.salePrice ? formatPrice(product.salePrice) : formatPrice(product.price)}
                        </div>

                        {product.score != null && (
                            <div style={{ margin: 'var(--space-xs) 0' }}>
                      <span
                          className={`score-badge ${
                              product.score >= 75
                                  ? 'score-badge-green'
                                  : product.score >= 45
                                      ? 'score-badge-yellow'
                                      : 'score-badge-red'
                          }`}
                          style={{ fontSize: '11px' }}
                      >
                        {product.scoreLabel || `${product.score} điểm`}
                      </span>
                            </div>
                        )}

                        <div className="flex gap-xs" style={{ marginTop: 'var(--space-sm)', flexWrap: 'wrap' }}>
                          <Link
                              href={`/dashboard/products/${product.id}`}
                              className="btn btn-sm btn-ghost"
                          >
                            View
                          </Link>

                          <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => void handleScore(product.id)}
                              title="Chấm điểm"
                          >
                            Score
                          </button>

                          {renderApproveButton(product)}

                          <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => void handleArchive(product.id)}
                              title="Lưu trữ"
                          >
                            Arch
                          </button>

                          <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => setDeleteConfirm(product.id)}
                              title="Xoá"
                              style={{ color: 'var(--color-danger)' }}
                          >
                            Del
                          </button>
                        </div>
                      </div>
                    </div>
                );
              })}
            </div>
        )}
      </>
  );
}