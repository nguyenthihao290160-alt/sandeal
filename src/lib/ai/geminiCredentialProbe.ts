import type { CredentialStatus, StoredCredential } from '../types/tokenVault';
import { getCredentialById, getRawCredentialValue, listCredentials, updateCredential } from '../storage/tokenVault';
import { FREE_MODEL_ALLOWLIST } from './geminiModels';
import { updateQuotaGroup } from './geminiQuotaGroupManager';

export interface ProbeResult { status: CredentialStatus; generationStatus: string; message: string; credentialId: string; }

export async function lightTestCredential(id: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const credential = await getCredentialById(id);
  if (!credential || credential.platform !== 'gemini') return { status: 'invalid', generationStatus: 'invalid', message: 'Gemini credential không tồn tại.', credentialId: id };
  const key = await getRawCredentialValue(id); if (!key) return persist(credential, 'invalid', 'invalid', 'Không thể giải mã credential.');
  try {
    const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000) }); const now = new Date().toISOString();
    if (response.ok) {
      const data = await response.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
      const supportedModels = (data.models || []).filter((model) => (model.supportedGenerationMethods || []).some((method) => ['generateContent', 'embedContent'].includes(method))).map((model) => String(model.name || '').replace(/^models\//, '')).filter(Boolean);
      await updateCredential(id, { status: 'valid', lastError: undefined, lastCheckedAt: now, metadata: { ...credential.metadata, lightTestStatus: 'available', lastLightTestAt: now, supportedModels } });
      return { status: 'valid', generationStatus: String(credential.metadata?.generationStatus || 'unchecked'), message: 'Light Test thành công.', credentialId: id };
    }
    const status: CredentialStatus = response.status === 401 ? 'invalid' : response.status === 403 ? 'missing_permission' : 'error';
    await updateCredential(id, { status, lastError: `Light Test HTTP ${response.status}.`, lastCheckedAt: now, metadata: { ...credential.metadata, lightTestStatus: status === 'invalid' ? 'invalid' : status === 'missing_permission' ? 'missing_permission' : 'transient_error', lastLightTestAt: now } });
    return { status, generationStatus: String(credential.metadata?.generationStatus || 'unchecked'), message: `Light Test HTTP ${response.status}.`, credentialId: id };
  } catch { return persist(credential, 'error', 'transient_error', 'Light Test transient error.'); }
}

export async function generationProbeCredential(id: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const credential = await getCredentialById(id);
  if (!credential || credential.platform !== 'gemini') return { status: 'invalid', generationStatus: 'invalid', message: 'Gemini credential không tồn tại.', credentialId: id };
  const key = await getRawCredentialValue(id);
  if (!key) return persist(credential, 'invalid', 'invalid', 'Không thể giải mã credential.');
  const supported = Array.isArray(credential.metadata?.supportedModels) ? credential.metadata.supportedModels.map(String) : [];
  const model = FREE_MODEL_ALLOWLIST.filter((entry) => entry.role === 'BULK_WORKER' && entry.taskTypesAllowed.includes('generation_probe')).sort((a, b) => b.priority - a.priority).find((entry) => supported.includes(entry.modelId));
  if (!model) return persist(credential, 'missing_permission', 'missing_permission', 'Không có model Free allowlisted đã được Light Test xác nhận.');
  try {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model.modelId}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Return exactly {"ok":true}' }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16 } }), signal: AbortSignal.timeout(model.timeoutMs) });
    if (response.ok) {
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const output = data.candidates?.[0]?.content?.parts?.[0]?.text;
      try { if ((JSON.parse(output || '{}') as { ok?: boolean }).ok !== true) throw new Error('invalid'); } catch { return persist(credential, 'error', 'transient_error', 'Generation probe không trả strict JSON.'); }
      return persist(credential, 'valid', 'available', 'Generation probe thành công.', model.modelId);
    }
    if (response.status === 429) return persist(credential, 'error', 'quota_exhausted', 'Free quota đang tạm hết.');
    if (response.status === 401) return persist(credential, 'invalid', 'invalid', 'Credential không hợp lệ.');
    if (response.status === 403) return persist(credential, 'missing_permission', 'missing_permission', 'Credential thiếu quyền generation.');
    return persist(credential, 'error', response.status >= 500 ? 'transient_error' : 'transient_error', `Generation probe HTTP ${response.status}.`);
  } catch (error) {
    return persist(credential, 'error', 'transient_error', error instanceof Error && error.name === 'AbortError' ? 'Generation probe timeout.' : 'Generation probe transient error.');
  }
}

async function persist(credential: StoredCredential, status: CredentialStatus, generationStatus: string, message: string, preferredModel?: string): Promise<ProbeResult> {
  const now = new Date().toISOString();
  const delayMs = generationStatus === 'quota_exhausted' ? 60 * 60_000 : generationStatus === 'transient_error' ? 15 * 60_000 : 0;
  const nextProbeAt = delayMs ? new Date(Date.now() + delayMs).toISOString() : undefined;
  await updateCredential(credential.id, { status, lastError: status === 'valid' ? undefined : message, lastCheckedAt: now, metadata: { ...credential.metadata, generationStatus, preferredModel: preferredModel || credential.metadata?.preferredModel, lastGenerationTestAt: now, lastSuccessfulRequestAt: status === 'valid' ? now : credential.metadata?.lastSuccessfulRequestAt, lastFailureAt: status === 'valid' ? credential.metadata?.lastFailureAt : now, nextProbeAt, cooldownUntil: nextProbeAt, quotaExhaustedUntil: generationStatus === 'quota_exhausted' ? nextProbeAt : credential.metadata?.quotaExhaustedUntil, failureStreak: status === 'valid' ? 0 : Number(credential.metadata?.failureStreak || 0) + 1 } });
  const group = typeof credential.metadata?.quotaGroupId === 'string' ? credential.metadata.quotaGroupId : undefined;
  if (group) await updateQuotaGroup(group, { cooldownUntil: nextProbeAt, quotaExhaustedUntil: generationStatus === 'quota_exhausted' ? nextProbeAt : undefined, failureStreak: status === 'valid' ? 0 : Number(credential.metadata?.failureStreak || 0) + 1 }, status === 'valid' ? 'ACTIVE' : 'DEGRADED');
  return { status, generationStatus, message, credentialId: credential.id };
}

export async function recoverDueGeminiCredentials(now = Date.now(), limit = 1): Promise<ProbeResult[]> {
  const due = (await listCredentials({ platform: 'gemini' }))
    .filter((credential) => credential.role !== 'disabled' && credential.metadata?.billingMode === 'free_confirmed')
    .filter((credential) => credential.metadata?.nextProbeAt && Date.parse(String(credential.metadata.nextProbeAt)) <= now)
    .sort((a, b) => Date.parse(String(a.metadata?.nextProbeAt)) - Date.parse(String(b.metadata?.nextProbeAt))).slice(0, Math.max(0, limit));
  const results: ProbeResult[] = []; for (const credential of due) results.push(await generationProbeCredential(credential.id)); return results;
}
