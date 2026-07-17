import { createHash } from 'node:crypto';
import { getBotRegistryEntry } from './botRegistry';
import { getAutomationPolicy } from './policyRegistry';
import { createAutomationJob } from './store';
import type { AutomationJobType, RequestedExecutionMode } from './types';

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

const MODE_JOB_TYPE: Record<LegacyBotMode, AutomationJobType> = {
  source_scan: 'PRODUCT_SCAN',
  deal_hunt: 'SCORE_PRODUCTS',
  gemini_analysis: 'AI_ANALYSIS',
  content_review: 'PREPARE_CONTENT_DRAFT',
  link_health: 'RECHECK_PRODUCT_HEALTH',
  cleanup: 'RECHECK_PRODUCT_HEALTH',
  score_only: 'SCORE_PRODUCTS',
  full_safe_run: 'AUTO_PILOT',
  health_check: 'RECHECK_PRODUCT_HEALTH',
  cleanup_broken_products: 'RECHECK_PRODUCT_HEALTH',
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

function generatedIdempotencyKey(input: EnqueueBotRequest, mode: LegacyBotMode): string {
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const digest = createHash('sha256').update(JSON.stringify({ actor: input.actor, mode, source: input.source, limit: input.limit, requestedExecutionMode: input.requestedExecutionMode, dryRun: input.dryRun, bucket })).digest('hex').slice(0, 24);
  return `bot:${mode}:${digest}`;
}

export async function enqueueBotExecution(input: EnqueueBotRequest) {
  const mode = input.mode || 'full_safe_run';
  if (!LEGACY_BOT_MODES.includes(mode)) throw new Error('INVALID_BOT_MODE');
  const jobType = MODE_JOB_TYPE[mode];
  const policy = getAutomationPolicy(jobType);
  const registry = getBotRegistryEntry(policy.botId);
  if (!registry || !registry.enabled) throw new Error('BOT_NOT_AVAILABLE');
  if (input.botId && input.botId !== policy.botId) throw new Error('CAPABILITY_JOB_TYPE_MISMATCH');
  if (input.capability && input.capability !== policy.capability) throw new Error('CAPABILITY_JOB_TYPE_MISMATCH');

  const requestedExecutionMode = input.requestedExecutionMode || registry.defaultExecutionMode;
  if (requestedExecutionMode === 'MANUAL_ONLY' && !registry.manualSupported) throw new Error('MANUAL_MODE_NOT_SUPPORTED');
  const source = input.source || 'accesstrade';
  if (!['local', 'accesstrade', 'manual', 'all'].includes(source)) throw new Error('INVALID_BOT_SOURCE');
  const limit = Math.max(1, Math.min(30, Math.floor(input.limit || 10)));
  return createAutomationJob({
    type: jobType,
    payload: { mode, source, limit, trigger: input.trigger || 'manual' },
    priority: mode === 'full_safe_run' ? 70 : 50,
    idempotencyKey: input.idempotencyKey || generatedIdempotencyKey(input, mode),
    operationId: input.operationId,
    requestedBy: input.actor,
    riskLevel: policy.defaultRisk,
    dryRun: input.dryRun === true,
    maxAttempts: registry.maxAttempts,
    approvalReason: policy.approvalMode === 'REQUIRED' ? 'Policy yêu cầu phê duyệt server-side.' : undefined,
    botId: policy.botId,
    capability: policy.capability,
    requestedExecutionMode,
  });
}
