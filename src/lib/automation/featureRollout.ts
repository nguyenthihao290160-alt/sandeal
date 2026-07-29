export const FEATURE_ROLLOUT_MODES = ['OFF', 'SHADOW', 'OBSERVE', 'CANARY', 'ACTIVE'] as const;

export type FeatureRolloutMode = typeof FEATURE_ROLLOUT_MODES[number];

export const SANDEAL_FEATURE_FLAGS = [
  'RUNTIME_RECOVERY_V2',
  'RECOVERY_CANARY',
  'WORKER_CONTINUOUS_POOL_V2',
  'SLO_RUNNABLE_AT_V2',
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
  mode: FeatureRolloutMode;
  defaultMode: FeatureRolloutMode;
  configured: boolean;
  valid: boolean;
  reasonCode?: 'FEATURE_ROLLOUT_INVALID_VALUE';
}

const DEFAULT_MODES: Readonly<Record<SandealFeatureFlag, FeatureRolloutMode>> = {
  RUNTIME_RECOVERY_V2: 'SHADOW',
  RECOVERY_CANARY: 'OFF',
  WORKER_CONTINUOUS_POOL_V2: 'OFF',
  SLO_RUNNABLE_AT_V2: 'SHADOW',
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

export function getFeatureRolloutState(
  feature: SandealFeatureFlag,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FeatureRolloutState {
  assertServerRuntime();
  const defaultMode = DEFAULT_MODES[feature];
  const configuredValue = environment[feature];
  if (configuredValue === undefined || configuredValue.trim() === '') {
    return { feature, mode: defaultMode, defaultMode, configured: false, valid: true };
  }
  const normalized = configuredValue.trim().toUpperCase();
  if (!isRolloutMode(normalized)) {
    return {
      feature,
      mode: defaultMode,
      defaultMode,
      configured: true,
      valid: false,
      reasonCode: 'FEATURE_ROLLOUT_INVALID_VALUE',
    };
  }
  return { feature, mode: normalized, defaultMode, configured: true, valid: true };
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
