import { type NextRequest } from 'next/server';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/apiResponse';
import { getServerActor, requirePermission } from '@/lib/auth';
import { appendAutomationAuditOnce } from '@/lib/automation/store';
import { generateId } from '@/lib/storage/adapter';
import { updateCredentialPriority } from '@/lib/storage/tokenVault';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = await requirePermission(request, 'MANAGE_AUTOMATION');
  if (authError) return authError;
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const priority = Number(body.priority);
    if (!id || !Number.isInteger(priority) || priority < 0 || priority > 10_000) return errorResponse('ID hoặc priority không hợp lệ.');
    const operationId = typeof body.operationId === 'string' && body.operationId.trim() ? body.operationId.trim().slice(0, 160) : generateId();
    const result = await updateCredentialPriority(id, priority, operationId);
    if (!result) return errorResponse('Không tìm thấy credential.', undefined, 404);
    if (result.changed) await appendAutomationAuditOnce({ correlationId: operationId, operationId, operationType: 'CREDENTIAL_PRIORITY_CHANGED', actor: getServerActor(), target: id, risk: 'LOW', reasons: [], result: { priority, platform: result.credential.platform }, dryRun: false, attempts: 0 });
    return successResponse(result.changed ? 'Đã cập nhật priority.' : 'Priority đã được xử lý trước đó.', result.credential);
  } catch (error) {
    return serverErrorResponse('Không thể cập nhật priority.', error);
  }
}
