import { checksumJson } from './migrationChecksum';
import { domainJson } from './domainSerialization';
import { productIdentityKeys, productVersion } from './productIdentity';
import { preparedProduct, safePayload } from './d1/d1StorageAdapter';
import { validateSettingsValue, type SettingsKey } from './settingsStore';
import type { Product } from '../types';
import type { MigrationInput, V6MigrationSource } from './v6MigrationSources';

export type V6MigrationClass = 'MIGRATABLE' | 'DUPLICATE_EQUIVALENT' | 'SKIP_STALE' | 'QUARANTINE_MALFORMED' | 'QUARANTINE_CONFLICT' | 'UNSUPPORTED';
export type V6MigrationDomain = 'products' | 'price-history' | 'system-settings';
export class V6MigrationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'V6MigrationError'; }
}
export interface V6MigrationTarget {
  readonly locality: 'LOCAL_TEST' | 'LOCAL_SHADOW';
  readonly remote: false;
  readonly production: false;
  read(domain: V6MigrationDomain, id: string): Promise<unknown | null>;
  identityOwners(product: Product): Promise<string[]>;
  insert(domain: V6MigrationDomain, id: string, value: unknown): Promise<'APPLIED' | 'NO_OP'>;
  counts(): Promise<Record<V6MigrationDomain, number>>;
}
export interface V6PlanRow {
  ordinal: number; domain: string; classification: V6MigrationClass;
  targetId: string | null; checksum: string | null; countUnknown: boolean;
}
export interface V6MigrationPlan {
  version: 1; sourceDriver: 'file' | 'mongo'; sourceFingerprint: string;
  planFingerprint: string; batchSize: number; staleHistoryBefore: string | null;
  rows: V6PlanRow[]; safeToApply: boolean;
}
export interface V6MigrationCheckpoint {
  migrationId: string; sourceFingerprint: string; planFingerprint: string;
  domain: string; lastBatch: number; rowsAttempted: number; rowsApplied: number;
  rowsSkipped: number; errors: number; status: 'RUNNING' | 'FAILED' | 'COMPLETED';
}
export interface V6CheckpointStore {
  read(): Promise<V6MigrationCheckpoint | null>;
  write(value: V6MigrationCheckpoint): Promise<void>;
}
const domains = new Set(['products', 'price-history', 'system-settings']);
const fail = (code: string): never => { throw new V6MigrationError(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('MIGRATION_RECORD_INVALID');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\x00-\x1f]/.test(value)) return fail('MIGRATION_ID_INVALID');
  return value;
}
function iso(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fail('MIGRATION_TIMESTAMP_INVALID');
  return new Date(value).toISOString();
}
function prepare(input: MigrationInput): { value: unknown; id: string; checksum: string; keys: string[] } {
  const raw = object(input.value);
  if (input.malformed) fail('MIGRATION_RECORD_INVALID');
  if (input.domain === 'products') {
    if (typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.source !== 'string'
      || !['draft','needs_review','approved','published','archived'].includes(String(raw.status))) fail('MIGRATION_PRODUCT_INVALID');
    const sourceKeys = productIdentityKeys(raw as unknown as Product);
    const targetId = raw.id ? id(raw.id) : sourceKeys.length ? `migrated-${checksumJson(sourceKeys).slice(0,40)}` : fail('MIGRATION_ID_REQUIRED');
    const value = preparedProduct({ ...raw, id: targetId, createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) } as unknown as Product, 1).value;
    // Canonical defaults may be added, but migration must not repair safety state.
    for (const field of ['status','publicHidden','publicBlocked','needsVerification','autoPublished','lifecycleState','affiliateUrl'] as const) {
      if (raw[field] !== undefined && checksumJson(raw[field]) !== checksumJson(value[field] ?? null)) fail('MIGRATION_SAFETY_STATE_CHANGE');
    }
    for (const amount of [value.price, value.salePrice]) if (amount != null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) fail('MIGRATION_PRICE_INVALID');
    if (value.slug.length > 160) fail('MIGRATION_SLUG_INVALID');
    const offers = new Set<string>();
    for (const offer of value.offers || []) {
      if (!offer.id || offer.id.length > 240 || offers.has(offer.id) || typeof offer.source !== 'string' || typeof offer.merchant !== 'string'
        || typeof offer.affiliateUrl !== 'string' || offer.affiliateUrl.length > 4096 || !['HEALTHY','DEGRADED','BROKEN','UNKNOWN'].includes(offer.health)) fail('MIGRATION_OFFER_INVALID');
      for (const amount of [offer.price, offer.originalPrice]) if (amount != null && (!Number.isFinite(amount) || amount < 0)) fail('MIGRATION_OFFER_INVALID');
      iso(offer.observedAt); safePayload(offer, 16384); offers.add(offer.id);
    }
    return { value, id: targetId, checksum: productVersion(value).token, keys: productIdentityKeys(value) };
  }
  if (input.domain === 'price-history') {
    const value = { ...raw, id: raw.id || `price-${checksumJson(raw).slice(0,40)}`, capturedAt: iso(raw.capturedAt) };
    const targetId = id(value.id); id(raw.productId);
    if (raw.currency !== 'VND' || !['available','unavailable','unknown'].includes(String(raw.availability))
      || typeof raw.source !== 'string' || typeof raw.sourceHash !== 'string' || !raw.sourceHash || raw.sourceHash.length > 128
      || typeof raw.operationId !== 'string' || raw.operationId.length > 160) fail('MIGRATION_HISTORY_INVALID');
    for (const price of [raw.price, raw.salePrice]) if (price != null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) fail('MIGRATION_HISTORY_INVALID');
    safePayload(value, 4096); return { value, id: targetId, checksum: checksumJson(value), keys: [] };
  }
  const targetId = id(raw.id); validateSettingsValue(targetId as SettingsKey, raw.value);
  safePayload(raw.value, 65536);
  return { value: domainJson(raw.value), id: targetId, checksum: checksumJson(domainJson(raw.value)), keys: [] };
}
function truth(domain: string, value: unknown): string {
  return domain === 'products' ? productVersion(value as Product).token : checksumJson(value);
}
async function snapshot(source: V6MigrationSource) {
  const records: MigrationInput[] = []; let bytes = 0;
  try {
    await source.scan(async input => {
      const record = domainJson(input);
      bytes += Buffer.byteLength(JSON.stringify(record));
      if (records.length >= 10000 || bytes > 32 * 1024 * 1024) fail('MIGRATION_SNAPSHOT_LIMIT');
      records.push(record);
    });
  } catch (error) { if (error instanceof V6MigrationError) throw error; fail('MIGRATION_SOURCE_READ_FAILED'); }
  return { records, fingerprint: checksumJson({ driver: source.driver, records }) };
}
function planDigest(plan: Omit<V6MigrationPlan, 'planFingerprint'> | V6MigrationPlan) {
  const { planFingerprint: _ignored, ...value } = plan as V6MigrationPlan;
  void _ignored; return checksumJson(value);
}
function assertLocal(target: V6MigrationTarget) {
  if (!target || !['LOCAL_TEST','LOCAL_SHADOW'].includes(target.locality) || target.remote !== false || target.production !== false) fail('MIGRATION_LOCAL_TARGET_REQUIRED');
}
export async function planV6Migration(source: V6MigrationSource, target?: V6MigrationTarget, options: { batchSize?: number; staleHistoryBefore?: string } = {}): Promise<V6MigrationPlan> {
  if (target) assertLocal(target);
  const batchSize = options.batchSize ?? 25;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) fail('MIGRATION_BATCH_SIZE_INVALID');
  const staleHistoryBefore = options.staleHistoryBefore ? iso(options.staleHistoryBefore) : null;
  const captured = await snapshot(source); const rows: V6PlanRow[] = [];
  const prepared = new Map<number, ReturnType<typeof prepare>>();
  for (const [ordinal, input] of captured.records.entries()) {
    const row: V6PlanRow = { ordinal, domain: input.domain, classification: 'MIGRATABLE', targetId: null, checksum: null, countUnknown: input.countUnknown === true }; rows.push(row);
    if (!domains.has(input.domain)) { row.classification = 'UNSUPPORTED'; continue; }
    try {
      const candidate = prepare(input); prepared.set(ordinal, candidate); row.targetId = candidate.id; row.checksum = candidate.checksum;
      if (input.domain === 'price-history' && staleHistoryBefore && String(object(candidate.value).capturedAt) < staleHistoryBefore) row.classification = 'SKIP_STALE';
    } catch { row.classification = 'QUARANTINE_MALFORMED'; }
  }
  const owners = new Map<string, number[]>();
  for (const row of rows) {
    const candidate = prepared.get(row.ordinal); if (!candidate || row.classification !== 'MIGRATABLE') continue;
    const keys = [`${row.domain}:id:${candidate.id}`, ...(row.domain === 'products' ? candidate.keys.map(key => `identity:${key}`) : [])];
    if (row.domain === 'products' && object(candidate.value).slug) keys.push(`slug:${object(candidate.value).slug}`);
    for (const key of keys) owners.set(key, [...(owners.get(key) || []), row.ordinal]);
  }
  for (const group of owners.values()) if (group.length > 1) {
    const first = rows[group[0]];
    const equivalent = group.every(index => rows[index].targetId === first.targetId && rows[index].checksum === first.checksum);
    for (const index of group) {
      if (!equivalent) rows[index].classification = 'QUARANTINE_CONFLICT';
      else if (index !== group[0] && rows[index].classification !== 'QUARANTINE_CONFLICT') rows[index].classification = 'DUPLICATE_EQUIVALENT';
    }
  }
  for (const row of rows) {
    if (row.classification !== 'MIGRATABLE') continue;
    const candidate = prepared.get(row.ordinal)!;
    if (target) {
      const existing = await target.read(row.domain as V6MigrationDomain, candidate.id);
      if (existing !== null && truth(row.domain, existing) !== candidate.checksum) row.classification = 'QUARANTINE_CONFLICT';
      if (row.domain === 'products' && (await target.identityOwners(candidate.value as Product)).some(owner => owner !== candidate.id)) row.classification = 'QUARANTINE_CONFLICT';
    }
    if (row.domain === 'price-history') {
      const productId = String(object(candidate.value).productId);
      const parent = rows.find(item => item.domain === 'products' && item.targetId === productId && item.classification === 'MIGRATABLE');
      if (!parent && (!target || await target.read('products', productId) === null)) row.classification = 'QUARANTINE_CONFLICT';
    }
  }
  const value: Omit<V6MigrationPlan, 'planFingerprint'> = { version: 1, sourceDriver: source.driver, sourceFingerprint: captured.fingerprint,
    batchSize, staleHistoryBefore, rows, safeToApply: Boolean(target) && !rows.some(row => row.classification.startsWith('QUARANTINE')) };
  return { ...value, planFingerprint: planDigest(value) };
}
export function summarizeV6Plan(plan: V6MigrationPlan) {
  const counts: Record<string, Record<string, number | string>> = Object.create(null);
  for (const row of plan.rows) {
    const summary = counts[row.domain] ||= { SOURCE_RECORDS: 0, VALID: 0, DUPLICATE: 0, MALFORMED: 0, CONFLICT: 0, STALE: 0, UNSUPPORTED: 0 };
    summary.SOURCE_RECORDS = row.countUnknown ? 'UNKNOWN_NOT_READ' : Number(summary.SOURCE_RECORDS) + 1;
    const key = ({ MIGRATABLE:'VALID', DUPLICATE_EQUIVALENT:'DUPLICATE', QUARANTINE_MALFORMED:'MALFORMED', QUARANTINE_CONFLICT:'CONFLICT', SKIP_STALE:'STALE', UNSUPPORTED:'UNSUPPORTED' })[row.classification];
    summary[key] = Number(summary[key]) + 1;
  }
  const planned = plan.rows.filter(row => row.classification === 'MIGRATABLE').length;
  return { SOURCE_FINGERPRINT: plan.sourceFingerprint, PLAN_FINGERPRINT: plan.planFingerprint, ROWS_READ: plan.rows.length,
    ROWS_PLANNED: planned, ROWS_SKIPPED: plan.rows.length - planned, CONFLICTS: plan.rows.filter(row => row.classification === 'QUARANTINE_CONFLICT').length,
    ESTIMATED_DOMAIN_INSERTS_UPPER_BOUND: planned,
    ESTIMATED_D1_WRITES: plan.rows.filter(row => row.classification === 'MIGRATABLE').reduce((sum,row) => sum + (row.domain === 'products' ? 307 : 1), 0),
    SAFE_TO_APPLY: plan.safeToApply ? 'YES' : 'NO', domains: counts };
}
export async function applyV6Migration(source: V6MigrationSource, target: V6MigrationTarget, plan: V6MigrationPlan, store: V6CheckpointStore,
  options: { apply?: boolean; afterCommit?: () => void; beforeCheckpoint?: () => void; afterBatch?: () => void } = {}) {
  if (options.apply !== true) fail('MIGRATION_EXPLICIT_APPLY_REQUIRED');
  assertLocal(target); if (!source.shadow) fail('MIGRATION_SHADOW_SOURCE_REQUIRED');
  if (!plan.safeToApply || plan.planFingerprint !== planDigest(plan)) fail('MIGRATION_PLAN_UNSAFE');
  const captured = await snapshot(source);
  if (captured.fingerprint !== plan.sourceFingerprint) fail('MIGRATION_SOURCE_CHANGED');
  const selected = plan.rows.filter(row => row.classification === 'MIGRATABLE').sort((a,b) => ['products','price-history','system-settings'].indexOf(a.domain) - ['products','price-history','system-settings'].indexOf(b.domain) || a.ordinal - b.ordinal);
  // Immutable bounded capture is used after re-fingerprinting, never a second live source read.
  for (const row of selected) {
    const candidate = prepare(captured.records[row.ordinal]);
    if (candidate.id !== row.targetId || candidate.checksum !== row.checksum) fail('MIGRATION_PLAN_UNSAFE');
    const existing = await target.read(row.domain as V6MigrationDomain, candidate.id);
    if (existing !== null && truth(row.domain, existing) !== candidate.checksum) fail('MIGRATION_DESTINATION_CONFLICT');
    if (row.domain === 'products' && (await target.identityOwners(candidate.value as Product)).some(owner => owner !== candidate.id)) fail('MIGRATION_DESTINATION_CONFLICT');
  }
  const previous = await store.read();
  if (previous && (previous.planFingerprint !== plan.planFingerprint || previous.sourceFingerprint !== plan.sourceFingerprint)) fail('MIGRATION_CHECKPOINT_CONFLICT');
  const checkpoint: V6MigrationCheckpoint = { migrationId: `v6-${plan.planFingerprint.slice(0,32)}`, sourceFingerprint: plan.sourceFingerprint,
    planFingerprint: plan.planFingerprint, domain: '', lastBatch: 0, rowsAttempted: 0, rowsApplied: 0, rowsSkipped: plan.rows.length - selected.length, errors: 0, status: 'RUNNING' };
  try {
    for (let start = 0; start < selected.length; start += plan.batchSize) {
      for (const row of selected.slice(start, start + plan.batchSize)) {
        const candidate = prepare(captured.records[row.ordinal]); checkpoint.domain = row.domain; checkpoint.rowsAttempted++;
        const result = await target.insert(row.domain as V6MigrationDomain, candidate.id, candidate.value);
        if (result === 'APPLIED') checkpoint.rowsApplied++; else checkpoint.rowsSkipped++;
        options.afterCommit?.();
      }
      checkpoint.lastBatch++; options.beforeCheckpoint?.(); await store.write({ ...checkpoint }); options.afterBatch?.();
    }
    checkpoint.status = 'COMPLETED'; await store.write({ ...checkpoint });
    return checkpoint;
  } catch {
    checkpoint.status = 'FAILED'; checkpoint.errors++;
    try { await store.write({ ...checkpoint }); }
    catch { fail('MIGRATION_CHECKPOINT_WRITE_FAILED'); }
    fail('MIGRATION_APPLY_FAILED');
  }
}
export async function verifyV6Migration(source: V6MigrationSource, target: V6MigrationTarget, plan: V6MigrationPlan) {
  assertLocal(target);
  const captured = await snapshot(source);
  if (captured.fingerprint !== plan.sourceFingerprint || plan.planFingerprint !== planDigest(plan)) fail('MIGRATION_SOURCE_CHANGED');
  let matched = 0, missing = 0, conflicts = 0;
  const expected = { products: 0, 'price-history': 0, 'system-settings': 0 };
  const present = { products: 0, 'price-history': 0, 'system-settings': 0 };
  for (const row of plan.rows.filter(row => row.classification === 'MIGRATABLE')) {
    expected[row.domain as V6MigrationDomain]++;
    const value = await target.read(row.domain as V6MigrationDomain, row.targetId!);
    if (value === null) missing++;
    else { present[row.domain as V6MigrationDomain]++; if (truth(row.domain, value) !== row.checksum) conflicts++; else matched++; }
  }
  const actual = await target.counts();
  const extra = Object.keys(expected).reduce((sum,key) => sum + Math.max(0, actual[key as V6MigrationDomain] - present[key as V6MigrationDomain]), 0);
  return { SOURCE_VALID: Object.values(expected).reduce((a,b)=>a+b,0), DESTINATION_VALID: Object.values(actual).reduce((a,b)=>a+b,0), MATCHED: matched, MISSING: missing, EXTRA: extra, CONFLICTS: conflicts,
    RESULT: missing || extra || conflicts ? 'FAIL' : 'PASS' };
}
