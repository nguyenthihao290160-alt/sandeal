import { load, domain, hash, executionFingerprint, proposalFingerprint, migrationFiles, runtimeConfiguration } from './release-rehearsal.mjs';

export const FIXTURE_NOW = 1_800_000_000_000;
export function executionFixture(now = FIXTURE_NOW, id = 'rehearsal-content') {
  const { KILL_SWITCH_DOMAINS } = load('../../src/lib/execution-control-plane/killSwitch.ts');
  const proposal = { id: `proposal-${id}`, origin: 'TEST_FIXTURE', proposalType: 'REFRESH_CONTENT', capability: 'PROPOSE_CONTENT_REFRESH',
    sourceSubsystem: 'CONTENT_LIFECYCLE', sourceRecordId: id, targetEntityId: id, targetUrl: '/products/shadow-item', parameters: {},
    rollbackEvidenceId: `prior-${id}`, changeWindowId: `window-${id}`, environment: 'LOCAL', executionMode: 'DRY_RUN', riskLevel: 'LOW',
    reasonCodes: ['REFRESH_REQUIRED'], evidenceRefs: ['decision-rehearsal'], policyVersion: 'decision-policy-v1', algorithmVersion: 'execution-v1',
    requestedAt: now - 1000, expiresAt: now + 240000, approvalRequirement: 'REQUIRED', rollbackRequirement: 'REQUIRED',
    evidenceFingerprint: 'local-fixture-evidence', status: 'PENDING' };
  const state = { title: 'Local fixture original title', canonical: '/products/shadow-item', content: 'Recoverable synthetic content, not a production snapshot' };
  const policy = { decisionId: 'decision-rehearsal', productId: id, origin: 'TEST_FIXTURE', decisionTimestamp: new Date(now - 500).toISOString(),
    validUntil: now + 240000, evidenceFingerprint: proposal.evidenceFingerprint, decisionPolicyVersion: 'decision-policy-v1', promptVersion: null,
    dealEvaluationId: 'deal-rehearsal', dealScore: 90, dealConfidence: 0.95, dealPriority: 'TOP', publishRecommendation: 'PUBLISH', dealAlgorithmVersion: 'deal-intelligence-v1',
    money: { status: 'SAFE', selectedOfferId: 'offer-rehearsal', provider: 'accesstrade', platform: 'shopee', version: 'money-v1' },
    publication: { ready: true, version: 'publish-v1' }, priceFreshness: 'FRESH', offerFreshness: 'FRESH', providerHealth: 'AVAILABLE',
    revenue: { state: 'POSITIVE', version: 1 }, constraints: { executionMode: 'SHADOW', systemHealth: 'AVAILABLE', systemVersion: 'v1',
      securityRisk: false, quarantined: false, runtimeValid: true }, gates: [{ outcome: 'ALLOW', reason: 'SAFE_MONETIZATION_AVAILABLE' }] };
  return { proposal, currentEnvironment: 'LOCAL', currentEvidenceFingerprint: proposal.evidenceFingerprint, currentProposalFingerprint: proposalFingerprint(proposal),
    currentPolicy: policy, target: { id, environment: 'LOCAL', url: proposal.targetUrl, version: 'revision-1', policyProductId: id, provider: 'accesstrade', platform: 'shopee' },
    priorState: { id: proposal.rollbackEvidenceId, capability: proposal.capability, targetEntityId: id, environment: 'LOCAL', targetVersion: 'revision-1',
      capturedAt: now - 1500, expiresAt: now + 240000, state, stateFingerprint: executionFingerprint(state) },
    changeWindow: { id: proposal.changeWindowId, environment: 'LOCAL', capabilities: [proposal.capability], status: 'OPEN', startsAt: now - 2000, endsAt: now + 240000 },
    approval: approvalFixture(proposal, now), killSwitch: { state: 'INACTIVE', revision: 1, observedAt: now - 1000, expiresAt: now + 299000,
      domains: Object.fromEntries(KILL_SWITCH_DOMAINS.map(name => [name, false])) }, bindings: { D1: true, QUEUE: true },
    allowedHosts: ['shopee.vn', 'sandeal.vn'], allowedApproverIds: ['local-simulation-operator'], now };
}
export function approvalFixture(proposal, now) {
  return { id: `approval-${proposal.id}`, proposalId: proposal.id, environment: proposal.environment, capability: proposal.capability,
    riskLevel: proposal.riskLevel, evidenceFingerprint: proposal.evidenceFingerprint, proposalFingerprint: proposalFingerprint(proposal),
    approverId: 'local-simulation-operator', status: 'APPROVED', createdAt: now - 100, expiresAt: now + 200000 };
}
export function releaseFixture({ now = FIXTURE_NOW, source, artifacts, evidenceOrigin = 'TEST_FIXTURE' } = {}) {
  const files = { 'src/fixture.ts': hash('LOCAL UNIT TEST SOURCE ONLY') };
  source ??= { head: '1'.repeat(40), files, fingerprint: executionFingerprint(files) };
  artifacts ??= ['WORKER', 'STATIC'].map(kind => {
    const artifact = { kind, sourceHead: source.head, sourceFingerprint: source.fingerprint,
      files: [{ path: kind === 'WORKER' ? 'worker.mjs' : 'index.html', sha256: hash(`LOCAL UNIT TEST ${kind}`), bytes: 32 }] };
    return { ...artifact, fingerprint: domain('manifest').artifactFingerprint(artifact) };
  });
  const bundle = { id: 'local-rehearsal-bundle', environment: 'LOCAL', members: [{ context: executionFixture(now), dependsOn: [] }] };
  const migrations = domain('migrations').migrationInventory(migrationFiles()), observability = domain('plans').observabilityPlan();
  const registryFingerprint = domain('manifest').registryFingerprint();
  const manifest = { schema: 'sandeal-local-preprod-v1', algorithmVersion: domain('contracts').RELEASE_ALGORITHM_VERSION, environment: 'LOCAL',
    source, artifacts, migrations, baselineMigrations: migrations.slice(0, 9).map(({ name, sha256 }) => ({ name, sha256 })),
    requiredMigrations: migrations.map(migration => migration.name), runtime: runtimeConfiguration(), bindings: structuredClone(domain('contracts').LOCAL_BINDINGS),
    registryFingerprint, registryVersion: `registry-sha256-${registryFingerprint}`, policyVersion: load('../../src/lib/decision-os/config.ts').DECISION_POLICY_VERSION,
    algorithmVersions: { execution: 'execution-v1', deal: load('../../src/lib/deal-intelligence/config.ts').DEAL_CONFIG.algorithmVersion,
      decision: load('../../src/lib/decision-os/config.ts').DECISION_POLICY_VERSION, opportunity: load('../../src/lib/opportunity/config.ts').OPPORTUNITY_CONFIG.algorithmVersion,
      content: load('../../src/lib/content/config.ts').CONTENT_INTELLIGENCE_VERSION, lifecycle: load('../../src/lib/content/lifecycle/config.ts').LIFECYCLE_CONFIG.algorithmVersion,
      release: domain('contracts').RELEASE_ALGORITHM_VERSION }, bundleFingerprint: domain('certification').bundleFingerprint(bundle), rollbackCoverage: 'FULL',
    dependencies: structuredClone(domain('plans').RELEASE_DEPENDENCIES), canary: domain('plans').canaryPlan('LOCAL', executionFingerprint(migrations), observability),
    observability, futureActions: [], provider: { provider: 'accesstrade', platform: 'shopee' }, productionAuthorized: false };
  const candidate = domain('manifest').createReleaseCandidate(manifest), proposal = domain('plans').releaseReviewProposal(candidate, now - 500, now + 240000);
  const context = { now, expiresAt: now + 200000, environment: 'LOCAL', activeCandidateId: candidate.id, current: structuredClone(manifest), bundle,
    killSwitch: structuredClone(bundle.members[0].context.killSwitch), approval: { proposal, approval: approvalFixture(proposal, now), approverIds: ['local-simulation-operator'] },
    availableBindings: { d1: ['DB'], queues: ['JOB_QUEUE'], assets: ['ASSETS'], secretReferences: [] }, d1Available: true, queueAvailable: true,
    providerAvailable: true, evidence: [], evidenceOrigin };
  if (evidenceOrigin === 'TEST_FIXTURE') context.evidence = domain('contracts').REQUIRED_GATES.map(gate => ({ gate, sourceFingerprint: source.fingerprint,
    subjectFingerprint: domain('certification').evidenceSubject(candidate, gate), passed: true, reportFingerprint: hash(`SYNTHETIC_UNIT_TEST_${gate}`), origin: 'TEST_FIXTURE' }));
  return { candidate, context };
}
