import { acquireRunLock, releaseRunLock } from './runLock';
import { getAutomationSettings } from '../storage/automationSettings';
import { getPublicProducts } from '../storage/products';
import { cleanupCandidateQueue, getQueueStats } from '../storage/candidateQueue';
import { readCollection, writeCollection } from '../storage/adapter';
import { processReviewQueue, recheckPublishedProducts, scanSourcesToQueue, selectOperationMode, type OperationMode, type PipelineCounters } from './productPipeline';
import { recoverDueGeminiCredentials } from '../ai/geminiCredentialProbe';
import { canRunLaunchWave, recordLaunchWave } from './launchAccelerator';
import { runAutomationSchedulerTick, runProductIntelligenceSchedulerTick } from '../automation/scheduler';

const COLLECTION = 'scheduler-state';

export interface SchedulerState {
  id: 'scheduler';
  currentMode: OperationMode;
  lastTickAt?: string;
  lastSourceScanAt?: string;
  nextSourceScanAt?: string;
  lastReviewRunAt?: string;
  nextReviewRunAt?: string;
  lastRecheckAt?: string;
  nextRecheckAt?: string;
  lastCleanupAt?: string;
  lastResult?: Record<string, unknown>;
  lastError?: string;
  queueSize: number;
  currentConcurrency: number;
  publicProductCount: number;
  sourceRateLimitUntil?: string;
  updatedAt: string;
}

export function getModeIntervals(mode: OperationMode) {
  return mode === 'bootstrap'
    ? { sourceMs: 15 * 60_000, reviewMs: 5 * 60_000, recheckMs: 12 * 60 * 60_000 }
    : { sourceMs: 60 * 60_000, reviewMs: 15 * 60_000, recheckMs: 24 * 60 * 60_000 };
}

export function isJobDue(nextAt: string | undefined, now = Date.now()): boolean {
  return !nextAt || !Number.isFinite(Date.parse(nextAt)) || Date.parse(nextAt) <= now;
}

function vietnamDayKey(now: number): string {
  return new Date(now + 7 * 60 * 60_000).toISOString().slice(0, 10);
}

export async function getSchedulerState(): Promise<SchedulerState> {
  const stored = (await readCollection<SchedulerState>(COLLECTION))[0];
  return stored || { id: 'scheduler', currentMode: 'bootstrap', queueSize: 0, currentConcurrency: 3, publicProductCount: 0, updatedAt: new Date().toISOString() };
}

function addCounters(a: Partial<PipelineCounters>, b: Partial<PipelineCounters>): PipelineCounters {
  const keys: Array<keyof PipelineCounters> = ['sourceRequests', 'found', 'queued', 'reviewed', 'created', 'updated', 'unchanged', 'duplicate', 'skippedCooldown', 'published', 'needsReview', 'failed', 'discarded', 'networkChecks', 'queueSize',
    'reviewQueued', 'reviewGenerated', 'reviewApproved', 'reviewNeedsReview', 'reviewRejected', 'reviewStale', 'claimValidationFailed', 'duplicateContentSkipped', 'seoReady', 'seoBlocked', 'indexable', 'noindex', 'sitemapIncluded'];
  return Object.fromEntries(keys.map((key) => [key, Number(a[key] || 0) + Number(b[key] || 0)])) as unknown as PipelineCounters;
}

export async function runSchedulerTick(now = Date.now()): Promise<{ status: 'completed' | 'skipped' | 'failed'; reason?: string; state: SchedulerState; summary?: PipelineCounters }> {
  const legacyTestExecution = process.env.NODE_ENV === 'test'
    && process.env.SANDEAL_ENABLE_LEGACY_DIRECT_WORKFLOW === 'true';
  if (!legacyTestExecution) {
    // Deprecated compatibility entry point. A scheduler is enqueue-only; all
    // candidate and product mutations are performed by the durable worker.
    try {
      const [automation, intelligence] = await Promise.all([
        runAutomationSchedulerTick(now),
        runProductIntelligenceSchedulerTick(now),
      ]);
      const state = await getSchedulerState();
      const inactive = ['paused', 'killed', 'disabled'].includes(automation.status)
        && ['paused', 'killed', 'disabled'].includes(intelligence.status);
      return {
        status: inactive ? 'skipped' : 'completed',
        reason: inactive ? automation.status : 'durable_jobs_enqueued',
        state: {
          ...state,
          lastTickAt: new Date(now).toISOString(),
          lastResult: { executionSource: 'durable_jobs', automation, intelligence },
          updatedAt: new Date().toISOString(),
        },
        summary: addCounters({}, {}),
      };
    } catch (error) {
      const state = await getSchedulerState();
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'durable_scheduler_error',
        state: { ...state, lastError: 'durable_scheduler_error', updatedAt: new Date().toISOString() },
      };
    }
  }

  const settings = await getAutomationSettings();
  let state = await getSchedulerState();
  if (!settings.enabled) return { status: 'skipped', reason: 'disabled', state };
  const lock = await acquireRunLock('scheduler_tick', 'scheduler');
  if (!lock.acquired) return { status: 'skipped', reason: 'already_running', state };
  try {
    const publicProductCount = (await getPublicProducts()).length;
    const mode = selectOperationMode(publicProductCount);
    const intervals = getModeIntervals(mode);
    const deadlineMs = now + settings.maxRunDurationMs;
    let summary = addCounters({}, {});
    const ran: string[] = [];
    const recovered = await recoverDueGeminiCredentials(now, 1);
    if (recovered.length) ran.push(`gemini_recovery:${recovered[0].generationStatus}`);
    if (settings.sourceScanEnabled && isJobDue(state.nextSourceScanAt, now) && (!state.sourceRateLimitUntil || Date.parse(state.sourceRateLimitUntil) <= now)) {
      const scan = await scanSourcesToQueue(mode, deadlineMs, { runId: `legacy-scheduler:${now}` });
      summary = addCounters(summary, scan);
      state.lastSourceScanAt = new Date(now).toISOString();
      state.nextSourceScanAt = new Date(now + intervals.sourceMs).toISOString();
      const rateLimited = Number(scan.resultTypes.rate_limited || 0) > 0;
      if (rateLimited) state.sourceRateLimitUntil = scan.retryAfter || new Date(now + 60 * 60_000).toISOString();
      ran.push('source_scan');
    }
    if (isJobDue(state.nextReviewRunAt, now) && Date.now() < deadlineMs) {
      const launchWave = await canRunLaunchWave(settings, now);
      const review = await processReviewQueue(mode, deadlineMs, launchWave ? settings.publishWaveSize : undefined);
      summary = addCounters(summary, review);
      state.currentConcurrency = review.currentConcurrency;
      state.lastReviewRunAt = new Date(now).toISOString();
      state.nextReviewRunAt = new Date(now + intervals.reviewMs).toISOString();
      ran.push('review_queue');
      if (launchWave && review.reviewed > 0) {
        const launchState = await recordLaunchWave(settings, { processed: review.reviewed, published: review.published, failed: review.failed }, now);
        ran.push(`launch_wave:${launchState.waves}:${launchState.phase}`);
      }
    }
    if (isJobDue(state.nextRecheckAt, now) && Date.now() < deadlineMs) {
      const recheck = await recheckPublishedProducts(mode === 'bootstrap' ? 10 : 20, deadlineMs);
      summary = addCounters(summary, recheck);
      state.lastRecheckAt = new Date(now).toISOString();
      state.nextRecheckAt = new Date(now + intervals.recheckMs).toISOString();
      ran.push('public_recheck');
    }
    const vietnamNow = new Date(now + 7 * 60 * 60_000);
    const cleanupDueToday = vietnamNow.getUTCHours() > 2 || (vietnamNow.getUTCHours() === 2 && vietnamNow.getUTCMinutes() >= 30);
    if (vietnamDayKey(Date.parse(state.lastCleanupAt || '1970-01-01')) !== vietnamDayKey(now) && cleanupDueToday) {
      const cleaned = await cleanupCandidateQueue(now);
      state.lastCleanupAt = new Date(now).toISOString();
      ran.push(`cleanup:${cleaned}`);
    }
    state = {
      ...state, id: 'scheduler', currentMode: mode, lastTickAt: new Date(now).toISOString(),
      lastRecheckAt: state.lastRecheckAt, nextRecheckAt: state.nextRecheckAt || new Date(now + intervals.recheckMs).toISOString(),
      lastResult: { ran, summary }, lastError: undefined, queueSize: (await getQueueStats()).total,
      publicProductCount: (await getPublicProducts()).length, updatedAt: new Date().toISOString(),
    };
    await writeCollection(COLLECTION, [state]);
    return { status: 'completed', state, summary };
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : 'scheduler_error';
    state.lastTickAt = new Date(now).toISOString();
    state.updatedAt = new Date().toISOString();
    await writeCollection(COLLECTION, [state]);
    return { status: 'failed', state };
  } finally {
    await releaseRunLock(lock.runId);
  }
}
