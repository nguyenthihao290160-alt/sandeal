import type { MetadataRoute } from 'next';
import { config } from '@/lib/config';
import { getPublicProducts } from '@/lib/storage/products';
import { getProductIndexingDecision, stableLastModified } from '@/lib/seo/productSeo';
import { summarizePublicTaxonomies } from '@/lib/product-intelligence/publicProducts';
import { taxonomyPath } from '@/lib/seo/taxonomySeo';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const products = (await getPublicProducts()).filter((product) => getProductIndexingDecision(product).indexable);
  const categories = summarizePublicTaxonomies(products, 'category').filter(item => item.count >= 2);
  const brands = summarizePublicTaxonomies(products, 'brand').filter(item => item.count >= 2);
  return [
    { url: config.siteUrl, changeFrequency: 'daily', priority: 1 },
    { url: new URL('/deals', config.siteUrl).toString(), changeFrequency: 'daily', priority: 0.9 },
    { url: new URL('/review-methodology', config.siteUrl).toString(), changeFrequency: 'monthly', priority: 0.5 },
    ...categories.map(item => ({
      url: new URL(taxonomyPath('category', item.slug), config.siteUrl).toString(),
      lastModified: item.lastModified,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
    ...brands.map(item => ({
      url: new URL(taxonomyPath('brand', item.slug), config.siteUrl).toString(),
      lastModified: item.lastModified,
      changeFrequency: 'daily' as const,
      priority: 0.65,
    })),
    ...products.map((product) => ({
      url: new URL(`/deals/${encodeURIComponent(product.slug)}`, config.siteUrl).toString(),
      lastModified: stableLastModified(product), changeFrequency: 'daily' as const, priority: 0.8,
      images: product.imageUrl ? [product.imageUrl] : undefined,
    })),
  ];
}
