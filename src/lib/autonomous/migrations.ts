import { createHash } from 'node:crypto';
import { normalizeCanonicalProduct } from '@/lib/canonicalProduct';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { Product } from '@/lib/types';
import { createStorageSnapshot } from './backupManager';

const MIGRATION_COLLECTION = 'autonomous-migrations';
const PRODUCT_COLLECTION = 'products';
export const AUTONOMOUS_SCHEMA_VERSION = 2;
export const AUTONOMOUS_MIGRATION_ID = 'prompt10-autonomous-schema-v2';

export interface MigrationCheckpoint {
  schemaVersion: number;
  id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  cursor: number;
  inputChecksum: string;
  migrated: number;
  skipped: number;
  quarantined: number;
  failed: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackfillResult {
  migrationId: string;
  dryRun: boolean;
  completed: boolean;
  checkpoint: number;
  total: number;
  migrated: number;
  skipped: number;
  quarantined: number;
  failed: number;
}

function checksum(items: Array<Partial<Product>>): string {
  return createHash('sha256').update(JSON.stringify(items.map(item => ({ id: item.id, updatedAt: item.updatedAt, schemaVersion: item.schemaVersion })))).digest('hex');
}

export async function runAutonomousSchemaBackfill(options: { dryRun?: boolean; limit?: number; createBackup?: boolean } = {}): Promise<BackfillResult> {
  const dryRun = options.dryRun !== false;
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)));
  const raw = await readCollection<Partial<Product>>(PRODUCT_COLLECTION);
  const existing = (await readCollection<MigrationCheckpoint>(MIGRATION_COLLECTION)).find(item => item.id === AUTONOMOUS_MIGRATION_ID);
  const inputChecksum = checksum(raw);
  const cursor = existing && ['RUNNING', 'FAILED'].includes(existing.status) && existing.inputChecksum === inputChecksum ? existing.cursor : 0;
  const slice = raw.slice(cursor, cursor + limit);
  if (!dryRun && options.createBackup !== false && slice.some(item => item.schemaVersion !== AUTONOMOUS_SCHEMA_VERSION || !item.lifecycleState || !item.recordType)) {
    await createStorageSnapshot({ sourceDir: process.env.SANDEAL_DATA_DIR, reason: 'migration', retention: 30 });
  }
  const now = new Date().toISOString();
  let migrated = 0;
  let skipped = 0;
  let quarantined = 0;
  let failed = 0;

  const replacements = new Map<number, Product>();
  let processed = 0;
  for (let offset = 0; offset < slice.length; offset += 1) {
    const item = slice[offset];
    try {
      if (item.schemaVersion === AUTONOMOUS_SCHEMA_VERSION && item.lifecycleState && item.recordType) {
        skipped += 1;
        processed += 1;
        continue;
      }
      const wasPublic = item.status === 'published' && item.publicHidden === false;
      const normalized = normalizeCanonicalProduct(item, now);
      if (!String(normalized.id || '').trim() || !String(normalized.title || '').trim()) {
        normalized.lifecycleState = 'QUARANTINED';
        normalized.quarantineReasons = [...new Set([...(normalized.quarantineReasons || []), 'migration_invalid_identity'])];
        normalized.status = 'needs_review';
        normalized.publicHidden = true;
        quarantined += 1;
      }
      if (!wasPublic && normalized.status === 'published') throw new Error('BACKFILL_MUST_NOT_PUBLISH');
      replacements.set(cursor + offset, normalized);
      migrated += 1;
      processed += 1;
    } catch {
      failed += 1;
      break;
    }
  }

  const nextCursor = cursor + processed;
  const completed = nextCursor >= raw.length;
  if (!dryRun) {
    await runTransaction<Partial<Product>>(PRODUCT_COLLECTION, current => {
      for (const [index, product] of replacements) {
        if (index >= current.length || current[index]?.id !== raw[index]?.id) throw new Error(`MIGRATION_SOURCE_CHANGED:${index}`);
        current[index] = product;
      }
      return current;
    });
    const checkpoint: MigrationCheckpoint = {
      schemaVersion: 1,
      id: AUTONOMOUS_MIGRATION_ID,
      status: failed ? 'FAILED' : completed ? 'COMPLETED' : 'RUNNING',
      cursor: nextCursor,
      inputChecksum: checksum(await readCollection<Partial<Product>>(PRODUCT_COLLECTION)),
      migrated: (existing?.migrated || 0) + migrated,
      skipped: (existing?.skipped || 0) + skipped,
      quarantined: (existing?.quarantined || 0) + quarantined,
      failed: (existing?.failed || 0) + failed,
      lastError: failed ? 'ONE_OR_MORE_RECORDS_FAILED' : undefined,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await runTransaction<MigrationCheckpoint>(MIGRATION_COLLECTION, items => [...items.filter(item => item.id !== checkpoint.id), checkpoint]);
  }

  return { migrationId: AUTONOMOUS_MIGRATION_ID, dryRun, completed, checkpoint: nextCursor, total: raw.length, migrated, skipped, quarantined, failed };
}
