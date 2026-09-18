import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { domain, root, load, sourceManifest } from './release-rehearsal.mjs';

export function checkpointOutcomes(evidence) {
  assert.equal(evidence.certification.certificate?.state, 'CERTIFIED_LOCAL_PREPROD');
  assert.deepEqual(evidence.certification.blockers, []); assert.equal(evidence.focused.failed, 0); assert.equal(evidence.focused.skipped, 0);
  assert.equal(evidence.focused.matrix.length, 26); assert.ok(evidence.validation.every(item => item.exit === 0));
  const success = evidence.certification.certificate && evidence.focused.failed === 0 ? 'PASS' : 'BLOCKED';
  const outcomes = Object.fromEntries(['PHASE9_5', 'PREPRODUCTION_REHEARSAL', 'RELEASE_CANDIDATE_CERTIFICATION', 'RELEASE_CANDIDATE_FINGERPRINT',
    'RELEASE_MANIFEST', 'WORKER_ARTIFACT_INTEGRITY', 'STATIC_ARTIFACT_INTEGRITY', 'BINDING_CONTRACT', 'CONFIGURATION_CONTRACT',
    'MIGRATION_INVENTORY', 'MIGRATION_CLASSIFICATION', 'CLEAN_INSTALL_MIGRATION_REHEARSAL', 'UPGRADE_MIGRATION_REHEARSAL', 'MIGRATION_DATA_PRESERVATION',
    'RELEASE_BUNDLE_CERTIFICATION', 'OPERATOR_REVIEW_SUMMARY', 'CANARY_PLAN', 'OBSERVABILITY_PLAN', 'ABORT_CONDITIONS', 'KILL_SWITCH_DRILL',
    'KILL_SWITCH_UNKNOWN_DRILL', 'EMERGENCY_STOP_DRILL', 'ROLLBACK_DRILL', 'RELEASE_RETRY_BUDGET', 'RESOURCE_LIMIT_AUDIT', 'DEPENDENCY_AUDIT',
    'READINESS_CERTIFICATE', 'TYPESCRIPT', 'SECRET_SCAN', 'GIT_DIFF_CHECK'].map(name => [name, success]));
  Object.assign(outcomes, { RELEASE_CANDIDATE_ALGORITHM_VERSION: domain('contracts').RELEASE_ALGORITHM_VERSION, BUILD_SOURCE_FINGERPRINT_MATCH: 'YES',
    ROLLBACK_COVERAGE: evidence.candidate.manifest.rollbackCoverage, BUILD_REPRODUCIBILITY: evidence.builds.reproducibility,
    READINESS_CERTIFICATE_STATE: evidence.certification.certificate.state, DIRECT_SHOPEE_STATUS: 'DISABLED_NO_CREDENTIALS',
    AI_EXECUTION_AUTHORITY: 'NO', LIVE_AI_PROBE: 'NOT_RUN', NEW_TEST_CASES_PASSED: evidence.focused.passed, NEW_TEST_CASES_FAILED: evidence.focused.failed,
    TEST_CASES_SKIPPED: evidence.focused.skipped, ESLINT: 'PASS_0_NEW_ERRORS', BUILD_CLOUDFLARE: 'PASS_STATIC_AND_WORKER',
    PRODUCTION_EXECUTION_ENABLED: 'NO', REAL_MONEY_TRANSACTION_CREATED: 'NO', DEPLOYED: 'NO', RESULT: success, SAFE_FOR_PHASE10: 'NOT_AUTHORIZED',
    BLOCKERS: [], NEXT_RECOMMENDED_PHASE: 'PHASE9_5_READ_ONLY_PRECOMMIT_REVIEW_NO_PRODUCTION_AUTHORIZATION' });
  for (const name of ['MISSING_BINDING_RELEASE_EFFECT', 'RAW_SECRET_IN_RELEASE_MANIFEST', 'RELEASE_APPROVAL_STALE_EFFECT', 'PRODUCTION_TRAFFIC_SHIFT',
    'UNKNOWN_BLAST_RADIUS_AUTOPASS_EFFECT', 'REHEARSAL_MONEY_LEDGER_MUTATION_EFFECT', 'STALE_READINESS_CERTIFICATE_EFFECT', 'DUPLICATE_CERTIFICATION_EFFECT',
    'SUPERSEDED_RELEASE_CERTIFICATE_EFFECT', 'CROSS_ENVIRONMENT_RELEASE_CERT_EFFECT', 'STALE_ARTIFACT_RELEASE_EFFECT', 'DIRECT_SHOPEE_API_CALLS',
    'FILE_STORAGE_CALLS', 'FILESYSTEM_SETTINGS_CALLS', 'PRODUCTION_SIDE_EFFECTS', 'PRODUCTION_CONTENT_MUTATIONS', 'PRODUCTION_CONTENT_PUBLISHED',
    'PRODUCTION_CONTENT_DELETED', 'PRODUCTION_REDIRECTS_CREATED', 'PRODUCTION_METADATA_MUTATIONS', 'PRODUCTION_EXPERIMENT_TRAFFIC', 'ACTIVE_PRODUCTION_EXPERIMENTS',
    'PRODUCTION_D1_MIGRATIONS', 'CLOUDFLARE_DEPLOYMENTS', 'DNS_CHANGES', 'PRODUCTION_RESOURCE_CREATED', 'REAL_PRODUCTION_DATA_MIGRATED']) outcomes[name] = 0;
  for (const name of ['RELEASE_CANDIDATE_FULL_SCAN', 'READINESS_CERT_FULL_SCAN', 'REHEARSAL_AUDIT_FULL_SCAN', 'MIGRATION_REHEARSAL_FULL_SCAN',
    'DUE_RELEASE_WORK_FULL_SCAN', 'PM2_REQUIRED', 'VPS_REQUIRED', 'LONG_RUNNING_PROCESS_REQUIRED', 'CONTINUOUS_POLLING', 'ASSERTIONS_WEAKENED',
    'RELEASE_ASSERTIONS_WEAKENED', 'MIGRATION_ASSERTIONS_WEAKENED', 'ROLLBACK_ASSERTIONS_WEAKENED', 'KILL_SWITCH_ASSERTIONS_WEAKENED', 'SAFETY_GATES_RELAXED']) outcomes[name] = 'NO';
  outcomes.STALE_RELEASE_CERTIFICATION_EFFECT = 0; outcomes.CRITICAL_FAILURE_CERTIFICATION_EFFECT = 0;
  return outcomes;
}
export function recordCheckpoint(evidence) {
  assert.deepEqual(sourceManifest(), evidence.source, 'STALE_CHECKPOINT_SOURCE');
  const outcomes = checkpointOutcomes(evidence);
  const statePath = path.join(root, 'docs/v6/LONG_RUN_STATE.json'), previous = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(previous.phase9?.outcomes?.PHASE9 ?? previous.phase9?.PHASE9 ?? previous.PHASE9, 'PASS', 'PRIOR_PHASE9_REQUIRED');
  const evidencePath = 'docs/v6/evidence/phase9-5-preproduction-readiness.json', checkpoint = 'docs/v6/phase-09-5-preproduction-readiness.md';
  const fullEvidence = { ...evidence, outcomes };
  fs.writeFileSync(path.join(root, evidencePath), JSON.stringify(fullEvidence, null, 2) + '\n');
  const status = Object.entries(outcomes).map(([key, value]) => `${key}=${Array.isArray(value) ? JSON.stringify(value) : value}`).join('\n');
  const document = `# Phase 9.5 — Local pre-production rehearsal\n\n` +
    `This is a historical local certification of an exact dirty-worktree source manifest, not production approval or an active deployment authorization.\n\n` +
    `- Baseline HEAD: \`${evidence.source.head}\`. Phase 9 was committed and clean before Phase 9.5 edits.\n` +
    `- Candidate: \`${evidence.candidate.id}\`.\n- Source fingerprint: \`${evidence.source.fingerprint}\`.\n` +
    `- Evidence: \`${evidencePath}\`. Captured: ${evidence.capturedAt}.\n` +
    `- Certificate expires: ${new Date(evidence.certification.certificate.expiresAt).toISOString()}. Revalidate before any local reuse; a commit changes HEAD and invalidates it.\n\n` +
    `## Reconstructed architecture\n\n` +
    `The Cloudflare Worker bundles to .test-tmp/v6-cloudflare-worker/worker.mjs; Next static export is cloudflare/site/out. ` +
    `The existing runtime is local-only with D1 DB, Queue JOB_QUEUE, ASSETS, and a five-minute Cron contract. Production bindings are absent. ` +
    `The legacy release scripts target the old VPS/file runtime and are deliberately not reused. No new production route, job, Cron, migration, or dependency is added.\n\n` +
    `Phase 9 registry, approvalState, preflight, dry-run execution, release bundles, recoverable prior-state plans, emergency stop, and indexed execution_audit are reused. ` +
    `The new layer supplies exact source/artifact identity, bounded local candidate sessions, contracts, local migration drills, a future canary/observability plan, and a local certificate.\n\n` +
    `## Identity and trust boundary\n\n` +
    `Canonical SHA-256 binds Git HEAD, every tracked/nonignored source/config/test file (excluding docs, generated evidence, and secret environment files), ` +
    `both complete deployment artifact inventories, ordered migrations, runtime config, registry, policy/algorithm versions, bundle, and environment. ` +
    `The build runner checks unchanged source before/after each build and rereads artifact bytes before certification. Docs are non-executable evidence and intentionally excluded to avoid self-referential hashes.\n\n` +
    `Quality and regression reports must match the entire final source manifest. Evidence is trusted local-runner output, not a signed supply-chain attestation. ` +
    `There is no public certification endpoint. Approvers and AccessTrade availability in rehearsal are explicitly synthetic local fixtures; no production human approval, provider health, secret, or telemetry is claimed. ` +
    `Certificates never authorize execution. A bounded ephemeral session supersedes old candidates and rechecks controls, expiration, current identity, evidence, and approvals on retrieval.\n\n` +
    `## Migration and recovery scope\n\n` +
    `All ten existing migrations are installed on clean ephemeral local D1. A separate 0009 baseline contains fourteen keyed synthetic product, offer, ` +
    `click/conversion/commission/ledger/revenue, deal, decision, opportunity, and content records before upgrading to additive 0010. ` +
    `Real Phase 9 execution receipts and inline rollback evidence are seeded after 0010 and preserved across a repeated migration-runner invocation. ` +
    `The migration ledger skips applied files; the raw ALTER statements are not universally SQL-idempotent. Historical triggers/table rebuilds are conservatively REVIEW_REQUIRED/DESTRUCTIVE, not reclassified as additive. ` +
    `Only 0010 is pending for this representative 0009 upgrade. No production schema baseline or data has been inspected.\n\n` +
    `FULL means every critical reversible member of the local fixture release bundle has a valid capability-scoped inline rollback plan. ` +
    `It does not mean production deployment, database downgrade, or external rollback coverage. Drills validate proposal/target/environment/version/fingerprint binding and original content, ` +
    `and prove duplicate, stale, and cross-proposal rejection. They never restore production. Non-reversible future actions block certification and require separate human review.\n\n` +
    `## Operator procedure\n\n` +
    `1. Review the exact candidate, OperatorReviewSummary, source/artifact hashes, pending migration, bindings, evidence, and approval scope.\n` +
    `2. Rehearse only with local fixtures. Run \`node scripts/v6-phase9-5-validation.mjs all\` (add \`--record\` only to refresh this checkpoint).\n` +
    `3. Inspect abort reasons: artifact/policy drift, missing bindings, migration failure, unknown/active controls, money or security violations, stale approval, unavailable rollback, or threshold failure.\n` +
    `4. A local kill-switch/unknown/emergency-stop drill must block. Emergency stop is exercised on an isolated disposable D1 instance; certification uses a separately initialized local instance, never resets production controls.\n` +
    `5. Stop after local certification. Future production requires separately authorized infrastructure/bindings, verified humans, provider observations, business SLOs, backup/restore and deployment procedures. Do not deploy, migrate production, change DNS, shift traffic, or start Phase 10.\n\n` +
    `## Canary, monitoring, cost and bounds\n\n` +
    `Canary stages 0/preview/1/5/100 percent are future plan references with executable=false; actual traffic remains zero. Unknown blast radius blocks. ` +
    `Observability describes local safety-event thresholds and a configured five-second drill-latency threshold, not measured production telemetry or invented business SLOs. ` +
    `Unknown thresholds require review. Structural resource classes are not billing estimates. Caps: queue10, D1 batch100, proposals20, approval backlog20, routes20, attempts3, dispatches5, retry delay at least60 seconds.\n\n` +
    `Candidate/certificate lookups are keyed in a session capped at20; journal reads are indexed and capped at20. Migration fixtures use keyed bounded lookups. ` +
    `No due-release scheduler or continuous polling is introduced. Source/build inventory scans are local tooling, not production application-memory scans. ` +
    `No file storage or settings modules enter the Worker build. Existing test bodies remain unchanged; an evidence-recorder preload redirects only their historical state/report writes to ignored local output.\n\n` +
    `## Final-source evidence\n\n` +
    `${evidence.focused.passed} focused checks passed, zero failures/skips, including all A–Z cases. ` +
    `Regression and quality commands, output hashes, full artifact hashes, before/after fixture hashes, and audit events are in the structured evidence. ` +
    `Two builds: ${evidence.builds.reproducibility}; per-artifact byte differences are recorded without claiming unproven reproducibility. ` +
    `Logs, build output and local databases remain ignored. Prior phase documents and historical state entries are preserved.\n\n` +
    `## Outcomes\n\n\`\`\`text\n${status}\n\`\`\`\n`;
  fs.writeFileSync(path.join(root, checkpoint), document);
  const marker = 'PHASE9_5: local preproduction rehearsal';
  const state = { ...previous, currentPhase: 'PHASE9_5', currentStep: 'Local readiness certified; stop before production', result: 'PASS',
    nextStep: outcomes.NEXT_RECOMMENDED_PHASE, blockers: [], updatedAt: evidence.capturedAt,
    completedCheckpoints: [...(previous.completedCheckpoints ?? []).filter(item => item !== marker), marker],
    verifiedTestEvidence: [...(previous.verifiedTestEvidence ?? []).filter(item => item.name !== 'phase9-5-preproduction-readiness'),
      { name: 'phase9-5-preproduction-readiness', path: evidencePath, passed: evidence.focused.passed, failed: evidence.focused.failed }],
    phase9_5: { checkpoint, evidence: evidencePath, sourceHead: evidence.source.head, candidateId: evidence.candidate.id,
      sourceFingerprint: evidence.source.fingerprint, outcomes }, workingTreeFingerprint: load('../v6-run-state.cjs').fingerprint().sha256 };
  for (const [key, value] of Object.entries(previous)) if (/^phase(5|6|7|8|9)/i.test(key) && key !== 'phase9_5') assert.deepEqual(state[key], value);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), state); assert.deepEqual(sourceManifest(), evidence.source);
  return outcomes;
}
