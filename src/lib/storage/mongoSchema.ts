import type {
  ClientSession,
  Db,
  Document,
  IndexSpecification,
} from 'mongodb';

import { storageError } from './storageErrors';

export const EXPECTED_MONGO_SCHEMA_VERSION = 1;
export const MONGO_STORAGE_METADATA_COLLECTION = 'sandeal_storage_metadata';
export const MONGO_STORAGE_SCHEMA_KEY = 'storage_schema';

export const MONGO_LOGICAL_COLLECTIONS = [
  'alert-incidents',
  'alert-occurrences',
  'alert-remediation-runs',
  'automation-ai-usage',
  'automation-audit',
  'automation-canary',
  'automation-circuits',
  'automation-control',
  'automation-job-attempts',
  // Compact automation read models use the generic revision/order storage
  // contract. Adding their indexes to this v1 manifest would silently require
  // a production schema migration, so that belongs in a future schema version.
  'automation-jobs',
  'automation-manual-tasks',
  'automation-outbound-events',
  'automation-slo-snapshots',
  'autonomous-entity-migrations',
  'autonomous-migrations',
  'autopilot-logs',
  'bot-runs',
  'candidate-queue',
  'content',
  'content-drafts',
  'content-packages',
  'domain-circuit-breakers',
  'duplicate-groups',
  'evidence-facts',
  'gemini-daily-usage',
  'gemini-pool-state',
  'growth-daily',
  'import-batches',
  'jobs',
  'launch-state',
  'link-health',
  'operation-journal',
  'operator-alert-deliveries',
  'outbound-events',
  'pending-manual-sources',
  'pipeline-daily-usage',
  'pipeline-runtime',
  'price-history',
  'product-alerts',
  'product-admin-actions',
  'product-lifecycle-events',
  'product-reprocess-audit',
  'product-sources',
  'products',
  'publication-audit',
  'recommended-actions',
  'runtime-health',
  'runtime-recovery-canary-health-v1',
  'runtime-recovery-canary-permits',
  'runtime-recovery-state',
  'runtime-role-conflicts',
  'runtime-role-fencing',
  'runtime-role-leases',
  'saved-views',
  'scheduler-state',
  'source-keyword-state',
  'source-quality',
  'token-vault',
] as const;

interface MongoSchemaDocument extends Document {
  _id: typeof MONGO_STORAGE_SCHEMA_KEY;
  kind: 'schema';
  version: number;
  updatedAt: string;
}

interface MongoExistingIndex extends Document {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
  collation?: unknown;
}

interface MongoIndexState {
  existingCollections: string[];
  indexesByCollection: Map<string, Map<string, MongoExistingIndex>>;
}

export interface MongoIndexPlan {
  readonly collection: string;
  readonly name: string;
  readonly keys: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly action: 'ensure';
}

export interface MongoSchemaInspection {
  readonly version: number | null;
  readonly expectedVersion: number;
  readonly ready: boolean;
  readonly existingCollections: string[];
  /**
   * Includes indexes that are absent and indexes whose current definition does
   * not match the manifest. Both conditions require operator attention.
   */
  readonly missingIndexes: Array<{ collection: string; name: string }>;
}

const INDEX_MANIFEST: readonly MongoIndexPlan[] = [
  {
    collection: MONGO_STORAGE_METADATA_COLLECTION,
    name: 'sandeal_metadata_kind_revision',
    keys: { kind: 1, revision: 1 },
    options: {},
    action: 'ensure',
  },
  ...MONGO_LOGICAL_COLLECTIONS.flatMap<MongoIndexPlan>(collection => [
    {
      collection,
      name: 'sandeal_revision_order_unique',
      keys: { revision: 1, order: 1 },
      options: { unique: true },
      action: 'ensure' as const,
    },
    {
      collection,
      name: 'sandeal_revision_item_id',
      keys: { revision: 1, itemId: 1 },
      options: {
        partialFilterExpression: {
          itemId: { $type: 'string' },
        },
      },
      action: 'ensure' as const,
    },
  ]),
];

const INDEX_OPTION_FIELDS = [
  'unique',
  'sparse',
  'expireAfterSeconds',
  'partialFilterExpression',
  'collation',
] as const;

function cloneManifestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => cloneManifestValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .map(([key, nested]) => [key, cloneManifestValue(nested)]),
    );
  }
  return value;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalizeValue(nested)]),
    );
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeValue(left))
      === JSON.stringify(canonicalizeValue(right));
}

function sameOrderedKeys(
    actual: Record<string, unknown> | undefined,
    expected: Readonly<Record<string, unknown>>,
): boolean {
  if (!actual) return false;
  return JSON.stringify(Object.entries(actual))
      === JSON.stringify(Object.entries(expected));
}

function indexMatchesPlan(
    existing: MongoExistingIndex,
    plan: MongoIndexPlan,
): boolean {
  if (!sameOrderedKeys(existing.key, plan.keys)) return false;

  for (const field of INDEX_OPTION_FIELDS) {
    const expected = plan.options[field];
    const actual = existing[field];

    if (field === 'unique' || field === 'sparse') {
      if (Boolean(actual) !== Boolean(expected)) return false;
      continue;
    }

    if (!sameValue(actual ?? null, expected ?? null)) return false;
  }

  return true;
}

function isIndexConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; codeName?: unknown };
  return candidate.code === 85
      || candidate.code === 86
      || candidate.codeName === 'IndexOptionsConflict'
      || candidate.codeName === 'IndexKeySpecsConflict';
}

async function inspectIndexState(db: Db): Promise<MongoIndexState> {
  const collectionInfo = await db
      .listCollections({}, { nameOnly: true })
      .toArray();
  const existingCollections = collectionInfo
      .map(item => item.name)
      .sort();
  const existingSet = new Set(existingCollections);
  const indexesByCollection = new Map<
      string,
      Map<string, MongoExistingIndex>
  >();

  for (const collection of new Set(
      INDEX_MANIFEST.map(item => item.collection),
  )) {
    if (!existingSet.has(collection)) continue;

    const indexes = await db
        .collection(collection)
        .listIndexes()
        .toArray() as MongoExistingIndex[];

    indexesByCollection.set(
        collection,
        new Map(
            indexes
                .filter((index): index is MongoExistingIndex & { name: string } =>
                    typeof index.name === 'string' && index.name.length > 0)
                .map(index => [index.name, index]),
        ),
    );
  }

  return { existingCollections, indexesByCollection };
}

export function planMongoSchema(): MongoIndexPlan[] {
  return INDEX_MANIFEST.map(item => ({
    ...item,
    keys: cloneManifestValue(item.keys) as Record<string, unknown>,
    options: cloneManifestValue(item.options) as Record<string, unknown>,
  }));
}

export async function readMongoSchemaVersion(
    db: Db,
    session?: ClientSession,
): Promise<number | null> {
  const document = await db
      .collection<MongoSchemaDocument>(MONGO_STORAGE_METADATA_COLLECTION)
      .findOne(
          { _id: MONGO_STORAGE_SCHEMA_KEY, kind: 'schema' },
          session ? { session } : undefined,
      );

  return Number.isSafeInteger(document?.version)
  && Number(document?.version) > 0
      ? Number(document?.version)
      : null;
}

export async function assertMongoSchema(
    db: Db,
    session?: ClientSession,
): Promise<void> {
  if (
      await readMongoSchemaVersion(db, session)
      !== EXPECTED_MONGO_SCHEMA_VERSION
  ) {
    throw storageError('MONGO_SCHEMA_VERSION_MISMATCH');
  }
}

export async function inspectMongoSchema(
    db: Db,
): Promise<MongoSchemaInspection> {
  const version = await readMongoSchemaVersion(db);
  const state = await inspectIndexState(db);

  const missingIndexes = INDEX_MANIFEST
      .filter(plan => {
        const existing = state.indexesByCollection
            .get(plan.collection)
            ?.get(plan.name);
        return !existing || !indexMatchesPlan(existing, plan);
      })
      .map(plan => ({
        collection: plan.collection,
        name: plan.name,
      }));

  return {
    version,
    expectedVersion: EXPECTED_MONGO_SCHEMA_VERSION,
    ready:
        version === EXPECTED_MONGO_SCHEMA_VERSION
        && missingIndexes.length === 0,
    existingCollections: state.existingCollections,
    missingIndexes,
  };
}

export async function applyMongoSchema(
    db: Db,
): Promise<MongoSchemaInspection> {
  const currentVersion = await readMongoSchemaVersion(db);
  if (
      currentVersion !== null
      && currentVersion !== EXPECTED_MONGO_SCHEMA_VERSION
  ) {
    throw storageError('MONGO_SCHEMA_VERSION_MISMATCH');
  }

  const existingState = await inspectIndexState(db);
  for (const plan of INDEX_MANIFEST) {
    const existing = existingState.indexesByCollection
        .get(plan.collection)
        ?.get(plan.name);
    if (existing && !indexMatchesPlan(existing, plan)) {
      throw storageError('MONGO_SCHEMA_VERSION_MISMATCH');
    }
  }

  try {
    for (const index of INDEX_MANIFEST) {
      await db.collection(index.collection).createIndex(
          index.keys as IndexSpecification,
          {
            ...(cloneManifestValue(index.options) as Record<string, unknown>),
            name: index.name,
          },
      );
    }
  } catch (error) {
    if (isIndexConflict(error)) {
      throw storageError('MONGO_SCHEMA_VERSION_MISMATCH', error);
    }
    throw error;
  }

  await db
      .collection<MongoSchemaDocument>(MONGO_STORAGE_METADATA_COLLECTION)
      .updateOne(
          { _id: MONGO_STORAGE_SCHEMA_KEY },
          {
            $set: {
              kind: 'schema',
              version: EXPECTED_MONGO_SCHEMA_VERSION,
              updatedAt: new Date().toISOString(),
            },
          },
          { upsert: true },
      );

  const inspection = await inspectMongoSchema(db);
  if (!inspection.ready) {
    throw storageError('MONGO_SCHEMA_VERSION_MISMATCH');
  }
  return inspection;
}
