import { createHash } from 'crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Product, ProductPlatform, ProductSource } from '@/lib/types';
import { getAllProducts, upsertCanonicalProduct } from '@/lib/storage/products';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';
import { normalizePlatformFromUrl } from '@/lib/productScoring';
import { PRODUCT_INTELLIGENCE_CONFIG as CONFIG } from './config';
import type { ImportPreview, ImportRowResult, ManualUrlPreview, PendingManualSource } from './types';
import { validateExternalUrl } from './urlSafety';
import { enqueueCandidate, type CandidatePayload, type CandidateQueueItem } from '@/lib/storage/candidateQueue';
import { scoreCandidateReadiness } from '@/lib/bots/candidateReadiness';
import { bridgeCandidatesToDurableJobs } from '@/lib/automation/candidateBridge';

const STAGING_COLLECTION = 'import-batches';
const PENDING_MANUAL_COLLECTION = 'pending-manual-sources';
const STAGING_TTL_MS = 2 * 60 * 60_000;
const MAX_PENDING_MANUAL_SOURCES = 1_000;
const FIELDS = [
  'title', 'originalUrl', 'affiliateUrl', 'imageUrl', 'price', 'salePrice', 'platform',
  'source', 'category', 'brand', 'sku', 'sourceId', 'externalId', 'merchant', 'observedAt',
] as const;
type ImportField = typeof FIELDS[number];

interface ImportBatch {
  id: string;
  rows: Array<{ row: number; action: 'create' | 'update'; normalized: Partial<Product> }>;
  format?: 'csv' | 'json';
  createdAt: string;
  expiresAt: string;
  digest: string;
}

export interface ImportApplyContext {
  parentJobId?: string;
  requestedBy?: string;
  approvedSource?: boolean;
}

const PLATFORMS = new Set<ProductPlatform>(['shopee', 'tiktok_shop', 'lazada', 'accesstrade', 'website', 'other']);
const SOURCES = new Set<ProductSource>(['manual', 'accesstrade', 'shopee_affiliate', 'tiktok_shop', 'lazada_affiliate', 'csv', 'other']);

export function neutralizeCsvFormula(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function parseNumber(value: string): number | undefined {
  const normalized = value.trim().replace(/[₫đ\s]/gi, '').replace(/(?<=\d)[.,](?=\d{3}(?:\D|$))/g, '');
  if (!normalized) return undefined;
  const parsed = Number(normalized.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseCsv(csv: string): string[][] {
  if (Buffer.byteLength(csv, 'utf8') > CONFIG.limits.csvBytes) throw new Error('CSV_TOO_LARGE');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field); field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      if (rows.length > CONFIG.limits.csvRows + 1) throw new Error('CSV_TOO_MANY_ROWS');
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV_UNCLOSED_QUOTE');
  row.push(field);
  if (row.some(value => value.length > 0)) rows.push(row);
  if (rows.length > CONFIG.limits.csvRows + 1) throw new Error('CSV_TOO_MANY_ROWS');
  return rows;
}

function canonicalUrl(value?: string): string {
  const checked = validateExternalUrl(value);
  if (!checked.safe || !checked.normalizedUrl) return '';
  const url = new URL(checked.normalizedUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|aff_|affiliate|tracking|ref|source|campaign)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function headerIndexes(headers: string[], mapping: Partial<Record<ImportField, string>>): Record<ImportField, number> {
  const normalizedHeaders = headers.map(normalizeHeader);
  return Object.fromEntries(FIELDS.map(field => {
    const requested = mapping[field] || field;
    return [field, normalizedHeaders.indexOf(normalizeHeader(requested))];
  })) as Record<ImportField, number>;
}

function valueAt(row: string[], indexes: Record<ImportField, number>, field: ImportField): string {
  const index = indexes[field];
  return index >= 0 ? String(row[index] || '').trim().slice(0, 2_048) : '';
}

function exactExisting(normalized: Partial<Product>, products: Product[]): Product | undefined {
  const original = canonicalUrl(normalized.originalUrl);
  const affiliate = canonicalUrl(normalized.affiliateUrl);
  const externalId = String(normalized.externalId || '');
  return products.find(product =>
    (externalId && product.source === normalized.source && String(product.externalId || product.sourceId || '') === externalId)
    || (original && canonicalUrl(product.originalUrl) === original)
    || (affiliate && canonicalUrl(product.affiliateUrl) === affiliate));
}

function likelyDuplicate(normalized: Partial<Product>, products: Product[]): Product | undefined {
  const brand = String(normalized.brand || '').toLowerCase();
  const sku = String(normalized.sku || '').toLowerCase();
  if (brand && sku) return products.find(product => product.brand?.toLowerCase() === brand && product.sku?.toLowerCase() === sku);
  return undefined;
}

function normalizeRow(row: string[], rowNumber: number, indexes: Record<ImportField, number>, products: Product[], strictDatafeed = false): ImportRowResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = neutralizeCsvFormula(valueAt(row, indexes, 'title')).slice(0, 240);
  const rawOriginalUrl = valueAt(row, indexes, 'originalUrl');
  const rawAffiliateUrl = valueAt(row, indexes, 'affiliateUrl');
  const rawImageUrl = valueAt(row, indexes, 'imageUrl');
  const originalCheck = rawOriginalUrl ? validateExternalUrl(rawOriginalUrl) : undefined;
  const affiliateCheck = rawAffiliateUrl ? validateExternalUrl(rawAffiliateUrl) : undefined;
  const imageCheck = rawImageUrl ? validateExternalUrl(rawImageUrl) : undefined;
  if (title.length < 3) errors.push('title_required');
  if (!rawOriginalUrl && !rawAffiliateUrl) errors.push('url_required');
  if (originalCheck && !originalCheck.safe) errors.push(`original_url_${originalCheck.code?.toLowerCase()}`);
  if (affiliateCheck && !affiliateCheck.safe) errors.push(`affiliate_url_${affiliateCheck.code?.toLowerCase()}`);
  if (imageCheck && !imageCheck.safe) errors.push(`image_url_${imageCheck.code?.toLowerCase()}`);

  const priceRaw = valueAt(row, indexes, 'price');
  const salePriceRaw = valueAt(row, indexes, 'salePrice');
  const price = parseNumber(priceRaw);
  const salePrice = parseNumber(salePriceRaw);
  if (priceRaw && price === undefined) errors.push('price_invalid');
  if (salePriceRaw && salePrice === undefined) errors.push('sale_price_invalid');
  if (price !== undefined && salePrice !== undefined && salePrice > price) warnings.push('sale_price_above_original');

  const sourceId = neutralizeCsvFormula(valueAt(row, indexes, 'sourceId')).slice(0, 160);
  const externalId = neutralizeCsvFormula(valueAt(row, indexes, 'externalId')).slice(0, 160);
  const observedAtRaw = valueAt(row, indexes, 'observedAt');
  const observedAt = observedAtRaw && Number.isFinite(Date.parse(observedAtRaw)) ? new Date(observedAtRaw).toISOString() : undefined;
  if (observedAtRaw && !observedAt) errors.push('observed_at_invalid');
  if (strictDatafeed) {
    if (title.length < 8) errors.push('title_not_specific');
    if (!rawOriginalUrl) errors.push('product_url_required');
    if (!rawImageUrl) errors.push('image_url_required');
    if (!(Number(salePrice || price) > 0)) errors.push('price_required');
    if (!sourceId && !externalId) errors.push('source_id_required');
  }

  const platformRaw = valueAt(row, indexes, 'platform').toLowerCase() as ProductPlatform;
  const sourceRaw = valueAt(row, indexes, 'source').toLowerCase() as ProductSource;
  if (platformRaw && !PLATFORMS.has(platformRaw)) errors.push('platform_invalid');
  if (sourceRaw && !SOURCES.has(sourceRaw)) errors.push('source_invalid');
  const inferredPlatform = normalizePlatformFromUrl(originalCheck?.normalizedUrl || affiliateCheck?.normalizedUrl || '');
  const normalized: Partial<Product> = {
    title,
    kind: 'product',
    platform: platformRaw || inferredPlatform || 'website',
    source: sourceRaw || 'csv',
    originalUrl: originalCheck?.normalizedUrl,
    affiliateUrl: affiliateCheck?.normalizedUrl,
    imageUrl: imageCheck?.normalizedUrl,
    price,
    salePrice,
    currency: 'VND',
    category: neutralizeCsvFormula(valueAt(row, indexes, 'category')).slice(0, 120) || undefined,
    brand: neutralizeCsvFormula(valueAt(row, indexes, 'brand')).slice(0, 120) || undefined,
    sku: neutralizeCsvFormula(valueAt(row, indexes, 'sku')).slice(0, 120) || undefined,
    sourceId: sourceId || externalId || undefined,
    externalId: externalId || sourceId || undefined,
    lastSeenAt: observedAt,
    priceObservedAt: observedAt && Number(salePrice || price) > 0 ? observedAt : undefined,
    tags: [],
    benefits: [],
    warnings: [],
    riskLevel: 'unknown',
    status: 'needs_review',
    verifiedSource: false,
    sourceVerified: false,
    publicHidden: true,
    needsVerification: true,
    autoPublishEligible: false,
    contentWorkflowStatus: 'insufficient_data',
  };
  const existing = exactExisting(normalized, products);
  const suspected = !existing ? likelyDuplicate(normalized, products) : undefined;
  if (suspected) warnings.push(`suspected_duplicate:${suspected.id}`);
  return {
    row: rowNumber,
    valid: errors.length === 0,
    errors,
    warnings,
    action: errors.length ? 'skip' : existing ? 'update' : suspected ? 'duplicate' : 'create',
    normalized: errors.length ? undefined : normalized,
  };
}

async function storeBatch(rows: ImportRowResult[], digest: string, format: 'csv' | 'json' = 'csv'): Promise<ImportBatch> {
  const now = Date.now();
  const batch: ImportBatch = {
    id: generateId(),
    rows: rows.filter((row): row is ImportRowResult & { action: 'create' | 'update'; normalized: Partial<Product> } =>
      row.valid && (row.action === 'create' || row.action === 'update') && Boolean(row.normalized))
      .map(row => ({ row: row.row, action: row.action, normalized: row.normalized })),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + STAGING_TTL_MS).toISOString(),
    digest,
    format,
  };
  await runTransaction<ImportBatch>(STAGING_COLLECTION, items => [
    ...items.filter(item => Date.parse(item.expiresAt) > now && item.digest !== digest).slice(-19),
    batch,
  ]);
  return batch;
}

function rejectionDirectory(): string {
  return path.resolve(process.cwd(), '.test-tmp', 'import-rejections');
}

async function writeRejectionReport(previewId: string, rows: ImportRowResult[]): Promise<string | null> {
  const rejected = rows.filter(row => !row.valid || row.action === 'duplicate');
  if (!rejected.length) return null;
  const directory = rejectionDirectory();
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${previewId}.csv`);
  const output = [
    'row,action,errors,warnings',
    ...rejected.map(row => [row.row, row.action, row.errors.join('|'), row.warnings.join('|')].map(escapeCsvCell).join(',')),
  ].join('\r\n');
  await fs.writeFile(file, `\uFEFF${output}\r\n`, { encoding: 'utf8', flag: 'wx' }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return `/api/dashboard/import?report=${encodeURIComponent(previewId)}`;
}

export function getImportRejectionReportPath(previewId: string): string | null {
  if (!/^[a-z0-9-]{8,160}$/i.test(previewId)) return null;
  const directory = rejectionDirectory();
  const file = path.resolve(directory, `${previewId}.csv`);
  return file.startsWith(`${directory}${path.sep}`) ? file : null;
}

async function previewParsedRows(
  parsed: string[][],
  mapping: Partial<Record<ImportField, string>>,
  format: 'csv' | 'json',
  strictDatafeed: boolean,
): Promise<ImportPreview> {
  if (parsed.length < 2) throw new Error(`${format.toUpperCase()}_HAS_NO_DATA`);
  const products = await getAllProducts();
  const indexes = headerIndexes(parsed[0], mapping);
  if (indexes.title < 0) throw new Error(`${format.toUpperCase()}_TITLE_COLUMN_REQUIRED`);
  const rows = parsed.slice(1).map((row, index) => normalizeRow(row, index + 2, indexes, products, strictDatafeed));
  return finalizePreview(rows, format);
}

async function finalizePreview(rows: ImportRowResult[], format: 'csv' | 'json'): Promise<ImportPreview> {
  const digest = createHash('sha256').update(JSON.stringify(rows.map(row => row.normalized || row.errors))).digest('hex');
  const batch = await storeBatch(rows, digest, format);
  const rejectionReportUrl = await writeRejectionReport(batch.id, rows);
  return {
    previewId: batch.id,
    expiresAt: batch.expiresAt,
    rows: rows.slice(0, CONFIG.limits.csvPreviewRows),
    totalRows: rows.length,
    validRows: rows.filter(row => row.valid && row.action !== 'duplicate').length,
    invalidRows: rows.filter(row => !row.valid).length,
    creates: rows.filter(row => row.action === 'create').length,
    updates: rows.filter(row => row.action === 'update').length,
    suspectedDuplicates: rows.filter(row => row.action === 'duplicate').length,
    truncated: rows.length > CONFIG.limits.csvPreviewRows,
    format,
    rejectionReportUrl,
    publicSideEffect: false,
  };
}

export async function previewCsvImport(
  csv: string,
  mapping: Partial<Record<ImportField, string>> = {},
): Promise<ImportPreview> {
  const parsed = parseCsv(csv);
  return previewParsedRows(parsed, mapping, 'csv', false);
}

const JSON_ALIASES: Record<ImportField, string[]> = {
  title: ['title', 'name', 'productName', 'product_name'],
  originalUrl: ['originalUrl', 'original_url', 'productUrl', 'product_url', 'url'],
  affiliateUrl: ['affiliateUrl', 'affiliate_url', 'trackingUrl', 'tracking_url'],
  imageUrl: ['imageUrl', 'image_url', 'image', 'thumbnail'],
  price: ['price', 'originalPrice', 'original_price'], salePrice: ['salePrice', 'sale_price', 'currentPrice', 'current_price'],
  platform: ['platform', 'marketplace'], source: ['source', 'provider'], category: ['category', 'categoryName', 'category_name'],
  brand: ['brand', 'manufacturer'], sku: ['sku', 'model'], sourceId: ['sourceId', 'source_id'], externalId: ['externalId', 'external_id', 'productId', 'product_id'],
  merchant: ['merchant', 'merchantName', 'merchant_name', 'shopName', 'shop_name'], observedAt: ['observedAt', 'observed_at', 'updatedAt', 'updated_at'],
};

function jsonRows(content: string): Array<{ row: number; values?: string[]; error?: 'json_row_invalid' | 'json_field_type_invalid' }> {
  if (Buffer.byteLength(content, 'utf8') > CONFIG.limits.csvBytes) throw new Error('JSON_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON_INVALID'); }
  const root = objectRecord(parsed);
  const records = Array.isArray(parsed) ? parsed : root.products;
  if (!Array.isArray(parsed) && (!Object.keys(root).length || !Array.isArray(root.products))) throw new Error('JSON_ROOT_INVALID');
  if (!Array.isArray(records) || !records.length) throw new Error('JSON_HAS_NO_DATA');
  if (records.length > CONFIG.limits.csvRows) throw new Error('JSON_TOO_MANY_ROWS');
  return records.map((value, index) => {
    const record = objectRecord(value);
    if (!Object.keys(record).length || ['__proto__', 'prototype', 'constructor'].some(key => Object.prototype.hasOwnProperty.call(record, key))) {
      return { row: index + 1, error: 'json_row_invalid' };
    }
    let invalidFieldType = false;
    const values = FIELDS.map(field => {
      const alias = JSON_ALIASES[field].find(key => record[key] !== undefined && record[key] !== null);
      const item = alias ? record[alias] : '';
      if (item !== '' && !['string', 'number'].includes(typeof item)) { invalidFieldType = true; return ''; }
      return String(item ?? '').slice(0, 2_048);
    });
    return invalidFieldType ? { row: index + 1, error: 'json_field_type_invalid' } : { row: index + 1, values };
  });
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function previewApprovedDatafeed(
  content: string,
  format: 'csv' | 'json',
  mapping: Partial<Record<ImportField, string>> = {},
): Promise<ImportPreview> {
  if (!['csv', 'json'].includes(format)) throw new Error('IMPORT_FORMAT_UNSUPPORTED');
  if (format === 'csv') return previewParsedRows(parseCsv(content), mapping, format, true);
  const parsed = jsonRows(content);
  const products = await getAllProducts();
  const indexes = headerIndexes(FIELDS.map(String), {});
  const rows: ImportRowResult[] = parsed.map(item => item.error ? {
    row: item.row,
    valid: false,
    errors: [item.error],
    warnings: [],
    action: 'skip',
  } : normalizeRow(item.values || [], item.row, indexes, products, true));
  return finalizePreview(rows, format);
}

export async function getImportBatch(id: string): Promise<ImportBatch | null> {
  const batch = (await readCollection<ImportBatch>(STAGING_COLLECTION)).find(item => item.id === id);
  return batch && Date.parse(batch.expiresAt) > Date.now() ? batch : null;
}

export async function applyImportBatch(previewId: string, operationId: string, context: ImportApplyContext = {}): Promise<Record<string, unknown>> {
  const batch = await getImportBatch(previewId);
  if (!batch) throw new Error('IMPORT_PREVIEW_EXPIRED');
  if (context.parentJobId) {
    let accepted = 0; let duplicate = 0; const candidateIds: string[] = []; const errors: Array<{ row: number; code: string }> = [];
    for (const row of batch.rows.slice(0, CONFIG.limits.csvRows)) {
      try {
        const normalized = row.normalized;
        const originalUrl = String(normalized.originalUrl || '');
        const affiliateUrl = String(normalized.affiliateUrl || normalized.originalUrl || '');
        const imageUrl = String(normalized.imageUrl || '');
        const sourceId = String(normalized.sourceId || normalized.externalId || createHash('sha256').update(originalUrl).digest('hex'));
        const sourceHash = createHash('sha256').update(JSON.stringify({ digest: batch.digest, row: row.row, normalized })).digest('hex');
        const payload: CandidatePayload = {
          title: String(normalized.title || ''), description: normalized.description,
          kind: 'product', platform: normalized.platform || 'website', originalUrl, affiliateUrl, imageUrl,
          imageCandidates: imageUrl ? [imageUrl] : [], price: normalized.price, salePrice: normalized.salePrice,
          currency: 'VND', category: normalized.category, brand: normalized.brand, sku: normalized.sku,
          merchant: (() => { try { return new URL(originalUrl).hostname.toLowerCase(); } catch { return undefined; } })(),
          rawSourceKind: batch.format === 'json' ? 'approved_json_datafeed' : 'approved_csv_datafeed',
          verifiedSource: context.approvedSource === true,
          autoPublishEligible: false,
        };
        const readiness = scoreCandidateReadiness(payload);
        const queued = await enqueueCandidate({
          source: (normalized.source || 'csv') as CandidateQueueItem['source'], sourceId,
          priority: Math.max(1, Math.min(100, 70 + readiness.score / 5 + (payload.verifiedSource ? 10 : 0))),
          readinessScore: readiness.score, lane: readiness.lane,
          contentHash: sourceHash, sourceHash, keyword: `datafeed:${batch.format || 'csv'}`, payload,
        });
        if (queued.queued) { accepted += 1; candidateIds.push(queued.item.id); }
        else duplicate += 1;
      } catch (error) {
        errors.push({ row: row.row, code: error instanceof Error ? error.message.slice(0, 80) : 'IMPORT_ROW_ERROR' });
      }
    }
    const bridge = candidateIds.length ? await bridgeCandidatesToDurableJobs({
      parentJobId: context.parentJobId, requestedBy: context.requestedBy || 'import-worker',
      limit: candidateIds.length, candidateIds,
    }) : { inspected: 0, created: 0, existing: 0, skipped: 0, jobs: [] };
    return {
      operationId, accepted, rejected: errors.length, duplicate, candidateQueued: accepted,
      processCandidateJobs: bridge.jobs.length, failed: errors.length, errors: errors.slice(0, 50),
      executionStatus: bridge.jobs.length ? 'PARTIALLY_COMPLETED' : 'COMPLETED_WITH_LOCAL_RULES',
      completedSteps: ['parse', 'normalize', 'fast-validation', 'candidate-ingestion'],
      pendingSteps: bridge.jobs.length ? ['candidate-processing', 'health-evidence-dedupe', 'launch-readiness'] : [],
      publicSideEffect: false, businessDataChanged: accepted > 0,
    };
  }

  // Compatibility for internal Prompt 08 callers. Production IMPORT_PRODUCTS jobs always pass parentJobId above.
  let created = 0; let updated = 0; let unchanged = 0; const errors: Array<{ row: number; code: string }> = [];
  for (const row of batch.rows.slice(0, CONFIG.limits.csvRows)) {
    try {
      const result = await upsertCanonicalProduct({
        ...row.normalized,
        status: 'needs_review', publicHidden: true, needsVerification: true, autoPublished: false,
        sourceHash: createHash('sha256').update(`${batch.digest}:${row.row}`).digest('hex'),
      }, { evaluate: false });
      if (result.unchanged) unchanged += 1;
      else if (result.created) created += 1;
      else updated += 1;
    } catch (error) {
      errors.push({ row: row.row, code: error instanceof Error ? error.message.slice(0, 80) : 'IMPORT_ERROR' });
    }
  }
  return { operationId, created, updated, unchanged, failed: errors.length, errors: errors.slice(0, 50), publicSideEffect: false };
}

export function previewManualUrl(value: string): ManualUrlPreview {
  const checked = validateExternalUrl(value);
  if (!checked.safe) return {
    valid: false,
    status: 'blocked',
    reason: checked.code || 'INVALID_URL',
    adapterSupported: false,
    publicSideEffect: false,
  };
  const normalized = new URL(checked.normalizedUrl!);
  return {
    valid: true,
    normalizedUrl: checked.normalizedUrl,
    hostname: normalized.hostname.toLowerCase(),
    status: 'metadata_required',
    reason: 'Chưa có adapter cho domain này. Hãy nhập metadata thủ công; hệ thống chưa tải dữ liệu từ URL.',
    adapterSupported: false,
    publicSideEffect: false,
  };
}

export interface PendingManualSourceInput {
  url: string;
  title: string;
  affiliateUrl?: string;
  imageUrl?: string;
  price?: number | string;
  salePrice?: number | string;
  platform?: string;
  category?: string;
  brand?: string;
  sku?: string;
  externalId?: string;
}

function cleanManualText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
  return cleaned ? neutralizeCsvFormula(cleaned) : undefined;
}

function optionalManualUrl(value: unknown, field: 'AFFILIATE_URL' | 'IMAGE_URL'): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const checked = validateExternalUrl(value);
  if (!checked.safe || !checked.normalizedUrl) throw new Error(`${field}_${checked.code || 'INVALID'}`);
  return checked.normalizedUrl;
}

function optionalManualNumber(value: unknown, field: 'PRICE' | 'SALE_PRICE'): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseNumber(String(value));
  if (parsed === undefined) throw new Error(`${field}_INVALID`);
  return parsed;
}

export async function submitPendingManualSource(
  input: PendingManualSourceInput,
  context: { actor: string; operationId: string },
): Promise<{ source: PendingManualSource; created: boolean }> {
  const preview = previewManualUrl(input.url);
  if (!preview.valid || !preview.normalizedUrl || !preview.hostname) throw new Error(preview.reason || 'INVALID_URL');
  const title = cleanManualText(input.title, 240);
  if (!title || title.length < 3) throw new Error('TITLE_REQUIRED');
  const originalUrl = preview.normalizedUrl;
  const canonical = canonicalUrl(originalUrl);
  if (!canonical) throw new Error('INVALID_URL');
  const affiliateUrl = optionalManualUrl(input.affiliateUrl, 'AFFILIATE_URL');
  const imageUrl = optionalManualUrl(input.imageUrl, 'IMAGE_URL');
  const price = optionalManualNumber(input.price, 'PRICE');
  const salePrice = optionalManualNumber(input.salePrice, 'SALE_PRICE');
  const requestedPlatform = String(input.platform || '').trim().toLowerCase() as ProductPlatform;
  if (requestedPlatform && !PLATFORMS.has(requestedPlatform)) throw new Error('PLATFORM_INVALID');
  const platform = requestedPlatform || normalizePlatformFromUrl(originalUrl) || 'website';
  const now = new Date().toISOString();
  const operationId = cleanManualText(context.operationId, 160);
  const actor = cleanManualText(context.actor, 120);
  if (!operationId || !actor) throw new Error('OPERATION_CONTEXT_REQUIRED');
  let result: { source: PendingManualSource; created: boolean } | null = null;

  await runTransaction<PendingManualSource>(PENDING_MANUAL_COLLECTION, items => {
    const existing = items.find(item => item.canonicalUrl === canonical);
    const metadata = {
      originalUrl,
      canonicalUrl: canonical,
      hostname: preview.hostname!,
      title,
      affiliateUrl,
      imageUrl,
      price,
      salePrice,
      platform,
      source: 'manual' as const,
      category: cleanManualText(input.category, 120),
      brand: cleanManualText(input.brand, 120),
      sku: cleanManualText(input.sku, 120),
      externalId: cleanManualText(input.externalId, 160),
      status: 'pending_review' as const,
      adapterSupported: false as const,
      metadataSubmitted: true as const,
      publicSideEffect: false as const,
      operationId,
      updatedAt: now,
    };
    if (existing) {
      const updated: PendingManualSource = { ...existing, ...metadata };
      result = { source: updated, created: false };
      return [...items.filter(item => item.id !== existing.id), updated].slice(-MAX_PENDING_MANUAL_SOURCES);
    }
    const source: PendingManualSource = {
      id: generateId(),
      ...metadata,
      createdBy: actor,
      createdAt: now,
    };
    result = { source, created: true };
    return [...items, source].slice(-MAX_PENDING_MANUAL_SOURCES);
  });

  if (!result) throw new Error('PENDING_SOURCE_NOT_STORED');
  return result;
}

export async function listPendingManualSources(limit = 50): Promise<PendingManualSource[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 50, 100));
  return (await readCollection<PendingManualSource>(PENDING_MANUAL_COLLECTION))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, safeLimit);
}

export function escapeCsvCell(value: unknown): string {
  const safe = neutralizeCsvFormula(String(value ?? ''));
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
