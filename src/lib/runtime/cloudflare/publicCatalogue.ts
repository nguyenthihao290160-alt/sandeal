import type { Product } from '../../types';
import type { DomainStorage } from '../../storage/domainStorage';
import { isPublicSafeProduct } from '../../publicProductFilter';
import { derivePersistedPriceTruth } from '../../autonomous/priceTruthEngine';
import { validateExternalUrl } from '../../product-intelligence/urlValidation';
import { CloudflareRequestError } from './context';

export function isCloudflarePublic(product: Product): boolean {
  return product.runtimeRecoveryCanaryObservationPending !== true && isPublicSafeProduct(product);
}
function publicImage(value: string | undefined) {
  if (!value) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  const result = validateExternalUrl(value);
  return result.safe && result.normalizedUrl?.startsWith('https:') ? result.normalizedUrl : undefined;
}
/** Explicit public projection. Internal source payloads, audit data and affiliate targets never leave here. */
export function publicCard(product: Product) {
  const truth = derivePersistedPriceTruth(product);
  return { id: product.id, slug: product.slug, title: product.title, imageUrl: publicImage(product.imageUrl),
    platform: product.platform, category: product.category, brand: product.brand,
    currentPrice: truth.isVerified ? (product.salePrice || product.price) : undefined, currency: 'VND' as const, verifiedSource: product.verifiedSource === true || product.sourceVerified === true,
    priceUpdatedAt: product.priceObservedAt || product.updatedAt, updatedAt: product.updatedAt,
    outboundHref: `/go/${encodeURIComponent(product.id)}` };
}
export async function publicPage(domain: DomainStorage, params: URLSearchParams) {
  const allowed = new Set(['limit', 'after']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new CloudflareRequestError('UNSUPPORTED_CATALOGUE_FILTER', 400);
  const raw = params.get('limit') || '20', after = params.get('after') || '';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50 || after.length > 160 || /[\x00-\x1f]/.test(after)) throw new CloudflareRequestError('INVALID_PAGE', 400);
  const limit = Number(raw);
  // A single indexed page of published candidates; no scans to fill a page and no fabricated totals.
  const records = await domain.listProducts({ status: 'published', afterId: after, limit });
  return { items: records.filter(row => isCloudflarePublic(row.value)).map(row => publicCard(row.value)),
    nextCursor: records.length === limit ? records[records.length - 1].value.id : null, limit };
}
export async function publicDetail(domain: DomainStorage, slug: string) {
  if (!/^[a-z0-9-]{1,160}$/i.test(slug)) throw new CloudflareRequestError('INVALID_SLUG', 400);
  const record = await domain.getProductBySlug(slug);
  if (!record || !isCloudflarePublic(record.value)) throw new CloudflareRequestError('NOT_FOUND', 404);
  const product = record.value;
  const snapshots = await domain.getPriceHistory({ productId: product.id, limit: 30 });
  return { ...publicCard(product), description: product.description,
    offers: (product.offers || []).slice(0, 50).map(offer => ({ id: offer.id, source: offer.source, merchant: offer.merchant,
      price: offer.price, health: offer.health, observedAt: offer.observedAt })),
    publication: { status: product.status, public: true },
    priceHistory: snapshots.map(row => ({ capturedAt: row.capturedAt, price: row.salePrice ?? row.price })) };
}
