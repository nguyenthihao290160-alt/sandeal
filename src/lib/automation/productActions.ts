import { createHash } from 'node:crypto';
import { evaluateSafePublish } from '@/lib/safePublish';
import { getProductById, publicationIdempotencyKey } from '@/lib/storage/products';
import { createAutomationJob, publicAutomationJob } from './store';
import type { AutomationExecutionPlanStep, AutomationJobType, AutomationRiskLevel } from './types';

export type ProductAutomationAction = 'health' | 'link' | 'image' | 'score' | 'content' | 'archive' | 'safe_publish';

const ACTIONS: Record<ProductAutomationAction, { type: AutomationJobType; capability: string; botId: string; risk: AutomationRiskLevel; expectedWrite: string[]; externalCall: boolean }> = {
  health: { type: 'RECHECK_PRODUCT_HEALTH', capability: 'INSPECT_PRODUCT_HEALTH', botId: 'HEALTH_INSPECTOR', risk: 'MEDIUM', expectedWrite: ['product-health'], externalCall: true },
  link: { type: 'RECHECK_PRODUCT_HEALTH', capability: 'INSPECT_PRODUCT_HEALTH', botId: 'HEALTH_INSPECTOR', risk: 'MEDIUM', expectedWrite: ['product-health'], externalCall: true },
  image: { type: 'RECHECK_PRODUCT_HEALTH', capability: 'INSPECT_PRODUCT_HEALTH', botId: 'HEALTH_INSPECTOR', risk: 'MEDIUM', expectedWrite: ['product-health'], externalCall: true },
  score: { type: 'SCORE_PRODUCTS', capability: 'SCORE_PRODUCTS', botId: 'SCORING_ENGINE', risk: 'MEDIUM', expectedWrite: ['product-scores'], externalCall: false },
  content: { type: 'PREPARE_CONTENT_DRAFT', capability: 'PREPARE_CONTENT_DRAFT', botId: 'CONTENT_DRAFT_ASSISTANT', risk: 'MEDIUM', expectedWrite: ['content-drafts'], externalCall: false },
  archive: { type: 'BULK_PRODUCT_OPERATION', capability: 'ARCHIVE_PRODUCT', botId: 'OPERATIONS_ORCHESTRATOR', risk: 'HIGH', expectedWrite: ['products'], externalCall: false },
  safe_publish: { type: 'SAFE_PUBLISH', capability: 'ENFORCE_SAFETY_POLICY', botId: 'POLICY_SAFETY_GUARD', risk: 'HIGH', expectedWrite: ['products', 'automation-audit'], externalCall: false },
};

function actionKey(actor: string, action: ProductAutomationAction, productId: string): string {
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const digest = createHash('sha256').update(`${actor}:${action}:${productId}:${bucket}`).digest('hex').slice(0, 20);
  return `product:${action}:${digest}`;
}

export async function enqueueProductAction(input: {
  actor: string;
  action: ProductAutomationAction;
  productId?: string;
  productIds?: string[];
  idempotencyKey?: string;
  operationId?: string;
  dryRun?: boolean;
  reason?: string;
  limit?: number;
}) {
  const config = ACTIONS[input.action];
  const ids = [...new Set([...(input.productIds || []), ...(input.productId ? [input.productId] : [])].map(value => value.trim()).filter(Boolean))].slice(0, 100);
  if (ids.length) {
    const products = await Promise.all(ids.map(getProductById));
    if (products.some(product => !product)) throw new Error('PRODUCT_NOT_FOUND');
  }
  if (input.action !== 'health' && !ids.length) throw new Error('PRODUCT_ID_REQUIRED');
  const product = input.action === 'safe_publish' ? await getProductById(ids[0]) : null;
  if (input.action === 'safe_publish' && product) {
    const evaluation = evaluateSafePublish(product);
    if (!evaluation.eligible) throw new Error(`SAFE_PUBLISH_NOT_READY:${evaluation.reasons.join(',')}`);
  }
  const target = ids[0] || 'all';
  const idempotencyKey = input.idempotencyKey
    || (input.action === 'safe_publish' && product ? `safe-publish:${publicationIdempotencyKey(product)}` : actionKey(input.actor, input.action, target));
  const payload: Record<string, unknown> = {
    productIds: ids,
    limit: Math.max(1, Math.min(100, Math.floor(input.limit || (ids.length || 50)))),
  };
  if (input.action === 'link' || input.action === 'image') payload.healthTarget = input.action;
  if (input.action === 'archive') { payload.action = 'archive'; payload.reason = input.reason || 'manual_archive_request'; }
  if (input.action === 'safe_publish') payload.productId = ids[0];
  const plan: AutomationExecutionPlanStep[] = [{
    id: input.action.replace('_', '-'),
    capability: config.capability,
    dependsOn: [],
    reason: input.reason || `Yêu cầu ${input.action} từ Product Operations.`,
    status: 'PENDING',
    risk: input.dryRun ? 'LOW' : config.risk,
    approvalRequired: !input.dryRun && config.risk === 'HIGH',
    expectedWrite: config.expectedWrite,
    externalCall: config.externalCall,
    fallback: config.externalCall ? ['LOCAL_RULES', 'MANUAL_INPUT'] : ['LOCAL_RULES'],
  }];
  const result = await createAutomationJob({
    type: config.type,
    payload,
    idempotencyKey,
    operationId: input.operationId,
    requestedBy: input.actor,
    riskLevel: input.dryRun ? 'LOW' : config.risk,
    dryRun: input.dryRun === true,
    maxAttempts: config.externalCall ? 3 : 1,
    approvalReason: config.risk === 'HIGH' && !input.dryRun ? input.reason || 'Thao tác thay đổi trạng thái public cần phê duyệt.' : undefined,
    botId: config.botId,
    capability: config.capability,
    requestedExecutionMode: 'LOCAL_ONLY',
    executionPlan: plan,
  });
  return {
    ...result,
    data: {
      job: publicAutomationJob(result.job),
      jobId: result.job.id,
      operationId: result.job.operationId,
      trackingRoute: `/api/automation/jobs/${result.job.id}`,
    },
  };
}
