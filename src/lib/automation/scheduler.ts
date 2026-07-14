import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { createAutomationJob, getAutomationControl, updateAutomationControl } from './store';

export interface SchedulerTickResult {
  status: 'paused' | 'killed' | 'disabled' | 'scheduled' | 'duplicate' | 'not_due';
  jobId?: string;
  nextRunAt?: string;
}

function bucketKey(now: number, intervalHours: number): string {
  const bucketMs = intervalHours * 60 * 60_000;
  return String(Math.floor(now / bucketMs));
}

export async function runAutomationSchedulerTick(now = Date.now()): Promise<SchedulerTickResult> {
  const control = await getAutomationControl();
  if (control.killSwitch) return { status: 'killed' };
  if (control.schedulerPaused) return { status: 'paused' };
  const settings = await getAutomationSettings();
  if (!settings.enabled) return { status: 'disabled' };
  await updateAutomationControl({ schedulerHeartbeatAt: new Date(now).toISOString() }, 'scheduler');
  const intervalMs = settings.intervalHours * 60 * 60_000;
  if (control.schedulerNextRunAt && Date.parse(control.schedulerNextRunAt) > now) return { status: 'not_due', nextRunAt: control.schedulerNextRunAt };

  const nextRunAt = new Date(now + intervalMs).toISOString();
  const created = await createAutomationJob({
    type: 'AUTO_PILOT',
    payload: { mode: settings.mode, source: settings.source, limit: settings.maxItemsPerRun },
    priority: 60,
    idempotencyKey: `scheduler:auto:${bucketKey(now, settings.intervalHours)}`,
    requestedBy: 'scheduler',
    riskLevel: 'HIGH',
    dryRun: false,
    maxAttempts: 3,
    approvalReason: 'Tác vụ tự động có thể thay đổi dữ liệu và cần phê duyệt quản trị.',
  });
  await updateAutomationControl({ schedulerHeartbeatAt: new Date(now).toISOString(), schedulerLastRunAt: new Date(now).toISOString(), schedulerNextRunAt: nextRunAt }, 'scheduler');
  return { status: created.created ? 'scheduled' : 'duplicate', jobId: created.job.id, nextRunAt };
}
