import { createHash } from 'node:crypto';

import {
  getStorageCapabilities,
  readBoundedCollectionSnapshot,
  runExclusive,
  runStreamingTransaction,
  runTransaction,
} from '@/lib/storage/adapter';
import type { StorageCommitGuard, StorageExclusiveHandle } from '@/lib/storage/types';
import type { AutomationJob, AutomationJobStatus, AutomationJobType } from './types';

export const AUTOMATION_JOB_HISTORY_MANIFEST_NAME = 'automation-job-history-manifest-v1';
export const AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX = 'automation-job-history-v1-';
export const AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX = 'automation-job-history-idempotency-v1-';
export const AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME = 'automation-job-history-publication-intent-v1';
export const AUTOMATION_JOB_HISTORY_COORDINATOR_SCOPE = 'automation-job-history-publication-v1';

const HISTORY_SCHEMA_VERSION = 1;
const HISTORY_SHARD_COUNT = 128;
const HISTORY_SEGMENT_MAX_ITEMS = 1_024;
const HISTORY_SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_INDEX_MAX_ITEMS = 4_096;
const HISTORY_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_MANIFEST_MAX_BYTES = 512 * 1024;
const HISTORY_PUBLICATION_INTENT_MAX_ITEMS = 256;
const HISTORY_PUBLICATION_INTENT_MAX_BYTES = 4 * 1024 * 1024;
const HISTORY_PUBLICATION_INTENT_MAX_RECORDS = 250;
const TERMINAL_STATUSES = new Set<AutomationJobStatus>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
]);
const AUTOMATION_JOB_TYPES: Readonly<Record<AutomationJobType, true>> = Object.freeze({
  PRODUCT_SCAN: true,
  AUTO_PILOT: true,
  PROCESS_CANDIDATE: true,
  AUTO_SAFE_PUBLISH: true,
  POST_PUBLISH_MONITOR: true,
  RECONCILE_AUTOMATION: true,
  RUNTIME_GUARDIAN: true,
  SAFE_PUBLISH: true,
  AI_ANALYSIS: true,
  HEALTH_CHECK: true,
  IMPORT_PRODUCTS: true,
  RECHECK_PRODUCT_HEALTH: true,
  DETECT_DUPLICATES: true,
  SCORE_PRODUCTS: true,
  CAPTURE_PRICE_HISTORY: true,
  PREPARE_CONTENT_DRAFT: true,
  EDITORIAL_CHECK: true,
  EVALUATE_ALERTS: true,
  AGGREGATE_GROWTH_METRICS: true,
  BULK_PRODUCT_OPERATION: true,
});

type TerminalAutomationJobStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';

export interface AutomationJobHistoryRecord {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  id: string;
  jobId: string;
  jobFingerprint: string;
  archivedAt: string;
  job: AutomationJob;
}

export interface AutomationJobHistoryIdempotencyRecord {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  id: string;
  keyDigest: string;
  jobId: string;
  jobFingerprint: string;
  jobType: AutomationJobType;
  completedAt: string;
  archivedAt: string;
}

export interface AutomationJobHistoryStatusCounts {
  SUCCEEDED: number;
  FAILED: number;
  CANCELLED: number;
  BLOCKED: number;
}

export interface AutomationJobHistorySegmentManifest {
  collection: string;
  itemCount: number;
  contentFingerprint: string;
  statusCounts: AutomationJobHistoryStatusCounts;
}

export interface AutomationJobHistoryManifest {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  id: 'automation-job-history-manifest';
  shardCount: typeof HISTORY_SHARD_COUNT;
  segmentMaximumItems: typeof HISTORY_SEGMENT_MAX_ITEMS;
  segmentMaximumBytes: typeof HISTORY_SEGMENT_MAX_BYTES;
  archivedVersions: number;
  statusCounts: AutomationJobHistoryStatusCounts;
  segments: AutomationJobHistorySegmentManifest[];
  /** Monotonic publication generation. Per-segment itemCount remains the stale-writer generation. */
  manifestGeneration?: number;
  updatedAt: string;
}

export interface AutomationJobHistoryPublicationRecordRef {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  recordId: string;
  segmentCollection: string;
  indexCollection: string;
  keyDigest: string;
  jobId: string;
  jobFingerprint: string;
}

export interface AutomationJobHistoryPublicationIntent {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  id: string;
  records: AutomationJobHistoryPublicationRecordRef[];
  createdAt: string;
}

export interface AutomationJobHistorySegmentSnapshot {
  collection: string;
  collectionPresent: boolean;
  records: AutomationJobHistoryRecord[];
  itemCount: number;
  contentFingerprint: string;
  statusCounts: AutomationJobHistoryStatusCounts;
}

export interface AutomationJobHistoryArchiveResult {
  created: boolean;
  collection: string;
  record: AutomationJobHistoryRecord;
  segmentItemCount: number;
  segmentContentFingerprint: string;
}

export type AutomationJobHistoryTestPhase =
  | 'BEFORE_SEGMENT_COMMIT'
  | 'AFTER_SEGMENT_COMMIT'
  | 'BEFORE_INDEX_COMMIT'
  | 'AFTER_INDEX_COMMIT'
  | 'BEFORE_MANIFEST_COMMIT'
  | 'AFTER_MANIFEST_COMMIT'
  | 'READER_COHERENCE_BARRIER';

type AutomationJobHistoryTestHook = (input: {
  phase: AutomationJobHistoryTestPhase;
  collection?: string;
}) => Promise<void> | void;

let automationJobHistoryTestHook: AutomationJobHistoryTestHook | undefined;

export function setAutomationJobHistoryTestHookForTests(
    hook: AutomationJobHistoryTestHook | undefined,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('AUTOMATION_JOB_HISTORY_TEST_HOOK_FORBIDDEN');
  }
  automationJobHistoryTestHook = hook;
}

async function invokeAutomationJobHistoryTestHook(
    phase: AutomationJobHistoryTestPhase,
    collection?: string,
): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || !automationJobHistoryTestHook) return;
  await automationJobHistoryTestHook({ phase, collection });
}

function emptyStatusCounts(): AutomationJobHistoryStatusCounts {
  return { SUCCEEDED: 0, FAILED: 0, CANCELLED: 0, BLOCKED: 0 };
}

function assertFileHistoryStorage(): void {
  if (getStorageCapabilities().driver !== 'file') {
    throw new Error('AUTOMATION_JOB_HISTORY_FILE_STORAGE_REQUIRED');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('AUTOMATION_JOB_HISTORY_UNSERIALIZABLE');
  return JSON.parse(encoded) as unknown;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function automationJobHistoryCanonicalFingerprint(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(normalizedJson(value))));
}

const fingerprint = automationJobHistoryCanonicalFingerprint;

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function historyRecordId(jobId: string, jobFingerprint: string): string {
  return sha256(`automation-job-history-record\u0000${jobId}\u0000${jobFingerprint}`);
}

function idempotencyKeyDigest(type: AutomationJobType, idempotencyKey: string): string {
  return sha256(`automation-job-idempotency\u0000${type}\u0000${idempotencyKey}`);
}

function idempotencyRecordId(keyDigest: string, jobId: string, jobFingerprint: string): string {
  return sha256(`automation-job-idempotency-record\u0000${keyDigest}\u0000${jobId}\u0000${jobFingerprint}`);
}

function shardHex(value: string): string {
  return (Number.parseInt(sha256(value).slice(0, 2), 16) % HISTORY_SHARD_COUNT)
      .toString(16)
      .padStart(2, '0');
}

export function automationJobHistorySegmentCollection(jobId: string): string {
  return `${AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}${shardHex(jobId)}`;
}

function allAutomationJobHistorySegmentCollections(): string[] {
  return Array.from(
      { length: HISTORY_SHARD_COUNT },
      (_, index) => `${AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}${index.toString(16).padStart(2, '0')}`,
  );
}

export function automationJobHistoryIdempotencyCollection(keyDigest: string): string {
  if (!/^[a-f0-9]{64}$/.test(keyDigest)) {
    throw new Error('AUTOMATION_JOB_HISTORY_INDEX_KEY_DIGEST_INVALID');
  }
  return `${AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX}${keyDigest.slice(0, 2)}`;
}

export function isTerminalAutomationJobStatus(status: AutomationJobStatus): status is TerminalAutomationJobStatus {
  return TERMINAL_STATUSES.has(status);
}

function isAutomationJobType(value: unknown): value is AutomationJobType {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(AUTOMATION_JOB_TYPES, value);
}

export function automationJobHistoryFingerprint(job: AutomationJob): string {
  return fingerprint(job);
}

export function automationJobHistoryBatchFingerprint(jobs: readonly AutomationJob[]): string {
  return fingerprint(jobs
      .map(job => [job.id, automationJobHistoryFingerprint(job)])
      .sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function assertArchivableJob(job: AutomationJob): void {
  if (!job || typeof job !== 'object') throw new Error('AUTOMATION_JOB_HISTORY_JOB_INVALID');
  if (typeof job.id !== 'string' || !job.id.trim() || job.id.length > 200) {
    throw new Error('AUTOMATION_JOB_HISTORY_JOB_ID_INVALID');
  }
  if (!isTerminalAutomationJobStatus(job.status)) {
    throw new Error('AUTOMATION_JOB_HISTORY_JOB_NOT_TERMINAL');
  }
  if (!isAutomationJobType(job.type)) {
    throw new Error('AUTOMATION_JOB_HISTORY_JOB_TYPE_INVALID');
  }
  if (!validTimestamp(job.createdAt) || !validTimestamp(job.updatedAt)) {
    throw new Error('AUTOMATION_JOB_HISTORY_TIMESTAMP_INVALID');
  }
  if (job.completedAt !== undefined && !validTimestamp(job.completedAt)) {
    throw new Error('AUTOMATION_JOB_HISTORY_TIMESTAMP_INVALID');
  }
  if (typeof job.operationId !== 'string' || !job.operationId.trim()) {
    throw new Error('AUTOMATION_JOB_HISTORY_OPERATION_ID_INVALID');
  }
  if (typeof job.idempotencyKey !== 'string' || !job.idempotencyKey.trim()) {
    throw new Error('AUTOMATION_JOB_HISTORY_IDEMPOTENCY_INVALID');
  }
  normalizedJson(job);
}

export function assertAutomationJobHistoryArchivable(job: AutomationJob): void {
  assertArchivableJob(job);
}

function makeHistoryRecord(job: AutomationJob, nowMs: number): AutomationJobHistoryRecord {
  assertArchivableJob(job);
  const durableJob = normalizedJson(job) as AutomationJob;
  const jobFingerprint = automationJobHistoryFingerprint(durableJob);
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id: historyRecordId(durableJob.id, jobFingerprint),
    jobId: durableJob.id,
    jobFingerprint,
    archivedAt: new Date(nowMs).toISOString(),
    job: durableJob,
  };
}

export function assertAutomationJobHistoryRecord(value: unknown): asserts value is AutomationJobHistoryRecord {
  if (!value || typeof value !== 'object') throw new Error('AUTOMATION_JOB_HISTORY_RECORD_INVALID');
  const record = value as Partial<AutomationJobHistoryRecord>;
  if (
    record.schemaVersion !== HISTORY_SCHEMA_VERSION
    || typeof record.id !== 'string'
    || typeof record.jobId !== 'string'
    || typeof record.jobFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.jobFingerprint)
    || !validTimestamp(record.archivedAt)
    || !record.job
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_RECORD_INVALID');
  }
  assertArchivableJob(record.job);
  if (
    record.job.id !== record.jobId
    || automationJobHistoryFingerprint(record.job) !== record.jobFingerprint
    || historyRecordId(record.jobId, record.jobFingerprint) !== record.id
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_FINGERPRINT_MISMATCH');
  }
}

export function assertAutomationJobHistoryIdempotencyRecord(
    value: unknown,
): asserts value is AutomationJobHistoryIdempotencyRecord {
  if (!value || typeof value !== 'object') throw new Error('AUTOMATION_JOB_HISTORY_INDEX_INVALID');
  const record = value as Partial<AutomationJobHistoryIdempotencyRecord>;
  if (
    record.schemaVersion !== HISTORY_SCHEMA_VERSION
    || typeof record.id !== 'string'
    || typeof record.keyDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.keyDigest)
    || typeof record.jobId !== 'string'
    || !record.jobId
    || record.jobId.length > 200
    || typeof record.jobFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.jobFingerprint)
    || !isAutomationJobType(record.jobType)
    || !validTimestamp(record.completedAt)
    || !validTimestamp(record.archivedAt)
    || idempotencyRecordId(record.keyDigest, record.jobId, record.jobFingerprint) !== record.id
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_INDEX_INVALID');
  }
}

export function automationJobHistoryStatusCounts(
    records: readonly AutomationJobHistoryRecord[],
): AutomationJobHistoryStatusCounts {
  const counts = emptyStatusCounts();
  for (const record of records) counts[record.job.status as TerminalAutomationJobStatus] += 1;
  return counts;
}

function addStatusCounts(
    left: AutomationJobHistoryStatusCounts,
    right: AutomationJobHistoryStatusCounts,
): AutomationJobHistoryStatusCounts {
  return {
    SUCCEEDED: left.SUCCEEDED + right.SUCCEEDED,
    FAILED: left.FAILED + right.FAILED,
    CANCELLED: left.CANCELLED + right.CANCELLED,
    BLOCKED: left.BLOCKED + right.BLOCKED,
  };
}

export function automationJobHistorySegmentFingerprint(
    records: readonly AutomationJobHistoryRecord[],
): string {
  return fingerprint(records
      .map(record => [record.id, record.jobFingerprint, record.archivedAt])
      .sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function validateHistorySegmentRecords(
    records: readonly AutomationJobHistoryRecord[],
    collection: string,
): void {
  if (!new RegExp(`^${AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}[a-f0-9]{2}$`).test(collection)) {
    throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_NAME_INVALID');
  }
  if (records.length > HISTORY_SEGMENT_MAX_ITEMS) {
    throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_ITEM_LIMIT_EXCEEDED');
  }
  const ids = new Set<string>();
  for (const record of records) {
    assertAutomationJobHistoryRecord(record);
    if (automationJobHistorySegmentCollection(record.jobId) !== collection) {
      throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_SHARD_MISMATCH');
    }
    if (ids.has(record.id)) throw new Error('AUTOMATION_JOB_HISTORY_DUPLICATE_RECORD');
    ids.add(record.id);
  }
}

export async function readAutomationJobHistorySegment(
    collection: string,
): Promise<AutomationJobHistorySegmentSnapshot> {
  const snapshot = await readBoundedCollectionSnapshot<AutomationJobHistoryRecord>(collection, {
    maximumItems: HISTORY_SEGMENT_MAX_ITEMS,
    maximumBytes: HISTORY_SEGMENT_MAX_BYTES,
  });
  validateHistorySegmentRecords(snapshot.items, collection);
  return {
    collection,
    collectionPresent: snapshot.metadata.collectionPresent,
    records: snapshot.items,
    itemCount: snapshot.items.length,
    contentFingerprint: automationJobHistorySegmentFingerprint(snapshot.items),
    statusCounts: automationJobHistoryStatusCounts(snapshot.items),
  };
}

export function automationJobHistoryManifestTotals(
    segments: readonly AutomationJobHistorySegmentManifest[],
): {
  archivedVersions: number;
  statusCounts: AutomationJobHistoryStatusCounts;
} {
  return segments.reduce((output, segment) => ({
    archivedVersions: output.archivedVersions + segment.itemCount,
    statusCounts: addStatusCounts(output.statusCounts, segment.statusCounts),
  }), { archivedVersions: 0, statusCounts: emptyStatusCounts() });
}

function assertStatusCounts(value: unknown): asserts value is AutomationJobHistoryStatusCounts {
  if (!value || typeof value !== 'object') throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.join(',') !== [...TERMINAL_STATUSES].sort().join(',')) {
    throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
  }
  for (const status of TERMINAL_STATUSES) {
    const count = (value as Record<string, unknown>)[status];
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
    }
  }
}

export function assertAutomationJobHistoryManifest(
    value: unknown,
): asserts value is AutomationJobHistoryManifest {
  if (!value || typeof value !== 'object') throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
  const manifest = value as Partial<AutomationJobHistoryManifest>;
  if (
    manifest.schemaVersion !== HISTORY_SCHEMA_VERSION
    || manifest.id !== 'automation-job-history-manifest'
    || manifest.shardCount !== HISTORY_SHARD_COUNT
    || manifest.segmentMaximumItems !== HISTORY_SEGMENT_MAX_ITEMS
    || manifest.segmentMaximumBytes !== HISTORY_SEGMENT_MAX_BYTES
    || !Array.isArray(manifest.segments)
    || manifest.segments.length > HISTORY_SHARD_COUNT
    || !Number.isSafeInteger(manifest.archivedVersions)
    || Number(manifest.archivedVersions) < 0
    || (manifest.manifestGeneration !== undefined && (
      !Number.isSafeInteger(manifest.manifestGeneration)
      || Number(manifest.manifestGeneration) < 1
    ))
    || !validTimestamp(manifest.updatedAt)
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
  }
  assertStatusCounts(manifest.statusCounts);
  const names = new Set<string>();
  for (const segment of manifest.segments) {
    if (
      !segment
      || typeof segment !== 'object'
      || !new RegExp(`^${AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}[a-f0-9]{2}$`).test(segment.collection)
      || names.has(segment.collection)
      || !Number.isSafeInteger(segment.itemCount)
      || segment.itemCount < 1
      || segment.itemCount > HISTORY_SEGMENT_MAX_ITEMS
      || !/^[a-f0-9]{64}$/.test(segment.contentFingerprint)
    ) {
      throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
    }
    assertStatusCounts(segment.statusCounts);
    const segmentStatusTotal = Object.values(segment.statusCounts).reduce((sum, count) => sum + count, 0);
    if (segmentStatusTotal !== segment.itemCount) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
    names.add(segment.collection);
  }
  const totals = automationJobHistoryManifestTotals(manifest.segments);
  if (
    totals.archivedVersions !== manifest.archivedVersions
    || fingerprint(totals.statusCounts) !== fingerprint(manifest.statusCounts)
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_TOTAL_MISMATCH');
  }
}

export async function readAutomationJobHistoryManifest(): Promise<AutomationJobHistoryManifest | null> {
  if (getStorageCapabilities().driver !== 'file') return null;
  const snapshot = await readBoundedCollectionSnapshot<AutomationJobHistoryManifest>(
      AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
      { maximumItems: 1, maximumBytes: HISTORY_MANIFEST_MAX_BYTES },
  );
  if (!snapshot.items.length) return null;
  if (snapshot.items.length !== 1) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
  assertAutomationJobHistoryManifest(snapshot.items[0]);
  return snapshot.items[0];
}

function publicationRecordRefSort(
    left: AutomationJobHistoryPublicationRecordRef,
    right: AutomationJobHistoryPublicationRecordRef,
): number {
  return left.segmentCollection.localeCompare(right.segmentCollection)
    || left.recordId.localeCompare(right.recordId);
}

function publicationIntentId(records: readonly AutomationJobHistoryPublicationRecordRef[]): string {
  return sha256(`automation-job-history-publication\u0000${fingerprint(records)}`);
}

export function assertAutomationJobHistoryPublicationIntent(
    value: unknown,
): asserts value is AutomationJobHistoryPublicationIntent {
  if (!value || typeof value !== 'object') {
    throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_INVALID');
  }
  const intent = value as Partial<AutomationJobHistoryPublicationIntent>;
  if (
    intent.schemaVersion !== HISTORY_SCHEMA_VERSION
    || typeof intent.id !== 'string'
    || !/^[a-f0-9]{64}$/.test(intent.id)
    || !Array.isArray(intent.records)
    || intent.records.length < 1
    || intent.records.length > HISTORY_PUBLICATION_INTENT_MAX_RECORDS
    || !validTimestamp(intent.createdAt)
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_INVALID');
  }
  const recordIds = new Set<string>();
  for (const record of intent.records) {
    if (
      !record
      || typeof record !== 'object'
      || record.schemaVersion !== HISTORY_SCHEMA_VERSION
      || typeof record.recordId !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.recordId)
      || typeof record.jobId !== 'string'
      || !record.jobId
      || record.jobId.length > 200
      || typeof record.jobFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.jobFingerprint)
      || typeof record.keyDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.keyDigest)
      || record.recordId !== historyRecordId(record.jobId, record.jobFingerprint)
      || record.segmentCollection !== automationJobHistorySegmentCollection(record.jobId)
      || record.indexCollection !== `${AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX}${record.keyDigest.slice(0, 2)}`
      || recordIds.has(record.recordId)
    ) {
      throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_INVALID');
    }
    recordIds.add(record.recordId);
  }
  const sorted = [...intent.records].sort(publicationRecordRefSort);
  if (
    fingerprint(sorted) !== fingerprint(intent.records)
    || publicationIntentId(intent.records) !== intent.id
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_INVALID');
  }
}

export async function readAutomationJobHistoryPublicationIntents(): Promise<
  AutomationJobHistoryPublicationIntent[]
> {
  assertFileHistoryStorage();
  const snapshot = await readBoundedCollectionSnapshot<AutomationJobHistoryPublicationIntent>(
      AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
      {
        maximumItems: HISTORY_PUBLICATION_INTENT_MAX_ITEMS,
        maximumBytes: HISTORY_PUBLICATION_INTENT_MAX_BYTES,
      },
  );
  const ids = new Set<string>();
  for (const intent of snapshot.items) {
    assertAutomationJobHistoryPublicationIntent(intent);
    if (ids.has(intent.id)) throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_DUPLICATE');
    ids.add(intent.id);
  }
  return snapshot.items;
}

export async function withAutomationJobHistoryCoordinator<T>(
    work: (handle: StorageExclusiveHandle) => Promise<T>,
): Promise<T> {
  assertFileHistoryStorage();
  return runExclusive(AUTOMATION_JOB_HISTORY_COORDINATOR_SCOPE, work);
}

export function composeAutomationJobHistoryCommitGuard(
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
): StorageCommitGuard {
  return async (commit, context) => {
    const coordinatedCommit = async () => {
      await handle.assertHeld();
      return commit();
    };
    if (external) return external(coordinatedCommit, context);
    context.authorityAcquired();
    return coordinatedCommit();
  };
}

function historyPhaseCommitGuard(
    handle: StorageExclusiveHandle,
    external: StorageCommitGuard | undefined,
    before: AutomationJobHistoryTestPhase,
    after: AutomationJobHistoryTestPhase,
    collection: string,
): StorageCommitGuard {
  const coordinated = composeAutomationJobHistoryCommitGuard(handle, external);
  return (commit, context) => coordinated(async () => {
    await invokeAutomationJobHistoryTestHook(before, collection);
    const result = await commit();
    await invokeAutomationJobHistoryTestHook(after, collection);
    return result;
  }, context);
}

function segmentManifestEntry(
    segment: AutomationJobHistorySegmentSnapshot,
): AutomationJobHistorySegmentManifest {
  return {
    collection: segment.collection,
    itemCount: segment.itemCount,
    contentFingerprint: segment.contentFingerprint,
    statusCounts: segment.statusCounts,
  };
}

function segmentMetadataMatches(
    left: AutomationJobHistorySegmentManifest,
    right: AutomationJobHistorySegmentManifest,
): boolean {
  return left.itemCount === right.itemCount
    && left.contentFingerprint === right.contentFingerprint
    && fingerprint(left.statusCounts) === fingerprint(right.statusCounts);
}

async function assertManifestSourceMatches(
    observed: AutomationJobHistoryManifest | null,
    items: readonly AutomationJobHistoryManifest[],
): Promise<void> {
  if (items.length > 1) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
  if (!observed && items.length) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_SOURCE_CHANGED');
  if (observed && (!items[0] || fingerprint(items[0]) !== fingerprint(observed))) {
    throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_SOURCE_CHANGED');
  }
}

export async function publishAutomationJobHistoryManifestCoordinated(
    collections: readonly string[],
    nowMs: number,
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
    expectedGeneration?: number,
): Promise<AutomationJobHistoryManifest | null> {
  const uniqueCollections = [...new Set(collections)].sort();
  if (!uniqueCollections.length) return readAutomationJobHistoryManifest();
  if (uniqueCollections.some(collection => (
    !new RegExp(`^${AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}[a-f0-9]{2}$`).test(collection)
  ))) throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_NAME_INVALID');
  await handle.assertHeld();
  const observed = await readAutomationJobHistoryManifest();
  const observedGeneration = observed?.manifestGeneration ?? 0;
  if (expectedGeneration !== undefined && expectedGeneration !== observedGeneration) {
    throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CHANGED');
  }
  const requestedCollections = new Set(uniqueCollections);
  // A missing manifest is derived-metadata loss. Reconstruct it once from all
  // current primary shards so publication cannot omit unrelated history.
  const collectionsToRead = observed
    ? uniqueCollections
    : allAutomationJobHistorySegmentCollections();
  const authoritative = new Map<string, AutomationJobHistorySegmentSnapshot>();
  for (const collection of collectionsToRead) {
    const segment = await readAutomationJobHistorySegment(collection);
    if (!segment.collectionPresent || segment.itemCount < 1) {
      if (requestedCollections.has(collection)) {
        throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_SEGMENT_MISSING');
      }
      continue;
    }
    authoritative.set(collection, segment);
  }
  let published = observed;
  await runTransaction<AutomationJobHistoryManifest>(AUTOMATION_JOB_HISTORY_MANIFEST_NAME, async items => {
    await assertManifestSourceMatches(observed, items);
    const existing = items[0];
    if (existing) assertAutomationJobHistoryManifest(existing);
    const currentGeneration = existing?.manifestGeneration ?? 0;
    if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) {
      throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CHANGED');
    }
    const existingByCollection = new Map((existing?.segments || []).map(segment => [segment.collection, segment]));
    // Upgrade a legacy manifest to the coordinated generation format even
    // when all affected segment metadata already matches.
    let changed = existing !== undefined && existing.manifestGeneration === undefined;
    for (const [collection, snapshot] of authoritative) {
      const candidate = segmentManifestEntry(snapshot);
      const prior = existingByCollection.get(collection);
      if (prior && candidate.itemCount < prior.itemCount) {
        throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_STALE_WRITER');
      }
      if (prior && candidate.itemCount === prior.itemCount) {
        if (!segmentMetadataMatches(prior, candidate)) {
          throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CONFLICT');
        }
        continue;
      }
      changed = true;
      existingByCollection.set(collection, candidate);
    }
    if (!changed) {
      published = existing || null;
      return undefined;
    }
    const segments = [...existingByCollection.values()]
        .sort((left, right) => left.collection.localeCompare(right.collection));
    const totals = automationJobHistoryManifestTotals(segments);
    const next: AutomationJobHistoryManifest = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      id: 'automation-job-history-manifest',
      shardCount: HISTORY_SHARD_COUNT,
      segmentMaximumItems: HISTORY_SEGMENT_MAX_ITEMS,
      segmentMaximumBytes: HISTORY_SEGMENT_MAX_BYTES,
      archivedVersions: totals.archivedVersions,
      statusCounts: totals.statusCounts,
      segments,
      manifestGeneration: currentGeneration + 1,
      updatedAt: new Date(nowMs).toISOString(),
    };
    published = next;
    return [next];
  }, {
    withCommitGuard: historyPhaseCommitGuard(
        handle,
        external,
        'BEFORE_MANIFEST_COMMIT',
        'AFTER_MANIFEST_COMMIT',
        AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
    ),
    operationCategory: 'automation_job_history_manifest',
    sourcePolicy: 'PRIMARY_ONLY',
  });
  await handle.assertHeld();
  return published;
}

export async function replaceAutomationJobHistoryManifestCoordinated(
    authoritativeSegments: readonly AutomationJobHistorySegmentSnapshot[],
    nowMs: number,
    handle: StorageExclusiveHandle,
    expectedGeneration?: number,
): Promise<AutomationJobHistoryManifest | null> {
  await handle.assertHeld();
  const byCollection = new Map<string, AutomationJobHistorySegmentManifest>();
  for (const snapshot of authoritativeSegments) {
    validateHistorySegmentRecords(snapshot.records, snapshot.collection);
    const exact: AutomationJobHistorySegmentSnapshot = {
      ...snapshot,
      itemCount: snapshot.records.length,
      contentFingerprint: automationJobHistorySegmentFingerprint(snapshot.records),
      statusCounts: automationJobHistoryStatusCounts(snapshot.records),
    };
    if (
      exact.itemCount !== snapshot.itemCount
      || exact.contentFingerprint !== snapshot.contentFingerprint
      || fingerprint(exact.statusCounts) !== fingerprint(snapshot.statusCounts)
    ) throw new Error('AUTOMATION_JOB_HISTORY_REPLACEMENT_SEGMENT_INVALID');
    if (exact.itemCount < 1) continue;
    if (byCollection.has(exact.collection)) {
      throw new Error('AUTOMATION_JOB_HISTORY_REPLACEMENT_SEGMENT_DUPLICATE');
    }
    byCollection.set(exact.collection, segmentManifestEntry(exact));
  }
  const replacement = [...byCollection.values()]
      .sort((left, right) => left.collection.localeCompare(right.collection));
  if (replacement.length > HISTORY_SHARD_COUNT) {
    throw new Error('AUTOMATION_JOB_HISTORY_REPLACEMENT_SEGMENT_LIMIT_EXCEEDED');
  }
  let observed: AutomationJobHistoryManifest | null = null;
  let observedMalformed = false;
  try {
    observed = await readAutomationJobHistoryManifest();
  } catch {
    observedMalformed = true;
  }
  const observedGeneration = observed?.manifestGeneration ?? 0;
  if (expectedGeneration !== undefined && (
    observedMalformed || expectedGeneration !== observedGeneration
  )) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CHANGED');
  let published = observed;
  await runTransaction<AutomationJobHistoryManifest>(AUTOMATION_JOB_HISTORY_MANIFEST_NAME, async items => {
    if (!observedMalformed) await assertManifestSourceMatches(observed, items);
    if (observed) {
      const replacementByCollection = new Map(replacement.map(segment => [segment.collection, segment]));
      for (const prior of observed.segments) {
        const candidate = replacementByCollection.get(prior.collection);
        if (!candidate || candidate.itemCount < prior.itemCount) {
          throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_STALE_WRITER');
        }
        if (
          candidate.itemCount === prior.itemCount
          && candidate.contentFingerprint !== prior.contentFingerprint
        ) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CONFLICT');
      }
    }
    const totals = automationJobHistoryManifestTotals(replacement);
    const metadataMatches = Boolean(observed
      && Number.isSafeInteger(observed.manifestGeneration)
      && fingerprint(observed.segments) === fingerprint(replacement)
      && observed.archivedVersions === totals.archivedVersions
      && fingerprint(observed.statusCounts) === fingerprint(totals.statusCounts));
    if (metadataMatches) {
      published = observed;
      return undefined;
    }
    const next: AutomationJobHistoryManifest = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      id: 'automation-job-history-manifest',
      shardCount: HISTORY_SHARD_COUNT,
      segmentMaximumItems: HISTORY_SEGMENT_MAX_ITEMS,
      segmentMaximumBytes: HISTORY_SEGMENT_MAX_BYTES,
      archivedVersions: totals.archivedVersions,
      statusCounts: totals.statusCounts,
      segments: replacement,
      manifestGeneration: observedGeneration + 1,
      updatedAt: new Date(nowMs).toISOString(),
    };
    published = next;
    return [next];
  }, {
    withCommitGuard: historyPhaseCommitGuard(
        handle,
        undefined,
        'BEFORE_MANIFEST_COMMIT',
        'AFTER_MANIFEST_COMMIT',
        AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
    ),
    operationCategory: 'automation_job_history_manifest_rebuild',
    sourcePolicy: 'PRIMARY_ONLY',
  });
  await handle.assertHeld();
  return published;
}

export function makeAutomationJobHistoryIdempotencyRecord(
    record: AutomationJobHistoryRecord,
): AutomationJobHistoryIdempotencyRecord {
  assertAutomationJobHistoryRecord(record);
  const keyDigest = idempotencyKeyDigest(record.job.type, record.job.idempotencyKey);
  const indexRecord: AutomationJobHistoryIdempotencyRecord = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id: idempotencyRecordId(keyDigest, record.jobId, record.jobFingerprint),
    keyDigest,
    jobId: record.jobId,
    jobFingerprint: record.jobFingerprint,
    jobType: record.job.type,
    completedAt: record.job.completedAt || record.job.updatedAt,
    archivedAt: record.archivedAt,
  };
  assertAutomationJobHistoryIdempotencyRecord(indexRecord);
  return indexRecord;
}

export async function readAutomationJobHistoryIdempotencyIndex(
    collection: string,
): Promise<{ collection: string; collectionPresent: boolean; records: AutomationJobHistoryIdempotencyRecord[] }> {
  if (!new RegExp(`^${AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX}[a-f0-9]{2}$`).test(collection)) {
    throw new Error('AUTOMATION_JOB_HISTORY_INDEX_NAME_INVALID');
  }
  const snapshot = await readBoundedCollectionSnapshot<AutomationJobHistoryIdempotencyRecord>(collection, {
    maximumItems: HISTORY_INDEX_MAX_ITEMS,
    maximumBytes: HISTORY_INDEX_MAX_BYTES,
  });
  const ids = new Set<string>();
  for (const record of snapshot.items) {
    assertAutomationJobHistoryIdempotencyRecord(record);
    if (automationJobHistoryIdempotencyCollection(record.keyDigest) !== collection) {
      throw new Error('AUTOMATION_JOB_HISTORY_INDEX_SHARD_MISMATCH');
    }
    if (ids.has(record.id)) throw new Error('AUTOMATION_JOB_HISTORY_INDEX_DUPLICATE_RECORD');
    ids.add(record.id);
  }
  return {
    collection,
    collectionPresent: snapshot.metadata.collectionPresent,
    records: snapshot.items,
  };
}

async function appendIdempotencyRecords(
    collection: string,
    requested: readonly AutomationJobHistoryIdempotencyRecord[],
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
): Promise<void> {
  if (!requested.length) return;
  let existingCount = 0;
  let estimatedBytes = 2;
  const requestedById = new Map(requested.map(record => [record.id, record]));
  if (requestedById.size !== requested.length) throw new Error('AUTOMATION_JOB_HISTORY_INDEX_DUPLICATE_INPUT');
  const existingIds = new Set<string>();
  const observedIds = new Set<string>();
  let appendItems: AutomationJobHistoryIdempotencyRecord[] = [];
  await runStreamingTransaction<AutomationJobHistoryIdempotencyRecord>(collection, () => false, {
    prepare: item => {
      assertAutomationJobHistoryIdempotencyRecord(item);
      if (automationJobHistoryIdempotencyCollection(item.keyDigest) !== collection) {
        throw new Error('AUTOMATION_JOB_HISTORY_INDEX_SHARD_MISMATCH');
      }
      if (observedIds.has(item.id)) throw new Error('AUTOMATION_JOB_HISTORY_INDEX_DUPLICATE_RECORD');
      observedIds.add(item.id);
      existingCount += 1;
      estimatedBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (existingCount > 1 ? 1 : 0);
      const requestedRecord = requestedById.get(item.id);
      if (requestedRecord) {
        if (
          item.schemaVersion !== requestedRecord.schemaVersion
          || item.keyDigest !== requestedRecord.keyDigest
          || item.jobId !== requestedRecord.jobId
          || item.jobFingerprint !== requestedRecord.jobFingerprint
          || item.jobType !== requestedRecord.jobType
          || item.completedAt !== requestedRecord.completedAt
          || item.archivedAt !== requestedRecord.archivedAt
        ) {
          throw new Error('AUTOMATION_JOB_HISTORY_INDEX_CONFLICT');
        }
        existingIds.add(item.id);
      }
      return false;
    },
    beforeMutation: () => {
      appendItems = requested.filter(record => !existingIds.has(record.id));
      const nextBytes = estimatedBytes + appendItems.reduce(
          (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1,
          0,
      );
      if (existingCount + appendItems.length > HISTORY_INDEX_MAX_ITEMS) {
        throw new Error('AUTOMATION_JOB_HISTORY_INDEX_ITEM_LIMIT_EXCEEDED');
      }
      if (nextBytes > HISTORY_INDEX_MAX_BYTES) {
        throw new Error('AUTOMATION_JOB_HISTORY_INDEX_BYTE_LIMIT_EXCEEDED');
      }
    },
    appendItems: () => appendItems,
    appendOnly: true,
    sourcePolicy: 'PRIMARY_ONLY',
    withCommitGuard: historyPhaseCommitGuard(
        handle,
        external,
        'BEFORE_INDEX_COMMIT',
        'AFTER_INDEX_COMMIT',
        collection,
    ),
    operationCategory: 'automation_job_history_idempotency',
  });
}

export async function convergeAutomationJobHistoryIndexesCoordinated(
    records: readonly AutomationJobHistoryIdempotencyRecord[],
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
): Promise<void> {
  const byCollection = new Map<string, AutomationJobHistoryIdempotencyRecord[]>();
  const uniqueIds = new Set<string>();
  for (const record of records) {
    assertAutomationJobHistoryIdempotencyRecord(record);
    if (uniqueIds.has(record.id)) throw new Error('AUTOMATION_JOB_HISTORY_INDEX_DUPLICATE_INPUT');
    uniqueIds.add(record.id);
    const collection = automationJobHistoryIdempotencyCollection(record.keyDigest);
    const group = byCollection.get(collection) || [];
    group.push(record);
    byCollection.set(collection, group);
  }
  for (const [collection, group] of [...byCollection].sort(([left], [right]) => left.localeCompare(right))) {
    await appendIdempotencyRecords(collection, group, handle, external);
  }
  await handle.assertHeld();
}

async function appendHistoryRecords(
    collection: string,
    requested: readonly AutomationJobHistoryRecord[],
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
): Promise<{ createdIds: Set<string>; segment: AutomationJobHistorySegmentSnapshot }> {
  const requestedById = new Map(requested.map(record => [record.id, record]));
  if (requestedById.size !== requested.length) throw new Error('AUTOMATION_JOB_HISTORY_DUPLICATE_INPUT');
  let existingCount = 0;
  let estimatedBytes = 2;
  const existingIds = new Set<string>();
  let appendItems: AutomationJobHistoryRecord[] = [];
  await runStreamingTransaction<AutomationJobHistoryRecord>(collection, () => false, {
    prepare: item => {
      assertAutomationJobHistoryRecord(item);
      if (automationJobHistorySegmentCollection(item.jobId) !== collection) {
        throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_SHARD_MISMATCH');
      }
      existingCount += 1;
      estimatedBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (existingCount > 1 ? 1 : 0);
      const requestedRecord = requestedById.get(item.id);
      if (requestedRecord) {
        if (
          item.jobFingerprint !== requestedRecord.jobFingerprint
          || fingerprint(item.job) !== fingerprint(requestedRecord.job)
        ) throw new Error('AUTOMATION_JOB_HISTORY_RECORD_CONFLICT');
        existingIds.add(item.id);
      }
      return false;
    },
    beforeMutation: () => {
      appendItems = requested.filter(record => !existingIds.has(record.id));
      const nextBytes = estimatedBytes + appendItems.reduce(
          (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1,
          0,
      );
      if (existingCount + appendItems.length > HISTORY_SEGMENT_MAX_ITEMS) {
        throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_ITEM_LIMIT_EXCEEDED');
      }
      if (nextBytes > HISTORY_SEGMENT_MAX_BYTES) {
        throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_BYTE_LIMIT_EXCEEDED');
      }
    },
    appendItems: () => appendItems,
    appendOnly: true,
    sourcePolicy: 'PRIMARY_ONLY',
    withCommitGuard: historyPhaseCommitGuard(
        handle,
        external,
        'BEFORE_SEGMENT_COMMIT',
        'AFTER_SEGMENT_COMMIT',
        collection,
    ),
    operationCategory: 'automation_job_history_append',
  });
  const segment = await readAutomationJobHistorySegment(collection);
  for (const record of requested) {
    if (!segment.records.some(item => item.id === record.id && item.jobFingerprint === record.jobFingerprint)) {
      throw new Error('AUTOMATION_JOB_HISTORY_ARCHIVE_VERIFY_FAILED');
    }
  }
  return { createdIds: new Set(appendItems.map(record => record.id)), segment };
}

function makePublicationRecordRef(
    record: AutomationJobHistoryRecord,
): AutomationJobHistoryPublicationRecordRef {
  const index = makeAutomationJobHistoryIdempotencyRecord(record);
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    recordId: record.id,
    segmentCollection: automationJobHistorySegmentCollection(record.jobId),
    indexCollection: automationJobHistoryIdempotencyCollection(index.keyDigest),
    keyDigest: index.keyDigest,
    jobId: record.jobId,
    jobFingerprint: record.jobFingerprint,
  };
}

function makePublicationIntent(
    records: readonly AutomationJobHistoryRecord[],
    nowMs: number,
): AutomationJobHistoryPublicationIntent {
  const refs = records.map(makePublicationRecordRef).sort(publicationRecordRefSort);
  const intent: AutomationJobHistoryPublicationIntent = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id: publicationIntentId(refs),
    records: refs,
    createdAt: new Date(nowMs).toISOString(),
  };
  assertAutomationJobHistoryPublicationIntent(intent);
  return intent;
}

async function persistPublicationIntentCoordinated(
    intent: AutomationJobHistoryPublicationIntent,
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
): Promise<void> {
  assertAutomationJobHistoryPublicationIntent(intent);
  const observed = await readAutomationJobHistoryPublicationIntents();
  const existing = observed.find(item => item.id === intent.id);
  if (existing) {
    if (fingerprint(existing.records) !== fingerprint(intent.records)) {
      throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_CONFLICT');
    }
    return;
  }
  if (observed.length >= HISTORY_PUBLICATION_INTENT_MAX_ITEMS) {
    throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_ITEM_LIMIT_EXCEEDED');
  }
  const next = [...observed, intent].sort((left, right) => left.id.localeCompare(right.id));
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > HISTORY_PUBLICATION_INTENT_MAX_BYTES) {
    throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_BYTE_LIMIT_EXCEEDED');
  }
  await runTransaction<AutomationJobHistoryPublicationIntent>(
      AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
      items => {
        if (fingerprint(items) !== fingerprint(observed)) {
          throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_SOURCE_CHANGED');
        }
        return next;
      },
      {
        withCommitGuard: composeAutomationJobHistoryCommitGuard(handle, external),
        operationCategory: 'automation_job_history_publication_intent_begin',
        sourcePolicy: 'PRIMARY_ONLY',
      },
  );
}

async function resolvePublicationRecords(
    refs: readonly AutomationJobHistoryPublicationRecordRef[],
    handle: StorageExclusiveHandle,
): Promise<{
  records: AutomationJobHistoryRecord[];
  unresolved: AutomationJobHistoryPublicationRecordRef[];
}> {
  const snapshots = new Map<string, AutomationJobHistorySegmentSnapshot>();
  for (const collection of [...new Set(refs.map(ref => ref.segmentCollection))].sort()) {
    await handle.assertHeld();
    snapshots.set(collection, await readAutomationJobHistorySegment(collection));
  }
  const records: AutomationJobHistoryRecord[] = [];
  const unresolved: AutomationJobHistoryPublicationRecordRef[] = [];
  for (const ref of refs) {
    const match = snapshots.get(ref.segmentCollection)?.records.find(record => record.id === ref.recordId);
    if (!match) {
      unresolved.push(ref);
      continue;
    }
    if (match.jobId !== ref.jobId || match.jobFingerprint !== ref.jobFingerprint) {
      throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_RECORD_CONFLICT');
    }
    records.push(match);
  }
  await handle.assertHeld();
  return { records, unresolved };
}

async function assertPublishedRecordsCoordinated(
    records: readonly AutomationJobHistoryRecord[],
    handle: StorageExclusiveHandle,
    requireIndex: (record: AutomationJobHistoryRecord) => boolean = () => true,
): Promise<void> {
  if (!records.length) return;
  await invokeAutomationJobHistoryTestHook('READER_COHERENCE_BARRIER');
  await handle.assertHeld();
  const manifest = await readAutomationJobHistoryManifest();
  if (!manifest) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_VERIFY_FAILED');
  const bySegment = new Map<string, AutomationJobHistoryRecord[]>();
  for (const record of records) {
    const collection = automationJobHistorySegmentCollection(record.jobId);
    const group = bySegment.get(collection) || [];
    group.push(record);
    bySegment.set(collection, group);
  }
  for (const [collection, requested] of bySegment) {
    const segment = await readAutomationJobHistorySegment(collection);
    const manifestSegment = manifest.segments.find(item => item.collection === collection);
    if (!manifestSegment || !segmentMetadataMatches(manifestSegment, segmentManifestEntry(segment))) {
      throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_VERIFY_FAILED');
    }
    for (const record of requested) {
      if (!segment.records.some(item => (
        item.id === record.id
        && item.jobId === record.jobId
        && item.jobFingerprint === record.jobFingerprint
      ))) throw new Error('AUTOMATION_JOB_HISTORY_ARCHIVE_VERIFY_FAILED');
    }
  }
  const indexes = records.filter(requireIndex).map(makeAutomationJobHistoryIdempotencyRecord);
  const byIndex = new Map<string, AutomationJobHistoryIdempotencyRecord[]>();
  for (const index of indexes) {
    const collection = automationJobHistoryIdempotencyCollection(index.keyDigest);
    const group = byIndex.get(collection) || [];
    group.push(index);
    byIndex.set(collection, group);
  }
  for (const [collection, requested] of byIndex) {
    const index = await readAutomationJobHistoryIdempotencyIndex(collection);
    for (const expected of requested) {
      const actual = index.records.find(item => item.id === expected.id);
      if (!actual || fingerprint(actual) !== fingerprint(expected)) {
        throw new Error('AUTOMATION_JOB_HISTORY_INDEX_VERIFY_FAILED');
      }
    }
  }
  await handle.assertHeld();
}

export async function completeAutomationJobHistoryPublicationIntentsCoordinated(
    intentIds: readonly string[],
    nowMs: number,
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
): Promise<number> {
  void nowMs;
  const requestedIds = new Set(intentIds);
  if (!requestedIds.size) return 0;
  const observed = await readAutomationJobHistoryPublicationIntents();
  const requested = observed.filter(intent => requestedIds.has(intent.id));
  for (const intent of requested) {
    const resolved = await resolvePublicationRecords(intent.records, handle);
    // Refs absent from current segments never crossed the authoritative
    // segment boundary; the active terminal source therefore remains the
    // retry source. Every ref that did commit must be fully published first.
    if (resolved.records.length) {
      await assertPublishedRecordsCoordinated(resolved.records, handle);
    }
  }
  if (!requested.length) return 0;
  const completedIds = new Set(requested.map(intent => intent.id));
  await runTransaction<AutomationJobHistoryPublicationIntent>(
      AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
      items => {
        if (fingerprint(items) !== fingerprint(observed)) {
          throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_SOURCE_CHANGED');
        }
        for (const intent of items) assertAutomationJobHistoryPublicationIntent(intent);
        return items.filter(intent => !completedIds.has(intent.id));
      },
      {
        withCommitGuard: composeAutomationJobHistoryCommitGuard(handle, external),
        operationCategory: 'automation_job_history_publication_intent_complete',
        sourcePolicy: 'PRIMARY_ONLY',
      },
  );
  await handle.assertHeld();
  return requested.length;
}

export async function recoverAutomationJobHistoryPublicationIntentsCoordinated(
    nowMs: number,
    handle: StorageExclusiveHandle,
    external?: StorageCommitGuard,
): Promise<{ intents: number; completed: number; unresolved: number; recoveredRecords: number }> {
  const intents = await readAutomationJobHistoryPublicationIntents();
  if (!intents.length) return { intents: 0, completed: 0, unresolved: 0, recoveredRecords: 0 };
  const recoveredById = new Map<string, AutomationJobHistoryRecord>();
  let unresolved = 0;
  for (const intent of intents) {
    const resolved = await resolvePublicationRecords(intent.records, handle);
    for (const record of resolved.records) recoveredById.set(record.id, record);
    if (resolved.unresolved.length) unresolved += 1;
  }
  const recovered = [...recoveredById.values()];
  if (recovered.length) {
    await convergeAutomationJobHistoryIndexesCoordinated(
        recovered.map(makeAutomationJobHistoryIdempotencyRecord),
        handle,
        external,
    );
    await publishAutomationJobHistoryManifestCoordinated(
        [...new Set(recovered.map(record => automationJobHistorySegmentCollection(record.jobId)))],
        nowMs,
        handle,
        external,
    );
    await assertPublishedRecordsCoordinated(recovered, handle);
  }
  const completed = await completeAutomationJobHistoryPublicationIntentsCoordinated(
      intents.map(intent => intent.id),
      nowMs,
      handle,
      external,
  );
  return { intents: intents.length, completed, unresolved, recoveredRecords: recovered.length };
}

export async function archiveAutomationJobHistoryBatch(
    jobs: readonly AutomationJob[],
    options: { nowMs?: number; withCommitGuard?: StorageCommitGuard } = {},
): Promise<AutomationJobHistoryArchiveResult[]> {
  if (!jobs.length) return [];
  assertFileHistoryStorage();
  if (jobs.length > 250) throw new Error('AUTOMATION_JOB_HISTORY_BATCH_LIMIT_EXCEEDED');
  const nowMs = options.nowMs ?? Date.now();
  const records = jobs.map(job => makeHistoryRecord(job, nowMs));
  const recordIds = new Set(records.map(record => record.id));
  if (recordIds.size !== records.length) throw new Error('AUTOMATION_JOB_HISTORY_DUPLICATE_INPUT');
  const bySegment = new Map<string, AutomationJobHistoryRecord[]>();
  for (const record of records) {
    const collection = automationJobHistorySegmentCollection(record.jobId);
    const group = bySegment.get(collection) || [];
    group.push(record);
    bySegment.set(collection, group);
  }

  return withAutomationJobHistoryCoordinator(async handle => {
    await recoverAutomationJobHistoryPublicationIntentsCoordinated(
        nowMs,
        handle,
        options.withCommitGuard,
    );
    const intent = makePublicationIntent(records, nowMs);
    await persistPublicationIntentCoordinated(intent, handle, options.withCommitGuard);

    const segmentResults = new Map<string, Awaited<ReturnType<typeof appendHistoryRecords>>>();
    for (const [collection, group] of [...bySegment].sort(([left], [right]) => left.localeCompare(right))) {
      segmentResults.set(
          collection,
          await appendHistoryRecords(collection, group, handle, options.withCommitGuard),
      );
    }
    await recoverAutomationJobHistoryPublicationIntentsCoordinated(
        nowMs,
        handle,
        options.withCommitGuard,
    );
    if ((await readAutomationJobHistoryPublicationIntents()).some(item => item.id === intent.id)) {
      throw new Error('AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_UNRESOLVED');
    }
    return records.map(record => {
      const collection = automationJobHistorySegmentCollection(record.jobId);
      const segmentResult = segmentResults.get(collection)!;
      return {
        created: segmentResult.createdIds.has(record.id),
        collection,
        record,
        segmentItemCount: segmentResult.segment.itemCount,
        segmentContentFingerprint: segmentResult.segment.contentFingerprint,
      };
    });
  });
}

export async function archiveAutomationJobHistory(
    job: AutomationJob,
    options: { nowMs?: number; withCommitGuard?: StorageCommitGuard } = {},
): Promise<AutomationJobHistoryArchiveResult> {
  return (await archiveAutomationJobHistoryBatch([job], options))[0];
}

function newestHistoryRecord(
    left: AutomationJobHistoryRecord,
    right: AutomationJobHistoryRecord,
): AutomationJobHistoryRecord {
  const leftUpdated = Date.parse(left.job.updatedAt);
  const rightUpdated = Date.parse(right.job.updatedAt);
  if (leftUpdated !== rightUpdated) return leftUpdated > rightUpdated ? left : right;
  const leftArchived = Date.parse(left.archivedAt);
  const rightArchived = Date.parse(right.archivedAt);
  if (leftArchived !== rightArchived) return leftArchived > rightArchived ? left : right;
  return left.id.localeCompare(right.id) >= 0 ? left : right;
}

export async function getArchivedAutomationJob(id: string): Promise<AutomationJob | null> {
  if (!id || id.length > 200) return null;
  if (getStorageCapabilities().driver !== 'file') return null;
  const segment = await readAutomationJobHistorySegment(automationJobHistorySegmentCollection(id));
  const matches = segment.records.filter(record => record.jobId === id);
  if (!matches.length) return null;
  return structuredClone(matches.reduce(newestHistoryRecord).job);
}

function historyCoordinatorReadRetryable(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? String((error as { code?: unknown }).code || '')
    : '';
  return code === 'STORAGE_LOCK_LOST';
}

async function withCoherentAutomationJobHistoryRead<T>(
    work: (handle: StorageExclusiveHandle) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withAutomationJobHistoryCoordinator(async handle => {
        await invokeAutomationJobHistoryTestHook('READER_COHERENCE_BARRIER');
        await handle.assertHeld();
        const result = await work(handle);
        await handle.assertHeld();
        return result;
      });
    } catch (error) {
      if (attempt > 0 || !historyCoordinatorReadRetryable(error)) throw error;
    }
  }
  throw new Error('AUTOMATION_JOB_HISTORY_READER_RETRY_EXHAUSTED');
}

export async function assertAutomationJobHistoryBatchArchived(
    jobs: readonly AutomationJob[],
    options: { requireAllTerminalIdempotencyIndex?: boolean } = {},
): Promise<void> {
  if (!jobs.length) return;
  assertFileHistoryStorage();
  await withCoherentAutomationJobHistoryRead(async handle => {
    const persisted: AutomationJobHistoryRecord[] = [];
    const bySegment = new Map<string, AutomationJob[]>();
    for (const job of jobs) {
      const collection = automationJobHistorySegmentCollection(job.id);
      const group = bySegment.get(collection) || [];
      group.push(job);
      bySegment.set(collection, group);
    }
    for (const [collection, group] of bySegment) {
      const segment = await readAutomationJobHistorySegment(collection);
      for (const job of group) {
        const expectedFingerprint = automationJobHistoryFingerprint(job);
        const record = segment.records.find(item => (
          item.jobId === job.id && item.jobFingerprint === expectedFingerprint
        ));
        if (!record) throw new Error('AUTOMATION_JOB_HISTORY_ARCHIVE_VERIFY_FAILED');
        persisted.push(record);
      }
    }
    await assertPublishedRecordsCoordinated(
        persisted,
        handle,
        record => options.requireAllTerminalIdempotencyIndex === true || record.job.status === 'SUCCEEDED',
    );
  });
}

export async function assertAutomationJobHistoryArchived(job: AutomationJob): Promise<void> {
  await assertAutomationJobHistoryBatchArchived([job]);
}

async function readExactAutomationJobHistoryRecord(
    jobId: string,
    jobFingerprint: string,
): Promise<AutomationJobHistoryRecord | null> {
  const segment = await readAutomationJobHistorySegment(
      automationJobHistorySegmentCollection(jobId),
  );
  return segment.records.find(record => (
    record.jobId === jobId && record.jobFingerprint === jobFingerprint
  )) || null;
}

async function resolveAutomationJobHistoryIndexCandidate(
    candidate: AutomationJobHistoryIdempotencyRecord,
): Promise<AutomationJobHistoryRecord> {
  const record = await readExactAutomationJobHistoryRecord(
      candidate.jobId,
      candidate.jobFingerprint,
  );
  if (!record) throw new Error('AUTOMATION_JOB_HISTORY_INDEX_ORPHAN');
  const expected = makeAutomationJobHistoryIdempotencyRecord(record);
  if (fingerprint(expected) !== fingerprint(candidate)) {
    throw new Error('AUTOMATION_JOB_HISTORY_INDEX_CONFLICT');
  }
  return record;
}

export async function getArchivedSuccessfulAutomationJob(
    type: AutomationJobType,
    idempotencyKey: string,
    nowMs = Date.now(),
): Promise<AutomationJob | null> {
  if (getStorageCapabilities().driver !== 'file') return null;
  const keyDigest = idempotencyKeyDigest(type, idempotencyKey);
  const index = await readAutomationJobHistoryIdempotencyIndex(
      automationJobHistoryIdempotencyCollection(keyDigest),
  );
  const retentionDays = Math.max(7, Number(process.env.SANDEAL_JOB_RETENTION_DAYS) || 30);
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60_000;
  const candidates = index.records
      .filter(item => item.keyDigest === keyDigest)
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  for (const candidate of candidates) {
    const record = await resolveAutomationJobHistoryIndexCandidate(candidate);
    const job = record.job;
    if (job.type !== type || job.idempotencyKey !== idempotencyKey) {
      throw new Error('AUTOMATION_JOB_HISTORY_INDEX_CONFLICT');
    }
    if (Date.parse(candidate.completedAt) < cutoffMs) continue;
    if (
      job.status === 'SUCCEEDED'
    ) return structuredClone(job);
  }
  return null;
}

/**
 * Resolve the newest immutable terminal execution for one durable identity.
 * This is intentionally separate from successful-result reuse: callers must
 * opt in when a failed/cancelled/blocked execution itself exhausts the
 * materialization identity (currently workflow reconciliation buckets).
 */
export async function getArchivedTerminalAutomationJob(
    type: AutomationJobType,
    idempotencyKey: string,
    nowMs = Date.now(),
): Promise<AutomationJob | null> {
  if (getStorageCapabilities().driver !== 'file') return null;
  const keyDigest = idempotencyKeyDigest(type, idempotencyKey);
  const index = await readAutomationJobHistoryIdempotencyIndex(
      automationJobHistoryIdempotencyCollection(keyDigest),
  );
  const retentionDays = Math.max(7, Number(process.env.SANDEAL_JOB_RETENTION_DAYS) || 30);
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60_000;
  const candidates = index.records
      .filter(item => item.keyDigest === keyDigest)
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  for (const candidate of candidates) {
    const record = await resolveAutomationJobHistoryIndexCandidate(candidate);
    const job = record.job;
    if (job.type !== type || job.idempotencyKey !== idempotencyKey) {
      throw new Error('AUTOMATION_JOB_HISTORY_INDEX_CONFLICT');
    }
    if (Date.parse(candidate.completedAt) < cutoffMs) continue;
    if (isTerminalAutomationJobStatus(job.status)) return structuredClone(job);
  }

  // Releases predating the all-terminal index only indexed SUCCEEDED jobs.
  // Fall back to the bounded immutable manifest/segments so an already-failed
  // reconciliation bucket from that format is still a real materialization.
  // This path is read-only and is reached only when the compact key index has
  // no usable entry; all newly archived terminal jobs use the fast path above.
  let legacyMatch: AutomationJob | null = null;
  await scanLatestArchivedAutomationJobs(job => {
    if (
      isTerminalAutomationJobStatus(job.status)
      && job.type === type
      && job.idempotencyKey === idempotencyKey
      && Date.parse(job.completedAt || job.updatedAt) >= cutoffMs
      && (!legacyMatch
        || Date.parse(job.completedAt || job.updatedAt)
          > Date.parse(legacyMatch.completedAt || legacyMatch.updatedAt))
    ) legacyMatch = job;
  });
  if (legacyMatch) return structuredClone(legacyMatch);
  return null;
}

export async function scanLatestArchivedAutomationJobs(
    visitor: (job: AutomationJob) => Promise<void> | void,
): Promise<{ archivedVersions: number; archivedJobs: number; statusCounts: AutomationJobHistoryStatusCounts }> {
  return withCoherentAutomationJobHistoryRead(async () => {
    const manifest = await readAutomationJobHistoryManifest();
    if (!manifest) return { archivedVersions: 0, archivedJobs: 0, statusCounts: emptyStatusCounts() };
    let archivedJobs = 0;
    for (const entry of manifest.segments) {
      const segment = await readAutomationJobHistorySegment(entry.collection);
      if (!segmentMetadataMatches(entry, segmentManifestEntry(segment))) {
        throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_VERIFY_FAILED');
      }
      const latest = new Map<string, AutomationJobHistoryRecord>();
      for (const record of segment.records) {
        const prior = latest.get(record.jobId);
        latest.set(record.jobId, prior ? newestHistoryRecord(prior, record) : record);
      }
      for (const record of latest.values()) {
        await visitor(structuredClone(record.job));
        archivedJobs += 1;
      }
    }
    return {
      archivedVersions: manifest.archivedVersions,
      archivedJobs,
      statusCounts: { ...manifest.statusCounts },
    };
  });
}

export async function getAllArchivedAutomationJobs(): Promise<AutomationJob[]> {
  const jobs: AutomationJob[] = [];
  await scanLatestArchivedAutomationJobs(job => { jobs.push(job); });
  return jobs;
}

export const AUTOMATION_JOB_HISTORY_LIMITS = Object.freeze({
  shardCount: HISTORY_SHARD_COUNT,
  segmentMaximumItems: HISTORY_SEGMENT_MAX_ITEMS,
  segmentMaximumBytes: HISTORY_SEGMENT_MAX_BYTES,
  indexMaximumItems: HISTORY_INDEX_MAX_ITEMS,
  indexMaximumBytes: HISTORY_INDEX_MAX_BYTES,
  manifestMaximumBytes: HISTORY_MANIFEST_MAX_BYTES,
  publicationIntentMaximumItems: HISTORY_PUBLICATION_INTENT_MAX_ITEMS,
  publicationIntentMaximumBytes: HISTORY_PUBLICATION_INTENT_MAX_BYTES,
});
