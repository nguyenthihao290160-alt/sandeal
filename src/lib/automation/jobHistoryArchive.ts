import { createHash } from 'node:crypto';

import {
  getStorageCapabilities,
  readBoundedCollectionSnapshot,
  runStreamingTransaction,
  runTransaction,
} from '@/lib/storage/adapter';
import type { StorageCommitGuard } from '@/lib/storage/types';
import type { AutomationJob, AutomationJobStatus, AutomationJobType } from './types';

export const AUTOMATION_JOB_HISTORY_MANIFEST_NAME = 'automation-job-history-manifest-v1';
export const AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX = 'automation-job-history-v1-';
export const AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX = 'automation-job-history-idempotency-v1-';

const HISTORY_SCHEMA_VERSION = 1;
const HISTORY_SHARD_COUNT = 128;
const HISTORY_SEGMENT_MAX_ITEMS = 1_024;
const HISTORY_SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_INDEX_MAX_ITEMS = 4_096;
const HISTORY_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_MANIFEST_MAX_BYTES = 512 * 1024;
const TERMINAL_STATUSES = new Set<AutomationJobStatus>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
]);

type TerminalAutomationJobStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';

export interface AutomationJobHistoryRecord {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  id: string;
  jobId: string;
  jobFingerprint: string;
  archivedAt: string;
  job: AutomationJob;
}

interface AutomationJobHistoryIdempotencyRecord {
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
  updatedAt: string;
}

export interface AutomationJobHistoryArchiveResult {
  created: boolean;
  collection: string;
  record: AutomationJobHistoryRecord;
  segmentItemCount: number;
  segmentContentFingerprint: string;
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

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(normalizedJson(value))));
}

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

function automationJobHistoryIdempotencyCollection(keyDigest: string): string {
  return `${AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX}${keyDigest.slice(0, 2)}`;
}

export function isTerminalAutomationJobStatus(status: AutomationJobStatus): status is TerminalAutomationJobStatus {
  return TERMINAL_STATUSES.has(status);
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
  if (!validTimestamp(job.createdAt) || !validTimestamp(job.updatedAt)) {
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

function assertHistoryRecord(value: unknown): asserts value is AutomationJobHistoryRecord {
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

function assertIdempotencyRecord(value: unknown): asserts value is AutomationJobHistoryIdempotencyRecord {
  if (!value || typeof value !== 'object') throw new Error('AUTOMATION_JOB_HISTORY_INDEX_INVALID');
  const record = value as Partial<AutomationJobHistoryIdempotencyRecord>;
  if (
    record.schemaVersion !== HISTORY_SCHEMA_VERSION
    || typeof record.id !== 'string'
    || typeof record.keyDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.keyDigest)
    || typeof record.jobId !== 'string'
    || typeof record.jobFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.jobFingerprint)
    || typeof record.jobType !== 'string'
    || !validTimestamp(record.completedAt)
    || !validTimestamp(record.archivedAt)
    || idempotencyRecordId(record.keyDigest, record.jobId, record.jobFingerprint) !== record.id
  ) {
    throw new Error('AUTOMATION_JOB_HISTORY_INDEX_INVALID');
  }
}

function recordsStatusCounts(records: readonly AutomationJobHistoryRecord[]): AutomationJobHistoryStatusCounts {
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

function historySegmentFingerprint(records: readonly AutomationJobHistoryRecord[]): string {
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
    assertHistoryRecord(record);
    if (automationJobHistorySegmentCollection(record.jobId) !== collection) {
      throw new Error('AUTOMATION_JOB_HISTORY_SEGMENT_SHARD_MISMATCH');
    }
    if (ids.has(record.id)) throw new Error('AUTOMATION_JOB_HISTORY_DUPLICATE_RECORD');
    ids.add(record.id);
  }
}

async function readHistorySegment(collection: string): Promise<{
  records: AutomationJobHistoryRecord[];
  itemCount: number;
  contentFingerprint: string;
  statusCounts: AutomationJobHistoryStatusCounts;
}> {
  const snapshot = await readBoundedCollectionSnapshot<AutomationJobHistoryRecord>(collection, {
    maximumItems: HISTORY_SEGMENT_MAX_ITEMS,
    maximumBytes: HISTORY_SEGMENT_MAX_BYTES,
  });
  validateHistorySegmentRecords(snapshot.items, collection);
  return {
    records: snapshot.items,
    itemCount: snapshot.items.length,
    contentFingerprint: historySegmentFingerprint(snapshot.items),
    statusCounts: recordsStatusCounts(snapshot.items),
  };
}

function manifestTotals(segments: readonly AutomationJobHistorySegmentManifest[]): {
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
  for (const status of TERMINAL_STATUSES) {
    const count = (value as Record<string, unknown>)[status];
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
    }
  }
}

function assertHistoryManifest(value: unknown): asserts value is AutomationJobHistoryManifest {
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
  const totals = manifestTotals(manifest.segments);
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
  assertHistoryManifest(snapshot.items[0]);
  return snapshot.items[0];
}

async function updateHistoryManifest(
    updatedSegments: Map<string, Awaited<ReturnType<typeof readHistorySegment>>>,
    nowMs: number,
    withCommitGuard?: StorageCommitGuard,
): Promise<void> {
  if (!updatedSegments.size) return;
  await runTransaction<AutomationJobHistoryManifest>(AUTOMATION_JOB_HISTORY_MANIFEST_NAME, items => {
    if (items.length > 1) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
    const existing = items[0];
    if (existing) assertHistoryManifest(existing);
    const existingByCollection = new Map((existing?.segments || []).map(segment => [segment.collection, segment]));
    let changed = false;
    for (const [collection, segment] of updatedSegments) {
      const prior = existingByCollection.get(collection);
      if (
        prior
        && prior.itemCount === segment.itemCount
        && prior.contentFingerprint === segment.contentFingerprint
        && fingerprint(prior.statusCounts) === fingerprint(segment.statusCounts)
      ) continue;
      changed = true;
      existingByCollection.set(collection, {
        collection,
        itemCount: segment.itemCount,
        contentFingerprint: segment.contentFingerprint,
        statusCounts: segment.statusCounts,
      });
    }
    if (!changed) return undefined;
    const segments = [...existingByCollection.values()]
        .sort((left, right) => left.collection.localeCompare(right.collection));
    const totals = manifestTotals(segments);
    const next: AutomationJobHistoryManifest = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      id: 'automation-job-history-manifest',
      shardCount: HISTORY_SHARD_COUNT,
      segmentMaximumItems: HISTORY_SEGMENT_MAX_ITEMS,
      segmentMaximumBytes: HISTORY_SEGMENT_MAX_BYTES,
      archivedVersions: totals.archivedVersions,
      statusCounts: totals.statusCounts,
      segments,
      updatedAt: new Date(nowMs).toISOString(),
    };
    return existing && fingerprint(existing) === fingerprint(next)
        ? undefined
        : [next];
  }, {
    withCommitGuard,
    operationCategory: 'automation_job_history_manifest',
  });
}

function makeIdempotencyRecord(record: AutomationJobHistoryRecord): AutomationJobHistoryIdempotencyRecord {
  const keyDigest = idempotencyKeyDigest(record.job.type, record.job.idempotencyKey);
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id: idempotencyRecordId(keyDigest, record.jobId, record.jobFingerprint),
    keyDigest,
    jobId: record.jobId,
    jobFingerprint: record.jobFingerprint,
    jobType: record.job.type,
    completedAt: record.job.completedAt || record.job.updatedAt,
    archivedAt: record.archivedAt,
  };
}

async function appendIdempotencyRecords(
    collection: string,
    requested: readonly AutomationJobHistoryIdempotencyRecord[],
    withCommitGuard?: StorageCommitGuard,
): Promise<void> {
  if (!requested.length) return;
  let existingCount = 0;
  let estimatedBytes = 2;
  const requestedById = new Map(requested.map(record => [record.id, record]));
  if (requestedById.size !== requested.length) throw new Error('AUTOMATION_JOB_HISTORY_INDEX_DUPLICATE_INPUT');
  const existingIds = new Set<string>();
  let appendItems: AutomationJobHistoryIdempotencyRecord[] = [];
  await runStreamingTransaction<AutomationJobHistoryIdempotencyRecord>(collection, () => false, {
    prepare: item => {
      assertIdempotencyRecord(item);
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
    withCommitGuard,
    operationCategory: 'automation_job_history_idempotency',
  });
}

async function appendHistoryRecords(
    collection: string,
    requested: readonly AutomationJobHistoryRecord[],
    withCommitGuard?: StorageCommitGuard,
): Promise<{ createdIds: Set<string>; segment: Awaited<ReturnType<typeof readHistorySegment>> }> {
  const requestedById = new Map(requested.map(record => [record.id, record]));
  if (requestedById.size !== requested.length) throw new Error('AUTOMATION_JOB_HISTORY_DUPLICATE_INPUT');
  let existingCount = 0;
  let estimatedBytes = 2;
  const existingIds = new Set<string>();
  let appendItems: AutomationJobHistoryRecord[] = [];
  await runStreamingTransaction<AutomationJobHistoryRecord>(collection, () => false, {
    prepare: item => {
      assertHistoryRecord(item);
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
    withCommitGuard,
    operationCategory: 'automation_job_history_append',
  });
  const segment = await readHistorySegment(collection);
  for (const record of requested) {
    if (!segment.records.some(item => item.id === record.id && item.jobFingerprint === record.jobFingerprint)) {
      throw new Error('AUTOMATION_JOB_HISTORY_ARCHIVE_VERIFY_FAILED');
    }
  }
  return { createdIds: new Set(appendItems.map(record => record.id)), segment };
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
  const segmentResults = new Map<string, Awaited<ReturnType<typeof appendHistoryRecords>>>();
  for (const [collection, group] of [...bySegment].sort(([left], [right]) => left.localeCompare(right))) {
    segmentResults.set(collection, await appendHistoryRecords(collection, group, options.withCommitGuard));
  }
  const byIndex = new Map<string, AutomationJobHistoryIdempotencyRecord[]>();
  for (const record of records.filter(item => item.job.status === 'SUCCEEDED')) {
    const indexRecord = makeIdempotencyRecord(record);
    const collection = automationJobHistoryIdempotencyCollection(indexRecord.keyDigest);
    const group = byIndex.get(collection) || [];
    group.push(indexRecord);
    byIndex.set(collection, group);
  }
  for (const [collection, group] of [...byIndex].sort(([left], [right]) => left.localeCompare(right))) {
    await appendIdempotencyRecords(collection, group, options.withCommitGuard);
  }
  await updateHistoryManifest(
      new Map([...segmentResults].map(([collection, result]) => [collection, result.segment])),
      nowMs,
      options.withCommitGuard,
  );
  await assertAutomationJobHistoryBatchArchived(jobs);
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
  const segment = await readHistorySegment(automationJobHistorySegmentCollection(id));
  const matches = segment.records.filter(record => record.jobId === id);
  if (!matches.length) return null;
  return structuredClone(matches.reduce(newestHistoryRecord).job);
}

export async function assertAutomationJobHistoryBatchArchived(
    jobs: readonly AutomationJob[],
): Promise<void> {
  if (!jobs.length) return;
  assertFileHistoryStorage();
  const manifest = await readAutomationJobHistoryManifest();
  const jobsBySegment = new Map<string, AutomationJob[]>();
  for (const job of jobs) {
    const collection = automationJobHistorySegmentCollection(job.id);
    const group = jobsBySegment.get(collection) || [];
    group.push(job);
    jobsBySegment.set(collection, group);
  }
  for (const [collection, group] of jobsBySegment) {
    const segment = await readHistorySegment(collection);
    const manifestSegment = manifest?.segments.find(item => item.collection === collection);
    if (
      !manifestSegment
      || manifestSegment.itemCount !== segment.itemCount
      || manifestSegment.contentFingerprint !== segment.contentFingerprint
      || fingerprint(manifestSegment.statusCounts) !== fingerprint(segment.statusCounts)
    ) throw new Error('AUTOMATION_JOB_HISTORY_MANIFEST_VERIFY_FAILED');
    for (const job of group) {
      const expectedFingerprint = automationJobHistoryFingerprint(job);
      if (!segment.records.some(record => (
        record.jobId === job.id && record.jobFingerprint === expectedFingerprint
      ))) throw new Error('AUTOMATION_JOB_HISTORY_ARCHIVE_VERIFY_FAILED');
    }
  }
  const successesByIndex = new Map<string, AutomationJob[]>();
  for (const job of jobs.filter(item => item.status === 'SUCCEEDED')) {
    const keyDigest = idempotencyKeyDigest(job.type, job.idempotencyKey);
    const collection = automationJobHistoryIdempotencyCollection(keyDigest);
    const group = successesByIndex.get(collection) || [];
    group.push(job);
    successesByIndex.set(collection, group);
  }
  for (const [collection, group] of successesByIndex) {
    const index = await readBoundedCollectionSnapshot<AutomationJobHistoryIdempotencyRecord>(
        collection,
        { maximumItems: HISTORY_INDEX_MAX_ITEMS, maximumBytes: HISTORY_INDEX_MAX_BYTES },
    );
    for (const item of index.items) assertIdempotencyRecord(item);
    for (const job of group) {
      const keyDigest = idempotencyKeyDigest(job.type, job.idempotencyKey);
      const expectedFingerprint = automationJobHistoryFingerprint(job);
      if (!index.items.some(item => (
        item.keyDigest === keyDigest
        && item.jobId === job.id
        && item.jobFingerprint === expectedFingerprint
      ))) throw new Error('AUTOMATION_JOB_HISTORY_INDEX_VERIFY_FAILED');
    }
  }
}

export async function assertAutomationJobHistoryArchived(job: AutomationJob): Promise<void> {
  await assertAutomationJobHistoryBatchArchived([job]);
}

export async function getArchivedSuccessfulAutomationJob(
    type: AutomationJobType,
    idempotencyKey: string,
    nowMs = Date.now(),
): Promise<AutomationJob | null> {
  if (getStorageCapabilities().driver !== 'file') return null;
  const keyDigest = idempotencyKeyDigest(type, idempotencyKey);
  const snapshot = await readBoundedCollectionSnapshot<AutomationJobHistoryIdempotencyRecord>(
      automationJobHistoryIdempotencyCollection(keyDigest),
      { maximumItems: HISTORY_INDEX_MAX_ITEMS, maximumBytes: HISTORY_INDEX_MAX_BYTES },
  );
  for (const item of snapshot.items) assertIdempotencyRecord(item);
  const retentionDays = Math.max(7, Number(process.env.SANDEAL_JOB_RETENTION_DAYS) || 30);
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60_000;
  const candidates = snapshot.items
      .filter(item => item.keyDigest === keyDigest && item.jobType === type)
      .filter(item => Date.parse(item.completedAt) >= cutoffMs)
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  for (const candidate of candidates) {
    const job = await getArchivedAutomationJob(candidate.jobId);
    if (
      job
      && job.status === 'SUCCEEDED'
      && job.type === type
      && job.idempotencyKey === idempotencyKey
      && automationJobHistoryFingerprint(job) === candidate.jobFingerprint
    ) return job;
  }
  return null;
}

export async function scanLatestArchivedAutomationJobs(
    visitor: (job: AutomationJob) => Promise<void> | void,
): Promise<{ archivedVersions: number; archivedJobs: number; statusCounts: AutomationJobHistoryStatusCounts }> {
  const manifest = await readAutomationJobHistoryManifest();
  if (!manifest) return { archivedVersions: 0, archivedJobs: 0, statusCounts: emptyStatusCounts() };
  let archivedJobs = 0;
  for (const entry of manifest.segments) {
    const segment = await readHistorySegment(entry.collection);
    if (
      segment.itemCount !== entry.itemCount
      || segment.contentFingerprint !== entry.contentFingerprint
      || fingerprint(segment.statusCounts) !== fingerprint(entry.statusCounts)
    ) {
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
});
