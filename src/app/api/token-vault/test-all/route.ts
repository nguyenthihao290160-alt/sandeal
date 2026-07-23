import { errorResponse, serverErrorResponse, successResponse } from '@/lib/apiResponse';
import { acquireRunLock, releaseRunLock } from '@/lib/bots/runLock';
import { probeAllGeminiCredentials } from '@/lib/ai/geminiCredentialProbe';
import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  const lock = await acquireRunLock('gemini_test_all', 'token_vault');
  if (!lock.acquired) return errorResponse('Test All Gemini Keys đang chạy.', undefined, 409);
  try {
    const { stats, results } = await probeAllGeminiCredentials();
    return successResponse(
      `Đã kiểm tra ${stats.total} kết nối: ${stats.validKeys} khóa hợp lệ, ${stats.generationReady} sẵn sàng tạo nội dung.`,
      { ...stats, completed: results.length, results },
    );
  } catch (error) { return serverErrorResponse('Test All Gemini Keys thất bại.', error); }
  finally { await releaseRunLock(lock.runId); }
}
