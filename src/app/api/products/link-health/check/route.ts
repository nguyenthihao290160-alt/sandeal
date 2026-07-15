// ===========================================
// POST /api/products/link-health/check
// Checks product and affiliate URLs
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';

interface LinkHealthCheckRequest {
  productId: string;
}

export async function POST(req: NextRequest) {
  try {
    const authError = await requirePermission(req, 'MANAGE_AUTOMATION');
    if (authError) return authError;

    const body = await req.json() as LinkHealthCheckRequest;

    if (!body.productId) {
      return NextResponse.json(
        { success: false, error: 'productId is required' },
        { status: 400 }
      );
    }

    const result = await enqueueProductAction({ actor: getServerActor(), action: 'link', productId: body.productId });
    return NextResponse.json({
      success: true,
      ok: true,
      code: result.code,
      message: 'Đã đưa kiểm tra liên kết vào hàng đợi.',
      data: result.data,
    }, { status: result.created ? 202 : 200 });
  } catch (error) {
    const code = error instanceof Error && error.message === 'PRODUCT_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR';
    return NextResponse.json(
      {
        success: false,
        ok: false,
        code,
        message: code === 'NOT_FOUND' ? 'Không tìm thấy sản phẩm.' : 'Không thể tạo tác vụ kiểm tra liên kết.',
      },
      { status: code === 'NOT_FOUND' ? 404 : 400 }
    );
  }
}
