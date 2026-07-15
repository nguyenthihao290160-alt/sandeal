// ===========================================
// POST /api/products/cleanup-broken-links
// Archives broken products safely
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';

export async function POST(req: NextRequest) {
  try {
    const authError = await requirePermission(req, 'MANAGE_AUTOMATION');
    if (authError) return authError;

    const result = await enqueueProductAction({ actor: getServerActor(), action: 'health', limit: 50 });
    return NextResponse.json({
      success: true,
      ok: true,
      code: 'HEALTH_RECHECK_ENQUEUED_NO_AUTO_ARCHIVE',
      message: 'Đã tạo tác vụ kiểm tra. Sản phẩm lỗi chỉ được đề xuất lưu trữ và cần phê duyệt riêng.',
      data: result.data,
    }, { status: result.created ? 202 : 200 });
  } catch {
    return NextResponse.json(
      {
        success: false,
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Không thể tạo tác vụ kiểm tra sản phẩm.',
      },
      { status: 400 }
    );
  }
}
