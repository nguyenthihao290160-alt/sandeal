import { createHash } from 'node:crypto';
import { getAutomationPolicy } from '@/lib/automation/policyRegistry';
import type { AutonomousMode } from '@/lib/automation/types';
import {
  buildEvidenceSnapshot,
  EVIDENCE_RULE_VERSION,
  listProductEvidence,
  verifyEvidenceSnapshot,
  type EvidenceFact,
  type EvidenceSnapshot,
} from '@/lib/autonomous/evidenceGraph';
import { evaluateSafePublish } from '@/lib/safePublish';
import type { Product } from '@/lib/types';

export const AUTONOMOUS_PUBLISH_RULE_VERSION = 'auto-publish-rules-v2';
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60_000;
export const AUTONOMOUS_REQUIRED_EVIDENCE_FIELDS = [
  'title',
  'recordType',
  'price',
  'currency',
  'originalUrl',
  'affiliateUrl',
  'imageUrl',
  'linkHealthStatus',
  'affiliateHealthStatus',
  'imageHealthStatus',
] as const;

export interface AutonomousPublishContext {
  mode: AutonomousMode;
  killSwitch: boolean;
  publishPaused: boolean;
  workerId?: string;
  jobType?: string;
  jobClaimedBy?: string;
  withinBudget: boolean;
  withinCanaryWave: boolean;
  now?: number;
}

export interface PersistedEvidenceVerification {
  valid: boolean;
  productId: string;
  reasons: string[];
  coverage: number;
  evidenceIds: string[];
  snapshotHash: string;
  verifiedAt: string;
  ruleVersion: string;
}

export interface AutonomousPublishDecision {
  eligible: boolean;
  reasons: string[];
  qualityScore: number;
  publishConfidence: number;
  evidenceCoverage: number;
  evidenceVerified: boolean;
  evidenceIds: string[];
  snapshotHash: string;
  ruleVersion: string;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(String).map(value => value.trim()).filter(Boolean))];
}

function sameSortedValues(left: string[], right: string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function comparableValue(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? `number:${value}` : 'number:invalid';
  if (typeof value === 'boolean') return `boolean:${value}`;
  return `string:${String(value ?? '').trim()}`;
}

function expectedCanonicalFacts(product: Partial<Product>): Array<{ field: string; value: unknown; sourceType: EvidenceFact['sourceType'] }> {
  const expected: Array<{ field: string; value: unknown; sourceType: EvidenceFact['sourceType'] }> = [
    { field: 'title', value: product.title, sourceType: 'SOURCE_API' },
    { field: 'recordType', value: product.recordType, sourceType: 'CANONICAL_RECORD' },
    { field: 'price', value: product.price || product.salePrice, sourceType: 'PRICE_OBSERVATION' },
    { field: 'currency', value: product.currency, sourceType: 'CANONICAL_RECORD' },
    { field: 'originalUrl', value: product.originalUrl, sourceType: 'HEALTH_PROBE' },
    { field: 'affiliateUrl', value: product.affiliateUrl, sourceType: 'HEALTH_PROBE' },
    { field: 'imageUrl', value: product.imageUrl, sourceType: 'HEALTH_PROBE' },
    { field: 'linkHealthStatus', value: product.linkHealthStatus, sourceType: 'HEALTH_PROBE' },
    { field: 'affiliateHealthStatus', value: product.affiliateHealthStatus, sourceType: 'HEALTH_PROBE' },
    { field: 'imageHealthStatus', value: product.imageHealthStatus, sourceType: 'HEALTH_PROBE' },
  ];
  if (Number(product.salePrice || 0) > 0) expected.push({ field: 'salePrice', value: product.salePrice, sourceType: 'PRICE_OBSERVATION' });
  return expected;
}

function appendCanonicalFactReasons(product: Partial<Product>, facts: EvidenceFact[], reasons: string[], nowMs: number): void {
  for (const expected of expectedCanonicalFacts(product)) {
    const matchingField = facts.filter(fact => fact.field === expected.field);
    if (!matchingField.length) {
      reasons.push(`canonical_fact_missing:${expected.field}`);
      continue;
    }
    const distinctValues = [...new Set(matchingField.map(fact => comparableValue(fact.value)))];
    if (distinctValues.length > 1) reasons.push(`canonical_fact_conflict:${expected.field}`);
    if (!distinctValues.includes(comparableValue(expected.value))) reasons.push(`canonical_fact_mismatch:${expected.field}`);
    const canonicalFacts = matchingField.filter(fact => comparableValue(fact.value) === comparableValue(expected.value));
    if (canonicalFacts.length && !canonicalFacts.some(fact => fact.sourceType === expected.sourceType)) {
      reasons.push(`canonical_fact_source_invalid:${expected.field}`);
    }
    if (canonicalFacts.some(fact => {
      const observedAt = Date.parse(fact.observedAt);
      return !Number.isFinite(observedAt) || observedAt > nowMs + 60_000 || nowMs - observedAt > DEFAULT_EVIDENCE_MAX_AGE_MS;
    })) reasons.push(`canonical_fact_stale:${expected.field}`);
  }
}

/**
 * Reconstructs the claimed snapshot from persisted facts. Product summary fields
 * are compared with the reconstruction, never accepted as proof on their own.
 */
export async function verifyAutonomousPublishEvidence(
  product: Partial<Product>,
  nowMs = Date.now(),
): Promise<PersistedEvidenceVerification> {
  const productId = String(product.id || '').trim();
  const reasons: string[] = [];
  if (!productId) {
    return {
      valid: false,
      productId,
      reasons: ['evidence_product_id_missing'],
      coverage: 0,
      evidenceIds: [],
      snapshotHash: '',
      verifiedAt: new Date(nowMs).toISOString(),
      ruleVersion: EVIDENCE_RULE_VERSION,
    };
  }

  const claimedIds = Array.isArray(product.evidenceFactIds)
    ? product.evidenceFactIds.map(String).map(value => value.trim()).filter(Boolean)
    : [];
  const uniqueClaimedIds = uniqueStrings(claimedIds);
  const canonicalClaimedIds = [...uniqueClaimedIds].sort();
  if (!claimedIds.length) reasons.push('evidence_snapshot_ids_missing');
  if (uniqueClaimedIds.length !== claimedIds.length) reasons.push('evidence_snapshot_duplicate_id');

  const productFacts = await listProductEvidence(productId, nowMs);
  const rebuilt = buildEvidenceSnapshot(productId, productFacts, nowMs);
  if (!sameSortedValues(canonicalClaimedIds, rebuilt.evidenceIds)) reasons.push('evidence_snapshot_active_set_mismatch');
  if (!product.evidenceSnapshotHash || product.evidenceSnapshotHash !== rebuilt.snapshotHash) reasons.push('evidence_snapshot_hash_mismatch');

  const productFactById = new Map(productFacts.map(fact => [fact.id, fact]));
  const selectedProductFacts = canonicalClaimedIds
    .map(id => productFactById.get(id))
    .filter((fact): fact is EvidenceFact => Boolean(fact));
  const expiries = selectedProductFacts.map(fact => Date.parse(fact.expiresAt)).filter(Number.isFinite);
  const snapshotAt = Date.parse(product.evidenceSnapshotAt || '');
  if (!Number.isFinite(snapshotAt) || nowMs - snapshotAt > DEFAULT_EVIDENCE_MAX_AGE_MS || snapshotAt > nowMs + 60_000) {
    reasons.push('evidence_snapshot_stale');
  }

  const claimedSnapshot: EvidenceSnapshot = {
    schemaVersion: rebuilt.schemaVersion,
    productId,
    evidenceIds: canonicalClaimedIds,
    factHashes: Object.fromEntries(canonicalClaimedIds.map(id => [id, productFactById.get(id)?.contentHash || 'missing'])),
    snapshotHash: String(product.evidenceSnapshotHash || ''),
    createdAt: Number.isFinite(snapshotAt) ? new Date(snapshotAt).toISOString() : new Date(0).toISOString(),
    expiresAt: new Date(expiries.length ? Math.min(...expiries) : 0).toISOString(),
    ruleVersion: EVIDENCE_RULE_VERSION,
  };
  const requiredFields = [
    ...AUTONOMOUS_REQUIRED_EVIDENCE_FIELDS,
    ...(Number(product.salePrice || 0) > 0 ? ['salePrice'] : []),
  ];
  const persisted = await verifyEvidenceSnapshot(claimedSnapshot, {
    productId,
    requiredFields,
    minimumCoverage: 1,
    nowMs,
  });
  reasons.push(...persisted.reasons);
  appendCanonicalFactReasons(product, persisted.activeFacts, reasons, nowMs);

  if (Number.isFinite(Number(product.evidenceCoverage))
    && Math.abs(Number(product.evidenceCoverage) - persisted.coverage) > 0.0001) {
    reasons.push('evidence_coverage_summary_mismatch');
  }

  return {
    valid: reasons.length === 0 && persisted.valid,
    productId,
    reasons: [...new Set(reasons)],
    coverage: persisted.coverage,
    evidenceIds: [...rebuilt.evidenceIds],
    snapshotHash: rebuilt.snapshotHash,
    verifiedAt: new Date(nowMs).toISOString(),
    ruleVersion: EVIDENCE_RULE_VERSION,
  };
}

export function readinessSnapshotHash(product: Partial<Product>): string {
  return createHash('sha256').update(JSON.stringify({
    id: product.id,
    recordType: product.recordType,
    lifecycleState: product.lifecycleState,
    sourceHash: product.sourceHash,
    evidenceSnapshotHash: product.evidenceSnapshotHash,
    evidenceFactIds: product.evidenceFactIds || [],
    confidences: product.confidences || null,
    duplicateStatus: product.duplicateStatus,
    claimValidationStatus: product.claimValidationStatus,
    health: [product.linkHealthStatus, product.affiliateHealthStatus, product.imageHealthStatus],
    price: product.salePrice || product.price,
    riskLevel: product.riskLevel,
    reviewHash: product.reviewContent?.reviewContentHash,
  })).digest('hex');
}

export function evaluateAutonomousPublish(
  product: Partial<Product>,
  context: AutonomousPublishContext,
  evidenceVerification?: PersistedEvidenceVerification,
): AutonomousPublishDecision {
  const base = evaluateSafePublish(product);
  const reasons = [...base.reasons];
  const now = context.now ?? Date.now();
  const policy = getAutomationPolicy('AUTO_SAFE_PUBLISH');
  const evidenceCoverage = evidenceVerification
    ? evidenceVerification.coverage
    : Number(product.evidenceCoverage || product.confidences?.contentEvidenceCoverage || 0);
  const publishConfidence = Number(product.confidences?.publish || 0);
  const snapshotAt = Date.parse(product.evidenceSnapshotAt || '');

  if (product.recordType !== 'PRODUCT') reasons.push('record_type_not_product');
  if (product.riskLevel !== 'low') reasons.push('risk_not_low');
  if (!['READY_FOR_PUBLISH', 'PUBLISHING'].includes(String(product.lifecycleState || ''))) reasons.push('lifecycle_not_ready');
  if (product.duplicateStatus !== 'CLEAR') reasons.push('duplicate_unresolved');
  if (product.claimValidationStatus !== 'VERIFIED') reasons.push('claim_evidence_unverified');
  if (evidenceCoverage < 0.8) reasons.push('evidence_coverage_low');
  if (!Number.isFinite(snapshotAt) || now - snapshotAt > DEFAULT_EVIDENCE_MAX_AGE_MS || snapshotAt > now + 60_000) reasons.push('evidence_snapshot_stale');
  if (evidenceVerification && !evidenceVerification.valid) reasons.push('persisted_evidence_unverified', ...evidenceVerification.reasons);
  if (publishConfidence < 0.85) reasons.push('publish_confidence_low');
  if (!['CANARY', 'AUTONOMOUS'].includes(context.mode)) reasons.push('mode_disallows_publish');
  if (context.killSwitch || context.mode === 'EMERGENCY_STOP') reasons.push('kill_switch_active');
  if (context.publishPaused) reasons.push('publish_lane_paused');
  if (!context.withinBudget) reasons.push('publish_budget_exceeded');
  if (context.mode === 'CANARY' && !context.withinCanaryWave) reasons.push('canary_wave_exceeded');
  if (!context.workerId || context.jobType !== 'AUTO_SAFE_PUBLISH' || context.jobClaimedBy !== context.workerId) reasons.push('durable_worker_required');
  if (!policy.autonomousAllowed || policy.publishPermission !== 'AUTONOMOUS_GUARDED' || policy.approvalMode !== 'NEVER') reasons.push('policy_disallows_autonomous_publish');

  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    qualityScore: base.qualityScore,
    publishConfidence,
    evidenceCoverage,
    evidenceVerified: evidenceVerification?.valid === true,
    evidenceIds: evidenceVerification ? [...evidenceVerification.evidenceIds] : uniqueStrings(product.evidenceFactIds),
    snapshotHash: readinessSnapshotHash(product),
    ruleVersion: AUTONOMOUS_PUBLISH_RULE_VERSION,
  };
}

export async function evaluatePersistedAutonomousPublish(
  product: Partial<Product>,
  context: AutonomousPublishContext,
): Promise<{ decision: AutonomousPublishDecision; evidence: PersistedEvidenceVerification }> {
  const evidence = await verifyAutonomousPublishEvidence(product, context.now ?? Date.now());
  return { decision: evaluateAutonomousPublish(product, context, evidence), evidence };
}

export function assertAutonomousPublishEligible(
  product: Partial<Product>,
  context: AutonomousPublishContext,
  evidenceVerification?: PersistedEvidenceVerification,
) {
  if (!evidenceVerification) throw new Error('AUTO_SAFE_PUBLISH_BLOCKED:persisted_evidence_not_enforced');
  const decision = evaluateAutonomousPublish(product, context, evidenceVerification);
  if (!decision.eligible) throw new Error(`AUTO_SAFE_PUBLISH_BLOCKED:${decision.reasons.join(',')}`);
  return decision;
}
