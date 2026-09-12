// Build-only replacement for the legacy factory in the Worker dependency graph.
// This module cannot construct File or Mongo storage, even outside a request scope.
import { currentStorageScope, RuntimeStorageError } from '../../storage/runtimeStorage';
export { withStorageAdapter } from '../../storage/runtimeStorage';
export function getStorageAdapter() {
  const adapter = currentStorageScope();
  if (!adapter || adapter.driver !== 'd1') throw new RuntimeStorageError('CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE');
  return adapter;
}
export function getDomainStorage() { return getStorageAdapter().domain!; }
