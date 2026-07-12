import { NextRequest } from 'next/server';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/apiResponse';
import { generationProbeCredential } from '@/lib/ai/geminiCredentialProbe';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { id?: string };
    if (!body.id) return errorResponse('ID credential là bắt buộc.');
    const result = await generationProbeCredential(body.id);
    return successResponse(result.message, result);
  } catch (error) { return serverErrorResponse('Không thể chạy generation probe.', error); }
}
