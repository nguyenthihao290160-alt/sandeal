import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listAutomationAudit } from '@/lib/automation/store';
import { getRedactedCorrelationTrace } from '@/lib/automation/correlationTrace';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  const operationId = request.nextUrl.searchParams.get('operationId');
  if (operationId) {
    try {
      return NextResponse.json({
        ok: true,
        code: 'OK',
        message: 'Đã tải chuỗi tương quan đã rút gọn.',
        data: await getRedactedCorrelationTrace(operationId),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'CORRELATION_ID_INVALID') {
        return NextResponse.json({
          ok: false,
          code: 'VALIDATION_ERROR',
          message: 'Mã tương quan không hợp lệ.',
        }, { status: 400 });
      }
      throw error;
    }
  }
  const page = Number(request.nextUrl.searchParams.get('page') || 1); const pageSize = Number(request.nextUrl.searchParams.get('pageSize') || 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Phân trang không hợp lệ.' }, { status: 400 });
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải nhật ký kiểm soát.', data: await listAutomationAudit(page, pageSize) });
}
