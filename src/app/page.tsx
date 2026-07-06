import Link from 'next/link';
import { getPublishedProducts } from '@/lib/storage/products';
import { PLATFORM_CONFIG } from '@/lib/types/tokenVault';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let products: Awaited<ReturnType<typeof getPublishedProducts>> = [];
  try { 
    const data = await getPublishedProducts(); 
    if (Array.isArray(data)) products = data;
  } catch { /* empty */ }
  const featured = products.slice(0, 10);

  const formatPrice = (p?: number) => p ? p.toLocaleString('vi-VN') + '₫' : '';

  const CATEGORIES = [
    { name: 'Điện tử', icon: '📱' },
    { name: 'Gia dụng', icon: '🏠' },
    { name: 'Thời trang', icon: '👕' },
    { name: 'Làm đẹp', icon: '💄' },
    { name: 'Mẹ & bé', icon: '👶' },
    { name: 'Phụ kiện', icon: '🎧' },
    { name: 'Văn phòng', icon: '📎' },
    { name: 'Deal mới', icon: '✨' },
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
            <span className="market-search-icon">🔍</span>
            <input placeholder="Bạn muốn tìm deal gì hôm nay?" />
          </div>
          <ul className="market-nav-links">
            <li><Link href="/">Trang chủ</Link></li>
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="#how-it-works">Cách hoạt động</Link></li>
            <li><Link href="#disclosure">Minh bạch affiliate</Link></li>
          </ul>
        </div>
      </header>

      {/* Hero */}
      <section className="market-section" style={{ background: 'linear-gradient(180deg, #ffffff 0%, var(--market-bg) 100%)', textAlign: 'center', paddingTop: 'var(--space-4xl)' }}>
        <div className="market-container">
          <h1 style={{ fontSize: 'var(--text-4xl)', fontWeight: 900, marginBottom: 'var(--space-md)', letterSpacing: '-0.03em' }}>
            SanDeal — săn deal thông minh bằng AI
          </h1>
          <p style={{ fontSize: 'var(--text-lg)', color: 'var(--market-text-muted)', maxWidth: '640px', margin: '0 auto var(--space-xl)', lineHeight: 1.6 }}>
            Tổng hợp sản phẩm đáng mua, ưu đãi nổi bật và thông tin minh bạch trước khi bạn bấm mua.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-md)' }}>
            <Link href="/deals" className="btn" style={{ background: 'var(--gradient-accent)', color: '#fff', fontSize: 'var(--text-base)', padding: '12px 32px' }}>
              🔥 Xem deal hot
            </Link>
            <Link href="#how-it-works" className="btn" style={{ background: '#ffffff', color: 'var(--market-text-main)', border: '1px solid var(--market-border)', fontSize: 'var(--text-base)', padding: '12px 32px' }}>
              Tìm hiểu cách hoạt động
            </Link>
          </div>

          {/* Categories Shortcuts */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-md)', flexWrap: 'wrap', marginTop: 'var(--space-3xl)' }}>
            {CATEGORIES.map(c => (
              <Link href="/deals" key={c.name} style={{ background: '#ffffff', border: '1px solid var(--market-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-md) var(--space-lg)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textDecoration: 'none', color: 'var(--market-text-main)', transition: 'all var(--transition-fast)', minWidth: '100px' }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--market-primary)'}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--market-border)'}
              >
                <span style={{ fontSize: '28px' }}>{c.icon}</span>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{c.name}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Deals */}
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
              <div style={{ fontSize: '48px', marginBottom: 'var(--space-md)' }}>🛍️</div>
              <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, marginBottom: 'var(--space-xs)' }}>Chưa có deal nào</h3>
              <p style={{ color: 'var(--market-text-muted)' }}>Các deal nổi bật sẽ xuất hiện ở đây khi có sản phẩm được duyệt.</p>
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
                          <span className="market-deal-placeholder-icon">📦</span>
                          <span className="market-deal-placeholder-text">Ảnh đang cập nhật</span>
                        </div>
                      )}
                      {discount > 0 && (
                        <div className="market-discount-badge">Giảm {discount}%</div>
                      )}
                      <div className="market-platform-badge">{p.platform}</div>
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
                        ⚡ Giá có thể thay đổi
                      </div>
                      <span className="market-deal-cta">Xem deal</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Trust & How it works */}
      <section id="how-it-works" className="market-section" style={{ background: '#ffffff', borderTop: '1px solid var(--market-border)', borderBottom: '1px solid var(--market-border)' }}>
        <div className="market-container">
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-3xl)' }}>
            <h2 className="market-section-title">Cách SanDeal hoạt động</h2>
            <p className="market-section-subtitle">Quy trình 4 bước để tìm deal tốt nhất, minh bạch và an toàn</p>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-xl)', textAlign: 'center' }}>
            {[
              { n: '1', t: 'Tìm sản phẩm', d: 'Tổng hợp từ Shopee, TikTok Shop, Lazada, AccessTrade và nhiều nguồn.' },
              { n: '2', t: 'Lọc ưu đãi', d: 'Hệ thống tự động so sánh giá và lọc ra những ưu đãi thực sự tốt.' },
              { n: '3', t: 'Chấm điểm cơ hội', d: 'AI đánh giá chất lượng, rủi ro và độ uy tín của sản phẩm.' },
              { n: '4', t: 'Xem deal minh bạch', d: 'Hiển thị đầy đủ thông tin, điểm số và cảnh báo trước khi bạn mua.' },
            ].map(s => (
              <div key={s.n}>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--gradient-subtle)', color: 'var(--market-primary)', fontSize: 'var(--text-xl)', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto var(--space-md)' }}>
                  {s.n}
                </div>
                <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, marginBottom: 'var(--space-xs)' }}>{s.t}</h3>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--market-text-muted)' }}>{s.d}</p>
              </div>
            ))}
          </div>

          <div className="trust-cards-grid">
            {[
              { t: 'Cập nhật deal', d: 'Làm mới thường xuyên để bạn dễ thấy ưu đãi nổi bật.', i: '⚡' },
              { t: 'Link minh bạch', d: 'Một số liên kết có thể là affiliate, nhưng giá của bạn không đổi.', i: '🔗' },
              { t: 'Ưu tiên sản phẩm đáng mua', d: 'Sản phẩm được lọc theo giá, lợi ích và độ phù hợp.', i: '⭐' },
              { t: 'So sánh nhanh', d: 'Xem giá, ưu điểm và ghi chú trước khi mua.', i: '⚖️' },
            ].map(s => (
              <div key={s.t} className="trust-card">
                <div className="trust-card-icon">{s.i}</div>
                <div className="trust-card-title">{s.t}</div>
                <div className="trust-card-desc">{s.d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Affiliate Disclosure */}
      <section id="disclosure" className="market-section">
        <div className="market-container" style={{ maxWidth: '800px' }}>
          <div className="market-affiliate-note">
            <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--market-text-main)', marginBottom: 'var(--space-sm)' }}>📋 Minh bạch Affiliate</h3>
            Một số liên kết trên SanDeal có thể là liên kết tiếp thị liên kết (affiliate). SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này, nhưng <strong>giá của bạn không thay đổi</strong>. Chúng tôi cam kết chỉ giới thiệu sản phẩm đã được đánh giá và kiểm duyệt.
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
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="#how-it-works">Cách hoạt động</Link></li>
            <li><Link href="#disclosure">Minh bạch affiliate</Link></li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
