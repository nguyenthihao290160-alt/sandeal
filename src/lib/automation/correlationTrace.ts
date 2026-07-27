import { createHash } from 'node:crypto';

import { readCollectionPage } from '@/lib/storage/adapter';
import type { PublicationAudit } from '@/lib/storage/products';
import type { OperationJournalEntry } from './operationJournal';
import type {
  AutomationAuditEvent,
  AutomationJob,
  AutomationJobAttempt,
} from './types';

const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const LAYER_LIMIT = 50;
const ROOT_JOB_LIMIT = 20;
const PROVIDERS = new Set([
  'accesstrade',
  'deterministic-rules',
  'gemini',
  'local',
  'local-ai',
  'manual',
  'system',
]);

type CorrelationStageName =
  | 'JOB'
  | 'ATTEMPT'
  | 'PROVIDER'
  | 'AUTOMATION_AUDIT'
  | 'OPERATION_JOURNAL'
  | 'PUBLICATION_AUDIT'
  | 'MONITOR';

export interface RedactedCorrelationStage {
  stage: CorrelationStageName;
  ref: string;
  parentRef?: string;
  status: string;
  occurredAt?: string;
  provider?: string;
  attemptNumber?: number;
  completedEffects?: number;
  pendingEffects?: number;
  reasonRefs?: string[];
  productRef?: string;
}

export interface RedactedCorrelationTrace {
  schemaVersion: 1;
  traceRef: string;
  operationKind: 'AUTO_SAFE_PUBLISH' | 'OTHER' | 'UNKNOWN';
  complete: boolean;
  missingStages: CorrelationStageName[];
  counts: Record<CorrelationStageName, number>;
  stages: RedactedCorrelationStage[];
}

function ref(kind: string, value: unknown): string {
  const digest = createHash('sha256')
    .update(`${kind}:${String(value || '')}`)
    .digest('hex')
    .slice(0, 20);
  return `${kind}_${digest}`;
}

function safeStatus(value: unknown): string {
  const normalized = String(value || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9:._-]+/g, '_')
    .slice(0, 80);
  return normalized || 'UNKNOWN';
}

function safeProvider(job: AutomationJob): string | undefined {
  const resultProvider = job.result && typeof job.result.provider === 'string'
    ? job.result.provider
    : undefined;
  const checkpointProvider = job.checkpoint?.providerStatus
    && typeof job.checkpoint.providerStatus.provider === 'string'
    ? job.checkpoint.providerStatus.provider
    : undefined;
  const provider = String(job.disclosure?.provider || resultProvider || checkpointProvider || '')
    .trim()
    .toLowerCase();
  return PROVIDERS.has(provider) ? provider : provider ? 'unknown' : undefined;
}

async function page<T>(
  collection: string,
  filters: Record<string, string>,
  pageSize = LAYER_LIMIT,
): Promise<T[]> {
  const result = await readCollectionPage<T>(collection, {
    page: 1,
    pageSize,
    filters,
    sort: { field: 'createdAt', direction: 'asc' },
  });
  return result.items;
}

function countStages(stages: RedactedCorrelationStage[]): Record<CorrelationStageName, number> {
  const output: Record<CorrelationStageName, number> = {
    JOB: 0,
    ATTEMPT: 0,
    PROVIDER: 0,
    AUTOMATION_AUDIT: 0,
    OPERATION_JOURNAL: 0,
    PUBLICATION_AUDIT: 0,
    MONITOR: 0,
  };
  for (const stage of stages) output[stage.stage] += 1;
  return output;
}

export async function getRedactedCorrelationTrace(
  operationId: string,
): Promise<RedactedCorrelationTrace> {
  if (!SAFE_OPERATION_ID.test(operationId)) throw new Error('CORRELATION_ID_INVALID');

  const [jobs, attempts, audits, journals, publicationAudits] = await Promise.all([
    page<AutomationJob>('automation-jobs', { operationId }, ROOT_JOB_LIMIT),
    page<AutomationJobAttempt>('automation-job-attempts', { operationId }),
    page<AutomationAuditEvent>('automation-audit', { operationId }),
    page<OperationJournalEntry>('operation-journal', { operationId }, 5),
    page<PublicationAudit>('publication-audit', { operationId }),
  ]);
  const rootJobIds = new Set(jobs.map(job => job.id));
  const monitorPages = await Promise.all(
    jobs.slice(0, ROOT_JOB_LIMIT).map(job => page<AutomationJob>(
      'automation-jobs',
      { parentJobId: job.id },
      LAYER_LIMIT,
    )),
  );
  const monitors = monitorPages.flat()
    .filter(job => job.type === 'POST_PUBLISH_MONITOR')
    .slice(0, LAYER_LIMIT);

  const stages: RedactedCorrelationStage[] = [];
  for (const job of jobs) {
    const jobRef = ref('job', job.id);
    stages.push({
      stage: 'JOB',
      ref: jobRef,
      status: safeStatus(job.status),
      occurredAt: job.createdAt,
    });
    const provider = safeProvider(job);
    if (provider) {
      stages.push({
        stage: 'PROVIDER',
        ref: ref('provider-event', `${job.id}:${provider}`),
        parentRef: jobRef,
        status: safeStatus(job.outcomeStatus || job.executionMode || job.status),
        occurredAt: job.completedAt || job.updatedAt,
        provider,
      });
    }
  }
  for (const attempt of attempts.filter(attempt => rootJobIds.has(attempt.jobId))) {
    stages.push({
      stage: 'ATTEMPT',
      ref: ref('attempt', attempt.id),
      parentRef: ref('job', attempt.jobId),
      status: 'CLAIMED',
      occurredAt: attempt.claimedAt,
      attemptNumber: attempt.attemptNumber,
    });
  }
  for (const audit of audits.filter(audit => !audit.jobId || rootJobIds.has(audit.jobId))) {
    stages.push({
      stage: 'AUTOMATION_AUDIT',
      ref: ref('automation-audit', audit.id),
      parentRef: audit.jobId ? ref('job', audit.jobId) : undefined,
      status: safeStatus(audit.nextState || audit.operationType),
      occurredAt: audit.createdAt,
      reasonRefs: audit.reasons.slice(0, 20).map(reason => ref('reason', reason)),
    });
  }
  for (const journal of journals.filter(journal => !journal.jobId || rootJobIds.has(journal.jobId))) {
    stages.push({
      stage: 'OPERATION_JOURNAL',
      ref: ref('journal', journal.id),
      parentRef: journal.jobId ? ref('job', journal.jobId) : undefined,
      status: safeStatus(journal.reconciliationStatus),
      occurredAt: journal.updatedAt,
      completedEffects: journal.completedEffects.length,
      pendingEffects: journal.pendingEffects.length,
    });
  }
  for (const audit of publicationAudits.filter(audit => !audit.jobId || rootJobIds.has(audit.jobId))) {
    stages.push({
      stage: 'PUBLICATION_AUDIT',
      ref: ref('publication-audit', audit.id),
      parentRef: audit.jobId ? ref('job', audit.jobId) : undefined,
      status: safeStatus(audit.action),
      occurredAt: audit.timestamp,
      reasonRefs: audit.reasonCodes.slice(0, 20).map(reason => ref('reason', reason)),
      productRef: ref('product', audit.productId),
    });
  }
  for (const monitor of monitors) {
    stages.push({
      stage: 'MONITOR',
      ref: ref('job', monitor.id),
      parentRef: monitor.parentJobId ? ref('job', monitor.parentJobId) : undefined,
      status: safeStatus(monitor.status),
      occurredAt: monitor.createdAt,
      attemptNumber: monitor.attemptCount,
      productRef: ref('product', monitor.payload.productId),
    });
  }

  const counts = countStages(stages);
  const operationKind = jobs.some(job => job.type === 'AUTO_SAFE_PUBLISH')
    ? 'AUTO_SAFE_PUBLISH'
    : jobs.length
      ? 'OTHER'
      : 'UNKNOWN';
  const required: CorrelationStageName[] = operationKind === 'AUTO_SAFE_PUBLISH'
    ? ['JOB', 'ATTEMPT', 'PROVIDER', 'AUTOMATION_AUDIT', 'OPERATION_JOURNAL', 'PUBLICATION_AUDIT', 'MONITOR']
    : ['JOB', 'ATTEMPT', 'AUTOMATION_AUDIT'];
  const missingStages = required.filter(stage => counts[stage] === 0);
  return {
    schemaVersion: 1,
    traceRef: ref('operation', operationId),
    operationKind,
    complete: missingStages.length === 0,
    missingStages,
    counts,
    stages,
  };
}
