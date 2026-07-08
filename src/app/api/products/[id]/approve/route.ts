// ===========================================
// API: Approve Product
// Safe approve / AutoPilot-compatible approve
// ===========================================

import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { approveProduct, getProductById } from '@/lib/storage/products';
import {
  classifyProductKind,
  looksLikeVoucherOrCampaign,
} from '@/lib/sourceItemClassifier';
import type { Product, ProductKind } from '@/lib/types';

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

  return null;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;

    const { id } = await context.params;

    const existing = await getProductById(id);

    if (!existing) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }

    const blockReason = getApproveBlockReason(existing);

    if (blockReason) {
      return errorResponse(blockReason, undefined, 400);
    }

    if (existing.status === 'approved' || existing.status === 'published') {
      return successResponse('Sản phẩm đã được duyệt trước đó.', existing);
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