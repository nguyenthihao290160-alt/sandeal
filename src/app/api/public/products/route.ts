import { NextRequest, NextResponse } from 'next/server';
import { PublicProductQueryError, queryPublicProducts } from '@/lib/product-intelligence/publicProducts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const data = await queryPublicProducts(request.nextUrl.searchParams);
    return NextResponse.json({ ok: true, code: data.pagination.totalItems ? 'OK' : 'EMPTY', data }, { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' } });
  } catch (error) {
    if (error instanceof PublicProductQueryError) {
      return NextResponse.json({ ok: false, code: error.message, message: 'Bộ lọc không hợp lệ.', field: error.field }, { status: 400 });
    }
    return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể tải danh sách deal.' }, { status: 500 });
  }
}
