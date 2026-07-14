// ===========================================
// API: Products — GET (list) + POST (create)
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { listProducts, createProduct, DuplicateProductError } from '@/lib/storage/products';
import { requirePermission } from '@/lib/auth';
import type { ProductPlatform, ProductSource, ProductStatus, ProductKind, ProductRiskLevel } from '@/lib/types';
import { PublicProductQueryError, queryPublicProducts } from '@/lib/product-intelligence/publicProducts';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';

export const dynamic = 'force-dynamic';

const PRODUCT_PLATFORMS = new Set<ProductPlatform>(['shopee', 'tiktok_shop', 'lazada', 'accesstrade', 'website', 'other']);
const PRODUCT_KINDS = new Set<ProductKind>(['product', 'voucher', 'campaign', 'deal', 'store_offer', 'unknown']);
const PRODUCT_SOURCES = new Set<ProductSource>(['manual', 'accesstrade', 'shopee_affiliate', 'tiktok_shop', 'lazada_affiliate', 'csv', 'other']);
const RISK_LEVELS = new Set<ProductRiskLevel>(['low', 'medium', 'high', 'unknown']);

function validHttpUrl(value: unknown): boolean {
  return validateExternalUrl(value).safe;
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;

    const isPublicRequest = sp.get('public') === 'true';
    if (!isPublicRequest) {
      const authError = await requirePermission(request, 'VIEW_PRODUCTS');
      if (authError) return authError;
    }

    const filters = {
      q: sp.get('q') || undefined,
      platform: (sp.get('platform') as ProductPlatform) || undefined,
      source: (sp.get('source') as ProductSource) || undefined,
      status: (sp.get('status') as ProductStatus) || undefined,
      kind: (sp.get('kind') as ProductKind) || undefined,
      riskLevel: (sp.get('riskLevel') as ProductRiskLevel) || undefined,
      minScore: sp.get('minScore') ? Number(sp.get('minScore')) : undefined,
    };

    // If client requests public=true, return public-safe normalized products
    if (isPublicRequest) {
      const publicParams = new URLSearchParams(sp);
      publicParams.delete('public');
      let products;
      try {
        products = (await queryPublicProducts(publicParams)).items;
      } catch (error) {
        if (error instanceof PublicProductQueryError) return errorResponse('Bộ lọc public không hợp lệ.', 'VALIDATION_ERROR', 400);
        throw error;
      }
      return successResponse('Đã tải danh sách sản phẩm (public).', products);
    }

    const products = await listProducts(filters);
    return successResponse('Đã tải danh sách sản phẩm.', products);
  } catch (err) {
    return serverErrorResponse('Không thể tải danh sách sản phẩm.', err);
  }
}

export async function POST(request: NextRequest) {
  const authError = await requirePermission(request, 'EDIT_PRODUCTS');
  if (authError) return authError;

  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return errorResponse('Dữ liệu JSON không hợp lệ.');
    }

    // Validate required fields
    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
      return errorResponse('Tên sản phẩm là bắt buộc.');
    }
    if (!PRODUCT_PLATFORMS.has(body.platform as ProductPlatform)) {
      return errorResponse('Nền tảng là bắt buộc.');
    }
    if (body.kind && !PRODUCT_KINDS.has(body.kind as ProductKind)) return errorResponse('Loại sản phẩm không hợp lệ.');
    if (body.source && !PRODUCT_SOURCES.has(body.source as ProductSource)) return errorResponse('Nguồn sản phẩm không hợp lệ.');
    if (body.riskLevel && !RISK_LEVELS.has(body.riskLevel as ProductRiskLevel)) return errorResponse('Mức rủi ro không hợp lệ.');
    if (!body.originalUrl && !body.affiliateUrl) {
      return errorResponse('Cần ít nhất link sản phẩm gốc hoặc link affiliate.');
    }
    if (body.originalUrl && !validHttpUrl(body.originalUrl)) return errorResponse('Link sản phẩm gốc không hợp lệ.');
    if (body.affiliateUrl && !validHttpUrl(body.affiliateUrl)) return errorResponse('Link affiliate không hợp lệ.');
    for (const field of ['price', 'salePrice'] as const) {
      if (body[field] !== undefined && body[field] !== '' && (!Number.isFinite(Number(body[field])) || Number(body[field]) < 0)) {
        return errorResponse('Giá sản phẩm không hợp lệ.');
      }
    }

    // Parse tags from comma-separated string if needed
    let tags: string[] = [];
    if (typeof body.tags === 'string') {
      tags = body.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
    } else if (Array.isArray(body.tags)) {
      tags = body.tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean);
    }

    // Parse multiline fields into arrays
    const parseMultiline = (val: unknown): string[] => {
      if (Array.isArray(val)) return val.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
      if (typeof val === 'string') {
        return val.split('\n').map(l => l.trim()).filter(Boolean);
      }
      return [];
    };

    const product = await createProduct({
      title: (body.title as string).trim(),
      description: typeof body.description === 'string' ? body.description : undefined,
      kind: (body.kind as ProductKind) || 'product',
      platform: body.platform as ProductPlatform,
      source: (body.source as ProductSource) || 'manual',
      originalUrl: typeof body.originalUrl === 'string' ? body.originalUrl : undefined,
      affiliateUrl: typeof body.affiliateUrl === 'string' ? body.affiliateUrl : undefined,
      imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : undefined,
      gallery: parseMultiline(body.gallery),
      price: body.price !== undefined && body.price !== '' ? Number(body.price) : undefined,
      salePrice: body.salePrice !== undefined && body.salePrice !== '' ? Number(body.salePrice) : undefined,
      currency: 'VND',
      priceNote: typeof body.priceNote === 'string' ? body.priceNote : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      tags,
      benefits: parseMultiline(body.benefits),
      painPoints: parseMultiline(body.painPoints),
      targetAudience: parseMultiline(body.targetAudience),
      warnings: parseMultiline(body.warnings),
      contentAngles: parseMultiline(body.contentAngles),
      complianceNotes: parseMultiline(body.complianceNotes),
      affiliateSource: typeof body.affiliateSource === 'string' ? body.affiliateSource : undefined,
      campaignName: typeof body.campaignName === 'string' ? body.campaignName : undefined,
      commissionNote: typeof body.commissionNote === 'string' ? body.commissionNote : undefined,
      affiliateDisclosure: typeof body.affiliateDisclosure === 'string' ? body.affiliateDisclosure : undefined,
      riskLevel: (body.riskLevel as ProductRiskLevel) || 'unknown',
      // Manual creation can never bypass the review/publication transaction.
      status: 'needs_review',
      publicHidden: true,
      autoPublished: false,
      needsVerification: true,
      verifiedSource: false,
    });

    return successResponse('Đã thêm sản phẩm thành công.', product, 201);
  } catch (err) {
    if (err instanceof DuplicateProductError) {
      return errorResponse('Sản phẩm đã tồn tại.', err.code, 409);
    }
    return serverErrorResponse('Không thể thêm sản phẩm.', err);
  }
}
