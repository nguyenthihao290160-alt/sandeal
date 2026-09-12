import {
  getStorageCapabilities,
  readBoundedCollectionSnapshot,
} from '@/lib/storage/adapter';
import type { StorageExclusiveHandle } from '@/lib/storage/types';
import {
  AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX,
  AUTOMATION_JOB_HISTORY_LIMITS,
  AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
  AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
  AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX,
  type AutomationJobHistoryIdempotencyRecord,
  type AutomationJobHistoryManifest,
  type AutomationJobHistoryPublicationIntent,
  type AutomationJobHistorySegmentSnapshot,
  assertAutomationJobHistoryIdempotencyRecord,
  assertAutomationJobHistoryManifest,
  assertAutomationJobHistoryPublicationIntent,
  automationJobHistoryCanonicalFingerprint,
  automationJobHistoryIdempotencyCollection,
  automationJobHistoryManifestTotals,
  completeAutomationJobHistoryPublicationIntentsCoordinated,
  convergeAutomationJobHistoryIndexesCoordinated,
  makeAutomationJobHistoryIdempotencyRecord,
  readAutomationJobHistorySegment,
  replaceAutomationJobHistoryManifestCoordinated,
  withAutomationJobHistoryCoordinator,
} from './jobHistoryArchive';

const PROGRAM = 'SANDEAL_V5_2_ZERO_TOUCH';
const HISTORY_INVARIANT_SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;

export type HistoryRecoveryClass = 'GREEN' | 'AMBER' | 'RED';
export type HistoryInvariantResult = 'PASS' | 'FAIL' | 'DEFERRED';

export interface AutomationJobHistoryRepairMismatch {
  category: 'SEGMENT' | 'MANIFEST' | 'INDEX' | 'PUBLICATION';
  collection: string;
  reasonCode: string;
  count: number;
}

interface MaintenanceIssue {
  collection: string;
  reasonCode: string;
  recordId?: string;
}

interface SegmentObservation {
  collection: string;
  collectionPresent: boolean | null;
  valid: boolean;
  errorCode?: string;
  snapshot?: AutomationJobHistorySegmentSnapshot;
}

interface ManifestObservation {
  collectionPresent: boolean;
  rawFingerprint: string;
  readable: boolean;
  valid: boolean;
  manifest: AutomationJobHistoryManifest | null;
  issue?: MaintenanceIssue;
  rawItems: unknown[];
}

interface IntentObservation {
  collectionPresent: boolean;
  rawFingerprint: string;
  valid: boolean;
  intents: AutomationJobHistoryPublicationIntent[];
  issues: MaintenanceIssue[];
}

interface IndexAudit {
  observationFingerprint: string;
  matching: number;
  missing: AutomationJobHistoryIdempotencyRecord[];
  conflicts: MaintenanceIssue[];
  invalidCollections: number;
}

interface ManifestAudit {
  structuralValid: boolean;
  exact: boolean;
  repairNeeded: boolean;
  unsafe: boolean;
  segmentsMatching: number;
  segmentsMismatched: number;
  globalTotalsExact: boolean;
  generationPresent: boolean;
  issues: MaintenanceIssue[];
}

interface HistoryAudit {
  stable: boolean;
  observationFingerprint: string;
  sourceFingerprint: string;
  planFingerprint: string;
  segments: SegmentObservation[];
  validSegments: AutomationJobHistorySegmentSnapshot[];
  invalidSegmentIssues: MaintenanceIssue[];
  manifestObservation: ManifestObservation;
  manifestAudit: ManifestAudit;
  intentObservation: IntentObservation;
  indexAudit: IndexAudit;
  archivedVersions: number;
  statusTotals: ReturnType<typeof automationJobHistoryManifestTotals>['statusCounts'];
  intrinsicSafeToApply: boolean;
}

export interface AutomationJobHistoryRepairPlan {
  schemaVersion: typeof HISTORY_INVARIANT_SCHEMA_VERSION;
  program: typeof PROGRAM;
  recoveryClass: HistoryRecoveryClass;
  stable: boolean;
  safeToApply: boolean;
  automaticMaintenanceEligible: boolean;
  noOp: boolean;
  segmentsTotal: number;
  segmentsMatching: number;
  segmentsMismatched: number;
  segmentsPresent: number;
  invalidSegments: number;
  missingIndexRecords: number;
  matchingIndexRecords: number;
  conflictingIndexRecords: number;
  invalidIndexCollections: number;
  pendingPublicationIntents: number;
  invalidPublicationIntents: number;
  archivedVersions: number;
  statusTotals: ReturnType<typeof automationJobHistoryManifestTotals>['statusCounts'];
  manifestStructuralValid: boolean;
  manifestGlobalTotalsExact: boolean;
  sourceFingerprint: string;
  planFingerprint: string;
  mismatchSummary: AutomationJobHistoryRepairMismatch[];
  blockers: string[];
}

export interface AutomationJobHistoryRepairApplyResult {
  result: 'APPLIED' | 'NO_OP';
  sourceFingerprint: string;
  planFingerprint: string;
  indexRecordsCreated: number;
  manifestRebuilt: boolean;
  intentsCompleted: number;
  verifierResult: 'PASS';
}

export interface V5HistoryInvariantReport {
  result: HistoryInvariantResult;
  recoveryClass: HistoryRecoveryClass;
  sourceFingerprint: string;
  planFingerprint: string;
  invariants: Array<{
    name: string;
    result: HistoryInvariantResult;
  }>;
  summary: {
    segmentsExpected: number;
    segmentsPresent: number;
    segmentsMatching: number;
    invalidSegments: number;
    archivedVersions: number;
    missingIndexes: number;
    conflictingIndexes: number;
    pendingPublications: number;
  };
}

function historyMaintenanceError(code: string): Error {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
}

function safeErrorCode(error: unknown, fallback: string): string {
  const explicit = error && typeof error === 'object'
      && typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code: string }).code)
      : error instanceof Error ? error.message.split(':', 1)[0] : '';
  return /^[A-Z][A-Z0-9_]{1,95}$/.test(explicit) ? explicit : fallback;
}

function assertFileStorage(): void {
  if (getStorageCapabilities().driver !== 'file') {
    throw historyMaintenanceError('AUTOMATION_JOB_HISTORY_FILE_STORAGE_REQUIRED');
  }
}

function segmentCollection(index: number): string {
  return `${AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}${index.toString(16).padStart(2, '0')}`;
}

function indexCollection(index: number): string {
  return `${AUTOMATION_JOB_HISTORY_IDEMPOTENCY_PREFIX}${index.toString(16).padStart(2, '0')}`;
}

function statusCountsEqual(left: unknown, right: unknown): boolean {
  return automationJobHistoryCanonicalFingerprint(left)
      === automationJobHistoryCanonicalFingerprint(right);
}

async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    work: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await work(values[index]);
    }
  }));
  return output;
}

async function readSegments(): Promise<SegmentObservation[]> {
  const collections = Array.from(
      { length: AUTOMATION_JOB_HISTORY_LIMITS.shardCount },
      (_, index) => segmentCollection(index),
  );
  return mapWithConcurrency(collections, 16, async collection => {
    try {
      const snapshot = await readAutomationJobHistorySegment(collection);
      return {
        collection,
        collectionPresent: snapshot.collectionPresent,
        valid: true,
        snapshot,
      };
    } catch (error) {
      return {
        collection,
        collectionPresent: null,
        valid: false,
        errorCode: safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_SEGMENT_INVALID'),
      };
    }
  });
}

async function readManifestObservation(): Promise<ManifestObservation> {
  try {
    const snapshot = await readBoundedCollectionSnapshot<unknown>(
        AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
        {
          maximumItems: AUTOMATION_JOB_HISTORY_LIMITS.shardCount,
          maximumBytes: AUTOMATION_JOB_HISTORY_LIMITS.manifestMaximumBytes,
        },
    );
    const rawFingerprint = automationJobHistoryCanonicalFingerprint(snapshot.items);
    if (!snapshot.items.length) {
      return {
        collectionPresent: snapshot.metadata.collectionPresent,
        rawFingerprint,
        readable: true,
        valid: true,
        manifest: null,
        rawItems: [],
      };
    }
    if (snapshot.items.length !== 1) {
      return {
        collectionPresent: true,
        rawFingerprint,
        readable: true,
        valid: false,
        manifest: null,
        rawItems: snapshot.items,
        issue: {
          collection: AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
          reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_INVALID',
        },
      };
    }
    try {
      assertAutomationJobHistoryManifest(snapshot.items[0]);
      return {
        collectionPresent: true,
        rawFingerprint,
        readable: true,
        valid: true,
        manifest: snapshot.items[0],
        rawItems: snapshot.items,
      };
    } catch (error) {
      return {
        collectionPresent: true,
        rawFingerprint,
        readable: true,
        valid: false,
        manifest: null,
        rawItems: snapshot.items,
        issue: {
          collection: AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
          reasonCode: safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_MANIFEST_INVALID'),
        },
      };
    }
  } catch (error) {
    const reasonCode = safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_MANIFEST_INVALID');
    return {
      collectionPresent: true,
      rawFingerprint: automationJobHistoryCanonicalFingerprint({ reasonCode }),
      readable: false,
      valid: false,
      manifest: null,
      rawItems: [],
      issue: { collection: AUTOMATION_JOB_HISTORY_MANIFEST_NAME, reasonCode },
    };
  }
}

async function readIntentObservation(): Promise<IntentObservation> {
  try {
    const snapshot = await readBoundedCollectionSnapshot<unknown>(
        AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
        {
          maximumItems: AUTOMATION_JOB_HISTORY_LIMITS.publicationIntentMaximumItems,
          maximumBytes: AUTOMATION_JOB_HISTORY_LIMITS.publicationIntentMaximumBytes,
        },
    );
    const intents: AutomationJobHistoryPublicationIntent[] = [];
    const issues: MaintenanceIssue[] = [];
    const ids = new Set<string>();
    for (const item of snapshot.items) {
      try {
        assertAutomationJobHistoryPublicationIntent(item);
        if (ids.has(item.id)) {
          issues.push({
            collection: AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
            reasonCode: 'AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_DUPLICATE',
            recordId: item.id,
          });
          continue;
        }
        ids.add(item.id);
        intents.push(item);
      } catch (error) {
        issues.push({
          collection: AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
          reasonCode: safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_INVALID'),
        });
      }
    }
    return {
      collectionPresent: snapshot.metadata.collectionPresent,
      rawFingerprint: automationJobHistoryCanonicalFingerprint(snapshot.items),
      valid: issues.length === 0,
      intents,
      issues,
    };
  } catch (error) {
    const reasonCode = safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_INVALID');
    return {
      collectionPresent: true,
      rawFingerprint: automationJobHistoryCanonicalFingerprint({ reasonCode }),
      valid: false,
      intents: [],
      issues: [{
        collection: AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
        reasonCode,
      }],
    };
  }
}

function sourceFingerprint(segments: readonly SegmentObservation[]): string {
  return automationJobHistoryCanonicalFingerprint(segments.map(observation => ({
    collection: observation.collection,
    collectionPresent: observation.collectionPresent,
    valid: observation.valid,
    ...(observation.valid && observation.snapshot ? {
      itemCount: observation.snapshot.itemCount,
      contentFingerprint: observation.snapshot.contentFingerprint,
      statusCounts: observation.snapshot.statusCounts,
    } : {
      errorCode: observation.errorCode,
    }),
  })));
}

function partialManifestEntries(rawItems: readonly unknown[]): Map<string, {
  itemCount: number;
  contentFingerprint?: string;
}> {
  const entries = new Map<string, { itemCount: number; contentFingerprint?: string }>();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const segments = (item as { segments?: unknown }).segments;
    if (!Array.isArray(segments)) continue;
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const candidate = segment as Record<string, unknown>;
      if (
        typeof candidate.collection !== 'string'
        || !candidate.collection.startsWith(AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX)
        || !Number.isSafeInteger(candidate.itemCount)
        || Number(candidate.itemCount) < 0
      ) continue;
      entries.set(candidate.collection, {
        itemCount: Number(candidate.itemCount),
        ...(typeof candidate.contentFingerprint === 'string'
          ? { contentFingerprint: candidate.contentFingerprint }
          : {}),
      });
    }
  }
  return entries;
}

function auditManifest(
    observation: ManifestObservation,
    segments: readonly SegmentObservation[],
): ManifestAudit {
  const issues: MaintenanceIssue[] = [];
  if (observation.issue) issues.push(observation.issue);
  const validSnapshots = segments
      .filter(item => item.valid && item.snapshot)
      .map(item => item.snapshot!);
  const hasHistory = validSnapshots.some(segment => segment.itemCount > 0);
  const typedEntries = new Map(
      (observation.manifest?.segments || []).map(item => [item.collection, item]),
  );
  const partialEntries = partialManifestEntries(observation.rawItems);
  const comparisonEntries = observation.manifest ? typedEntries : partialEntries;
  let matching = 0;
  let mismatched = 0;
  let unsafe = !observation.readable;

  for (const segment of segments) {
    const current = segment.snapshot;
    const entry = comparisonEntries.get(segment.collection);
    if (!segment.valid || !current) {
      mismatched += 1;
      continue;
    }
    if (current.itemCount === 0) {
      if (!entry) matching += 1;
      else {
        mismatched += 1;
        unsafe = true;
        issues.push({
          collection: segment.collection,
          reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_AHEAD_OF_CURRENT',
        });
      }
      continue;
    }
    if (!entry) {
      mismatched += 1;
      issues.push({
        collection: segment.collection,
        reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_ENTRY_MISSING',
      });
      continue;
    }
    if (entry.itemCount > current.itemCount) {
      mismatched += 1;
      unsafe = true;
      issues.push({
        collection: segment.collection,
        reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_AHEAD_OF_CURRENT',
      });
      continue;
    }
    if (entry.itemCount < current.itemCount) {
      mismatched += 1;
      issues.push({
        collection: segment.collection,
        reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_STALE',
      });
      continue;
    }
    if (entry.contentFingerprint !== current.contentFingerprint) {
      mismatched += 1;
      unsafe = true;
      issues.push({
        collection: segment.collection,
        reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CONFLICT',
      });
      continue;
    }
    if (
      observation.manifest
      && !statusCountsEqual(
          typedEntries.get(segment.collection)?.statusCounts,
          current.statusCounts,
      )
    ) {
      mismatched += 1;
      issues.push({
        collection: segment.collection,
        reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_STATUS_COUNTS_MISMATCH',
      });
      continue;
    }
    matching += 1;
  }

  const totals = automationJobHistoryManifestTotals(validSnapshots
      .filter(segment => segment.itemCount > 0)
      .map(segment => ({
        collection: segment.collection,
        itemCount: segment.itemCount,
        contentFingerprint: segment.contentFingerprint,
        statusCounts: segment.statusCounts,
      })));
  const globalTotalsExact = Boolean(
    observation.manifest
    && observation.manifest.archivedVersions === totals.archivedVersions
    && statusCountsEqual(observation.manifest.statusCounts, totals.statusCounts)
  );
  const structuralValid = observation.valid
      && Boolean(observation.manifest || !hasHistory);
  const generationPresent = !observation.manifest
      ? !hasHistory
      : Number.isSafeInteger(observation.manifest.manifestGeneration)
        && Number(observation.manifest.manifestGeneration) >= 0;
  const globalTotalsSatisfied = hasHistory
    ? globalTotalsExact
    : observation.manifest === null || globalTotalsExact;
  if (!globalTotalsSatisfied) {
    issues.push({
      collection: AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
      reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_GLOBAL_TOTALS_MISMATCH',
    });
  }
  if (!generationPresent) {
    issues.push({
      collection: AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
      reasonCode: 'AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_MISSING',
    });
  }
  const exact = structuralValid
      && mismatched === 0
      && globalTotalsSatisfied
      && generationPresent;
  return {
    structuralValid,
    exact,
    repairNeeded: !exact,
    unsafe,
    segmentsMatching: matching,
    segmentsMismatched: mismatched,
    globalTotalsExact: globalTotalsSatisfied,
    generationPresent,
    issues,
  };
}

function expectedIndexes(
    segments: readonly AutomationJobHistorySegmentSnapshot[],
): Map<string, AutomationJobHistoryIdempotencyRecord> {
  const expected = new Map<string, AutomationJobHistoryIdempotencyRecord>();
  for (const segment of segments) {
    for (const record of segment.records) {
      const indexRecord = makeAutomationJobHistoryIdempotencyRecord(record);
      const prior = expected.get(indexRecord.id);
      if (
        prior
        && automationJobHistoryCanonicalFingerprint(prior)
          !== automationJobHistoryCanonicalFingerprint(indexRecord)
      ) {
        throw historyMaintenanceError('AUTOMATION_JOB_HISTORY_INDEX_EXPECTATION_CONFLICT');
      }
      expected.set(indexRecord.id, indexRecord);
    }
  }
  return expected;
}

async function auditIndexes(
    expected: ReadonlyMap<string, AutomationJobHistoryIdempotencyRecord>,
): Promise<IndexAudit> {
  const collections = Array.from({ length: 256 }, (_, index) => indexCollection(index));
  const observed = new Map<string, AutomationJobHistoryIdempotencyRecord>();
  const conflicts: MaintenanceIssue[] = [];
  let invalidCollections = 0;
  const collectionFacts = await mapWithConcurrency(collections, 16, async collection => {
    try {
      const snapshot = await readBoundedCollectionSnapshot<unknown>(collection, {
        maximumItems: AUTOMATION_JOB_HISTORY_LIMITS.indexMaximumItems,
        maximumBytes: AUTOMATION_JOB_HISTORY_LIMITS.indexMaximumBytes,
      });
      const facts: unknown[] = [];
      for (const item of snapshot.items) {
        try {
          assertAutomationJobHistoryIdempotencyRecord(item);
          if (automationJobHistoryIdempotencyCollection(item.keyDigest) !== collection) {
            throw historyMaintenanceError('AUTOMATION_JOB_HISTORY_INDEX_SHARD_MISMATCH');
          }
          const prior = observed.get(item.id);
          if (prior) {
            conflicts.push({
              collection,
              recordId: item.id,
              reasonCode: 'AUTOMATION_JOB_HISTORY_INDEX_DUPLICATE_RECORD',
            });
          } else {
            observed.set(item.id, item);
          }
          facts.push(item);
        } catch (error) {
          conflicts.push({
            collection,
            reasonCode: safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_INDEX_INVALID'),
          });
          facts.push({ invalid: safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_INDEX_INVALID') });
        }
      }
      return {
        collection,
        collectionPresent: snapshot.metadata.collectionPresent,
        records: facts.sort((left, right) => automationJobHistoryCanonicalFingerprint(left)
            .localeCompare(automationJobHistoryCanonicalFingerprint(right))),
      };
    } catch (error) {
      invalidCollections += 1;
      const reasonCode = safeErrorCode(error, 'AUTOMATION_JOB_HISTORY_INDEX_INVALID');
      conflicts.push({ collection, reasonCode });
      return { collection, collectionPresent: null, errorCode: reasonCode };
    }
  });

  const missing: AutomationJobHistoryIdempotencyRecord[] = [];
  let matching = 0;
  for (const expectedRecord of [...expected.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const actual = observed.get(expectedRecord.id);
    if (!actual) {
      missing.push(expectedRecord);
      continue;
    }
    if (
      automationJobHistoryCanonicalFingerprint(actual)
      !== automationJobHistoryCanonicalFingerprint(expectedRecord)
    ) {
      conflicts.push({
        collection: automationJobHistoryIdempotencyCollection(expectedRecord.keyDigest),
        recordId: expectedRecord.id,
        reasonCode: 'AUTOMATION_JOB_HISTORY_INDEX_CONFLICT',
      });
      continue;
    }
    matching += 1;
  }
  for (const actual of observed.values()) {
    if (!expected.has(actual.id)) {
      conflicts.push({
        collection: automationJobHistoryIdempotencyCollection(actual.keyDigest),
        recordId: actual.id,
        reasonCode: 'AUTOMATION_JOB_HISTORY_INDEX_ORPHAN',
      });
    }
  }
  conflicts.sort((left, right) => (
    left.collection.localeCompare(right.collection)
    || String(left.recordId || '').localeCompare(String(right.recordId || ''))
    || left.reasonCode.localeCompare(right.reasonCode)
  ));
  return {
    observationFingerprint: automationJobHistoryCanonicalFingerprint(collectionFacts),
    matching,
    missing,
    conflicts,
    invalidCollections,
  };
}

async function auditOnce(): Promise<HistoryAudit> {
  assertFileStorage();
  const [segments, manifestObservation, intentObservation] = await Promise.all([
    readSegments(),
    readManifestObservation(),
    readIntentObservation(),
  ]);
  const invalidSegmentIssues = segments
      .filter(item => !item.valid)
      .map(item => ({
        collection: item.collection,
        reasonCode: item.errorCode || 'AUTOMATION_JOB_HISTORY_SEGMENT_INVALID',
      }));
  const validSegments = segments
      .filter(item => item.valid && item.snapshot)
      .map(item => item.snapshot!);
  const totals = automationJobHistoryManifestTotals(validSegments
      .filter(segment => segment.itemCount > 0)
      .map(segment => ({
        collection: segment.collection,
        itemCount: segment.itemCount,
        contentFingerprint: segment.contentFingerprint,
        statusCounts: segment.statusCounts,
      })));
  const expected = expectedIndexes(validSegments);
  const indexAudit = await auditIndexes(expected);
  const manifestAudit = auditManifest(manifestObservation, segments);
  const currentSourceFingerprint = sourceFingerprint(segments);
  const observationFingerprint = automationJobHistoryCanonicalFingerprint({
    sourceFingerprint: currentSourceFingerprint,
    manifest: manifestObservation.rawFingerprint,
    intents: intentObservation.rawFingerprint,
    indexes: indexAudit.observationFingerprint,
  });
  const planFingerprint = automationJobHistoryCanonicalFingerprint({
    schemaVersion: 1,
    sourceFingerprint: currentSourceFingerprint,
    manifestObservation: manifestObservation.rawFingerprint,
    manifestRepairNeeded: manifestAudit.repairNeeded,
    missingIndexes: indexAudit.missing,
    indexConflicts: indexAudit.conflicts,
    invalidSegments: invalidSegmentIssues,
    publicationIntents: intentObservation.intents.map(intent => intent.id).sort(),
    publicationIntentIssues: intentObservation.issues,
  });
  const intrinsicSafeToApply = invalidSegmentIssues.length === 0
      && indexAudit.conflicts.length === 0
      && !manifestAudit.unsafe
      && intentObservation.valid;
  return {
    stable: false,
    observationFingerprint,
    sourceFingerprint: currentSourceFingerprint,
    planFingerprint,
    segments,
    validSegments,
    invalidSegmentIssues,
    manifestObservation,
    manifestAudit,
    intentObservation,
    indexAudit,
    archivedVersions: totals.archivedVersions,
    statusTotals: totals.statusCounts,
    intrinsicSafeToApply,
  };
}

async function stableAudit(): Promise<HistoryAudit> {
  let prior: HistoryAudit | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await auditOnce();
    if (prior?.observationFingerprint === current.observationFingerprint) {
      return { ...current, stable: true };
    }
    prior = current;
  }
  return { ...prior!, stable: false };
}

function recoveryClass(audit: HistoryAudit): HistoryRecoveryClass {
  if (!audit.stable) return 'AMBER';
  if (!audit.intrinsicSafeToApply) return 'RED';
  if (audit.intentObservation.intents.length > 0) return 'AMBER';
  return 'GREEN';
}

function blockers(audit: HistoryAudit): string[] {
  const output = new Set<string>();
  if (!audit.stable) output.add('AUTOMATION_JOB_HISTORY_SOURCE_CHANGING');
  for (const issue of audit.invalidSegmentIssues) output.add(issue.reasonCode);
  for (const issue of audit.indexAudit.conflicts) output.add(issue.reasonCode);
  for (const issue of audit.intentObservation.issues) output.add(issue.reasonCode);
  for (const issue of audit.manifestAudit.issues) {
    if (audit.manifestAudit.unsafe) output.add(issue.reasonCode);
  }
  return [...output].sort();
}

function isNoOp(audit: HistoryAudit): boolean {
  return audit.manifestAudit.exact
      && audit.indexAudit.missing.length === 0
      && audit.indexAudit.conflicts.length === 0
      && audit.invalidSegmentIssues.length === 0
      && audit.intentObservation.intents.length === 0
      && audit.intentObservation.issues.length === 0;
}

function repairMismatchSummary(audit: HistoryAudit): AutomationJobHistoryRepairMismatch[] {
  const grouped = new Map<string, AutomationJobHistoryRepairMismatch>();
  const add = (
      category: AutomationJobHistoryRepairMismatch['category'],
      collection: string,
      reasonCode: string,
      count = 1,
  ): void => {
    const key = `${category}\u0000${collection}\u0000${reasonCode}`;
    const prior = grouped.get(key);
    if (prior) prior.count += count;
    else grouped.set(key, { category, collection, reasonCode, count });
  };
  for (const issue of audit.invalidSegmentIssues) {
    add('SEGMENT', issue.collection, issue.reasonCode);
  }
  for (const issue of audit.manifestAudit.issues) {
    add('MANIFEST', issue.collection, issue.reasonCode);
  }
  for (const record of audit.indexAudit.missing) {
    add(
        'INDEX',
        automationJobHistoryIdempotencyCollection(record.keyDigest),
        'AUTOMATION_JOB_HISTORY_INDEX_RECORD_MISSING',
    );
  }
  for (const issue of audit.indexAudit.conflicts) {
    add('INDEX', issue.collection, issue.reasonCode);
  }
  if (audit.intentObservation.intents.length) {
    add(
        'PUBLICATION',
        AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_NAME,
        'AUTOMATION_JOB_HISTORY_PUBLICATION_INTENT_PENDING',
        audit.intentObservation.intents.length,
    );
  }
  for (const issue of audit.intentObservation.issues) {
    add('PUBLICATION', issue.collection, issue.reasonCode);
  }
  return [...grouped.values()].sort((left, right) => (
    left.category.localeCompare(right.category)
    || left.collection.localeCompare(right.collection)
    || left.reasonCode.localeCompare(right.reasonCode)
  ));
}

function publicPlan(audit: HistoryAudit): AutomationJobHistoryRepairPlan {
  const classification = recoveryClass(audit);
  return {
    schemaVersion: HISTORY_INVARIANT_SCHEMA_VERSION,
    program: PROGRAM,
    recoveryClass: classification,
    stable: audit.stable,
    safeToApply: audit.stable && audit.intrinsicSafeToApply,
    automaticMaintenanceEligible: classification === 'GREEN'
      && audit.stable
      && audit.intrinsicSafeToApply,
    noOp: isNoOp(audit),
    segmentsTotal: AUTOMATION_JOB_HISTORY_LIMITS.shardCount,
    segmentsMatching: audit.manifestAudit.segmentsMatching,
    segmentsMismatched: audit.manifestAudit.segmentsMismatched,
    segmentsPresent: audit.segments.filter(item => item.collectionPresent === true).length,
    invalidSegments: audit.invalidSegmentIssues.length,
    missingIndexRecords: audit.indexAudit.missing.length,
    matchingIndexRecords: audit.indexAudit.matching,
    conflictingIndexRecords: audit.indexAudit.conflicts.length,
    invalidIndexCollections: audit.indexAudit.invalidCollections,
    pendingPublicationIntents: audit.intentObservation.intents.length,
    invalidPublicationIntents: audit.intentObservation.issues.length,
    archivedVersions: audit.archivedVersions,
    statusTotals: { ...audit.statusTotals },
    manifestStructuralValid: audit.manifestAudit.structuralValid,
    manifestGlobalTotalsExact: audit.manifestAudit.globalTotalsExact,
    sourceFingerprint: audit.sourceFingerprint,
    planFingerprint: audit.planFingerprint,
    mismatchSummary: repairMismatchSummary(audit),
    blockers: blockers(audit),
  };
}

export async function planAutomationJobHistoryRepair(): Promise<AutomationJobHistoryRepairPlan> {
  return publicPlan(await stableAudit());
}

function invariantReport(audit: HistoryAudit): V5HistoryInvariantReport {
  const pending = audit.intentObservation.intents.length > 0;
  const deferred = !audit.stable || (pending && audit.intrinsicSafeToApply);
  const exactIndexes = audit.indexAudit.missing.length === 0
      && audit.indexAudit.conflicts.length === 0;
  const invariant = (condition: boolean): HistoryInvariantResult => condition
    ? 'PASS'
    : deferred ? 'DEFERRED' : 'FAIL';
  const invariants: V5HistoryInvariantReport['invariants'] = [
    {
      name: 'HISTORY_SOURCE_SNAPSHOT_STABLE',
      result: audit.stable ? 'PASS' : 'DEFERRED',
    },
    {
      name: 'HISTORY_SEGMENTS_VALID_AND_BOUNDED',
      result: invariant(audit.invalidSegmentIssues.length === 0),
    },
    {
      name: 'HISTORY_MANIFEST_STRUCTURAL_VALID',
      result: invariant(audit.manifestAudit.structuralValid),
    },
    {
      name: 'HISTORY_SEGMENT_METADATA_EXACT',
      result: invariant(audit.manifestAudit.segmentsMismatched === 0),
    },
    {
      name: 'HISTORY_GLOBAL_TOTALS_EXACT',
      result: invariant(audit.manifestAudit.globalTotalsExact),
    },
    {
      name: 'HISTORY_IDEMPOTENCY_INDEX_CONVERGED',
      result: invariant(exactIndexes),
    },
    {
      name: 'HISTORY_PUBLICATION_JOURNAL_CONVERGED',
      result: pending ? 'DEFERRED' : invariant(audit.intentObservation.valid),
    },
  ];
  const result: HistoryInvariantResult = invariants.some(item => item.result === 'FAIL')
    ? 'FAIL'
    : invariants.some(item => item.result === 'DEFERRED') ? 'DEFERRED' : 'PASS';
  return {
    result,
    recoveryClass: recoveryClass(audit),
    sourceFingerprint: audit.sourceFingerprint,
    planFingerprint: audit.planFingerprint,
    invariants,
    summary: {
      segmentsExpected: AUTOMATION_JOB_HISTORY_LIMITS.shardCount,
      segmentsPresent: audit.segments.filter(item => item.collectionPresent === true).length,
      segmentsMatching: audit.manifestAudit.segmentsMatching,
      invalidSegments: audit.invalidSegmentIssues.length,
      archivedVersions: audit.archivedVersions,
      missingIndexes: audit.indexAudit.missing.length,
      conflictingIndexes: audit.indexAudit.conflicts.length,
      pendingPublications: audit.intentObservation.intents.length,
    },
  };
}

export async function verifyV5HistoryInvariants(): Promise<V5HistoryInvariantReport> {
  return invariantReport(await stableAudit());
}

async function applyCoordinated(
    handle: StorageExclusiveHandle,
    expectedSourceFingerprint: string,
    expectedPlanFingerprint: string,
    nowMs: number,
): Promise<AutomationJobHistoryRepairApplyResult> {
  const before = { ...(await auditOnce()), stable: true };
  if (before.sourceFingerprint !== expectedSourceFingerprint) {
    throw historyMaintenanceError('HISTORY_REPAIR_SOURCE_FINGERPRINT_CHANGED');
  }
  if (before.planFingerprint !== expectedPlanFingerprint) {
    throw historyMaintenanceError('HISTORY_REPAIR_PLAN_FINGERPRINT_CHANGED');
  }
  if (!before.intrinsicSafeToApply) {
    throw historyMaintenanceError('HISTORY_REPAIR_UNSAFE_TO_APPLY');
  }
  if (isNoOp(before)) {
    const report = invariantReport(before);
    if (report.result !== 'PASS') throw historyMaintenanceError('HISTORY_REPAIR_POST_VERIFY_FAILED');
    return {
      result: 'NO_OP',
      sourceFingerprint: before.sourceFingerprint,
      planFingerprint: before.planFingerprint,
      indexRecordsCreated: 0,
      manifestRebuilt: false,
      intentsCompleted: 0,
      verifierResult: 'PASS',
    };
  }

  await convergeAutomationJobHistoryIndexesCoordinated(
      before.indexAudit.missing,
      handle,
  );
  const manifestRebuilt = before.manifestAudit.repairNeeded;
  if (manifestRebuilt) {
    const sourceBeforeManifest = sourceFingerprint(await readSegments());
    if (sourceBeforeManifest !== expectedSourceFingerprint) {
      throw historyMaintenanceError('HISTORY_REPAIR_SOURCE_FINGERPRINT_CHANGED');
    }
    await replaceAutomationJobHistoryManifestCoordinated(
        before.validSegments.filter(segment => segment.itemCount > 0),
        nowMs,
        handle,
    );
  }
  const intentIds = before.intentObservation.intents.map(intent => intent.id);
  if (intentIds.length) {
    await completeAutomationJobHistoryPublicationIntentsCoordinated(
        intentIds,
        nowMs,
        handle,
    );
  }

  const after = { ...(await auditOnce()), stable: true };
  const report = invariantReport(after);
  if (report.result !== 'PASS') throw historyMaintenanceError('HISTORY_REPAIR_POST_VERIFY_FAILED');
  return {
    result: 'APPLIED',
    sourceFingerprint: before.sourceFingerprint,
    planFingerprint: before.planFingerprint,
    indexRecordsCreated: before.indexAudit.missing.length,
    manifestRebuilt,
    intentsCompleted: intentIds.length,
    verifierResult: 'PASS',
  };
}

export async function applyAutomationJobHistoryRepair(options: {
  expectedSourceFingerprint: string;
  expectedPlanFingerprint: string;
  nowMs?: number;
}): Promise<AutomationJobHistoryRepairApplyResult> {
  assertFileStorage();
  if (
    !SHA256.test(options.expectedSourceFingerprint)
    || !SHA256.test(options.expectedPlanFingerprint)
  ) {
    throw historyMaintenanceError('HISTORY_REPAIR_APPLY_FINGERPRINTS_REQUIRED');
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs)) throw historyMaintenanceError('HISTORY_REPAIR_TIME_INVALID');
  return withAutomationJobHistoryCoordinator(handle => applyCoordinated(
      handle,
      options.expectedSourceFingerprint,
      options.expectedPlanFingerprint,
      nowMs,
  ));
}
