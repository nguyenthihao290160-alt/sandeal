// ===========================================
// API: Token Vault — Set Primary Credential
// ===========================================

import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { setPrimaryCredential } from '@/lib/storage/tokenVault';
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

    const updated = await setPrimaryCredential(id);
    if (!updated) {
      return errorResponse('Không tìm thấy credential.', undefined, 404);
    }

    const operationId = typeof requestedOperationId === 'string' && requestedOperationId.trim() ? requestedOperationId.trim().slice(0, 160) : generateId();
    await appendAutomationAuditOnce({ correlationId: operationId, operationId, operationType: 'CREDENTIAL_PRIMARY_CHANGED', actor: getServerActor(), target: id, risk: 'MEDIUM', reasons: [], result: { platform: updated.platform, role: updated.role }, dryRun: false, attempts: 0 });
    return successResponse('Đã đặt làm khóa chính.', updated);
  } catch (err) {
    return serverErrorResponse('Không thể đặt làm khóa chính.', err);
  }
}
