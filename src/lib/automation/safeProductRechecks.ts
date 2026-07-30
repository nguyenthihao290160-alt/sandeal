import { createHash } from 'node:crypto';
import type { Product } from '@/lib/types';
import { createAutomationJob } from './store';

const DEFAULT_RECHECK_LIMIT = 50;
const MAX_AUTOMATIC_FAILURES = 6;

export type ProductRecheckCategory =
  | 'SOURCE_READINESS'
  | 'TARGET_URL'
  | 'IMAGE'
  | 'PRICE'
  | 'MERCHANT'
  | 'PRODUCT_HEALTH'
  | 'PUBLICATION_READINESS';

export type ProductRecheckDisposition =
  | 'RETRYABLE'
  | 'PERMANENT'
  | 'MANUAL_INPUT_REQUIRED'
  | 'NOT_DUE'
  | 'NOT_REQUIRED';

export interface ProductRecheckDecision {
  productId: string;
  category: ProductRecheckCategory;
  disposition: ProductRecheckDisposition;
  reasonCode: string;
  scheduledAt: string | null;
  evidenceRevision: string;
  idempotencyKey: string;
}

export interface SafeProductRecheckScheduleResult {
  inspected: number;
  eligible: number;
  enqueueAttempts: number;
  created: number;
  duplicateSuppressed: number;
  notDue: number;
  permanent: number;
  manualInputRequired: number;
  notRequired: number;
  createdJobIds: string[];
}

function safeTimestamp(value: string | undefined): string | null {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function recheckCategory(product: Product): ProductRecheckCategory {
  const action = String(product.nextAutomaticAction || '').toUpperCase();
  const reasons = [
    product.sourceHealthReason,
    product.publicBlockReason,
    ...(product.publicBlockReasons || []),
    ...(product.eligibility?.criticalBlockers || []),
  ].join(',');
  if (/SOURCE|INGEST/.test(action) || /source/i.test(reasons)) return 'SOURCE_READINESS';
  if (/AFFILIATE|MERCHANT/.test(action) || /merchant|affiliate/i.test(reasons)) return 'MERCHANT';
  if (/IMAGE/.test(action) || /image/i.test(reasons)) return 'IMAGE';
  if (/PRICE/.test(action) || /price/i.test(reasons)) return 'PRICE';
  if (/URL|LINK/.test(action) || /url|link/i.test(reasons)) return 'TARGET_URL';
  if (/PUBLISH|ELIGIB/.test(action)) return 'PUBLICATION_READINESS';
  return 'PRODUCT_HEALTH';
}

function evidenceRevision(product: Product, category: ProductRecheckCategory): string {
  const explicit = product.evidenceSnapshotHash
    || product.sourceHash
    || product.contentHash
    || product.lifecycleUpdatedAt
    || product.updatedAt
    || product.id;
  return createHash('sha256')
    .update([
      product.id,
      category,
      explicit,
      product.nextAutomaticAction || '',
      product.sourceHealthReason || '',
      product.nextRetryAt || '',
    ].join(':'))
    .digest('hex');
}

export function productRecheckIdempotencyKey(
  product: Product,
  category = recheckCategory(product),
): string {
  const revision = evidenceRevision(product, category);
  return `product-recheck:${createHash('sha256')
    .update(`${product.id}:${category}:${revision}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function isPermanent(product: Product): boolean {
  const reasons = [
    product.archivedReason,
    product.sourceHealthReason,
    product.publicBlockReason,
    ...(product.publicBlockReasons || []),
    ...(product.quarantineReasons || []),
    ...(product.eligibility?.criticalBlockers || []),
  ].join(',');
  return product.status === 'archived'
    || product.lifecycleState === 'CONFIRMED_BROKEN'
    || (product.recordType !== undefined && product.recordType !== 'PRODUCT')
    || /confirmed_broken|not_found|prohibited|permanent|invalid_product_kind|non_product/i.test(reasons);
}

function requiresManualInput(product: Product): boolean {
  const action = String(product.nextAutomaticAction || '');
  const reasons = [
    product.publicBlockReason,
    ...(product.publicBlockReasons || []),
    ...(product.quarantineReasons || []),
    ...(product.eligibility?.criticalBlockers || []),
  ].join(',');
  return product.status === 'needs_review'
    || Number(product.consecutiveHealthFailures || 0) >= MAX_AUTOMATIC_FAILURES
    || /manual|human|operator|review|quarantined/i.test(action)
    || /manual|human_review|compliance|credential|merchant_block/i.test(reasons);
}

function requested(product: Product): boolean {
  return /recheck|retry|verify/i.test(String(product.nextAutomaticAction || ''))
    || product.lifecycleState === 'RETRY_SCHEDULED'
    || Boolean(product.nextRetryAt);
}

export function classifyProductRecheck(product: Product, now = Date.now()): ProductRecheckDecision {
  const category = recheckCategory(product);
  const revision = evidenceRevision(product, category);
  const idempotencyKey = productRecheckIdempotencyKey(product, category);
  const scheduledAt = safeTimestamp(product.nextRetryAt) || new Date(now).toISOString();
  if (isPermanent(product)) {
    return {
      productId: product.id,
      category,
      disposition: 'PERMANENT',
      reasonCode: 'PRODUCT_RECHECK_PERMANENT_BLOCKER',
      scheduledAt: null,
      evidenceRevision: revision,
      idempotencyKey,
    };
  }
  if (requiresManualInput(product)) {
    return {
      productId: product.id,
      category,
      disposition: 'MANUAL_INPUT_REQUIRED',
      reasonCode: 'PRODUCT_RECHECK_MANUAL_INPUT_REQUIRED',
      scheduledAt: null,
      evidenceRevision: revision,
      idempotencyKey,
    };
  }
  if (!requested(product)) {
    return {
      productId: product.id,
      category,
      disposition: 'NOT_REQUIRED',
      reasonCode: 'PRODUCT_RECHECK_NOT_REQUESTED',
      scheduledAt: null,
      evidenceRevision: revision,
      idempotencyKey,
    };
  }
  if (Date.parse(scheduledAt) > now) {
    return {
      productId: product.id,
      category,
      disposition: 'NOT_DUE',
      reasonCode: 'PRODUCT_RECHECK_BACKOFF_ACTIVE',
      scheduledAt,
      evidenceRevision: revision,
      idempotencyKey,
    };
  }
  return {
    productId: product.id,
    category,
    disposition: 'RETRYABLE',
    reasonCode: 'PRODUCT_RECHECK_RETRYABLE',
    scheduledAt,
    evidenceRevision: revision,
    idempotencyKey,
  };
}

function healthTarget(category: ProductRecheckCategory): 'link' | 'affiliate' | 'image' | undefined {
  if (category === 'TARGET_URL') return 'link';
  if (category === 'MERCHANT') return 'affiliate';
  if (category === 'IMAGE') return 'image';
  return undefined;
}

export async function scheduleSafeProductRechecks(
  products: Product[],
  options: {
    now?: number;
    limit?: number;
    createJob?: typeof createAutomationJob;
  } = {},
): Promise<SafeProductRecheckScheduleResult> {
  const now = options.now ?? Date.now();
  const createJob = options.createJob || createAutomationJob;
  const limit = Math.max(1, Math.min(DEFAULT_RECHECK_LIMIT, Math.floor(options.limit || DEFAULT_RECHECK_LIMIT)));
  const result: SafeProductRecheckScheduleResult = {
    inspected: 0,
    eligible: 0,
    enqueueAttempts: 0,
    created: 0,
    duplicateSuppressed: 0,
    notDue: 0,
    permanent: 0,
    manualInputRequired: 0,
    notRequired: 0,
    createdJobIds: [],
  };
  const decisions = products
    .map(product => ({ product, decision: classifyProductRecheck(product, now) }))
    .sort((left, right) => {
      const leftAt = Date.parse(left.decision.scheduledAt || '') || Number.POSITIVE_INFINITY;
      const rightAt = Date.parse(right.decision.scheduledAt || '') || Number.POSITIVE_INFINITY;
      return leftAt - rightAt || left.product.id.localeCompare(right.product.id);
    });
  for (const { product, decision } of decisions) {
    result.inspected += 1;
    if (decision.disposition === 'NOT_DUE') {
      result.notDue += 1;
      continue;
    }
    if (decision.disposition === 'PERMANENT') {
      result.permanent += 1;
      continue;
    }
    if (decision.disposition === 'MANUAL_INPUT_REQUIRED') {
      result.manualInputRequired += 1;
      continue;
    }
    if (decision.disposition === 'NOT_REQUIRED') {
      result.notRequired += 1;
      continue;
    }
    result.eligible += 1;
    if (result.enqueueAttempts >= limit) continue;
    result.enqueueAttempts += 1;
    const target = healthTarget(decision.category);
    const created = await createJob({
      type: 'RECHECK_PRODUCT_HEALTH',
      payload: {
        productIds: [product.id],
        ...(target ? { healthTarget: target } : {}),
        recheckCategory: decision.category,
        evidenceRevision: decision.evidenceRevision,
      },
      idempotencyKey: decision.idempotencyKey,
      operationId: `product-recheck:${product.id}:${decision.evidenceRevision.slice(0, 24)}`,
      requestedBy: 'autonomous-reconciler',
      priority: decision.category === 'PUBLICATION_READINESS' ? 65 : 55,
      scheduledAt: decision.scheduledAt || new Date(now).toISOString(),
    });
    if (created.created) {
      result.created += 1;
      result.createdJobIds.push(created.job.id);
    } else {
      result.duplicateSuppressed += 1;
    }
  }
  return result;
}
