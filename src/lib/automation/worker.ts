import { runAutoPilot } from '@/lib/bots/autoPilotRunner';
import { buildDashboardProducts } from '@/lib/dashboard/products';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { getProductById, getAllProducts, publishCanonicalProductTransaction } from '@/lib/storage/products';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';
import {
  canUseCircuit,
  claimAutomationJobs,
  completeAutomationJob,
  failAutomationJob,
  getAutomationControl,
  getAutomationJob,
  heartbeatAutomationJob,
  recordCircuitResult,
  updateAutomationControl,
} from './store';
import type { AutomationJob } from './types';

export interface WorkerRunResult {
  workerId: string;
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|abort/i.test(message)) return 'TIMEOUT';
  if (/429|rate.?limit/i.test(message)) return 'RATE_LIMITED';
  if (/network|fetch|socket/i.test(message)) return 'NETWORK_ERROR';
  if (/credential|api.?key|configuration/i.test(message)) return 'CONFIGURATION_REQUIRED';
  if (/budget|quota|limit/i.test(message)) return 'AI_BUDGET_EXCEEDED';
  if (/validation|invalid/i.test(message)) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

async function dryRunPreview(job: AutomationJob): Promise<Record<string, unknown>> {
  const products = await getAllProducts();
  const requestedLimit = Number(job.payload.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 10;
  const selected = products.slice(0, limit);
  const dashboard = buildDashboardProducts(selected, { sort: 'updated_desc', page: 1, pageSize: 50 });
  return {
    preview: true,
    inspected: selected.length,
    qualified: dashboard.summary.qualifiedForPublish,
    needsReview: dashboard.summary.needsReview,
    blocked: dashboard.summary.blocked + dashboard.summary.rejectedItems,
    estimatedAiRequests: job.type === 'AI_ANALYSIS' ? selected.length : 0,
    requiresApproval: job.riskLevel === 'HIGH',
    businessDataChanged: false,
    externalSideEffect: false,
  };
}

async function executeJob(job: AutomationJob): Promise<Record<string, unknown>> {
  if (job.dryRun) return dryRunPreview(job);
  const control = await getAutomationControl();
  if (control.killSwitch) throw new Error('KILL_SWITCH_ACTIVE');

  if (job.type === 'HEALTH_CHECK') {
    const products = await getAllProducts();
    return { checkedAt: new Date().toISOString(), productCount: products.length, businessDataChanged: false };
  }

  if (job.type === 'SAFE_PUBLISH') {
    if (job.approvalStatus !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
    const productId = typeof job.payload.productId === 'string' ? job.payload.productId : '';
    const product = await getProductById(productId);
    if (!product) throw new Error('VALIDATION_PRODUCT_NOT_FOUND');
    const published = await publishCanonicalProductTransaction(productId, { status: 'published' }, {
      actor: job.approvedBy || job.requestedBy,
      approval: true,
      dryRun: false,
      idempotencyKey: job.idempotencyKey,
      runId: job.operationId,
    });
    if (!published || published.status !== 'published') throw new Error('SAFE_PUBLISH_BLOCKED');
    return { productId, status: published.status, publishedAt: published.publishedAt || null };
  }

  if (job.type === 'AI_ANALYSIS') {
    const settings = await getAutomationSettings();
    if (!settings.freeOnly || settings.allowPaidAi) throw new Error('PAID_PROVIDER_BLOCKED');
    const credential = await getPrimaryCredential('gemini');
    if (!credential || credential.status !== 'valid') throw new Error('CONFIGURATION_REQUIRED');
    const estimate = Math.max(1, Math.min(10, Number(job.payload.limit) || 1));
    const circuit = await canUseCircuit('gemini');
    if (!circuit.allowed) throw new Error('CIRCUIT_OPEN');
    // Reserve usage only at the future provider call boundary; no provider is called here.
    void estimate;
    throw new Error('AI_HANDLER_UNAVAILABLE');
  }

  const circuit = await canUseCircuit('autopilot');
  if (!circuit.allowed) throw new Error('CIRCUIT_OPEN');
  try {
    const result = await runAutoPilot({
      mode: job.type === 'PRODUCT_SCAN' ? 'source_scan' : 'full_safe_run',
      trigger: job.requestedBy === 'scheduler' ? 'scheduler' : 'dashboard',
    });
    if (result.status !== 'completed') throw new Error(result.error || result.message || 'AUTOPILOT_NOT_COMPLETED');
    await recordCircuitResult('autopilot', true);
    return { runId: result.runId, summary: result.summary, durationMs: result.durationMs || 0 };
  } catch (error) {
    if (['TIMEOUT', 'RATE_LIMITED', 'NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorCode(error))) {
      await recordCircuitResult('autopilot', false);
    }
    throw error;
  }
}

export async function processAutomationBatch(workerId: string, limit = 2): Promise<WorkerRunResult> {
  const result: WorkerRunResult = { workerId, claimed: 0, succeeded: 0, failed: 0, skipped: 0 };
  await updateAutomationControl({ workerHeartbeatAt: new Date().toISOString(), workerId }, workerId);
  const claimed = await claimAutomationJobs(workerId, limit);
  result.claimed = claimed.length;

  for (const job of claimed) {
    const freshControl = await getAutomationControl();
    if (freshControl.killSwitch) {
      await failAutomationJob(job.id, workerId, 'KILL_SWITCH_ACTIVE', 'Dừng khẩn cấp đang được bật.');
      result.skipped += 1;
      continue;
    }
    await updateAutomationControl({ workerHeartbeatAt: new Date().toISOString(), workerId, workerCurrentJobId: job.id }, workerId);
    const heartbeat = setInterval(() => { void heartbeatAutomationJob(job.id, workerId); }, 20_000);
    try {
      const output = await executeJob(job);
      const latest = await getAutomationJob(job.id);
      if (latest?.status === 'CANCELLED') { result.skipped += 1; continue; }
      const completed = await completeAutomationJob(job.id, workerId, output);
      if (completed) result.succeeded += 1; else result.skipped += 1;
    } catch (error) {
      await failAutomationJob(job.id, workerId, errorCode(error), error);
      result.failed += 1;
    } finally {
      clearInterval(heartbeat);
      await updateAutomationControl({ workerHeartbeatAt: new Date().toISOString(), workerId, workerCurrentJobId: undefined }, workerId);
    }
  }
  return result;
}
