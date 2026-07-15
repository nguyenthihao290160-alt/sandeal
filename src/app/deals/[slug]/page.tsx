import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import {
  AffiliateDisclosure,
  ComparisonToggle,
  DealScoreBadge,
  PriceDisplay,
  PriceHistory,
  ProductEvidence,
  ProductGallery,
  ProductComparisonTray,
  PublicFooter,
  PublicHeader,
  PublicIcon,
  PublicVisibilityTracker,
  PublicViewTracker,
  RelatedDeals,
  SourceSummary,
  VerifiedSourceBadge,
} from '@/components/public';
import styles from '@/components/public/public.module.css';
import { getPublicProductBySlugSafe } from '@/lib/product-intelligence/publicProducts';
import {
  buildBreadcrumbJsonLd,
  buildProductJsonLd,
  buildProductMetadata,
  getProductIndexingDecision,
} from '@/lib/seo/productSeo';
import { publicTaxonomySlug, taxonomyPath } from '@/lib/seo/taxonomySeo';

export const dynamic = 'force-dynamic';

const getSafeDetail = cache((slug: string) => getPublicProductBySlugSafe(slug));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const result = await getSafeDetail(slug);
  return buildProductMetadata(result?.product || null);
}

function claimTexts(items?: Array<{ text: string }>) {
  return (items || []).map((item) => item.text).filter(Boolean);
}

function comparisonIds(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return [];
  return [...new Set(raw.split(',').map(id => id.trim()).filter(id => id.length > 0 && id.length <= 120))].slice(0, 4);
}

export default async function DealDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const selectedComparisonIds = comparisonIds((await searchParams).compare);
  const result = await getSafeDetail(slug);
  if (!result) notFound();

  const { product, detail } = result;
  const indexing = getProductIndexingDecision(product);
  const productJsonLd = buildProductJsonLd(product);
  const breadcrumbJsonLd = buildBreadcrumbJsonLd(product);
  const review = detail.reviewContent;
  const strengths = claimTexts(review?.strengths);
  const limitations = claimTexts(review?.limitations);
  const facts = [
    ...(review?.keyFacts || [])
      .filter((fact) => !['product_url', 'affiliate_url', 'image'].includes(fact.id))
      .map((fact) => ({ id: fact.id, label: fact.label, value: fact.value })),
    ...Object.entries(detail.specifications || {}).map(([key, value]) => ({ id: `spec-${key}`, label: key, value })),
  ];
  const evidence = {
    facts,
    sources: (review?.evidenceSources || []).map((source) => ({
      name: source.name,
      fields: source.fields,
      checkedAt: source.checkedAt,
    })),
    warnings: detail.warnings,
  };
  const contentPageId = `deal:${detail.slug}`;
  const outboundHref = `${detail.outboundHref}?content=${encodeURIComponent(contentPageId)}`;

  return (
    <div className={styles.shell}>
      <PublicViewTracker productId={detail.id} contentPageId={contentPageId} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c') }}
      />
      {productJsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd).replace(/</g, '\\u003c') }}
        />
      ) : null}

      <PublicHeader />
      <main>
        <section className={styles.section}>
          <div className={styles.container}>
            <nav className={styles.breadcrumb} aria-label="Breadcrumb">
              <Link href="/">Trang chủ</Link><span aria-hidden="true">/</span>
              <Link href="/deals">Deal</Link><span aria-hidden="true">/</span>
              {detail.category ? <><Link href={taxonomyPath('category', publicTaxonomySlug(detail.category))}>{detail.category}</Link><span aria-hidden="true">/</span></> : null}
              <span aria-current="page">{detail.title}</span>
            </nav>

            {!indexing.indexable ? (
              <div className={styles.warningBox} role="note">
                Trang này chưa đủ điều kiện lập chỉ mục: {indexing.reasons.join(', ')}.
              </div>
            ) : null}

            <div className={styles.detailGrid}>
              <ProductGallery images={detail.gallery || []} title={detail.title} />

              <div className={styles.decisionPanel}>
                <SourceSummary source={detail.sourceLabel} checkedAt={detail.priceUpdatedAt || detail.updatedAt} />
                {detail.brand ? <p className={styles.cardKicker}><Link href={taxonomyPath('brand', publicTaxonomySlug(detail.brand))}>{detail.brand}</Link></p> : null}
                <h1 className={styles.detailTitle}>{detail.title}</h1>
                {detail.description ? <p className={styles.detailSummary}>{detail.description}</p> : null}
                <PriceDisplay
                  currentPrice={detail.currentPrice}
                  originalPrice={detail.originalPrice}
                  currency={detail.currency}
                  large
                />
                <div className={styles.badgeRow}>
                  <DealScoreBadge score={detail.dealScore} band={detail.dealBand} />
                  {typeof detail.qualityScore === 'number' ? (
                    <span className={styles.qualityBadge}>Quality Score {Math.round(detail.qualityScore)}</span>
                  ) : null}
                  {typeof detail.opportunityScore === 'number' ? (
                    <span className={styles.opportunityBadge}>Opportunity Score {Math.round(detail.opportunityScore)}</span>
                  ) : null}
                  <VerifiedSourceBadge verified={detail.verifiedSource} />
                </div>

                {detail.priceMovement ? (
                  <p className={detail.priceMovement.direction === 'down' ? styles.priceMovementDown : styles.priceMovementUp}>
                    Giá {detail.priceMovement.direction === 'down' ? 'giảm' : 'tăng'} {Math.round(detail.priceMovement.percent * 10) / 10}% giữa hai lần SanDeal ghi nhận gần nhất.
                  </p>
                ) : <p className={styles.timeNote}>Chưa đủ snapshot để xác định biến động giá gần nhất.</p>}

                {detail.warnings.map(warning => (
                  <p className={styles.cardWarning} key={warning}><PublicIcon name="warning" size={13} /> {warning}</p>
                ))}

                {detail.dealReasons.length > 0 ? (
                  <article className={styles.contentCard}>
                    <h2>Lý do chấm Deal Score</h2>
                    <ul className={styles.evidenceList}>{detail.dealReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  </article>
                ) : null}

                <div className={styles.detailCta}>
                  {indexing.indexable ? (
                    <a
                      className={styles.primaryButton}
                      href={outboundHref}
                      target="_blank"
                      rel="sponsored noopener noreferrer"
                    >
                      Xem tại nhà bán <PublicIcon name="external" size={16} />
                    </a>
                  ) : <span className={styles.warningBox}>Liên kết mua đang chờ xác minh lại.</span>}
                  <ComparisonToggle productId={detail.id} selectedIds={selectedComparisonIds} />
                  <small>SanDeal có thể nhận hoa hồng. Giá và điều kiện cuối cùng được xác nhận tại nhà bán.</small>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.sectionSoft}`} aria-labelledby="editorial-review-title">
          <div className={styles.container}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 id="editorial-review-title">Đánh giá dựa trên bằng chứng</h2>
                <p>Nội dung phản ánh dữ liệu nguồn hiện có, không phải trải nghiệm sử dụng trực tiếp nếu không được ghi rõ.</p>
              </div>
            </div>

            {review ? (
              <div className={styles.contentGrid}>
                {review.reviewSummary ? (
                  <article className={styles.contentCard}>
                    <h3>{review.reviewTitle || 'Tóm tắt đánh giá'}</h3>
                    <p>{review.reviewSummary}</p>
                  </article>
                ) : null}
                {review.reviewVerdict ? (
                  <article className={styles.contentCard}>
                    <h3>Kết luận biên tập</h3>
                    <p>{review.reviewVerdict}</p>
                  </article>
                ) : null}
                {strengths.length > 0 ? (
                  <article className={styles.contentCard}><h3>Điểm mạnh có bằng chứng</h3><ul className={styles.evidenceList}>{strengths.map((item) => <li key={item}>{item}</li>)}</ul></article>
                ) : null}
                {limitations.length > 0 ? (
                  <article className={styles.contentCard}><h3>Hạn chế cần cân nhắc</h3><ul className={styles.evidenceList}>{limitations.map((item) => <li key={item}>{item}</li>)}</ul></article>
                ) : null}
                {review.suitableFor.length > 0 ? (
                  <article className={styles.contentCard}><h3>Phù hợp với ai</h3><ul className={styles.evidenceList}>{review.suitableFor.map((item) => <li key={item}>{item}</li>)}</ul></article>
                ) : null}
                {review.notSuitableFor.length > 0 ? (
                  <article className={styles.contentCard}><h3>Chưa phù hợp với ai</h3><ul className={styles.evidenceList}>{review.notSuitableFor.map((item) => <li key={item}>{item}</li>)}</ul></article>
                ) : null}
                {review.buyingConsiderations.length > 0 ? (
                  <article className={styles.contentCard}><h3>Lưu ý mua hàng</h3><ul className={styles.evidenceList}>{review.buyingConsiderations.map((item) => <li key={item}>{item}</li>)}</ul></article>
                ) : null}
                {review.reviewDisclosure ? (
                  <article className={styles.contentCard}><h3>Minh bạch phương pháp</h3><p>{review.reviewDisclosure}</p></article>
                ) : null}
              </div>
            ) : (
              <div className={styles.emptyState}>
                <span className={styles.emptyIcon}><PublicIcon name="warning" size={24} /></span>
                <h2>Nội dung đang được xác minh</h2>
                <p>SanDeal chưa có đủ dữ kiện để hiển thị bài đánh giá đầy đủ.</p>
              </div>
            )}
          </div>
        </section>

        <ProductEvidence evidence={evidence} />

        <section className={`${styles.section} ${styles.sectionSoft}`}>
          <div className={styles.container}>
            <PublicVisibilityTracker
              event={{ eventType: 'PRICE_HISTORY_OPEN', productId: detail.id, contentPageId }}
              dedupeKey={`price-history:${detail.id}`}
            >
              <PriceHistory points={detail.priceHistory} />
            </PublicVisibilityTracker>
          </div>
        </section>

        <RelatedDeals products={detail.related} selectedComparisonIds={selectedComparisonIds} />

        <section className={styles.section}>
          <div className={styles.container}><AffiliateDisclosure /></div>
        </section>
        <ProductComparisonTray selectedIds={selectedComparisonIds} />
      </main>
      <PublicFooter />
    </div>
  );
}
