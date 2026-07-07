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

const PLATFORMS: Record<string, string> = {
  shopee: 'Shopee', tiktok_shop: 'TikTok Shop', lazada: 'Lazada',
  accesstrade: 'AccessTrade', website: 'Website', other: 'Khác',
};

export default async function DealDetailPage(
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product || (product.status !== 'approved' && product.status !== 'published')) {
    notFound();
  }

  const dealUrl = product.affiliateUrl || product.originalUrl;
  let allDeals: Awaited<ReturnType<typeof getPublishedProducts>> = [];
  try {
    const data = await getPublishedProducts();
    if (Array.isArray(data)) allDeals = data;
  } catch { /* empty */ }
  const relatedDeals = allDeals.filter(d => d.id !== product.id).slice(0, 4);

  const formatPrice = (p?: number) => p ? p.toLocaleString('vi-VN') + '₫' : '';
  const discount = (product.salePrice && product.price && product.price > product.salePrice) 
    ? Math.round((1 - product.salePrice / product.price) * 100) 
    : 0;

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
            <input placeholder="Bạn muốn tìm deal gì hôm nay?" />
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
        
        {/* Breadcrumb */}
        <div style={{ marginBottom: 'var(--space-xl)', fontSize: 'var(--text-sm)', color: 'var(--market-text-muted)' }}>
          <Link href="/deals" style={{ color: 'var(--market-text-muted)', textDecoration: 'none' }}>← Quay lại Deal hot</Link> 
        </div>

        {/* Product Detail Layout */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 450px) 1fr', gap: 'var(--space-3xl)', alignItems: 'start' }}>
          
          {/* Left: Image */}
          <div style={{ background: '#ffffff', border: '1px solid var(--market-border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden' }}>
            <div className="market-deal-image-wrapper">
              {product.imageUrl ? (
                <img src={product.imageUrl} alt={product.title} />
              ) : (
                <div className="market-deal-placeholder">
                  <span className="market-deal-placeholder-text">Ảnh đang cập nhật</span>
                </div>
              )}
            </div>
            
            {Array.isArray(product.gallery) && product.gallery.length > 0 && (
              <div style={{ display: 'flex', gap: 'var(--space-sm)', padding: 'var(--space-md)', overflowX: 'auto' }}>
                {product.gallery.map((url, idx) => (
                  <div key={idx} style={{ width: '60px', height: '60px', borderRadius: 'var(--radius-md)', border: '1px solid var(--market-border)', overflow: 'hidden', flexShrink: 0 }}>
                    <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: Details */}
          <div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: 'var(--space-md)' }}>
              <span className="market-platform-badge" style={{ position: 'relative', top: 'auto', right: 'auto' }}>
                {PLATFORMS[product.platform] || product.platform}
              </span>
              {discount > 0 && (
                <span className="market-discount-badge" style={{ position: 'relative', top: 'auto', left: 'auto' }}>
                  Giảm {discount}%
                </span>
              )}
            </div>

            <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, color: 'var(--market-text-main)', marginBottom: 'var(--space-md)', lineHeight: 1.3 }}>
              {product.title}
            </h1>

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-xl)', paddingBottom: 'var(--space-xl)', borderBottom: '1px dashed var(--market-border)' }}>
              <div style={{ fontSize: 'var(--text-4xl)', fontWeight: 900, color: 'var(--market-discount)' }}>
                {formatPrice(product.salePrice || product.price)}
              </div>
              {product.salePrice && product.price && product.price !== product.salePrice && (
                <div style={{ fontSize: 'var(--text-lg)', color: 'var(--market-text-muted)', textDecoration: 'line-through' }}>
                  {formatPrice(product.price)}
                </div>
              )}
            </div>

            {/* Description */}
            {product.description && (
              <div style={{ marginBottom: 'var(--space-xl)' }}>
                <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, marginBottom: 'var(--space-sm)' }}>Thông tin sản phẩm</h3>
                <p style={{ color: 'var(--market-text-muted)', lineHeight: 1.7, fontSize: 'var(--text-sm)' }}>
                  {product.description}
                </p>
              </div>
            )}

            {/* Benefits */}
            {Array.isArray(product.benefits) && product.benefits.length > 0 && (
              <div style={{ marginBottom: 'var(--space-xl)' }}>
                <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, marginBottom: 'var(--space-sm)' }}>Điểm nổi bật</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {product.benefits.map((b, i) => (
                    <li key={i} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '8px', fontSize: 'var(--text-sm)' }}>
                      <span style={{ color: 'var(--market-success)' }}>✔</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Warnings */}
            {Array.isArray(product.warnings) && product.warnings.length > 0 && (
              <div style={{ marginBottom: 'var(--space-xl)', padding: 'var(--space-md)', background: 'rgba(245, 158, 11, 0.1)', borderRadius: 'var(--radius-md)' }}>
                <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--market-warning)', marginBottom: 'var(--space-xs)' }}>Cần kiểm tra trước khi mua</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {product.warnings.map((w, i) => (
                    <li key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: 'var(--text-xs)', color: '#92400e', marginBottom: '4px' }}>
                      <span>[!]</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Actions */}
            <div style={{ marginTop: 'var(--space-2xl)' }}>
              {dealUrl ? (
                <a href={dealUrl} target="_blank" rel="noopener noreferrer" className="btn" style={{ background: 'var(--market-primary)', color: '#ffffff', width: '100%', fontSize: 'var(--text-lg)', padding: '16px', borderRadius: 'var(--radius-lg)' }}>
                  Đến trang mua hàng
                </a>
              ) : (
                <button className="btn" disabled style={{ background: 'var(--market-border)', color: 'var(--market-text-muted)', width: '100%', fontSize: 'var(--text-lg)', padding: '16px', borderRadius: 'var(--radius-lg)' }}>
                  Sản phẩm chưa sẵn sàng
                </button>
              )}
              <div style={{ textAlign: 'center', marginTop: 'var(--space-md)', fontSize: 'var(--text-xs)', color: 'var(--market-text-muted)' }}>
                Giá có thể thay đổi tùy thời điểm.
              </div>
            </div>

          </div>
        </div>

        {/* Related Deals */}
        {relatedDeals.length > 0 && (
          <div style={{ marginTop: 'var(--space-4xl)', paddingTop: 'var(--space-2xl)', borderTop: '1px solid var(--market-border)' }}>
            <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 800, marginBottom: 'var(--space-lg)' }}>Deal khác có thể bạn thích</h2>
            <div className="deal-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              {relatedDeals.map(p => {
                const relDiscount = (p.salePrice && p.price && p.price > p.salePrice) 
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
                      {relDiscount > 0 && (
                        <div className="market-discount-badge">Giảm {relDiscount}%</div>
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
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="market-footer">
        <div className="market-container market-footer-inner">
          <div className="market-affiliate-note" style={{ maxWidth: '800px', margin: '0 auto var(--space-2xl)' }}>
            <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--market-text-main)', marginBottom: 'var(--space-sm)' }}>Minh bạch Affiliate</h3>
            SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này, nhưng <strong>giá của bạn không thay đổi</strong>. Chúng tôi cam kết chỉ giới thiệu sản phẩm đã được đánh giá và kiểm duyệt.
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
