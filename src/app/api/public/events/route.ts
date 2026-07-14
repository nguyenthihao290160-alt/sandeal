import { NextRequest, NextResponse } from 'next/server';
import { getProductById } from '@/lib/storage/products';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { classifyDevice, classifyReferrer, recordGrowthEvent } from '@/lib/product-intelligence/growth';

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const productId = typeof body.productId === 'string' ? body.productId.trim().slice(0, 160) : '';
  if (!productId) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  const product = await getProductById(productId);
  if (!product || !isPublicSafeProduct(product)) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  const requestedEventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  if (requestedEventId && !/^[a-zA-Z0-9:_-]{8,160}$/.test(requestedEventId)) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  }
  await recordGrowthEvent({
    id: requestedEventId || undefined,
    eventType: 'view', productId, source: product.source, campaign: product.campaignName,
    contentPageId: typeof body.contentPageId === 'string' ? body.contentPageId.slice(0, 160) : undefined,
    referrerCategory: classifyReferrer(request.headers.get('referer'), request.nextUrl.hostname),
    deviceCategory: classifyDevice(request.headers.get('user-agent')),
  });
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
