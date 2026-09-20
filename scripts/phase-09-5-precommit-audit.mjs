import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { root, git, hash, executionFingerprint } from './lib/release-rehearsal.mjs';

export function auditPhase95() {
  const head = '4890b7bd4ec737d1e503ea2b6e38435a817aaee6';
  assert.equal(git('rev-parse', 'HEAD'), head, 'AUDIT_HEAD_CHANGED');
  const evidencePath = 'docs/v6/evidence/phase9-5-preproduction-readiness.json';
  const evidence = JSON.parse(git('show', `${head}:${evidencePath}`));
  const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', head).split('\n');
  const allowed = /^(?:docs\/v6\/(?:LONG_RUN_STATE\.json|evidence\/phase9-5-preproduction-readiness\.json|phase-09-5-preproduction-readiness\.md)|scripts\/(?:lib\/(?:local-d1\.cjs|rehearsal-evidence-isolation\.mjs|release-(?:migration-rehearsal|rehearsal(?:-checkpoint|-fixtures)?)\.mjs)|phase-09-5-preproduction-tests\.mjs|v6-phase9-5-validation\.mjs)|src\/lib\/release-rehearsal\/[a-z]+\.ts)$/;
  const suspicious = changed.filter(file => !allowed.test(file));
  assert.equal(suspicious.length, 0, 'UNEXPECTED_PHASE95_COMMIT_PATH');
  assert.equal(changed.length, 19, 'PHASE95_COMMIT_SCOPE_CHANGED');
  const retained = JSON.parse(fs.readFileSync(path.join(root, '.test-tmp/phase10/inventory.json'))).source;
  assert.equal(retained.fingerprint, evidence.source.fingerprint);
  assert.equal(executionFingerprint(retained.files), retained.fingerprint);
  for (const [file, fingerprint] of Object.entries(retained.files)) {
    const committed = execFileSync('git', ['show', `${head}:${file}`], { cwd: root, windowsHide: true });
    const allowedHashes = [hash(committed)];
    if (!committed.includes(0)) {
      const normalized = committed.toString('utf8').replaceAll('\r\n', '\n');
      allowedHashes.push(hash(normalized), hash(normalized.replaceAll('\n', '\r\n')));
    }
    assert.ok(allowedHashes.includes(fingerprint), `COMMITTED_SOURCE_DRIFT_${file}`);
  }
  const reportHashes = {};
  for (const [name, reference] of Object.entries(evidence.reports)) {
    assert.equal(hash(fs.readFileSync(path.join(root, reference.path))), reference.sha256, `AUDIT_REPORT_DRIFT_${name}`);
    reportHashes[name] = reference;
  }
  const read = name => JSON.parse(fs.readFileSync(path.join(root, evidence.reports[name].path)));
  const focused = read('focused'), regressions = read('regressions'), quality = read('quality');
  assert.equal(focused.passed, 61); assert.equal(focused.failed, 0); assert.equal(focused.skipped, 0);
  assert.equal(focused.cases.length, 61); assert.ok(focused.cases.every(item => item.status === 'PASS'));
  assert.equal(focused.source.fingerprint, retained.fingerprint);
  assert.equal(regressions.completed, true); assert.equal(quality.completed, true);
  for (const result of [...regressions.results, ...quality.results]) assert.equal(result.exit, 0);
  assert.equal(regressions.results.reduce((total, item) => total + item.passed, 0), 873);
  assert.ok(regressions.results.every(item => item.failed === 0 && item.skipped === 0));
  const currentReports = ['.test-tmp/phase10/tests.json', '.test-tmp/phase10/resume-20260919/regressions.json'];
  for (const file of currentReports) {
    const report = JSON.parse(fs.readFileSync(path.join(root, file)));
    assert.equal(report.completed, true); assert.equal(report.source.fingerprint, retained.fingerprint);
    for (const item of report.results) {
      assert.equal(item.exit, 0); assert.equal(item.failed, 0); assert.equal(item.skipped, 0);
      assert.equal(hash(fs.readFileSync(path.join(root, item.log))), item.sha256);
    }
  }
  const checks = [['secret-scan', process.execPath, ['scripts/release-validation.cjs', 'secret-scan']],
    ['commit-diff-check', 'git', ['diff', `${head}^`, head, '--check']], ['worktree-diff-check', 'git', ['diff', '--check']]];
  const commands = checks.map(([name, binary, args]) => {
    const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(result.status, 0, `AUDIT_${name}_FAILED`);
    return { name, exit: result.status, outputSha256: hash(`${result.stdout}${result.stderr}`) };
  });
  return { schema: 'sandeal-phase95-reconstructed-audit-v1', reviewedAt: new Date().toISOString(),
    scope: 'HONESTLY_DATED_POSTCOMMIT_REVERIFICATION_OF_COMMITTED_PHASE95_NOT_BACKDATED', head,
    originalPrecommitAuditTimestamp: null, originalPrecommitAuditClaimVerified: false,
    sourceFingerprint: retained.fingerprint, sourceFilesVerified: Object.keys(retained.files).length,
    changedFiles: changed, reportHashes, commands, verifiedPhase95Tests: 934,
    rawPhase10LogsAlsoVerified: true, historicalCertificateReusable: false,
    SAFE_TO_COMMIT_ALL_SCOPE: 'RECONSTRUCTED_19_FILE_PHASE95_CHANGESET_ONLY_NOT_CURRENT_PHASE10_WORKTREE',
    PHASE9_5_PRECOMMIT_AUDIT: 'PASS', SAFE_TO_COMMIT_ALL: 'YES', SUSPICIOUS_COUNT: 0,
    PHASE9_5_PRECOMMIT_EVIDENCE: 'PASS', productionAuthority: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const report = auditPhase95();
  fs.mkdirSync(path.join(root, '.test-tmp/phase10-preauth'), { recursive: true });
  fs.writeFileSync(path.join(root, '.test-tmp/phase10-preauth/phase95-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
