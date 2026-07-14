import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, getServerActor } from '@/lib/auth';
import { getProductById } from '@/lib/storage/products';
import { getPriceStatistics, listPriceHistory } from '@/lib/product-intelligence/priceHistory';
import { createAutomationJob } from '@/lib/automation/store';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_PRICE_HISTORY'); if (denied) return denied;
  const productId = request.nextUrl.searchParams.get('productId') || ''; if (!productId || productId.length > 160) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  const product = await getProductById(productId); if (!product) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ ok: true, code: 'OK', data: { product: { id: product.id, title: product.title }, snapshots: await listPriceHistory(productId), statistics: await getPriceStatistics(productId) } }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_PRICE_HISTORY'); if (denied) return denied;
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const productIds = Array.isArray(body.productIds) ? body.productIds.map(String).slice(0, 100) : [];
  if (!productIds.length) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  const result = await createAutomationJob({ type: 'CAPTURE_PRICE_HISTORY', payload: { productIds }, idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `price:${new Date().toISOString().slice(0, 13)}:${productIds.length}`, requestedBy: getServerActor(), riskLevel: 'MEDIUM', dryRun: body.dryRun === true });
  return NextResponse.json({ ok: true, code: result.code, data: { jobId: result.job.id, operationId: result.job.operationId } }, { status: result.created ? 201 : 200 });
}
