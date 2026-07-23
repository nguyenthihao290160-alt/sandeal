import type {
  CredentialStatus,
  GeminiDiagnosticCategory,
  GeminiGenerationStatus,
  StoredCredential,
} from '../types/tokenVault';
import {
  getCredentialById,
  getRawCredentialValue,
  listCredentials,
  updateCredential,
} from '../storage/tokenVault';
import { discoverAllowedModels } from './geminiModels';
import { updateQuotaGroup } from './geminiQuotaGroupManager';
import { getCredentialTruth, getGeminiReadinessMaxAgeMs } from './credentialTruth';
import {
  classifyGeminiProviderException,
  classifyGeminiProviderResponse,
  computeGeminiCooldownMs,
  geminiDiagnosticMessage,
  type GeminiProviderDiagnostic,
  type GeminiProviderErrorCategory,
} from './geminiProviderDiagnostics';

const MODEL_DISCOVERY_LIMIT = 200;
const GENERATION_CANDIDATE_LIMIT = 4;
const MODEL_DISCOVERY_MAX_AGE_MS = 6 * 60 * 60_000;

export interface ProbeResult {
  status: CredentialStatus;
  generationStatus: GeminiGenerationStatus;
  message: string;
  credentialId: string;
  provider: 'gemini';
  keyValid: boolean;
  generationReady: boolean;
  diagnosticCategory: GeminiDiagnosticCategory;
  errorCategory: GeminiProviderErrorCategory | null;
  retryable: boolean;
  cooldownUntil: string | null;
  testedModel: string | null;
  providerHttpStatus?: number;
  httpStatus: number | null;
  lastCheckedAt: string;
  freePolicyEligible: boolean;
  adapterReady: boolean;
}

export interface GeminiFailureClassification {
  diagnosticCategory: GeminiProviderErrorCategory;
  generationStatus: GeminiGenerationStatus;
  credentialStatus: CredentialStatus;
  retryable: boolean;
  cooldownMs: number;
  message: string;
}

export interface GeminiBatchStats {
  total: number;
  validKeys: number;
  generationReady: number;
  permissionDenied: number;
  invalidKey: number;
  rateLimited: number;
  quotaExceeded: number;
  modelUnavailable: number;
  freePolicyUnverified: number;
  transientFailures: number;
}

function retryAfterMs(value: string | null): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(60_000, Math.min(6 * 60 * 60_000, seconds * 1000));
  }
  if (value) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return Math.max(60_000, Math.min(6 * 60 * 60_000, timestamp - Date.now()));
    }
  }
  return 15 * 60_000;
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

function credentialStatusFor(category: GeminiProviderErrorCategory): CredentialStatus {
  if (category === 'INVALID_KEY') return 'invalid';
  if (category === 'PERMISSION_DENIED') return 'missing_permission';
  if (category === 'MODEL_NOT_AVAILABLE' || category === 'REGION_RESTRICTED') return 'valid';
  return 'error';
}

function failureFromDiagnostic(
  diagnostic: GeminiProviderDiagnostic,
  failureStreak = 1,
  testedModel?: string,
): GeminiFailureClassification {
  return {
    diagnosticCategory: diagnostic.category,
    generationStatus: generationStatusFor(diagnostic.category),
    credentialStatus: credentialStatusFor(diagnostic.category),
    retryable: diagnostic.retryable,
    cooldownMs: computeGeminiCooldownMs(
      diagnostic.category,
      failureStreak,
      diagnostic.retryAfterMs,
    ) || 0,
    message: geminiDiagnosticMessage(diagnostic.category, testedModel),
  };
}

/**
 * Backward-compatible status-only classifier used by isolated regression tests.
 * Runtime requests use classifyGeminiProviderResponse so safe response hints can
 * distinguish quota exhaustion from a short rate limit without persisting them.
 */
export function classifyGeminiFailure(
  status: number,
  retryAfter: string | null = null,
): GeminiFailureClassification {
  let category: GeminiProviderErrorCategory;
  if (status === 401) category = 'INVALID_KEY';
  else if (status === 403) category = 'PERMISSION_DENIED';
  else if (status === 429 && retryAfter) category = 'RATE_LIMITED';
  else if (status === 429) category = 'QUOTA_EXCEEDED';
  else if (status === 400 || status === 404) category = 'MODEL_NOT_AVAILABLE';
  else if (status === 451) category = 'REGION_RESTRICTED';
  else if (status === 408 || status === 504) category = 'NETWORK_TIMEOUT';
  else if (status >= 500) category = 'PROVIDER_UNAVAILABLE';
  else category = 'UNKNOWN_PROVIDER_ERROR';

  const retryable = [
    'QUOTA_EXCEEDED',
    'RATE_LIMITED',
    'NETWORK_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'TRANSIENT_ERROR',
  ].includes(category);
  const retryMs = retryAfter ? retryAfterMs(retryAfter) : undefined;
  return failureFromDiagnostic({ category, retryable, retryAfterMs: retryMs });
}

export function classifyGeminiException(error: unknown): GeminiFailureClassification {
  return failureFromDiagnostic(classifyGeminiProviderException(error));
}

function supportedMethods(model: { supportedGenerationMethods?: string[] }): string[] {
  return Array.isArray(model.supportedGenerationMethods)
    ? model.supportedGenerationMethods.map(String)
    : [];
}

function modelName(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/^models\//, '').trim().slice(0, 160)
    : '';
}

function safeStatus(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function diagnosticCategory(value: unknown): GeminiDiagnosticCategory {
  const allowed = new Set<GeminiDiagnosticCategory>([
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
  return allowed.has(value as GeminiDiagnosticCategory)
    ? value as GeminiDiagnosticCategory
    : 'FREE_POLICY_UNVERIFIED';
}

async function resultFromCredential(id: string, message: string, nowMs = Date.now()): Promise<ProbeResult> {
  const credential = await getCredentialById(id);
  if (!credential || credential.platform !== 'gemini') return missingCredential(id, nowMs);
  const truth = getCredentialTruth(credential, nowMs);
  const metadata = credential.metadata || {};
  const category = diagnosticCategory(
    truth.diagnosticCategory || metadata.diagnosticCategory || metadata.errorCategory,
  );
  const providerHttpStatus = Number.isInteger(Number(metadata.providerHttpStatus))
    ? Number(metadata.providerHttpStatus)
    : undefined;
  const checkedAt = credential.lastCheckedAt
    || (typeof metadata.lastCheckedAt === 'string' ? metadata.lastCheckedAt : undefined)
    || new Date(nowMs).toISOString();
  return {
    status: credential.status,
    generationStatus: String(metadata.generationStatus || 'unchecked') as GeminiGenerationStatus,
    message,
    credentialId: id,
    provider: 'gemini',
    keyValid: truth.valid,
    generationReady: truth.generationReady,
    diagnosticCategory: category,
    errorCategory: category === 'READY' || category === 'FREE_POLICY_UNVERIFIED'
      ? null
      : category,
    retryable: truth.retryable,
    cooldownUntil: truth.cooldownUntil,
    testedModel: truth.testedModel,
    providerHttpStatus,
    httpStatus: providerHttpStatus ?? null,
    lastCheckedAt: checkedAt,
    freePolicyEligible: truth.freePolicyEligible,
    adapterReady: truth.adapterReady,
  };
}

function missingCredential(id: string, nowMs = Date.now()): ProbeResult {
  return {
    status: 'invalid',
    generationStatus: 'invalid',
    message: 'Không tìm thấy kết nối Gemini.',
    credentialId: id,
    provider: 'gemini',
    keyValid: false,
    generationReady: false,
    diagnosticCategory: 'INVALID_KEY',
    errorCategory: 'INVALID_KEY',
    retryable: false,
    cooldownUntil: null,
    testedModel: null,
    httpStatus: null,
    lastCheckedAt: new Date(nowMs).toISOString(),
    freePolicyEligible: false,
    adapterReady: false,
  };
}

interface PersistFailureOptions {
  providerHttpStatus?: number;
  testedModel?: string;
  freePolicyEligible?: boolean;
  phase: 'light' | 'generation';
}

async function persistFailure(
  credential: StoredCredential,
  failure: GeminiFailureClassification,
  nowMs: number,
  options: PersistFailureOptions,
): Promise<ProbeResult> {
  const fresh = await getCredentialById(credential.id) || credential;
  const now = new Date(nowMs).toISOString();
  const failureStreak = Number(fresh.metadata?.failureStreak || 0) + 1;
  const cooldownMs = failure.retryable
    ? computeGeminiCooldownMs(failure.diagnosticCategory, failureStreak, failure.cooldownMs) || 0
    : 0;
  const cooldownUntil = cooldownMs > 0
    ? new Date(nowMs + cooldownMs).toISOString()
    : undefined;
  const status = failure.credentialStatus === 'error' && fresh.status === 'valid'
    ? 'valid'
    : failure.credentialStatus;
  const terminal = !failure.retryable;
  const freePolicyEligible = options.freePolicyEligible
    ?? (failure.diagnosticCategory === 'MODEL_NOT_AVAILABLE'
      ? false
      : fresh.metadata?.freePolicyEligible === true);
  const metadata = {
    ...fresh.metadata,
    provider: 'gemini',
    lastCheckedAt: now,
    providerHttpStatus: options.providerHttpStatus,
    diagnosticCategory: failure.diagnosticCategory,
    errorCategory: failure.diagnosticCategory,
    retryable: failure.retryable,
    generationReady: false,
    generationReadinessReason: failure.diagnosticCategory,
    adapterReady: options.phase === 'generation' || fresh.metadata?.adapterReady === true,
    runtimeRouteReady: false,
    testedModel: options.testedModel || fresh.metadata?.testedModel,
    freePolicyEligible,
    generationStatus: failure.generationStatus,
    lastFailureAt: now,
    lastErrorCode: failure.diagnosticCategory,
    failureStreak,
    cooldownUntil,
    nextProbeAt: cooldownUntil,
    quotaExhaustedUntil: failure.diagnosticCategory === 'QUOTA_EXCEEDED'
      ? cooldownUntil
      : undefined,
    ...(options.phase === 'light'
      ? {
          lightTestStatus: status === 'invalid'
            ? 'invalid'
            : status === 'missing_permission'
              ? 'missing_permission'
              : 'transient_error',
          lastLightTestAt: now,
        }
      : { lastGenerationTestAt: now }),
  };
  await updateCredential(fresh.id, {
    status,
    role: terminal && fresh.role === 'primary' ? 'backup' : fresh.role,
    lastError: failure.diagnosticCategory,
    lastCheckedAt: now,
    metadata,
  });

  const quotaGroup = typeof fresh.metadata?.quotaGroupId === 'string'
    ? fresh.metadata.quotaGroupId
    : undefined;
  if (quotaGroup && options.phase === 'generation') {
    await updateQuotaGroup(quotaGroup, {
      cooldownUntil,
      quotaExhaustedUntil: failure.diagnosticCategory === 'QUOTA_EXCEEDED'
        ? cooldownUntil
        : undefined,
      failureStreak,
    }, 'DEGRADED');
  }
  return resultFromCredential(fresh.id, failure.message, nowMs);
}

export async function lightTestCredential(
  id: string,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<ProbeResult> {
  const credential = await getCredentialById(id);
  if (!credential || credential.platform !== 'gemini') return missingCredential(id, nowMs);
  const key = await getRawCredentialValue(id);
  if (!key) {
    return persistFailure(credential, classifyGeminiFailure(401), nowMs, { phase: 'light' });
  }

  try {
    const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const failure = failureFromDiagnostic(
        await classifyGeminiProviderResponse(response),
        Number(credential.metadata?.failureStreak || 0) + 1,
      );
      return persistFailure(credential, failure, nowMs, {
        providerHttpStatus: safeStatus(response.status),
        phase: 'light',
      });
    }

    const payload = await response.json() as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const models = Array.isArray(payload.models)
      ? payload.models.slice(0, MODEL_DISCOVERY_LIMIT)
      : [];
    const supportedModels = [...new Set(models
      .filter((model) => supportedMethods(model)
        .some((method) => method === 'generateContent' || method === 'embedContent'))
      .map((model) => modelName(model.name))
      .filter(Boolean))];
    const supportedGenerateContentModels = [...new Set(models
      .filter((model) => supportedMethods(model).includes('generateContent'))
      .map((model) => modelName(model.name))
      .filter(Boolean))];
    const eligibleModels = discoverAllowedModels(supportedGenerateContentModels, nowMs)
      .filter((entry) => entry.taskTypesAllowed.includes('generation_probe'));
    const priorTruth = getCredentialTruth(credential, nowMs);
    const priorStillUsable = priorTruth.generationReady
      && Boolean(
        priorTruth.testedModel
        && eligibleModels.some((entry) => entry.modelId === priorTruth.testedModel),
      );
    const category: GeminiDiagnosticCategory = priorStillUsable
      ? 'READY'
      : eligibleModels.length
        ? 'FREE_POLICY_UNVERIFIED'
        : 'MODEL_NOT_AVAILABLE';
    const now = new Date(nowMs).toISOString();
    await updateCredential(id, {
      status: 'valid',
      lastError: eligibleModels.length ? undefined : 'MODEL_NOT_AVAILABLE',
      lastCheckedAt: now,
      metadata: {
        ...credential.metadata,
        provider: 'gemini',
        lightTestStatus: 'available',
        lastLightTestAt: now,
        lastCheckedAt: now,
        supportedModels,
        supportedGenerateContentModels,
        discoveredModelCount: models.length,
        providerHttpStatus: safeStatus(response.status),
        diagnosticCategory: category,
        errorCategory: category === 'MODEL_NOT_AVAILABLE' ? category : undefined,
        retryable: false,
        generationReady: priorStillUsable,
        generationReadinessReason: priorStillUsable ? 'READY' : category,
        freePolicyEligible: priorStillUsable,
        adapterReady: priorStillUsable || credential.metadata?.adapterReady === true,
        runtimeRouteReady: priorStillUsable,
        generationStatus: priorStillUsable
          ? 'available'
          : eligibleModels.length
            ? credential.metadata?.generationStatus || 'unchecked'
            : 'model_unavailable',
      },
    });
    return resultFromCredential(
      id,
      eligibleModels.length
        ? `Khóa hợp lệ; đã phát hiện ${supportedGenerateContentModels.length} model có thể tạo nội dung.`
        : 'Khóa hợp lệ nhưng chưa tìm được model Free phù hợp để tạo nội dung.',
      nowMs,
    );
  } catch (error) {
    return persistFailure(credential, classifyGeminiException(error), nowMs, { phase: 'light' });
  }
}

function hasFreshModelDiscovery(credential: StoredCredential, nowMs: number): boolean {
  const lastLightTestAt = typeof credential.metadata?.lastLightTestAt === 'string'
    ? Date.parse(credential.metadata.lastLightTestAt)
    : Number.NaN;
  return Number.isFinite(lastLightTestAt)
    && nowMs - lastLightTestAt >= -5 * 60_000
    && nowMs - lastLightTestAt <= MODEL_DISCOVERY_MAX_AGE_MS
    && Array.isArray(credential.metadata?.supportedGenerateContentModels);
}

async function persistGenerationSuccess(
  credential: StoredCredential,
  modelId: string,
  nowMs: number,
  providerHttpStatus = 200,
): Promise<ProbeResult> {
  const fresh = await getCredentialById(credential.id) || credential;
  const now = new Date(nowMs).toISOString();
  const quotaGroupId = typeof fresh.metadata?.quotaGroupId === 'string'
    && fresh.metadata.quotaGroupId.trim()
    ? fresh.metadata.quotaGroupId.trim().slice(0, 160)
    : `gemini-credential-${fresh.id}`.slice(0, 160);
  const supported = Array.isArray(fresh.metadata?.supportedGenerateContentModels)
    ? fresh.metadata.supportedGenerateContentModels.map(String)
    : Array.isArray(fresh.metadata?.supportedModels)
      ? fresh.metadata.supportedModels.map(String)
      : [];
  await updateCredential(fresh.id, {
    status: 'valid',
    lastError: undefined,
    lastCheckedAt: now,
    metadata: {
      ...fresh.metadata,
      provider: 'gemini',
      quotaGroupId,
      supportedGenerateContentModels: supported.includes(modelId)
        ? supported
        : [...supported, modelId],
      preferredModel: modelId,
      testedModel: modelId,
      generationStatus: 'available',
      generationReady: true,
      generationReadinessReason: 'READY',
      freePolicyEligible: true,
      adapterReady: true,
      runtimeRouteReady: true,
      providerHttpStatus: safeStatus(providerHttpStatus),
      diagnosticCategory: 'READY',
      errorCategory: undefined,
      retryable: false,
      lastCheckedAt: now,
      lastGenerationTestAt: now,
      generationVerifiedAt: now,
      lastGenerationSucceededAt: now,
      lastSuccessfulRequestAt: now,
      lastErrorCode: undefined,
      failureStreak: 0,
      cooldownUntil: undefined,
      nextProbeAt: undefined,
      quotaExhaustedUntil: undefined,
    },
  });
  await updateQuotaGroup(quotaGroupId, {
    cooldownUntil: undefined,
    quotaExhaustedUntil: undefined,
    failureStreak: 0,
  }, 'ACTIVE');
  return resultFromCredential(
    fresh.id,
    `Đã xác minh tạo nội dung thành công bằng ${modelId}.`,
    nowMs,
  );
}

export async function generationProbeCredential(
  id: string,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<ProbeResult> {
  let credential = await getCredentialById(id);
  if (!credential || credential.platform !== 'gemini') return missingCredential(id, nowMs);

  if (!hasFreshModelDiscovery(credential, nowMs)) {
    const light = await lightTestCredential(id, fetchImpl, nowMs);
    if (!light.keyValid) return light;
    credential = await getCredentialById(id);
    if (!credential) return missingCredential(id, nowMs);
  }

  const key = await getRawCredentialValue(id);
  if (!key) {
    return persistFailure(credential, classifyGeminiFailure(401), nowMs, { phase: 'generation' });
  }
  const supported = Array.isArray(credential.metadata?.supportedGenerateContentModels)
    ? credential.metadata.supportedGenerateContentModels.map(String)
    : Array.isArray(credential.metadata?.supportedModels)
      ? credential.metadata.supportedModels.map(String)
      : [];
  const candidates = discoverAllowedModels(supported, nowMs)
    .filter((entry) => entry.taskTypesAllowed.includes('generation_probe') && entry.maxOutputTokens > 0)
    .sort((left, right) => {
      const leftBulk = left.role === 'BULK_WORKER' ? 1 : 0;
      const rightBulk = right.role === 'BULK_WORKER' ? 1 : 0;
      return rightBulk - leftBulk
        || right.priority - left.priority
        || left.modelId.localeCompare(right.modelId);
    })
    .slice(0, GENERATION_CANDIDATE_LIMIT);

  if (!candidates.length) {
    return persistFailure(credential, classifyGeminiFailure(404), nowMs, {
      phase: 'generation',
      freePolicyEligible: false,
    });
  }

  let lastModelFailure: {
    failure: GeminiFailureClassification;
    modelId: string;
    status: number;
  } | null = null;
  for (const model of candidates) {
    try {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.modelId)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Return exactly {"ok":true}' }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              maxOutputTokens: 24,
              temperature: 0,
            },
          }),
          signal: AbortSignal.timeout(model.timeoutMs),
        },
      );
      if (response.ok) {
        const payload = await response.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const output = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        let validOutput = false;
        try {
          validOutput = (JSON.parse(output || '{}') as { ok?: unknown }).ok === true;
        } catch {
          validOutput = false;
        }
        if (!validOutput) {
          const malformed = failureFromDiagnostic({
            category: 'UNKNOWN_PROVIDER_ERROR',
            retryable: false,
            httpStatus: safeStatus(response.status),
          }, Number(credential.metadata?.failureStreak || 0) + 1, model.modelId);
          return persistFailure(credential, malformed, nowMs, {
            phase: 'generation',
            providerHttpStatus: safeStatus(response.status),
            testedModel: model.modelId,
            freePolicyEligible: true,
          });
        }
        return persistGenerationSuccess(
          credential,
          model.modelId,
          nowMs,
          response.status,
        );
      }

      const failure = failureFromDiagnostic(
        await classifyGeminiProviderResponse(response),
        Number(credential.metadata?.failureStreak || 0) + 1,
        model.modelId,
      );
      if (failure.diagnosticCategory === 'MODEL_NOT_AVAILABLE') {
        lastModelFailure = { failure, modelId: model.modelId, status: response.status };
        continue;
      }
      return persistFailure(credential, failure, nowMs, {
        phase: 'generation',
        providerHttpStatus: safeStatus(response.status),
        testedModel: model.modelId,
        freePolicyEligible: true,
      });
    } catch (error) {
      return persistFailure(credential, classifyGeminiException(error), nowMs, {
        phase: 'generation',
        testedModel: model.modelId,
        freePolicyEligible: true,
      });
    }
  }

  const exhausted = lastModelFailure || {
    failure: classifyGeminiFailure(404),
    modelId: candidates[0].modelId,
    status: 404,
  };
  return persistFailure(credential, exhausted.failure, nowMs, {
    phase: 'generation',
    providerHttpStatus: exhausted.status,
    testedModel: exhausted.modelId,
    freePolicyEligible: true,
  });
}

export function summarizeGeminiProbeResults(
  results: ProbeResult[],
  total = results.length,
): GeminiBatchStats {
  const categories = results.map((result) => result.diagnosticCategory);
  return {
    total,
    validKeys: results.filter((result) => result.keyValid || [
      'PERMISSION_DENIED',
      'RATE_LIMITED',
      'QUOTA_EXCEEDED',
      'MODEL_NOT_AVAILABLE',
      'REGION_RESTRICTED',
    ].includes(result.diagnosticCategory)).length,
    generationReady: results.filter((result) => result.generationReady).length,
    permissionDenied: categories.filter((category) => category === 'PERMISSION_DENIED').length,
    invalidKey: categories.filter((category) => category === 'INVALID_KEY').length,
    rateLimited: categories.filter((category) => category === 'RATE_LIMITED').length,
    quotaExceeded: categories.filter((category) => category === 'QUOTA_EXCEEDED').length,
    modelUnavailable: categories.filter((category) => category === 'MODEL_NOT_AVAILABLE').length,
    freePolicyUnverified: results.filter((result) => result.keyValid && !result.freePolicyEligible).length,
    transientFailures: categories.filter((category) => [
      'NETWORK_TIMEOUT',
      'PROVIDER_UNAVAILABLE',
      'TRANSIENT_ERROR',
      'UNKNOWN_PROVIDER_ERROR',
    ].includes(category)).length,
  };
}

export async function probeAllGeminiCredentials(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ stats: GeminiBatchStats; results: ProbeResult[] }> {
  const credentials = (await listCredentials({ platform: 'gemini' }))
    .filter((item) => item.role !== 'disabled');
  const results: ProbeResult[] = [];
  for (const credential of credentials) {
    const light = await lightTestCredential(credential.id, fetchImpl, now);
    results.push(
      light.status === 'valid'
        ? await generationProbeCredential(credential.id, fetchImpl, now)
        : light,
    );
  }
  return {
    stats: summarizeGeminiProbeResults(results, credentials.length),
    results,
  };
}

export async function recoverDueGeminiCredentials(
  now = Date.now(),
  limit = 1,
): Promise<ProbeResult[]> {
  const due = (await listCredentials({ platform: 'gemini' }))
    .filter((credential) => credential.role !== 'disabled')
    .filter((credential) => credential.metadata?.billingMode === 'free_confirmed'
      || credential.metadata?.freePolicyEligible === true)
    .filter((credential) => credential.metadata?.retryable === true
      || ['transient_error', 'rate_limited', 'quota_exhausted', 'provider_unavailable']
        .includes(String(credential.metadata?.generationStatus || '')))
    .filter((credential) => credential.metadata?.nextProbeAt
      && Date.parse(String(credential.metadata.nextProbeAt)) <= now)
    .sort((left, right) => Date.parse(String(left.metadata?.nextProbeAt))
      - Date.parse(String(right.metadata?.nextProbeAt)))
    .slice(0, Math.max(0, Math.min(10, limit)));
  const results: ProbeResult[] = [];
  for (const credential of due) {
    results.push(await generationProbeCredential(credential.id, fetch, now));
  }
  return results;
}

export function isGeminiGenerationSuccessFresh(
  credential: StoredCredential,
  now = Date.now(),
): boolean {
  const value = credential.metadata?.lastGenerationSucceededAt
    || credential.metadata?.generationVerifiedAt
    || credential.metadata?.lastSuccessfulRequestAt;
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp)
    && now - timestamp >= -5 * 60_000
    && now - timestamp <= getGeminiReadinessMaxAgeMs();
}
