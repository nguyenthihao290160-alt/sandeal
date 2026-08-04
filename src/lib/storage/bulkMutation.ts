import { normalizeCollectionPayload } from './mongoSerialization';
import { storageError } from './storageErrors';
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

function storageBulkSizeError(): Error {
  const error = new Error('STORAGE_BULK_SIZE_INVALID') as Error & {
    code?: string;
  };
  error.code = 'STORAGE_BULK_SIZE_INVALID';
  return error;
}

function normalizedValue<T extends { id: string }>(
    value: unknown,
    expectedId: string,
): T | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  if ((value as { id?: unknown }).id !== expectedId) return undefined;

  try {
    const [normalized] = normalizeCollectionPayload([value]);
    const encoded = JSON.stringify(normalized);
    if (
        encoded === undefined
        || Buffer.byteLength(encoded, 'utf8') > MAX_ITEM_BYTES
    ) {
      return undefined;
    }
    return normalized as T;
  } catch {
    return undefined;
  }
}

function buildCurrentItemIndex<T extends { id: string }>(
    current: T[],
): {
  items: Array<T | undefined>;
  itemIndexes: Map<string, number>;
} {
  if (!Array.isArray(current)) {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }

  const items: Array<T | undefined> = [...current];
  const itemIndexes = new Map<string, number>();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (
        !item
        || typeof item !== 'object'
        || Array.isArray(item)
        || typeof item.id !== 'string'
        || item.id.length === 0
        || itemIndexes.has(item.id)
    ) {
      // Bulk mutation cannot safely address a collection with missing or
      // duplicate durable identities. Fail before applying any mutation.
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }
    itemIndexes.set(item.id, index);
  }

  return { items, itemIndexes };
}

export function validateStorageBulkSize(
    mutations: unknown,
): asserts mutations is StorageBulkMutation<{ id: string }>[] {
  if (
      !Array.isArray(mutations)
      || mutations.length === 0
      || mutations.length > STORAGE_BULK_MAX_ITEMS
  ) {
    throw storageBulkSizeError();
  }
}

export function applyStorageBulkMutations<T extends { id: string }>(
    current: T[],
    mutations: StorageBulkMutation<T>[],
): AppliedStorageBulk<T> {
  validateStorageBulkSize(mutations);

  const { items, itemIndexes } = buildCurrentItemIndex(current);
  const results: StorageBulkItemResult[] = [];
  const mutationIds = new Set<string>();
  const targets = new Set<string>();
  let applied = 0;

  for (const mutation of mutations) {
    const mutationId = validId(mutation?.mutationId)
        ? mutation.mutationId
        : 'invalid';
    const itemId = validId(mutation?.itemId)
        ? mutation.itemId
        : 'invalid';
    let code: StorageBulkItemResult['code'] | undefined;

    if (
        !mutation
        || !validId(mutation.mutationId)
        || !validId(mutation.itemId)
        || (mutation.type !== 'UPSERT' && mutation.type !== 'DELETE')
    ) {
      code = 'INVALID_MUTATION';
    } else if (mutationIds.has(mutation.mutationId)) {
      code = 'DUPLICATE_MUTATION_ID';
    } else if (targets.has(mutation.itemId)) {
      code = 'DUPLICATE_TARGET';
    }

    // Reserve every syntactically valid mutation ID and target, including
    // entries that later fail semantic validation. This keeps one batch
    // deterministic and prevents a later entry from reusing the same identity.
    if (validId(mutation?.mutationId)) {
      mutationIds.add(mutation.mutationId);
    }
    if (validId(mutation?.itemId)) {
      targets.add(mutation.itemId);
    }

    if (code) {
      results.push({
        mutationId,
        itemId,
        status: 'FAILED',
        code,
      });
      continue;
    }

    const index = itemIndexes.get(mutation.itemId);

    if (mutation.type === 'DELETE') {
      if (index === undefined) {
        results.push({
          mutationId,
          itemId,
          status: 'FAILED',
          code: 'ITEM_NOT_FOUND',
        });
      } else {
        items[index] = undefined;
        itemIndexes.delete(mutation.itemId);
        applied += 1;
        results.push({
          mutationId,
          itemId,
          status: 'APPLIED',
          code: 'DELETED',
        });
      }
      continue;
    }

    const value = normalizedValue<T>(mutation.value, mutation.itemId);
    if (!value) {
      results.push({
        mutationId,
        itemId,
        status: 'FAILED',
        code: 'INVALID_VALUE',
      });
      continue;
    }

    if (index === undefined) {
      itemIndexes.set(mutation.itemId, items.length);
      items.push(value);
    } else {
      items[index] = value;
    }

    applied += 1;
    results.push({
      mutationId,
      itemId,
      status: 'APPLIED',
      code: 'UPSERTED',
    });
  }

  return {
    items: items.filter((item): item is T => item !== undefined),
    results,
    applied,
    failed: results.length - applied,
  };
}
