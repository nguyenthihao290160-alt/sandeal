// ===========================================
// GET + PATCH /api/ai-bots/scheduler
// Scheduler config management
// ===========================================

import { type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  getSchedulerConfig,
  updateSchedulerConfig,
} from '@/lib/bots/schedulerConfig';
import { getRunLockStatus } from '@/lib/bots/runLock';
import { getSchedulerState } from '@/lib/bots/automationScheduler';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;

    const config = await getSchedulerConfig();
    const lockStatus = await getRunLockStatus();
    const state = await getSchedulerState();

    return Response.json({
      ok: true,
      data: {
        scheduler: config,
        state,
        lock: {
          isLocked: lockStatus.isLocked,
          isExpired: lockStatus.isExpired,
          runId: lockStatus.lock?.runId ?? null,
          mode: lockStatus.lock?.mode ?? null,
          startedAt: lockStatus.lock?.startedAt ?? null,
          expiresAt: lockStatus.lock?.expiresAt ?? null,
        },
      },
    });
  } catch (err) {
    console.error('[api/ai-bots/scheduler] GET Error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Lỗi không xác định' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authError = await requireAuth(request);
    if (authError) return authError;

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { ok: false, error: 'Body JSON không hợp lệ.' },
        { status: 400 },
      );
    }

    const result = await updateSchedulerConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : undefined,
      mode: typeof body.mode === 'string' ? body.mode : undefined,
    });

    if (result.error) {
      return Response.json(
        { ok: false, error: result.error, data: result.config },
        { status: 400 },
      );
    }

    return Response.json({
      ok: true,
      message: 'Đã cập nhật cấu hình lịch.',
      data: result.config,
    });
  } catch (err) {
    console.error('[api/ai-bots/scheduler] PATCH Error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Lỗi không xác định' },
      { status: 500 },
    );
  }
}
