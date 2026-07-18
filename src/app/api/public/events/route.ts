import { NextRequest, NextResponse } from 'next/server';
import { getProductById } from '@/lib/storage/products';
import { isPublicSafeProduct } from '@/lib/publicProductFilter';
import { classifyDevice, classifyReferrer, recordGrowthEvent } from '@/lib/product-intelligence/growth';

const CLIENT_EVENT_TYPES = new Set([
  'PUBLIC_SEARCH',
  'SEARCH_NO_RESULT',
  'CATEGORY_VIEW',
  'PRODUCT_CARD_VIEW',
  'PRODUCT_CARD_CLICK',
  'PRODUCT_DETAIL_VIEW',
  'PRICE_HISTORY_OPEN',
  'COMPARE_ADD',
  'COMPARE_OPEN',
  'GUIDE_VIEW',
]);

const PRODUCT_EVENT_TYPES = new Set([
  'PRODUCT_CARD_VIEW',
  'PRODUCT_CARD_CLICK',
  'PRODUCT_DETAIL_VIEW',
  'PRICE_HISTORY_OPEN',
  'COMPARE_ADD',
]);

function boundedKey(value: unknown, maximum = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return clean && clean.length <= maximum && /^[a-zA-Z0-9:_-]+$/.test(clean) ? clean : undefined;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const eventType = typeof body.eventType === 'string' ? body.eventType : 'PRODUCT_DETAIL_VIEW';
  if (!CLIENT_EVENT_TYPES.has(eventType)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  const productId = boundedKey(body.productId);
  if (PRODUCT_EVENT_TYPES.has(eventType) && !productId) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  }
  const product = productId ? await getProductById(productId) : null;
  if (productId && (!product || !isPublicSafeProduct(product))) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  }
  const requestedEventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  if (requestedEventId && !/^[a-zA-Z0-9:_-]{8,160}$/.test(requestedEventId)) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  }
  const anonymousSessionId = body.anonymousSessionId === undefined ? undefined : boundedKey(body.anonymousSessionId, 80);
  if (body.anonymousSessionId !== undefined && !anonymousSessionId) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  }
  const contentPageId = body.contentPageId === undefined ? undefined : boundedKey(body.contentPageId);
  const contextKey = body.contextKey === undefined ? undefined : boundedKey(body.contextKey, 120);
  const resultCount = body.resultCount === undefined ? undefined : Number(body.resultCount);
  if ((body.contentPageId !== undefined && !contentPageId)
    || (body.contextKey !== undefined && !contextKey)
    || (resultCount !== undefined && (!Number.isSafeInteger(resultCount) || resultCount < 0 || resultCount > 50))) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  }
  await recordGrowthEvent({
    id: requestedEventId || undefined,
    eventType: eventType as Parameters<typeof recordGrowthEvent>[0]['eventType'],
    productId,
    source: product?.source || 'public',
    campaign: product?.campaignName,
    contentPageId,
    contextKey,
    resultCount,
    anonymousSessionId,
    referrerCategory: classifyReferrer(request.headers.get('referer'), request.nextUrl.hostname),
    deviceCategory: classifyDevice(request.headers.get('user-agent')),
  });
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
