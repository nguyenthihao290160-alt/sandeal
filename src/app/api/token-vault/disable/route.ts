// ===========================================
// API: Token Vault — Disable Credential
// ===========================================

import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { disableCredential } from '@/lib/storage/tokenVault';
import { getServerActor, requirePermission } from '@/lib/auth';
import { appendAutomationAuditOnce } from '@/lib/automation/store';
import { generateId } from '@/lib/storage/adapter';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (authError) return authError;
  try {
    const body = await request.json();
    const { id, operationId: requestedOperationId } = body as { id?: string; operationId?: string };

    if (!id || typeof id !== 'string') {
      return errorResponse('ID credential là bắt buộc.');
    }

    const updated = await disableCredential(id);
    if (!updated) {
      return errorResponse('Không tìm thấy credential.', undefined, 404);
    }

    const operationId = typeof requestedOperationId === 'string' && requestedOperationId.trim() ? requestedOperationId.trim().slice(0, 160) : generateId();
    await appendAutomationAuditOnce({ correlationId: operationId, operationId, operationType: 'CREDENTIAL_DISABLED', actor: getServerActor(), target: id, risk: 'MEDIUM', reasons: [], result: { platform: updated.platform, role: updated.role }, dryRun: false, attempts: 0 });
    return successResponse('Đã tắt token.', updated);
  } catch (err) {
    return serverErrorResponse('Không thể tắt credential.', err);
  }
}
