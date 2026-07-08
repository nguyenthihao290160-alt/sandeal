'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Product } from '@/lib/types';
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

const RISK_LABELS: Record<string, { label: string; badge: string }> = {
  low: { label: 'Thấp', badge: 'badge-success' },
  medium: { label: 'Trung bình', badge: 'badge-warning' },
  high: { label: 'Cao', badge: 'badge-danger' },
  unknown: { label: 'Chưa rõ', badge: 'badge-neutral' },
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'card' | 'table'>('table');
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [filterPlatform, setFilterPlatform] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterKind, setFilterKind] = useState('');
  const [filterRisk, setFilterRisk] = useState('');

  const showToast = useCallback((type: string, message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadProducts = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (filterPlatform) params.set('platform', filterPlatform);
      if (filterStatus) params.set('status', filterStatus);
      if (filterKind) params.set('kind', filterKind);
      if (filterRisk) params.set('riskLevel', filterRisk);

      const res = await fetch(`/api/products?${params.toString()}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        setProducts(data.data);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (filterPlatform) params.set('platform', filterPlatform);
    if (filterStatus) params.set('status', filterStatus);
    if (filterKind) params.set('kind', filterKind);
    if (filterRisk) params.set('riskLevel', filterRisk);

    fetch(`/api/products?${params.toString()}`)
      .then(res => res.json())
      .then(data => {
        if (!cancelled && data.ok && Array.isArray(data.data)) {
          setProducts(data.data);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [search, filterPlatform, filterStatus, filterKind, filterRisk]);


  const handleScore = async (id: string) => {
    const res = await fetch(`/api/products/${id}/score`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('success', 'Đã chấm điểm sản phẩm.');
      loadProducts();
    } else {
      showToast('error', data.message);
    }
  };

  const handleApprove = async (id: string) => {
    const res = await fetch(`/api/products/${id}/approve`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('success', 'Đã duyệt sản phẩm.');
      loadProducts();
    } else {
      showToast('error', data.message);
    }
  };

  const handleArchive = async (id: string) => {
    const res = await fetch(`/api/products/${id}/archive`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('success', 'Đã lưu trữ sản phẩm.');
      loadProducts();
    } else {
      showToast('error', data.message);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      showToast('success', 'Đã xoá sản phẩm.');
      setDeleteConfirm(null);
      loadProducts();
    } else {
      showToast('error', data.message);
    }
  };

  const formatPrice = (price?: number) => {
    if (!price) return '—';
    return price.toLocaleString('vi-VN') + '₫';
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
            <p className="page-header-desc">Sản phẩm do bot AI quét được, chờ duyệt trước khi xuất bản.</p>
          </div>
          <Link href="/dashboard/product-sources" className="btn btn-primary">+ Thêm sản phẩm</Link>
        </div>
        {/* Toast */}
        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              {toast.message}
            </div>
          </div>
        )}

        {/* Delete Confirmation Dialog */}
        {deleteConfirm && (
          <div className="dialog-overlay" onClick={() => setDeleteConfirm(null)}>
            <div className="dialog" onClick={e => e.stopPropagation()}>
              <div className="dialog-title">Xác nhận xoá</div>
              <div className="dialog-message">Bạn chắc chắn muốn xoá sản phẩm này? Hành động không thể hoàn tác.</div>
              <div className="dialog-actions">
                <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>Huỷ</button>
                <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm)}>Xoá sản phẩm</button>
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="filter-bar">
          <input className="input" style={{ maxWidth: '280px' }} placeholder="Tìm sản phẩm..." value={search} onChange={e => setSearch(e.target.value)} />
          <select className="select" style={{ maxWidth: '140px' }} value={filterPlatform} onChange={e => setFilterPlatform(e.target.value)}>
            <option value="">Nền tảng</option>
            <option value="shopee">Shopee</option>
            <option value="tiktok_shop">TikTok Shop</option>
            <option value="lazada">Lazada</option>
            <option value="accesstrade">AccessTrade</option>
            <option value="website">Website</option>
          </select>
          <select className="select" style={{ maxWidth: '140px' }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">Trạng thái</option>
            <option value="draft">Nháp</option>
            <option value="needs_review">Cần xem xét</option>
            <option value="approved">Đã duyệt</option>
            <option value="published">Đã xuất bản</option>
            <option value="archived">Lưu trữ</option>
          </select>
          <select className="select" style={{ maxWidth: '120px' }} value={filterKind} onChange={e => setFilterKind(e.target.value)}>
            <option value="">Loại</option>
            <option value="product">Sản phẩm</option>
            <option value="voucher">Voucher</option>
            <option value="campaign">Chiến dịch</option>
            <option value="deal">Deal</option>
          </select>
          <select className="select" style={{ maxWidth: '120px' }} value={filterRisk} onChange={e => setFilterRisk(e.target.value)}>
            <option value="">Rủi ro</option>
            <option value="low">Thấp</option>
            <option value="medium">Trung bình</option>
            <option value="high">Cao</option>
          </select>
          <div className="view-toggle">
            <button className={`view-toggle-btn${viewMode === 'table' ? ' active' : ''}`} onClick={() => setViewMode('table')}>List</button>
            <button className={`view-toggle-btn${viewMode === 'card' ? ' active' : ''}`} onClick={() => setViewMode('card')}>Grid</button>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="loading-state"><div className="spinner"></div></div>
        )}

        {/* Empty */}
        {!loading && products.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon" style={{ fontSize: '32px', opacity: 0.3 }}>P</div>
            <div className="empty-state-title">Chưa có sản phẩm nào</div>
            <div className="empty-state-desc">Hãy thêm sản phẩm thủ công hoặc lấy từ nguồn affiliate.</div>
            <Link href="/dashboard/product-sources" className="btn btn-primary" style={{ marginTop: 'var(--space-lg)' }}>
              + Thêm sản phẩm
            </Link>
          </div>
        )}

        {/* Table View */}
        {!loading && products.length > 0 && viewMode === 'table' && (
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
                {products.map(p => (
                  <tr key={p.id}>
                    <td>
                      <div className="flex items-center gap-sm">
                        {p.imageUrl ? (
                          <div style={{ width: 40, height: 40, borderRadius: 'var(--radius-sm)', overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0 }}>
                            <img src={p.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                        ) : (
                          <div style={{ width: 40, height: 40, borderRadius: 'var(--radius-sm)', background: 'linear-gradient(135deg, #1a2237, #111827)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#64748b', flexShrink: 0 }}>SP</div>
                        )}
                        <div>
                          <Link href={`/dashboard/products/${p.id}`} style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{p.title}</Link>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <span>{p.source}</span>
                            {/* Badges: test/demo/manual unverified and Nguồn thật */}
                            {((p as any).isDemo || (p as any).isSample || (p as any).isTest || ['demo','sample','test'].includes(p.source || '')) && (
                              <span style={{ fontSize: 10, background: 'rgba(245,158,11,0.1)', color: '#f59e0b', padding: '2px 8px', borderRadius: 6 }}>Dữ liệu test</span>
                            )}
                            {(p.source === 'accesstrade' || (p as any).verifiedSource) && (
                              <span style={{ fontSize: 10, background: 'rgba(34,211,238,0.08)', color: '#22d3ee', padding: '2px 8px', borderRadius: 6 }}>Nguồn thật</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>{(() => {
                  const inferred = p.kind || classifyProductKind(p as any);
                  return (
                    <div>
                      <span className="badge badge-neutral">{KIND_LABELS[inferred] || inferred}</span>
                      {inferred !== 'product' && (
                        <div style={{ fontSize: 11, color: 'var(--text-warning)', marginTop: 4 }}>Chưa phải sản phẩm cụ thể</div>
                      )}
                    </div>
                  );
                })()}</td>
                    <td><span className="badge badge-neutral">{PLATFORM_LABELS[p.platform] || p.platform}</span></td>
                    <td>
                      <div>
                        {p.salePrice ? (
                          <>
                            <span style={{ fontWeight: 700, color: 'var(--color-accent-light)' }}>{formatPrice(p.salePrice)}</span>
                            {p.price && p.price !== p.salePrice && (
                              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', textDecoration: 'line-through', marginLeft: '6px' }}>{formatPrice(p.price)}</span>
                            )}
                          </>
                        ) : (
                          <span>{formatPrice(p.price)}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_LABELS[p.status]?.badge || 'badge-neutral'}`}>
                        {STATUS_LABELS[p.status]?.label || p.status}
                      </span>
                    </td>
                    <td>
                      {p.score != null ? (
                        <span className={`score-badge ${p.score >= 75 ? 'score-badge-green' : p.score >= 45 ? 'score-badge-yellow' : 'score-badge-red'}`} style={{ fontSize: '12px', padding: '4px 10px' }}>
                          {p.score}
                        </span>
                      ) : '—'}
                    </td>
                    <td>
                      <span className={`badge ${RISK_LABELS[p.riskLevel]?.badge || 'badge-neutral'}`}>
                        {RISK_LABELS[p.riskLevel]?.label || p.riskLevel}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-xs" style={{ flexWrap: 'wrap' }}>
                        <Link href={`/dashboard/products/${p.id}`} className="btn btn-ghost btn-sm" title="Xem">View</Link>
                        <button className="btn btn-ghost btn-sm" onClick={() => handleScore(p.id)} title="Chấm điểm">Score</button>
                        {(() => {
                          const inferred = p.kind || classifyProductKind(p as any);
                          if (inferred !== 'product') {
                            return (
                              <button className="btn btn-ghost btn-sm" disabled title="Mục này là voucher/chiến dịch, không thể duyệt">OK</button>
                            );
                          }
                          return (p.status !== 'approved' && p.status !== 'published') ? (
                            <button className="btn btn-ghost btn-sm" onClick={() => handleApprove(p.id)} title="Duyệt">OK</button>
                          ) : null;
                        })()}
                        <button className="btn btn-ghost btn-sm" onClick={() => handleArchive(p.id)} title="Lưu trữ">Arch</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setDeleteConfirm(p.id)} title="Xoá" style={{ color: 'var(--color-danger)' }}>Del</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Card View */}
        {!loading && products.length > 0 && viewMode === 'card' && (
          <div className="grid grid-3">
            {products.map(p => (
              <div key={p.id} className="card product-card">
                <div className="product-card-image">
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt={p.title} />
                  ) : (
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#64748b' }}>SP</span>
                  )}
                  <div className="deal-card-platform">
                    <span className="badge badge-neutral">{PLATFORM_LABELS[p.platform] || p.platform}</span>
                  </div>
                </div>
                <div style={{ padding: 'var(--space-md)' }}>
                  <Link href={`/dashboard/products/${p.id}`}>
                    <h4 className="deal-card-title">{p.title}</h4>
                  </Link>
                  <div className="flex items-center gap-sm" style={{ margin: 'var(--space-xs) 0', flexWrap: 'wrap' }}>
                    <span className={`badge ${STATUS_LABELS[p.status]?.badge || 'badge-neutral'}`} style={{ fontSize: '10px' }}>
                      {STATUS_LABELS[p.status]?.label || p.status}
                    </span>
                    <span className="badge badge-neutral" style={{ fontSize: '10px' }}>
                      {KIND_LABELS[p.kind] || p.kind}
                    </span>
                    <span className={`badge ${RISK_LABELS[p.riskLevel]?.badge || 'badge-neutral'}`} style={{ fontSize: '10px' }}>
                      {RISK_LABELS[p.riskLevel]?.label || 'N/A'}
                    </span>
                  </div>
                  <div className="deal-card-price" style={{ fontSize: 'var(--text-lg)' }}>
                    {p.salePrice ? formatPrice(p.salePrice) : formatPrice(p.price)}
                  </div>
                  {p.score != null && (
                    <div style={{ margin: 'var(--space-xs) 0' }}>
                      <span className={`score-badge ${p.score >= 75 ? 'score-badge-green' : p.score >= 45 ? 'score-badge-yellow' : 'score-badge-red'}`} style={{ fontSize: '11px' }}>
                        {p.scoreLabel || `${p.score} điểm`}
                      </span>
                    </div>
                  )}
                  <div className="flex gap-xs" style={{ marginTop: 'var(--space-sm)' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => handleScore(p.id)} title="Chấm điểm">Score</button>
                    {(() => {
                      const inferred = p.kind || classifyProductKind(p as any);
                      if (inferred !== 'product') {
                        return (
                          <button className="btn btn-sm btn-ghost" disabled title="Mục này là voucher/chiến dịch, không thể duyệt">OK</button>
                        );
                      }
                      return (p.status !== 'approved' && p.status !== 'published') ? (
                        <button className="btn btn-sm btn-ghost" onClick={() => handleApprove(p.id)} title="Duyệt">OK</button>
                      ) : null;
                    })()}
                    <button className="btn btn-sm btn-ghost" onClick={() => handleArchive(p.id)} title="Lưu trữ">Arch</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setDeleteConfirm(p.id)} title="Xoá" style={{ color: 'var(--color-danger)' }}>Del</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
