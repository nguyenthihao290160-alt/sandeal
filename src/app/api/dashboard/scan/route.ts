import { randomUUID } from 'crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAllProducts } from '@/lib/storage/products';
import { buildDashboardProducts } from '@/lib/dashboard/products';
import { createCompletedPreview } from '@/lib/dashboard/operations';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu yêu cầu không hợp lệ.' }, { status: 400 });
  }

  const limit = Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Số lượng kiểm tra phải từ 1 đến 30.' }, { status: 400 });
  }
  if (body.dryRun !== true) {
    return NextResponse.json({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Endpoint này chỉ hỗ trợ chạy thử an toàn. Dữ liệu hiện tại không bị thay đổi.',
    }, { status: 400 });
  }

  try {
    const products = (await getAllProducts()).slice(0, limit);
    const dashboard = buildDashboardProducts(products, {
      sort: 'updated_desc', page: 1, pageSize: 30,
    });
    const result = {
      inspected: products.length,
      qualified: dashboard.summary.qualifiedForPublish,
      needsReview: dashboard.summary.needsReview,
      blocked: dashboard.summary.blocked + dashboard.summary.rejectedItems,
      changed: 0,
    };
    const operation = createCompletedPreview(
      randomUUID(),
      result,
      products.length === 0
        ? 'Chạy thử hoàn tất. Chưa có sản phẩm để kiểm tra và không có dữ liệu nào bị thay đổi.'
        : `Chạy thử hoàn tất trên ${products.length} sản phẩm. Không có dữ liệu nào bị thay đổi.`,
    );
    return NextResponse.json({ ok: true, code: products.length === 0 ? 'EMPTY' : 'OK', message: operation.message, data: operation });
  } catch {
    return NextResponse.json({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Không thể chạy thử kiểm tra sản phẩm. Dữ liệu hiện tại không bị thay đổi. Vui lòng thử lại.',
    }, { status: 500 });
  }
}
