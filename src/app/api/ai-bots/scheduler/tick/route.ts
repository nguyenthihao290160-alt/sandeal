// ===========================================
// POST /api/ai-bots/scheduler/tick
// Called by VPS cron every 10–30 minutes
// ===========================================

import { type NextRequest } from 'next/server';
import { runAutoPilot } from '@/lib/bots/autoPilotRunner';
import { getRunLockStatus } from '@/lib/bots/runLock';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { listRunLogs } from '@/lib/bots/runLogs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Use a secret header to protect this internal route
const EXPECTED_SECRET = process.env.SCHEDULER_SECRET || 'sandeal-vps-scheduler-secret-2024';

export async function GET() {
  return Response.json(
    { ok: false, message: 'Scheduler tick chỉ chấp nhận POST.' },
    { status: 405 },
  );
}

export async function POST(request: NextRequest) {
  const tickStartMs = Date.now();

  try {
    const authHeader = request.headers.get('x-sandeal-scheduler-secret');
    if (authHeader !== EXPECTED_SECRET) {
      return Response.json({ error: 'Unauthorized scheduler secret' }, { status: 401 });
    }

    const settings = await getAutomationSettings();
    if (!settings.enabled) {
      return Response.json({
        ok: true,
        data: {
          status: 'skipped',
          reason: 'disabled',
          message: 'Lịch tự động đang tắt. Bỏ qua.',
        },
      });
    }

    // Check if it's due
    const recentLogs = await listRunLogs(10);
    const lastRun = recentLogs.find((log: any) => log.status === 'completed' || log.status === 'failed');

    if (lastRun && lastRun.finishedAt && settings.intervalHours) {
      const lastFinishedMs = new Date(lastRun.finishedAt).getTime();
      const nextRunMs = lastFinishedMs + settings.intervalHours * 60 * 60 * 1000;
      
      if (Date.now() < nextRunMs) {
        return Response.json({
          ok: true,
          data: {
            status: 'skipped',
            reason: 'not_due',
            message: `Chưa đến lịch. Lần tiếp theo: ${new Date(nextRunMs).toISOString()}`,
          },
        });
      }
    }

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

    const result = await runAutoPilot({
      mode: settings.mode as any || 'full_safe_run',
      trigger: 'scheduler',
    });

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
