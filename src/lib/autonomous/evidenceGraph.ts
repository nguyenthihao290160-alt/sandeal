import { createHash } from 'node:crypto';
import { readCollection, runTransaction } from '@/lib/storage/adapter';
import type { Product } from '@/lib/types';

const COLLECTION = 'evidence-facts';
export const EVIDENCE_SCHEMA_VERSION = 2;
export const EVIDENCE_RULE_VERSION = 'evidence-capture-v2';

export type EvidenceSourceType = 'SOURCE_API' | 'CANONICAL_RECORD' | 'HEALTH_PROBE' | 'PRICE_OBSERVATION' | 'OWNER_OVERRIDE' | 'AI_INFERENCE';
export type EvidenceFactStatus = 'ACTIVE' | 'EXPIRED' | 'CONFLICTED' | 'REVOKED';

export interface EvidenceFact {
  schemaVersion: number;
  id: string;
  productId: string;
  field: string;
  value: string | number | boolean;
  sourceType: EvidenceSourceType;
  sourceId: string;
  sourceUrl?: string;
  observedAt: string;
  capturedAt: string;
  verificationMethod: string;
  confidence: number;
  status: EvidenceFactStatus;
  expiresAt: string;
  ruleVersion: string;
  modelId?: string;
  promptVersion?: string;
  observationKey: string;
  contentHash: string;
}

export interface EvidenceSnapshot {
  schemaVersion: number;
  productId: string;
  evidenceIds: string[];
  factHashes: Record<string, string>;
  snapshotHash: string;
  createdAt: string;
  expiresAt: string;
  ruleVersion: string;
}

export interface EvidenceReplayBundle {
  schemaVersion: number;
  productId: string;
  inputSnapshotHash: string;
  evidenceIds: string[];
  ruleVersion: string;
  policyVersion: string;
  promptVersion?: string;
  modelId?: string;
  responseHash?: string;
  createdAt: string;
}

export interface EvidenceBackedClaim {
  id: string;
  field?: string;
  evidenceFactIds: string[];
  requiredFields?: string[];
}

export interface ClaimEvidenceValidation {
  status: 'VERIFIED' | 'PARTIAL' | 'MISSING_EVIDENCE' | 'UNSAFE';
  valid: boolean;
  issues: Array<{ claimId: string; code: string; evidenceFactId?: string }>;
  verifiedClaimIds: string[];
  evidenceIds: string[];
}

export interface ProductHealthEvidenceObservation {
  observationId?: string;
  checkedAt: string;
  productUrl: string;
  affiliateUrl: string;
  imageUrl: string;
  productStatus: string;
  affiliateStatus: string;
  imageStatus: string;
  publicPageUrl?: string;
  publicPageStatus?: string;
}

export interface ProductHealthEvidenceCapture {
  facts: EvidenceFact[];
  activeFacts: EvidenceFact[];
  revoked: number;
  coverage: number;
  snapshot: EvidenceSnapshot;
}

type EvidenceFactInput = Omit<EvidenceFact, 'schemaVersion' | 'id' | 'observationKey' | 'contentHash' | 'capturedAt'>;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('EVIDENCE_TIMESTAMP_INVALID');
  return timestamp;
}

function observationKey(input: EvidenceFactInput): string {
  return hash({
    productId: input.productId,
    field: input.field,
    value: input.value,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl || null,
    observedAt: input.observedAt,
    verificationMethod: input.verificationMethod,
    ruleVersion: input.ruleVersion,
    modelId: input.modelId || null,
    promptVersion: input.promptVersion || null,
  });
}

function factContentHash(input: EvidenceFactInput, key: string): string {
  return hash({ observationKey: key, confidence: input.confidence, expiresAt: input.expiresAt });
}

function factInput(fact: EvidenceFact): EvidenceFactInput {
  return {
    productId: fact.productId,
    field: fact.field,
    value: fact.value,
    sourceType: fact.sourceType,
    sourceId: fact.sourceId,
    sourceUrl: fact.sourceUrl,
    observedAt: fact.observedAt,
    verificationMethod: fact.verificationMethod,
    confidence: fact.confidence,
    status: fact.status,
    expiresAt: fact.expiresAt,
    ruleVersion: fact.ruleVersion,
    modelId: fact.modelId,
    promptVersion: fact.promptVersion,
  };
}

function hasValidFactIntegrity(fact: EvidenceFact): boolean {
  const input = factInput(fact);
  const expectedObservationKey = observationKey(input);
  return fact.observationKey === expectedObservationKey && fact.contentHash === factContentHash(input, expectedObservationKey);
}

function effectiveStatus(fact: EvidenceFact, nowMs: number): EvidenceFactStatus {
  return fact.status === 'ACTIVE' && Date.parse(fact.expiresAt) <= nowMs ? 'EXPIRED' : fact.status;
}

function isActiveFact(fact: EvidenceFact, nowMs: number): boolean {
  return effectiveStatus(fact, nowMs) === 'ACTIVE';
}

function snapshotDigest(productId: string, evidenceIds: string[], factHashes: Record<string, string>, ruleVersion: string): string {
  return hash({
    productId,
    evidence: evidenceIds.map(id => [id, factHashes[id] || null]),
    ruleVersion,
  });
}

export async function captureEvidenceFact(
  input: EvidenceFactInput,
  options: { capturedAt?: string } = {},
): Promise<{ fact: EvidenceFact; created: boolean }> {
  if (input.sourceType === 'AI_INFERENCE') throw new Error('AI_INFERENCE_CANNOT_CREATE_CANONICAL_FACT');
  if (!input.productId.trim() || !input.field.trim() || !input.sourceId.trim()) throw new Error('EVIDENCE_IDENTITY_REQUIRED');
  if (!['string', 'number', 'boolean'].includes(typeof input.value) || (typeof input.value === 'number' && !Number.isFinite(input.value))) throw new Error('EVIDENCE_VALUE_INVALID');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error('EVIDENCE_CONFIDENCE_INVALID');
  if (input.status !== 'ACTIVE') throw new Error('EVIDENCE_NEW_FACT_MUST_BE_ACTIVE');
  if (input.sourceUrl) {
    try {
      const sourceUrl = new URL(input.sourceUrl);
      if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('invalid_protocol');
    } catch {
      throw new Error('EVIDENCE_SOURCE_URL_INVALID');
    }
  }
  const capturedAt = options.capturedAt || new Date().toISOString();
  const capturedMs = validTimestamp(capturedAt);
  const observedMs = validTimestamp(input.observedAt);
  const expiresMs = validTimestamp(input.expiresAt);
  if (observedMs > capturedMs + 5 * 60_000) throw new Error('EVIDENCE_OBSERVED_AT_IN_FUTURE');
  if (expiresMs <= capturedMs) throw new Error('EVIDENCE_ALREADY_EXPIRED');

  const key = observationKey(input);
  const contentHash = factContentHash(input, key);
  let output!: { fact: EvidenceFact; created: boolean };
  await runTransaction<EvidenceFact>(COLLECTION, facts => {
    const existing = facts.find(fact => fact.observationKey === key || (fact.productId === input.productId && fact.field === input.field && fact.contentHash === contentHash));
    if (existing) {
      output = { fact: structuredClone(existing), created: false };
      return undefined;
    }
    const fact: EvidenceFact = {
      ...input,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      id: `evidence-${key.slice(0, 32)}`,
      capturedAt,
      observationKey: key,
      contentHash,
    };
    facts.push(fact);
    output = { fact: structuredClone(fact), created: true };
    return facts;
  });
  return output;
}

export function buildEvidenceSnapshot(productId: string, facts: EvidenceFact[], nowMs = Date.now()): EvidenceSnapshot {
  const active = facts
    .filter(fact => fact.productId === productId && isActiveFact(fact, nowMs))
    .sort((left, right) => left.id.localeCompare(right.id));
  const evidenceIds = [...new Set(active.map(fact => fact.id))].sort();
  const factHashes = Object.fromEntries(active.map(fact => [fact.id, fact.contentHash]));
  const expiries = active.map(fact => Date.parse(fact.expiresAt)).filter(Number.isFinite);
  const expiresAt = new Date(expiries.length ? Math.min(...expiries) : nowMs).toISOString();
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    productId,
    evidenceIds,
    factHashes,
    snapshotHash: snapshotDigest(productId, evidenceIds, factHashes, EVIDENCE_RULE_VERSION),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt,
    ruleVersion: EVIDENCE_RULE_VERSION,
  };
}

export async function verifyEvidenceSnapshot(
  snapshot: EvidenceSnapshot,
  options: { productId: string; requiredFields?: string[]; minimumCoverage?: number; nowMs?: number },
): Promise<{ valid: boolean; reasons: string[]; coverage: number; activeFacts: EvidenceFact[] }> {
  const nowMs = options.nowMs ?? Date.now();
  const reasons: string[] = [];
  const allFacts = await readCollection<EvidenceFact>(COLLECTION);
  const requestedIds = [...new Set(snapshot.evidenceIds)];
  if (snapshot.productId !== options.productId) reasons.push('snapshot_product_mismatch');
  if (requestedIds.length !== snapshot.evidenceIds.length) reasons.push('snapshot_duplicate_evidence_id');
  const selected = requestedIds.map(id => allFacts.find(fact => fact.id === id)).filter((fact): fact is EvidenceFact => Boolean(fact));
  if (selected.length !== requestedIds.length) reasons.push('snapshot_evidence_missing');
  if (selected.some(fact => fact.productId !== options.productId)) reasons.push('snapshot_evidence_owner_mismatch');
  if (selected.some(fact => !isActiveFact(fact, nowMs))) reasons.push('snapshot_evidence_inactive_or_expired');
  if (selected.some(fact => !hasValidFactIntegrity(fact))) reasons.push('snapshot_fact_integrity_mismatch');
  if (selected.some(fact => snapshot.factHashes[fact.id] !== fact.contentHash)) reasons.push('snapshot_fact_hash_mismatch');
  const recalculated = snapshotDigest(snapshot.productId, snapshot.evidenceIds, snapshot.factHashes, snapshot.ruleVersion);
  if (snapshot.snapshotHash !== recalculated) reasons.push('snapshot_hash_mismatch');
  if (Date.parse(snapshot.expiresAt) <= nowMs) reasons.push('snapshot_expired');

  const required = [...new Set(options.requiredFields || [])];
  const activeFacts = selected.filter(fact => fact.productId === options.productId && isActiveFact(fact, nowMs));
  const covered = required.filter(field => activeFacts.some(fact => fact.field === field && fact.confidence >= 0.8)).length;
  const coverage = required.length ? covered / required.length : activeFacts.length ? 1 : 0;
  if (coverage < (options.minimumCoverage ?? 1)) reasons.push('snapshot_coverage_low');
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], coverage, activeFacts };
}

export async function captureProductEvidence(
  product: Product,
  now = new Date().toISOString(),
): Promise<{ facts: EvidenceFact[]; coverage: number; snapshotHash: string; snapshot: EvidenceSnapshot }> {
  const nowMs = validTimestamp(now);
  const expiry = new Date(nowMs + 24 * 60 * 60_000).toISOString();
  const sourceId = product.sourceId || product.externalId || product.sourceHash || product.id;
  const definitions: Array<{ field: string; value: string | number | boolean | undefined; sourceType: EvidenceSourceType; method: string; confidence: number; observedAt: string; url?: string }> = [
    { field: 'title', value: product.title, sourceType: 'SOURCE_API', method: 'source_payload', confidence: product.verifiedSource ? 0.98 : 0.65, observedAt: product.lastSeenAt || now, url: product.originalUrl },
    { field: 'recordType', value: product.recordType, sourceType: 'CANONICAL_RECORD', method: 'deterministic_classifier', confidence: product.confidences?.classification || 0.9, observedAt: product.lifecycleUpdatedAt || product.lastSeenAt || now },
    { field: 'price', value: product.price || product.salePrice, sourceType: 'PRICE_OBSERVATION', method: 'source_original_price_observation', confidence: product.confidences?.price || 0.9, observedAt: product.priceObservedAt || product.lastSeenAt || now, url: product.originalUrl },
    { field: 'salePrice', value: product.salePrice, sourceType: 'PRICE_OBSERVATION', method: 'source_current_price_observation', confidence: product.confidences?.price || 0.9, observedAt: product.priceObservedAt || product.lastSeenAt || now, url: product.originalUrl },
    { field: 'currency', value: product.currency, sourceType: 'CANONICAL_RECORD', method: 'schema_validation', confidence: 1, observedAt: product.priceObservedAt || product.lastSeenAt || now },
    { field: 'originalUrl', value: product.originalUrl, sourceType: 'HEALTH_PROBE', method: 'http_health_probe', confidence: ['ok', 'redirect_ok'].includes(String(product.linkHealthStatus)) ? 0.98 : 0.4, observedAt: product.linkLastCheckedAt || now, url: product.originalUrl },
    { field: 'affiliateUrl', value: product.affiliateUrl, sourceType: 'HEALTH_PROBE', method: 'http_health_probe', confidence: ['ok', 'redirect_ok'].includes(String(product.affiliateHealthStatus)) ? 0.98 : 0.4, observedAt: product.affiliateLastCheckedAt || now, url: product.affiliateUrl },
    { field: 'imageUrl', value: product.imageUrl, sourceType: 'HEALTH_PROBE', method: 'image_content_probe', confidence: product.imageHealthStatus === 'ok' ? 0.98 : 0.4, observedAt: product.imageLastCheckedAt || now, url: product.imageUrl },
    { field: 'linkHealthStatus', value: product.linkHealthStatus, sourceType: 'HEALTH_PROBE', method: 'http_health_probe', confidence: ['ok', 'redirect_ok'].includes(String(product.linkHealthStatus)) ? 0.98 : 0.4, observedAt: product.linkLastCheckedAt || now, url: product.originalUrl },
    { field: 'affiliateHealthStatus', value: product.affiliateHealthStatus, sourceType: 'HEALTH_PROBE', method: 'http_health_probe', confidence: ['ok', 'redirect_ok'].includes(String(product.affiliateHealthStatus)) ? 0.98 : 0.4, observedAt: product.affiliateLastCheckedAt || now, url: product.affiliateUrl },
    { field: 'imageHealthStatus', value: product.imageHealthStatus, sourceType: 'HEALTH_PROBE', method: 'image_content_probe', confidence: product.imageHealthStatus === 'ok' ? 0.98 : 0.4, observedAt: product.imageLastCheckedAt || now, url: product.imageUrl },
    { field: 'brand', value: product.brand, sourceType: 'SOURCE_API', method: 'source_payload', confidence: 0.85, observedAt: product.lastSeenAt || now, url: product.originalUrl },
    { field: 'sku', value: product.sku, sourceType: 'SOURCE_API', method: 'source_payload', confidence: 0.9, observedAt: product.lastSeenAt || now, url: product.originalUrl },
    { field: 'category', value: product.category, sourceType: 'SOURCE_API', method: 'source_payload', confidence: 0.9, observedAt: product.lastSeenAt || now, url: product.originalUrl },
    { field: 'gtin', value: product.gtin, sourceType: 'SOURCE_API', method: 'source_payload', confidence: 0.95, observedAt: product.lastSeenAt || now, url: product.originalUrl },
    { field: 'mpn', value: product.mpn, sourceType: 'SOURCE_API', method: 'source_payload', confidence: 0.9, observedAt: product.lastSeenAt || now, url: product.originalUrl },
    ...Object.entries(product.specifications || {}).map(([key, value]) => ({
      field: `specifications.${key}`,
      value,
      sourceType: 'SOURCE_API' as const,
      method: 'source_payload',
      confidence: 0.85,
      observedAt: product.lastSeenAt || now,
      url: product.originalUrl,
    })),
  ];
  const facts: EvidenceFact[] = [];
  for (const item of definitions.filter(definition => definition.value !== undefined && definition.value !== '')) {
    const captured = await captureEvidenceFact({
      productId: product.id,
      field: item.field,
      value: item.value!,
      sourceType: item.sourceType,
      sourceId,
      sourceUrl: item.url,
      observedAt: item.observedAt,
      verificationMethod: item.method,
      confidence: item.confidence,
      status: 'ACTIVE',
      expiresAt: expiry,
      ruleVersion: EVIDENCE_RULE_VERSION,
    }, { capturedAt: now });
    facts.push(captured.fact);
  }
  const required = ['title', 'recordType', 'price', 'currency', 'originalUrl', 'affiliateUrl', 'imageUrl'];
  const coverage = required.filter(field => facts.some(fact => fact.field === field && fact.confidence >= 0.8)).length / required.length;
  const snapshot = buildEvidenceSnapshot(product.id, facts, nowMs);
  return { facts, coverage, snapshotHash: snapshot.snapshotHash, snapshot };
}

const HEALTH_EVIDENCE_FIELDS = new Set([
  'originalUrl',
  'affiliateUrl',
  'imageUrl',
  'linkHealthStatus',
  'affiliateHealthStatus',
  'imageHealthStatus',
  'publicPageUrl',
  'publicPageHealthStatus',
]);

function observedHealthConfidence(status: string): number {
  const normalized = String(status || '').toLowerCase();
  if (['ok', 'healthy', 'redirect_ok', 'redirected'].includes(normalized)) return 0.98;
  if (['broken', 'not_found', 'image_broken', 'invalid_image'].includes(normalized)) return 0.05;
  if (normalized === 'unverified' || normalized === 'not_applicable') return 0.2;
  return 0.4;
}

/**
 * Replaces only the active health observation set. Source, price, and editorial
 * facts keep their original observation timestamps and provenance.
 */
export async function captureProductHealthEvidence(
  product: Product,
  observation: ProductHealthEvidenceObservation,
): Promise<ProductHealthEvidenceCapture> {
  const checkedMs = validTimestamp(observation.checkedAt);
  const expiry = new Date(checkedMs + 24 * 60 * 60_000).toISOString();
  const sourceId = product.sourceId || product.externalId || product.sourceHash || product.id;
  const methodSuffix = observation.observationId ? `:${observation.observationId}` : '';
  const definitions: Array<{ field: string; value: string; status: string; method: string; url?: string }> = [
    { field: 'originalUrl', value: observation.productUrl, status: observation.productStatus, method: `http_health_probe${methodSuffix}`, url: observation.productUrl },
    { field: 'affiliateUrl', value: observation.affiliateUrl, status: observation.affiliateStatus, method: `http_health_probe${methodSuffix}`, url: observation.affiliateUrl },
    { field: 'imageUrl', value: observation.imageUrl, status: observation.imageStatus, method: `image_content_probe${methodSuffix}`, url: observation.imageUrl },
    { field: 'linkHealthStatus', value: observation.productStatus, status: observation.productStatus, method: `http_health_probe${methodSuffix}`, url: observation.productUrl },
    { field: 'affiliateHealthStatus', value: observation.affiliateStatus, status: observation.affiliateStatus, method: `http_health_probe${methodSuffix}`, url: observation.affiliateUrl },
    { field: 'imageHealthStatus', value: observation.imageStatus, status: observation.imageStatus, method: `image_content_probe${methodSuffix}`, url: observation.imageUrl },
  ];
  if (observation.publicPageUrl && observation.publicPageStatus) {
    const publicSourceUrl = /^https?:\/\//i.test(observation.publicPageUrl) ? observation.publicPageUrl : undefined;
    definitions.push(
      { field: 'publicPageUrl', value: observation.publicPageUrl, status: observation.publicPageStatus, method: `public_route_probe${methodSuffix}`, url: publicSourceUrl },
      { field: 'publicPageHealthStatus', value: observation.publicPageStatus, status: observation.publicPageStatus, method: `public_route_probe${methodSuffix}`, url: publicSourceUrl },
    );
  }

  const capturedFacts: EvidenceFact[] = [];
  for (const definition of definitions) {
    if (!definition.value) continue;
    const captured = await captureEvidenceFact({
      productId: product.id,
      field: definition.field,
      value: definition.value,
      sourceType: 'HEALTH_PROBE',
      sourceId,
      sourceUrl: definition.url,
      observedAt: observation.checkedAt,
      verificationMethod: definition.method,
      confidence: observedHealthConfidence(definition.status),
      status: 'ACTIVE',
      expiresAt: expiry,
      ruleVersion: EVIDENCE_RULE_VERSION,
    }, { capturedAt: observation.checkedAt });
    capturedFacts.push(captured.fact);
  }

  const currentIds = new Set(capturedFacts.map(fact => fact.id));
  let revoked = 0;
  await runTransaction<EvidenceFact>(COLLECTION, facts => {
    for (const fact of facts) {
      if (fact.productId !== product.id || fact.status !== 'ACTIVE' || !HEALTH_EVIDENCE_FIELDS.has(fact.field) || currentIds.has(fact.id)) continue;
      fact.status = 'REVOKED';
      revoked += 1;
    }
    return revoked ? facts : undefined;
  });

  const activeFacts = (await listProductEvidence(product.id, checkedMs)).filter(fact => fact.status === 'ACTIVE');
  const snapshot = buildEvidenceSnapshot(product.id, activeFacts, checkedMs);
  const requiredFields = [
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
    ...(Number(product.salePrice || 0) > 0 ? ['salePrice'] : []),
  ];
  const covered = requiredFields.filter(field => activeFacts.some(fact => fact.field === field && fact.confidence >= 0.8)).length;
  return {
    facts: capturedFacts,
    activeFacts,
    revoked,
    coverage: requiredFields.length ? covered / requiredFields.length : 0,
    snapshot,
  };
}

export async function listProductEvidence(productId: string, nowMs = Date.now()): Promise<EvidenceFact[]> {
  return (await readCollection<EvidenceFact>(COLLECTION))
    .filter(fact => fact.productId === productId)
    .map(fact => ({ ...fact, status: effectiveStatus(fact, nowMs) }));
}

export async function expireEvidenceFacts(nowMs = Date.now()): Promise<number> {
  let expired = 0;
  await runTransaction<EvidenceFact>(COLLECTION, facts => {
    for (const fact of facts) {
      if (fact.status === 'ACTIVE' && Date.parse(fact.expiresAt) <= nowMs) {
        fact.status = 'EXPIRED';
        expired += 1;
      }
    }
    return expired ? facts : undefined;
  });
  return expired;
}

export function validateClaimsAgainstEvidence(
  productId: string,
  claims: EvidenceBackedClaim[],
  facts: EvidenceFact[],
  options: { nowMs?: number; minimumConfidence?: number } = {},
): ClaimEvidenceValidation {
  const nowMs = options.nowMs ?? Date.now();
  const minimumConfidence = options.minimumConfidence ?? 0.8;
  const issues: ClaimEvidenceValidation['issues'] = [];
  const verifiedClaimIds: string[] = [];
  const evidenceIds = new Set<string>();
  for (const claim of claims) {
    const ids = [...new Set(claim.evidenceFactIds || [])];
    if (!ids.length) {
      issues.push({ claimId: claim.id, code: 'claim_evidence_missing' });
      continue;
    }
    const referenced = ids.map(id => facts.find(fact => fact.id === id));
    for (let index = 0; index < referenced.length; index += 1) {
      const fact = referenced[index];
      const id = ids[index];
      if (!fact) issues.push({ claimId: claim.id, code: 'claim_evidence_not_found', evidenceFactId: id });
      else if (fact.productId !== productId) issues.push({ claimId: claim.id, code: 'claim_evidence_owner_mismatch', evidenceFactId: id });
      else if (!isActiveFact(fact, nowMs)) issues.push({ claimId: claim.id, code: 'claim_evidence_inactive', evidenceFactId: id });
      else if (!hasValidFactIntegrity(fact)) issues.push({ claimId: claim.id, code: 'claim_evidence_integrity_failed', evidenceFactId: id });
      else if (fact.sourceType === 'AI_INFERENCE') issues.push({ claimId: claim.id, code: 'claim_ai_inference_not_canonical', evidenceFactId: id });
      else if (fact.confidence < minimumConfidence) issues.push({ claimId: claim.id, code: 'claim_evidence_confidence_low', evidenceFactId: id });
      else evidenceIds.add(id);
    }
    const validFacts = referenced.filter((fact): fact is EvidenceFact => fact !== undefined
      && fact.productId === productId
      && isActiveFact(fact, nowMs)
      && hasValidFactIntegrity(fact)
      && fact.sourceType !== 'AI_INFERENCE'
      && fact.confidence >= minimumConfidence);
    const requiredFields = [...new Set([...(claim.requiredFields || []), ...(claim.field ? [claim.field] : [])])];
    for (const field of requiredFields) {
      if (!validFacts.some(fact => fact.field === field)) issues.push({ claimId: claim.id, code: 'claim_required_field_missing' });
    }
    if (!issues.some(issue => issue.claimId === claim.id)) verifiedClaimIds.push(claim.id);
  }
  const unsafe = issues.some(issue => ['claim_evidence_owner_mismatch', 'claim_ai_inference_not_canonical'].includes(issue.code));
  const status = unsafe ? 'UNSAFE' : verifiedClaimIds.length === claims.length ? 'VERIFIED' : verifiedClaimIds.length ? 'PARTIAL' : 'MISSING_EVIDENCE';
  return { status, valid: status === 'VERIFIED', issues, verifiedClaimIds, evidenceIds: [...evidenceIds].sort() };
}

export function createEvidenceReplayBundle(input: Omit<EvidenceReplayBundle, 'schemaVersion' | 'createdAt'>): EvidenceReplayBundle {
  return { ...input, schemaVersion: EVIDENCE_SCHEMA_VERSION, evidenceIds: [...new Set(input.evidenceIds)].sort(), createdAt: new Date().toISOString() };
}
