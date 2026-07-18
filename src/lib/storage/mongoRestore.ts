import { checksumCollection } from './migrationChecksum';
import { assertIsolatedDatabase } from './migrationExecutor';
import type { MongoLogicalBackup } from './mongoLogicalBackup';
import { verifyMongoLogicalBackup } from './mongoLogicalBackup';

export type MongoRestoreMode = 'dry-run' | 'apply-isolated';

export interface MongoRestoreTarget {
  readonly database: string;
  inspectCollection(collection: string): Promise<{ exists: boolean; count: number }>;
  readCollection(collection: string): Promise<unknown[]>;
  /** Implementations must make an already-seen batchKey a successful no-op. */
  writeBatch(input: {
    restoreId: string;
    collection: string;
    batchKey: string;
    startIndex: number;
    items: unknown[];
  }): Promise<'written' | 'already_applied'>;
}

export type MongoRestoreErrorCode =
  | 'MONGO_RESTORE_MODE_INVALID'
  | 'MONGO_RESTORE_FLAG_REQUIRED'
  | 'MONGO_RESTORE_ID_INVALID'
  | 'MONGO_RESTORE_TARGET_NOT_EMPTY'
  | 'MONGO_RESTORE_BATCH_FAILED'
  | 'MONGO_RESTORE_VERIFY_FAILED'
  | 'MONGO_RESTORE_BATCH_SIZE_INVALID';

const SAFE_MESSAGES: Record<MongoRestoreErrorCode, string> = {
  MONGO_RESTORE_MODE_INVALID: 'Mongo restore mode is invalid.',
  MONGO_RESTORE_FLAG_REQUIRED: 'Mongo restore requires an explicit isolated-write flag.',
  MONGO_RESTORE_ID_INVALID: 'Mongo restore identifier is invalid.',
  MONGO_RESTORE_TARGET_NOT_EMPTY: 'Mongo restore target collection is not empty.',
  MONGO_RESTORE_BATCH_FAILED: 'Mongo restore batch failed.',
  MONGO_RESTORE_VERIFY_FAILED: 'Mongo restore verification failed.',
  MONGO_RESTORE_BATCH_SIZE_INVALID: 'Mongo restore batch size is invalid.',
};

export class MongoRestoreError extends Error {
  readonly code: MongoRestoreErrorCode;

  constructor(code: MongoRestoreErrorCode, options: { cause?: unknown } = {}) {
    super(SAFE_MESSAGES[code], options);
    this.name = 'MongoRestoreError';
    this.code = code;
  }
}

export interface MongoRestoreOptions {
  readonly mode: MongoRestoreMode;
  readonly backup: MongoLogicalBackup;
  readonly target: MongoRestoreTarget;
  readonly restoreId: string;
  readonly allowIsolatedWrite?: boolean;
  readonly batchSize?: number;
}

export interface MongoRestoreSummary {
  readonly mode: MongoRestoreMode;
  readonly restoreId: string;
  readonly targetDatabase: string;
  readonly success: boolean;
  readonly writesPerformed: number;
  readonly collections: ReadonlyArray<{
    collection: string;
    expectedCount: number;
    expectedChecksum: string;
    status: 'PLANNED' | 'RESTORED' | 'SKIPPED_ABSENT';
  }>;
}

function safeRestoreId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new MongoRestoreError('MONGO_RESTORE_ID_INVALID');
  return value;
}

export async function restoreMongoLogicalBackup(options: MongoRestoreOptions): Promise<MongoRestoreSummary> {
  if (options.mode !== 'dry-run' && options.mode !== 'apply-isolated') {
    throw new MongoRestoreError('MONGO_RESTORE_MODE_INVALID');
  }
  const backup = verifyMongoLogicalBackup(options.backup);
  const restoreId = safeRestoreId(options.restoreId);
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new MongoRestoreError('MONGO_RESTORE_BATCH_SIZE_INVALID');
  }
  assertIsolatedDatabase(options.target.database);
  const restorable = backup.collections.filter(collection => collection.existed);

  for (const collection of restorable) {
    const state = await options.target.inspectCollection(collection.logicalName);
    if (state.count !== 0) throw new MongoRestoreError('MONGO_RESTORE_TARGET_NOT_EMPTY');
  }

  if (options.mode === 'dry-run') {
    return {
      mode: options.mode,
      restoreId,
      targetDatabase: options.target.database,
      success: true,
      writesPerformed: 0,
      collections: backup.collections.map(collection => ({
        collection: collection.logicalName,
        expectedCount: collection.recordCount,
        expectedChecksum: collection.checksum,
        status: collection.existed ? 'PLANNED' : 'SKIPPED_ABSENT',
      })),
    };
  }

  if (!options.allowIsolatedWrite) throw new MongoRestoreError('MONGO_RESTORE_FLAG_REQUIRED');
  let writesPerformed = 0;
  const summaries: MongoRestoreSummary['collections'][number][] = [];
  for (const collection of backup.collections) {
    if (!collection.existed) {
      summaries.push({
        collection: collection.logicalName,
        expectedCount: collection.recordCount,
        expectedChecksum: collection.checksum,
        status: 'SKIPPED_ABSENT',
      });
      continue;
    }
    for (let startIndex = 0; startIndex < collection.records.length; startIndex += batchSize) {
      const endIndex = Math.min(startIndex + batchSize, collection.records.length);
      try {
        const result = await options.target.writeBatch({
          restoreId,
          collection: collection.logicalName,
          batchKey: `${restoreId}:${collection.logicalName}:${startIndex}:${endIndex}:${collection.checksum}`,
          startIndex,
          items: collection.records.slice(startIndex, endIndex),
        });
        if (result === 'written') writesPerformed += 1;
      } catch (error) {
        throw new MongoRestoreError('MONGO_RESTORE_BATCH_FAILED', { cause: error });
      }
    }
    const restored = await options.target.readCollection(collection.logicalName);
    if (restored.length !== collection.recordCount || checksumCollection(restored) !== collection.checksum) {
      throw new MongoRestoreError('MONGO_RESTORE_VERIFY_FAILED');
    }
    summaries.push({
      collection: collection.logicalName,
      expectedCount: collection.recordCount,
      expectedChecksum: collection.checksum,
      status: 'RESTORED',
    });
  }
  return {
    mode: options.mode,
    restoreId,
    targetDatabase: options.target.database,
    success: true,
    writesPerformed,
    collections: summaries,
  };
}
