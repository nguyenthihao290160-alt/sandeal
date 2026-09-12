import { AsyncLocalStorage } from 'node:async_hooks';
import { getSandealRuntime, type SandealRuntime } from '../runtime/config';
import type { StorageAdapter } from './types';

/** Structural binding seam; no Cloudflare globals or SDK imports at module load. */
export interface D1Binding {
  prepare(query: string): unknown;
  batch(statements: unknown[]): Promise<unknown>;
}
export interface StorageDependencies {
  runtime: SandealRuntime | string;
  bindings?: { DB?: D1Binding };
  createD1?: (binding: D1Binding) => StorageAdapter;
}

export class RuntimeStorageError extends Error {
  constructor(readonly code: 'CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE' | 'D1_STORAGE_IMPLEMENTATION_UNAVAILABLE' | 'CLOUDFLARE_STORAGE_CAPABILITY_MISMATCH') {
    super(code);
  }
}

const requestStorage = new AsyncLocalStorage<StorageAdapter>();
export function currentStorageScope(): StorageAdapter | undefined {
  return requestStorage.getStore();
}

/** Explicit request/test scope, not a process-global binding or fallback. */
export function withStorageAdapter<T>(adapter: StorageAdapter, work: () => T): T {
  if (getSandealRuntime() === 'cloudflare' && adapter.driver !== 'd1') {
    throw new RuntimeStorageError('CLOUDFLARE_STORAGE_CAPABILITY_MISMATCH');
  }
  return requestStorage.run(adapter, work);
}

export function createRuntimeStorage(
  dependencies: StorageDependencies,
  createLegacy: () => StorageAdapter,
): StorageAdapter {
  const runtime = getSandealRuntime({ SANDEAL_RUNTIME: dependencies.runtime });
  if (runtime === 'legacy') return createLegacy();
  const binding = dependencies.bindings?.DB;
  if (!binding || typeof binding.prepare !== 'function' || typeof binding.batch !== 'function') {
    throw new RuntimeStorageError('CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE');
  }
  if (!dependencies.createD1) throw new RuntimeStorageError('D1_STORAGE_IMPLEMENTATION_UNAVAILABLE');
  const adapter = dependencies.createD1(binding);
  if (adapter.driver !== 'd1' || !adapter.domain?.capabilities.nativeIndexedQueries || !adapter.settingsStore) {
    throw new RuntimeStorageError('CLOUDFLARE_STORAGE_CAPABILITY_MISMATCH');
  }
  return adapter;
}
