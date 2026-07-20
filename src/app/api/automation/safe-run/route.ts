import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { createAutomationJob, publicAutomationJob } from '@/lib/automation/store';
import { getAutomationSettings } from '@/lib/storage/automationSettings';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (denied) return denied;
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu chạy thử không hợp lệ.' }, { status: 400 }); }
  const requestKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!/^[a-zA-Z0-9:_-]{8,140}$/.test(requestKey)) {
    return NextResponse.json({ ok: false, code: 'INVALID_IDEMPOTENCY_KEY', message: 'Thiếu mã chống bấm lặp hợp lệ.' }, { status: 400 });
  }
  const settings = await getAutomationSettings();
  const requestedLimit = Number(body.limit);
  const limit = Math.max(1, Math.min(settings.maxItemsPerRun, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : settings.maxItemsPerRun));
  const result = await createAutomationJob({
    type: 'AUTO_PILOT',
    payload: { mode: 'full_safe_run', trigger: 'dashboard-safe-run', limit, safeRun: true },
    priority: 70,
    idempotencyKey: `safe-run:${requestKey}`,
    requestedBy: getServerActor(),
    dryRun: true,
    requestedExecutionMode: 'LOCAL_ONLY',
  });
  return NextResponse.json({
    ok: true,
    code: result.code,
    message: result.created ? 'Đã tạo tác vụ chạy thử.' : 'Tác vụ chạy thử tương ứng đã tồn tại.',
    data: publicAutomationJob(result.job),
  }, { status: result.created ? 201 : 200, headers: { 'Cache-Control': 'no-store' } });
}
