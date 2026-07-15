// ===========================================
// API: Score Product
// ===========================================

import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requirePermission(request, 'RUN_QUALITY_CHECK');
  if (denied) return denied;
  const { id } = await params;
  try {
    const result = await enqueueProductAction({ actor: getServerActor(), action: 'score', productId: id });
    return NextResponse.json({ ok: true, code: result.code, message: 'Đã đưa chấm điểm vào hàng đợi.', data: result.data }, { status: result.created ? 202 : 200 });
  } catch (error) {
    const code = error instanceof Error && error.message === 'PRODUCT_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR';
    return NextResponse.json({ ok: false, code, message: code === 'NOT_FOUND' ? 'Không tìm thấy sản phẩm.' : 'Không thể tạo tác vụ chấm điểm.' }, { status: code === 'NOT_FOUND' ? 404 : 400 });
  }
}
