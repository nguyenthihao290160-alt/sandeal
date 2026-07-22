import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { AutomationJobEnqueueError, createAutomationJob, listAutomationJobs, publicAutomationJob } from '@/lib/automation/store';
import type { AutomationJobStatus, AutomationJobType } from '@/lib/automation/types';
import { getAutomationPolicy, listAutomationPolicies } from '@/lib/automation/policyRegistry';

export const dynamic = 'force-dynamic';
const ALL_TYPES = new Set<AutomationJobType>(listAutomationPolicies().map(item => item.jobType));
const OWNER_TYPES = new Set<AutomationJobType>(listAutomationPolicies().filter(item => item.ownerEnqueueAllowed).map(item => item.jobType));
const STATUSES = new Set<AutomationJobStatus>(['PENDING','WAITING_APPROVAL','WAITING_FOR_MANUAL_INPUT','WAITING_CHILDREN','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED','BLOCKED','PAUSED']);

export async function GET(request: NextRequest) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (authError) return authError;
  const searchParams = request.nextUrl.searchParams;
  const page = Number(searchParams.get('page') || 1);
  const pageSize = Number(searchParams.get('pageSize') || 20);
  const status = searchParams.get('status') as AutomationJobStatus | null;
  const type = searchParams.get('type') as AutomationJobType | null;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 || (status && !STATUSES.has(status)) || (type && !ALL_TYPES.has(type))) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Bộ lọc tác vụ không hợp lệ.' }, { status: 400 });
  }
  const result = await listAutomationJobs({ page, pageSize, status: status || undefined, type: type || undefined });
  return NextResponse.json({
    ok: true,
    code: result.pagination.totalItems ? 'OK' : 'EMPTY',
    message: 'Đã tải hàng chờ tác vụ.',
    data: { ...result, items: result.items.map(publicAutomationJob) },
  });
}

export async function POST(request: NextRequest) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (authError) return authError;
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu tác vụ không hợp lệ.' }, { status: 400 });
  }

  const type = body.type as AutomationJobType;
  const dryRun = body.dryRun === true;
  if (!OWNER_TYPES.has(type)) {
    return NextResponse.json({ ok: false, code: 'SYSTEM_JOB_ONLY', message: 'Loại tác vụ này chỉ được tạo bởi scheduler hoặc durable worker.' }, { status: 403 });
  }
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  const policy = getAutomationPolicy(type);
  try {
    const result = await createAutomationJob({
      type,
      payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {},
      idempotencyKey,
      operationId: typeof body.operationId === 'string' ? body.operationId : undefined,
      requestedBy: getServerActor(),
      riskLevel: policy.defaultRisk,
      dryRun,
      priority: Number(body.priority) || 50,
      maxAttempts: Number(body.maxAttempts) || 3,
      approvalReason: policy.approvalMode === 'REQUIRED' ? 'Policy yêu cầu chủ sở hữu phê duyệt tác vụ này.' : undefined,
    });
    const responseCode = result.created
      ? 'CREATED'
      : result.code === 'ALREADY_PROCESSED'
        ? 'COMPLETED_RECENTLY'
        : 'REUSED_ACTIVE_JOB';
    return NextResponse.json({
      ok: true,
      code: responseCode,
      message: result.created
        ? 'Đã xếp tác vụ vào hàng đợi.'
        : responseCode === 'COMPLETED_RECENTLY'
          ? 'Tác vụ cùng phạm vi vừa hoàn tất; đang dùng lại kết quả gần nhất.'
          : 'Đã có tác vụ cùng phạm vi trong hàng đợi hoặc đang xử lý.',
      data: publicAutomationJob(result.job),
    }, { status: result.created ? 201 : 200 });
  } catch (error) {
    const code = error instanceof AutomationJobEnqueueError
      ? error.code
      : error instanceof Error && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'AUTOMATION_ENQUEUE_FAILED';
    const messages: Record<string, string> = {
      INVALID_IDEMPOTENCY_KEY: 'Mã chống thực hiện trùng không hợp lệ.',
      DAILY_PRODUCT_LIMIT_REACHED: 'Đã đạt giới hạn sản phẩm xử lý trong ngày Việt Nam.',
      PAYLOAD_TOO_LARGE: 'Dữ liệu tác vụ vượt giới hạn cho phép.',
      STORAGE_LOCK_TIMEOUT: 'Hàng đợi đang bận. Vui lòng thử lại sau; không có tác vụ trùng nào được tạo.',
      AUTOMATION_JOB_TYPE_UNSUPPORTED: 'Worker chưa hỗ trợ loại tác vụ này.',
      SCHEMA_VALIDATION_FAILED: 'Dữ liệu tác vụ không đúng hợp đồng xử lý.',
    };
    const status = code === 'DAILY_PRODUCT_LIMIT_REACHED' ? 409
      : code === 'STORAGE_LOCK_TIMEOUT' ? 503
        : code === 'AUTOMATION_ENQUEUE_FAILED' ? 500
          : 400;
    return NextResponse.json({ ok: false, code, message: messages[code] || 'Không thể xếp tác vụ vào hàng đợi.' }, { status });
  }
}
