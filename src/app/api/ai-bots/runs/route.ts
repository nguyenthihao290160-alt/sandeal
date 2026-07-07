// ===========================================
// GET /api/ai-bots/runs
// Returns recent bot run history
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getBotRuns } from '@/lib/storage/botRuns';

export async function GET(req: NextRequest) {
  try {
    // Check auth
    const authError = await requireAuth(req);
    if (authError) return authError;

    const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 100);
    const runs = await getBotRuns(limit);

    return NextResponse.json({
      success: true,
      data: runs,
    });
  } catch (error) {
    console.error('[ai-bots/runs] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
