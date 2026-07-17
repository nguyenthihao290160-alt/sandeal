import type { Product } from '@/lib/types';

export const PUBLIC_SEARCH_RANKING_VERSION = 'public-search-ranking-v2';

export interface PublicSearchScore {
  text: number;
  source: number;
  priceFreshness: number;
  quality: number;
  deal: number;
  health: number;
  freshness: number;
  total: number;
}

export interface RankedPublicProduct {
  product: Product;
  score: PublicSearchScore;
}

export interface PublicSearchSuggestion {
  label: string;
  query: string;
  reason: 'brand' | 'category';
  matchingProducts: number;
}

const PHRASE_ALIASES: Array<[string, string]> = [
  ['may tinh xach tay', 'laptop'],
  ['dien thoai di dong', 'smartphone'],
  ['dien thoai', 'smartphone'],
  ['tai nghe', 'headphone'],
  ['khong day', 'wireless'],
  ['may hut bui', 'vacuum'],
  ['giam gia', 'deal'],
  ['khuyen mai', 'deal'],
];

const TOKEN_ALIASES = new Map<string, string>([
  ['headphones', 'headphone'],
  ['headsets', 'headphone'],
  ['headset', 'headphone'],
  ['earbuds', 'headphone'],
  ['earbud', 'headphone'],
  ['notebook', 'laptop'],
  ['mobile', 'smartphone'],
  ['phone', 'smartphone'],
  ['television', 'tv'],
  ['tivi', 'tv'],
  ['cordless', 'wireless'],
  ['sale', 'deal'],
  ['discount', 'deal'],
]);

const NON_DISCOVERABLE_PRICE_STATES = new Set(['STALE', 'CONFLICTED', 'ANOMALOUS', 'UNAVAILABLE']);
const HEALTHY_STATUSES = new Set(['ok', 'healthy', 'redirect_ok', 'redirected', 'valid', 'available']);

export function normalizePublicSearchText(value: unknown): string {
  let normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[dD]\u0335/g, match => match[0].toLowerCase())
    .replace(/[\u0111\u0110]/g, match => match === '\u0110' ? 'D' : 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [phrase, alias] of PHRASE_ALIASES) {
    normalized = normalized.replace(new RegExp(`\\b${phrase.replace(/ /g, '\\s+')}\\b`, 'g'), alias);
  }
  return normalized.split(' ').filter(Boolean).map(token => TOKEN_ALIASES.get(token) || token).join(' ');
}

function tokens(value: unknown): string[] {
  return [...new Set(normalizePublicSearchText(value).split(' ').filter(Boolean))];
}

function boundedEditDistance(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length];
}

function tokenSimilarity(query: string, candidate: string): number {
  if (query === candidate) return 1;
  if (query.length >= 3 && candidate.startsWith(query)) return 0.84;
  if (candidate.length >= 3 && query.startsWith(candidate)) return 0.76;
  const maximum = Math.min(query.length, candidate.length) >= 7 ? 2 : 1;
  if (Math.min(query.length, candidate.length) < 4) return 0;
  const distance = boundedEditDistance(query, candidate, maximum);
  if (distance > maximum) return 0;
  return distance === 1 ? 0.74 : 0.6;
}

function bestTokenScore(queryToken: string, candidates: string[]): number {
  return candidates.reduce((best, candidate) => Math.max(best, tokenSimilarity(queryToken, candidate)), 0);
}

function textRelevance(product: Product, query: string): number {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return 0;
  const fields = [
    { value: product.title, weight: 1 },
    { value: product.brand, weight: 1.15 },
    { value: product.category, weight: 1.1 },
    { value: product.sku, weight: 0.95 },
    { value: `${product.source} ${product.platform}`, weight: 0.82 },
    { value: (product.tags || []).join(' '), weight: 0.8 },
    { value: Object.values(product.specifications || {}).join(' '), weight: 0.72 },
    { value: product.description, weight: 0.62 },
  ].map(field => ({ tokens: tokens(field.value), weight: field.weight }));
  const matches = queryTokens.map(queryToken => fields.reduce(
    (best, field) => Math.max(best, bestTokenScore(queryToken, field.tokens) * field.weight),
    0,
  ));
  if (matches.some(score => score < 0.42)) return 0;
  const normalizedQuery = normalizePublicSearchText(query);
  const exactTitle = normalizePublicSearchText(product.title).includes(normalizedQuery) ? 0.12 : 0;
  return Math.min(1, matches.reduce((sum, score) => sum + score, 0) / matches.length + exactTitle);
}

function sourceScore(product: Product): number {
  const confidence = Number(product.confidences?.source);
  if (Number.isFinite(confidence)) return Math.max(0, Math.min(1, confidence));
  return product.verifiedSource === true || product.sourceVerified === true ? 0.9 : 0.25;
}

function priceFreshnessScore(product: Product): number {
  if (product.priceTruthState === 'FRESH') return 1;
  if (product.priceTruthState === 'AGING') return 0.65;
  if (!product.priceTruthState) return 0.5;
  return 0;
}

function healthScore(product: Product): number {
  if (product.lifecycleState === 'DEGRADED' || product.lifecycleState === 'RECHECKING' || product.lifecycleState === 'RETRY_SCHEDULED') return 0.25;
  const statuses = [product.linkHealthStatus, product.affiliateHealthStatus, product.imageHealthStatus];
  if (statuses.every(status => HEALTHY_STATUSES.has(String(status || '').toLowerCase()))) return 1;
  const confidence = Number(product.confidences?.health);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.35;
}

function recencyScore(product: Product, now: number): number {
  const timestamp = Date.parse(product.lastSeenAt || product.updatedAt);
  if (!Number.isFinite(timestamp)) return 0;
  const age = Math.max(0, now - timestamp);
  if (age <= 24 * 60 * 60_000) return 1;
  if (age <= 7 * 24 * 60 * 60_000) return 0.8;
  if (age <= 30 * 24 * 60 * 60_000) return 0.5;
  return 0.2;
}

export function isDiscoverableCommerceProduct(product: Product): boolean {
  if (NON_DISCOVERABLE_PRICE_STATES.has(String(product.priceTruthState || ''))) return false;
  if (['QUARANTINED', 'HIDDEN', 'CONFIRMED_BROKEN'].includes(String(product.lifecycleState || ''))) return false;
  return true;
}

export function commerceQualityScore(product: Product, now = Date.now()): number {
  return sourceScore(product) * 0.22
    + priceFreshnessScore(product) * 0.2
    + Math.max(0, Math.min(1, Number(product.qualityScore || 0) / 100)) * 0.18
    + Math.max(0, Math.min(1, Number(product.dealScore || 0) / 100)) * 0.14
    + healthScore(product) * 0.16
    + recencyScore(product, now) * 0.1;
}

export function rankPublicSearchProducts(products: Product[], query: string, now = Date.now()): RankedPublicProduct[] {
  return products
    .filter(isDiscoverableCommerceProduct)
    .map(product => {
      const text = textRelevance(product, query);
      const score: PublicSearchScore = {
        text,
        source: sourceScore(product),
        priceFreshness: priceFreshnessScore(product),
        quality: Math.max(0, Math.min(1, Number(product.qualityScore || 0) / 100)),
        deal: Math.max(0, Math.min(1, Number(product.dealScore || 0) / 100)),
        health: healthScore(product),
        freshness: recencyScore(product, now),
        total: 0,
      };
      score.total = Math.round((score.text * 0.6 + commerceQualityScore(product, now) * 0.4) * 10_000) / 100;
      return { product, score };
    })
    .filter(item => item.score.text > 0)
    .sort((left, right) => right.score.total - left.score.total
      || Date.parse(right.product.updatedAt) - Date.parse(left.product.updatedAt)
      || left.product.id.localeCompare(right.product.id));
}

export function buildZeroResultSuggestions(products: Product[], query: string, limit = 5): PublicSearchSuggestion[] {
  const eligible = products.filter(isDiscoverableCommerceProduct);
  const candidates = new Map<string, PublicSearchSuggestion>();
  for (const product of eligible) {
    for (const [reason, value] of [['brand', product.brand], ['category', product.category]] as const) {
      const label = String(value || '').trim();
      if (!label) continue;
      const key = `${reason}:${normalizePublicSearchText(label)}`;
      const existing = candidates.get(key);
      if (existing) existing.matchingProducts += 1;
      else candidates.set(key, { label, query: label, reason, matchingProducts: 1 });
    }
  }
  const queryTokens = tokens(query);
  return [...candidates.values()]
    .map(item => ({
      item,
      similarity: queryTokens.reduce((best, token) => Math.max(best, bestTokenScore(token, tokens(item.label))), 0),
    }))
    .sort((left, right) => right.similarity - left.similarity
      || right.item.matchingProducts - left.item.matchingProducts
      || left.item.label.localeCompare(right.item.label, 'vi'))
    .slice(0, Math.max(0, Math.min(10, limit)))
    .map(({ item }) => item);
}
