import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { buildBusinessOverview } from '@/lib/product-intelligence/insights';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_ANALYTICS'); if (denied) return denied;
  try { return NextResponse.json({ ok: true, code: 'OK', data: await buildBusinessOverview() }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể tải tổng quan kinh doanh.' }, { status: 500 }); }
}
