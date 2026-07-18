import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { getAllProducts } from '@/lib/storage/products';
import { summarizeRevenueIntegrity } from '@/lib/autonomous/revenueIntegrity';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type { GrowthDaily, OutboundEvent } from './types';

const EVENTS = 'outbound-events';
const DAILY = 'growth-daily';

function dayInVietnam(value: string | number | Date): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return new Date(timestamp + 7 * 60 * 60_000).toISOString().slice(0, 10);
}

export async function recordGrowthEvent(
  input: Omit<OutboundEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: string },
): Promise<OutboundEvent> {
  const requestedId = typeof input.id === 'string' && /^[a-zA-Z0-9:_-]{8,160}$/.test(input.id)
    ? input.id
    : generateId();
  const event: OutboundEvent = {
    ...input,
    id: requestedId,
    productId: input.productId?.slice(0, 160),
    source: input.source?.slice(0, 120),
    campaign: input.campaign?.slice(0, 160),
    contentPageId: input.contentPageId?.slice(0, 160),
    contextKey: input.contextKey && /^[a-z0-9:_-]{1,120}$/i.test(input.contextKey) ? input.contextKey : undefined,
    resultCount: Number.isSafeInteger(input.resultCount) && Number(input.resultCount) >= 0 && Number(input.resultCount) <= 50
      ? Number(input.resultCount)
      : undefined,
    anonymousSessionId: input.anonymousSessionId && /^[a-zA-Z0-9:_-]{8,80}$/.test(input.anonymousSessionId)
      ? input.anonymousSessionId
      : undefined,
    timestamp: input.timestamp && Number.isFinite(Date.parse(input.timestamp)) ? input.timestamp : new Date().toISOString(),
  };
  let stored = event;
  await runTransaction<OutboundEvent>(EVENTS, items => {
    const existing = items.find(item => item.id === event.id);
    if (existing) {
      stored = existing;
      return undefined;
    }
    const cutoff = Date.now() - CONFIG.retention.outboundEventDays * 86_400_000;
    return [...items.filter(item => Date.parse(item.timestamp) >= cutoff), event].slice(-CONFIG.limits.outboundEvents);
  });
  return stored;
}

export async function listOutboundEvents(): Promise<OutboundEvent[]> {
  return readCollection<OutboundEvent>(EVENTS);
}

export async function aggregateGrowthMetrics(now = Date.now()): Promise<{ days: number; events: number }> {
  const events = await listOutboundEvents();
  const grouped = new Map<string, OutboundEvent[]>();
  for (const event of events) grouped.set(dayInVietnam(event.timestamp), [...(grouped.get(dayInVietnam(event.timestamp)) || []), event]);
  const daily: GrowthDaily[] = [...grouped.entries()].map(([day, dayEvents]) => {
    const listViews = dayEvents.filter(event => event.eventType === 'PRODUCT_CARD_VIEW').length;
    const detailViews = dayEvents.filter(event => event.eventType === 'view' || event.eventType === 'PRODUCT_DETAIL_VIEW').length;
    const outboundClicks = dayEvents.filter(event => event.eventType === 'click' || event.eventType === 'OUTBOUND_CLICK').length;
    const views = detailViews;
    const clicks = outboundClicks;
    const productClicks: Record<string, number> = {};
    const sourceClicks: Record<string, number> = {};
    const contentClicks: Record<string, number> = {};
    for (const event of dayEvents.filter(item => item.eventType === 'click' || item.eventType === 'OUTBOUND_CLICK')) {
      if (event.productId) productClicks[event.productId] = (productClicks[event.productId] || 0) + 1;
      if (event.source) sourceClicks[event.source] = (sourceClicks[event.source] || 0) + 1;
      if (event.contentPageId) contentClicks[event.contentPageId] = (contentClicks[event.contentPageId] || 0) + 1;
    }
    return {
      id: day, day, views, clicks, ctr: views > 0 ? Math.round((clicks / views) * 10_000) / 100 : undefined,
      listViews,
      detailViews,
      outboundClicks,
      searches: dayEvents.filter(event => event.eventType === 'PUBLIC_SEARCH').length,
      noResultSearches: dayEvents.filter(event => event.eventType === 'SEARCH_NO_RESULT').length,
      compareOpens: dayEvents.filter(event => event.eventType === 'COMPARE_OPEN').length,
      productClicks, sourceClicks, contentClicks, updatedAt: new Date(now).toISOString(),
    };
  }).sort((a, b) => a.day.localeCompare(b.day));
  const cutoffDay = dayInVietnam(now - CONFIG.retention.growthDailyDays * 86_400_000);
  await runTransaction<GrowthDaily>(DAILY, () => daily.filter(item => item.day >= cutoffDay).slice(-CONFIG.retention.growthDailyDays));
  return { days: daily.length, events: events.length };
}

function totals(recordMaps: Array<Record<string, number>>): Array<{ key: string; value: number }> {
  const output: Record<string, number> = {};
  for (const record of recordMaps) for (const [key, value] of Object.entries(record)) output[key] = (output[key] || 0) + value;
  return Object.entries(output).map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

export async function getGrowthSummary(days = 30) {
  const safeDays = Math.max(1, Math.min(days, 365));
  const now = Date.now();
  const cutoffTime = now - safeDays * 86_400_000;
  const cutoff = dayInVietnam(now - (safeDays - 1) * 86_400_000);
  const [storedDaily, events, products] = await Promise.all([
    readCollection<GrowthDaily>(DAILY),
    listOutboundEvents(),
    getAllProducts(),
  ]);
  const daily = storedDaily.filter(item => item.day >= cutoff).sort((a, b) => a.day.localeCompare(b.day));
  const views = daily.reduce((sum, item) => sum + item.views, 0);
  const clicks = daily.reduce((sum, item) => sum + item.clicks, 0);
  const listViews = daily.reduce((sum, item) => sum + (item.listViews || 0), 0);
  const detailViews = daily.reduce((sum, item) => sum + (item.detailViews ?? item.views), 0);
  const outboundClicks = daily.reduce((sum, item) => sum + (item.outboundClicks ?? item.clicks), 0);
  return {
    rangeDays: safeDays,
    views,
    clicks,
    ctr: views > 0 ? Math.round((clicks / views) * 10_000) / 100 : undefined,
    funnel: {
      listViews,
      detailViews,
      outboundClicks,
      listToDetailRate: listViews > 0 ? Math.round((detailViews / listViews) * 10_000) / 100 : undefined,
      detailToOutboundRate: detailViews > 0 ? Math.round((outboundClicks / detailViews) * 10_000) / 100 : undefined,
    },
    trend: daily.map(item => ({ day: item.day, views: item.views, clicks: item.clicks, ctr: item.ctr })),
    topProducts: totals(daily.map(item => item.productClicks)).slice(0, 10),
    topSources: totals(daily.map(item => item.sourceClicks)).slice(0, 10),
    topContent: totals(daily.map(item => item.contentClicks)).slice(0, 10),
    revenueIntegrity: summarizeRevenueIntegrity({ products, events, cutoff: cutoffTime, now }),
    revenueAvailable: false,
  };
}

export function classifyReferrer(value: string | null, siteHost?: string): OutboundEvent['referrerCategory'] {
  if (!value) return 'direct';
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (siteHost && host === siteHost.toLowerCase()) return 'internal';
    if (/google|bing|yahoo|duckduckgo/.test(host)) return 'search';
    if (/facebook|instagram|tiktok|youtube|threads|x\.com|twitter/.test(host)) return 'social';
    return 'other';
  } catch { return 'other'; }
}

export function classifyDevice(userAgent: string | null): OutboundEvent['deviceCategory'] {
  const value = String(userAgent || '').toLowerCase();
  if (!value) return 'other';
  if (/ipad|tablet/.test(value)) return 'tablet';
  if (/mobile|android|iphone/.test(value)) return 'mobile';
  return 'desktop';
}
