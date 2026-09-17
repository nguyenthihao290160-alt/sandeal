import type { QueueDelivery } from '../platform/cloudflareContracts';
import { D1ExecutionStore, ExecutionStoreError } from '../storage/d1/d1ExecutionStore';
import { validId } from './fingerprint';

export interface ExecutionQueueBinding { send(message: { version: 1; jobId: string }): Promise<void> }
export async function consumeExecutionDelivery(store: D1ExecutionStore, queue: ExecutionQueueBinding | null, delivery: QueueDelivery, now: () => number): Promise<void> {
  try {
    if (!queue || typeof queue.send !== 'function') throw new ExecutionStoreError('EXECUTION_QUEUE_UNAVAILABLE');
    const body = delivery.body as { version?: unknown; jobId?: unknown } | null;
    if (!body || Object.keys(body).sort().join(',') !== 'jobId,version' || body.version !== 1 || !validId(body.jobId)) { delivery.ack(); return; }
    const status = await store.jobStatus(body.jobId, now());
    if (['SUCCEEDED', 'BLOCKED', 'MISSING'].includes(status)) { delivery.ack(); return; }
    const claim = await store.claim(body.jobId, now());
    if (!claim) { delivery.retry({ delaySeconds: 60 }); return; }
    await store.completeClaim(claim, now(), true, now);
    delivery.ack();
  } catch { delivery.retry({ delaySeconds: 60 }); }
}
