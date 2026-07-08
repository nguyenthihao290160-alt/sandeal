import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getProductBySlug, getPublishedProducts } from '@/lib/storage/products';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PLATFORMS: Record<string, string> = {
    shopee: 'Shopee',
    tiktok_shop: 'TikTok Shop',
    lazada: 'Lazada',
    accesstrade: 'AccessTrade',
    website: 'Website',
    other: 'Khác',
};

function getText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function formatPrice(price?: number) {
    if (!price) return 'Đang cập nhật';
    return `${price.toLocaleString('vi-VN')}₫`;
}

function getDiscountPercent(product: Product) {
    if (!product.price || !product.salePrice || product.price <= product.salePrice) {
        return 0;
    }

    return Math.round((1 - product.salePrice / product.price) * 100);
}

function getDealUrl(product: Product) {
    const record = product as Product & Record<string, unknown>;

    return product.affiliateUrl || product.originalUrl || getText(record.url) || '';
}

function getPlatformLabel(platform?: string) {
    const key = String(platform || 'other');
    return PLATFORMS[key] || key || 'Khác';
}

function SafeProductImage({
                              src,
                              alt,
                              compact = false,
                          }: {
    src?: string | null;
    alt: string;
    compact?: boolean;
}) {
    const cleanSrc = typeof src === 'string' ? src.trim() : '';

    const fallback = (
        <div
            aria-label={alt}
            style={{
                width: '100%',
                height: '100%',
                minHeight: compact ? 68 : 260,
                display: 'grid',
                placeItems: 'center',
                padding: compact ? 8 : 22,
                background:
                    'radial-gradient(circle at 50% 20%, rgba(14,165,233,0.14), transparent 34%), linear-gradient(135deg, #f8fafc 0%, #eef6ff 100%)',
                color: '#64748b',
                textAlign: 'center',
            }}
        >
            <div>
                <div
                    style={{
                        width: compact ? 34 : 68,
                        height: compact ? 34 : 68,
                        margin: compact ? '0 auto' : '0 auto 12px',
                        borderRadius: compact ? 12 : 20,
                        display: 'grid',
                        placeItems: 'center',
                        background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                        color: '#ffffff',
                        fontWeight: 950,
                        fontSize: compact ? 15 : 28,
                        boxShadow: '0 18px 38px rgba(37,99,235,0.18)',
                    }}
                >
                    S
                </div>

                {!compact && (
                    <>
                        <div style={{ fontSize: 14, fontWeight: 950, color: '#0f172a' }}>
                            Ảnh đang cập nhật
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginTop: 5 }}>
                            Ảnh gốc có thể không còn khả dụng từ nguồn bán hàng
                        </div>
                    </>
                )}
            </div>
        </div>
    );

    if (!cleanSrc) return fallback;

    return (
        <object
            data={cleanSrc}
            aria-label={alt}
            style={{
                width: '100%',
                height: '100%',
                display: 'block',
                objectFit: 'cover',
                background: '#f8fafc',
            }}
        >
            {fallback}
        </object>
    );
}

function ProductCardImage({
                              product,
                              platformLabel,
                              discount,
                          }: {
    product: Product;
    platformLabel: string;
    discount: number;
}) {
    return (
        <div
            style={{
                position: 'relative',
                aspectRatio: '1 / 1',
                background: '#f8fafc',
                display: 'grid',
                placeItems: 'center',
                overflow: 'hidden',
            }}
        >
            <SafeProductImage src={product.imageUrl} alt={product.title} compact />

            <div
                style={{
                    position: 'absolute',
                    top: 12,
                    left: 12,
                    borderRadius: 999,
                    background: '#ffffff',
                    color: '#0f172a',
                    padding: '6px 10px',
                    fontSize: 11,
                    fontWeight: 950,
                    boxShadow: '0 8px 20px rgba(15,23,42,0.1)',
                }}
            >
                {platformLabel}
            </div>

            {discount > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 12,
                        borderRadius: 999,
                        background: '#ef4444',
                        color: '#ffffff',
                        padding: '6px 10px',
                        fontSize: 11,
                        fontWeight: 950,
                    }}
                >
                    -{discount}%
                </div>
            )}
        </div>
    );
}

export async function generateMetadata({
                                           params,
                                       }: {
    params: Promise<{ slug: string }>;
}): Promise<Metadata> {
    const { slug } = await params;
    const product = await getProductBySlug(slug);

    if (!product || !isPublicSafeProduct(product)) {
        return {
            title: 'Không tìm thấy — SanDeal',
        };
    }

    return {
        title: `${product.title} — SanDeal`,
        description:
            product.description ||
            `Deal ${product.title} trên ${getPlatformLabel(String(product.platform || 'other'))}`,
    };
}

export default async function DealDetailPage({
                                                 params,
                                             }: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const product = await getProductBySlug(slug);

    if (!product || !isPublicSafeProduct(product)) {
        notFound();
    }

    const dealUrl = getDealUrl(product);
    const discount = getDiscountPercent(product);
    const platformLabel = getPlatformLabel(String(product.platform || 'other'));
    const currentPrice = product.salePrice || product.price;

    let relatedDeals: Product[] = [];

    try {
        const data = await getPublishedProducts();

        if (Array.isArray(data)) {
            relatedDeals = data
                .filter((item) => item.id !== product.id)
                .filter((item) => isPublicSafeProduct(item))
                .slice(0, 4);
        }
    } catch {
        relatedDeals = [];
    }

    return (
        <div
            className="market-shell"
            style={{
                background: 'linear-gradient(180deg, #f8fbff 0%, #ffffff 38%, #f5f8fc 100%)',
                minHeight: '100vh',
            }}
        >
            <div
                style={{
                    background: 'linear-gradient(90deg, #6d5dfc 0%, #06b6d4 100%)',
                    color: '#ffffff',
                    fontSize: 13,
                    fontWeight: 800,
                    padding: '10px 0',
                }}
            >
                <div
                    className="market-container"
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 16,
                        alignItems: 'center',
                    }}
                >
                    <span>Deal mới mỗi ngày — So sánh nhanh — Link minh bạch</span>
                    <span style={{ opacity: 0.95 }}>Giá và ưu đãi có thể thay đổi</span>
                </div>
            </div>

            <header
                className="market-header"
                style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 20,
                    background: 'rgba(255,255,255,0.92)',
                    backdropFilter: 'blur(14px)',
                    borderBottom: '1px solid #e8edf5',
                }}
            >
                <div
                    className="market-container"
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto minmax(260px, 1fr) auto auto',
                        alignItems: 'center',
                        gap: 20,
                        minHeight: 72,
                    }}
                >
                    <Link
                        href="/"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            textDecoration: 'none',
                            fontWeight: 950,
                            color: '#0f172a',
                            letterSpacing: '-0.03em',
                        }}
                    >
            <span
                style={{
                    width: 40,
                    height: 40,
                    borderRadius: 14,
                    display: 'grid',
                    placeItems: 'center',
                    background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                    color: '#ffffff',
                    fontWeight: 950,
                }}
            >
              S
            </span>
                        <span style={{ fontSize: 22 }}>SanDeal</span>
                    </Link>

                    <form
                        action="/deals"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: 999,
                            padding: '0 16px',
                            height: 46,
                            boxShadow: '0 8px 24px rgba(15, 23, 42, 0.04)',
                        }}
                    >
                        <span style={{ color: '#94a3b8' }}>⌕</span>
                        <input
                            name="q"
                            placeholder="Tìm kiếm Deal ngon..."
                            style={{
                                width: '100%',
                                border: 0,
                                outline: 0,
                                background: 'transparent',
                                fontSize: 14,
                                color: '#0f172a',
                            }}
                        />
                    </form>

                    <nav
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 22,
                            fontSize: 14,
                            fontWeight: 800,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <Link href="/" style={{ color: '#475569', textDecoration: 'none' }}>
                            Trang chủ
                        </Link>
                        <Link href="/deals" style={{ color: '#0ea5e9', textDecoration: 'none' }}>
                            Deal hot
                        </Link>
                        <Link href="/deals" style={{ color: '#475569', textDecoration: 'none' }}>
                            Danh mục
                        </Link>
                        <Link href="/#how-it-works" style={{ color: '#475569', textDecoration: 'none' }}>
                            Cách hoạt động
                        </Link>
                        <Link href="/#disclosure" style={{ color: '#475569', textDecoration: 'none' }}>
                            Minh bạch affiliate
                        </Link>
                    </nav>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
                style={{
                    border: '1px solid #dbeafe',
                    background: '#eff6ff',
                    borderRadius: 999,
                    padding: '8px 10px',
                    fontSize: 12,
                    fontWeight: 900,
                    color: '#2563eb',
                }}
            >
              VN
            </span>
                        <span
                            style={{
                                border: '1px solid #e2e8f0',
                                background: '#ffffff',
                                borderRadius: 999,
                                padding: '8px 10px',
                                fontSize: 12,
                                fontWeight: 900,
                                color: '#64748b',
                            }}
                        >
              EN
            </span>
                    </div>
                </div>
            </header>

            <main>
                <section
                    style={{
                        padding: '32px 0 68px',
                        background: 'radial-gradient(circle at 50% 0%, rgba(59,130,246,0.11), transparent 44%)',
                    }}
                >
                    <div className="market-container">
                        <div
                            style={{
                                marginBottom: 24,
                                fontSize: 14,
                                fontWeight: 800,
                                color: '#64748b',
                            }}
                        >
                            <Link
                                href="/deals"
                                style={{
                                    color: '#64748b',
                                    textDecoration: 'none',
                                }}
                            >
                                ← Quay lại Deal hot
                            </Link>
                        </div>

                        <div
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(320px, 520px) 1fr',
                                gap: 42,
                                alignItems: 'start',
                            }}
                        >
                            <div
                                style={{
                                    background: '#ffffff',
                                    border: '1px solid #e8edf5',
                                    borderRadius: 28,
                                    overflow: 'hidden',
                                    boxShadow: '0 24px 60px rgba(15,23,42,0.08)',
                                }}
                            >
                                <div
                                    style={{
                                        position: 'relative',
                                        aspectRatio: '1 / 1',
                                        background: '#f8fafc',
                                        display: 'grid',
                                        placeItems: 'center',
                                        overflow: 'hidden',
                                    }}
                                >
                                    <SafeProductImage src={product.imageUrl} alt={product.title} />

                                    <div
                                        style={{
                                            position: 'absolute',
                                            top: 16,
                                            left: 16,
                                            borderRadius: 999,
                                            background: '#ffffff',
                                            color: '#0f172a',
                                            padding: '8px 12px',
                                            fontSize: 12,
                                            fontWeight: 950,
                                            boxShadow: '0 8px 20px rgba(15,23,42,0.12)',
                                        }}
                                    >
                                        {platformLabel}
                                    </div>

                                    {discount > 0 && (
                                        <div
                                            style={{
                                                position: 'absolute',
                                                top: 16,
                                                right: 16,
                                                borderRadius: 999,
                                                background: '#ef4444',
                                                color: '#ffffff',
                                                padding: '8px 12px',
                                                fontSize: 12,
                                                fontWeight: 950,
                                            }}
                                        >
                                            -{discount}%
                                        </div>
                                    )}
                                </div>

                                {Array.isArray(product.gallery) && product.gallery.length > 0 && (
                                    <div
                                        style={{
                                            display: 'flex',
                                            gap: 10,
                                            padding: 16,
                                            overflowX: 'auto',
                                            borderTop: '1px solid #edf2f7',
                                        }}
                                    >
                                        {product.gallery.slice(0, 6).map((url, index) => (
                                            <div
                                                key={`${url}-${index}`}
                                                style={{
                                                    width: 68,
                                                    height: 68,
                                                    borderRadius: 16,
                                                    border: '1px solid #e8edf5',
                                                    overflow: 'hidden',
                                                    flexShrink: 0,
                                                    background: '#f8fafc',
                                                }}
                                            >
                                                <SafeProductImage src={url} alt={`${product.title} ${index + 1}`} compact />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div>
                                <div
                                    style={{
                                        display: 'flex',
                                        gap: 10,
                                        flexWrap: 'wrap',
                                        marginBottom: 16,
                                    }}
                                >
                  <span
                      style={{
                          borderRadius: 999,
                          background: '#eff6ff',
                          border: '1px solid #dbeafe',
                          color: '#2563eb',
                          padding: '8px 12px',
                          fontSize: 12,
                          fontWeight: 950,
                      }}
                  >
                    {platformLabel}
                  </span>

                                    <span
                                        style={{
                                            borderRadius: 999,
                                            background: '#ecfdf5',
                                            border: '1px solid #bbf7d0',
                                            color: '#059669',
                                            padding: '8px 12px',
                                            fontSize: 12,
                                            fontWeight: 950,
                                        }}
                                    >
                    Đã lọc an toàn
                  </span>

                                    {discount > 0 && (
                                        <span
                                            style={{
                                                borderRadius: 999,
                                                background: '#fef2f2',
                                                border: '1px solid #fecaca',
                                                color: '#dc2626',
                                                padding: '8px 12px',
                                                fontSize: 12,
                                                fontWeight: 950,
                                            }}
                                        >
                      Giảm {discount}%
                    </span>
                                    )}
                                </div>

                                <h1
                                    style={{
                                        fontSize: 'clamp(34px, 4.5vw, 54px)',
                                        lineHeight: 1.04,
                                        letterSpacing: '-0.06em',
                                        fontWeight: 950,
                                        color: '#0f172a',
                                        margin: '0 0 22px',
                                    }}
                                >
                                    {product.title}
                                </h1>

                                <div
                                    style={{
                                        background: '#ffffff',
                                        border: '1px solid #e8edf5',
                                        borderRadius: 24,
                                        padding: 24,
                                        boxShadow: '0 18px 40px rgba(15,23,42,0.05)',
                                        marginBottom: 22,
                                    }}
                                >
                                    <div style={{ color: '#64748b', fontWeight: 800, marginBottom: 8 }}>
                                        Giá tham khảo
                                    </div>

                                    <div
                                        style={{
                                            display: 'flex',
                                            alignItems: 'baseline',
                                            gap: 12,
                                            flexWrap: 'wrap',
                                            marginBottom: 12,
                                        }}
                                    >
                                        <strong
                                            style={{
                                                color: '#06b6d4',
                                                fontSize: 38,
                                                fontWeight: 950,
                                                letterSpacing: '-0.04em',
                                            }}
                                        >
                                            {formatPrice(currentPrice)}
                                        </strong>

                                        {product.salePrice && product.price && product.salePrice !== product.price && (
                                            <span
                                                style={{
                                                    color: '#94a3b8',
                                                    textDecoration: 'line-through',
                                                    fontSize: 18,
                                                    fontWeight: 800,
                                                }}
                                            >
                        {formatPrice(product.price)}
                      </span>
                                        )}
                                    </div>

                                    <div
                                        style={{
                                            display: 'flex',
                                            gap: 8,
                                            flexWrap: 'wrap',
                                        }}
                                    >
                    <span
                        style={{
                            color: '#f59e0b',
                            background: 'rgba(245,158,11,0.08)',
                            border: '1px solid rgba(245,158,11,0.16)',
                            borderRadius: 999,
                            padding: '6px 10px',
                            fontSize: 12,
                            fontWeight: 900,
                        }}
                    >
                      Giá có thể thay đổi
                    </span>

                                        <span
                                            style={{
                                                color: '#2563eb',
                                                background: '#eff6ff',
                                                border: '1px solid #dbeafe',
                                                borderRadius: 999,
                                                padding: '6px 10px',
                                                fontSize: 12,
                                                fontWeight: 900,
                                            }}
                                        >
                      Link affiliate minh bạch
                    </span>
                                    </div>
                                </div>

                                {product.description && (
                                    <div
                                        style={{
                                            background: '#ffffff',
                                            border: '1px solid #e8edf5',
                                            borderRadius: 22,
                                            padding: 22,
                                            marginBottom: 18,
                                        }}
                                    >
                                        <h2
                                            style={{
                                                margin: '0 0 10px',
                                                color: '#0f172a',
                                                fontSize: 18,
                                                fontWeight: 950,
                                            }}
                                        >
                                            Thông tin sản phẩm
                                        </h2>
                                        <p
                                            style={{
                                                margin: 0,
                                                color: '#64748b',
                                                lineHeight: 1.75,
                                                fontSize: 15,
                                            }}
                                        >
                                            {product.description}
                                        </p>
                                    </div>
                                )}

                                {Array.isArray(product.benefits) && product.benefits.length > 0 && (
                                    <div
                                        style={{
                                            background: '#ffffff',
                                            border: '1px solid #e8edf5',
                                            borderRadius: 22,
                                            padding: 22,
                                            marginBottom: 18,
                                        }}
                                    >
                                        <h2
                                            style={{
                                                margin: '0 0 12px',
                                                color: '#0f172a',
                                                fontSize: 18,
                                                fontWeight: 950,
                                            }}
                                        >
                                            Điểm nổi bật
                                        </h2>

                                        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                            {product.benefits.slice(0, 6).map((benefit, index) => (
                                                <li
                                                    key={`${benefit}-${index}`}
                                                    style={{
                                                        display: 'flex',
                                                        gap: 10,
                                                        alignItems: 'flex-start',
                                                        color: '#334155',
                                                        marginBottom: 9,
                                                        lineHeight: 1.6,
                                                    }}
                                                >
                                                    <span style={{ color: '#10b981', fontWeight: 950 }}>✓</span>
                                                    <span>{benefit}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {Array.isArray(product.warnings) && product.warnings.length > 0 && (
                                    <div
                                        style={{
                                            background: '#fffbeb',
                                            border: '1px solid #fde68a',
                                            borderRadius: 22,
                                            padding: 22,
                                            marginBottom: 18,
                                        }}
                                    >
                                        <h2
                                            style={{
                                                margin: '0 0 12px',
                                                color: '#92400e',
                                                fontSize: 18,
                                                fontWeight: 950,
                                            }}
                                        >
                                            Cần kiểm tra trước khi mua
                                        </h2>

                                        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                            {product.warnings.slice(0, 6).map((warning, index) => (
                                                <li
                                                    key={`${warning}-${index}`}
                                                    style={{
                                                        display: 'flex',
                                                        gap: 10,
                                                        alignItems: 'flex-start',
                                                        color: '#92400e',
                                                        marginBottom: 8,
                                                        lineHeight: 1.6,
                                                    }}
                                                >
                                                    <span>!</span>
                                                    <span>{warning}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                <div style={{ marginTop: 24 }}>
                                    {dealUrl ? (
                                        <a
                                            href={dealUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                                display: 'block',
                                                width: '100%',
                                                textAlign: 'center',
                                                background: 'linear-gradient(135deg, #06b6d4, #2563eb)',
                                                color: '#ffffff',
                                                borderRadius: 18,
                                                padding: '18px 22px',
                                                textDecoration: 'none',
                                                fontWeight: 950,
                                                fontSize: 18,
                                                boxShadow: '0 18px 34px rgba(37,99,235,0.22)',
                                            }}
                                        >
                                            Đến trang mua hàng
                                        </a>
                                    ) : (
                                        <div
                                            style={{
                                                width: '100%',
                                                textAlign: 'center',
                                                background: '#cbd5e1',
                                                color: '#ffffff',
                                                borderRadius: 18,
                                                padding: '18px 22px',
                                                fontWeight: 950,
                                                fontSize: 18,
                                            }}
                                        >
                                            Sản phẩm chưa sẵn sàng
                                        </div>
                                    )}

                                    <p
                                        style={{
                                            textAlign: 'center',
                                            margin: '12px 0 0',
                                            color: '#64748b',
                                            fontSize: 13,
                                            lineHeight: 1.6,
                                        }}
                                    >
                                        SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này,
                                        nhưng giá của bạn không thay đổi.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {relatedDeals.length > 0 && (
                    <section style={{ padding: '0 0 68px' }}>
                        <div className="market-container">
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'flex-end',
                                    marginBottom: 22,
                                }}
                            >
                                <div>
                                    <h2
                                        style={{
                                            color: '#0f172a',
                                            fontSize: 28,
                                            fontWeight: 950,
                                            margin: 0,
                                            letterSpacing: '-0.04em',
                                        }}
                                    >
                                        Deal khác có thể bạn thích
                                    </h2>
                                    <p style={{ color: '#64748b', margin: '8px 0 0' }}>
                                        Sản phẩm đã được duyệt qua hệ thống
                                    </p>
                                </div>

                                <Link
                                    href="/deals"
                                    style={{
                                        color: '#06b6d4',
                                        textDecoration: 'none',
                                        fontWeight: 950,
                                    }}
                                >
                                    Xem tất cả →
                                </Link>
                            </div>

                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(238px, 1fr))',
                                    gap: 22,
                                }}
                            >
                                {relatedDeals.map((item) => {
                                    const relatedDiscount = getDiscountPercent(item);
                                    const relatedPlatform = getPlatformLabel(String(item.platform || 'other'));

                                    return (
                                        <article
                                            key={item.id}
                                            style={{
                                                background: '#ffffff',
                                                border: '1px solid #e8edf5',
                                                borderRadius: 22,
                                                overflow: 'hidden',
                                                boxShadow: '0 18px 40px rgba(15,23,42,0.05)',
                                            }}
                                        >
                                            <Link
                                                href={`/deals/${item.slug}`}
                                                style={{ display: 'block', textDecoration: 'none' }}
                                            >
                                                <ProductCardImage
                                                    product={item}
                                                    platformLabel={relatedPlatform}
                                                    discount={relatedDiscount}
                                                />
                                            </Link>

                                            <div style={{ padding: 16 }}>
                                                <Link
                                                    href={`/deals/${item.slug}`}
                                                    style={{ textDecoration: 'none', color: '#0f172a' }}
                                                >
                                                    <h3
                                                        style={{
                                                            fontSize: 15,
                                                            lineHeight: 1.45,
                                                            minHeight: 44,
                                                            margin: '0 0 12px',
                                                            fontWeight: 950,
                                                        }}
                                                    >
                                                        {item.title}
                                                    </h3>
                                                </Link>

                                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                                    <strong style={{ color: '#06b6d4', fontSize: 18 }}>
                                                        {formatPrice(item.salePrice || item.price)}
                                                    </strong>

                                                    {item.salePrice && item.price && item.salePrice !== item.price && (
                                                        <span
                                                            style={{
                                                                color: '#94a3b8',
                                                                textDecoration: 'line-through',
                                                                fontSize: 13,
                                                            }}
                                                        >
                              {formatPrice(item.price)}
                            </span>
                                                    )}
                                                </div>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </div>
                    </section>
                )}

                <section id="disclosure" style={{ padding: '0 0 54px' }}>
                    <div className="market-container" style={{ maxWidth: 880 }}>
                        <div
                            style={{
                                background: '#ffffff',
                                border: '1px solid #e8edf5',
                                borderRadius: 20,
                                padding: 26,
                                textAlign: 'center',
                                color: '#64748b',
                                lineHeight: 1.75,
                            }}
                        >
                            <h3 style={{ margin: '0 0 8px', color: '#0f172a', fontWeight: 950 }}>
                                Minh bạch Affiliate
                            </h3>
                            SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này, nhưng{' '}
                            <strong>giá của bạn không thay đổi</strong>. Giá, tồn kho và ưu đãi
                            có thể thay đổi theo thời điểm. Bạn nên kiểm tra lại thông tin trên
                            trang bán hàng trước khi mua.
                        </div>
                    </div>
                </section>
            </main>

            <footer
                style={{
                    background: '#0f172a',
                    color: '#cbd5e1',
                    padding: '48px 0 30px',
                }}
            >
                <div
                    className="market-container"
                    style={{
                        display: 'grid',
                        gridTemplateColumns: '1.2fr 1fr 1fr 1fr',
                        gap: 40,
                    }}
                >
                    <div>
                        <div style={{ fontSize: 22, fontWeight: 950, color: '#ffffff', marginBottom: 12 }}>
                            SanDeal
                        </div>
                        <p style={{ margin: 0, color: '#94a3b8', lineHeight: 1.7 }}>
                            Tổng hợp ưu đãi công nghệ, sản phẩm đáng mua và link affiliate minh bạch.
                        </p>
                    </div>

                    <div>
                        <h4 style={{ color: '#ffffff', marginTop: 0 }}>Danh mục</h4>
                        <p>Trang chủ</p>
                        <p>Deal hot</p>
                        <p>Tìm kiếm</p>
                    </div>

                    <div>
                        <h4 style={{ color: '#ffffff', marginTop: 0 }}>Chính sách</h4>
                        <p>Công bố Affiliate</p>
                        <p>Lưu ý về giá</p>
                        <p>Bảo mật</p>
                    </div>

                    <div>
                        <h4 style={{ color: '#ffffff', marginTop: 0 }}>Liên hệ</h4>
                        <p>Hỗ trợ: support@sandeal.tech</p>
                    </div>
                </div>

                <div
                    className="market-container"
                    style={{
                        borderTop: '1px solid rgba(148,163,184,0.2)',
                        marginTop: 34,
                        paddingTop: 22,
                        textAlign: 'center',
                        color: '#64748b',
                        fontSize: 13,
                        lineHeight: 1.7,
                    }}
                >
                    © 2026 SanDeal. SanDeal là nền tảng so sánh giá độc lập và có thể nhận
                    hoa hồng Affiliate từ các liên kết. Chúng tôi không trực tiếp bán hàng;
                    mọi giao dịch, giá cả do nhà bán trên sàn TMĐT chịu trách nhiệm.
                </div>
            </footer>
        </div>
    );
}