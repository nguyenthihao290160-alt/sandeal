import type { ClientSession, Db, Document, IndexSpecification } from 'mongodb';

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
  'runtime-role-conflicts',
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
      options: { partialFilterExpression: { itemId: { $type: 'string' } } },
      action: 'ensure' as const,
    },
  ]),
];

export function planMongoSchema(): MongoIndexPlan[] {
  return INDEX_MANIFEST.map(item => ({
    ...item,
    keys: { ...item.keys },
    options: { ...item.options },
  }));
}

export async function readMongoSchemaVersion(db: Db, session?: ClientSession): Promise<number | null> {
  const document = await db.collection<MongoSchemaDocument>(MONGO_STORAGE_METADATA_COLLECTION)
    .findOne({ _id: MONGO_STORAGE_SCHEMA_KEY }, session ? { session } : undefined);
  return typeof document?.version === 'number' ? document.version : null;
}

export async function assertMongoSchema(db: Db, session?: ClientSession): Promise<void> {
  if (await readMongoSchemaVersion(db, session) !== EXPECTED_MONGO_SCHEMA_VERSION) {
    throw storageError('MONGO_SCHEMA_VERSION_MISMATCH');
  }
}

export async function inspectMongoSchema(db: Db): Promise<MongoSchemaInspection> {
  const version = await readMongoSchemaVersion(db);
  const collectionInfo = await db.listCollections({}, { nameOnly: true }).toArray();
  const existingCollections = collectionInfo.map(item => item.name).sort();
  const existingSet = new Set(existingCollections);
  const indexNames = new Map<string, Set<string>>();

  for (const collection of new Set(INDEX_MANIFEST.map(item => item.collection))) {
    if (!existingSet.has(collection)) continue;
    const indexes = await db.collection(collection).listIndexes().toArray();
    indexNames.set(collection, new Set(indexes.map(index => index.name).filter((name): name is string => Boolean(name))));
  }

  const missingIndexes = INDEX_MANIFEST
    .filter(item => !indexNames.get(item.collection)?.has(item.name))
    .map(item => ({ collection: item.collection, name: item.name }));

  return {
    version,
    expectedVersion: EXPECTED_MONGO_SCHEMA_VERSION,
    ready: version === EXPECTED_MONGO_SCHEMA_VERSION && missingIndexes.length === 0,
    existingCollections,
    missingIndexes,
  };
}

export async function applyMongoSchema(db: Db): Promise<MongoSchemaInspection> {
  const currentVersion = await readMongoSchemaVersion(db);
  if (currentVersion !== null && currentVersion !== EXPECTED_MONGO_SCHEMA_VERSION) {
    throw storageError('MONGO_SCHEMA_VERSION_MISMATCH');
  }

  for (const index of INDEX_MANIFEST) {
    await db.collection(index.collection).createIndex(
      index.keys as IndexSpecification,
      { ...index.options, name: index.name }
    );
  }

  await db.collection<MongoSchemaDocument>(MONGO_STORAGE_METADATA_COLLECTION).updateOne(
    { _id: MONGO_STORAGE_SCHEMA_KEY },
    {
      $set: {
        kind: 'schema',
        version: EXPECTED_MONGO_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true }
  );

  return inspectMongoSchema(db);
}
