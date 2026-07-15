import { createHash } from 'crypto';
import type { Product } from '@/lib/types';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type { PriceSnapshot, PriceStatistics } from './types';

const COLLECTION = 'price-history';

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
): Promise<{ created: boolean; priceChanged: boolean; snapshot?: PriceSnapshot; reason?: string }> {
  const capturedAt = options.capturedAt || new Date().toISOString();
  if (!Number(product.price || product.salePrice || 0)) return { created: false, priceChanged: false, reason: 'missing_price' };
  const sourceHash = snapshotHash(product);
  let response: { created: boolean; priceChanged: boolean; snapshot?: PriceSnapshot; reason?: string } = { created: false, priceChanged: false };
  await runTransaction<PriceSnapshot>(COLLECTION, items => {
    const existing = items.filter(item => item.productId === product.id)
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
    const checkpointElapsed = !existing || Date.parse(capturedAt) - Date.parse(existing.capturedAt)
      >= CONFIG.cooldown.priceCheckpointHours * 60 * 60_000;
    if (existing?.sourceHash === sourceHash && !(options.forceCheckpoint && checkpointElapsed)) {
      response = { created: false, priceChanged: false, reason: 'unchanged' };
      return undefined;
    }
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
    const previousPrice = existing ? effectivePrice(existing) : undefined;
    const nextPrice = effectivePrice(snapshot);
    const priceChanged = previousPrice !== undefined && nextPrice !== undefined && previousPrice !== nextPrice;
    const cutoff = Date.parse(capturedAt) - CONFIG.retention.priceHistoryDays * 86_400_000;
    let next = items.filter(item => Date.parse(item.capturedAt) >= cutoff);
    next.push(snapshot);
    const grouped = new Map<string, PriceSnapshot[]>();
    for (const item of next) grouped.set(item.productId, [...(grouped.get(item.productId) || []), item]);
    next = [...grouped.values()].flatMap(group => group
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
      .slice(0, CONFIG.limits.priceSnapshotsPerProduct));
    next.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    response = { created: true, priceChanged, snapshot };
    return next.slice(-CONFIG.limits.collectionRecords);
  });
  return response;
}

export async function listPriceHistory(productId: string, limit = 365): Promise<PriceSnapshot[]> {
  return (await readCollection<PriceSnapshot>(COLLECTION))
    .filter(item => item.productId === productId)
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
    .slice(-Math.max(1, Math.min(limit, CONFIG.limits.priceSnapshotsPerProduct)));
}

export async function listPriceHistories(
  productIds: string[],
  limitPerProduct = 365,
): Promise<Map<string, PriceSnapshot[]>> {
  const ids = new Set(productIds.map(String).filter(Boolean).slice(0, 2_000));
  const limit = Math.max(1, Math.min(limitPerProduct, CONFIG.limits.priceSnapshotsPerProduct));
  const grouped = new Map<string, PriceSnapshot[]>();
  if (!ids.size) return grouped;
  for (const snapshot of await readCollection<PriceSnapshot>(COLLECTION)) {
    if (!ids.has(snapshot.productId)) continue;
    grouped.set(snapshot.productId, [...(grouped.get(snapshot.productId) || []), snapshot]);
  }
  for (const [productId, snapshots] of grouped) {
    grouped.set(productId, snapshots
      .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
      .slice(-limit));
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

export async function getPriceStatistics(productId: string): Promise<PriceStatistics> {
  return calculatePriceStatistics(productId, await listPriceHistory(productId));
}
