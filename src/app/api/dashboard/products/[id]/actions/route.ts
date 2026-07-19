import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { recordProductAdminAction } from '@/lib/product-intelligence/productActions';
import type { ProductAdminActionType } from '@/lib/product-intelligence/productPipelineTruth';

const ACTIONS = new Set<ProductAdminActionType>(['reviewed', 'data_verified', 'canary_ready', 'safe_publish_requested', 'publish_approved']);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requirePermission(request, 'EDIT_PRODUCTS');
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR' }, { status: 400 }); }
  const action = String(body.action || '') as ProductAdminActionType;
  if (!ACTIONS.has(action)) return NextResponse.json({ ok: false, code: String(body.action || '') === 'published' ? 'PUBLISH_ACTION_DISABLED' : 'INVALID_ACTION' }, { status: 400 });
  if (action === 'publish_approved') {
    const approvalDenied = await requirePermission(request, 'PUBLISH_CONTENT');
    if (approvalDenied) return approvalDenied;
  }
  const { id } = await params;
  try {
    const result = await recordProductAdminAction({ productId: id, action, actor: getServerActor(), operationId: typeof body.operationId === 'string' ? body.operationId : undefined, reason: typeof body.reason === 'string' ? body.reason : undefined });
    return NextResponse.json({ ok: true, code: result.created ? 'CREATED' : 'ALREADY_PROCESSED', data: result }, { status: result.job ? 202 : 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(':')[0] : 'ACTION_FAILED';
    return NextResponse.json({ ok: false, code, message: 'Không thể cập nhật action semantics.' }, { status: code === 'PRODUCT_NOT_FOUND' ? 404 : 409 });
  }
}
