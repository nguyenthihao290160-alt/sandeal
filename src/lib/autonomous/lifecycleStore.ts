import { createHash } from 'node:crypto';
import {
  completeJournalEffect,
  ensureOperationJournal,
  failJournalEffect,
  getOperationJournal,
} from '@/lib/automation/operationJournal';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { AutomationJob } from '@/lib/automation/types';
import type { Product, ProductLifecycleState } from '@/lib/types';
import {
  transitionLifecycle,
  type LifecycleActor,
  type LifecycleTransitionEvent,
} from './lifecycle';

const PRODUCTS_COLLECTION = 'products';
const EVENTS_COLLECTION = 'product-lifecycle-events';

export interface PersistLifecycleTransitionInput {
  productId: string;
  to: ProductLifecycleState;
  actor: LifecycleActor;
  transitionKey: string;
  operationId?: string;
  reasonCodes?: string[];
  now?: string;
  /** Isolated crash test only. Runtime callers cannot enable this hook. */
  testFailurePoint?: 'AFTER_EVENT_INTENT' | 'AFTER_PRODUCT_WRITE';
}

export interface PersistLifecycleTransitionResult {
  product: Product;
  event: LifecycleTransitionEvent;
  changed: boolean;
  replayed: boolean;
  reconciled: boolean;
  journalOperationId: string;
}

function transitionDigest(transitionKey: string): string {
  return createHash('sha256').update(transitionKey).digest('hex');
}

function journalOperationId(transitionKey: string): string {
  return `lifecycle:${transitionDigest(transitionKey).slice(0, 40)}`;
}

function assertTestFailurePointAllowed(input: PersistLifecycleTransitionInput): void {
  if (input.testFailurePoint && process.env.NODE_ENV !== 'test') throw new Error('LIFECYCLE_TEST_HOOK_FORBIDDEN');
}

function assertExistingEventMatches(event: LifecycleTransitionEvent, input: PersistLifecycleTransitionInput): void {
  if (event.productId !== input.productId || event.nextState !== input.to) throw new Error('LIFECYCLE_TRANSITION_KEY_REUSED');
  if (event.actor.jobId !== input.actor.jobId || event.actor.jobType !== input.actor.jobType) {
    throw new Error('LIFECYCLE_TRANSITION_JOB_MISMATCH');
  }
}

async function getProduct(productId: string): Promise<Product | null> {
  return (await readCollection<Product>(PRODUCTS_COLLECTION)).find(item => item.id === productId) || null;
}

async function assertDurableJobClaim(actor: LifecycleActor): Promise<void> {
  if (actor.type === 'migration') return;
  if (!actor.jobId || !actor.jobType) throw new Error('LIFECYCLE_DURABLE_JOB_REQUIRED');
  const job = (await readCollection<AutomationJob>('automation-jobs')).find(item => item.id === actor.jobId);
  if (!job || job.type !== actor.jobType) throw new Error('LIFECYCLE_DURABLE_JOB_INVALID');
  if (job.status !== 'RUNNING' || job.claimedBy !== actor.id) throw new Error('LIFECYCLE_DURABLE_JOB_NOT_CLAIMED');
}

export async function getLifecycleTransitionEvent(transitionKey: string): Promise<LifecycleTransitionEvent | null> {
  return (await readCollection<LifecycleTransitionEvent>(EVENTS_COLLECTION))
    .find(item => item.transitionKey === transitionKey) || null;
}

export async function listLifecycleTransitionEvents(productId?: string): Promise<LifecycleTransitionEvent[]> {
  const events = await readCollection<LifecycleTransitionEvent>(EVENTS_COLLECTION);
  return events
    .filter(event => !productId || event.productId === productId)
    .sort((left, right) => Date.parse(left.transitionedAt) - Date.parse(right.transitionedAt) || left.id.localeCompare(right.id));
}

async function ensureEventIntent(
  input: PersistLifecycleTransitionInput,
  product: Product,
  lifecycleJournalId: string,
): Promise<{ event: LifecycleTransitionEvent; existing: boolean }> {
  let output!: { event: LifecycleTransitionEvent; existing: boolean };
  await runTransaction<LifecycleTransitionEvent>(EVENTS_COLLECTION, events => {
    const existing = events.find(item => item.transitionKey === input.transitionKey);
    if (existing) {
      assertExistingEventMatches(existing, input);
      output = { event: structuredClone(existing), existing: true };
      return undefined;
    }
    const pendingForProduct = events.find(item => item.productId === input.productId && item.status === 'PENDING');
    if (pendingForProduct) throw new Error(`LIFECYCLE_PENDING_RECONCILIATION_REQUIRED:${pendingForProduct.transitionKey}`);
    const transition = transitionLifecycle(product, input.to, input.actor, {
      transitionKey: input.transitionKey,
      operationId: input.operationId || lifecycleJournalId,
      reasonCodes: input.reasonCodes,
      now: input.now,
    });
    events.push(transition.event);
    output = { event: structuredClone(transition.event), existing: false };
    return events;
  });
  return output;
}

async function applyProductTransition(
  event: LifecycleTransitionEvent,
): Promise<{ product: Product; changed: boolean; reconciled: boolean }> {
  let output!: { product: Product; changed: boolean; reconciled: boolean };
  await runTransaction<Product>(PRODUCTS_COLLECTION, products => {
    const index = products.findIndex(item => item.id === event.productId);
    if (index < 0) throw new Error('LIFECYCLE_PRODUCT_NOT_FOUND');
    const current = products[index];
    const currentState = current.lifecycleState || (current.status === 'published' ? 'PUBLISHED' : 'STAGED');
    if (currentState === event.nextState) {
      output = { product: structuredClone(current), changed: false, reconciled: true };
      return undefined;
    }
    if (currentState !== event.previousState) {
      throw new Error(`LIFECYCLE_RECONCILIATION_CONFLICT:${event.previousState}:${currentState}:${event.nextState}`);
    }
    const transition = transitionLifecycle(current, event.nextState, event.actor, {
      transitionKey: event.transitionKey,
      operationId: event.operationId,
      reasonCodes: event.reasonCodes,
      now: event.transitionedAt,
    });
    products[index] = transition.product;
    output = { product: structuredClone(transition.product), changed: true, reconciled: event.status === 'PENDING' };
    return products;
  });
  return output;
}

async function finalizeEvent(event: LifecycleTransitionEvent): Promise<LifecycleTransitionEvent> {
  let output!: LifecycleTransitionEvent;
  await runTransaction<LifecycleTransitionEvent>(EVENTS_COLLECTION, events => {
    const stored = events.find(item => item.transitionKey === event.transitionKey);
    if (!stored) throw new Error('LIFECYCLE_EVENT_NOT_FOUND');
    if (stored.status !== 'APPLIED') {
      stored.status = 'APPLIED';
      stored.appliedAt = stored.appliedAt || new Date().toISOString();
    }
    output = structuredClone(stored);
    return events;
  });
  return output;
}

export async function persistLifecycleTransition(
  input: PersistLifecycleTransitionInput,
): Promise<PersistLifecycleTransitionResult> {
  assertTestFailurePointAllowed(input);
  const initial = await getProduct(input.productId);
  if (!initial) throw new Error('LIFECYCLE_PRODUCT_NOT_FOUND');
  const lifecycleJournalId = journalOperationId(input.transitionKey);
  const preexistingEvent = await getLifecycleTransitionEvent(input.transitionKey);
  if (preexistingEvent) {
    assertExistingEventMatches(preexistingEvent, input);
  } else {
    // Authorize and validate the transition before creating any durable journal artifact.
    transitionLifecycle(initial, input.to, input.actor, {
      transitionKey: input.transitionKey,
      operationId: input.operationId || lifecycleJournalId,
      reasonCodes: input.reasonCodes,
      now: input.now,
    });
    await assertDurableJobClaim(input.actor);
  }
  await ensureOperationJournal({
    operationId: lifecycleJournalId,
    jobId: input.actor.jobId,
    operationType: 'PRODUCT_LIFECYCLE_TRANSITION',
    effects: [
      {
        id: 'event-intent',
        description: 'Persist one immutable lifecycle transition intent.',
        idempotencyKey: `${input.transitionKey}:event-intent`,
        intendedValue: { productId: input.productId, to: input.to, jobId: input.actor.jobId },
      },
      {
        id: 'product-transition',
        description: 'Apply the authorized lifecycle state to the canonical product.',
        idempotencyKey: `${input.transitionKey}:product-transition`,
        intendedValue: { productId: input.productId, to: input.to },
      },
      {
        id: 'event-finalize',
        description: 'Mark the lifecycle event applied after the product write is durable.',
        idempotencyKey: `${input.transitionKey}:event-finalize`,
      },
    ],
  });

  let activeEffect = 'event-intent';
  try {
    const intent = await ensureEventIntent(input, initial, lifecycleJournalId);
    await completeJournalEffect(lifecycleJournalId, 'event-intent', {
      eventId: intent.event.id,
      transitionKey: intent.event.transitionKey,
      productId: intent.event.productId,
      nextState: intent.event.nextState,
    });
    if (input.testFailurePoint === 'AFTER_EVENT_INTENT') throw new Error('SIMULATED_LIFECYCLE_CRASH_AFTER_EVENT_INTENT');

    if (intent.event.status === 'APPLIED') {
      const current = await getProduct(input.productId);
      if (!current) throw new Error('LIFECYCLE_PRODUCT_NOT_FOUND');
      const currentState = current.lifecycleState || (current.status === 'published' ? 'PUBLISHED' : 'STAGED');
      if (currentState === intent.event.previousState) throw new Error('LIFECYCLE_APPLIED_EVENT_PRODUCT_MISMATCH');
      await completeJournalEffect(lifecycleJournalId, 'product-transition', {
        productId: current.id,
        lifecycleState: intent.event.nextState,
        lifecycleUpdatedAt: intent.event.transitionedAt,
      });
      await completeJournalEffect(lifecycleJournalId, 'event-finalize', {
        eventId: intent.event.id,
        transitionKey: intent.event.transitionKey,
        applied: true,
      });
      return {
        product: current,
        event: intent.event,
        changed: false,
        replayed: true,
        reconciled: false,
        journalOperationId: lifecycleJournalId,
      };
    }

    activeEffect = 'product-transition';
    const applied = await applyProductTransition(intent.event);
    await completeJournalEffect(lifecycleJournalId, 'product-transition', {
      productId: applied.product.id,
      lifecycleState: applied.product.lifecycleState,
      lifecycleUpdatedAt: applied.product.lifecycleUpdatedAt,
    });
    if (input.testFailurePoint === 'AFTER_PRODUCT_WRITE') throw new Error('SIMULATED_LIFECYCLE_CRASH_AFTER_PRODUCT_WRITE');

    activeEffect = 'event-finalize';
    const event = await finalizeEvent(intent.event);
    await completeJournalEffect(lifecycleJournalId, 'event-finalize', {
      eventId: event.id,
      transitionKey: event.transitionKey,
      applied: true,
    });
    return {
      product: applied.product,
      event,
      changed: applied.changed,
      replayed: intent.existing,
      reconciled: applied.reconciled && intent.existing,
      journalOperationId: lifecycleJournalId,
    };
  } catch (error) {
    await failJournalEffect(lifecycleJournalId, activeEffect, error).catch(() => undefined);
    throw error;
  }
}

export async function reconcilePendingLifecycleTransitions(limit = 100): Promise<{
  inspected: number;
  repaired: number;
  failed: Array<{ transitionKey: string; error: string }>;
}> {
  const pending = (await listLifecycleTransitionEvents()).filter(event => event.status === 'PENDING').slice(0, Math.max(1, Math.min(500, limit)));
  const result: { inspected: number; repaired: number; failed: Array<{ transitionKey: string; error: string }> } = {
    inspected: pending.length,
    repaired: 0,
    failed: [],
  };
  for (const event of pending) {
    try {
      await persistLifecycleTransition({
        productId: event.productId,
        to: event.nextState,
        actor: event.actor,
        transitionKey: event.transitionKey,
        operationId: event.operationId,
        reasonCodes: event.reasonCodes,
        now: event.transitionedAt,
      });
      result.repaired += 1;
    } catch (error) {
      result.failed.push({ transitionKey: event.transitionKey, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export async function getLifecycleTransitionJournal(transitionKey: string) {
  return getOperationJournal(journalOperationId(transitionKey));
}
