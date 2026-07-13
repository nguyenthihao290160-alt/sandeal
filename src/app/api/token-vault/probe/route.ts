import { NextRequest } from 'next/server';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/apiResponse';
import { generationProbeCredential } from '@/lib/ai/geminiCredentialProbe';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    const body = await request.json() as { id?: string };
    if (!body.id) return errorResponse('ID credential là bắt buộc.');
    const result = await generationProbeCredential(body.id);
    return successResponse(result.message, result);
  } catch (error) { return serverErrorResponse('Không thể chạy generation probe.', error); }
}
