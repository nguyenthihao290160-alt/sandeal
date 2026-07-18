import { createHash } from 'crypto';

import { normalizeCollectionPayload } from './mongoSerialization';
import { storageError } from './storageErrors';

export interface RecordChecksum {
  readonly identity: string;
  readonly ordinal: number;
  readonly checksum: string;
}

function assertJsonCompatible(value: unknown, ancestors: Set<object>): void {
  const valueType = typeof value;
  if (
    valueType === 'undefined'
    || valueType === 'function'
    || valueType === 'symbol'
    || valueType === 'bigint'
    || (valueType === 'number' && !Number.isFinite(value as number))
  ) {
    throw storageError('INVALID_STORAGE_PAYLOAD');
  }
  if (value === null || valueType !== 'object') return;

  const objectValue = value as object;
  if (ancestors.has(objectValue)) throw storageError('INVALID_STORAGE_PAYLOAD');
  ancestors.add(objectValue);
  try {
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw storageError('INVALID_STORAGE_PAYLOAD');
    }
    for (const key of Object.keys(objectValue)) {
      assertJsonCompatible((objectValue as Record<string, unknown>)[key], ancestors);
    }
  } finally {
    ancestors.delete(objectValue);
  }
}

function normalizeJsonValue(value: unknown): unknown {
  assertJsonCompatible(value, new Set());
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw storageError('INVALID_STORAGE_PAYLOAD');
  return JSON.parse(encoded) as unknown;
}

function canonicalizeNormalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalizeNormalized(item));
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    canonical[key] = canonicalizeNormalized(source[key]);
  }
  return canonical;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeNormalized(normalizeJsonValue(value)));
}

export function checksumJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function normalizeDomainCollection(value: unknown): unknown[] {
  const normalized = normalizeCollectionPayload(value);
  for (const item of normalized) assertJsonCompatible(item, new Set());
  return normalized;
}

export function checksumCollection(value: unknown): string {
  return checksumJson(normalizeDomainCollection(value));
}

function recordIdentity(item: unknown, ordinal: number): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const id = (item as Record<string, unknown>).id;
    if (typeof id === 'string' && id !== '') return `id:${id}`;
  }
  return `ordinal:${ordinal}`;
}

export function checksumCollectionRecords(value: unknown): RecordChecksum[] {
  return normalizeDomainCollection(value).map((item, ordinal) => ({
    identity: recordIdentity(item, ordinal),
    ordinal,
    checksum: checksumJson(item),
  }));
}

