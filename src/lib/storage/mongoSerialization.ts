import type { Document } from 'mongodb';

import { isStorageError, storageError } from './storageErrors';

const MAX_COLLECTION_NAME_BYTES = 120;
const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface MongoStoredItem extends Document {
  revision: number;
  order: number;
  itemId: string | null;
  item: unknown;
}

export function validateCollectionName(collection: string): string {
  if (
    typeof collection !== 'string'
    || collection === ''
    || Buffer.byteLength(collection, 'utf8') > MAX_COLLECTION_NAME_BYTES
    || collection.includes('\0')
    || collection.includes('$')
    || collection.toLowerCase().startsWith('system.')
    || !COLLECTION_NAME_PATTERN.test(collection)
  ) {
    throw storageError('INVALID_COLLECTION_NAME');
  }
  return collection;
}

function assertJsonSafe(value: unknown, ancestors: Set<object>): void {
  const valueType = typeof value;
  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }
  if (value === null || valueType !== 'object') return;

  const objectValue = value as object;
  if (ancestors.has(objectValue)) throw storageError('INVALID_STORAGE_PAYLOAD');
  ancestors.add(objectValue);
  try {
    if (Object.getOwnPropertySymbols(objectValue).length > 0) throw storageError('INVALID_STORAGE_PAYLOAD');
    for (const key of Object.keys(objectValue)) {
      assertJsonSafe((objectValue as Record<string, unknown>)[key], ancestors);
    }
  } finally {
    ancestors.delete(objectValue);
  }
}

export function normalizeCollectionPayload(data: unknown): unknown[] {
  if (!Array.isArray(data)) throw storageError('INVALID_STORAGE_PAYLOAD');
  assertJsonSafe(data, new Set());
  try {
    const encoded = JSON.stringify(data);
    if (encoded === undefined) throw storageError('INVALID_STORAGE_PAYLOAD');
    const normalized = JSON.parse(encoded) as unknown;
    if (!Array.isArray(normalized)) throw storageError('INVALID_STORAGE_PAYLOAD');
    return normalized;
  } catch (error) {
    if (isStorageError(error)) throw error;
    throw storageError('INVALID_STORAGE_PAYLOAD', error);
  }
}

function domainItemId(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = (item as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

export function serializeMongoItems(data: unknown, revision: number): MongoStoredItem[] {
  return normalizeCollectionPayload(data).map((item, order) => ({
    revision,
    order,
    itemId: domainItemId(item),
    item,
  }));
}

export function deserializeMongoItems<T>(documents: MongoStoredItem[]): T[] {
  const ordered = [...documents].sort((left, right) => left.order - right.order);
  return normalizeCollectionPayload(ordered.map(document => document.item)) as T[];
}
