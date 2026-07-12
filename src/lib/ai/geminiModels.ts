export type GeminiModelRole = 'BULK_WORKER' | 'EDITORIAL_WRITER' | 'EXPERT_ADJUDICATOR' | 'SEMANTIC_DEDUP';
export type GeminiTaskType = 'structured_extraction' | 'category_mapping' | 'metadata_repair' | 'editorial_review' | 'originality_repair' | 'seo_repair' | 'adjudication' | 'embedding' | 'generation_probe';

export interface FreeModelAllowlistEntry {
  modelId: string;
  role: GeminiModelRole;
  enabled: boolean;
  stableRequired: boolean;
  freeTierConfirmed: boolean;
  freeTierVerifiedAt: string;
  verificationExpiresAt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  dailyRequestBudget: number;
  taskTypesAllowed: GeminiTaskType[];
  priority: number;
}

const VERIFIED_AT = '2026-07-12T00:00:00.000Z';
const EXPIRES_AT = '2026-10-10T00:00:00.000Z';

export const FREE_MODEL_ALLOWLIST: readonly FreeModelAllowlistEntry[] = [
  { modelId: 'gemini-3.1-flash-lite', role: 'BULK_WORKER', enabled: true, stableRequired: true, freeTierConfirmed: true, freeTierVerifiedAt: VERIFIED_AT, verificationExpiresAt: EXPIRES_AT, maxInputTokens: 32_000, maxOutputTokens: 2_048, timeoutMs: 20_000, dailyRequestBudget: 200, taskTypesAllowed: ['structured_extraction', 'category_mapping', 'metadata_repair', 'generation_probe'], priority: 100 },
  { modelId: 'gemini-2.5-flash-lite', role: 'BULK_WORKER', enabled: true, stableRequired: true, freeTierConfirmed: true, freeTierVerifiedAt: VERIFIED_AT, verificationExpiresAt: EXPIRES_AT, maxInputTokens: 32_000, maxOutputTokens: 2_048, timeoutMs: 20_000, dailyRequestBudget: 200, taskTypesAllowed: ['structured_extraction', 'category_mapping', 'metadata_repair', 'generation_probe'], priority: 90 },
  { modelId: 'gemini-3.5-flash', role: 'EDITORIAL_WRITER', enabled: true, stableRequired: true, freeTierConfirmed: true, freeTierVerifiedAt: VERIFIED_AT, verificationExpiresAt: EXPIRES_AT, maxInputTokens: 64_000, maxOutputTokens: 8_192, timeoutMs: 40_000, dailyRequestBudget: 100, taskTypesAllowed: ['editorial_review', 'originality_repair', 'seo_repair', 'generation_probe'], priority: 100 },
  { modelId: 'gemini-2.5-flash', role: 'EDITORIAL_WRITER', enabled: true, stableRequired: true, freeTierConfirmed: true, freeTierVerifiedAt: VERIFIED_AT, verificationExpiresAt: EXPIRES_AT, maxInputTokens: 64_000, maxOutputTokens: 8_192, timeoutMs: 40_000, dailyRequestBudget: 100, taskTypesAllowed: ['editorial_review', 'originality_repair', 'seo_repair', 'generation_probe'], priority: 90 },
  { modelId: 'gemini-2.5-pro', role: 'EXPERT_ADJUDICATOR', enabled: true, stableRequired: true, freeTierConfirmed: true, freeTierVerifiedAt: VERIFIED_AT, verificationExpiresAt: EXPIRES_AT, maxInputTokens: 64_000, maxOutputTokens: 8_192, timeoutMs: 60_000, dailyRequestBudget: 3, taskTypesAllowed: ['adjudication'], priority: 100 },
  { modelId: 'gemini-embedding-001', role: 'SEMANTIC_DEDUP', enabled: true, stableRequired: true, freeTierConfirmed: true, freeTierVerifiedAt: VERIFIED_AT, verificationExpiresAt: EXPIRES_AT, maxInputTokens: 8_192, maxOutputTokens: 0, timeoutMs: 20_000, dailyRequestBudget: 50, taskTypesAllowed: ['embedding'], priority: 100 },
] as const;

export interface TaskProfile {
  taskType: GeminiTaskType;
  riskLevel: 'low' | 'medium' | 'high';
  complexityScore: number;
  factCount: number;
  inputTokenEstimate: number;
  candidateLane: string;
  priority: number;
  previousFailures: number;
  requiredQuality: number;
  adjudicationRequired?: boolean;
}

export function discoverAllowedModels(availableModelIds: string[], now = Date.now()): FreeModelAllowlistEntry[] {
  const available = new Set(availableModelIds.map((id) => id.replace(/^models\//, '')));
  return FREE_MODEL_ALLOWLIST.filter((entry) => entry.enabled && entry.freeTierConfirmed && Date.parse(entry.verificationExpiresAt) > now && available.has(entry.modelId));
}

export function routeModel(profile: TaskProfile, availableModelIds: string[], now = Date.now()): FreeModelAllowlistEntry | null {
  if (profile.taskType === 'adjudication' && !profile.adjudicationRequired) return null;
  const candidates = discoverAllowedModels(availableModelIds, now)
    .filter((entry) => entry.taskTypesAllowed.includes(profile.taskType))
    .filter((entry) => profile.complexityScore <= 30 ? entry.role === 'BULK_WORKER' : profile.complexityScore <= 100 ? entry.role !== 'BULK_WORKER' : false)
    .sort((a, b) => b.priority - a.priority);
  return candidates[0] || null;
}
