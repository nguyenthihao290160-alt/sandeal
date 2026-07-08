'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import type { Product, ProductKind } from '@/lib/types';
import { classifyProductKind, looksLikeVoucherOrCampaign } from '@/lib/sourceItemClassifier';

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

function normalizeText(value?: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
}

function getEffectiveKind(product: Product): ProductKind {
  const p = product as Product & {
    sourceItemKind?: ProductKind;
    kind?: ProductKind;
  };

  const explicitKind = p.sourceItemKind || p.kind;

  // Nếu dữ liệu đã được phân loại rõ thì dùng luôn,
  // nhưng không tin "unknown" vì dữ liệu cũ thường bị để unknown.
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

  // Dữ liệu cũ chưa có kind/sourceItemKind thì suy luận lại từ title/source/raw fields.
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

function canApproveProduct(product: Product): boolean {
  const kind = getEffectiveKind(product);
  const status = normalizeText(product.status);

  if (!isRealProductKind(kind)) return false;
  if (status === 'approved' || status === 'published' || status === 'archived') return false;
  if (looksLikeVoucherOrCampaign(product) || looksLikeVoucherOrCampaign(product.title)) return false;

  return true;
}

function getApproveBlockedReason(product: Product): string {
  const kind = getEffectiveKind(product);

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

  return 'Mục này chưa đủ điều kiện duyệt.';
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'card' | 'table'>('table');
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filterPlatform, setFilterPlatform] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterKind, setFilterKind] = useState('');
  const [filterRisk, setFilterRisk] = useState('');

  const showToast = useCallback((type: string, message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);

    try {
      const params = new URLSearchParams();

      if (search) params.set('q', search);
      if (filterPlatform) params.set('platform', filterPlatform);
      if (filterStatus) params.set('status', filterStatus);
      if (filterRisk) params.set('riskLevel', filterRisk);

      // Không gửi filterKind lên API vì dữ liệu cũ có thể thiếu kind/sourceItemKind.
      // Loại sản phẩm sẽ được lọc lại ở client bằng classifier.
      const res = await fetch(`/api/products?${params.toString()}`);
      const data = await res.json().catch(() => null);

      if (data?.ok && Array.isArray(data.data)) {
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
    loadProducts();
  }, [loadProducts]);

  const visibleProducts = useMemo(() => {
    return products.filter((product) => {
      if (!filterKind) return true;

      const inferredKind = getEffectiveKind(product);

      if (filterKind === 'product') {
        return inferredKind === 'product';
      }

      if (filterKind === 'deal') {
        return inferredKind === 'deal';
      }

      return inferredKind === filterKind;
    });
  }, [products, filterKind]);

  const handleScore = async (id: string) => {
    const res = await fetch(`/api/products/${id}/score`, { method: 'POST' });
    const data = await res.json().catch(() => null);

    if (data?.ok) {
      showToast('success', 'Đã chấm điểm sản phẩm.');
      loadProducts();
    } else {
      showToast('error', data?.message || 'Không thể chấm điểm sản phẩm.');
    }
  };

  const handleApprove = async (id: string) => {
    const product = products.find((item) => item.id === id);

    if (product && !canApproveProduct(product)) {
      showToast('error', getApproveBlockedReason(product));
      return;
    }

    const res = await fetch(`/api/products/${id}/approve`, { method: 'POST' });
    const data = await res.json().catch(() => null);

    if (data?.ok) {
      showToast('success', 'Đã duyệt sản phẩm.');
      loadProducts();
    } else {
      showToast('error', data?.message || 'Không thể duyệt sản phẩm.');
    }
  };

  const handleArchive = async (id: string) => {
    const res = await fetch(`/api/products/${id}/archive`, { method: 'POST' });
    const data = await res.json().catch(() => null);

    if (data?.ok) {
      showToast('success', 'Đã lưu trữ sản phẩm.');
      loadProducts();
    } else {
      showToast('error', data?.message || 'Không thể lưu trữ sản phẩm.');
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => null);

    if (data?.ok) {
      showToast('success', 'Đã xoá sản phẩm.');
      setDeleteConfirm(null);
      loadProducts();
    } else {
      showToast('error', data?.message || 'Không thể xoá sản phẩm.');
    }
  };

  const formatPrice = (price?: number) => {
    if (!price) return '—';
    return `${price.toLocaleString('vi-VN')}₫`;
  };

  const renderKindBadge = (product: Product) => {
    const kind = getEffectiveKind(product);
    const warningText = isNonProductKind(kind) ? 'Chưa phải sản phẩm cụ thể' : null;

    return (
        <div>
        <span className={`badge ${getKindBadge(kind)}`}>
          {getKindLabel(kind)}
        </span>
          {warningText && (
              <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>
                {warningText}
              </div>
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
            className={`btn btn-ghost ${sizeClass}`}
            onClick={() => handleApprove(product.id)}
            title="Duyệt sản phẩm"
        >
          OK
        </button>
    );
  };

  return (
      <>
        <div className="topbar">
          <div className="topbar-title">Kết quả bot & hàng chờ duyệt</div>
          <div className="safe-mode-badges">
            <span className="dashboard-status-badge success">Safe Mode</span>
            <span className="dashboard-status-badge success">Free Only</span>
            <span className="dashboard-status-badge neutral">Auto Publish: OFF</span>
          </div>
        </div>

        <div className="page-content">
          <div className="page-header">
            <div>
              <h1 className="page-header-title">Kết quả bot & hàng chờ duyệt</h1>
              <p className="page-header-desc">
                Sản phẩm do bot AI quét được, chờ duyệt trước khi xuất bản.
              </p>
            </div>
            <Link href="/dashboard/product-sources" className="btn btn-primary">
              + Thêm sản phẩm
            </Link>
          </div>

          {toast && (
              <div className="toast-container">
                <div className={`toast toast-${toast.type}`}>
                  {toast.message}
                </div>
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
                    <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm)}>
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

            <div className="view-toggle">
              <button
                  className={`view-toggle-btn${viewMode === 'table' ? ' active' : ''}`}
                  onClick={() => setViewMode('table')}
              >
                List
              </button>
              <button
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
                      : 'Hãy thêm sản phẩm thủ công hoặc lấy từ nguồn affiliate.'}
                </div>
                <Link
                    href="/dashboard/product-sources"
                    className="btn btn-primary"
                    style={{ marginTop: 'var(--space-lg)' }}
                >
                  + Thêm sản phẩm
                </Link>
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
                            {product.imageUrl ? (
                                <div
                                    style={{
                                      width: 40,
                                      height: 40,
                                      borderRadius: 'var(--radius-sm)',
                                      overflow: 'hidden',
                                      background: 'var(--bg-tertiary)',
                                      flexShrink: 0,
                                    }}
                                >
                                  <img
                                      src={product.imageUrl}
                                      alt=""
                                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  />
                                </div>
                            ) : (
                                <div
                                    style={{
                                      width: 40,
                                      height: 40,
                                      borderRadius: 'var(--radius-sm)',
                                      background: 'linear-gradient(135deg, #1a2237, #111827)',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '12px',
                                      fontWeight: 700,
                                      color: '#64748b',
                                      flexShrink: 0,
                                    }}
                                >
                                  SP
                                </div>
                            )}

                            <div>
                              <Link
                                  href={`/dashboard/products/${product.id}`}
                                  style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}
                              >
                                {product.title}
                              </Link>

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
                                <span>{product.source}</span>

                                {((product as Product & { isDemo?: boolean; isSample?: boolean; isTest?: boolean }).isDemo ||
                                    (product as Product & { isDemo?: boolean; isSample?: boolean; isTest?: boolean }).isSample ||
                                    (product as Product & { isDemo?: boolean; isSample?: boolean; isTest?: boolean }).isTest ||
                                    ['demo', 'sample', 'test'].includes(product.source || '')) && (
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

                                {(product.source === 'accesstrade' ||
                                    (product as Product & { verifiedSource?: boolean }).verifiedSource) && (
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

                                {isNonProductKind(getEffectiveKind(product)) && (
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
                      <span className={`badge ${STATUS_LABELS[product.status]?.badge || 'badge-neutral'}`}>
                        {STATUS_LABELS[product.status]?.label || product.status}
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
                      <span className={`badge ${RISK_LABELS[product.riskLevel]?.badge || 'badge-neutral'}`}>
                        {RISK_LABELS[product.riskLevel]?.label || product.riskLevel || 'Chưa rõ'}
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
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleScore(product.id)}
                                title="Chấm điểm"
                            >
                              Score
                            </button>

                            {renderApproveButton(product)}

                            <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleArchive(product.id)}
                                title="Lưu trữ"
                            >
                              Arch
                            </button>

                            <button
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
                          {product.imageUrl ? (
                              <img src={product.imageUrl} alt={product.title} />
                          ) : (
                              <span style={{ fontSize: '12px', fontWeight: 700, color: '#64748b' }}>
                        SP
                      </span>
                          )}

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
                          className={`badge ${STATUS_LABELS[product.status]?.badge || 'badge-neutral'}`}
                          style={{ fontSize: '10px' }}
                      >
                        {STATUS_LABELS[product.status]?.label || product.status}
                      </span>

                            <span className={`badge ${getKindBadge(kind)}`} style={{ fontSize: '10px' }}>
                        {getKindLabel(kind)}
                      </span>

                            <span
                                className={`badge ${RISK_LABELS[product.riskLevel]?.badge || 'badge-neutral'}`}
                                style={{ fontSize: '10px' }}
                            >
                        {RISK_LABELS[product.riskLevel]?.label || 'N/A'}
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
                            <button
                                className="btn btn-sm btn-ghost"
                                onClick={() => handleScore(product.id)}
                                title="Chấm điểm"
                            >
                              Score
                            </button>

                            {renderApproveButton(product)}

                            <button
                                className="btn btn-sm btn-ghost"
                                onClick={() => handleArchive(product.id)}
                                title="Lưu trữ"
                            >
                              Arch
                            </button>

                            <button
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
        </div>
      </>
  );
}