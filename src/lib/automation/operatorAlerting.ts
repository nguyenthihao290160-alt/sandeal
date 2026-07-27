import { createHash, randomUUID } from 'crypto';

import { runTransaction } from '@/lib/storage/adapter';
import { getFeatureRolloutState } from './featureRollout';

const COLLECTION = 'operator-alert-deliveries';
const MAX_RECORDS = 5_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const SECRET_KEY = /authorization|cookie|credential|password|secret|token|api[_-]?key/i;

export type OperatorAlertSeverity = 'INFO' | 'ATTENTION' | 'IMPORTANT' | 'CRITICAL';

export interface OperatorAlert {
  eventType: string;
  entityType: string;
  entityId: string;
  transitionId: string;
  severity: OperatorAlertSeverity;
  title: string;
  message: string;
  occurredAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface OperatorAlertAdapter {
  id: string;
  deliver(alert: OperatorAlert, signal: AbortSignal): Promise<{ receiptId?: string }>;
}

export interface OperatorAlertDelivery {
  schemaVersion: 1;
  id: string;
  deduplicationKey: string;
  adapterId: string;
  status: 'ATTEMPTING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  leaseId?: string;
  eventType: string;
  entityType: string;
  entityHash: string;
  severity: OperatorAlertSeverity;
  receiptHash?: string;
  failureCode?: 'DELIVERY_TIMEOUT' | 'DELIVERY_FAILED';
  firstAttemptAt: string;
  lastAttemptAt: string;
  deliveredAt?: string;
  nextRetryAt?: string;
}

export interface OperatorAlertDispatchResult {
  status: 'SUPPRESSED' | 'DELIVERED' | 'FAILED' | 'DUPLICATE';
  reasonCode?: 'FEATURE_DISABLED' | 'NO_ADAPTERS' | 'DUPLICATE' | 'DELIVERY_FAILED';
  deliveries: OperatorAlertDelivery[];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new Error('OPERATOR_ALERT_STRING_REQUIRED');
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) throw new Error('OPERATOR_ALERT_STRING_REQUIRED');
  return normalized.slice(0, maximum);
}

function normalizeAlert(input: OperatorAlert): OperatorAlert {
  if (!['INFO', 'ATTENTION', 'IMPORTANT', 'CRITICAL'].includes(input.severity)) {
    throw new Error('OPERATOR_ALERT_SEVERITY_INVALID');
  }
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error('OPERATOR_ALERT_TIMESTAMP_INVALID');
  }
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.metadata || {}).slice(0, 32)) {
    if (SECRET_KEY.test(key) || key.length > 80) throw new Error('OPERATOR_ALERT_METADATA_UNSAFE');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      metadata[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    } else {
      throw new Error('OPERATOR_ALERT_METADATA_UNSAFE');
    }
  }
  const normalized = {
    eventType: safeSegment(input.eventType, 120),
    entityType: safeSegment(input.entityType, 120),
    entityId: safeSegment(input.entityId, 240),
    transitionId: safeSegment(input.transitionId, 240),
    severity: input.severity,
    title: safeSegment(input.title, 240),
    message: safeSegment(input.message, 2_000),
    occurredAt: new Date(input.occurredAt).toISOString(),
    metadata,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 16 * 1024) {
    throw new Error('OPERATOR_ALERT_TOO_LARGE');
  }
  return normalized;
}

function deduplicationKey(alert: OperatorAlert, adapterId: string): string {
  return hash([
    alert.eventType,
    alert.entityType,
    alert.entityId,
    alert.transitionId,
    adapterId,
  ].join('|'));
}

function cloneDelivery(delivery: OperatorAlertDelivery): OperatorAlertDelivery {
  return { ...delivery };
}

async function claimDelivery(
  alert: OperatorAlert,
  adapterId: string,
  now: number,
): Promise<{ delivery: OperatorAlertDelivery; duplicate: boolean }> {
  const key = deduplicationKey(alert, adapterId);
  const id = `operator-alert:${key.slice(0, 32)}`;
  const nowIso = new Date(now).toISOString();
  let result!: { delivery: OperatorAlertDelivery; duplicate: boolean };
  await runTransaction<OperatorAlertDelivery>(COLLECTION, items => {
    const current = items.find(item => item.id === id);
    const retryAt = Date.parse(current?.nextRetryAt || '');
    if (
      current?.status === 'DELIVERED'
      || current?.status === 'ATTEMPTING'
      || (current?.status === 'FAILED' && Number.isFinite(retryAt) && retryAt > now)
    ) {
      result = { delivery: cloneDelivery(current), duplicate: true };
      return undefined;
    }
    const delivery: OperatorAlertDelivery = {
      schemaVersion: 1,
      id,
      deduplicationKey: key,
      adapterId,
      status: 'ATTEMPTING',
      attempts: (current?.attempts || 0) + 1,
      leaseId: randomUUID(),
      eventType: alert.eventType,
      entityType: alert.entityType,
      entityHash: hash(alert.entityId),
      severity: alert.severity,
      firstAttemptAt: current?.firstAttemptAt || nowIso,
      lastAttemptAt: nowIso,
    };
    result = { delivery: cloneDelivery(delivery), duplicate: false };
    return [...items.filter(item => item.id !== id).slice(-(MAX_RECORDS - 1)), delivery];
  });
  return result;
}

async function finishDelivery(
  claimed: OperatorAlertDelivery,
  result: { receiptId?: string } | null,
  now: number,
  timedOut: boolean,
): Promise<OperatorAlertDelivery> {
  let completed = claimed;
  await runTransaction<OperatorAlertDelivery>(COLLECTION, items => {
    const index = items.findIndex(item => (
      item.id === claimed.id
      && item.status === 'ATTEMPTING'
      && item.leaseId === claimed.leaseId
    ));
    if (index === -1) return undefined;
    const updated: OperatorAlertDelivery = result
      ? {
          ...items[index],
          status: 'DELIVERED',
          leaseId: undefined,
          receiptHash: result.receiptId ? hash(result.receiptId) : undefined,
          deliveredAt: new Date(now).toISOString(),
          failureCode: undefined,
          nextRetryAt: undefined,
        }
      : {
          ...items[index],
          status: 'FAILED',
          leaseId: undefined,
          failureCode: timedOut ? 'DELIVERY_TIMEOUT' : 'DELIVERY_FAILED',
          nextRetryAt: new Date(now + Math.min(60 * 60_000, 5_000 * (2 ** items[index].attempts))).toISOString(),
        };
    items[index] = updated;
    completed = cloneDelivery(updated);
    return items;
  });
  return completed;
}

async function boundedDelivery(
  adapter: OperatorAlertAdapter,
  alert: OperatorAlert,
): Promise<{ result: { receiptId?: string } | null; timedOut: boolean }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('OPERATOR_ALERT_TIMEOUT'));
      reject(new Error('OPERATOR_ALERT_TIMEOUT'));
    }, DELIVERY_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([adapter.deliver(alert, controller.signal), timeout]);
    return { result, timedOut: false };
  } catch (error) {
    return {
      result: null,
      timedOut: controller.signal.aborted
        || (error instanceof Error && /timeout|abort/i.test(error.message)),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function dispatchOperatorAlert(
  input: OperatorAlert,
  adapters: OperatorAlertAdapter[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = Date.now(),
): Promise<OperatorAlertDispatchResult> {
  const rollout = getFeatureRolloutState('OPERATOR_ALERTING', environment);
  if (rollout.mode !== 'ACTIVE') {
    return {
      status: 'SUPPRESSED',
      reasonCode: 'FEATURE_DISABLED',
      deliveries: [],
    };
  }
  const uniqueAdapters = [...new Map(
    adapters.slice(0, 3).map(adapter => {
      const id = safeSegment(adapter.id, 120);
      return [id, { id, deliver: adapter.deliver.bind(adapter) }] as const;
    }),
  ).values()];
  if (!uniqueAdapters.length) {
    return { status: 'SUPPRESSED', reasonCode: 'NO_ADAPTERS', deliveries: [] };
  }
  const alert = normalizeAlert(input);
  const deliveries: OperatorAlertDelivery[] = [];
  let delivered = 0;
  let duplicates = 0;
  for (const adapter of uniqueAdapters) {
    const claimed = await claimDelivery(alert, adapter.id, now);
    if (claimed.duplicate) {
      duplicates += 1;
      deliveries.push(claimed.delivery);
      continue;
    }
    const outcome = await boundedDelivery(adapter, alert);
    const finished = await finishDelivery(claimed.delivery, outcome.result, now, outcome.timedOut);
    deliveries.push(finished);
    if (finished.status === 'DELIVERED') delivered += 1;
  }
  if (delivered > 0) return { status: 'DELIVERED', deliveries };
  if (duplicates === uniqueAdapters.length) {
    return { status: 'DUPLICATE', reasonCode: 'DUPLICATE', deliveries };
  }
  return { status: 'FAILED', reasonCode: 'DELIVERY_FAILED', deliveries };
}
