export type StorageDriver = 'file' | 'mongo';

export type StorageTransaction<T> = (
  items: T[]
) => Promise<T[] | undefined> | T[] | undefined;

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
   * capped read model once; Mongo reads the active revision and one facet.
   */
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
  readCollectionPage?<T>(collection: string, options: StoragePageOptions): Promise<StoragePage<T>>;
  writeCollection<T>(collection: string, data: T[]): Promise<void>;
  backupCollection?(collection: string, label: string): Promise<string>;
  runTransaction<T>(collection: string, fn: StorageTransaction<T>): Promise<void>;
  bulkMutateCollection?<T extends { id: string }>(
    collection: string,
    mutations: StorageBulkMutation<T>[],
    options?: { optimized?: boolean },
  ): Promise<StorageBulkResult>;
  checkHealth(): Promise<StorageHealth>;
}
