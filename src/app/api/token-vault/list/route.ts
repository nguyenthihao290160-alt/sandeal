// ===========================================
// API: Token Vault — List Credentials
// ===========================================

import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { listCredentialsGrouped } from '@/lib/storage/tokenVault';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const groups = await listCredentialsGrouped();
    return successResponse('Đã tải danh sách token.', { groups });
  } catch (err) {
    return serverErrorResponse('Không thể tải danh sách token.', err);
  }
}
