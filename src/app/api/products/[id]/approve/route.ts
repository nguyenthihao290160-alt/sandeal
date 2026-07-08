// ===========================================
// API: Approve Product
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { approveProduct, getProductById } from '@/lib/storage/products';
import { classifyProductKind, looksLikeVoucherOrCampaign } from '@/lib/sourceItemClassifier';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await getProductById(id);
    if (!existing) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }

    // Classify kind if missing and block approval for non-products
    const kind = (existing.kind as string) || classifyProductKind(existing as any);
    const titleLooksLikeVoucher = looksLikeVoucherOrCampaign(existing.title);

    if (kind !== 'product' || titleLooksLikeVoucher) {
      return errorResponse('Mục này là voucher/chiến dịch/ưu đãi shop hoặc chưa xác định — không thể duyệt thành sản phẩm công khai.', undefined, 400);
    }

    const product = await approveProduct(id);
    if (!product) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }
    return successResponse('Đã duyệt sản phẩm.', product);
  } catch (err) {
    return serverErrorResponse('Không thể duyệt sản phẩm.', err);
  }
}
