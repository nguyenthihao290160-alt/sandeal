import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() || '';
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_protocol');
    url.pathname = '/deals';
    url.search = '';
    url.hash = '';
    return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải cấu hình trang công khai.', data: { publicUrl: url.toString() } });
  } catch {
    return NextResponse.json({
      ok: true,
      code: 'CONFIGURATION_REQUIRED',
      message: 'Chưa thiết lập địa chỉ trang công khai.',
      data: { publicUrl: null },
    });
  }
}
