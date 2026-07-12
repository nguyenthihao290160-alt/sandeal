// ===========================================
// Run Logs — Stores recent AutoPilot run summaries
// Max 150 entries, compatible with file-based storage
// ===========================================

import { readCollection, writeCollection, generateId, ensureDataDir } from '../storage/adapter';

const COLLECTION = 'autopilot-logs';
const MAX_LOGS = 150;

export interface AutoPilotRunLog {
  id: string;
  runId: string;
  mode: string;
  trigger: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary: RunSummary;
  message?: string;
  error?: string;
}

export interface RunSummary {
  sourceRequests?: number;
  candidatesQueued?: number;
  networkChecks?: number;
  productsReviewed?: number;
  unchanged?: number;
  skippedCooldown?: number;
  failed?: number;
  queueSize?: number;
  reviewQueued?: number;
  reviewGenerated?: number;
  reviewApproved?: number;
  reviewNeedsReview?: number;
  reviewRejected?: number;
  reviewStale?: number;
  claimValidationFailed?: number;
  duplicateContentSkipped?: number;
  seoReady?: number;
  seoBlocked?: number;
  indexable?: number;
  noindex?: number;
  sitemapIncluded?: number;
  // Core metrics
  found?: number;
  rawFound?: number; // items returned by source API (before preflight)
  validCandidates?: number; // items that passed preflight validation
  created?: number;
  updated?: number;
  saved?: number;
  published?: number;
  needsReview?: number;
  archived?: number;
  blocked?: number;
  duplicate?: number;
  skipped?: number;
  brokenLinks?: number;
  brokenImages?: number;
  healthErrors?: number;
  checked?: number;
  cleaned?: number;
  hidden?: number;
  errors?: number;

  // Source quality resilience
  cooldownSkipped?: number; // items skipped due to active cooldown
  staleImage?: number; // items with image 404/410
  staleProductUrl?: number; // items with product URL 404/410
  staleAffiliate?: number; // items with affiliate URL 404/410
  affiliateUnverified?: number; // items with affiliate 200 but unverified destination
  malformedSource?: number; // items with invalid URL format
  invalidSource?: number; // items failing preflight validation
  timeout?: number; // items with timeout during health check
  needsImageFallback?: number; // items needing alternative image source
}

/**
 * Create a new run log entry with status 'running'.
 */
export async function createRunLog(
  runId: string,
  mode: string,
  trigger: string,
): Promise<AutoPilotRunLog> {
  await ensureDataDir();

  const log: AutoPilotRunLog = {
    id: generateId(),
    runId,
    mode,
    trigger,
    status: 'running',
    startedAt: new Date().toISOString(),
    summary: {},
  };

  const logs = await readCollection<AutoPilotRunLog>(COLLECTION);
  logs.push(log);

  // Trim to max
  const trimmed = logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs;
  await writeCollection(COLLECTION, trimmed);

  return log;
}

/**
 * Update a run log entry (e.g. status, summary, error, finishedAt).
 */
export async function updateRunLog(
  runId: string,
  updates: Partial<Pick<AutoPilotRunLog, 'status' | 'finishedAt' | 'durationMs' | 'summary' | 'message' | 'error'>>,
): Promise<void> {
  const logs = await readCollection<AutoPilotRunLog>(COLLECTION);
  const index = logs.findIndex((l) => l.runId === runId);

  if (index === -1) return;

  logs[index] = { ...logs[index], ...updates };
  await writeCollection(COLLECTION, logs);
}

/**
 * List recent run logs, most recent first.
 */
export async function listRunLogs(limit = 50): Promise<AutoPilotRunLog[]> {
  const logs = await readCollection<AutoPilotRunLog>(COLLECTION);
  return logs.slice(-limit).reverse();
}

/**
 * Convenience: mark a run log as skipped.
 */
export async function markRunSkipped(
  runId: string,
  reason: string,
): Promise<void> {
  await updateRunLog(runId, {
    status: 'skipped',
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    message: reason,
  });
}
