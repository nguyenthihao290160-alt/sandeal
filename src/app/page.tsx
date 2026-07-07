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
                  { label: 'Nguồn dữ liệu', value: 'Sẵn sàng' },
                  { label: 'Bot kiểm link', value: 'Active' },
                  { label: 'Chờ duyệt', value: 'Chặt chẽ' },
                  { label: 'Minh bạch affiliate', value: '100%' },
                ].map(s => (
                  <div key={s.label} style={{ padding: '12px', background: 'rgba(148,163,184,0.06)', borderRadius: '8px', border: '1px solid rgba(148,163,184,0.1)' }}>
                    <div style={{ fontSize: '16px', fontWeight: 800, color: '#a78bfa', marginBottom: '4px' }}>{s.value}</div>
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

      {/* ========== NGUỒN & QUY TRÌNH ========== */}
      <section className="market-section" style={{ background: '#ffffff', borderTop: '1px solid var(--market-border)', paddingTop: 'var(--space-3xl)', paddingBottom: 'var(--space-3xl)' }}>
        <div className="market-container">
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-2xl)' }}>
            <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 800, marginBottom: 'var(--space-xs)', color: 'var(--market-text-main)' }}>Nguồn dữ liệu &amp; quy trình kiểm tra</h2>
            <p style={{ color: 'var(--market-text-muted)' }}>Mọi deal đều phải qua 4 bước kiểm duyệt trước khi hiển thị cho bạn.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-lg)' }}>
            {[
              { t: 'Nguồn sản phẩm thật', d: 'Lấy dữ liệu từ AccessTrade, Shopee, TikTok Shop...', i: '1' },
              { t: 'AI lọc cơ hội', d: 'Loại bỏ deal ảo, chấm điểm rủi ro.', i: '2' },
              { t: 'Kiểm tra link', d: 'Đảm bảo link affiliate an toàn, không bị hỏng.', i: '3' },
              { t: 'Duyệt trước khi public', d: 'Admin kiểm tra lần cuối để đảm bảo chất lượng.', i: '4' },
            ].map(s => (
              <div key={s.t} style={{ background: 'var(--market-bg)', padding: 'var(--space-xl)', borderRadius: '16px', border: '1px solid var(--market-border)' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: 'var(--market-primary)', fontSize: '18px', marginBottom: '16px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>{s.i}</div>
                <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '8px' }}>{s.t}</h3>
                <p style={{ fontSize: '13px', color: 'var(--market-text-muted)', lineHeight: 1.6 }}>{s.d}</p>
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
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#f3f4f6,#eef2ff)', height: '180px' }}>
                          <div style={{ textAlign: 'center' }}>
                            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginBottom: 8 }}>
                              <rect x="2" y="6" width="20" height="12" rx="2" fill="#e6eefc" />
                              <circle cx="8" cy="10" r="3" fill="#dbeafe" />
                              <path d="M3 18 L9 11 L14 16 L21 9" stroke="#cbd5e1" strokeWidth="1.2" fill="none" />
                            </svg>
                            <div style={{ fontSize: 13, color: '#6b7280' }}>Ảnh sản phẩm đang chờ nguồn thật</div>
                          </div>
                        </div>
                      )}
                      {discount > 0 && (
                        <div className="market-discount-badge">Giảm {discount}%</div>
                      )}
                      <div className="market-platform-badge">{PLATFORMS[p.platform] || p.platform}</div>
                    </div>
                    <div className="market-deal-body">
                      {p.title.toLowerCase().includes('demo') || p.title.toLowerCase().includes('test') ? (
                        <div style={{ fontSize: '10px', color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '4px 8px', borderRadius: '4px', display: 'inline-block', marginBottom: '8px', fontWeight: 600 }}>
                          Dữ liệu đang trong giai đoạn kiểm thử nội bộ
                        </div>
                      ) : null}
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
                        {(p.affiliateUrl || p.originalUrl) ? (
                          <a href={p.affiliateUrl || p.originalUrl} target="_blank" rel="noreferrer" className="market-deal-cta" style={{ flex: 1, textAlign: 'center' }}>Xem deal</a>
                        ) : (
                          <span className="market-deal-cta" style={{ flex: 1, textAlign: 'center', opacity: 0.7 }}>Xem deal</span>
                        )}
                        <Link href={`/deals/${p.slug}`} className="market-deal-cta" style={{ background: '#f1f5f9', color: 'var(--market-text-main)' }}>Chi tiết</Link>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
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
