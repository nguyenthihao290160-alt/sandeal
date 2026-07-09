'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Product } from '@/lib/types';

const PLATFORMS: Record<string, string> = {
    shopee: 'Shopee',
    tiktok_shop: 'TikTok Shop',
    lazada: 'Lazada',
    accesstrade: 'AccessTrade',
    website: 'Website',
    other: 'Khác',
};

const PLATFORM_FILTERS = [
    { label: 'Tất cả', value: '' },
    { label: 'Shopee', value: 'shopee' },
    { label: 'TikTok Shop', value: 'tiktok_shop' },
    { label: 'Lazada', value: 'lazada' },
    { label: 'AccessTrade', value: 'accesstrade' },
];

const DEAL_TABS = [
    { label: 'Deal chạm đáy', value: 'bottom_deal' },
    { label: 'Siêu Sale', value: 'super_sale' },
    { label: 'Bán chạy', value: 'best_seller' },
    { label: 'Mới cập nhật', value: 'newest' },
    { label: 'Mã giảm giá', value: 'voucher' },
    { label: 'Khám phá', value: 'discover' },
];

const QUICK_FILTERS = [
    { label: 'Tất cả', value: '' },
    { label: 'Có ảnh', value: 'has_image' },
    { label: 'Đã duyệt', value: 'approved' },
    { label: 'Giá tốt', value: 'good_price' },
    { label: 'Nên xem', value: 'recommended' },
    { label: 'Điểm cao', value: 'high_score' },
];

const PRICE_FILTERS = [
    { label: 'Tất cả giá', value: '' },
    { label: 'Dưới 500K', value: 'under_500k' },
    { label: '500K - 1 Triệu', value: '500k_1m' },
    { label: 'Trên 1 Triệu', value: 'over_1m' },
];

const SORTS = [
    { label: 'Phổ biến', value: 'popular' },
    { label: 'Khuyến mãi HOT', value: 'hot_sale' },
    { label: 'Deal mới', value: 'newest' },
    { label: 'Giá thấp - cao', value: 'price_asc' },
    { label: 'Giá cao - thấp', value: 'price_desc' },
    { label: 'Điểm tốt nhất', value: 'score_desc' },
];

type ProductRecord = Product & Record<string, unknown>;

function formatPrice(price?: number) {
    if (!price) return 'Đang cập nhật';
    return `${price.toLocaleString('vi-VN')}₫`;
}

function getDealPrice(product: Product) {
    return product.salePrice || product.price || 0;
}

function getDiscountPercent(product: Product) {
    if (!product.price || !product.salePrice || product.price <= product.salePrice) {
        return 0;
    }

    return Math.round((1 - product.salePrice / product.price) * 100);
}

function getRecordUrl(product: Product) {
    const record = product as ProductRecord;
    return typeof record.url === 'string' ? record.url : '';
}

function getBuyUrl(product: Product) {
    return product.affiliateUrl || product.originalUrl || getRecordUrl(product);
}

function isPublicProduct(product: Product) {
    const record = product as ProductRecord;

    if (!product) return false;
    if (product.status !== 'approved' && product.status !== 'published') return false;
    if (record.publicHidden === true) return false;
    if (product.kind === 'voucher' || product.kind === 'campaign' || product.kind === 'store_offer') {
        return false;
    }
    if (!product.title || !String(product.title).trim()) return false;
    if (!getBuyUrl(product)) return false;

    return true;
}

function applyQuickFilter(products: Product[], activeFilter: string) {
    if (!activeFilter) return products;

    if (activeFilter === 'has_image') {
        return products.filter((product) => Boolean(product.imageUrl));
    }

    if (activeFilter === 'approved') {
        return products.filter(
            (product) => product.status === 'approved' || product.status === 'published',
        );
    }

    if (activeFilter === 'good_price') {
        return products.filter(
            (product) => Boolean(product.salePrice && product.price && product.salePrice < product.price),
        );
    }

    if (activeFilter === 'recommended') {
        return products.filter((product) => {
            const score = product.score ?? 0;
            const discount = getDiscountPercent(product);
            return score >= 60 || discount >= 10;
        });
    }

    if (activeFilter === 'high_score') {
        return products.filter((product) => (product.score ?? 0) >= 75);
    }

    return products;
}

function applyPriceFilter(products: Product[], priceFilter: string) {
    if (!priceFilter) return products;

    return products.filter((product) => {
        const price = getDealPrice(product);

        if (!price) return false;
        if (priceFilter === 'under_500k') return price < 500_000;
        if (priceFilter === '500k_1m') return price >= 500_000 && price <= 1_000_000;
        if (priceFilter === 'over_1m') return price > 1_000_000;

        return true;
    });
}

function sortProducts(products: Product[], activeSort: string, activeTab: string) {
    const list = [...products];

    if (activeSort === 'price_asc') {
        return list.sort((a, b) => getDealPrice(a) - getDealPrice(b));
    }

    if (activeSort === 'price_desc') {
        return list.sort((a, b) => getDealPrice(b) - getDealPrice(a));
    }

    if (activeSort === 'score_desc') {
        return list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    if (activeSort === 'hot_sale' || activeTab === 'super_sale' || activeTab === 'bottom_deal') {
        return list.sort((a, b) => getDiscountPercent(b) - getDiscountPercent(a));
    }

    if (activeSort === 'newest' || activeTab === 'newest') {
        return list.reverse();
    }

    return list.sort((a, b) => {
        const scoreA = a.score ?? 0;
        const scoreB = b.score ?? 0;
        const discountA = getDiscountPercent(a);
        const discountB = getDiscountPercent(b);

        return scoreB + discountB - (scoreA + discountA);
    });
}

function SafeProductImage({
                              src,
                              alt,
                          }: {
    src?: string | null;
    alt: string;
}) {
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [src]);

    const cleanSrc = typeof src === 'string' ? src.trim() : '';
    const shouldShowImage = cleanSrc && !failed;

    if (!shouldShowImage) {
        return (
            <div
                aria-label={alt}
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'grid',
                    placeItems: 'center',
                    padding: 18,
                    background:
                        'radial-gradient(circle at 50% 20%, rgba(14,165,233,0.14), transparent 34%), linear-gradient(135deg, #f8fafc 0%, #eef6ff 100%)',
                    color: '#64748b',
                    textAlign: 'center',
                }}
            >
                <div>
                    <div
                        style={{
                            width: 58,
                            height: 58,
                            margin: '0 auto 12px',
                            borderRadius: 18,
                            display: 'grid',
                            placeItems: 'center',
                            background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                            color: '#ffffff',
                            fontWeight: 950,
                            fontSize: 24,
                            boxShadow: '0 18px 38px rgba(37,99,235,0.18)',
                        }}
                    >
                        S
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 950, color: '#0f172a' }}>
                        Ảnh đang cập nhật
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginTop: 4 }}>
                        SanDeal đã giữ sản phẩm, ảnh gốc có thể không còn khả dụng
                    </div>
                </div>
            </div>
        );
    }

    return (
        <img
            src={cleanSrc}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
            }}
        />
    );
}

export default function DealsPage() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);

    const [search, setSearch] = useState('');
    const [platform, setPlatform] = useState('');
    const [activeTab, setActiveTab] = useState('bottom_deal');
    const [activeFilter, setActiveFilter] = useState('');
    const [priceFilter, setPriceFilter] = useState('');
    const [activeSort, setActiveSort] = useState('popular');

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const initialSearch = params.get('q');

        if (initialSearch) {
            setSearch(initialSearch);
        }
    }, []);

    const loadDeals = useCallback(async () => {
        setLoading(true);

        try {
            const params = new URLSearchParams();
            params.set('public', 'true');

            if (search.trim()) params.set('q', search.trim());
            if (platform) params.set('platform', platform);

            const response = await fetch(`/api/products?${params.toString()}`, {
                cache: 'no-store',
            });

            const data = await response.json();

            if (data?.ok && Array.isArray(data.data)) {
                const safeProducts = data.data.filter((product: Product) => isPublicProduct(product));
                setProducts(safeProducts);
            } else {
                setProducts([]);
            }
        } catch {
            setProducts([]);
        } finally {
            setLoading(false);
        }
    }, [search, platform]);

    useEffect(() => {
        loadDeals();
    }, [loadDeals]);

    const visibleProducts = useMemo(() => {
        let list = products;

        list = applyQuickFilter(list, activeFilter);
        list = applyPriceFilter(list, priceFilter);
        list = sortProducts(list, activeSort, activeTab);

        return list;
    }, [products, activeFilter, priceFilter, activeSort, activeTab]);

    function clearFilters() {
        setSearch('');
        setPlatform('');
        setActiveTab('bottom_deal');
        setActiveFilter('');
        setPriceFilter('');
        setActiveSort('popular');
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
                    <span style={{ opacity: 0.95 }}>Giá sản phẩm có thể thay đổi theo thời điểm</span>
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
                        onSubmit={(event) => {
                            event.preventDefault();
                            loadDeals();
                        }}
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
                            placeholder="Tìm kiếm Deal ngon..."
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
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
                        padding: '54px 0 34px',
                        textAlign: 'center',
                        background: 'radial-gradient(circle at 50% 0%, rgba(59,130,246,0.13), transparent 46%)',
                    }}
                >
                    <div className="market-container">
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
                                fontWeight: 900,
                                fontSize: 14,
                                marginBottom: 24,
                            }}
                        >
                            ⚡ Hệ thống cập nhật deal tự động 24/7
                        </div>

                        <h1
                            style={{
                                fontSize: 'clamp(42px, 6vw, 72px)',
                                lineHeight: 0.98,
                                letterSpacing: '-0.07em',
                                fontWeight: 950,
                                color: '#0f172a',
                                margin: '0 auto 20px',
                                maxWidth: 920,
                            }}
                        >
                            Deal Hot & Ưu Đãi Mới
                            <br />
                            <span
                                style={{
                                    background: 'linear-gradient(90deg, #2563eb, #6d5dfc, #06b6d4)',
                                    WebkitBackgroundClip: 'text',
                                    color: 'transparent',
                                }}
                            >
                Đã Lọc An Toàn
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
                            Khám phá các sản phẩm đã được hệ thống kiểm tra link, lọc voucher
                            và chỉ hiển thị deal thật đủ điều kiện public.
                        </p>
                    </div>
                </section>

                <section style={{ padding: '18px 0 64px' }}>
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
                                        fontWeight: 950,
                                        color: '#0f172a',
                                    }}
                                >
                                    ☷ Danh mục
                                </button>

                                {DEAL_TABS.map((tab) => (
                                    <button
                                        type="button"
                                        key={tab.value}
                                        onClick={() => {
                                            setActiveTab(tab.value);
                                            if (tab.value === 'newest') setActiveSort('newest');
                                            if (tab.value === 'super_sale') setActiveSort('hot_sale');
                                        }}
                                        style={{
                                            border: 0,
                                            cursor: 'pointer',
                                            background: activeTab === tab.value ? '#eff6ff' : 'transparent',
                                            borderBottom:
                                                activeTab === tab.value ? '3px solid #2563eb' : '3px solid transparent',
                                            color: activeTab === tab.value ? '#2563eb' : '#475569',
                                            padding: '12px 16px',
                                            fontWeight: 950,
                                        }}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>

                            <div style={{ marginBottom: 16 }}>
                                <h3
                                    style={{
                                        margin: '0 0 10px',
                                        fontSize: 12,
                                        letterSpacing: '0.08em',
                                        textTransform: 'uppercase',
                                        color: '#64748b',
                                        fontWeight: 950,
                                    }}
                                >
                                    Nền tảng
                                </h3>
                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                    {PLATFORM_FILTERS.map((item) => (
                                        <button
                                            type="button"
                                            key={item.value}
                                            onClick={() => setPlatform(item.value)}
                                            style={{
                                                borderRadius: 999,
                                                padding: '10px 16px',
                                                background: platform === item.value ? '#06b6d4' : '#ffffff',
                                                color: platform === item.value ? '#ffffff' : '#475569',
                                                border:
                                                    platform === item.value ? '1px solid #06b6d4' : '1px solid #e2e8f0',
                                                cursor: 'pointer',
                                                fontWeight: 900,
                                                fontSize: 13,
                                            }}
                                        >
                                            {item.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div style={{ marginBottom: 16 }}>
                                <h3
                                    style={{
                                        margin: '0 0 10px',
                                        fontSize: 12,
                                        letterSpacing: '0.08em',
                                        textTransform: 'uppercase',
                                        color: '#64748b',
                                        fontWeight: 950,
                                    }}
                                >
                                    Lọc theo tiêu chí
                                </h3>
                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                    {QUICK_FILTERS.map((item) => (
                                        <button
                                            type="button"
                                            key={item.value}
                                            onClick={() => setActiveFilter(item.value)}
                                            style={{
                                                borderRadius: 999,
                                                padding: '10px 16px',
                                                background: activeFilter === item.value ? '#06b6d4' : '#ffffff',
                                                color: activeFilter === item.value ? '#ffffff' : '#475569',
                                                border:
                                                    activeFilter === item.value ? '1px solid #06b6d4' : '1px solid #e2e8f0',
                                                cursor: 'pointer',
                                                fontWeight: 900,
                                                fontSize: 13,
                                            }}
                                        >
                                            {item.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 1fr',
                                    gap: 18,
                                }}
                            >
                                <div>
                                    <h3
                                        style={{
                                            margin: '0 0 10px',
                                            fontSize: 12,
                                            letterSpacing: '0.08em',
                                            textTransform: 'uppercase',
                                            color: '#64748b',
                                            fontWeight: 950,
                                        }}
                                    >
                                        Khoảng giá
                                    </h3>
                                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                        {PRICE_FILTERS.map((item) => (
                                            <button
                                                type="button"
                                                key={item.value}
                                                onClick={() => setPriceFilter(item.value)}
                                                style={{
                                                    borderRadius: 999,
                                                    padding: '10px 16px',
                                                    background: priceFilter === item.value ? '#0f172a' : '#ffffff',
                                                    color: priceFilter === item.value ? '#ffffff' : '#475569',
                                                    border:
                                                        priceFilter === item.value ? '1px solid #0f172a' : '1px solid #e2e8f0',
                                                    cursor: 'pointer',
                                                    fontWeight: 900,
                                                    fontSize: 13,
                                                }}
                                            >
                                                {item.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <h3
                                        style={{
                                            margin: '0 0 10px',
                                            fontSize: 12,
                                            letterSpacing: '0.08em',
                                            textTransform: 'uppercase',
                                            color: '#64748b',
                                            fontWeight: 950,
                                        }}
                                    >
                                        Sắp xếp theo
                                    </h3>
                                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                        {SORTS.map((item) => (
                                            <button
                                                type="button"
                                                key={item.value}
                                                onClick={() => setActiveSort(item.value)}
                                                style={{
                                                    borderRadius: 999,
                                                    padding: '10px 16px',
                                                    background: activeSort === item.value ? '#0f172a' : '#ffffff',
                                                    color: activeSort === item.value ? '#ffffff' : '#475569',
                                                    border:
                                                        activeSort === item.value ? '1px solid #0f172a' : '1px solid #e2e8f0',
                                                    cursor: 'pointer',
                                                    fontWeight: 900,
                                                    fontSize: 13,
                                                }}
                                            >
                                                {item.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
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
                                    Danh sách deal đã duyệt
                                </h2>
                                <p style={{ color: '#64748b', margin: '8px 0 0' }}>
                                    {loading ? 'Đang tải dữ liệu...' : `${visibleProducts.length} deal đủ điều kiện hiển thị`}
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={clearFilters}
                                style={{
                                    border: '1px solid #e2e8f0',
                                    background: '#ffffff',
                                    color: '#475569',
                                    borderRadius: 999,
                                    padding: '11px 16px',
                                    fontWeight: 900,
                                    cursor: 'pointer',
                                }}
                            >
                                Xóa bộ lọc
                            </button>
                        </div>

                        {loading && (
                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(238px, 1fr))',
                                    gap: 22,
                                }}
                            >
                                {Array.from({ length: 8 }).map((_, index) => (
                                    <div
                                        key={index}
                                        style={{
                                            height: 360,
                                            borderRadius: 22,
                                            background: 'linear-gradient(90deg, #ffffff 0%, #f1f5f9 45%, #ffffff 100%)',
                                            border: '1px solid #e8edf5',
                                        }}
                                    />
                                ))}
                            </div>
                        )}

                        {!loading && visibleProducts.length === 0 && (
                            <div
                                style={{
                                    textAlign: 'center',
                                    padding: '90px 24px',
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
                                    Hiện chưa có deal đủ chuẩn an toàn để hiển thị
                                </h3>
                                <p
                                    style={{
                                        color: '#64748b',
                                        maxWidth: 560,
                                        margin: '0 auto 18px',
                                        lineHeight: 1.7,
                                    }}
                                >
                                    Bot đang lọc link, ảnh và sản phẩm thật trước khi public.
                                    Voucher, chiến dịch và ưu đãi shop sẽ không hiển thị như sản phẩm.
                                </p>

                                <button
                                    type="button"
                                    onClick={clearFilters}
                                    style={{
                                        border: '1px solid #e2e8f0',
                                        background: '#ffffff',
                                        color: '#0f172a',
                                        borderRadius: 999,
                                        padding: '12px 18px',
                                        fontWeight: 900,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Xóa bộ lọc
                                </button>
                            </div>
                        )}

                        {!loading && visibleProducts.length > 0 && (
                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(238px, 1fr))',
                                    gap: 22,
                                }}
                            >
                                {visibleProducts.map((product) => {
                                    const discount = getDiscountPercent(product);
                                    const platformLabel =
                                        PLATFORMS[String(product.platform || 'other')] || String(product.platform || 'Khác');
                                    const buyUrl = getBuyUrl(product);
                                    const score = product.score ?? 0;

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
                                            </Link>

                                            <div style={{ padding: 16 }}>
                                                <Link
                                                    href={`/deals/${product.slug}`}
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
                                                        {product.title}
                                                    </h3>
                                                </Link>

                                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                                    <strong style={{ color: '#06b6d4', fontSize: 18 }}>
                                                        {formatPrice(product.salePrice || product.price)}
                                                    </strong>

                                                    {product.salePrice && product.price && product.salePrice !== product.price && (
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
                                                        display: 'flex',
                                                        gap: 8,
                                                        flexWrap: 'wrap',
                                                        marginTop: 10,
                                                    }}
                                                >
                          <span
                              style={{
                                  color: '#f59e0b',
                                  background: 'rgba(245,158,11,0.08)',
                                  border: '1px solid rgba(245,158,11,0.16)',
                                  borderRadius: 999,
                                  padding: '5px 9px',
                                  fontSize: 11,
                                  fontWeight: 900,
                              }}
                          >
                            Giá có thể thay đổi
                          </span>

                                                    {score > 0 && (
                                                        <span
                                                            style={{
                                                                color: '#2563eb',
                                                                background: '#eff6ff',
                                                                border: '1px solid #dbeafe',
                                                                borderRadius: 999,
                                                                padding: '5px 9px',
                                                                fontSize: 11,
                                                                fontWeight: 900,
                                                            }}
                                                        >
                              Điểm {score}
                            </span>
                                                    )}
                                                </div>

                                                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                                                    {buyUrl ? (
                                                        <a
                                                            href={buyUrl}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            style={{
                                                                flex: 1,
                                                                textAlign: 'center',
                                                                background: '#06b6d4',
                                                                color: '#ffffff',
                                                                borderRadius: 12,
                                                                padding: '11px 12px',
                                                                textDecoration: 'none',
                                                                fontWeight: 950,
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
                                                                fontWeight: 950,
                                                                fontSize: 13,
                                                            }}
                                                        >
                              Xem deal
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
                                                            fontWeight: 950,
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

                <section style={{ padding: '0 0 54px' }}>
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
                            Giá, tồn kho và ưu đãi có thể thay đổi theo thời gian. Một số liên kết
                            trên SanDeal có thể là liên kết tiếp thị liên kết. SanDeal có thể nhận
                            hoa hồng nếu bạn mua qua liên kết này, nhưng{' '}
                            <strong>giá của bạn không thay đổi</strong>.
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
                    © 2026 SanDeal. SanDeal là nền tảng so sánh giá độc lập và có thể nhận hoa hồng
                    Affiliate từ các liên kết. Chúng tôi không trực tiếp bán hàng; mọi giao dịch,
                    giá cả do nhà bán trên sàn TMĐT chịu trách nhiệm.
                </div>
            </footer>
        </div>
    );
}