import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth';
import { getSourceReliabilityReport } from '@/lib/commerce/sourceReliability';
import { updateAutomationSettings } from '@/lib/storage/automationSettings';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({
      ok: true,
      code: 'OK',
      message: 'Đã tải trạng thái độ tin cậy nguồn.',
      data: await getSourceReliabilityReport(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({
      ok: false,
      code: 'SOURCE_RELIABILITY_UNAVAILABLE',
      message: 'Không thể đọc trạng thái nguồn lúc này.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function PATCH(request: NextRequest) {
  const permissionError = await requirePermission(request, 'MANAGE_SOURCES');
  if (permissionError) return permissionError;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Cấu hình nguồn không hợp lệ.' }, { status: 400 });
  }
  if (body.confirmed !== true) {
    return NextResponse.json({ ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Cần xác nhận thay đổi kiểm soát nguồn.' }, { status: 409 });
  }
  const updates = {
    ...(Array.isArray(body.pausedDomains) ? { pausedSourceDomains: body.pausedDomains.map(String) } : {}),
    ...(Array.isArray(body.pausedCampaigns) ? { pausedSourceCampaigns: body.pausedCampaigns.map(String) } : {}),
    ...(body.maximumPerMerchant !== undefined ? { sourceMaxPerMerchant: Number(body.maximumPerMerchant) } : {}),
    ...(body.maximumPerCampaign !== undefined ? { sourceMaxPerCampaign: Number(body.maximumPerCampaign) } : {}),
  };
  if (!Object.keys(updates).length) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Không có cấu hình nguồn được hỗ trợ.' }, { status: 400 });
  }
  const settings = await updateAutomationSettings(updates);
  return NextResponse.json({
    ok: true,
    code: 'SOURCE_CONTROLS_UPDATED',
    message: 'Đã cập nhật kiểm soát nguồn; không có sản phẩm nào được xuất bản.',
    data: {
      maximumPerMerchant: settings.sourceMaxPerMerchant,
      maximumPerCampaign: settings.sourceMaxPerCampaign,
      pausedDomains: settings.pausedSourceDomains,
      pausedCampaigns: settings.pausedSourceCampaigns,
    },
  });
}
