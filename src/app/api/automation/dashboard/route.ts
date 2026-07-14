import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildAutomationDashboard, type DashboardRange } from '@/lib/automation/dashboard';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  const range = (request.nextUrl.searchParams.get('range') || '7d') as DashboardRange;
  if (!['today','7d','30d'].includes(range)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Khoảng thời gian không hợp lệ.' }, { status: 400 });
  try { return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải bảng điều khiển.', data: await buildAutomationDashboard(range) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể tải bảng điều khiển. Vui lòng thử lại.' }, { status: 500 }); }
}
