// ===========================================
// API: Products — GET (list) + POST (create)
// ===========================================

import { type NextRequest, NextResponse } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { listProducts, createProduct, DuplicateProductError, SourceCandidateMappingConflictError, upsertSourceCandidateProduct } from '@/lib/storage/products';
import { requirePermission } from '@/lib/auth';
import type { CreateProductInput, ProductPlatform, ProductSource, ProductStatus, ProductKind, ProductRiskLevel } from '@/lib/types';
import { PublicProductQueryError, queryPublicProducts } from '@/lib/product-intelligence/publicProducts';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import { extractAccessTradeAffiliateDestination, normalizeAccessTradeImageUrl } from '@/lib/integrations/accesstrade';

export const dynamic = 'force-dynamic';

const PRODUCT_PLATFORMS = new Set<ProductPlatform>(['shopee', 'tiktok_shop', 'lazada', 'accesstrade', 'website', 'other']);
const PRODUCT_KINDS = new Set<ProductKind>(['product', 'voucher', 'campaign', 'deal', 'store_offer', 'unknown']);
const PRODUCT_SOURCES = new Set<ProductSource>(['manual', 'accesstrade', 'shopee_affiliate', 'tiktok_shop', 'lazada_affiliate', 'csv', 'other']);
const RISK_LEVELS = new Set<ProductRiskLevel>(['low', 'medium', 'high', 'unknown']);

function validHttpUrl(value: unknown): boolean {
  return validateExternalUrl(value).safe;
}

const SOURCE_SECRET_KEY = /token|secret|password|cookie|authorization|api[_-]?key|credential/i;
const SOURCE_PAYLOAD_MAX_BYTES = 32 * 1024;

function sanitizeSourceValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return '[truncated]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeSourceValue(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SOURCE_SECRET_KEY.test(key))
    .slice(0, 64)
    .map(([key, item]) => [key.slice(0, 120), sanitizeSourceValue(item, depth + 1)]));
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sanitizeSourcePayload(value: unknown): unknown {
  const sanitized = sanitizeSourceValue(value);
  if (serializedBytes(sanitized) <= SOURCE_PAYLOAD_MAX_BYTES) return sanitized;
  if (Array.isArray(sanitized)) {
    const bounded: unknown[] = [];
    for (const item of sanitized) {
      if (serializedBytes([...bounded, item]) > SOURCE_PAYLOAD_MAX_BYTES) break;
      bounded.push(item);
    }
    return bounded;
  }
  if (sanitized && typeof sanitized === 'object') {
    const bounded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(sanitized as Record<string, unknown>)) {
      const next = { ...bounded, [key]: item };
      if (serializedBytes(next) > SOURCE_PAYLOAD_MAX_BYTES) continue;
      bounded[key] = item;
    }
    return bounded;
  }
  return undefined;
}

function sourceEvidenceText(rawData: Record<string, unknown> | undefined, fields: readonly string[]): { value?: string; field?: string } {
  for (const field of fields) {
    const value = rawData?.[field];
    if (typeof value === 'string' && value.trim()) return { value: value.trim().slice(0, 4_096), field };
    if (typeof value === 'number' && Number.isFinite(value)) return { value: String(value), field };
  }
  return {};
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
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

    const source = (body.source as ProductSource) || 'manual';
    const accessTrade = source === 'accesstrade' && body.platform === 'accesstrade';
    const sanitizedRawSource = sanitizeSourcePayload(body.rawData);
    const rawData = sanitizedRawSource && typeof sanitizedRawSource === 'object' && !Array.isArray(sanitizedRawSource)
      ? sanitizedRawSource as Record<string, unknown>
      : undefined;
    const canonicalEvidence = accessTrade
      ? sourceEvidenceText(rawData, ['url', 'link', 'productUrl', 'product_url'])
      : {};
    const affiliateEvidence = accessTrade ? sourceEvidenceText(rawData, ['aff_link']) : {};
    const imageEvidence = accessTrade
      ? sourceEvidenceText(rawData, ['image', 'image_url', 'imageUrl', 'productImage', 'product_image'])
      : {};
    const priceEvidence = accessTrade
      ? sourceEvidenceText(rawData, ['price', 'sale_price', 'salePrice', 'currentPrice', 'current_price'])
      : {};
    const originalUrl = typeof body.originalUrl === 'string' ? body.originalUrl : undefined;
    const affiliateUrl = typeof body.affiliateUrl === 'string' ? body.affiliateUrl : undefined;
    const canonicalUrlSourceField = accessTrade && ['url', 'link'].includes(String(body.canonicalUrlSourceField || ''))
      ? String(body.canonicalUrlSourceField)
      : undefined;
    const affiliateUrlSourceField = accessTrade && body.affiliateUrlSourceField === 'aff_link' ? 'aff_link' : undefined;
    const sourceEndpoint = accessTrade && ['datafeed', 'offers'].includes(String(body.sourceEndpoint || body.canonicalUrlSourceEndpoint || ''))
      ? String(body.sourceEndpoint || body.canonicalUrlSourceEndpoint)
      : undefined;
    const sourceFetchedAt = isoDate(body.sourceFetchedAt || body.canonicalUrlFetchedAt || body.affiliateUrlFetchedAt);
    const sourceItemId = typeof body.sourceItemId === 'string'
      ? body.sourceItemId.trim().slice(0, 240)
      : typeof body.sourceId === 'string' ? body.sourceId.trim().slice(0, 240) : undefined;
    const verifiedSource = Boolean(accessTrade && body.sourceVerified === true && sourceItemId && sourceEndpoint && canonicalUrlSourceField);
    const imageUrl = normalizeAccessTradeImageUrl(body.imageUrl);
    const suppliedPrice = body.salePrice !== undefined && body.salePrice !== '' ? Number(body.salePrice)
      : body.price !== undefined && body.price !== '' ? Number(body.price) : undefined;
    const fetchedPrice = suppliedPrice !== undefined && Number.isFinite(suppliedPrice) && suppliedPrice > 0
      ? suppliedPrice
      : undefined;
    const decodedAffiliateDestination = extractAccessTradeAffiliateDestination(affiliateUrl);
    const suppliedAffiliateDestination = typeof body.affiliateDestinationUrl === 'string' && validHttpUrl(body.affiliateDestinationUrl)
      ? body.affiliateDestinationUrl
      : undefined;
    // AccessTrade destinations must be derived from the provider tracking URL,
    // never trusted from a parallel browser field that could disagree with it.
    const affiliateDestinationUrl = accessTrade ? decodedAffiliateDestination : suppliedAffiliateDestination;

    const productDraft: CreateProductInput = {
      title: (body.title as string).trim(),
      description: typeof body.description === 'string' ? body.description : undefined,
      kind: (body.kind as ProductKind) || 'product',
      platform: body.platform as ProductPlatform,
      source,
      originalUrl,
      canonicalProductUrl: originalUrl,
      canonicalUrlSource: accessTrade && canonicalUrlSourceField ? 'provider_api' : source === 'manual' ? 'manual' : 'none',
      canonicalUrlProvider: accessTrade && canonicalUrlSourceField ? 'accesstrade' : source === 'manual' ? 'manual' : undefined,
      canonicalUrlSourceEndpoint: sourceEndpoint,
      canonicalUrlSourceField,
      canonicalUrlFetchedAt: sourceFetchedAt,
      canonicalUrlStatus: originalUrl ? 'unverified' : canonicalEvidence.value ? 'invalid' : 'unavailable',
      affiliateUrl,
      affiliateDestinationUrl,
      affiliateUrlSource: body.affiliateUrlSource === 'provider_api' ? 'provider_api' : body.affiliateUrlSource === 'manual' ? 'manual' : 'none',
      affiliateUrlProvider: accessTrade && affiliateUrlSourceField ? 'accesstrade' : source === 'manual' ? 'manual' : undefined,
      affiliateUrlSourceEndpoint: sourceEndpoint,
      affiliateUrlSourceField,
      affiliateUrlCampaignId: typeof body.affiliateUrlCampaignId === 'string' ? body.affiliateUrlCampaignId.slice(0, 240) : undefined,
      affiliateUrlFetchedAt: sourceFetchedAt,
      affiliateUrlStatus: affiliateUrl ? 'unverified' : affiliateEvidence.value ? 'invalid' : 'unavailable',
      deepLinkSupported: typeof body.deepLinkSupported === 'boolean' ? body.deepLinkSupported : undefined,
      affiliateLinkReason: typeof body.affiliateLinkReason === 'string' ? body.affiliateLinkReason.slice(0, 240) : undefined,
      imageUrl: imageUrl || undefined,
      gallery: parseMultiline(body.gallery),
      price: body.price !== undefined && body.price !== '' ? Number(body.price) : undefined,
      salePrice: body.salePrice !== undefined && body.salePrice !== '' ? Number(body.salePrice) : undefined,
      currency: 'VND',
      priceVerificationStatus: fetchedPrice !== undefined ? 'UNVERIFIED' : priceEvidence.value ? 'INVALID' : 'MISSING',
      priceObservedAt: sourceFetchedAt,
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
      externalId: sourceItemId,
      sourceId: sourceItemId,
      sourceItemId,
      sourceEndpoint,
      sourceFetchedAt,
      sourceItemKind: (body.sourceItemKind as ProductKind) || (body.kind as ProductKind) || 'product',
      rawSourceKind: typeof body.rawSourceKind === 'string' ? body.rawSourceKind.slice(0, 160) : undefined,
      rawSourceType: typeof body.rawSourceType === 'string' ? body.rawSourceType.slice(0, 160) : undefined,
      sourceType: typeof body.sourceType === 'string' ? body.sourceType.slice(0, 80) : undefined,
      dataSource: typeof body.dataSource === 'string' ? body.dataSource.slice(0, 80) : undefined,
      importedFrom: typeof body.importedFrom === 'string' ? body.importedFrom.slice(0, 80) : undefined,
      merchant: typeof body.merchant === 'string' ? body.merchant.slice(0, 240) : undefined,
      merchantDomain: typeof body.merchantDomain === 'string' ? body.merchantDomain.toLowerCase().slice(0, 240) : undefined,
      shopId: typeof body.shopId === 'string' ? body.shopId.trim().slice(0, 240) : undefined,
      shopName: typeof body.shopName === 'string' ? body.shopName.trim().slice(0, 240) : undefined,
      sku: typeof body.sku === 'string' ? body.sku.trim().slice(0, 240) : undefined,
      providerUpdatedAt: isoDate(body.providerUpdatedAt),
      sourceNormalizationIssues: Array.isArray(body.sourceNormalizationIssues)
        ? body.sourceNormalizationIssues
            .filter((issue): issue is string => typeof issue === 'string')
            .slice(0, 16)
            .map((issue) => issue.slice(0, 80))
        : [],
      sourceQualityScore: Number.isFinite(Number(body.sourceQualityScore)) ? Math.max(0, Math.min(100, Number(body.sourceQualityScore))) : undefined,
      rawData,
      fieldProvenance: {
        canonicalProductUrl: {
          value: originalUrl || canonicalEvidence.value,
          source,
          provider: accessTrade ? 'accesstrade' : source,
          endpoint: sourceEndpoint,
          sourceField: canonicalUrlSourceField || canonicalEvidence.field,
          fetchedAt: sourceFetchedAt,
          canonicalizedAt: originalUrl ? new Date().toISOString() : undefined,
          verificationStatus: originalUrl ? 'UNVERIFIED' : canonicalEvidence.value ? 'INVALID' : 'MISSING',
          verificationReason: originalUrl ? undefined : canonicalEvidence.value ? 'CANONICAL_URL_FORMAT_INVALID' : 'CANONICAL_URL_MISSING',
        },
        affiliateUrl: {
          value: affiliateUrl || affiliateEvidence.value,
          source,
          provider: accessTrade ? 'accesstrade' : source,
          endpoint: sourceEndpoint,
          sourceField: affiliateUrlSourceField || affiliateEvidence.field,
          fetchedAt: sourceFetchedAt,
          canonicalizedAt: affiliateUrl ? new Date().toISOString() : undefined,
          verificationStatus: affiliateUrl ? 'UNVERIFIED' : affiliateEvidence.value ? 'INVALID' : 'MISSING',
          verificationReason: affiliateUrl ? undefined : affiliateEvidence.value ? 'AFFILIATE_URL_FORMAT_INVALID' : 'AFFILIATE_URL_MISSING',
        },
        imageUrl: {
          value: imageUrl || imageEvidence.value,
          source,
          provider: accessTrade ? 'accesstrade' : source,
          endpoint: sourceEndpoint,
          sourceField: typeof body.imageSourceField === 'string' ? body.imageSourceField.slice(0, 80) : imageEvidence.field || 'image',
          fetchedAt: sourceFetchedAt,
          canonicalizedAt: imageUrl ? new Date().toISOString() : undefined,
          verificationStatus: imageUrl ? 'UNVERIFIED' : imageEvidence.value ? 'INVALID' : 'MISSING',
          verificationReason: imageUrl ? undefined : imageEvidence.value ? 'IMAGE_URL_FORMAT_INVALID' : 'IMAGE_URL_MISSING',
        },
        price: {
          value: fetchedPrice ?? priceEvidence.value,
          source,
          provider: accessTrade ? 'accesstrade' : source,
          endpoint: sourceEndpoint,
          sourceField: body.salePrice !== undefined && body.salePrice !== '' ? 'salePrice' : priceEvidence.field || 'price',
          fetchedAt: sourceFetchedAt,
          canonicalizedAt: fetchedPrice !== undefined ? new Date().toISOString() : undefined,
          verificationStatus: fetchedPrice !== undefined ? 'UNVERIFIED' : priceEvidence.value ? 'INVALID' : 'MISSING',
          verificationReason: fetchedPrice !== undefined ? undefined : priceEvidence.value ? 'PRICE_FORMAT_INVALID' : 'PRICE_MISSING',
        },
      },
      // Manual creation can never bypass the review/publication transaction.
      status: 'needs_review',
      publicHidden: true,
      publicBlocked: true,
      autoPublished: false,
      needsVerification: true,
      verifiedSource,
      sourceVerified: verifiedSource,
    };

    if (productDraft.source === 'accesstrade' && productDraft.sourceId) {
      const result = await upsertSourceCandidateProduct(productDraft);
      const evidenceLabel = result.mapping.duplicateEvidence.includes('SOURCE_ID_EXACT')
        ? 'source ID trùng chính xác'
        : result.mapping.duplicateEvidence.includes('CANONICAL_URL_EXACT')
          ? 'URL sản phẩm gốc trùng chính xác'
          : '';
      const message = result.created
        ? 'Đã thêm sản phẩm AccessTrade vào hàng chờ.'
        : result.mapping.enrichedFields.length
          ? `Sản phẩm đã tồn tại (ID ${result.mapping.canonicalIdentifier}); ${evidenceLabel}. Đã bổ sung: ${result.mapping.enrichedFields.join(', ')}.`
          : `Sản phẩm đã tồn tại (ID ${result.mapping.canonicalIdentifier}); ${evidenceLabel}. Không có trường còn thiếu cần bổ sung.`;
      const responseData = { ...result.product, mapping: result.mapping };
      if (result.created) return successResponse(message, responseData, 201);

      const existingProductUrl = `/dashboard/products/${encodeURIComponent(result.product.id)}`;
      const mergeResult = {
        updatedFields: result.mapping.enrichedFields,
        unchangedFields: result.mapping.unchangedFields,
      };
      return NextResponse.json({
        ok: false,
        success: false,
        code: 'DUPLICATE_PRODUCT',
        error: 'DUPLICATE_PRODUCT',
        message,
        existingProductId: result.product.id,
        existingProductUrl,
        mergeResult,
        data: {
          ...responseData,
          existingProductId: result.product.id,
          existingProductUrl,
          mergeResult,
        },
      }, { status: 409 });
    }

    const product = await createProduct(productDraft);

    return successResponse('Đã thêm sản phẩm thành công.', product, 201);
  } catch (err) {
    if (err instanceof SourceCandidateMappingConflictError) {
      return errorResponse('Candidate có bằng chứng định danh mâu thuẫn giữa nhiều sản phẩm. Không tự động merge; cần kiểm tra thủ công.', err.code, 409);
    }
    if (err instanceof DuplicateProductError) {
      return NextResponse.json({
        ok: false,
        code: err.code,
        error: err.code,
        message: err.mergeResult.updatedFields.length
          ? 'Sản phẩm đã tồn tại; các trường nguồn còn thiếu đã được bổ sung an toàn.'
          : 'Sản phẩm đã tồn tại.',
        existingProductId: err.existingProductId,
        existingProductUrl: err.existingProductUrl,
        mergeResult: err.mergeResult,
        data: {
          existingProductId: err.existingProductId,
          existingProductUrl: err.existingProductUrl,
          mergeResult: err.mergeResult,
        },
      }, { status: 409 });
    }
    return serverErrorResponse('Không thể thêm sản phẩm.', err);
  }
}
