import type {
  GeminiDiagnosticCategory,
  SafeCredential,
  StoredCredential,
} from '@/lib/types/tokenVault';

export type CredentialReadinessState = 'stored' | 'valid' | 'generation_ready' | 'cooldown' | 'quota_limited' | 'invalid' | 'disabled' | 'missing_permission' | 'unknown';
export type CredentialReadinessReason = 'ready' | 'not_applicable' | 'credential_not_checked' | 'credential_not_valid'
  | 'generation_not_verified' | 'generation_check_stale' | 'generation_temporarily_unavailable'
  | 'cooldown_active' | 'quota_limited' | 'free_policy_unverified' | 'billing_not_confirmed'
  | 'quota_group_missing' | 'model_not_verified' | 'model_not_available' | 'region_restricted'
  | 'provider_unavailable' | 'invalid' | 'disabled' | 'missing_permission' | 'unknown';

export type GeminiReadinessFailureClass =
  | 'permission'
  | 'authentication'
  | 'policy'
  | 'quota'
  | 'model'
  | 'adapter'
  | 'network'
  | 'routing'
  | 'unknown';

export interface GeminiReadinessDimensions {
  credentialPresent: boolean;
  credentialFormatAccepted: boolean;
  authenticationValid: boolean;
  modelDiscoveryAvailable: boolean;
  contentGenerationPermissionAvailable: boolean;
  selectedModelAvailable: boolean;
  quotaAvailable: boolean;
  freeOnlyPolicySatisfied: boolean;
  adapterHealthy: boolean;
  productionRouteSelected: boolean;
  endToEndMinimalGenerationPassed: boolean;
  productionReady: boolean;
}

export interface CredentialTruth {
  id: string;
  maskedIdentifier: string;
  state: CredentialReadinessState;
  stored: boolean;
  valid: boolean;
  /** Eligible for deterministic routing, but not necessarily the selected production route. */
  generationReady: boolean;
  productionReady: boolean;
  dimensions: GeminiReadinessDimensions;
  failureClass: GeminiReadinessFailureClass | null;
  selectedProvider: 'gemini' | null;
  routePolicy: 'FREE_ONLY' | null;
  reasonCode: CredentialReadinessReason;
  priority: number;
  preferredModel: string | null;
  testedModel: string | null;
  projectLabel: string | null;
  quotaGroup: string | null;
  cooldownUntil: string | null;
  lastCheckedAt: string | null;
  lastGenerationSucceededAt: string | null;
  diagnosticCategory: GeminiDiagnosticCategory | null;
  retryable: boolean;
  freePolicyEligible: boolean;
  adapterReady: boolean;
  errorCategory: string | null;
  httpStatus: number | null;
}

const DEFAULT_READINESS_MAX_AGE_MS = 24 * 60 * 60_000;
const MIN_READINESS_MAX_AGE_MS = 60_000;
const MAX_READINESS_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DIAGNOSTIC_CATEGORIES = new Set<GeminiDiagnosticCategory>([
  'READY',
  'FREE_POLICY_UNVERIFIED',
  'INVALID_KEY',
  'PERMISSION_DENIED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'MODEL_NOT_AVAILABLE',
  'REGION_RESTRICTED',
  'NETWORK_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'TRANSIENT_ERROR',
  'UNKNOWN_PROVIDER_ERROR',
]);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null;
}

function priority(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(0, Math.min(10_000, parsed)) : 100;
}

function diagnostic(value: unknown): GeminiDiagnosticCategory | null {
  const normalized = text(value) as GeminiDiagnosticCategory | null;
  return normalized && DIAGNOSTIC_CATEGORIES.has(normalized) ? normalized : null;
}

export function getGeminiReadinessMaxAgeMs(): number {
  const raw = process.env.GEMINI_READINESS_MAX_AGE_MS;
  if (!raw?.trim()) return DEFAULT_READINESS_MAX_AGE_MS;
  const configured = Number(raw);
  if (!Number.isFinite(configured)) return DEFAULT_READINESS_MAX_AGE_MS;
  return Math.max(MIN_READINESS_MAX_AGE_MS, Math.min(MAX_READINESS_MAX_AGE_MS, Math.floor(configured)));
}

export function getCredentialTruth(
  credential: Pick<SafeCredential | StoredCredential, 'id' | 'platform' | 'maskedValue' | 'status' | 'role' | 'metadata' | 'lastCheckedAt' | 'lastError'>,
  now = Date.now(),
): CredentialTruth {
  const metadata = credential.metadata || {};
  const generationStatus = text(metadata.generationStatus) || 'unchecked';
  const cooldownUntil = text(metadata.cooldownUntil);
  const quotaUntil = text(metadata.quotaExhaustedUntil);
  const quotaGroup = text(metadata.quotaGroupId);
  const preferredModel = text(metadata.preferredModel);
  const testedModel = text(metadata.testedModel) || preferredModel;
  const supportedModels = Array.isArray(metadata.supportedGenerateContentModels)
    ? metadata.supportedGenerateContentModels.map(String).filter(Boolean)
    : Array.isArray(metadata.supportedModels) ? metadata.supportedModels.map(String).filter(Boolean) : [];
  const lastGenerationSucceededAt = text(
    metadata.lastGenerationSucceededAt || metadata.generationVerifiedAt || metadata.lastSuccessfulRequestAt,
  );
  const successTimestamp = lastGenerationSucceededAt ? Date.parse(lastGenerationSucceededAt) : Number.NaN;
  const successAge = now - successTimestamp;
  const successFresh = Number.isFinite(successTimestamp)
    && successAge >= -5 * 60_000
    && successAge <= getGeminiReadinessMaxAgeMs();
  const explicitFreePolicy = metadata.freePolicyEligible === true;
  const legacyFreePolicy = metadata.freePolicyEligible === undefined && metadata.billingMode === 'free_confirmed';
  const freePolicyEligible = explicitFreePolicy || legacyFreePolicy;
  const modelReady = Boolean(testedModel && supportedModels.includes(testedModel));
  const legacyRouteProof = metadata.adapterReady === undefined
    && metadata.runtimeRouteReady === undefined
    && legacyFreePolicy
    && generationStatus === 'available'
    && successFresh;
  const adapterReady = metadata.adapterReady === true || legacyRouteProof;
  const runtimeRouteReady = metadata.runtimeRouteReady === true || legacyRouteProof;
  const disabled = credential.role === 'disabled' || credential.status === 'disabled' || generationStatus === 'disabled';
  const cooldown = Boolean(cooldownUntil && Date.parse(cooldownUntil) > now);
  const quota = generationStatus === 'quota_exhausted' || Boolean(quotaUntil && Date.parse(quotaUntil) > now);
  const valid = credential.status === 'valid';
  const generationReady = credential.platform === 'gemini'
    && valid
    && generationStatus === 'available'
    && successFresh
    && freePolicyEligible
    && Boolean(quotaGroup)
    && modelReady
    && adapterReady
    && runtimeRouteReady
    && !cooldown
    && !quota
    && !disabled;
  const modelDiscoveryAvailable = supportedModels.length > 0
    && (Number(metadata.discoveredModelCount || supportedModels.length) > 0);
  const productionRouteSelected = credential.role === 'primary' && runtimeRouteReady;
  const productionReady = generationReady && modelDiscoveryAvailable && productionRouteSelected;
  const category = diagnostic(metadata.diagnosticCategory || metadata.lastErrorCode);
  const state: CredentialReadinessState = disabled ? 'disabled'
    : credential.status === 'invalid' || generationStatus === 'invalid' ? 'invalid'
      : credential.status === 'missing_permission' || generationStatus === 'missing_permission' ? 'missing_permission'
        : quota ? 'quota_limited'
          : cooldown ? 'cooldown'
            : generationReady ? 'generation_ready'
              : valid ? 'valid'
                : credential.maskedValue ? 'stored' : 'unknown';

  const reasonCode: CredentialReadinessReason = credential.platform !== 'gemini' ? 'not_applicable'
    : disabled ? 'disabled'
      : credential.status === 'invalid' || generationStatus === 'invalid' || category === 'INVALID_KEY' ? 'invalid'
        : credential.status === 'missing_permission' || generationStatus === 'missing_permission' || category === 'PERMISSION_DENIED' ? 'missing_permission'
          : category === 'REGION_RESTRICTED' || generationStatus === 'region_restricted' ? 'region_restricted'
            : quota ? 'quota_limited'
              : cooldown ? 'cooldown_active'
                : generationReady ? 'ready'
                  : credential.status === 'unchecked' ? 'credential_not_checked'
                    : !valid ? 'credential_not_valid'
                      : category === 'MODEL_NOT_AVAILABLE' || generationStatus === 'model_unavailable' ? 'model_not_available'
                        : category === 'PROVIDER_UNAVAILABLE' || generationStatus === 'provider_unavailable' ? 'provider_unavailable'
                          : !lastGenerationSucceededAt || generationStatus === 'unchecked' ? 'generation_not_verified'
                            : !successFresh ? 'generation_check_stale'
                              : ['rate_limited', 'cooldown', 'transient_error'].includes(generationStatus) ? 'generation_temporarily_unavailable'
                                : !freePolicyEligible ? 'free_policy_unverified'
                                  : !quotaGroup ? 'quota_group_missing'
                                    : !modelReady ? 'model_not_verified'
                                      : !adapterReady ? 'provider_unavailable'
                                        : 'unknown';

  const dimensions: GeminiReadinessDimensions = {
    credentialPresent: Boolean(credential.maskedValue),
    credentialFormatAccepted: Boolean(credential.maskedValue) && credential.status !== 'invalid',
    authenticationValid: valid,
    modelDiscoveryAvailable,
    contentGenerationPermissionAvailable: generationStatus === 'available' && successFresh,
    selectedModelAvailable: modelReady,
    quotaAvailable: generationStatus === 'available' && successFresh && !quota,
    freeOnlyPolicySatisfied: freePolicyEligible,
    adapterHealthy: adapterReady,
    productionRouteSelected,
    endToEndMinimalGenerationPassed: successFresh,
    productionReady,
  };
  const failureClass: GeminiReadinessFailureClass | null = productionReady ? null
    : credential.status === 'invalid' || category === 'INVALID_KEY' || reasonCode === 'credential_not_valid' ? 'authentication'
      : credential.status === 'missing_permission' || category === 'PERMISSION_DENIED' || reasonCode === 'missing_permission' ? 'permission'
        : quota || category === 'QUOTA_EXCEEDED' || category === 'RATE_LIMITED' ? 'quota'
          : category === 'MODEL_NOT_AVAILABLE' || reasonCode === 'model_not_available' ? 'model'
            : category === 'NETWORK_TIMEOUT' || category === 'TRANSIENT_ERROR' ? 'network'
              : category === 'PROVIDER_UNAVAILABLE' ? 'adapter'
                : credential.status === 'unchecked' || !valid ? 'unknown'
                  : !freePolicyEligible || reasonCode === 'free_policy_unverified' ? 'policy'
                    : !modelReady || reasonCode === 'model_not_verified' ? 'model'
                      : !adapterReady ? 'adapter'
                        : !runtimeRouteReady || (generationReady && !productionRouteSelected) ? 'routing'
                          : 'unknown';

  return {
    id: credential.id,
    maskedIdentifier: credential.maskedValue,
    state,
    stored: Boolean(credential.maskedValue),
    valid,
    generationReady,
    productionReady,
    dimensions,
    failureClass,
    selectedProvider: credential.platform === 'gemini' ? 'gemini' : null,
    routePolicy: credential.platform === 'gemini' ? 'FREE_ONLY' : null,
    reasonCode,
    priority: priority(metadata.priority),
    preferredModel,
    testedModel,
    projectLabel: text(metadata.projectAlias || metadata.projectLabel),
    quotaGroup,
    cooldownUntil,
    lastCheckedAt: credential.lastCheckedAt || text(metadata.lastCheckedAt),
    lastGenerationSucceededAt,
    diagnosticCategory: category,
    retryable: metadata.retryable === true,
    freePolicyEligible,
    adapterReady,
    errorCategory: text(metadata.errorCategory || metadata.lastErrorCode || credential.lastError),
    httpStatus: Number.isInteger(Number(metadata.providerHttpStatus)) ? Number(metadata.providerHttpStatus) : null,
  };
}

export function compareCredentialTruth(left: { id: string; truth: CredentialTruth }, right: { id: string; truth: CredentialTruth }): number {
  return left.truth.priority - right.truth.priority || left.id.localeCompare(right.id);
}
