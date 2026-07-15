import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { buildOperationsOnboarding } from '@/lib/operations/onboarding';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, code: 'OK', message: 'Đã suy ra trạng thái bắt đầu vận hành từ backend.', data: await buildOperationsOnboarding() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể suy ra trạng thái vận hành. Dữ liệu hiện tại không bị thay đổi.' }, { status: 500 });
  }
}
