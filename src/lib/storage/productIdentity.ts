import { createHash } from 'node:crypto';
import type { Product } from '../types';
import type { ProductVersion, StoredProduct } from './domainStorage';

const TRACKING_QUERY_KEYS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid']);
export function normalizeProductIdentityUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch { return null; }
}

/** Exact source IDs and canonical merchant URLs only; never fuzzy titles. */
export function productIdentityKeys(product: Product): string[] {
  const keys = new Set<string>();
  const addSource = (source: string | undefined, id: string | undefined) => {
    if (source && id) keys.add(JSON.stringify(['source', source, id]));
  };
  const addUrl = (url: unknown) => {
    const normalized = normalizeProductIdentityUrl(url);
    if (normalized) keys.add(JSON.stringify(['url', normalized]));
  };
  addSource(product.source, product.sourceId);
  addSource(product.source, product.externalId);
  addUrl(product.originalUrl);
  for (const mapping of product.sourceMappings || []) {
    addSource(mapping.source, mapping.sourceId);
    addUrl(mapping.normalizedOriginalUrl || mapping.originalUrl);
  }
  return [...keys].sort();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, nested]) => key !== 'storageRevision' && nested !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]));
  return value;
}
export function productVersion(product: Product): ProductVersion {
  return { revision: product.storageRevision || 1,
    token: createHash('sha256').update(JSON.stringify(canonical(product))).digest('hex') };
}
export function storedProduct(product: Product): StoredProduct {
  return { value: product, version: productVersion(product) };
}

function normalizedDuplicateUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|aff|affiliate|ref|source|campaign|clickid|subid)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return undefined; }
}

/** The established operator-create identity differs from source discovery. */
export function productCreateDuplicateKeys(product: Partial<Product>): string[] {
  const keys = new Set<string>();
  const sourceItemId = product.sourceItemId || product.sourceId || product.externalId;
  if (product.source && sourceItemId) keys.add(`source:${product.source}:${String(sourceItemId).trim().toLowerCase()}`);
  const canonicalUrl = normalizedDuplicateUrl(product.canonicalProductUrl || product.originalUrl);
  if (canonicalUrl) keys.add(`canonical:${canonicalUrl}`);
  const affiliateUrl = normalizedDuplicateUrl(product.affiliateUrl);
  if (affiliateUrl) keys.add(`affiliate:${affiliateUrl}`);
  const merchant = (product.merchantIdentity || product.merchantDomain || (() => {
    try { return canonicalUrl ? new URL(canonicalUrl).hostname : ''; } catch { return ''; }
  })()).toLowerCase();
  const title = product.title?.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!keys.size && merchant && title && title.length >= 16) keys.add(`merchant-title:${merchant}:${title}`);
  return [...keys];
}

export function productCanonicalIdentityKeys(product: Partial<Product>): string[] {
  const keys = new Set<string>();
  for (const id of [product.sourceId, product.externalId]) {
    if (product.source && id) keys.add(JSON.stringify(['source', product.source, id]));
  }
  if (product.originalUrl) keys.add(JSON.stringify(['original', product.originalUrl]));
  if (product.affiliateUrl) keys.add(JSON.stringify(['affiliate', product.affiliateUrl]));
  return [...keys];
}

export function queryIdentityKeys(query: import('./domainStorage').ProductIdentityQuery): { namespace: string; keys: string[] } {
  if ('kind' in query) return { namespace: query.kind, keys: query.kind === 'CREATE'
    ? productCreateDuplicateKeys(query.draft)
    : productCanonicalIdentityKeys({ ...query.draft, sourceId: String(query.draft.sourceId || query.draft.externalId || ''), externalId: undefined }) };
  return { namespace: 'SOURCE', keys: [JSON.stringify(['source', query.source, query.sourceId]),
    ...(query.normalizedOriginalUrl ? [JSON.stringify(['url', query.normalizedOriginalUrl])] : [])] };
}
export function allProductIdentityKeys(product: Product): Array<{ namespace: string; key: string }> {
  return [
    ...productIdentityKeys(product).map(key => ({ namespace: 'SOURCE', key })),
    ...productCreateDuplicateKeys(product).map(key => ({ namespace: 'CREATE', key })),
    ...productCanonicalIdentityKeys(product).map(key => ({ namespace: 'CANONICAL', key })),
  ];
}
