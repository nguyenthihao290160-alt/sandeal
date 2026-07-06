// ===========================================
// API: Token Vault — Set Primary Credential
// ===========================================

import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { setPrimaryCredential } from '@/lib/storage/tokenVault';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body as { id?: string };

    if (!id || typeof id !== 'string') {
      return errorResponse('ID credential là bắt buộc.');
    }

    const updated = await setPrimaryCredential(id);
    if (!updated) {
      return errorResponse('Không tìm thấy credential.', undefined, 404);
    }

    return successResponse('Đã đặt làm khóa chính.', updated);
  } catch (err) {
    return serverErrorResponse('Không thể đặt làm khóa chính.', err);
  }
}
