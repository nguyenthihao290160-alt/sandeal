import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getLatestRuntimeHealth } from '@/lib/automation/runtimeGuardian';
import { listRuntimeRoleLeases } from '@/lib/automation/runtimeRoles';
import { getAutomationControl } from '@/lib/automation/store';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { buildDashboardStatusStrip } from '@/lib/dashboard/statusStrip';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const [control, runtime, leases, settings] = await Promise.all([
      getAutomationControl(),
      getLatestRuntimeHealth(),
      listRuntimeRoleLeases(),
      getAutomationSettings(),
    ]);
    return NextResponse.json({
      ok: true,
      code: 'OK',
      data: buildDashboardStatusStrip({ control, runtime, leases, schedulerEnabled: settings.enabled }),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({
      ok: false,
      code: 'STATUS_UNAVAILABLE',
      message: 'Không thể xác minh trạng thái hệ thống lúc này.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
}
