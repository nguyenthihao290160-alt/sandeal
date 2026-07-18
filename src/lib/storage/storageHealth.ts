import { getStorageAdapter } from './storageFactory';
import type { StorageHealth } from './types';

export function checkStorageHealth(): Promise<StorageHealth> {
  return getStorageAdapter().checkHealth();
}
