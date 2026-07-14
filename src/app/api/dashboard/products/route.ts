import { type NextRequest, NextResponse } from 'next/server';

import { requirePermission } from '@/lib/auth';
import {
  buildDashboardProducts,
  parseDashboardProductQuery,
} from '@/lib/dashboard/products';
import { getAllProducts } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requirePermission(request, 'VIEW_PRODUCTS');

  if (authError) {
    return authError;
  }

  const parsed = parseDashboardProductQuery(request.nextUrl.searchParams);

  if (!parsed.ok) {
    return NextResponse.json(
        {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: parsed.message,
        },
        { status: 400 },
    );
  }

  try {
    const products = await getAllProducts();

    return NextResponse.json(
        {
          ok: true,
          code: products.length === 0 ? 'EMPTY' : 'OK',
          message:
              products.length === 0
                  ? 'Chưa có sản phẩm trong kho dữ liệu.'
                  : 'Đã tải kết quả bot.',
          data: buildDashboardProducts(products, parsed.query),
        },
        {
          headers: {
            'Cache-Control': 'no-store, max-age=0',
          },
        },
    );
  } catch {
    return NextResponse.json(
        {
          ok: false,
          code: 'INTERNAL_ERROR',
          message:
              'Không thể tải kết quả bot. Dữ liệu hiện tại không bị thay đổi. Vui lòng thử lại.',
        },
        { status: 500 },
    );
  }
}
