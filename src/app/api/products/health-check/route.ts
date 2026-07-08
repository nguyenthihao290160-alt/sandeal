// ===========================================
// API: Product Health Check
// POST /api/products/health-check
// Chạy health cleanup cho sản phẩm đang public
// Require auth — chỉ admin dashboard dùng
// ===========================================

import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { runProductHealthCleanup } from '@/lib/bots/productHealth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;

    const summary = await runProductHealthCleanup();

    return successResponse(
      `Health check hoàn tất. Đã kiểm tra ${summary.checked} sản phẩm, ẩn ${summary.hidden}, link lỗi ${summary.linkBroken}, ảnh lỗi ${summary.imageBroken}.`,
      summary,
    );
  } catch (err) {
    return serverErrorResponse('Không thể chạy health check.', err);
  }
}
