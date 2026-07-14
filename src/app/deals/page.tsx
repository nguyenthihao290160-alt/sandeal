import type { Metadata } from 'next';

import {
  AffiliateDisclosure,
  DealCard,
  DealEmptyState,
  DealFilterBar,
  DealPagination,
  DealTabs,
  ProductComparisonTray,
  PublicFooter,
  PublicHeader,
  type PublicFilterValues,
} from '@/components/public';
import styles from '@/components/public/public.module.css';
import {
  PublicProductQueryError,
  queryPublicProducts,
  type PublicProductQuery,
} from '@/lib/product-intelligence/publicProducts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Danh sách deal đã kiểm tra | SanDeal',
  description: 'Lọc và so sánh sản phẩm công khai theo giá, nền tảng, chất lượng dữ liệu, Deal Score và thời điểm cập nhật.',
  alternates: { canonical: '/deals' },
  openGraph: {
    title: 'Danh sách deal đã kiểm tra | SanDeal',
    description: 'Tìm sản phẩm theo dữ liệu giá, nguồn và điểm chất lượng hiện có.',
    url: '/deals',
    type: 'website',
    locale: 'vi_VN',
    siteName: 'SanDeal',
  },
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function appendSearchParams(target: URLSearchParams, source: RawSearchParams) {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'compare' || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => target.append(key, item));
    else target.set(key, value);
  }
}

function comparisonIds(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return [];
  return [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 120))].slice(0, 4);
}

function filterValues(query: PublicProductQuery, selectedIds: string[]): PublicFilterValues {
  return {
    q: query.q,
    platform: query.platform,
    category: query.category,
    priceMin: query.priceMin === undefined ? undefined : String(query.priceMin),
    priceMax: query.priceMax === undefined ? undefined : String(query.priceMax),
    qualityBand: query.qualityBand,
    opportunityBand: query.opportunityBand,
    dealBand: query.dealBand,
    hasImage: query.hasImage === undefined ? undefined : String(query.hasImage),
    verifiedSource: query.verifiedSource === undefined ? undefined : String(query.verifiedSource),
    updatedWithin: query.updatedWithin === undefined ? undefined : String(query.updatedWithin),
    sort: query.sort,
    pageSize: String(query.pageSize),
    compare: selectedIds.length > 0 ? selectedIds.join(',') : undefined,
  };
}

function paginationQuery(query: PublicProductQuery, selectedIds: string[]): Record<string, string> {
  const values = filterValues(query, selectedIds);
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function hasFilters(query: PublicProductQuery) {
  return Boolean(
    query.q || query.platform || query.category || query.priceMin !== undefined || query.priceMax !== undefined
    || query.qualityBand || query.opportunityBand || query.dealBand || query.hasImage !== undefined
    || query.verifiedSource !== undefined || query.updatedWithin || query.sort !== 'updated_desc' || query.pageSize !== 12,
  );
}

export default async function DealsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const rawSearch = await searchParams;
  const selectedIds = comparisonIds(rawSearch.compare);
  const publicSearch = new URLSearchParams();
  appendSearchParams(publicSearch, rawSearch);

  let invalidFilter: string | null = null;
  let result: Awaited<ReturnType<typeof queryPublicProducts>>;
  try {
    result = await queryPublicProducts(publicSearch);
  } catch (error) {
    if (!(error instanceof PublicProductQueryError)) throw error;
    invalidFilter = error.field;
    result = await queryPublicProducts(new URLSearchParams());
  }

  const values = filterValues(result.filters, selectedIds);
  const activeFilters = hasFilters(result.filters);
  const pageQuery = paginationQuery(result.filters, selectedIds);

  return (
    <div className={styles.shell}>
      <PublicHeader search={result.filters.q} />
      <main>
        <section className={styles.section}>
          <div className={styles.container}>
            <div className={styles.sectionHeader}>
              <div>
                <h1>Khám phá deal đã kiểm tra</h1>
                <p>Lọc trên dữ liệu công khai; mỗi trang chỉ nhận tối đa 50 sản phẩm từ server.</p>
              </div>
            </div>

            <DealTabs activeSort={result.filters.sort} activeDealBand={result.filters.dealBand} />
            <DealFilterBar values={values} hasActiveFilters={activeFilters} />

            {invalidFilter ? (
              <div className={styles.warningBox} role="alert">
                <strong>Bộ lọc không hợp lệ:</strong> trường “{invalidFilter}” đã được bỏ qua. Danh sách mặc định đang được hiển thị.
              </div>
            ) : null}

            <div className={styles.resultBar} aria-live="polite">
              <p><strong>{result.pagination.totalItems.toLocaleString('vi-VN')}</strong> sản phẩm phù hợp</p>
              <p>Trang {result.pagination.page}/{result.pagination.totalPages}</p>
            </div>

            {result.items.length > 0 ? (
              <div className={styles.dealGrid}>
                {result.items.map((product) => (
                  <DealCard product={product} selectedComparisonIds={selectedIds} comparisonEnabled key={product.id} />
                ))}
              </div>
            ) : <DealEmptyState filtered={activeFilters} />}

            <DealPagination
              page={result.pagination.page}
              totalPages={result.pagination.totalPages}
              query={pageQuery}
            />
            <ProductComparisonTray selectedIds={selectedIds} />
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionSoft}`}>
          <div className={styles.container}><AffiliateDisclosure /></div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
