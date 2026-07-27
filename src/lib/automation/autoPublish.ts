import {
  assertAutonomousPublishEligible,
  AUTONOMOUS_PUBLISH_RULE_VERSION,
  evaluatePersistedAutonomousPublish,
  readinessSnapshotHash,
  type AutonomousPublishDecision,
  type PersistedEvidenceVerification,
} from '@/lib/autonomous/publishPolicy';
import { recordSourceQualityObservation } from '@/lib/autonomous/sourceQuality';
import { createHash } from 'node:crypto';
import {
  getLifecycleTransitionEvent,
  persistLifecycleTransition,
} from '@/lib/autonomous/lifecycleStore';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import {
  appendPublicationAuditOnce,
  getAllProducts,
  getProductById,
  publishCanonicalProductTransaction,
  saveCanonicalProduct,
} from '@/lib/storage/products';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import type { BlockedPublicationDecisionRecord } from '@/lib/types';
import { canPublishInCurrentWave, completeCanaryEffect, reserveCanaryEffect } from './canaryController';
import { claimJournalEffect, completeJournalEffect, ensureOperationJournal, failJournalEffect, getOperationJournal } from './operationJournal';
import {
  consumeRuntimeRecoveryCanaryPermit,
  finalizeRuntimeRecoveryCanaryPermit,
  getRuntimeRecoveryCanaryPermit,
  issueRuntimeRecoveryCanaryPermit,
  type RuntimeRecoveryCanaryPermit,
  validateRuntimeRecoveryCanaryPermitForOperation,
} from './runtimeRecoveryCanary';
import { createAutomationJob, getAutomationControl } from './store';
import type { AutomationJob } from './types';
import { vietnamDayKey } from './timezone';

const OUTBOUND_COLLECTION = 'automation-outbound-events';
const CONTROL_BLOCK_REASONS = new Set([
  'mode_disallows_publish',
  'kill_switch_active',
  'publish_lane_paused',
  'publish_paused_by_operator',
  'publish_blocked_by_runtime',
  'publish_blocked_by_policy',
  'publish_budget_exceeded',
  'canary_wave_exceeded',
]);
const RUNTIME_BLOCK_REASONS = new Set([
  'mode_disallows_publish',
  'kill_switch_active',
  'publish_blocked_by_runtime',
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
  const day = vietnamDayKey(nowMs);
  const count = products.filter(product => product.autoPublished && product.publishedAt && vietnamDayKey(Date.parse(product.publishedAt)) === day).length;
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
  effectKey: string,
): Promise<{ runtimeOnly: boolean; quarantined: boolean; record: BlockedPublicationDecisionRecord }> {
  const runtimeOnly = decision.reasons.length > 0 && decision.reasons.every(reason => CONTROL_BLOCK_REASONS.has(reason));
  const nextRetryAt = new Date(Date.now() + (runtimeOnly ? 30 : 6 * 60) * 60_000).toISOString();
  let current = await getProductById(productId);
  if (!current) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');
  const existingRecord = current.lastBlockedPublicationDecision?.operationId === job.operationId
    && current.lastBlockedPublicationDecision.effectKey === effectKey
    ? current.lastBlockedPublicationDecision
    : undefined;
  if (existingRecord) {
    return {
      runtimeOnly: existingRecord.productReasonCodes.length === 0,
      quarantined: existingRecord.resultingLifecycleState === 'QUARANTINED',
      record: existingRecord,
    };
  }

  const transitionType = runtimeOnly ? 'retry-scheduled' : 'quarantined';
  const transitionEvent = await getLifecycleTransitionEvent(lifecycleTransitionKey(job.id, transitionType));
  const previousLifecycleState = transitionEvent?.productId === productId
    ? transitionEvent.previousState
    : current.lifecycleState || 'STAGED';
  const previousStatus = current.status;

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
  const runtimeReasonCodes = decision.reasons.filter(reason => RUNTIME_BLOCK_REASONS.has(reason));
  const productReasonCodes = decision.reasons.filter(reason => !CONTROL_BLOCK_REASONS.has(reason));
  const recordedAt = new Date().toISOString();
  const record: BlockedPublicationDecisionRecord = {
    schemaVersion: 1,
    operationId: job.operationId,
    effectKey,
    jobId: job.id,
    attemptId: job.claimToken || `${job.id}:attempt:${job.attemptCount}`,
    productId,
    candidateId: typeof job.payload.candidateId === 'string' ? job.payload.candidateId : undefined,
    previousLifecycleState,
    resultingLifecycleState: current.lifecycleState || 'STAGED',
    previousStatus,
    resultingStatus: quarantined ? 'needs_review' : current.status,
    decisionRuleVersion: decision.ruleVersion,
    reasonCodes: [...new Set(decision.reasons)],
    runtimeReasonCodes: [...new Set(runtimeReasonCodes)],
    productReasonCodes: [...new Set(productReasonCodes)],
    sourceHash: current.sourceHash,
    reviewVersion: current.reviewContent?.reviewVersion,
    riskLevel: current.riskLevel,
    dryRun: job.dryRun,
    actor: {
      type: 'worker',
      id: workerId,
    },
    releaseIdentity: getReleaseIdentity().releaseId,
    recordedAt,
  };
  const saved = await saveCanonicalProduct(productId, {
    quarantineReasons: quarantined ? [...new Set([...(current.quarantineReasons || []), ...decision.reasons])] : current.quarantineReasons,
    nextAutomaticAction: quarantined ? 'RECHECK_QUARANTINED_PRODUCT' : 'RETRY_AUTO_SAFE_PUBLISH',
    nextRetryAt,
    publicHidden: true,
    ...(quarantined ? { status: 'needs_review' as const } : {}),
    lastBlockedPublicationDecision: record,
  });
  if (!saved?.lastBlockedPublicationDecision || saved.lastBlockedPublicationDecision.effectKey !== effectKey) {
    throw new Error('BLOCKED_PUBLICATION_STATE_NOT_DURABLE');
  }
  return { runtimeOnly, quarantined, record: saved.lastBlockedPublicationDecision };
}

function blockedAuditFromRecord(record: BlockedPublicationDecisionRecord) {
  return {
    effectKey: record.effectKey,
    operationId: record.operationId,
    runId: record.jobId,
    jobId: record.jobId,
    attemptId: record.attemptId,
    candidateId: record.candidateId,
    productId: record.productId,
    action: 'publish_blocked',
    previousState: record.previousStatus,
    nextState: record.resultingStatus,
    previousLifecycleState: record.previousLifecycleState,
    nextLifecycleState: record.resultingLifecycleState,
    reasonCodes: record.reasonCodes,
    runtimeReasonCodes: record.runtimeReasonCodes,
    productReasonCodes: record.productReasonCodes,
    decisionRuleVersion: record.decisionRuleVersion,
    sourceHash: record.sourceHash,
    reviewVersion: record.reviewVersion,
    riskLevel: record.riskLevel.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN',
    dryRun: record.dryRun,
    actor: record.actor,
    releaseIdentity: record.releaseIdentity,
    timestamp: record.recordedAt,
  };
}

async function ensurePublishedPublicationAudit(
  job: AutomationJob,
  workerId: string,
  productId: string,
  effectKey: string,
): Promise<{ auditId: string; effectKey: string }> {
  const product = await getProductById(productId);
  if (!product
    || product.publicationEffectKey !== effectKey
    || product.status !== 'published'
    || product.publicHidden !== false
    || !['PUBLISHING', 'PUBLISHED'].includes(String(product.lifecycleState || ''))) {
    throw new Error('PUBLICATION_AUDIT_COMMITTED_PRODUCT_REQUIRED');
  }
  const durable = await appendPublicationAuditOnce({
    effectKey: `${effectKey}:audit`.slice(0, 240),
    operationId: job.operationId,
    runId: job.id,
    jobId: job.id,
    attemptId: job.claimToken || `${job.id}:attempt:${job.attemptCount}`,
    candidateId: typeof job.payload.candidateId === 'string' ? job.payload.candidateId : undefined,
    productId,
    action: 'published',
    previousState: product.publicationPreviousStatus || 'needs_review',
    nextState: 'published',
    previousLifecycleState: product.publicationPreviousLifecycleState,
    nextLifecycleState: product.lifecycleState,
    reasonCodes: [],
    sourceHash: product.sourceHash,
    reviewVersion: product.reviewContent?.reviewVersion,
    riskLevel: 'HIGH',
    dryRun: false,
    actor: { type: 'worker', id: workerId },
    releaseIdentity: getReleaseIdentity().releaseId,
    timestamp: product.publishedAt || new Date().toISOString(),
  });
  if (!durable.event.id) throw new Error('PUBLICATION_AUDIT_NOT_DURABLE');
  return { auditId: durable.event.id, effectKey: durable.event.effectKey! };
}

function blockedResult(record: BlockedPublicationDecisionRecord): Record<string, unknown> {
  return {
    executionStatus: 'COMPLETED_WITH_LOCAL_RULES',
    executionMode: 'LOCAL_RULES',
    provider: 'local',
    published: false,
    quarantined: record.resultingLifecycleState === 'QUARANTINED',
    reasons: record.reasonCodes,
    rulesVersion: record.decisionRuleVersion,
    evidenceVerified: false,
    blockedAuditEffectKey: record.effectKey,
    aiRequests: 0,
    externalRequests: 0,
  };
}

async function executeBlockedDecision(
  job: AutomationJob,
  workerId: string,
  productId: string,
  decision?: AutonomousPublishDecision,
  journalOperationId = job.operationId,
): Promise<Record<string, unknown>> {
  const effectKey = `publish-blocked:${job.operationId}:${productId}`.slice(0, 240);
  await ensureOperationJournal({
    operationId: journalOperationId,
    jobId: job.id,
    operationType: 'AUTO_SAFE_PUBLISH_BLOCKED',
    effects: [
      {
        id: 'blocked-state',
        description: 'Persist the blocked publication decision before its audit.',
        idempotencyKey: `${effectKey}:state`.slice(0, 240),
        intendedValue: { productId },
      },
      {
        id: 'blocked-audit',
        description: 'Record one durable blocked publication audit.',
        idempotencyKey: effectKey,
      },
    ],
  });

  const ownerId = `auto-safe-publish-blocked:${job.id}`;
  let record: BlockedPublicationDecisionRecord | undefined;
  let activeEffectId: string | undefined;
  const acquireEffect = async (effectId: string): Promise<boolean> => {
    const claim = await claimJournalEffect(journalOperationId, effectId, ownerId);
    if (claim.status === 'IN_PROGRESS') {
      throw new Error(`TEMPORARY_ERROR:JOURNAL_EFFECT_IN_PROGRESS:${effectId}`);
    }
    if (claim.status === 'COMPLETED') return false;
    activeEffectId = effectId;
    return true;
  };
  const finishEffect = async (effectId: string, actualValue: unknown): Promise<void> => {
    await completeJournalEffect(journalOperationId, effectId, actualValue, { ownerId });
    if (activeEffectId === effectId) activeEffectId = undefined;
  };

  try {
    const stateRequired = await acquireEffect('blocked-state');
    if (stateRequired) {
      const product = await getProductById(productId);
      const persistedRecord = product?.lastBlockedPublicationDecision?.operationId === job.operationId
        && product.lastBlockedPublicationDecision.effectKey === effectKey
        ? product.lastBlockedPublicationDecision
        : undefined;
      if (persistedRecord) {
        record = persistedRecord;
      } else {
        if (!decision) throw new Error('BLOCKED_PUBLICATION_DECISION_MISSING');
        const applied = await applyBlockedDecision(job, workerId, productId, decision, effectKey);
        record = applied.record;
      }
      if (process.env.NODE_ENV === 'test' && job.payload.simulateCrashAfterBlockedState === true && job.attemptCount === 1) {
        throw new Error('TEMPORARY_ERROR:SIMULATED_CRASH_AFTER_BLOCKED_STATE');
      }
      await finishEffect('blocked-state', {
        productId,
        effectKey,
        resultingLifecycleState: record.resultingLifecycleState,
      });
    } else {
      const product = await getProductById(productId);
      record = product?.lastBlockedPublicationDecision?.operationId === job.operationId
        ? product.lastBlockedPublicationDecision
        : undefined;
    }
    if (!record || record.effectKey !== effectKey) {
      throw new Error('BLOCKED_PUBLICATION_STATE_RECONCILIATION_FAILED');
    }

    if (await acquireEffect('blocked-audit')) {
      const durableAudit = await appendPublicationAuditOnce(blockedAuditFromRecord(record));
      if (process.env.NODE_ENV === 'test' && job.payload.simulateCrashAfterBlockedAuditWrite === true && job.attemptCount === 1) {
        throw new Error('TEMPORARY_ERROR:SIMULATED_CRASH_AFTER_BLOCKED_AUDIT_WRITE');
      }
      await finishEffect('blocked-audit', {
        auditId: durableAudit.event.id,
        effectKey,
      });
    }
    const journal = await getOperationJournal(journalOperationId);
    if (!journal || journal.reconciliationStatus !== 'CONSISTENT') {
      throw new Error('TEMPORARY_ERROR:BLOCKED_PUBLICATION_JOURNAL_INCOMPLETE');
    }
    return blockedResult(record);
  } catch (error) {
    if (activeEffectId) {
      await failJournalEffect(journalOperationId, activeEffectId, error, { ownerId });
    }
    throw error;
  }
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

function recoveryCanaryPermitIdFromJournal(
  journal: Awaited<ReturnType<typeof getOperationJournal>>,
): string | undefined {
  const effect = journal?.intendedEffects.find(item => item.id === 'recovery-canary-permit');
  const prefix = 'recovery-canary-permit:';
  return effect?.idempotencyKey.startsWith(prefix)
    ? effect.idempotencyKey.slice(prefix.length)
    : undefined;
}

function contextualizeBlockedDecision(
  decision: AutonomousPublishDecision,
  control: Awaited<ReturnType<typeof getAutomationControl>>,
): AutonomousPublishDecision {
  if (!decision.reasons.includes('publish_lane_paused')) return decision;
  const provenanceReasons = [
    ...(control.publishPausedByOperator ? ['publish_paused_by_operator'] : []),
    ...(control.publishBlockedByRuntime ? ['publish_blocked_by_runtime'] : []),
    ...(control.publishBlockedByPolicy ? ['publish_blocked_by_policy'] : []),
  ];
  return {
    ...decision,
    reasons: [...new Set([...decision.reasons, ...provenanceReasons])],
  };
}

function blockedJournalOperationId(operationId: string, productId: string): string {
  const identity = createHash('sha256').update(`${operationId}:${productId}`).digest('hex').slice(0, 24);
  return `blocked:${operationId.slice(0, 120)}:${identity}`.slice(0, 160);
}

export async function executeAutoSafePublish(job: AutomationJob, workerId: string): Promise<Record<string, unknown>> {
  const productId = typeof job.payload.productId === 'string' ? job.payload.productId : '';
  if (!productId) throw new Error('VALIDATION_PRODUCT_ID_REQUIRED');
  const existingJournal = await getOperationJournal(job.operationId);
  if (existingJournal?.operationType === 'AUTO_SAFE_PUBLISH_BLOCKED') {
    return executeBlockedDecision(job, workerId, productId);
  }
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
  const journalCanaryPermitId = recoveryCanaryPermitIdFromJournal(existingJournal);
  let recoveryCanaryPermit: RuntimeRecoveryCanaryPermit | undefined;
  if (journalCanaryPermitId) {
    const permit = await getRuntimeRecoveryCanaryPermit(journalCanaryPermitId);
    if (permit
      && permit.operationId === job.operationId
      && permit.productId === productId
      && permit.publicationEffectKey === effectKey
      && (permit.status === 'CONSUMED' || replayingCompletedProductWrite)) {
      recoveryCanaryPermit = permit;
    }
  }
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

  if (!decision.eligible
    && control.publishBlockedByRuntime
    && !control.publishPausedByOperator
    && !control.publishBlockedByPolicy
    && !control.killSwitch
    && decision.reasons.length === 1
    && decision.reasons[0] === 'publish_lane_paused') {
    const recoveryEvaluation = await evaluatePersistedAutonomousPublish(product, {
      mode: control.effectiveMode,
      killSwitch: control.killSwitch,
      publishPaused: false,
      workerId,
      jobType: job.type,
      jobClaimedBy: job.claimedBy,
      withinBudget,
      withinCanaryWave: wave.allowed,
    });
    if (recoveryEvaluation.decision.eligible) {
      if (recoveryCanaryPermit
        && job.claimToken
        && job.workerOwnerId
        && job.workerInstanceId
        && Number.isInteger(job.workerFencingToken)
        && Number(job.workerFencingToken) > 0) {
        const resumed = await validateRuntimeRecoveryCanaryPermitForOperation({
          permitId: recoveryCanaryPermit.id,
          operationId: job.operationId,
          productId,
          jobId: job.id,
          claimToken: job.claimToken,
          ownership: {
            ownerId: job.workerOwnerId,
            instanceId: job.workerInstanceId,
            fencingToken: Number(job.workerFencingToken),
          },
          productEligibleExceptRuntime: true,
          publicationEffectKey: effectKey,
        });
        if (resumed.allowed && resumed.permit) {
          recoveryCanaryPermit = resumed.permit;
          decision = recoveryEvaluation.decision;
          evidenceVerification = recoveryEvaluation.evidence;
        } else {
          recoveryCanaryPermit = undefined;
        }
      } else if (job.claimToken
        && job.workerOwnerId
        && job.workerInstanceId
        && Number.isInteger(job.workerFencingToken)
        && Number(job.workerFencingToken) > 0) {
        const ownership = {
          ownerId: job.workerOwnerId,
          instanceId: job.workerInstanceId,
          fencingToken: Number(job.workerFencingToken),
        };
        const issued = await issueRuntimeRecoveryCanaryPermit({
          operationId: job.operationId,
          productId,
          jobId: job.id,
          claimToken: job.claimToken,
          ownership,
          readinessSnapshotHash: effectSnapshot,
          productEligibleExceptRuntime: true,
        });
        if (issued.allowed && issued.permit) {
          const consumed = await consumeRuntimeRecoveryCanaryPermit({
            operationId: job.operationId,
            productId,
            jobId: job.id,
            claimToken: job.claimToken,
            ownership,
            permitId: issued.permit.id,
            productEligibleExceptRuntime: true,
            publicationEffectKey: effectKey,
          });
          if (consumed.allowed && consumed.permit) {
            recoveryCanaryPermit = consumed.permit;
            decision = recoveryEvaluation.decision;
            evidenceVerification = recoveryEvaluation.evidence;
          }
        }
      }
    }
  }

  if (!decision.eligible) {
    const blockedDecision = contextualizeBlockedDecision(decision, control);
    const journalOperationId = existingJournal?.operationType === 'AUTO_SAFE_PUBLISH'
      ? blockedJournalOperationId(job.operationId, productId)
      : job.operationId;
    return executeBlockedDecision(job, workerId, productId, blockedDecision, journalOperationId);
  }
  if (!replayingCompletedProductWrite) {
    assertAutonomousPublishEligible(product, {
      mode: control.effectiveMode,
      killSwitch: control.killSwitch,
      publishPaused: recoveryCanaryPermit ? false : control.publishPaused,
      workerId,
      jobType: job.type,
      jobClaimedBy: job.claimedBy,
      withinBudget,
      withinCanaryWave: wave.allowed,
    }, evidenceVerification);
  }

  const publicationAuditJournalEffect = !existingJournal
    || existingJournal.intendedEffects.some(effect => effect.id === 'publication-audit');
  await ensureOperationJournal({
    operationId: job.operationId,
    jobId: job.id,
    operationType: 'AUTO_SAFE_PUBLISH',
    effects: [
      ...(recoveryCanaryPermit ? [{
        id: 'recovery-canary-permit',
        description: 'Consume one scoped runtime recovery canary permit.',
        idempotencyKey: `recovery-canary-permit:${recoveryCanaryPermit.id}`,
        intendedValue: {
          permitId: recoveryCanaryPermit.id,
          operationId: job.operationId,
          productId,
        },
      }] : []),
      { id: 'publish-product', description: 'Publish canonical product exactly once.', idempotencyKey: effectKey, intendedValue: { productId, snapshotHash: effectSnapshot } },
      ...(publicationAuditJournalEffect ? [{
        id: 'publication-audit',
        description: 'Record one durable publication audit after the canonical product commit.',
        idempotencyKey: `${effectKey}:audit`,
      }] : []),
      { id: 'outbound-event', description: 'Emit one publication event.', idempotencyKey: `${effectKey}:event` },
      { id: 'monitor-job', description: 'Create one post-publish monitoring chain.', idempotencyKey: `${effectKey}:monitor` },
    ],
  });
  if (!(await reserveCanaryEffect(control.effectiveMode, effectKey))) {
    return {
      executionStatus: 'COMPLETED_WITH_LOCAL_RULES',
      executionMode: 'LOCAL_RULES',
      provider: 'local',
      published: false,
      quarantined: false,
      reasons: ['canary_wave_capacity_reached_concurrently'],
      rulesVersion: decision.ruleVersion,
      evidenceVerified: decision.evidenceVerified,
      aiRequests: 0,
      externalRequests: 0,
    };
  }

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
    if (recoveryCanaryPermit && await acquireEffect('recovery-canary-permit')) {
      await finishEffect('recovery-canary-permit', {
        permitId: recoveryCanaryPermit.id,
        operationId: job.operationId,
        productId,
      });
    }
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
        ...(recoveryCanaryPermit ? {
          runtimeRecoveryCanaryPermitId: recoveryCanaryPermit.id,
          runtimeRecoveryCanaryObservationPending: true,
          runtimeRecoveryCanaryObservationExpiresAt: recoveryCanaryPermit.expiresAt,
        } : {}),
      }, {
        jobId: job.id,
        workerId,
        operationId: job.operationId,
        runId: job.id,
        idempotencyKey: job.idempotencyKey,
        publicationEffectKey: effectKey,
        runtimeRecoveryCanaryPermitId: recoveryCanaryPermit?.id,
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

    if (publicationAuditJournalEffect) {
      if (await acquireEffect('publication-audit')) {
        const audit = await ensurePublishedPublicationAudit(job, workerId, productId, effectKey);
        await finishEffect('publication-audit', audit);
      }
    } else {
      await ensurePublishedPublicationAudit(job, workerId, productId, effectKey);
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
        payload: {
          productId,
          interval: '15m',
          sequence: 0,
          publicationEffectKey: effectKey,
          ...(recoveryCanaryPermit ? {
            runtimeRecoveryCanaryPermitId: recoveryCanaryPermit.id,
          } : {}),
        },
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
    await recordSourceQualityObservation(published.source, {
      idempotencyKey: `source-publish:${effectKey}`.slice(0, 200),
      observedAt: published.publishedAt || job.createdAt,
      publishedProducts: 1,
    });
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
    if (recoveryCanaryPermit && !mustPreserveCanaryReservation) {
      await finalizeRuntimeRecoveryCanaryPermit({
        permitId: recoveryCanaryPermit.id,
        productId,
        healthy: false,
        reasonCode: 'RECOVERY_CANARY_PUBLICATION_ABORTED',
        publicationEffectKey: effectKey,
        preserveRuntimeBlock: true,
        finalStatus: 'REVOKED',
      });
    }
    if (!mustPreserveCanaryReservation) await completeCanaryEffect(control.effectiveMode, effectKey, false);
    throw error;
  }
}
