import type { Metadata } from 'next';
import { cache } from 'react';

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

type RawSearchParams = Record<string, string | string[] | undefined>;

const getPublicSearch = cache((serialized: string) => queryPublicProducts(new URLSearchParams(serialized)));

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
    brand: query.brand,
    priceTrend: query.priceTrend,
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
    query.q || query.platform || query.category || query.brand || query.priceTrend || query.priceMin !== undefined || query.priceMax !== undefined
    || query.qualityBand || query.opportunityBand || query.dealBand || query.hasImage !== undefined
    || query.verifiedSource !== undefined || query.updatedWithin || query.sort !== 'updated_desc' || query.pageSize !== 12,
  );
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<RawSearchParams> }): Promise<Metadata> {
  const raw = await searchParams;
  const params = new URLSearchParams();
  appendSearchParams(params, raw);
  const curated = Object.keys(raw).every(key => key === 'page');
  const description = 'Lọc và so sánh sản phẩm công khai theo giá, nền tảng, chất lượng dữ liệu, Deal Score và thời điểm cập nhật.';
  try {
    const result = await getPublicSearch(params.toString());
    const pageSuffix = result.pagination.page > 1 ? ` - Trang ${result.pagination.page}` : '';
    const title = `Danh sách deal đã kiểm tra${pageSuffix} | SanDeal`;
    const canonical = result.pagination.page > 1 ? `/deals?page=${result.pagination.page}` : '/deals';
    const indexable = curated && !result.pagination.outOfRange;
    return {
      title,
      description,
      alternates: { canonical },
      robots: { index: indexable, follow: true, googleBot: { index: indexable, follow: true } },
      openGraph: { title, description, url: canonical, type: 'website', locale: 'vi_VN', siteName: 'SanDeal' },
      twitter: { card: 'summary', title, description },
    };
  } catch {
    return {
      title: 'Danh sách deal đã kiểm tra | SanDeal',
      description,
      alternates: { canonical: '/deals' },
      robots: { index: false, follow: true },
    };
  }
}

export default async function DealsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const rawSearch = await searchParams;
  const selectedIds = comparisonIds(rawSearch.compare);
  const publicSearch = new URLSearchParams();
  appendSearchParams(publicSearch, rawSearch);

  let invalidFilter: string | null = null;
  let result: Awaited<ReturnType<typeof queryPublicProducts>>;
  try {
    result = await getPublicSearch(publicSearch.toString());
  } catch (error) {
    if (!(error instanceof PublicProductQueryError)) throw error;
    invalidFilter = error.field;
    result = await getPublicSearch('');
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

            {result.pagination.outOfRange ? (
              <div className={styles.warningBox} role="status">
                Trang {result.pagination.requestedPage} vượt phạm vi hiện có; đang hiển thị trang {result.pagination.page}.
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
