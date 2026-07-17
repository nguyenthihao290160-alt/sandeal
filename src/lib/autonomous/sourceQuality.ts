import { createHash } from 'node:crypto';
import { readCollection, runTransaction } from '@/lib/storage/adapter';

const COLLECTION = 'source-quality';
export const SOURCE_QUALITY_SCHEMA_VERSION = 1;
export const SOURCE_QUALITY_RULE_VERSION = 'source-quality-v1';

export interface SourceQualityCounters {
  candidatesObserved: number;
  validCandidates: number;
  linksChecked: number;
  healthyLinks: number;
  imagesChecked: number;
  healthyImages: number;
  pricesChecked: number;
  pricesAvailable: number;
  publishedProducts: number;
  rolledBackProducts: number;
  timeouts: number;
  externalRequests: number;
}

export interface SourceQualityRates {
  candidateValidity: number | null;
  linkHealth: number | null;
  imageHealth: number | null;
  priceAvailability: number | null;
  publishRate: number | null;
  rollbackRate: number | null;
  timeoutRate: number | null;
  requestsPerPublishedProduct: number | null;
}

export type SourcePriorityClass = 'UNVERIFIED' | 'PREFERRED' | 'STANDARD' | 'DEPRIORITIZED' | 'SEVERELY_DEGRADED';

export interface SourceQualityObservation {
  idempotencyKey: string;
  observedAt?: string;
  candidatesObserved?: number;
  validCandidates?: number;
  linksChecked?: number;
  healthyLinks?: number;
  imagesChecked?: number;
  healthyImages?: number;
  pricesChecked?: number;
  pricesAvailable?: number;
  publishedProducts?: number;
  rolledBackProducts?: number;
  timeouts?: number;
  externalRequests?: number;
}

export interface PersistedSourceQualityObservation extends SourceQualityCounters {
  idempotencyKey: string;
  contentHash: string;
  observedAt: string;
}

export interface SourceQualitySnapshot {
  schemaVersion: number;
  id: string;
  sourceId: string;
  counters: SourceQualityCounters;
  rates: SourceQualityRates;
  qualityScore: number;
  sampleSufficient: boolean;
  priorityClass: SourcePriorityClass;
  priorityMultiplier: number;
  observations: PersistedSourceQualityObservation[];
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
  lastObservedAt: string;
}

export interface SourcePriorityDecision {
  sourceId: string;
  basePriority: number;
  effectivePriority: number;
  qualityScore: number | null;
  priorityClass: SourcePriorityClass;
  priorityMultiplier: number;
  ruleVersion: string;
}

const COUNTER_KEYS: Array<keyof SourceQualityCounters> = [
  'candidatesObserved',
  'validCandidates',
  'linksChecked',
  'healthyLinks',
  'imagesChecked',
  'healthyImages',
  'pricesChecked',
  'pricesAvailable',
  'publishedProducts',
  'rolledBackProducts',
  'timeouts',
  'externalRequests',
];

function emptyCounters(): SourceQualityCounters {
  return {
    candidatesObserved: 0,
    validCandidates: 0,
    linksChecked: 0,
    healthyLinks: 0,
    imagesChecked: 0,
    healthyImages: 0,
    pricesChecked: 0,
    pricesAvailable: 0,
    publishedProducts: 0,
    rolledBackProducts: 0,
    timeouts: 0,
    externalRequests: 0,
  };
}

function normalizeSourceId(value: string): string {
  const sourceId = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(sourceId)) throw new Error('SOURCE_QUALITY_SOURCE_ID_INVALID');
  return sourceId;
}

function normalizeCount(value: unknown): number {
  const count = Number(value || 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000) throw new Error('SOURCE_QUALITY_COUNTER_INVALID');
  return count;
}

function normalizeObservation(input: SourceQualityObservation): PersistedSourceQualityObservation {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('SOURCE_QUALITY_IDEMPOTENCY_KEY_INVALID');
  const observedAt = input.observedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('SOURCE_QUALITY_OBSERVED_AT_INVALID');
  const counters = emptyCounters();
  for (const key of COUNTER_KEYS) counters[key] = normalizeCount(input[key]);
  if (counters.validCandidates > counters.candidatesObserved
    || counters.healthyLinks > counters.linksChecked
    || counters.healthyImages > counters.imagesChecked
    || counters.pricesAvailable > counters.pricesChecked
    || counters.timeouts > counters.externalRequests) {
    throw new Error('SOURCE_QUALITY_COUNTER_RELATION_INVALID');
  }
  const canonical = { idempotencyKey, observedAt: new Date(observedAt).toISOString(), ...counters };
  return {
    ...canonical,
    contentHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round(Math.min(1, Math.max(0, numerator / denominator)) * 10_000) / 10_000;
}

function ratioOrNeutral(value: number | null): number {
  return value === null ? 0.5 : value;
}

function metrics(counters: SourceQualityCounters): { rates: SourceQualityRates; qualityScore: number; sampleSufficient: boolean } {
  const rates: SourceQualityRates = {
    candidateValidity: rate(counters.validCandidates, counters.candidatesObserved),
    linkHealth: rate(counters.healthyLinks, counters.linksChecked),
    imageHealth: rate(counters.healthyImages, counters.imagesChecked),
    priceAvailability: rate(counters.pricesAvailable, counters.pricesChecked),
    publishRate: rate(counters.publishedProducts, counters.validCandidates),
    rollbackRate: rate(counters.rolledBackProducts, counters.publishedProducts),
    timeoutRate: rate(counters.timeouts, counters.externalRequests),
    requestsPerPublishedProduct: counters.publishedProducts > 0
      ? Math.round((counters.externalRequests / counters.publishedProducts) * 100) / 100
      : null,
  };
  const requestEfficiency = counters.externalRequests > 0
    ? Math.min(1, (counters.publishedProducts / counters.externalRequests) * 5)
    : 0.5;
  const rawScore = (
    ratioOrNeutral(rates.candidateValidity) * 25
    + ratioOrNeutral(rates.linkHealth) * 15
    + ratioOrNeutral(rates.imageHealth) * 15
    + ratioOrNeutral(rates.priceAvailability) * 15
    + ratioOrNeutral(rates.publishRate) * 15
    + (1 - ratioOrNeutral(rates.rollbackRate)) * 7.5
    + (1 - ratioOrNeutral(rates.timeoutRate)) * 5
    + requestEfficiency * 2.5
  );
  return {
    rates,
    qualityScore: Math.round(Math.min(100, Math.max(0, rawScore)) * 100) / 100,
    sampleSufficient: counters.candidatesObserved >= 10 || counters.externalRequests >= 10 || counters.publishedProducts >= 3,
  };
}

function priority(score: number, sampleSufficient: boolean): { priorityClass: SourcePriorityClass; priorityMultiplier: number } {
  if (!sampleSufficient) return { priorityClass: 'UNVERIFIED', priorityMultiplier: 1 };
  if (score >= 85) return { priorityClass: 'PREFERRED', priorityMultiplier: 1 };
  if (score >= 70) return { priorityClass: 'STANDARD', priorityMultiplier: 0.85 };
  if (score >= 50) return { priorityClass: 'DEPRIORITIZED', priorityMultiplier: 0.6 };
  if (score >= 30) return { priorityClass: 'DEPRIORITIZED', priorityMultiplier: 0.4 };
  return { priorityClass: 'SEVERELY_DEGRADED', priorityMultiplier: 0.2 };
}

function aggregate(observations: PersistedSourceQualityObservation[]): SourceQualityCounters {
  const counters = emptyCounters();
  for (const observation of observations) {
    for (const key of COUNTER_KEYS) counters[key] += observation[key];
  }
  return counters;
}

function rebuild(snapshot: SourceQualitySnapshot): SourceQualitySnapshot {
  const counters = aggregate(snapshot.observations || []);
  const calculated = metrics(counters);
  const priorityDecision = priority(calculated.qualityScore, calculated.sampleSufficient);
  const lastObservedAt = (snapshot.observations || [])
    .map(observation => observation.observedAt)
    .sort()
    .at(-1) || snapshot.lastObservedAt;
  return {
    ...snapshot,
    schemaVersion: SOURCE_QUALITY_SCHEMA_VERSION,
    counters,
    rates: calculated.rates,
    qualityScore: calculated.qualityScore,
    sampleSufficient: calculated.sampleSufficient,
    ...priorityDecision,
    ruleVersion: SOURCE_QUALITY_RULE_VERSION,
    lastObservedAt,
  };
}

export async function recordSourceQualityObservation(
  source: string,
  input: SourceQualityObservation,
): Promise<{ snapshot: SourceQualitySnapshot; recorded: boolean }> {
  const sourceId = normalizeSourceId(source);
  const observation = normalizeObservation(input);
  let output!: SourceQualitySnapshot;
  let recorded = false;
  await runTransaction<SourceQualitySnapshot>(COLLECTION, snapshots => {
    const index = snapshots.findIndex(item => item.sourceId === sourceId);
    const existing = index >= 0 ? rebuild(snapshots[index]) : null;
    const replay = existing?.observations.find(item => item.idempotencyKey === observation.idempotencyKey);
    if (replay) {
      if (replay.contentHash !== observation.contentHash) throw new Error('SOURCE_QUALITY_OBSERVATION_CONFLICT');
      output = existing!;
      return undefined;
    }
    const now = new Date().toISOString();
    const next = rebuild(existing ? {
      ...existing,
      observations: [...existing.observations, observation],
      updatedAt: now,
      lastObservedAt: observation.observedAt,
    } : {
      schemaVersion: SOURCE_QUALITY_SCHEMA_VERSION,
      id: `source-quality:${sourceId}`,
      sourceId,
      counters: emptyCounters(),
      rates: metrics(emptyCounters()).rates,
      qualityScore: 50,
      sampleSufficient: false,
      priorityClass: 'UNVERIFIED',
      priorityMultiplier: 1,
      observations: [observation],
      ruleVersion: SOURCE_QUALITY_RULE_VERSION,
      createdAt: now,
      updatedAt: now,
      lastObservedAt: observation.observedAt,
    });
    if (index >= 0) snapshots[index] = next;
    else snapshots.push(next);
    output = next;
    recorded = true;
    return snapshots;
  });
  return { snapshot: structuredClone(output), recorded };
}

export async function getSourceQualitySnapshot(source: string): Promise<SourceQualitySnapshot | null> {
  const sourceId = normalizeSourceId(source);
  const found = (await readCollection<SourceQualitySnapshot>(COLLECTION)).find(item => item.sourceId === sourceId);
  return found ? rebuild(found) : null;
}

export async function listSourceQualitySnapshots(): Promise<SourceQualitySnapshot[]> {
  return (await readCollection<SourceQualitySnapshot>(COLLECTION))
    .map(rebuild)
    .sort((left, right) => right.qualityScore - left.qualityScore || left.sourceId.localeCompare(right.sourceId));
}

export function applySourceQualityPriority(basePriority: number, snapshot: SourceQualitySnapshot | null): SourcePriorityDecision {
  const normalizedBase = Math.max(1, Math.min(100, Math.round(Number(basePriority) || 1)));
  const priorityDecision = snapshot
    ? priority(snapshot.qualityScore, snapshot.sampleSufficient)
    : { priorityClass: 'UNVERIFIED' as const, priorityMultiplier: 1 };
  return {
    sourceId: snapshot?.sourceId || 'unverified',
    basePriority: normalizedBase,
    effectivePriority: Math.max(1, Math.min(100, Math.round(normalizedBase * priorityDecision.priorityMultiplier))),
    qualityScore: snapshot?.qualityScore ?? null,
    ...priorityDecision,
    ruleVersion: SOURCE_QUALITY_RULE_VERSION,
  };
}

export async function getSourcePriorityDecision(source: string, basePriority: number): Promise<SourcePriorityDecision> {
  const sourceId = normalizeSourceId(source);
  const snapshot = await getSourceQualitySnapshot(sourceId);
  const decision = applySourceQualityPriority(basePriority, snapshot);
  return { ...decision, sourceId };
}
