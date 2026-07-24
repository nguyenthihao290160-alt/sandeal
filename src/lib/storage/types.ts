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

export interface StorageAdapter {
  readonly driver: StorageDriver;
  getDataDir(): string;
  ensureDataDir(): Promise<void>;
  readCollection<T>(collection: string): Promise<T[]>;
  readCollectionPage?<T>(collection: string, options: StoragePageOptions): Promise<StoragePage<T>>;
  writeCollection<T>(collection: string, data: T[]): Promise<void>;
  backupCollection?(collection: string, label: string): Promise<string>;
  runTransaction<T>(collection: string, fn: StorageTransaction<T>): Promise<void>;
  checkHealth(): Promise<StorageHealth>;
}
