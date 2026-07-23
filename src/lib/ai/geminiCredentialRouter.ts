import { readCollection, updateOne } from '../storage/adapter';
import { decryptSecret } from '../security/secrets';
import type {
  GeminiCredentialMetadata,
  GeminiGenerationStatus,
  StoredCredential,
} from '../types/tokenVault';
import {
  getGeminiPoolState,
  quotaGroupAvailable,
  setGeminiPoolState,
  updateQuotaGroup,
} from './geminiQuotaGroupManager';
import { recordGeminiUsage } from './geminiUsageTracker';
import { getCredentialTruth } from './credentialTruth';
import { discoverAllowedModels } from './geminiModels';
import {
  classifyGeminiProviderException,
  classifyGeminiProviderResponse,
  computeGeminiCooldownMs,
  type GeminiProviderErrorCategory,
} from './geminiProviderDiagnostics';

const COLLECTION = 'token-vault';

export interface GeminiCredentialSelection {
  credentialId: string;
  quotaGroupId: string;
  supportedModels: string[];
  preferredModel?: string;
  healthScore: number;
  primary: boolean;
  priority: number;
}

export interface GeminiRequest {
  modelId: string;
  taskType: string;
  idempotencyKey: string;
  body: unknown;
  timeoutMs: number;
  inputTokenEstimate?: number;
  maxFailoverGroups?: number;
}

export interface GeminiRequestResult {
  ok: boolean;
  status: number;
  data?: unknown;
  errorCode?: string;
  credentialId?: string;
  quotaGroupId?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isGenerationStatus(value: unknown): value is GeminiGenerationStatus {
  return [
    'unchecked',
    'available',
    'rate_limited',
    'quota_exhausted',
    'cooldown',
    'transient_error',
    'model_unavailable',
    'region_restricted',
    'provider_unavailable',
    'invalid',
    'missing_permission',
    'disabled',
  ].includes(String(value));
}

function metadataOf(credential: StoredCredential): GeminiCredentialMetadata {
  const raw = credential.metadata || {};
  return {
    provider: 'gemini',
    projectAlias: text(raw.projectAlias),
    quotaGroupId: text(raw.quotaGroupId),
    billingMode: raw.billingMode === 'free_confirmed' || raw.billingMode === 'paid'
      ? raw.billingMode
      : 'unknown',
    keyType: raw.keyType === 'auth'
      || raw.keyType === 'restricted_standard'
      || raw.keyType === 'standard'
      ? raw.keyType
      : 'unknown',
    supportedModels: Array.isArray(raw.supportedGenerateContentModels)
      ? raw.supportedGenerateContentModels.map(String)
      : Array.isArray(raw.supportedModels)
        ? raw.supportedModels.map(String)
        : [],
    supportedGenerateContentModels: Array.isArray(raw.supportedGenerateContentModels)
      ? raw.supportedGenerateContentModels.map(String)
      : undefined,
    preferredModel: text(raw.preferredModel),
    testedModel: text(raw.testedModel),
    priority: Number.isInteger(Number(raw.priority))
      ? Math.max(0, Math.min(10_000, Number(raw.priority)))
      : 100,
    lightTestStatus: raw.lightTestStatus === 'available'
      || raw.lightTestStatus === 'invalid'
      || raw.lightTestStatus === 'missing_permission'
      || raw.lightTestStatus === 'transient_error'
      ? raw.lightTestStatus
      : 'unchecked',
    generationStatus: isGenerationStatus(raw.generationStatus)
      ? raw.generationStatus
      : 'unchecked',
    generationReady: raw.generationReady === true,
    generationReadinessReason: text(raw.generationReadinessReason),
    freePolicyEligible: raw.freePolicyEligible === true,
    adapterReady: raw.adapterReady === true,
    runtimeRouteReady: raw.runtimeRouteReady === true,
    diagnosticCategory: typeof raw.diagnosticCategory === 'string'
      ? raw.diagnosticCategory as GeminiCredentialMetadata['diagnosticCategory']
      : undefined,
    retryable: raw.retryable === true,
    providerHttpStatus: Number.isInteger(Number(raw.providerHttpStatus))
      ? Number(raw.providerHttpStatus)
      : undefined,
    discoveredModelCount: Number.isInteger(Number(raw.discoveredModelCount))
      ? Number(raw.discoveredModelCount)
      : undefined,
    lastCheckedAt: text(raw.lastCheckedAt),
    lastLightTestAt: text(raw.lastLightTestAt),
    lastGenerationTestAt: text(raw.lastGenerationTestAt),
    generationVerifiedAt: text(raw.generationVerifiedAt),
    lastGenerationSucceededAt: text(raw.lastGenerationSucceededAt),
    lastSuccessfulRequestAt: text(raw.lastSuccessfulRequestAt),
    lastFailureAt: text(raw.lastFailureAt),
    lastErrorCode: text(raw.lastErrorCode),
    errorCategory: text(raw.errorCategory),
    failureStreak: number(raw.failureStreak),
    cooldownUntil: text(raw.cooldownUntil),
    nextProbeAt: text(raw.nextProbeAt),
    quotaExhaustedUntil: text(raw.quotaExhaustedUntil),
    requestsTodayEstimated: number(raw.requestsTodayEstimated),
    inputTokensTodayEstimated: number(raw.inputTokensTodayEstimated),
    outputTokensTodayEstimated: number(raw.outputTokensTodayEstimated),
    healthScore: Math.max(0, Math.min(100, number(raw.healthScore) || 50)),
  };
}

export async function selectGeminiCredentials(
  modelId: string,
  now = Date.now(),
): Promise<GeminiCredentialSelection[]> {
  if (!discoverAllowedModels([modelId], now).some((entry) => entry.modelId === modelId)) {
    return [];
  }
  const pool = await getGeminiPoolState();
  const credentials = (await readCollection<StoredCredential>(COLLECTION))
    .filter((credential) => credential.platform === 'gemini'
      && credential.role !== 'disabled'
      && credential.status !== 'disabled');
  return credentials
    .map((credential) => ({
      credential,
      metadata: metadataOf(credential),
      truth: getCredentialTruth(credential, now),
    }))
    .filter(({ truth }) => truth.generationReady)
    .filter(({ metadata }) => metadata.supportedModels.includes(modelId))
    .filter(({ metadata }) => Boolean(metadata.quotaGroupId)
      && quotaGroupAvailable(pool.groups[metadata.quotaGroupId!], now))
    .sort((left, right) => Number(right.credential.role === 'primary')
      - Number(left.credential.role === 'primary')
      || (left.metadata.priority ?? 100) - (right.metadata.priority ?? 100)
      || left.credential.id.localeCompare(right.credential.id))
    .map(({ credential, metadata }) => ({
      credentialId: credential.id,
      quotaGroupId: metadata.quotaGroupId!,
      supportedModels: metadata.supportedModels,
      preferredModel: metadata.preferredModel,
      healthScore: metadata.healthScore,
      primary: credential.role === 'primary',
      priority: metadata.priority ?? 100,
    }));
}

export async function listAvailableGeminiModels(now = Date.now()): Promise<string[]> {
  const credentials = await readCollection<StoredCredential>(COLLECTION);
  const models = new Set<string>();
  for (const credential of credentials) {
    const metadata = metadataOf(credential);
    if (!getCredentialTruth(credential, now).generationReady) continue;
    metadata.supportedModels.forEach((model) => models.add(model));
  }
  return [...models];
}

const completed = new Map<string, GeminiRequestResult>();
let activeRequests = 0;

async function withConcurrency<T>(work: () => Promise<T>): Promise<T> {
  while (activeRequests >= 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  activeRequests += 1;
  try {
    return await work();
  } finally {
    activeRequests -= 1;
  }
}

function generationStatusFor(category: GeminiProviderErrorCategory): GeminiGenerationStatus {
  if (category === 'INVALID_KEY') return 'invalid';
  if (category === 'PERMISSION_DENIED') return 'missing_permission';
  if (category === 'QUOTA_EXCEEDED') return 'quota_exhausted';
  if (category === 'RATE_LIMITED') return 'rate_limited';
  if (category === 'MODEL_NOT_AVAILABLE') return 'model_unavailable';
  if (category === 'REGION_RESTRICTED') return 'region_restricted';
  if (category === 'PROVIDER_UNAVAILABLE') return 'provider_unavailable';
  return 'transient_error';
}

export async function executeGeminiRequest(
  request: GeminiRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<GeminiRequestResult> {
  const cached = completed.get(request.idempotencyKey);
  if (cached) return cached;

  const selections = await selectGeminiCredentials(request.modelId);
  const attemptedGroups = new Set<string>();
  for (const selection of selections) {
    if (attemptedGroups.has(selection.quotaGroupId)
      || attemptedGroups.size >= Math.max(1, request.maxFailoverGroups || 3)) {
      continue;
    }
    attemptedGroups.add(selection.quotaGroupId);
    const credential = (await readCollection<StoredCredential>(COLLECTION))
      .find((item) => item.id === selection.credentialId);
    if (!credential) continue;

    let key = '';
    try {
      key = decryptSecret(credential.encryptedValue);
    } catch {
      await markCredential(selection.credentialId, 'invalid', 'INVALID_KEY', {
        category: 'INVALID_KEY',
        testedModel: request.modelId,
        retryable: false,
      });
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await withConcurrency(() => fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.modelId)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(request.body),
          signal: controller.signal,
        },
      ));
      if (response.ok) {
        const data = await response.json();
        const result: GeminiRequestResult = {
          ok: true,
          status: response.status,
          data,
          credentialId: selection.credentialId,
          quotaGroupId: selection.quotaGroupId,
        };
        await markCredential(selection.credentialId, 'available', undefined, {
          httpStatus: response.status,
          testedModel: request.modelId,
          retryable: false,
        });
        await updateQuotaGroup(selection.quotaGroupId, {
          failureStreak: 0,
          cooldownUntil: undefined,
          quotaExhaustedUntil: undefined,
        }, 'ACTIVE');
        await recordGeminiUsage(
          selection.quotaGroupId,
          request.taskType,
          request.inputTokenEstimate || 0,
          0,
        );
        completed.set(request.idempotencyKey, result);
        return result;
      }

      const diagnostic = await classifyGeminiProviderResponse(response);
      const status = generationStatusFor(diagnostic.category);
      const cooldownUntil = await markCredential(
        selection.credentialId,
        status,
        diagnostic.category,
        {
          category: diagnostic.category,
          httpStatus: diagnostic.httpStatus,
          testedModel: request.modelId,
          retryable: diagnostic.retryable,
          retryAfterMs: diagnostic.retryAfterMs,
        },
      );
      if (diagnostic.retryable) {
        await updateQuotaGroup(selection.quotaGroupId, {
          failureStreak: 1,
          cooldownUntil,
          quotaExhaustedUntil: diagnostic.category === 'QUOTA_EXCEEDED'
            ? cooldownUntil
            : undefined,
        }, 'DEGRADED');
      } else {
        return {
          ok: false,
          status: response.status,
          errorCode: diagnostic.category,
          credentialId: selection.credentialId,
          quotaGroupId: selection.quotaGroupId,
        };
      }
    } catch (error) {
      const diagnostic = classifyGeminiProviderException(error);
      const cooldownUntil = await markCredential(
        selection.credentialId,
        generationStatusFor(diagnostic.category),
        diagnostic.category,
        {
          category: diagnostic.category,
          testedModel: request.modelId,
          retryable: diagnostic.retryable,
          retryAfterMs: diagnostic.retryAfterMs,
        },
      );
      await updateQuotaGroup(selection.quotaGroupId, {
        failureStreak: 1,
        cooldownUntil,
      }, 'DEGRADED');
    } finally {
      clearTimeout(timeout);
      key = '';
    }
  }

  const uniqueGroups = new Set(selections.map((item) => item.quotaGroupId)).size;
  if (selections.length === 0 || attemptedGroups.size >= uniqueGroups) {
    await setGeminiPoolState('LOCAL_ONLY');
  }
  return {
    ok: false,
    status: 0,
    errorCode: selections.length ? 'free_quota_unavailable' : 'local_only',
  };
}

interface MarkCredentialOptions {
  category?: GeminiProviderErrorCategory;
  httpStatus?: number;
  testedModel?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

async function markCredential(
  id: string,
  status: GeminiGenerationStatus,
  errorCode?: string,
  options: MarkCredentialOptions = {},
): Promise<string | undefined> {
  const credential = (await readCollection<StoredCredential>(COLLECTION))
    .find((item) => item.id === id);
  if (!credential) return undefined;

  const metadata = metadataOf(credential);
  const now = new Date().toISOString();
  const success = status === 'available';
  metadata.generationStatus = status;
  metadata.generationReady = success;
  metadata.generationReadinessReason = success ? 'READY' : errorCode;
  metadata.diagnosticCategory = success
    ? 'READY'
    : options.category || 'UNKNOWN_PROVIDER_ERROR';
  metadata.errorCategory = success ? undefined : options.category || errorCode;
  metadata.retryable = options.retryable === true;
  metadata.failureStreak = success ? 0 : metadata.failureStreak + 1;
  const cooldownMs = options.category
    ? computeGeminiCooldownMs(
        options.category,
        metadata.failureStreak,
        options.retryAfterMs,
      )
    : undefined;
  const cooldownUntil = cooldownMs
    ? new Date(Date.now() + cooldownMs).toISOString()
    : undefined;
  metadata.cooldownUntil = cooldownUntil;
  metadata.nextProbeAt = cooldownUntil;
  metadata.adapterReady = true;
  metadata.runtimeRouteReady = success;
  metadata.providerHttpStatus = options.httpStatus;
  metadata.lastCheckedAt = now;
  metadata.lastGenerationTestAt = now;
  metadata.testedModel = options.testedModel || metadata.testedModel;

  if (success) {
    metadata.freePolicyEligible = true;
    metadata.preferredModel = options.testedModel || metadata.preferredModel;
    if (options.testedModel && !metadata.supportedModels.includes(options.testedModel)) {
      metadata.supportedModels = [...metadata.supportedModels, options.testedModel];
      metadata.supportedGenerateContentModels = metadata.supportedModels;
    }
    metadata.lastSuccessfulRequestAt = now;
    metadata.generationVerifiedAt = now;
    metadata.lastGenerationSucceededAt = now;
    metadata.lastErrorCode = undefined;
    metadata.quotaExhaustedUntil = undefined;
  } else {
    metadata.lastFailureAt = now;
    metadata.lastErrorCode = errorCode;
    metadata.quotaExhaustedUntil = status === 'quota_exhausted'
      ? cooldownUntil
      : undefined;
  }

  const terminal = options.category
    ? !['QUOTA_EXCEEDED', 'RATE_LIMITED', 'NETWORK_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'TRANSIENT_ERROR']
        .includes(options.category)
    : false;
  await updateOne<StoredCredential>(COLLECTION, id, {
    metadata: metadata as unknown as Record<string, unknown>,
    role: terminal && credential.role === 'primary' ? 'backup' : credential.role,
    status: success
      ? 'valid'
      : status === 'invalid'
        ? 'invalid'
        : status === 'missing_permission'
          ? 'missing_permission'
          : credential.status,
    lastError: success ? undefined : errorCode,
    lastCheckedAt: now,
  } as Partial<StoredCredential>);
  return cooldownUntil;
}
