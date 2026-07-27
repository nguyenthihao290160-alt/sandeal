import { normalizeCollectionPayload } from './mongoSerialization';
import type {
  StorageBulkItemResult,
  StorageBulkMutation,
} from './types';

export const STORAGE_BULK_SCHEMA_VERSION = 1;
export const STORAGE_BULK_MAX_ITEMS = 100;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/;
const MAX_ITEM_BYTES = 64 * 1024;

export interface AppliedStorageBulk<T extends { id: string }> {
  items: T[];
  results: StorageBulkItemResult[];
  applied: number;
  failed: number;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function normalizedValue<T extends { id: string }>(
  value: unknown,
  expectedId: string,
): T | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if ((value as { id?: unknown }).id !== expectedId) return undefined;
  try {
    const [normalized] = normalizeCollectionPayload([value]);
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_ITEM_BYTES) return undefined;
    return normalized as T;
  } catch {
    return undefined;
  }
}

export function validateStorageBulkSize(
  mutations: unknown,
): asserts mutations is StorageBulkMutation<{ id: string }>[] {
  if (
    !Array.isArray(mutations)
    || mutations.length === 0
    || mutations.length > STORAGE_BULK_MAX_ITEMS
  ) {
    throw new Error('STORAGE_BULK_SIZE_INVALID');
  }
}

export function applyStorageBulkMutations<T extends { id: string }>(
  current: T[],
  mutations: StorageBulkMutation<T>[],
): AppliedStorageBulk<T> {
  validateStorageBulkSize(mutations);
  const items = [...current];
  const results: StorageBulkItemResult[] = [];
  const mutationIds = new Set<string>();
  const targets = new Set<string>();

  for (const mutation of mutations) {
    const mutationId = validId(mutation?.mutationId) ? mutation.mutationId : 'invalid';
    const itemId = validId(mutation?.itemId) ? mutation.itemId : 'invalid';
    let code: StorageBulkItemResult['code'] | undefined;

    if (
      !mutation
      || !validId(mutation.mutationId)
      || !validId(mutation.itemId)
      || !['UPSERT', 'DELETE'].includes(mutation.type)
    ) {
      code = 'INVALID_MUTATION';
    } else if (mutationIds.has(mutation.mutationId)) {
      code = 'DUPLICATE_MUTATION_ID';
    } else if (targets.has(mutation.itemId)) {
      code = 'DUPLICATE_TARGET';
    }

    if (validId(mutation?.mutationId)) mutationIds.add(mutation.mutationId);
    if (validId(mutation?.itemId)) targets.add(mutation.itemId);
    if (code) {
      results.push({ mutationId, itemId, status: 'FAILED', code });
      continue;
    }

    const index = items.findIndex(item => item.id === mutation.itemId);
    if (mutation.type === 'DELETE') {
      if (index < 0) {
        results.push({ mutationId, itemId, status: 'FAILED', code: 'ITEM_NOT_FOUND' });
      } else {
        items.splice(index, 1);
        results.push({ mutationId, itemId, status: 'APPLIED', code: 'DELETED' });
      }
      continue;
    }

    const value = normalizedValue<T>(mutation.value, mutation.itemId);
    if (!value) {
      results.push({ mutationId, itemId, status: 'FAILED', code: 'INVALID_VALUE' });
      continue;
    }
    if (index < 0) items.push(value);
    else items[index] = value;
    results.push({ mutationId, itemId, status: 'APPLIED', code: 'UPSERTED' });
  }

  const applied = results.filter(result => result.status === 'APPLIED').length;
  return {
    items,
    results,
    applied,
    failed: results.length - applied,
  };
}
