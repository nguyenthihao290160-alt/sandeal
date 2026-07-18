import { createAutomationJob } from './store';
import { ensureOperationJournal, completeJournalEffect } from './operationJournal';
import { listCandidateQueue, markCandidateBridged } from '@/lib/storage/candidateQueue';

export interface CandidateBridgeResult {
  inspected: number;
  created: number;
  existing: number;
  skipped: number;
  jobs: Array<{ candidateId: string; jobId: string; created: boolean }>;
}

function candidateJobKey(candidateId: string, sourceHash: string): string {
  return `candidate:${candidateId}:${sourceHash}`.slice(0, 160);
}

export async function bridgeCandidatesToDurableJobs(input: {
  parentJobId?: string;
  requestedBy?: string;
  limit?: number;
  candidateIds?: string[];
} = {}): Promise<CandidateBridgeResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 25)));
  const requestedIds = input.candidateIds?.length ? new Set(input.candidateIds.slice(0, 100)) : null;
  const candidates = (await listCandidateQueue())
    .filter(item => ['pending', 'delayed', 'needs_review', 'failed'].includes(item.status) && (!requestedIds || requestedIds.has(item.id)))
    .sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, limit);
  const result: CandidateBridgeResult = { inspected: candidates.length, created: 0, existing: 0, skipped: 0, jobs: [] };

  for (const candidate of candidates) {
    const key = candidateJobKey(candidate.id, candidate.sourceHash);
    const operationId = `candidate-operation:${candidate.id}:${candidate.sourceHash}`.slice(0, 160);
    const created = await createAutomationJob({
      type: 'PROCESS_CANDIDATE',
      payload: { candidateId: candidate.id, sourceHash: candidate.sourceHash },
      priority: Math.max(1, Math.min(100, candidate.priority)),
      idempotencyKey: key,
      operationId,
      requestedBy: input.requestedBy || 'automation-bridge',
      parentJobId: input.parentJobId,
      dryRun: false,
    });
    await ensureOperationJournal({
      operationId,
      jobId: created.job.id,
      operationType: 'PROCESS_CANDIDATE',
      effects: [
        { id: 'candidate-bridge', description: 'Bind staging candidate to its durable job.', idempotencyKey: key, intendedValue: { candidateId: candidate.id, jobId: created.job.id } },
        { id: 'canonical-product', description: 'Create or update the canonical product.', idempotencyKey: `${key}:product` },
        { id: 'evidence-snapshot', description: 'Capture versioned evidence facts.', idempotencyKey: `${key}:evidence` },
        { id: 'publish-child', description: 'Create at most one guarded publish child job.', idempotencyKey: `${key}:publish` },
      ],
    });
    const marked = await markCandidateBridged(candidate.id, created.job.id, key);
    if (!marked) { result.skipped += 1; continue; }
    await completeJournalEffect(operationId, 'candidate-bridge', { candidateId: candidate.id, jobId: created.job.id });
    if (created.created) result.created += 1; else result.existing += 1;
    result.jobs.push({ candidateId: candidate.id, jobId: created.job.id, created: created.created });
  }
  return result;
}
