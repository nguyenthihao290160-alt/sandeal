export type StorageDriver = 'file' | 'mongo';

export type StorageTransaction<T> = (
  items: T[]
) => Promise<T[] | undefined> | T[] | undefined;

/**
 * Mutate a collection one item at a time while the adapter owns its atomic
 * write boundary. The visitor must return true when it changed the item.
 * Implementations may retain only the current item and bounded bookkeeping.
 */
export type StorageStreamingTransaction<T> = (
  item: T,
  index: number,
) => Promise<boolean | void> | boolean | void;

export interface StorageStreamingTransactionOptions<T> {
  /** Optional bounded first pass executed under the same atomic boundary. */
  prepare?: StorageStreamingTransaction<T>;
  /** Runs after prepare and before the mutating pass, still under the boundary. */
  beforeMutation?: () => Promise<void> | void;
  /** Runs immediately before the atomic replacement/commit. */
  beforeCommit?: () => Promise<void> | void;
  /** Append bounded new records after the existing source has been transformed. */
  appendItems?: () => T[] | undefined;
  /**
   * The transaction is known to append only. Implementations may use a
   * bounded-copy append path, but must preserve the same atomic and durable
   * result as the normal streaming transaction.
   */
  appendOnly?: boolean;
}

export interface StoragePageOptions {
  page: number;
  pageSize: number;
  filters?: Record<string, string>;
  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
}

export interface StoragePage<T> {
  items: T[];
  totalItems: number;
  /**
   * Number of storage round trips used for this page. File storage reads the
   * compact collection once; Mongo verifies schema, reads the active revision,
   * and executes one bounded query.
   */
  queryCount: number;
}

export const STORAGE_MAX_PAGE_SIZE = 10_000;
export const STORAGE_MAX_BOUNDED_ITEMS = 10_000;
export const STORAGE_MAX_BOUNDED_BYTES = 32 * 1024 * 1024;

export interface StorageBoundedCollectionOptions {
  maximumItems: number;
  maximumBytes: number;
}

export interface StorageBoundedCollectionMetadata {
  driver: StorageDriver;
  collectionPresent: boolean;
  itemCount: number;
  observedBytes: number;
  maximumItems: number;
  maximumBytes: number;
  truncated: false;
  queryCount: number;
}

export interface StorageBoundedCollectionResult<T> {
  items: T[];
  metadata: StorageBoundedCollectionMetadata;
}

/**
 * Iterate a collection without materialising the durable array in memory.
 * The visitor is deliberately sequential: callers can keep a bounded
 * accumulator and preserve the same collection order on file and Mongo.
 */
export interface StorageScanResult {
  itemCount: number;
  observedBytes: number;
  queryCount: number;
}

export interface StorageHealth {
  readonly driver: StorageDriver;
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly healthy: boolean;
  readonly database?: string;
  readonly schemaVersion?: number | null;
  readonly expectedSchemaVersion?: number;
  readonly latencyMs?: number;
  readonly checkedAt: string;
  readonly errorCode?: string;
}

export interface StorageCapabilities {
  readonly schemaVersion: 1;
  readonly driver: StorageDriver;
  readonly transactions: boolean;
  readonly atomicCollectionRevision: boolean;
  readonly boundedBulkMutation: boolean;
  readonly partialFailureReporting: boolean;
  readonly nativeBulkWrite: boolean;
  readonly maximumBulkItems: number;
  readonly optimizedBulkFeatureFlag?: 'MONGO_BULK_WRITE';
}

export interface StorageBulkMutation<T extends { id: string }> {
  mutationId: string;
  type: 'UPSERT' | 'DELETE';
  itemId: string;
  value?: T;
}

export interface StorageBulkItemResult {
  mutationId: string;
  itemId: string;
  status: 'APPLIED' | 'FAILED';
  code:
    | 'UPSERTED'
    | 'DELETED'
    | 'ITEM_NOT_FOUND'
    | 'INVALID_MUTATION'
    | 'INVALID_VALUE'
    | 'DUPLICATE_MUTATION_ID'
    | 'DUPLICATE_TARGET';
}

export interface StorageBulkResult {
  schemaVersion: 1;
  driver: StorageDriver;
  mode: 'FILE_ATOMIC_REVISION' | 'MONGO_COMPATIBILITY_REVISION' | 'MONGO_OPT_IN_REVISION';
  requested: number;
  applied: number;
  failed: number;
  results: StorageBulkItemResult[];
}

export interface StorageAdapter {
  readonly driver: StorageDriver;
  readonly capabilities: StorageCapabilities;
  getDataDir(): string;
  ensureDataDir(): Promise<void>;
  readCollection<T>(collection: string): Promise<T[]>;
  scanCollection<T>(
    collection: string,
    visitor: (item: T, index: number) => Promise<void> | void,
  ): Promise<StorageScanResult>;
  /**
   * Read a deliberately compact read model. Implementations must reject the
   * read before parsing when the configured byte bound can be checked.
   */
  readBoundedCollection<T>(
    collection: string,
    options: StorageBoundedCollectionOptions,
  ): Promise<T[]>;
  readBoundedCollectionSnapshot<T>(
    collection: string,
    options: StorageBoundedCollectionOptions,
  ): Promise<StorageBoundedCollectionResult<T>>;
  readCollectionPage<T>(collection: string, options: StoragePageOptions): Promise<StoragePage<T>>;
  writeCollection<T>(collection: string, data: T[]): Promise<void>;
  backupCollection?(collection: string, label: string): Promise<string>;
  runTransaction<T>(collection: string, fn: StorageTransaction<T>): Promise<void>;
  runStreamingTransaction<T>(
    collection: string,
    fn: StorageStreamingTransaction<T>,
    options?: StorageStreamingTransactionOptions<T>,
  ): Promise<{ changed: boolean; itemCount: number }>;
  bulkMutateCollection?<T extends { id: string }>(
    collection: string,
    mutations: StorageBulkMutation<T>[],
    options?: { optimized?: boolean },
  ): Promise<StorageBulkResult>;
  checkHealth(): Promise<StorageHealth>;
}
