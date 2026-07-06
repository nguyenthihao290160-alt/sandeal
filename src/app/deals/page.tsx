import Link from 'next/link';
import { getPublishedProducts } from '@/lib/storage/products';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Deals Hot — SanDeal',
  description: 'Tổng hợp deal, khuyến mãi và sản phẩm tốt nhất từ Shopee, TikTok Shop, Lazada và nhiều nguồn khác.',
};

export default async function DealsPage() {
  const products = await getPublishedProducts();

  return (
    <>
      {/* Navigation */}
      <nav className="public-nav">
        <div className="public-nav-inner">
          <Link href="/" className="public-nav-brand">SanDeal</Link>
          <ul className="public-nav-links">
            <li><Link href="/deals">Deals</Link></li>
          </ul>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <h1 className="hero-title" style={{ position: 'relative' }}>
          Deal hot từ <span>SanDeal</span>
        </h1>
        <p className="hero-subtitle">
          Tổng hợp deal, khuyến mãi và sản phẩm affiliate từ các nền tảng uy tín.
        </p>
      </section>

      {/* Deals Grid */}
      <div className="container" style={{ padding: 'var(--space-xl) var(--space-lg)' }}>
        {products.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📦</div>
            <div className="empty-state-title">Chưa có deal nào</div>
            <div className="empty-state-desc">Các sản phẩm được duyệt sẽ hiển thị ở đây.</div>
          </div>
        ) : (
          <div className="grid grid-3">
            {products.map(product => {
              const dealUrl = product.affiliateUrl || product.originalUrl;
              return (
                <div key={product.id} className="deal-card">
                  <div className="deal-card-image">
                    {product.imageUrl ? (
                      <img src={product.imageUrl} alt={product.title} />
                    ) : (
                      <span>📦 Chưa có hình ảnh</span>
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
                        {product.price && product.salePrice && product.price > product.salePrice && (
                          <span style={{
                            fontSize: 'var(--text-sm)',
                            color: 'var(--text-tertiary)',
                            textDecoration: 'line-through',
                            marginLeft: '8px',
                            fontWeight: 400,
                          }}>
                            {product.price.toLocaleString('vi-VN')}₫
                          </span>
                        )}
                      </div>
                    )}
                    {product.benefits && product.benefits.length > 0 && (
                      <div className="deal-card-desc">
                        {product.benefits.slice(0, 2).join(' • ')}
                      </div>
                    )}
                    <span className="badge badge-warning" style={{ fontSize: '10px', marginTop: '4px' }}>
                      Giá có thể thay đổi
                    </span>
                  </div>
                  <div className="deal-card-footer">
                    {product.scoreLabel && (
                      <span className={`badge ${product.score && product.score >= 75 ? 'badge-success' : product.score && product.score >= 45 ? 'badge-warning' : 'badge-neutral'}`} style={{ fontSize: '10px' }}>
                        {product.scoreLabel}
                      </span>
                    )}
                    {dealUrl ? (
                      <a href={dealUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
                        Xem deal →
                      </a>
                    ) : (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>Link sản phẩm chưa sẵn sàng.</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Disclaimer */}
        <div className="disclosure-banner" style={{ marginTop: 'var(--space-xl)' }}>
          <strong>⚠️ Lưu ý:</strong> Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian. Vui lòng kiểm tra lại trên trang bán hàng trước khi mua.
          Một số liên kết trên trang này là liên kết tiếp thị liên kết — chúng tôi có thể nhận được hoa hồng nhỏ nếu bạn mua hàng thông qua các liên kết này, không ảnh hưởng đến giá bạn trả.
        </div>
      </div>

      {/* Footer */}
      <footer className="public-footer">
        <div className="public-footer-inner">
          <p className="public-footer-text">© {new Date().getFullYear()} SanDeal — Powered by ReviewPilot AI</p>
          <p className="public-footer-disclosure">
            Trang web này chứa liên kết tiếp thị liên kết. Giá và khuyến mãi có thể thay đổi. Vui lòng kiểm tra lại trên trang bán hàng trước khi mua.
          </p>
        </div>
      </footer>
    </>
  );
}
