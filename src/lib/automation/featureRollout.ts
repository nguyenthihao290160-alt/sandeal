export const FEATURE_ROLLOUT_MODES = ['OFF', 'SHADOW', 'OBSERVE', 'CANARY', 'ACTIVE'] as const;

export type FeatureRolloutMode = typeof FEATURE_ROLLOUT_MODES[number];

export const SANDEAL_FEATURE_FLAGS = [
  'RUNTIME_RECOVERY_V2',
  'RECOVERY_CANARY',
  'WORKER_CONTINUOUS_POOL_V2',
  'WORKER_CRITICAL_SCHEDULING_V3',
  'SLO_RUNNABLE_AT_V2',
  'PRODUCT_RECHECK_V2',
  'PUBLICATION_EVIDENCE_V2',
  'ACCESSTRADE_LIVE_READINESS_PROBE',
  'AI_CLOUD_FALLBACK',
  'AI_LOCAL_FALLBACK',
  'OPERATOR_ALERTING',
  'SMART_CATEGORIZATION_V2',
  'MONGO_BULK_WRITE',
  'MULTI_AFFILIATE_OFFER',
  'PROGRAMMATIC_SEO_V2',
] as const;

export type SandealFeatureFlag = typeof SANDEAL_FEATURE_FLAGS[number];

export interface FeatureRolloutState {
  feature: SandealFeatureFlag;
  /**
   * The operator-visible configuration, intentionally redacted to INVALID when
   * the environment value is not an accepted rollout mode. Feature flags must
   * never become an accidental environment-value disclosure channel.
   */
  configuredValue: FeatureRolloutMode | 'INVALID' | null;
  mode: FeatureRolloutMode;
  defaultMode: FeatureRolloutMode;
  /** Safe value actually used by the implementation. */
  effectiveMode: FeatureRolloutMode;
  effectiveModeSource: 'ENVIRONMENT_OVERRIDE' | 'SAFE_DEFAULT' | 'INVALID_CONFIGURATION_FALLBACK';
  rolloutCohort: string;
  /** Why the complete implementation is not active, or null when ACTIVE. */
  inactiveReason: string | null;
  configured: boolean;
  valid: boolean;
  reasonCode?: 'FEATURE_ROLLOUT_INVALID_VALUE';
}

export interface WorkerPoolRolloutState {
  configuredMode: FeatureRolloutMode;
  effectiveMode: FeatureRolloutMode;
  effectiveModeSource: 'ENVIRONMENT_OVERRIDE' | 'SAFE_DEFAULT' | 'INVALID_CONFIGURATION_FALLBACK';
  configured: boolean;
  valid: boolean;
  implementationActive: boolean;
  rolloutCohort: string;
  disabledReason:
    | 'WORKER_POOL_ROLLOUT_OFF'
    | 'WORKER_POOL_OBSERVATION_ONLY'
    | 'WORKER_POOL_INVALID_CONFIGURATION'
    | null;
  activationControl: 'WORKER_CONTINUOUS_POOL_V2=ACTIVE';
}

export interface WorkerCriticalSchedulingRolloutState {
  configuredMode: FeatureRolloutMode;
  effectiveMode: FeatureRolloutMode;
  effectiveModeSource: 'ENVIRONMENT_OVERRIDE' | 'SAFE_DEFAULT' | 'INVALID_CONFIGURATION_FALLBACK';
  configured: boolean;
  valid: boolean;
  implementationActive: boolean;
  rolloutCohort: string;
  disabledReason:
    | 'WORKER_CRITICAL_SCHEDULING_OFF'
    | 'WORKER_CRITICAL_SCHEDULING_OBSERVATION_ONLY'
    | 'WORKER_CRITICAL_SCHEDULING_INVALID_CONFIGURATION'
    | null;
  activationControl: 'WORKER_CRITICAL_SCHEDULING_V3=ACTIVE';
}

const DEFAULT_MODES: Readonly<Record<SandealFeatureFlag, FeatureRolloutMode>> = {
  RUNTIME_RECOVERY_V2: 'SHADOW',
  RECOVERY_CANARY: 'OFF',
  WORKER_CONTINUOUS_POOL_V2: 'ACTIVE',
  WORKER_CRITICAL_SCHEDULING_V3: 'SHADOW',
  SLO_RUNNABLE_AT_V2: 'SHADOW',
  PRODUCT_RECHECK_V2: 'SHADOW',
  PUBLICATION_EVIDENCE_V2: 'SHADOW',
  ACCESSTRADE_LIVE_READINESS_PROBE: 'OFF',
  AI_CLOUD_FALLBACK: 'OFF',
  AI_LOCAL_FALLBACK: 'OFF',
  OPERATOR_ALERTING: 'OFF',
  SMART_CATEGORIZATION_V2: 'SHADOW',
  MONGO_BULK_WRITE: 'OFF',
  MULTI_AFFILIATE_OFFER: 'SHADOW',
  PROGRAMMATIC_SEO_V2: 'SHADOW',
};

function assertServerRuntime(): void {
  if (typeof window !== 'undefined') throw new Error('FEATURE_ROLLOUT_SERVER_ONLY');
}

function isRolloutMode(value: string): value is FeatureRolloutMode {
  return (FEATURE_ROLLOUT_MODES as readonly string[]).includes(value);
}

function inactiveReason(
  effectiveMode: FeatureRolloutMode,
  valid: boolean,
): string | null {
  if (!valid) return 'FEATURE_ROLLOUT_INVALID_VALUE';
  if (effectiveMode === 'ACTIVE') return null;
  if (effectiveMode === 'OFF') return 'FEATURE_ROLLOUT_OFF';
  return `FEATURE_ROLLOUT_${effectiveMode}_ONLY`;
}

export function getFeatureRolloutState(
  feature: SandealFeatureFlag,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FeatureRolloutState {
  assertServerRuntime();
  const defaultMode = DEFAULT_MODES[feature];
  const configuredValue = environment[feature];
  if (configuredValue === undefined || configuredValue.trim() === '') {
    return {
      feature,
      configuredValue: null,
      mode: defaultMode,
      defaultMode,
      effectiveMode: defaultMode,
      effectiveModeSource: 'SAFE_DEFAULT',
      rolloutCohort: `${feature}:${defaultMode}`,
      inactiveReason: inactiveReason(defaultMode, true),
      configured: false,
      valid: true,
    };
  }
  const normalized = configuredValue.trim().toUpperCase();
  if (!isRolloutMode(normalized)) {
    return {
      feature,
      configuredValue: 'INVALID',
      mode: defaultMode,
      defaultMode,
      effectiveMode: 'OFF',
      effectiveModeSource: 'INVALID_CONFIGURATION_FALLBACK',
      rolloutCohort: `${feature}:OFF`,
      inactiveReason: inactiveReason('OFF', false),
      configured: true,
      valid: false,
      reasonCode: 'FEATURE_ROLLOUT_INVALID_VALUE',
    };
  }
  return {
    feature,
    configuredValue: normalized,
    mode: normalized,
    defaultMode,
    effectiveMode: normalized,
    effectiveModeSource: 'ENVIRONMENT_OVERRIDE',
    rolloutCohort: `${feature}:${normalized}`,
    inactiveReason: inactiveReason(normalized, true),
    configured: true,
    valid: true,
  };
}

export function listFeatureRolloutStates(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FeatureRolloutState[] {
  return SANDEAL_FEATURE_FLAGS.map(feature => getFeatureRolloutState(feature, environment));
}

export function isFeatureActive(
  feature: SandealFeatureFlag,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return getFeatureRolloutState(feature, environment).mode === 'ACTIVE';
}

export function isContinuousWorkerPoolEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const state = getFeatureRolloutState('WORKER_CONTINUOUS_POOL_V2', environment);
  return state.valid && state.mode === 'ACTIVE';
}

export function isCriticalWorkerSchedulingEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const state = getFeatureRolloutState('WORKER_CRITICAL_SCHEDULING_V3', environment);
  return state.valid && state.mode === 'ACTIVE';
}

export function getWorkerPoolRolloutState(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkerPoolRolloutState {
  const state = getFeatureRolloutState('WORKER_CONTINUOUS_POOL_V2', environment);
  const effectiveMode = state.valid ? state.mode : 'OFF';
  const implementationActive = state.valid && state.mode === 'ACTIVE';
  return {
    configuredMode: state.mode,
    effectiveMode,
    effectiveModeSource: !state.valid
      ? 'INVALID_CONFIGURATION_FALLBACK'
      : state.configured ? 'ENVIRONMENT_OVERRIDE' : 'SAFE_DEFAULT',
    configured: state.configured,
    valid: state.valid,
    implementationActive,
    rolloutCohort: `WORKER_CONTINUOUS_POOL_V2:${effectiveMode}`,
    disabledReason: !state.valid
      ? 'WORKER_POOL_INVALID_CONFIGURATION'
      : implementationActive
        ? null
        : state.mode === 'OFF'
          ? 'WORKER_POOL_ROLLOUT_OFF'
          : 'WORKER_POOL_OBSERVATION_ONLY',
    activationControl: 'WORKER_CONTINUOUS_POOL_V2=ACTIVE',
  };
}

export function getWorkerCriticalSchedulingRolloutState(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkerCriticalSchedulingRolloutState {
  const state = getFeatureRolloutState('WORKER_CRITICAL_SCHEDULING_V3', environment);
  const effectiveMode = state.valid ? state.mode : 'OFF';
  const implementationActive = state.valid && state.mode === 'ACTIVE';
  return {
    configuredMode: state.mode,
    effectiveMode,
    effectiveModeSource: !state.valid
      ? 'INVALID_CONFIGURATION_FALLBACK'
      : state.configured ? 'ENVIRONMENT_OVERRIDE' : 'SAFE_DEFAULT',
    configured: state.configured,
    valid: state.valid,
    implementationActive,
    rolloutCohort: `WORKER_CRITICAL_SCHEDULING_V3:${effectiveMode}`,
    disabledReason: !state.valid
      ? 'WORKER_CRITICAL_SCHEDULING_INVALID_CONFIGURATION'
      : implementationActive
        ? null
        : state.mode === 'OFF'
          ? 'WORKER_CRITICAL_SCHEDULING_OFF'
          : 'WORKER_CRITICAL_SCHEDULING_OBSERVATION_ONLY',
    activationControl: 'WORKER_CRITICAL_SCHEDULING_V3=ACTIVE',
  };
}
