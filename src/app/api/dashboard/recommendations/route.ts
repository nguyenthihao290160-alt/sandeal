import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { appendAutomationAudit } from '@/lib/automation/store';
import { generateRecommendedActions, updateRecommendedAction } from '@/lib/product-intelligence/alerts';
import { generateId } from '@/lib/storage/adapter';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_PRODUCTS'); if (denied) return denied;
  return NextResponse.json({ ok: true, code: 'OK', data: await generateRecommendedActions() }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function PATCH(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS'); if (denied) return denied;
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const status = String(body.status || ''); if (!['new', 'seen', 'snoozed', 'ignored'].includes(status)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  try {
    const data = await updateRecommendedAction(String(body.id || ''), status as never, typeof body.reason === 'string' ? body.reason : undefined);
    if (!data) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
    const operationId = generateId();
    await appendAutomationAudit({
      correlationId: operationId, operationId, operationType: 'RECOMMENDATION_STATUS_CHANGED', actor: getServerActor(),
      target: data.id, nextState: data.status, risk: 'LOW', reasons: typeof body.reason === 'string' ? [body.reason] : [], dryRun: false, attempts: 0,
    });
    return NextResponse.json({ ok: true, code: 'OK', operationId, data }, { headers: { 'Cache-Control': 'no-store', 'X-Operation-Id': operationId } });
  }
  catch (error) {
    const code = error instanceof Error && error.message === 'REASON_REQUIRED' ? 'REASON_REQUIRED' : 'INTERNAL_ERROR';
    return NextResponse.json({ ok: false, code, message: code === 'REASON_REQUIRED' ? 'Cần nhập lý do bỏ qua ít nhất 5 ký tự.' : 'Không thể cập nhật hành động đề xuất.' }, { status: code === 'REASON_REQUIRED' ? 400 : 500 });
  }
}
