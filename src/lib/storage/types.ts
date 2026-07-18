export type StorageDriver = 'file' | 'mongo';

export type StorageTransaction<T> = (
  items: T[]
) => Promise<T[] | undefined> | T[] | undefined;

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
  writeCollection<T>(collection: string, data: T[]): Promise<void>;
  runTransaction<T>(collection: string, fn: StorageTransaction<T>): Promise<void>;
  checkHealth(): Promise<StorageHealth>;
}
