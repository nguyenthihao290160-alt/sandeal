// ===========================================
// API: Archive Product
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { archiveProduct } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const product = await archiveProduct(id);
    if (!product) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }
    return successResponse('Đã lưu trữ sản phẩm.', product);
  } catch (err) {
    return serverErrorResponse('Không thể lưu trữ sản phẩm.', err);
  }
}
