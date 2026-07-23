import { readCollection, updateOne } from '../storage/adapter';
import { decryptSecret } from '../security/secrets';
import type { GeminiCredentialMetadata, GeminiGenerationStatus, StoredCredential } from '../types/tokenVault';
import { getGeminiPoolState, quotaGroupAvailable, setGeminiPoolState, updateQuotaGroup } from './geminiQuotaGroupManager';
import { recordGeminiUsage } from './geminiUsageTracker';
import { getCredentialTruth } from './credentialTruth';
import {
  classifyGeminiProviderException,
  classifyGeminiProviderResponse,
  computeGeminiCooldownMs,
  type GeminiProviderErrorCategory,
} from './geminiProviderDiagnostics';

const COLLECTION = 'token-vault';
export interface GeminiCredentialSelection { credentialId: string; quotaGroupId: string; supportedModels: string[]; preferredModel?: string; healthScore: number; primary: boolean; priority: number; }
export interface GeminiRequest { modelId: string; taskType: string; idempotencyKey: string; body: unknown; timeoutMs: number; inputTokenEstimate?: number; maxFailoverGroups?: number; }
export interface GeminiRequestResult { ok: boolean; status: number; data?: unknown; errorCode?: string; credentialId?: string; quotaGroupId?: string; }

function metadataOf(credential: StoredCredential): GeminiCredentialMetadata {
  const raw = credential.metadata || {};
  return {
    provider: 'gemini',
    projectAlias: typeof raw.projectAlias === 'string' ? raw.projectAlias : undefined,
    quotaGroupId: typeof raw.quotaGroupId === 'string' ? raw.quotaGroupId : undefined,
    billingMode: raw.billingMode === 'free_confirmed' || raw.billingMode === 'paid' ? raw.billingMode : 'unknown',
    keyType: raw.keyType === 'auth' || raw.keyType === 'restricted_standard' || raw.keyType === 'standard' ? raw.keyType : 'unknown',
    supportedModels: Array.isArray(raw.supportedModels) ? raw.supportedModels.map(String) : [],
    preferredModel: typeof raw.preferredModel === 'string' ? raw.preferredModel : undefined,
    priority: Number.isInteger(Number(raw.priority)) ? Math.max(0, Math.min(10_000, Number(raw.priority))) : 100,
    lightTestStatus: raw.lightTestStatus === 'available' || raw.lightTestStatus === 'invalid' || raw.lightTestStatus === 'missing_permission' || raw.lightTestStatus === 'transient_error' ? raw.lightTestStatus : 'unchecked',
    generationStatus: isGenerationStatus(raw.generationStatus) ? raw.generationStatus : 'unchecked',
    lastLightTestAt: text(raw.lastLightTestAt), lastGenerationTestAt: text(raw.lastGenerationTestAt), generationVerifiedAt: text(raw.generationVerifiedAt), lastSuccessfulRequestAt: text(raw.lastSuccessfulRequestAt), lastFailureAt: text(raw.lastFailureAt), lastErrorCode: text(raw.lastErrorCode),
    testedModel: text(raw.testedModel), providerHttpStatus: Number.isInteger(Number(raw.providerHttpStatus)) ? Number(raw.providerHttpStatus) : undefined,
    errorCategory: text(raw.errorCategory), retryable: raw.retryable === true,
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
        await markCredential(selection.credentialId, 'available', undefined, { httpStatus: response.status, testedModel: request.modelId, retryable: false }); await updateQuotaGroup(selection.quotaGroupId, { failureStreak: 0, cooldownUntil: undefined, quotaExhaustedUntil: undefined }, 'ACTIVE');
        await recordGeminiUsage(selection.quotaGroupId, request.taskType, request.inputTokenEstimate || 0, 0); completed.set(request.idempotencyKey, result); return result;
      }
      const diagnostic = await classifyGeminiProviderResponse(response);
      const generationStatus = diagnostic.category === 'INVALID_KEY' ? 'invalid'
        : diagnostic.category === 'PERMISSION_DENIED' || diagnostic.category === 'MODEL_NOT_AVAILABLE' || diagnostic.category === 'REGION_RESTRICTED' ? 'missing_permission'
          : diagnostic.category === 'QUOTA_EXCEEDED' ? 'quota_exhausted'
            : diagnostic.category === 'RATE_LIMITED' ? 'rate_limited'
              : 'transient_error';
      const cooldownUntil = await markCredential(selection.credentialId, generationStatus, diagnostic.category, {
        category: diagnostic.category,
        httpStatus: diagnostic.httpStatus,
        testedModel: request.modelId,
        retryable: diagnostic.retryable,
        retryAfterMs: diagnostic.retryAfterMs,
      });
      await updateQuotaGroup(selection.quotaGroupId, {
        failureStreak: 1,
        cooldownUntil,
        quotaExhaustedUntil: diagnostic.category === 'QUOTA_EXCEEDED' ? cooldownUntil : undefined,
      }, 'DEGRADED');
      if (!diagnostic.retryable) return { ok: false, status: response.status, errorCode: diagnostic.category, credentialId: selection.credentialId, quotaGroupId: selection.quotaGroupId };
    } catch (error) {
      const diagnostic = classifyGeminiProviderException(error);
      await markCredential(selection.credentialId, 'transient_error', diagnostic.category, {
        category: diagnostic.category, testedModel: request.modelId, retryable: diagnostic.retryable,
      });
    } finally { clearTimeout(timeout); key = ''; }
  }
  if (selections.length === 0 || attemptedGroups.size >= selections.map((item) => item.quotaGroupId).filter((value, index, all) => all.indexOf(value) === index).length) {
    await setGeminiPoolState('LOCAL_ONLY');
  }
  return { ok: false, status: 0, errorCode: selections.length ? 'free_quota_unavailable' : 'local_only' };
}

interface MarkCredentialOptions {
  category?: GeminiProviderErrorCategory;
  httpStatus?: number;
  testedModel?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

async function markCredential(id: string, status: GeminiGenerationStatus, errorCode?: string, options: MarkCredentialOptions = {}): Promise<string | undefined> {
  const credential = (await readCollection<StoredCredential>(COLLECTION)).find((item) => item.id === id); if (!credential) return;
  const metadata = metadataOf(credential); const now = new Date().toISOString();
  metadata.generationStatus = status;
  metadata.lastErrorCode = errorCode;
  metadata.errorCategory = options.category;
  metadata.providerHttpStatus = options.httpStatus;
  metadata.testedModel = options.testedModel;
  metadata.retryable = options.retryable === true;
  metadata.failureStreak = status === 'available' ? 0 : metadata.failureStreak + 1;
  const cooldownMs = options.category
    ? computeGeminiCooldownMs(options.category, metadata.failureStreak, options.retryAfterMs)
    : undefined;
  const cooldownUntil = cooldownMs ? new Date(Date.now() + cooldownMs).toISOString() : undefined;
  metadata.cooldownUntil = cooldownUntil;
  metadata.nextProbeAt = cooldownUntil;
  if (status === 'available') {
    metadata.lastSuccessfulRequestAt = now;
    metadata.generationVerifiedAt = now;
    metadata.quotaExhaustedUntil = undefined;
    metadata.errorCategory = undefined;
    metadata.lastErrorCode = undefined;
  } else {
    metadata.lastFailureAt = now;
    metadata.generationVerifiedAt = undefined;
  }
  if (status === 'quota_exhausted') metadata.quotaExhaustedUntil = cooldownUntil;
  else if (status !== 'available') metadata.quotaExhaustedUntil = undefined;
  await updateOne<StoredCredential>(COLLECTION, id, {
    metadata: metadata as unknown as Record<string, unknown>,
    status: status === 'invalid' ? 'invalid' : status === 'missing_permission' ? 'missing_permission' : status === 'available' ? 'valid' : credential.status,
    lastError: errorCode,
    lastCheckedAt: now,
  } as Partial<StoredCredential>);
  return cooldownUntil;
}
