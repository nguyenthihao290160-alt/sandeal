import {
  activatePreparedCandidateAutomationJob,
  AutomationJobEnqueueError,
  cancelAutomationJob,
  createAutomationJob,
  getAutomationJob,
} from './store';
import { ensureOperationJournal, completeJournalEffect } from './operationJournal';
import {
  advanceCandidateBridgeGeneration,
  advanceUnboundCandidateBridgeGeneration,
  bindCandidateToHistoricalDurableJob,
  bindCandidateToPreparedDurableJob,
  candidateDurableJobBindingCommitGuard,
  candidateDurableJobKey,
  candidateDurableOperationId,
  candidateHasAuthoritativeDurableJobBinding,
  completeCandidateDurableJobBinding,
  listCandidateQueue,
  readCandidateDurableJobGeneration,
  requestCandidateBridgeGenerationAdvance,
  type CandidateDurableJobBinding,
  type CandidateQueueItem,
} from '@/lib/storage/candidateQueue';
import { listDomainCircuitStates } from '@/lib/bots/domainCircuitBreaker';
import type { AutomationJob } from './types';

export interface CandidateBridgeResult {
  inspected: number;
  created: number;
  existing: number;
  skipped: number;
  jobs: Array<{ candidateId: string; jobId: string; created: boolean }>;
}

export function candidateJobKey(candidateId: string, sourceHash: string, generation = 0): string {
  return candidateDurableJobKey(candidateId, sourceHash, generation);
}

export function candidateOperationId(candidateId: string, sourceHash: string, generation = 0): string {
  return candidateDurableOperationId(candidateId, sourceHash, generation);
}

function candidateJobMatches(
  job: AutomationJob,
  candidate: CandidateQueueItem,
  generation: number,
  key: string,
  operationId: string,
): boolean {
  const payloadGeneration = job.payload.generation;
  return job.type === 'PROCESS_CANDIDATE'
    && job.idempotencyKey === key
    && job.operationId === operationId
    && job.payload.candidateId === candidate.id
    && job.payload.sourceHash === candidate.sourceHash
    // Pre-V4.1 durable jobs encoded the generation in the immutable key and
    // operationId but did not duplicate it in the payload. Keep those real
    // active/history bindings authoritative while requiring new jobs to carry
    // the explicit payload field.
    && (payloadGeneration === undefined
      || (Number.isSafeInteger(Number(payloadGeneration)) && Number(payloadGeneration) === generation));
}

function bindingFor(
  candidate: CandidateQueueItem,
  generation: number,
  jobId: string,
  key: string,
  operationId: string,
): CandidateDurableJobBinding {
  return {
    candidateId: candidate.id,
    sourceHash: candidate.sourceHash,
    generation,
    jobId,
    durableJobKey: key,
    operationId,
    expectedUpdatedAt: candidate.updatedAt,
  };
}

function candidateJournalContract(
  candidateId: string,
  jobId: string,
  durableJobKey: string,
  operationId: string,
) {
  return {
    operationId,
    jobId,
    operationType: 'PROCESS_CANDIDATE',
    effects: [
      { id: 'candidate-bridge', description: 'Bind staging candidate to its durable job.', idempotencyKey: durableJobKey, intendedValue: { candidateId, jobId } },
      { id: 'canonical-product', description: 'Create or update the canonical product.', idempotencyKey: `${durableJobKey}:product` },
      { id: 'evidence-snapshot', description: 'Capture versioned evidence facts.', idempotencyKey: `${durableJobKey}:evidence` },
      { id: 'publish-child', description: 'Create at most one guarded publish child job.', idempotencyKey: `${durableJobKey}:publish` },
    ],
  };
}

/**
 * Explicit operator-only generation transition. The durable job must already
 * be terminal and must match every immutable candidate identity field before
 * the operator intent is recorded and consumed by the candidate CAS.
 */
export async function advanceCandidateBridgeGenerationByOperator(input: {
  binding: CandidateDurableJobBinding;
  actor: string;
  reasonCode: string;
}): Promise<boolean> {
  const actor = input.actor.trim().slice(0, 160);
  const reasonCode = input.reasonCode.trim().slice(0, 160);
  if (!actor || !reasonCode) throw new Error('CANDIDATE_GENERATION_OPERATOR_INTENT_INVALID');
  const job = await getAutomationJob(input.binding.jobId);
  if (
    !job
    || !['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(job.status)
    || job.type !== 'PROCESS_CANDIDATE'
    || job.idempotencyKey !== input.binding.durableJobKey
    || job.operationId !== input.binding.operationId
    || job.payload.candidateId !== input.binding.candidateId
    || job.payload.sourceHash !== input.binding.sourceHash
    || Number(job.payload.generation) !== input.binding.generation
  ) return false;
  if (!await requestCandidateBridgeGenerationAdvance(
    input.binding,
    `operator:${reasonCode}`,
    actor,
  )) return false;
  return advanceCandidateBridgeGeneration(input.binding);
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
    const generation = readCandidateDurableJobGeneration(candidate);
    const key = candidateJobKey(candidate.id, candidate.sourceHash, generation);
    const operationId = candidateOperationId(candidate.id, candidate.sourceHash, generation);
    let created: Awaited<ReturnType<typeof createAutomationJob>>;
    if (candidate.durableJobId) {
      const boundJob = await getAutomationJob(candidate.durableJobId);
      if (!boundJob || !candidateJobMatches(boundJob, candidate, generation, key, operationId)) {
        result.skipped += 1;
        continue;
      }
      // A crash can occur after the guarded PAUSED -> PENDING commit but
      // before the candidate's cosmetic prepared marker is cleared. Resume
      // the same contract for every non-terminal protocol job so replay can
      // finish that final transition without creating or rebinding anything.
      const resumablePreparation = boundJob.payload.candidateMaterializationProtocol === 'candidate-bridge-v1'
        && Boolean(candidate.durableJobPreparedAt)
        && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(boundJob.status);
      if (!resumablePreparation) {
        result.existing += 1;
        result.jobs.push({ candidateId: candidate.id, jobId: boundJob.id, created: false });
        continue;
      }
      created = { job: boundJob, created: false, code: 'IN_PROGRESS' };
    } else {
      try {
        created = await createAutomationJob({
          type: 'PROCESS_CANDIDATE',
          payload: { candidateId: candidate.id, sourceHash: candidate.sourceHash, generation },
          priority: Math.max(1, Math.min(100, candidate.priority)),
          idempotencyKey: key,
          operationId,
          requestedBy: input.requestedBy || 'automation-bridge',
          parentJobId: input.parentJobId,
          dryRun: false,
          preparedCandidate: true,
        });
      } catch (error) {
        if (error instanceof AutomationJobEnqueueError && error.code === 'DAILY_PRODUCT_LIMIT_REACHED') {
          result.skipped += candidates.length - result.jobs.length;
          break;
        }
        throw error;
      }
    }
    if (!candidateJobMatches(created.job, candidate, generation, key, operationId)) {
      throw new Error('CANDIDATE_JOB_CONTRACT_MISMATCH');
    }
    const binding = bindingFor(candidate, generation, created.job.id, key, operationId);
    const terminalMaterialization = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(created.job.status);
    const legacyAlreadyRunnable = !created.created
      && created.job.payload.candidateMaterializationProtocol !== 'candidate-bridge-v1';
    if (terminalMaterialization || legacyAlreadyRunnable) {
      const historical = await bindCandidateToHistoricalDurableJob(binding);
      if (historical) {
        await ensureOperationJournal(candidateJournalContract(
          candidate.id,
          created.job.id,
          key,
          operationId,
        ), {
          withCommitGuard: candidateDurableJobBindingCommitGuard(binding),
        });
        await completeJournalEffect(
          operationId,
          'candidate-bridge',
          { candidateId: candidate.id, jobId: created.job.id },
          { withCommitGuard: candidateDurableJobBindingCommitGuard(binding) },
        );
        result.existing += 1;
        result.jobs.push({ candidateId: candidate.id, jobId: created.job.id, created: false });
      } else result.skipped += 1;
      continue;
    }
    const bound = await bindCandidateToPreparedDurableJob(binding);
    if (!bound) {
      if (created.created) {
        const cancelled = await cancelAutomationJob(created.job.id, 'candidate-bridge', 'Candidate generation changed before durable binding.');
        if (cancelled) {
          await advanceUnboundCandidateBridgeGeneration({
            candidateId: candidate.id,
            sourceHash: candidate.sourceHash,
            generation,
          });
        }
      }
      result.skipped += 1;
      continue;
    }
    try {
      await ensureOperationJournal(candidateJournalContract(
        candidate.id,
        created.job.id,
        key,
        operationId,
      ), {
        withCommitGuard: candidateDurableJobBindingCommitGuard(binding),
      });
      await completeJournalEffect(
        operationId,
        'candidate-bridge',
        { candidateId: candidate.id, jobId: created.job.id },
        { withCommitGuard: candidateDurableJobBindingCommitGuard(binding) },
      );
      const activated = await activatePreparedCandidateAutomationJob({
        jobId: binding.jobId,
        candidateId: binding.candidateId,
        sourceHash: binding.sourceHash,
        generation: binding.generation,
        idempotencyKey: binding.durableJobKey,
        operationId: binding.operationId,
      }, {
        withCommitGuard: candidateDurableJobBindingCommitGuard(binding, { completeBinding: true }),
      });
      if (!activated) throw new Error('CANDIDATE_JOB_ACTIVATION_FAILED');
      // Repairs a crash where the automation commit became visible but a
      // separate candidate commit could not finish (notably on Mongo). The
      // exact binding CAS makes this replay harmless on FileStorage.
      const marked = await completeCandidateDurableJobBinding(binding);
      if (!marked) throw new Error('CANDIDATE_BINDING_AUTHORITY_LOST');
    } catch (error) {
      const stillAuthoritative = await candidateHasAuthoritativeDurableJobBinding(binding)
        .catch(() => true);
      if (created.created && !stillAuthoritative) {
        const cancelled = await cancelAutomationJob(
          created.job.id,
          'candidate-bridge',
          'Candidate binding authority was lost during durable materialization.',
        );
        if (cancelled) {
          await advanceUnboundCandidateBridgeGeneration({
            candidateId: candidate.id,
            sourceHash: candidate.sourceHash,
            generation,
          });
        }
      }
      throw error;
    }
    if (created.created) result.created += 1; else result.existing += 1;
    result.jobs.push({ candidateId: candidate.id, jobId: created.job.id, created: created.created });
  }
  return result;
}
