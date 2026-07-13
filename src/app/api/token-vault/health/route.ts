// ===========================================
// API: Token Vault — Vault Health
// ===========================================

import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getVaultStats } from '@/lib/storage/tokenVault';
import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    const stats = await getVaultStats();
    return successResponse('Trạng thái Token Vault.', stats);
  } catch (err) {
    return serverErrorResponse('Không thể tải trạng thái Token Vault.', err);
  }
}
