import Link from 'next/link';
import { getPublishedProducts } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

type PublishedProduct = Awaited<ReturnType<typeof getPublishedProducts>>[number];

const PLATFORMS: Record<string, string> = {
    shopee: 'Shopee',
    tiktok_shop: 'TikTok Shop',
    lazada: 'Lazada',
    accesstrade: 'AccessTrade',
    website: 'Website',
    other: 'Khác',
};

const CATEGORIES = [
    { name: 'Điện tử', icon: '⚡' },
    { name: 'Gia dụng', icon: '🏠' },
    { name: 'Thời trang', icon: '👕' },
    { name: 'Làm đẹp', icon: '✨' },
    { name: 'Mẹ & bé', icon: '🧸' },
    { name: 'Phụ kiện', icon: '🎧' },
    { name: 'Văn phòng', icon: '💼' },
    { name: 'Deal mới', icon: '🔥' },
];

const DEAL_TABS = [
    'Deal chạm đáy',
    'Siêu Sale',
    'Bán chạy',
    'Mới cập nhật',
    'Mã giảm giá',
    'Khám phá',
];

const PRICE_FILTERS = ['Tất cả giá', 'Dưới 500K', '500K - 1 Triệu', 'Trên 1 Triệu'];

function formatPrice(price?: number | null) {
    if (!price || price <= 0) return 'Đang cập nhật';
    return `${price.toLocaleString('vi-VN')}₫`;
}

function getDiscountPercent(price?: number | null, salePrice?: number | null) {
    if (!price || !salePrice || price <= 0 || salePrice <= 0 || price <= salePrice) return 0;
    return Math.round((1 - salePrice / price) * 100);
}

function normalizeExternalUrl(value?: unknown) {
    if (typeof value !== 'string') return '';

    const url = value.trim();
    if (!url) return '';

    if (url.startsWith('//')) return `https:${url}`;
    if (/^https?:\/\//i.test(url)) return url;

    return '';
}

function normalizeImageUrl(value?: unknown) {
    if (typeof value !== 'string') return '';

    const url = value.trim();
    if (!url) return '';

    if (url.startsWith('//')) return `https:${url}`;
    if (/^https?:\/\//i.test(url)) return url;

    return '';
}

function getProductBuyUrl(product: PublishedProduct) {
    const fallbackUrl = (product as { url?: unknown }).url;

    return (
        normalizeExternalUrl(product.affiliateUrl) ||
        normalizeExternalUrl(product.originalUrl) ||
        normalizeExternalUrl(fallbackUrl)
    );
}

function SafeProductImage({
                              imageUrl,
                              title,
                              platformLabel,
                              discount,
                          }: {
    imageUrl?: string | null;
    title: string;
    platformLabel: string;
    discount: number;
}) {
    const safeImageUrl = normalizeImageUrl(imageUrl);

    return (
        <div
            aria-label={title}
            role="img"
            style={{
                position: 'relative',
                aspectRatio: '1 / 1',
                background:
                    'linear-gradient(135deg, rgba(239,246,255,0.98), rgba(245,250,255,0.98))',
                display: 'grid',
                placeItems: 'center',
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    display: 'grid',
                    placeItems: 'center',
                    gap: 8,
                    color: '#94a3b8',
                    textAlign: 'center',
                    padding: 18,
                    position: 'relative',
                    zIndex: 0,
                }}
            >
                <div
                    style={{
                        width: 42,
                        height: 42,
                        borderRadius: 16,
                        display: 'grid',
                        placeItems: 'center',
                        background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                        color: '#ffffff',
                        fontWeight: 950,
                        boxShadow: '0 14px 32px rgba(37,99,235,0.16)',
                    }}
                >
                    S
                </div>
                <div style={{ fontSize: 12, fontWeight: 900, color: '#0f172a' }}>
                    Ảnh đang cập nhật
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.4 }}>
                    Ảnh gốc có thể không còn khả dụng từ nguồn bán hàng
                </div>
            </div>

            {safeImageUrl ? (
                <div
                    aria-hidden="true"
                    style={{
                        position: 'absolute',
                        inset: 0,
                        zIndex: 1,
                        backgroundImage: `url(${JSON.stringify(safeImageUrl)})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        backgroundRepeat: 'no-repeat',
                    }}
                />
            ) : null}

            <div
                style={{
                    position: 'absolute',
                    top: 12,
                    left: 12,
                    zIndex: 2,
                    borderRadius: 999,
                    background: '#ffffff',
                    color: '#0f172a',
                    padding: '6px 10px',
                    fontSize: 11,
                    fontWeight: 900,
                    boxShadow: '0 8px 20px rgba(15,23,42,0.1)',
                    maxWidth: 'calc(100% - 24px)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {platformLabel}
            </div>

            {discount > 0 ? (
                <div
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 12,
                        zIndex: 2,
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
            ) : null}
        </div>
    );
}

export default async function HomePage() {
    let products: Awaited<ReturnType<typeof getPublishedProducts>> = [];

    try {
        const data = await getPublishedProducts();
        if (Array.isArray(data)) products = data;
    } catch {
        products = [];
    }

    const featured = products.slice(0, 12);

    return (
        <div
            className="market-shell"
            style={{
                background: 'linear-gradient(180deg, #f8fbff 0%, #ffffff 42%, #f5f8fc 100%)',
                minHeight: '100vh',
            }}
        >
            <div
                style={{
                    background: 'linear-gradient(90deg, #6d5dfc 0%, #06b6d4 100%)',
                    color: '#ffffff',
                    fontSize: 13,
                    fontWeight: 700,
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
                    className="market-container market-header-inner"
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
                        className="market-logo"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            textDecoration: 'none',
                            fontWeight: 900,
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
                    fontWeight: 900,
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
                        className="market-nav-links"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 22,
                            listStyle: 'none',
                            margin: 0,
                            padding: 0,
                            fontSize: 14,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <Link href="/" style={{ color: '#0f172a', textDecoration: 'none' }}>
                            Trang chủ
                        </Link>
                        <Link href="/deals" style={{ color: '#0ea5e9', textDecoration: 'none' }}>
                            Deal hot
                        </Link>
                        <Link href="/deals" style={{ color: '#475569', textDecoration: 'none' }}>
                            Danh mục
                        </Link>
                        <Link href="#how-it-works" style={{ color: '#475569', textDecoration: 'none' }}>
                            Cách hoạt động
                        </Link>
                        <Link href="#disclosure" style={{ color: '#475569', textDecoration: 'none' }}>
                            Minh bạch affiliate
                        </Link>
                    </nav>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
                style={{
                    border: '1px solid #e2e8f0',
                    background: '#ffffff',
                    borderRadius: 999,
                    padding: '8px 10px',
                    fontSize: 12,
                    fontWeight: 800,
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
                                fontWeight: 800,
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
                        padding: '54px 0 34px',
                        background:
                            'radial-gradient(circle at 50% 0%, rgba(59,130,246,0.13), transparent 42%)',
                    }}
                >
                    <div className="market-container" style={{ textAlign: 'center' }}>
                        <div
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '10px 18px',
                                borderRadius: 999,
                                background: '#ffffff',
                                color: '#2563eb',
                                border: '1px solid #dbeafe',
                                boxShadow: '0 12px 30px rgba(37, 99, 235, 0.08)',
                                fontWeight: 800,
                                fontSize: 14,
                                marginBottom: 24,
                            }}
                        >
                            <span>⚡</span>
                            <span>Hệ thống lọc deal tự động có kiểm soát</span>
                        </div>

                        <h1
                            style={{
                                fontSize: 'clamp(42px, 6vw, 76px)',
                                lineHeight: 0.98,
                                letterSpacing: '-0.07em',
                                fontWeight: 950,
                                color: '#0f172a',
                                margin: '0 auto 22px',
                                maxWidth: 920,
                            }}
                        >
                            Săn Deal Thông Minh
                            <br />
                            <span
                                style={{
                                    background: 'linear-gradient(90deg, #2563eb, #6d5dfc, #06b6d4)',
                                    WebkitBackgroundClip: 'text',
                                    color: 'transparent',
                                }}
                            >
                Nhanh Nhất & Minh Bạch
              </span>
                        </h1>

                        <p
                            style={{
                                maxWidth: 720,
                                margin: '0 auto',
                                color: '#64748b',
                                fontSize: 18,
                                lineHeight: 1.75,
                            }}
                        >
                            SanDeal tổng hợp sản phẩm đáng mua, ưu đãi nổi bật và link affiliate
                            minh bạch để bạn dễ so sánh trước khi bấm mua.
                        </p>

                        <div
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(4, minmax(160px, 1fr))',
                                gap: 18,
                                maxWidth: 920,
                                margin: '46px auto 0',
                            }}
                        >
                            {[
                                ['⏱', 'Giá tham khảo', 'Giá có thể thay đổi.'],
                                ['🔗', 'Link minh bạch', 'Affiliate rõ ràng.'],
                                ['🛡', 'Ưu tiên uy tín', 'Lọc nguồn đáng tin.'],
                                ['📈', 'So sánh nhanh', 'Xem deal nổi bật.'],
                            ].map(([icon, title, desc]) => (
                                <div
                                    key={title}
                                    style={{
                                        background: '#ffffff',
                                        border: '1px solid #e8edf5',
                                        borderRadius: 20,
                                        padding: 22,
                                        boxShadow: '0 18px 40px rgba(15,23,42,0.05)',
                                    }}
                                >
                                    <div style={{ fontSize: 24, marginBottom: 10 }}>{icon}</div>
                                    <div style={{ fontWeight: 900, color: '#0f172a', marginBottom: 4 }}>
                                        {title}
                                    </div>
                                    <div style={{ color: '#64748b', fontSize: 13 }}>{desc}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                <section style={{ padding: '22px 0 10px' }}>
                    <div
                        className="market-container"
                        style={{
                            display: 'flex',
                            justifyContent: 'center',
                            gap: 14,
                            flexWrap: 'wrap',
                        }}
                    >
                        {CATEGORIES.map((category) => (
                            <Link
                                href="/deals"
                                key={category.name}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    minWidth: 122,
                                    padding: '14px 16px',
                                    borderRadius: 18,
                                    background: '#ffffff',
                                    border: '1px solid #e8edf5',
                                    color: '#0f172a',
                                    textDecoration: 'none',
                                    fontWeight: 800,
                                    boxShadow: '0 12px 26px rgba(15,23,42,0.04)',
                                }}
                            >
                <span
                    style={{
                        width: 32,
                        height: 32,
                        borderRadius: 12,
                        display: 'grid',
                        placeItems: 'center',
                        background: '#eef2ff',
                    }}
                >
                  {category.icon}
                </span>
                                <span>{category.name}</span>
                            </Link>
                        ))}
                    </div>
                </section>

                <section id="how-it-works" style={{ padding: '44px 0 52px' }}>
                    <div className="market-container">
                        <div style={{ textAlign: 'center', marginBottom: 30 }}>
                            <h2
                                style={{
                                    color: '#0f172a',
                                    fontSize: 28,
                                    fontWeight: 950,
                                    marginBottom: 8,
                                    letterSpacing: '-0.04em',
                                }}
                            >
                                Nguồn dữ liệu & quy trình kiểm tra
                            </h2>
                            <p style={{ color: '#64748b', margin: 0 }}>
                                Deal chỉ hiển thị khi vượt qua bộ lọc sản phẩm thật và link an toàn.
                            </p>
                        </div>

                        <div
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(4, minmax(180px, 1fr))',
                                gap: 18,
                            }}
                        >
                            {[
                                ['1', 'Nguồn sản phẩm thật', 'Lấy dữ liệu từ AccessTrade, Shopee, TikTok Shop...'],
                                ['2', 'AI lọc cơ hội', 'Loại bỏ voucher/campaign giả dạng sản phẩm.'],
                                ['3', 'Kiểm tra link', 'Ưu tiên link affiliate minh bạch, hạn chế link lỗi.'],
                                ['4', 'Safe Publish', 'AutoPilot chỉ public sản phẩm đạt chuẩn an toàn.'],
                            ].map(([step, title, desc]) => (
                                <div
                                    key={step}
                                    style={{
                                        background: '#ffffff',
                                        border: '1px solid #e8edf5',
                                        borderRadius: 20,
                                        padding: 26,
                                        minHeight: 178,
                                    }}
                                >
                                    <div
                                        style={{
                                            width: 44,
                                            height: 44,
                                            borderRadius: 14,
                                            display: 'grid',
                                            placeItems: 'center',
                                            background: '#f0f9ff',
                                            color: '#06b6d4',
                                            fontWeight: 950,
                                            fontSize: 18,
                                            marginBottom: 18,
                                            boxShadow: '0 10px 20px rgba(6,182,212,0.1)',
                                        }}
                                    >
                                        {step}
                                    </div>
                                    <h3 style={{ margin: '0 0 8px', color: '#0f172a', fontWeight: 900 }}>
                                        {title}
                                    </h3>
                                    <p style={{ margin: 0, color: '#64748b', lineHeight: 1.65, fontSize: 14 }}>
                                        {desc}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                <section style={{ padding: '28px 0 68px' }}>
                    <div className="market-container">
                        <div
                            style={{
                                background: '#ffffff',
                                border: '1px solid #e8edf5',
                                borderRadius: 24,
                                padding: 18,
                                marginBottom: 34,
                                boxShadow: '0 18px 40px rgba(15,23,42,0.05)',
                            }}
                        >
                            <div
                                style={{
                                    display: 'flex',
                                    gap: 8,
                                    flexWrap: 'wrap',
                                    borderBottom: '1px solid #edf2f7',
                                    paddingBottom: 14,
                                    marginBottom: 14,
                                }}
                            >
                                <button
                                    type="button"
                                    style={{
                                        border: '1px solid #dbeafe',
                                        background: '#ffffff',
                                        borderRadius: 14,
                                        padding: '12px 18px',
                                        fontWeight: 900,
                                        color: '#0f172a',
                                    }}
                                >
                                    ☷ Danh mục
                                </button>

                                {DEAL_TABS.map((tab, index) => (
                                    <Link
                                        key={tab}
                                        href="/deals"
                                        style={{
                                            border: 0,
                                            background: index === 0 ? '#eff6ff' : 'transparent',
                                            borderBottom: index === 0 ? '3px solid #2563eb' : '3px solid transparent',
                                            color: index === 0 ? '#2563eb' : '#475569',
                                            padding: '12px 16px',
                                            fontWeight: 900,
                                            textDecoration: 'none',
                                        }}
                                    >
                                        {tab}
                                    </Link>
                                ))}
                            </div>

                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                {PRICE_FILTERS.map((filter, index) => (
                                    <Link
                                        href="/deals"
                                        key={filter}
                                        style={{
                                            borderRadius: 999,
                                            padding: '10px 16px',
                                            background: index === 0 ? '#0f172a' : '#ffffff',
                                            color: index === 0 ? '#ffffff' : '#475569',
                                            border: '1px solid #e2e8f0',
                                            textDecoration: 'none',
                                            fontWeight: 800,
                                            fontSize: 13,
                                        }}
                                    >
                                        {filter}
                                    </Link>
                                ))}
                            </div>
                        </div>

                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'flex-end',
                                gap: 16,
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
                                    Deal nổi bật hôm nay
                                </h2>
                                <p style={{ color: '#64748b', margin: '8px 0 0' }}>
                                    Sản phẩm đã được duyệt qua hệ thống AI
                                </p>
                            </div>
                            <Link
                                href="/deals"
                                style={{
                                    color: '#06b6d4',
                                    textDecoration: 'none',
                                    fontWeight: 900,
                                }}
                            >
                                Xem tất cả →
                            </Link>
                        </div>

                        {featured.length === 0 ? (
                            <div
                                style={{
                                    textAlign: 'center',
                                    padding: '86px 24px',
                                    background: '#ffffff',
                                    borderRadius: 24,
                                    border: '1px dashed #dbe3ef',
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: 38,
                                        marginBottom: 14,
                                        color: '#cbd5e1',
                                        fontWeight: 950,
                                    }}
                                >
                                    S
                                </div>
                                <h3
                                    style={{
                                        fontSize: 22,
                                        fontWeight: 950,
                                        margin: '0 0 8px',
                                        color: '#0f172a',
                                    }}
                                >
                                    Chưa có deal thật đã duyệt
                                </h3>
                                <p
                                    style={{
                                        color: '#64748b',
                                        maxWidth: 560,
                                        margin: '0 auto',
                                        lineHeight: 1.7,
                                    }}
                                >
                                    Hệ thống đang chờ nguồn sản phẩm từ AccessTrade hoặc nguồn nội bộ.
                                    Các deal sẽ xuất hiện ở đây sau khi được kiểm duyệt.
                                </p>
                            </div>
                        ) : (
                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(238px, 1fr))',
                                    gap: 22,
                                }}
                            >
                                {featured.map((product) => {
                                    const discount = getDiscountPercent(product.price, product.salePrice);
                                    const platformLabel =
                                        PLATFORMS[String(product.platform || 'other')] ||
                                        String(product.platform || 'Khác');
                                    const buyUrl = getProductBuyUrl(product);

                                    return (
                                        <article
                                            key={product.id}
                                            style={{
                                                background: '#ffffff',
                                                border: '1px solid #e8edf5',
                                                borderRadius: 22,
                                                overflow: 'hidden',
                                                boxShadow: '0 18px 40px rgba(15,23,42,0.05)',
                                            }}
                                        >
                                            <Link
                                                href={`/deals/${product.slug}`}
                                                style={{ display: 'block', textDecoration: 'none' }}
                                            >
                                                <SafeProductImage
                                                    imageUrl={product.imageUrl}
                                                    title={product.title}
                                                    platformLabel={platformLabel}
                                                    discount={discount}
                                                />
                                            </Link>

                                            <div style={{ padding: 16 }}>
                                                <Link
                                                    href={`/deals/${product.slug}`}
                                                    style={{
                                                        textDecoration: 'none',
                                                        color: '#0f172a',
                                                    }}
                                                >
                                                    <h3
                                                        style={{
                                                            fontSize: 15,
                                                            lineHeight: 1.45,
                                                            minHeight: 44,
                                                            margin: '0 0 12px',
                                                            fontWeight: 900,
                                                        }}
                                                    >
                                                        {product.title}
                                                    </h3>
                                                </Link>

                                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                                    <strong style={{ color: '#06b6d4', fontSize: 18 }}>
                                                        {formatPrice(product.salePrice || product.price)}
                                                    </strong>
                                                    {product.salePrice &&
                                                        product.price &&
                                                        product.salePrice !== product.price && (
                                                            <span
                                                                style={{
                                                                    color: '#94a3b8',
                                                                    textDecoration: 'line-through',
                                                                    fontSize: 13,
                                                                }}
                                                            >
                                {formatPrice(product.price)}
                              </span>
                                                        )}
                                                </div>

                                                <div
                                                    style={{
                                                        marginTop: 10,
                                                        color: '#f59e0b',
                                                        fontSize: 12,
                                                        fontWeight: 800,
                                                    }}
                                                >
                                                    Giá có thể thay đổi
                                                </div>

                                                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                                                    {buyUrl ? (
                                                        <a
                                                            href={buyUrl}
                                                            target="_blank"
                                                            rel="nofollow sponsored noopener noreferrer"
                                                            style={{
                                                                flex: 1,
                                                                textAlign: 'center',
                                                                background: '#06b6d4',
                                                                color: '#ffffff',
                                                                borderRadius: 12,
                                                                padding: '11px 12px',
                                                                textDecoration: 'none',
                                                                fontWeight: 900,
                                                                fontSize: 13,
                                                            }}
                                                        >
                                                            Xem deal
                                                        </a>
                                                    ) : (
                                                        <span
                                                            style={{
                                                                flex: 1,
                                                                textAlign: 'center',
                                                                background: '#cbd5e1',
                                                                color: '#ffffff',
                                                                borderRadius: 12,
                                                                padding: '11px 12px',
                                                                fontWeight: 900,
                                                                fontSize: 13,
                                                            }}
                                                        >
                              Chưa có link
                            </span>
                                                    )}

                                                    <Link
                                                        href={`/deals/${product.slug}`}
                                                        style={{
                                                            textAlign: 'center',
                                                            background: '#f1f5f9',
                                                            color: '#0f172a',
                                                            borderRadius: 12,
                                                            padding: '11px 14px',
                                                            textDecoration: 'none',
                                                            fontWeight: 900,
                                                            fontSize: 13,
                                                        }}
                                                    >
                                                        Chi tiết
                                                    </Link>
                                                </div>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>

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
                            Một số liên kết trên SanDeal có thể là liên kết tiếp thị liên kết
                            affiliate. SanDeal có thể nhận hoa hồng nếu bạn mua qua liên kết này,
                            nhưng <strong> giá của bạn không thay đổi</strong>. Giá, tồn kho và
                            ưu đãi có thể thay đổi theo thời điểm.
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
                            Tổng hợp ưu đãi công nghệ, sản phẩm đáng mua và link affiliate minh
                            bạch.
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