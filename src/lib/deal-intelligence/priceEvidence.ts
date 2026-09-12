import type { Product } from '../types';
import type { PriceSnapshot } from '../product-intelligence/types';
import { DEAL_CONFIG, boundedScore, unitConfidence, type DealConfig } from './config';
import type { DealFreshness, DealPriceEvidence } from './types';

export function evidenceTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}
export function freshness(value: unknown, now: number, config: DealConfig = DEAL_CONFIG): DealFreshness {
  const time = evidenceTime(value);
  if (time === undefined || time > now) return 'UNKNOWN';
  return now - time <= config.freshness.freshMs ? 'FRESH' : now - time <= config.freshness.staleMs ? 'AGING' : 'STALE';
}
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function validPrice(value: unknown, config: DealConfig = DEAL_CONFIG): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= config.limits.amount;
}
export function priceEvidence(product: Product, history: PriceSnapshot[], now: number, config: DealConfig = DEAL_CONFIG): DealPriceEvidence {
  const reasons: string[] = [], risks: string[] = [];
  const current = product.salePrice ?? product.price;
  const priceValid = validPrice(current, config) && product.currency === config.currency;
  if (!priceValid) risks.push('INVALID_CURRENT_PRICE_OR_CURRENCY');
  if (history.length > config.limits.samples) risks.push('PRICE_HISTORY_TRUNCATED');
  const rows = history.slice(0, config.limits.samples).map(row => ({ row, time: evidenceTime(row.capturedAt), price: row.salePrice ?? row.price }));
  const valid = rows.filter(item => item.row.productId === product.id && item.row.currency === config.currency
    && validPrice(item.price, config) && item.time !== undefined && item.time <= now
    && item.time >= now - config.windows.referenceDays * Number(config.dayMs) && item.row.availability === 'available');
  let invalidSamples = rows.length - valid.length;
  if (invalidSamples) risks.push('INVALID_HISTORICAL_SAMPLE');
  const timestamps = new Map<number, typeof valid>();
  for (const item of valid) timestamps.set(item.time!, [...(timestamps.get(item.time!) || []), item]);
  const unique = [...timestamps.values()].flatMap(items => {
    if (items.length > 1) reasons.push('DUPLICATE_TIMESTAMP_COLLAPSED');
    if (new Set(items.map(item => item.price)).size > 1) { invalidSamples += items.length; risks.push('CONFLICTING_PRICE_TIMESTAMP'); return []; }
    return [items.sort((left, right) => left.row.id.localeCompare(right.row.id))[0]];
  }).sort((left, right) => right.time! - left.time!);
  const days = new Map<string, typeof unique[number]>();
  for (const item of unique) if (!days.has(item.row.capturedAt.slice(0, 10))) days.set(item.row.capturedAt.slice(0, 10), item);
  const daily = [...days.values()];
  const center = daily.length ? median(daily.map(item => item.price!)) : undefined;
  const robust = daily.filter(item => center === undefined || (item.price! <= center * config.history.outlierRatio && item.price! >= center / config.history.outlierRatio));
  if (robust.length < daily.length) { risks.push('HISTORICAL_OUTLIER_EXCLUDED'); invalidSamples += daily.length - robust.length; }
  const observed = unique[0];
  const matching = priceValid && observed?.price === current;
  if (!matching) risks.push('CURRENT_PRICE_NOT_OBSERVED');
  const observedAt = matching ? observed?.row.capturedAt : undefined;
  const state = freshness(observedAt, now, config);
  if (state === 'STALE') risks.push('STALE_PRICE');
  if (state === 'UNKNOWN') risks.push('PRICE_EVIDENCE_UNKNOWN');
  if (state === 'FRESH') reasons.push('FRESH_PRICE');
  if (state === 'AGING') reasons.push('PRICE_EVIDENCE_AGING');
  const sampleCount = robust.length;
  const coverage = sampleCount > 1 ? (robust[0].time! - robust.at(-1)!.time!) / Number(config.dayMs) : 0;
  const historyConfidence = unitConfidence(Math.min(1, sampleCount / config.history.strongSamples)
    * Math.min(1, coverage / config.history.strongDays) * (valid.length ? Math.max(0, 1 - invalidSamples / rows.length) : 0)
    * (history.length > config.limits.samples ? config.confidence.limitedCap : 1));
  reasons.push(historyConfidence >= config.confidence.high ? 'STRONG_HISTORY_COVERAGE' : 'INSUFFICIENT_PRICE_HISTORY');
  const values = robust.map(item => item.price!);
  const low = sampleCount ? Math.min(...values) : undefined;
  const reference = sampleCount >= 2 ? median(values) : undefined;
  const difference = priceValid && reference ? (reference - current) / reference : undefined;
  const nominal = product.salePrice !== undefined && validPrice(product.price, config) && priceValid
    ? (product.price - current) / product.price : undefined;
  if (nominal !== undefined && nominal < 0) risks.push('LIST_PRICE_BELOW_CURRENT');
  const verifiedList = nominal !== undefined && nominal > 0 && reference !== undefined && historyConfidence >= config.confidence.high
    && Math.abs(product.price! - reference) / reference <= config.history.verifiedListTolerance;
  if (nominal !== undefined && nominal > 0) {
    if (verifiedList) reasons.push('DISCOUNT_VERIFIED');
    else { reasons.push(reference ? 'DISCOUNT_PARTIALLY_VERIFIED' : 'DISCOUNT_LIST_PRICE_ONLY'); risks.push('UNVERIFIED_LIST_DISCOUNT'); }
  }
  if (difference !== undefined) reasons.push(difference > 0 ? 'BELOW_RECENT_MEDIAN' : difference < 0 ? 'ABOVE_RECENT_MEDIAN' : 'AT_RECENT_MEDIAN');
  if (difference !== undefined && difference < 0) risks.push('PRICE_ABOVE_REFERENCE');
  const nearLow = priceValid && low !== undefined && current <= low * config.history.nearLowRatio;
  if (nearLow) reasons.push('NEAR_HISTORICAL_LOW');
  const priceScore = difference === undefined ? 0 : boundedScore(config.points.priceBaseline
    + Math.max(-1, Math.min(1, difference / config.history.strongDiscount)) * config.points.priceDiscount + (nearLow ? config.points.nearLow : 0));
  const previousDifferent = matching ? unique.find(item => item.price !== current) : undefined;
  const change = previousDifferent ? unique[unique.indexOf(previousDifferent) - 1]?.row.capturedAt : undefined;
  const windowLow = (window: number) => { const prices = robust.filter(item => item.time! >= now - window * Number(config.dayMs)).map(item => item.price!); return prices.length ? Math.min(...prices) : undefined; };
  return { currentPrice: priceValid ? current : undefined, currency: priceValid ? product.currency : undefined, observedAt,
    priceFreshness: state, historicalLow: low, historicalMaximum: sampleCount ? Math.max(...values) : undefined,
    historicalMedian: reference, historicalSampleCount: sampleCount, historicalCoverageDays: coverage,
    shortLow: windowLow(config.windows.shortDays), mediumLow: windowLow(config.windows.mediumDays),
    referencePrice: reference, referencePriceSource: reference === undefined ? undefined : 'OBSERVED_30D_MEDIAN',
    distanceFromLowPercent: priceValid && low ? (current - low) / low * 100 : undefined,
    distanceFromMedianPercent: difference === undefined ? undefined : -difference * 100,
    lastObservedChangeAt: change, nominalDiscountPercent: nominal === undefined ? undefined : Math.max(0, nominal * 100),
    discountPercent: difference === undefined ? undefined : Math.max(0, difference * 100), discountConfidence: reference ? historyConfidence : 0,
    historyConfidence, priceQualityScore: priceScore, invalidSamples, reasons: [...new Set(reasons)].sort(), risks: [...new Set(risks)].sort() };
}
