// ===========================================
// GET /api/ai-bots/status
// Returns current AI bot team status
// ===========================================

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createAppHealthChecker } from '@/lib/bots/appHealth';
import { getBotRunsStats } from '@/lib/storage/botRuns';

export async function GET(req: NextRequest) {
  try {
    // Check auth
    const authError = await requireAuth(req);
    if (authError) return authError;

    // Create a dummy run ID for logging
    const tempRunId = `health-check-${Date.now()}`;
    const healthBot = await createAppHealthChecker(tempRunId);
    const status = await healthBot.getHealthStatus();
    const runStats = await getBotRunsStats();

    return NextResponse.json({
      success: true,
      data: {
        ...status,
        totalBotRuns: runStats.totalRuns,
        completedRuns: runStats.completedRuns,
        failedRuns: runStats.failedRuns,
        pendingRuns: runStats.pendingRuns,
      },
    });
  } catch (error) {
    console.error('[ai-bots/status] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
