import { config } from '@/lib/config';
import { classifyRecord } from '@/lib/autonomous/recordClassification';
import { getAllAutomationJobs, getAutomationControl } from '@/lib/automation/store';
import type { AutomationJob } from '@/lib/automation/types';
import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { readCollection } from '@/lib/storage/adapter';
import { getProductById } from '@/lib/storage/products';
import type { Product } from '@/lib/types';
import { evaluateProductEligibility } from '@/lib/productEligibility';

export type ProductAdminActionType = 'reviewed' | 'data_verified' | 'canary_ready' | 'safe_publish_requested' | 'publish_approved';
export interface ProductAdminActionRecord {
  id: string;
  productId: string;
  action: ProductAdminActionType;
  actor: string;
  operationId: string;
  reason: string | null;
  evidence: Record<string, unknown>;
  occurredAt: string;
}

function jobTargetsProduct(job: AutomationJob, product: Product): boolean {
  if (product.relatedJobId === job.id) return true;
  if (job.payload.productId === product.id) return true;
  return Array.isArray(job.payload.productIds) && job.payload.productIds.map(String).includes(product.id);
}

function health(value: string | undefined, hasValue: boolean): string {
  if (!hasValue) return 'MISSING';
  if (['ok', 'redirect_ok', 'HEALTHY', 'FRESH'].includes(String(value || ''))) return 'HEALTHY';
  if (['broken', 'not_found', 'invalid_image', 'image_broken', 'UNAVAILABLE', 'CONFLICTED', 'ANOMALOUS'].includes(String(value || ''))) return 'UNHEALTHY';
  return 'UNVERIFIED';
}

export function buildProductPipelineTruth(input: {
  product: Product;
  jobs: AutomationJob[];
  actions: ProductAdminActionRecord[];
  launchEnabled: boolean;
  effectiveMode: string;
  now: number;
}) {
  const { product, now } = input;
  const classification = product.classification || classifyRecord(product as unknown as Record<string, unknown>);
  const eligibility = evaluateProductEligibility(product, now);
  const actions = input.actions.filter(item => item.productId === product.id);
  const hasAction = (action: ProductAdminActionType) => actions.some(item => item.action === action);
  const criticalBlockers = eligibility.criticalBlockers;
  const blockers = [...new Set([...criticalBlockers, ...eligibility.warningBlockers, ...(product.dataIssues || [])])];
  const productJobs = input.jobs.filter(job => jobTargetsProduct(job, product)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const activeJob = productJobs.find(job => ['PENDING', 'RUNNING', 'RETRY_SCHEDULED', 'WAITING_APPROVAL', 'WAITING_FOR_MANUAL_INPUT', 'WAITING_CHILDREN'].includes(job.status)) || productJobs[0];
  const staleRunning = Boolean(activeJob?.status === 'RUNNING' && (!activeJob.leaseExpiresAt || Date.parse(activeJob.leaseExpiresAt) <= now || (activeJob.heartbeatAt && now - Date.parse(activeJob.heartbeatAt) > 90_000)));
  const status = staleRunning ? 'STALE' : activeJob?.status || null;
  const reviewed = hasAction('reviewed');
  const dataVerified = hasAction('data_verified');
  const canaryReady = hasAction('canary_ready') && eligibility.eligibleForCanary;
  const safePublishRequested = hasAction('safe_publish_requested');
  const publishApproved = hasAction('publish_approved');
  const publishingEnabled = config.allowPublishingApi && config.autoPublishEnabled && input.launchEnabled && ['CANARY', 'AUTONOMOUS'].includes(input.effectiveMode);
  const published = eligibility.eligibleForPublic && Boolean(product.publishedAt || product.publicationEffectKey);
  const requiredAction = classification.recordType !== 'PRODUCT' ? 'MANUAL_CLASSIFICATION_DECISION'
    : criticalBlockers.length ? eligibility.nextRequiredAction
      : !reviewed ? 'MARK_REVIEWED'
        : !dataVerified ? 'VERIFY_DATA'
          : !canaryReady ? 'MARK_CANARY_READY'
            : !safePublishRequested ? 'REQUEST_SAFE_PUBLISH_CHECK' : publishingEnabled && !publishApproved ? 'PUBLISH_APPROVAL_REQUIRED' : null;
  return {
    productId: product.id,
    classification: { type: classification.recordType, confidence: classification.confidence ?? null, reasonCodes: classification.reasons || [] },
    lifecycle: {
      stage: product.lifecycleState || 'STAGED', blockers, reviewed, dataVerified, canaryReady,
      safePublishRequested, publishApproved, published, publicHidden: product.publicHidden !== false,
    },
    automation: {
      currentJobId: activeJob?.id || null, status, attempts: activeJob?.attemptCount || 0,
      maxAttempts: activeJob?.maxAttempts ?? null, nextRetryAt: activeJob?.nextRetryAt || null,
      workerOwner: activeJob?.claimedBy || null, lastRunAt: activeJob?.startedAt || null,
      lastSuccessAt: productJobs.find(job => job.status === 'SUCCEEDED')?.completedAt || null,
      lastProcessedAt: activeJob?.updatedAt || product.updatedAt || null,
    },
    health: {
      link: health(product.linkHealthStatus, Boolean(product.originalUrl)),
      productLink: health(product.linkHealthStatus, Boolean(product.originalUrl)),
      affiliateLink: health(product.affiliateHealthStatus, Boolean(product.affiliateUrl)),
      image: health(product.imageHealthStatus, Boolean(product.imageUrl)),
      price: health(product.priceTruthState, Number(product.salePrice || product.price) > 0),
      source: product.verifiedSource || product.sourceVerified ? 'HEALTHY' : 'UNVERIFIED',
      content: product.contentWorkflowStatus || 'insufficient_data',
    },
    requiredAction,
    humanActionRequired: Boolean(requiredAction && !['FIX_CRITICAL_BLOCKERS'].includes(requiredAction)),
    eligibility,
    remediationAvailable: Boolean(activeJob?.status === 'FAILED' && activeJob.attemptCount < activeJob.maxAttempts) || ['UNHEALTHY', 'UNVERIFIED'].some(value => [
      health(product.linkHealthStatus, Boolean(product.originalUrl)),
      health(product.affiliateHealthStatus, Boolean(product.affiliateUrl)),
      health(product.imageHealthStatus, Boolean(product.imageUrl)),
    ].includes(value)),
    safety: { publishingEnabled, launchEnabled: input.launchEnabled, effectiveMode: input.effectiveMode },
  };
}

export async function getProductPipelineTruth(productId: string, now = Date.now()) {
  const [product, jobs, actions, settings, control] = await Promise.all([
    getProductById(productId), getAllAutomationJobs(), readCollection<ProductAdminActionRecord>('product-admin-actions'),
    getAutomationSettings(), getAutomationControl(),
  ]);
  if (!product) return null;
  return buildProductPipelineTruth({ product, jobs, actions, launchEnabled: settings.launchEnabled, effectiveMode: control.effectiveMode, now });
}
