// ===========================================
// API: Score Product
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getProductById, updateProduct } from '@/lib/storage/products';
import { scoreProductV2 } from '@/lib/productScoring';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const product = await getProductById(id);
    if (!product) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }

    const result = scoreProductV2(product);

    const updated = await updateProduct(id, {
      score: result.score,
      scoreLabel: result.label,
      scoreReasons: result.reasons,
      scoreWarnings: result.warnings,
      riskLevel: result.riskLevel,
    });

    return successResponse('Đã chấm điểm sản phẩm.', {
      product: updated,
      scoring: result,
    });
  } catch (err) {
    return serverErrorResponse('Không thể chấm điểm sản phẩm.', err);
  }
}
