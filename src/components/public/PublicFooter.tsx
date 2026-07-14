import Link from 'next/link';

import styles from './public.module.css';

export function PublicFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.footerGrid}>
          <div className={styles.footerIntro}>
            <h2>SanDeal</h2>
            <p>
              SanDeal tổng hợp dữ liệu sản phẩm và ưu đãi để bạn kiểm tra nguồn,
              mức giá và các giới hạn trước khi truy cập trang bán.
            </p>
          </div>
          <div>
            <h3>Khám phá</h3>
            <ul className={styles.footerLinks}>
              <li><Link href="/deals">Danh sách deal</Link></li>
              <li><Link href="/compare">So sánh sản phẩm</Link></li>
            </ul>
          </div>
          <div>
            <h3>Phương pháp</h3>
            <ul className={styles.footerLinks}>
              <li><Link href="/review-methodology">Cách SanDeal kiểm tra</Link></li>
              <li><Link href="/#affiliate-disclosure">Minh bạch affiliate</Link></li>
            </ul>
          </div>
          <div>
            <h3>Lưu ý</h3>
            <ul className={styles.footerLinks}>
              <li><Link href="/review-methodology">Nguồn và bằng chứng</Link></li>
              <li><Link href="/deals?sort=updated_desc">Mới cập nhật</Link></li>
            </ul>
          </div>
        </div>
        <div className={styles.footerBottom}>
          Giá, tình trạng hàng và điều kiện ưu đãi được quyết định bởi nhà bán tại thời điểm truy cập.
        </div>
      </div>
    </footer>
  );
}
