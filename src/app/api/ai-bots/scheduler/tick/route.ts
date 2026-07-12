import { type NextRequest } from 'next/server';
import { runSchedulerTick } from '@/lib/bots/automationScheduler';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  const tickStartMs = Date.now();
  const expectedSecret = process.env.SCHEDULER_SECRET;
  const suppliedSecret = request.headers.get('x-sandeal-scheduler-secret');
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return Response.json({ ok: false, error: 'Unauthorized scheduler secret' }, { status: 401 });
  }
  try {
    const result = await runSchedulerTick();
    return Response.json({
      ok: result.status !== 'failed',
      data: {
        status: result.status,
        reason: result.reason,
        mode: result.state.currentMode,
        trigger: 'scheduler',
        summary: result.summary,
        scheduler: result.state,
        tickDurationMs: Date.now() - tickStartMs,
        message: result.status === 'completed'
          ? 'Scheduler tick hoàn tất.'
          : (result.reason || result.state.lastError || 'Scheduler tick thất bại.'),
      },
    }, { status: result.status === 'failed' ? 500 : 200 });
  } catch (error) {
    const safeError = error instanceof Error ? error.message : 'Lỗi không xác định';
    console.error('[scheduler/tick]', safeError);
    return Response.json({ ok: false, data: { status: 'failed', error: safeError, tickDurationMs: Date.now() - tickStartMs } }, { status: 500 });
  }
}
