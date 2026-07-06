import Link from 'next/link';
import { getPublishedProducts } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let products: Awaited<ReturnType<typeof getPublishedProducts>> = [];
  try { products = await getPublishedProducts(); } catch { /* empty */ }
  const featured = products.slice(0, 6);

  const formatPrice = (p?: number) => p ? p.toLocaleString('vi-VN') + '₫' : '';

  return (
    <>
      {/* Navbar */}
      <nav className="public-nav">
        <div className="public-nav-inner">
          <Link href="/" className="public-nav-brand">SanDeal</Link>
          <ul className="public-nav-links">
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="#how-it-works">Cách hoạt động</Link></li>
            <li><Link href="#disclosure">Minh bạch affiliate</Link></li>
            <li><Link href="/dashboard" className="btn btn-primary btn-sm">Dashboard</Link></li>
          </ul>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-text">
            <h1 className="hero-title">
              <span>SanDeal</span> — săn deal<br />thông minh bằng AI
            </h1>
            <p className="hero-subtitle">
              Tìm sản phẩm đáng mua, lọc ưu đãi tốt và minh bạch liên kết affiliate bằng ReviewPilot AI.
            </p>
            <div className="hero-actions">
              <Link href="/deals" className="btn btn-primary btn-lg">🔥 Xem deal hot</Link>
              <Link href="/dashboard" className="btn btn-secondary btn-lg">📊 Vào Dashboard</Link>
            </div>
          </div>
          <div className="hero-visual">
            <div className="dash-preview">
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-primary-light)', marginBottom: '8px' }}>Revenue Radar</div>
              <div className="dash-preview-row">
                <span className="dash-preview-label">Sản phẩm</span>
                <span className="dash-preview-value">{products.length}</span>
              </div>
              <div className="dash-preview-row">
                <span className="dash-preview-label">Nên làm ngay</span>
                <span className="dash-preview-value" style={{ color: 'var(--color-success)' }}>
                  {products.filter(p => (p.score ?? 0) >= 75).length}
                </span>
              </div>
              <div className="dash-preview-row">
                <span className="dash-preview-label">Nền tảng</span>
                <span className="dash-preview-value">{new Set(products.map(p => p.platform)).size}</span>
              </div>
              <div className="dash-preview-row">
                <span className="dash-preview-label">Safe Mode</span>
                <span className="badge badge-success" style={{ fontSize: '9px', padding: '2px 6px' }}>ON</span>
              </div>
              <div className="dash-preview-row">
                <span className="dash-preview-label">Auto Publish</span>
                <span className="badge badge-neutral" style={{ fontSize: '9px', padding: '2px 6px' }}>OFF</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Strip */}
      <div className="trust-strip">
        <div className="trust-item"><span className="trust-item-icon">🔍</span> Minh bạch affiliate</div>
        <div className="trust-item"><span className="trust-item-icon">💰</span> Giá có thể thay đổi</div>
        <div className="trust-item"><span className="trust-item-icon">⭐</span> Ưu tiên sản phẩm đáng mua</div>
        <div className="trust-item"><span className="trust-item-icon">🤖</span> Powered by ReviewPilot AI</div>
      </div>

      {/* How it works */}
      <section id="how-it-works" style={{ padding: 'var(--space-3xl) var(--space-lg)', textAlign: 'center' }}>
        <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, marginBottom: 'var(--space-sm)', letterSpacing: '-0.02em' }}>Cách hoạt động</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-2xl)' }}>Quy trình 4 bước để tìm deal tốt nhất</p>
        <div className="hiw-steps">
          {[
            { n: '1', t: 'Tìm sản phẩm', d: 'Tổng hợp từ Shopee, TikTok Shop, Lazada, AccessTrade và nhiều nguồn khác.' },
            { n: '2', t: 'Chấm điểm cơ hội', d: 'AI đánh giá chất lượng, rủi ro và tiềm năng của từng sản phẩm.' },
            { n: '3', t: 'Duyệt & kiểm tra', d: 'Kiểm duyệt từ ngữ, xác minh thông tin và đảm bảo minh bạch.' },
            { n: '4', t: 'Xuất deal / nội dung', d: 'Tạo bài viết, caption, script video và xuất bản an toàn.' },
          ].map(s => (
            <div className="hiw-step" key={s.n}>
              <div className="hiw-step-number">{s.n}</div>
              <h3 className="hiw-step-title">{s.t}</h3>
              <p className="hiw-step-desc">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Featured Deals */}
      {featured.length > 0 && (
        <section style={{ padding: '0 var(--space-lg) var(--space-3xl)' }}>
          <div className="container">
            <div style={{ textAlign: 'center', marginBottom: 'var(--space-2xl)' }}>
              <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 'var(--space-sm)' }}>Deal nổi bật</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>Sản phẩm đã được duyệt qua ReviewPilot AI</p>
            </div>
            <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
              {featured.map(p => (
                <Link href={`/deals/${p.slug}`} key={p.id} className="deal-card" style={{ textDecoration: 'none' }}>
                  <div className="deal-card-image">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt={p.title} />
                    ) : (
                      <>
                        <span>📦</span>
                        <span className="deal-card-placeholder-text">Ảnh đang cập nhật</span>
                      </>
                    )}
                    <div className="deal-card-platform"><span className="badge badge-neutral">{p.platform}</span></div>
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
                    </div>
                  </div>
                  <div className="deal-card-footer">
                    <span className="deal-card-warning">⚡ Giá có thể thay đổi</span>
                    <span className="btn btn-primary btn-sm">Xem deal</span>
                  </div>
                </Link>
              ))}
            </div>
            <div style={{ textAlign: 'center', marginTop: 'var(--space-xl)' }}>
              <Link href="/deals" className="btn btn-secondary btn-lg">Xem tất cả deal →</Link>
            </div>
          </div>
        </section>
      )}

      {/* Disclosure */}
      <section id="disclosure" style={{ padding: 'var(--space-2xl) var(--space-lg)', borderTop: '1px solid var(--border-primary)' }}>
        <div className="container" style={{ textAlign: 'center', maxWidth: '640px' }}>
          <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, marginBottom: 'var(--space-md)' }}>📋 Minh bạch Affiliate</h3>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            SanDeal có thể nhận hoa hồng khi bạn mua sản phẩm qua các liên kết trên trang này. Giá của bạn không thay đổi.
            Chúng tôi cam kết chỉ giới thiệu sản phẩm đã được đánh giá và kiểm duyệt qua hệ thống ReviewPilot AI.
            Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="public-footer">
        <div className="public-footer-inner">
          <p className="public-footer-text"><strong>SanDeal</strong> · Powered by ReviewPilot AI</p>
          <p className="public-footer-disclosure">
            Giá, tồn kho và ưu đãi có thể thay đổi. Một số liên kết có thể là liên kết tiếp thị liên kết.
          </p>
          <ul className="public-footer-links">
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="#disclosure">Affiliate Disclosure</Link></li>
            <li><Link href="/dashboard">Dashboard</Link></li>
          </ul>
        </div>
      </footer>
    </>
  );
}
