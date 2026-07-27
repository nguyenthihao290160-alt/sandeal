import { createHash } from 'crypto';

import { validateExternalUrl } from './urlSafety';

export const DETERMINISTIC_EXTRACTION_SCHEMA_VERSION = 1;
export const DETERMINISTIC_EXTRACTION_RULE_VERSION = 'deterministic-product-extraction-v1';

const MAX_HTML_BYTES = 512 * 1024;
const MAX_JSON_LD_BYTES = 128 * 1024;
const MAX_JSON_LD_SCRIPTS = 16;
const MAX_JSON_NODES = 256;
const MAX_JSON_DEPTH = 8;
const MAX_TEXT = 4_096;
const MAX_LIST_ITEMS = 12;

export type DeterministicExtractionSource =
  | 'JSON_LD_PRODUCT'
  | 'OPEN_GRAPH'
  | 'HTML_META';

export interface DeterministicFieldProvenance {
  source: DeterministicExtractionSource;
  sourceField: string;
  sourceUrl: string;
  extractedAt: string;
  confidence: number;
  valueHash: string;
}

export interface DeterministicExtractedField<T> {
  value: T;
  provenance: DeterministicFieldProvenance;
}

export interface DeterministicProductExtraction {
  schemaVersion: number;
  ruleVersion: string;
  sourceUrl: string;
  sourceHash: string;
  extractedAt: string;
  title?: DeterministicExtractedField<string>;
  description?: DeterministicExtractedField<string>;
  canonicalUrl?: DeterministicExtractedField<string>;
  images: Array<DeterministicExtractedField<string>>;
  price?: DeterministicExtractedField<number>;
  currency?: DeterministicExtractedField<string>;
  brand?: DeterministicExtractedField<string>;
  sku?: DeterministicExtractedField<string>;
  category?: DeterministicExtractedField<string>;
  warnings: string[];
}

type JsonRecord = Record<string, unknown>;

function hash(value: unknown): string {
  return createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).digest('hex');
}

function boundedText(value: unknown, maximum = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = decodeHtmlEntities(value)
    .replace(/<[^>]{0,2_048}>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
    if (token[0] !== '#') return named[token.toLowerCase()] ?? entity;
    const hexadecimal = token[1]?.toLowerCase() === 'x';
    const numeric = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 0x10ffff) return '';
    try {
      return String.fromCodePoint(numeric);
    } catch {
      return '';
    }
  });
}

function parseAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(input)) !== null && Object.keys(result).length < 32) {
    const key = match[1].toLowerCase();
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '').slice(0, MAX_TEXT);
  }
  return result;
}

function metaValues(html: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const expression = /<meta\b([^>]{0,4096})>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = expression.exec(html)) !== null && count < 256) {
    count += 1;
    const attributes = parseAttributes(match[1]);
    const key = (attributes.property || attributes.name || attributes.itemprop || '').toLowerCase();
    const content = boundedText(attributes.content);
    if (!key || !content) continue;
    values.set(key, [...(values.get(key) || []), content].slice(0, MAX_LIST_ITEMS));
  }
  return values;
}

function canonicalLink(html: string): string | undefined {
  const expression = /<link\b([^>]{0,4096})>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = expression.exec(html)) !== null && count < 128) {
    count += 1;
    const attributes = parseAttributes(match[1]);
    const relations = String(attributes.rel || '').toLowerCase().split(/\s+/);
    if (relations.includes('canonical')) return attributes.href;
  }
  return undefined;
}

function titleElement(html: string): string | undefined {
  const match = html.match(/<title\b[^>]{0,2048}>([\s\S]{0,8192}?)<\/title>/i);
  return boundedText(match?.[1], 240);
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function productType(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => (
    typeof type === 'string'
    && type.toLowerCase().split(/[\/#]/).pop() === 'product'
  ));
}

function collectJsonLdProducts(value: unknown): JsonRecord[] {
  const products: JsonRecord[] = [];
  const seen = new Set<unknown>();
  let visited = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH || visited >= MAX_JSON_NODES || seen.has(candidate)) return;
    if (!candidate || typeof candidate !== 'object') return;
    seen.add(candidate);
    visited += 1;
    if (Array.isArray(candidate)) {
      for (const item of candidate.slice(0, 64)) visit(item, depth + 1);
      return;
    }
    const record = candidate as JsonRecord;
    if (productType(record['@type'])) products.push(record);
    for (const [key, child] of Object.entries(record).slice(0, 64)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (key === '@graph' || key === 'mainEntity' || key === 'itemListElement') {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return products.slice(0, 16);
}

function parseJsonLdProducts(html: string, warnings: Set<string>): JsonRecord[] {
  const products: JsonRecord[] = [];
  const expression = /<script\b([^>]{0,4096})>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let scripts = 0;
  while ((match = expression.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (String(attributes.type || '').toLowerCase().split(';')[0].trim() !== 'application/ld+json') {
      continue;
    }
    scripts += 1;
    if (scripts > MAX_JSON_LD_SCRIPTS) {
      warnings.add('JSON_LD_SCRIPT_LIMIT_REACHED');
      continue;
    }
    const body = match[2].trim();
    if (Buffer.byteLength(body, 'utf8') > MAX_JSON_LD_BYTES) {
      warnings.add('JSON_LD_SCRIPT_TOO_LARGE');
      continue;
    }
    try {
      products.push(...collectJsonLdProducts(JSON.parse(body)));
    } catch {
      warnings.add('JSON_LD_INVALID');
    }
  }
  return products.slice(0, 16);
}

function resolveExternalUrl(value: unknown, sourceUrl: string): string | undefined {
  const text = boundedText(value, 2_048);
  if (!text) return undefined;
  try {
    const resolved = new URL(text, sourceUrl).toString();
    const validation = validateExternalUrl(resolved);
    return validation.safe ? validation.normalizedUrl || resolved : undefined;
  } catch {
    return undefined;
  }
}

function imagesFrom(value: unknown, sourceUrl: string): string[] {
  const candidates = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const candidate of candidates.slice(0, MAX_LIST_ITEMS)) {
    const record = asRecord(candidate);
    const resolved = resolveExternalUrl(
      typeof candidate === 'string'
        ? candidate
        : record?.url || record?.contentUrl || record?.thumbnailUrl,
      sourceUrl,
    );
    if (resolved && !result.includes(resolved)) result.push(resolved);
  }
  return result;
}

function firstOffer(value: unknown): JsonRecord | undefined {
  const offers = Array.isArray(value) ? value : [value];
  return offers.map(asRecord).find(Boolean);
}

function finitePrice(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.replace(/\s/g, '').replace(',', '.'))
      : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 && numeric < 1_000_000_000_000_000
    ? numeric
    : undefined;
}

function field<T>(
  value: T | undefined,
  source: DeterministicExtractionSource,
  sourceField: string,
  sourceUrl: string,
  extractedAt: string,
  confidence: number,
): DeterministicExtractedField<T> | undefined {
  if (value === undefined) return undefined;
  return {
    value,
    provenance: {
      source,
      sourceField,
      sourceUrl,
      extractedAt,
      confidence,
      valueHash: hash(value),
    },
  };
}

function jsonProductFields(products: JsonRecord[], sourceUrl: string, extractedAt: string) {
  for (const product of products) {
    const offer = firstOffer(product.offers);
    const title = boundedText(product.name, 240);
    const description = boundedText(product.description);
    const imageValues = imagesFrom(product.image, sourceUrl);
    const brandRecord = asRecord(product.brand);
    const brand = boundedText(
      typeof product.brand === 'string' ? product.brand : brandRecord?.name,
      160,
    );
    const sku = boundedText(product.sku || product.mpn || product.productID, 160);
    const category = boundedText(product.category, 160);
    const canonical = resolveExternalUrl(product.url || offer?.url, sourceUrl);
    const price = finitePrice(offer?.price || offer?.lowPrice);
    const currency = boundedText(offer?.priceCurrency, 8)?.toUpperCase();
    if (title || description || imageValues.length || canonical || price || brand || sku || category) {
      return {
        title: field(title, 'JSON_LD_PRODUCT', 'name', sourceUrl, extractedAt, 0.95),
        description: field(description, 'JSON_LD_PRODUCT', 'description', sourceUrl, extractedAt, 0.9),
        canonicalUrl: field(canonical, 'JSON_LD_PRODUCT', offer?.url ? 'offers.url' : 'url', sourceUrl, extractedAt, 0.9),
        images: imageValues.map(value => field(value, 'JSON_LD_PRODUCT', 'image', sourceUrl, extractedAt, 0.95)!),
        price: field(price, 'JSON_LD_PRODUCT', offer?.price !== undefined ? 'offers.price' : 'offers.lowPrice', sourceUrl, extractedAt, 0.9),
        currency: field(currency, 'JSON_LD_PRODUCT', 'offers.priceCurrency', sourceUrl, extractedAt, 0.9),
        brand: field(brand, 'JSON_LD_PRODUCT', 'brand.name', sourceUrl, extractedAt, 0.9),
        sku: field(sku, 'JSON_LD_PRODUCT', product.sku ? 'sku' : product.mpn ? 'mpn' : 'productID', sourceUrl, extractedAt, 0.9),
        category: field(category, 'JSON_LD_PRODUCT', 'category', sourceUrl, extractedAt, 0.8),
      };
    }
  }
  return { images: [] as Array<DeterministicExtractedField<string>> };
}

export function extractDeterministicProductData(
  html: string,
  requestedSourceUrl: string,
  now = Date.now(),
): DeterministicProductExtraction {
  const validatedSource = validateExternalUrl(requestedSourceUrl);
  if (!validatedSource.safe || !validatedSource.normalizedUrl) {
    throw new Error('DETERMINISTIC_EXTRACTION_SOURCE_URL_INVALID');
  }
  const sourceUrl = validatedSource.normalizedUrl;
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error('DETERMINISTIC_EXTRACTION_HTML_TOO_LARGE');
  }

  const extractedAt = new Date(now).toISOString();
  const warnings = new Set<string>();
  const metadata = metaValues(html);
  const jsonFields = jsonProductFields(
    parseJsonLdProducts(html, warnings),
    sourceUrl,
    extractedAt,
  );
  const metaFirst = (key: string): string | undefined => metadata.get(key)?.[0];
  const ogTitle = boundedText(metaFirst('og:title'), 240);
  const ogDescription = boundedText(metaFirst('og:description'));
  const ogImages = [
    ...(metadata.get('og:image:secure_url') || []),
    ...(metadata.get('og:image') || []),
  ].map(value => resolveExternalUrl(value, sourceUrl))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, MAX_LIST_ITEMS);
  const canonical = resolveExternalUrl(
    canonicalLink(html) || metaFirst('og:url'),
    sourceUrl,
  );
  const metaPrice = finitePrice(
    metaFirst('product:price:amount')
    || metaFirst('og:price:amount')
    || metaFirst('price'),
  );
  const metaCurrency = boundedText(
    metaFirst('product:price:currency') || metaFirst('og:price:currency'),
    8,
  )?.toUpperCase();
  const fallbackTitle = titleElement(html);

  const images = [
    ...(jsonFields.images || []),
    ...ogImages.map(value => field(value, 'OPEN_GRAPH', 'og:image', sourceUrl, extractedAt, 0.8)!),
  ].filter((item, index, all) => all.findIndex(other => other.value === item.value) === index)
    .slice(0, MAX_LIST_ITEMS);

  return {
    schemaVersion: DETERMINISTIC_EXTRACTION_SCHEMA_VERSION,
    ruleVersion: DETERMINISTIC_EXTRACTION_RULE_VERSION,
    sourceUrl,
    sourceHash: hash(html),
    extractedAt,
    title: jsonFields.title
      || field(ogTitle, 'OPEN_GRAPH', 'og:title', sourceUrl, extractedAt, 0.8)
      || field(fallbackTitle, 'HTML_META', 'title', sourceUrl, extractedAt, 0.6),
    description: jsonFields.description
      || field(ogDescription, 'OPEN_GRAPH', 'og:description', sourceUrl, extractedAt, 0.75)
      || field(boundedText(metaFirst('description')), 'HTML_META', 'description', sourceUrl, extractedAt, 0.6),
    canonicalUrl: jsonFields.canonicalUrl
      || field(canonical, canonicalLink(html) ? 'HTML_META' : 'OPEN_GRAPH', canonicalLink(html) ? 'link[rel=canonical]' : 'og:url', sourceUrl, extractedAt, 0.85),
    images,
    price: jsonFields.price
      || field(metaPrice, 'OPEN_GRAPH', 'product:price:amount', sourceUrl, extractedAt, 0.75),
    currency: jsonFields.currency
      || field(metaCurrency, 'OPEN_GRAPH', 'product:price:currency', sourceUrl, extractedAt, 0.75),
    brand: jsonFields.brand,
    sku: jsonFields.sku,
    category: jsonFields.category,
    warnings: [...warnings].sort(),
  };
}
