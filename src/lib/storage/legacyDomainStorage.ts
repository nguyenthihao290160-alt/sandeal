import { normalizeCanonicalProduct } from '../canonicalProduct';
import type { Product } from '../types';
import type { PriceSnapshot } from '../product-intelligence/types';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from '../product-intelligence/config';
import { boundedDomainLimit, type DomainStorage, type ProductCommitResult, type ProductIdentityQuery } from './domainStorage';
import { allProductIdentityKeys, queryIdentityKeys, storedProduct, productIdentityKeys } from './productIdentity';
import type { StorageAdapter } from './types';
import { domainJson } from './domainSerialization';

const normalize = (value: Partial<Product>) => normalizeCanonicalProduct(value, value.updatedAt || value.createdAt || '1970-01-01T00:00:00.000Z');
function matches(product: Product, query: ProductIdentityQuery): boolean {
  const requested = queryIdentityKeys(query);
  return allProductIdentityKeys(product).some(item => item.namespace === requested.namespace && requested.keys.includes(item.key));
}
const historyOrder = (a: PriceSnapshot, b: PriceSnapshot) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id);
const sourceKeys = (product: Product) => productIdentityKeys(product).filter(key => JSON.parse(key)[0] === 'source');

/** Compatibility implementation: only legacy infrastructure knows collection revisions. */
export function createLegacyDomainStorage(adapter: Pick<StorageAdapter, 'readCollection' | 'runTransaction'>): DomainStorage {
  const products = async () => (await adapter.readCollection<Partial<Product>>('products')).map(normalize);
  return {
    capabilities: { productLookup: true, conditionalProductWrite: true, boundedHistory: true, nativeIndexedQueries: false },
    async appendProductAudit<T extends object>(kind: 'duplicate' | 'evidence' | 'publication', event: T, effectKey?: string) {
      const collection = { duplicate: 'product-duplicate-merge-audit', evidence: 'product-evidence-repair-audit', publication: 'publication-audit' }[kind];
      let result = { event, created: true };
      await adapter.runTransaction<T>(collection, rows => {
        const existing = effectKey ? rows.find(row => (row as { effectKey?: string }).effectKey === effectKey) : undefined;
        if (existing) { result = { event: existing, created: false }; return undefined; }
        return [...rows.slice(-999), domainJson(event)];
      });
      return result;
    },
    async getProduct(id) { const row = (await products()).find(item => item.id === id); return row ? storedProduct(row) : null; },
    async getProductBySlug(slug) { const row = (await products()).find(item => item.slug === slug); return row ? storedProduct(row) : null; },
    async findProductIdentity(query) { return (await products()).filter(item => matches(item, query)).slice(0, 2).map(storedProduct); },
    async listProducts(query) {
      const limit = boundedDomainLimit(query.limit);
      return (await products()).filter(item => (!query.status || item.status === query.status) && (!query.afterId || item.id > query.afterId))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, limit).map(storedProduct);
    },
    async createProduct(product, identity) {
      let result: ProductCommitResult = { status: 'CONFLICT', reason: 'IDENTITY' };
      await adapter.runTransaction<Partial<Product>>('products', rows => {
        const current = rows.map(normalize);
        if (current.some(row => row.id === product.id || (identity && matches(row, identity)))) return undefined;
        const incoming = sourceKeys(product);
        if (current.some(row => sourceKeys(row).some(key => incoming.includes(key)))) return undefined;
        if (product.slug && current.some(row => row.slug === product.slug)) { result = { status: 'CONFLICT', reason: 'SLUG' }; return undefined; }
        const value = normalize({ ...product, storageRevision: 1 });
        result = { status: 'APPLIED', record: storedProduct(value) };
        return [...rows, domainJson(value)];
      });
      return result;
    },
    async replaceProduct(product, expected) {
      let result: ProductCommitResult = { status: 'NOT_FOUND' };
      await adapter.runTransaction<Partial<Product>>('products', rows => {
        const index = rows.findIndex(row => row.id === product.id);
        if (index < 0) return undefined;
        const current = storedProduct(normalize(rows[index]));
        if (current.version.revision !== expected.revision || current.version.token !== expected.token) {
          result = { status: 'CONFLICT', reason: 'VERSION' }; return undefined;
        }
        if (product.slug && rows.some(row => row.id !== product.id && row.slug === product.slug)) {
          result = { status: 'CONFLICT', reason: 'SLUG' }; return undefined;
        }
        const added = sourceKeys(product).filter(key => !sourceKeys(current.value).includes(key));
        if (rows.some(row => row.id !== product.id && sourceKeys(normalize(row)).some(key => added.includes(key)))) {
          result = { status: 'CONFLICT', reason: 'IDENTITY' }; return undefined;
        }
        const value = normalize({ ...product, storageRevision: expected.revision + 1 });
        result = { status: 'APPLIED', record: storedProduct(value) };
        const next = [...rows]; next[index] = domainJson(value); return next;
      });
      return result;
    },
    async getPriceHistory(query) {
      const limit = boundedDomainLimit(query.limit, CONFIG.limits.priceSnapshotsPerProduct);
      return (await adapter.readCollection<PriceSnapshot>('price-history')).filter(row => row.productId === query.productId
        && (!query.before || row.capturedAt < query.before.capturedAt || (row.capturedAt === query.before.capturedAt && row.id < query.before.id)))
        .sort(historyOrder).slice(-limit);
    },
    async appendPriceSnapshot(snapshot, options) {
      let result: Awaited<ReturnType<DomainStorage['appendPriceSnapshot']>> = { created: false };
      await adapter.runTransaction<PriceSnapshot>('price-history', rows => {
        const previous = rows.filter(row => row.productId === snapshot.productId).sort(historyOrder).at(-1);
        if (rows.some(row => row.id === snapshot.id)) return undefined;
        const elapsed = previous ? Date.parse(snapshot.capturedAt) - Date.parse(previous.capturedAt) : Infinity;
        if (previous?.sourceHash === snapshot.sourceHash && !(options.forceCheckpoint && elapsed >= options.checkpointHours * 3_600_000)) return undefined;
        result = { created: true, previous, snapshot };
        const cutoff = Date.parse(snapshot.capturedAt) - CONFIG.retention.priceHistoryDays * 86_400_000;
        const grouped = new Map<string, PriceSnapshot[]>();
        for (const row of [...rows, snapshot].filter(item => Date.parse(item.capturedAt) >= cutoff).sort(historyOrder)) {
          const group = grouped.get(row.productId) || []; group.push(row); grouped.set(row.productId, group);
        }
        return [...grouped.values()].flatMap(group => group.slice(-CONFIG.limits.priceSnapshotsPerProduct))
          .sort(historyOrder).slice(-CONFIG.limits.collectionRecords).map(domainJson);
      });
      return result;
    },
  };
}
