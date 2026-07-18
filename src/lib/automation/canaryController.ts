import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { AutomationSloMeasurement } from './sloErrorBudget';
import type { AutomationControlState, AutonomousMode } from './types';

const COLLECTION = 'automation-canary';

export type CanaryWave = 0 | 1 | 2 | 3;

export interface CanaryState {
  schemaVersion: number;
  id: 'canary-controller';
  wave: CanaryWave;
  successfulShadowCycles: number;
  reservedEffectKeys: string[];
  publishedEffectKeys: string[];
  paused: boolean;
  pauseReasons: string[];
  lastHealthyEvaluationId?: string;
  lastEvaluationAt?: string;
  controlledLaunch?: boolean;
  approvedWave?: CanaryWave;
  approvedBy?: string;
  approvedAt?: string;
  approvalReason?: string;
  wavePublishedBaseline?: number;
  observationUntil?: string;
  updatedAt: string;
}

export interface CanaryHealthEvidence {
  evaluationId: string;
  status: 'PASS' | 'BREACH' | 'INSUFFICIENT_DATA';
  dataStatus: 'MEASURED' | 'INSUFFICIENT_DATA';
  sampleSize: number;
  evaluatedAt: string;
}

export interface CanarySafetyDecision {
  pause: boolean;
  reasons: string[];
  evaluatedAt?: string;
  evaluationId?: string;
}

export interface ControlledWaveGate {
  code: string;
  passed: boolean;
  observed: number | boolean | string | null;
  required: string;
}

export interface ControlledWavePreview {
  requestedWave: CanaryWave;
  currentWave: CanaryWave;
  cumulativeBudget: number;
  additionalBudget: number;
  publishedCount: number;
  remainingInCurrentWave: number;
  readyForLaunchCount: number;
  backupVerified: boolean;
  eligible: boolean;
  gates: ControlledWaveGate[];
  warnings: string[];
  observationUntil?: string;
  measuredAt: string;
}

export interface ControlledModeTransitionPreview {
  targetMode: 'CANARY' | 'AUTONOMOUS';
  backupVerified: boolean;
  eligible: boolean;
  gates: ControlledWaveGate[];
  measuredAt: string;
}

const DEFAULT_STATE: CanaryState = {
  schemaVersion: 2,
  id: 'canary-controller',
  wave: 0,
  successfulShadowCycles: 0,
  reservedEffectKeys: [],
  publishedEffectKeys: [],
  paused: false,
  pauseReasons: [],
  updatedAt: new Date(0).toISOString(),
};

export function getCanaryWaveBudget(wave: CanaryWave): number {
  if (wave === 0) return 0;
  if (wave === 1) return 3;
  if (wave === 2) return 10;
  return 50;
}

/** Cumulative ceilings: WAVE 1 = 10, WAVE 2 = +25, WAVE 3 = +50. */
export function getControlledWaveBudget(wave: CanaryWave): number {
  if (wave === 0) return 0;
  if (wave === 1) return 10;
  if (wave === 2) return 35;
  return 85;
}

function normalizeState(stored?: Partial<CanaryState>): CanaryState {
  return {
    ...DEFAULT_STATE,
    ...stored,
    schemaVersion: 2,
    id: 'canary-controller',
    reservedEffectKeys: [...new Set(Array.isArray(stored?.reservedEffectKeys) ? stored.reservedEffectKeys.filter(item => typeof item === 'string') : [])].slice(-100),
    publishedEffectKeys: [...new Set(Array.isArray(stored?.publishedEffectKeys) ? stored.publishedEffectKeys.filter(item => typeof item === 'string') : [])].slice(-100),
    pauseReasons: [...new Set(Array.isArray(stored?.pauseReasons) ? stored.pauseReasons.filter(item => typeof item === 'string') : [])].slice(0, 20),
  };
}

function usedEffectCount(state: CanaryState): number {
  return new Set([...state.reservedEffectKeys, ...state.publishedEffectKeys]).size;
}

function activeWaveBudget(state: CanaryState): number {
  return state.controlledLaunch ? getControlledWaveBudget(state.wave) : getCanaryWaveBudget(state.wave);
}

export async function getCanaryState(): Promise<CanaryState> {
  const stored = (await readCollection<Partial<CanaryState>>(COLLECTION))[0];
  return normalizeState(stored);
}

export async function recordSuccessfulShadowCycle(now = Date.now()): Promise<CanaryState> {
  let output!: CanaryState;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    state.successfulShadowCycles += 1;
    if (!state.controlledLaunch && state.wave === 0 && state.successfulShadowCycles >= 1 && !state.paused) state.wave = 1;
    state.updatedAt = new Date(now).toISOString();
    output = state;
    return [state];
  });
  return output;
}

export async function canPublishInCurrentWave(mode: AutonomousMode, effectKey: string): Promise<{ allowed: boolean; wave: CanaryWave; remaining: number; reason?: string }> {
  const state = await getCanaryState();
  if (mode !== 'CANARY' && mode !== 'AUTONOMOUS') return { allowed: false, wave: 0, remaining: 0, reason: 'MODE_DISALLOWS_PUBLISH' };
  if (!state.controlledLaunch) return { allowed: false, wave: 0, remaining: 0, reason: 'CONTROLLED_LAUNCH_REQUIRED' };
  if (state.wave === 0 || state.approvedWave !== state.wave) return { allowed: false, wave: state.wave, remaining: 0, reason: 'WAVE_OWNER_CONFIRMATION_REQUIRED' };
  const capacity = activeWaveBudget(state);
  const remaining = Math.max(0, capacity - usedEffectCount(state));

  // A completed product write must be allowed to finish its journal/event replay.
  if (state.publishedEffectKeys.includes(effectKey)) return { allowed: true, wave: state.wave, remaining };
  if (state.paused) return { allowed: false, wave: state.wave, remaining: 0, reason: 'CANARY_PAUSED' };
  if (state.controlledLaunch && state.approvedWave !== state.wave) return { allowed: false, wave: state.wave, remaining: 0, reason: 'WAVE_OWNER_CONFIRMATION_REQUIRED' };
  if (state.reservedEffectKeys.includes(effectKey)) return { allowed: true, wave: state.wave, remaining };
  return { allowed: remaining > 0, wave: state.wave, remaining, reason: remaining > 0 ? undefined : 'CANARY_WAVE_EXCEEDED' };
}

export async function reserveCanaryEffect(mode: AutonomousMode, effectKey: string): Promise<boolean> {
  const initial = await getCanaryState();
  if (!initial.controlledLaunch || initial.wave === 0 || initial.approvedWave !== initial.wave) return false;
  let reserved = false;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    const published = state.publishedEffectKeys.includes(effectKey);
    const alreadyReserved = state.reservedEffectKeys.includes(effectKey);
    if (published) {
      reserved = true;
      return undefined;
    }
    if ((mode === 'CANARY' || mode === 'AUTONOMOUS') && !state.paused
      && (!state.controlledLaunch || state.approvedWave === state.wave)
      && (alreadyReserved || usedEffectCount(state) < activeWaveBudget(state))) {
      if (!alreadyReserved) state.reservedEffectKeys.push(effectKey);
      reserved = true;
      state.updatedAt = new Date().toISOString();
      return [state];
    }
    return undefined;
  });
  return reserved;
}

export async function completeCanaryEffect(mode: AutonomousMode, effectKey: string, success: boolean): Promise<void> {
  if (mode !== 'CANARY' && mode !== 'AUTONOMOUS') return;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    state.reservedEffectKeys = state.reservedEffectKeys.filter(key => key !== effectKey);
    if (success) {
      state.publishedEffectKeys = [...new Set([...state.publishedEffectKeys, effectKey])].slice(-100);
      if (state.controlledLaunch) state.observationUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    }
    state.updatedAt = new Date().toISOString();
    return [state];
  });
}

export async function advanceCanaryWaveAfterHealthyEvaluation(evidence?: CanaryHealthEvidence): Promise<CanaryState> {
  let output!: CanaryState;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    const evidenceIsUsable = evidence?.status === 'PASS'
      && evidence.dataStatus === 'MEASURED'
      && evidence.sampleSize >= 5
      && Number.isFinite(Date.parse(evidence.evaluatedAt));
    if (evidenceIsUsable && !state.paused && state.lastHealthyEvaluationId !== evidence.evaluationId) {
      if (state.controlledLaunch) {
        state.lastHealthyEvaluationId = evidence.evaluationId;
        state.lastEvaluationAt = evidence.evaluatedAt;
        state.updatedAt = new Date().toISOString();
        output = state;
        return [state];
      }
      if (state.wave === 1 && state.publishedEffectKeys.length >= 1) state.wave = 2;
      else if (state.wave === 2 && state.publishedEffectKeys.length >= 5) state.wave = 3;
      state.lastHealthyEvaluationId = evidence.evaluationId;
      state.lastEvaluationAt = evidence.evaluatedAt;
    }
    state.updatedAt = new Date().toISOString();
    output = state;
    return [state];
  });
  return output;
}

export async function activateControlledLaunch(input: { actor: string; reason: string; now?: number }): Promise<CanaryState> {
  let previous!: CanaryState;
  let output!: CanaryState;
  const now = input.now ?? Date.now();
  await runTransaction<CanaryState>(COLLECTION, items => {
    previous = normalizeState(items[0]);
    output = {
      ...previous,
      controlledLaunch: true,
      wave: 0,
      approvedWave: 0,
      approvedBy: input.actor,
      approvedAt: new Date(now).toISOString(),
      approvalReason: input.reason.slice(0, 500),
      wavePublishedBaseline: previous.publishedEffectKeys.length,
      observationUntil: undefined,
      updatedAt: new Date(now).toISOString(),
    };
    return [output];
  });
  const { appendAutomationAudit } = await import('./store');
  await appendAutomationAudit({
    correlationId: `controlled-launch-${now}`,
    operationId: `controlled-launch-${now}`,
    operationType: 'CONTROL_CHANGED',
    actor: input.actor,
    target: 'automation-canary',
    previousState: JSON.stringify({ controlledLaunch: previous.controlledLaunch, wave: previous.wave }),
    nextState: JSON.stringify({ controlledLaunch: true, wave: 0, approvedWave: 0 }),
    risk: 'MEDIUM', reasons: [input.reason], dryRun: false, attempts: 0,
  });
  return output;
}

function gate(code: string, passed: boolean, observed: ControlledWaveGate['observed'], required: string): ControlledWaveGate {
  return { code, passed, observed, required };
}

function operationalSafetyGates(
  measurement: AutomationSloMeasurement,
  control: AutomationControlState,
  readyForLaunchCount: number,
  rollbackPass: boolean,
): ControlledWaveGate[] {
  const noCriticalBlocker = measurement.runtimePublishSafe === true
    && measurement.runtimeReasons.length === 0
    && measurement.storageLockTimeoutCount === 0;
  return [
    gate('KILL_SWITCH', !control.killSwitch, control.killSwitch, 'false'),
    gate('WORKER_HEALTH', measurement.workerHeartbeatFresh === true, measurement.workerHeartbeatFresh, 'fresh'),
    gate('SCHEDULER_HEALTH', measurement.schedulerHeartbeatFresh === true, measurement.schedulerHeartbeatFresh, 'fresh'),
    gate('HEALTH_PASS_RATE', measurement.healthPassRate !== null && measurement.healthPassRate >= 0.95, measurement.healthPassRate, '>= 0.95'),
    gate('ERROR_RATE', measurement.errorRate !== null && measurement.errorRate <= 0.05, measurement.errorRate, '<= 0.05'),
    gate('ROLLBACK_RATE', rollbackPass, measurement.rollbackRate, '<= 0.02 (not applicable before first publication)'),
    gate('PUBLIC_ROUTES', measurement.publicRouteHealthy === true, measurement.publicRouteHealthy, 'healthy'),
    gate('NO_DUPLICATE_SIDE_EFFECTS', measurement.duplicatePublishCount === 0, measurement.duplicatePublishCount, '0'),
    gate('NO_UNSAFE_PUBLICATION', measurement.unsafePublishCount === 0, measurement.unsafePublishCount, '0'),
    gate('READY_PRODUCTS', readyForLaunchCount > 0, readyForLaunchCount, '> 0'),
    gate('NO_CRITICAL_BLOCKER', noCriticalBlocker, noCriticalBlocker, 'runtime publish safe with no critical reason or storage lock timeout'),
  ];
}

export function evaluateControlledModeTransition(input: {
  targetMode: 'CANARY' | 'AUTONOMOUS';
  state: CanaryState;
  control: AutomationControlState;
  measurement: AutomationSloMeasurement;
  readyForLaunchCount: number;
  backupVerified: boolean;
  ownerConfirmed: boolean;
  confirmationAt?: string;
  now?: number;
}): ControlledModeTransitionPreview {
  const now = input.now ?? Date.now();
  const confirmationTime = Date.parse(input.confirmationAt || '');
  const confirmationFresh = Number.isFinite(confirmationTime)
    && confirmationTime <= now + 30_000
    && now - confirmationTime <= 5 * 60_000;
  const planExists = input.state.controlledLaunch === true
    && Boolean(input.state.approvedBy)
    && Boolean(input.state.approvedAt)
    && Boolean(input.state.approvalReason);
  const waveValid = input.targetMode === 'CANARY'
    ? [0, 1, 2, 3].includes(input.state.wave)
      && input.state.approvedWave === input.state.wave
    : [1, 2, 3].includes(input.state.wave)
      && input.state.approvedWave === input.state.wave;
  const rollbackPass = input.measurement.rollbackRate === null
    ? input.measurement.sourceCounts.publicationAttempts === 0
    : input.measurement.rollbackRate <= 0.02;
  const gates = [
    gate('OWNER_CONFIRMATION', input.ownerConfirmed === true, input.ownerConfirmed, 'true'),
    gate('CONFIRMATION_FRESH', confirmationFresh, input.confirmationAt || null, 'server-authenticated request within 5 minutes'),
    gate('BACKUP_VERIFIED', input.backupVerified === true, input.backupVerified, 'verified snapshot'),
    gate('CONTROLLED_LAUNCH_PLAN', planExists, planExists, 'persisted controlled launch plan'),
    gate('CONTROLLED_LAUNCH_STATE', input.state.controlledLaunch === true && !input.state.paused, input.state.paused, 'active and not paused'),
    gate('LAUNCH_WAVE', waveValid, input.state.wave, input.targetMode === 'CANARY' ? 'approved wave 0-3' : 'approved active wave 1-3'),
    ...operationalSafetyGates(input.measurement, input.control, input.readyForLaunchCount, rollbackPass),
  ];
  return {
    targetMode: input.targetMode,
    backupVerified: input.backupVerified,
    eligible: gates.every(item => item.passed),
    gates,
    measuredAt: input.measurement.measuredAt,
  };
}

export async function previewControlledModeTransition(
  targetMode: 'CANARY' | 'AUTONOMOUS',
  options: { backupVerified?: boolean; ownerConfirmed?: boolean; confirmationAt?: string; now?: number } = {},
): Promise<ControlledModeTransitionPreview> {
  const now = options.now ?? Date.now();
  const [{ measureAutomationSlo }, { getAutomationControl }, inventoryModule] = await Promise.all([
    import('./sloErrorBudget'),
    import('./store'),
    import('./launchInventory'),
  ]);
  const [state, measurement, control, inventory] = await Promise.all([
    getCanaryState(),
    measureAutomationSlo({ now, minimumSamples: 5 }),
    getAutomationControl(),
    inventoryModule.buildLaunchReadyReport(),
  ]);
  return evaluateControlledModeTransition({
    targetMode,
    state,
    measurement,
    control,
    readyForLaunchCount: inventory.totalReady,
    backupVerified: options.backupVerified === true,
    ownerConfirmed: options.ownerConfirmed === true,
    confirmationAt: options.confirmationAt,
    now,
  });
}

export async function previewControlledPublishWave(
  requestedWave: CanaryWave,
  options: { backupVerified?: boolean; now?: number } = {},
): Promise<ControlledWavePreview> {
  const now = options.now ?? Date.now();
  const [{ measureAutomationSlo }, { getAutomationControl }, { getAutomationSettings }, inventoryModule] = await Promise.all([
    import('./sloErrorBudget'),
    import('./store'),
    import('@/lib/storage/automationSettings'),
    import('./launchInventory'),
  ]);
  const [storedState, measurement, control, settings, inventory] = await Promise.all([
    getCanaryState(),
    measureAutomationSlo({ now, minimumSamples: 5 }),
    getAutomationControl(),
    getAutomationSettings(),
    inventoryModule.buildLaunchReadyReport(),
  ]);
  const state = storedState.controlledLaunch
    ? storedState
    : { ...storedState, wave: 0 as CanaryWave, approvedWave: 0 as CanaryWave, wavePublishedBaseline: storedState.publishedEffectKeys.length };
  const expectedWave = Math.min(3, state.wave + 1) as CanaryWave;
  const recoveringPausedWave = state.controlledLaunch === true && state.paused && requestedWave === state.wave;
  const published = state.publishedEffectKeys.length;
  const baseline = state.wavePublishedBaseline ?? 0;
  const observationPassed = !state.observationUntil || Date.parse(state.observationUntil) <= now;
  const previousWaveObserved = recoveringPausedWave || requestedWave === 1 || (published > baseline && observationPassed);
  const rollbackPass = measurement.rollbackRate === null
    ? requestedWave === 1 && measurement.sourceCounts.publicationAttempts === 0
    : measurement.rollbackRate <= 0.02;
  const gates: ControlledWaveGate[] = [
    gate('SEQUENTIAL_WAVE', requestedWave === expectedWave || recoveringPausedWave, requestedWave, recoveringPausedWave ? String(state.wave) : String(expectedWave)),
    gate('SHADOW_CYCLE', requestedWave !== 1 || state.successfulShadowCycles >= 1, state.successfulShadowCycles, '>= 1 before WAVE 1'),
    gate('PREVIOUS_WAVE_OBSERVED', previousWaveObserved, state.observationUntil || null, 'at least one publish and 30-minute observation before next wave'),
    gate('MODE', control.mode === 'CANARY' || control.mode === 'AUTONOMOUS', control.mode, 'CANARY or AUTONOMOUS'),
    gate('PUBLISH_NOT_PAUSED', !control.publishPaused, control.publishPaused, 'false'),
    gate('LAUNCH_ENABLED', settings.launchEnabled, settings.launchEnabled, 'true'),
    gate('CANARY_NOT_PAUSED', !state.paused || recoveringPausedWave, state.paused, 'false, or explicit owner re-approval after health recovery'),
    ...operationalSafetyGates(measurement, control, inventory.totalReady, rollbackPass),
    gate('BACKUP_VERIFIED', options.backupVerified === true, options.backupVerified === true, 'verified snapshot'),
  ];
  const currentBudget = getControlledWaveBudget(state.wave);
  const requestedBudget = getControlledWaveBudget(requestedWave);
  return {
    requestedWave,
    currentWave: state.wave,
    cumulativeBudget: requestedBudget,
    additionalBudget: requestedBudget - currentBudget,
    publishedCount: published,
    remainingInCurrentWave: Math.max(0, currentBudget - usedEffectCount(state)),
    readyForLaunchCount: inventory.totalReady,
    backupVerified: options.backupVerified === true,
    eligible: gates.every(item => item.passed),
    gates,
    warnings: measurement.dataStatus === 'INSUFFICIENT_DATA' ? ['SLO telemetry has insufficient measured samples; wave approval remains blocked.'] : [],
    observationUntil: state.observationUntil,
    measuredAt: measurement.measuredAt,
  };
}

export async function approveControlledPublishWave(input: {
  requestedWave: CanaryWave;
  actor: string;
  reason: string;
  confirmed: boolean;
}): Promise<{ state: CanaryState; preview: ControlledWavePreview; backup: { created: boolean; sourceStateHash: string } }> {
  if (!input.confirmed) throw new Error('WAVE_CONFIRMATION_REQUIRED');
  if (input.reason.trim().length < 8) throw new Error('WAVE_REASON_REQUIRED');
  if (![1, 2, 3].includes(input.requestedWave)) throw new Error('WAVE_INVALID');
  let state = await getCanaryState();
  if (!state.controlledLaunch) throw new Error('CONTROLLED_LAUNCH_REQUIRED');
  const preliminary = await previewControlledPublishWave(input.requestedWave);
  const blockers = preliminary.gates.filter(item => !item.passed && item.code !== 'BACKUP_VERIFIED');
  if (blockers.length > 0) throw new Error(`WAVE_HEALTH_GATES_FAILED:${blockers.map(item => item.code).join(',')}`);
  const { ensurePreCanarySnapshot } = await import('@/lib/autonomous/backupManager');
  const targetMode = (await import('./store')).getAutomationControl().then(control => control.mode === 'AUTONOMOUS' ? 'AUTONOMOUS' as const : 'CANARY' as const);
  const snapshot = await ensurePreCanarySnapshot({ targetMode: await targetMode, retention: 30 });
  const preview = await previewControlledPublishWave(input.requestedWave, { backupVerified: true });
  if (!preview.eligible) throw new Error(`WAVE_HEALTH_GATES_CHANGED:${preview.gates.filter(item => !item.passed).map(item => item.code).join(',')}`);
  let previous!: CanaryState;
  await runTransaction<CanaryState>(COLLECTION, items => {
    previous = normalizeState(items[0]);
    if (!previous.controlledLaunch || previous.wave !== preview.currentWave) throw new Error('WAVE_STATE_CHANGED');
    state = {
      ...previous,
      wave: input.requestedWave,
      approvedWave: input.requestedWave,
      approvedBy: input.actor,
      approvedAt: new Date().toISOString(),
      approvalReason: input.reason.slice(0, 500),
      wavePublishedBaseline: previous.publishedEffectKeys.length,
      observationUntil: undefined,
      paused: false,
      pauseReasons: [],
      updatedAt: new Date().toISOString(),
    };
    return [state];
  });
  const { appendAutomationAudit } = await import('./store');
  await appendAutomationAudit({
    correlationId: `wave-${input.requestedWave}-${Date.now()}`,
    operationId: `wave-${input.requestedWave}-${Date.now()}`,
    operationType: 'CONTROL_CHANGED', actor: input.actor, target: 'automation-canary',
    previousState: JSON.stringify({ wave: previous.wave, published: previous.publishedEffectKeys.length }),
    nextState: JSON.stringify({ wave: state.wave, cumulativeBudget: preview.cumulativeBudget, approvedBy: input.actor }),
    risk: 'HIGH', reasons: [input.reason], dryRun: false, attempts: 0,
    result: { measurementAt: preview.measuredAt, snapshotHash: snapshot.sourceStateHash },
  });
  return { state, preview, backup: { created: snapshot.created, sourceStateHash: snapshot.sourceStateHash } };
}

export async function applyCanarySafetyDecision(decision: CanarySafetyDecision): Promise<CanaryState> {
  let output!: CanaryState;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    state.paused = decision.pause;
    state.pauseReasons = decision.pause ? [...new Set(decision.reasons)].slice(0, 20) : [];
    state.lastEvaluationAt = decision.evaluatedAt || new Date().toISOString();
    if (decision.evaluationId) state.lastHealthyEvaluationId = decision.pause ? state.lastHealthyEvaluationId : decision.evaluationId;
    state.updatedAt = state.lastEvaluationAt;
    output = state;
    return [state];
  });
  return output;
}

/** @deprecated Caller-provided SLO values are ignored; persisted telemetry is re-measured. */
export async function applyErrorBudget(_untrustedSnapshot?: unknown): Promise<{ degraded: boolean; effectiveMode: string; reasons: string[] }> {
  void _untrustedSnapshot;
  const { applyAutomationErrorBudget } = await import('./sloErrorBudget');
  const result = await applyAutomationErrorBudget();
  return { degraded: result.applied, effectiveMode: result.control.effectiveMode, reasons: result.evaluation.reasons };
}
