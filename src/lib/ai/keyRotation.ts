// ===========================================
// Gemini Key Rotation — Preparation helper
// ===========================================
// Server-side only. No paid API calls.
// Manages Gemini key selection from Token Vault + env fallback.

import { readCollection } from '../storage/adapter';
import { decryptSecret } from '../security/secrets';
import { getServerConfig } from '../config';
import type { StoredCredential } from '../types/tokenVault';
import { updateOne } from '../storage/adapter';

const COLLECTION = 'token-vault';

/** Internal counter for round-robin key selection */
let roundRobinIndex = 0;

/**
 * List all active (non-disabled) Gemini keys.
 * Combines Token Vault credentials + env fallback keys.
 * Returns array of { id, key, source } objects.
 */
export async function listActiveGeminiKeys(): Promise<
  Array<{ id: string; key: string; source: 'vault' | 'env' }>
> {
  const keys: Array<{ id: string; key: string; source: 'vault' | 'env' }> = [];

  // 1. Token Vault keys
  const creds = await readCollection<StoredCredential>(COLLECTION);
  const geminiCreds = creds.filter(
    c =>
      c.platform === 'gemini' &&
      c.role !== 'disabled' &&
      c.status !== 'disabled' &&
      c.status !== 'invalid' &&
      c.status !== 'expired' &&
      c.encryptedValue
  );

  // Primary first
  geminiCreds.sort((a, b) => {
    if (a.role === 'primary' && b.role !== 'primary') return -1;
    if (b.role === 'primary' && a.role !== 'primary') return 1;
    return 0;
  });

  for (const cred of geminiCreds) {
    try {
      const rawKey = decryptSecret(cred.encryptedValue);
      if (rawKey && rawKey.length > 5) {
        keys.push({ id: cred.id, key: rawKey, source: 'vault' });
      }
    } catch {
      // Skip credentials that can't be decrypted
    }
  }

  // 2. Env fallback keys (only if not already in vault)
  const { geminiApiKeys } = getServerConfig();
  for (let i = 0; i < geminiApiKeys.length; i++) {
    const envKey = geminiApiKeys[i];
    // Check if this env key is already in vault (by comparing first+last 4 chars)
    const alreadyInVault = keys.some(k => {
      if (k.key.length < 8 || envKey.length < 8) return k.key === envKey;
      return k.key.slice(0, 4) === envKey.slice(0, 4) && k.key.slice(-4) === envKey.slice(-4);
    });
    if (!alreadyInVault) {
      keys.push({ id: `env-gemini-${i}`, key: envKey, source: 'env' });
    }
  }

  return keys;
}

/**
 * Get the primary Gemini key.
 * Vault primary first, then first env key.
 * Returns null if no key is available.
 */
export async function getPrimaryGeminiKey(): Promise<string | null> {
  const keys = await listActiveGeminiKeys();
  if (keys.length === 0) return null;
  return keys[0].key;
}

/**
 * Get the next Gemini key using round-robin.
 * Useful for distributing load across multiple keys.
 */
export async function getNextGeminiKey(): Promise<string | null> {
  const keys = await listActiveGeminiKeys();
  if (keys.length === 0) return null;
  const key = keys[roundRobinIndex % keys.length];
  roundRobinIndex = (roundRobinIndex + 1) % keys.length;
  return key.key;
}

/**
 * Mark a Gemini key as errored.
 * Only works for vault-stored keys (env keys can't be updated).
 */
export async function markGeminiKeyError(id: string, error: string): Promise<void> {
  if (id.startsWith('env-')) {
    // Can't update env keys — just log
    console.warn(`[Key Rotation] Gemini env key error: ${error.slice(0, 100)}`);
    return;
  }

  await updateOne<StoredCredential>(COLLECTION, id, {
    status: 'error',
    lastError: error.slice(0, 500),
    lastCheckedAt: new Date().toISOString(),
  } as Partial<StoredCredential>);
}
