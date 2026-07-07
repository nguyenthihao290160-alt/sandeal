'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Product } from '@/lib/types';

const PLATFORMS: Record<string, string> = {
  shopee: 'Shopee', tiktok_shop: 'TikTok Shop', lazada: 'Lazada',
  accesstrade: 'AccessTrade', website: 'Website', other: 'Khác',
};

const CATEGORIES = [
  { label: 'Tất cả', value: '' },
  { label: 'Shopee', value: 'shopee' },
  { label: 'TikTok Shop', value: 'tiktok_shop' },
  { label: 'Lazada', value: 'lazada' },
  { label: 'AccessTrade', value: 'accesstrade' },
  { label: 'Giá tốt', value: 'gia_tot' },
  { label: 'Deal mới', value: 'deal_moi' },
  { label: 'Nên xem', value: 'nen_xem' },
];

const FILTERS = [
  { label: 'Bộ lọc', value: '' },
  { label: 'Có ảnh', value: 'has_image' },
  { label: 'Đã duyệt', value: 'approved' },
  { label: 'Giá tốt', value: 'good_price' },
  { label: 'Nên làm ngay', value: 'do_now' },
  { label: 'Cần xác minh', value: 'verify' },
  { label: 'Shopee', value: 'shopee' },
  { label: 'TikTok Shop', value: 'tiktok_shop' },
  { label: 'Lazada', value: 'lazada' },
  { label: 'AccessTrade', value: 'accesstrade' },
];

const SORTS = [
  { label: 'Phổ biến', value: 'popular' },
  { label: 'Khuyến mãi HOT', value: 'hot_sale' },
  { label: 'Deal mới', value: 'newest' },
  { label: 'Giá thấp - cao', value: 'price_asc' },
  { label: 'Giá cao - thấp', value: 'price_desc' },
  { label: 'Điểm tốt nhất', value: 'score_desc' },
];

export default function DealsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Search & Filter state
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [activeSort, setActiveSort] = useState('popular');

  const loadDeals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (platform) params.set('platform', platform);
      
      const res = await fetch(`/api/products?${params.toString()}`);
      const data = await res.json();
      
      if (data.ok && Array.isArray(data.data)) {
        let list = data.data.filter((p: Product) => p.status === 'approved' || p.status === 'published');
        
        // Client-side filtering for UI mock
        if (activeFilter === 'has_image') list = list.filter((p: Product) => !!p.imageUrl);
        if (activeFilter === 'high_score') list = list.filter((p: Product) => (p.score ?? 0) >= 75);
        if (activeFilter === 'good_price') list = list.filter((p: Product) => p.salePrice && p.price && p.salePrice < p.price);
        
        // Client-side sorting for UI mock
        if (activeSort === 'price_asc') list.sort((a: Product, b: Product) => (a.salePrice || a.price || 0) - (b.salePrice || b.price || 0));
        if (activeSort === 'price_desc') list.sort((a: Product, b: Product) => (b.salePrice || b.price || 0) - (a.salePrice || a.price || 0));
        if (activeSort === 'score_desc') list.sort((a: Product, b: Product) => (b.score ?? 0) - (a.score ?? 0));
        // Newest could use createdAt, assuming ID is chronological or use createdAt if available

        setProducts(list);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [search, platform, activeFilter, activeSort]);

  useEffect(() => { loadDeals(); }, [loadDeals]);

  const formatPrice = (p?: number) => p ? p.toLocaleString('vi-VN') + '₫' : '';

  return (
    <div className="market-shell">
      {/* Top Announcement */}
      <div className="top-announcement">
        <div>Deal mới mỗi ngày — So sánh nhanh — Link minh bạch</div>
        <div className="top-announcement-right">Giá và ưu đãi có thể thay đổi</div>
      </div>

      {/* Header */}
      <header className="market-header">
        <div className="market-container market-header-inner">
          <Link href="/" className="market-logo">SanDeal</Link>
          <div className="market-search">
            <span className="market-search-icon" style={{ fontSize: '14px', opacity: 0.5 }}>⌕</span>
            <input 
              placeholder="Bạn muốn tìm deal gì hôm nay?" 
              value={search} 
              onChange={e => setSearch(e.target.value)} 
              onKeyDown={e => e.key === 'Enter' && loadDeals()}
            />
          </div>
          <ul className="market-nav-links">
            <li><Link href="/">Trang chủ</Link></li>
            <li><Link href="/deals" style={{ color: 'var(--market-primary)' }}>Deal hot</Link></li>
            <li><Link href="/deals">Danh mục</Link></li>
            <li><Link href="/#how-it-works">Cách hoạt động</Link></li>
            <li><Link href="/#disclosure">Minh bạch affiliate</Link></li>
          </ul>
        </div>
      </header>

      {/* Main Content */}
      <main className="market-container" style={{ padding: 'var(--space-2xl) var(--space-lg)' }}>
        
        {/* Navigation / Filters / Sorting Block */}
        <div style={{ background: '#ffffff', border: '1px solid var(--market-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-lg)', marginBottom: 'var(--space-2xl)' }}>
          
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <h3 style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--market-text-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '8px' }}>Nền tảng</h3>
            <div className="market-chips-row">
              {CATEGORIES.map(c => (
                <button key={c.value} className={`market-chip${platform === c.value ? ' active' : ''}`} onClick={() => setPlatform(c.value)}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xl)' }}>
            <div>
              <h3 style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--market-text-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '8px' }}>Lọc theo tiêu chí</h3>
              <div className="market-chips-row">
                <button className={`market-chip${activeFilter === '' ? ' active' : ''}`} onClick={() => setActiveFilter('')}>Tất cả</button>
                {FILTERS.map(f => (
                  <button key={f.value} className={`market-chip${activeFilter === f.value ? ' active' : ''}`} onClick={() => setActiveFilter(f.value)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h3 style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--market-text-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '8px' }}>Sắp xếp theo</h3>
              <div className="market-chips-row">
                {SORTS.map(s => (
                  <button key={s.value} className={`market-chip${activeSort === s.value ? ' active' : ''}`} onClick={() => setActiveSort(s.value)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Product Grid */}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-4xl)' }}>
            <div className="spinner" style={{ borderColor: 'var(--market-border)', borderTopColor: 'var(--market-primary)' }}></div>
          </div>
        )}

        {!loading && products.length === 0 && (
          <div style={{ textAlign: 'center', padding: 'var(--space-4xl) 0', background: '#ffffff', borderRadius: 'var(--radius-xl)', border: '1px dashed var(--market-border)' }}>
            <div style={{ fontSize: '32px', marginBottom: 'var(--space-md)', opacity: 0.3, fontWeight: 700 }}>S</div>
            <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, marginBottom: 'var(--space-xs)' }}>Không tìm thấy deal</h3>
            <p style={{ color: 'var(--market-text-muted)' }}>Thử tìm kiếm khác hoặc xoá bộ lọc.</p>
            <button className="btn" style={{ marginTop: 'var(--space-md)', background: 'var(--market-bg)', border: '1px solid var(--market-border)' }} onClick={() => { setSearch(''); setPlatform(''); setActiveFilter(''); }}>
              Xoá bộ lọc
            </button>
          </div>
        )}

        {!loading && products.length > 0 && (
          <div className="deal-grid">
            {products.map(p => {
              const discount = (p.salePrice && p.price && p.price > p.salePrice) 
                ? Math.round((1 - p.salePrice / p.price) * 100) 
                : 0;

              return (
                <Link href={`/deals/${p.slug}`} key={p.id} className="market-deal-card">
                  <div className="market-deal-image-wrapper">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt={p.title} />
                    ) : (
                      <div className="market-deal-placeholder">
                        <span className="market-deal-placeholder-text">Ảnh đang cập nhật</span>
                      </div>
                    )}
                    {discount > 0 && (
                      <div className="market-discount-badge">Giảm {discount}%</div>
                    )}
                    <div className="market-platform-badge">{PLATFORMS[p.platform] || p.platform}</div>
                  </div>
                  <div className="market-deal-body">
                    <h3 className="market-deal-title">{p.title}</h3>
                    <div className="market-deal-price-row">
                      <span className="market-price-current">{formatPrice(p.salePrice || p.price)}</span>
                      {p.salePrice && p.price && p.price !== p.salePrice && (
                        <span className="market-price-original">{formatPrice(p.price)}</span>
                      )}
                    </div>
                    <div className="market-deal-benefits">
                      {Array.isArray(p.benefits) && p.benefits.slice(0, 3).map((b, i) => (
                        <span key={i} className="market-benefit-chip">{b}</span>
                      ))}
                    </div>
                    <div className="market-warning-pill">
                      Giá có thể thay đổi
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: 'var(--space-sm)' }}>
                      <span className="market-deal-cta" style={{ flex: 1, textAlign: 'center' }}>Xem deal</span>
                      <span className="market-deal-cta" style={{ background: '#f1f5f9', color: 'var(--market-text-main)' }}>Chi tiết</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="market-footer">
        <div className="market-container market-footer-inner">
          <div className="market-affiliate-note" style={{ maxWidth: '800px', margin: '0 auto var(--space-2xl)' }}>
            <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--market-text-main)', marginBottom: 'var(--space-sm)' }}>Minh bạch Affiliate</h3>
            Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian. Một số liên kết có thể là liên kết tiếp thị liên kết. SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này, nhưng <strong>giá của bạn không thay đổi</strong>.
          </div>
          
          <Link href="/" className="market-logo" style={{ fontSize: 'var(--text-xl)', display: 'inline-block', marginBottom: 'var(--space-md)' }}>SanDeal</Link>
          <ul className="market-footer-links">
            <li><Link href="/">SanDeal</Link></li>
            <li><Link href="/deals">Deal hot</Link></li>
            <li><Link href="/deals">Danh mục</Link></li>
            <li><Link href="/#how-it-works">Cách hoạt động</Link></li>
            <li><Link href="/#disclosure">Minh bạch affiliate</Link></li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
