import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { listManualTasks } from '@/lib/automation/manualTasks';
import type { ManualTaskStatus } from '@/lib/automation/types';

export const dynamic = 'force-dynamic';

const STATUSES = new Set<ManualTaskStatus>(['WAITING', 'DRAFT', 'SUBMITTED', 'REVISION_REQUIRED', 'COMPLETED', 'EXPIRED', 'CANCELLED']);

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (denied) return denied;
  const status = request.nextUrl.searchParams.get('status') as ManualTaskStatus | null;
  const page = Number(request.nextUrl.searchParams.get('page') || 1);
  const pageSize = Number(request.nextUrl.searchParams.get('pageSize') || 20);
  if ((status && !STATUSES.has(status)) || !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Bộ lọc công việc thủ công không hợp lệ.' }, { status: 400 });
  }
  const data = await listManualTasks({ status: status || undefined, page, pageSize });
  return NextResponse.json({ ok: true, code: data.pagination.totalItems ? 'OK' : 'EMPTY', message: 'Đã tải hộp thư công việc thủ công.', data }, { headers: { 'Cache-Control': 'no-store' } });
}
