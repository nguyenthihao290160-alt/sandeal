import {
  createAutomationJob,
  createAutomationJobsBatch,
} from '@/lib/automation/store';
import {
  runAutomationSchedulerTick,
  runProductIntelligenceSchedulerTick,
} from '@/lib/automation/scheduler';
import {
  aggregateGrowthMetrics,
  getGrowthSummary,
  recordGrowthEvent,
} from '@/lib/product-intelligence/growth';
import { readCollection } from '@/lib/storage/adapter';
import type { GrowthDaily } from '@/lib/product-intelligence/types';
import type {
  AnalyticsAdapter,
  JobQueueAdapter,
  SchedulerAdapter,
} from './types';

export const legacyJobQueueAdapter: JobQueueAdapter = {
  id: 'legacy-durable-automation-jobs',
  runtime: 'legacy',
  enqueueJob: createAutomationJob,
  enqueueJobs: createAutomationJobsBatch,
};

export const legacySchedulerAdapter: SchedulerAdapter = {
  id: 'legacy-durable-scheduler',
  runtime: 'legacy',
  async tick(now = Date.now()) {
    const [automation, intelligence] = await Promise.all([
      runAutomationSchedulerTick(now),
      runProductIntelligenceSchedulerTick(now),
    ]);
    return { automation, intelligence };
  },
};

export const legacyAnalyticsAdapter: AnalyticsAdapter = {
  id: 'legacy-growth-collections',
  runtime: 'legacy',
  recordEvent: recordGrowthEvent,
  aggregate: aggregateGrowthMetrics,
  readDaily: () => readCollection<GrowthDaily>('growth-daily'),
  getSummary: getGrowthSummary,
};
