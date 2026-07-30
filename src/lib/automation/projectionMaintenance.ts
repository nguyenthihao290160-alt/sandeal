import { createHash } from 'node:crypto';
import { readBoundedCollectionSnapshot, runTransaction } from '@/lib/storage/adapter';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import type { AutomationJobHealthView } from './jobHealthSummary';
import {
  appendAutomationAuditOnce,
  createAutomationJob,
} from './store';

// This is a compact projection-control record that uses the generic storage
// revision contract. Keep it outside the Mongo v1 indexed collection manifest.
const MAINTENANCE_STATE_STORE = 'automation-job-projection-maintenance-v1';
const RECORD_ID = 'job-health-projection-rebuild';
const MAXIMUM_ATTEMPTS = 3;
const ACTIVE_REQUEST_MAX_AGE_MS = 30 * 60_000;
const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export type JobHealthProjectionMaintenanceStatus =
  | 'IDLE'
  | 'CLAIMED'
  | 'REQUESTED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXHAUSTED';

export interface JobHealthProjectionMaintenanceState {
  schemaVersion: 1;
  id: typeof RECORD_ID;
  incidentFingerprint: string;
  releaseId: string;
  status: JobHealthProjectionMaintenanceStatus;
  attemptCount: number;
  maximumAttempts: number;
  jobId: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  nextRetryAt: string | null;
  reasonCodes: string[];
  outcomeReasonCode: string | null;
  duplicateRequestsSuppressed: number;
  updatedAt: string;
}

export interface JobHealthProjectionMaintenanceView {
  status:
    | 'NOT_REQUIRED'
    | 'REQUESTED'
    | 'REUSED_ACTIVE_REQUEST'
    | 'BACKOFF'
    | 'EXHAUSTED';
  jobId: string | null;
  attemptCount: number;
  maximumAttempts: number;
  nextRetryAt: string | null;
  duplicateRequestsSuppressed: number;
  incidentFingerprint: string | null;
  reasonCodes: string[];
}

const REBUILD_REASON_PREFIXES = [
  'JOB_HEALTH_SUMMARY_',
  'JOB_HEALTH_CURRENT_STATE_INCOMPLETE',
  'JOB_PROJECTION_MANIFEST_',
  'JOB_STATUS_PROJECTION_MANIFEST_',
  'JOB_PROJECTION_CURRENT_STATE_INCOMPLETE',
  'JOB_STATUS_PROJECTION_CURRENT_STATE_INCOMPLETE',
  'JOB_PROJECTION_INVALID_ITEMS',
  'JOB_STATUS_PROJECTION_INVALID_ITEMS',
] as const;

function safeReasons(values: string[]): string[] {
  return [...new Set(values
    .map(value => value.replace(/[^A-Z0-9_:-]/gi, '_').toUpperCase().slice(0, 120))
    .filter(Boolean))]
    .sort()
    .slice(0, 30);
}

function actionableReasons(view: AutomationJobHealthView): string[] {
  return safeReasons(view.reasonCodes.filter(reason =>
    REBUILD_REASON_PREFIXES.some(prefix => reason.startsWith(prefix))));
}

function incidentFingerprint(view: AutomationJobHealthView, reasons: string[], releaseId: string): string {
  return createHash('sha256').update(JSON.stringify({
    releaseId,
    projectionVersion: view.projectionVersion,
    projectionStatus: view.projectionStatus,
    sourceRevision: view.sourceRevision,
    projectionFingerprint: view.projectionFingerprint,
    reasons,
  })).digest('hex');
}

function emptyState(
  fingerprint: string,
  releaseId: string,
  reasons: string[],
  now: number,
): JobHealthProjectionMaintenanceState {
  return {
    schemaVersion: 1,
    id: RECORD_ID,
    incidentFingerprint: fingerprint,
    releaseId,
    status: 'IDLE',
    attemptCount: 0,
    maximumAttempts: MAXIMUM_ATTEMPTS,
    jobId: null,
    requestedAt: null,
    startedAt: null,
    completedAt: null,
    nextRetryAt: null,
    reasonCodes: reasons,
    outcomeReasonCode: null,
    duplicateRequestsSuppressed: 0,
    updatedAt: new Date(now).toISOString(),
  };
}

function publicView(
  status: JobHealthProjectionMaintenanceView['status'],
  state: JobHealthProjectionMaintenanceState | null,
  reasonCodes: string[],
): JobHealthProjectionMaintenanceView {
  return {
    status,
    jobId: state?.jobId || null,
    attemptCount: state?.attemptCount || 0,
    maximumAttempts: state?.maximumAttempts || MAXIMUM_ATTEMPTS,
    nextRetryAt: state?.nextRetryAt || null,
    duplicateRequestsSuppressed: state?.duplicateRequestsSuppressed || 0,
    incidentFingerprint: state?.incidentFingerprint || null,
    reasonCodes,
  };
}

export async function getJobHealthProjectionMaintenanceState(): Promise<JobHealthProjectionMaintenanceState | null> {
  const snapshot = await readBoundedCollectionSnapshot<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, {
    maximumItems: 1,
    maximumBytes: 128 * 1024,
  });
  return snapshot.items.find(item => item.id === RECORD_ID) || null;
}

export async function ensureJobHealthProjectionMaintenanceRequest(
  view: AutomationJobHealthView,
  now = Date.now(),
): Promise<JobHealthProjectionMaintenanceView> {
  const reasons = actionableReasons(view);
  if (view.projectionStatus === 'VALID' || reasons.length === 0) {
    return publicView('NOT_REQUIRED', await getJobHealthProjectionMaintenanceState(), reasons);
  }

  const releaseId = getReleaseIdentity().releaseId;
  const fingerprint = incidentFingerprint(view, reasons, releaseId);
  let claimed = false;
  let resultStatus: JobHealthProjectionMaintenanceView['status'] = 'REUSED_ACTIVE_REQUEST';
  let state!: JobHealthProjectionMaintenanceState;
  const measuredAt = new Date(now).toISOString();

  await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => {
    const stored = items.find(item => item.id === RECORD_ID);
    const current = stored || emptyState(fingerprint, releaseId, reasons, now);
    const requestAge = now - Date.parse(current.requestedAt || current.updatedAt);
    const active = ['CLAIMED', 'REQUESTED', 'RUNNING'].includes(current.status)
      && Number.isFinite(requestAge)
      && requestAge <= ACTIVE_REQUEST_MAX_AGE_MS;
    if (active) {
      state = {
        ...current,
        duplicateRequestsSuppressed: current.duplicateRequestsSuppressed + 1,
        updatedAt: measuredAt,
      };
      resultStatus = 'REUSED_ACTIVE_REQUEST';
      return [state];
    }

    const sameIncident = current.incidentFingerprint === fingerprint
      && current.releaseId === releaseId;
    const nextRetryAt = Date.parse(current.nextRetryAt || '');
    if (sameIncident && current.status === 'FAILED' && Number.isFinite(nextRetryAt) && nextRetryAt > now) {
      state = {
        ...current,
        duplicateRequestsSuppressed: current.duplicateRequestsSuppressed + 1,
        updatedAt: measuredAt,
      };
      resultStatus = 'BACKOFF';
      return [state];
    }
    if (sameIncident && current.attemptCount >= current.maximumAttempts && current.status !== 'SUCCEEDED') {
      state = {
        ...current,
        status: 'EXHAUSTED',
        duplicateRequestsSuppressed: current.duplicateRequestsSuppressed + 1,
        updatedAt: measuredAt,
      };
      resultStatus = 'EXHAUSTED';
      return [state];
    }
    if (sameIncident && current.status === 'SUCCEEDED') {
      state = {
        ...current,
        duplicateRequestsSuppressed: current.duplicateRequestsSuppressed + 1,
        updatedAt: measuredAt,
      };
      resultStatus = 'EXHAUSTED';
      return [state];
    }

    const attemptCount = sameIncident ? current.attemptCount + 1 : 1;
    state = {
      ...emptyState(fingerprint, releaseId, reasons, now),
      status: 'CLAIMED',
      attemptCount,
      jobId: null,
      requestedAt: measuredAt,
      duplicateRequestsSuppressed: sameIncident ? current.duplicateRequestsSuppressed : 0,
      updatedAt: measuredAt,
    };
    claimed = true;
    resultStatus = 'REQUESTED';
    return [state];
  });

  if (!claimed) return publicView(resultStatus, state, reasons);

  try {
    const key = `maintenance:job-health:${fingerprint.slice(0, 24)}:${state.attemptCount}`;
    const created = await createAutomationJob({
      type: 'RECONCILE_AUTOMATION',
      payload: {
        maintenanceTask: 'JOB_HEALTH_PROJECTION_REBUILD',
        incidentFingerprint: fingerprint,
        projectionVersion: view.projectionVersion,
        reasonCodes: reasons,
      },
      idempotencyKey: key,
      operationId: key,
      requestedBy: 'app-health-reconciliation',
      priority: 90,
      riskLevel: 'MEDIUM',
      dryRun: false,
      maxAttempts: 1,
    });
    await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => items.map(item =>
      item.id === RECORD_ID && item.incidentFingerprint === fingerprint
        ? {
            ...item,
            status: 'REQUESTED',
            jobId: created.job.id,
            outcomeReasonCode: created.created
              ? 'JOB_HEALTH_PROJECTION_REBUILD_REQUESTED'
              : 'JOB_HEALTH_PROJECTION_REBUILD_REQUEST_REUSED',
            duplicateRequestsSuppressed: item.duplicateRequestsSuppressed + (created.created ? 0 : 1),
            updatedAt: measuredAt,
          }
        : item));
    state = (await getJobHealthProjectionMaintenanceState()) || state;
    await appendAutomationAuditOnce({
      correlationId: key,
      operationId: `${key}:request`,
      jobId: created.job.id,
      operationType: created.created
        ? 'JOB_HEALTH_PROJECTION_REBUILD_REQUESTED'
        : 'JOB_HEALTH_PROJECTION_REBUILD_REQUEST_REUSED',
      actor: 'app-health-reconciliation',
      target: 'automation-job-health-summary',
      risk: 'MEDIUM',
      result: {
        incidentFingerprint: fingerprint,
        attemptCount: state.attemptCount,
        duplicateSuppressed: !created.created,
      },
      reasons,
      dryRun: false,
      attempts: state.attemptCount,
    });
    return publicView(created.created ? 'REQUESTED' : 'REUSED_ACTIVE_REQUEST', state, reasons);
  } catch {
    const attemptIndex = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, state.attemptCount - 1));
    const retryAt = new Date(now + RETRY_BACKOFF_MS[attemptIndex]).toISOString();
    await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => items.map(item =>
      item.id === RECORD_ID && item.incidentFingerprint === fingerprint
        ? {
            ...item,
            status: item.attemptCount >= item.maximumAttempts ? 'EXHAUSTED' : 'FAILED',
            completedAt: measuredAt,
            nextRetryAt: item.attemptCount >= item.maximumAttempts ? null : retryAt,
            outcomeReasonCode: 'JOB_HEALTH_PROJECTION_REBUILD_REQUEST_FAILED',
            updatedAt: measuredAt,
          }
        : item));
    state = (await getJobHealthProjectionMaintenanceState()) || state;
    return publicView(state.status === 'EXHAUSTED' ? 'EXHAUSTED' : 'BACKOFF', state, reasons);
  }
}

export async function markJobHealthProjectionMaintenance(
  input: {
    jobId: string;
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    reasonCode: string;
    now?: number;
  },
): Promise<JobHealthProjectionMaintenanceState | null> {
  const now = input.now ?? Date.now();
  const measuredAt = new Date(now).toISOString();
  let output: JobHealthProjectionMaintenanceState | null = null;
  await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => {
    const index = items.findIndex(item => item.id === RECORD_ID && item.jobId === input.jobId);
    if (index < 0) return undefined;
    const current = items[index];
    const attemptIndex = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, current.attemptCount - 1));
    output = {
      ...current,
      status: input.status,
      startedAt: input.status === 'RUNNING' ? current.startedAt || measuredAt : current.startedAt,
      completedAt: input.status === 'RUNNING' ? null : measuredAt,
      nextRetryAt: input.status === 'FAILED' && current.attemptCount < current.maximumAttempts
        ? new Date(now + RETRY_BACKOFF_MS[attemptIndex]).toISOString()
        : null,
      outcomeReasonCode: input.reasonCode
        .replace(/[^A-Z0-9_:-]/gi, '_')
        .toUpperCase()
        .slice(0, 120),
      updatedAt: measuredAt,
    };
    items[index] = output;
    return items;
  });
  return output;
}
