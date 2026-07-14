import Link from 'next/link';

import type { PublicCategoryItem } from './contracts';
import { PublicIcon, type PublicIconName } from './PublicIcon';
import styles from './public.module.css';

export function HeroSection({
  publicProductCount,
  verifiedSourceCount,
}: {
  publicProductCount: number;
  verifiedSourceCount: number;
}) {
  const metrics: Array<{ icon: PublicIconName; title: string; detail: string }> = [
    {
      icon: 'shield',
      title: publicProductCount > 0 ? `${publicProductCount.toLocaleString('vi-VN')} sản phẩm đủ điều kiện` : 'Đang cập nhật sản phẩm',
      detail: 'Chỉ hiển thị dữ liệu vượt qua cổng an toàn công khai.',
    },
    {
      icon: 'source',
      title: verifiedSourceCount > 0 ? `${verifiedSourceCount.toLocaleString('vi-VN')} nguồn đã xác minh` : 'Nguồn được ghi rõ',
      detail: 'Mỗi sản phẩm cho biết nguồn và trạng thái xác minh hiện có.',
    },
    {
      icon: 'price',
      title: 'Giá có thời điểm kiểm tra',
      detail: 'Mức giá được xem như dữ liệu tham khảo, không phải cam kết của nhà bán.',
    },
    {
      icon: 'compare',
      title: 'So sánh theo dữ liệu có sẵn',
      detail: 'Không tự điền thông số còn thiếu hoặc tạo nhận xét giả.',
    },
  ];

  return (
    <section className={styles.hero}>
      <div className={`${styles.container} ${styles.heroGrid}`}>
        <div>
          <span className={styles.eyebrow}><PublicIcon name="shield" size={15} /> Deal và bằng chứng trong cùng một nơi</span>
          <h1>Kiểm tra deal rõ ràng trước khi quyết định</h1>
          <p className={styles.heroLead}>
            SanDeal giúp bạn xem giá, nguồn, thời điểm cập nhật và lý do chấm điểm.
            Thông tin còn thiếu được ghi rõ thay vì được suy đoán.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryButton} href="/deals">
              Khám phá deal <PublicIcon name="arrowRight" size={16} />
            </Link>
            <Link className={styles.secondaryButton} href="/review-methodology">
              Cách SanDeal kiểm tra
            </Link>
          </div>
        </div>
        <div className={styles.heroPanel} aria-label="Điểm tin cậy của SanDeal">
          {metrics.map((metric) => (
            <article className={styles.heroMetric} key={metric.title}>
              <span className={styles.heroMetricIcon}><PublicIcon name={metric.icon} size={20} /></span>
              <strong>{metric.title}</strong>
              <span>{metric.detail}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function TrustHighlights() {
  const items: Array<{ icon: PublicIconName; title: string; text: string }> = [
    { icon: 'source', title: 'Nguồn được ghi rõ', text: 'Bạn có thể biết dữ liệu đến từ nguồn nào và đã được xác minh hay chưa.' },
    { icon: 'calendar', title: 'Có thời điểm cập nhật', text: 'Giá và nội dung hiển thị kèm mốc kiểm tra khi dữ liệu có sẵn.' },
    { icon: 'shield', title: 'Cổng an toàn công khai', text: 'Sản phẩm bị chặn, trùng hoặc chưa đủ chuẩn không được đưa vào danh sách công khai.' },
    { icon: 'link', title: 'Affiliate minh bạch', text: 'Nút sang nhà bán được ghi rõ; SanDeal có thể nhận hoa hồng và giá cuối cùng do nhà bán xác nhận.' },
  ];

  return (
    <section className={`${styles.section} ${styles.sectionSoft}`} id="how-it-works">
      <div className={styles.container}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Vì sao nên kiểm tra deal tại SanDeal?</h2>
            <p>Các tín hiệu được trình bày riêng để bạn tự cân nhắc, không thay thế thông tin chính thức của nhà bán.</p>
          </div>
        </div>
        <div className={styles.trustGrid}>
          {items.map((item) => (
            <article className={styles.trustCard} key={item.title}>
              <span className={styles.trustIcon}><PublicIcon name={item.icon} size={20} /></span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function CategoryNavigation({ categories }: { categories: PublicCategoryItem[] }) {
  if (categories.length === 0) return null;

  return (
    <section className={styles.section} aria-labelledby="featured-categories">
      <div className={styles.container}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 id="featured-categories">Danh mục đang có sản phẩm</h2>
            <p>Danh mục được lấy từ kho sản phẩm công khai hiện tại.</p>
          </div>
        </div>
        <nav className={styles.categoryList} aria-label="Danh mục sản phẩm">
          {categories.map((category) => (
            <Link
              className={styles.categoryLink}
              href={`/deals?category=${encodeURIComponent(category.name)}`}
              key={category.name}
            >
              <span className={styles.categoryIcon}><PublicIcon name="category" size={15} /></span>
              <span>{category.name}</span>
              <span className={styles.categoryCount}>{category.count}</span>
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}

export function DealTabs({ activeSort, activeDealBand }: { activeSort?: string; activeDealBand?: string }) {
  const tabs = [
    { label: 'Mới cập nhật', href: '/deals?sort=updated_desc', active: activeSort === 'updated_desc' && !activeDealBand },
    { label: 'Deal nổi bật', href: '/deals?dealBand=featured&sort=deal_desc', active: activeDealBand === 'featured' },
    { label: 'Chất lượng cao', href: '/deals?qualityBand=good&sort=quality_desc', active: activeSort === 'quality_desc' },
    { label: 'Mức giảm cao', href: '/deals?sort=discount_desc', active: activeSort === 'discount_desc' },
  ];

  return (
    <nav className={styles.tabs} aria-label="Cách xem deal">
      {tabs.map((tab) => (
        <Link className={tab.active ? styles.tabActive : styles.tabLink} href={tab.href} key={tab.label}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
