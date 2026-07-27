import { createHash } from 'crypto';

import type { EditorialClaim, Product, ReviewContent } from '../types';
import type { ProviderId } from '../automation/providerRegistry';

export const AI_CANONICAL_CONTRACT_SCHEMA_VERSION = 1;
export const AI_CANONICAL_CONTRACT_VERSION = 'ai-canonical-proposal-v1';

const MAX_SERIALIZED_BYTES = 256 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;

export interface AiCanonicalSuggestions {
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  benefits?: string[];
  warnings?: string[];
}

export interface AiCanonicalProposal {
  schemaVersion: number;
  contractVersion: string;
  providerId: ProviderId;
  modelId: string;
  promptVersion: string;
  inputHash: string;
  evidenceFactIds: string[];
  confidence: number;
  suggestions: AiCanonicalSuggestions;
  generatedAt: string;
  outputHash: string;
}

export interface AiCanonicalWriteOptions {
  minimumConfidence?: number;
  allowTitle?: boolean;
  allowDescription?: boolean;
  allowCategory?: boolean;
  allowLists?: boolean;
}

const ROOT_KEYS = new Set([
  'schemaVersion',
  'contractVersion',
  'providerId',
  'modelId',
  'promptVersion',
  'inputHash',
  'evidenceFactIds',
  'confidence',
  'suggestions',
  'generatedAt',
]);
const SUGGESTION_KEYS = new Set([
  'title',
  'description',
  'category',
  'tags',
  'benefits',
  'warnings',
]);
const PROVIDERS = new Set<ProviderId>(['deterministic-rules', 'gemini', 'local-ai']);

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
    && !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key));
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length >= minimum ? normalized.slice(0, maximum) : undefined;
}

function boundedList(value: unknown, maximumItems = 16, maximumLength = 240): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximumItems) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const normalized = boundedString(item, 1, maximumLength);
    if (!normalized) return undefined;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function strictIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString() === value ? value : undefined;
}

function strictHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function validateEvidenceIds(value: unknown, allowedEvidenceIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error('AI_CONTRACT_EVIDENCE_REQUIRED');
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !SAFE_ID.test(item) || !allowedEvidenceIds.has(item)) {
      throw new Error('AI_CONTRACT_EVIDENCE_INVALID');
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

export function parseAiCanonicalProposal(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>,
): AiCanonicalProposal {
  if (serializedBytes(value) > MAX_SERIALIZED_BYTES) {
    throw new Error('AI_CONTRACT_RESPONSE_TOO_LARGE');
  }
  const root = record(value);
  if (!root || !exactKeys(root, ROOT_KEYS)) throw new Error('AI_CONTRACT_ROOT_INVALID');
  if (
    root.schemaVersion !== AI_CANONICAL_CONTRACT_SCHEMA_VERSION
    || root.contractVersion !== AI_CANONICAL_CONTRACT_VERSION
    || typeof root.providerId !== 'string'
    || !PROVIDERS.has(root.providerId as ProviderId)
  ) {
    throw new Error('AI_CONTRACT_VERSION_OR_PROVIDER_INVALID');
  }
  const modelId = boundedString(root.modelId, 1, 160);
  const promptVersion = boundedString(root.promptVersion, 1, 160);
  const inputHash = strictHash(root.inputHash);
  const generatedAt = strictIso(root.generatedAt);
  const confidence = Number(root.confidence);
  if (
    !modelId
    || !promptVersion
    || !inputHash
    || !generatedAt
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
  ) {
    throw new Error('AI_CONTRACT_METADATA_INVALID');
  }
  const suggestions = record(root.suggestions);
  if (!suggestions || !exactKeys(suggestions, SUGGESTION_KEYS)) {
    throw new Error('AI_CONTRACT_SUGGESTIONS_INVALID');
  }
  const normalizedSuggestions: AiCanonicalSuggestions = {};
  if (suggestions.title !== undefined) {
    normalizedSuggestions.title = boundedString(suggestions.title, 3, 240);
    if (!normalizedSuggestions.title) throw new Error('AI_CONTRACT_TITLE_INVALID');
  }
  if (suggestions.description !== undefined) {
    normalizedSuggestions.description = boundedString(suggestions.description, 40, 4_096);
    if (!normalizedSuggestions.description) throw new Error('AI_CONTRACT_DESCRIPTION_INVALID');
  }
  if (suggestions.category !== undefined) {
    normalizedSuggestions.category = boundedString(suggestions.category, 2, 120);
    if (!normalizedSuggestions.category) throw new Error('AI_CONTRACT_CATEGORY_INVALID');
  }
  for (const key of ['tags', 'benefits', 'warnings'] as const) {
    if (suggestions[key] === undefined) continue;
    const list = boundedList(suggestions[key]);
    if (!list) throw new Error(`AI_CONTRACT_${key.toUpperCase()}_INVALID`);
    normalizedSuggestions[key] = list;
  }
  if (Object.keys(normalizedSuggestions).length === 0) {
    throw new Error('AI_CONTRACT_SUGGESTIONS_EMPTY');
  }
  const evidenceFactIds = validateEvidenceIds(root.evidenceFactIds, allowedEvidenceIds);
  const normalized = {
    schemaVersion: AI_CANONICAL_CONTRACT_SCHEMA_VERSION,
    contractVersion: AI_CANONICAL_CONTRACT_VERSION,
    providerId: root.providerId as ProviderId,
    modelId,
    promptVersion,
    inputHash,
    evidenceFactIds,
    confidence,
    suggestions: normalizedSuggestions,
    generatedAt,
  };
  return {
    ...normalized,
    outputHash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}

export function canonicalPatchFromAiProposal(
  proposal: AiCanonicalProposal,
  options: AiCanonicalWriteOptions = {},
): Partial<Product> {
  const minimumConfidence = Math.max(0.8, Math.min(1, options.minimumConfidence || 0.9));
  if (
    proposal.contractVersion !== AI_CANONICAL_CONTRACT_VERSION
    || proposal.schemaVersion !== AI_CANONICAL_CONTRACT_SCHEMA_VERSION
    || proposal.confidence < minimumConfidence
    || proposal.evidenceFactIds.length === 0
  ) {
    throw new Error('AI_CANONICAL_WRITE_NOT_ELIGIBLE');
  }
  const patch: Partial<Product> = {};
  if (options.allowTitle && proposal.suggestions.title) patch.title = proposal.suggestions.title;
  if (options.allowDescription && proposal.suggestions.description) {
    patch.description = proposal.suggestions.description;
  }
  if (options.allowCategory && proposal.suggestions.category) {
    patch.category = proposal.suggestions.category;
  }
  if (options.allowLists) {
    if (proposal.suggestions.tags) patch.tags = [...proposal.suggestions.tags];
    if (proposal.suggestions.benefits) patch.benefits = [...proposal.suggestions.benefits];
    if (proposal.suggestions.warnings) patch.warnings = [...proposal.suggestions.warnings];
  }
  if (Object.keys(patch).length === 0) throw new Error('AI_CANONICAL_WRITE_SCOPE_EMPTY');
  return patch;
}

const EDITORIAL_KEYS = new Set([
  'reviewTitle',
  'reviewSummary',
  'reviewVerdict',
  'suitableFor',
  'notSuitableFor',
  'buyingConsiderations',
  'factualClaims',
  'inferredClaims',
  'unknownClaims',
]);
const CLAIM_KEYS = new Set(['id', 'text', 'claimType', 'evidenceFactIds', 'confidence']);

function editorialClaim(
  value: unknown,
  expectedType: EditorialClaim['claimType'],
  allowedEvidenceIds: ReadonlySet<string>,
): EditorialClaim {
  const input = record(value);
  if (!input || !exactKeys(input, CLAIM_KEYS)) throw new Error('AI_EDITORIAL_CLAIM_INVALID');
  const id = boundedString(input.id, 1, 160);
  const text = boundedString(input.text, 3, 1_000);
  const confidence = input.confidence;
  if (
    !id
    || !SAFE_ID.test(id)
    || !text
    || input.claimType !== expectedType
    || !['high', 'medium', 'low', 'unknown'].includes(String(confidence))
    || !Array.isArray(input.evidenceFactIds)
    || input.evidenceFactIds.length > 32
  ) {
    throw new Error('AI_EDITORIAL_CLAIM_INVALID');
  }
  const evidenceFactIds = [...new Set(input.evidenceFactIds.map(item => {
    if (typeof item !== 'string' || !SAFE_ID.test(item) || !allowedEvidenceIds.has(item)) {
      throw new Error('AI_EDITORIAL_EVIDENCE_INVALID');
    }
    return item;
  }))];
  if (expectedType === 'factual' && evidenceFactIds.length === 0) {
    throw new Error('AI_EDITORIAL_FACT_EVIDENCE_REQUIRED');
  }
  return {
    id,
    text,
    claimType: expectedType,
    evidenceFactIds,
    confidence: confidence as EditorialClaim['confidence'],
  };
}

function claimList(
  value: unknown,
  expectedType: EditorialClaim['claimType'],
  allowedEvidenceIds: ReadonlySet<string>,
): EditorialClaim[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('AI_EDITORIAL_CLAIMS_INVALID');
  return value.map(item => editorialClaim(item, expectedType, allowedEvidenceIds));
}

export function parseStrictEditorialProposal(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>,
): Pick<
  ReviewContent,
  | 'reviewTitle'
  | 'reviewSummary'
  | 'reviewVerdict'
  | 'suitableFor'
  | 'notSuitableFor'
  | 'buyingConsiderations'
  | 'factualClaims'
  | 'inferredClaims'
  | 'unknownClaims'
> {
  if (serializedBytes(value) > MAX_SERIALIZED_BYTES) {
    throw new Error('AI_EDITORIAL_RESPONSE_TOO_LARGE');
  }
  const input = record(value);
  if (!input || !exactKeys(input, EDITORIAL_KEYS)) throw new Error('AI_EDITORIAL_ROOT_INVALID');
  const reviewTitle = boundedString(input.reviewTitle, 12, 240);
  const reviewSummary = boundedString(input.reviewSummary, 80, 4_096);
  const reviewVerdict = boundedString(input.reviewVerdict, 12, 1_000);
  const suitableFor = boundedList(input.suitableFor, 16, 240);
  const notSuitableFor = boundedList(input.notSuitableFor, 16, 240);
  const buyingConsiderations = boundedList(input.buyingConsiderations, 16, 400);
  if (
    !reviewTitle
    || !reviewSummary
    || !reviewVerdict
    || !suitableFor
    || !notSuitableFor
    || !buyingConsiderations
  ) {
    throw new Error('AI_EDITORIAL_TEXT_INVALID');
  }
  return {
    reviewTitle,
    reviewSummary,
    reviewVerdict,
    suitableFor,
    notSuitableFor,
    buyingConsiderations,
    factualClaims: claimList(input.factualClaims, 'factual', allowedEvidenceIds),
    inferredClaims: claimList(input.inferredClaims, 'inferred', allowedEvidenceIds),
    unknownClaims: claimList(input.unknownClaims, 'unknown', allowedEvidenceIds),
  };
}
