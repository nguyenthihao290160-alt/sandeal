import type { MetadataRoute } from 'next';
import { config } from '@/lib/config';
import { getPublicProducts } from '@/lib/storage/products';
import { getProductIndexingDecision, stableLastModified } from '@/lib/seo/productSeo';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const products = (await getPublicProducts()).filter((product) => getProductIndexingDecision(product).indexable);
  return [
    { url: config.siteUrl, changeFrequency: 'daily', priority: 1 },
    { url: new URL('/deals', config.siteUrl).toString(), changeFrequency: 'daily', priority: 0.9 },
    { url: new URL('/review-methodology', config.siteUrl).toString(), changeFrequency: 'monthly', priority: 0.5 },
    ...products.map((product) => ({
      url: new URL(`/deals/${encodeURIComponent(product.slug)}`, config.siteUrl).toString(),
      lastModified: stableLastModified(product), changeFrequency: 'daily' as const, priority: 0.8,
      images: product.imageUrl ? [product.imageUrl] : undefined,
    })),
  ];
}
