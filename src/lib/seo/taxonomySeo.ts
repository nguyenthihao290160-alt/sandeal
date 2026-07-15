import type { Metadata } from 'next';

import { config } from '../config';

export type PublicTaxonomyKind = 'category' | 'brand';

export interface TaxonomySeoInput {
  kind: PublicTaxonomyKind;
  name: string;
  slug: string;
  totalItems: number;
  page: number;
  totalPages: number;
  curated: boolean;
  imageUrl?: string;
}

export type TaxonomySearchParams = Record<string, string | string[] | undefined>;

export function parseTaxonomySearchParams(raw: TaxonomySearchParams): {
  page: number | null;
  selectedComparisonIds: string[];
  curated: boolean;
} {
  const pageValue = Array.isArray(raw.page) ? null : raw.page;
  const page = pageValue === undefined
    ? 1
    : typeof pageValue === 'string' && /^\d+$/.test(pageValue) && Number(pageValue) >= 1 && Number(pageValue) <= 100_000
      ? Number(pageValue)
      : null;
  const compareValue = Array.isArray(raw.compare) ? raw.compare[0] : raw.compare;
  const selectedComparisonIds = [...new Set(String(compareValue || '').split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0 && id.length <= 120))].slice(0, 4);
  const curated = Object.keys(raw).every(key => key === 'page');
  return { page, selectedComparisonIds, curated };
}

export function publicTaxonomySlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, match => match === 'Đ' ? 'D' : 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function taxonomyPath(kind: PublicTaxonomyKind, slug: string, page = 1): string {
  const base = `/deals/${kind}/${encodeURIComponent(slug)}`;
  return page > 1 ? `${base}?page=${page}` : base;
}

export function taxonomyIndexingDecision(input: TaxonomySeoInput): { indexable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.curated) reasons.push('non_curated_query');
  if (input.totalItems < 2) reasons.push(input.totalItems === 0 ? 'zero_products' : 'thin_taxonomy');
  if (input.page < 1 || input.page > input.totalPages) reasons.push('page_out_of_range');
  return { indexable: reasons.length === 0, reasons };
}

export function buildTaxonomyMetadata(input: TaxonomySeoInput): Metadata {
  const label = input.kind === 'category' ? `danh mục ${input.name}` : `thương hiệu ${input.name}`;
  const title = `Deal ${input.name} đã kiểm tra${input.page > 1 ? ` - Trang ${input.page}` : ''} | SanDeal`;
  const description = `Khám phá sản phẩm thuộc ${label} đã vượt cổng công khai, kèm giá, nguồn, thời điểm cập nhật và dữ kiện hiện có.`;
  const path = taxonomyPath(input.kind, input.slug, input.page);
  const canonical = new URL(path, config.siteUrl).toString();
  const indexing = taxonomyIndexingDecision(input);
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: indexing.indexable, follow: true, googleBot: { index: indexing.indexable, follow: true } },
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'website',
      locale: 'vi_VN',
      siteName: 'SanDeal',
      images: input.imageUrl ? [{ url: input.imageUrl, alt: `Sản phẩm ${input.name}` }] : [],
    },
    twitter: {
      card: input.imageUrl ? 'summary_large_image' : 'summary',
      title,
      description,
      images: input.imageUrl ? [input.imageUrl] : [],
    },
  };
}

export function buildTaxonomyBreadcrumbJsonLd(input: Pick<TaxonomySeoInput, 'kind' | 'name' | 'slug'>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: config.siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Deal', item: new URL('/deals', config.siteUrl).toString() },
      { '@type': 'ListItem', position: 3, name: input.name, item: new URL(taxonomyPath(input.kind, input.slug), config.siteUrl).toString() },
    ],
  };
}

export function buildTaxonomyItemListJsonLd(
  input: Pick<TaxonomySeoInput, 'kind' | 'name' | 'slug' | 'page'>,
  items: Array<{ title: string; slug: string }>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Deal ${input.name} đã kiểm tra`,
    url: new URL(taxonomyPath(input.kind, input.slug, input.page), config.siteUrl).toString(),
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: (input.page - 1) * 12 + index + 1,
      name: item.title,
      url: new URL(`/deals/${encodeURIComponent(item.slug)}`, config.siteUrl).toString(),
    })),
  };
}

export function taxonomyFaq(kind: PublicTaxonomyKind, name: string): Array<{ question: string; answer: string }> {
  const subject = kind === 'category' ? `danh mục ${name}` : `thương hiệu ${name}`;
  return [
    {
      question: `Sản phẩm ${subject} được đưa lên SanDeal theo điều kiện nào?`,
      answer: 'Chỉ sản phẩm đã vượt kiểm tra nguồn, liên kết, hình ảnh, dữ liệu giá, nội dung và cổng Safe Publish mới xuất hiện công khai.',
    },
    {
      question: `Giá của ${subject} có phải cam kết bán hàng không?`,
      answer: 'Không. SanDeal ghi lại giá tham khảo cùng thời điểm kiểm tra; nhà bán xác nhận giá và điều kiện cuối cùng tại trang đích.',
    },
  ];
}

export function buildFaqJsonLd(items: Array<{ question: string; answer: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
