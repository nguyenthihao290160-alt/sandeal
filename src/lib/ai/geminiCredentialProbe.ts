import type { CredentialStatus, GeminiGenerationStatus, StoredCredential } from '../types/tokenVault';
import { getCredentialById, getRawCredentialValue, getSafeCredentialById, listCredentials, updateCredential } from '../storage/tokenVault';
import { FREE_MODEL_ALLOWLIST } from './geminiModels';
import { updateQuotaGroup } from './geminiQuotaGroupManager';
import {
  classifyGeminiProviderException,
  classifyGeminiProviderResponse,
  computeGeminiCooldownMs,
  geminiDiagnosticMessage,
  type GeminiProviderErrorCategory,
} from './geminiProviderDiagnostics';
import { getCredentialTruth } from './credentialTruth';

export interface ProbeResult {
  status: CredentialStatus;
  generationStatus: GeminiGenerationStatus;
  message: string;
  credentialId: string;
  provider: 'gemini';
  testedModel: string | null;
  httpStatus: number | null;
  errorCategory: GeminiProviderErrorCategory | null;
  lastCheckedAt: string;
  cooldownUntil: string | null;
  retryable: boolean;
  generationReady: boolean;
}

export async function lightTestCredential(id: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const credential = await getCredentialById(id);
  if (!credential || credential.platform !== 'gemini') return missingCredentialResult(id);
  const key = await getRawCredentialValue(id);
  if (!key) {
    return persistDiagnostic(credential, {
      status: 'invalid', generationStatus: 'invalid', category: 'INVALID_KEY', retryable: false,
      message: 'Không thể giải mã khóa Gemini. Hãy kiểm tra cấu hình mã hóa Token Vault.',
      probeType: 'light',
    });
  }

  try {
    const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const data = await response.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
      const supportedModels = (data.models || [])
        .filter((model) => (model.supportedGenerationMethods || []).includes('generateContent'))
        .map((model) => String(model.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      const now = new Date().toISOString();
      await updateCredential(id, {
        status: 'valid', lastError: undefined, lastCheckedAt: now,
        metadata: {
          ...credential.metadata,
          provider: 'gemini',
          lightTestStatus: 'available',
          lastLightTestAt: now,
          supportedModels,
          providerHttpStatus: safeStatus(response.status),
          errorCategory: undefined,
          retryable: false,
        },
      });
      const updated = await getSafeCredentialById(id);
      return buildResult(credential, {
        status: 'valid',
        generationStatus: asGenerationStatus(credential.metadata?.generationStatus),
        message: `Đã xác thực khóa Gemini và tìm thấy ${supportedModels.length} mô hình có thể tạo nội dung. Cần chạy thử tạo nội dung để xác nhận readiness.`,
        lastCheckedAt: now,
        generationReady: updated ? getCredentialTruth(updated).generationReady : false,
        httpStatus: safeStatus(response.status),
      });
    }
    const diagnostic = await classifyGeminiProviderResponse(response);
    return persistDiagnostic(credential, {
      status: diagnostic.category === 'INVALID_KEY' ? 'invalid'
        : diagnostic.category === 'PERMISSION_DENIED' ? 'missing_permission'
          : 'error',
      generationStatus: generationStatusFor(diagnostic.category),
      category: diagnostic.category,
      retryable: diagnostic.retryable,
      httpStatus: diagnostic.httpStatus,
      retryAfterMs: diagnostic.retryAfterMs,
      message: geminiDiagnosticMessage(diagnostic.category),
      probeType: 'light',
    });
  } catch (error) {
    const diagnostic = classifyGeminiProviderException(error);
    return persistDiagnostic(credential, {
      status: 'error', generationStatus: generationStatusFor(diagnostic.category),
      category: diagnostic.category, retryable: diagnostic.retryable,
      message: geminiDiagnosticMessage(diagnostic.category), probeType: 'light',
    });
  } finally {
    // Keep the complete key scoped to this server-side function only.
  }
}

export async function generationProbeCredential(id: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const credential = await getCredentialById(id);
  if (!credential || credential.platform !== 'gemini') return missingCredentialResult(id);
  const key = await getRawCredentialValue(id);
  if (!key) {
    return persistDiagnostic(credential, {
      status: 'invalid', generationStatus: 'invalid', category: 'INVALID_KEY', retryable: false,
      message: 'Không thể giải mã khóa Gemini. Hãy kiểm tra cấu hình mã hóa Token Vault.', probeType: 'generation',
    });
  }
  const supported = Array.isArray(credential.metadata?.supportedModels)
    ? credential.metadata.supportedModels.map(String)
    : [];
  const model = FREE_MODEL_ALLOWLIST
    .filter((entry) => entry.enabled && entry.taskTypesAllowed.includes('generation_probe'))
    .sort((left, right) => right.priority - left.priority || left.modelId.localeCompare(right.modelId))
    .find((entry) => supported.includes(entry.modelId));
  if (!model) {
    return persistDiagnostic(credential, {
      status: 'error', generationStatus: 'missing_permission', category: 'MODEL_NOT_AVAILABLE', retryable: false,
      message: 'Không có mô hình tạo nội dung trong danh sách an toàn được khóa này hỗ trợ. Hãy chạy kiểm tra khóa và xem cấu hình mô hình.',
      probeType: 'generation',
    });
  }

  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.modelId)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Chỉ trả về JSON chính xác: {"ok":true}' }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 24, temperature: 0 },
        }),
        signal: AbortSignal.timeout(model.timeoutMs),
      },
    );
    if (response.ok) {
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const output = data.candidates?.[0]?.content?.parts?.[0]?.text;
      let verified = false;
      try { verified = (JSON.parse(output || '{}') as { ok?: boolean }).ok === true; } catch { verified = false; }
      if (!verified) {
        return persistDiagnostic(credential, {
          status: 'error', generationStatus: 'transient_error', category: 'UNKNOWN_PROVIDER_ERROR', retryable: false,
          httpStatus: safeStatus(response.status), testedModel: model.modelId,
          message: 'Gemini đã phản hồi nhưng kết quả kiểm tra tối thiểu không đúng định dạng; khóa vẫn chưa sẵn sàng tạo nội dung.',
          probeType: 'generation',
        });
      }
      return persistSuccess(credential, model.modelId, safeStatus(response.status));
    }

    const diagnostic = await classifyGeminiProviderResponse(response);
    return persistDiagnostic(credential, {
      status: diagnostic.category === 'INVALID_KEY' ? 'invalid'
        : diagnostic.category === 'PERMISSION_DENIED' ? 'missing_permission'
          : 'error',
      generationStatus: generationStatusFor(diagnostic.category),
      category: diagnostic.category,
      retryable: diagnostic.retryable,
      httpStatus: diagnostic.httpStatus,
      retryAfterMs: diagnostic.retryAfterMs,
      testedModel: model.modelId,
      message: geminiDiagnosticMessage(diagnostic.category, model.modelId),
      probeType: 'generation',
    });
  } catch (error) {
    const diagnostic = classifyGeminiProviderException(error);
    return persistDiagnostic(credential, {
      status: 'error', generationStatus: generationStatusFor(diagnostic.category),
      category: diagnostic.category, retryable: diagnostic.retryable,
      testedModel: model.modelId, message: geminiDiagnosticMessage(diagnostic.category, model.modelId),
      probeType: 'generation',
    });
  }
}

interface PersistFailureInput {
  status: CredentialStatus;
  generationStatus: GeminiGenerationStatus;
  category: GeminiProviderErrorCategory;
  retryable: boolean;
  message: string;
  probeType: 'light' | 'generation';
  httpStatus?: number;
  retryAfterMs?: number;
  testedModel?: string;
}

async function persistDiagnostic(credential: StoredCredential, input: PersistFailureInput): Promise<ProbeResult> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const failureStreak = Number(credential.metadata?.failureStreak || 0) + 1;
  const cooldownMs = computeGeminiCooldownMs(input.category, failureStreak, input.retryAfterMs);
  const cooldownUntil = cooldownMs ? new Date(nowMs + cooldownMs).toISOString() : undefined;
  const generationProbe = input.probeType === 'generation';
  const metadata = {
    ...credential.metadata,
    provider: 'gemini',
    ...(input.probeType === 'light'
      ? { lightTestStatus: lightStatusFor(input.category), lastLightTestAt: now }
      : { lastGenerationTestAt: now }),
    ...(generationProbe ? { generationStatus: input.generationStatus, generationVerifiedAt: undefined } : {}),
    testedModel: input.testedModel,
    preferredModel: input.testedModel || credential.metadata?.preferredModel,
    providerHttpStatus: input.httpStatus,
    errorCategory: input.category,
    lastErrorCode: input.category,
    retryable: input.retryable,
    lastFailureAt: now,
    failureStreak,
    cooldownUntil,
    nextProbeAt: cooldownUntil,
    quotaExhaustedUntil: input.category === 'QUOTA_EXCEEDED' ? cooldownUntil : undefined,
  };
  await updateCredential(credential.id, {
    status: input.status,
    lastError: input.category,
    lastCheckedAt: now,
    metadata,
  });
  await updateCredentialGroup(credential, failureStreak, cooldownUntil, input.category);
  return buildResult(credential, {
    status: input.status,
    generationStatus: generationProbe ? input.generationStatus : asGenerationStatus(credential.metadata?.generationStatus),
    message: input.message,
    testedModel: input.testedModel,
    httpStatus: input.httpStatus,
    errorCategory: input.category,
    lastCheckedAt: now,
    cooldownUntil,
    retryable: input.retryable,
    generationReady: false,
  });
}

async function persistSuccess(credential: StoredCredential, testedModel: string, httpStatus?: number): Promise<ProbeResult> {
  const now = new Date().toISOString();
  await updateCredential(credential.id, {
    status: 'valid', lastError: undefined, lastCheckedAt: now,
    metadata: {
      ...credential.metadata,
      provider: 'gemini',
      generationStatus: 'available',
      preferredModel: testedModel,
      testedModel,
      providerHttpStatus: httpStatus,
      errorCategory: undefined,
      lastErrorCode: undefined,
      retryable: false,
      lastGenerationTestAt: now,
      generationVerifiedAt: now,
      lastSuccessfulRequestAt: now,
      failureStreak: 0,
      cooldownUntil: undefined,
      nextProbeAt: undefined,
      quotaExhaustedUntil: undefined,
    },
  });
  const group = typeof credential.metadata?.quotaGroupId === 'string' ? credential.metadata.quotaGroupId : undefined;
  if (group) await updateQuotaGroup(group, { cooldownUntil: undefined, quotaExhaustedUntil: undefined, failureStreak: 0 }, 'ACTIVE');
  const updated = await getSafeCredentialById(credential.id);
  const generationReady = updated ? getCredentialTruth(updated).generationReady : false;
  return buildResult(credential, {
    status: 'valid', generationStatus: 'available',
    message: `Đã tạo nội dung kiểm tra tối thiểu thành công với ${testedModel}. Khóa đủ điều kiện readiness nếu cấu hình hạn mức đã hoàn tất.`,
    testedModel, httpStatus, lastCheckedAt: now, generationReady,
  });
}

async function updateCredentialGroup(
    credential: StoredCredential,
    failureStreak: number,
    cooldownUntil: string | undefined,
    category: GeminiProviderErrorCategory,
): Promise<void> {
  const group = typeof credential.metadata?.quotaGroupId === 'string' ? credential.metadata.quotaGroupId : undefined;
  if (!group) return;
  await updateQuotaGroup(group, {
    cooldownUntil,
    quotaExhaustedUntil: category === 'QUOTA_EXCEEDED' ? cooldownUntil : undefined,
    failureStreak,
  }, 'DEGRADED');
}

function generationStatusFor(category: GeminiProviderErrorCategory): GeminiGenerationStatus {
  if (category === 'INVALID_KEY') return 'invalid';
  if (category === 'PERMISSION_DENIED' || category === 'MODEL_NOT_AVAILABLE' || category === 'REGION_RESTRICTED') return 'missing_permission';
  if (category === 'QUOTA_EXCEEDED') return 'quota_exhausted';
  if (category === 'RATE_LIMITED') return 'rate_limited';
  return 'transient_error';
}

function lightStatusFor(category: GeminiProviderErrorCategory): 'invalid' | 'missing_permission' | 'transient_error' {
  if (category === 'INVALID_KEY') return 'invalid';
  if (category === 'PERMISSION_DENIED' || category === 'MODEL_NOT_AVAILABLE' || category === 'REGION_RESTRICTED') return 'missing_permission';
  return 'transient_error';
}

function asGenerationStatus(value: unknown): GeminiGenerationStatus {
  const allowed: GeminiGenerationStatus[] = [
    'unchecked', 'available', 'rate_limited', 'quota_exhausted', 'cooldown',
    'transient_error', 'invalid', 'missing_permission', 'disabled',
  ];
  return allowed.includes(value as GeminiGenerationStatus) ? value as GeminiGenerationStatus : 'unchecked';
}

function buildResult(
    credential: StoredCredential,
    input: Partial<ProbeResult> & Pick<ProbeResult, 'status' | 'generationStatus' | 'message' | 'lastCheckedAt' | 'generationReady'>,
): ProbeResult {
  return {
    ...input,
    credentialId: credential.id,
    provider: 'gemini',
    testedModel: input.testedModel || null,
    httpStatus: input.httpStatus ?? null,
    errorCategory: input.errorCategory || null,
    cooldownUntil: input.cooldownUntil || null,
    retryable: input.retryable === true,
  };
}

function missingCredentialResult(id: string): ProbeResult {
  return {
    credentialId: id, provider: 'gemini', status: 'invalid', generationStatus: 'invalid',
    message: 'Không tìm thấy kết nối Gemini.', testedModel: null, httpStatus: null,
    errorCategory: 'INVALID_KEY', lastCheckedAt: new Date().toISOString(), cooldownUntil: null,
    retryable: false, generationReady: false,
  };
}

function safeStatus(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

export async function recoverDueGeminiCredentials(now = Date.now(), limit = 1): Promise<ProbeResult[]> {
  const due = (await listCredentials({ platform: 'gemini' }))
    .filter((credential) => credential.role !== 'disabled' && credential.metadata?.billingMode === 'free_confirmed')
    .filter((credential) => credential.metadata?.retryable === true)
    .filter((credential) => credential.metadata?.nextProbeAt && Date.parse(String(credential.metadata.nextProbeAt)) <= now)
    .sort((left, right) => Date.parse(String(left.metadata?.nextProbeAt)) - Date.parse(String(right.metadata?.nextProbeAt)))
    .slice(0, Math.max(0, limit));
  const results: ProbeResult[] = [];
  for (const credential of due) results.push(await generationProbeCredential(credential.id));
  return results;
}
