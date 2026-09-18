import { executionFingerprint, proposalFingerprint } from '../execution-control-plane/fingerprint';
import { approvalState } from '../execution-control-plane/approval';
import { getGlobalKillSwitchState, KILL_SWITCH_DOMAINS } from '../execution-control-plane/killSwitch';
import { planReleaseBundle, type ReleaseBundleInput } from '../execution-control-plane/releaseBundle';
import { executeDryRun } from '../execution-control-plane/dryRunExecutor';
import { assertManifest, createReleaseCandidate } from './manifest';
import { ABORT_CONDITIONS, REQUIRED_GATES, RELEASE_LIMITS, validBindings, validRuntime, resourceClass, isHash, exactKeys, migrationSetFingerprint } from './contracts';
import { RELEASE_DEPENDENCIES, observabilityPlan, canaryPlan, releaseReviewProposal } from './plans';
import type { CertificationContext, ReadinessCertificate, ReleaseCandidate, ReleaseCertification, ReleaseReadiness, OperatorReviewSummary } from './types';

export function bundleFingerprint(bundle: ReleaseBundleInput): string {
  const plan = planReleaseBundle(bundle);
  return executionFingerprint({ plan, members: [...bundle.members].sort((left, right) => left.context.proposal.id.localeCompare(right.context.proposal.id))
    .map(member => ({ proposal: proposalFingerprint(member.context.proposal), priorState: member.context.priorState, target: member.context.target,
      changeWindow: member.context.changeWindow, policy: member.context.currentPolicy, dependsOn: [...member.dependsOn].sort() })) });
}
export function evidenceSubject(candidate: ReleaseCandidate, gate: string): string {
  return ['CLEAN_MIGRATION', 'UPGRADE_MIGRATION', 'DATA_PRESERVATION'].includes(gate)
    ? migrationSetFingerprint(candidate.manifest.migrations) : ['ROLLBACK_DRILL', 'KILL_SWITCH_DRILL', 'KILL_SWITCH_UNKNOWN_DRILL', 'EMERGENCY_STOP_DRILL'].includes(gate)
      ? candidate.manifest.bundleFingerprint : candidate.manifest.source.fingerprint;
}
function summary(candidate: ReleaseCandidate, context: CertificationContext, readiness: ReleaseReadiness, blockers: string[]): OperatorReviewSummary {
  const manifest = candidate.manifest;
  return { candidateId: candidate.id, readiness, changes: ['Worker and static artifacts; local migration and safety rehearsal only'],
    why: 'Validate this exact source and local artifact pair before a separately authorized production review',
    capabilities: context.bundle.members.map(member => member.context.proposal.capability), entities: context.bundle.members.map(member => member.context.proposal.targetEntityId ?? 'unknown'),
    migrations: manifest.migrations.slice(manifest.baselineMigrations.length).map(migration => migration.name),
    bindings: [...manifest.bindings.d1, ...manifest.bindings.queues, ...manifest.bindings.assets],
    risk: manifest.canary.blastRadius === 'UNKNOWN' ? 'UNKNOWN' : manifest.futureActions.length ? 'HIGH' : 'LOW',
    rollbackCoverage: manifest.rollbackCoverage, rollbackLimitations: ['CAPABILITY_SCOPED_INLINE_PLANS_ONLY', 'NO_RESTORE_EXECUTOR', 'NO_PRODUCTION_ARTIFACT_OR_EXTERNAL_RECOVERY'],
    abortConditions: [...manifest.canary.abortConditions], monitoring: manifest.observability.signals.map(signal => signal.name),
    approval: 'CANDIDATE_BOUND_PHASE9_APPROVAL_LOCAL_REHEARSAL_ONLY', reasons: blockers, futureProductionAuthorizationRequired: true };
}
export function certifyRelease(candidate: ReleaseCandidate, context: CertificationContext): ReleaseCertification {
  const blockers: string[] = [];
  const block = (condition: boolean, reason: string) => { if (condition && !blockers.includes(reason)) blockers.push(reason); };
  let certificate: ReadinessCertificate | null = null;
  try {
    assertManifest(candidate.manifest); assertManifest(context.current);
    const manifest = candidate.manifest, now = context.now;
    block(candidate.id !== `rc-${candidate.fingerprint}` || candidate.fingerprint !== executionFingerprint(manifest), 'CANDIDATE_FINGERPRINT_MISMATCH');
    block(createReleaseCandidate(context.current).fingerprint !== candidate.fingerprint, 'STALE_RELEASE_CANDIDATE');
    block(context.activeCandidateId !== candidate.id, 'SUPERSEDED_RELEASE_CANDIDATE');
    block(!['LOCAL', 'PREVIEW_SIMULATION'].includes(context.environment) || context.environment !== manifest.environment, 'ENVIRONMENT_MISMATCH');
    block(!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= now
      || context.expiresAt - now > RELEASE_LIMITS.certificateMs, 'CERTIFICATION_TIME_INVALID');
    block(!validRuntime(manifest.runtime), 'CONFIGURATION_INVALID');
    block(!validBindings(manifest.bindings), 'BINDING_CONTRACT_INVALID');
    for (const kind of ['d1', 'queues', 'assets', 'secretReferences'] as const) {
      const available = context.availableBindings[kind];
      block(!Array.isArray(available) || available.length > 20 || manifest.bindings[kind].some(name => !available.includes(name)), 'MISSING_BINDING');
      if (kind === 'secretReferences') block(available.length > 0, 'UNKNOWN_SECRET_REFERENCE');
    }
    block(context.d1Available !== true, 'D1_UNAVAILABLE'); block(context.queueAvailable !== true, 'QUEUE_UNAVAILABLE');
    block(!exactKeys(manifest.provider, ['provider', 'platform']) || manifest.provider.provider !== 'accesstrade'
      || manifest.provider.platform !== 'shopee', 'DIRECT_SHOPEE_OR_PROVIDER_MISMATCH');
    block(context.providerAvailable !== true, 'PROVIDER_UNAVAILABLE');
    block(getGlobalKillSwitchState(context.killSwitch, now) !== 'INACTIVE'
      || KILL_SWITCH_DOMAINS.some(domain => context.killSwitch?.domains[domain] !== false), 'KILL_SWITCH_BLOCKED');
    block(executionFingerprint(manifest.dependencies) !== executionFingerprint(RELEASE_DEPENDENCIES), 'DEPENDENCY_CONTRACT_MISMATCH');
    for (const migration of manifest.migrations.slice(manifest.baselineMigrations.length)) {
      block(migration.classification !== 'ADDITIVE_SAFE', `MIGRATION_${migration.classification}`);
    }
    const freshBundle = { ...context.bundle, members: context.bundle.members.map(member => ({ ...member,
      context: { ...member.context, now, killSwitch: context.killSwitch, bindings: { D1: context.d1Available, QUEUE: context.queueAvailable } } })) };
    const plan = planReleaseBundle(freshBundle);
    block(bundleFingerprint(freshBundle) !== manifest.bundleFingerprint || plan.preflightState !== 'PASS', 'RELEASE_BUNDLE_INVALID');
    block(manifest.rollbackCoverage !== plan.rollbackCoverage || plan.rollbackCoverage !== 'FULL'
      || freshBundle.members.some(member => executeDryRun(member.context).rollbackPlan === null), 'ROLLBACK_COVERAGE_INCOMPLETE');
    block(!Array.isArray(manifest.futureActions) || manifest.futureActions.length > 20 || manifest.futureActions.length > 0, 'NON_REVERSIBLE_FUTURE_ACTION_REQUIRES_AUTHORIZATION');
    const expectedReview = releaseReviewProposal(candidate, context.approval.proposal.requestedAt, context.approval.proposal.expiresAt);
    block(executionFingerprint(context.approval.proposal) !== executionFingerprint(expectedReview), 'RELEASE_APPROVAL_BINDING_INVALID');
    const approved = approvalState(context.approval.proposal, context.approval.approval, 'LOCAL', context.approval.approverIds, now, true);
    block(approved !== 'APPROVED', `APPROVAL_${approved}`);
    const observability = manifest.observability, expectedSignals = observabilityPlan().signals;
    block(!exactKeys(observability, ['source', 'signals', 'productionSloApproved']) || observability.source !== 'CONFIGURED_LOCAL_REHEARSAL_NOT_PRODUCTION_TELEMETRY'
      || observability.productionSloApproved !== false || !Array.isArray(observability.signals) || observability.signals.length !== expectedSignals.length
      || expectedSignals.some(required => !observability.signals.some(signal => exactKeys(signal, ['name', 'abortAbove', 'unit']) && signal.name === required.name
        && signal.unit === required.unit && Number.isFinite(signal.abortAbove) && signal.abortAbove !== null && signal.abortAbove >= 0
        && signal.abortAbove <= required.abortAbove!)), 'OBSERVABILITY_REVIEW_REQUIRED');
    const canary = manifest.canary;
    block(!exactKeys(canary, ['environment', 'worker', 'contentDomain', 'routes', 'blastRadius', 'productionTrafficPercent', 'stages', 'migrationFingerprint',
      'observabilityFingerprint', 'abortConditions']) || canary.environment !== manifest.environment || canary.worker !== 'sandeal-runtime-local-only'
      || canary.contentDomain !== 'shadow-content' || canary.blastRadius !== 'BOUNDED' || canary.productionTrafficPercent !== 0
      || !Array.isArray(canary.routes) || canary.routes.length < 1 || canary.routes.length > manifest.runtime.budget.routeScope
      || new Set(canary.routes).size !== canary.routes.length || canary.routes.some(route => !/^\/(?:[a-z0-9-]+\/?)*$/.test(route))
      || canary.migrationFingerprint !== migrationSetFingerprint(manifest.migrations) || canary.observabilityFingerprint !== executionFingerprint(observability)
      || executionFingerprint(canary.stages) !== executionFingerprint(canaryPlan(manifest.environment, canary.migrationFingerprint, observability).stages)
      || executionFingerprint(canary.abortConditions) !== executionFingerprint(ABORT_CONDITIONS), 'CANARY_PLAN_INVALID');
    const resource = resourceClass(manifest.runtime.budget, manifest.artifacts.reduce((total, artifact) => total + artifact.files.reduce((sum, file) => sum + file.bytes, 0), 0));
    block(['UNKNOWN', 'HIGH'].includes(resource), 'RESOURCE_REVIEW_REQUIRED');
    block(context.bundle.members.length > manifest.runtime.budget.proposals || context.bundle.members.length > manifest.runtime.budget.approvalBacklog
      || manifest.migrations.some(migration => migration.statements + 1 > manifest.runtime.budget.d1Batch), 'WORK_BUDGET_EXCEEDED');
    block(!Array.isArray(context.evidence) || context.evidence.length !== REQUIRED_GATES.length
      || new Set(context.evidence.map(item => item.gate)).size !== REQUIRED_GATES.length, 'EVIDENCE_INCOMPLETE');
    for (const gate of REQUIRED_GATES) {
      const proof = context.evidence.find(item => item.gate === gate);
      block(!proof || !exactKeys(proof, ['gate', 'sourceFingerprint', 'subjectFingerprint', 'passed', 'reportFingerprint', 'origin'])
        || proof.passed !== true || !isHash(proof.reportFingerprint) || proof.sourceFingerprint !== manifest.source.fingerprint
        || proof.subjectFingerprint !== evidenceSubject(candidate, gate) || proof.origin !== context.evidenceOrigin, `EVIDENCE_${gate}_INVALID`);
    }
    block(!['TEST_FIXTURE', 'LOCAL_RUNNER'].includes(context.evidenceOrigin), 'EVIDENCE_ORIGIN_INVALID');
    if (!blockers.length) {
      const evidenceFingerprint = executionFingerprint({ proofs: context.evidence, approval: context.approval.approval, killSwitch: context.killSwitch });
      const expiresAt = Math.min(context.expiresAt, context.killSwitch!.expiresAt, context.approval.approval!.expiresAt,
        ...freshBundle.members.flatMap(member => [member.context.proposal.expiresAt, member.context.approval?.expiresAt ?? 0,
          member.context.priorState?.expiresAt ?? 0, member.context.changeWindow?.endsAt ?? 0, member.context.currentPolicy?.validUntil ?? 0]));
      block(expiresAt <= now, 'CERTIFICATE_ALREADY_EXPIRED');
      if (!blockers.length) certificate = { id: `cert-${executionFingerprint({ candidate: candidate.fingerprint, evidenceFingerprint, expiresAt })}`,
        candidateId: candidate.id, candidateFingerprint: candidate.fingerprint, environment: manifest.environment, state: 'CERTIFIED_LOCAL_PREPROD',
        evidenceFingerprint, issuedAt: now, expiresAt, productionAuthorized: false, approvalScope: 'LOCAL_REHEARSAL_ONLY' };
    }
  } catch { block(true, 'MALFORMED_OR_UNSAFE_RELEASE_INPUT'); }
  const readiness: ReleaseReadiness = certificate ? 'CERTIFIED_LOCAL' : blockers.length === 1 && blockers[0] === 'APPROVAL_MISSING' ? 'APPROVAL_REQUIRED'
    : blockers.length > 0 && blockers.every(reason => reason.includes('REVIEW_REQUIRED')) ? 'READY_FOR_REVIEW' : 'BLOCKED';
  let review: OperatorReviewSummary;
  try { review = summary(candidate, context, readiness, blockers); }
  catch { review = { candidateId: 'invalid', readiness: 'BLOCKED', changes: [], why: 'Invalid input requires operator investigation', capabilities: [], entities: [], migrations: [], bindings: [], risk: 'UNKNOWN',
    rollbackCoverage: 'UNKNOWN', rollbackLimitations: ['INVALID_INPUT_NO_RESTORE'], abortConditions: [...ABORT_CONDITIONS], monitoring: [],
    approval: 'NOT_READY', reasons: blockers, futureProductionAuthorizationRequired: true }; }
  return { readiness, blockers, certificate, summary: review };
}
export function validateReadinessCertificate(certificate: ReadinessCertificate, candidate: ReleaseCandidate, context: CertificationContext): boolean {
  try {
    const expected = certifyRelease(candidate, context).certificate;
    return !!expected && exactKeys(certificate, Object.keys(expected)) && Number.isSafeInteger(certificate.issuedAt) && certificate.issuedAt <= context.now
      && certificate.expiresAt > context.now && executionFingerprint({ ...certificate, issuedAt: expected.issuedAt }) === executionFingerprint(expected);
  } catch { return false; }
}
