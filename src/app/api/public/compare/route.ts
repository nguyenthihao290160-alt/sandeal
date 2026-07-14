import { NextRequest, NextResponse } from 'next/server';
import { getPublicComparison } from '@/lib/product-intelligence/publicProducts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('ids') || '';
  const ids = raw.split(',').map(value => value.trim()).filter(Boolean);
  if (!ids.length || ids.length > 4 || ids.some(id => id.length > 160)) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Chọn từ 1 đến 4 sản phẩm để so sánh.' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, code: 'OK', data: await getPublicComparison(ids) }, { headers: { 'Cache-Control': 'public, max-age=30' } });
}
