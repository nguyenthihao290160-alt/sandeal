import {
  assertAutonomousPublishEligible,
  AUTONOMOUS_PUBLISH_RULE_VERSION,
  evaluatePersistedAutonomousPublish,
  readinessSnapshotHash,
  type AutonomousPublishDecision,
  type PersistedEvidenceVerification,
} from '@/lib/autonomous/publishPolicy';
import {
  getLifecycleTransitionEvent,
  persistLifecycleTransition,
} from '@/lib/autonomous/lifecycleStore';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { getAllProducts, getProductById, publishCanonicalProductTransaction, saveCanonicalProduct } from '@/lib/storage/products';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { canPublishInCurrentWave, completeCanaryEffect, reserveCanaryEffect } from './canaryController';
import { claimJournalEffect, completeJournalEffect, ensureOperationJournal, failJournalEffect, getOperationJournal } from './operationJournal';
import { createAutomationJob, getAutomationControl } from './store';
import type { AutomationJob } from './types';

const OUTBOUND_COLLECTION = 'automation-outbound-events';
const RUNTIME_BLOCK_REASONS = new Set([
  'mode_disallows_publish',
  'kill_switch_active',
  'publish_lane_paused',
  'publish_budget_exceeded',
  'canary_wave_exceeded',
]);

interface PublicationEvent {
  schemaVersion: number;
  id: string;
  effectKey: string;
  productId: string;
  jobId: string;
  eventType: 'PRODUCT_PUBLISHED';
  createdAt: string;
}

function lifecycleTransitionKey(jobId: string, transition: 'publishing' | 'published' | 'quarantined' | 'retry-scheduled'): string {
  return `auto-safe-publish:${jobId}:${transition}`;
}

function lifecycleActor(job: AutomationJob, workerId: string) {
  return { type: 'worker' as const, id: workerId, jobId: job.id, jobType: job.type };
}

async function withinDailyPublishBudget(nowMs = Date.now()): Promise<boolean> {
  const [products, settings] = await Promise.all([getAllProducts(), getAutomationSettings()]);
  const day = new Date(nowMs + 7 * 60 * 60_000).toISOString().slice(0, 10);
  const count = products.filter(product => product.autoPublished && product.publishedAt && new Date(Date.parse(product.publishedAt) + 7 * 60 * 60_000).toISOString().slice(0, 10) === day).length;
  return count < settings.maxItemsPerDay;
}

async function recordPublicationEvent(effectKey: string, productId: string, jobId: string): Promise<{ event: PublicationEvent; created: boolean }> {
  let output!: { event: PublicationEvent; created: boolean };
  await runTransaction<PublicationEvent>(OUTBOUND_COLLECTION, events => {
    const existing = events.find(event => event.effectKey === effectKey);
    if (existing) { output = { event: existing, created: false }; return undefined; }
    const event: PublicationEvent = { schemaVersion: 1, id: generateId(), effectKey, productId, jobId, eventType: 'PRODUCT_PUBLISHED', createdAt: new Date().toISOString() };
    events.push(event);
    output = { event, created: true };
    return events;
  });
  return output;
}

async function hasPublishingTransition(job: AutomationJob, productId: string, requireApplied = true): Promise<boolean> {
  const event = await getLifecycleTransitionEvent(lifecycleTransitionKey(job.id, 'publishing'));
  return Boolean(event
    && (!requireApplied || event.status === 'APPLIED')
    && event.productId === productId
    && event.previousState === 'READY_FOR_PUBLISH'
    && event.nextState === 'PUBLISHING'
    && event.actor.jobId === job.id
    && event.actor.jobType === job.type);
}

async function ensurePublishingLifecycle(job: AutomationJob, workerId: string, productId: string): Promise<void> {
  const current = await getProductById(productId);
  if (!current) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');
  const transitionKey = lifecycleTransitionKey(job.id, 'publishing');
  if (current.lifecycleState === 'READY_FOR_PUBLISH' || current.lifecycleState === 'PUBLISHING') {
    await persistLifecycleTransition({
      productId,
      to: 'PUBLISHING',
      actor: lifecycleActor(job, workerId),
      transitionKey,
      operationId: job.operationId,
      reasonCodes: ['autonomous_publish_policy_passed', 'persisted_evidence_verified'],
    });
    return;
  }
  if (current.lifecycleState === 'PUBLISHED' && await hasPublishingTransition(job, productId)) return;
  throw new Error(`AUTO_SAFE_PUBLISH_LIFECYCLE_INVALID:${current.lifecycleState || 'UNKNOWN'}`);
}

async function ensurePublishedLifecycle(job: AutomationJob, workerId: string, productId: string): Promise<void> {
  const transitionKey = lifecycleTransitionKey(job.id, 'published');
  const current = await getProductById(productId);
  if (!current) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');
  if (current.lifecycleState === 'PUBLISHED') {
    const existing = await getLifecycleTransitionEvent(transitionKey);
    if (!existing || existing.status !== 'APPLIED' || existing.actor.jobId !== job.id) {
      throw new Error('AUTO_SAFE_PUBLISH_FINAL_LIFECYCLE_EVENT_MISSING');
    }
  } else if (current.lifecycleState !== 'PUBLISHING') {
    throw new Error(`AUTO_SAFE_PUBLISH_FINAL_LIFECYCLE_INVALID:${current.lifecycleState || 'UNKNOWN'}`);
  }
  const result = await persistLifecycleTransition({
    productId,
    to: 'PUBLISHED',
    actor: lifecycleActor(job, workerId),
    transitionKey,
    operationId: job.operationId,
    reasonCodes: ['exactly_once_publish_effect_confirmed'],
  });
  if (result.product.lifecycleState !== 'PUBLISHED' || result.event.status !== 'APPLIED') {
    throw new Error('AUTO_SAFE_PUBLISH_FINAL_LIFECYCLE_NOT_CONFIRMED');
  }
}

async function applyBlockedDecision(
  job: AutomationJob,
  workerId: string,
  productId: string,
  decision: AutonomousPublishDecision,
): Promise<{ runtimeOnly: boolean; quarantined: boolean }> {
  const runtimeOnly = decision.reasons.length > 0 && decision.reasons.every(reason => RUNTIME_BLOCK_REASONS.has(reason));
  const nextRetryAt = new Date(Date.now() + (runtimeOnly ? 30 : 6 * 60) * 60_000).toISOString();
  let current = await getProductById(productId);
  if (!current) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');

  if (runtimeOnly && current.lifecycleState === 'PUBLISHING') {
    const transitioned = await persistLifecycleTransition({
      productId,
      to: 'RETRY_SCHEDULED',
      actor: lifecycleActor(job, workerId),
      transitionKey: lifecycleTransitionKey(job.id, 'retry-scheduled'),
      operationId: job.operationId,
      reasonCodes: decision.reasons,
    });
    current = transitioned.product;
  } else if (!runtimeOnly && ['READY_FOR_PUBLISH', 'PUBLISHING'].includes(String(current.lifecycleState || ''))) {
    const transitioned = await persistLifecycleTransition({
      productId,
      to: 'QUARANTINED',
      actor: lifecycleActor(job, workerId),
      transitionKey: lifecycleTransitionKey(job.id, 'quarantined'),
      operationId: job.operationId,
      reasonCodes: decision.reasons,
    });
    current = transitioned.product;
  }

  const quarantined = current.lifecycleState === 'QUARANTINED';
  await saveCanonicalProduct(productId, {
    quarantineReasons: quarantined ? [...new Set([...(current.quarantineReasons || []), ...decision.reasons])] : current.quarantineReasons,
    nextAutomaticAction: quarantined ? 'RECHECK_QUARANTINED_PRODUCT' : 'RETRY_AUTO_SAFE_PUBLISH',
    nextRetryAt,
    publicHidden: true,
    ...(quarantined ? { status: 'needs_review' as const } : {}),
  });
  return { runtimeOnly, quarantined };
}

function replayDecision(productId: string, effectSnapshot: string, product: Awaited<ReturnType<typeof getProductById>>): AutonomousPublishDecision {
  return {
    eligible: true,
    reasons: [],
    qualityScore: Number(product?.qualityScore || 100),
    publishConfidence: Number(product?.confidences?.publish || 1),
    evidenceCoverage: Number(product?.evidenceCoverage || 1),
    evidenceVerified: true,
    evidenceIds: [...(product?.evidenceFactIds || [])],
    snapshotHash: effectSnapshot,
    ruleVersion: AUTONOMOUS_PUBLISH_RULE_VERSION,
  };
}

export async function executeAutoSafePublish(job: AutomationJob, workerId: string): Promise<Record<string, unknown>> {
  const productId = typeof job.payload.productId === 'string' ? job.payload.productId : '';
  if (!productId) throw new Error('VALIDATION_PRODUCT_ID_REQUIRED');
  const product = await getProductById(productId);
  if (!product) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');
  const control = await getAutomationControl();
  const currentSnapshot = readinessSnapshotHash(product);
  const requestedSnapshot = typeof job.payload.readinessSnapshotHash === 'string' ? job.payload.readinessSnapshotHash : undefined;
  const publishingTransitionExists = await hasPublishingTransition(job, productId, false);
  const publishingTransitionApplied = publishingTransitionExists && await hasPublishingTransition(job, productId);
  const readyProjectionSnapshot = readinessSnapshotHash({ ...product, lifecycleState: 'READY_FOR_PUBLISH' });
  const transitionReplaySnapshotAccepted = publishingTransitionExists
    && ['PUBLISHING', 'PUBLISHED'].includes(String(product.lifecycleState || ''))
    && requestedSnapshot === readyProjectionSnapshot;
  if (requestedSnapshot && requestedSnapshot !== currentSnapshot && !transitionReplaySnapshotAccepted) {
    throw new Error('STALE_READINESS_SNAPSHOT');
  }
  const effectSnapshot = requestedSnapshot || (publishingTransitionExists ? readyProjectionSnapshot : currentSnapshot);
  const effectKey = `publish-effect:${product.id}:${effectSnapshot}`;
  const replayingCompletedProductWrite = publishingTransitionApplied
    && product.publicationEffectKey === effectKey
    && product.status === 'published'
    && product.publicHidden === false;
  const wave = await canPublishInCurrentWave(control.effectiveMode, effectKey);
  const withinBudget = replayingCompletedProductWrite || await withinDailyPublishBudget();
  let evidenceVerification: PersistedEvidenceVerification | undefined;
  let decision: AutonomousPublishDecision;
  if (replayingCompletedProductWrite) {
    decision = replayDecision(productId, effectSnapshot, product);
  } else {
    const evaluated = await evaluatePersistedAutonomousPublish(product, {
      mode: control.effectiveMode,
      killSwitch: control.killSwitch,
      publishPaused: control.publishPaused,
      workerId,
      jobType: job.type,
      jobClaimedBy: job.claimedBy,
      withinBudget,
      withinCanaryWave: wave.allowed,
    });
    decision = evaluated.decision;
    evidenceVerification = evaluated.evidence;
  }

  if (!decision.eligible) {
    const blocked = await applyBlockedDecision(job, workerId, productId, decision);
    return {
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES',
      executionMode: 'LOCAL_RULES',
      provider: 'local',
      published: false,
      quarantined: blocked.quarantined,
      reasons: decision.reasons,
      rulesVersion: decision.ruleVersion,
      evidenceVerified: decision.evidenceVerified,
      aiRequests: 0,
      externalRequests: 0,
    };
  }
  if (!replayingCompletedProductWrite) {
    assertAutonomousPublishEligible(product, {
      mode: control.effectiveMode,
      killSwitch: control.killSwitch,
      publishPaused: control.publishPaused,
      workerId,
      jobType: job.type,
      jobClaimedBy: job.claimedBy,
      withinBudget,
      withinCanaryWave: wave.allowed,
    }, evidenceVerification);
  }

  await ensureOperationJournal({
    operationId: job.operationId,
    jobId: job.id,
    operationType: 'AUTO_SAFE_PUBLISH',
    effects: [
      { id: 'publish-product', description: 'Publish canonical product exactly once.', idempotencyKey: effectKey, intendedValue: { productId, snapshotHash: effectSnapshot } },
      { id: 'outbound-event', description: 'Emit one publication event.', idempotencyKey: `${effectKey}:event` },
      { id: 'monitor-job', description: 'Create one post-publish monitoring chain.', idempotencyKey: `${effectKey}:monitor` },
    ],
  });
  if (!(await reserveCanaryEffect(control.effectiveMode, effectKey))) throw new Error('TEMPORARY_ERROR:CANARY_RESERVATION_FAILED');

  const effectOwnerId = `auto-safe-publish:${job.id}`;
  let activeEffectId: string | undefined;
  const acquireEffect = async (effectId: string): Promise<boolean> => {
    const claim = await claimJournalEffect(job.operationId, effectId, effectOwnerId);
    if (claim.status === 'IN_PROGRESS') throw new Error(`TEMPORARY_ERROR:JOURNAL_EFFECT_IN_PROGRESS:${effectId}`);
    if (claim.status === 'COMPLETED') return false;
    activeEffectId = effectId;
    return true;
  };
  const finishEffect = async (effectId: string, actualValue: unknown): Promise<void> => {
    await completeJournalEffect(job.operationId, effectId, actualValue, { ownerId: effectOwnerId });
    if (activeEffectId === effectId) activeEffectId = undefined;
  };

  try {
    await ensurePublishingLifecycle(job, workerId, productId);
    if (process.env.NODE_ENV === 'test' && job.payload.simulateCrashAfterPublishingTransition === true && job.attemptCount === 1) {
      throw new Error('TEMPORARY_ERROR:SIMULATED_CRASH_AFTER_PUBLISHING_TRANSITION');
    }

    const fresh = await getProductById(productId);
    const publishEffectRequired = await acquireEffect('publish-product');
    if (!publishEffectRequired) {
      if (fresh?.publicationEffectKey !== effectKey || fresh.status !== 'published' || fresh.publicHidden !== false) {
        throw new Error('JOURNAL_EFFECT_PRODUCT_STATE_MISMATCH');
      }
    } else if (fresh?.publicationEffectKey === effectKey && fresh.status === 'published' && fresh.publicHidden === false) {
      await finishEffect('publish-product', { productId, effectKey, publishedAt: fresh.publishedAt });
    } else {
      const published = await publishCanonicalProductTransaction(productId, {
        status: 'published',
        autoPublished: true,
        relatedJobId: job.id,
      }, {
        jobId: job.id,
        workerId,
        operationId: job.operationId,
        runId: job.id,
        idempotencyKey: job.idempotencyKey,
        publicationEffectKey: effectKey,
        dryRun: false,
      });
      if (!published || published.status !== 'published' || published.publicHidden !== false || published.lifecycleState !== 'PUBLISHING') {
        throw new Error('AUTO_SAFE_PUBLISH_WRITE_BLOCKED');
      }
      if (process.env.NODE_ENV === 'test' && job.payload.simulateCrashAfterProductWrite === true && job.attemptCount === 1) {
        throw new Error('TEMPORARY_ERROR:SIMULATED_CRASH_AFTER_PRODUCT_WRITE');
      }
      await finishEffect('publish-product', { productId, effectKey, publishedAt: published.publishedAt });
    }

    await ensurePublishedLifecycle(job, workerId, productId);

    if (await acquireEffect('outbound-event')) {
      if (process.env.NODE_ENV === 'test' && job.payload.simulateCrashAfterEventClaim === true && job.attemptCount === 1) throw new Error('TEMPORARY_ERROR:SIMULATED_CRASH_AFTER_EVENT_CLAIM');
      const event = await recordPublicationEvent(effectKey, productId, job.id);
      await finishEffect('outbound-event', { id: event.event.id, effectKey: event.event.effectKey });
    }

    let monitorJobId: string | undefined;
    if (await acquireEffect('monitor-job')) {
      if (process.env.NODE_ENV === 'test' && job.payload.simulateCrashAfterMonitorClaim === true && job.attemptCount === 1) throw new Error('TEMPORARY_ERROR:SIMULATED_CRASH_AFTER_MONITOR_CLAIM');
      const scheduledAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const monitor = await createAutomationJob({
        type: 'POST_PUBLISH_MONITOR',
        payload: { productId, interval: '15m', sequence: 0, publicationEffectKey: effectKey },
        idempotencyKey: `monitor:${productId}:${effectSnapshot}:15m`.slice(0, 160),
        operationId: `monitor:${productId}:${effectSnapshot}`.slice(0, 160),
        parentJobId: job.id,
        requestedBy: 'autopilot-worker',
        priority: 70,
        scheduledAt,
      });
      monitorJobId = monitor.job.id;
      await saveCanonicalProduct(productId, { monitoringScheduledAt: scheduledAt, nextAutomaticAction: 'POST_PUBLISH_MONITOR' });
      await finishEffect('monitor-job', { jobId: monitor.job.id });
    }
    const journal = await getOperationJournal(job.operationId);
    if (!journal || journal.reconciliationStatus !== 'CONSISTENT') throw new Error('TEMPORARY_ERROR:JOURNAL_INCOMPLETE');
    await completeCanaryEffect(control.effectiveMode, effectKey, true);
    const published = await getProductById(productId);
    if (published?.lifecycleState !== 'PUBLISHED') throw new Error('AUTO_SAFE_PUBLISH_NOT_PUBLIC_AFTER_LIFECYCLE');
    const eventCount = (await readCollection<PublicationEvent>(OUTBOUND_COLLECTION)).filter(event => event.effectKey === effectKey).length;
    return {
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES',
      executionMode: 'LOCAL_RULES',
      provider: 'local',
      published: true,
      productId,
      publishedAt: published.publishedAt,
      publicationEffectKey: effectKey,
      monitorJobId,
      outboundEvents: eventCount,
      rulesVersion: decision.ruleVersion,
      evidenceVerified: decision.evidenceVerified,
      evidenceIds: decision.evidenceIds,
      aiRequests: 0,
      externalRequests: 0,
    };
  } catch (error) {
    if (activeEffectId) await failJournalEffect(job.operationId, activeEffectId, error, { ownerId: effectOwnerId });
    const durableProductWrite = await getProductById(productId);
    const mustPreserveCanaryReservation = durableProductWrite?.publicationEffectKey === effectKey
      && durableProductWrite.status === 'published'
      && durableProductWrite.publicHidden === false;
    if (!mustPreserveCanaryReservation) await completeCanaryEffect(control.effectiveMode, effectKey, false);
    throw error;
  }
}
