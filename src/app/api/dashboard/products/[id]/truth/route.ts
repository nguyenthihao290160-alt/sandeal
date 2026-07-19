import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { getProductPipelineTruth } from '@/lib/product-intelligence/productPipelineTruth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requirePermission(request, 'VIEW_PRODUCTS');
  if (denied) return denied;
  const { id } = await params;
  const truth = await getProductPipelineTruth(id);
  if (!truth) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ ok: true, code: 'OK', data: truth }, { headers: { 'Cache-Control': 'no-store' } });
}
