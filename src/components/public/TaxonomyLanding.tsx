import Link from 'next/link';

import type { PublicTaxonomyLanding as PublicTaxonomyLandingData } from '@/lib/product-intelligence/publicProducts';
import {
  buildFaqJsonLd,
  buildTaxonomyBreadcrumbJsonLd,
  buildTaxonomyItemListJsonLd,
  taxonomyFaq,
  taxonomyPath,
} from '@/lib/seo/taxonomySeo';

import { AffiliateDisclosure } from './ProductSections';
import { DealCard } from './DealCard';
import { DealPagination } from './DealPagination';
import { ProductComparisonTray } from './ProductComparisonTray';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { PublicIcon } from './PublicIcon';
import { PublicViewTracker } from './PublicViewTracker';
import styles from './public.module.css';

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Chưa có dữ liệu'
    : new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

export function TaxonomyLanding({
  data,
  selectedComparisonIds,
}: {
  data: PublicTaxonomyLandingData;
  selectedComparisonIds: string[];
}) {
  const { kind, taxonomy, items, pagination } = data;
  const kindLabel = kind === 'category' ? 'Danh mục' : 'Thương hiệu';
  const oppositeKind = kind === 'category' ? 'brand' : 'category';
  const oppositeLabel = kind === 'category' ? 'Thương hiệu trong danh mục' : 'Danh mục của thương hiệu';
  const faq = taxonomyFaq(kind, taxonomy.name);
  const breadcrumbJsonLd = buildTaxonomyBreadcrumbJsonLd({ kind, name: taxonomy.name, slug: taxonomy.slug });
  const itemListJsonLd = buildTaxonomyItemListJsonLd({ kind, name: taxonomy.name, slug: taxonomy.slug, page: pagination.page }, items);
  const faqJsonLd = buildFaqJsonLd(faq);
  const basePath = taxonomyPath(kind, taxonomy.slug);

  return (
    <div className={styles.shell}>
      <PublicViewTracker
        eventType="CATEGORY_VIEW"
        contentPageId={`${kind}:${taxonomy.slug}`}
        contextKey={taxonomy.slug}
      />
      {[breadcrumbJsonLd, itemListJsonLd, faqJsonLd].map((value, index) => (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(value).replace(/</g, '\\u003c') }}
          key={index}
        />
      ))}
      <PublicHeader />
      <main>
        <section className={styles.taxonomyIntro}>
          <div className={styles.container}>
            <nav className={styles.breadcrumb} aria-label="Breadcrumb">
              <Link href="/">Trang chủ</Link><span aria-hidden="true">/</span>
              <Link href="/deals">Deal</Link><span aria-hidden="true">/</span>
              <span aria-current="page">{taxonomy.name}</span>
            </nav>
            <p className={styles.eyebrow}><PublicIcon name={kind === 'category' ? 'category' : 'source'} size={15} /> {kindLabel}</p>
            <h1>Deal {taxonomy.name} đã kiểm tra</h1>
            <p>
              Danh sách chỉ gồm sản phẩm đã vượt cổng công khai, kèm giá tham khảo, nguồn,
              thời điểm cập nhật và dữ kiện hiện có. Trường còn thiếu không được tự điền.
            </p>
            <dl className={styles.taxonomyMeta}>
              <div><dt>Sản phẩm công khai</dt><dd>{pagination.totalItems.toLocaleString('vi-VN')}</dd></div>
              <div><dt>Trang hiện tại</dt><dd>{pagination.page}/{pagination.totalPages}</dd></div>
              <div><dt>Cập nhật dữ liệu</dt><dd>{formatDate(taxonomy.lastModified)}</dd></div>
            </dl>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="taxonomy-products">
          <div className={styles.container}>
            <div className={styles.sectionHeader}>
              <div><h2 id="taxonomy-products">Sản phẩm đang có dữ liệu công khai</h2><p>Sắp xếp theo lần quan sát hoặc cập nhật gần nhất.</p></div>
            </div>
            <div className={styles.dealGrid}>
              {items.map(item => (
                <DealCard product={item} selectedComparisonIds={selectedComparisonIds} comparisonEnabled key={item.id} />
              ))}
            </div>
            <DealPagination
              page={pagination.page}
              totalPages={pagination.totalPages}
              query={selectedComparisonIds.length ? { compare: selectedComparisonIds.join(',') } : {}}
              basePath={basePath}
            />
            <ProductComparisonTray selectedIds={selectedComparisonIds} />
          </div>
        </section>

        {data.crossLinks.length > 0 || data.related.length > 0 ? (
          <section className={`${styles.section} ${styles.sectionSoft}`}>
            <div className={styles.container}>
              {data.crossLinks.length > 0 ? (
                <div className={styles.taxonomyLinkGroup}>
                  <h2>{oppositeLabel}</h2>
                  <nav className={styles.taxonomyLinks} aria-label={oppositeLabel}>
                    {data.crossLinks.map(item => (
                      <Link href={taxonomyPath(oppositeKind, item.slug)} key={item.slug}>{item.name}<span>{item.count}</span></Link>
                    ))}
                  </nav>
                </div>
              ) : null}
              {data.related.length > 0 ? (
                <div className={styles.taxonomyLinkGroup}>
                  <h2>{kind === 'category' ? 'Danh mục liên quan' : 'Thương hiệu khác'}</h2>
                  <nav className={styles.taxonomyLinks} aria-label={`${kindLabel} liên quan`}>
                    {data.related.map(item => (
                      <Link href={taxonomyPath(kind, item.slug)} key={item.slug}>{item.name}<span>{item.count}</span></Link>
                    ))}
                  </nav>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby="taxonomy-methodology">
          <div className={styles.container}>
            <div className={styles.methodologyBand}>
              <div>
                <h2 id="taxonomy-methodology">Cách dữ liệu được kiểm tra</h2>
                <p>Điểm số là tín hiệu hỗ trợ quyết định; giá và điều kiện cuối cùng luôn do nhà bán xác nhận.</p>
              </div>
              <Link className={styles.secondaryButton} href="/review-methodology">Xem phương pháp</Link>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionSoft}`} aria-labelledby="taxonomy-faq">
          <div className={styles.container}>
            <div className={styles.sectionHeader}><div><h2 id="taxonomy-faq">Câu hỏi thường gặp</h2></div></div>
            <div className={styles.faqList}>
              {faq.map(item => (
                <details key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.section}><div className={styles.container}><AffiliateDisclosure /></div></section>
      </main>
      <PublicFooter />
    </div>
  );
}
