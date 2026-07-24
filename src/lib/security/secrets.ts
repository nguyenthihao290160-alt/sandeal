// ===========================================
// Secret Handling — Encryption, Decryption, Masking
// ===========================================
// Server-side only. Never import from client components.
// Uses Node.js crypto with AES-256-GCM.
// New values fail closed when TOKEN_VAULT_SECRET_KEY is unavailable.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import type { StoredCredential, SafeCredential } from '../types/tokenVault';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT = 'sandeal-token-vault-salt-v1';

// ---- Secret Key Management ----

function getEncryptionKey(): Buffer | null {
  const envKey = process.env.TOKEN_VAULT_SECRET_KEY;
  if (!envKey || envKey === 'change_me_to_a_long_random_secret' || envKey.length < 16) {
    return null;
  }
  // Derive a 32-byte key from the env secret using scrypt
  return scryptSync(envKey, SALT, 32);
}

// ---- Encryption ----

/**
 * Encrypt a secret value.
 * Uses AES-256-GCM if TOKEN_VAULT_SECRET_KEY is set.
 * Refuses to persist when the encryption key is unavailable.
 */
export function encryptSecret(value: string): string {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('Token Vault encryption is unavailable. Configure TOKEN_VAULT_SECRET_KEY before storing credentials.');
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: enc:<iv>:<tag>:<encrypted> (all hex)
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a secret value.
 * Handles both AES-256-GCM encrypted values and base64 fallback.
 */
export function decryptSecret(encrypted: string): string {
  // Handle base64 fallback
  if (encrypted.startsWith('b64:')) {
    return Buffer.from(encrypted.slice(4), 'base64').toString('utf-8');
  }

  // Handle AES-256-GCM
  if (!encrypted.startsWith('enc:')) {
    // Legacy plain value — should not happen but handle gracefully
    return encrypted;
  }

  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      'Không thể giải mã token: TOKEN_VAULT_SECRET_KEY chưa được cấu hình. ' +
      'Token này đã được mã hoá bằng AES nhưng không tìm thấy khoá giải mã.'
    );
  }

  const parts = encrypted.slice(4).split(':');
  if (parts.length !== 3) {
    throw new Error('Dữ liệu mã hoá không hợp lệ.');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encryptedData = Buffer.from(parts[2], 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

  return decrypted.toString('utf-8');
}

// ---- Masking ----

/**
 * Mask a secret for safe frontend display.
 * Shows only the last 4 characters. Prefixes can reveal provider/key families
 * and are not needed by the browser.
 * 
 * Examples:
 * - "AIzaSyABCDEF123456" → "AIza****3456"
 * - "EAABwzLixnjYBO..." → "EAAB****YBO."
 * - Short values → "****"
 */
export function maskSecret(value: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '****';
  const suffix = trimmed.slice(-4);
  return `****${suffix}`;
}

// ---- Safe Projection ----

const SAFE_CREDENTIAL_METADATA_KEYS = new Set([
  'provider', 'priority', 'projectAlias', 'projectLabel', 'quotaGroupId',
  'billingMode', 'keyType', 'supportedModels', 'supportedGenerateContentModels',
  'preferredModel', 'testedModel', 'lightTestStatus', 'generationStatus',
  'generationReady', 'generationReadinessReason', 'freePolicyEligible',
  'adapterReady', 'runtimeRouteReady', 'diagnosticCategory', 'retryable',
  'providerHttpStatus', 'discoveredModelCount', 'lastCheckedAt',
  'lastLightTestAt', 'lastGenerationTestAt', 'generationVerifiedAt',
  'lastGenerationSucceededAt', 'lastSuccessfulRequestAt', 'lastFailureAt',
  'lastErrorCode', 'errorCategory', 'failureStreak', 'cooldownUntil',
  'nextProbeAt', 'quotaExhaustedUntil', 'requestsTodayEstimated',
  'inputTokensTodayEstimated', 'outputTokensTodayEstimated', 'healthScore',
]);

function safeCredentialMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_CREDENTIAL_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      safe[key] = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]').slice(0, 200);
    } else if (typeof value === 'boolean') {
      safe[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[key] = value.slice(0, 100).map(entry => String(entry).slice(0, 160));
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

/**
 * Strip sensitive fields from a StoredCredential.
 * Returns a SafeCredential that is safe for frontend/API responses.
 * NEVER includes encryptedValue.
 */
export function toSafeCredential(stored: StoredCredential): SafeCredential {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { encryptedValue, lastError, ...safe } = stored;
  const safeGeminiCategories = new Set([
    'INVALID_KEY', 'PERMISSION_DENIED', 'QUOTA_EXCEEDED', 'RATE_LIMITED',
    'MODEL_NOT_AVAILABLE', 'REGION_RESTRICTED', 'NETWORK_TIMEOUT',
    'PROVIDER_UNAVAILABLE', 'TRANSIENT_ERROR', 'UNKNOWN_PROVIDER_ERROR',
  ]);
  const category = typeof stored.metadata?.errorCategory === 'string'
    && safeGeminiCategories.has(stored.metadata.errorCategory)
    ? stored.metadata.errorCategory
    : undefined;
  return {
    ...safe,
    permissions: Array.isArray(safe.permissions) ? safe.permissions.slice(0, 100).map(value => String(value).slice(0, 160)) : undefined,
    metadata: safeCredentialMetadata(stored.metadata),
    lastError: category || (lastError ? 'PROVIDER_CHECK_FAILED' : undefined),
  };
}

/**
 * Strip sensitive fields from an array of StoredCredentials.
 */
export function toSafeCredentials(stored: StoredCredential[]): SafeCredential[] {
  return stored.map(toSafeCredential);
}
