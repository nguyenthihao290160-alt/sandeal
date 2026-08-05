import { AutomationJobEnqueueError, createAutomationJob } from './store';
import { ensureOperationJournal, completeJournalEffect } from './operationJournal';
import { listCandidateQueue, markCandidateBridged } from '@/lib/storage/candidateQueue';
import { listDomainCircuitStates } from '@/lib/bots/domainCircuitBreaker';

export interface CandidateBridgeResult {
  inspected: number;
  created: number;
  existing: number;
  skipped: number;
  jobs: Array<{ candidateId: string; jobId: string; created: boolean }>;
}

function candidateJobKey(candidateId: string, sourceHash: string, generation = 0): string {
  return `candidate:${candidateId}:${sourceHash}:g${Math.max(0, Math.floor(generation))}`.slice(0, 160);
}

export async function bridgeCandidatesToDurableJobs(input: {
  parentJobId?: string;
  requestedBy?: string;
  limit?: number;
  candidateIds?: string[];
} = {}): Promise<CandidateBridgeResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 25)));
  const requestedIds = input.candidateIds?.length ? new Set(input.candidateIds.slice(0, 100)) : null;
  const now = Date.now();
  const circuits = await listDomainCircuitStates();
  const blockedMerchants = new Set(circuits
    .filter(item => item.role === 'MERCHANT' && (item.state === 'OPEN' || item.state === 'HALF_OPEN' && item.halfOpenProbeInFlight))
    .map(item => item.domain));
  const candidates = (await listCandidateQueue())
    .filter(item => ['pending', 'delayed'].includes(item.status)
      && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
      && (!requestedIds || requestedIds.has(item.id)))
    .sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.min(100, limit * 4));
  const result: CandidateBridgeResult = { inspected: candidates.length, created: 0, existing: 0, skipped: 0, jobs: [] };

  for (const candidate of candidates) {
    if (result.jobs.length >= limit) break;
    let merchantDomain = candidate.merchantDomain || candidate.payload.merchantDomain || '';
    if (!merchantDomain) {
      try { merchantDomain = new URL(candidate.payload.canonicalProductUrl || candidate.payload.originalUrl).hostname.toLowerCase().replace(/^www\./, ''); }
      catch { merchantDomain = 'invalid'; }
    }
    if (blockedMerchants.has(merchantDomain)) {
      result.skipped += 1;
      continue;
    }
    const generation = Math.max(0, Math.floor(Number(candidate.durableJobGeneration) || 0));
    const key = candidateJobKey(candidate.id, candidate.sourceHash, generation);
    const operationId = `candidate-operation:${candidate.id}:${candidate.sourceHash}:g${generation}`.slice(0, 160);
    let created;
    try {
      created = await createAutomationJob({
        type: 'PROCESS_CANDIDATE',
        payload: { candidateId: candidate.id, sourceHash: candidate.sourceHash },
        priority: Math.max(1, Math.min(100, candidate.priority)),
        idempotencyKey: key,
        operationId,
        requestedBy: input.requestedBy || 'automation-bridge',
        parentJobId: input.parentJobId,
        dryRun: false,
      });
    } catch (error) {
      if (error instanceof AutomationJobEnqueueError && error.code === 'DAILY_PRODUCT_LIMIT_REACHED') {
        result.skipped += candidates.length - result.jobs.length;
        break;
      }
      throw error;
    }
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
