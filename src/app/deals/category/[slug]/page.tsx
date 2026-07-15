import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { TaxonomyLanding } from '@/components/public/TaxonomyLanding';
import { getPublicTaxonomyLanding } from '@/lib/product-intelligence/publicProducts';
import {
  buildTaxonomyMetadata,
  parseTaxonomySearchParams,
  type TaxonomySearchParams,
} from '@/lib/seo/taxonomySeo';

export const dynamic = 'force-dynamic';

const getLanding = cache((slug: string, page: number) => getPublicTaxonomyLanding('category', slug, page));

function validSlug(slug: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 100;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<TaxonomySearchParams>;
}): Promise<Metadata> {
  const [{ slug }, raw] = await Promise.all([params, searchParams]);
  const parsed = parseTaxonomySearchParams(raw);
  if (!validSlug(slug) || parsed.page === null) {
    return buildTaxonomyMetadata({ kind: 'category', name: 'không hợp lệ', slug: 'invalid', totalItems: 0, page: 1, totalPages: 1, curated: false });
  }
  const data = await getLanding(slug, parsed.page);
  if (!data) return { title: 'Không tìm thấy danh mục | SanDeal', robots: { index: false, follow: true } };
  return buildTaxonomyMetadata({
    kind: 'category',
    name: data.taxonomy.name,
    slug: data.taxonomy.slug,
    totalItems: data.pagination.totalItems,
    page: data.pagination.page,
    totalPages: data.pagination.totalPages,
    curated: parsed.curated,
    imageUrl: data.items.find(item => Boolean(item.imageUrl))?.imageUrl,
  });
}

export default async function CategoryLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<TaxonomySearchParams>;
}) {
  const [{ slug }, raw] = await Promise.all([params, searchParams]);
  const parsed = parseTaxonomySearchParams(raw);
  if (!validSlug(slug) || parsed.page === null) notFound();
  const data = await getLanding(slug, parsed.page);
  if (!data || data.pagination.outOfRange) notFound();
  return <TaxonomyLanding data={data} selectedComparisonIds={parsed.selectedComparisonIds} />;
}
