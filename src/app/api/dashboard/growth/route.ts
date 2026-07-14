import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { getGrowthSummary } from '@/lib/product-intelligence/growth';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_ANALYTICS'); if (denied) return denied;
  const days = Number(request.nextUrl.searchParams.get('days') || 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  return NextResponse.json({ ok: true, code: 'OK', data: await getGrowthSummary(days) }, { headers: { 'Cache-Control': 'no-store' } });
}
