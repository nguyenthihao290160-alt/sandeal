import { createHash } from 'node:crypto';
import { appendAutomationAudit, createAutomationJob } from '@/lib/automation/store';
import { generateId, runTransaction } from '@/lib/storage/adapter';
import { getProductById, saveCanonicalProduct } from '@/lib/storage/products';
import { getProductPipelineTruth, type ProductAdminActionRecord, type ProductAdminActionType } from './productPipelineTruth';

function actionId(productId: string, action: ProductAdminActionType, operationId: string): string {
  return `product-action-${createHash('sha256').update(`${productId}:${action}:${operationId}`).digest('hex').slice(0, 24)}`;
}

export async function recordProductAdminAction(input: { productId: string; action: ProductAdminActionType; actor: string; operationId?: string; reason?: string }) {
  const product = await getProductById(input.productId);
  if (!product) throw new Error('PRODUCT_NOT_FOUND');
  const observedPrice = Number(product.salePrice || product.price || 0);
  const hasObservedPrice = Number.isFinite(observedPrice) && observedPrice > 0 && product.currency === 'VND';
  if (input.action === 'price_verified' && !hasObservedPrice) throw new Error('PRICE_VERIFICATION_FAILED');
  if (input.action === 'data_verified') {
    const missing = [!Number(product.salePrice || product.price) && 'price', !(product.originalUrl || product.affiliateUrl) && 'link', !product.imageUrl && 'image', !(product.verifiedSource || product.sourceVerified) && 'source'].filter(Boolean);
    if (missing.length) throw new Error(`DATA_VERIFICATION_FAILED:${missing.join(',')}`);
  }
  const truth = await getProductPipelineTruth(input.productId);
  if (!truth) throw new Error('PRODUCT_NOT_FOUND');
  if (input.action === 'canary_ready' && truth.lifecycle.blockers.some(item => /record_type|quarant|broken|missing|unverified|conflict|invalid|block/i.test(item))) throw new Error('CANARY_CRITICAL_BLOCKER');
  const operationId = input.operationId?.trim() || generateId();
  const id = actionId(input.productId, input.action, operationId);
  const occurredAt = new Date().toISOString();
  let record!: ProductAdminActionRecord;
  let created = false;
  await runTransaction<ProductAdminActionRecord>('product-admin-actions', items => {
    const existing = items.find(item => item.id === id || (item.productId === input.productId && item.action === input.action && item.operationId === operationId));
    if (existing) { record = structuredClone(existing); return undefined; }
    record = { id, productId: input.productId, action: input.action, actor: input.actor, operationId, reason: input.reason?.trim().slice(0, 500) || null, evidence: { productUpdatedAt: product.updatedAt, publicHidden: product.publicHidden !== false }, occurredAt };
    items.push(record); created = true; return items;
  });
  let job: { id: string; status: string } | null = null;
  const verificationAction = input.action === 'data_verified' || input.action === 'price_verified';
  // If the action record committed but the product write failed, an idempotent
  // retry is allowed to finish the verification using the original audit time.
  const verificationIncomplete = hasObservedPrice && product.priceVerificationStatus !== 'VERIFIED';
  if (verificationAction && (created || verificationIncomplete)) {
    const verificationReason = input.action === 'price_verified' ? 'OPERATOR_PRICE_VERIFIED' : 'OWNER_DATA_VERIFIED';
    const verificationAt = record.occurredAt;
    await saveCanonicalProduct(input.productId, {
      priceVerificationStatus: hasObservedPrice ? 'VERIFIED' : 'MISSING',
      priceObservedAt: hasObservedPrice ? verificationAt : product.priceObservedAt,
      priceTruthState: hasObservedPrice ? 'FRESH' : 'UNAVAILABLE',
      fieldProvenance: {
        ...(product.fieldProvenance || {}),
        price: {
          ...(product.fieldProvenance?.price || { source: product.source }),
          value: hasObservedPrice ? observedPrice : undefined,
          verificationStatus: hasObservedPrice ? 'VERIFIED' : 'MISSING',
          verifiedAt: hasObservedPrice ? verificationAt : undefined,
          verificationReason: hasObservedPrice ? verificationReason : 'PRICE_MISSING',
        },
      },
      publicHidden: true,
      publicBlocked: true,
      autoPublished: false,
    });
  }
  if (created && input.action === 'safe_publish_requested') {
    const result = await createAutomationJob({
      type: 'RECHECK_PRODUCT_HEALTH', payload: { productIds: [input.productId], safePublishAssessment: true },
      idempotencyKey: `safe-publish-assessment:${input.productId}:${createHash('sha256').update(operationId).digest('hex').slice(0, 20)}`,
      operationId, requestedBy: input.actor, riskLevel: 'MEDIUM', dryRun: false,
    });
    job = { id: result.job.id, status: result.job.status };
  }
  if (created) await appendAutomationAudit({ correlationId: operationId, operationId, operationType: `PRODUCT_${input.action.toUpperCase()}`, actor: input.actor, target: input.productId, risk: input.action === 'publish_approved' ? 'HIGH' : 'LOW', reasons: input.reason ? [input.reason] : [], result: { actionRecordId: id, assessmentJobId: job?.id }, dryRun: false, attempts: 0 });
  return { record, created, job };
}
