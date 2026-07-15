import type { Metadata } from 'next';
import Link from 'next/link';

import { AffiliateDisclosure, PublicFooter, PublicHeader } from '@/components/public';
import styles from '@/components/public/public.module.css';
import { config } from '@/lib/config';

export const metadata: Metadata = {
  title: 'SanDeal đánh giá sản phẩm như thế nào?',
  description: 'Phương pháp SanDeal kiểm tra dữ liệu, liên kết, hình ảnh và tạo nhận định biên tập minh bạch.',
  alternates: { canonical: '/review-methodology' },
  openGraph: {
    title: 'Phương pháp đánh giá của SanDeal',
    description: 'Cách SanDeal tách dữ kiện, nhận định, bằng chứng và kiểm soát Safe Publish.',
    url: '/review-methodology',
    type: 'article',
    locale: 'vi_VN',
    siteName: 'SanDeal',
  },
};

export default function ReviewMethodologyPage() {
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: config.siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Phương pháp đánh giá', item: new URL('/review-methodology', config.siteUrl).toString() },
    ],
  };
  return <div className={styles.shell}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb).replace(/</g, '\\u003c') }} />
    <PublicHeader />
    <main>
      <section className={styles.section}>
        <div className={`${styles.container} ${styles.methodologyContent}`}>
          <nav className={styles.breadcrumb} aria-label="Breadcrumb"><Link href="/">Trang chủ</Link><span aria-hidden="true">/</span><span aria-current="page">Phương pháp đánh giá</span></nav>
          <h1>SanDeal đánh giá sản phẩm như thế nào?</h1>
          <p>SanDeal tổng hợp dữ liệu sản phẩm từ nguồn đã khai báo, sau đó kiểm tra trường bắt buộc, giá, liên kết, hình ảnh và nội dung. Chỉ dữ kiện có thể truy về sản phẩm canonical mới được trình bày như sự thật.</p>
          <h2>Dữ kiện, nhận định và giới hạn</h2>
          <p>Dữ kiện đã xác minh được tách khỏi nhận định biên tập. Nhận định phải nêu căn cứ và mức tin cậy. Trải nghiệm thực tế, độ bền hoặc hiệu quả dài hạn được ghi là chưa xác minh nếu không có bằng chứng.</p>
          <h2>Tự động hóa có kiểm soát</h2>
          <p>Quy tắc deterministic và template local được ưu tiên khi đủ khả năng. Khi provider được cấu hình, kết quả hỗ trợ phải ghi rõ mode/provider và vẫn chỉ là draft hoặc suggestion; không trở thành canonical fact hay tự publish.</p>
          <h2>Safe Publish</h2>
          <p>Claim quan trọng thiếu evidence, nội dung chưa đạt Editorial Guard, nguy cơ trùng cao, link hoặc ảnh lỗi và sản phẩm chưa được phê duyệt đều bị chặn khỏi cổng công khai.</p>
          <h2>Giá, liên kết và affiliate</h2>
          <p>Giá là mức SanDeal ghi nhận tại một thời điểm và có thể thay đổi. SanDeal có thể nhận hoa hồng qua liên kết affiliate, không trực tiếp bán hàng và không quyết định giá cuối cùng.</p>
          <p><Link className={styles.textButton} href="/deals">Xem danh sách sản phẩm đã vượt kiểm tra</Link></p>
        </div>
      </section>
      <section className={`${styles.section} ${styles.sectionSoft}`}><div className={styles.container}><AffiliateDisclosure /></div></section>
    </main>
    <PublicFooter />
  </div>;
}
