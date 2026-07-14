import type { Metadata } from 'next';
import Link from 'next/link';

import {
  AffiliateDisclosure,
  CategoryNavigation,
  DealCard,
  DealEmptyState,
  HeroSection,
  PublicFooter,
  PublicHeader,
  PublicIcon,
  TrustHighlights,
} from '@/components/public';
import styles from '@/components/public/public.module.css';
import { getPublicHomepageData } from '@/lib/product-intelligence/publicProducts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SanDeal — Kiểm tra deal, giá và nguồn sản phẩm',
  description: 'Khám phá sản phẩm có nguồn, thời điểm cập nhật, Deal Score và dữ kiện được SanDeal kiểm tra trước khi công khai.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'SanDeal — Kiểm tra deal trước khi quyết định',
    description: 'Xem giá, nguồn, thời điểm cập nhật và lý do chấm điểm bằng dữ liệu hiện có.',
    url: '/',
    type: 'website',
    locale: 'vi_VN',
    siteName: 'SanDeal',
  },
};

function DealSection({
  title,
  description,
  products,
  soft = false,
}: {
  title: string;
  description: string;
  products: Awaited<ReturnType<typeof getPublicHomepageData>>['featured'];
  soft?: boolean;
}) {
  if (products.length === 0) return null;
  return (
    <section className={`${styles.section} ${soft ? styles.sectionSoft : ''}`}>
      <div className={styles.container}>
        <div className={styles.sectionHeader}>
          <div><h2>{title}</h2><p>{description}</p></div>
          <Link className={styles.textButton} href="/deals">
            Xem tất cả <PublicIcon name="arrowRight" size={15} />
          </Link>
        </div>
        <div className={styles.dealGrid}>
          {products.map((product) => <DealCard product={product} key={product.id} />)}
        </div>
      </div>
    </section>
  );
}

export default async function HomePage() {
  const data = await getPublicHomepageData();

  return (
    <div className={styles.shell}>
      <PublicHeader />
      <main>
        <HeroSection publicProductCount={data.totalProducts} verifiedSourceCount={data.verifiedSourceCount} />
        <CategoryNavigation categories={data.categories} />
        <TrustHighlights />

        {data.featured.length > 0 ? (
          <DealSection
            title="Deal nổi bật theo dữ liệu hiện có"
            description="Sản phẩm vượt cổng chất lượng và có Deal Score thuộc mức nổi bật hoặc đáng cân nhắc."
            products={data.featured}
          />
        ) : (
          <section className={styles.section}>
            <div className={styles.container}><DealEmptyState /></div>
          </section>
        )}

        <DealSection
          title="Giá vừa giảm"
          description="Chỉ hiển thị sản phẩm có lịch sử giá nội bộ ghi nhận mức thay đổi giảm."
          products={data.priceDrops}
          soft
        />
        <DealSection
          title="Mới cập nhật"
          description="Sắp xếp theo lần quan sát hoặc cập nhật gần nhất trong dữ liệu công khai."
          products={data.recentlyUpdated}
        />

        <section className={styles.section}>
          <div className={styles.container}><AffiliateDisclosure /></div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
