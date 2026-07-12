import type { Metadata } from 'next';
import type { Product } from '../types';
import { config } from '../config';
import { isPublicSafeProduct } from '../publicProductFilter';
import { isReviewIndexable } from '../editorialReview';

export function canonicalProductUrl(product: Pick<Product, 'slug'>): string {
  return new URL(`/deals/${encodeURIComponent(product.slug)}`, config.siteUrl).toString();
}

export function getProductIndexingDecision(product?: Product | null): { indexable: boolean; reasons: string[] } {
  if (!product) return { indexable: false, reasons: ['missing_product'] };
  const reasons: string[] = [];
  if (!isPublicSafeProduct(product)) reasons.push('safe_publish_blocked');
  if (!isReviewIndexable(product)) reasons.push(...(product.reviewContent?.reviewBlockReasons || ['review_not_ready']));
  if (!product.imageUrl || product.imageHealthStatus !== 'ok') reasons.push('broken_image');
  if (product.status !== 'published' || product.publicHidden !== false) reasons.push('not_public');
  return { indexable: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function buildProductMetadata(product?: Product | null): Metadata {
  if (!product) return { title: 'Không tìm thấy sản phẩm | SanDeal', robots: { index: false, follow: true } };
  const review = product.reviewContent;
  const indexing = getProductIndexingDecision(product);
  const title = review?.reviewTitle || `${product.title} | Thông tin đang được xác minh`;
  const description = review?.reviewSummary || `Thông tin về ${product.title} đang được SanDeal kiểm tra và chưa đủ điều kiện lập chỉ mục.`;
  const canonical = canonicalProductUrl(product);
  return {
    title,
    description: description.slice(0, 160),
    alternates: { canonical },
    robots: { index: indexing.indexable, follow: true, googleBot: { index: indexing.indexable, follow: true } },
    openGraph: {
      title, description: description.slice(0, 200), url: canonical, siteName: 'SanDeal', locale: 'vi_VN', type: 'article',
      images: product.imageUrl ? [{ url: product.imageUrl, alt: product.title }] : [],
      modifiedTime: review?.contentUpdatedAt || product.updatedAt,
    },
    twitter: { card: product.imageUrl ? 'summary_large_image' : 'summary', title, description: description.slice(0, 200), images: product.imageUrl ? [product.imageUrl] : [] },
  };
}

export function buildProductJsonLd(product: Product): Record<string, unknown> | null {
  if (!getProductIndexingDecision(product).indexable || !product.reviewContent) return null;
  const currentPrice = Number(product.salePrice || product.price || 0);
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org', '@type': 'Product', name: product.title,
    image: product.imageUrl ? [product.imageUrl] : undefined,
    description: product.reviewContent.reviewSummary,
    url: canonicalProductUrl(product),
    brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
    sku: product.sku || undefined, gtin: product.gtin || undefined, mpn: product.mpn || undefined,
    offers: currentPrice > 0 ? {
      '@type': 'Offer', price: currentPrice, priceCurrency: product.currency,
      url: product.affiliateUrl || product.originalUrl, seller: { '@type': 'Organization', name: String(product.source || 'Nguồn đối tác') },
    } : undefined,
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

export function buildBreadcrumbJsonLd(product: Product): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: config.siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Sản phẩm', item: new URL('/deals', config.siteUrl).toString() },
      { '@type': 'ListItem', position: 3, name: product.title, item: canonicalProductUrl(product) },
    ],
  };
}

export function selectRelatedProducts(product: Product, candidates: Product[], limit = 4): Product[] {
  const price = Number(product.salePrice || product.price || 0);
  return candidates.filter((item) => item.id !== product.id && getProductIndexingDecision(item).indexable)
    .map((item) => {
      const itemPrice = Number(item.salePrice || item.price || 0);
      let score = 0;
      if (product.category && item.category === product.category) score += 5;
      if (product.brand && item.brand === product.brand) score += 4;
      if (price && itemPrice && Math.abs(price - itemPrice) / Math.max(price, itemPrice) <= 0.3) score += 3;
      if (product.tags?.some((tag) => item.tags?.includes(tag))) score += 2;
      return { item, score };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ item }) => item);
}

export function stableLastModified(product: Product): string {
  const candidates = [product.reviewContent?.contentUpdatedAt, product.publishedAt, product.createdAt].filter((value): value is string => Boolean(value));
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || product.createdAt;
}
