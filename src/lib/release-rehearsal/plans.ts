import { executionFingerprint, proposalFingerprint } from '../execution-control-plane/fingerprint';
import { executeDryRun } from '../execution-control-plane/dryRunExecutor';
import type { PreflightContext } from '../execution-control-plane/preflightValidator';
import type { ExecutionProposal } from '../execution-control-plane/types';
import { ABORT_CONDITIONS } from './contracts';
import type { CanaryPlan, ObservabilityPlan, ReleaseCandidate, ReleaseDependency, ReleaseEnvironment, RollbackDrill, SubmittedRollbackPlan } from './types';

export const RELEASE_DEPENDENCIES: ReleaseDependency[] = [
  { id: 'migration', dependsOn: [] }, { id: 'artifact', dependsOn: ['migration'] }, { id: 'binding', dependsOn: ['artifact'] },
  { id: 'preflight', dependsOn: ['binding'] }, { id: 'approval', dependsOn: ['preflight'] }, { id: 'canary', dependsOn: ['approval'] },
  { id: 'rollback', dependsOn: ['canary'] }, { id: 'certification', dependsOn: ['rollback'] },
];
for (const dependency of RELEASE_DEPENDENCIES) { Object.freeze(dependency.dependsOn); Object.freeze(dependency); }
Object.freeze(RELEASE_DEPENDENCIES);
export function observabilityPlan(): ObservabilityPlan {
  return { source: 'CONFIGURED_LOCAL_REHEARSAL_NOT_PRODUCTION_TELEMETRY', productionSloApproved: false,
    signals: ['REQUEST_FAILURE', 'QUEUE_FAILURE', 'D1_ERROR', 'DECISION_BLOCK', 'KILL_SWITCH_BLOCK', 'CONTENT_MUTATION_ATTEMPT',
      'AFFILIATE_ERROR', 'MONEY_INVARIANT_FAILURE', 'RATE_LIMIT', 'EXTERNAL_WRITE_ATTEMPT'].map(name => ({ name, abortAbove: 0, unit: 'unexpected-events-per-drill' }))
      .concat([{ name: 'LATENCY', abortAbove: 5000, unit: 'configured-local-drill-ms-not-business-slo' }]) };
}
export function canaryPlan(environment: ReleaseEnvironment, migrationFingerprint: string, observability: ObservabilityPlan): CanaryPlan {
  return { environment, worker: 'sandeal-runtime-local-only', contentDomain: 'shadow-content', routes: ['/', '/api', '/deals', '/go', '/product'],
    blastRadius: 'BOUNDED', productionTrafficPercent: 0, migrationFingerprint, observabilityFingerprint: executionFingerprint(observability),
    stages: [{ name: 'ZERO', futurePercent: 0, executable: false }, { name: 'PREVIEW_ONLY', futurePercent: 0, executable: false },
      { name: 'FUTURE_SMALL', futurePercent: 1, executable: false }, { name: 'FUTURE_EXPANDED', futurePercent: 5, executable: false },
      { name: 'FUTURE_FULL', futurePercent: 100, executable: false }], abortConditions: [...ABORT_CONDITIONS] };
}
export function releaseReviewProposal(candidate: ReleaseCandidate, requestedAt: number, expiresAt: number): ExecutionProposal {
  return { id: `review-${candidate.fingerprint}`, origin: 'TEST_FIXTURE', proposalType: 'READ_PRODUCT', capability: 'READ_PRODUCT_DATA',
    sourceSubsystem: 'PREPRODUCTION_REHEARSAL', sourceRecordId: candidate.id, targetEntityId: candidate.id, targetUrl: null, parameters: {},
    rollbackEvidenceId: null, changeWindowId: null, environment: 'LOCAL', executionMode: 'REVIEW_REQUIRED', riskLevel: 'READ_ONLY',
    reasonCodes: ['REVIEW_LOCAL_RELEASE_ONLY'], evidenceRefs: [candidate.id], policyVersion: candidate.manifest.policyVersion,
    algorithmVersion: candidate.manifest.algorithmVersion, requestedAt, expiresAt, approvalRequirement: 'REQUIRED', rollbackRequirement: 'NOT_REQUIRED',
    evidenceFingerprint: candidate.fingerprint, status: 'PENDING' };
}
export function rollbackDrill(context: PreflightContext, submitted: SubmittedRollbackPlan): RollbackDrill {
  try {
    const expected = executeDryRun(context);
    const passed = expected.receipt.preflightResult === 'PASS' && expected.rollbackPlan !== null && submitted !== null
      && submitted.proposalFingerprint === proposalFingerprint(context.proposal)
      && executionFingerprint(submitted) === executionFingerprint(expected.rollbackPlan);
    return { passed, proposalId: context.proposal.id, planFingerprint: passed ? executionFingerprint(submitted) : null,
      restored: false, scope: 'CAPABILITY_SCOPED_PLAN_VALIDATION_ONLY' };
  } catch { return { passed: false, proposalId: context?.proposal?.id ?? 'invalid', planFingerprint: null, restored: false, scope: 'CAPABILITY_SCOPED_PLAN_VALIDATION_ONLY' }; }
}
