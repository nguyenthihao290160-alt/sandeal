import { NextRequest, NextResponse } from 'next/server';
import { getProductById } from '@/lib/storage/products';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import { classifyDevice, classifyReferrer, recordGrowthEvent } from '@/lib/product-intelligence/growth';
import {
  inspectRevenueIntegrity,
  isCountableOutboundClick,
  selectRevenueIntegrityOffer,
} from '@/lib/autonomous/revenueIntegrity';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  const { productId } = await context.params;
  const product = await getProductById(productId);
  if (!product || !isPublicSafeProduct(product)) return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Deal không còn khả dụng.' }, { status: 404 });
  const offer = selectRevenueIntegrityOffer(product);
  const integrity = inspectRevenueIntegrity({ product, offer });
  const target = validateExternalUrl(offer?.affiliateUrl || product.affiliateUrl);
  if (!integrity.eligible || !target.safe || !target.normalizedUrl) {
    return NextResponse.json(
      { ok: false, code: 'AFFILIATE_INTEGRITY_BLOCKED', message: 'Liên kết nhà bán chưa an toàn để chuyển hướng.' },
      { status: 410, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } },
    );
  }
  if (isCountableOutboundClick({
    userAgent: request.headers.get('user-agent') || undefined,
    method: request.method,
    purpose: `${request.headers.get('purpose') || ''} ${request.headers.get('sec-purpose') || ''}`,
    nextRouterPrefetch: request.headers.get('next-router-prefetch') || undefined,
  })) {
    try {
      await recordGrowthEvent({
        eventType: 'OUTBOUND_CLICK', productId: product.id, source: product.source, campaign: product.campaignName,
        contentPageId: request.nextUrl.searchParams.get('content')?.slice(0, 160),
        contextKey: 'redirect:validated',
        referrerCategory: classifyReferrer(request.headers.get('referer'), request.nextUrl.hostname),
        deviceCategory: classifyDevice(request.headers.get('user-agent')),
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'outbound_click_log_failed',
        productId: product.id,
        errorCode: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      }));
    }
  }
  return NextResponse.redirect(target.normalizedUrl, {
    status: 302,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
