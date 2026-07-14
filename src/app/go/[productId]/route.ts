import { NextRequest, NextResponse } from 'next/server';
import { getProductById } from '@/lib/storage/products';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import { classifyDevice, classifyReferrer, recordGrowthEvent } from '@/lib/product-intelligence/growth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  const { productId } = await context.params;
  const product = await getProductById(productId);
  if (!product || !isPublicSafeProduct(product)) return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Deal không còn khả dụng.' }, { status: 404 });
  const target = validateExternalUrl(product.affiliateUrl || product.originalUrl);
  if (!target.safe || !target.normalizedUrl) return NextResponse.json({ ok: false, code: 'UNSAFE_TARGET', message: 'Liên kết nhà bán chưa an toàn để chuyển hướng.' }, { status: 410 });
  await recordGrowthEvent({
    eventType: 'click', productId: product.id, source: product.source, campaign: product.campaignName,
    contentPageId: request.nextUrl.searchParams.get('content')?.slice(0, 160),
    referrerCategory: classifyReferrer(request.headers.get('referer'), request.nextUrl.hostname),
    deviceCategory: classifyDevice(request.headers.get('user-agent')),
  }).catch(() => undefined);
  return NextResponse.redirect(target.normalizedUrl, { status: 302, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin' } });
}
