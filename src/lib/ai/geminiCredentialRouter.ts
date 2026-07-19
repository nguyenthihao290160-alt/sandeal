import { readCollection, updateOne } from '../storage/adapter';
import { decryptSecret } from '../security/secrets';
import type { GeminiCredentialMetadata, GeminiGenerationStatus, StoredCredential } from '../types/tokenVault';
import { getGeminiPoolState, quotaGroupAvailable, setGeminiPoolState, updateQuotaGroup } from './geminiQuotaGroupManager';
import { recordGeminiUsage } from './geminiUsageTracker';
import { getCredentialTruth } from './credentialTruth';

const COLLECTION = 'token-vault';
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);

export interface GeminiCredentialSelection { credentialId: string; quotaGroupId: string; supportedModels: string[]; preferredModel?: string; healthScore: number; primary: boolean; priority: number; }
export interface GeminiRequest { modelId: string; taskType: string; idempotencyKey: string; body: unknown; timeoutMs: number; inputTokenEstimate?: number; maxFailoverGroups?: number; }
export interface GeminiRequestResult { ok: boolean; status: number; data?: unknown; errorCode?: string; credentialId?: string; quotaGroupId?: string; }

function metadataOf(credential: StoredCredential): GeminiCredentialMetadata {
  const raw = credential.metadata || {};
  return {
    projectAlias: typeof raw.projectAlias === 'string' ? raw.projectAlias : undefined,
    quotaGroupId: typeof raw.quotaGroupId === 'string' ? raw.quotaGroupId : undefined,
    billingMode: raw.billingMode === 'free_confirmed' || raw.billingMode === 'paid' ? raw.billingMode : 'unknown',
    keyType: raw.keyType === 'auth' || raw.keyType === 'restricted_standard' || raw.keyType === 'standard' ? raw.keyType : 'unknown',
    supportedModels: Array.isArray(raw.supportedModels) ? raw.supportedModels.map(String) : [],
    preferredModel: typeof raw.preferredModel === 'string' ? raw.preferredModel : undefined,
    priority: Number.isInteger(Number(raw.priority)) ? Math.max(0, Math.min(10_000, Number(raw.priority))) : 100,
    lightTestStatus: raw.lightTestStatus === 'available' || raw.lightTestStatus === 'invalid' || raw.lightTestStatus === 'missing_permission' || raw.lightTestStatus === 'transient_error' ? raw.lightTestStatus : 'unchecked',
    generationStatus: isGenerationStatus(raw.generationStatus) ? raw.generationStatus : 'unchecked',
    lastLightTestAt: text(raw.lastLightTestAt), lastGenerationTestAt: text(raw.lastGenerationTestAt), lastSuccessfulRequestAt: text(raw.lastSuccessfulRequestAt), lastFailureAt: text(raw.lastFailureAt), lastErrorCode: text(raw.lastErrorCode),
    failureStreak: number(raw.failureStreak), cooldownUntil: text(raw.cooldownUntil), nextProbeAt: text(raw.nextProbeAt), quotaExhaustedUntil: text(raw.quotaExhaustedUntil), requestsTodayEstimated: number(raw.requestsTodayEstimated), inputTokensTodayEstimated: number(raw.inputTokensTodayEstimated), outputTokensTodayEstimated: number(raw.outputTokensTodayEstimated), healthScore: Math.max(0, Math.min(100, number(raw.healthScore) || 50)),
  };
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function isGenerationStatus(value: unknown): value is GeminiGenerationStatus { return ['unchecked', 'available', 'rate_limited', 'quota_exhausted', 'cooldown', 'transient_error', 'invalid', 'missing_permission', 'disabled'].includes(String(value)); }

export async function selectGeminiCredentials(modelId: string, now = Date.now()): Promise<GeminiCredentialSelection[]> {
  const pool = await getGeminiPoolState();
  const credentials = (await readCollection<StoredCredential>(COLLECTION)).filter((credential) => credential.platform === 'gemini' && credential.role !== 'disabled' && credential.status !== 'disabled');
  return credentials.map((credential) => ({ credential, metadata: metadataOf(credential) }))
    .filter(({ metadata }) => metadata.billingMode === 'free_confirmed' && metadata.generationStatus === 'available')
    .filter(({ metadata }) => !metadata.cooldownUntil || Date.parse(metadata.cooldownUntil) <= now)
    .filter(({ metadata }) => !metadata.quotaExhaustedUntil || Date.parse(metadata.quotaExhaustedUntil) <= now)
    .filter(({ metadata }) => metadata.supportedModels.includes(modelId))
    .filter(({ metadata }) => Boolean(metadata.quotaGroupId) && quotaGroupAvailable(pool.groups[metadata.quotaGroupId!], now))
    .filter(({ credential }) => getCredentialTruth(credential, now).generationReady)
    .sort((a, b) => a.metadata.priority! - b.metadata.priority! || a.credential.id.localeCompare(b.credential.id))
    .map(({ credential, metadata }) => ({ credentialId: credential.id, quotaGroupId: metadata.quotaGroupId!, supportedModels: metadata.supportedModels, preferredModel: metadata.preferredModel, healthScore: metadata.healthScore, primary: credential.role === 'primary', priority: metadata.priority! }));
}
export async function listAvailableGeminiModels(now = Date.now()): Promise<string[]> {
  const credentials = await readCollection<StoredCredential>(COLLECTION); const models = new Set<string>();
  for (const credential of credentials) { const metadata = metadataOf(credential); if (!getCredentialTruth(credential, now).generationReady) continue; metadata.supportedModels.forEach((model) => models.add(model)); }
  return [...models];
}

const completed = new Map<string, GeminiRequestResult>();
let activeRequests = 0;
async function withConcurrency<T>(work: () => Promise<T>): Promise<T> {
  while (activeRequests >= 2) await new Promise((resolve) => setTimeout(resolve, 5));
  activeRequests++;
  try { return await work(); } finally { activeRequests--; }
}

export async function executeGeminiRequest(request: GeminiRequest, fetchImpl: typeof fetch = fetch): Promise<GeminiRequestResult> {
  const cached = completed.get(request.idempotencyKey); if (cached) return cached;
  const selections = await selectGeminiCredentials(request.modelId);
  const attemptedGroups = new Set<string>();
  for (const selection of selections) {
    if (attemptedGroups.has(selection.quotaGroupId) || attemptedGroups.size >= Math.max(1, request.maxFailoverGroups || 3)) continue;
    attemptedGroups.add(selection.quotaGroupId);
    const credential = (await readCollection<StoredCredential>(COLLECTION)).find((item) => item.id === selection.credentialId);
    if (!credential) continue;
    let key: string;
    try { key = decryptSecret(credential.encryptedValue); } catch { await markCredential(selection.credentialId, 'invalid', 'decrypt_failed'); continue; }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await withConcurrency(() => fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.modelId)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(request.body), signal: controller.signal }));
      if (response.ok) {
        const data = await response.json();
        const result = { ok: true, status: response.status, data, credentialId: selection.credentialId, quotaGroupId: selection.quotaGroupId };
        await markCredential(selection.credentialId, 'available'); await updateQuotaGroup(selection.quotaGroupId, { failureStreak: 0, cooldownUntil: undefined, quotaExhaustedUntil: undefined }, 'ACTIVE');
        await recordGeminiUsage(selection.quotaGroupId, request.taskType, request.inputTokenEstimate || 0, 0); completed.set(request.idempotencyKey, result); return result;
      }
      const code = response.status === 429 ? 'quota_exhausted' : response.status === 401 ? 'invalid' : response.status === 403 ? 'missing_permission' : `http_${response.status}`;
      if (response.status === 429) {
        const retryMs = parseRetryAfter(response.headers.get('retry-after'));
        const until = new Date(Date.now() + retryMs).toISOString(); await markCredential(selection.credentialId, 'quota_exhausted', code, until); await updateQuotaGroup(selection.quotaGroupId, { failureStreak: 1, quotaExhaustedUntil: until, cooldownUntil: until }, 'DEGRADED');
      } else if (response.status === 401 || response.status === 403) await markCredential(selection.credentialId, response.status === 401 ? 'invalid' : 'missing_permission', code);
      else if (TRANSIENT_HTTP.has(response.status)) await markCredential(selection.credentialId, 'transient_error', code, new Date(Date.now() + 15 * 60_000).toISOString());
      else return { ok: false, status: response.status, errorCode: code, credentialId: selection.credentialId, quotaGroupId: selection.quotaGroupId };
      if (!TRANSIENT_HTTP.has(response.status)) break;
    } catch (error) {
      const code = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'connection_error';
      await markCredential(selection.credentialId, 'transient_error', code, new Date(Date.now() + 15 * 60_000).toISOString());
    } finally { clearTimeout(timeout); key = ''; }
  }
  if (selections.length === 0 || attemptedGroups.size >= selections.map((item) => item.quotaGroupId).filter((value, index, all) => all.indexOf(value) === index).length) {
    await setGeminiPoolState('LOCAL_ONLY');
  }
  return { ok: false, status: 0, errorCode: selections.length ? 'free_quota_unavailable' : 'local_only' };
}

function parseRetryAfter(value: string | null): number { const seconds = Number(value); return Number.isFinite(seconds) && seconds > 0 ? Math.max(60_000, seconds * 1000) : 60 * 60_000; }
async function markCredential(id: string, status: GeminiGenerationStatus, errorCode?: string, cooldownUntil?: string): Promise<void> {
  const credential = (await readCollection<StoredCredential>(COLLECTION)).find((item) => item.id === id); if (!credential) return;
  const metadata = metadataOf(credential); const now = new Date().toISOString();
  metadata.generationStatus = status; metadata.lastErrorCode = errorCode; metadata.cooldownUntil = cooldownUntil; metadata.failureStreak = status === 'available' ? 0 : metadata.failureStreak + 1;
  if (status === 'available') metadata.lastSuccessfulRequestAt = now; else metadata.lastFailureAt = now;
  if (status === 'quota_exhausted') metadata.quotaExhaustedUntil = cooldownUntil;
  await updateOne<StoredCredential>(COLLECTION, id, { metadata: metadata as unknown as Record<string, unknown>, status: status === 'invalid' ? 'invalid' : status === 'missing_permission' ? 'missing_permission' : credential.status, lastError: errorCode, lastCheckedAt: now } as Partial<StoredCredential>);
}
