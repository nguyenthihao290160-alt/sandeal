import { DealCardSkeleton, PublicFooter, PublicHeader } from '@/components/public';
import styles from '@/components/public/public.module.css';

export default function DealsLoading() {
  return (
    <div className={styles.shell}>
      <PublicHeader />
      <main className={styles.section}>
        <div className={styles.container}>
          <div className={styles.sectionHeader}>
            <div><h1>Khám phá deal</h1><p>Đang tải dữ liệu sản phẩm đã vượt cổng an toàn.</p></div>
          </div>
          <div className={styles.dealGrid} aria-busy="true" aria-label="Đang tải danh sách deal">
            {Array.from({ length: 8 }, (_, index) => <DealCardSkeleton key={index} />)}
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
