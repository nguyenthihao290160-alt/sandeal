// ===========================================
// POST /api/ai-bots/run-now
// Manual trigger for AutoPilot with run lock
// ===========================================

import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { runAutoPilot, type AutoPilotMode } from '@/lib/bots/autoPilotRunner';

export const dynamic = 'force-dynamic';

const VALID_MODES: AutoPilotMode[] = [
  'full_safe_run',
  'source_scan',
  'health_check',
  'cleanup_broken_products',
];

export async function POST(request: NextRequest) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;

    let body: { mode?: string } = {};
    try {
      body = await request.json();
    } catch {
      // Empty body → default mode
    }

    const mode = (
      typeof body.mode === 'string' && VALID_MODES.includes(body.mode as AutoPilotMode)
        ? body.mode
        : 'full_safe_run'
    ) as AutoPilotMode;

    const result = await runAutoPilot({ mode, trigger: 'dashboard' });

    const statusCode = result.status === 'skipped' ? 409 : 200;

    return Response.json(
      {
        ok: result.status !== 'failed',
        message: result.message || result.error || 'OK',
        data: result,
      },
      { status: statusCode },
    );
  } catch (err) {
    console.error('[api/ai-bots/run-now] Error:', err);
    return Response.json(
      {
        ok: false,
        message: 'Không thể chạy AutoPilot.',
        error: err instanceof Error ? err.message : 'Lỗi không xác định',
      },
      { status: 500 },
    );
  }
}
