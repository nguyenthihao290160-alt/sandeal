import { createHash } from 'node:crypto';
import { findById, generateId, readBoundedCollection, runTransaction } from './adapter';
import type { StorageCommitGuard } from './types';
import type { CandidateLane, CommerceSourceEvidence, Product } from '../types';
import { LANE_PRIORITY } from '../bots/candidateReadiness';

const COLLECTION = 'candidate-queue';
const PROCESSING_TTL_MS = 15 * 60_000;
const MAX_ACTIVE_CANDIDATES = 10_000;
const MAX_ACTIVE_CANDIDATE_BYTES = 32 * 1024 * 1024;

export const CANDIDATE_QUEUE_SCHEMA_VERSION = 3;
export const MAX_CANDIDATE_DURABLE_JOB_GENERATION = 32;

export type CandidateQueueStatus = 'pending' | 'processing' | 'completed' | 'needs_review' | 'delayed' | 'failed' | 'discarded';

export interface CandidatePayload {
  title: string;
  description?: string;
  kind: Product['kind'];
  platform: Product['platform'];
  originalUrl: string;
  canonicalProductUrl?: string;
  canonicalUrlSource?: 'provider_api' | 'none';
  canonicalUrlProvider?: 'accesstrade';
  canonicalUrlSourceEndpoint?: 'datafeed' | 'offers' | 'tiktok_product_feed_v2';
  canonicalUrlSourceField?: string;
  canonicalUrlFetchedAt?: string;
  canonicalUrlStatus?: 'available' | 'unavailable';
  affiliateUrl: string;
  affiliateUrlSource?: 'provider_api' | 'none';
  affiliateUrlProvider?: 'accesstrade';
  affiliateUrlSourceEndpoint?: 'datafeed' | 'offers' | 'tiktok_create_link_v2';
  affiliateUrlSourceField?: string;
  affiliateUrlCampaignId?: string;
  affiliateUrlFetchedAt?: string;
  affiliateUrlStatus?: 'available' | 'unavailable';
  imageUrl: string;
  imageCandidates?: string[];
  price?: number;
  salePrice?: number;
  currency: 'VND';
  category?: string;
  brand?: string;
  model?: string;
  sku?: string;
  gtin?: string;
  mpn?: string;
  specifications?: Record<string, string | number>;
  merchant?: string;
  merchantDomain?: string;
  merchantIdentity?: string;
  shopId?: string;
  shopName?: string;
  sourceItemId?: string;
  sourceEndpoint?: 'datafeed' | 'offers' | 'tiktok_product_feed_v2';
  sourceFetchedAt?: string;
  providerUpdatedAt?: string;
  sourceNormalizationIssues?: string[];
  fieldProvenance?: Product['fieldProvenance'];
  rawSourceKind?: string;
  nonProductReason?: string;
  campaignName?: string;
  commissionRate?: number;
  commissionAmount?: number;
  unitsSold?: number;
  categoryId?: string;
  categoryChain?: Array<{ id: string; name: string; parentId?: string; leaf: boolean }>;
  available?: boolean;
  verifiedSource: boolean;
  autoPublishEligible: boolean;
  sourceQualityScore?: number;
  isolatedHealthFixture?: 'healthy' | 'temporary_failure' | 'confirmed_broken';
}

export interface CandidateQueueItem {
  schemaVersion?: number;
  id: string;
  source: Product['source'];
  sourceId: string;
  status: CandidateQueueStatus;
  priority: number;
  readinessScore?: number;
  lane?: CandidateLane;
  attempts: number;
  nextAttemptAt?: string;
  delayReason?: string;
  terminalReason?: string;
  retryable?: boolean;
  lastProbeAt?: string;
  affiliateGatewayDomain?: string;
  merchantDomain?: string;
  sourceEvidence?: CommerceSourceEvidence;
  createdAt: string;
  updatedAt: string;
  processingStartedAt?: string;
  contentHash: string;
  sourceHash: string;
  keyword?: string;
  durableJobId?: string;
  durableJobKey?: string;
  /** Exact operation identity reserved for this sourceHash/generation. */
  durableOperationId?: string;
  /** Set while a non-runnable durable job is being materialized. */
  durableJobPreparedAt?: string;
  /** Monotonic generation used only after a bound durable job is terminal. */
  durableJobGeneration?: number;
  /** Explicit terminal-failure intent consumed by a bounded generation CAS. */
  durableJobGenerationAdvanceIntent?: CandidateDurableJobGenerationAdvanceIntent;
  /** Last atomic generation transition, retained as bounded operator evidence. */
  durableJobGenerationLastAdvance?: CandidateDurableJobGenerationAdvanceAudit;
  bridgedAt?: string;
  payload: CandidatePayload;
}

export interface CandidateDurableJobGenerationAdvanceIntent {
  jobId: string;
  sourceHash: string;
  generation: number;
  durableJobKey: string;
  operationId: string;
  reasonCode: string;
  requestedBy: string;
  requestedAt: string;
}

export interface CandidateDurableJobGenerationAdvanceAudit {
  fromJobId: string;
  fromSourceHash: string;
  fromGeneration: number;
  toGeneration: number;
  reasonCode: string;
  requestedBy: string;
  advancedAt: string;
}

type CandidateEnqueueInput = Omit<CandidateQueueItem,
  | 'id'
  | 'status'
  | 'attempts'
  | 'createdAt'
  | 'updatedAt'
  | 'durableJobId'
  | 'durableJobKey'
  | 'durableOperationId'
  | 'durableJobPreparedAt'
  | 'durableJobGeneration'
  | 'durableJobGenerationAdvanceIntent'
  | 'durableJobGenerationLastAdvance'
  | 'bridgedAt'>;

export function readCandidateDurableJobGeneration(
  item: Pick<CandidateQueueItem, 'durableJobGeneration'>,
): number {
  if (item.durableJobGeneration === undefined || item.durableJobGeneration === null) return 0;
  const generation = Number(item.durableJobGeneration);
  if (
    !Number.isSafeInteger(generation)
    || generation < 0
    || generation > MAX_CANDIDATE_DURABLE_JOB_GENERATION
  ) throw new Error('CANDIDATE_DURABLE_JOB_GENERATION_INVALID');
  return generation;
}

function boundedCandidateIdentity(
  prefix: 'candidate:' | 'candidate-operation:',
  candidateId: string,
  sourceHash: string,
  generation: number,
): string {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_CANDIDATE_DURABLE_JOB_GENERATION) {
    throw new Error('CANDIDATE_DURABLE_JOB_GENERATION_INVALID');
  }
  const suffix = `:g${generation}`;
  const base = `${prefix}${candidateId}:${sourceHash}`;
  if (base.length + suffix.length <= 160) return `${base}${suffix}`;
  const identityDigest = createHash('sha256')
    .update(`${candidateId}\0${sourceHash}`)
    .digest('hex')
    .slice(0, 24);
  const retainedLength = 160 - prefix.length - identityDigest.length - suffix.length - 1;
  return `${prefix}${candidateId.slice(0, Math.max(0, retainedLength))}:${identityDigest}${suffix}`;
}

export function candidateDurableJobKey(candidateId: string, sourceHash: string, generation: number): string {
  return boundedCandidateIdentity('candidate:', candidateId, sourceHash, generation);
}

export function candidateDurableOperationId(candidateId: string, sourceHash: string, generation: number): string {
  return boundedCandidateIdentity('candidate-operation:', candidateId, sourceHash, generation);
}

export async function listCandidateQueue(): Promise<CandidateQueueItem[]> {
  return readBoundedCollection<CandidateQueueItem>(COLLECTION, {
    maximumItems: MAX_ACTIVE_CANDIDATES,
    maximumBytes: MAX_ACTIVE_CANDIDATE_BYTES,
  });
}

export async function recoverStaleProcessing(now = Date.now(), ttlMs = PROCESSING_TTL_MS): Promise<number> {
  let recovered = 0;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    for (const item of items) {
      if (item.status !== 'processing') continue;
      const started = Date.parse(item.processingStartedAt || item.updatedAt);
      if (Number.isFinite(started) && now - started <= ttlMs) continue;
      item.status = 'pending';
      item.processingStartedAt = undefined;
      item.delayReason = 'processing_ttl_expired';
      item.updatedAt = new Date(now).toISOString();
      recovered++;
    }
    return recovered ? items : undefined;
  });
  return recovered;
}

export async function enqueueCandidate(input: CandidateEnqueueInput): Promise<{ item: CandidateQueueItem; queued: boolean; unchanged: boolean }> {
  let output!: { item: CandidateQueueItem; queued: boolean; unchanged: boolean };
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const existing = items.find((item) => item.source === input.source && item.sourceId === input.sourceId);
    // Terminal outcomes are durable for the same exact source snapshot. A new
    // provider sourceHash is required before the item may re-enter automation.
    if (existing && existing.sourceHash === input.sourceHash) {
      output = { item: structuredClone(existing), queued: false, unchanged: true };
      return undefined;
    }
    // A durable worker owns this exact immutable snapshot until the candidate
    // reaches a final completed/discarded disposition. A handler may write
    // needs_review/failed immediately before its durable job commits, so those
    // states are protected too. Defer the newer observation to a later scan.
    if (
      existing
      && !['completed', 'discarded'].includes(existing.status)
      && Boolean(existing.durableJobId || existing.durableJobKey || existing.durableOperationId)
    ) {
      output = { item: structuredClone(existing), queued: false, unchanged: true };
      return undefined;
    }
    const now = new Date().toISOString();
    if (existing) {
      const sourceChanged = existing.sourceHash !== input.sourceHash;
      Object.assign(existing, input, {
        schemaVersion: CANDIDATE_QUEUE_SCHEMA_VERSION, status: 'pending', attempts: 0, updatedAt: now,
        processingStartedAt: undefined, delayReason: undefined,
        terminalReason: undefined, retryable: undefined, nextAttemptAt: undefined,
        lastProbeAt: undefined, sourceEvidence: undefined,
      });
      if (sourceChanged) {
        existing.durableJobId = undefined;
        existing.durableJobKey = undefined;
        existing.durableOperationId = undefined;
        existing.durableJobPreparedAt = undefined;
        existing.durableJobGeneration = 0;
        existing.durableJobGenerationAdvanceIntent = undefined;
        existing.bridgedAt = undefined;
      }
      output = { item: structuredClone(existing), queued: true, unchanged: false };
      return items;
    }
    const item: CandidateQueueItem = {
      ...input,
      schemaVersion: CANDIDATE_QUEUE_SCHEMA_VERSION,
      id: generateId(),
      status: 'pending',
      attempts: 0,
      durableJobGeneration: 0,
      createdAt: now,
      updatedAt: now,
    };
    items.push(item);
    output = { item: structuredClone(item), queued: true, unchanged: false };
    return items;
  });
  return output;
}

export async function getCandidateById(id: string): Promise<CandidateQueueItem | null> {
  return findById<CandidateQueueItem>(COLLECTION, id);
}

export async function markCandidateBridged(id: string, jobId: string, durableJobKey: string): Promise<CandidateQueueItem | null> {
  let output: CandidateQueueItem | null = null;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === id);
    if (!item) return undefined;
    if (item.durableJobId && item.durableJobId !== jobId) throw new Error('CANDIDATE_ALREADY_BRIDGED');
    item.schemaVersion = CANDIDATE_QUEUE_SCHEMA_VERSION;
    item.durableJobId = jobId;
    item.durableJobKey = durableJobKey;
    item.bridgedAt ||= new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    output = structuredClone(item);
    return items;
  });
  return output;
}

export interface CandidateDurableJobBinding {
  candidateId: string;
  sourceHash: string;
  generation: number;
  jobId: string;
  durableJobKey: string;
  operationId: string;
  expectedUpdatedAt?: string;
}

function candidateBindingMatches(item: CandidateQueueItem, input: CandidateDurableJobBinding): boolean {
  return item.id === input.candidateId
    && item.sourceHash === input.sourceHash
    && readCandidateDurableJobGeneration(item) === input.generation
    && item.durableJobId === input.jobId
    && item.durableJobKey === input.durableJobKey
    && item.durableOperationId === input.operationId;
}

/**
 * Bind one exact candidate snapshot to a prepared, non-runnable durable job.
 * Replaying the same binding is idempotent; a different job never replaces
 * the authoritative job for this generation.
 */
export async function bindCandidateToPreparedDurableJob(
  input: CandidateDurableJobBinding,
): Promise<CandidateQueueItem | null> {
  let output: CandidateQueueItem | null = null;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === input.candidateId);
    if (!item || item.sourceHash !== input.sourceHash || readCandidateDurableJobGeneration(item) !== input.generation) return undefined;
    if (candidateBindingMatches(item, input)) {
      output = structuredClone(item);
      return undefined;
    }
    if (item.durableJobId || item.durableJobKey || item.durableOperationId) return undefined;
    if (!['pending', 'delayed'].includes(item.status)) return undefined;
    if (input.expectedUpdatedAt && item.updatedAt !== input.expectedUpdatedAt) return undefined;
    const now = new Date().toISOString();
    item.schemaVersion = CANDIDATE_QUEUE_SCHEMA_VERSION;
    item.durableJobId = input.jobId;
    item.durableJobKey = input.durableJobKey;
    item.durableOperationId = input.operationId;
    item.durableJobPreparedAt = now;
    item.durableJobGenerationAdvanceIntent = undefined;
    item.bridgedAt = undefined;
    item.updatedAt = now;
    output = structuredClone(item);
    return items;
  }, { operationCategory: 'candidate_job_materialization_bind' });
  return output;
}

/** Mark the exact prepared binding complete after its journal is durable. */
export async function completeCandidateDurableJobBinding(
  input: CandidateDurableJobBinding,
): Promise<CandidateQueueItem | null> {
  let output: CandidateQueueItem | null = null;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === input.candidateId);
    if (!item || !candidateBindingMatches(item, input)) return undefined;
    const now = new Date().toISOString();
    item.schemaVersion = CANDIDATE_QUEUE_SCHEMA_VERSION;
    if (item.bridgedAt && !item.durableJobPreparedAt) {
      output = structuredClone(item);
      return undefined;
    }
    item.bridgedAt ||= now;
    item.durableJobPreparedAt = undefined;
    item.updatedAt = now;
    output = structuredClone(item);
    return items;
  });
  return output;
}

/**
 * Preserve an already-materialized legacy or terminal durable job as the
 * authority for this generation. This does not make a terminal candidate
 * runnable or advance its generation; an operator/retry transition remains
 * explicit.
 */
export async function bindCandidateToHistoricalDurableJob(
  input: CandidateDurableJobBinding,
): Promise<CandidateQueueItem | null> {
  let output: CandidateQueueItem | null = null;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === input.candidateId);
    if (!item || item.sourceHash !== input.sourceHash || readCandidateDurableJobGeneration(item) !== input.generation) return undefined;
    if (candidateBindingMatches(item, input)) {
      output = structuredClone(item);
      return undefined;
    }
    if (item.durableJobId || item.durableJobKey || item.durableOperationId) return undefined;
    if (!['pending', 'delayed'].includes(item.status)) return undefined;
    if (input.expectedUpdatedAt && item.updatedAt !== input.expectedUpdatedAt) return undefined;
    const now = new Date().toISOString();
    item.schemaVersion = CANDIDATE_QUEUE_SCHEMA_VERSION;
    item.durableJobId = input.jobId;
    item.durableJobKey = input.durableJobKey;
    item.durableOperationId = input.operationId;
    item.durableJobPreparedAt = undefined;
    item.durableJobGenerationAdvanceIntent = undefined;
    item.bridgedAt ||= now;
    item.updatedAt = now;
    output = structuredClone(item);
    return items;
  }, { operationCategory: 'candidate_job_materialization_history_bind' });
  return output;
}

export async function candidateHasAuthoritativeDurableJobBinding(
  input: CandidateDurableJobBinding,
): Promise<boolean> {
  const item = await getCandidateById(input.candidateId);
  return Boolean(item && candidateBindingMatches(item, input));
}

/** Hold the candidate collection authority through another durable commit. */
export function candidateDurableJobBindingCommitGuard(
  input: CandidateDurableJobBinding,
  options: { completeBinding?: boolean } = {},
): StorageCommitGuard {
  return async commit => {
    let committed = false;
    let result: unknown;
    await runTransaction<CandidateQueueItem>(COLLECTION, async items => {
      const item = items.find(entry => entry.id === input.candidateId);
      if (!item || !candidateBindingMatches(item, input)) {
        throw new Error('CANDIDATE_BINDING_AUTHORITY_LOST');
      }
      result = await commit();
      committed = true;
      if (!options.completeBinding) return undefined;
      const now = new Date().toISOString();
      item.schemaVersion = CANDIDATE_QUEUE_SCHEMA_VERSION;
      item.bridgedAt ||= now;
      item.durableJobPreparedAt = undefined;
      item.updatedAt = now;
      return items;
    }, { operationCategory: 'candidate_job_materialization_authority' });
    if (!committed) throw new Error('CANDIDATE_BINDING_AUTHORITY_LOST');
    return result as Awaited<ReturnType<typeof commit>>;
  };
}

export async function clearOrphanedCandidateBridge(
  id: string,
  missingJobId: string,
  expected: Pick<CandidateDurableJobBinding, 'sourceHash' | 'generation' | 'durableJobKey' | 'operationId'>,
): Promise<boolean> {
  let cleared = false;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === id);
    if (!item || item.durableJobId !== missingJobId || !['pending', 'delayed'].includes(item.status)) return undefined;
    if (
      item.sourceHash !== expected.sourceHash
      || readCandidateDurableJobGeneration(item) !== expected.generation
      || item.durableJobKey !== expected.durableJobKey
      || (item.durableOperationId !== undefined && item.durableOperationId !== expected.operationId)
    ) return undefined;
    const generation = readCandidateDurableJobGeneration(item);
    if (generation >= MAX_CANDIDATE_DURABLE_JOB_GENERATION) {
      item.status = 'needs_review';
      item.retryable = false;
      item.nextAttemptAt = undefined;
      item.delayReason = 'candidate_generation_limit_reached';
      item.terminalReason = 'candidate_generation_limit_reached';
      item.durableJobGenerationAdvanceIntent = undefined;
      item.updatedAt = new Date().toISOString();
      cleared = true;
      return items;
    }
    item.durableJobGeneration = generation + 1;
    item.durableJobId = undefined;
    item.durableJobKey = undefined;
    item.durableOperationId = undefined;
    item.durableJobPreparedAt = undefined;
    item.durableJobGenerationAdvanceIntent = undefined;
    item.bridgedAt = undefined;
    item.delayReason = 'orphaned_durable_job_recovered';
    item.updatedAt = new Date().toISOString();
    cleared = true;
    return items;
  });
  return cleared;
}

export async function claimCandidateForDurableJob(id: string, jobId: string, nowMs = Date.now()): Promise<CandidateQueueItem | null> {
  let output: CandidateQueueItem | null = null;
  await recoverStaleProcessing(nowMs);
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === id);
    if (!item || item.durableJobId !== jobId) return undefined;
    readCandidateDurableJobGeneration(item);
    if (['completed', 'discarded'].includes(item.status)) { output = structuredClone(item); return undefined; }
    if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > nowMs) return undefined;
    if (item.status === 'processing' && item.processingStartedAt && nowMs - Date.parse(item.processingStartedAt) <= PROCESSING_TTL_MS) return undefined;
    if (!['pending', 'delayed', 'needs_review', 'failed'].includes(item.status)) return undefined;
    item.status = 'processing';
    item.processingStartedAt = new Date(nowMs).toISOString();
    item.updatedAt = item.processingStartedAt;
    item.attempts += 1;
    output = structuredClone(item);
    return items;
  });
  return output;
}

export async function claimCandidateBatch(limit: number, now = Date.now()): Promise<CandidateQueueItem[]> {
  await recoverStaleProcessing(now);
  let claimed: CandidateQueueItem[] = [];
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const due = items
      .filter((item) => ['pending', 'delayed'].includes(item.status) && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now))
      .sort((a, b) => (LANE_PRIORITY[b.lane || (b.status === 'delayed' ? 'RETRY_LANE' : 'NORMAL_LANE')] - LANE_PRIORITY[a.lane || (a.status === 'delayed' ? 'RETRY_LANE' : 'NORMAL_LANE')]) || b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, Math.max(0, limit));
    const timestamp = new Date(now).toISOString();
    for (const item of due) {
      item.status = 'processing';
      item.processingStartedAt = timestamp;
      item.updatedAt = timestamp;
      item.attempts += 1;
    }
    claimed = due.map((item) => structuredClone(item));
    return due.length ? items : undefined;
  });
  return claimed;
}

/**
 * Release a delayed candidate from one exact terminal durable job. The CAS on
 * job id prevents an old worker from clearing a newer bridge. Incrementing the
 * generation gives the next cooldown attempt a distinct durable idempotency
 * key without weakening sourceHash identity.
 */
export async function advanceCandidateBridgeGeneration(
  input: CandidateDurableJobBinding,
): Promise<boolean> {
  let advanced = false;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === input.candidateId);
    if (
      !item
      || !candidateBindingMatches(item, input)
      || item.status !== 'delayed'
      || item.retryable !== true
      || !item.nextAttemptAt
    ) return undefined;
    const generation = readCandidateDurableJobGeneration(item);
    const intent = item.durableJobGenerationAdvanceIntent;
    if (
      !intent
      || intent.jobId !== input.jobId
      || intent.sourceHash !== input.sourceHash
      || intent.generation !== input.generation
      || intent.durableJobKey !== input.durableJobKey
      || intent.operationId !== input.operationId
    ) return undefined;
    if (generation >= MAX_CANDIDATE_DURABLE_JOB_GENERATION) {
      item.status = 'needs_review';
      item.retryable = false;
      item.nextAttemptAt = undefined;
      item.delayReason = 'candidate_generation_limit_reached';
      item.terminalReason = 'candidate_generation_limit_reached';
      item.durableJobGenerationAdvanceIntent = undefined;
      item.updatedAt = new Date().toISOString();
      advanced = true;
      return items;
    }
    const advancedAt = new Date().toISOString();
    item.durableJobGeneration = generation + 1;
    item.durableJobGenerationLastAdvance = {
      fromJobId: input.jobId,
      fromSourceHash: input.sourceHash,
      fromGeneration: generation,
      toGeneration: generation + 1,
      reasonCode: intent.reasonCode,
      requestedBy: intent.requestedBy || 'legacy-generation-intent',
      advancedAt,
    };
    item.durableJobId = undefined;
    item.durableJobKey = undefined;
    item.durableOperationId = undefined;
    item.durableJobPreparedAt = undefined;
    item.durableJobGenerationAdvanceIntent = undefined;
    item.bridgedAt = undefined;
    item.updatedAt = advancedAt;
    advanced = true;
    return items;
  });
  return advanced;
}

export async function requestCandidateBridgeGenerationAdvance(
  input: CandidateDurableJobBinding,
  reasonCode: string,
  requestedBy = 'automation-worker-failure',
): Promise<boolean> {
  let requested = false;
  const normalizedReasonCode = reasonCode.trim().slice(0, 160) || 'candidate_retry_exhausted';
  const normalizedRequestedBy = requestedBy.trim().slice(0, 160) || 'unknown-operator';
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === input.candidateId);
    if (
      !item
      || !candidateBindingMatches(item, input)
      || item.status !== 'delayed'
      || item.retryable !== true
      || !item.nextAttemptAt
    ) return undefined;
    const existing = item.durableJobGenerationAdvanceIntent;
    if (existing) {
      requested = existing.jobId === input.jobId
        && existing.sourceHash === input.sourceHash
        && existing.generation === input.generation
        && existing.durableJobKey === input.durableJobKey
        && existing.operationId === input.operationId
        && existing.reasonCode === normalizedReasonCode
        && existing.requestedBy === normalizedRequestedBy;
      return undefined;
    }
    item.durableJobGenerationAdvanceIntent = {
      jobId: input.jobId,
      sourceHash: input.sourceHash,
      generation: input.generation,
      durableJobKey: input.durableJobKey,
      operationId: input.operationId,
      reasonCode: normalizedReasonCode,
      requestedBy: normalizedRequestedBy,
      requestedAt: new Date().toISOString(),
    };
    item.updatedAt = new Date().toISOString();
    requested = true;
    return items;
  }, { operationCategory: 'candidate_job_generation_advance_intent' });
  return requested;
}

/**
 * Exhaust a prepared identity that reached a terminal state before binding.
 * The exact source/generation CAS prevents a cancelled preparation from being
 * silently materialized again under the same durable key.
 */
export async function advanceUnboundCandidateBridgeGeneration(
  input: Pick<CandidateDurableJobBinding, 'candidateId' | 'sourceHash' | 'generation'>,
): Promise<boolean> {
  let advanced = false;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === input.candidateId);
    if (
      !item
      || item.sourceHash !== input.sourceHash
      || readCandidateDurableJobGeneration(item) !== input.generation
      || item.durableJobId
      || item.durableJobKey
      || item.durableOperationId
      || !['pending', 'delayed'].includes(item.status)
    ) return undefined;
    if (input.generation >= MAX_CANDIDATE_DURABLE_JOB_GENERATION) {
      item.status = 'needs_review';
      item.retryable = false;
      item.nextAttemptAt = undefined;
      item.delayReason = 'candidate_generation_limit_reached';
      item.terminalReason = 'candidate_generation_limit_reached';
    } else {
      item.durableJobGeneration = input.generation + 1;
      item.delayReason = 'prepared_durable_job_identity_exhausted';
    }
    item.durableJobGenerationAdvanceIntent = undefined;
    item.updatedAt = new Date().toISOString();
    advanced = true;
    return items;
  }, { operationCategory: 'candidate_job_unbound_generation_advance' });
  return advanced;
}

export async function finishCandidate(
  id: string,
  update: Pick<CandidateQueueItem, 'status'> & Partial<Pick<CandidateQueueItem,
    'nextAttemptAt' | 'delayReason' | 'terminalReason' | 'retryable' | 'lastProbeAt'
    | 'affiliateGatewayDomain' | 'merchantDomain' | 'sourceEvidence'>>,
): Promise<void> {
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find((entry) => entry.id === id);
    if (!item) return undefined;
    Object.assign(item, update, { processingStartedAt: undefined, updatedAt: new Date().toISOString() });
    if (update.status !== 'delayed' || update.retryable !== true || !update.nextAttemptAt) {
      item.durableJobGenerationAdvanceIntent = undefined;
    }
    return items;
  });
}

export async function getQueueStats(): Promise<Record<CandidateQueueStatus | 'total', number>> {
  const items = await listCandidateQueue();
  const stats = { total: items.length, pending: 0, processing: 0, completed: 0, needs_review: 0, delayed: 0, failed: 0, discarded: 0 };
  for (const item of items) stats[item.status]++;
  return stats;
}

export async function cleanupCandidateQueue(now = Date.now(), retentionMs = 7 * 24 * 60 * 60_000): Promise<number> {
  let removed = 0;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const kept = items.filter((item) => !['completed', 'discarded'].includes(item.status) || now - Date.parse(item.updatedAt) < retentionMs);
    removed = items.length - kept.length;
    return removed ? kept : undefined;
  });
  return removed;
}
