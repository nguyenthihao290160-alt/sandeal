import type { Document } from 'mongodb';

import { isStorageError, storageError } from './storageErrors';

const MAX_COLLECTION_NAME_BYTES = 120;
const MAX_JSON_DEPTH = 128;
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

function assertJsonSafe(
    value: unknown,
    ancestors: Set<object>,
    depth = 0,
): void {
  if (depth > MAX_JSON_DEPTH) {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }

  const valueType = typeof value;
  if (
      valueType === 'undefined'
      || valueType === 'function'
      || valueType === 'symbol'
      || valueType === 'bigint'
  ) {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }

  if (valueType === 'number' && !Number.isFinite(value)) {
    // JSON.stringify silently converts NaN and infinities to null. Reject the
    // payload instead of allowing an unnoticed durable data change.
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }

  if (value === null || valueType !== 'object') return;

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }

  ancestors.add(objectValue);
  try {
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }

    if (Array.isArray(value)) {
      // Sparse arrays are converted to arrays containing null by JSON.stringify.
      // Extra named properties are omitted. Both cases would silently alter the
      // durable value, so require a dense, ordinary JSON array.
      if (Object.keys(value).length !== value.length) {
        throw storageError('INVALID_STORAGE_PAYLOAD');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw storageError('INVALID_STORAGE_PAYLOAD');
        }
        assertJsonSafe(value[index], ancestors, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) {
      // Dates, Maps, Sets, Buffers, and class instances can invoke toJSON or
      // otherwise serialize into a shape different from their in-memory form.
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }

    const descriptors = Object.getOwnPropertyDescriptors(objectValue);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
          !descriptor.enumerable
          || !('value' in descriptor)
          || descriptor.get !== undefined
          || descriptor.set !== undefined
      ) {
        throw storageError('INVALID_STORAGE_PAYLOAD');
      }
      assertJsonSafe(descriptor.value, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(objectValue);
  }
}

export function normalizeCollectionPayload(data: unknown): unknown[] {
  if (!Array.isArray(data)) {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }

  assertJsonSafe(data, new Set());

  try {
    const encoded = JSON.stringify(data);
    if (encoded === undefined) {
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }

    const normalized = JSON.parse(encoded) as unknown;
    if (!Array.isArray(normalized)) {
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }
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

function assertMongoRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }
}

function assertStoredDocuments(documents: MongoStoredItem[]): void {
  let expectedRevision: number | undefined;
  const observedOrders = new Set<number>();

  for (const document of documents) {
    if (
        !Number.isSafeInteger(document.revision)
        || document.revision <= 0
        || !Number.isSafeInteger(document.order)
        || document.order < 0
        || observedOrders.has(document.order)
    ) {
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }

    expectedRevision ??= document.revision;
    if (document.revision !== expectedRevision) {
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }
    observedOrders.add(document.order);
  }
}

export function serializeMongoItems(
    data: unknown,
    revision: number,
): MongoStoredItem[] {
  assertMongoRevision(revision);

  return normalizeCollectionPayload(data).map((item, order) => ({
    revision,
    order,
    itemId: domainItemId(item),
    item,
  }));
}

export function deserializeMongoItems<T>(
    documents: MongoStoredItem[],
): T[] {
  assertStoredDocuments(documents);
  const ordered = [...documents].sort((left, right) => left.order - right.order);
  return normalizeCollectionPayload(
      ordered.map(document => document.item),
  ) as T[];
}
