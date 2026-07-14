import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { createAutomationJob, getAutomationControl, updateAutomationControl } from './store';
import type { AutomationJobType } from './types';

export interface SchedulerTickResult {
  status: 'paused' | 'killed' | 'disabled' | 'scheduled' | 'duplicate' | 'not_due';
  jobId?: string;
  nextRunAt?: string;
}

function bucketKey(now: number, intervalHours: number): string {
  const bucketMs = intervalHours * 60 * 60_000;
  return String(Math.floor(now / bucketMs));
}

type ScheduledProductIntelligenceJobType = Extract<
  AutomationJobType,
  | 'RECHECK_PRODUCT_HEALTH'
  | 'SCORE_PRODUCTS'
  | 'CAPTURE_PRICE_HISTORY'
  | 'EVALUATE_ALERTS'
  | 'AGGREGATE_GROWTH_METRICS'
>;

export interface ProductIntelligenceSchedulerTickResult {
  status: 'paused' | 'killed' | 'disabled' | 'scheduled' | 'duplicate';
  scheduled: number;
  duplicates: number;
  jobs: Array<{
    type: ScheduledProductIntelligenceJobType;
    jobId: string;
    created: boolean;
  }>;
}

const PRODUCT_INTELLIGENCE_SCHEDULES: ReadonlyArray<{
  type: ScheduledProductIntelligenceJobType;
  intervalHours: number;
  priority: number;
}> = [
  { type: 'RECHECK_PRODUCT_HEALTH', intervalHours: 1, priority: 70 },
  { type: 'EVALUATE_ALERTS', intervalHours: 1, priority: 65 },
  { type: 'SCORE_PRODUCTS', intervalHours: 6, priority: 55 },
  { type: 'CAPTURE_PRICE_HISTORY', intervalHours: 6, priority: 50 },
  { type: 'AGGREGATE_GROWTH_METRICS', intervalHours: 24, priority: 40 },
];

export async function runProductIntelligenceSchedulerTick(
  now = Date.now(),
): Promise<ProductIntelligenceSchedulerTickResult> {
  const emptyResult = (status: 'paused' | 'killed' | 'disabled'): ProductIntelligenceSchedulerTickResult => ({
    status,
    scheduled: 0,
    duplicates: 0,
    jobs: [],
  });
  const control = await getAutomationControl();
  if (control.killSwitch) return emptyResult('killed');
  if (control.schedulerPaused) return emptyResult('paused');
  const settings = await getAutomationSettings();
  if (!settings.enabled) return emptyResult('disabled');

  const timestamp = new Date(now).toISOString();
  await updateAutomationControl({ schedulerHeartbeatAt: timestamp }, 'scheduler');
  const jobs: ProductIntelligenceSchedulerTickResult['jobs'] = [];

  for (const schedule of PRODUCT_INTELLIGENCE_SCHEDULES) {
    const bucket = bucketKey(now, schedule.intervalHours);
    const created = await createAutomationJob({
      type: schedule.type,
      payload: {
        limit: settings.maxItemsPerRun,
        scheduleIntervalHours: schedule.intervalHours,
        scheduleBucket: bucket,
      },
      priority: schedule.priority,
      idempotencyKey: `scheduler:intelligence:${schedule.type.toLowerCase()}:${bucket}`,
      requestedBy: 'scheduler',
      riskLevel: 'MEDIUM',
      dryRun: false,
      maxAttempts: 3,
    });
    jobs.push({ type: schedule.type, jobId: created.job.id, created: created.created });
  }

  const scheduled = jobs.filter((job) => job.created).length;
  const duplicates = jobs.length - scheduled;
  await updateAutomationControl({ schedulerHeartbeatAt: timestamp, schedulerLastRunAt: timestamp }, 'scheduler');
  return {
    status: scheduled > 0 ? 'scheduled' : 'duplicate',
    scheduled,
    duplicates,
    jobs,
  };
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
