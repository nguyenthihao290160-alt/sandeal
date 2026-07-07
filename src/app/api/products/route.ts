// ===========================================
// API: Products — GET (list) + POST (create)
// ===========================================

import { type NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { listProducts, createProduct } from '@/lib/storage/products';
import type { ProductPlatform, ProductSource, ProductStatus, ProductKind, ProductRiskLevel } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;

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
    if (sp.get('public') === 'true') {
      // lazy import to avoid cycles
      const { getPublicProducts } = await import('@/lib/storage/products');
      const products = await getPublicProducts(filters as any);
      return successResponse('Đã tải danh sách sản phẩm (public).', products);
    }

    const products = await listProducts(filters);
    return successResponse('Đã tải danh sách sản phẩm.', products);
  } catch (err) {
    return serverErrorResponse('Không thể tải danh sách sản phẩm.', err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields
    if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
      return errorResponse('Tên sản phẩm là bắt buộc.');
    }
    if (!body.platform) {
      return errorResponse('Nền tảng là bắt buộc.');
    }
    if (!body.originalUrl && !body.affiliateUrl) {
      return errorResponse('Cần ít nhất link sản phẩm gốc hoặc link affiliate.');
    }

    // Parse tags from comma-separated string if needed
    let tags: string[] = [];
    if (typeof body.tags === 'string') {
      tags = body.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
    } else if (Array.isArray(body.tags)) {
      tags = body.tags;
    }

    // Parse multiline fields into arrays
    const parseMultiline = (val: unknown): string[] => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        return val.split('\n').map(l => l.trim()).filter(Boolean);
      }
      return [];
    };

    const product = await createProduct({
      title: body.title.trim(),
      description: body.description || undefined,
      kind: body.kind || 'product',
      platform: body.platform,
      source: body.source || 'manual',
      originalUrl: body.originalUrl || undefined,
      affiliateUrl: body.affiliateUrl || undefined,
      imageUrl: body.imageUrl || undefined,
      gallery: parseMultiline(body.gallery),
      price: body.price ? Number(body.price) : undefined,
      salePrice: body.salePrice ? Number(body.salePrice) : undefined,
      currency: 'VND',
      priceNote: body.priceNote || undefined,
      category: body.category || undefined,
      tags,
      benefits: parseMultiline(body.benefits),
      painPoints: parseMultiline(body.painPoints),
      targetAudience: parseMultiline(body.targetAudience),
      warnings: parseMultiline(body.warnings),
      contentAngles: parseMultiline(body.contentAngles),
      complianceNotes: parseMultiline(body.complianceNotes),
      affiliateSource: body.affiliateSource || undefined,
      campaignName: body.campaignName || undefined,
      commissionNote: body.commissionNote || undefined,
      affiliateDisclosure: body.affiliateDisclosure || undefined,
      riskLevel: body.riskLevel || 'unknown',
      status: body.status || 'needs_review',
    });

    return successResponse('Đã thêm sản phẩm thành công.', product, 201);
  } catch (err) {
    return serverErrorResponse('Không thể thêm sản phẩm.', err);
  }
}
