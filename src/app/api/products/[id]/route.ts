// ===========================================
// API: Product by ID — GET + PATCH + DELETE
// ===========================================

import { createHash } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getProductById, updateProduct } from '@/lib/storage/products';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EDITABLE_FIELDS = new Set([
  'title', 'description', 'originalUrl', 'affiliateUrl', 'imageUrl', 'gallery',
  'price', 'salePrice', 'currency', 'priceNote', 'category', 'tags', 'benefits',
  'painPoints', 'targetAudience', 'warnings', 'contentAngles', 'complianceNotes',
  'affiliateSource', 'campaignName', 'commissionNote', 'brand', 'sku', 'gtin',
  'mpn', 'specifications',
]);

const AUTONOMOUS_FIELDS = new Set([
  'schemaVersion', 'id', 'slug', 'kind', 'platform', 'source', 'sourceId', 'externalId',
  'rawSourceType', 'contentHash', 'sourceHash', 'createdAt', 'updatedAt', 'recordType',
  'lifecycleState', 'lifecycleVersion', 'lifecycleUpdatedAt', 'quarantineReasons',
  'nextAutomaticAction', 'nextRetryAt', 'relatedJobId', 'evidenceFactIds',
  'evidenceCoverage', 'evidenceSnapshotAt', 'evidenceSnapshotHash', 'confidences',
  'identity', 'offers', 'bestOfferId', 'priceTruthState', 'priceObservedAt',
  'priceTruthConfidence', 'priceTruthEffectivePrice', 'priceTruthDiscountPercent',
  'priceTruthEvidenceFactIds', 'priceTruthReasons', 'priceTruthRuleVersion',
  'priceTruthRequiresCrossCheck',
  'priceLastChangedAt', 'duplicateStatus', 'duplicateGroupId', 'duplicateConfidence',
  'claimValidationStatus', 'publicationEffectKey', 'publicationJobId',
  'monitoringScheduledAt', 'consecutiveHealthFailures', 'lastHealthyAt', 'hiddenAt',
  'hiddenReason', 'status', 'riskLevel', 'verifiedSource', 'sourceVerified',
  'autoPublishEligible', 'publicDecision', 'publicHidden', 'publicBlockReason',
  'publicBlockReasons', 'autoPublished', 'needsVerification', 'publishedAt',
  'linkHealthStatus', 'linkLastCheckedAt', 'linkFailureCount', 'affiliateHealthStatus',
  'affiliateLinkErrors', 'affiliateLastCheckedAt', 'imageHealthStatus',
  'imageLastCheckedAt', 'imageContentType', 'productHealthStatus',
  'sourceHealthCooldownUntil', 'sourceHealthReason', 'sourceHealthSkipUntil',
  'availability', 'lastSeenAt', 'score', 'scoreLabel', 'scoreReasons', 'scoreWarnings',
  'qualityScore', 'qualityBand', 'opportunityScore', 'opportunityBand', 'scoreVersion',
  'scoreCalculatedAt', 'scoreBreakdown', 'dealScore', 'dealBand', 'dealReasons',
  'dealConfidence', 'dataCompleteness', 'dataIssues', 'recommendedActions',
  'contentPackageStatus', 'contentWorkflowStatus', 'complianceStatus',
  'complianceIssues', 'generatedContent', 'reviewContent', 'reviewGeneration',
  'lastEditorialCheckAt', 'analyticsSummary', 'archivedReason', 'unpublishedReason',
  'affiliateDisclosure',
  'indexable', 'readinessSnapshotHash', 'publishConfidence',
]);

class ProductPatchValidationError extends Error {
  constructor(public readonly field: string) {
    super(`INVALID_PRODUCT_FIELD:${field}`);
  }
}

function autonomousFieldNames(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter(key => !EDITABLE_FIELDS.has(key) && (
    AUTONOMOUS_FIELDS.has(key)
    || /^(lifecycle|evidence|confidence|identity|offer|priceTruth|duplicate|claim|publication|readiness)/i.test(key)
  ));
}

function textValue(value: unknown, field: string, maximum: number, required = false): string | undefined {
  if (value === null && !required) return undefined;
  if (typeof value !== 'string') throw new ProductPatchValidationError(field);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) throw new ProductPatchValidationError(field);
  return normalized || undefined;
}

function urlValue(value: unknown, field: string): string | undefined {
  const normalized = textValue(value, field, 2_048);
  if (!normalized) return undefined;
  const checked = validateExternalUrl(normalized);
  if (!checked.safe || !checked.normalizedUrl) throw new ProductPatchValidationError(field);
  return checked.normalizedUrl;
}

function listValue(value: unknown, field: string, maximum = 50): string[] {
  const input = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(input) || input.length > maximum) throw new ProductPatchValidationError(field);
  const normalized = input.map(item => {
    if (typeof item !== 'string') throw new ProductPatchValidationError(field);
    return item.trim();
  }).filter(Boolean);
  if (normalized.some(item => item.length > 160)) throw new ProductPatchValidationError(field);
  return [...new Set(normalized)];
}

function numberValue(value: unknown, field: string): number | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000_000) {
    throw new ProductPatchValidationError(field);
  }
  return Math.round(value);
}

function specificationsValue(value: unknown): Record<string, string | number> | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProductPatchValidationError('specifications');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) throw new ProductPatchValidationError('specifications');
  const output: Record<string, string | number> = {};
  for (const [key, item] of entries) {
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > 80 || ['__proto__', 'prototype', 'constructor'].includes(normalizedKey) || !['string', 'number'].includes(typeof item)) throw new ProductPatchValidationError('specifications');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new ProductPatchValidationError('specifications');
    const normalizedValue = typeof item === 'string' ? item.trim() : item as number;
    if (typeof normalizedValue === 'string' && normalizedValue.length > 300) throw new ProductPatchValidationError('specifications');
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function normalizeEditableFields(body: Record<string, unknown>): Partial<Product> {
  const updates: Record<string, unknown> = {};
  const textFields: Record<string, number> = {
    description: 4_000, priceNote: 500, category: 160, affiliateSource: 160,
    campaignName: 240, commissionNote: 500, brand: 160, sku: 160, gtin: 64, mpn: 160,
  };
  const listFields = new Set(['tags', 'benefits', 'painPoints', 'targetAudience', 'warnings', 'contentAngles', 'complianceNotes']);
  for (const [field, value] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(field)) throw new ProductPatchValidationError(field);
    if (field === 'title') updates.title = textValue(value, field, 240, true);
    else if (field in textFields) updates[field] = textValue(value, field, textFields[field]);
    else if (['originalUrl', 'affiliateUrl', 'imageUrl'].includes(field)) updates[field] = urlValue(value, field);
    else if (field === 'gallery') updates.gallery = listValue(value, field, 20).map(item => urlValue(item, field)!);
    else if (field === 'price' || field === 'salePrice') updates[field] = numberValue(value, field);
    else if (field === 'currency') {
      if (value !== 'VND') throw new ProductPatchValidationError(field);
      updates.currency = 'VND';
    } else if (listFields.has(field)) updates[field] = listValue(value, field);
    else if (field === 'specifications') updates.specifications = specificationsValue(value);
  }
  return updates as Partial<Product>;
}

function valuesDiffer(product: Product, updates: Partial<Product>): boolean {
  return Object.entries(updates).some(([key, value]) => JSON.stringify(product[key as keyof Product]) !== JSON.stringify(value));
}

function readinessInvalidation(product: Product, updates: Partial<Product>): Partial<Product> {
  const changed = new Set(Object.keys(updates));
  const identityChanged = ['title', 'originalUrl', 'affiliateUrl', 'brand', 'sku', 'gtin', 'mpn'].some(field => changed.has(field));
  const priceChanged = changed.has('price') || changed.has('salePrice') || changed.has('currency');
  const reviewContent = product.reviewContent ? { ...product.reviewContent, reviewStatus: 'stale' as const } : undefined;
  return {
    autoPublishEligible: false,
    needsVerification: true,
    publicHidden: true,
    publicDecision: 'needs_review',
    publicBlockReasons: [...new Set([...(product.publicBlockReasons || []), 'owner_factual_edit_requires_reverification'])],
    status: 'needs_review',
    evidenceFactIds: [],
    evidenceCoverage: 0,
    evidenceSnapshotAt: undefined,
    evidenceSnapshotHash: undefined,
    confidences: undefined,
    claimValidationStatus: 'MISSING_EVIDENCE',
    duplicateStatus: identityChanged ? 'UNRESOLVED' : product.duplicateStatus,
    priceTruthState: priceChanged ? 'STALE' : product.priceTruthState,
    reviewContent,
    nextAutomaticAction: 'REVERIFY_OWNER_EDIT',
    nextRetryAt: undefined,
    relatedJobId: undefined,
    ...(changed.has('originalUrl') ? { linkHealthStatus: 'unverified' as const, linkLastCheckedAt: undefined, verifiedSource: false, sourceVerified: false } : {}),
    ...(changed.has('affiliateUrl') ? { affiliateHealthStatus: 'unverified' as const, affiliateLastCheckedAt: undefined } : {}),
    ...((changed.has('imageUrl') || changed.has('gallery')) ? { imageHealthStatus: 'unverified' as const, imageLastCheckedAt: undefined } : {}),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authError = await requirePermission(request, 'VIEW_PRODUCTS');
    if (authError) return authError;
    const { id } = await params;
    const product = await getProductById(id);
    if (!product) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }
    return successResponse('Đã tải sản phẩm.', product);
  } catch (err) {
    return serverErrorResponse('Không thể tải sản phẩm.', err);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authError = await requirePermission(request, 'EDIT_PRODUCTS');
    if (authError) return authError;
    const { id } = await params;
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json() as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON_OBJECT');
      body = parsed as Record<string, unknown>;
    } catch {
      return errorResponse('Dữ liệu JSON không hợp lệ.');
    }

    const autonomousFields = autonomousFieldNames(body);
    if (autonomousFields.length) {
      return NextResponse.json({
        ok: false,
        code: 'AUTONOMOUS_FIELDS_READ_ONLY',
        error: 'AUTONOMOUS_FIELDS_READ_ONLY',
        message: 'Trạng thái tự động chỉ được thay đổi bởi durable worker và policy phía máy chủ.',
        fields: autonomousFields.sort(),
      }, { status: 409 });
    }
    if (!Object.keys(body).length) return errorResponse('Không có trường sản phẩm hợp lệ để cập nhật.', 'VALIDATION_ERROR', 400);

    let editableUpdates: Partial<Product>;
    try {
      editableUpdates = normalizeEditableFields(body);
    } catch (error) {
      const field = error instanceof ProductPatchValidationError ? error.field : undefined;
      return NextResponse.json({ ok: false, code: 'PRODUCT_FIELDS_NOT_EDITABLE', error: 'PRODUCT_FIELDS_NOT_EDITABLE', message: 'Dữ liệu chỉnh sửa sản phẩm không hợp lệ.', field }, { status: 400 });
    }

    const current = await getProductById(id);
    if (!current) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }
    const nextPrice = Object.prototype.hasOwnProperty.call(editableUpdates, 'price') ? editableUpdates.price : current.price;
    const nextSalePrice = Object.prototype.hasOwnProperty.call(editableUpdates, 'salePrice') ? editableUpdates.salePrice : current.salePrice;
    if (nextPrice && nextSalePrice && nextSalePrice > nextPrice) {
      return NextResponse.json({ ok: false, code: 'PRODUCT_FIELDS_NOT_EDITABLE', error: 'PRODUCT_FIELDS_NOT_EDITABLE', message: 'Giá bán không được lớn hơn giá gốc.', field: 'salePrice' }, { status: 400 });
    }
    if (!valuesDiffer(current, editableUpdates)) return successResponse('Dữ liệu sản phẩm không thay đổi.', current);

    const invalidated = await updateProduct(id, { ...editableUpdates, ...readinessInvalidation(current, editableUpdates) });
    if (!invalidated) return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);

    const digest = createHash('sha256').update(JSON.stringify({ id, editableUpdates, updatedAt: invalidated.updatedAt })).digest('hex').slice(0, 32);
    const verification = await enqueueProductAction({
      actor: getServerActor(),
      action: 'health',
      productId: id,
      idempotencyKey: `owner-edit-reverify:${digest}`,
      reason: 'Owner factual edit requires server-side re-verification.',
    });
    const linked = await updateProduct(id, { relatedJobId: verification.job.id, nextAutomaticAction: 'RECHECK_PRODUCT_HEALTH' });
    return successResponse('Đã cập nhật sản phẩm và đưa kiểm tra lại vào hàng đợi.', linked || invalidated);
  } catch (err) {
    return serverErrorResponse('Không thể cập nhật sản phẩm.', err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await requirePermission(request, 'EDIT_PRODUCTS');
  if (authError) return authError;
  await params;
  return NextResponse.json({
    ok: false,
    code: 'ARCHIVE_REQUIRED',
    message: 'Không xóa sản phẩm trực tiếp. Hãy tạo tác vụ lưu trữ có phê duyệt.',
  }, { status: 409 });
}
