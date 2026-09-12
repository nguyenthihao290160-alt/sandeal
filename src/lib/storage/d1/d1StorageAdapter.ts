import type { Product } from '../../types';
import type { PriceSnapshot } from '../../product-intelligence/types';
import { normalizeCanonicalProduct } from '../../canonicalProduct';
import type { StorageAdapter } from '../types';
import type { D1Binding } from '../runtimeStorage';
import { boundedDomainLimit, DomainStorageError, type DomainStorage, type ProductCommitResult, type StoredProduct } from '../domainStorage';
import { allProductIdentityKeys, queryIdentityKeys, productVersion } from '../productIdentity';
import { domainJson } from '../domainSerialization';
import { validateSettingsValue, type SettingsStore } from '../settingsStore';
import type { D1Database, D1Rows, D1Statement, SqlValue } from './database';

interface ProductRow { payload: string; revision: number; token: string; sequence: number }
type PayloadRow = { payload: string };
export interface D1QueryObservation {
  operation: string;
  rowsRead?: number;
  rowsWritten?: number;
}
const fields = 'payload,revision,token,sequence';
const credentialKey = /^(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|token|password|secret|cookie|authorization|private[_-]?key|credentials?)$/i;
export function safePayload(value: unknown, maximumBytes: number): string {
  const clean = domainJson(value);
  function inspect(item: unknown): void {
    if (Array.isArray(item)) { item.forEach(inspect); return; }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (credentialKey.test(key)) throw new DomainStorageError('D1_SECRET_FORBIDDEN');
        if (/^(?:rawData|rawPayload|rawResponse)$/i.test(key) && child != null) throw new DomainStorageError('D1_RAW_PAYLOAD_UNSUPPORTED');
        inspect(child);
      }
    } else if (typeof item === 'string') {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+\S+/i.test(item)) throw new DomainStorageError('D1_SECRET_FORBIDDEN');
      for (const candidate of item.match(/https?:\/\/[^\s]+/gi) || []) {
        let url: URL; try { url = new URL(candidate); } catch { continue; }
        if (url.username || url.password || [...url.searchParams.keys()].some(key => credentialKey.test(key))) throw new DomainStorageError('D1_SECRET_FORBIDDEN');
      }
    }
  }
  inspect(clean);
  const serialized = JSON.stringify(clean);
  if (new TextEncoder().encode(serialized).length > maximumBytes) throw new DomainStorageError('D1_PAYLOAD_LIMIT');
  return serialized;
}
function timestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new DomainStorageError('D1_TIMESTAMP_INVALID');
  return new Date(time).toISOString();
}
export function preparedProduct(product: Product, revision: number) {
  const value = domainJson(normalizeCanonicalProduct({ ...product, storageRevision: revision,
    createdAt: timestamp(product.createdAt), updatedAt: timestamp(product.updatedAt) }, product.updatedAt));
  if (!value.id || value.id.length > 160 || (value.offers?.length || 0) > 50) throw new DomainStorageError('D1_PRODUCT_LIMIT');
  const identities = allProductIdentityKeys(value).map(identity => ({ ...identity,
    kind: identity.namespace === 'SOURCE' ? JSON.parse(identity.key)[0] : 'alias' }));
  if (identities.length > 256 || identities.some(item => item.key.length > 4096)) throw new DomainStorageError('D1_IDENTITY_LIMIT');
  const payload = safePayload(value, 262_144);
  const version = productVersion(value);
  return { value, payload, version, identities: JSON.stringify(identities) };
}
function decodeProduct(row: ProductRow): StoredProduct {
  try {
    const value = normalizeCanonicalProduct(JSON.parse(row.payload));
    if (productVersion(value).token !== row.token || value.storageRevision !== row.revision) throw new Error();
    return { value, version: { revision: row.revision, token: row.token } };
  } catch { throw new DomainStorageError('D1_PRODUCT_CORRUPT'); }
}
function conflict(error: unknown): ProductCommitResult | undefined {
  // Inspect internally; never expose driver SQL, parameters, or raw exception text.
  const message = error instanceof Error ? error.message : '';
  if (/UNIQUE constraint failed: products\.slug/.test(message)) return { status: 'CONFLICT', reason: 'SLUG' };
  if (/UNIQUE constraint failed: (?:product_identities\.|products\.id)/.test(message)) return { status: 'CONFLICT', reason: 'IDENTITY' };
  return undefined;
}

export function createD1StorageAdapter(binding: D1Binding, observe?: (value: D1QueryObservation) => void): StorageAdapter {
  const db = binding as D1Database;
  function statement(sql: string, values: SqlValue[] = []): D1Statement { return db.prepare(sql).bind(...values); }
  function report(operation: string, result: D1Rows) {
    if (!result.success) throw new DomainStorageError('D1_OPERATION_FAILED');
    observe?.({ operation, rowsRead: result.meta?.rows_read, rowsWritten: result.meta?.rows_written });
  }
  async function query<T>(operation: string, sql: string, values: SqlValue[] = [], allowConflict = false): Promise<T[]> {
    try {
      const result = await statement(sql, values).all<T>(); report(operation, result as D1Rows); return result.results;
    } catch (error) {
      if (allowConflict && conflict(error)) throw error;
      if (error instanceof DomainStorageError) throw error;
      throw new DomainStorageError('D1_OPERATION_FAILED');
    }
  }
  async function getProduct(id: string): Promise<StoredProduct | null> {
    const [row] = await query<ProductRow>('product.id', `SELECT ${fields} FROM products WHERE id=? LIMIT 1`, [id]);
    return row ? decodeProduct(row) : null;
  }
  const domain: DomainStorage = {
    capabilities: { productLookup: true, conditionalProductWrite: true, boundedHistory: true, nativeIndexedQueries: true },
    getProduct,
    async getProductBySlug(slug) {
      const [row] = await query<ProductRow>('product.slug', `SELECT ${fields} FROM products WHERE slug=? LIMIT 1`, [slug]);
      return row ? decodeProduct(row) : null;
    },
    async findProductIdentity(identity) {
      const { namespace, keys } = queryIdentityKeys(identity);
      if (keys.length > 8) throw new DomainStorageError('D1_IDENTITY_QUERY_LIMIT');
      const matches = new Map<string, { id: string; product_sequence: number }>();
      for (const key of keys) {
        const rows = await query<{ product_id: string; product_sequence: number }>('product.identity',
          'SELECT product_id,product_sequence FROM product_identities WHERE namespace=? AND identity_key=? ORDER BY product_sequence LIMIT 2', [namespace, key]);
        for (const row of rows) matches.set(row.product_id, { id: row.product_id, product_sequence: row.product_sequence });
      }
      const selected = [...matches.values()].sort((a, b) => a.product_sequence - b.product_sequence).slice(0, 2);
      const rows = await Promise.all(selected.map(row => getProduct(row.id)));
      if (rows.some(row => row === null)) throw new DomainStorageError('D1_IDENTITY_INCONSISTENT');
      return rows as StoredProduct[];
    },
    async listProducts(options) {
      const limit = boundedDomainLimit(options.limit);
      const rows = await query<ProductRow>('product.page', `SELECT ${fields} FROM products WHERE id>?${options.status ? ' AND status=?' : ''} ORDER BY id LIMIT ?`,
        [options.afterId || '', ...(options.status ? [options.status] : []), limit]);
      return rows.map(decodeProduct);
    },
    async createProduct(product, identity) {
      const prepared = preparedProduct(product, 1);
      const requested = identity ? queryIdentityKeys(identity) : { namespace: 'SOURCE', keys: [] };
      if (requested.keys.length > 8) throw new DomainStorageError('D1_IDENTITY_QUERY_LIMIT');
      try {
        const [row] = await query<ProductRow>('product.create', `INSERT INTO products(id,slug,status,revision,token,created_at,updated_at,payload,identities)
          SELECT ?,?,?,1,?,?,?,?,? WHERE NOT EXISTS
          (SELECT 1 FROM product_identities WHERE namespace=? AND identity_key IN (SELECT value FROM json_each(?)) LIMIT 1)
          RETURNING ${fields}`, [prepared.value.id, prepared.value.slug || null, prepared.value.status, prepared.version.token,
          prepared.value.createdAt, prepared.value.updatedAt, prepared.payload, prepared.identities, requested.namespace, JSON.stringify(requested.keys)], true);
        return row ? { status: 'APPLIED', record: decodeProduct(row) } : { status: 'CONFLICT', reason: 'IDENTITY' };
      } catch (error) { const result = conflict(error); if (result) return result; throw error; }
    },
    async replaceProduct(product, expected) {
      if (!Number.isSafeInteger(expected.revision) || expected.revision < 1 || !/^[a-f0-9]{64}$/.test(expected.token)) return { status: 'CONFLICT', reason: 'VERSION' };
      const prepared = preparedProduct(product, expected.revision + 1);
      try {
        const [row] = await query<ProductRow>('product.conditional', `UPDATE products SET slug=?,status=?,revision=?,token=?,created_at=?,updated_at=?,payload=?,identities=?
          WHERE id=? AND revision=? AND token=? RETURNING ${fields}`, [prepared.value.slug || null, prepared.value.status, expected.revision + 1,
          prepared.version.token, prepared.value.createdAt, prepared.value.updatedAt, prepared.payload, prepared.identities, product.id, expected.revision, expected.token], true);
        if (row) return { status: 'APPLIED', record: decodeProduct(row) };
        return await getProduct(product.id) ? { status: 'CONFLICT', reason: 'VERSION' } : { status: 'NOT_FOUND' };
      } catch (error) { const result = conflict(error); if (result) return result; throw error; }
    },
    async getPriceHistory(options) {
      const limit = boundedDomainLimit(options.limit, 730);
      const rows = await query<PayloadRow>('history.range', `SELECT payload FROM price_history WHERE product_id=?
        ${options.before ? 'AND (captured_at,id)<(?,?)' : ''} ORDER BY captured_at DESC,id DESC LIMIT ?`,
        [options.productId, ...(options.before ? [timestamp(options.before.capturedAt), options.before.id] : []), limit]);
      return rows.reverse().map(row => JSON.parse(row.payload) as PriceSnapshot);
    },
    async appendPriceSnapshot(snapshot, options) {
      const value = { ...snapshot, capturedAt: timestamp(snapshot.capturedAt) };
      const payload = safePayload(value, 4096);
      try {
        const results = await db.batch<PayloadRow>([
          statement('SELECT payload FROM price_history WHERE product_id=? ORDER BY captured_at DESC,id DESC LIMIT 1', [value.productId]),
          statement(`INSERT INTO price_history(id,product_id,captured_at,source_hash,price,sale_price,operation_id,payload)
            SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM price_history WHERE id=? LIMIT 1)
            AND NOT EXISTS(SELECT 1 FROM (SELECT source_hash,captured_at FROM price_history WHERE product_id=? ORDER BY captured_at DESC,id DESC LIMIT 1)
              WHERE source_hash=? AND (?=0 OR (julianday(?)-julianday(captured_at))*24 < ?)) RETURNING payload`,
          [value.id, value.productId, value.capturedAt, value.sourceHash, value.price ?? null, value.salePrice ?? null, value.operationId, payload,
            value.id, value.productId, value.sourceHash, options.forceCheckpoint ? 1 : 0, value.capturedAt, options.checkpointHours]),
        ]);
        results.forEach(result => report('history.append.batch', result as D1Rows));
        if (!results[1].results.length) return { created: false };
        return { created: true, snapshot: value, previous: results[0].results[0] ? JSON.parse(results[0].results[0].payload) as PriceSnapshot : undefined };
      } catch { throw new DomainStorageError('D1_OPERATION_FAILED'); }
    },
    async appendProductAudit<T extends object>(kind: 'duplicate' | 'evidence' | 'publication', event: T, effectKey?: string) {
      const payload = safePayload(event, 16384);
      const value = event as { productId?: string; existingProductId?: string; timestamp?: string; createdAt?: string };
      const rows = await query<PayloadRow>('product.audit.append', `INSERT INTO product_audits(kind,effect_key,product_id,captured_at,payload)
        VALUES(?,?,?,?,?) ON CONFLICT(kind,effect_key) DO NOTHING RETURNING payload`,
        [kind, effectKey || null, value.productId || value.existingProductId || '', timestamp(value.timestamp || value.createdAt || new Date().toISOString()), payload]);
      if (rows.length) return { event: JSON.parse(rows[0].payload) as T, created: true };
      const [existing] = await query<PayloadRow>('product.audit.replay', 'SELECT payload FROM product_audits WHERE kind=? AND effect_key=? LIMIT 1', [kind, effectKey || null]);
      if (!existing) throw new DomainStorageError('D1_AUDIT_INCONSISTENT');
      return { event: JSON.parse(existing.payload) as T, created: false };
    },
  };
  const settingsStore: SettingsStore = {
    async read(key) {
      const [row] = await query<PayloadRow>('settings.read', 'SELECT payload FROM system_settings WHERE id=? LIMIT 1', [key]);
      if (!row) return null;
      const value: unknown = JSON.parse(row.payload); validateSettingsValue(key, value); return value;
    },
    async write(key, value) {
      validateSettingsValue(key, value);
      await query('settings.write', `INSERT INTO system_settings(id,updated_at,payload) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload WHERE system_settings.payload<>excluded.payload`,
        [key, new Date().toISOString(), safePayload(value, 65536)]);
    },
  };
  const unsupported = (): never => { throw new DomainStorageError('D1_COLLECTION_OPERATION_UNSUPPORTED'); };
  return {
    driver: 'd1', domain, settingsStore,
    capabilities: { schemaVersion: 1, driver: 'd1', transactions: false, atomicCollectionRevision: false,
      boundedBulkMutation: false, partialFailureReporting: false, nativeBulkWrite: false, maximumBulkItems: 0 },
    getDataDir: unsupported, ensureDataDir: unsupported, readCollection: unsupported, scanCollection: unsupported,
    readBoundedCollection: unsupported, readBoundedCollectionSnapshot: unsupported, readCollectionPage: unsupported,
    writeCollection: unsupported, runTransaction: unsupported, runStreamingTransaction: unsupported,
    async checkHealth() {
      const applied = await query('health', 'SELECT name FROM d1_migrations WHERE name=? LIMIT 1', ['0001_product_storage.sql']);
      if (!applied.length) throw new DomainStorageError('D1_SCHEMA_NOT_READY');
      return { driver: 'd1', configured: true, reachable: true, healthy: true, checkedAt: new Date().toISOString() };
    },
  };
}
