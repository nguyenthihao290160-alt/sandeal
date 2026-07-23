import type { SafeCredential, StoredCredential } from '@/lib/types/tokenVault';

export type CredentialReadinessState = 'stored' | 'valid' | 'generation_ready' | 'cooldown' | 'quota_limited' | 'invalid' | 'disabled' | 'missing_permission' | 'unknown';
export type CredentialReadinessReason = 'ready' | 'not_applicable' | 'credential_not_checked' | 'credential_not_valid'
  | 'generation_not_verified' | 'generation_temporarily_unavailable' | 'cooldown_active' | 'quota_limited'
  | 'billing_not_confirmed' | 'quota_group_missing' | 'model_not_verified'
  | 'invalid' | 'disabled' | 'missing_permission' | 'unknown';

export interface CredentialTruth {
  id: string;
  maskedIdentifier: string;
  state: CredentialReadinessState;
  stored: boolean;
  valid: boolean;
  generationReady: boolean;
  reasonCode: CredentialReadinessReason;
  priority: number;
  preferredModel: string | null;
  projectLabel: string | null;
  quotaGroup: string | null;
  cooldownUntil: string | null;
  lastCheckedAt: string | null;
  errorCategory: string | null;
  testedModel: string | null;
  httpStatus: number | null;
  retryable: boolean;
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null; }
function priority(value: unknown): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.max(0, Math.min(10_000, parsed)) : 100; }

export function getCredentialTruth(credential: Pick<SafeCredential | StoredCredential, 'id' | 'platform' | 'maskedValue' | 'status' | 'role' | 'metadata' | 'lastCheckedAt' | 'lastError'>, now = Date.now()): CredentialTruth {
  const metadata = credential.metadata || {};
  const generationStatus = text(metadata.generationStatus) || 'unchecked';
  const cooldownUntil = text(metadata.cooldownUntil);
  const quotaUntil = text(metadata.quotaExhaustedUntil);
  const quotaGroup = text(metadata.quotaGroupId);
  const preferredModel = text(metadata.preferredModel);
  const supportedModels = Array.isArray(metadata.supportedModels) ? metadata.supportedModels.map(String).filter(Boolean) : [];
  const generationVerifiedAt = text(metadata.generationVerifiedAt || metadata.lastSuccessfulRequestAt);
  const billingReady = metadata.billingMode === 'free_confirmed';
  const modelReady = supportedModels.length > 0;
  const disabled = credential.role === 'disabled' || credential.status === 'disabled' || generationStatus === 'disabled';
  const cooldown = Boolean(cooldownUntil && Date.parse(cooldownUntil) > now);
  const quota = generationStatus === 'quota_exhausted' || Boolean(quotaUntil && Date.parse(quotaUntil) > now);
  const valid = credential.status === 'valid';
  const generationReady = credential.platform === 'gemini' && valid && generationStatus === 'available'
    && Boolean(generationVerifiedAt) && billingReady && Boolean(quotaGroup) && modelReady && !cooldown && !quota && !disabled;
  const state: CredentialReadinessState = disabled ? 'disabled'
    : credential.status === 'invalid' || generationStatus === 'invalid' ? 'invalid'
      : credential.status === 'missing_permission' || generationStatus === 'missing_permission' ? 'missing_permission'
          : quota ? 'quota_limited' : cooldown ? 'cooldown' : generationReady ? 'generation_ready' : valid ? 'valid'
          : credential.maskedValue ? 'stored' : 'unknown';
  const reasonCode: CredentialReadinessReason = credential.platform !== 'gemini' ? 'not_applicable'
    : disabled ? 'disabled'
      : credential.status === 'invalid' || generationStatus === 'invalid' ? 'invalid'
        : credential.status === 'missing_permission' || generationStatus === 'missing_permission' ? 'missing_permission'
          : quota ? 'quota_limited' : cooldown ? 'cooldown_active' : generationReady ? 'ready'
            : credential.status === 'unchecked' ? 'credential_not_checked'
              : !valid ? 'credential_not_valid'
                : generationStatus === 'unchecked' || !generationVerifiedAt ? 'generation_not_verified'
                  : ['rate_limited', 'cooldown', 'transient_error'].includes(generationStatus) ? 'generation_temporarily_unavailable'
                    : !billingReady ? 'billing_not_confirmed'
                      : !quotaGroup ? 'quota_group_missing'
                        : !modelReady ? 'model_not_verified'
                          : 'unknown';
  return {
    id: credential.id, maskedIdentifier: credential.maskedValue, state, stored: Boolean(credential.maskedValue), valid, generationReady, reasonCode,
    priority: priority(metadata.priority), preferredModel, projectLabel: text(metadata.projectAlias || metadata.projectLabel),
    quotaGroup, cooldownUntil, lastCheckedAt: credential.lastCheckedAt || null,
    errorCategory: text(metadata.errorCategory || metadata.lastErrorCode || credential.lastError),
    testedModel: text(metadata.testedModel || metadata.preferredModel),
    httpStatus: Number.isInteger(Number(metadata.providerHttpStatus)) ? Number(metadata.providerHttpStatus) : null,
    retryable: metadata.retryable === true,
  };
}

export function compareCredentialTruth(left: { id: string; truth: CredentialTruth }, right: { id: string; truth: CredentialTruth }): number {
  return left.truth.priority - right.truth.priority || left.id.localeCompare(right.id);
}
