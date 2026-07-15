import { type NextRequest } from 'next/server';
import { runAutomationSchedulerTick, runProductIntelligenceSchedulerTick } from '@/lib/automation/scheduler';
import { sanitizeErrorMessage } from '@/lib/safety/operationGuard';

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
    const dryRun = request.nextUrl.searchParams.get('dryRun') === 'true';
    if (dryRun) {
      return Response.json({
        ok: true,
        data: { status: 'DRY_RUN', businessDataChanged: false, externalSideEffect: false, tickDurationMs: Date.now() - tickStartMs },
      });
    }
    const now = Date.now();
    const [automation, intelligence] = await Promise.all([
      runAutomationSchedulerTick(now),
      runProductIntelligenceSchedulerTick(now),
    ]);
    return Response.json({
      ok: true,
      data: {
        status: 'ENQUEUE_ONLY',
        trigger: 'scheduler',
        automation,
        intelligence,
        tickDurationMs: Date.now() - tickStartMs,
        message: 'Scheduler đã đánh giá lịch và chỉ tạo durable job khi đến hạn.',
      },
    });
  } catch (error) {
    const safeError = sanitizeErrorMessage(error instanceof Error ? error.message : 'Unknown error');
    console.error('[scheduler/tick]', safeError);
    return Response.json({ ok: false, data: { status: 'failed', error: 'INTERNAL_ERROR', tickDurationMs: Date.now() - tickStartMs } }, { status: 500 });
  }
}
