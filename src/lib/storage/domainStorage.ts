import type { Product, ProductSource } from '../types';
import type { PriceSnapshot } from '../product-intelligence/types';

/** Version includes a content token so legacy writers cannot evade stale-write detection. */
export interface ProductVersion { revision: number; token: string }
export interface StoredProduct { value: Product; version: ProductVersion }
export type ProductCommitResult =
  | { status: 'APPLIED'; record: StoredProduct }
  | { status: 'CONFLICT'; reason: 'VERSION' | 'IDENTITY' | 'SLUG' }
  | { status: 'NOT_FOUND' };
export type ProductIdentityQuery = {
  source: ProductSource;
  sourceId: string;
  normalizedOriginalUrl?: string | null;
} | { kind: 'CREATE' | 'CANONICAL'; draft: Partial<Product> };
export interface ProductPageQuery {
  status?: Product['status'];
  limit: number;
  afterId?: string;
}
export interface PriceHistoryQuery {
  productId: string;
  limit: number;
  before?: { capturedAt: string; id: string };
}
export interface DomainStorage {
  readonly capabilities: {
    productLookup: true;
    conditionalProductWrite: true;
    boundedHistory: true;
    /** Legacy formats may scan internally; business code never depends on that. */
    nativeIndexedQueries: boolean;
  };
  getProduct(id: string): Promise<StoredProduct | null>;
  getProductBySlug(slug: string): Promise<StoredProduct | null>;
  /** Returns at most two distinct products: two proves ambiguous identity. */
  findProductIdentity(query: ProductIdentityQuery): Promise<StoredProduct[]>;
  listProducts(query: ProductPageQuery): Promise<StoredProduct[]>;
  createProduct(product: Product, identity?: ProductIdentityQuery): Promise<ProductCommitResult>;
  replaceProduct(product: Product, expected: ProductVersion): Promise<ProductCommitResult>;
  getPriceHistory(query: PriceHistoryQuery): Promise<PriceSnapshot[]>;
  appendPriceSnapshot(snapshot: PriceSnapshot, options: {
    forceCheckpoint: boolean;
    checkpointHours: number;
  }): Promise<{ created: boolean; previous?: PriceSnapshot; snapshot?: PriceSnapshot }>;
  appendProductAudit<T extends object>(kind: 'duplicate' | 'evidence' | 'publication', event: T,
    effectKey?: string): Promise<{ event: T; created: boolean }>;
}

export class DomainStorageError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DomainStorageError'; }
}
export function boundedDomainLimit(value: number, maximum = 365): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new DomainStorageError('DOMAIN_QUERY_LIMIT_INVALID');
  }
  return value;
}
