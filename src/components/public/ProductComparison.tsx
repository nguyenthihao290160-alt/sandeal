import Link from 'next/link';

import type { PublicComparisonData } from './contracts';
import { DealScoreBadge, PriceDisplay, VerifiedSourceBadge } from './DealCard';
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

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function formatDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

export function ProductComparison({ products }: { products: PublicComparisonData[] }) {
  const specificationKeys = [...new Set(products.flatMap((product) => Object.keys(product.specifications || {})))];
  const rows: Array<{ label: string; values: React.ReactNode[]; visible: boolean }> = [
    {
      label: 'Giá hiện tại',
      values: products.map((product) => <PriceDisplay currentPrice={product.currentPrice} originalPrice={product.originalPrice} currency={product.currency} key={product.id} />),
      visible: products.some((product) => hasValue(product.currentPrice)),
    },
    {
      label: 'Deal Score',
      values: products.map((product) => <DealScoreBadge score={product.dealScore} band={product.dealBand} key={product.id} />),
      visible: products.some((product) => hasValue(product.dealScore)),
    },
    {
      label: 'Quality Score',
      values: products.map((product) => hasValue(product.qualityScore) ? Math.round(product.qualityScore as number) : null),
      visible: products.some((product) => hasValue(product.qualityScore)),
    },
    {
      label: 'Nền tảng',
      values: products.map((product) => PLATFORM_LABELS[product.platform] || product.platform || null),
      visible: products.some((product) => hasValue(product.platform)),
    },
    {
      label: 'Thương hiệu',
      values: products.map((product) => product.brand || null),
      visible: products.some((product) => hasValue(product.brand)),
    },
    {
      label: 'Nguồn',
      values: products.map((product) => (
        <div className={styles.metaRow} key={product.id}>
          <VerifiedSourceBadge verified={product.verifiedSource} />
          {product.sourceLabel ? <span>{product.sourceLabel}</span> : null}
        </div>
      )),
      visible: products.some((product) => product.verifiedSource || hasValue(product.sourceLabel)),
    },
    {
      label: 'Điểm mạnh',
      values: products.map((product) => product.strengths?.length ? <ul className={styles.evidenceList} key={product.id}>{product.strengths.map((item) => <li key={item}>{item}</li>)}</ul> : null),
      visible: products.some((product) => hasValue(product.strengths)),
    },
    {
      label: 'Hạn chế',
      values: products.map((product) => product.limitations?.length ? <ul className={styles.evidenceList} key={product.id}>{product.limitations.map((item) => <li key={item}>{item}</li>)}</ul> : null),
      visible: products.some((product) => hasValue(product.limitations)),
    },
    {
      label: 'Cập nhật',
      values: products.map((product) => formatDate(product.updatedAt || product.priceUpdatedAt)),
      visible: products.some((product) => Boolean(formatDate(product.updatedAt || product.priceUpdatedAt))),
    },
  ];

  for (const key of specificationKeys) {
    rows.push({
      label: key,
      values: products.map((product) => product.specifications?.[key] ?? null),
      visible: products.some((product) => hasValue(product.specifications?.[key])),
    });
  }

  return (
    <div className={styles.comparisonWrap}>
      <table className={styles.comparisonTable}>
        <caption className={styles.visuallyHidden}>So sánh dữ liệu của {products.length} sản phẩm</caption>
        <thead>
          <tr>
            <th scope="col">Tiêu chí</th>
            {products.map((product) => (
              <th scope="col" key={product.id}>
                <Link className={styles.dealTitleLink} href={`/deals/${encodeURIComponent(product.slug)}`}>{product.title}</Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.filter((row) => row.visible).map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              {row.values.map((value, index) => <td key={`${row.label}-${products[index].id}`}>{value ?? 'Chưa có dữ liệu'}</td>)}
            </tr>
          ))}
          <tr>
            <td>Trang bán</td>
            {products.map((product) => (
              <td key={product.id}>
                <a className={styles.primaryButton} href={product.outboundHref?.startsWith('/go/') ? product.outboundHref : `/go/${encodeURIComponent(product.id)}`} target="_blank" rel="sponsored noopener noreferrer">
                  Xem tại nhà bán <PublicIcon name="external" size={14} />
                </a>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
