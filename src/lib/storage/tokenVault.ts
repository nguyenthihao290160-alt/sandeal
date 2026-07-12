// ===========================================
// Token Vault Storage — Server-side only
// ===========================================
// Uses existing storage adapter for JSON file persistence.
// Collection: token-vault (.data/token-vault.json)
// NEVER import from client components.

import type {
  StoredCredential,
  SafeCredential,
  CreateCredentialInput,
  CredentialFilters,
  CredentialPlatform,
  VaultStats,
  CredentialGroup,
} from '../types/tokenVault';
import { PLATFORM_CONFIG } from '../types/tokenVault';
import {
  readCollection,
  writeCollection,
  findById,
  insertOne,
  updateOne,
  deleteOne,
  generateId,
} from './adapter';
import { encryptSecret, decryptSecret, maskSecret, toSafeCredential, toSafeCredentials } from '../security/secrets';

const COLLECTION = 'token-vault';

function initialMetadata(input: CreateCredentialInput): Record<string, unknown> | undefined {
  if (input.platform !== 'gemini') return input.metadata;
  
  const userMetadata = (input.metadata || {}) as Record<string, unknown>;
  const {
    billingMode, keyType, supportedModels, lightTestStatus,
    generationStatus, failureStreak, requestsTodayEstimated,
    inputTokensTodayEstimated, outputTokensTodayEstimated, healthScore,
    ...safeMetadata
  } = userMetadata;

  return {
    ...safeMetadata,
    billingMode: 'unknown', keyType: 'unknown', supportedModels: [], lightTestStatus: 'unchecked',
    generationStatus: 'unchecked', failureStreak: 0, requestsTodayEstimated: 0,
    inputTokensTodayEstimated: 0, outputTokensTodayEstimated: 0, healthScore: 50,
  };
}

// ---- List & Filter ----

/**
 * List credentials with optional filters.
 * Returns SafeCredential[] — never returns encrypted values.
 */
export async function listCredentials(filters?: CredentialFilters): Promise<SafeCredential[]> {
  let creds = await readCollection<StoredCredential>(COLLECTION);

  if (filters) {
    if (filters.platform) {
      creds = creds.filter(c => c.platform === filters.platform);
    }
    if (filters.credentialType) {
      creds = creds.filter(c => c.credentialType === filters.credentialType);
    }
    if (filters.status) {
      creds = creds.filter(c => c.status === filters.status);
    }
    if (filters.role) {
      creds = creds.filter(c => c.role === filters.role);
    }
  }

  // Sort: primary first, then by updatedAt desc
  creds.sort((a, b) => {
    if (a.role === 'primary' && b.role !== 'primary') return -1;
    if (b.role === 'primary' && a.role !== 'primary') return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return toSafeCredentials(creds);
}

/**
 * List credentials grouped by platform for UI display.
 */
export async function listCredentialsGrouped(): Promise<CredentialGroup[]> {
  const creds = await listCredentials();

  const groupMap = new Map<CredentialPlatform, SafeCredential[]>();
  for (const cred of creds) {
    const existing = groupMap.get(cred.platform) || [];
    existing.push(cred);
    groupMap.set(cred.platform, existing);
  }

  // Include all platforms even if empty
  const groups: CredentialGroup[] = [];
  const platforms = Object.keys(PLATFORM_CONFIG) as CredentialPlatform[];

  for (const platform of platforms) {
    const config = PLATFORM_CONFIG[platform];
    groups.push({
      platform,
      label: config.label,
      icon: config.icon,
      credentials: groupMap.get(platform) || [],
    });
  }

  return groups;
}

// ---- Get by ID ----

/**
 * Get credential by ID (server-side full object).
 */
export async function getCredentialById(id: string): Promise<StoredCredential | null> {
  return findById<StoredCredential>(COLLECTION, id);
}

/**
 * Get credential by ID (safe projection for API response).
 */
export async function getSafeCredentialById(id: string): Promise<SafeCredential | null> {
  const cred = await getCredentialById(id);
  return cred ? toSafeCredential(cred) : null;
}

// ---- Create ----

/**
 * Create a new credential.
 * Encrypts the raw value, generates masked value,
 * and auto-assigns role if not specified.
 */
export async function createCredential(input: CreateCredentialInput): Promise<SafeCredential> {
  const now = new Date().toISOString();

  // Determine role: if no primary exists for this platform, make it primary
  let role = input.role || 'backup';
  const existing = await readCollection<StoredCredential>(COLLECTION);
  const hasPrimary = existing.some(
    c => c.platform === input.platform && c.role === 'primary'
  );
  if (!hasPrimary && role !== 'disabled') {
    role = 'primary';
  }

  const credential: StoredCredential = {
    id: generateId(),
    platform: input.platform,
    credentialType: input.credentialType,
    role,
    label: input.label || `${PLATFORM_CONFIG[input.platform]?.label || input.platform} ${input.credentialType}`,
    encryptedValue: encryptSecret(input.value),
    maskedValue: maskSecret(input.value),
    status: 'unchecked',
    permissions: undefined,
    metadata: initialMetadata(input),
    lastCheckedAt: undefined,
    lastError: undefined,
    createdAt: now,
    updatedAt: now,
  };

  // If this is primary, demote existing primary for same platform
  if (role === 'primary') {
    await demotePrimaryForPlatform(input.platform, credential.id);
  }

  await insertOne<StoredCredential>(COLLECTION, credential);
  return toSafeCredential(credential);
}

// ---- Update ----

/**
 * Update credential fields (partial update).
 * Never updates encryptedValue through this method.
 */
export async function updateCredential(
  id: string,
  patch: Partial<Omit<StoredCredential, 'id' | 'encryptedValue' | 'createdAt'>>
): Promise<SafeCredential | null> {
  const updated = await updateOne<StoredCredential>(COLLECTION, id, patch as Partial<StoredCredential>);
  return updated ? toSafeCredential(updated) : null;
}

/**
 * Replace the raw value of an existing credential.
 * Re-encrypts and re-masks.
 */
export async function replaceCredentialValue(id: string, newValue: string): Promise<SafeCredential | null> {
  const current = await getCredentialById(id);
  const updated = await updateOne<StoredCredential>(COLLECTION, id, {
    encryptedValue: encryptSecret(newValue),
    maskedValue: maskSecret(newValue),
    status: 'unchecked',
    lastCheckedAt: undefined,
    lastError: undefined,
    metadata: current?.platform === 'gemini' ? { ...current.metadata, lightTestStatus: 'unchecked', generationStatus: 'unchecked', failureStreak: 0 } : current?.metadata,
  } as Partial<StoredCredential>);
  return updated ? toSafeCredential(updated) : null;
}

// ---- Delete ----

/**
 * Delete a credential by ID.
 */
export async function deleteCredential(id: string): Promise<boolean> {
  return deleteOne<StoredCredential>(COLLECTION, id);
}

// ---- Disable ----

/**
 * Disable a credential (preserves encrypted value).
 */
export async function disableCredential(id: string): Promise<SafeCredential | null> {
  return updateCredential(id, {
    role: 'disabled',
    status: 'disabled',
  });
}

// ---- Primary Management ----

/**
 * Set a credential as primary for its platform.
 * Demotes existing primary for the same platform to backup.
 */
export async function setPrimaryCredential(id: string): Promise<SafeCredential | null> {
  const cred = await getCredentialById(id);
  if (!cred) return null;

  // Demote existing primary
  await demotePrimaryForPlatform(cred.platform, id);

  // Promote this one
  return updateCredential(id, {
    role: 'primary',
    status: cred.status === 'disabled' ? 'unchecked' : cred.status,
  });
}

/**
 * Get the primary credential for a platform (safe projection).
 */
export async function getPrimaryCredential(platform: CredentialPlatform): Promise<SafeCredential | null> {
  const creds = await readCollection<StoredCredential>(COLLECTION);
  const primary = creds.find(c => c.platform === platform && c.role === 'primary');
  return primary ? toSafeCredential(primary) : null;
}

// ---- Raw Value Access (server-side only) ----

/**
 * Get the decrypted raw value of a credential.
 * SERVER-SIDE ONLY — never expose this to the frontend.
 */
export async function getRawCredentialValue(id: string): Promise<string | null> {
  const cred = await getCredentialById(id);
  if (!cred || !cred.encryptedValue) return null;
  try {
    return decryptSecret(cred.encryptedValue);
  } catch {
    return null;
  }
}

/**
 * Get the decrypted raw value of the primary credential for a platform.
 * SERVER-SIDE ONLY — never expose this to the frontend.
 */
export async function getRawPrimaryCredentialValue(platform: CredentialPlatform): Promise<string | null> {
  const creds = await readCollection<StoredCredential>(COLLECTION);
  const primary = creds.find(c => c.platform === platform && c.role === 'primary');
  if (!primary || !primary.encryptedValue) return null;
  try {
    return decryptSecret(primary.encryptedValue);
  } catch {
    return null;
  }
}

// ---- Stats ----

/**
 * Get vault statistics for health checks.
 * Never returns raw values.
 */
export async function getVaultStats(): Promise<VaultStats> {
  const creds = await readCollection<StoredCredential>(COLLECTION);

  const socialPlatforms: CredentialPlatform[] = ['facebook', 'instagram', 'threads', 'youtube', 'tiktok'];
  const affiliatePlatforms: CredentialPlatform[] = ['accesstrade', 'shopee', 'lazada'];

  const geminiCreds = creds.filter(c => c.platform === 'gemini');
  const geminiPrimary = geminiCreds.find(c => c.role === 'primary');
  const accessTradePrimary = creds.find(c => c.platform === 'accesstrade' && c.role === 'primary');

  const allCheckedDates = creds
    .filter(c => c.lastCheckedAt)
    .map(c => c.lastCheckedAt as string)
    .sort()
    .reverse();

  return {
    totalCredentials: creds.length,
    geminiKeysCount: geminiCreds.length,
    geminiPrimaryConfigured: !!geminiPrimary,
    accessTradeConfigured: !!accessTradePrimary,
    socialTokensCount: creds.filter(c => socialPlatforms.includes(c.platform)).length,
    affiliateKeysCount: creds.filter(c => affiliatePlatforms.includes(c.platform)).length,
    disabledCount: creds.filter(c => c.role === 'disabled' || c.status === 'disabled').length,
    errorCount: creds.filter(c => c.status === 'error' || c.status === 'invalid' || c.status === 'expired').length,
    lastCheckTime: allCheckedDates[0] || undefined,
  };
}

// ---- Helpers ----

/**
 * Demote the existing primary credential for a platform to backup.
 * Skips the credential with excludeId.
 */
async function demotePrimaryForPlatform(platform: CredentialPlatform, excludeId?: string): Promise<void> {
  const creds = await readCollection<StoredCredential>(COLLECTION);
  const primaries = creds.filter(
    c => c.platform === platform && c.role === 'primary' && c.id !== excludeId
  );

  for (const primary of primaries) {
    await updateOne<StoredCredential>(COLLECTION, primary.id, {
      role: 'backup',
    } as Partial<StoredCredential>);
  }
}
