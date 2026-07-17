import { createHash } from 'node:crypto';
import type { AutomationJobType } from '@/lib/automation/types';
import type { Product, ProductLifecycleState } from '@/lib/types';

export const PRODUCT_LIFECYCLE_VERSION = 'product-lifecycle-v1';
export const PRODUCT_LIFECYCLE_SCHEMA_VERSION = 1;

export type LifecycleActorType = 'worker' | 'reconciler' | 'guardian' | 'migration' | 'api';
export type LifecycleEventStatus = 'PENDING' | 'APPLIED';

export interface LifecycleActor {
  type: LifecycleActorType;
  id: string;
  jobId?: string;
  jobType?: AutomationJobType;
}

export interface LifecycleActorAuthorization {
  actorType: Exclude<LifecycleActorType, 'api'>;
  jobTypes?: AutomationJobType[];
}

export interface LifecycleTransitionDefinition {
  schemaVersion: number;
  from: ProductLifecycleState;
  to: ProductLifecycleState;
  authorizedActors: LifecycleActorAuthorization[];
  precondition: string;
  output: string;
  writeScope: string[];
  sideEffect: 'NONE' | 'SCHEDULE_RETRY' | 'PUBLISH' | 'HIDE_PUBLIC_PRODUCT';
  retryable: boolean;
  idempotencyStrategy: 'CALLER_TRANSITION_KEY';
  auditEvent: string;
}

export interface LifecycleTransitionEvent {
  schemaVersion: number;
  id: string;
  transitionKey: string;
  operationId: string;
  productId: string;
  previousState: ProductLifecycleState;
  nextState: ProductLifecycleState;
  actor: LifecycleActor;
  reasonCodes: string[];
  lifecycleVersion: string;
  definition: Pick<LifecycleTransitionDefinition,
    'precondition' | 'output' | 'writeScope' | 'sideEffect' | 'retryable' | 'idempotencyStrategy' | 'auditEvent'>;
  status: LifecycleEventStatus;
  transitionedAt: string;
  appliedAt?: string;
}

export interface LifecycleTransitionOptions {
  transitionKey: string;
  operationId?: string;
  reasonCodes?: string[];
  now?: string;
}

const PROCESS_JOB: AutomationJobType[] = ['PROCESS_CANDIDATE'];
const PUBLISH_JOB: AutomationJobType[] = ['AUTO_SAFE_PUBLISH', 'SAFE_PUBLISH'];
const MONITOR_JOB: AutomationJobType[] = ['POST_PUBLISH_MONITOR', 'RECHECK_PRODUCT_HEALTH'];
const RECONCILE_JOB: AutomationJobType[] = ['RECONCILE_AUTOMATION'];

const processWorker = (): LifecycleActorAuthorization => ({ actorType: 'worker', jobTypes: [...PROCESS_JOB] });
const publishWorker = (): LifecycleActorAuthorization => ({ actorType: 'worker', jobTypes: [...PUBLISH_JOB] });
const monitorWorker = (): LifecycleActorAuthorization => ({ actorType: 'worker', jobTypes: [...MONITOR_JOB] });
const reconciler = (): LifecycleActorAuthorization => ({ actorType: 'reconciler', jobTypes: [...RECONCILE_JOB] });
const migration = (): LifecycleActorAuthorization => ({ actorType: 'migration' });

function definition(
  from: ProductLifecycleState,
  to: ProductLifecycleState,
  authorizedActors: LifecycleActorAuthorization[],
  input: {
    precondition: string;
    output: string;
    sideEffect?: LifecycleTransitionDefinition['sideEffect'];
    retryable?: boolean;
    writeScope?: string[];
  },
): LifecycleTransitionDefinition {
  return {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    from,
    to,
    authorizedActors,
    precondition: input.precondition,
    output: input.output,
    writeScope: input.writeScope || ['products', 'product-lifecycle-events', 'operation-journal'],
    sideEffect: input.sideEffect || 'NONE',
    retryable: input.retryable ?? false,
    idempotencyStrategy: 'CALLER_TRANSITION_KEY',
    auditEvent: `PRODUCT_${from}_TO_${to}`,
  };
}

const DEFINITIONS: LifecycleTransitionDefinition[] = [
  definition('DISCOVERED', 'STAGED', [processWorker(), migration()], { precondition: 'candidate_identity_exists', output: 'candidate_staged' }),
  definition('DISCOVERED', 'QUARANTINED', [processWorker(), migration()], { precondition: 'discovery_policy_failed', output: 'record_quarantined' }),
  definition('STAGED', 'CLASSIFIED', [processWorker()], { precondition: 'classification_is_versioned', output: 'record_type_assigned' }),
  definition('STAGED', 'QUARANTINED', [processWorker(), migration()], { precondition: 'classification_is_restricted_or_low_confidence', output: 'record_quarantined' }),
  definition('CLASSIFIED', 'NORMALIZED', [processWorker()], { precondition: 'record_type_is_product', output: 'canonical_product_normalized' }),
  definition('CLASSIFIED', 'QUARANTINED', [processWorker()], { precondition: 'record_type_is_not_publishable', output: 'record_quarantined' }),
  definition('NORMALIZED', 'VERIFYING', [processWorker()], { precondition: 'canonical_identity_exists', output: 'verification_started', retryable: true }),
  definition('NORMALIZED', 'QUARANTINED', [processWorker()], { precondition: 'canonical_normalization_failed', output: 'record_quarantined' }),
  definition('VERIFYING', 'CONTENT_PREPARING', [processWorker()], { precondition: 'health_evidence_and_duplicate_checks_passed', output: 'content_preparation_started' }),
  definition('VERIFYING', 'RETRY_SCHEDULED', [processWorker(), monitorWorker()], { precondition: 'verification_failed_transiently', output: 'verification_retry_scheduled', sideEffect: 'SCHEDULE_RETRY', retryable: true }),
  definition('VERIFYING', 'QUARANTINED', [processWorker()], { precondition: 'verification_failed_policy', output: 'record_quarantined' }),
  definition('RETRY_SCHEDULED', 'VERIFYING', [processWorker(), reconciler()], { precondition: 'verification_retry_is_due', output: 'verification_resumed', retryable: true }),
  definition('RETRY_SCHEDULED', 'RECHECKING', [monitorWorker(), reconciler()], { precondition: 'monitor_retry_is_due', output: 'health_recheck_started', retryable: true }),
  definition('RETRY_SCHEDULED', 'QUARANTINED', [processWorker(), monitorWorker()], { precondition: 'retry_budget_exhausted', output: 'record_quarantined' }),
  definition('CONTENT_PREPARING', 'READY_FOR_PUBLISH', [processWorker()], { precondition: 'editorial_and_readiness_policy_passed', output: 'publish_snapshot_ready' }),
  definition('CONTENT_PREPARING', 'QUARANTINED', [processWorker()], { precondition: 'content_or_claim_policy_failed', output: 'record_quarantined' }),
  definition('READY_FOR_PUBLISH', 'PUBLISHING', [publishWorker()], { precondition: 'durable_publish_job_claimed_and_snapshot_fresh', output: 'publish_effect_started', sideEffect: 'PUBLISH', retryable: true }),
  definition('READY_FOR_PUBLISH', 'VERIFYING', [processWorker(), reconciler()], { precondition: 'readiness_snapshot_invalidated', output: 'verification_reopened', retryable: true }),
  definition('READY_FOR_PUBLISH', 'QUARANTINED', [processWorker(), publishWorker()], { precondition: 'publish_policy_failed', output: 'record_quarantined' }),
  definition('PUBLISHING', 'PUBLISHED', [publishWorker()], { precondition: 'exactly_once_publish_effect_confirmed', output: 'product_public', sideEffect: 'PUBLISH' }),
  definition('PUBLISHING', 'RETRY_SCHEDULED', [publishWorker()], { precondition: 'publish_effect_failed_transiently', output: 'publish_retry_scheduled', sideEffect: 'SCHEDULE_RETRY', retryable: true }),
  definition('PUBLISHING', 'QUARANTINED', [publishWorker()], { precondition: 'publish_effect_failed_policy', output: 'record_quarantined' }),
  definition('PUBLISHED', 'DEGRADED', [monitorWorker()], { precondition: 'temporary_post_publish_failure_observed', output: 'public_product_degraded', retryable: true }),
  definition('PUBLISHED', 'RECHECKING', [monitorWorker(), reconciler()], { precondition: 'post_publish_recheck_is_due', output: 'health_recheck_started', retryable: true }),
  definition('DEGRADED', 'RECHECKING', [monitorWorker(), reconciler()], { precondition: 'degraded_recheck_is_due', output: 'health_recheck_started', retryable: true }),
  definition('DEGRADED', 'PUBLISHED', [monitorWorker()], { precondition: 'temporary_failure_recovered', output: 'public_product_healthy' }),
  definition('DEGRADED', 'CONFIRMED_BROKEN', [monitorWorker()], { precondition: 'permanent_failure_confirmed', output: 'broken_state_confirmed' }),
  definition('RECHECKING', 'PUBLISHED', [monitorWorker()], { precondition: 'recheck_passed_for_public_product', output: 'public_product_healthy' }),
  definition('RECHECKING', 'READY_FOR_PUBLISH', [monitorWorker()], { precondition: 'hidden_product_recovered_and_readiness_rebuilt', output: 'republish_snapshot_ready' }),
  definition('RECHECKING', 'RETRY_SCHEDULED', [monitorWorker()], { precondition: 'recheck_failed_transiently', output: 'recheck_retry_scheduled', sideEffect: 'SCHEDULE_RETRY', retryable: true }),
  definition('RECHECKING', 'CONFIRMED_BROKEN', [monitorWorker()], { precondition: 'permanent_failure_confirmed', output: 'broken_state_confirmed' }),
  definition('RECHECKING', 'QUARANTINED', [monitorWorker(), reconciler()], { precondition: 'recheck_failed_policy', output: 'record_quarantined' }),
  definition('CONFIRMED_BROKEN', 'HIDDEN', [monitorWorker()], { precondition: 'confirmed_broken_product_is_public', output: 'public_product_hidden', sideEffect: 'HIDE_PUBLIC_PRODUCT' }),
  definition('HIDDEN', 'RECHECKING', [monitorWorker(), reconciler()], { precondition: 'hidden_product_recheck_is_due', output: 'health_recheck_started', retryable: true }),
  definition('HIDDEN', 'READY_FOR_PUBLISH', [monitorWorker()], { precondition: 'hidden_product_recovered_and_readiness_rebuilt', output: 'republish_snapshot_ready' }),
  definition('HIDDEN', 'QUARANTINED', [monitorWorker(), reconciler()], { precondition: 'hidden_product_requires_long_quarantine', output: 'record_quarantined' }),
  definition('QUARANTINED', 'RECHECKING', [monitorWorker(), reconciler()], { precondition: 'quarantine_recheck_is_due', output: 'health_recheck_started', retryable: true }),
  definition('QUARANTINED', 'VERIFYING', [processWorker(), reconciler()], { precondition: 'quarantine_input_changed_or_retry_is_due', output: 'verification_reopened', retryable: true }),
];

const DEFINITION_MAP = new Map(DEFINITIONS.map(item => [`${item.from}:${item.to}`, item]));

function normalizedTransitionKey(value: string): string {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 200 || /[\u0000-\u001f]/.test(key)) throw new Error('LIFECYCLE_TRANSITION_KEY_INVALID');
  return key;
}

function assertAuthorized(definitionValue: LifecycleTransitionDefinition, actor: LifecycleActor): void {
  if (!actor.id.trim()) throw new Error('LIFECYCLE_ACTOR_ID_REQUIRED');
  if (actor.type === 'api') throw new Error('LIFECYCLE_API_WRITE_FORBIDDEN');
  const actorAuthorizations = definitionValue.authorizedActors.filter(item => item.actorType === actor.type);
  if (!actorAuthorizations.length) throw new Error(`LIFECYCLE_ACTOR_FORBIDDEN:${actor.type}:${definitionValue.from}:${definitionValue.to}`);
  const unrestricted = actorAuthorizations.find(item => !item.jobTypes);
  if (!unrestricted && (!actor.jobId || !actor.jobType)) throw new Error('LIFECYCLE_DURABLE_JOB_REQUIRED');
  const authorization = unrestricted || actorAuthorizations.find(item => item.jobTypes?.includes(actor.jobType!));
  if (!authorization) throw new Error(`LIFECYCLE_JOB_TYPE_FORBIDDEN:${actor.jobType}`);
  if (authorization.jobTypes) {
    if (!actor.jobId || !actor.jobType) throw new Error('LIFECYCLE_DURABLE_JOB_REQUIRED');
  }
}

export function getLifecycleTransitionDefinition(
  from: ProductLifecycleState,
  to: ProductLifecycleState,
): LifecycleTransitionDefinition | null {
  const found = DEFINITION_MAP.get(`${from}:${to}`);
  return found ? structuredClone(found) : null;
}

export function canTransitionLifecycle(from: ProductLifecycleState, to: ProductLifecycleState): boolean {
  return from === to || DEFINITION_MAP.has(`${from}:${to}`);
}

export function transitionLifecycle(
  product: Product,
  to: ProductLifecycleState,
  actor: LifecycleActor,
  options: LifecycleTransitionOptions,
): { product: Product; event: LifecycleTransitionEvent; changed: boolean } {
  const from = product.lifecycleState || (product.status === 'published' ? 'PUBLISHED' : 'STAGED');
  const transitionKey = normalizedTransitionKey(options.transitionKey);
  const definitionValue = getLifecycleTransitionDefinition(from, to);
  if (!definitionValue) {
    if (from === to) throw new Error('LIFECYCLE_REPLAY_REQUIRES_PERSISTED_EVENT');
    throw new Error(`FORBIDDEN_LIFECYCLE_TRANSITION:${from}:${to}`);
  }
  assertAuthorized(definitionValue, actor);
  const transitionedAt = options.now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(transitionedAt))) throw new Error('LIFECYCLE_TRANSITION_TIME_INVALID');
  const operationId = options.operationId || `lifecycle:${createHash('sha256').update(transitionKey).digest('hex').slice(0, 32)}`;
  const event: LifecycleTransitionEvent = {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    id: `lifecycle-${createHash('sha256').update(transitionKey).digest('hex').slice(0, 32)}`,
    transitionKey,
    operationId,
    productId: product.id,
    previousState: from,
    nextState: to,
    actor: { ...actor },
    reasonCodes: [...new Set((options.reasonCodes || []).map(String).map(item => item.trim()).filter(Boolean))],
    lifecycleVersion: PRODUCT_LIFECYCLE_VERSION,
    definition: {
      precondition: definitionValue.precondition,
      output: definitionValue.output,
      writeScope: [...definitionValue.writeScope],
      sideEffect: definitionValue.sideEffect,
      retryable: definitionValue.retryable,
      idempotencyStrategy: definitionValue.idempotencyStrategy,
      auditEvent: definitionValue.auditEvent,
    },
    status: 'PENDING',
    transitionedAt,
  };
  return {
    product: {
      ...product,
      lifecycleState: to,
      lifecycleVersion: PRODUCT_LIFECYCLE_VERSION,
      lifecycleUpdatedAt: transitionedAt,
      updatedAt: transitionedAt,
      relatedJobId: actor.jobId || product.relatedJobId,
      nextAutomaticAction: to === 'QUARANTINED' ? 'RECHECK_QUARANTINED_PRODUCT' : product.nextAutomaticAction,
      quarantineReasons: to === 'QUARANTINED'
        ? [...new Set([...(product.quarantineReasons || []), ...event.reasonCodes])]
        : product.quarantineReasons,
    },
    event,
    changed: true,
  };
}

export function listLifecycleContract(): LifecycleTransitionDefinition[] {
  return DEFINITIONS.map(item => structuredClone(item));
}
