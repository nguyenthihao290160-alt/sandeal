import Link from 'next/link';

import { PublicSearch } from './PublicSearch';
import { PublicIcon } from './PublicIcon';
import styles from './public.module.css';

export function PublicHeader({ search = '' }: { search?: string }) {
  return (
    <>
      <div className={styles.announcement}>
        <div className={`${styles.container} ${styles.announcementInner}`}>
          <span>Thông tin sản phẩm có nguồn và thời điểm kiểm tra rõ ràng</span>
          <span>Giá và tình trạng ưu đãi có thể thay đổi tại nhà bán</span>
        </div>
      </div>
      <header className={styles.header}>
        <div className={`${styles.container} ${styles.headerInner}`}>
          <Link className={styles.brand} href="/" aria-label="SanDeal — Trang chủ">
            <span className={styles.brandMark} aria-hidden="true">S</span>
            <span>SanDeal</span>
          </Link>
          <PublicSearch defaultValue={search} />
          <nav className={styles.nav} aria-label="Điều hướng công khai">
            <Link href="/deals?sort=deal_desc">Deal nổi bật</Link>
            <Link href="/deals">Danh mục</Link>
            <Link href="/#how-it-works">Cách hoạt động</Link>
            <Link href="/#affiliate-disclosure">Minh bạch affiliate</Link>
          </nav>
          <details className={styles.mobileNav}>
            <summary><PublicIcon name="menu" size={17} /> Menu</summary>
            <nav aria-label="Điều hướng công khai trên thiết bị di động">
              <Link href="/deals?sort=deal_desc">Deal nổi bật</Link>
              <Link href="/deals">Danh mục</Link>
              <Link href="/#how-it-works">Cách hoạt động</Link>
              <Link href="/#affiliate-disclosure">Minh bạch affiliate</Link>
            </nav>
          </details>
        </div>
      </header>
    </>
  );
}
