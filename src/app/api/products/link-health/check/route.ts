// ===========================================
// POST /api/products/link-health/check
// Checks product and affiliate URLs
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';

interface LinkHealthCheckRequest {
  productId: string;
  target?: 'link' | 'affiliate' | 'image' | 'all';
}

const TARGET_ACTION = {
  link: 'link',
  affiliate: 'affiliate',
  image: 'image',
  all: 'health',
} as const;

const TARGET_MESSAGE = {
  link: 'Đã đưa kiểm tra URL sản phẩm vào hàng đợi.',
  affiliate: 'Đã đưa kiểm tra URL affiliate vào hàng đợi.',
  image: 'Đã đưa kiểm tra ảnh vào hàng đợi.',
  all: 'Đã đưa kiểm tra toàn bộ bằng chứng liên kết vào hàng đợi.',
} as const;

export async function POST(req: NextRequest) {
  try {
    const authError = await requirePermission(req, 'MANAGE_AUTOMATION');
    if (authError) return authError;

    const body = await req.json() as LinkHealthCheckRequest;

    const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
    if (!productId || productId.length > 200 || /[\u0000-\u001f\u007f]/.test(productId)) {
      return NextResponse.json(
        { success: false, ok: false, code: 'INVALID_PRODUCT_ID', message: 'Mã sản phẩm không hợp lệ.' },
        { status: 400 }
      );
    }

    const target = body.target || 'link';
    if (!Object.hasOwn(TARGET_ACTION, target)) {
      return NextResponse.json(
        { success: false, ok: false, code: 'INVALID_TARGET', message: 'Mục tiêu kiểm tra không hợp lệ.' },
        { status: 400 },
      );
    }
    const result = await enqueueProductAction({
      actor: getServerActor(),
      action: TARGET_ACTION[target],
      productId,
    });
    return NextResponse.json({
      success: true,
      ok: true,
      code: result.code,
      message: TARGET_MESSAGE[target],
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
