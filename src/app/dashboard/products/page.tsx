import { Suspense } from 'react';
import ProductsDashboard from './products-dashboard';
import styles from './products.module.css';

export default function ProductsPage() {
  return (
    <Suspense fallback={<div className={styles.pageSkeleton} aria-label="Đang tải kết quả bot"><span /><span /><span /></div>}>
      <ProductsDashboard />
    </Suspense>
  );
}
