import { readinessSnapshotHash } from '@/lib/autonomous/publishPolicy';
import { clearOrphanedCandidateBridge, listCandidateQueue, recoverStaleProcessing } from '@/lib/storage/candidateQueue';
import { getAllProducts, publicationIdempotencyKey, saveCanonicalProduct } from '@/lib/storage/products';
import { bridgeCandidatesToDurableJobs } from './candidateBridge';
import { completeJournalEffect, listInconsistentJournals } from './operationJournal';
import { approveAutomationJob, cancelAutomationJob, completeAutomationParentJob, createAutomationJob, getAllAutomationJobs, getAutomationControl } from './store';
import type { AutomationJob } from './types';
import { reconcilePendingLifecycleTransitions } from '@/lib/autonomous/lifecycleStore';
import { recordSuccessfulShadowCycle } from './canaryController';

const TERMINAL_JOB_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);

export interface ReconcilerResult {
  inspected: number;
  repaired: number;
  bridgeJobs: number;
  publishJobs: number;
  monitorJobs: number;
  staleCandidates: number;
  journalsReconciled: number;
  orphans: number;
  parentJobsCompleted: number;
  shadowCyclesRecorded: number;
  duplicateJobsCancelled: number;
  staleApprovalsExpired: number;
  lifecycleTransitionsReconciled: number;
  skipped: number;
}

function descendantsOf(parentId: string, jobs: AutomationJob[]): AutomationJob[] {
  const descendants: AutomationJob[] = [];
  const seen = new Set<string>([parentId]);
  let frontier = [parentId];
  while (frontier.length) {
    const parents = new Set(frontier);
    frontier = [];
    for (const job of jobs) {
      if (!job.parentJobId || !parents.has(job.parentJobId) || seen.has(job.id)) continue;
      seen.add(job.id);
      descendants.push(job);
      frontier.push(job.id);
    }
  }
  return descendants;
}

export async function runAutonomousReconciler(nowMs = Date.now()): Promise<ReconcilerResult> {
  const result: ReconcilerResult = { inspected: 0, repaired: 0, bridgeJobs: 0, publishJobs: 0, monitorJobs: 0, staleCandidates: 0, journalsReconciled: 0, orphans: 0, parentJobsCompleted: 0, shadowCyclesRecorded: 0, duplicateJobsCancelled: 0, staleApprovalsExpired: 0, lifecycleTransitionsReconciled: 0, skipped: 0 };
  const control = await getAutomationControl();
  result.staleCandidates = await recoverStaleProcessing(nowMs);
  result.repaired += result.staleCandidates;
  const lifecycleRepair = await reconcilePendingLifecycleTransitions(100);
  result.lifecycleTransitionsReconciled = lifecycleRepair.repaired;
  result.repaired += lifecycleRepair.repaired;
  result.skipped += lifecycleRepair.failed.length;

  const initialJobs = await getAllAutomationJobs();
  const initialJobIds = new Set(initialJobs.map(job => job.id));
  for (const candidate of await listCandidateQueue()) {
    if (!candidate.durableJobId || initialJobIds.has(candidate.durableJobId)) continue;
    result.orphans += 1;
    if (await clearOrphanedCandidateBridge(candidate.id, candidate.durableJobId)) result.repaired += 1;
  }

  const bridge = await bridgeCandidatesToDurableJobs({ requestedBy: 'autonomous-reconciler', limit: 100 });
  result.bridgeJobs = bridge.created;
  result.repaired += bridge.created;

  const [products, jobs] = await Promise.all([getAllProducts(), getAllAutomationJobs()]);
  const jobsById = new Map(jobs.map(job => [job.id, job]));
  result.inspected += products.length + jobs.length;

  for (const job of jobs) {
    if (job.status !== 'WAITING_APPROVAL' || !job.approvalExpiresAt || Date.parse(job.approvalExpiresAt) > nowMs) continue;
    if (await approveAutomationJob(job.id, 'autonomous-reconciler', 'Approval snapshot expired.', false)) {
      result.staleApprovalsExpired += 1;
      result.repaired += 1;
    }
  }

  const duplicateGroups = new Map<string, AutomationJob[]>();
  for (const job of jobs) {
    const key = `${job.type}:${job.idempotencyKey}`;
    const group = duplicateGroups.get(key) || [];
    group.push(job);
    duplicateGroups.set(key, group);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => Number(b.status === 'SUCCEEDED') - Number(a.status === 'SUCCEEDED') || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const duplicate of ordered.slice(1)) {
      if (!['PENDING', 'WAITING_APPROVAL', 'WAITING_FOR_MANUAL_INPUT', 'WAITING_CHILDREN', 'RETRY_SCHEDULED', 'PAUSED'].includes(duplicate.status)) continue;
      if (await cancelAutomationJob(duplicate.id, 'autonomous-reconciler', 'Duplicate durable child idempotency key.')) {
        result.duplicateJobsCancelled += 1;
        result.repaired += 1;
      }
    }
  }

  for (const job of jobs) {
    if (job.parentJobId && !jobsById.has(job.parentJobId)) result.orphans += 1;
    if (job.status !== 'WAITING_CHILDREN') continue;
    const descendants = descendantsOf(job.id, jobs);
    if (!descendants.length) {
      result.orphans += 1;
      continue;
    }
    const active = descendants.filter(child => !TERMINAL_JOB_STATUSES.has(child.status));
    if (active.length) continue;
    const byStatus = Object.fromEntries([...new Set(descendants.map(child => child.status))].map(status => [status, descendants.filter(child => child.status === status).length]));
    if (await completeAutomationParentJob(job.id, 'autonomous-reconciler', { total: descendants.length, byStatus, completedAt: new Date(nowMs).toISOString() })) {
      result.parentJobsCompleted += 1;
      result.repaired += 1;
      const shadowCycleSucceeded = job.type === 'AUTO_PILOT'
        && control.effectiveMode === 'SHADOW'
        && descendants.every(child => child.status === 'SUCCEEDED');
      if (shadowCycleSucceeded) {
        await recordSuccessfulShadowCycle(nowMs);
        result.shadowCyclesRecorded += 1;
      }
    }
  }

  for (const product of products) {
    if (product.lifecycleState === 'READY_FOR_PUBLISH' && ['CANARY', 'AUTONOMOUS'].includes(control.effectiveMode) && !control.publishPaused && !control.killSwitch) {
      const key = `auto-safe-publish:${publicationIdempotencyKey(product)}:${control.effectiveMode}`.slice(0, 160);
      const created = await createAutomationJob({
        type: 'AUTO_SAFE_PUBLISH',
        payload: { productId: product.id, readinessSnapshotHash: readinessSnapshotHash(product), reconciled: true },
        idempotencyKey: key,
        operationId: `publish:${product.id}:${readinessSnapshotHash(product)}`.slice(0, 160),
        requestedBy: 'autonomous-reconciler',
        priority: 85,
      });
      if (created.created) {
        result.publishJobs += 1;
        result.repaired += 1;
        await saveCanonicalProduct(product.id, { relatedJobId: created.job.id, nextAutomaticAction: 'AUTO_SAFE_PUBLISH' });
      } else result.skipped += 1;
    }

    if (product.lifecycleState === 'PUBLISHED' && !product.monitoringScheduledAt) {
      const effect = product.publicationEffectKey || product.publishedAt || product.sourceHash || product.id;
      const scheduledAt = new Date(nowMs + 15 * 60_000).toISOString();
      const created = await createAutomationJob({
        type: 'POST_PUBLISH_MONITOR',
        payload: { productId: product.id, interval: '15m', sequence: 0 },
        idempotencyKey: `monitor:${product.id}:${effect}:15m`.slice(0, 160),
        operationId: `monitor:${product.id}:${effect}`.slice(0, 160),
        requestedBy: 'autonomous-reconciler',
        priority: 70,
        scheduledAt,
      });
      if (created.created) {
        result.monitorJobs += 1;
        result.repaired += 1;
        await saveCanonicalProduct(product.id, { monitoringScheduledAt: scheduledAt, nextAutomaticAction: 'POST_PUBLISH_MONITOR' });
      } else result.skipped += 1;
    }

    if (product.lifecycleState === 'HIDDEN' && !product.nextRetryAt) {
      const scheduledAt = new Date(nowMs + 24 * 60 * 60_000).toISOString();
      const created = await createAutomationJob({
        type: 'POST_PUBLISH_MONITOR',
        payload: { productId: product.id, interval: '24h', sequence: Number(product.consecutiveHealthFailures || 0), recheckHidden: true },
        idempotencyKey: `hidden-recheck:${product.id}:${product.hiddenAt || product.updatedAt}`.slice(0, 160),
        requestedBy: 'autonomous-reconciler',
        priority: 55,
        scheduledAt,
      });
      if (created.created) {
        result.monitorJobs += 1;
        result.repaired += 1;
        await saveCanonicalProduct(product.id, { nextRetryAt: scheduledAt, nextAutomaticAction: 'RECHECK_HIDDEN_PRODUCT' });
      }
    }
  }

  for (const journal of await listInconsistentJournals()) {
    const product = products.find(item => item.publicationJobId === journal.jobId || item.relatedJobId === journal.jobId);
    if (!product?.publicationEffectKey) continue;
    const effect = journal.intendedEffects.find(item => item.id === 'publish-product' && item.status !== 'COMPLETED');
    if (!effect) continue;
    await completeJournalEffect(journal.operationId, effect.id, { productId: product.id, publicationEffectKey: product.publicationEffectKey });
    result.journalsReconciled += 1;
    result.repaired += 1;
  }
  return result;
}
