import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/apiResponse';
import { isAccessTradeConfigured } from '@/lib/integrations/accesstrade';
import {
  ACCESSTRADE_TIKTOK_BOUNDS,
  ACCESSTRADE_TIKTOK_SORT_STRATEGIES,
  ACCESSTRADE_TIKTOK_SOURCE_LABEL_VI,
  AccessTradeTikTokError,
  searchAccessTradeTikTokProducts,
  type AccessTradeTikTokSortStrategy,
} from '@/lib/integrations/accesstradeTikTokShop';

export const dynamic = 'force-dynamic';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function sortStrategy(value: unknown): AccessTradeTikTokSortStrategy {
  const normalized = String(value || 'RECOMMENDED').trim().toUpperCase() as AccessTradeTikTokSortStrategy;
  return ACCESSTRADE_TIKTOK_SORT_STRATEGIES.includes(normalized) ? normalized : 'RECOMMENDED';
}

function keywords(body: Record<string, unknown>): string[] {
  const supplied = Array.isArray(body.titleKeywords) ? body.titleKeywords : [body.keyword];
  return [...new Set(supplied
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().slice(0, 160))
    .filter(Boolean))].slice(0, 6);
}

export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  if (!(await isAccessTradeConfigured())) {
    return successResponse('AccessTrade chưa được cấu hình.', {
      sourceReady: false,
      source: 'accesstrade_tiktok_shop',
      sourceLabel: ACCESSTRADE_TIKTOK_SOURCE_LABEL_VI,
      items: [],
      diagnostics: {
        source: 'accesstrade_tiktok_shop', fetched: 0, normalized: 0, accepted: 0, duplicates: 0,
        rejectedByReason: {}, pageCount: 0, stopReason: 'PROVIDER_ERROR', durationMs: 0,
        previewOnly: true, persisted: false,
      },
    });
  }
  let body: Record<string, unknown>;
  try { body = record(await request.json()); }
  catch { return errorResponse('Dữ liệu JSON không hợp lệ.', 'VALIDATION_ERROR', 400); }
  const titleKeywords = keywords(body);
  if (!titleKeywords.length || titleKeywords.every(keyword => keyword.length < 2)) {
    return errorResponse('Hãy nhập từ khóa sản phẩm có ít nhất 2 ký tự.', 'VALIDATION_ERROR', 400);
  }
  try {
    const result = await searchAccessTradeTikTokProducts({
      titleKeywords,
      sortStrategy: sortStrategy(body.sortStrategy),
      limit: boundedInteger(body.pageSize, ACCESSTRADE_TIKTOK_BOUNDS.pageSize, ACCESSTRADE_TIKTOK_BOUNDS.pageSize),
      maximumPages: boundedInteger(body.maximumPages, ACCESSTRADE_TIKTOK_BOUNDS.manualMaximumPages, ACCESSTRADE_TIKTOK_BOUNDS.manualMaximumPages),
      rawItemBudget: boundedInteger(body.rawItemBudget, ACCESSTRADE_TIKTOK_BOUNDS.rawItemBudget, ACCESSTRADE_TIKTOK_BOUNDS.rawItemBudget),
      acceptedItemBudget: boundedInteger(body.limit, ACCESSTRADE_TIKTOK_BOUNDS.manualDefaultAcceptedItemBudget, ACCESSTRADE_TIKTOK_BOUNDS.manualAcceptedItemBudget),
      mode: 'manual',
      signal: request.signal,
    });
    return successResponse('Đã tìm sản phẩm TikTok Shop qua AccessTrade.', {
      sourceReady: true,
      source: 'accesstrade_tiktok_shop',
      sourceLabel: ACCESSTRADE_TIKTOK_SOURCE_LABEL_VI,
      requested: { titleKeywords, sortStrategy: sortStrategy(body.sortStrategy) },
      items: result.items.map(item => ({
        ...item,
        rawData: undefined,
        rawPayloadOmitted: true,
        state: 'preview',
      })),
      diagnostics: result.diagnostics,
      note: 'Kết quả chỉ là bản xem trước; chưa phải ứng viên, sản phẩm nội bộ hoặc sản phẩm công khai.',
    });
  } catch (error) {
    if (error instanceof AccessTradeTikTokError && ['unauthorized', 'forbidden'].includes(error.resultType)) {
      return errorResponse('AccessTrade từ chối khóa kết nối.', 'SOURCE_INVALID_CREDENTIAL', 502);
    }
    return serverErrorResponse('Không thể tìm sản phẩm TikTok Shop qua AccessTrade.', error);
  }
}
