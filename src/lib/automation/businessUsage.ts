import { readCollection, runTransaction } from '@/lib/storage/adapter';
import { vietnamDayKey } from './timezone';

const COLLECTION = 'pipeline-daily-usage';
const RESERVATION_TTL_MS = 30 * 60_000;

export interface ProductProcessingReservation {
  units: number;
  reservedAt: string;
}

export interface DailyBusinessUsage {
  id: string;
  sourceRequests: number;
  candidatesFound: number;
  candidatesQueued: number;
  networkChecks: number;
  productsReviewed: number;
  productsPublished: number;
  productReservations?: Record<string, ProductProcessingReservation>;
  processedProductKeys?: string[];
  updatedAt: string;
}

function emptyUsage(now: number): DailyBusinessUsage {
  const id = vietnamDayKey(now);
  return {
    id,
    sourceRequests: 0,
    candidatesFound: 0,
    candidatesQueued: 0,
    networkChecks: 0,
    productsReviewed: 0,
    productsPublished: 0,
    productReservations: {},
    processedProductKeys: [],
    updatedAt: new Date(now).toISOString(),
  };
}

function normalizeUsage(input: DailyBusinessUsage | undefined, now: number): DailyBusinessUsage {
  const base = emptyUsage(now);
  return input ? {
    ...base,
    ...input,
    productReservations: { ...(input.productReservations || {}) },
    processedProductKeys: [...(input.processedProductKeys || [])],
  } : base;
}

function removeExpiredReservations(usage: DailyBusinessUsage, now: number): void {
  for (const [key, reservation] of Object.entries(usage.productReservations || {})) {
    const reservedAt = Date.parse(reservation.reservedAt);
    if (!Number.isFinite(reservedAt) || now - reservedAt > RESERVATION_TTL_MS) delete usage.productReservations![key];
  }
}

function reservedUnits(usage: DailyBusinessUsage): number {
  return Object.values(usage.productReservations || {}).reduce((total, item) => total + Math.max(0, item.units), 0);
}

export async function getDailyBusinessUsage(now = Date.now()): Promise<DailyBusinessUsage> {
  const day = vietnamDayKey(now);
  const stored = (await readCollection<DailyBusinessUsage>(COLLECTION)).find(item => item.id === day);
  const usage = normalizeUsage(stored, now);
  removeExpiredReservations(usage, now);
  return usage;
}

export async function getProductProcessingCapacity(limit: number, now = Date.now()): Promise<{
  day: string;
  processed: number;
  reserved: number;
  limit: number;
  remaining: number;
}> {
  const usage = await getDailyBusinessUsage(now);
  const reserved = reservedUnits(usage);
  return {
    day: usage.id,
    processed: usage.productsReviewed,
    reserved,
    limit,
    remaining: Math.max(0, limit - usage.productsReviewed - reserved),
  };
}

export async function reserveProductProcessingCapacity(
  key: string,
  requestedUnits: number,
  limit: number,
  now = Date.now(),
): Promise<{ allowed: boolean; units: number; alreadyProcessed: boolean; remaining: number }> {
  const day = vietnamDayKey(now);
  const safeRequested = Math.max(0, Math.floor(requestedUnits));
  let result = { allowed: false, units: 0, alreadyProcessed: false, remaining: 0 };
  await runTransaction<DailyBusinessUsage>(COLLECTION, items => {
    const usage = normalizeUsage(items.find(item => item.id === day), now);
    removeExpiredReservations(usage, now);
    const alreadyProcessed = usage.processedProductKeys?.includes(key) === true;
    const existing = usage.productReservations?.[key];
    const available = Math.max(0, limit - usage.productsReviewed - reservedUnits(usage));
    if (alreadyProcessed) {
      result = { allowed: true, units: 0, alreadyProcessed: true, remaining: available };
    } else if (existing) {
      result = { allowed: true, units: existing.units, alreadyProcessed: false, remaining: available };
    } else {
      const units = Math.min(safeRequested, available);
      if (units > 0) {
        usage.productReservations![key] = { units, reservedAt: new Date(now).toISOString() };
        usage.updatedAt = new Date(now).toISOString();
      }
      result = { allowed: units === safeRequested && safeRequested > 0, units, alreadyProcessed: false, remaining: Math.max(0, available - units) };
    }
    const retained = items.filter(item => item.id !== day).slice(-6);
    return [...retained, usage];
  });
  return result;
}

export async function commitProductProcessingCapacity(key: string, processedUnits: number, now = Date.now()): Promise<DailyBusinessUsage> {
  const day = vietnamDayKey(now);
  let result = emptyUsage(now);
  await runTransaction<DailyBusinessUsage>(COLLECTION, items => {
    const usage = normalizeUsage(items.find(item => item.id === day), now);
    removeExpiredReservations(usage, now);
    if (!usage.processedProductKeys!.includes(key)) {
      const reserved = usage.productReservations?.[key]?.units || 0;
      const committed = Math.min(reserved, Math.max(0, Math.floor(processedUnits)));
      usage.productsReviewed += committed;
      usage.processedProductKeys = [...usage.processedProductKeys!.slice(-999), key];
    }
    delete usage.productReservations![key];
    usage.updatedAt = new Date(now).toISOString();
    result = { ...usage, productReservations: { ...usage.productReservations }, processedProductKeys: [...usage.processedProductKeys!] };
    return [...items.filter(item => item.id !== day).slice(-6), usage];
  });
  return result;
}

export async function releaseProductProcessingCapacity(key: string, now = Date.now()): Promise<void> {
  const day = vietnamDayKey(now);
  await runTransaction<DailyBusinessUsage>(COLLECTION, items => {
    const stored = items.find(item => item.id === day);
    if (!stored?.productReservations?.[key]) return undefined;
    delete stored.productReservations[key];
    stored.updatedAt = new Date(now).toISOString();
    return items;
  });
}

export async function recordPipelineUsageMetrics(input: {
  sourceRequests: number;
  candidatesFound: number;
  candidatesQueued: number;
  networkChecks: number;
  productsPublished: number;
}, now = Date.now()): Promise<void> {
  const day = vietnamDayKey(now);
  await runTransaction<DailyBusinessUsage>(COLLECTION, items => {
    const usage = normalizeUsage(items.find(item => item.id === day), now);
    usage.sourceRequests += Math.max(0, input.sourceRequests);
    usage.candidatesFound += Math.max(0, input.candidatesFound);
    usage.candidatesQueued += Math.max(0, input.candidatesQueued);
    usage.networkChecks += Math.max(0, input.networkChecks);
    usage.productsPublished += Math.max(0, input.productsPublished);
    usage.updatedAt = new Date(now).toISOString();
    return [...items.filter(item => item.id !== day).slice(-6), usage];
  });
}
