// ===========================================
// API: Token Vault — Disable Credential
// ===========================================

import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { disableCredential } from '@/lib/storage/tokenVault';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body as { id?: string };

    if (!id || typeof id !== 'string') {
      return errorResponse('ID credential là bắt buộc.');
    }

    const updated = await disableCredential(id);
    if (!updated) {
      return errorResponse('Không tìm thấy credential.', undefined, 404);
    }

    return successResponse('Đã tắt token.', updated);
  } catch (err) {
    return serverErrorResponse('Không thể tắt credential.', err);
  }
}
