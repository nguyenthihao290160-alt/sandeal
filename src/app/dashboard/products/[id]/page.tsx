'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Product } from '@/lib/types';
import { classifyProductKind, looksLikeVoucherOrCampaign } from '@/lib/sourceItemClassifier';

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);

  const showToast = useCallback((type: string, message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadProduct = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/products/${id}`);
      const data = await res.json();
      if (data.ok) {
        setProduct(data.data);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/products/${id}`)
      .then(res => res.json())
      .then(data => { if (!cancelled && data.ok) setProduct(data.data); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const handleAction = async (action: string) => {
    const url = action === 'score' ? `/api/products/${id}/score`
      : action === 'approve' ? `/api/products/${id}/approve`
      : action === 'archive' ? `/api/products/${id}/archive`
      : action === 'needs_review' ? `/api/products/${id}` : '';

    const method = action === 'needs_review' ? 'PATCH' : 'POST';
    const body = action === 'needs_review' ? JSON.stringify({ status: 'needs_review' }) : undefined;
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, { method, body, headers });
    const data = await res.json();
    if (data.ok) {
      const messages: Record<string, string> = {
        score: 'Đã chấm điểm sản phẩm.',
        approve: 'Đã duyệt sản phẩm.',
        archive: 'Đã lưu trữ sản phẩm.',
        needs_review: 'Đã chuyển về cần xem xét.',
      };
      showToast('success', messages[action] || 'Thành công.');
      loadProduct();
    } else {
      showToast('error', data.message);
    }
  };

  const formatPrice = (price?: number) => {
    if (!price) return '—';
    return price.toLocaleString('vi-VN') + '₫';
  };

  if (loading) {
    return (
      <>
        <div className="topbar"><div className="topbar-title">Chi tiết sản phẩm</div></div>
        <div className="page-content"><div className="loading-state"><div className="spinner"></div></div></div>
      </>
    );
  }

  if (!product) {
    return (
      <>
        <div className="topbar"><div className="topbar-title">Chi tiết sản phẩm</div></div>
        <div className="page-content">
          <div className="empty-state">
            <div className="empty-state-icon">❌</div>
            <div className="empty-state-title">Không tìm thấy sản phẩm</div>
            <div className="empty-state-desc">Sản phẩm này có thể đã bị xoá hoặc không tồn tại.</div>
            <Link href="/dashboard/products" className="btn btn-primary" style={{ marginTop: 'var(--space-lg)' }}>← Quay lại danh sách</Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Chi tiết sản phẩm</div>
        <Link href="/dashboard/products" className="btn btn-secondary btn-sm">← Quay lại</Link>
      </div>
      <div className="page-content">
        {/* Toast */}
        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              {toast.type === 'success' ? '✅' : '❌'} {toast.message}
            </div>
          </div>
        )}

        <div className="product-detail-grid">
          {/* Left: Main info */}
          <div>
            {/* Product Header */}
            <div className="gradient-card" style={{ marginBottom: 'var(--space-lg)' }}>
              <div className="flex items-center gap-md" style={{ marginBottom: 'var(--space-md)', flexWrap: 'wrap' }}>
                {product.imageUrl ? (
                  <div style={{ width: 100, height: 100, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0 }}>
                    <img src={product.imageUrl} alt={product.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ) : (
                  <div style={{ width: 100, height: 100, borderRadius: 'var(--radius-md)', background: 'linear-gradient(135deg, #1a2237, #111827)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '40px', flexShrink: 0 }}>📦</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 800, marginBottom: '6px', letterSpacing: '-0.01em' }}>{product.title}</h1>
                  <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
                    <span className="badge badge-neutral">{product.platform}</span>
                    {(() => {
                      const inferred = product.kind || classifyProductKind(product as any);
                      return (
                        <>
                          <span className="badge badge-neutral">{inferred}</span>
                          {inferred !== 'product' && (
                            <div style={{ fontSize: 12, color: 'var(--text-warning)', marginLeft: 8 }}>Chưa phải sản phẩm cụ thể</div>
                          )}
                        </>
                      );
                    })()}
                    <span className={`badge ${product.status === 'approved' ? 'badge-success' : product.status === 'needs_review' ? 'badge-warning' : product.status === 'published' ? 'badge-info' : 'badge-neutral'}`}>
                      {product.status === 'approved' ? 'Đã duyệt' : product.status === 'needs_review' ? 'Cần xem xét' : product.status === 'draft' ? 'Nháp' : product.status === 'published' ? 'Đã xuất bản' : product.status}
                    </span>
                  </div>
                </div>
              </div>

              {product.description && (
                <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-md)', fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>{product.description}</p>
              )}

              {/* Price */}
              <div className="flex items-center gap-md" style={{ marginBottom: 'var(--space-md)', flexWrap: 'wrap' }}>
                {product.salePrice ? (
                  <>
                    <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--color-accent-light)' }}>{formatPrice(product.salePrice)}</span>
                    {product.price && product.price !== product.salePrice && (
                      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', textDecoration: 'line-through' }}>{formatPrice(product.price)}</span>
                    )}
                  </>
                ) : product.price ? (
                  <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--color-accent-light)' }}>{formatPrice(product.price)}</span>
                ) : null}
                {product.priceNote && <span className="badge badge-warning">{product.priceNote}</span>}
              </div>

              {/* Links */}
              <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
                {product.affiliateUrl && (
                  <a href={product.affiliateUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">🔗 Mở link affiliate</a>
                )}
                {product.originalUrl && (
                  <a href={product.originalUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">🌐 Mở link gốc</a>
                )}
              </div>
            </div>

            {/* Benefits */}
            {product.benefits && product.benefits.length > 0 && (
              <div className="glass-card" style={{ marginBottom: 'var(--space-lg)' }}>
                <h3 className="card-title">✅ Lợi ích chính</h3>
                <ul className="detail-list">
                  {product.benefits.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            )}

            {/* Warnings */}
            {product.warnings && product.warnings.length > 0 && (
              <div className="glass-card" style={{ marginBottom: 'var(--space-lg)', borderColor: 'rgba(245, 158, 11, 0.2)' }}>
                <h3 className="card-title">⚠️ Cảnh báo / Không được nói quá</h3>
                <ul className="detail-list detail-list-warning">
                  {product.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* Content Intelligence */}
            <div className="glass-card" style={{ marginBottom: 'var(--space-lg)' }}>
              <h3 className="card-title">🧠 Content Intelligence</h3>
              {product.painPoints && product.painPoints.length > 0 && (
                <div style={{ marginBottom: 'var(--space-md)' }}>
                  <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Pain points:</strong>
                  <ul className="detail-list">{product.painPoints.map((p2, i) => <li key={i}>{p2}</li>)}</ul>
                </div>
              )}
              {product.targetAudience && product.targetAudience.length > 0 && (
                <div style={{ marginBottom: 'var(--space-md)' }}>
                  <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Đối tượng:</strong>
                  <ul className="detail-list">{product.targetAudience.map((t, i) => <li key={i}>{t}</li>)}</ul>
                </div>
              )}
              {product.contentAngles && product.contentAngles.length > 0 && (
                <div style={{ marginBottom: 'var(--space-md)' }}>
                  <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Góc nội dung:</strong>
                  <ul className="detail-list">{product.contentAngles.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              )}
              {product.complianceNotes && product.complianceNotes.length > 0 && (
                <div>
                  <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Ghi chú kiểm duyệt:</strong>
                  <ul className="detail-list">{product.complianceNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                </div>
              )}
              {!product.painPoints?.length && !product.targetAudience?.length && !product.contentAngles?.length && (
                <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>Chưa có thông tin content intelligence.</p>
              )}
            </div>
          </div>

          {/* Right: Score + Actions */}
          <div>
            {/* Score Card */}
            <div className="gradient-card" style={{ marginBottom: 'var(--space-lg)' }}>
              <h3 className="card-title">📊 Điểm đánh giá</h3>
              {product.score != null ? (
                <>
                  <div style={{ textAlign: 'center', margin: 'var(--space-lg) 0' }}>
                    <div className={`score-badge ${product.score >= 75 ? 'score-badge-green' : product.score >= 45 ? 'score-badge-yellow' : 'score-badge-red'}`} style={{ fontSize: 'var(--text-2xl)', padding: '14px 28px' }}>
                      {product.score}
                    </div>
                    {product.scoreLabel && (
                      <div style={{ marginTop: 'var(--space-sm)', fontWeight: 700, fontSize: 'var(--text-sm)' }}>{product.scoreLabel}</div>
                    )}
                  </div>
                  {product.scoreReasons && product.scoreReasons.length > 0 && (
                    <div style={{ marginBottom: 'var(--space-md)' }}>
                      <strong style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>Lý do:</strong>
                      <ul className="detail-list" style={{ fontSize: 'var(--text-xs)' }}>
                        {product.scoreReasons.map((r, i) => <li key={i} style={{ color: 'var(--color-success)' }}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                  {product.scoreWarnings && product.scoreWarnings.length > 0 && (
                    <div>
                      <strong style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>Cảnh báo:</strong>
                      <ul className="detail-list" style={{ fontSize: 'var(--text-xs)' }}>
                        {product.scoreWarnings.map((w, i) => <li key={i} style={{ color: 'var(--color-warning)' }}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-sm)' }}>Chưa được chấm điểm.</p>
              )}
              <button className="btn btn-accent" style={{ width: '100%', marginTop: 'var(--space-md)' }} onClick={() => handleAction('score')}>
                ⭐ Chấm điểm lại
              </button>
            </div>

            {/* Risk */}
            <div className="glass-card" style={{ marginBottom: 'var(--space-lg)' }}>
              <h3 className="card-title">🛡️ Mức rủi ro</h3>
              <span className={`badge ${product.riskLevel === 'low' ? 'badge-success' : product.riskLevel === 'medium' ? 'badge-warning' : product.riskLevel === 'high' ? 'badge-danger' : 'badge-neutral'}`} style={{ fontSize: 'var(--text-sm)', padding: '6px 14px' }}>
                {product.riskLevel === 'low' ? 'Thấp' : product.riskLevel === 'medium' ? 'Trung bình' : product.riskLevel === 'high' ? 'Cao' : 'Chưa rõ'}
              </span>
            </div>

            {/* Actions */}
            <div className="glass-card" style={{ marginBottom: 'var(--space-lg)' }}>
              <h3 className="card-title">⚡ Hành động</h3>
              <div className="flex flex-col gap-sm">
                {(() => {
                  const inferred = product.kind || classifyProductKind(product as any);
                  if (inferred !== 'product') {
                    return (
                      <button className="btn btn-primary" style={{ width: '100%' }} disabled title="Mục này là voucher/chiến dịch/ưu đãi shop, không thể duyệt">✅ Duyệt sản phẩm</button>
                    );
                  }
                  return (product.status !== 'approved' && product.status !== 'published') ? (
                    <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => handleAction('approve')}>
                      ✅ Duyệt sản phẩm
                    </button>
                  ) : null;
                })()}
                {product.status !== 'needs_review' && (
                  <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => handleAction('needs_review')}>
                    🔍 Chuyển về cần xem xét
                  </button>
                )}
                <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => handleAction('archive')}>
                  📥 Lưu trữ
                </button>
                <Link href="/dashboard/content" className="btn btn-ghost" style={{ width: '100%', textAlign: 'center' }}>
                  ✍️ Tạo nội dung (sắp có)
                </Link>
              </div>
            </div>

            {/* Meta */}
            <div className="glass-card">
              <h3 className="card-title">📋 Thông tin thêm</h3>
              <div className="detail-meta">
                <div className="detail-meta-row"><span>Nguồn:</span><span>{product.source}</span></div>
                {product.category && <div className="detail-meta-row"><span>Danh mục:</span><span>{product.category}</span></div>}
                {product.tags && product.tags.length > 0 && (
                  <div className="detail-meta-row"><span>Tags:</span><span>{product.tags.join(', ')}</span></div>
                )}
                {product.campaignName && <div className="detail-meta-row"><span>Chiến dịch:</span><span>{product.campaignName}</span></div>}
                {product.commissionNote && <div className="detail-meta-row"><span>Hoa hồng:</span><span>{product.commissionNote}</span></div>}
                {product.affiliateDisclosure && <div className="detail-meta-row"><span>Disclosure:</span><span>{product.affiliateDisclosure}</span></div>}
                <div className="detail-meta-row"><span>Tạo lúc:</span><span>{new Date(product.createdAt).toLocaleString('vi-VN')}</span></div>
                <div className="detail-meta-row"><span>Cập nhật:</span><span>{new Date(product.updatedAt).toLocaleString('vi-VN')}</span></div>
              </div>

              {/* Technical Details */}
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 'var(--space-md)' }} onClick={() => setShowTechnical(!showTechnical)}>
                {showTechnical ? '▲' : '▼'} Chi tiết kỹ thuật
              </button>
              {showTechnical && (
                <pre style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', background: 'rgba(148, 163, 184, 0.04)', padding: 'var(--space-md)', borderRadius: 'var(--radius-md)', marginTop: 'var(--space-sm)', overflow: 'auto', maxHeight: '400px', border: '1px solid var(--border-primary)' }}>
                  {JSON.stringify(product, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
