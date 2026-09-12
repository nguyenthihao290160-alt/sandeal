import type {
  CreateAutomationJobInput,
} from '@/lib/automation/store';
import type {
  AutomationJob,
} from '@/lib/automation/types';
import type {
  ProductIntelligenceSchedulerTickResult,
  SchedulerTickResult,
} from '@/lib/automation/scheduler';
import type {
  GrowthDaily,
  OutboundEvent,
} from '@/lib/product-intelligence/types';
import type { SandealRuntime } from '@/lib/runtime/config';

export interface JobQueueEnqueueResult<Job = AutomationJob> {
  job: Job;
  created: boolean;
  code: 'CREATED' | 'ALREADY_PROCESSED' | 'IN_PROGRESS';
}

export interface JobQueueAdapter<Input = CreateAutomationJobInput, Job = AutomationJob> {
  readonly id: string;
  readonly runtime: SandealRuntime;
  enqueueJob(input: Input): Promise<JobQueueEnqueueResult<Job>>;
  enqueueJobs(inputs: readonly Input[]): Promise<JobQueueEnqueueResult<Job>[]>;
}

export interface SchedulerTickBundle {
  automation: SchedulerTickResult;
  intelligence: ProductIntelligenceSchedulerTickResult;
}

export interface SchedulerAdapter<Result = SchedulerTickBundle> {
  readonly id: string;
  readonly runtime: SandealRuntime;
  tick(now?: number): Promise<Result>;
}

export type AnalyticsEventInput = Omit<OutboundEvent, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: string;
};

export interface AnalyticsSummary {
  rangeDays: number;
  views: number;
  clicks: number;
  revenueAvailable: boolean;
  [key: string]: unknown;
}

export interface AnalyticsAdapter {
  readonly id: string;
  readonly runtime: SandealRuntime;
  recordEvent(input: AnalyticsEventInput): Promise<OutboundEvent>;
  aggregate(now?: number): Promise<{ days: number; events: number }>;
  readDaily(): Promise<GrowthDaily[]>;
  getSummary(days?: number): Promise<AnalyticsSummary>;
}
