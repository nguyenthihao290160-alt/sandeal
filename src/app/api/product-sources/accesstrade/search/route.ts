// ===========================================
// API: AccessTrade Search
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import {
  searchAccessTrade,
  isAccessTradeConfigured,
  type AccessTradeSearchParams,
} from '@/lib/integrations/accesstrade';

export const dynamic = 'force-dynamic';

type AccessTradeKind = NonNullable<AccessTradeSearchParams['kind']>;

type AccessTradeSearchBody = {
  keyword?: unknown;
  category?: unknown;
  platform?: unknown;
  kind?: unknown;
  limit?: unknown;
  imageOnly?: unknown;
  affiliateLinkOnly?: unknown;
};

const ACCESS_TRADE_KINDS: AccessTradeKind[] = [
  'product',
  'voucher',
  'campaign',
  'store_offer',
  'unknown',
  'all',
];

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();

  return trimmed ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  return false;
}

function asLimit(value: unknown): number {
  const parsed =
      typeof value === 'number'
          ? value
          : typeof value === 'string'
              ? Number(value)
              : 20;

  if (!Number.isFinite(parsed)) return 20;

  return Math.min(Math.max(Math.floor(parsed), 1), 50);
}

function asKind(value: unknown): AccessTradeKind {
  if (typeof value !== 'string') return 'all';

  const normalized = value.trim().toLowerCase() as AccessTradeKind;

  if (ACCESS_TRADE_KINDS.includes(normalized)) {
    return normalized;
  }

  return 'all';
}

async function readBody(request: NextRequest): Promise<AccessTradeSearchBody> {
  try {
    const body = await request.json();

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return {};
    }

    return body as AccessTradeSearchBody;
  } catch {
    return {};
  }
}

function emptyAccessTradeResult(message: string) {
  return {
    sourceReady: false,
    message,
    items: [],
    products: [],
    vouchers: [],
    campaigns: [],
    storeOffers: [],
    unknown: [],
    summary: {
      total: 0,
      products: 0,
      vouchers: 0,
      campaigns: 0,
      storeOffers: 0,
      unknown: 0,
      publicEligibleProducts: 0,
      blockedFromPublic: 0,
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const configured = await isAccessTradeConfigured();

    if (!configured) {
      return successResponse(
          'AccessTrade chưa được cấu hình.',
          emptyAccessTradeResult('AccessTrade token chưa được cấu hình trong Token Vault hoặc env.'),
      );
    }

    const body = await readBody(request);

    const params: AccessTradeSearchParams = {
      keyword: asText(body.keyword),
      category: asText(body.category),
      platform: asText(body.platform),
      kind: asKind(body.kind),
      limit: asLimit(body.limit),
      imageOnly: asBoolean(body.imageOnly),
      affiliateLinkOnly: asBoolean(body.affiliateLinkOnly),
    };

    const result = await searchAccessTrade(params);

    return successResponse('Đã tải dữ liệu từ AccessTrade.', {
      sourceReady: true,
      requested: {
        keyword: params.keyword || null,
        category: params.category || null,
        platform: params.platform || null,
        kind: params.kind || 'all',
        limit: params.limit || 20,
        imageOnly: Boolean(params.imageOnly),
        affiliateLinkOnly: Boolean(params.affiliateLinkOnly),
      },
      ...result,
      note:
          'Dữ liệu AccessTrade đã được phân loại an toàn. Voucher, chiến dịch và ưu đãi shop không được public như sản phẩm.',
    });
  } catch (err) {
    const message =
        err instanceof Error
            ? err.message
            : 'Không thể lấy dữ liệu từ AccessTrade. Vui lòng kiểm tra API key hoặc thử lại sau.';

    return serverErrorResponse(message, err);
  }
}