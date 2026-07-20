import { generateId, readCollection, runTransaction, writeCollection } from './adapter';
import type { CandidateLane, Product } from '../types';
import { LANE_PRIORITY } from '../bots/candidateReadiness';

const COLLECTION = 'candidate-queue';
const PROCESSING_TTL_MS = 15 * 60_000;

export type CandidateQueueStatus = 'pending' | 'processing' | 'completed' | 'needs_review' | 'delayed' | 'failed' | 'discarded';

export interface CandidatePayload {
  title: string;
  description?: string;
  kind: Product['kind'];
  platform: Product['platform'];
  originalUrl: string;
  affiliateUrl: string;
  affiliateUrlSource?: 'provider_api' | 'none';
  affiliateUrlProvider?: 'accesstrade';
  affiliateUrlSourceEndpoint?: 'datafeed' | 'offers';
  affiliateUrlSourceField?: string;
  affiliateUrlCampaignId?: string;
  affiliateUrlFetchedAt?: string;
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
  rawSourceKind?: string;
  nonProductReason?: string;
  campaignName?: string;
  commissionRate?: number;
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
  createdAt: string;
  updatedAt: string;
  processingStartedAt?: string;
  contentHash: string;
  sourceHash: string;
  keyword?: string;
  durableJobId?: string;
  durableJobKey?: string;
  bridgedAt?: string;
  payload: CandidatePayload;
}

let writeChain: Promise<unknown> = Promise.resolve();
function mutate<T>(work: () => Promise<T>): Promise<T> {
  const next = writeChain.then(work, work);
  writeChain = next.then(() => undefined, () => undefined);
  return next;
}

export async function listCandidateQueue(): Promise<CandidateQueueItem[]> {
  return readCollection<CandidateQueueItem>(COLLECTION);
}

export async function recoverStaleProcessing(now = Date.now(), ttlMs = PROCESSING_TTL_MS): Promise<number> {
  return mutate(async () => {
    const items = await listCandidateQueue();
    let recovered = 0;
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
    if (recovered) await writeCollection(COLLECTION, items);
    return recovered;
  });
}

export async function enqueueCandidate(input: Omit<CandidateQueueItem, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>): Promise<{ item: CandidateQueueItem; queued: boolean; unchanged: boolean }> {
  return mutate(async () => {
    const items = await listCandidateQueue();
    const existing = items.find((item) => item.source === input.source && item.sourceId === input.sourceId);
    if (existing && existing.sourceHash === input.sourceHash && !['failed', 'discarded'].includes(existing.status)) {
      return { item: existing, queued: false, unchanged: true };
    }
    const now = new Date().toISOString();
    if (existing) {
      const sourceChanged = existing.sourceHash !== input.sourceHash;
      Object.assign(existing, input, { schemaVersion: 2, status: 'pending', attempts: 0, updatedAt: now, processingStartedAt: undefined, delayReason: undefined });
      if (sourceChanged) {
        existing.durableJobId = undefined;
        existing.durableJobKey = undefined;
        existing.bridgedAt = undefined;
      }
      await writeCollection(COLLECTION, items);
      return { item: existing, queued: true, unchanged: false };
    }
    const item: CandidateQueueItem = { ...input, schemaVersion: 2, id: generateId(), status: 'pending', attempts: 0, createdAt: now, updatedAt: now };
    items.push(item);
    await writeCollection(COLLECTION, items);
    return { item, queued: true, unchanged: false };
  });
}

export async function getCandidateById(id: string): Promise<CandidateQueueItem | null> {
  return (await listCandidateQueue()).find(item => item.id === id) || null;
}

export async function markCandidateBridged(id: string, jobId: string, durableJobKey: string): Promise<CandidateQueueItem | null> {
  let output: CandidateQueueItem | null = null;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === id);
    if (!item) return undefined;
    if (item.durableJobId && item.durableJobId !== jobId) throw new Error('CANDIDATE_ALREADY_BRIDGED');
    item.schemaVersion = 2;
    item.durableJobId = jobId;
    item.durableJobKey = durableJobKey;
    item.bridgedAt ||= new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    output = structuredClone(item);
    return items;
  });
  return output;
}

export async function clearOrphanedCandidateBridge(id: string, missingJobId: string): Promise<boolean> {
  let cleared = false;
  await runTransaction<CandidateQueueItem>(COLLECTION, items => {
    const item = items.find(entry => entry.id === id);
    if (!item || item.durableJobId !== missingJobId || item.status === 'processing' || ['completed', 'discarded'].includes(item.status)) return undefined;
    item.durableJobId = undefined;
    item.durableJobKey = undefined;
    item.bridgedAt = undefined;
    item.status = 'pending';
    item.nextAttemptAt = undefined;
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
  return mutate(async () => {
    const items = await listCandidateQueue();
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
    if (due.length) await writeCollection(COLLECTION, items);
    return due.map((item) => ({ ...item, payload: { ...item.payload } }));
  });
}

export async function finishCandidate(id: string, update: Pick<CandidateQueueItem, 'status'> & Partial<Pick<CandidateQueueItem, 'nextAttemptAt' | 'delayReason'>>): Promise<void> {
  await mutate(async () => {
    const items = await listCandidateQueue();
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    Object.assign(item, update, { processingStartedAt: undefined, updatedAt: new Date().toISOString() });
    await writeCollection(COLLECTION, items);
  });
}

export async function getQueueStats(): Promise<Record<CandidateQueueStatus | 'total', number>> {
  const items = await listCandidateQueue();
  const stats = { total: items.length, pending: 0, processing: 0, completed: 0, needs_review: 0, delayed: 0, failed: 0, discarded: 0 };
  for (const item of items) stats[item.status]++;
  return stats;
}

export async function cleanupCandidateQueue(now = Date.now(), retentionMs = 7 * 24 * 60 * 60_000): Promise<number> {
  return mutate(async () => {
    const items = await listCandidateQueue();
    const kept = items.filter((item) => !['completed', 'discarded'].includes(item.status) || now - Date.parse(item.updatedAt) < retentionMs);
    if (kept.length !== items.length) await writeCollection(COLLECTION, kept);
    return items.length - kept.length;
  });
}
