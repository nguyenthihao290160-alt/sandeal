import type { SafeCredential, StoredCredential } from '@/lib/types/tokenVault';

export type CredentialReadinessState = 'stored' | 'valid' | 'generation_ready' | 'cooldown' | 'quota_limited' | 'invalid' | 'disabled' | 'missing_permission' | 'unknown';

export interface CredentialTruth {
  id: string;
  maskedIdentifier: string;
  state: CredentialReadinessState;
  stored: boolean;
  valid: boolean;
  generationReady: boolean;
  priority: number;
  preferredModel: string | null;
  projectLabel: string | null;
  quotaGroup: string | null;
  cooldownUntil: string | null;
  lastCheckedAt: string | null;
  errorCategory: string | null;
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null; }
function priority(value: unknown): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.max(0, Math.min(10_000, parsed)) : 100; }

export function getCredentialTruth(credential: Pick<SafeCredential | StoredCredential, 'id' | 'maskedValue' | 'status' | 'role' | 'metadata' | 'lastCheckedAt' | 'lastError'>, now = Date.now()): CredentialTruth {
  const metadata = credential.metadata || {};
  const generationStatus = text(metadata.generationStatus) || 'unchecked';
  const cooldownUntil = text(metadata.cooldownUntil);
  const quotaUntil = text(metadata.quotaExhaustedUntil);
  const disabled = credential.role === 'disabled' || credential.status === 'disabled' || generationStatus === 'disabled';
  const cooldown = Boolean(cooldownUntil && Date.parse(cooldownUntil) > now);
  const quota = generationStatus === 'quota_exhausted' || Boolean(quotaUntil && Date.parse(quotaUntil) > now);
  const valid = credential.status === 'valid';
  const generationReady = valid && generationStatus === 'available' && !cooldown && !quota && !disabled;
  const state: CredentialReadinessState = disabled ? 'disabled'
    : credential.status === 'invalid' || generationStatus === 'invalid' ? 'invalid'
      : credential.status === 'missing_permission' || generationStatus === 'missing_permission' ? 'missing_permission'
        : quota ? 'quota_limited' : cooldown ? 'cooldown' : generationReady ? 'generation_ready' : valid ? 'valid'
          : credential.maskedValue ? 'stored' : 'unknown';
  return {
    id: credential.id, maskedIdentifier: credential.maskedValue, state, stored: Boolean(credential.maskedValue), valid, generationReady,
    priority: priority(metadata.priority), preferredModel: text(metadata.preferredModel), projectLabel: text(metadata.projectAlias || metadata.projectLabel),
    quotaGroup: text(metadata.quotaGroupId), cooldownUntil, lastCheckedAt: credential.lastCheckedAt || null,
    errorCategory: text(metadata.lastErrorCode || credential.lastError),
  };
}

export function compareCredentialTruth(left: { id: string; truth: CredentialTruth }, right: { id: string; truth: CredentialTruth }): number {
  return left.truth.priority - right.truth.priority || left.id.localeCompare(right.id);
}
