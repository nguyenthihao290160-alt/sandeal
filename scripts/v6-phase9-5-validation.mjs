import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load, domain, root, hash, executionFingerprint, sourceManifest, captureArtifacts, buildArtifacts, git } from './lib/release-rehearsal.mjs';
import { releaseFixture, approvalFixture } from './lib/release-rehearsal-fixtures.mjs';
import { persistExecutionFixture } from './lib/release-migration-rehearsal.mjs';
import { recordCheckpoint } from './lib/release-rehearsal-checkpoint.mjs';

const directory = path.join(root, '.test-tmp/phase9-5');
const mode = process.argv[2] ?? 'all';
assert.ok(['all', 'focused', 'regressions', 'quality', 'build', 'certify'].includes(mode), 'REHEARSAL_MODE_INVALID');
fs.mkdirSync(directory, { recursive: true });
const initialSource = sourceManifest(), statePath = path.join(root, 'docs/v6/LONG_RUN_STATE.json'), priorStateBytes = fs.readFileSync(statePath);
const steps = {
  focused: [['phase9-5', 'scripts/phase-09-5-preproduction-tests.mjs']],
  regressions: [
    ['phase9', 'scripts/phase-09-execution-control-plane-tests.cjs'], ['d1', 'scripts/v6-d1-tests.cjs'],
    ['migrations', 'scripts/v6-migration-tests.cjs'], ['queue', 'scripts/v6-cloudflare-queue-tests.cjs'], ['cron', 'scripts/v6-cloudflare-cron-tests.cjs'],
    ['phase8-5', 'scripts/v6-content-lifecycle-tests.mjs'], ['phase8', 'scripts/v6-content-seo-tests.mjs'],
    ['phase7-5', 'scripts/v6-opportunity-experiments-tests.mjs'], ['phase7', 'scripts/v6-decision-os-tests.mjs'],
    ['phase6', 'scripts/v6-deal-intelligence-tests.cjs'], ['phase5', 'scripts/v6-money-engine-tests.cjs'],
    ['autopilot', 'scripts/v6-cloudflare-autopilot-tests.cjs'], ['runtime', 'scripts/v6-cloudflare-runtime-tests.cjs'],
    ['routing', 'scripts/v6-cloudflare-routing-tests.cjs'], ['site', 'scripts/v6-cloudflare-site-tests.cjs'],
    ['accesstrade', 'scripts/accesstrade-link-safety-tests.cjs'], ['tiktok', 'scripts/accesstrade-tiktok-integration-tests.cjs'],
    ['publication', 'scripts/prompt10-autopublish-tests.cjs'], ['zero-vps', 'scripts/v6-zero-vps-storage-tests.cjs'],
    ['revenue', 'scripts/prompt10-revenue-integrity-tests.cjs'],
  ],
  quality: [
    ['typescript', 'node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'],
    ['eslint', 'node_modules/eslint/bin/eslint.js', '.'], ['secret-scan', 'scripts/release-validation.cjs', 'secret-scan'], ['diff-check', null],
  ],
};
function write(name, value) { fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n'); }
function unchanged() { assert.deepEqual(sourceManifest(), initialSource, 'SOURCE_CHANGED_DURING_REHEARSAL'); assert.deepEqual(fs.readFileSync(statePath), priorStateBytes, 'PRIOR_STATE_CHANGED'); }
function report(name) {
  const value = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8'));
  assert.deepEqual(value.source, initialSource, `STALE_${name}_REPORT`); return value;
}
function runGroup(group) {
  const results = [];
  for (const [name, entry, ...argumentsList] of steps[group]) {
    console.log(`RUN ${name}`); const started = Date.now();
    const args = entry ? [...(group === 'regressions' ? ['--import', './scripts/lib/rehearsal-evidence-isolation.mjs'] : []), entry, ...argumentsList] : ['diff', '--check'];
    const result = spawnSync(entry ? process.execPath : 'git', args, { cwd: root, encoding: 'utf8', windowsHide: true,
      timeout: 600000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' } });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`;
    fs.writeFileSync(path.join(directory, `${name}.log`), output);
    const count = [...output.matchAll(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/gi)].at(-1);
    const item = { name, command: [entry ? 'node' : 'git', ...args].join(' '), exit: result.status ?? 1, elapsedMs: Date.now() - started,
      outputFingerprint: hash(output), passed: count ? Number(count[1]) : null, failed: count ? Number(count[2]) : null, skipped: count ? Number(count[3] ?? 0) : null };
    results.push(item); write(group, { source: initialSource, results, completed: false, generatedAt: new Date().toISOString() }); console.log(JSON.stringify(item));
    assert.equal(item.exit, 0, `${name}: ${output.slice(-4000)}`);
    if (group !== 'quality') { assert.ok(item.passed > 0, `NO_ASSERTIONS_${name}`); assert.equal(item.failed, 0); assert.equal(item.skipped, 0); }
    unchanged();
  }
  write(group, { source: initialSource, results, completed: true, generatedAt: new Date().toISOString() });
}
async function buildTwice() {
  const first = await buildArtifacts(initialSource), second = await buildArtifacts(initialSource);
  const comparison = first.map((artifact, index) => {
    const changed = [...new Set([...artifact.files, ...second[index].files].map(file => file.path))].sort().filter(name => {
      const left = artifact.files.find(file => file.path === name), right = second[index].files.find(file => file.path === name);
      return !left || !right || left.sha256 !== right.sha256;
    });
    return { kind: artifact.kind, firstFingerprint: artifact.fingerprint, secondFingerprint: second[index].fingerprint, exactBytes: changed.length === 0, changed };
  });
  unchanged(); write('build', { source: initialSource, artifacts: second, comparison, completed: true,
    reproducibility: comparison.every(item => item.exactBytes) ? 'BYTE_FOR_BYTE' : 'SOURCE_BOUND_BUILDS_BYTE_VARIANCE_RECORDED',
    generatedAt: new Date().toISOString() });
}
function requireResults(group) {
  const value = report(group); assert.equal(value.completed, true);
  assert.deepEqual(value.results.map(item => item.name), steps[group].map(([name]) => name));
  assert.ok(value.results.every(item => item.exit === 0 && (group === 'quality' || item.passed > 0 && item.failed === 0 && item.skipped === 0)));
  return value;
}
async function certify() {
  const focusedGroup = requireResults('focused'), regressions = requireResults('regressions'), quality = requireResults('quality'), builds = report('build');
  const focused = report('focused-results');
  assert.equal(builds.completed, true); assert.equal(focused.failed, 0); assert.equal(focused.skipped, 0); assert.equal(focused.matrix.length, 26);
  assert.ok(focused.matrix.every(item => focused.cases.some(test => test.name === item.test && test.status === 'PASS')));
  assert.deepEqual(captureArtifacts(initialSource), builds.artifacts, 'STALE_ARTIFACT_BYTES');
  assert.deepEqual(git('diff', '--name-only', 'HEAD', '--', 'package.json', 'package-lock.json'), '', 'DEPENDENCY_CHANGE_REQUIRES_REVIEW');
  const now = Date.now(), fixture = releaseFixture({ now, source: initialSource, artifacts: builds.artifacts, evidenceOrigin: 'LOCAL_RUNNER' });
  const { candidate, context } = fixture, { certifyRelease, evidenceSubject } = domain('certification');
  assert.equal(focused.migration.inventoryFingerprint, executionFingerprint(candidate.manifest.migrations), 'MIGRATION_REPORT_MISMATCH');
  const { openLocalD1, applyLocalMigrations } = load('./local-d1.cjs');
  const { executeDryRun } = load('../../src/lib/execution-control-plane/dryRunExecutor.ts');
  const drillHandle = await openLocalD1();
  const drills = { scope: 'ACTUAL_CANDIDATE_LOCAL_FIXTURE_BUNDLE_NO_RESTORE_OR_PRODUCTION_AUTHORITY' };
  try {
    await applyLocalMigrations(drillHandle);
    const execution = await persistExecutionFixture(drillHandle.db, context.bundle.members[0].context);
    drills.rollback = domain('plans').rollbackDrill(execution.context, execution.plan); assert.equal(drills.rollback.passed, true); assert.equal(drills.rollback.restored, false);
    const active = structuredClone(execution.context); active.killSwitch.state = 'ACTIVE';
    assert.equal(executeDryRun(active).receipt.wouldExecute, false); drills.killSwitch = 'BLOCKED';
    const unknown = structuredClone(execution.context); unknown.killSwitch = null;
    assert.equal(executeDryRun(unknown).receipt.wouldExecute, false); drills.unknownKillSwitch = 'BLOCKED';
    await execution.store.emergencyStop('local-simulation-operator', now);
    const stopped = await execution.store.loadContext(execution.context.proposal.id, now, true);
    assert.equal(executeDryRun(stopped).receipt.wouldExecute, false); drills.emergencyStop = 'BLOCKED';
  } finally { await drillHandle.dispose(); }
  const gateReports = {
    CLEAN_MIGRATION: focused.migration, UPGRADE_MIGRATION: focused.migration, DATA_PRESERVATION: focused.migration,
    ROLLBACK_DRILL: drills.rollback, KILL_SWITCH_DRILL: drills, KILL_SWITCH_UNKNOWN_DRILL: drills, EMERGENCY_STOP_DRILL: drills,
    SECURITY_TESTS: focused.cases, REGRESSIONS: regressions.results,
    TYPESCRIPT: quality.results.find(item => item.name === 'typescript'), ESLINT: quality.results.find(item => item.name === 'eslint'),
    SECRET_SCAN: quality.results.find(item => item.name === 'secret-scan'), DIFF_CHECK: quality.results.find(item => item.name === 'diff-check'),
  };
  context.evidence = domain('contracts').REQUIRED_GATES.map(gate => ({ gate, sourceFingerprint: initialSource.fingerprint,
    subjectFingerprint: evidenceSubject(candidate, gate), passed: true, reportFingerprint: executionFingerprint(gateReports[gate]), origin: 'LOCAL_RUNNER' }));
  const handle = await openLocalD1();
  let certification, journalEvents;
  try {
    await applyLocalMigrations(handle);
    const execution = await persistExecutionFixture(handle.db, context.bundle.members[0].context);
    await execution.store.createProposal(context.approval.proposal); await execution.store.createApproval(approvalFixture(context.approval.proposal, now));
    context.now = Date.now();
    context.approval.approval = await execution.store.getValidApprovalForProposal(context.approval.proposal.id, context.now);
    context.bundle.members[0].context = await execution.store.loadContext(context.bundle.members[0].context.proposal.id, context.now, true);
    context.killSwitch = await execution.store.getKillSwitchState();
    const session = new (domain('session').LocalRehearsalSession)('LOCAL'); session.activate(candidate.manifest);
    unchanged(); assert.deepEqual(captureArtifacts(initialSource), builds.artifacts);
    certification = session.certify(candidate.id, context); assert.deepEqual(certification.blockers, []); assert.ok(certification.certificate);
    assert.deepEqual(session.certify(candidate.id, context), certification); assert.ok(session.certificate(candidate.id, context));
    const active = structuredClone(context); active.killSwitch.state = 'ACTIVE'; assert.equal(certifyRelease(candidate, active).certificate, null);
    const unknown = structuredClone(context); unknown.killSwitch = null; assert.equal(certifyRelease(candidate, unknown).certificate, null);
    const journal = new (domain('journal').RehearsalJournal)(handle.db, 'LOCAL');
    for (const event of ['CANDIDATE_CREATED', 'ARTIFACT_VERIFIED', 'MIGRATION_PASS', 'KILL_SWITCH_DRILL', 'ROLLBACK_DRILL', 'CERTIFICATE_ISSUED']) {
      await journal.append({ candidateId: candidate.id, event, timestamp: now, evidenceFingerprint: executionFingerprint({ candidate: candidate.fingerprint, event, drills }) });
    }
    journalEvents = await journal.list(candidate.id, now + 1); assert.equal(journalEvents.length, 6);
  } finally { await handle.dispose(); }
  unchanged();
  const evidence = { schema: 'sandeal-phase9-5-local-evidence-v1', capturedAt: new Date().toISOString(), source: initialSource,
    scope: 'LOCAL_FIXTURE_REHEARSAL_NOT_PRODUCTION_APPROVAL', candidate, certification, gateEvidence: context.evidence,
    approvalProvenance: 'SYNTHETIC_LOCAL_OPERATOR_ALLOWLIST_ONLY_NOT_PRODUCTION_HUMAN_APPROVAL',
    providerProvenance: 'LOCAL_FIXTURE_AVAILABILITY_NOT_LIVE_PROBE', migration: focused.migration, drills, journalEvents,
    focused: { passed: focused.passed, failed: focused.failed, skipped: focused.skipped, matrix: focused.matrix, cases: focused.cases },
    validation: [...focusedGroup.results, ...regressions.results, ...quality.results], builds: { comparison: builds.comparison, reproducibility: builds.reproducibility },
    dependencyAudit: { packageAndLockUnchanged: true, productionDependenciesAdded: 0 },
    production: { deployment: 0, resources: 0, migrations: 0, mutations: 0, trafficShift: 0, realMoney: 0, directShopeeCalls: 0,
      aiExecutionAuthority: false, liveAiProbe: 'NOT_RUN', enabled: false },
    limitations: ['Historical migrations include destructive table-copy steps; only 0010 is pending against the 0009 fixture baseline.',
      'FULL rollback covers critical reversible local bundle members only. No artifact/schema/production restore executor exists.',
      'Local approval and provider availability are explicit fixtures; no authenticated production approval or observation.',
      'Certificates expire within five minutes or sooner with any source, artifact, approval, policy, control, or environment change.',
      'No release worker is scheduled. Candidate/certificate sessions are bounded and ephemeral; only indexed local D1 audit events persist during the drill.'] };
  write('certification', evidence); console.log(`READINESS_CERTIFICATE_STATE=${certification.certificate.state}`);
  console.log(`RELEASE_CANDIDATE_ID=${candidate.id}`); return evidence;
}
try {
  if (mode === 'all' || mode === 'focused') runGroup('focused');
  if (mode === 'all' || mode === 'regressions') runGroup('regressions');
  if (mode === 'all' || mode === 'quality') runGroup('quality');
  if (mode === 'all' || mode === 'build') await buildTwice();
  if (mode === 'all' || mode === 'certify') { const evidence = await certify(); if (process.argv.includes('--record')) console.log(JSON.stringify(recordCheckpoint(evidence), null, 2)); }
} catch (error) { console.error(error); process.exitCode = 1; }
