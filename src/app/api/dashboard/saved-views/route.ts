import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, getServerActor } from '@/lib/auth';
import { createSavedView, deleteSavedView, listSavedViews, updateSavedView } from '@/lib/product-intelligence/savedViews';
import { appendAutomationAudit } from '@/lib/automation/store';
import { generateId } from '@/lib/storage/adapter';

const PAGES = new Set(['products', 'quality', 'duplicates', 'content', 'tasks', 'alerts']);
const MAX_BODY_BYTES = 32_000;

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('VALIDATION_ERROR');
  return parsed as Record<string, unknown>;
}

async function audit(action: string, id: string, actor: string, operationId: string) {
  await appendAutomationAudit({
    correlationId: operationId,
    operationId,
    operationType: action,
    actor,
    target: `saved-view:${id}`,
    risk: 'LOW',
    reasons: [],
    dryRun: false,
    attempts: 1,
  });
}

export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_PRODUCTS'); if (denied) return denied;
  const page = request.nextUrl.searchParams.get('page'); if (page && !PAGES.has(page)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 });
  return NextResponse.json({ ok: true, code: 'OK', data: await listSavedViews(page as never, getServerActor()) }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>; try { body = await readBody(request); } catch (error) { return NextResponse.json({ ok: false, code: error instanceof Error ? error.message : 'VALIDATION_ERROR' }, { status: error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400 }); }
  const denied = await requirePermission(request, 'VIEW_PRODUCTS'); if (denied) return denied;
  try {
    const actor = getServerActor();
    const data = await createSavedView({ ...body, createdBy: actor });
    const operationId = typeof body.operationId === 'string' && body.operationId.trim() ? body.operationId.trim().slice(0, 160) : generateId();
    await audit('SAVED_VIEW_CREATED', data.id, actor, operationId);
    return NextResponse.json({ ok: true, code: 'OK', operationId, data }, { status: 201 });
  }
  catch (error) { return NextResponse.json({ ok: false, code: error instanceof Error ? error.message : 'VALIDATION_ERROR' }, { status: 400 }); }
}
export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>; try { body = await readBody(request); } catch (error) { return NextResponse.json({ ok: false, code: error instanceof Error ? error.message : 'VALIDATION_ERROR' }, { status: error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400 }); }
  const denied = await requirePermission(request, 'VIEW_PRODUCTS'); if (denied) return denied;
  try {
    const actor = getServerActor();
    const data = await updateSavedView(String(body.id || ''), body, actor);
    if (!data) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
    const operationId = typeof body.operationId === 'string' && body.operationId.trim() ? body.operationId.trim().slice(0, 160) : generateId();
    await audit('SAVED_VIEW_UPDATED', data.id, actor, operationId);
    return NextResponse.json({ ok: true, code: 'OK', operationId, data });
  }
  catch (error) { return NextResponse.json({ ok: false, code: error instanceof Error ? error.message : 'VALIDATION_ERROR' }, { status: 400 }); }
}
export async function DELETE(request: NextRequest) {
  const denied = await requirePermission(request, 'VIEW_PRODUCTS'); if (denied) return denied;
  const actor = getServerActor();
  const id = request.nextUrl.searchParams.get('id') || '';
  const deleted = await deleteSavedView(id, actor);
  if (deleted) {
    const operationId = generateId();
    await audit('SAVED_VIEW_DELETED', id, actor, operationId);
    return NextResponse.json({ ok: true, code: 'OK', operationId });
  }
  return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
}
