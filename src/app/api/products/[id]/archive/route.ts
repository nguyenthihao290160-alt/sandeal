// ===========================================
// API: Archive Product
// ===========================================

import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requirePermission(request, 'EDIT_PRODUCTS');
  if (denied) return denied;
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { /* optional body */ }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : 'Lưu trữ từ Product Operations';
  if (reason.length < 5) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Vui lòng nhập lý do ít nhất 5 ký tự.' }, { status: 400 });
  try {
    const result = await enqueueProductAction({ actor: getServerActor(), action: 'archive', productId: id, reason, idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined });
    return NextResponse.json({ ok: true, code: result.code, message: 'Đã tạo yêu cầu lưu trữ; tác vụ đang chờ phê duyệt.', data: result.data }, { status: result.created ? 202 : 200 });
  } catch (error) {
    const code = error instanceof Error && error.message === 'PRODUCT_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR';
    return NextResponse.json({ ok: false, code, message: code === 'NOT_FOUND' ? 'Không tìm thấy sản phẩm.' : 'Không thể tạo yêu cầu lưu trữ.' }, { status: code === 'NOT_FOUND' ? 404 : 400 });
  }
}
