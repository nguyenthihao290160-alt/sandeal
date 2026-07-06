import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductBySlug, getPublishedProducts } from '@/lib/storage/products';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: 'Không tìm thấy — SanDeal' };
  return {
    title: `${product.title} — SanDeal`,
    description: product.description || `Deal ${product.title} trên ${product.platform}`,
  };
}

export default async function DealDetailPage(
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product || (product.status !== 'approved' && product.status !== 'published')) {
    notFound();
  }

  const dealUrl = product.affiliateUrl || product.originalUrl;
  const allDeals = await getPublishedProducts();
  const relatedDeals = allDeals.filter(d => d.id !== product.id).slice(0, 3);

  return (
    <>
      {/* Navigation */}
      <nav className="public-nav">
        <div className="public-nav-inner">
          <Link href="/" className="public-nav-brand">SanDeal</Link>
          <ul className="public-nav-links">
            <li><Link href="/">Trang chủ</Link></li>
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="/dashboard" className="btn btn-primary btn-sm">Dashboard</Link></li>
          </ul>
        </div>
      </nav>

      <div className="container" style={{ padding: 'var(--space-xl) var(--space-lg)' }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: 'var(--space-lg)', fontSize: 'var(--text-sm)' }}>
          <Link href="/deals" style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>← Quay lại deals</Link>
        </div>

        <div className="product-detail-grid">
          {/* Left: Main content */}
          <div>
            {/* Product Image */}
            <div style={{
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
              marginBottom: 'var(--space-lg)',
              background: 'linear-gradient(135deg, #1a2237, #111827)',
              minHeight: '200px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              {product.imageUrl ? (
                <img src={product.imageUrl} alt={product.title} style={{ width: '100%', maxHeight: '400px', objectFit: 'cover' }} />
              ) : (
                <span style={{ fontSize: '64px', opacity: 0.4 }}>📦</span>
              )}
            </div>

            <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, marginBottom: 'var(--space-md)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
              {product.title}
            </h1>

            <div className="flex gap-sm" style={{ marginBottom: 'var(--space-md)', flexWrap: 'wrap' }}>
              <span className="badge badge-neutral">{product.platform}</span>
              {product.scoreLabel && (
                <span className={`badge ${product.score && product.score >= 75 ? 'badge-success' : 'badge-warning'}`}>
                  {product.scoreLabel}
                </span>
              )}
              <span className="badge badge-warning">Giá có thể thay đổi</span>
            </div>

            {product.description && (
              <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-lg)', lineHeight: 1.8, fontSize: 'var(--text-base)' }}>
                {product.description}
              </p>
            )}

            {/* Benefits */}
            {product.benefits && product.benefits.length > 0 && (
              <div className="glass-card" style={{ marginBottom: 'var(--space-lg)' }}>
                <h3 className="card-title">✅ Lợi ích chính</h3>
                <ul className="detail-list">
                  {product.benefits.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            )}

            {/* Things to check */}
            {product.warnings && product.warnings.length > 0 && (
              <div className="glass-card" style={{ marginBottom: 'var(--space-lg)', borderColor: 'rgba(245, 158, 11, 0.2)' }}>
                <h3 className="card-title">🔍 Điều cần kiểm tra trước khi mua</h3>
                <ul className="detail-list detail-list-warning">
                  {product.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* Price note */}
            {product.priceNote && (
              <div className="disclosure-banner">
                💡 <strong>Ghi chú giá:</strong> {product.priceNote}
              </div>
            )}

            {/* Affiliate disclosure */}
            <div className="disclosure-banner" style={{ marginTop: 'var(--space-md)' }}>
              🛡️ {product.affiliateDisclosure || 'Bài viết có chứa liên kết tiếp thị liên kết. Nếu bạn mua hàng thông qua liên kết này, chúng tôi có thể nhận được hoa hồng nhỏ, không ảnh hưởng đến giá bạn trả.'}
            </div>

            {/* Disclaimer */}
            <div className="disclosure-banner" style={{ marginTop: 'var(--space-md)' }}>
              ⚠️ Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian. Vui lòng kiểm tra lại trên trang bán hàng trước khi mua.
            </div>
          </div>

          {/* Right: CTA + Info */}
          <div>
            <div className="gradient-card" style={{ position: 'sticky', top: '80px' }}>
              {/* Price */}
              {(product.salePrice || product.price) && (
                <div style={{ marginBottom: 'var(--space-lg)', textAlign: 'center' }}>
                  <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, color: 'var(--color-accent-light)' }}>
                    {product.salePrice
                      ? product.salePrice.toLocaleString('vi-VN') + '₫'
                      : product.price?.toLocaleString('vi-VN') + '₫'}
                  </div>
                  {product.price && product.salePrice && product.price > product.salePrice && (
                    <div style={{ marginTop: '4px' }}>
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textDecoration: 'line-through' }}>
                        {product.price.toLocaleString('vi-VN')}₫
                      </span>
                      <span className="badge badge-success" style={{ marginLeft: '8px' }}>
                        -{Math.round(((product.price - product.salePrice) / product.price) * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* CTA */}
              {dealUrl ? (
                <a href={dealUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 'var(--space-md)' }}>
                  Xem deal →
                </a>
              ) : (
                <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)', textAlign: 'center', marginBottom: 'var(--space-md)' }}>
                  Link sản phẩm chưa sẵn sàng.
                </p>
              )}

              {/* Info */}
              <div className="detail-meta">
                <div className="detail-meta-row"><span>Nền tảng:</span><span>{product.platform}</span></div>
                {product.category && <div className="detail-meta-row"><span>Danh mục:</span><span>{product.category}</span></div>}
                {product.tags && product.tags.length > 0 && (
                  <div className="detail-meta-row"><span>Tags:</span><span>{product.tags.join(', ')}</span></div>
                )}
              </div>

              {/* Back */}
              <Link href="/deals" className="btn btn-secondary" style={{ width: '100%', marginTop: 'var(--space-md)', textAlign: 'center' }}>
                ← Tất cả deals
              </Link>
            </div>
          </div>
        </div>

        {/* Related Deals */}
        {relatedDeals.length > 0 && (
          <div style={{ marginTop: 'var(--space-3xl)' }}>
            <h2 className="section-title">Deals khác</h2>
            <div className="grid grid-3">
              {relatedDeals.map(d => (
                <div key={d.id} className="deal-card">
                  <div className="deal-card-image">
                    {d.imageUrl ? <img src={d.imageUrl} alt={d.title} /> : <span>📦</span>}
                    <div className="deal-card-platform">
                      <span className="badge badge-neutral">{d.platform}</span>
                    </div>
                  </div>
                  <div className="deal-card-body">
                    <Link href={`/deals/${d.slug}`}><h3 className="deal-card-title">{d.title}</h3></Link>
                    {(d.salePrice || d.price) && (
                      <div className="deal-card-price">
                        {(d.salePrice || d.price || 0).toLocaleString('vi-VN')}₫
                      </div>
                    )}
                  </div>
                  <div className="deal-card-footer">
                    <span className="badge badge-neutral">{d.platform}</span>
                    <Link href={`/deals/${d.slug}`} className="btn btn-primary btn-sm">Xem →</Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="public-footer">
        <div className="public-footer-inner">
          <p style={{ fontSize: 'var(--text-xl)', fontWeight: 900, marginBottom: '8px' }}>
            <span style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>SanDeal</span>
          </p>
          <p className="public-footer-text">© {new Date().getFullYear()} SanDeal — Powered by ReviewPilot AI</p>
          <p className="public-footer-disclosure">
            Trang web này chứa liên kết tiếp thị liên kết. Giá và khuyến mãi có thể thay đổi. Vui lòng kiểm tra lại trên trang bán hàng trước khi mua.
          </p>
        </div>
      </footer>
    </>
  );
}
