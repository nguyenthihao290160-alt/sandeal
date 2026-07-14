import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { previewManualUrl } from '@/lib/product-intelligence/importer';

export const dynamic = 'force-dynamic';

/**
 * Compatibility endpoint for the former URL enricher.
 * It intentionally performs no network request, AI call, or Product write.
 */
export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'IMPORT_PRODUCTS');
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu URL không hợp lệ.' }, { status: 400 }); }
  const preview = previewManualUrl(String(body.url || ''));
  if (!preview.valid) {
    return NextResponse.json({ ok: false, code: 'UNSAFE_URL', message: 'URL bị chặn bởi chính sách an toàn.', data: preview }, { status: 400 });
  }
  return NextResponse.json({
    ok: false,
    code: 'METADATA_REQUIRED',
    message: 'Route tự lấy metadata đã được vô hiệu hóa. Hãy nhập metadata thủ công hoặc dùng adapter nguồn được hỗ trợ.',
    data: preview,
  }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
}
