// ===========================================
// API: Token Vault — List Credentials
// ===========================================

import { successResponse, serverErrorResponse } from '@/lib/apiResponse';
import { listCredentialsGrouped } from '@/lib/storage/tokenVault';
import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getCredentialTruth } from '@/lib/ai/credentialTruth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    const groups = (await listCredentialsGrouped()).map(group => ({ ...group, credentials: group.credentials.map(credential => ({ ...credential, readiness: getCredentialTruth(credential) })) }));
    return successResponse('Đã tải danh sách token.', { groups });
  } catch (err) {
    return serverErrorResponse('Không thể tải danh sách token.', err);
  }
}
