import { type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/apiResponse';
import { enqueueSelectedAccessTradeTikTokProduct } from '@/lib/bots/productPipeline';
import { ACCESSTRADE_TIKTOK_BOUNDS, searchAccessTradeTikTokProducts } from '@/lib/integrations/accesstradeTikTokShop';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = await requirePermission(request, 'EDIT_PRODUCTS');
  if (authError) return authError;
  let body: Record<string, unknown>;
  try {
    const value = await request.json();
    body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return errorResponse('Dữ liệu JSON không hợp lệ.', 'VALIDATION_ERROR', 400);
  }
  const productId = typeof body.productId === 'string' ? body.productId.trim().slice(0, 200) : '';
  if (!productId) return errorResponse('Thiếu mã sản phẩm TikTok.', 'VALIDATION_ERROR', 400);
  try {
    // Refetch the selected product server-side so browser-supplied price, shop,
    // URL, and image data cannot become source truth.
    const source = await searchAccessTradeTikTokProducts({
      productIds: [productId],
      sortStrategy: 'RECOMMENDED',
      maximumPages: 1,
      rawItemBudget: ACCESSTRADE_TIKTOK_BOUNDS.pageSize,
      acceptedItemBudget: ACCESSTRADE_TIKTOK_BOUNDS.pageSize,
      limit: ACCESSTRADE_TIKTOK_BOUNDS.pageSize,
      mode: 'manual',
      signal: request.signal,
    });
    const product = source.items.find(item => item.id === productId);
    if (!product) return errorResponse('Sản phẩm không còn trong nguồn TikTok Shop hợp lệ.', 'SOURCE_PRODUCT_NOT_FOUND', 404);
    const result = await enqueueSelectedAccessTradeTikTokProduct(product, {
      signal: request.signal,
      requestedBy: 'dashboard_product_sources',
    });
    return successResponse(result.queued ? 'Đã thêm ứng viên TikTok Shop vào hàng chờ.' : 'Ứng viên TikTok Shop đã tồn tại.', {
      state: result.productId ? 'stored_internal_product' : 'candidate',
      candidateId: result.candidate?.id,
      productId: result.productId,
      queued: result.queued,
      unchanged: result.unchanged,
      affiliateLinkCreated: result.affiliateLinkCreated,
      public: false,
    }, result.queued ? 201 : 200);
  } catch (error) {
    if (error instanceof Error && error.message === 'TIKTOK_MERCHANT_CIRCUIT_OPEN') {
      return errorResponse('Gian hàng TikTok này đang trong thời gian chờ kiểm tra sức khỏe.', 'MERCHANT_CIRCUIT_OPEN', 409);
    }
    return serverErrorResponse('Không thể tạo ứng viên TikTok Shop an toàn.', error);
  }
}
