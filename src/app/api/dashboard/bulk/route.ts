import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, getServerActor } from '@/lib/auth';
import { previewBulkOperation } from '@/lib/product-intelligence/jobs';
import { createAutomationJob } from '@/lib/automation/store';
import { generateId } from '@/lib/storage/adapter';

const MAX_BODY_BYTES = 64_000;
const PAYLOAD_KEYS = new Set(['action', 'productIds', 'category', 'tag', 'groupId', 'primaryId', 'limit']);

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VALIDATION_ERROR');
  return value as Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, 'RUN_BULK_ACTION'); if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await readBody(request); }
  catch (error) { const code = error instanceof Error ? error.message : 'VALIDATION_ERROR'; return NextResponse.json({ ok: false, code }, { status: code === 'PAYLOAD_TOO_LARGE' ? 413 : 400 }); }
  try {
    const preview = await previewBulkOperation(body);
    if (body.mode !== 'apply') return NextResponse.json({ ok: true, code: 'PREVIEW', data: preview });
    const dryRun = body.dryRun === true;
    if (!dryRun && body.confirmed !== true) return NextResponse.json({ ok: false, code: 'CONFIRMATION_REQUIRED', data: preview }, { status: 409 });
    const payload = Object.fromEntries(Object.entries(body).filter(([key]) => PAYLOAD_KEYS.has(key)));
    const result = await createAutomationJob({
      type: 'BULK_PRODUCT_OPERATION', payload,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `bulk:${generateId()}`,
      operationId: typeof body.operationId === 'string' ? body.operationId : undefined,
      requestedBy: getServerActor(),
      riskLevel: dryRun ? 'LOW' : preview.requiresApproval ? 'HIGH' : 'MEDIUM',
      dryRun,
      approvalReason: !dryRun && preview.requiresApproval ? 'Bulk action tác động lớn cần phê duyệt.' : undefined,
    });
    return NextResponse.json({ ok: true, code: result.code, data: { jobId: result.job.id, operationId: result.job.operationId, status: result.job.status } }, { status: result.created ? 201 : 200 });
  } catch (error) { return NextResponse.json({ ok: false, code: error instanceof Error ? error.message : 'VALIDATION_ERROR' }, { status: 400 }); }
}
