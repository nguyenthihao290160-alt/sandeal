import { checksumCollection, checksumJson, normalizeDomainCollection } from './migrationChecksum';

export type ShadowValidationStatus = 'MATCH' | 'MISMATCH' | 'BLOCKED' | 'UNREACHABLE';
export type ShadowCollectionPolicy = 'compare' | 'exclude' | 'checksum_only';

export interface ShadowCollectionSnapshot {
  readonly exists: boolean;
  readonly items: unknown[];
}

export interface ShadowSchemaReadiness {
  readonly version: number | null;
  readonly expectedVersion: number;
  readonly ready: boolean;
  readonly indexReady: boolean;
  readonly missingIndexes: ReadonlyArray<{ collection: string; name: string }>;
}

export interface ShadowCollectionReader {
  inspectCollection(collection: string): Promise<ShadowCollectionSnapshot>;
}

export interface ShadowTargetReader extends ShadowCollectionReader {
  inspectSchema(): Promise<ShadowSchemaReadiness>;
}

export interface ShadowCollectionPlan {
  readonly collection: string;
  readonly policy?: ShadowCollectionPolicy;
  readonly sensitive?: boolean;
}

export interface ShadowDifference {
  readonly collection: string;
  readonly kind:
    | 'TARGET_COLLECTION_MISSING'
    | 'TARGET_COLLECTION_EXTRA'
    | 'COUNT_MISMATCH'
    | 'CHECKSUM_MISMATCH'
    | 'ORDER_MISMATCH'
    | 'RECORD_MISSING'
    | 'RECORD_EXTRA'
    | 'RECORD_CHANGED';
  readonly identity?: string;
  readonly ordinal?: number;
  readonly path?: string;
  readonly status: 'MISSING' | 'EXTRA' | 'DIFFERENT';
  readonly redacted: boolean;
}

export interface ShadowCollectionReport {
  readonly collection: string;
  readonly policy: ShadowCollectionPolicy;
  readonly sourceExists: boolean | null;
  readonly targetExists: boolean | null;
  readonly sourceCount: number | null;
  readonly targetCount: number | null;
  readonly sourceChecksum: string | null;
  readonly targetChecksum: string | null;
  readonly countMatches: boolean | null;
  readonly checksumMatches: boolean | null;
  readonly orderMatches: boolean | null;
  readonly status: 'MATCH' | 'MISMATCH' | 'EXCLUDED';
}

export interface ShadowValidationReport {
  readonly status: ShadowValidationStatus;
  readonly checkedAt: string;
  readonly schema: ShadowSchemaReadiness | null;
  readonly collections: ShadowCollectionReport[];
  readonly differences: ShadowDifference[];
  readonly differenceCount: number;
  readonly maxDifferences: number;
  readonly truncated: boolean;
  readonly errorCode?: 'SHADOW_TIMEOUT' | 'SOURCE_READ_BLOCKED' | 'TARGET_UNREACHABLE' | 'SCHEMA_NOT_READY';
}

export interface ShadowValidationOptions {
  readonly source: ShadowCollectionReader;
  readonly target: ShadowTargetReader;
  readonly collections: readonly ShadowCollectionPlan[];
  readonly maxDifferences?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const SENSITIVE_FIELD_PATTERN = /(?:password|secret|token|apiKey|accessKey|refreshToken|authorization|cookie|session|uri|credential|encryptedPayload)/i;
const SENSITIVE_COLLECTIONS = new Set(['token-vault', 'credentials', 'credential-store', 'secrets']);

class ShadowTimeoutError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMongoStorageWrapper(value: unknown): value is Record<string, unknown> & { item: unknown } {
  if (!isObject(value)) return false;
  const allowed = new Set(['_id', 'revision', 'order', 'itemId', 'item', 'migrationId', 'migrationMetadata']);
  return Object.prototype.hasOwnProperty.call(value, 'item')
    && typeof value.revision === 'number'
    && typeof value.order === 'number'
    && Object.keys(value).every(key => allowed.has(key));
}

export function normalizeMongoDomainItems(items: unknown): unknown[] {
  const normalized = normalizeDomainCollection(items);
  return normalizeDomainCollection(normalized.map(item => isMongoStorageWrapper(item) ? item.item : item));
}

function sensitivePath(path: string): boolean {
  return path.split(/[.[\]]/).filter(Boolean).some(segment => SENSITIVE_FIELD_PATTERN.test(segment));
}

function differencePaths(left: unknown, right: unknown, prefix = '$', limit = 20): string[] {
  if (checksumJson(left) === checksumJson(right)) return [];
  if (limit <= 0) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths: string[] = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length && paths.length < limit; index += 1) {
      if (index >= left.length || index >= right.length) paths.push(`${prefix}[${index}]`);
      else paths.push(...differencePaths(left[index], right[index], `${prefix}[${index}]`, limit - paths.length));
    }
    return paths;
  }
  if (isObject(left) && isObject(right)) {
    const paths: string[] = [];
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (paths.length >= limit) break;
      const path = prefix === '$' ? key : `${prefix}.${key}`;
      if (!Object.prototype.hasOwnProperty.call(left, key) || !Object.prototype.hasOwnProperty.call(right, key)) {
        paths.push(path);
      } else {
        paths.push(...differencePaths(left[key], right[key], path, limit - paths.length));
      }
    }
    return paths;
  }
  return [prefix];
}

interface IndexedRecord {
  readonly key: string;
  readonly identity: string;
  readonly ordinal: number;
  readonly value: unknown;
  readonly checksum: string;
}

function indexedRecords(items: unknown[]): IndexedRecord[] {
  const occurrences = new Map<string, number>();
  return items.map((value, ordinal) => {
    const id = isObject(value) && typeof value.id === 'string' && value.id !== '' ? `id:${value.id}` : `ordinal:${ordinal}`;
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    return {
      key: `${id}#${occurrence}`,
      identity: id,
      ordinal,
      value,
      checksum: checksumJson(value),
    };
  });
}

function orderEquality(source: IndexedRecord[], target: IndexedRecord[]): boolean | null {
  if (source.length !== target.length) return false;
  const sourceHasStableIds = source.every(record => record.identity.startsWith('id:'));
  const targetHasStableIds = target.every(record => record.identity.startsWith('id:'));
  if (sourceHasStableIds && targetHasStableIds) {
    return source.every((record, index) => record.key === target[index].key);
  }
  const sourceChecksums = source.map(record => record.checksum);
  const targetChecksums = target.map(record => record.checksum);
  const sortedSourceChecksums = [...sourceChecksums].sort();
  const sortedTargetChecksums = [...targetChecksums].sort();
  const sameMembers = sortedSourceChecksums.every((value, index) => value === sortedTargetChecksums[index]);
  if (!sameMembers) return null;
  return sourceChecksums.every((value, index) => value === targetChecksums[index]);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ShadowTimeoutError('SHADOW_TIMEOUT')), timeoutMs);
    work.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function blockedReport(
  status: 'BLOCKED' | 'UNREACHABLE',
  errorCode: NonNullable<ShadowValidationReport['errorCode']>,
  checkedAt: string,
  maxDifferences: number,
  schema: ShadowSchemaReadiness | null = null
): ShadowValidationReport {
  return {
    status,
    checkedAt,
    schema,
    collections: [],
    differences: [],
    differenceCount: 0,
    maxDifferences,
    truncated: false,
    errorCode,
  };
}

export async function validateShadow(options: ShadowValidationOptions): Promise<ShadowValidationReport> {
  const maxDifferences = options.maxDifferences ?? 50;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(maxDifferences) || maxDifferences < 1 || maxDifferences > 1_000) {
    throw new Error('SHADOW_MAX_DIFFERENCES_INVALID');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) {
    throw new Error('SHADOW_TIMEOUT_INVALID');
  }
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));

  let schema: ShadowSchemaReadiness;
  try {
    schema = await withTimeout(options.target.inspectSchema(), remaining());
  } catch (error) {
    if (error instanceof ShadowTimeoutError) return blockedReport('BLOCKED', 'SHADOW_TIMEOUT', checkedAt, maxDifferences);
    return blockedReport('UNREACHABLE', 'TARGET_UNREACHABLE', checkedAt, maxDifferences);
  }
  if (!schema.ready || !schema.indexReady || schema.version !== schema.expectedVersion) {
    return blockedReport('BLOCKED', 'SCHEMA_NOT_READY', checkedAt, maxDifferences, schema);
  }

  const differences: ShadowDifference[] = [];
  let differenceCount = 0;
  const addDifference = (difference: ShadowDifference) => {
    differenceCount += 1;
    if (differences.length < maxDifferences) differences.push(difference);
  };
  const reports: ShadowCollectionReport[] = [];
  const plans = [...options.collections].sort((left, right) => left.collection.localeCompare(right.collection));

  for (const plan of plans) {
    const sensitive = plan.sensitive === true || SENSITIVE_COLLECTIONS.has(plan.collection.toLowerCase());
    const policy = sensitive && plan.policy === undefined ? 'exclude' : plan.policy ?? 'compare';
    if (policy === 'exclude') {
      reports.push({
        collection: plan.collection,
        policy,
        sourceExists: null,
        targetExists: null,
        sourceCount: null,
        targetCount: null,
        sourceChecksum: null,
        targetChecksum: null,
        countMatches: null,
        checksumMatches: null,
        orderMatches: null,
        status: 'EXCLUDED',
      });
      continue;
    }

    let sourceSnapshot: ShadowCollectionSnapshot;
    try {
      sourceSnapshot = await withTimeout(options.source.inspectCollection(plan.collection), remaining());
    } catch (error) {
      if (error instanceof ShadowTimeoutError) return blockedReport('BLOCKED', 'SHADOW_TIMEOUT', checkedAt, maxDifferences, schema);
      return blockedReport('BLOCKED', 'SOURCE_READ_BLOCKED', checkedAt, maxDifferences, schema);
    }
    let targetSnapshot: ShadowCollectionSnapshot;
    try {
      targetSnapshot = await withTimeout(options.target.inspectCollection(plan.collection), remaining());
    } catch (error) {
      if (error instanceof ShadowTimeoutError) return blockedReport('BLOCKED', 'SHADOW_TIMEOUT', checkedAt, maxDifferences, schema);
      return blockedReport('UNREACHABLE', 'TARGET_UNREACHABLE', checkedAt, maxDifferences, schema);
    }

    const sourceItems = normalizeMongoDomainItems(sourceSnapshot.items);
    const targetItems = normalizeMongoDomainItems(targetSnapshot.items);
    const sourceChecksum = checksumCollection(sourceItems);
    const targetChecksum = checksumCollection(targetItems);
    const sourceRecords = indexedRecords(sourceItems);
    const targetRecords = indexedRecords(targetItems);
    const countMatches = sourceItems.length === targetItems.length;
    const checksumMatches = sourceChecksum === targetChecksum;
    const orderMatches = orderEquality(sourceRecords, targetRecords);

    if (sourceSnapshot.exists && !targetSnapshot.exists) addDifference({
      collection: plan.collection,
      kind: 'TARGET_COLLECTION_MISSING',
      status: 'MISSING',
      redacted: sensitive,
    });
    if (!sourceSnapshot.exists && targetSnapshot.exists) addDifference({
      collection: plan.collection,
      kind: 'TARGET_COLLECTION_EXTRA',
      status: 'EXTRA',
      redacted: sensitive,
    });
    if (!countMatches) addDifference({
      collection: plan.collection,
      kind: 'COUNT_MISMATCH',
      status: 'DIFFERENT',
      redacted: sensitive,
    });
    if (!checksumMatches) addDifference({
      collection: plan.collection,
      kind: 'CHECKSUM_MISMATCH',
      status: 'DIFFERENT',
      redacted: sensitive,
    });
    if (orderMatches === false) addDifference({
      collection: plan.collection,
      kind: 'ORDER_MISMATCH',
      status: 'DIFFERENT',
      redacted: sensitive,
    });

    if (policy === 'compare') {
      const sourceMap = new Map(sourceRecords.map(record => [record.key, record]));
      const targetMap = new Map(targetRecords.map(record => [record.key, record]));
      for (const record of sourceRecords) {
        const targetRecord = targetMap.get(record.key);
        if (!targetRecord) {
          addDifference({
            collection: plan.collection,
            kind: 'RECORD_MISSING',
            identity: record.identity,
            ordinal: record.ordinal,
            status: 'MISSING',
            redacted: sensitive,
          });
          continue;
        }
        if (record.checksum !== targetRecord.checksum) {
          const paths = differencePaths(record.value, targetRecord.value, '$', Math.max(1, maxDifferences));
          for (const path of paths.length > 0 ? paths : ['$']) addDifference({
            collection: plan.collection,
            kind: 'RECORD_CHANGED',
            identity: record.identity,
            ordinal: record.ordinal,
            path,
            status: 'DIFFERENT',
            redacted: sensitive || sensitivePath(path),
          });
        }
      }
      for (const record of targetRecords) {
        if (!sourceMap.has(record.key)) addDifference({
          collection: plan.collection,
          kind: 'RECORD_EXTRA',
          identity: record.identity,
          ordinal: record.ordinal,
          status: 'EXTRA',
          redacted: sensitive,
        });
      }
    }

    const collectionMatches = sourceSnapshot.exists === targetSnapshot.exists && countMatches && checksumMatches;
    reports.push({
      collection: plan.collection,
      policy,
      sourceExists: sourceSnapshot.exists,
      targetExists: targetSnapshot.exists,
      sourceCount: sourceItems.length,
      targetCount: targetItems.length,
      sourceChecksum,
      targetChecksum,
      countMatches,
      checksumMatches,
      orderMatches,
      status: collectionMatches ? 'MATCH' : 'MISMATCH',
    });
  }

  return {
    status: reports.every(report => report.status !== 'MISMATCH') ? 'MATCH' : 'MISMATCH',
    checkedAt,
    schema,
    collections: reports,
    differences,
    differenceCount,
    maxDifferences,
    truncated: differenceCount > differences.length,
  };
}
