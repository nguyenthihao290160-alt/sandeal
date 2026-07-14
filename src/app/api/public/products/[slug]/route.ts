import { type NextRequest, NextResponse } from 'next/server';

import { getPublicProductBySlugSafe } from '@/lib/product-intelligence/publicProducts';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!slug || slug.length > 160 || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Slug sản phẩm không hợp lệ.' }, { status: 400 });
  }

  const result = await getPublicProductBySlugSafe(slug);
  if (!result) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Sản phẩm không đủ điều kiện công khai.' }, { status: 404 });
  }

  return NextResponse.json(
    { ok: true, code: 'OK', data: result.detail },
    { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' } },
  );
}
