import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { appendAutomationAudit } from '@/lib/automation/store';
import { listAlerts, updateAlertStatus } from '@/lib/product-intelligence/alerts';
import { generateId } from '@/lib/storage/adapter';
import type { ProductAlert } from '@/lib/product-intelligence/types';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS'); if (denied) return denied;
  const status = request.nextUrl.searchParams.get('status') as ProductAlert['status'] | null;
  if (status && !['new', 'acknowledged', 'in_progress', 'resolved', 'ignored'].includes(status)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  return NextResponse.json({ ok: true, code: 'OK', data: await listAlerts({ status: status || undefined, limit: 500 }) }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function PATCH(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS'); if (denied) return denied;
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const status = String(body.status || ''); if (!['new', 'acknowledged', 'in_progress', 'resolved', 'ignored'].includes(status)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  try {
    const data = await updateAlertStatus(String(body.id || ''), status as never, typeof body.reason === 'string' ? body.reason : undefined);
    if (!data) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
    const operationId = generateId();
    await appendAutomationAudit({
      correlationId: operationId, operationId, operationType: 'ALERT_STATUS_CHANGED', actor: getServerActor(),
      target: data.id, nextState: data.status, risk: 'LOW', reasons: typeof body.reason === 'string' ? [body.reason] : [], dryRun: false, attempts: 0,
    });
    return NextResponse.json({ ok: true, code: 'OK', operationId, data }, { headers: { 'Cache-Control': 'no-store', 'X-Operation-Id': operationId } });
  }
  catch (error) {
    const code = error instanceof Error && error.message === 'REASON_REQUIRED' ? 'REASON_REQUIRED' : 'INTERNAL_ERROR';
    return NextResponse.json({ ok: false, code, message: code === 'REASON_REQUIRED' ? 'Cần nhập lý do bỏ qua ít nhất 5 ký tự.' : 'Không thể cập nhật cảnh báo.' }, { status: code === 'REASON_REQUIRED' ? 400 : 500 });
  }
}
