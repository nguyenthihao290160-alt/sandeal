// ===========================================
// POST /api/ai-bots/scheduler/tick
// Called by VPS cron every 30–60 minutes
// Checks scheduler config and runs AutoPilot if due
//
// Security:
//   - Protected by requireAuth (Basic Auth)
//   - POST only — GET does not trigger
//   - Scheduler must be enabled in dashboard
//   - Run lock prevents concurrent runs
//   - No secrets in response
// ===========================================

import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  getSchedulerConfig,
  shouldRunNow,
  markSchedulerRunCompleted,
} from '@/lib/bots/schedulerConfig';
import { runAutoPilot } from '@/lib/bots/autoPilotRunner';
import { getRunLockStatus } from '@/lib/bots/runLock';

export const dynamic = 'force-dynamic';

// Explicitly block GET — scheduler tick is POST only
export async function GET() {
  return Response.json(
    {
      ok: false,
      message: 'Scheduler tick chỉ chấp nhận POST. GET không kích hoạt bot.',
    },
    { status: 405 },
  );
}

export async function POST(request: NextRequest) {
  const tickStartMs = Date.now();

  try {
    // Step 1: Auth guard
    const authError = await requireAuth(request);
    if (authError) return authError;

    // Step 2: Read scheduler config
    const config = await getSchedulerConfig();

    // Step 3: If scheduler disabled → skip
    if (!config.enabled) {
      return Response.json({
        ok: true,
        data: {
          status: 'skipped',
          reason: 'disabled',
          message: 'Lịch tự động đang tắt. Bỏ qua.',
        },
      });
    }

    // Step 4: Check if due
    const check = shouldRunNow(config);

    if (!check.shouldRun) {
      return Response.json({
        ok: true,
        data: {
          status: 'skipped',
          reason: 'not_due',
          message: check.reason,
          nextRunAt: config.nextRunAt,
        },
      });
    }

    // Step 5: Check run lock before attempting
    const lockStatus = await getRunLockStatus();
    if (lockStatus.isLocked) {
      return Response.json({
        ok: true,
        data: {
          status: 'skipped',
          reason: 'already_running',
          message: `AutoPilot đang chạy (mode: ${lockStatus.lock?.mode || '?'}). Bỏ qua tick này.`,
        },
      });
    }

    // Step 6: Run AutoPilot
    const result = await runAutoPilot({
      mode: config.mode,
      trigger: 'scheduler',
    });

    // Step 7: Update scheduler timestamps
    if (result.status !== 'skipped') {
      await markSchedulerRunCompleted();
    }

    const tickDurationMs = Date.now() - tickStartMs;

    return Response.json({
      ok: result.status !== 'failed',
      data: {
        status: result.status,
        runId: result.runId,
        mode: result.mode,
        trigger: 'scheduler',
        summary: result.summary,
        durationMs: result.durationMs,
        tickDurationMs,
        message: result.message || result.error || 'Scheduler tick hoàn tất.',
      },
    });
  } catch (err) {
    const tickDurationMs = Date.now() - tickStartMs;
    const safeError = err instanceof Error ? err.message : 'Lỗi không xác định';
    console.error('[api/ai-bots/scheduler/tick] Error:', safeError);

    return Response.json(
      {
        ok: false,
        data: {
          status: 'failed',
          message: 'Scheduler tick thất bại.',
          error: safeError,
          tickDurationMs,
        },
      },
      { status: 500 },
    );
  }
}
