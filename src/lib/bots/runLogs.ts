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
  found?: number;
  saved?: number;
  autoPublished?: number;
  needsReview?: number;
  blockedByKind?: number;
  blockedByLink?: number;
  blockedByImage?: number;
  cleaned?: number;
  checked?: number;
  hidden?: number;
  errors?: number;
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
