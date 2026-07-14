import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { createAutomationJob } from '@/lib/automation/store';
import { listAffiliateLinks, parseAffiliateLinkQuery } from '@/lib/product-intelligence/affiliateLinks';
import { validateExternalUrl } from '@/lib/product-intelligence/urlSafety';
import { getAllProducts } from '@/lib/storage/products';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16_000;

function failure(code: string, status = 400) {
  const messages: Record<string, string> = {
    INVALID_FILTER: 'Bộ lọc link không hợp lệ.',
    INVALID_Q: 'Từ khóa tìm kiếm không hợp lệ.',
    INVALID_PROVIDER: 'Provider không hợp lệ.',
    INVALID_STATUS: 'Trạng thái link không hợp lệ.',
    INVALID_SORT: 'Kiểu sắp xếp không hợp lệ.',
    INVALID_PAGE: 'Trang không hợp lệ.',
    INVALID_PAGESIZE: 'Kích thước trang phải từ 1 đến 50.',
    VALIDATION_ERROR: 'Yêu cầu kiểm tra link không hợp lệ.',
    PAYLOAD_TOO_LARGE: 'Payload vượt giới hạn cho phép.',
    NO_ELIGIBLE_LINKS: 'Không có affiliate URL an toàn để đưa vào hàng chờ.',
  };
  return NextResponse.json({ ok: false, code, message: messages[code] || 'Không thể xử lý link tiếp thị liên kết.' }, { status });
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VALIDATION_ERROR');
  return value as Record<string, unknown>;
}

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_ANALYTICS');
  if (denied) return denied;
  try {
    const query = parseAffiliateLinkQuery(request.nextUrl.searchParams);
    return NextResponse.json({ ok: true, code: 'OK', data: await listAffiliateLinks(query) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'INVALID_FILTER');
  }
}

export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'MANAGE_SOURCES');
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'VALIDATION_ERROR';
    return failure(code, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
  }
  if (body.action !== 'recheck' || !Array.isArray(body.productIds) || body.productIds.length < 1 || body.productIds.length > 100) {
    return failure('VALIDATION_ERROR');
  }
  const requested = [...new Set(body.productIds.map(value => String(value).trim()))];
  if (requested.some(id => !/^[a-zA-Z0-9:_-]{1,160}$/.test(id))) return failure('VALIDATION_ERROR');
  const products = await getAllProducts();
  const byId = new Map(products.map(product => [product.id, product]));
  const eligible: string[] = [];
  const skipped: Array<{ productId: string; reason: 'not_found' | 'unsafe_or_missing_affiliate' }> = [];
  for (const id of requested) {
    const product = byId.get(id);
    if (!product) skipped.push({ productId: id, reason: 'not_found' });
    else if (!validateExternalUrl(product.affiliateUrl).safe) skipped.push({ productId: id, reason: 'unsafe_or_missing_affiliate' });
    else eligible.push(id);
  }
  if (!eligible.length) return failure('NO_ELIGIBLE_LINKS');
  const hour = new Date().toISOString().slice(0, 13).replace(/[^0-9]/g, '');
  const digest = createHash('sha256').update([...eligible].sort().join('\n')).digest('hex').slice(0, 20);
  const dryRun = body.dryRun === true;
  try {
    const result = await createAutomationJob({
      type: 'RECHECK_PRODUCT_HEALTH',
      payload: { productIds: eligible, healthTarget: 'affiliate' },
      idempotencyKey: `affiliate-health:${dryRun ? 'dry' : 'apply'}:${hour}:${digest}`,
      requestedBy: getServerActor(),
      riskLevel: 'MEDIUM',
      dryRun,
    });
    return NextResponse.json({
      ok: true,
      code: result.code,
      data: {
        jobId: result.job.id,
        operationId: result.job.operationId,
        status: result.job.status,
        accepted: eligible,
        skipped,
      },
    }, { status: result.created ? 201 : 200, headers: { 'Cache-Control': 'no-store', 'X-Operation-Id': result.job.operationId } });
  } catch (error) {
    const code = error instanceof Error && ['INVALID_IDEMPOTENCY_KEY', 'PAYLOAD_TOO_LARGE'].includes(error.message)
      ? error.message
      : 'VALIDATION_ERROR';
    return failure(code, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
  }
}
