// ===========================================
// API: AccessTrade Search
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { searchAccessTrade, isAccessTradeConfigured } from '@/lib/integrations/accesstrade';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    if (!(await isAccessTradeConfigured())) {
      return successResponse('AccessTrade not configured', { sourceReady: false, message: 'AccessTrade token chưa được cấu hình.' });
    }

    const body = await request.json();

    const result = await searchAccessTrade({
      keyword: body.keyword || undefined,
      category: body.category || undefined,
      platform: body.platform || undefined,
      kind: body.kind || 'all',
      limit: body.limit || 20,
      imageOnly: body.imageOnly || false,
      affiliateLinkOnly: body.affiliateLinkOnly || false,
    });

    return successResponse('Đã tải dữ liệu từ AccessTrade.', result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Không thể lấy dữ liệu từ AccessTrade. Vui lòng kiểm tra API key hoặc thử lại sau.';
    return serverErrorResponse(message, err);
  }
}
