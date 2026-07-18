import { checksumCollection, normalizeDomainCollection } from './migrationChecksum';
import type { MigrationManifest, MigrationManifestCollection } from './migrationManifest';
import { validateMigrationManifest } from './migrationManifest';

export type MigrationExecutionMode = 'plan' | 'dry-run' | 'apply-isolated';
export type MigrationCheckpointStatus = 'PLANNED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export type MigrationExecutionErrorCode =
  | 'MIGRATION_MODE_INVALID'
  | 'MIGRATION_MANIFEST_UNSAFE'
  | 'MIGRATION_ISOLATED_WRITE_FLAG_REQUIRED'
  | 'MIGRATION_DATABASE_FORBIDDEN'
  | 'MIGRATION_DATABASE_NOT_ISOLATED'
  | 'MIGRATION_DATABASE_MISMATCH'
  | 'MIGRATION_ID_INVALID'
  | 'MIGRATION_SOURCE_MISSING'
  | 'MIGRATION_SOURCE_COUNT_MISMATCH'
  | 'MIGRATION_SOURCE_CHECKSUM_MISMATCH'
  | 'MIGRATION_MANIFEST_CHECKSUM_MISMATCH'
  | 'MIGRATION_TARGET_NOT_EMPTY'
  | 'MIGRATION_TARGET_OWNERSHIP_MISMATCH'
  | 'MIGRATION_CHECKPOINT_CONFLICT'
  | 'MIGRATION_ALREADY_RUNNING'
  | 'MIGRATION_BATCH_FAILED'
  | 'MIGRATION_VERIFY_FAILED';

const SAFE_MESSAGES: Record<MigrationExecutionErrorCode, string> = {
  MIGRATION_MODE_INVALID: 'Migration execution mode is invalid.',
  MIGRATION_MANIFEST_UNSAFE: 'Migration manifest is not safe to apply.',
  MIGRATION_ISOLATED_WRITE_FLAG_REQUIRED: 'Isolated migration write requires an explicit allow flag.',
  MIGRATION_DATABASE_FORBIDDEN: 'Migration target database is forbidden.',
  MIGRATION_DATABASE_NOT_ISOLATED: 'Migration target database is not an isolated database.',
  MIGRATION_DATABASE_MISMATCH: 'Migration manifest and target database do not match.',
  MIGRATION_ID_INVALID: 'Migration identifier is invalid.',
  MIGRATION_SOURCE_MISSING: 'Migration source collection is missing.',
  MIGRATION_SOURCE_COUNT_MISMATCH: 'Migration source count changed after planning.',
  MIGRATION_SOURCE_CHECKSUM_MISMATCH: 'Migration source checksum changed after planning.',
  MIGRATION_MANIFEST_CHECKSUM_MISMATCH: 'Migration checkpoint belongs to a different manifest.',
  MIGRATION_TARGET_NOT_EMPTY: 'Migration target collection is not empty.',
  MIGRATION_TARGET_OWNERSHIP_MISMATCH: 'Migration target data is owned by a different migration.',
  MIGRATION_CHECKPOINT_CONFLICT: 'Migration checkpoint atomic update conflicted.',
  MIGRATION_ALREADY_RUNNING: 'Migration identifier is already being executed.',
  MIGRATION_BATCH_FAILED: 'Migration batch failed after bounded attempts.',
  MIGRATION_VERIFY_FAILED: 'Migration target verification failed.',
};

export class MigrationExecutionError extends Error {
  readonly code: MigrationExecutionErrorCode;

  constructor(code: MigrationExecutionErrorCode, options: { cause?: unknown } = {}) {
    super(SAFE_MESSAGES[code], options);
    this.name = 'MigrationExecutionError';
    this.code = code;
  }
}

export interface MigrationCheckpoint {
  readonly migrationId: string;
  readonly manifestChecksum: string;
  readonly collection: string;
  readonly sourceChecksum: string;
  readonly sourceCount: number;
  readonly processedCount: number;
  readonly batchCursor: number;
  readonly status: MigrationCheckpointStatus;
  readonly updatedAt: string;
  readonly checkpointRevision: number;
  readonly executorId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastErrorCode?: MigrationExecutionErrorCode;
}

export interface MigrationTargetCollectionState {
  readonly exists: boolean;
  readonly count: number;
  readonly migrationId: string | null;
}

export interface MigrationBatchWrite {
  readonly migrationId: string;
  readonly manifestChecksum: string;
  readonly collection: string;
  readonly sourceChecksum: string;
  readonly batchKey: string;
  readonly startIndex: number;
  readonly items: unknown[];
}

export interface IsolatedMigrationTarget {
  readonly database: string;
  inspectCollection(collection: string): Promise<MigrationTargetCollectionState>;
  readCollection(collection: string): Promise<unknown[]>;
  readCheckpoint(migrationId: string, collection: string): Promise<MigrationCheckpoint | null>;
  /** This compare-and-set operation is the required atomic checkpoint boundary. */
  compareAndSetCheckpoint(
    migrationId: string,
    collection: string,
    expectedRevision: number | null,
    next: MigrationCheckpoint
  ): Promise<boolean>;
  /** Implementations must treat an already-seen batchKey as a successful no-op. */
  writeBatch(batch: MigrationBatchWrite): Promise<'written' | 'already_applied'>;
}

export interface MigrationExecutionOptions {
  readonly mode: MigrationExecutionMode;
  readonly manifest: MigrationManifest;
  readonly migrationId: string;
  readonly sourceCollections: ReadonlyMap<string, unknown[]> | Readonly<Record<string, unknown[]>>;
  readonly target?: IsolatedMigrationTarget;
  readonly allowIsolatedWrite?: boolean;
  readonly executorId?: string;
  readonly leaseMs?: number;
  readonly maxBatchRetries?: number;
  readonly now?: () => Date;
  readonly isRetryable?: (error: unknown) => boolean;
}

export interface MigrationCollectionExecutionSummary {
  readonly collection: string;
  readonly sourceCount: number;
  readonly sourceChecksum: string;
  readonly processedCount: number;
  readonly status: 'PLANNED' | 'DRY_RUN' | 'COMPLETED' | 'SKIPPED_COMPLETED';
}

export interface MigrationExecutionSummary {
  readonly migrationId: string;
  readonly manifestChecksum: string;
  readonly mode: MigrationExecutionMode;
  readonly database: string;
  readonly collections: MigrationCollectionExecutionSummary[];
  readonly writesPerformed: number;
}

export const ISOLATED_DATABASE_SUFFIXES = [
  '_test',
  '_staging',
  '_sandbox',
  '_migration_test',
  '_restore_test',
  '_acceptance',
] as const;

const FORBIDDEN_DATABASES = new Set(['sandeal', 'admin', 'local', 'config']);

export function assertIsolatedDatabase(database: string): void {
  const normalized = database.trim().toLowerCase();
  if (
    normalized === ''
    || Buffer.byteLength(normalized, 'utf8') > 63
    || /[\x00/\\."$*<>:|?]/.test(normalized)
  ) throw new MigrationExecutionError('MIGRATION_DATABASE_NOT_ISOLATED');
  if (FORBIDDEN_DATABASES.has(normalized)) throw new MigrationExecutionError('MIGRATION_DATABASE_FORBIDDEN');
  if (!ISOLATED_DATABASE_SUFFIXES.some(suffix => normalized.endsWith(suffix))) {
    throw new MigrationExecutionError('MIGRATION_DATABASE_NOT_ISOLATED');
  }
}

function sourceValue(
  source: MigrationExecutionOptions['sourceCollections'],
  collection: string
): unknown[] | undefined {
  if (typeof (source as ReadonlyMap<string, unknown[]>).get === 'function') {
    return (source as ReadonlyMap<string, unknown[]>).get(collection);
  }
  return (source as Readonly<Record<string, unknown[]>>)[collection];
}

function executionError(error: unknown, fallback: MigrationExecutionErrorCode): MigrationExecutionError {
  return error instanceof MigrationExecutionError ? error : new MigrationExecutionError(fallback, { cause: error });
}

function validateMigrationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) {
    throw new MigrationExecutionError('MIGRATION_ID_INVALID');
  }
  return value;
}

function validateSource(collection: MigrationManifestCollection, source: unknown[] | undefined): unknown[] {
  if (source === undefined) throw new MigrationExecutionError('MIGRATION_SOURCE_MISSING');
  const normalized = normalizeDomainCollection(source);
  if (normalized.length !== collection.sourceCount) {
    throw new MigrationExecutionError('MIGRATION_SOURCE_COUNT_MISMATCH');
  }
  if (checksumCollection(normalized) !== collection.sourceChecksum) {
    throw new MigrationExecutionError('MIGRATION_SOURCE_CHECKSUM_MISMATCH');
  }
  return normalized;
}

function validateCheckpoint(
  checkpoint: MigrationCheckpoint,
  manifest: MigrationManifest,
  collection: MigrationManifestCollection
): void {
  if (checkpoint.manifestChecksum !== manifest.manifestChecksum) {
    throw new MigrationExecutionError('MIGRATION_MANIFEST_CHECKSUM_MISMATCH');
  }
  if (checkpoint.sourceChecksum !== collection.sourceChecksum || checkpoint.sourceCount !== collection.sourceCount) {
    throw new MigrationExecutionError('MIGRATION_SOURCE_CHECKSUM_MISMATCH');
  }
  if (
    checkpoint.processedCount < 0
    || checkpoint.processedCount > checkpoint.sourceCount
    || checkpoint.batchCursor !== checkpoint.processedCount
  ) throw new MigrationExecutionError('MIGRATION_CHECKPOINT_CONFLICT');
}

function leaseActive(checkpoint: MigrationCheckpoint, now: Date, executorId: string): boolean {
  return checkpoint.executorId !== null
    && checkpoint.executorId !== executorId
    && checkpoint.leaseExpiresAt !== null
    && Date.parse(checkpoint.leaseExpiresAt) > now.getTime();
}

async function verifyCompleted(
  target: IsolatedMigrationTarget,
  collection: MigrationManifestCollection
): Promise<void> {
  const targetItems = await target.readCollection(collection.expectedTargetCollection);
  if (targetItems.length !== collection.sourceCount || checksumCollection(targetItems) !== collection.sourceChecksum) {
    throw new MigrationExecutionError('MIGRATION_VERIFY_FAILED');
  }
}

async function applyCollection(
  options: MigrationExecutionOptions,
  collection: MigrationManifestCollection,
  source: unknown[],
  now: () => Date,
  executorId: string
): Promise<{ summary: MigrationCollectionExecutionSummary; writes: number }> {
  const target = options.target as IsolatedMigrationTarget;
  const leaseMs = options.leaseMs ?? 30_000;
  const maxBatchRetries = options.maxBatchRetries ?? 2;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new MigrationExecutionError('MIGRATION_MODE_INVALID');
  }
  if (!Number.isSafeInteger(maxBatchRetries) || maxBatchRetries < 0 || maxBatchRetries > 5) {
    throw new MigrationExecutionError('MIGRATION_MODE_INVALID');
  }

  const state = await target.inspectCollection(collection.expectedTargetCollection);
  let checkpoint = await target.readCheckpoint(options.migrationId, collection.logicalName);
  if (checkpoint) {
    validateCheckpoint(checkpoint, options.manifest, collection);
    if (checkpoint.status === 'COMPLETED') {
      await verifyCompleted(target, collection);
      return {
        summary: {
          collection: collection.logicalName,
          sourceCount: source.length,
          sourceChecksum: collection.sourceChecksum as string,
          processedCount: checkpoint.processedCount,
          status: 'SKIPPED_COMPLETED',
        },
        writes: 0,
      };
    }
    if (leaseActive(checkpoint, now(), executorId)) {
      throw new MigrationExecutionError('MIGRATION_ALREADY_RUNNING');
    }
    if (state.count > 0 && state.migrationId !== options.migrationId) {
      throw new MigrationExecutionError('MIGRATION_TARGET_OWNERSHIP_MISMATCH');
    }
    if (state.count < checkpoint.processedCount) {
      throw new MigrationExecutionError('MIGRATION_VERIFY_FAILED');
    }
  } else {
    if (state.count !== 0) throw new MigrationExecutionError('MIGRATION_TARGET_NOT_EMPTY');
    const plannedAt = now();
    const planned: MigrationCheckpoint = {
      migrationId: options.migrationId,
      manifestChecksum: options.manifest.manifestChecksum,
      collection: collection.logicalName,
      sourceChecksum: collection.sourceChecksum as string,
      sourceCount: collection.sourceCount as number,
      processedCount: 0,
      batchCursor: 0,
      status: 'PLANNED',
      updatedAt: plannedAt.toISOString(),
      checkpointRevision: 1,
      executorId,
      leaseExpiresAt: new Date(plannedAt.getTime() + leaseMs).toISOString(),
    };
    if (!await target.compareAndSetCheckpoint(options.migrationId, collection.logicalName, null, planned)) {
      throw new MigrationExecutionError('MIGRATION_CHECKPOINT_CONFLICT');
    }
    checkpoint = planned;
  }

  const saveCheckpoint = async (
    changes: Omit<Partial<MigrationCheckpoint>, 'checkpointRevision'>
  ): Promise<MigrationCheckpoint> => {
    const changedAt = now();
    const next: MigrationCheckpoint = {
      ...checkpoint as MigrationCheckpoint,
      ...changes,
      updatedAt: changedAt.toISOString(),
      checkpointRevision: (checkpoint as MigrationCheckpoint).checkpointRevision + 1,
    };
    if (!await target.compareAndSetCheckpoint(
      options.migrationId,
      collection.logicalName,
      (checkpoint as MigrationCheckpoint).checkpointRevision,
      next
    )) throw new MigrationExecutionError('MIGRATION_CHECKPOINT_CONFLICT');
    checkpoint = next;
    return next;
  };

  let writes = 0;
  try {
    await saveCheckpoint({
      status: 'RUNNING',
      executorId,
      leaseExpiresAt: new Date(now().getTime() + leaseMs).toISOString(),
    });
    while ((checkpoint as MigrationCheckpoint).processedCount < source.length) {
      const startIndex = (checkpoint as MigrationCheckpoint).processedCount;
      const endIndex = Math.min(startIndex + collection.batchSize, source.length);
      const batchKey = `${options.migrationId}:${collection.logicalName}:${startIndex}:${endIndex}:${collection.sourceChecksum}`;
      let wrote = false;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxBatchRetries; attempt += 1) {
        try {
          const result = await target.writeBatch({
            migrationId: options.migrationId,
            manifestChecksum: options.manifest.manifestChecksum,
            collection: collection.expectedTargetCollection,
            sourceChecksum: collection.sourceChecksum as string,
            batchKey,
            startIndex,
            items: source.slice(startIndex, endIndex),
          });
          if (result === 'written') writes += 1;
          wrote = true;
          break;
        } catch (error) {
          lastError = error;
          const retryable = options.isRetryable?.(error) ?? false;
          if (!retryable || attempt >= maxBatchRetries) break;
        }
      }
      if (!wrote) throw new MigrationExecutionError('MIGRATION_BATCH_FAILED', { cause: lastError });
      await saveCheckpoint({
        processedCount: endIndex,
        batchCursor: endIndex,
        status: 'RUNNING',
        executorId,
        leaseExpiresAt: new Date(now().getTime() + leaseMs).toISOString(),
      });
    }

    await verifyCompleted(target, collection);
    await saveCheckpoint({
      status: 'COMPLETED',
      executorId: null,
      leaseExpiresAt: null,
      processedCount: source.length,
      batchCursor: source.length,
    });
    return {
      summary: {
        collection: collection.logicalName,
        sourceCount: source.length,
        sourceChecksum: collection.sourceChecksum as string,
        processedCount: source.length,
        status: 'COMPLETED',
      },
      writes,
    };
  } catch (error) {
    const safe = executionError(error, 'MIGRATION_BATCH_FAILED');
    if (checkpoint && checkpoint.executorId === executorId && checkpoint.status !== 'COMPLETED') {
      try {
        await saveCheckpoint({
          status: 'FAILED',
          executorId: null,
          leaseExpiresAt: null,
          lastErrorCode: safe.code,
        });
      } catch {
        // Preserve the original failure; a CAS conflict must never be hidden as completion.
      }
    }
    throw safe;
  }
}

export async function executeMigration(options: MigrationExecutionOptions): Promise<MigrationExecutionSummary> {
  if (!['plan', 'dry-run', 'apply-isolated'].includes(options.mode)) {
    throw new MigrationExecutionError('MIGRATION_MODE_INVALID');
  }
  validateMigrationId(options.migrationId);
  const validation = validateMigrationManifest(options.manifest);
  if (!validation.valid || options.manifest.blockers.length > 0) {
    throw new MigrationExecutionError('MIGRATION_MANIFEST_UNSAFE');
  }

  const included = options.manifest.collections.filter(collection => collection.migrationPolicy === 'include');
  const sources = new Map<string, unknown[]>();
  for (const collection of included) {
    sources.set(collection.logicalName, validateSource(
      collection,
      sourceValue(options.sourceCollections, collection.logicalName)
    ));
  }

  if (options.mode !== 'apply-isolated') {
    return {
      migrationId: options.migrationId,
      manifestChecksum: options.manifest.manifestChecksum,
      mode: options.mode,
      database: options.manifest.database,
      collections: included.map(collection => ({
        collection: collection.logicalName,
        sourceCount: collection.sourceCount as number,
        sourceChecksum: collection.sourceChecksum as string,
        processedCount: 0,
        status: options.mode === 'plan' ? 'PLANNED' : 'DRY_RUN',
      })),
      writesPerformed: 0,
    };
  }

  if (!options.allowIsolatedWrite) {
    throw new MigrationExecutionError('MIGRATION_ISOLATED_WRITE_FLAG_REQUIRED');
  }
  if (!options.target) throw new MigrationExecutionError('MIGRATION_MODE_INVALID');
  assertIsolatedDatabase(options.target.database);
  if (options.target.database !== options.manifest.database) {
    throw new MigrationExecutionError('MIGRATION_DATABASE_MISMATCH');
  }
  const executorId = validateMigrationId(options.executorId ?? 'isolated-executor');
  const now = options.now ?? (() => new Date());
  const collections: MigrationCollectionExecutionSummary[] = [];
  let writesPerformed = 0;
  for (const collection of included) {
    const result = await applyCollection(
      options,
      collection,
      sources.get(collection.logicalName) as unknown[],
      now,
      executorId
    );
    collections.push(result.summary);
    writesPerformed += result.writes;
  }
  return {
    migrationId: options.migrationId,
    manifestChecksum: options.manifest.manifestChecksum,
    mode: options.mode,
    database: options.target.database,
    collections,
    writesPerformed,
  };
}
