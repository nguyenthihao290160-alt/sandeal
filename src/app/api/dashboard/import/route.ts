import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { previewCsvImport, previewManualUrl, submitPendingManualSource } from '@/lib/product-intelligence/importer';
import { appendAutomationAudit, createAutomationJob } from '@/lib/automation/store';
import { generateId } from '@/lib/storage/adapter';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'IMPORT_PRODUCTS'); if (denied) return denied;
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu import không hợp lệ.' }, { status: 400 }); }
  const mode = String(body.mode || '');
  try {
    if (mode === 'preview') {
      if (typeof body.csv !== 'string') throw new Error('CSV_REQUIRED');
      const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping as Record<string, string> : {};
      return NextResponse.json({ ok: true, code: 'PREVIEW', message: 'Đã kiểm tra CSV; chưa thay đổi sản phẩm và chưa public.', data: await previewCsvImport(body.csv, mapping) });
    }
    if (mode === 'manual') {
      const data = previewManualUrl(String(body.url || ''));
      return NextResponse.json({
        ok: data.valid,
        code: data.valid ? 'METADATA_REQUIRED' : 'UNSAFE_URL',
        message: data.valid ? data.reason : 'URL không an toàn hoặc không được hỗ trợ.',
        data,
      }, { status: data.valid ? 200 : 400 });
    }
    if (mode === 'manual_submit') {
      const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : {};
      const actor = getServerActor();
      const operationId = `manual-source:${generateId()}`;
      const result = await submitPendingManualSource({
        url: String(body.url || ''),
        title: typeof metadata.title === 'string' ? metadata.title : '',
        affiliateUrl: typeof metadata.affiliateUrl === 'string' ? metadata.affiliateUrl : undefined,
        imageUrl: typeof metadata.imageUrl === 'string' ? metadata.imageUrl : undefined,
        price: typeof metadata.price === 'string' || typeof metadata.price === 'number' ? metadata.price : undefined,
        salePrice: typeof metadata.salePrice === 'string' || typeof metadata.salePrice === 'number' ? metadata.salePrice : undefined,
        platform: typeof metadata.platform === 'string' ? metadata.platform : undefined,
        category: typeof metadata.category === 'string' ? metadata.category : undefined,
        brand: typeof metadata.brand === 'string' ? metadata.brand : undefined,
        sku: typeof metadata.sku === 'string' ? metadata.sku : undefined,
        externalId: typeof metadata.externalId === 'string' ? metadata.externalId : undefined,
      }, { actor, operationId });
      await appendAutomationAudit({
        correlationId: operationId,
        operationId,
        operationType: 'MANUAL_SOURCE_SUBMITTED',
        actor,
        target: result.source.id,
        previousState: result.created ? undefined : 'pending_review',
        nextState: 'pending_review',
        risk: 'LOW',
        result: { created: result.created, adapterSupported: false, publicSideEffect: false },
        reasons: ['manual_metadata_submitted', 'adapter_not_supported'],
        dryRun: false,
        attempts: 1,
      });
      return NextResponse.json({
        ok: true,
        code: result.created ? 'PENDING_SOURCE_CREATED' : 'PENDING_SOURCE_UPDATED',
        message: 'Đã lưu nguồn chờ xử lý. Hệ thống chưa tải URL, chưa tạo sản phẩm và chưa public dữ liệu.',
        data: { ...result, operationId },
      }, { status: result.created ? 201 : 200 });
    }
    if (mode === 'apply') {
      const previewId = String(body.previewId || ''); if (!previewId) throw new Error('PREVIEW_REQUIRED');
      const result = await createAutomationJob({
        type: 'IMPORT_PRODUCTS', payload: { previewId }, idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `import:${previewId}`,
        operationId: typeof body.operationId === 'string' ? body.operationId : undefined, requestedBy: getServerActor(), riskLevel: 'MEDIUM', dryRun: body.dryRun === true,
      });
      return NextResponse.json({ ok: true, code: result.code, message: 'Đã đưa import vào hàng chờ; sản phẩm sẽ không tự public.', data: { jobId: result.job.id, operationId: result.job.operationId, status: result.job.status } }, { status: result.created ? 201 : 200 });
    }
    throw new Error('INVALID_MODE');
  } catch (error) {
    const code = error instanceof Error ? error.message : 'VALIDATION_ERROR';
    return NextResponse.json({ ok: false, code, message: 'Không thể xử lý import. Hãy kiểm tra kích thước, mapping và dữ liệu từng dòng.' }, { status: 400 });
  }
}
