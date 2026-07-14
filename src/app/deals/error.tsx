'use client';

import Link from 'next/link';

import { PublicFooter, PublicHeader, PublicIcon } from '@/components/public';
import styles from '@/components/public/public.module.css';

export default function DealsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className={styles.shell}>
      <PublicHeader />
      <main className={styles.section}>
        <div className={styles.container}>
          <div className={styles.errorState} role="alert">
            <span className={styles.emptyIcon}><PublicIcon name="warning" size={24} /></span>
            <h2>Không thể tải danh sách deal</h2>
            <p>Dữ liệu chưa bị thay đổi. Bạn có thể thử lại hoặc trở về trang chủ.</p>
            <div className={styles.emptyActions}>
              <button className={styles.primaryButton} type="button" onClick={reset}>Thử lại</button>
              <Link className={styles.secondaryButton} href="/">Về trang chủ</Link>
            </div>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
