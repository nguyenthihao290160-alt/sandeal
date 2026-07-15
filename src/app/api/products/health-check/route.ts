// ===========================================
// API: Product Health Check
// POST /api/products/health-check
// Chạy health cleanup cho sản phẩm đang public
// Require auth — chỉ admin dashboard dùng
// ===========================================

import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (denied) return denied;
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { /* optional body */ }
  try {
    const result = await enqueueProductAction({ actor: getServerActor(), action: 'health', dryRun: body.dryRun === true, idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined, limit: Number(body.limit) || 50 });
    return NextResponse.json({ ok: true, code: result.code, message: 'Đã đưa kiểm tra sức khỏe vào hàng đợi.', data: result.data }, { status: result.created ? 202 : 200 });
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Không thể tạo tác vụ kiểm tra sức khỏe.' }, { status: 400 });
  }
}
