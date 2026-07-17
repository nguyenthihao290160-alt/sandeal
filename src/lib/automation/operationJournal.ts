import { createHash } from 'node:crypto';
import { generateId, readCollection, runTransaction } from '@/lib/storage/adapter';

const COLLECTION = 'operation-journal';
export const OPERATION_JOURNAL_EFFECT_LEASE_MS = 2 * 60_000;

export interface OperationJournalEffect {
  id: string;
  description: string;
  idempotencyKey: string;
  /** Schema-v1 compatibility. New code uses intendedChecksum. */
  checksum?: string;
  intendedChecksum?: string;
  actualChecksum?: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  attempts: number;
  ownerId?: string;
  previousOwnerId?: string;
  reclaimCount?: number;
  startedAt?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface OperationJournalEntry {
  schemaVersion: number;
  id: string;
  operationId: string;
  jobId?: string;
  operationType: string;
  contractHash: string;
  intendedEffects: OperationJournalEffect[];
  completedEffects: string[];
  pendingEffects: string[];
  idempotencyKeys: string[];
  intendedChecksums: Record<string, string>;
  actualChecksums: Record<string, string>;
  /** Schema-v1 compatibility. Actual hashes take precedence in this view. */
  checksums: Record<string, string>;
  reconciliationStatus: 'PENDING' | 'CONSISTENT' | 'REPAIRING' | 'REPAIRED' | 'BLOCKED';
  integrityError?: string;
  blockedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type JournalEffectClaimStatus = 'CLAIMED' | 'OWNED' | 'RECLAIMED' | 'COMPLETED' | 'IN_PROGRESS';

export interface JournalEffectClaim {
  status: JournalEffectClaimStatus;
  ownerId: string;
  activeOwnerId?: string;
  leaseExpiresAt?: string;
  attempts: number;
}

interface EffectContractInput {
  id: string;
  description: string;
  idempotencyKey: string;
  intendedValue?: unknown;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function contractHash(jobId: string | undefined, operationType: string, effects: OperationJournalEffect[]): string {
  const contract = effects
    .map(effect => ({
      id: effect.id,
      description: effect.description,
      idempotencyKey: effect.idempotencyKey,
      intendedChecksum: effect.intendedChecksum || effect.checksum || null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return checksum({ jobId: jobId || null, operationType, effects: contract });
}

function buildEffects(effects: EffectContractInput[]): OperationJournalEffect[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  return effects.map(effect => {
    const id = effect.id.trim();
    const idempotencyKey = effect.idempotencyKey.trim();
    if (!id || !idempotencyKey || ids.has(id) || keys.has(idempotencyKey)) throw new Error('JOURNAL_CONTRACT_INVALID');
    ids.add(id);
    keys.add(idempotencyKey);
    const intendedChecksum = effect.intendedValue === undefined ? undefined : checksum(effect.intendedValue);
    return {
      id,
      description: effect.description.trim(),
      idempotencyKey,
      checksum: intendedChecksum,
      intendedChecksum,
      status: 'PENDING',
      attempts: 0,
      reclaimCount: 0,
    };
  });
}

function normalizeEntry(entry: OperationJournalEntry): OperationJournalEntry {
  const legacyChecksums = entry.checksums || {};
  const intendedChecksums = { ...(entry.intendedChecksums || {}) };
  const actualChecksums = { ...(entry.actualChecksums || {}) };
  const intendedEffects = (entry.intendedEffects || []).map(effect => {
    const intendedChecksum = effect.intendedChecksum || effect.checksum || intendedChecksums[effect.id];
    const actualChecksum = effect.actualChecksum
      || actualChecksums[effect.id]
      || (effect.status === 'COMPLETED' ? legacyChecksums[effect.id] : undefined);
    if (intendedChecksum) intendedChecksums[effect.id] = intendedChecksum;
    if (actualChecksum) actualChecksums[effect.id] = actualChecksum;
    return {
      ...effect,
      checksum: intendedChecksum,
      intendedChecksum,
      actualChecksum,
      reclaimCount: effect.reclaimCount || 0,
    };
  });
  return {
    ...entry,
    schemaVersion: 2,
    contractHash: contractHash(entry.jobId, entry.operationType, intendedEffects),
    intendedEffects,
    completedEffects: [...new Set(entry.completedEffects || intendedEffects.filter(effect => effect.status === 'COMPLETED').map(effect => effect.id))],
    pendingEffects: intendedEffects.filter(effect => effect.status !== 'COMPLETED').map(effect => effect.id),
    idempotencyKeys: intendedEffects.map(effect => effect.idempotencyKey),
    intendedChecksums,
    actualChecksums,
    checksums: { ...intendedChecksums, ...actualChecksums },
  };
}

export async function ensureOperationJournal(input: {
  operationId: string;
  jobId?: string;
  operationType: string;
  effects: EffectContractInput[];
}): Promise<OperationJournalEntry> {
  const requestedEffects = buildEffects(input.effects);
  const requestedContractHash = contractHash(input.jobId, input.operationType, requestedEffects);
  let output!: OperationJournalEntry;
  let contractMismatch = false;
  const now = new Date().toISOString();
  await runTransaction<OperationJournalEntry>(COLLECTION, entries => {
    const index = entries.findIndex(item => item.operationId === input.operationId);
    if (index >= 0) {
      const existing = normalizeEntry(entries[index]);
      if (existing.contractHash !== requestedContractHash) {
        existing.reconciliationStatus = 'BLOCKED';
        existing.integrityError = 'JOURNAL_CONTRACT_MISMATCH';
        existing.blockedAt ||= now;
        existing.updatedAt = now;
        entries[index] = existing;
        output = existing;
        contractMismatch = true;
        return entries;
      }
      entries[index] = existing;
      output = existing;
      return entries;
    }
    const intendedChecksums = Object.fromEntries(requestedEffects.filter(effect => effect.intendedChecksum).map(effect => [effect.id, effect.intendedChecksum!]));
    output = {
      schemaVersion: 2,
      id: generateId(),
      operationId: input.operationId,
      jobId: input.jobId,
      operationType: input.operationType,
      contractHash: requestedContractHash,
      intendedEffects: requestedEffects,
      completedEffects: [],
      pendingEffects: requestedEffects.map(effect => effect.id),
      idempotencyKeys: requestedEffects.map(effect => effect.idempotencyKey),
      intendedChecksums,
      actualChecksums: {},
      checksums: { ...intendedChecksums },
      reconciliationStatus: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    entries.push(output);
    return entries;
  });
  if (contractMismatch) throw new Error('JOURNAL_CONTRACT_MISMATCH');
  return structuredClone(output);
}

export async function getOperationJournal(operationId: string): Promise<OperationJournalEntry | null> {
  const found = (await readCollection<OperationJournalEntry>(COLLECTION)).find(item => item.operationId === operationId);
  return found ? normalizeEntry(found) : null;
}

async function claimEffect(
  operationId: string,
  effectId: string,
  ownerId: string | undefined,
  nowMs: number,
): Promise<JournalEffectClaim> {
  let result!: JournalEffectClaim;
  const now = new Date(nowMs).toISOString();
  await runTransaction<OperationJournalEntry>(COLLECTION, entries => {
    const index = entries.findIndex(item => item.operationId === operationId);
    if (index < 0) throw new Error('JOURNAL_EFFECT_NOT_FOUND');
    const journal = normalizeEntry(entries[index]);
    const effect = journal.intendedEffects.find(item => item.id === effectId);
    if (!effect) throw new Error('JOURNAL_EFFECT_NOT_FOUND');
    if (journal.reconciliationStatus === 'BLOCKED') throw new Error('JOURNAL_BLOCKED');
    const claimOwner = ownerId || '';
    if (effect.status === 'COMPLETED') {
      result = { status: 'COMPLETED', ownerId: claimOwner, activeOwnerId: effect.ownerId, attempts: effect.attempts };
      return undefined;
    }
    const leaseExpiryMs = Date.parse(effect.leaseExpiresAt || '')
      || (effect.startedAt ? Date.parse(effect.startedAt) + OPERATION_JOURNAL_EFFECT_LEASE_MS : Number.NaN);
    const leaseActive = effect.status === 'IN_PROGRESS' && Number.isFinite(leaseExpiryMs) && leaseExpiryMs > nowMs;
    if (leaseActive && (!ownerId || effect.ownerId !== ownerId)) {
      result = { status: 'IN_PROGRESS', ownerId: claimOwner, activeOwnerId: effect.ownerId, leaseExpiresAt: new Date(leaseExpiryMs).toISOString(), attempts: effect.attempts };
      return undefined;
    }
    const sameOwner = leaseActive && Boolean(ownerId) && effect.ownerId === ownerId;
    const reclaiming = effect.status === 'IN_PROGRESS' && !leaseActive;
    if (reclaiming) {
      effect.previousOwnerId = effect.ownerId;
      effect.reclaimCount = (effect.reclaimCount || 0) + 1;
    }
    if (!sameOwner) effect.attempts += 1;
    effect.status = 'IN_PROGRESS';
    effect.ownerId = ownerId;
    effect.startedAt = now;
    effect.leaseExpiresAt = new Date(nowMs + OPERATION_JOURNAL_EFFECT_LEASE_MS).toISOString();
    effect.lastError = undefined;
    journal.reconciliationStatus = reclaiming || effect.attempts > 1 ? 'REPAIRING' : 'PENDING';
    journal.updatedAt = now;
    entries[index] = journal;
    result = {
      status: sameOwner ? 'OWNED' : reclaiming ? 'RECLAIMED' : 'CLAIMED',
      ownerId: claimOwner,
      activeOwnerId: effect.ownerId,
      leaseExpiresAt: effect.leaseExpiresAt,
      attempts: effect.attempts,
    };
    return entries;
  });
  return result;
}

export async function claimJournalEffect(operationId: string, effectId: string, ownerId: string, nowMs = Date.now()): Promise<JournalEffectClaim> {
  const normalizedOwner = ownerId.trim();
  if (!normalizedOwner || normalizedOwner.length > 200) throw new Error('JOURNAL_EFFECT_OWNER_INVALID');
  return claimEffect(operationId, effectId, normalizedOwner, nowMs);
}

/** Schema-v1 compatibility wrapper. New business effects should use claimJournalEffect. */
export async function beginJournalEffect(operationId: string, effectId: string, nowMs = Date.now()): Promise<'CLAIMED' | 'COMPLETED' | 'IN_PROGRESS'> {
  const result = await claimEffect(operationId, effectId, undefined, nowMs);
  if (result.status === 'COMPLETED') return 'COMPLETED';
  if (result.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  return 'CLAIMED';
}

function ownerFrom(options?: { ownerId?: string } | string): string | undefined {
  return typeof options === 'string' ? options : options?.ownerId;
}

export async function completeJournalEffect(
  operationId: string,
  effectId: string,
  actualValue?: unknown,
  options?: { ownerId?: string } | string,
): Promise<OperationJournalEntry> {
  const ownerId = ownerFrom(options);
  const actualChecksum = actualValue === undefined ? undefined : checksum(actualValue);
  let output!: OperationJournalEntry;
  let resultMismatch = false;
  const now = new Date().toISOString();
  await runTransaction<OperationJournalEntry>(COLLECTION, entries => {
    const index = entries.findIndex(item => item.operationId === operationId);
    if (index < 0) throw new Error('JOURNAL_EFFECT_NOT_FOUND');
    const journal = normalizeEntry(entries[index]);
    const effect = journal.intendedEffects.find(item => item.id === effectId);
    if (!effect) throw new Error('JOURNAL_EFFECT_NOT_FOUND');
    if (journal.reconciliationStatus === 'BLOCKED') throw new Error('JOURNAL_BLOCKED');
    if (effect.status === 'IN_PROGRESS' && effect.ownerId && effect.ownerId !== ownerId) throw new Error('JOURNAL_EFFECT_OWNERSHIP_MISMATCH');
    if (effect.status === 'COMPLETED') {
      if (actualChecksum && effect.actualChecksum && actualChecksum !== effect.actualChecksum) {
        journal.reconciliationStatus = 'BLOCKED';
        journal.integrityError = 'JOURNAL_EFFECT_RESULT_MISMATCH';
        journal.blockedAt ||= now;
        journal.updatedAt = now;
        entries[index] = journal;
        output = structuredClone(journal);
        resultMismatch = true;
        return entries;
      }
      output = structuredClone(journal);
      return undefined;
    }
    effect.status = 'COMPLETED';
    effect.completedAt ||= now;
    effect.leaseExpiresAt = undefined;
    effect.lastError = undefined;
    if (actualChecksum) {
      effect.actualChecksum = actualChecksum;
      journal.actualChecksums[effectId] = actualChecksum;
      journal.checksums[effectId] = actualChecksum;
    }
    journal.completedEffects = [...new Set([...journal.completedEffects, effectId])];
    journal.pendingEffects = journal.intendedEffects.filter(item => item.status !== 'COMPLETED').map(item => item.id);
    journal.reconciliationStatus = journal.pendingEffects.length ? 'PENDING' : 'CONSISTENT';
    journal.updatedAt = now;
    entries[index] = journal;
    output = structuredClone(journal);
    return entries;
  });
  if (resultMismatch) throw new Error('JOURNAL_EFFECT_RESULT_MISMATCH');
  return output;
}

export async function failJournalEffect(
  operationId: string,
  effectId: string,
  error: unknown,
  options?: { ownerId?: string } | string,
): Promise<void> {
  const ownerId = ownerFrom(options);
  await runTransaction<OperationJournalEntry>(COLLECTION, entries => {
    const index = entries.findIndex(item => item.operationId === operationId);
    if (index < 0) return undefined;
    const journal = normalizeEntry(entries[index]);
    const effect = journal.intendedEffects.find(item => item.id === effectId);
    if (!effect || effect.status === 'COMPLETED') return undefined;
    if (effect.ownerId && effect.ownerId !== ownerId) throw new Error('JOURNAL_EFFECT_OWNERSHIP_MISMATCH');
    effect.status = 'FAILED';
    effect.leaseExpiresAt = undefined;
    effect.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    journal.pendingEffects = journal.intendedEffects.filter(item => item.status !== 'COMPLETED').map(item => item.id);
    if (journal.reconciliationStatus !== 'BLOCKED') journal.reconciliationStatus = 'PENDING';
    journal.updatedAt = new Date().toISOString();
    entries[index] = journal;
    return entries;
  });
}

export async function listInconsistentJournals(): Promise<OperationJournalEntry[]> {
  return (await readCollection<OperationJournalEntry>(COLLECTION))
    .map(normalizeEntry)
    .filter(item => item.reconciliationStatus !== 'CONSISTENT');
}
