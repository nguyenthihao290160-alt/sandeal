import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { createAutomationJob, listAutomationJobs, publicAutomationJob } from '@/lib/automation/store';
import type { AutomationJobStatus, AutomationJobType } from '@/lib/automation/types';

export const dynamic = 'force-dynamic';
const TYPES = new Set<AutomationJobType>([
  'PRODUCT_SCAN',
  'AUTO_PILOT',
  'SAFE_PUBLISH',
  'AI_ANALYSIS',
  'HEALTH_CHECK',
  'IMPORT_PRODUCTS',
  'RECHECK_PRODUCT_HEALTH',
  'DETECT_DUPLICATES',
  'SCORE_PRODUCTS',
  'CAPTURE_PRICE_HISTORY',
  'PREPARE_CONTENT_DRAFT',
  'EDITORIAL_CHECK',
  'EVALUATE_ALERTS',
  'AGGREGATE_GROWTH_METRICS',
  'BULK_PRODUCT_OPERATION',
]);
const STATUSES = new Set<AutomationJobStatus>(['PENDING','WAITING_APPROVAL','WAITING_FOR_MANUAL_INPUT','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED','BLOCKED','PAUSED']);

export async function GET(request: NextRequest) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION'); if (authError) return authError;
  const sp = request.nextUrl.searchParams;
  const page = Number(sp.get('page') || 1); const pageSize = Number(sp.get('pageSize') || 20);
  const status = sp.get('status') as AutomationJobStatus | null; const type = sp.get('type') as AutomationJobType | null;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 || (status && !STATUSES.has(status)) || (type && !TYPES.has(type))) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Bộ lọc tác vụ không hợp lệ.' }, { status: 400 });
  }
  const result = await listAutomationJobs({ page, pageSize, status: status || undefined, type: type || undefined });
  return NextResponse.json({ ok: true, code: result.pagination.totalItems ? 'OK' : 'EMPTY', message: 'Đã tải hàng chờ tác vụ.', data: { ...result, items: result.items.map(publicAutomationJob) } });
}

export async function POST(request: NextRequest) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION'); if (authError) return authError;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu tác vụ không hợp lệ.' }, { status: 400 }); }
  const type = body.type as AutomationJobType; const dryRun = body.dryRun === true;
  if (!TYPES.has(type)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Loại tác vụ không hợp lệ.' }, { status: 400 });
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  const riskLevel = dryRun || type === 'HEALTH_CHECK'
    ? 'LOW'
    : ['AUTO_PILOT','SAFE_PUBLISH','AI_ANALYSIS','PRODUCT_SCAN','BULK_PRODUCT_OPERATION'].includes(type)
      ? 'HIGH'
      : 'MEDIUM';
  try {
    const result = await createAutomationJob({ type, payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {},
      idempotencyKey, operationId: typeof body.operationId === 'string' ? body.operationId : undefined, requestedBy: getServerActor(),
      riskLevel, dryRun, priority: Number(body.priority) || 50, maxAttempts: Number(body.maxAttempts) || 3,
      approvalReason: riskLevel === 'HIGH' ? 'Tác vụ có thể tạo side effect và cần quản trị viên phê duyệt.' : undefined });
    return NextResponse.json({ ok: true, code: result.code, message: result.created ? 'Đã tạo tác vụ.' : result.code === 'ALREADY_PROCESSED' ? 'Tác vụ đã được hoàn thành trước đó.' : 'Tác vụ đã tồn tại và đang được xử lý.', data: publicAutomationJob(result.job) }, { status: result.created ? 201 : 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'VALIDATION_ERROR';
    return NextResponse.json({ ok: false, code, message: code === 'PAYLOAD_TOO_LARGE' ? 'Dữ liệu tác vụ vượt giới hạn cho phép.' : 'Mã chống thực hiện trùng không hợp lệ.' }, { status: 400 });
  }
}
