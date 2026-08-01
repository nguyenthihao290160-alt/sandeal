import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildAutomationHealthResponse } from '@/lib/automation/healthService';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  try {
    // Opening or refreshing App Health is observational only. Repair creation
    // is deliberately confined to the explicit POST Retry action below.
    const data = await buildAutomationHealthResponse({ signal: request.signal });
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

export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  try {
    const data = await buildAutomationHealthResponse({
      signal: request.signal,
      scheduleProjectionMaintenance: true,
    });
    const repairStatus = data.projectionMaintenance?.status;
    const code = repairStatus === 'REQUESTED'
      ? 'JOB_HEALTH_PROJECTION_REBUILD_REQUESTED'
      : repairStatus === 'REUSED_ACTIVE_REQUEST'
        ? 'JOB_HEALTH_PROJECTION_REBUILD_REUSED'
        : repairStatus === 'BACKOFF'
          ? 'JOB_HEALTH_PROJECTION_REBUILD_BACKOFF'
          : repairStatus === 'EXHAUSTED'
            ? 'JOB_HEALTH_PROJECTION_REBUILD_EXHAUSTED'
            : repairStatus === 'NOT_REQUIRED'
              ? 'JOB_HEALTH_PROJECTION_REBUILD_NOT_REQUIRED'
              : 'JOB_HEALTH_PROJECTION_REBUILD_NOT_SCHEDULED';
    return NextResponse.json({
      ok: true,
      code,
      // The browser maps the stable code/status to Vietnamese copy. Keep the
      // transport message intentionally generic and free of storage details.
      message: 'Projection repair retry evaluated.',
      data,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    console.error(JSON.stringify({
      type: 'automation_health_projection_retry_failed',
      reasonCode: 'APP_HEALTH_PROJECTION_RETRY_UNEXPECTED_FAILURE',
    }));
    return NextResponse.json({
      ok: false,
      code: 'APP_HEALTH_PROJECTION_RETRY_UNAVAILABLE',
      message: 'Projection repair scheduling is unavailable. Current data was not changed.',
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
