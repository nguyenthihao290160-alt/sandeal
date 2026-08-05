import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { createStorageSnapshot, verifyStorageSnapshot } from '@/lib/autonomous/backupManager';
import { listRuntimeRoleLeases } from '@/lib/automation/runtimeRoles';
import {
  cancelAutomationJob,
  completeAutomationParentJob,
  getAllAutomationJobs,
  getAllActiveAutomationJobs,
} from '@/lib/automation/store';
import type { AutomationJob } from '@/lib/automation/types';
import { advanceCandidateBridgeGeneration, finishCandidate, listCandidateQueue, type CandidateQueueItem } from '@/lib/storage/candidateQueue';
import { getDataDir } from '@/lib/storage/adapter';
import { getStorageConfig } from '@/lib/storage/storageConfig';
import { getAllProducts, saveCanonicalProduct } from '@/lib/storage/products';
import type { CommerceUrlProbeClassification, Product } from '@/lib/types';
import { listDomainCircuitStates } from '@/lib/bots/domainCircuitBreaker';

const GIT_SHA = /^[0-9a-f]{40}$/i;
const TERMINAL_JOB_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const PERMANENT_SOURCE_REASONS = new Set<string>([
  'AFFILIATE_LINK_NOT_FOUND', 'AFFILIATE_LINK_REJECTED', 'MERCHANT_NOT_FOUND',
  'REDIRECT_LOOP', 'UNSAFE_URL', 'INVALID_URL',
]);
const TEMPORARY_SOURCE_REASONS = new Set<string>([
  'MERCHANT_UNREACHABLE', 'RATE_LIMITED', 'PROVIDER_SERVER_ERROR', 'DNS_FAILURE',
  'TLS_FAILURE', 'CONNECT_TIMEOUT', 'REQUEST_TIMEOUT', 'CONNECTION_RESET',
  'MERCHANT_CONNECT_TIMEOUT', 'MERCHANT_CONNECTION_RESET', 'MERCHANT_CIRCUIT_OPEN',
  'AFFILIATE_GATEWAY_CIRCUIT_OPEN', 'DOMAIN_CIRCUIT_OPEN',
]);

/** Collections this maintenance operation is forbidden to mutate. */
export const SOURCE_RECONCILIATION_PROTECTED_COLLECTIONS = Object.freeze([
  'automation-settings', 'automation-control', 'token-vault', 'runtime-role-fencing',
  'runtime-role-leases', 'credentials', 'users', 'accounts', 'auth',
]);

const SNAPSHOT_COLLECTIONS = Object.freeze([
  'products', 'candidate-queue', 'automation-jobs', 'automation-audit',
  'automation-job-list-projections-v2', 'automation-job-projections',
  'automation-job-health-summary-v1', 'automation-job-projection-manifest-v1',
  'operation-journal', 'publication-audit',
]);

export interface SourceReconciliationOptions {
  apply?: boolean;
  expectedReleaseId: string;
  repositoryRoot?: string;
  backupDir?: string;
  now?: number;
}

export interface SourceReconciliationCounts {
  candidates: Record<string, number>;
  affectedCandidates: number;
  affectedJobs: number;
  waitingParents: number;
  affectedProducts: number;
}

export interface SourceReconciliationResult {
  schemaVersion: 1;
  type: 'source_reliability_reconciliation';
  mode: 'dry-run' | 'apply';
  releaseId: string;
  backup: null | { directory: string; id: string; checksum: string; files: number };
  before: SourceReconciliationCounts;
  after: SourceReconciliationCounts;
  mutations: {
    candidatesDiscarded: number;
    candidatesDelayed: number;
    candidateBridgesAdvanced: number;
    jobsCancelled: number;
    parentJobsCompleted: number;
    productsQuarantined: number;
  };
  affected: { candidateIds: string[]; jobIds: string[]; parentJobIds: string[]; productIds: string[] };
  protectedCollections: readonly string[];
  rollbackInstructions: string[];
  completedAt: string;
}

interface CandidateDisposition {
  candidate: CandidateQueueItem;
  reasonCode: string;
  action: 'DISCARD' | 'DELAY';
  nextAttemptAt?: string;
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sourceReason(candidate: CandidateQueueItem): string | null {
  const evidence = candidate.sourceEvidence;
  const evidenceReasons = [
    evidence?.affiliate.reasonCode,
    evidence?.merchant?.reasonCode,
    evidence?.affiliate.classification,
    evidence?.merchant?.classification,
  ];
  const storedReasons = [candidate.terminalReason, candidate.delayReason];
  for (const value of [...evidenceReasons, ...storedReasons]) {
    const normalized = String(value || '').trim().toUpperCase().replace(/^TEMPORARY_ERROR:CANDIDATE_DELAYED:/, '');
    if (!normalized) continue;
    if (normalized === 'DOMAIN_CIRCUIT_OPEN') return normalized;
    if (PERMANENT_SOURCE_REASONS.has(normalized) || TEMPORARY_SOURCE_REASONS.has(normalized)) return normalized;
  }
  return null;
}

function circuitRetryAt(candidate: CandidateQueueItem, circuits: Awaited<ReturnType<typeof listDomainCircuitStates>>, now: number): string {
  const evidenceRetry = candidate.sourceEvidence?.merchant?.retryAfter || candidate.sourceEvidence?.affiliate.retryAfter;
  if (evidenceRetry && Date.parse(evidenceRetry) > now) return evidenceRetry;
  const merchant = candidate.merchantDomain || candidate.payload.merchantDomain;
  const circuit = circuits.find(item => item.role === 'MERCHANT' && item.domain === merchant);
  const circuitRetry = circuit?.nextProbeAt || circuit?.openUntil;
  if (circuitRetry && Date.parse(circuitRetry) > now) return circuitRetry;
  return new Date(now + 30 * 60_000).toISOString();
}

function candidateDispositions(
  candidates: CandidateQueueItem[],
  circuits: Awaited<ReturnType<typeof listDomainCircuitStates>>,
  now: number,
): CandidateDisposition[] {
  const results: CandidateDisposition[] = [];
  for (const candidate of candidates) {
    const reasonCode = sourceReason(candidate);
    if (!reasonCode) continue;
    if (PERMANENT_SOURCE_REASONS.has(reasonCode)) {
      if (candidate.status !== 'discarded' || candidate.terminalReason !== reasonCode) {
        results.push({ candidate, reasonCode, action: 'DISCARD' });
      }
      continue;
    }
    if (TEMPORARY_SOURCE_REASONS.has(reasonCode) && !['completed', 'discarded'].includes(candidate.status)) {
      results.push({ candidate, reasonCode, action: 'DELAY', nextAttemptAt: circuitRetryAt(candidate, circuits, now) });
    }
  }
  return results;
}

function productSourceBlockers(product: Product): string[] {
  const blockers: string[] = [];
  const classifications: Array<CommerceUrlProbeClassification | undefined> = [
    product.sourceEvidence?.affiliate.classification,
    product.sourceEvidence?.merchant?.classification,
  ];
  for (const classification of classifications) {
    if (classification && classification !== 'HEALTHY') blockers.push(classification);
  }
  if (/reset/i.test(String(product.productUrlErrorCode || product.productUrlHealthReason || ''))) blockers.push('MERCHANT_CONNECTION_RESET');
  if (/timeout/i.test(String(product.linkHealthStatus || product.productUrlErrorCode || product.productUrlHealthReason || ''))) blockers.push('MERCHANT_CONNECT_TIMEOUT');
  if (product.affiliateHealthStatus === 'broken' && !blockers.some(code => code.startsWith('AFFILIATE_'))) blockers.push('AFFILIATE_LINK_UNHEALTHY');
  const existing = [...(product.publicBlockReasons || []), ...(product.quarantineReasons || [])]
    .map(value => String(value).trim().toUpperCase())
    .filter(value => PERMANENT_SOURCE_REASONS.has(value) || TEMPORARY_SOURCE_REASONS.has(value) || value === 'SOURCE_EVIDENCE_STALE');
  blockers.push(...existing);
  if (!product.sourceEvidence && blockers.length) blockers.push('SOURCE_EVIDENCE_STALE');
  return [...new Set(blockers)];
}

function affectedProductPlans(products: Product[]): Array<{ product: Product; blockers: string[] }> {
  return products
    .map(product => ({ product, blockers: productSourceBlockers(product) }))
    .filter(plan => plan.blockers.length > 0 && (
      plan.product.lifecycleState === 'QUARANTINED'
      || plan.product.status === 'archived'
      || plan.product.publicBlocked === true
      || Boolean(plan.product.sourceEvidence)
    ));
}

function descendantsOf(parentId: string, jobs: AutomationJob[]): AutomationJob[] {
  const descendants: AutomationJob[] = [];
  const seen = new Set([parentId]);
  let frontier = [parentId];
  while (frontier.length) {
    const parents = new Set(frontier);
    frontier = [];
    for (const job of jobs) {
      if (!job.parentJobId || !parents.has(job.parentJobId) || seen.has(job.id)) continue;
      seen.add(job.id);
      descendants.push(job);
      frontier.push(job.id);
    }
  }
  return descendants;
}

function waitingParentPlans(
  jobs: AutomationJob[],
  dispositions: CandidateDisposition[],
): AutomationJob[] {
  const discardedCandidates = new Set(dispositions
    .filter(item => item.action === 'DISCARD')
    .map(item => item.candidate.id));
  return jobs.filter(job => {
    if (job.status !== 'WAITING_CHILDREN') return false;
    const descendants = descendantsOf(job.id, jobs);
    return descendants.length > 0 && descendants.every(child =>
      TERMINAL_JOB_STATUSES.has(child.status)
      || child.type === 'PROCESS_CANDIDATE'
        && discardedCandidates.has(String(child.payload.candidateId || '')));
  });
}

function candidateCounts(candidates: CandidateQueueItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) counts[candidate.status] = (counts[candidate.status] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function countSnapshot(
  candidates: CandidateQueueItem[],
  dispositions: CandidateDisposition[],
  jobs: AutomationJob[],
  products: Array<{ product: Product; blockers: string[] }>,
): SourceReconciliationCounts {
  const affectedCandidateIds = new Set(dispositions.map(item => item.candidate.id));
  return {
    candidates: candidateCounts(candidates),
    affectedCandidates: dispositions.length,
    affectedJobs: jobs.filter(job => job.type === 'PROCESS_CANDIDATE' && affectedCandidateIds.has(String(job.payload.candidateId || ''))).length,
    waitingParents: jobs.filter(job => job.status === 'WAITING_CHILDREN').length,
    affectedProducts: products.length,
  };
}

async function assertPreconditions(options: SourceReconciliationOptions, now: number): Promise<{ root: string; releaseId: string }> {
  if (getStorageConfig().driver !== 'file') throw new Error('SOURCE_RECONCILIATION_REQUIRES_FILE_STORAGE');
  const expected = options.expectedReleaseId.trim().toLowerCase();
  if (!GIT_SHA.test(expected)) throw new Error('SOURCE_RECONCILIATION_EXPECTED_RELEASE_INVALID');
  const root = path.resolve(options.repositoryRoot || process.cwd());
  const head = git(root, ['rev-parse', 'HEAD']).toLowerCase();
  if (head !== expected) throw new Error('SOURCE_RECONCILIATION_RELEASE_MISMATCH');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=normal'])) throw new Error('SOURCE_RECONCILIATION_GIT_TREE_NOT_CLEAN');
  if (process.env.NODE_ENV === 'production') {
    const releaseValues = [
      process.env.SANDEAL_RELEASE_ID,
      process.env.GIT_COMMIT_SHA,
      process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID,
      process.env.SANDEAL_BUILD_COMMIT,
      process.env.SANDEAL_BUILD_MANIFEST_COMMIT,
    ].map(value => String(value || '').trim().toLowerCase());
    if (releaseValues.some(value => value !== expected)) throw new Error('SOURCE_RECONCILIATION_RUNTIME_RELEASE_MISMATCH');
  }
  const leases = await listRuntimeRoleLeases();
  const liveScheduler = leases.some(lease => lease.role === 'SCHEDULER'
    && lease.status === 'ACTIVE'
    && Date.parse(lease.leaseExpiresAt || lease.expiresAt) > now);
  if (liveScheduler) throw new Error('SOURCE_RECONCILIATION_SCHEDULER_MUST_BE_STOPPED');
  if ((await getAllActiveAutomationJobs()).some(job => job.status === 'RUNNING')) throw new Error('SOURCE_RECONCILIATION_RUNNING_JOBS_PRESENT');
  return { root, releaseId: expected };
}

export async function reconcileUnhealthySources(options: SourceReconciliationOptions): Promise<SourceReconciliationResult> {
  const now = options.now ?? Date.now();
  const { releaseId } = await assertPreconditions(options, now);
  const [candidates, circuits, jobs, products] = await Promise.all([
    listCandidateQueue(), listDomainCircuitStates(), getAllAutomationJobs(), getAllProducts(),
  ]);
  const dispositions = candidateDispositions(candidates, circuits, now);
  const productPlans = affectedProductPlans(products);
  const before = countSnapshot(candidates, dispositions, jobs, productPlans);
  const affectedCandidateIds = new Set(dispositions.map(item => item.candidate.id));
  const affectedJobs = jobs.filter(job => job.type === 'PROCESS_CANDIDATE'
    && affectedCandidateIds.has(String(job.payload.candidateId || '')));
  const parentPlans = waitingParentPlans(jobs, dispositions);
  let backup: SourceReconciliationResult['backup'] = null;
  const mutations = {
    candidatesDiscarded: 0, candidatesDelayed: 0, candidateBridgesAdvanced: 0,
    jobsCancelled: 0, parentJobsCompleted: 0, productsQuarantined: 0,
  };

  if (options.apply) {
    const snapshot = await createStorageSnapshot({
      sourceDir: getDataDir(),
      outputDir: options.backupDir,
      reason: 'manual',
      includeCollections: SNAPSHOT_COLLECTIONS,
      now,
    });
    const verified = await verifyStorageSnapshot(snapshot.directory);
    backup = { directory: snapshot.directory, id: verified.id, checksum: verified.checksum, files: verified.files.length };

    const jobsById = new Map(jobs.map(job => [job.id, job]));
    for (const disposition of dispositions) {
      const { candidate, reasonCode } = disposition;
      if (disposition.action === 'DISCARD') {
        await finishCandidate(candidate.id, { status: 'discarded', terminalReason: reasonCode, delayReason: reasonCode, retryable: false, nextAttemptAt: undefined });
        mutations.candidatesDiscarded++;
        const job = candidate.durableJobId ? jobsById.get(candidate.durableJobId) : undefined;
        if (job && !TERMINAL_JOB_STATUSES.has(job.status)) {
          if (await cancelAutomationJob(job.id, 'source-reliability-reconciliation', reasonCode)) mutations.jobsCancelled++;
        }
      } else {
        await finishCandidate(candidate.id, {
          status: 'delayed', delayReason: reasonCode, terminalReason: undefined,
          retryable: true, nextAttemptAt: disposition.nextAttemptAt,
        });
        mutations.candidatesDelayed++;
        const job = candidate.durableJobId ? jobsById.get(candidate.durableJobId) : undefined;
        if (job && TERMINAL_JOB_STATUSES.has(job.status)
          && await advanceCandidateBridgeGeneration(candidate.id, job.id)) mutations.candidateBridgesAdvanced++;
      }
    }

    for (const plan of productPlans) {
      const timestamp = new Date(now).toISOString();
      const saved = await saveCanonicalProduct(plan.product.id, {
        status: 'archived', lifecycleState: 'QUARANTINED', publicDecision: 'quarantined',
        publicHidden: true, publicBlocked: true,
        publicBlockReasons: [...new Set([...(plan.product.publicBlockReasons || []), ...plan.blockers])],
        quarantineReasons: [...new Set([...(plan.product.quarantineReasons || []), ...plan.blockers])],
        lastEligibilityDecision: {
          eligible: false, reasonCodes: plan.blockers, checkedAt: timestamp,
          ruleVersion: 'source-reliability-reconciliation-v1',
        },
        nextAutomaticAction: 'RECHECK_QUARANTINED_PRODUCT',
      });
      if (saved) mutations.productsQuarantined++;
    }

    // Close parents only after candidate/job/product dispositions are durable,
    // and re-read lineage so a just-cancelled permanent child is observed as
    // terminal rather than leaving AUTO_PILOT in WAITING_CHILDREN.
    const reconciledJobs = await getAllAutomationJobs();
    for (const parent of parentPlans) {
      const currentParent = reconciledJobs.find(job => job.id === parent.id);
      if (!currentParent || currentParent.status !== 'WAITING_CHILDREN') continue;
      const descendants = descendantsOf(parent.id, reconciledJobs);
      if (!descendants.length || descendants.some(job => !TERMINAL_JOB_STATUSES.has(job.status))) continue;
      const byStatus = Object.fromEntries([...new Set(descendants.map(job => job.status))]
        .map(status => [status, descendants.filter(job => job.status === status).length]));
      if (await completeAutomationParentJob(parent.id, 'source-reliability-reconciliation', {
        total: descendants.length, byStatus, reconciledAt: new Date(now).toISOString(),
      })) mutations.parentJobsCompleted++;
    }
  }

  const [afterCandidates, afterJobs, afterProducts] = options.apply
    ? await Promise.all([listCandidateQueue(), getAllAutomationJobs(), getAllProducts()])
    : [candidates, jobs, products];
  const afterDispositions = candidateDispositions(afterCandidates, circuits, now);
  const afterProductPlans = affectedProductPlans(afterProducts);
  const after = countSnapshot(afterCandidates, afterDispositions, afterJobs, afterProductPlans);
  const snapshotDirectory = backup?.directory || '<verified-snapshot-directory-from-apply-output>';
  return {
    schemaVersion: 1,
    type: 'source_reliability_reconciliation',
    mode: options.apply ? 'apply' : 'dry-run',
    releaseId,
    backup,
    before,
    after,
    mutations,
    affected: {
      candidateIds: dispositions.map(item => item.candidate.id).slice(0, 200),
      jobIds: affectedJobs.map(job => job.id).slice(0, 200),
      parentJobIds: parentPlans.map(job => job.id).slice(0, 200),
      productIds: productPlans.map(item => item.product.id).slice(0, 200),
    },
    protectedCollections: SOURCE_RECONCILIATION_PROTECTED_COLLECTIONS,
    rollbackInstructions: [
      'Keep the web application, Worker, and Scheduler stopped before rollback.',
      `Verify the snapshot: node scripts/reconcile-source-reliability.cjs --verify-snapshot=\"${snapshotDirectory}\"`,
      `Restore only to a new empty directory: node scripts/reconcile-source-reliability.cjs --restore-snapshot=\"${snapshotDirectory}\" --target=\"<empty-directory>\"`,
      'Compare the isolated restore, then use the approved FileStorage recovery procedure; this tool never overwrites live JSON files.',
    ],
    completedAt: new Date().toISOString(),
  };
}
