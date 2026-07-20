import type { Metadata } from 'next';
import type { Product } from '../types';
import { config } from '../config';
import { isPublicSafeProduct } from '../publicProductFilter';
import { isReviewIndexable } from '../editorialReview';
import { PRODUCT_INTELLIGENCE_CONFIG } from '../product-intelligence/config';
import { commerceQualityScore, isDiscoverableCommerceProduct } from '../product-intelligence/searchRanking';
import { publicTaxonomySlug, taxonomyPath } from './taxonomySeo';

export function canonicalProductUrl(product: Pick<Product, 'slug'>): string {
  return new URL(`/deals/${encodeURIComponent(product.slug)}`, config.siteUrl).toString();
}

export function getProductIndexingDecision(product?: Product | null): { indexable: boolean; reasons: string[] } {
  if (!product) return { indexable: false, reasons: ['missing_product'] };
  const reasons: string[] = [];
  if (!isPublicSafeProduct(product)) reasons.push('safe_publish_blocked');
  if ((product.duplicateConfidence || 0) >= PRODUCT_INTELLIGENCE_CONFIG.thresholds.duplicateHigh) reasons.push('duplicate_high_confidence');
  if (!isReviewIndexable(product)) reasons.push(...(product.reviewContent?.reviewBlockReasons || ['review_not_ready']));
  if (!product.imageUrl || product.imageHealthStatus !== 'ok') reasons.push('broken_image');
  if (product.status !== 'published' || product.publicHidden !== false) reasons.push('not_public');
  if (!isDiscoverableCommerceProduct(product)) reasons.push(`price_or_lifecycle_not_discoverable:${product.priceTruthState || product.lifecycleState || 'unknown'}`);
  if (product.schemaVersion === 2 && product.autoPublished === true) {
    if (!String(product.category || '').trim()) reasons.push('category_missing');
    if (!String(product.brand || '').trim()) reasons.push('brand_missing');
    if (product.evidenceCoverage !== undefined && Number(product.evidenceCoverage) < 0.8) reasons.push('evidence_coverage_low');
    const verifiedAt = Date.parse(product.priceObservedAt || product.linkLastCheckedAt || '');
    if (Number.isFinite(verifiedAt) && Date.now() - verifiedAt > 7 * 24 * 60 * 60_000) reasons.push('verification_stale');
  }
  return { indexable: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function buildProductMetadata(product?: Product | null): Metadata {
  if (!product) return { title: 'Không tìm thấy sản phẩm | SanDeal', robots: { index: false, follow: true } };
  const review = product.reviewContent;
  const indexing = getProductIndexingDecision(product);
  const title = review?.reviewTitle || `${product.title} | Thông tin đang được xác minh`;
  const description = review?.reviewSummary || `Thông tin về ${product.title} đang được SanDeal kiểm tra và chưa đủ điều kiện lập chỉ mục.`;
  const canonical = canonicalProductUrl(product);
  const previewImage = indexing.indexable ? `${canonical}/opengraph-image` : new URL('/opengraph-image', config.siteUrl).toString();
  return {
    title,
    description: description.slice(0, 160),
    alternates: { canonical },
    robots: { index: indexing.indexable, follow: true, googleBot: { index: indexing.indexable, follow: true } },
    openGraph: {
      title, description: description.slice(0, 200), url: canonical, siteName: 'SanDeal', locale: 'vi_VN', type: 'article',
      images: [{ url: previewImage, alt: indexing.indexable ? `${product.title} — SanDeal` : 'SanDeal' }],
      modifiedTime: review?.contentUpdatedAt || product.updatedAt,
    },
    twitter: { card: 'summary_large_image', title, description: description.slice(0, 200), images: [previewImage] },
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
      url: new URL(`/go/${encodeURIComponent(product.id)}`, config.siteUrl).toString(),
    } : undefined,
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

export function buildBreadcrumbJsonLd(product: Product): Record<string, unknown> {
  const categorySlug = product.category ? publicTaxonomySlug(product.category) : '';
  const middle = categorySlug
    ? [{ '@type': 'ListItem', position: 3, name: product.category, item: new URL(taxonomyPath('category', categorySlug), config.siteUrl).toString() }]
    : [];
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: config.siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Sản phẩm', item: new URL('/deals', config.siteUrl).toString() },
      ...middle,
      { '@type': 'ListItem', position: middle.length ? 4 : 3, name: product.title, item: canonicalProductUrl(product) },
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
      score += commerceQualityScore(item) * 5;
      return { item, score };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score
      || Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt)
      || a.item.id.localeCompare(b.item.id)).slice(0, limit).map(({ item }) => item);
}

export function buildProductFactFaq(product: Product): Array<{ question: string; answer: string; evidenceFields: string[] }> {
  if (!getProductIndexingDecision(product).indexable) return [];
  const items: Array<{ question: string; answer: string; evidenceFields: string[] }> = [];
  if (product.brand && product.category) {
    items.push({
      question: `${product.title} thuoc thuong hieu va danh muc nao?`,
      answer: `${product.title} duoc nguon xac minh ghi nhan thuoc thuong hieu ${product.brand}, danh muc ${product.category}.`,
      evidenceFields: ['title', 'brand', 'category'],
    });
  }
  const currentPrice = Number(product.salePrice || product.price || 0);
  if (currentPrice > 0 && product.priceObservedAt && !['STALE', 'CONFLICTED', 'ANOMALOUS', 'UNAVAILABLE'].includes(String(product.priceTruthState || ''))) {
    items.push({
      question: `Gia quan sat gan nhat cua ${product.title} la bao nhieu?`,
      answer: `Gia duoc ghi nhan la ${Math.round(currentPrice).toLocaleString('vi-VN')} ${product.currency} vao ${product.priceObservedAt}. Gia cuoi cung do nha ban xac nhan.`,
      evidenceFields: ['price', 'currency', 'priceObservedAt'],
    });
  }
  return items;
}

export function stableLastModified(product: Product): string {
  const candidates = [product.reviewContent?.contentUpdatedAt, product.publishedAt, product.createdAt].filter((value): value is string => Boolean(value));
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || product.createdAt;
}
