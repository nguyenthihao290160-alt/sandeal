import type { D1Binding } from '../runtimeStorage';
import type { D1Database } from './database';
import { createD1StorageAdapter, safePayload } from './d1StorageAdapter';
import { productIdentityKeys, productVersion } from '../productIdentity';
import { checksumJson } from '../migrationChecksum';
import { validateSettingsValue, type SettingsKey } from '../settingsStore';
import type { V6MigrationDomain, V6MigrationTarget } from '../v6MigrationEngine';
import { V6MigrationError } from '../v6MigrationEngine';
import type { Product } from '../../types';

/** Offline migration infrastructure only, never a business hot-query API. */
export function createD1MigrationTarget(binding: D1Binding, locality: 'LOCAL_TEST' | 'LOCAL_SHADOW'): V6MigrationTarget {
  if (!['LOCAL_TEST','LOCAL_SHADOW'].includes(locality)) throw new V6MigrationError('MIGRATION_LOCAL_TARGET_REQUIRED');
  const db = binding as D1Database;
  const adapter = createD1StorageAdapter(binding);
  const tables = { 'price-history': 'price_history', 'system-settings': 'system_settings' } as const;
  async function rows<T>(sql: string, values: Array<string | number | null> = []) {
    try {
      const result = await db.prepare(sql).bind(...values).all<T>();
      if (!result.success) throw new Error();
      return result.results;
    } catch { throw new V6MigrationError('MIGRATION_D1_FAILED'); }
  }
  async function read(domain: V6MigrationDomain, id: string): Promise<unknown | null> {
    if (domain === 'products') return (await adapter.domain!.getProduct(id))?.value ?? null;
    if (!(domain in tables)) throw new V6MigrationError('MIGRATION_DOMAIN_UNSUPPORTED');
    const [row] = await rows<{ payload: string }>(`SELECT payload FROM ${tables[domain]} WHERE id=? LIMIT 1`, [id]);
    return row ? JSON.parse(row.payload) : null;
  }
  function equal(domain: V6MigrationDomain, a: unknown, b: unknown) {
    return domain === 'products' ? productVersion(a as Product).token === productVersion(b as Product).token : checksumJson(a) === checksumJson(b);
  }
  return { locality, remote: false, production: false, read,
    async identityOwners(product) {
      const owners = new Set<string>();
      for (const key of productIdentityKeys(product)) {
        for (const row of await rows<{ product_id: string }>('SELECT product_id FROM product_identities WHERE namespace=? AND identity_key=? LIMIT 2', ['SOURCE', key])) owners.add(row.product_id);
      }
      if (product.slug) {
        const match = await adapter.domain!.getProductBySlug(product.slug); if (match) owners.add(match.value.id);
      }
      return [...owners];
    },
    async insert(domain, id, value) {
      const existing = await read(domain, id);
      if (existing !== null) {
        if (!equal(domain, value, existing)) throw new V6MigrationError('MIGRATION_DESTINATION_CONFLICT');
        return 'NO_OP';
      }
      let applied: boolean;
      if (domain === 'products') {
        applied = (await adapter.domain!.createProduct(value as Product)).status === 'APPLIED';
      } else if (domain === 'price-history') {
        const price = value as Record<string, string | number | null>;
        // Migration preserves every validated source snapshot; live ingest's
        // adjacent-price suppression must not discard historical observations.
        applied = (await rows(`INSERT INTO price_history(id,product_id,captured_at,source_hash,price,sale_price,operation_id,payload)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`,
        [id, price.productId, price.capturedAt, price.sourceHash, price.price ?? null, price.salePrice ?? null, price.operationId, safePayload(value, 4096)])).length === 1;
      } else if (domain === 'system-settings') {
        validateSettingsValue(id as SettingsKey, value);
        applied = (await rows('INSERT INTO system_settings(id,updated_at,payload) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id',
          [id, new Date().toISOString(), safePayload(value, 65536)])).length === 1;
      } else throw new V6MigrationError('MIGRATION_DOMAIN_UNSUPPORTED');
      const stored = await read(domain, id);
      if (stored === null || !equal(domain, value, stored)) throw new V6MigrationError('MIGRATION_DESTINATION_CONFLICT');
      return applied ? 'APPLIED' : 'NO_OP';
    },
    async counts() {
      const result = { products: 0, 'price-history': 0, 'system-settings': 0 };
      for (const [domain, table] of Object.entries({ products: 'products', ...tables })) {
        // Explicit offline verification; not available through DomainStorage.
        result[domain as V6MigrationDomain] = (await rows<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))[0].count;
      }
      return result;
    },
  };
}
