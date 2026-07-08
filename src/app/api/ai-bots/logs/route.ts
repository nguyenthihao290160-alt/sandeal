// ===========================================
// GET /api/ai-bots/logs
// Returns recent AutoPilot run logs
// ===========================================

import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listRunLogs } from '@/lib/bots/runLogs';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;

    const limitParam = request.nextUrl.searchParams.get('limit');
    const limit = Math.min(
      Math.max(parseInt(limitParam || '50', 10) || 50, 1),
      150,
    );

    const logs = await listRunLogs(limit);

    return Response.json({
      ok: true,
      data: logs,
    });
  } catch (err) {
    console.error('[api/ai-bots/logs] Error:', err);
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    );
  }
}
