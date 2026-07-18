import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { appendAutomationAudit, createAutomationJob, getAllAutomationJobs, getAutomationControl } from '@/lib/automation/store';
import { listAlerts, updateAlertStatuses } from '@/lib/product-intelligence/alerts';
import { generateId } from '@/lib/storage/adapter';
import type { ProductAlert } from '@/lib/product-intelligence/types';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS'); if (denied) return denied;
  const status = request.nextUrl.searchParams.get('status') as ProductAlert['status'] | null;
  if (status && !['new', 'acknowledged', 'in_progress', 'resolved', 'ignored'].includes(status)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  const [items, jobs, control] = await Promise.all([listAlerts({ status: status || undefined, limit: 500 }), getAllAutomationJobs(), getAutomationControl()]);
  const latest = jobs.filter(job => job.type === 'EVALUATE_ALERTS').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const unresolved = items.filter(item => !['resolved', 'ignored'].includes(item.status));
  return NextResponse.json({ ok: true, code: 'OK', data: {
    items,
    summary: {
      total: items.length,
      unresolved: unresolved.length,
      critical: unresolved.filter(item => item.severity === 'critical').length,
      important: unresolved.filter(item => item.severity === 'important').length,
      resolved: items.filter(item => item.status === 'resolved').length,
    },
    evaluation: {
      lastEvaluatedAt: latest?.completedAt || null,
      runStatus: latest?.status || 'NOT_STARTED',
      operationId: latest?.operationId || null,
      result: latest?.result ? { active: latest.result.active, created: latest.result.created, reopened: latest.result.reopened, resolved: latest.result.resolved } : null,
      schedulerHeartbeatAt: control.schedulerHeartbeatAt || null,
    },
    updatedAt: new Date().toISOString(),
  } }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS'); if (denied) return denied;
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { /* optional body */ }
  try {
    const result = await createAutomationJob({
      type: 'EVALUATE_ALERTS', payload: {},
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `alerts:evaluate:${new Date().toISOString().slice(0, 13)}`,
      operationId: typeof body.operationId === 'string' ? body.operationId : undefined,
      requestedBy: getServerActor(), riskLevel: 'LOW', dryRun: body.dryRun === true,
      botId: 'ALERT_METRICS_ENGINE', capability: 'EVALUATE_ALERTS', requestedExecutionMode: 'LOCAL_ONLY',
      executionPlan: [{ id: 'evaluate-alerts', capability: 'EVALUATE_ALERTS', dependsOn: [], reason: 'Đánh giá cảnh báo có dedupe và cooldown.', status: 'PENDING', risk: 'LOW', approvalRequired: false, expectedWrite: ['product-alerts'], externalCall: false, fallback: ['LOCAL_RULES'] }],
    });
    return NextResponse.json({ ok: true, code: result.code, message: 'Đã đưa đánh giá cảnh báo vào hàng đợi.', data: { jobId: result.job.id, operationId: result.job.operationId, status: result.job.status, trackingRoute: `/api/automation/jobs/${result.job.id}` } }, { status: result.created ? 202 : 200 });
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Không thể tạo tác vụ đánh giá cảnh báo.' }, { status: 400 });
  }
}
export async function PATCH(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS'); if (denied) return denied;
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const status = String(body.status || ''); if (!['new', 'acknowledged', 'in_progress', 'resolved', 'ignored'].includes(status)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  try {
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 100) : [String(body.id || '')];
    const data = await updateAlertStatuses(ids, status as never, typeof body.reason === 'string' ? body.reason : undefined);
    if (!data.length) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
    const operationId = generateId();
    await appendAutomationAudit({
      correlationId: operationId, operationId, operationType: 'ALERT_STATUS_CHANGED', actor: getServerActor(),
      target: data.map(item => item.id).join(','), nextState: status, risk: 'LOW', reasons: typeof body.reason === 'string' ? [body.reason] : [], dryRun: false, attempts: 0,
    });
    return NextResponse.json({ ok: true, code: 'OK', operationId, data }, { headers: { 'Cache-Control': 'no-store', 'X-Operation-Id': operationId } });
  }
  catch (error) {
    const code = error instanceof Error && error.message === 'REASON_REQUIRED' ? 'REASON_REQUIRED' : 'INTERNAL_ERROR';
    return NextResponse.json({ ok: false, code, message: code === 'REASON_REQUIRED' ? 'Cần nhập lý do bỏ qua ít nhất 5 ký tự.' : 'Không thể cập nhật cảnh báo.' }, { status: code === 'REASON_REQUIRED' ? 400 : 500 });
  }
}
