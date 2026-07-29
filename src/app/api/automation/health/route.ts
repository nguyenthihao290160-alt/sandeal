import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildAutomationHealthResponse } from '@/lib/automation/healthService';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  try {
    const data = await buildAutomationHealthResponse();
    return NextResponse.json({
      ok: true,
      code: data.partial ? 'DEGRADED_HEALTH' : 'OK',
      message: data.partial
        ? 'Một số thành phần sức khỏe chưa được xác minh; dữ liệu đã xác minh vẫn được giữ lại.'
        : 'Đã kiểm tra hệ thống tự động hóa.',
      data,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    console.error(JSON.stringify({
      type: 'automation_health_request_failed',
      reasonCode: 'APP_HEALTH_UNEXPECTED_FAILURE',
    }));
    return NextResponse.json({
      ok: false,
      code: 'APP_HEALTH_UNAVAILABLE',
      message: 'Không thể xác minh sức khỏe hệ thống lúc này. Dữ liệu hiện tại không bị thay đổi.',
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
