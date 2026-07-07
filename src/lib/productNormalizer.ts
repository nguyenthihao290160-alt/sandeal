import type { Product } from './types';

const PLACEHOLDER_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='800' viewBox='0 0 24 24' fill='none' stroke='currentColor'>\n  <rect width='100%' height='100%' fill='%23f3f4f6' />\n  <g transform='translate(4,4)'>\n    <rect x='0' y='0' width='16' height='12' rx='2' fill='%23e5e7eb' />\n    <circle cx='4' cy='4' r='2' fill='%23c7d2fe' />\n    <path d='M0 12 L6 6 L10 10 L16 4 L24 12' stroke='%23cbd5e1' stroke-width='1.2' fill='none' />\n  </g>\n</svg>";
const PLACEHOLDER_SVG_DATAURL = 'data:image/svg+xml;utf8,' + encodeURIComponent(PLACEHOLDER_SVG);

/**
 * Normalize product for public display.
 * - Avoids throwing on missing fields
 * - Computes discountPercent from price/salePrice
 * - Marks missing image and provides placeholder
 */
export function normalizeProductForPublic(p: Partial<Product>): Product {
  const price = typeof p.price === 'number' ? p.price : undefined;
  const salePrice = typeof p.salePrice === 'number' ? p.salePrice : undefined;
  const discountPercent = (price && salePrice && price > salePrice) ? Math.round((1 - (salePrice / price)) * 100) : undefined;

  const imageUrl = p.imageUrl && typeof p.imageUrl === 'string' && p.imageUrl.length > 5 ? p.imageUrl : PLACEHOLDER_SVG_DATAURL;

  const normalized: Product = {
    id: String(p.id || '') || '',
    title: p.title || 'Sản phẩm chưa có tiêu đề',
    slug: p.slug || (p.title ? String(p.title).toLowerCase().replace(/[^a-z0-9]+/g, '-') : '') || '',
    description: p.description || undefined,
    kind: (p.kind as any) || 'product',
    platform: (p.platform as any) || 'website',
    source: (p.source as any) || 'manual',
    originalUrl: p.originalUrl || undefined,
    affiliateUrl: p.affiliateUrl || undefined,
    imageUrl,
    gallery: Array.isArray(p.gallery) ? p.gallery : [],
    price,
    salePrice,
    currency: 'VND',
    priceNote: p.priceNote || undefined,
    category: p.category || undefined,
    tags: Array.isArray(p.tags) ? p.tags : [],
    benefits: Array.isArray(p.benefits) ? p.benefits : [],
    painPoints: Array.isArray(p.painPoints) ? p.painPoints : [],
    targetAudience: Array.isArray(p.targetAudience) ? p.targetAudience : [],
    warnings: Array.isArray(p.warnings) ? p.warnings : [],
    contentAngles: Array.isArray(p.contentAngles) ? p.contentAngles : [],
    complianceNotes: Array.isArray(p.complianceNotes) ? p.complianceNotes : [],
    affiliateSource: p.affiliateSource || undefined,
    campaignName: p.campaignName || undefined,
    commissionNote: p.commissionNote || undefined,
    affiliateDisclosure: p.affiliateDisclosure || undefined,
    score: typeof p.score === 'number' ? p.score : undefined,
    scoreLabel: p.scoreLabel,
    scoreReasons: Array.isArray(p.scoreReasons) ? p.scoreReasons : undefined,
    scoreWarnings: Array.isArray(p.scoreWarnings) ? p.scoreWarnings : undefined,
    riskLevel: (p.riskLevel as any) || 'unknown',
    status: (p.status as any) || 'draft',
    externalId: p.externalId,
    rawSourceType: p.rawSourceType,
    linkHealthStatus: p.linkHealthStatus,
    linkLastCheckedAt: p.linkLastCheckedAt,
    linkFailureCount: p.linkFailureCount || 0,
    imageHealthStatus: p.imageHealthStatus,
    archivedReason: p.archivedReason,
    unpublishedReason: p.unpublishedReason,
    contentPackageStatus: p.contentPackageStatus || 'none',
    complianceStatus: p.complianceStatus || 'safe',
    complianceIssues: Array.isArray(p.complianceIssues) ? p.complianceIssues : [],
    generatedContent: p.generatedContent,
    dataCompleteness: computeDataCompleteness(p),
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || new Date().toISOString(),
  };

  return normalized;
}

function computeDataCompleteness(p: Partial<Product>): number {
  let score = 50; // baseline
  if (p.title) score += 10;
  if (p.description) score += 10;
  if (p.imageUrl) score += 15;
  if (p.price || p.salePrice) score += 10;
  if (p.affiliateUrl || p.originalUrl) score += 5;
  if (Array.isArray(p.benefits) && p.benefits.length > 0) score += 5;
  return Math.max(0, Math.min(100, score));
}
