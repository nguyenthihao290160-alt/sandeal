import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { getAutomationTruth } from '@/lib/automation/truth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, code: 'OK', data: await getAutomationTruth() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ ok: false, code: 'AUTOMATION_TRUTH_UNAVAILABLE', message: 'Không thể tổng hợp trạng thái vận hành.' }, { status: 503 });
  }
}
