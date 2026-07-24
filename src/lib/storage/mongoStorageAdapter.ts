import type { ClientSession, Db, Document } from 'mongodb';

import { mongoConnection, type MongoConnection } from './mongoClient';
import {
  deserializeMongoItems,
  normalizeCollectionPayload,
  serializeMongoItems,
  validateCollectionName,
  type MongoStoredItem,
} from './mongoSerialization';
import {
  assertMongoSchema,
  EXPECTED_MONGO_SCHEMA_VERSION,
  MONGO_STORAGE_METADATA_COLLECTION,
  readMongoSchemaVersion,
} from './mongoSchema';
import type { MongoStorageConfig } from './storageConfig';
import { isStorageError, storageError, storageErrorCode } from './storageErrors';
import type { StorageAdapter, StoragePageOptions, StorageTransaction } from './types';

const TRANSACTION_ATTEMPTS = 2;
const COMMIT_ATTEMPTS = 2;
const SAFE_PAGE_FIELD = /^[A-Za-z][A-Za-z0-9]*$/;

interface MongoRevisionDocument extends Document {
  _id: string;
  kind: 'collection';
  revision: number;
  updatedAt: string;
}

interface CollectionSnapshot<T> {
  revision: number;
  items: T[];
}

function hasErrorLabel(error: unknown, label: string): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'hasErrorLabel' in error
    && typeof (error as { hasErrorLabel?: unknown }).hasErrorLabel === 'function'
    && (error as { hasErrorLabel(value: string): boolean }).hasErrorLabel(label)
  );
}

function isTransientTransactionError(error: unknown): boolean {
  return hasErrorLabel(error, 'TransientTransactionError');
}

function isUnknownCommitResult(error: unknown): boolean {
  return hasErrorLabel(error, 'UnknownTransactionCommitResult');
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000);
}

async function abortIfActive(session: ClientSession): Promise<void> {
  if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
}

async function commitWithBoundedRetry(session: ClientSession): Promise<void> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      if (!isUnknownCommitResult(error) || attempt + 1 >= COMMIT_ATTEMPTS) throw error;
    }
  }
}

async function readSnapshot<T>(db: Db, session: ClientSession, collection: string): Promise<CollectionSnapshot<T>> {
  await assertMongoSchema(db, session);
  const metadata = await db.collection<MongoRevisionDocument>(MONGO_STORAGE_METADATA_COLLECTION)
    .findOne({ _id: collection, kind: 'collection' }, { session });
  if (!metadata) return { revision: 0, items: [] };

  const documents = await db.collection<MongoStoredItem>(collection)
    .find({ revision: metadata.revision }, { session })
    .sort({ order: 1 })
    .toArray();
  return { revision: metadata.revision, items: deserializeMongoItems<T>(documents) };
}

async function writeRevision(
  db: Db,
  session: ClientSession,
  collection: string,
  expectedRevision: number,
  normalized: unknown[]
): Promise<void> {
  await assertMongoSchema(db, session);
  const nextRevision = expectedRevision + 1;
  const metadata = db.collection<MongoRevisionDocument>(MONGO_STORAGE_METADATA_COLLECTION);
  const updatedAt = new Date().toISOString();

  if (expectedRevision === 0) {
    try {
      await metadata.insertOne({
        _id: collection,
        kind: 'collection',
        revision: nextRevision,
        updatedAt,
      }, { session });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw storageError('MONGO_TRANSACTION_CONFLICT', error);
      throw error;
    }
  } else {
    const result = await metadata.updateOne(
      { _id: collection, kind: 'collection', revision: expectedRevision },
      { $set: { revision: nextRevision, updatedAt } },
      { session }
    );
    if (result.matchedCount !== 1) throw storageError('MONGO_TRANSACTION_CONFLICT');
  }

  const dataCollection = db.collection<MongoStoredItem>(collection);
  const documents = serializeMongoItems(normalized, nextRevision);
  if (documents.length > 0) await dataCollection.insertMany(documents, { session, ordered: true });
  await dataCollection.deleteMany({ revision: { $ne: nextRevision } }, { session });
}

export class MongoStorageAdapter implements StorageAdapter {
  readonly driver = 'mongo' as const;

  constructor(
    private readonly config: MongoStorageConfig,
    private readonly connection: MongoConnection = mongoConnection
  ) {}

  getDataDir(): never {
    throw storageError('MONGO_OPERATION_FAILED');
  }

  async ensureDataDir(): Promise<void> {
    throw storageError('MONGO_OPERATION_FAILED');
  }

  private async database(): Promise<Db> {
    try {
      return await this.connection.getDatabase(this.config);
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw storageError('MONGO_CONNECTION_FAILED', error);
    }
  }

  private async session(): Promise<ClientSession> {
    try {
      return await this.connection.startSession(this.config);
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw storageError('MONGO_CONNECTION_FAILED', error);
    }
  }

  private async commitPrepared(
    db: Db,
    collection: string,
    expectedRevision: number,
    normalized: unknown[]
  ): Promise<void> {
    for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt += 1) {
      const session = await this.session();
      try {
        session.startTransaction();
        await writeRevision(db, session, collection, expectedRevision, normalized);
        await commitWithBoundedRetry(session);
        return;
      } catch (error) {
        await abortIfActive(session);
        if (isStorageError(error)) throw error;
        if (!isTransientTransactionError(error) || attempt + 1 >= TRANSACTION_ATTEMPTS) {
          throw storageError('MONGO_TRANSACTION_FAILED', error);
        }
      } finally {
        await session.endSession();
      }
    }
  }

  async readCollection<T>(collection: string): Promise<T[]> {
    const safeCollection = validateCollectionName(collection);
    const db = await this.database();
    const session = await this.session();
    try {
      session.startTransaction();
      const snapshot = await readSnapshot<T>(db, session, safeCollection);
      await commitWithBoundedRetry(session);
      return snapshot.items;
    } catch (error) {
      await abortIfActive(session);
      if (isStorageError(error)) throw error;
      throw storageError('MONGO_OPERATION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async readCollectionPage<T>(collection: string, options: StoragePageOptions) {
    const safeCollection = validateCollectionName(collection);
    const filterEntries = Object.entries(options.filters || {});
    const sortField = options.sort?.field;
    if (
      filterEntries.some(([field]) => !SAFE_PAGE_FIELD.test(field))
      || (sortField && !SAFE_PAGE_FIELD.test(sortField))
    ) {
      throw storageError('INVALID_STORAGE_QUERY');
    }
    const db = await this.database();
    const session = await this.session();
    try {
      session.startTransaction();
      await assertMongoSchema(db, session);
      const metadata = await db.collection<MongoRevisionDocument>(MONGO_STORAGE_METADATA_COLLECTION)
        .findOne({ _id: safeCollection, kind: 'collection' }, { session });
      if (!metadata) {
        await commitWithBoundedRetry(session);
        return { items: [] as T[], totalItems: 0, queryCount: 1 };
      }
      const match: Record<string, unknown> = { revision: metadata.revision };
      for (const [field, expected] of filterEntries) match[`item.${field}`] = expected;
      const sort = options.sort
        ? { [`item.${options.sort.field}`]: options.sort.direction === 'desc' ? -1 : 1, order: 1 }
        : { order: 1 };
      const skip = (options.page - 1) * options.pageSize;
      const [facet] = await db.collection<MongoStoredItem>(safeCollection).aggregate<{
        rows: MongoStoredItem[];
        count: Array<{ total: number }>;
      }>([
        { $match: match },
        { $sort: sort },
        {
          $facet: {
            rows: [{ $skip: skip }, { $limit: options.pageSize }],
            count: [{ $count: 'total' }],
          },
        },
      ], { session }).toArray();
      await commitWithBoundedRetry(session);
      return {
        items: deserializeMongoItems<T>(facet?.rows || []),
        totalItems: facet?.count[0]?.total || 0,
        // One metadata lookup plus one aggregation command. The aggregation
        // returns both the page and total through $facet.
        queryCount: 2,
      };
    } catch (error) {
      await abortIfActive(session);
      if (isStorageError(error)) throw error;
      throw storageError('MONGO_OPERATION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async writeCollection<T>(collection: string, data: T[]): Promise<void> {
    const safeCollection = validateCollectionName(collection);
    const normalized = normalizeCollectionPayload(data);
    const db = await this.database();
    const session = await this.session();
    let prepared: { revision: number } | undefined;
    try {
      session.startTransaction();
      const snapshot = await readSnapshot<unknown>(db, session, safeCollection);
      prepared = { revision: snapshot.revision };
      await writeRevision(db, session, safeCollection, snapshot.revision, normalized);
      await commitWithBoundedRetry(session);
    } catch (error) {
      await abortIfActive(session);
      if (isStorageError(error)) throw error;
      if (prepared && isTransientTransactionError(error)) {
        await this.commitPrepared(db, safeCollection, prepared.revision, normalized);
        return;
      }
      throw storageError('MONGO_TRANSACTION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async runTransaction<T>(collection: string, fn: StorageTransaction<T>): Promise<void> {
    const safeCollection = validateCollectionName(collection);
    const db = await this.database();
    const session = await this.session();
    let callbackFailed = false;
    let callbackError: unknown;
    let prepared: { revision: number; normalized: unknown[] } | undefined;
    try {
      session.startTransaction();
      const snapshot = await readSnapshot<T>(db, session, safeCollection);
      let updated: T[] | undefined;
      try {
        updated = await fn(snapshot.items);
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        throw error;
      }
      if (updated === undefined) {
        await abortIfActive(session);
        return;
      }

      prepared = { revision: snapshot.revision, normalized: normalizeCollectionPayload(updated) };
      await writeRevision(db, session, safeCollection, prepared.revision, prepared.normalized);
      await commitWithBoundedRetry(session);
    } catch (error) {
      await abortIfActive(session);
      if (callbackFailed) throw callbackError;
      if (isStorageError(error)) throw error;
      if (prepared && isTransientTransactionError(error)) {
        await this.commitPrepared(db, safeCollection, prepared.revision, prepared.normalized);
        return;
      }
      throw storageError('MONGO_TRANSACTION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async checkHealth() {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      const db = await this.database();
      await db.command({ ping: 1 }, { timeoutMS: 5_000 });
      const schemaVersion = await readMongoSchemaVersion(db);
      const schemaReady = schemaVersion === EXPECTED_MONGO_SCHEMA_VERSION;
      return {
        driver: 'mongo' as const,
        configured: true,
        reachable: true,
        healthy: schemaReady,
        database: this.config.database,
        schemaVersion,
        expectedSchemaVersion: EXPECTED_MONGO_SCHEMA_VERSION,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        errorCode: schemaReady ? undefined : 'MONGO_SCHEMA_VERSION_MISMATCH',
      };
    } catch (error) {
      return {
        driver: 'mongo' as const,
        configured: true,
        reachable: false,
        healthy: false,
        database: this.config.database,
        schemaVersion: null,
        expectedSchemaVersion: EXPECTED_MONGO_SCHEMA_VERSION,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        errorCode: storageErrorCode(error, 'MONGO_CONNECTION_FAILED'),
      };
    }
  }
}

export function createMongoStorageAdapter(
  config: MongoStorageConfig,
  connection: MongoConnection = mongoConnection
): MongoStorageAdapter {
  return new MongoStorageAdapter(config, connection);
}
