import Link from 'next/link';
import { getPublishedProducts } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

const PLATFORMS: Record<string, string> = {
  shopee: 'Shopee', tiktok_shop: 'TikTok Shop', lazada: 'Lazada',
  accesstrade: 'AccessTrade', website: 'Website', other: 'Khác',
};

export default async function HomePage() {
  let products: Awaited<ReturnType<typeof getPublishedProducts>> = [];
  try { 
    const data = await getPublishedProducts(); 
    if (Array.isArray(data)) products = data;
  } catch { /* empty */ }
  const featured = products.slice(0, 10);

  const formatPrice = (p?: number) => p ? p.toLocaleString('vi-VN') + '₫' : '';

  const CATEGORIES = [
    { name: 'Điện tử', icon: 'E' },
    { name: 'Gia dụng', icon: 'G' },
    { name: 'Thời trang', icon: 'T' },
    { name: 'Làm đẹp', icon: 'L' },
    { name: 'Mẹ & bé', icon: 'M' },
    { name: 'Phụ kiện', icon: 'P' },
    { name: 'Văn phòng', icon: 'V' },
    { name: 'Deal mới', icon: 'N' },
  ];

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
            <span className="market-search-icon" style={{ fontSize: '14px', opacity: 0.5 }}>&#x2315;</span>
            <input placeholder="Bạn muốn tìm deal gì hôm nay?" />
          </div>
          <ul className="market-nav-links">
            <li><Link href="/">Trang chủ</Link></li>
            <li><Link href="/deals">Deal hot</Link></li>
            <li><Link href="/deals">Danh mục</Link></li>
            <li><Link href="#how-it-works">Cách hoạt động</Link></li>
            <li><Link href="#disclosure">Minh bạch affiliate</Link></li>
          </ul>
        </div>
      </header>

      {/* ========== HERO ========== */}
      <section className="market-section" style={{ background: 'linear-gradient(180deg, #ffffff 0%, var(--market-bg) 100%)', paddingTop: 'var(--space-4xl)', paddingBottom: 'var(--space-3xl)' }}>
        <div className="market-container">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3xl)', alignItems: 'center' }}>
            {/* Left */}
            <div>
              <h1 style={{ fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 900, marginBottom: 'var(--space-md)', letterSpacing: '-0.03em', lineHeight: 1.15, color: 'var(--market-text-main)' }}>
                Săn Deal Thông Minh,<br/>Nhanh &amp; Minh Bạch
              </h1>
              <p style={{ fontSize: 'var(--text-base)', color: 'var(--market-text-muted)', maxWidth: '480px', lineHeight: 1.7, marginBottom: 'var(--space-lg)' }}>
                SanDeal tổng hợp sản phẩm đáng mua, ưu đãi nổi bật và thông tin affiliate minh bạch để bạn dễ so sánh trước khi bấm mua.
              </p>
              {/* Trust chips */}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: 'var(--space-xl)' }}>
                {['AI Verified', 'Link minh bạch', 'Giá thật', 'Kiểm duyệt'].map(c => (
                  <span key={c} style={{ padding: '5px 12px', borderRadius: '16px', fontSize: '11px', fontWeight: 600, background: 'rgba(79, 70, 229, 0.08)', color: '#6366f1', border: '1px solid rgba(79, 70, 229, 0.15)' }}>{c}</span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
                <Link href="/deals" className="btn" style={{ background: 'var(--gradient-accent)', color: '#fff', fontSize: 'var(--text-base)', padding: '14px 32px', fontWeight: 700 }}>
                  Xem deal hot
                </Link>
                <Link href="#how-it-works" className="btn" style={{ background: '#ffffff', color: 'var(--market-text-main)', border: '1px solid var(--market-border)', fontSize: 'var(--text-base)', padding: '14px 32px' }}>
                  Cách hoạt động
                </Link>
              </div>
            </div>

            {/* Right — AI Intelligence Card */}
            <div style={{ background: '#0f172a', borderRadius: '16px', padding: '28px', color: '#f8fafc', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }} />
              <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b', fontWeight: 700, marginBottom: '16px' }}>
                AI DEAL INTELLIGENCE
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                {[
                  { label: 'Sản phẩm AI đã quét', value: `${products.length}+` },
                  { label: 'Nguồn được hỗ trợ', value: '5+' },
                  { label: 'Kiểm duyệt tự động', value: 'ON' },
                  { label: 'Link đã xác minh', value: `${products.length}` },
                ].map(s => (
                  <div key={s.label} style={{ padding: '12px', background: 'rgba(148,163,184,0.06)', borderRadius: '8px', border: '1px solid rgba(148,163,184,0.1)' }}>
                    <div style={{ fontSize: '18px', fontWeight: 800, color: '#a78bfa', marginBottom: '2px' }}>{s.value}</div>
                    <div style={{ fontSize: '10px', color: '#64748b' }}>{s.label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '6px', fontSize: '10px' }}>
                <span style={{ padding: '3px 8px', borderRadius: '8px', background: 'rgba(16,185,129,0.15)', color: '#34d399', fontWeight: 600 }}>Safe Mode</span>
                <span style={{ padding: '3px 8px', borderRadius: '8px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontWeight: 600 }}>Free Only</span>
                <span style={{ padding: '3px 8px', borderRadius: '8px', background: 'rgba(148,163,184,0.1)', color: '#94a3b8', fontWeight: 600 }}>Auto Publish: OFF</span>
              </div>
            </div>
          </div>

          {/* Categories */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-md)', flexWrap: 'wrap', marginTop: 'var(--space-3xl)' }}>
            {CATEGORIES.map(c => (
              <Link href="/deals" key={c.name} className="market-category-card" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '28px', height: '28px', borderRadius: '8px', background: 'rgba(79, 70, 229, 0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#6366f1' }}>{c.icon}</span>
                <span style={{ fontSize: '14px', fontWeight: 600 }}>{c.name}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ========== SUPPORTED SOURCES ========== */}
      <section className="market-section" style={{ background: '#ffffff', borderTop: '1px solid var(--market-border)', paddingTop: 'var(--space-2xl)', paddingBottom: 'var(--space-2xl)' }}>
        <div className="market-container" style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--market-text-muted)', fontWeight: 700, marginBottom: 'var(--space-lg)' }}>
            Nguồn dữ liệu đang hỗ trợ
          </h2>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-2xl)', flexWrap: 'wrap' }}>
            {['Shopee', 'TikTok Shop', 'Lazada', 'AccessTrade'].map(s => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--market-text-muted)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
                {s}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ========== FEATURED DEALS ========== */}
      <section className="market-section">
        <div className="market-container">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 'var(--space-xl)' }}>
            <div>
              <h2 className="market-section-title">Deal nổi bật hôm nay</h2>
              <p className="market-section-subtitle" style={{ marginBottom: 0 }}>Sản phẩm đã được duyệt qua hệ thống AI</p>
            </div>
            <Link href="/deals" style={{ color: 'var(--market-primary)', fontWeight: 600, textDecoration: 'none' }}>Xem tất cả →</Link>
          </div>

          {featured.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 'var(--space-4xl) 0', background: '#ffffff', borderRadius: 'var(--radius-xl)', border: '1px dashed var(--market-border)' }}>
              <div style={{ fontSize: '32px', marginBottom: 'var(--space-md)', color: '#d1d5db', fontWeight: 700 }}>S</div>
              <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, marginBottom: 'var(--space-xs)' }}>Chưa có deal thật đã duyệt</h3>
              <p style={{ color: 'var(--market-text-muted)', maxWidth: '480px', margin: '0 auto' }}>Hệ thống đang chờ nguồn sản phẩm từ AccessTrade hoặc nguồn nội bộ. Các deal sẽ xuất hiện ở đây sau khi được kiểm duyệt.</p>
            </div>
          ) : (
            <div className="deal-grid">
              {featured.map(p => {
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
                          <span className="market-deal-placeholder-text">Ảnh sản phẩm đang chờ nguồn thật</span>
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
                        {p.benefits?.slice(0, 2).map((b, i) => (
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
        </div>
      </section>

      {/* ========== HOW AI FILTERS ========== */}
      <section id="how-it-works" className="market-section" style={{ background: '#ffffff', borderTop: '1px solid var(--market-border)', borderBottom: '1px solid var(--market-border)' }}>
        <div className="market-container">
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-3xl)' }}>
            <h2 className="market-section-title">Cách bot AI lọc deal cho bạn</h2>
            <p className="market-section-subtitle">Quy trình 4 bước để tìm deal tốt nhất, minh bạch và an toàn</p>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-xl)', textAlign: 'center' }}>
            {[
              { n: '1', t: 'Quét nguồn', d: 'Bot tự động quét sản phẩm từ Shopee, TikTok Shop, Lazada, AccessTrade.' },
              { n: '2', t: 'Lọc & phân tích', d: 'AI phân tích giá, lợi ích, rủi ro và chấm điểm cơ hội cho từng deal.' },
              { n: '3', t: 'Kiểm duyệt', d: 'Sản phẩm qua kiểm duyệt nội dung, link và tuân thủ trước khi hiển thị.' },
              { n: '4', t: 'Xem deal minh bạch', d: 'Hiển thị đầy đủ thông tin, điểm số và cảnh báo trước khi bạn mua.' },
            ].map(s => (
              <div key={s.n}>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--gradient-subtle)', color: 'var(--market-primary)', fontSize: 'var(--text-xl)', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto var(--space-md)' }}>
                  {s.n}
                </div>
                <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, marginBottom: 'var(--space-xs)' }}>{s.t}</h3>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--market-text-muted)', lineHeight: 1.6 }}>{s.d}</p>
              </div>
            ))}
          </div>

          <div className="trust-cards-grid" style={{ marginTop: 'var(--space-3xl)' }}>
            {[
              { t: 'Cập nhật deal', d: 'Làm mới thường xuyên để bạn dễ thấy ưu đãi nổi bật.' },
              { t: 'Link minh bạch', d: 'Một số liên kết có thể là affiliate, nhưng giá của bạn không đổi.' },
              { t: 'Ưu tiên sản phẩm đáng mua', d: 'Sản phẩm được lọc theo giá, lợi ích và độ phù hợp.' },
              { t: 'So sánh nhanh', d: 'Xem giá, ưu điểm và ghi chú trước khi mua.' },
            ].map(s => (
              <div key={s.t} className="trust-card">
                <div className="trust-card-title">{s.t}</div>
                <div className="trust-card-desc">{s.d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ========== AFFILIATE DISCLOSURE ========== */}
      <section id="disclosure" className="market-section">
        <div className="market-container" style={{ maxWidth: '800px' }}>
          <div className="market-affiliate-note">
            <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--market-text-main)', marginBottom: 'var(--space-sm)' }}>Minh bạch Affiliate</h3>
            Một số liên kết trên SanDeal có thể là liên kết tiếp thị liên kết (affiliate). SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này, nhưng <strong>giá của bạn không thay đổi</strong>. Chúng tôi cam kết chỉ giới thiệu sản phẩm đã được đánh giá và kiểm duyệt.
          </div>
          <div className="market-affiliate-note" style={{ marginTop: 'var(--space-md)' }}>
            <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--market-text-main)', marginBottom: 'var(--space-sm)' }}>Lưu ý về giá</h3>
            Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian. SanDeal không đảm bảo giá hiển thị là giá cuối cùng tại thời điểm bạn mua. Vui lòng kiểm tra trên trang gốc trước khi quyết định.
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="market-footer">
        <div className="market-container market-footer-inner">
          <Link href="/" className="market-logo" style={{ fontSize: 'var(--text-xl)', display: 'inline-block', marginBottom: 'var(--space-md)' }}>SanDeal</Link>
          <p style={{ color: 'var(--market-text-muted)', fontSize: 'var(--text-sm)', maxWidth: '400px', margin: '0 auto' }}>
            Săn deal thông minh. Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian.
          </p>
          <ul className="market-footer-links">
            <li><Link href="/">SanDeal</Link></li>
            <li><Link href="/deals">Deal hot</Link></li>
            <li><Link href="/deals">Danh mục</Link></li>
            <li><Link href="#how-it-works">Cách hoạt động</Link></li>
            <li><Link href="#disclosure">Minh bạch affiliate</Link></li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
