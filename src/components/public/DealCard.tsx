import Link from 'next/link';

import ProductImage from '@/app/deals/ProductImage';
import { publicTaxonomySlug } from '@/lib/seo/taxonomySeo';

import type { PublicDealCardData } from './contracts';
import { ComparisonToggle } from './ProductComparisonTray';
import { PublicProductCardTracker } from './PublicAnalytics';
import { PublicIcon } from './PublicIcon';
import styles from './public.module.css';

const PLATFORM_LABELS: Record<string, string> = {
  shopee: 'Shopee',
  tiktok_shop: 'TikTok Shop',
  lazada: 'Lazada',
  accesstrade: 'AccessTrade',
  website: 'Website',
  other: 'Nguồn khác',
};

const DEAL_BANDS: Record<string, string> = {
  featured: 'Nổi bật',
  consider: 'Đáng cân nhắc',
  normal: 'Bình thường',
  verify: 'Cần xác minh',
  ineligible: 'Không đủ điều kiện',
};

function formatPrice(value?: number | null, currency = 'VND') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(value);
}

function formatCheckedAt(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

export function PriceDisplay({
  currentPrice,
  originalPrice,
  currency = 'VND',
  large = false,
}: {
  currentPrice?: number | null;
  originalPrice?: number | null;
  currency?: string | null;
  large?: boolean;
}) {
  const current = formatPrice(currentPrice, currency || 'VND');
  const original = typeof originalPrice === 'number' && typeof currentPrice === 'number' && originalPrice > currentPrice
    ? formatPrice(originalPrice, currency || 'VND')
    : null;

  return (
    <div className={`${styles.priceRow} ${large ? styles.detailPrice : ''}`}>
      {current ? <strong className={styles.priceCurrent}>{current}</strong> : <span className={styles.priceMissing}>Giá đang được cập nhật</span>}
      {original ? <span className={styles.priceOriginal}>{original}</span> : null}
    </div>
  );
}

export function DealScoreBadge({ score, band }: { score?: number | null; band?: string | null }) {
  if (typeof score !== 'number' || !Number.isFinite(score) || band === 'ineligible') return null;
  const label = band ? DEAL_BANDS[band] : undefined;
  return (
    <span className={styles.scoreBadge} title={label ? `Mức đánh giá: ${label}` : undefined}>
      <PublicIcon name="chart" size={13} /> Deal Score {Math.round(score)}
    </span>
  );
}

export function VerifiedSourceBadge({ verified }: { verified?: boolean }) {
  return verified ? (
    <span className={styles.verifiedBadge}><PublicIcon name="check" size={13} /> Nguồn đã xác minh</span>
  ) : (
    <span className={styles.unverifiedBadge}><PublicIcon name="warning" size={13} /> Cần xác minh nguồn</span>
  );
}

export function DealCard({
  product,
  selectedComparisonIds = [],
  comparisonEnabled = false,
}: {
  product: PublicDealCardData;
  selectedComparisonIds?: string[];
  comparisonEnabled?: boolean;
}) {
  const platformLabel = PLATFORM_LABELS[product.platform] || product.platform || 'Nguồn khác';
  const checkedAt = formatCheckedAt(product.priceUpdatedAt);
  const verifiedAt = formatCheckedAt(product.verifiedAt);
  const discount = typeof product.discountPercent === 'number' && product.discountPercent > 0
    ? Math.min(99, Math.round(product.discountPercent))
    : null;
  const outboundHref = product.outboundHref?.startsWith('/go/')
    ? product.outboundHref
    : `/go/${encodeURIComponent(product.id)}`;
  const detailHref = selectedComparisonIds.length > 0
    ? `/deals/${encodeURIComponent(product.slug)}?compare=${encodeURIComponent(selectedComparisonIds.join(','))}`
    : `/deals/${encodeURIComponent(product.slug)}`;

  return (
    <PublicProductCardTracker className={styles.dealCard} productId={product.id}>
      <Link className={styles.dealImageLink} href={detailHref} data-product-detail-link="true">
        <div className={styles.imageFrame}>
          <ProductImage
            src={product.imageUrl}
            alt={product.title}
            fallbackLabel={product.brand || product.category}
            sizes="(max-width: 540px) calc(100vw - 28px), (max-width: 800px) 46vw, (max-width: 1060px) 30vw, 290px"
          />
          <div className={styles.imageBadges}>
            <span className={styles.platformBadge}>{platformLabel}</span>
            {discount ? <span className={styles.discountBadge}>Giảm {discount}%</span> : null}
          </div>
        </div>
      </Link>
      <div className={styles.dealBody}>
        <p className={styles.cardKicker}>
          {product.brand ? (
            <Link href={`/deals/brand/${encodeURIComponent(publicTaxonomySlug(product.brand))}`}>{product.brand}</Link>
          ) : null}
          {product.brand ? ' · ' : ''}{platformLabel}
        </p>
        <Link className={styles.dealTitleLink} href={detailHref} data-product-detail-link="true">
          <h3 className={styles.dealTitle}>{product.title}</h3>
        </Link>
        <PriceDisplay
          currentPrice={product.currentPrice}
          originalPrice={product.originalPrice}
          currency={product.currency}
        />
        <div className={styles.badgeRow}>
          <DealScoreBadge score={product.dealScore} band={product.dealBand} />
          {typeof product.qualityScore === 'number' ? (
            <span className={styles.qualityBadge}>Chất lượng {Math.round(product.qualityScore)}</span>
          ) : null}
          {typeof product.opportunityScore === 'number' ? (
            <span className={styles.opportunityBadge}>Cơ hội {Math.round(product.opportunityScore)}</span>
          ) : null}
        </div>
        {product.priceMovement ? (
          <p className={product.priceMovement.direction === 'down' ? styles.priceMovementDown : styles.priceMovementUp}>
            {product.priceMovement.direction === 'down' ? 'Giảm' : 'Tăng'} {Math.round(product.priceMovement.percent * 10) / 10}% trong lịch sử SanDeal
          </p>
        ) : null}
        <div className={styles.metaRow}>
          <VerifiedSourceBadge verified={product.verifiedSource} />
          <span className={styles.affiliateBadge}>Có thể có affiliate</span>
        </div>
        <p className={styles.timeNote}>
          {checkedAt ? `Giá được kiểm tra ngày ${checkedAt}` : 'Chưa có thời điểm cập nhật giá'}
          {verifiedAt ? ` · Xác minh ${verifiedAt}` : ''}
        </p>
        {product.warnings?.map(warning => <p className={styles.cardWarning} key={warning}><PublicIcon name="warning" size={13} /> {warning}</p>)}
        <p className={styles.cardDisclosure}>Giá và ưu đãi có thể thay đổi tại nhà bán.</p>
        <div className={styles.cardActions}>
          <Link className={styles.secondaryButton} href={detailHref} data-product-detail-link="true">Xem phân tích</Link>
          <a
            className={styles.primaryButton}
            href={outboundHref}
            target="_blank"
            rel="sponsored noopener noreferrer"
          >
            Xem tại nhà bán <PublicIcon name="external" size={14} />
          </a>
          {comparisonEnabled ? <ComparisonToggle productId={product.id} selectedIds={selectedComparisonIds} /> : null}
        </div>
      </div>
    </PublicProductCardTracker>
  );
}

export function DealCardSkeleton() {
  return (
    <div className={styles.skeletonCard} aria-hidden="true">
      <div className={styles.skeletonImage} />
      <div className={styles.skeletonBody}>
        <div className={styles.skeletonLine} />
        <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
        <div className={styles.skeletonButton} />
      </div>
    </div>
  );
}

export function DealEmptyState({
  filtered = false,
  suggestions = [],
}: {
  filtered?: boolean;
  suggestions?: Array<{ label: string; query: string; matchingProducts: number }>;
}) {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyIcon}><PublicIcon name={filtered ? 'filter' : 'shield'} size={24} /></span>
      <h2>{filtered ? 'Không có sản phẩm phù hợp bộ lọc' : 'Chưa có deal đủ điều kiện công khai'}</h2>
      <p>
        {filtered
          ? 'Hãy xóa một vài điều kiện hoặc quay lại danh sách mới cập nhật.'
          : 'SanDeal chưa có sản phẩm vượt qua đầy đủ cổng nguồn, link, ảnh và nội dung. Không có card giả được tạo để lấp chỗ trống.'}
      </p>
      {suggestions.length > 0 ? (
        <div className={styles.emptyActions} aria-label="Goi y tim kiem co san pham">
          {suggestions.map(suggestion => (
            <Link
              className={styles.secondaryButton}
              href={`/deals?q=${encodeURIComponent(suggestion.query)}`}
              key={`${suggestion.query}:${suggestion.label}`}
            >
              {suggestion.label} ({suggestion.matchingProducts})
            </Link>
          ))}
        </div>
      ) : null}
      <div className={styles.emptyActions}>
        {filtered ? <Link className={styles.secondaryButton} href="/deals">Xóa bộ lọc</Link> : null}
        <Link className={styles.primaryButton} href="/review-methodology">Xem cách kiểm tra</Link>
      </div>
    </div>
  );
}
