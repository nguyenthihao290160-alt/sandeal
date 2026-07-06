// ===========================================
// Token Vault Storage
// ===========================================

import type { StoredToken, SafeToken, TokenPlatform, TokenCredentialType, TokenLabel, TokenStatus } from '../types';
import { readCollection, writeCollection, generateId } from './adapter';
import { maskToken } from '../tokenMask';

const COLLECTION = 'tokens';

/** Get all tokens — safe version for frontend (no raw values) */
export async function getAllTokensSafe(): Promise<SafeToken[]> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  return tokens.map(toSafeToken);
}

/** Get all tokens — full version for server-side use only */
export async function getAllTokensFull(): Promise<StoredToken[]> {
  return readCollection<StoredToken>(COLLECTION);
}

/** Get token by ID — server-side only */
export async function getTokenById(id: string): Promise<StoredToken | null> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  return tokens.find(t => t.id === id) ?? null;
}

/** Get primary token for a platform + credential type */
export async function getPrimaryToken(platform: TokenPlatform, credentialType: TokenCredentialType): Promise<StoredToken | null> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  return tokens.find(t => t.platform === platform && t.credentialType === credentialType && t.label === 'primary') ?? null;
}

/** Get all tokens for a platform */
export async function getTokensByPlatform(platform: TokenPlatform): Promise<SafeToken[]> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  return tokens.filter(t => t.platform === platform).map(toSafeToken);
}

/** Save a new token */
export async function saveToken(data: {
  platform: TokenPlatform;
  credentialType: TokenCredentialType;
  value: string;
  label?: TokenLabel;
}): Promise<SafeToken> {
  const tokens = await readCollection<StoredToken>(COLLECTION);

  const token: StoredToken = {
    id: generateId(),
    platform: data.platform,
    credentialType: data.credentialType,
    value: data.value,
    maskedValue: maskToken(data.value),
    label: data.label || 'primary',
    status: 'unchecked',
    createdAt: new Date().toISOString(),
  };

  tokens.push(token);
  await writeCollection(COLLECTION, tokens);
  return toSafeToken(token);
}

/** Update token status after testing */
export async function updateTokenStatus(id: string, status: TokenStatus, statusMessage?: string): Promise<SafeToken | null> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  const index = tokens.findIndex(t => t.id === id);
  if (index === -1) return null;

  tokens[index].status = status;
  tokens[index].statusMessage = statusMessage;
  tokens[index].lastCheckedAt = new Date().toISOString();
  await writeCollection(COLLECTION, tokens);
  return toSafeToken(tokens[index]);
}

/** Set token as primary (demotes other tokens of same platform+type) */
export async function setTokenPrimary(id: string): Promise<SafeToken | null> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  const target = tokens.find(t => t.id === id);
  if (!target) return null;

  for (const t of tokens) {
    if (t.platform === target.platform && t.credentialType === target.credentialType) {
      t.label = t.id === id ? 'primary' : (t.label === 'primary' ? 'backup' : t.label);
    }
  }

  await writeCollection(COLLECTION, tokens);
  return toSafeToken(target);
}

/** Disable a token */
export async function disableToken(id: string): Promise<SafeToken | null> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  const index = tokens.findIndex(t => t.id === id);
  if (index === -1) return null;

  tokens[index].label = 'disabled';
  await writeCollection(COLLECTION, tokens);
  return toSafeToken(tokens[index]);
}

/** Delete a token */
export async function deleteToken(id: string): Promise<boolean> {
  const tokens = await readCollection<StoredToken>(COLLECTION);
  const filtered = tokens.filter(t => t.id !== id);
  if (filtered.length === tokens.length) return false;
  await writeCollection(COLLECTION, filtered);
  return true;
}

/** Convert StoredToken to SafeToken (removes raw value) */
function toSafeToken(token: StoredToken): SafeToken {
  const { value: _value, ...safe } = token;
  void _value; // explicitly unused
  return safe;
}
