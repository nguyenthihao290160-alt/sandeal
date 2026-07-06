'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Product } from '@/lib/types';

const PLATFORMS: Record<string, string> = {
  shopee: 'Shopee', tiktok_shop: 'TikTok Shop', lazada: 'Lazada',
  accesstrade: 'AccessTrade', website: 'Website', other: 'Khác',
};

const FILTER_CHIPS = [
  { label: 'Tất cả', value: '' },
  { label: 'Shopee', value: 'shopee' },
  { label: 'TikTok Shop', value: 'tiktok_shop' },
  { label: 'Lazada', value: 'lazada' },
  { label: 'AccessTrade', value: 'accesstrade' },
];

export default function DealsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('');

  const loadDeals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (platform) params.set('platform', platform);
      const res = await fetch(`/api/products?${params.toString()}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.data)) {
        setProducts(data.data.filter((p: Product) => p.status === 'approved' || p.status === 'published'));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [search, platform]);

  useEffect(() => { loadDeals(); }, [loadDeals]);

  const formatPrice = (p?: number) => p ? p.toLocaleString('vi-VN') + '₫' : '';
  const uniquePlatforms = new Set(products.map(p => p.platform));

  return (
    <>
      <nav className="public-nav">
        <div className="public-nav-inner">
          <Link href="/" className="public-nav-brand">SanDeal</Link>
          <ul className="public-nav-links">
            <li><Link href="/">Trang chủ</Link></li>
            <li><Link href="/deals" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Deals</Link></li>
            <li><Link href="/dashboard" className="btn btn-primary btn-sm">Dashboard</Link></li>
          </ul>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero" style={{ padding: 'var(--space-2xl) var(--space-lg)', textAlign: 'center' }}>
        <div style={{ position: 'relative', zIndex: 1 }}>
          <h1 className="hero-title" style={{ fontSize: 'var(--text-3xl)' }}>
            Deal hot từ <span>SanDeal</span>
          </h1>
          <p className="hero-subtitle" style={{ margin: '0 auto var(--space-lg)', maxWidth: '520px' }}>
            Tổng hợp sản phẩm, khuyến mãi và deal affiliate đã được lọc qua ReviewPilot AI.
          </p>

          <div style={{ maxWidth: '480px', margin: '0 auto var(--space-lg)' }}>
            <input className="input" placeholder="🔍 Tìm sản phẩm, nền tảng, danh mục..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ textAlign: 'center', background: 'rgba(148,163,184,0.06)', border: '1px solid var(--border-secondary)' }} />
          </div>

          <div className="filter-chips" style={{ justifyContent: 'center' }}>
            {FILTER_CHIPS.map(f => (
              <button key={f.value} className={`filter-chip${platform === f.value ? ' active' : ''}`} onClick={() => setPlatform(f.value)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Stats */}
      <div className="deals-stats">
        <div className="deals-stat"><div className="deals-stat-value">{products.length}</div><div className="deals-stat-label">Deal hiển thị</div></div>
        <div className="deals-stat"><div className="deals-stat-value">{uniquePlatforms.size}</div><div className="deals-stat-label">Nền tảng</div></div>
        <div className="deals-stat"><div className="deals-stat-value">{products.filter(p => p.status === 'approved' || p.status === 'published').length}</div><div className="deals-stat-label">Đã duyệt</div></div>
      </div>

      {/* Products */}
      <section className="container" style={{ paddingBottom: 'var(--space-3xl)' }}>
        {loading && <div className="loading-state"><div className="spinner"></div></div>}

        {!loading && products.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <div className="empty-state-title">Không tìm thấy deal</div>
            <div className="empty-state-desc">Thử tìm kiếm khác hoặc xoá bộ lọc.</div>
          </div>
        )}

        {!loading && products.length > 0 && (
          <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
            {products.map(p => (
              <Link href={`/deals/${p.slug}`} key={p.id} className="deal-card" style={{ textDecoration: 'none' }}>
                <div className="deal-card-image">
                  {p.imageUrl ? <img src={p.imageUrl} alt={p.title} /> : (
                    <><span>📦</span><span className="deal-card-placeholder-text">Ảnh đang cập nhật</span></>
                  )}
                  <div className="deal-card-platform"><span className="badge badge-neutral">{PLATFORMS[p.platform] || p.platform}</span></div>
                  {p.score != null && (
                    <div className="deal-card-score">
                      <span className={`score-badge ${p.score >= 75 ? 'score-badge-green' : p.score >= 45 ? 'score-badge-yellow' : 'score-badge-red'}`} style={{ fontSize: '10px', padding: '3px 8px' }}>
                        {p.score}
                      </span>
                    </div>
                  )}
                </div>
                <div className="deal-card-body">
                  <h3 className="deal-card-title">{p.title}</h3>
                  <div className="deal-card-price">
                    {formatPrice(p.salePrice || p.price)}
                    {p.salePrice && p.price && p.price !== p.salePrice && (
                      <span className="deal-card-original-price">{formatPrice(p.price)}</span>
                    )}
                    {p.salePrice && p.price && p.price > p.salePrice && (
                      <span className="deal-card-discount">-{Math.round((1 - p.salePrice / p.price) * 100)}%</span>
                    )}
                  </div>
                  {p.benefits && p.benefits.length > 0 && (
                    <div className="deal-card-chips">
                      {p.benefits.slice(0, 2).map((b, i) => <span key={i} className="deal-card-chip">{b}</span>)}
                    </div>
                  )}
                </div>
                <div className="deal-card-footer">
                  <span className="deal-card-warning">⚡ Giá có thể thay đổi</span>
                  <span className="btn btn-primary btn-sm">Xem deal</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Disclosure */}
      <div className="container">
        <div className="disclosure-banner" style={{ marginBottom: 'var(--space-2xl)' }}>
          📋 Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian. Một số liên kết có thể là liên kết tiếp thị liên kết.
          SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này, nhưng giá của bạn không thay đổi.
        </div>
      </div>

      <footer className="public-footer" style={{ marginTop: 0 }}>
        <div className="public-footer-inner">
          <p className="public-footer-text"><strong>SanDeal</strong> · Powered by ReviewPilot AI</p>
          <ul className="public-footer-links">
            <li><Link href="/">Trang chủ</Link></li>
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="/dashboard">Dashboard</Link></li>
          </ul>
        </div>
      </footer>
    </>
  );
}
