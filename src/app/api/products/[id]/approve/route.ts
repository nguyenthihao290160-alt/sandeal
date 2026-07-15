// ===========================================
// API: Approve Product
// Safe approve / AutoPilot-compatible approve
// ===========================================

import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requireAuth, requirePermission } from '@/lib/auth';
import { enqueueProductAction } from '@/lib/automation/productActions';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { approveProduct, getProductById, updateProduct } from '@/lib/storage/products';
import {
  classifyProductKind,
  looksLikeVoucherOrCampaign,
} from '@/lib/sourceItemClassifier';
import type { Product, ProductKind } from '@/lib/types';
import { checkLinkHealth, checkImageHealth } from '@/lib/bots/productHealthCheck';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

type ProductRecord = Product &
    Record<string, unknown> & {
  sourceItemKind?: ProductKind;
  kind?: ProductKind;
  affiliateUrl?: unknown;
  originalUrl?: unknown;
  url?: unknown;
  productUrl?: unknown;
  landingUrl?: unknown;
  platform?: unknown;
  source?: unknown;
  dataSource?: unknown;
  verifiedSource?: boolean;
  sourceVerified?: boolean;
  isDemo?: boolean;
  isSample?: boolean;
  isTest?: boolean;
  isInternal?: boolean;
  archived?: boolean;
  deleted?: boolean;
  hidden?: boolean;
  publicHidden?: boolean;
  linkHealthStatus?: unknown;
  linkHealth?: unknown;
  imageHealthStatus?: unknown;
};

function normalizeText(value?: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
}

function getRecord(product: Product): ProductRecord {
  return product as ProductRecord;
}

function getEffectiveKind(product: Product): ProductKind {
  const p = getRecord(product);
  const explicitKind = p.sourceItemKind || p.kind;

  if (explicitKind && explicitKind !== 'unknown') {
    const looksUnsafe =
        looksLikeVoucherOrCampaign({
          title: product.title,
          description: product.description,
          rawSourceKind: p.rawSourceKind,
          source: p.source,
          raw: product,
        }) || looksLikeVoucherOrCampaign(product.title);

    if ((explicitKind === 'product' || explicitKind === 'deal') && looksUnsafe) {
      return classifyProductKind({
        ...product,
        kind: undefined,
        sourceItemKind: undefined,
      } as Partial<Product>);
    }

    return explicitKind;
  }

  return classifyProductKind({
    ...product,
    kind: undefined,
    sourceItemKind: undefined,
  } as Partial<Product>);
}

function hasExternalUrl(product: Product): boolean {
  const p = getRecord(product);

  const urls = [
    p.affiliateUrl,
    p.originalUrl,
    p.url,
    p.productUrl,
    p.landingUrl,
  ];

  return urls.some((url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()));
}

function hasPlatformOrSource(product: Product): boolean {
  const p = getRecord(product);

  return Boolean(
      normalizeText(p.platform) ||
      normalizeText(p.source) ||
      normalizeText(p.dataSource),
  );
}

function hasRealTitle(product: Product): boolean {
  return Boolean(product.title && String(product.title).trim().length >= 3);
}

function hasRealPrice(product: Product): boolean {
  const p = getRecord(product);

  const priceCandidates = [
    product.price,
    product.salePrice,
    p.currentPrice,
    p.originalPrice,
  ];

  return priceCandidates.some((value) => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;

    if (typeof value === 'string') {
      const digitsOnly = value.replace(/[^\d]/g, '');
      const parsed = Number(digitsOnly);
      return Number.isFinite(parsed) && parsed > 0;
    }

    return false;
  });
}

function hasImage(product: Product): boolean {
  return Boolean(product.imageUrl && String(product.imageUrl).trim());
}

function isDemoOrInternal(product: Product): boolean {
  const p = getRecord(product);

  const source = normalizeText(p.source);
  const dataSource = normalizeText(p.dataSource);
  const title = normalizeText(p.title);

  return Boolean(
      p.isDemo === true ||
      p.isSample === true ||
      p.isTest === true ||
      p.isInternal === true ||
      p.archived === true ||
      p.deleted === true ||
      p.hidden === true ||
      source === 'demo' ||
      source === 'sample' ||
      source === 'test' ||
      source === 'internal' ||
      dataSource === 'demo' ||
      dataSource === 'sample' ||
      dataSource === 'test' ||
      dataSource === 'internal' ||
      title.includes('demo') ||
      title.includes('sample') ||
      title.includes('test product') ||
      title.includes('san pham test'),
  );
}

function isBrokenLinkStatus(product: Product): boolean {
  const p = getRecord(product);

  const status =
      normalizeText(p.linkHealthStatus) ||
      normalizeText(p.linkHealth);

  if (!status) return false;

  return [
    'broken',
    'broken_link',
    'not_found',
    'not_allowed',
    'forbidden',
    'timeout',
    'affiliate_error',
    'image_broken',
    'product_unavailable',
    'server_error',
    'error',
    'failed',
    'dead',
    'redirect_error',
    'unavailable',
    'out_of_stock',
  ].includes(status);
}

function isBrokenImageStatus(product: Product): boolean {
  const p = getRecord(product);

  const status = normalizeText(p.imageHealthStatus);

  if (!status) return false;

  return [
    'image_broken',
    'invalid_image',
    'forbidden',
    'timeout',
    'error',
  ].includes(status);
}

function titleLooksUnsafe(product: Product): boolean {
  const p = getRecord(product);

  return Boolean(
      looksLikeVoucherOrCampaign({
        title: product.title,
        description: product.description,
        rawSourceKind: p.rawSourceKind,
        source: p.source,
        raw: product,
      }) || looksLikeVoucherOrCampaign(product.title),
  );
}

function getApproveBlockReason(product: Product): string | null {
  const p = getRecord(product);
  const kind = getEffectiveKind(product);
  const status = normalizeText(product.status);

  if (status === 'archived') {
    return 'Sản phẩm đã lưu trữ, không thể duyệt public.';
  }

  if (status === 'published' || status === 'approved') {
    return null;
  }

  if (kind === 'voucher') {
    return 'Mục này là voucher, chưa đủ dữ liệu sản phẩm để public.';
  }

  if (kind === 'campaign') {
    return 'Mục này là chiến dịch, chưa đủ dữ liệu sản phẩm để public.';
  }

  if (kind === 'store_offer') {
    return 'Mục này là ưu đãi shop, chưa phải sản phẩm cụ thể để public.';
  }

  if (kind === 'unknown') {
    return 'Mục này chưa rõ loại dữ liệu, cần phân loại thành sản phẩm thật trước khi duyệt.';
  }

  if (kind !== 'product' && kind !== 'deal') {
    return 'Mục này chưa phải sản phẩm thật, không thể duyệt public.';
  }

  if (titleLooksUnsafe(product)) {
    return 'Tiêu đề giống voucher/chiến dịch/ưu đãi shop, không thể duyệt public.';
  }

  if (!hasRealTitle(product)) {
    return 'Thiếu tên sản phẩm, không thể duyệt public.';
  }

  if (isDemoOrInternal(product)) {
    return 'Dữ liệu demo/test/internal hoặc đang bị ẩn, không thể duyệt public.';
  }

  if (!hasPlatformOrSource(product)) {
    return 'Thiếu nền tảng hoặc nguồn dữ liệu, không thể duyệt public.';
  }

  if (!hasExternalUrl(product)) {
    return 'Thiếu link mua hàng hoặc link affiliate hợp lệ, không thể duyệt public.';
  }

  if (!hasImage(product)) {
    return 'Thiếu ảnh sản phẩm thật, không thể duyệt public.';
  }

  if (!hasRealPrice(product)) {
    return 'Thiếu giá sản phẩm thật, không thể duyệt public.';
  }

  if (normalizeText(p.source) === 'manual' && p.verifiedSource !== true && p.sourceVerified !== true) {
    return 'Sản phẩm nhập thủ công chưa được xác minh nguồn, không thể duyệt public.';
  }

  if (isBrokenLinkStatus(product)) {
    return 'Link sản phẩm đang lỗi hoặc không khả dụng, không thể duyệt public.';
  }

  if (isBrokenImageStatus(product)) {
    return 'Ảnh sản phẩm đang lỗi hoặc không hợp lệ, không thể duyệt public.';
  }

  return null;
}

async function legacyApproveDisabled(request: NextRequest, context: RouteContext) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;

    const { id } = await context.params;

    const existing = await getProductById(id);

    if (!existing) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }

    // Quick health verify nếu chưa có health status
    const p = existing as ProductRecord;
    const hasLinkHealth = Boolean(normalizeText(p.linkHealthStatus));
    const hasImageHealth = Boolean(normalizeText(p.imageHealthStatus));

    if (!hasLinkHealth || !hasImageHealth) {
      try {
        const healthUpdates: Record<string, unknown> = {};

        if (!hasLinkHealth) {
          const linkUrl =
            (typeof p.affiliateUrl === 'string' ? p.affiliateUrl.trim() : '') ||
            (typeof p.originalUrl === 'string' ? p.originalUrl.trim() : '') ||
            (typeof p.url === 'string' ? (p.url as string).trim() : '') ||
            (typeof p.productUrl === 'string' ? (p.productUrl as string).trim() : '');

          if (linkUrl) {
            const linkResult = await checkLinkHealth(linkUrl);
            healthUpdates.linkHealthStatus = linkResult.status;
            healthUpdates.linkLastCheckedAt = new Date().toISOString();
          }
        }

        if (!hasImageHealth && existing.imageUrl) {
          const imageResult = await checkImageHealth(existing.imageUrl);
          healthUpdates.imageHealthStatus = imageResult.status;
        }

        if (Object.keys(healthUpdates).length > 0) {
          await updateProduct(id, healthUpdates as Partial<Product>);

          // Re-fetch with updated health status
          const refreshed = await getProductById(id);
          if (refreshed) {
            const blockReason = getApproveBlockReason(refreshed);
            if (blockReason) {
              return errorResponse(blockReason, undefined, 400);
            }
          }
        }
      } catch (healthErr) {
        // Health check lỗi không chặn approve, chỉ log
        console.warn('[Approve] Health check error:', healthErr instanceof Error ? healthErr.message : String(healthErr));
      }
    }

    const blockReason = getApproveBlockReason(existing);

    if (blockReason) {
      return errorResponse(blockReason, undefined, 400);
    }

    if (existing.status === 'approved' || existing.status === 'published') {
      return successResponse('Đã duyệt sản phẩm trước đó.', existing);
    }

    const product = await approveProduct(id);

    if (!product) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }

    return successResponse('Đã duyệt sản phẩm.', product);
  } catch (err) {
    return serverErrorResponse('Không thể duyệt sản phẩm.', err);
  }
}

// Retained for migration evidence; this synchronous approval path is not exported.
void legacyApproveDisabled;

export async function POST(request: NextRequest, context: RouteContext) {
  const denied = await requirePermission(request, 'PUBLISH_CONTENT');
  if (denied) return denied;
  const { id } = await context.params;
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { /* optional body */ }
  const reason = typeof body.reason === 'string' && body.reason.trim().length >= 5
    ? body.reason.trim()
    : 'Yêu cầu Safe Publish từ Product Operations';
  try {
    const result = await enqueueProductAction({
      actor: getServerActor(),
      action: 'safe_publish',
      productId: id,
      reason,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      operationId: typeof body.operationId === 'string' ? body.operationId : undefined,
    });
    return NextResponse.json({ ok: true, code: result.code, message: 'Đã tạo Safe Publish job; cần phê duyệt trước khi worker có thể đăng.', data: result.data }, { status: result.created ? 202 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'PRODUCT_NOT_FOUND') return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy sản phẩm.' }, { status: 404 });
    if (message.startsWith('SAFE_PUBLISH_NOT_READY:')) {
      const blockers = message.slice('SAFE_PUBLISH_NOT_READY:'.length).split(',').filter(Boolean).slice(0, 20);
      return NextResponse.json({ ok: false, code: 'SAFE_PUBLISH_NOT_READY', message: 'Sản phẩm chưa đạt điều kiện Safe Publish.', data: { blockers } }, { status: 409 });
    }
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Không thể tạo yêu cầu Safe Publish.' }, { status: 400 });
  }
}
