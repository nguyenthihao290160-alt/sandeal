import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { createAutomationJob, listAutomationJobs, publicAutomationJob } from '@/lib/automation/store';
import type { AutomationJobStatus, AutomationJobType } from '@/lib/automation/types';
import { getAutomationPolicy, listAutomationPolicies } from '@/lib/automation/policyRegistry';

export const dynamic = 'force-dynamic';
const ALL_TYPES = new Set<AutomationJobType>(listAutomationPolicies().map(item => item.jobType));
const OWNER_TYPES = new Set<AutomationJobType>(listAutomationPolicies().filter(item => item.ownerEnqueueAllowed).map(item => item.jobType));
const STATUSES = new Set<AutomationJobStatus>(['PENDING','WAITING_APPROVAL','WAITING_FOR_MANUAL_INPUT','WAITING_CHILDREN','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED','BLOCKED','PAUSED']);

export async function GET(request: NextRequest) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION'); if (authError) return authError;
  const sp = request.nextUrl.searchParams;
  const page = Number(sp.get('page') || 1); const pageSize = Number(sp.get('pageSize') || 20);
  const status = sp.get('status') as AutomationJobStatus | null; const type = sp.get('type') as AutomationJobType | null;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 || (status && !STATUSES.has(status)) || (type && !ALL_TYPES.has(type))) {
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
  if (!OWNER_TYPES.has(type)) return NextResponse.json({ ok: false, code: 'SYSTEM_JOB_ONLY', message: 'Loại tác vụ này chỉ được tạo bởi scheduler hoặc durable worker.' }, { status: 403 });
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  const policy = getAutomationPolicy(type);
  const riskLevel = policy.defaultRisk;
  try {
    const result = await createAutomationJob({ type, payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {},
      idempotencyKey, operationId: typeof body.operationId === 'string' ? body.operationId : undefined, requestedBy: getServerActor(),
      riskLevel, dryRun, priority: Number(body.priority) || 50, maxAttempts: Number(body.maxAttempts) || 3,
      approvalReason: policy.approvalMode === 'REQUIRED' ? 'Policy yêu cầu chủ sở hữu phê duyệt tác vụ này.' : undefined });
    return NextResponse.json({ ok: true, code: result.code, message: result.created ? 'Đã tạo tác vụ.' : result.code === 'ALREADY_PROCESSED' ? 'Tác vụ đã được hoàn thành trước đó.' : 'Tác vụ đã tồn tại và đang được xử lý.', data: publicAutomationJob(result.job) }, { status: result.created ? 201 : 200 });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : 'VALIDATION_ERROR';
    const dailyLimitReached = code === 'DAILY_PRODUCT_LIMIT_REACHED';
    return NextResponse.json({ ok: false, code, message: dailyLimitReached ? 'Đã đạt giới hạn sản phẩm xử lý trong ngày Việt Nam.' : code === 'PAYLOAD_TOO_LARGE' ? 'Dữ liệu tác vụ vượt giới hạn cho phép.' : 'Mã chống thực hiện trùng không hợp lệ.' }, { status: dailyLimitReached ? 409 : 400 });
  }
}
