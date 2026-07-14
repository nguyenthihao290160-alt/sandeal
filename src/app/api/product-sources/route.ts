import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createProductSource, listProductSources } from '@/lib/storage/productSources';
import type { ProductKind, ProductPlatform } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PLATFORMS = new Set<ProductPlatform>(['shopee', 'tiktok_shop', 'lazada', 'accesstrade', 'website', 'other']);
const KINDS = new Set<ProductKind>(['product', 'voucher', 'campaign', 'deal', 'store_offer', 'unknown']);

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    const sources = await listProductSources();
    return NextResponse.json({ ok: true, code: sources.length ? 'OK' : 'EMPTY', message: sources.length ? 'Đã tải nguồn sản phẩm.' : 'Chưa có nguồn sản phẩm.', data: sources });
  } catch {
    return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể tải nguồn sản phẩm. Vui lòng thử lại.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu nguồn không hợp lệ.', fields: {} }, { status: 400 }); }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const platform = body.platform as ProductPlatform;
  const kind = body.kind as ProductKind;
  const fields: Record<string, string> = {};
  if (!name) fields.name = 'Vui lòng nhập tên nguồn.';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
  } catch { fields.url = 'Địa chỉ nguồn phải là URL http hoặc https hợp lệ.'; }
  if (!PLATFORMS.has(platform)) fields.platform = 'Vui lòng chọn nền tảng hợp lệ.';
  if (!KINDS.has(kind)) fields.kind = 'Vui lòng chọn loại dữ liệu hợp lệ.';
  if (Object.keys(fields).length) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Nguồn sản phẩm chưa hợp lệ. Dữ liệu chưa được lưu.', fields }, { status: 400 });
  }

  try {
    const source = await createProductSource({
      name,
      url,
      platform,
      kind,
      enabled: body.enabled !== false,
      scanSchedule: typeof body.scanSchedule === 'string' && body.scanSchedule.trim() ? body.scanSchedule.trim().slice(0, 80) : undefined,
      description: typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 500) : undefined,
    });
    return NextResponse.json({ ok: true, code: 'OK', message: 'Đã lưu nguồn sản phẩm.', data: source }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'DUPLICATE_SOURCE') {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Địa chỉ nguồn này đã tồn tại. Dữ liệu chưa được thay đổi.', fields: { url: 'Địa chỉ nguồn đã tồn tại.' } }, { status: 409 });
    }
    return NextResponse.json({ ok: false, code: 'INTERNAL_ERROR', message: 'Không thể lưu nguồn sản phẩm. Dữ liệu chưa được thay đổi. Vui lòng thử lại.' }, { status: 500 });
  }
}
