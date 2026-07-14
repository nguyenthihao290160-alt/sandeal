import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission, type AdminPermission } from '@/lib/auth';
import { getQualityDashboard } from '@/lib/product-intelligence/insights';
import { appendAutomationAudit, createAutomationJob } from '@/lib/automation/store';
import { previewDuplicateMerge, reviewDuplicateGroup } from '@/lib/product-intelligence/dedupe';
import { getAllProducts } from '@/lib/storage/products';
import { generateId } from '@/lib/storage/adapter';
import type { DuplicateGroup } from '@/lib/product-intelligence/types';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

function duplicateGroupDto(group: DuplicateGroup, products: Map<string, Product>) {
  return {
    id: group.id,
    productIds: group.productIds,
    candidates: group.candidates.map(candidate => ({
      productId: candidate.productId,
      confidence: candidate.confidence,
      matchedSignals: candidate.matchedSignals.slice(0, 20),
      differentSignals: candidate.differentSignals.slice(0, 20),
      reason: candidate.reason,
    })),
    products: group.productIds.map(id => products.get(id)).filter((item): item is Product => Boolean(item)).map(product => ({
      id: product.id,
      title: product.title,
      source: product.source,
      platform: product.platform,
      qualityScore: product.qualityScore,
      status: product.status,
      verifiedSource: Boolean(product.verifiedSource || product.sourceVerified),
      updatedAt: product.updatedAt,
    })),
    suggestedPrimaryId: group.suggestedPrimaryId,
    confidence: group.confidence,
    status: group.status,
    reason: group.reason,
    calculatedAt: group.calculatedAt,
    algorithmVersion: group.algorithmVersion,
    operationId: group.operationId,
    reviewedAt: group.reviewedAt,
    reviewedBy: group.reviewedBy,
    hasMergeHistory: Boolean(group.mergeHistory?.length),
  };
}

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_PRODUCTS');
  if (denied) return denied;
  const page = Number(request.nextUrl.searchParams.get('page') || 1);
  const pageSize = Number(request.nextUrl.searchParams.get('pageSize') || 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Phân trang không hợp lệ.' }, { status: 400 });
  }
  const [data, products] = await Promise.all([getQualityDashboard(page, pageSize), getAllProducts()]);
  const productMap = new Map(products.map(product => [product.id, product]));
  return NextResponse.json({
    ok: true,
    code: 'OK',
    data: { ...data, duplicateGroups: data.duplicateGroups.map(group => duplicateGroupDto(group, productMap)) },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const viewDenied = await requirePermission(request, 'VIEW_PRODUCTS');
  if (viewDenied) return viewDenied;
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 64 * 1024) {
    return NextResponse.json({ ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Payload vượt giới hạn cho phép.' }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ.' }, { status: 400 });
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const permission: AdminPermission = action === 'merge_preview' || action === 'merge_apply'
    ? 'MERGE_DUPLICATES'
    : action === 'detect_duplicates' || action === 'review_keep' || action === 'review_ignore'
      ? 'REVIEW_DUPLICATES'
      : 'RUN_QUALITY_CHECK';
  const denied = await requirePermission(request, permission);
  if (denied) return denied;

  if (action === 'merge_preview') {
    try {
      const preview = await previewDuplicateMerge(String(body.groupId || ''), String(body.primaryId || ''));
      return NextResponse.json({
        ok: true,
        code: 'PREVIEW',
        data: {
          groupId: preview.groupId,
          primaryId: preview.primaryId,
          secondaryIds: preview.secondaryIds,
          filledFields: preview.filledFields,
          conflicts: preview.conflicts,
          businessDataChanged: false,
          requiresApproval: true,
        },
      });
    } catch {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Nhóm trùng hoặc bản chính không hợp lệ.' }, { status: 400 });
    }
  }

  if (action === 'review_keep' || action === 'review_ignore') {
    const actor = getServerActor();
    const operationId = `duplicate-review:${generateId()}`;
    try {
      const group = await reviewDuplicateGroup(
        String(body.groupId || '').slice(0, 160),
        action === 'review_keep' ? 'kept_separate' : 'ignored',
        typeof body.reason === 'string' ? body.reason : '',
        { actor, operationId },
      );
      if (!group) return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy nhóm trùng.' }, { status: 404 });
      await appendAutomationAudit({
        correlationId: operationId,
        operationId,
        operationType: 'DUPLICATE_REVIEW',
        actor,
        target: group.id,
        previousState: 'pending',
        nextState: group.status,
        risk: 'LOW',
        result: { status: group.status, businessDataChanged: false },
        reasons: [group.reason || 'reviewed'],
        dryRun: false,
        attempts: 1,
      });
      const products = new Map((await getAllProducts()).map(product => [product.id, product]));
      return NextResponse.json({ ok: true, code: 'REVIEW_SAVED', message: 'Đã lưu quyết định xem xét và lý do.', data: duplicateGroupDto(group, products) });
    } catch (error) {
      const code = error instanceof Error && error.message === 'REASON_REQUIRED' ? 'REASON_REQUIRED' : 'VALIDATION_ERROR';
      return NextResponse.json({ ok: false, code, message: code === 'REASON_REQUIRED' ? 'Lý do phải có ít nhất 5 ký tự.' : 'Không thể lưu quyết định xem xét.' }, { status: 400 });
    }
  }

  const type = action === 'score'
    ? 'SCORE_PRODUCTS'
    : action === 'detect_duplicates'
      ? 'DETECT_DUPLICATES'
      : action === 'merge_apply'
        ? 'BULK_PRODUCT_OPERATION'
        : '';
  if (!type) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Thao tác không hợp lệ.' }, { status: 400 });
  if (action === 'merge_apply' && body.confirmed !== true) {
    return NextResponse.json({ ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Hợp nhất cần xác nhận và phê duyệt.' }, { status: 409 });
  }
  if (action === 'merge_apply') {
    try {
      await previewDuplicateMerge(String(body.groupId || ''), String(body.primaryId || ''));
    } catch {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Nhóm trùng hoặc bản chính không hợp lệ.' }, { status: 400 });
    }
  }
  const operationId = typeof body.operationId === 'string' && body.operationId.trim()
    ? body.operationId.trim().slice(0, 160)
    : `quality:${generateId()}`;
  const key = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim().slice(0, 160)
    : `${action}:${String(body.groupId || 'all').slice(0, 120)}:${new Date().toISOString().slice(0, 13)}`;
  try {
    const result = await createAutomationJob({
      type,
      payload: action === 'merge_apply'
        ? { action: 'merge_duplicates', groupId: body.groupId, primaryId: body.primaryId }
        : { productIds: body.productIds },
      idempotencyKey: key,
      operationId,
      requestedBy: getServerActor(),
      riskLevel: action === 'merge_apply' ? 'HIGH' : 'MEDIUM',
      dryRun: action === 'merge_apply' ? false : body.dryRun === true,
      approvalReason: action === 'merge_apply' ? 'Hợp nhất metadata và lưu trữ bản phụ cần phê duyệt.' : undefined,
    });
    return NextResponse.json({
      ok: true,
      code: result.code,
      message: action === 'merge_apply' ? 'Đã tạo tác vụ HIGH, đang chờ phê duyệt.' : 'Đã tạo tác vụ chất lượng.',
      data: { jobId: result.job.id, operationId: result.job.operationId, status: result.job.status, approvalStatus: result.job.approvalStatus },
    }, { status: result.created ? 201 : 200 });
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Không thể tạo tác vụ chất lượng.' }, { status: 400 });
  }
}
