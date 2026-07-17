import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { AutonomousMode } from './types';

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

export async function getCanaryState(): Promise<CanaryState> {
  const stored = (await readCollection<Partial<CanaryState>>(COLLECTION))[0];
  return normalizeState(stored);
}

export async function recordSuccessfulShadowCycle(now = Date.now()): Promise<CanaryState> {
  let output!: CanaryState;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    state.successfulShadowCycles += 1;
    if (state.wave === 0 && state.successfulShadowCycles >= 1 && !state.paused) state.wave = 1;
    state.updatedAt = new Date(now).toISOString();
    output = state;
    return [state];
  });
  return output;
}

export async function canPublishInCurrentWave(mode: AutonomousMode, effectKey: string): Promise<{ allowed: boolean; wave: CanaryWave; remaining: number; reason?: string }> {
  if (mode === 'AUTONOMOUS') return { allowed: true, wave: 3, remaining: Number.MAX_SAFE_INTEGER };
  if (mode !== 'CANARY') return { allowed: false, wave: 0, remaining: 0, reason: 'MODE_DISALLOWS_PUBLISH' };
  const state = await getCanaryState();
  const capacity = getCanaryWaveBudget(state.wave);
  const remaining = Math.max(0, capacity - usedEffectCount(state));

  // A completed product write must be allowed to finish its journal/event replay.
  if (state.publishedEffectKeys.includes(effectKey)) return { allowed: true, wave: state.wave, remaining };
  if (state.paused) return { allowed: false, wave: state.wave, remaining: 0, reason: 'CANARY_PAUSED' };
  if (state.reservedEffectKeys.includes(effectKey)) return { allowed: true, wave: state.wave, remaining };
  return { allowed: remaining > 0, wave: state.wave, remaining, reason: remaining > 0 ? undefined : 'CANARY_WAVE_EXCEEDED' };
}

export async function reserveCanaryEffect(mode: AutonomousMode, effectKey: string): Promise<boolean> {
  if (mode === 'AUTONOMOUS') return true;
  let reserved = false;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    const published = state.publishedEffectKeys.includes(effectKey);
    const alreadyReserved = state.reservedEffectKeys.includes(effectKey);
    if (published) {
      reserved = true;
      return undefined;
    }
    if (mode === 'CANARY' && !state.paused && (alreadyReserved || usedEffectCount(state) < getCanaryWaveBudget(state.wave))) {
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
  if (mode !== 'CANARY') return;
  await runTransaction<CanaryState>(COLLECTION, items => {
    const state = normalizeState(items[0]);
    state.reservedEffectKeys = state.reservedEffectKeys.filter(key => key !== effectKey);
    if (success) state.publishedEffectKeys = [...new Set([...state.publishedEffectKeys, effectKey])].slice(-100);
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
