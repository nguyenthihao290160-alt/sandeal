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
import { applyStorageBulkMutations } from './bulkMutation';
import { isStorageError, storageError, storageErrorCode } from './storageErrors';
import { recordBoundedRead, recordFullCollectionRead, recordScanCollection } from './diagnostics';
import {
  STORAGE_MAX_BOUNDED_BYTES,
  STORAGE_MAX_BOUNDED_ITEMS,
  STORAGE_MAX_PAGE_SIZE,
} from './types';
import type {
  StorageAdapter,
  StorageBulkMutation,
  StorageBulkResult,
  StorageBoundedCollectionOptions,
  StorageBoundedCollectionResult,
  StoragePageOptions,
  StorageScanResult,
  StorageStreamingTransaction,
  StorageStreamingTransactionOptions,
  StorageTransaction,
  StorageTransactionOptions,
} from './types';

const TRANSACTION_ATTEMPTS = 2;
const COMMIT_ATTEMPTS = 2;
const STREAMING_INSERT_BATCH_SIZE = 250;
const SAFE_PAGE_FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

interface MongoCursorCompat<T> {
  toArray(): Promise<T[]>;
  close?: () => Promise<void>;
  batchSize?: (size: number) => MongoCursorCompat<T>;
  [Symbol.asyncIterator]?: () => AsyncIterator<T>;
}

function configureMongoCursor<T>(cursor: MongoCursorCompat<T>, batchSize?: number): MongoCursorCompat<T> {
  if (batchSize !== undefined) cursor.batchSize?.(batchSize);
  return cursor;
}

async function closeMongoCursor<T>(cursor: MongoCursorCompat<T>): Promise<void> {
  await cursor.close?.().catch(() => undefined);
}

async function* iterateMongoCursor<T>(cursor: MongoCursorCompat<T>): AsyncGenerator<T> {
  const iterator = cursor[Symbol.asyncIterator]?.();
  if (iterator) {
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  // The fake adapter used by deterministic tests exposes only toArray(). Real
  // Mongo cursors take the streaming branch above, so this fallback is test
  // compatibility rather than a production materialization path.
  for (const item of await cursor.toArray()) yield item;
}

function boundedCollectionError(code: string, collection: string): Error {
  const error = new Error(`${code}:${collection}`) as Error & { code?: string };
  error.code = code;
  return error;
}

function validateBoundedCollectionOptions(
    collection: string,
    options: StorageBoundedCollectionOptions,
): { maximumItems: number; maximumBytes: number } {
  if (
      !Number.isFinite(options.maximumItems)
      || !Number.isInteger(options.maximumItems)
      || options.maximumItems <= 0
      || options.maximumItems > STORAGE_MAX_BOUNDED_ITEMS
      || !Number.isFinite(options.maximumBytes)
      || !Number.isInteger(options.maximumBytes)
      || options.maximumBytes <= 0
      || options.maximumBytes > STORAGE_MAX_BOUNDED_BYTES
  ) {
    throw boundedCollectionError('BOUNDED_COLLECTION_OPTIONS_INVALID', collection);
  }
  return {
    maximumItems: options.maximumItems,
    maximumBytes: options.maximumBytes,
  };
}

function validatePageOptions(options: StoragePageOptions): void {
  const filterEntries = Object.entries(options.filters || {});
  const sortField = options.sort?.field;
  if (
      !Number.isInteger(options.page)
      || options.page < 1
      || !Number.isInteger(options.pageSize)
      || options.pageSize < 1
      || options.pageSize > STORAGE_MAX_PAGE_SIZE
      || options.page > Math.floor(Number.MAX_SAFE_INTEGER / options.pageSize)
      || filterEntries.some(([field]) => !SAFE_PAGE_FIELD.test(field))
      || filterEntries.some(([, value]) => typeof value !== 'string')
      || (sortField && !SAFE_PAGE_FIELD.test(sortField))
  ) {
    throw storageError('INVALID_STORAGE_QUERY');
  }
}

interface MongoRevisionDocument extends Document {
  _id: string;
  kind: 'collection';
  revision: number;
  itemCount?: number;
  serializedBytes?: number;
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
  const itemCount = normalized.length;
  const serializedBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');

  if (expectedRevision === 0) {
    try {
      await metadata.insertOne({
        _id: collection,
        kind: 'collection',
        revision: nextRevision,
        itemCount,
        serializedBytes,
        updatedAt,
      }, { session });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw storageError('MONGO_TRANSACTION_CONFLICT', error);
      throw error;
    }
  } else {
    const result = await metadata.updateOne(
        { _id: collection, kind: 'collection', revision: expectedRevision },
        { $set: { revision: nextRevision, itemCount, serializedBytes, updatedAt } },
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
  readonly capabilities = {
    schemaVersion: 1 as const,
    driver: 'mongo' as const,
    transactions: true,
    atomicCollectionRevision: true,
    boundedBulkMutation: true,
    partialFailureReporting: true,
    // The adapter writes one transactionally selected collection revision.
    // It does not claim MongoDB's item-level bulkWrite API.
    nativeBulkWrite: false,
    maximumBulkItems: 100,
    optimizedBulkFeatureFlag: 'MONGO_BULK_WRITE' as const,
  };

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
    recordFullCollectionRead(collection);
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
    recordBoundedRead();
    const safeCollection = validateCollectionName(collection);
    validatePageOptions(options);
    const filterEntries = Object.entries(options.filters || {});
    const db = await this.database();
    const session = await this.session();
    try {
      session.startTransaction();
      await assertMongoSchema(db, session);
      const metadata = await db.collection<MongoRevisionDocument>(MONGO_STORAGE_METADATA_COLLECTION)
          .findOne({ _id: safeCollection, kind: 'collection' }, { session });
      if (!metadata) {
        await commitWithBoundedRetry(session);
        return { items: [] as T[], totalItems: 0, queryCount: 2 };
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
        // One schema lookup, one revision lookup, and one aggregation command.
        // The aggregation returns both the page and total through $facet.
        queryCount: 3,
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

  async runTransaction<T>(
      collection: string,
      fn: StorageTransaction<T>,
      options: StorageTransactionOptions = {},
  ): Promise<void> {
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
      try {
        await options.beforeCommit?.();
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        throw error;
      }
      if (options.withCommitGuard) {
        let commitCalls = 0;
        let commitStarted = false;
        try {
          await options.withCommitGuard(async () => {
            commitCalls += 1;
            if (commitCalls !== 1) throw new Error('STORAGE_COMMIT_GUARD_MULTIPLE_COMMIT');
            commitStarted = true;
            await commitWithBoundedRetry(session);
          }, { authorityAcquired: () => undefined });
          if (commitCalls !== 1) throw new Error('STORAGE_COMMIT_GUARD_DID_NOT_COMMIT');
        } catch (error) {
          if (!commitStarted) {
            callbackFailed = true;
            callbackError = error;
          }
          throw error;
        }
      } else {
        await commitWithBoundedRetry(session);
      }
    } catch (error) {
      await abortIfActive(session);
      if (callbackFailed) throw callbackError;
      if (isStorageError(error)) throw error;
      if (prepared && !options.withCommitGuard && isTransientTransactionError(error)) {
        await this.commitPrepared(db, safeCollection, prepared.revision, prepared.normalized);
        return;
      }
      throw storageError('MONGO_TRANSACTION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async runStreamingTransaction<T>(
      collection: string,
      fn: StorageStreamingTransaction<T>,
      options: StorageStreamingTransactionOptions<T> = {},
  ): Promise<{ changed: boolean; itemCount: number }> {
    const safeCollection = validateCollectionName(collection);
    const db = await this.database();
    const session = await this.session();
    let changed = false;
    let itemCount = 0;
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      session.startTransaction();
      await assertMongoSchema(db, session);
      const metadataCollection = db.collection<MongoRevisionDocument>(MONGO_STORAGE_METADATA_COLLECTION);
      const metadata = await metadataCollection.findOne({ _id: safeCollection, kind: 'collection' }, { session });
      const expectedRevision = metadata?.revision || 0;
      const nextRevision = expectedRevision + 1;
      const dataCollection = db.collection<MongoStoredItem>(safeCollection);
      const staged: MongoStoredItem[] = [];
      let serializedBytes = 2;

      const flush = async (): Promise<void> => {
        if (!staged.length) return;
        await dataCollection.insertMany(staged.splice(0, staged.length), { session, ordered: true });
      };
      const stage = (item: T): void => {
        const serialized = serializeMongoItems([item], nextRevision)[0];
        if (!serialized) throw storageError('INVALID_STORAGE_PAYLOAD');
        const encoded = JSON.stringify(serialized.item);
        if (encoded === undefined) throw storageError('INVALID_STORAGE_PAYLOAD');
        staged.push({ ...serialized, order: itemCount });
        serializedBytes += Buffer.byteLength(encoded, 'utf8') + (itemCount > 0 ? 1 : 0);
        itemCount += 1;
      };
      const visitSource = async (visitor: StorageStreamingTransaction<T>): Promise<void> => {
        if (!metadata) return;
        const cursor = configureMongoCursor(
            dataCollection.find({ revision: expectedRevision }, { session }).sort({ order: 1 }),
            STREAMING_INSERT_BATCH_SIZE,
        );
        try {
          for await (const document of iterateMongoCursor(cursor)) {
            const item = deserializeMongoItems<T>([document])[0];
            try {
              const itemChanged = await visitor(item, itemCount);
              if (itemChanged === true) changed = true;
            } catch (error) {
              callbackFailed = true;
              callbackError = error;
              throw error;
            }
            stage(item);
            if (staged.length >= STREAMING_INSERT_BATCH_SIZE) await flush();
          }
        } finally {
          await closeMongoCursor(cursor);
        }
      };

      if (options.prepare && metadata) {
        const cursor = configureMongoCursor(
            dataCollection.find({ revision: expectedRevision }, { session }).sort({ order: 1 }),
            STREAMING_INSERT_BATCH_SIZE,
        );
        try {
          let index = 0;
          for await (const document of iterateMongoCursor(cursor)) {
            try {
              await options.prepare(deserializeMongoItems<T>([document])[0], index);
            } catch (error) {
              callbackFailed = true;
              callbackError = error;
              throw error;
            }
            index += 1;
          }
        } finally {
          await closeMongoCursor(cursor);
        }
      }
      try {
        await options.beforeMutation?.();
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        throw error;
      }
      await visitSource(fn);
      try {
        for (const item of options.appendItems?.() || []) {
          changed = true;
          stage(item);
          if (staged.length >= STREAMING_INSERT_BATCH_SIZE) await flush();
        }
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        throw error;
      }
      if (!changed) {
        await abortIfActive(session);
        return { changed: false, itemCount };
      }
      await flush();
      // Staged documents are still transactional and invisible. Revalidate
      // authority after the last potentially expensive flush, immediately
      // before advancing the visible collection revision.
      try {
        await options.beforeCommit?.();
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        throw error;
      }
      let commitCalls = 0;
      let commitStarted = false;
      const commit = async (): Promise<void> => {
        commitCalls += 1;
        if (commitCalls !== 1) throw new Error('STORAGE_COMMIT_GUARD_MULTIPLE_COMMIT');
        commitStarted = true;
        const updatedAt = new Date().toISOString();
        if (expectedRevision === 0) {
          try {
            await metadataCollection.insertOne({
              _id: safeCollection,
              kind: 'collection',
              revision: nextRevision,
              itemCount,
              serializedBytes,
              updatedAt,
            }, { session });
          } catch (error) {
            if (isDuplicateKeyError(error)) throw storageError('MONGO_TRANSACTION_CONFLICT', error);
            throw error;
          }
        } else {
          const result = await metadataCollection.updateOne(
              { _id: safeCollection, kind: 'collection', revision: expectedRevision },
              { $set: { revision: nextRevision, itemCount, serializedBytes, updatedAt } },
              { session },
          );
          if (result.matchedCount !== 1) throw storageError('MONGO_TRANSACTION_CONFLICT');
        }
        await dataCollection.deleteMany({ revision: { $ne: nextRevision } }, { session });
        await commitWithBoundedRetry(session);
      };
      if (options.withCommitGuard) {
        try {
          await options.withCommitGuard(commit, { authorityAcquired: () => undefined });
          if (commitCalls !== 1) throw new Error('STORAGE_COMMIT_GUARD_DID_NOT_COMMIT');
        } catch (error) {
          if (!commitStarted) {
            callbackFailed = true;
            callbackError = error;
          }
          throw error;
        }
      } else {
        await commit();
      }
      return { changed: true, itemCount };
    } catch (error) {
      await abortIfActive(session);
      if (callbackFailed) throw callbackError;
      if (isStorageError(error)) throw error;
      // Do not replay an arbitrary async visitor after a transient Mongo
      // transaction failure. The caller can retry the durable operation with
      // its normal fencing/idempotency rules.
      throw storageError('MONGO_TRANSACTION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async scanCollection<T>(
      collection: string,
      visitor: (item: T, index: number) => Promise<void> | void,
  ): Promise<StorageScanResult> {
    recordScanCollection();
    const safeCollection = validateCollectionName(collection);
    const db = await this.database();
    const session = await this.session();
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      session.startTransaction();
      await assertMongoSchema(db, session);
      const metadata = await db.collection<MongoRevisionDocument>(MONGO_STORAGE_METADATA_COLLECTION)
          .findOne({ _id: safeCollection, kind: 'collection' }, { session });
      if (!metadata) {
        await commitWithBoundedRetry(session);
        return { itemCount: 0, observedBytes: 0, queryCount: 2 };
      }
      const cursor = configureMongoCursor(
          db.collection<MongoStoredItem>(safeCollection)
              .find({ revision: metadata.revision }, { session })
              .sort({ order: 1 }),
          STREAMING_INSERT_BATCH_SIZE,
      );
      let index = 0;
      try {
        for await (const document of iterateMongoCursor(cursor)) {
          const normalized = normalizeCollectionPayload([document.item])[0] as T;
          try {
            await visitor(normalized, index);
          } catch (error) {
            callbackFailed = true;
            callbackError = error;
            throw error;
          }
          index += 1;
        }
      } finally {
        await closeMongoCursor(cursor);
      }
      await commitWithBoundedRetry(session);
      return {
        itemCount: index,
        observedBytes: Number(metadata.serializedBytes || 0),
        queryCount: 3,
      };
    } catch (error) {
      await abortIfActive(session);
      if (callbackFailed) throw callbackError;
      if (isStorageError(error)) throw error;
      throw storageError('MONGO_OPERATION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async readBoundedCollection<T>(
      collection: string,
      options: StorageBoundedCollectionOptions,
  ): Promise<T[]> {
    return (await this.readBoundedCollectionSnapshot<T>(collection, options)).items;
  }

  async readBoundedCollectionSnapshot<T>(
      collection: string,
      options: StorageBoundedCollectionOptions,
  ): Promise<StorageBoundedCollectionResult<T>> {
    recordBoundedRead();
    const safeCollection = validateCollectionName(collection);
    const { maximumItems, maximumBytes } = validateBoundedCollectionOptions(safeCollection, options);
    const db = await this.database();
    const session = await this.session();
    try {
      session.startTransaction();
      await assertMongoSchema(db, session);
      const metadata = await db.collection<MongoRevisionDocument>(MONGO_STORAGE_METADATA_COLLECTION)
          .findOne({ _id: safeCollection, kind: 'collection' }, { session });
      if (!metadata) {
        await commitWithBoundedRetry(session);
        return {
          items: [],
          metadata: {
            driver: 'mongo',
            collectionPresent: false,
            itemCount: 0,
            observedBytes: 0,
            maximumItems,
            maximumBytes,
            truncated: false,
            queryCount: 2,
          },
        };
      }
      if (
          !Number.isInteger(metadata.itemCount)
          || Number(metadata.itemCount) < 0
          || !Number.isInteger(metadata.serializedBytes)
          || Number(metadata.serializedBytes) < 2
      ) {
        throw boundedCollectionError('BOUNDED_COLLECTION_METADATA_INCOMPLETE', safeCollection);
      }
      if (Number(metadata.itemCount) > maximumItems) {
        throw boundedCollectionError('BOUNDED_COLLECTION_ITEM_LIMIT_EXCEEDED', safeCollection);
      }
      if (Number(metadata.serializedBytes) > maximumBytes) {
        throw boundedCollectionError('BOUNDED_COLLECTION_BYTE_LIMIT_EXCEEDED', safeCollection);
      }
      const cursor = configureMongoCursor(
          db.collection<MongoStoredItem>(safeCollection)
              .find({ revision: metadata.revision }, { session })
              .sort({ order: 1 })
              .limit(maximumItems + 1),
          Math.min(STREAMING_INSERT_BATCH_SIZE, maximumItems + 1),
      );
      const items: T[] = [];
      // Account for the JSON array delimiters up front, then admit one
      // normalized item at a time. This keeps client memory proportional to
      // the configured byte bound and closes the server cursor immediately
      // when either bound is crossed.
      let observedBytes = 2;
      try {
        if (observedBytes > maximumBytes) {
          throw boundedCollectionError('BOUNDED_COLLECTION_BYTE_LIMIT_EXCEEDED', safeCollection);
        }
        for await (const document of iterateMongoCursor(cursor)) {
          if (items.length >= maximumItems) {
            throw boundedCollectionError('BOUNDED_COLLECTION_ITEM_LIMIT_EXCEEDED', safeCollection);
          }
          const normalizedItem = normalizeCollectionPayload([document.item])[0] as T;
          const encodedItem = JSON.stringify(normalizedItem);
          if (encodedItem === undefined) throw storageError('INVALID_STORAGE_PAYLOAD');
          const itemBytes = Buffer.byteLength(encodedItem, 'utf8');
          const nextObservedBytes = observedBytes + itemBytes + (items.length > 0 ? 1 : 0);
          if (nextObservedBytes > maximumBytes) {
            throw boundedCollectionError('BOUNDED_COLLECTION_BYTE_LIMIT_EXCEEDED', safeCollection);
          }
          items.push(normalizedItem);
          observedBytes = nextObservedBytes;
        }
      } finally {
        await closeMongoCursor(cursor);
      }
      if (
          items.length !== metadata.itemCount
          || observedBytes !== metadata.serializedBytes
      ) {
        throw boundedCollectionError('BOUNDED_COLLECTION_METADATA_MISMATCH', safeCollection);
      }
      await commitWithBoundedRetry(session);
      return {
        items,
        metadata: {
          driver: 'mongo',
          collectionPresent: true,
          itemCount: items.length,
          observedBytes,
          maximumItems,
          maximumBytes,
          truncated: false,
          queryCount: 3,
        },
      };
    } catch (error) {
      await abortIfActive(session);
      if (
          isStorageError(error)
          || (
              error instanceof Error
              && typeof (error as Error & { code?: unknown }).code === 'string'
              && String((error as Error & { code?: string }).code).startsWith('BOUNDED_COLLECTION_')
          )
      ) {
        throw error;
      }
      throw storageError('MONGO_OPERATION_FAILED', error);
    } finally {
      await session.endSession();
    }
  }

  async bulkMutateCollection<T extends { id: string }>(
      collection: string,
      mutations: StorageBulkMutation<T>[],
      options: { optimized?: boolean } = {},
  ): Promise<StorageBulkResult> {
    let output!: StorageBulkResult;
    await this.runTransaction<T>(collection, items => {
      const applied = applyStorageBulkMutations(items, mutations);
      output = {
        schemaVersion: 1,
        driver: 'mongo',
        mode: options.optimized ? 'MONGO_OPT_IN_REVISION' : 'MONGO_COMPATIBILITY_REVISION',
        requested: mutations.length,
        applied: applied.applied,
        failed: applied.failed,
        results: applied.results,
      };
      return applied.applied > 0 ? applied.items : undefined;
    });
    return output;
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
    connection: MongoConnection = mongoConnection,
): MongoStorageAdapter {
  return new MongoStorageAdapter({ ...config }, connection);
}
