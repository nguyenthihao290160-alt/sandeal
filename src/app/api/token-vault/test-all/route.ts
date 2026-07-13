import { errorResponse, serverErrorResponse, successResponse } from '@/lib/apiResponse';
import { acquireRunLock, releaseRunLock } from '@/lib/bots/runLock';
import { listCredentials } from '@/lib/storage/tokenVault';
import { generationProbeCredential, lightTestCredential } from '@/lib/ai/geminiCredentialProbe';
import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  const lock = await acquireRunLock('gemini_test_all', 'token_vault');
  if (!lock.acquired) return errorResponse('Test All Gemini Keys đang chạy.', undefined, 409);
  try {
    const credentials = (await listCredentials({ platform: 'gemini' })).filter((item) => item.role !== 'disabled');
    const results = [];
    for (const credential of credentials) {
      const light = await lightTestCredential(credential.id); results.push(light);
      if (light.status === 'valid') results.push(await generationProbeCredential(credential.id));
    }
    return successResponse('Đã kiểm tra tuần tự toàn bộ Gemini keys.', { total: credentials.length, completed: results.length, results });
  } catch (error) { return serverErrorResponse('Test All Gemini Keys thất bại.', error); }
  finally { await releaseRunLock(lock.runId); }
}
