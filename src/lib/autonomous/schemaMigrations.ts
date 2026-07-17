import { createHash } from 'node:crypto';
import { getAutomationPolicy } from '@/lib/automation/policyRegistry';
import type { AutomationJobType, AutonomousMode } from '@/lib/automation/types';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import { createStorageSnapshot } from './backupManager';
import { runAutonomousSchemaBackfill, type BackfillResult } from './migrations';

export const PERSISTED_ENTITY_SCHEMA_VERSION = 2;
export const PERSISTED_ENTITY_MIGRATION_ID = 'prompt10-persisted-entities-v2';

type EntityName = 'automation-jobs' | 'automation-control' | 'automation-audit' | 'candidate-queue';

interface EntityCheckpoint {
  schemaVersion: number;
  id: string;
  entity: EntityName;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  inputChecksum: string;
  cursor: number;
  migrated: number;
  skipped: number;
  quarantined: number;
  failed: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedEntityBackfillResult {
  dryRun: boolean;
  completed: boolean;
  migrated: number;
  skipped: number;
  quarantined: number;
  failed: number;
  entities: Array<{ entity: EntityName; total: number; cursor: number; completed: boolean }>;
}

const CHECKPOINTS = 'autonomous-entity-migrations';
const ENTITIES: EntityName[] = ['automation-jobs', 'automation-control', 'automation-audit', 'candidate-queue'];
const MODES = new Set<AutonomousMode>(['OBSERVE', 'SHADOW', 'CANARY', 'AUTONOMOUS', 'EMERGENCY_STOP']);

function checksum(items: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(items.map((item, index) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return [index, record.id, record.updatedAt, record.schemaVersion];
  }))).digest('hex');
}

function migrateJob(record: Record<string, unknown>, now: string): { record: Record<string, unknown>; quarantined: boolean } {
  const type = String(record.type || '') as AutomationJobType;
  const policy = getAutomationPolicy(type);
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
  const status = String(record.status || 'BLOCKED');
  const shouldBlock = !terminal.has(status);
  const executionPlan = Array.isArray(record.executionPlan) ? record.executionPlan.map(item => {
    const step = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return { ...step, approvalRequired: policy.approvalMode === 'REQUIRED', expectedWrite: [...policy.writeScope], externalCall: policy.externalSideEffect, fallback: [...policy.fallbackPolicy] };
  }) : [];
  return {
    quarantined: shouldBlock,
    record: {
      ...record,
      schemaVersion: PERSISTED_ENTITY_SCHEMA_VERSION,
      policyVersion: policy.policyVersion,
      handlerVersion: policy.handlerVersion,
      botId: policy.botId,
      capability: policy.capability,
      maxAttempts: policy.retryPolicy.maxAttempts,
      executionPlan,
      status: shouldBlock ? 'BLOCKED' : status,
      lastErrorCode: shouldBlock ? 'SCHEMA_MIGRATION_REVIEW_REQUIRED' : record.lastErrorCode,
      lastErrorMessage: shouldBlock ? 'Legacy job was blocked during schema migration and was not executed.' : record.lastErrorMessage,
      completedAt: shouldBlock ? now : record.completedAt,
      updatedAt: now,
    },
  };
}

function migrateRecord(entity: EntityName, value: unknown, now: string): { record: Record<string, unknown>; quarantined: boolean } {
  if (!value || typeof value !== 'object') throw new Error('ENTITY_RECORD_INVALID');
  const record = value as Record<string, unknown>;
  if (entity === 'automation-jobs') return migrateJob(record, now);
  if (entity === 'automation-control') {
    const requestedMode = MODES.has(String(record.mode) as AutonomousMode) ? String(record.mode) as AutonomousMode : 'OBSERVE';
    const effectiveMode = requestedMode === 'EMERGENCY_STOP' ? 'OBSERVE' : requestedMode;
    return { quarantined: false, record: { ...record, schemaVersion: 2, id: 'automation-control', mode: requestedMode, effectiveMode, publishPaused: record.publishPaused === true, ingestionPaused: record.ingestionPaused === true, workerPaused: record.workerPaused === true, schedulerPaused: record.schedulerPaused !== false, killSwitch: record.killSwitch === true, timezone: 'Asia/Ho_Chi_Minh', updatedAt: now } };
  }
  if (entity === 'automation-audit') return { quarantined: false, record: { ...record, schemaVersion: 2 } };
  return { quarantined: false, record: { ...record, schemaVersion: 2, durableJobId: record.durableJobId, durableJobKey: record.durableJobKey } };
}

export async function runPersistedEntityBackfill(options: { dryRun?: boolean; limit?: number } = {}): Promise<PersistedEntityBackfillResult> {
  const dryRun = options.dryRun !== false;
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)));
  const checkpoints = await readCollection<EntityCheckpoint>(CHECKPOINTS);
  const result: PersistedEntityBackfillResult = { dryRun, completed: true, migrated: 0, skipped: 0, quarantined: 0, failed: 0, entities: [] };

  for (const entity of ENTITIES) {
    const raw = await readCollection<unknown>(entity);
    const inputChecksum = checksum(raw);
    const existing = checkpoints.find(item => item.id === `${PERSISTED_ENTITY_MIGRATION_ID}:${entity}`);
    const resumable = existing && ['RUNNING', 'FAILED'].includes(existing.status) && existing.inputChecksum === inputChecksum;
    const cursor = resumable ? existing.cursor : 0;
    const slice = raw.slice(cursor, cursor + limit);
    const replacements = new Map<number, Record<string, unknown>>();
    let migrated = 0; let skipped = 0; let quarantined = 0; let failed = 0;
    const now = new Date().toISOString();
    for (let offset = 0; offset < slice.length; offset += 1) {
      const value = slice[offset];
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      if (record.schemaVersion === PERSISTED_ENTITY_SCHEMA_VERSION) { skipped += 1; continue; }
      try {
        const next = migrateRecord(entity, value, now);
        replacements.set(cursor + offset, next.record);
        migrated += 1;
        if (next.quarantined) quarantined += 1;
      } catch { failed += 1; }
    }
    const nextCursor = cursor + slice.length;
    const completed = nextCursor >= raw.length;
    if (!dryRun) {
      await runTransaction<Record<string, unknown>>(entity, current => {
        for (const [index, replacement] of replacements) {
          const expected = raw[index] as Record<string, unknown> | undefined;
          if (index >= current.length || current[index]?.id !== expected?.id) throw new Error(`MIGRATION_SOURCE_CHANGED:${entity}:${index}`);
          current[index] = replacement;
        }
        return current;
      });
      const checkpoint: EntityCheckpoint = {
        schemaVersion: 1, id: `${PERSISTED_ENTITY_MIGRATION_ID}:${entity}`, entity,
        status: failed ? 'FAILED' : completed ? 'COMPLETED' : 'RUNNING', inputChecksum: checksum(await readCollection(entity)), cursor: nextCursor,
        migrated: (resumable ? existing?.migrated || 0 : 0) + migrated,
        skipped: (resumable ? existing?.skipped || 0 : 0) + skipped,
        quarantined: (resumable ? existing?.quarantined || 0 : 0) + quarantined,
        failed: (resumable ? existing?.failed || 0 : 0) + failed,
        lastError: failed ? 'ONE_OR_MORE_RECORDS_FAILED' : undefined,
        createdAt: resumable ? existing!.createdAt : now, updatedAt: now,
      };
      await runTransaction<EntityCheckpoint>(CHECKPOINTS, items => [...items.filter(item => item.id !== checkpoint.id), checkpoint]);
    }
    result.migrated += migrated; result.skipped += skipped; result.quarantined += quarantined; result.failed += failed;
    result.completed &&= completed && failed === 0;
    result.entities.push({ entity, total: raw.length, cursor: nextCursor, completed });
  }
  return result;
}

export async function runAllAutonomousBackfills(options: { dryRun?: boolean; limit?: number; createBackup?: boolean } = {}): Promise<{ products: BackfillResult; entities: PersistedEntityBackfillResult }> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.createBackup !== false) await createStorageSnapshot({ sourceDir: process.env.SANDEAL_DATA_DIR, reason: 'migration', retention: 30 });
  const products = await runAutonomousSchemaBackfill({ dryRun, limit: options.limit, createBackup: false });
  const entities = await runPersistedEntityBackfill({ dryRun, limit: options.limit });
  return { products, entities };
}
