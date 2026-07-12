// ===========================================
// Bot Run Storage
// ===========================================

import type { BotName, BotRun, BotRunMode, BotRunStatus } from '../types';
import { readCollection, findById, insertOne, updateOne, generateId } from './adapter';

const COLLECTION = 'bot-runs';

export async function createBotRun(
  mode: BotRunMode,
  source: 'local' | 'accesstrade' | 'manual' | 'all',
  limit: number
): Promise<BotRun> {
  const run: BotRun = {
    id: generateId(),
    mode,
    source,
    limit,
    status: 'pending',
    startedAt: new Date().toISOString(),
    candidatesFound: 0,
    productsSaved: 0,
    contentPackagesGenerated: 0,
    linksChecked: 0,
    productsArchived: 0,
    errorCount: 0,
    logs: [],
  };
  return insertOne<BotRun>(COLLECTION, run);
}

export async function getBotRunById(id: string): Promise<BotRun | null> {
  return findById<BotRun>(COLLECTION, id);
}

export async function getBotRuns(limit = 50): Promise<BotRun[]> {
  const runs = await readCollection<BotRun>(COLLECTION);
  return runs.slice(-limit).reverse(); // Most recent first
}

export async function updateBotRun(
  id: string,
  updates: Partial<Omit<BotRun, 'id' | 'startedAt' | 'logs'>>
): Promise<BotRun | null> {
  return updateOne<BotRun>(COLLECTION, id, updates);
}

export async function completeBotRun(
  id: string,
  data: {
    status: 'completed' | 'failed' | 'cancelled';
    candidatesFound?: number;
    productsSaved?: number;
    contentPackagesGenerated?: number;
    linksChecked?: number;
    productsArchived?: number;
    errorCount?: number;
  }
): Promise<BotRun | null> {
  const run = await getBotRunById(id);
  if (!run) return null;

  const updates: Partial<BotRun> = {
    ...data,
    completedAt: new Date().toISOString(),
  };

  return updateOne<BotRun>(COLLECTION, id, updates);
}

export async function addBotRunLog(
  runId: string,
  botName: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const run = await getBotRunById(runId);
  if (!run) return;

  run.logs.push({
    id: generateId(),
    runId,
    botName: (['orchestrator', 'source_scout', 'deal_hunter', 'product_normalizer', 'image_resolver', 'gemini_analyst', 'deal_scorer', 'content_review', 'compliance_guard', 'link_health', 'product_cleanup', 'content_package', 'app_health'].includes(botName) ? botName : 'orchestrator') as BotName,
    level,
    message,
    timestamp: new Date().toISOString(),
    data,
  });

  // Limit logs to prevent unbounded growth
  if (run.logs.length > 1000) {
    run.logs = run.logs.slice(-1000);
  }

  await updateOne<BotRun>(COLLECTION, runId, { logs: run.logs });
}

export async function getBotRunsStats(): Promise<{
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  pendingRuns: number;
  lastRunAt?: string;
  lastRunStatus?: 'completed' | 'failed' | 'cancelled';
}> {
  const runs = await readCollection<BotRun>(COLLECTION);
  const completed = runs.filter(r => r.status === 'completed').length;
  const failed = runs.filter(r => r.status === 'failed').length;
  const pending = runs.filter(r => r.status === 'pending' || r.status === 'running').length;
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

  return {
    totalRuns: runs.length,
    completedRuns: completed,
    failedRuns: failed,
    pendingRuns: pending,
    lastRunAt: lastRun?.completedAt || lastRun?.startedAt,
    lastRunStatus: lastRun && ['completed', 'failed', 'cancelled'].includes(lastRun.status) ? lastRun.status as Extract<BotRunStatus, 'completed' | 'failed' | 'cancelled'> : undefined,
  };
}
