// ===========================================
// API: Token Vault — Vault Health
// ===========================================

import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getVaultStats } from '@/lib/storage/tokenVault';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stats = await getVaultStats();
    return successResponse('Trạng thái Token Vault.', stats);
  } catch (err) {
    return serverErrorResponse('Không thể tải trạng thái Token Vault.', err);
  }
}
