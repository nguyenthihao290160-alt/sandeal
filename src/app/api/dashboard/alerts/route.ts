import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { appendAutomationAudit, createAutomationJob, getAutomationControl } from '@/lib/automation/store';
import { readBoundedAutomationJobStatuses } from '@/lib/automation/jobHealthSummary';
import { readAlertDashboardView, updateAlertStatuses } from '@/lib/product-intelligence/alerts';
import { generateId } from '@/lib/storage/adapter';
import type { ProductAlert } from '@/lib/product-intelligence/types';

export const dynamic = 'force-dynamic';

const ALERT_MUTATION_MESSAGES: Record<string, string> = {
  REASON_REQUIRED: 'Cần nhập lý do bỏ qua ít nhất 5 ký tự.',
  RECHECK_EVIDENCE_REQUIRED: 'Không thể đánh dấu đã xử lý nếu chưa có bằng chứng kiểm tra lại hợp lệ.',
  INTERNAL_ERROR: 'Không thể cập nhật cảnh báo.',
};

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_ALERTS'); if (denied) return denied;
  const status = request.nextUrl.searchParams.get('status') as ProductAlert['status'] | null;
  if (status && !['new', 'acknowledged', 'in_progress', 'resolved', 'ignored'].includes(status)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  const [alertView, jobRead, control] = await Promise.all([
    readAlertDashboardView({ status: status || undefined, limit: 500 }),
    readBoundedAutomationJobStatuses(),
    getAutomationControl(),
  ]);
  const items = alertView.items;
  const jobs = jobRead.items;
  const latest = jobs.filter(job => job.type === 'EVALUATE_ALERTS').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const evidenceStatus = jobRead.evidenceClassification;
  return NextResponse.json({ ok: true, code: 'OK', data: {
    items,
    summary: alertView.summary,
    collectionEvidence: alertView.evidence,
    history: alertView.history,
    evaluation: {
      lastEvaluatedAt: latest?.completedAt || null,
      runStatus: latest?.status || (evidenceStatus === 'COMPLETE' ? 'NOT_STARTED' : 'UNKNOWN'),
      operationId: latest?.operationId || null,
      result: latest?.result ? {
        active: latest.result.active,
        created: latest.result.created,
        reopened: latest.result.reopened,
        resolved: latest.result.resolved,
        resolutionDeferred: latest.result.resolutionDeferred,
        jobEvidence: latest.result.jobEvidence,
      } : null,
      schedulerHeartbeatAt: control.schedulerHeartbeatAt || null,
      evidence: {
        status: evidenceStatus,
        reasonCodes: jobRead.reasonCodes,
        currentStateComplete: jobRead.currentStateComplete,
        historyComplete: jobRead.historyComplete,
        truncated: jobRead.truncated,
        retentionBoundary: jobRead.retentionBoundary,
        message: evidenceStatus === 'COMPLETE'
          ? 'Bằng chứng tác vụ đã đầy đủ trong phạm vi lưu giữ.'
          : 'Chưa thể xác minh đầy đủ lịch sử đánh giá cảnh báo; trạng thái thiếu không được hiểu là chưa từng chạy.',
      },
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
  const status = String(body.status || '');
  if (status === 'resolved') return NextResponse.json({
    ok: false,
    code: 'RECHECK_EVIDENCE_REQUIRED',
    message: 'Không thể đánh dấu đã xử lý trực tiếp; cảnh báo phải được kiểm tra lại và có bằng chứng đạt yêu cầu.',
  }, { status: 409 });
  if (!['new', 'acknowledged', 'in_progress', 'ignored'].includes(status)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
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
    const reasonCode = error instanceof Error ? error.message : '';
    const code = reasonCode === 'REASON_REQUIRED' || reasonCode === 'RECHECK_EVIDENCE_REQUIRED'
      ? reasonCode
      : 'INTERNAL_ERROR';
    return NextResponse.json({
      ok: false,
      code,
      message: ALERT_MUTATION_MESSAGES[code],
    }, {
      status: code === 'RECHECK_EVIDENCE_REQUIRED' ? 409 : code === 'REASON_REQUIRED' ? 400 : 500,
    });
  }
}
