// ===========================================
// API: Token Vault — Delete Credential
// ===========================================

import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { deleteCredential } from '@/lib/storage/tokenVault';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    const body = await request.json();
    const { id } = body as { id?: string };

    if (!id || typeof id !== 'string') {
      return errorResponse('ID credential là bắt buộc.');
    }

    const deleted = await deleteCredential(id);
    if (!deleted) {
      return errorResponse('Không tìm thấy credential để xoá.', undefined, 404);
    }

    return successResponse('Đã xoá token.');
  } catch (err) {
    return serverErrorResponse('Không thể xoá credential.', err);
  }
}
