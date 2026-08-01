import { readBoundedCollectionSnapshot, runTransaction } from '@/lib/storage/adapter';
import { getReleaseIdentity } from '@/lib/releaseIdentity';
import {
  AUTOMATION_JOB_PROJECTION_NAME,
  AUTOMATION_JOB_PROJECTION_VERSION,
  deterministicProjectionFingerprint,
  type AutomationJobProjectionRepairPhase,
  type AutomationJobHealthView,
} from './jobHealthSummary';
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
const INCOMPLETE_CLAIM_MAX_AGE_MS = 15_000;
const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export type JobHealthProjectionMaintenanceStatus =
  | 'IDLE'
  | 'CLAIMED'
  | 'REQUESTED'
  | 'RUNNING'
  | 'RETRY_SCHEDULED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXHAUSTED';

export interface JobHealthProjectionMaintenanceState {
  schemaVersion: 2;
  id: typeof RECORD_ID;
  incidentFingerprint: string;
  releaseId: string;
  status: JobHealthProjectionMaintenanceStatus;
  phase: AutomationJobProjectionRepairPhase | null;
  repairId: string | null;
  /** Monotonic request cycle; prevents a completed job's idempotency key from suppressing later recovery. */
  requestGeneration: number;
  attemptCount: number;
  maximumAttempts: number;
  jobId: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  nextRetryAt: string | null;
  durationMs: number | null;
  sourceRevision: string | null;
  resultRevision: string | null;
  resultFingerprint: string | null;
  reasonCodes: string[];
  outcomeReasonCode: string | null;
  lastFailureReason: string | null;
  duplicateRequestsSuppressed: number;
  updatedAt: string;
}

export interface JobHealthProjectionMaintenanceView {
  status:
    | 'NOT_REQUIRED'
    | 'NEEDS_REPAIR'
    | 'REQUESTED'
    | 'REUSED_ACTIVE_REQUEST'
    | 'BACKOFF'
    | 'EXHAUSTED';
  jobId: string | null;
  requestGeneration: number;
  attemptCount: number;
  maximumAttempts: number;
  nextRetryAt: string | null;
  duplicateRequestsSuppressed: number;
  incidentFingerprint: string | null;
  reasonCodes: string[];
  repairState: 'IDLE' | 'SCHEDULED' | 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED' | 'EXHAUSTED';
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  sourceRevision: string | null;
  resultRevision: string | null;
  resultFingerprint: string | null;
  outcomeReasonCode: string | null;
  phase: AutomationJobProjectionRepairPhase | null;
  repairId: string | null;
  lastFailureReason: string | null;
  /** Terminal evidence from a non-current repair cycle. Never authorizes a current block. */
  historical: {
    status: 'SUCCEEDED' | 'FAILED' | 'EXHAUSTED';
    completedAt: string | null;
    outcomeReasonCode: string | null;
    lastFailureReason: string | null;
  } | null;
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

const MAINTENANCE_STATUS_TRANSITIONS: Readonly<Record<JobHealthProjectionMaintenanceStatus, readonly JobHealthProjectionMaintenanceStatus[]>> = {
  IDLE: ['CLAIMED'],
  CLAIMED: ['REQUESTED', 'FAILED', 'EXHAUSTED'],
  REQUESTED: ['CLAIMED', 'RUNNING', 'RETRY_SCHEDULED', 'FAILED', 'EXHAUSTED'],
  RUNNING: ['RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'EXHAUSTED'],
  RETRY_SCHEDULED: ['RUNNING', 'FAILED', 'EXHAUSTED'],
  SUCCEEDED: [],
  FAILED: ['CLAIMED', 'RUNNING', 'EXHAUSTED'],
  EXHAUSTED: [],
};

const MAINTENANCE_PHASE_TRANSITIONS: Readonly<Record<AutomationJobProjectionRepairPhase, readonly AutomationJobProjectionRepairPhase[]>> = {
  SCHEDULED: ['CLAIMED', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED'],
  CLAIMED: ['REBUILDING', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED'],
  REBUILDING: ['CATCHING_UP', 'VALIDATING', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED'],
  CATCHING_UP: ['CATCHING_UP', 'VALIDATING', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED'],
  VALIDATING: ['PUBLISHING', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED'],
  PUBLISHING: ['COMPLETED', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED'],
  RETRY_WAIT: ['CLAIMED', 'REBUILDING', 'CATCHING_UP', 'FAILED', 'SUPERSEDED'],
  COMPLETED: [],
  FAILED: ['SCHEDULED', 'CLAIMED'],
  SUPERSEDED: [],
};

function assertMaintenanceStatusTransition(
  current: JobHealthProjectionMaintenanceStatus,
  next: JobHealthProjectionMaintenanceStatus,
  reset = false,
): void {
  if (current === next || reset) return;
  if (!MAINTENANCE_STATUS_TRANSITIONS[current].includes(next)) {
    throw new Error(`JOB_PROJECTION_MAINTENANCE_INVALID_TRANSITION:${current}:${next}`);
  }
}

function assertMaintenancePhaseTransition(
  current: AutomationJobProjectionRepairPhase | null,
  next: AutomationJobProjectionRepairPhase | null,
  reset = false,
): void {
  if (current === next || reset || next === null) return;
  if (current === null || !MAINTENANCE_PHASE_TRANSITIONS[current].includes(next)) {
    throw new Error(`JOB_PROJECTION_MAINTENANCE_PHASE_INVALID_TRANSITION:${current || 'NONE'}:${next}`);
  }
}

function normalizeMaintenanceState(value: unknown): JobHealthProjectionMaintenanceState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<JobHealthProjectionMaintenanceState> & { schemaVersion?: number };
  if (state.id !== RECORD_ID || !state.incidentFingerprint || !state.releaseId) return null;
  if (!['IDLE', 'CLAIMED', 'REQUESTED', 'RUNNING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'EXHAUSTED']
    .includes(String(state.status))) return null;
  const status = state.status as JobHealthProjectionMaintenanceStatus;
  const validPhases = new Set<AutomationJobProjectionRepairPhase>([
    'SCHEDULED', 'CLAIMED', 'REBUILDING', 'CATCHING_UP', 'VALIDATING',
    'PUBLISHING', 'COMPLETED', 'RETRY_WAIT', 'FAILED', 'SUPERSEDED',
  ]);
  const legacyPhase: AutomationJobProjectionRepairPhase | null = status === 'CLAIMED' || status === 'REQUESTED'
    ? 'SCHEDULED'
    : status === 'RUNNING'
      ? 'REBUILDING'
      : status === 'RETRY_SCHEDULED'
        ? 'RETRY_WAIT'
        : status === 'SUCCEEDED'
          ? 'COMPLETED'
          : status === 'FAILED' || status === 'EXHAUSTED'
            ? 'FAILED'
            : null;
  return {
    schemaVersion: 2,
    id: RECORD_ID,
    incidentFingerprint: String(state.incidentFingerprint),
    releaseId: String(state.releaseId),
    status,
    phase: state.phase && validPhases.has(state.phase) ? state.phase : legacyPhase,
    repairId: state.repairId || state.jobId || null,
    requestGeneration: Math.max(0, Math.floor(Number(state.requestGeneration) || 0)),
    attemptCount: Math.max(0, Math.floor(Number(state.attemptCount) || 0)),
    maximumAttempts: Math.max(1, Math.floor(Number(state.maximumAttempts) || MAXIMUM_ATTEMPTS)),
    jobId: state.jobId || null,
    requestedAt: state.requestedAt || null,
    startedAt: state.startedAt || null,
    completedAt: state.completedAt || null,
    nextRetryAt: state.nextRetryAt || null,
    durationMs: Number.isFinite(state.durationMs) ? Number(state.durationMs) : null,
    sourceRevision: state.sourceRevision || null,
    resultRevision: state.resultRevision || null,
    resultFingerprint: state.resultFingerprint || null,
    reasonCodes: safeReasons(Array.isArray(state.reasonCodes) ? state.reasonCodes : []),
    outcomeReasonCode: state.outcomeReasonCode || null,
    lastFailureReason: state.lastFailureReason || (status === 'FAILED' || status === 'EXHAUSTED'
      ? state.outcomeReasonCode || null
      : null),
    duplicateRequestsSuppressed: Math.max(0, Math.floor(Number(state.duplicateRequestsSuppressed) || 0)),
    updatedAt: state.updatedAt || new Date(0).toISOString(),
  };
}

function actionableReasons(view: AutomationJobHealthView): string[] {
  return safeReasons(view.reasonCodes.filter(reason =>
    REBUILD_REASON_PREFIXES.some(prefix => reason.startsWith(prefix))));
}

function incidentFingerprint(view: AutomationJobHealthView, reasons: string[], releaseId: string): string {
  return deterministicProjectionFingerprint({
    projectionName: AUTOMATION_JOB_PROJECTION_NAME,
    releaseId,
    projectionVersion: view.projectionVersion,
    activeProjectionGeneration: view.activeProjectionGeneration,
    reasons,
  });
}

function emptyState(
  fingerprint: string,
  releaseId: string,
  reasons: string[],
  now: number,
): JobHealthProjectionMaintenanceState {
  return {
    schemaVersion: 2,
    id: RECORD_ID,
    incidentFingerprint: fingerprint,
    releaseId,
    status: 'IDLE',
    phase: null,
    repairId: null,
    requestGeneration: 0,
    attemptCount: 0,
    maximumAttempts: MAXIMUM_ATTEMPTS,
    jobId: null,
    requestedAt: null,
    startedAt: null,
    completedAt: null,
    nextRetryAt: null,
    durationMs: null,
    sourceRevision: null,
    resultRevision: null,
    resultFingerprint: null,
    reasonCodes: reasons,
    outcomeReasonCode: null,
    lastFailureReason: null,
    duplicateRequestsSuppressed: 0,
    updatedAt: new Date(now).toISOString(),
  };
}

function repairState(
  state: JobHealthProjectionMaintenanceState | null,
): JobHealthProjectionMaintenanceView['repairState'] {
  if (!state || state.status === 'IDLE') return 'IDLE';
  if (state.status === 'CLAIMED' || state.status === 'REQUESTED') return 'SCHEDULED';
  return state.status;
}

function historicalView(
  state: JobHealthProjectionMaintenanceState | null | undefined,
): JobHealthProjectionMaintenanceView['historical'] {
  if (!state || !['SUCCEEDED', 'FAILED', 'EXHAUSTED'].includes(state.status)) return null;
  return {
    status: state.status as 'SUCCEEDED' | 'FAILED' | 'EXHAUSTED',
    completedAt: state.completedAt,
    outcomeReasonCode: state.outcomeReasonCode,
    lastFailureReason: state.lastFailureReason,
  };
}

function publicView(
  status: JobHealthProjectionMaintenanceView['status'],
  state: JobHealthProjectionMaintenanceState | null,
  reasonCodes: string[],
  historicalState?: JobHealthProjectionMaintenanceState | null,
): JobHealthProjectionMaintenanceView {
  return {
    status,
    jobId: state?.jobId || null,
    requestGeneration: state?.requestGeneration || 0,
    attemptCount: state?.attemptCount || 0,
    maximumAttempts: state?.maximumAttempts || MAXIMUM_ATTEMPTS,
    nextRetryAt: state?.nextRetryAt || null,
    duplicateRequestsSuppressed: state?.duplicateRequestsSuppressed || 0,
    incidentFingerprint: state?.incidentFingerprint || null,
    reasonCodes: safeReasons([...reasonCodes, ...(state?.reasonCodes || [])]),
    repairState: repairState(state),
    requestedAt: state?.requestedAt || null,
    startedAt: state?.startedAt || null,
    completedAt: state?.completedAt || null,
    durationMs: Number.isFinite(state?.durationMs) ? Number(state?.durationMs) : null,
    sourceRevision: state?.sourceRevision || null,
    resultRevision: state?.resultRevision || null,
    resultFingerprint: state?.resultFingerprint || null,
    outcomeReasonCode: state?.outcomeReasonCode || null,
    phase: state?.phase || null,
    repairId: state?.repairId || null,
    lastFailureReason: state?.lastFailureReason || null,
    historical: historicalView(historicalState),
  };
}

function maintenanceRequestAge(state: JobHealthProjectionMaintenanceState, now: number): number {
  return now - Date.parse(
    state.status === 'CLAIMED' ? state.updatedAt : state.requestedAt || state.updatedAt,
  );
}

function maintenanceRequestIsActive(state: JobHealthProjectionMaintenanceState, now: number): boolean {
  const requestAge = maintenanceRequestAge(state, now);
  return state.status === 'RETRY_SCHEDULED'
    || (
      ['CLAIMED', 'REQUESTED', 'RUNNING'].includes(state.status)
      && Number.isFinite(requestAge)
      && requestAge <= (
        state.status === 'CLAIMED' && !state.jobId
          ? INCOMPLETE_CLAIM_MAX_AGE_MS
          : ACTIVE_REQUEST_MAX_AGE_MS
      )
    );
}

/**
 * The manifest is the fencing authority for a repair that has already begun.
 * Its compact maintenance record is written by the Worker just after claim,
 * so there is a short, valid interval where the manifest knows about the
 * repair first. Represent that interval as RUNNING without writing a second
 * request; otherwise App Health could falsely show IDLE/NEEDS_REPAIR beside an
 * active generation and an explicit Retry could enqueue redundant work.
 */
function activeManifestRepairState(
  view: AutomationJobHealthView,
  incidentFingerprint: string,
  releaseId: string,
  reasons: string[],
  now: number,
  stored: JobHealthProjectionMaintenanceState | null = null,
): JobHealthProjectionMaintenanceState | null {
  const phase = view.repairPhase;
  if (!view.activeRepairId
    || !phase
    || ['FAILED', 'SUPERSEDED', 'COMPLETED'].includes(phase)) return null;
  const measuredAt = new Date(now).toISOString();
  const matchesIncident = stored?.incidentFingerprint === incidentFingerprint
    && stored.releaseId === releaseId;
  return {
    ...emptyState(incidentFingerprint, releaseId, reasons, now),
    status: 'RUNNING',
    phase,
    repairId: view.activeRepairId,
    requestGeneration: matchesIncident
      ? stored.requestGeneration
      : Math.max(0, view.pendingProjectionGeneration || 0),
    attemptCount: Math.max(1, view.repairAttemptNumber || stored?.attemptCount || 0),
    maximumAttempts: stored?.maximumAttempts || MAXIMUM_ATTEMPTS,
    // A direct maintenance rebuild can use a repair ID that is not an
    // Automation Job ID. Preserve a known matching job ID only.
    jobId: matchesIncident && stored?.jobId === view.activeRepairId ? stored.jobId : null,
    requestedAt: stored?.requestedAt || view.repairStartedAt || measuredAt,
    startedAt: view.repairStartedAt || stored?.startedAt || measuredAt,
    sourceRevision: stored?.sourceRevision || view.currentServingProjectionSourceRevision || null,
    resultRevision: stored?.resultRevision || null,
    resultFingerprint: stored?.resultFingerprint || null,
    duplicateRequestsSuppressed: stored?.duplicateRequestsSuppressed || 0,
    lastFailureReason: null,
    outcomeReasonCode: 'JOB_HEALTH_PROJECTION_REBUILD_RUNNING',
    updatedAt: view.repairLastHeartbeatAt || measuredAt,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('JOB_HEALTH_PROJECTION_REBUILD_REQUEST_ABORTED');
  error.name = 'AbortError';
  throw error;
}

export async function getJobHealthProjectionMaintenanceState(): Promise<JobHealthProjectionMaintenanceState | null> {
  const snapshot = await readBoundedCollectionSnapshot<unknown>(MAINTENANCE_STATE_STORE, {
    // The control store is expected to contain one record. Read a small bounded
    // window so a malformed or legacy sibling cannot hide the authoritative one.
    maximumItems: 10,
    maximumBytes: 128 * 1024,
  });
  return snapshot.items
    .map(normalizeMaintenanceState)
    .find((item): item is JobHealthProjectionMaintenanceState => item !== null)
    || null;
}

/**
 * Read the maintenance state without creating a repair request. Interactive
 * App Health GETs use this path so simply opening or refreshing the page is
 * never an operational mutation.
 */
export async function observeJobHealthProjectionMaintenance(
  view: AutomationJobHealthView,
  now = Date.now(),
): Promise<JobHealthProjectionMaintenanceView> {
  const reasons = actionableReasons(view);
  const stored = await getJobHealthProjectionMaintenanceState();
  const releaseId = getReleaseIdentity().releaseId;
  const fingerprint = incidentFingerprint(view, reasons, releaseId);
  const activeManifestRepair = activeManifestRepairState(
    view,
    fingerprint,
    releaseId,
    reasons,
    now,
    stored,
  );
  if (activeManifestRepair) {
    return publicView(
      'REUSED_ACTIVE_REQUEST',
      activeManifestRepair,
      reasons,
      stored?.status === 'SUCCEEDED' || stored?.status === 'FAILED' || stored?.status === 'EXHAUSTED'
        ? stored
        : null,
    );
  }
  if (view.projectionStatus === 'VALID' || reasons.length === 0) {
    return publicView('NOT_REQUIRED', null, reasons, stored);
  }

  const sameIncident = stored?.incidentFingerprint === fingerprint && stored.releaseId === releaseId;
  if (!stored || !sameIncident) {
    return publicView('NEEDS_REPAIR', emptyState(fingerprint, releaseId, reasons, now), reasons, stored);
  }
  if (maintenanceRequestIsActive(stored, now)) {
    return publicView('REUSED_ACTIVE_REQUEST', stored, reasons);
  }
  const nextRetryAt = Date.parse(stored.nextRetryAt || '');
  if (stored.status === 'FAILED' && Number.isFinite(nextRetryAt) && nextRetryAt > now) {
    return publicView('BACKOFF', stored, reasons);
  }
  if (stored.status === 'EXHAUSTED') return publicView('EXHAUSTED', stored, reasons);
  // A previous success cannot retain authority over a newly-invalid projection.
  // A retry must be explicitly requested, but observation must expose that need.
  return publicView('NEEDS_REPAIR', emptyState(fingerprint, releaseId, reasons, now), reasons, stored);
}

export async function ensureJobHealthProjectionMaintenanceRequest(
  view: AutomationJobHealthView,
  now = Date.now(),
  options: { signal?: AbortSignal } = {},
): Promise<JobHealthProjectionMaintenanceView> {
  throwIfAborted(options.signal);
  const reasons = actionableReasons(view);
  const releaseId = getReleaseIdentity().releaseId;
  const fingerprint = incidentFingerprint(view, reasons, releaseId);
  const activeManifestRepair = activeManifestRepairState(view, fingerprint, releaseId, reasons, now);
  if (activeManifestRepair) {
    return publicView('REUSED_ACTIVE_REQUEST', activeManifestRepair, reasons);
  }
  if (view.projectionStatus === 'VALID' || reasons.length === 0) {
    return publicView('NOT_REQUIRED', null, reasons, await getJobHealthProjectionMaintenanceState());
  }

  let requested = false;
  let resultStatus: JobHealthProjectionMaintenanceView['status'] = 'REUSED_ACTIVE_REQUEST';
  let state!: JobHealthProjectionMaintenanceState;
  const measuredAt = new Date(now).toISOString();

  await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => {
    const stored = normalizeMaintenanceState(items.find(item => item.id === RECORD_ID));
    const current = stored || emptyState(fingerprint, releaseId, reasons, now);
    const active = maintenanceRequestIsActive(current, now);
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
    // A completed repair is historical once the currently observed generation
    // is invalid again. Start a fresh bounded cycle instead of letting a past
    // success suppress recovery indefinitely.
    const previousCycleSucceeded = sameIncident && current.status === 'SUCCEEDED';

    const attemptCount = sameIncident && !previousCycleSucceeded ? current.attemptCount + 1 : 1;
    assertMaintenanceStatusTransition(current.status, 'REQUESTED', true);
    assertMaintenancePhaseTransition(
      current.phase,
      'SCHEDULED',
      !sameIncident || current.status === 'IDLE' || previousCycleSucceeded,
    );
    state = {
      ...emptyState(fingerprint, releaseId, reasons, now),
      status: 'REQUESTED',
      phase: 'SCHEDULED',
      requestGeneration: Math.max(0, current.requestGeneration) + 1,
      repairId: `repair-request:${fingerprint.slice(0, 32)}:${Math.max(0, current.requestGeneration) + 1}`,
      attemptCount,
      jobId: null,
      requestedAt: measuredAt,
      duplicateRequestsSuppressed: sameIncident && !previousCycleSucceeded
        ? current.duplicateRequestsSuppressed
        : 0,
      updatedAt: measuredAt,
    };
    requested = true;
    resultStatus = 'REQUESTED';
    return [state];
  });

  return publicView(requested ? 'REQUESTED' : resultStatus, state, reasons);
}

/** Materialize the compact request outside the interactive App Health path. */
export async function materializeJobHealthProjectionMaintenanceRequest(
  now = Date.now(),
): Promise<JobHealthProjectionMaintenanceState | null> {
  const measuredAt = new Date(now).toISOString();
  let claimed: JobHealthProjectionMaintenanceState | null = null;
  await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => {
    const current = normalizeMaintenanceState(items.find(item => item.id === RECORD_ID));
    if (!current || current.jobId || current.status !== 'REQUESTED') return undefined;
    assertMaintenanceStatusTransition(current.status, 'CLAIMED');
    claimed = { ...current, status: 'CLAIMED', phase: 'SCHEDULED', updatedAt: measuredAt };
    return [claimed];
  });
  if (!claimed) return getJobHealthProjectionMaintenanceState();

  const request = claimed as JobHealthProjectionMaintenanceState;
  const key = `maintenance:${AUTOMATION_JOB_PROJECTION_NAME}:${request.incidentFingerprint.slice(0, 32)}:${request.requestGeneration}`;
  try {
    const created = await createAutomationJob({
      type: 'RECONCILE_AUTOMATION',
      payload: {
        maintenanceTask: 'JOB_HEALTH_PROJECTION_REBUILD',
        incidentFingerprint: request.incidentFingerprint,
        projectionVersion: AUTOMATION_JOB_PROJECTION_VERSION,
        reasonCodes: request.reasonCodes,
      },
      idempotencyKey: key,
      operationId: key,
      requestedBy: 'app-health-reconciliation',
      priority: 90,
      riskLevel: 'MEDIUM',
      dryRun: false,
      maxAttempts: MAXIMUM_ATTEMPTS,
    });
    let output: JobHealthProjectionMaintenanceState | null = null;
    await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => {
      const current = normalizeMaintenanceState(items.find(item => item.id === RECORD_ID));
      if (!current || current.incidentFingerprint !== request.incidentFingerprint || current.status !== 'CLAIMED') {
        return undefined;
      }
      assertMaintenanceStatusTransition(current.status, 'REQUESTED');
      output = {
        ...current,
        status: 'REQUESTED',
        phase: 'SCHEDULED',
        jobId: created.job.id,
        repairId: created.job.id,
        outcomeReasonCode: created.created
          ? 'JOB_HEALTH_PROJECTION_REBUILD_REQUESTED'
          : 'JOB_HEALTH_PROJECTION_REBUILD_REQUEST_REUSED',
        duplicateRequestsSuppressed: current.duplicateRequestsSuppressed + (created.created ? 0 : 1),
        updatedAt: measuredAt,
      };
      return [output];
    });
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
        incidentFingerprint: request.incidentFingerprint,
        attemptCount: request.attemptCount,
        duplicateSuppressed: !created.created,
      },
      reasons: request.reasonCodes,
      dryRun: false,
      attempts: request.attemptCount,
    });
    return output || getJobHealthProjectionMaintenanceState();
  } catch (error) {
    const attemptIndex = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, request.attemptCount - 1));
    const retryAt = new Date(now + RETRY_BACKOFF_MS[attemptIndex]).toISOString();
    await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => {
      const current = normalizeMaintenanceState(items.find(item => item.id === RECORD_ID));
      if (!current || current.incidentFingerprint !== request.incidentFingerprint) return undefined;
      const nextStatus = current.attemptCount >= current.maximumAttempts ? 'EXHAUSTED' : 'FAILED';
      assertMaintenanceStatusTransition(current.status, nextStatus);
      assertMaintenancePhaseTransition(current.phase, 'FAILED');
      const failure = error instanceof Error && error.name === 'AbortError'
        ? 'JOB_HEALTH_PROJECTION_REBUILD_REQUEST_ABORTED'
        : 'JOB_HEALTH_PROJECTION_REBUILD_REQUEST_FAILED';
      return [{
        ...current,
        status: nextStatus,
        phase: 'FAILED',
        completedAt: measuredAt,
        nextRetryAt: current.attemptCount >= current.maximumAttempts ? null : retryAt,
        outcomeReasonCode: failure,
        lastFailureReason: failure,
        updatedAt: measuredAt,
      }];
    });
    return getJobHealthProjectionMaintenanceState();
  }
}

export async function markJobHealthProjectionMaintenance(
  input: {
    jobId: string;
    status: 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED';
    reasonCode: string;
    nextRetryAt?: string | null;
    sourceRevision?: string | null;
    resultRevision?: string | null;
    resultFingerprint?: string | null;
    phase?: AutomationJobProjectionRepairPhase;
    attemptNumber?: number;
    now?: number;
  },
): Promise<JobHealthProjectionMaintenanceState | null> {
  const now = input.now ?? Date.now();
  const measuredAt = new Date(now).toISOString();
  let output: JobHealthProjectionMaintenanceState | null = null;
  await runTransaction<JobHealthProjectionMaintenanceState>(MAINTENANCE_STATE_STORE, items => {
    const current = normalizeMaintenanceState(items.find(item => item.id === RECORD_ID));
    if (!current || current.jobId !== input.jobId) return undefined;
    const attemptIndex = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, current.attemptCount - 1));
    const nextPhase: AutomationJobProjectionRepairPhase = input.phase
      || (input.status === 'RUNNING'
        ? 'CLAIMED'
        : input.status === 'RETRY_SCHEDULED'
          ? 'RETRY_WAIT'
          : input.status === 'SUCCEEDED'
            ? 'COMPLETED'
            : 'FAILED');
    assertMaintenanceStatusTransition(current.status, input.status);
    assertMaintenancePhaseTransition(current.phase, nextPhase);
    const startedAt = input.status === 'RUNNING' ? current.startedAt || measuredAt : current.startedAt;
    const startedAtMs = Date.parse(startedAt || '');
    const safeReason = input.reasonCode
      .replace(/[^A-Z0-9_:-]/gi, '_')
      .toUpperCase()
      .slice(0, 120);
    output = {
      ...current,
      status: input.status,
      phase: nextPhase,
      repairId: input.jobId,
      attemptCount: Math.max(current.attemptCount, Math.floor(input.attemptNumber || 0)),
      startedAt,
      completedAt: input.status === 'RUNNING' ? null : measuredAt,
      nextRetryAt: input.status === 'RETRY_SCHEDULED'
        ? input.nextRetryAt || new Date(now + RETRY_BACKOFF_MS[attemptIndex]).toISOString()
        : input.status === 'FAILED' && current.attemptCount < current.maximumAttempts
          ? new Date(now + RETRY_BACKOFF_MS[attemptIndex]).toISOString()
          : null,
      durationMs: input.status === 'RUNNING' || !Number.isFinite(startedAtMs)
        ? null
        : Math.max(0, now - startedAtMs),
      sourceRevision: input.sourceRevision === undefined
        ? current.sourceRevision || null
        : input.sourceRevision,
      resultRevision: input.resultRevision === undefined
        ? current.resultRevision || null
        : input.resultRevision,
      resultFingerprint: input.resultFingerprint === undefined
        ? current.resultFingerprint || null
        : input.resultFingerprint,
      outcomeReasonCode: safeReason,
      lastFailureReason: input.status === 'FAILED' || input.status === 'RETRY_SCHEDULED'
        ? safeReason
        : current.lastFailureReason,
      updatedAt: measuredAt,
    };
    return [output];
  });
  return output;
}
