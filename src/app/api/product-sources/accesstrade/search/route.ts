// ===========================================
// API: AccessTrade Search
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import {
  searchAccessTrade,
  isAccessTradeConfigured,
  ACCESS_TRADE_REJECTION_REASONS,
  type AccessTradeSearchResult,
  type AccessTradeRejectionReason,
  type AccessTradeSearchParams,
  type NormalizedAccessTradeItem,
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
  diagnosticReason?: unknown;
  diagnosticPage?: unknown;
  diagnosticPageSize?: unknown;
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

function asBoundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), maximum);
}

function asDiagnosticReason(value: unknown): AccessTradeRejectionReason | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase() as AccessTradeRejectionReason;
  return ACCESS_TRADE_REJECTION_REASONS.includes(normalized) ? normalized : undefined;
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
    requests: [],
    diagnostics: {
      state: 'PROVIDER_EMPTY' as const,
      providerResultType: 'success_empty' as const,
      providerReportedItemCount: 0,
      rawItemCount: 0,
      extractedItemCount: 0,
      normalizedItemCount: 0,
      classifiedProductCount: 0,
      classifiedVoucherCount: 0,
      classifiedCampaignCount: 0,
      classifiedStoreOfferCount: 0,
      classifiedUnknownCount: 0,
      acceptedCount: 0,
      returnedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      filteredCount: 0,
      limitedCount: 0,
      rejectedByReason: {},
      reviewByReason: {},
      rejectionGroups: [],
      rejectionSamplePolicy: {
        defaultSampleSize: 3,
        maximumPageSize: 20,
        selectedReason: null,
      },
    },
  };
}

export function compactPublicAccessTradeItem(item: NormalizedAccessTradeItem) {
  const { rawData: _rawProviderPayload, ...safe } = item;
  void _rawProviderPayload;
  return {
    ...safe,
    rawPayloadOmitted: true,
  };
}

export function compactPublicAccessTradeResult(result: AccessTradeSearchResult) {
  return {
    ...result,
    items: result.items.map(compactPublicAccessTradeItem),
    products: result.products.map(compactPublicAccessTradeItem),
    vouchers: result.vouchers.map(compactPublicAccessTradeItem),
    campaigns: result.campaigns.map(compactPublicAccessTradeItem),
    storeOffers: result.storeOffers.map(compactPublicAccessTradeItem),
    unknown: result.unknown.map(compactPublicAccessTradeItem),
  };
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;
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
      diagnosticReason: asDiagnosticReason(body.diagnosticReason),
      diagnosticPage: asBoundedInteger(body.diagnosticPage, 1, 100),
      diagnosticPageSize: asBoundedInteger(body.diagnosticPageSize, 3, 20),
    };

    const result = compactPublicAccessTradeResult(await searchAccessTrade(params));

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
        diagnosticReason: params.diagnosticReason || null,
        diagnosticPage: params.diagnosticPage || 1,
        diagnosticPageSize: params.diagnosticPageSize || 3,
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
