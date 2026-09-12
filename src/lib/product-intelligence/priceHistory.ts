import { createHash } from 'crypto';
import type { Product } from '@/lib/types';
import { generateId } from '@/lib/storage/adapter';
import { getDomainStorage } from '@/lib/storage/storageFactory';
import { DomainStorageError, type DomainStorage, type PriceHistoryQuery } from '@/lib/storage/domainStorage';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type { PriceSnapshot, PriceStatistics } from './types';

function effectivePrice(snapshot: Pick<PriceSnapshot, 'price' | 'salePrice'>): number | undefined {
  const value = Number(snapshot.salePrice || snapshot.price || 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function snapshotHash(product: Partial<Product>): string {
  return createHash('sha256').update(JSON.stringify({
    source: product.source || 'other',
    price: Number(product.price || 0),
    salePrice: Number(product.salePrice || 0),
    currency: product.currency || 'VND',
    availability: product.availability || 'unknown',
  })).digest('hex');
}

export async function capturePriceSnapshot(
  product: Product,
  operationId: string,
  options: { forceCheckpoint?: boolean; capturedAt?: string } = {},
  storage: DomainStorage = getDomainStorage(),
): Promise<{ created: boolean; priceChanged: boolean; snapshot?: PriceSnapshot; reason?: string }> {
  const capturedAt = options.capturedAt || new Date().toISOString();
  if (!Number(product.price || product.salePrice || 0)) return { created: false, priceChanged: false, reason: 'missing_price' };
  const sourceHash = snapshotHash(product);
  const snapshot: PriceSnapshot = {
    id: generateId(),
    productId: product.id,
    source: product.source,
    price: product.price,
    salePrice: product.salePrice,
    currency: 'VND',
    availability: product.availability || 'unknown',
    capturedAt,
    operationId: operationId.slice(0, 160),
    sourceHash,
  };
  // The adapter compares and appends inside its own commit boundary. Separating
  // a latest-value read from an append here would admit duplicate concurrent writes.
  const result = await storage.appendPriceSnapshot(snapshot, {
    forceCheckpoint: options.forceCheckpoint === true,
    checkpointHours: CONFIG.cooldown.priceCheckpointHours,
  });
  if (!result.created) return { created: false, priceChanged: false, reason: 'unchanged' };
  const previousPrice = result.previous ? effectivePrice(result.previous) : undefined;
  const nextPrice = effectivePrice(snapshot);
  const priceChanged = previousPrice !== undefined && nextPrice !== undefined && previousPrice !== nextPrice;
  return { created: true, priceChanged, snapshot: result.snapshot || snapshot };
}

function historyLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new DomainStorageError('DOMAIN_QUERY_LIMIT_INVALID');
  return Math.max(1, Math.min(Math.trunc(limit), CONFIG.limits.priceSnapshotsPerProduct));
}

export async function listPriceHistory(
  productId: string,
  limit = 365,
  storage: DomainStorage = getDomainStorage(),
  before?: PriceHistoryQuery['before'],
): Promise<PriceSnapshot[]> {
  return storage.getPriceHistory({ productId, limit: historyLimit(limit), ...(before ? { before } : {}) });
}

export async function listPriceHistories(
  productIds: string[],
  limitPerProduct = 365,
  storage: DomainStorage = getDomainStorage(),
): Promise<Map<string, PriceSnapshot[]>> {
  const ids = new Set(productIds.map(String).filter(Boolean).slice(0, 2_000));
  const limit = historyLimit(limitPerProduct);
  const grouped = new Map<string, PriceSnapshot[]>();
  if (!ids.size) return grouped;
  for (const productId of ids) {
    const snapshots = await storage.getPriceHistory({ productId, limit });
    if (snapshots.length) grouped.set(productId, snapshots);
  }
  return grouped;
}

export function calculatePriceStatistics(productId: string, snapshots: PriceSnapshot[]): PriceStatistics {
  const sorted = snapshots.filter(item => item.productId === productId && effectivePrice(item))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const prices = sorted.map(item => effectivePrice(item)!).filter(Number.isFinite);
  if (!prices.length) return { productId, changeCount: 0, trackingDays: 0, snapshots: 0 };
  let changeCount = 0;
  for (let index = 1; index < prices.length; index += 1) {
    if (prices[index] !== prices[index - 1]) changeCount += 1;
  }
  const current = prices[prices.length - 1];
  const previousDifferent = [...prices.slice(0, -1)].reverse().find(value => value !== current);
  const lastChange = previousDifferent === undefined ? 0 : current - previousDifferent;
  const trackingDays = sorted.length < 2 ? 0
    : Math.max(0, Math.ceil((Date.parse(sorted[sorted.length - 1].capturedAt) - Date.parse(sorted[0].capturedAt)) / 86_400_000));
  return {
    productId,
    current,
    lowest: Math.min(...prices),
    highest: Math.max(...prices),
    average: Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length),
    lastChange,
    lastChangePercent: previousDifferent ? Math.round((lastChange / previousDifferent) * 10_000) / 100 : 0,
    changeCount,
    trackingDays,
    snapshots: sorted.length,
  };
}

export async function getPriceStatistics(productId: string, storage: DomainStorage = getDomainStorage()): Promise<PriceStatistics> {
  return calculatePriceStatistics(productId, await listPriceHistory(productId, 365, storage));
}
