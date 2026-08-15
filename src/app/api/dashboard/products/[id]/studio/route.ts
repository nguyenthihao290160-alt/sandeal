import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { buildProductStudioDetail } from '@/lib/dashboard/productStudio';
import { listPriceHistory } from '@/lib/product-intelligence/priceHistory';
import { getProductById } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requirePermission(request, 'VIEW_PRODUCTS');
  if (denied) return denied;
  const { id } = await params;
  try {
    const [product, priceSnapshots] = await Promise.all([
      getProductById(id),
      listPriceHistory(id, 90),
    ]);
    if (!product) {
      return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy sản phẩm.' }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      code: 'OK',
      message: 'Đã tải Product Studio.',
      data: buildProductStudioDetail({
        product,
        priceSnapshots,
        // There is no verified payment-promotion store in the current repository.
        // Empty input deliberately renders the honest unavailable state.
        paymentPromotions: [],
      }),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch {
    return NextResponse.json({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Không thể tải Product Studio lúc này. Dữ liệu sản phẩm không bị thay đổi.',
    }, { status: 500 });
  }
}
