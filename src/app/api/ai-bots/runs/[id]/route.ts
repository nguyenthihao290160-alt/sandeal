import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getBotRunById } from '@/lib/storage/botRuns';
import type { DashboardOperation, DashboardOperationStatus } from '@/lib/dashboard/operations';

export const dynamic = 'force-dynamic';

function operationStatus(status: string): DashboardOperationStatus {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'pending';
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const run = await getBotRunById(id);
  if (!run) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy tác vụ bot.' }, { status: 404 });
  }

  const status = operationStatus(run.status);
  const final = ['completed', 'failed', 'cancelled'].includes(status);
  const operation: DashboardOperation = {
    operationId: run.id,
    jobId: run.id,
    status,
    progress: status === 'completed' ? 100 : null,
    result: final ? {
      candidatesFound: run.candidatesFound,
      productsSaved: run.productsSaved,
      linksChecked: run.linksChecked,
      productsArchived: run.productsArchived,
      errorCount: run.errorCount,
    } : null,
    errorCode: status === 'failed' ? 'BOT_RUN_FAILED' : null,
    message: status === 'completed'
      ? 'Tác vụ bot đã hoàn thành.'
      : status === 'failed'
        ? 'Tác vụ bot thất bại. Dữ liệu đã hoàn tất trước thời điểm lỗi được giữ nguyên. Vui lòng kiểm tra kết nối rồi thử lại.'
        : status === 'cancelled'
          ? 'Tác vụ bot đã bị hủy.'
          : status === 'running'
            ? 'Bot đang xử lý số lượng giới hạn trong chế độ an toàn.'
            : 'Tác vụ đang chờ bộ xử lý bắt đầu.',
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    updatedAt: run.completedAt || run.startedAt,
    canCancel: false,
    canRetry: status === 'failed',
    requiresApproval: false,
  };
  return NextResponse.json({ ok: true, code: 'OK', message: operation.message, data: operation }, { headers: { 'Cache-Control': 'no-store' } });
}
