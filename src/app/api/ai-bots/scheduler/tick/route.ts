import { type NextRequest } from 'next/server';
import { runSchedulerTick } from '@/lib/bots/automationScheduler';
import { getOperationEnvironment, runGuardedOperation, sanitizeErrorMessage } from '@/lib/safety/operationGuard';

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
    const minuteBucket = new Date().toISOString().slice(0, 16);
    const guarded = await runGuardedOperation({
      operationType: 'scheduler_tick',
      actor: 'scheduler',
      environment: getOperationEnvironment(),
      target: 'automation_scheduler',
      approval: true,
      riskLevel: 'HIGH',
      dryRun,
      idempotencyKey: request.headers.get('x-idempotency-key') || `natural-tick:${minuteBucket}`,
    }, runSchedulerTick);
    if (guarded.status !== 'COMPLETED') {
      return Response.json({
        ok: guarded.status === 'DRY_RUN' || guarded.status === 'ALREADY_PROCESSED',
        data: { status: guarded.status, tickDurationMs: Date.now() - tickStartMs },
      }, { status: guarded.status === 'IN_PROGRESS' ? 409 : guarded.status === 'APPROVAL_REQUIRED' || guarded.status === 'BLOCKED' ? 403 : 200 });
    }
    const result = guarded.value;
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
    const safeError = sanitizeErrorMessage(error instanceof Error ? error.message : 'Unknown error');
    console.error('[scheduler/tick]', safeError);
    return Response.json({ ok: false, data: { status: 'failed', error: 'INTERNAL_ERROR', tickDurationMs: Date.now() - tickStartMs } }, { status: 500 });
  }
}
