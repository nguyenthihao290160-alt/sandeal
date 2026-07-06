import Link from 'next/link';
import { getPublishedProducts } from '@/lib/storage/products';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SanDeal — Săn deal thông minh bằng AI',
  description: 'Tìm sản phẩm đáng mua, kiểm tra ưu đãi và chuẩn bị nội dung affiliate an toàn, minh bạch. Powered by ReviewPilot AI.',
};

export default async function HomePage() {
  const products = await getPublishedProducts();
  const approvedProducts = products.slice(0, 6);

  return (
    <>
      {/* Navigation */}
      <nav className="public-nav">
        <div className="public-nav-inner">
          <Link href="/" className="public-nav-brand">SanDeal</Link>
          <ul className="public-nav-links">
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="/dashboard" className="btn btn-primary btn-sm">Dashboard</Link></li>
          </ul>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero" style={{ padding: '80px 24px 64px' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto', display: 'flex', alignItems: 'center', gap: '48px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 480px', textAlign: 'left', maxWidth: '600px', position: 'relative', zIndex: 1 }}>
            <h1 className="hero-title" style={{ textAlign: 'left', marginBottom: '16px' }}>
              <span>SanDeal</span> — săn deal thông minh bằng AI
            </h1>
            <p className="hero-subtitle" style={{ textAlign: 'left', margin: '0 0 32px' }}>
              Tìm sản phẩm đáng mua, kiểm tra ưu đãi và chuẩn bị nội dung affiliate an toàn, minh bạch.
            </p>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <Link href="/deals" className="btn btn-primary btn-lg">🔥 Xem deal hot</Link>
              <Link href="/dashboard" className="btn btn-secondary btn-lg">📊 Vào Dashboard</Link>
            </div>
          </div>
          <div className="dash-preview" style={{ position: 'relative', zIndex: 1 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }}></span>
              Dashboard Preview
            </div>
            <div className="dash-preview-row">
              <span className="dash-preview-label">Sản phẩm đã lọc</span>
              <span className="dash-preview-value">{products.length > 0 ? products.length : '—'}</span>
            </div>
            <div className="dash-preview-row">
              <span className="dash-preview-label">Deal cần xác minh</span>
              <span className="dash-preview-value" style={{ color: 'var(--color-warning)' }}>0</span>
            </div>
            <div className="dash-preview-row">
              <span className="dash-preview-label">Nội dung sẵn sàng</span>
              <span className="dash-preview-value">0</span>
            </div>
            <div className="dash-preview-row">
              <span className="dash-preview-label">Safe Mode</span>
              <span className="safe-badge safe-badge-on" style={{ fontSize: '10px', padding: '2px 8px' }}>ON</span>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Strip */}
      <div className="trust-strip">
        <div className="trust-item">
          <span className="trust-item-icon">🛡️</span>
          <span>Minh bạch affiliate</span>
        </div>
        <div className="trust-item">
          <span className="trust-item-icon">💰</span>
          <span>Giá có thể thay đổi</span>
        </div>
        <div className="trust-item">
          <span className="trust-item-icon">⭐</span>
          <span>Ưu tiên sản phẩm đáng mua</span>
        </div>
        <div className="trust-item">
          <span className="trust-item-icon">🤖</span>
          <span>Powered by ReviewPilot AI</span>
        </div>
      </div>

      {/* How It Works */}
      <section style={{ padding: '64px 24px', background: 'var(--bg-primary)' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
          <h2 className="section-title" style={{ textAlign: 'center', fontSize: 'var(--text-2xl)', marginBottom: '8px' }}>Cách hoạt động</h2>
          <p className="section-subtitle" style={{ textAlign: 'center', maxWidth: '500px', margin: '0 auto var(--space-xl)' }}>
            Ba bước đơn giản để tìm và tận dụng deal thông minh.
          </p>
          <div className="hiw-steps">
            <div className="hiw-step">
              <div className="hiw-step-number">1</div>
              <h3 className="hiw-step-title">Tìm sản phẩm</h3>
              <p className="hiw-step-desc">Thêm sản phẩm từ nhiều nguồn affiliate hoặc nhập thủ công.</p>
            </div>
            <div className="hiw-step">
              <div className="hiw-step-number">2</div>
              <h3 className="hiw-step-title">Chấm điểm cơ hội</h3>
              <p className="hiw-step-desc">AI tự động đánh giá mức độ tiềm năng và rủi ro.</p>
            </div>
            <div className="hiw-step">
              <div className="hiw-step-number">3</div>
              <h3 className="hiw-step-title">Xuất nội dung / deal</h3>
              <p className="hiw-step-desc">Tạo nội dung và xuất deal sẵn sàng để đăng.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Deals */}
      <section style={{ padding: '48px 24px 64px', background: 'var(--bg-secondary)' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
          <h2 className="section-title" style={{ textAlign: 'center', fontSize: 'var(--text-2xl)', marginBottom: '8px' }}>Deal nổi bật</h2>
          <p className="section-subtitle" style={{ textAlign: 'center', maxWidth: '500px', margin: '0 auto var(--space-xl)' }}>
            Các sản phẩm đã được kiểm tra và duyệt bởi hệ thống.
          </p>

          {approvedProducts.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-2xl)' }}>
              <div className="empty-state-icon">🔍</div>
              <div className="empty-state-title">Chưa có deal nào</div>
              <div className="empty-state-desc">
                Các sản phẩm được duyệt và xuất bản sẽ xuất hiện tại đây. Hãy quay lại sau!
              </div>
              <Link href="/dashboard" className="btn btn-secondary" style={{ marginTop: 'var(--space-lg)' }}>
                Vào Dashboard
              </Link>
            </div>
          ) : (
            <div className="grid grid-3">
              {approvedProducts.map(product => {
                const dealUrl = product.affiliateUrl || product.originalUrl;
                return (
                  <div key={product.id} className="deal-card">
                    <div className="deal-card-image">
                      {product.imageUrl ? (
                        <img src={product.imageUrl} alt={product.title} />
                      ) : (
                        <span>📦</span>
                      )}
                      <div className="deal-card-platform">
                        <span className="badge badge-neutral">{product.platform}</span>
                      </div>
                    </div>
                    <div className="deal-card-body">
                      <Link href={`/deals/${product.slug}`}>
                        <h3 className="deal-card-title">{product.title}</h3>
                      </Link>
                      {(product.salePrice || product.price) && (
                        <div className="deal-card-price">
                          {product.salePrice
                            ? product.salePrice.toLocaleString('vi-VN') + '₫'
                            : product.price?.toLocaleString('vi-VN') + '₫'}
                        </div>
                      )}
                    </div>
                    <div className="deal-card-footer">
                      {product.scoreLabel && (
                        <span className={`badge ${product.score && product.score >= 75 ? 'badge-success' : 'badge-warning'}`}>
                          {product.scoreLabel}
                        </span>
                      )}
                      {dealUrl ? (
                        <a href={dealUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
                          Xem deal →
                        </a>
                      ) : (
                        <Link href={`/deals/${product.slug}`} className="btn btn-secondary btn-sm">Chi tiết</Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Affiliate Disclosure */}
      <section style={{ padding: '32px 24px', background: 'var(--bg-primary)' }}>
        <div className="disclosure-banner" style={{ maxWidth: '800px', margin: '0 auto' }}>
          <strong>🛡️ Tiết lộ affiliate:</strong> Một số liên kết trên SanDeal có thể là liên kết tiếp thị liên kết. SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này, nhưng giá của bạn không thay đổi.
        </div>
      </section>

      {/* Footer */}
      <footer className="public-footer" style={{ marginTop: 0 }}>
        <div className="public-footer-inner">
          <p style={{ fontSize: 'var(--text-xl)', fontWeight: 900, marginBottom: '8px' }}>
            <span style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>SanDeal</span>
          </p>
          <p className="public-footer-text">© {new Date().getFullYear()} SanDeal — Powered by ReviewPilot AI</p>
          <ul className="public-footer-links">
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="/dashboard">Dashboard</Link></li>
          </ul>
          <p className="public-footer-disclosure">
            Trang web này chứa liên kết tiếp thị liên kết. Giá và khuyến mãi có thể thay đổi. Vui lòng kiểm tra lại trên trang bán hàng trước khi mua.
          </p>
        </div>
      </footer>
    </>
  );
}
