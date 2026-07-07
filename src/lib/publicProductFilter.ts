import type { Product } from './types';

const DEMO_TITLES = [
  'Tai nghe Bluetooth TWS Pro Max',
  'Balo laptop chống nước 15.6 inch',
];

export function looksLikeDemoTitle(title?: string): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  if (DEMO_TITLES.some(d => d.toLowerCase() === t)) return true;
  if (t.includes('demo') || t.includes('sample') || t.includes('test product') || t.includes('test')) return true;
  return false;
}

export function isPublicSafeProduct(p: Product): boolean {
  if (!p) return false;

  const status = p.status;
  // Disallowed explicit states
  if (status === 'archived' || status === 'draft' || status === 'needs_review') return false;

  // Must be approved or published
  if (status !== 'approved' && status !== 'published') return false;

  // Title must exist and not look demo/test
  if (!p.title || looksLikeDemoTitle(p.title)) return false;

  // Must have at least one external link
  if (!p.affiliateUrl && !p.originalUrl && !(p as any).url) return false;

  // Exclude explicit demo/sample/test flags or sources
  if ((p as any).isDemo === true || (p as any).isSample === true || (p as any).isTest === true) return false;
  if ((p as any).source === 'demo' || (p as any).source === 'sample' || (p as any).source === 'test') return false;

  // Manual source must be verified
  if (p.source === 'manual' && !(p as any).verifiedSource) return false;

  // Platform/source must exist
  if (!p.platform && !p.source) return false;

  // Link health — treat certain statuses as broken
  const brokenStatuses = ['not_found', 'affiliate_error', 'image_broken', 'product_unavailable', 'server_error'];
  if (p.linkHealthStatus && brokenStatuses.includes(p.linkHealthStatus)) return false;

  return true;
}
