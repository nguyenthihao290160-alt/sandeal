import { createHash } from 'node:crypto';
import { findBotForCapability, getBotRegistryEntry } from './botRegistry';
import { createAutomationJob } from './store';
import type { AutomationExecutionPlanStep, AutomationJobType, AutomationRiskLevel, RequestedExecutionMode } from './types';

export const LEGACY_BOT_MODES = [
  'source_scan',
  'deal_hunt',
  'gemini_analysis',
  'content_review',
  'link_health',
  'cleanup',
  'score_only',
  'full_safe_run',
  'health_check',
  'cleanup_broken_products',
] as const;

export type LegacyBotMode = (typeof LEGACY_BOT_MODES)[number];
export type BotSource = 'local' | 'accesstrade' | 'manual' | 'all';

const MODE_CONFIG: Record<LegacyBotMode, { botId: string; capability: string; jobType: AutomationJobType; risk: AutomationRiskLevel }> = {
  source_scan: { botId: 'SOURCE_INTAKE', capability: 'INGEST_SOURCES', jobType: 'PRODUCT_SCAN', risk: 'MEDIUM' },
  deal_hunt: { botId: 'SCORING_ENGINE', capability: 'SCORE_PRODUCTS', jobType: 'SCORE_PRODUCTS', risk: 'MEDIUM' },
  gemini_analysis: { botId: 'EVIDENCE_GROUNDED_ANALYST', capability: 'ANALYZE_WITH_EVIDENCE', jobType: 'AI_ANALYSIS', risk: 'MEDIUM' },
  content_review: { botId: 'CONTENT_DRAFT_ASSISTANT', capability: 'PREPARE_CONTENT_DRAFT', jobType: 'PREPARE_CONTENT_DRAFT', risk: 'MEDIUM' },
  link_health: { botId: 'HEALTH_INSPECTOR', capability: 'INSPECT_PRODUCT_HEALTH', jobType: 'RECHECK_PRODUCT_HEALTH', risk: 'MEDIUM' },
  cleanup: { botId: 'HEALTH_INSPECTOR', capability: 'INSPECT_PRODUCT_HEALTH', jobType: 'RECHECK_PRODUCT_HEALTH', risk: 'MEDIUM' },
  score_only: { botId: 'SCORING_ENGINE', capability: 'SCORE_PRODUCTS', jobType: 'SCORE_PRODUCTS', risk: 'MEDIUM' },
  full_safe_run: { botId: 'OPERATIONS_ORCHESTRATOR', capability: 'ORCHESTRATE_OPERATIONS', jobType: 'AUTO_PILOT', risk: 'MEDIUM' },
  health_check: { botId: 'HEALTH_INSPECTOR', capability: 'INSPECT_PRODUCT_HEALTH', jobType: 'RECHECK_PRODUCT_HEALTH', risk: 'MEDIUM' },
  cleanup_broken_products: { botId: 'HEALTH_INSPECTOR', capability: 'INSPECT_PRODUCT_HEALTH', jobType: 'RECHECK_PRODUCT_HEALTH', risk: 'MEDIUM' },
};

export interface EnqueueBotRequest {
  actor: string;
  mode?: LegacyBotMode;
  botId?: string;
  capability?: string;
  source?: BotSource;
  limit?: number;
  trigger?: 'manual' | 'scheduler' | 'system' | 'dashboard';
  requestedExecutionMode?: RequestedExecutionMode;
  idempotencyKey?: string;
  operationId?: string;
  dryRun?: boolean;
}

function buildPlan(mode: LegacyBotMode, risk: AutomationRiskLevel): AutomationExecutionPlanStep[] {
  if (mode === 'full_safe_run') {
    return [
      { id: 'source-intake', capability: 'INGEST_SOURCES', dependsOn: [], reason: 'Tiếp nhận ứng viên từ nguồn đã cấu hình.', status: 'PENDING', risk: 'MEDIUM', approvalRequired: false, expectedWrite: ['product-review-queue'], externalCall: true, fallback: ['MANUAL_INPUT'] },
      { id: 'review-normalize-score', capability: 'NORMALIZE_AND_SCORE', dependsOn: ['source-intake'], reason: 'Chuẩn hóa, kiểm tra và chấm điểm ứng viên.', status: 'PENDING', risk: 'MEDIUM', approvalRequired: false, expectedWrite: ['products', 'product-scores'], externalCall: false, fallback: ['LOCAL_RULES', 'MANUAL_INPUT'] },
      { id: 'safe-publish-request', capability: 'REQUEST_SAFE_PUBLISH', dependsOn: ['review-normalize-score'], reason: 'Chỉ tạo SAFE_PUBLISH job riêng cho ứng viên đủ điều kiện.', status: 'PENDING', risk: 'HIGH', approvalRequired: true, expectedWrite: ['automation-jobs'], externalCall: false, fallback: ['MANUAL_INPUT'] },
    ];
  }
  const config = MODE_CONFIG[mode];
  return [{
    id: config.capability.toLowerCase().replaceAll('_', '-'),
    capability: config.capability,
    dependsOn: [],
    reason: 'Thực thi capability đã đăng ký qua worker bền vững.',
    status: 'PENDING',
    risk,
    approvalRequired: risk === 'HIGH',
    expectedWrite: config.jobType === 'RECHECK_PRODUCT_HEALTH' ? ['product-health'] : config.jobType === 'AI_ANALYSIS' ? ['analysis-drafts'] : ['automation-results'],
    externalCall: ['PRODUCT_SCAN', 'RECHECK_PRODUCT_HEALTH', 'AI_ANALYSIS'].includes(config.jobType),
    fallback: ['LOCAL_RULES', 'LOCAL_TEMPLATE', 'MANUAL_INPUT'],
  }];
}

function generatedIdempotencyKey(input: EnqueueBotRequest, mode: LegacyBotMode): string {
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const digest = createHash('sha256').update(JSON.stringify({ actor: input.actor, mode, source: input.source, limit: input.limit, requestedExecutionMode: input.requestedExecutionMode, dryRun: input.dryRun, bucket })).digest('hex').slice(0, 24);
  return `bot:${mode}:${digest}`;
}

export async function enqueueBotExecution(input: EnqueueBotRequest) {
  const mode = input.mode || 'full_safe_run';
  if (!LEGACY_BOT_MODES.includes(mode)) throw new Error('INVALID_BOT_MODE');
  const modeConfig = MODE_CONFIG[mode];
  const registry = input.botId
    ? getBotRegistryEntry(input.botId)
    : input.capability
      ? findBotForCapability(input.capability)
      : getBotRegistryEntry(modeConfig.botId);
  if (!registry || !registry.enabled) throw new Error('BOT_NOT_AVAILABLE');
  if (registry.jobType && registry.jobType !== modeConfig.jobType && (input.botId || input.capability)) throw new Error('CAPABILITY_JOB_TYPE_MISMATCH');

  const requestedExecutionMode = input.requestedExecutionMode || registry.defaultExecutionMode;
  if (requestedExecutionMode === 'MANUAL_ONLY' && !registry.manualSupported) throw new Error('MANUAL_MODE_NOT_SUPPORTED');
  const source = input.source || 'accesstrade';
  if (!['local', 'accesstrade', 'manual', 'all'].includes(source)) throw new Error('INVALID_BOT_SOURCE');
  const limit = Math.max(1, Math.min(30, Math.floor(input.limit || 10)));
  const risk = input.dryRun ? 'LOW' : modeConfig.risk;
  const executionPlan = buildPlan(mode, risk);

  return createAutomationJob({
    type: modeConfig.jobType,
    payload: { mode, source, limit, trigger: input.trigger || 'manual' },
    priority: mode === 'full_safe_run' ? 70 : 50,
    idempotencyKey: input.idempotencyKey || generatedIdempotencyKey(input, mode),
    operationId: input.operationId,
    requestedBy: input.actor,
    riskLevel: risk,
    dryRun: input.dryRun === true,
    maxAttempts: registry.maxAttempts,
    approvalReason: risk === 'HIGH' ? 'Capability có side effect rủi ro cao và cần phê duyệt server-side.' : undefined,
    botId: registry.id,
    capability: registry.capability,
    requestedExecutionMode,
    executionPlan,
  });
}
