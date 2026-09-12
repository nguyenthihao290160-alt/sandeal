import { getSandealRuntime } from '@/lib/runtime/config';
import {
  legacyAnalyticsAdapter,
  legacyJobQueueAdapter,
  legacySchedulerAdapter,
} from './legacyAdapters';
import type {
  AnalyticsAdapter,
  JobQueueAdapter,
  SchedulerAdapter,
} from './types';

export class RuntimeAdapterUnavailableError extends Error {
  readonly code = 'RUNTIME_ADAPTER_UNAVAILABLE' as const;

  constructor(readonly adapter: 'analytics' | 'job-queue' | 'scheduler') {
    super(`RUNTIME_ADAPTER_UNAVAILABLE:${adapter}`);
    this.name = 'RuntimeAdapterUnavailableError';
  }
}

export function getJobQueueAdapter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): JobQueueAdapter {
  if (getSandealRuntime(environment) === 'legacy') return legacyJobQueueAdapter;
  throw new RuntimeAdapterUnavailableError('job-queue');
}

export function getSchedulerAdapter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SchedulerAdapter {
  if (getSandealRuntime(environment) === 'legacy') return legacySchedulerAdapter;
  throw new RuntimeAdapterUnavailableError('scheduler');
}

export function getAnalyticsAdapter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AnalyticsAdapter {
  if (getSandealRuntime(environment) === 'legacy') return legacyAnalyticsAdapter;
  throw new RuntimeAdapterUnavailableError('analytics');
}
