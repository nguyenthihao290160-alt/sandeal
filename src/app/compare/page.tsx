import type { Metadata } from 'next';
import Link from 'next/link';

import {
  AffiliateDisclosure,
  ProductComparison,
  PublicFooter,
  PublicHeader,
  PublicIcon,
  PublicViewTracker,
} from '@/components/public';
import styles from '@/components/public/public.module.css';
import { getPublicComparison } from '@/lib/product-intelligence/publicProducts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'So sánh sản phẩm | SanDeal',
  description: 'So sánh tối đa bốn sản phẩm bằng các trường dữ liệu đã có trên SanDeal.',
  alternates: { canonical: '/compare' },
  robots: { index: false, follow: true },
};

type CompareSearchParams = Record<string, string | string[] | undefined>;

function selectedIds(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.length > 600) return [];
  return [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 120))].slice(0, 4);
}

export default async function ComparePage({ searchParams }: { searchParams: Promise<CompareSearchParams> }) {
  const query = await searchParams;
  const ids = selectedIds(query.ids);
  const products = await getPublicComparison(ids);
  const missingCount = Math.max(0, ids.length - products.length);

  return (
    <div className={styles.shell}>
      <PublicViewTracker eventType="COMPARE_OPEN" contentPageId="compare:page" resultCount={products.length} />
      <PublicHeader />
      <main className={styles.section}>
        <div className={styles.container}>
          <nav className={styles.breadcrumb} aria-label="Breadcrumb">
            <Link href="/">Trang chủ</Link><span aria-hidden="true">/</span>
            <Link href="/deals">Deal</Link><span aria-hidden="true">/</span>
            <span aria-current="page">So sánh</span>
          </nav>
          <div className={styles.sectionHeader}>
            <div>
              <h1>So sánh sản phẩm</h1>
              <p>Chỉ các trường có dữ liệu được đưa vào bảng; SanDeal không tự điền thông số còn thiếu.</p>
            </div>
            <Link className={styles.secondaryButton} href="/deals"><PublicIcon name="chevronLeft" size={16} /> Chọn lại sản phẩm</Link>
          </div>

          {missingCount > 0 ? (
            <div className={styles.warningBox} role="note">
              {missingCount} sản phẩm không còn đủ điều kiện công khai nên đã được bỏ khỏi bảng.
            </div>
          ) : null}

          {products.length >= 2 ? (
            <ProductComparison products={products} />
          ) : (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}><PublicIcon name="compare" size={24} /></span>
              <h2>Chọn ít nhất hai sản phẩm</h2>
              <p>Bạn có thể chọn tối đa bốn sản phẩm từ danh sách deal rồi mở lại trang so sánh.</p>
              <div className={styles.emptyActions}><Link className={styles.primaryButton} href="/deals">Mở danh sách deal</Link></div>
            </div>
          )}

          <div className={styles.section}><AffiliateDisclosure /></div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
