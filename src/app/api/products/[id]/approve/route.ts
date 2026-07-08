// ===========================================
// API: Approve Product
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { approveProduct, getProductById } from '@/lib/storage/products';
import {
  classifyProductKind,
  looksLikeVoucherOrCampaign,
} from '@/lib/sourceItemClassifier';
import type { Product, ProductKind } from '@/lib/types';

export const dynamic = 'force-dynamic';

function normalizeText(value?: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
}

function getEffectiveKind(product: Product): ProductKind {
  const p = product as Product & {
    sourceItemKind?: ProductKind;
    kind?: ProductKind;
  };

  const explicitKind = p.sourceItemKind || p.kind;

  // Không tin "unknown" vì dữ liệu cũ có thể bị lưu thiếu phân loại.
  if (explicitKind && explicitKind !== 'unknown') {
    // Nếu bị gắn nhầm product/deal nhưng tiêu đề giống voucher thì phân loại lại.
    if (
        (explicitKind === 'product' || explicitKind === 'deal') &&
        (looksLikeVoucherOrCampaign(product) || looksLikeVoucherOrCampaign(product.title))
    ) {
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
  const p = product as Product & {
    affiliateUrl?: unknown;
    originalUrl?: unknown;
    url?: unknown;
    productUrl?: unknown;
    landingUrl?: unknown;
  };

  const urls = [
    p.affiliateUrl,
    p.originalUrl,
    p.url,
    p.productUrl,
    p.landingUrl,
  ];

  return urls.some((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
}

function hasPlatformOrSource(product: Product): boolean {
  const p = product as Product & {
    platform?: unknown;
    source?: unknown;
    dataSource?: unknown;
  };

  return Boolean(
      normalizeText(p.platform) ||
      normalizeText(p.source) ||
      normalizeText(p.dataSource),
  );
}

function isDemoOrInternal(product: Product): boolean {
  const p = product as Product & {
    source?: unknown;
    dataSource?: unknown;
    title?: unknown;
    isDemo?: boolean;
    isSample?: boolean;
    isTest?: boolean;
    isInternal?: boolean;
    publicHidden?: boolean;
    archived?: boolean;
    deleted?: boolean;
    hidden?: boolean;
  };

  const source = normalizeText(p.source);
  const dataSource = normalizeText(p.dataSource);
  const title = normalizeText(p.title);

  return Boolean(
      p.isDemo === true ||
      p.isSample === true ||
      p.isTest === true ||
      p.isInternal === true ||
      p.publicHidden === true ||
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
  const p = product as Product & {
    linkHealthStatus?: unknown;
  };

  const status = normalizeText(p.linkHealthStatus);

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

function getApproveBlockReason(product: Product): string | null {
  const kind = getEffectiveKind(product);
  const status = normalizeText(product.status);

  if (status === 'archived') {
    return 'Sản phẩm đã lưu trữ, không thể duyệt public.';
  }

  if (status === 'published') {
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

  if (looksLikeVoucherOrCampaign(product) || looksLikeVoucherOrCampaign(product.title)) {
    return 'Tiêu đề giống voucher/chiến dịch/ưu đãi shop, không thể duyệt public.';
  }

  if (!product.title || !String(product.title).trim()) {
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

  const p = product as Product & {
    source?: unknown;
    verifiedSource?: boolean;
  };

  if (normalizeText(p.source) === 'manual' && p.verifiedSource !== true) {
    return 'Sản phẩm nhập thủ công chưa được xác minh nguồn, không thể duyệt public.';
  }

  if (isBrokenLinkStatus(product)) {
    return 'Link sản phẩm đang lỗi hoặc không khả dụng, không thể duyệt public.';
  }

  return null;
}

export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existing = await getProductById(id);

    if (!existing) {
      return errorResponse('Không tìm thấy sản phẩm.', undefined, 404);
    }

    const blockReason = getApproveBlockReason(existing);

    if (blockReason) {
      return errorResponse(blockReason, undefined, 400);
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