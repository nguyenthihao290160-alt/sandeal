import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, load, hash, git, sourceManifest, captureArtifacts, executionFingerprint } from './lib/release-rehearsal.mjs';

const directory = path.join(root, '.test-tmp/phase10-preauth');
const mode = process.argv[2];
assert.ok(['focused', 'regressions', 'quality', 'build', 'final'].includes(mode), 'PREAUTH_MODE_INVALID');
fs.mkdirSync(directory, { recursive: true });
const source = sourceManifest();
const stateBytes = fs.readFileSync(path.join(root, 'docs/v6/LONG_RUN_STATE.json'));
const historical = git('ls-files', '-z', 'docs/v6').split('\0').filter(file => file && file !== 'docs/v6/LONG_RUN_STATE.json');
const historyHashes = Object.fromEntries(historical.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/CLOUDFLARE|^CF_|SHOPEE|ACCESS_TRADE|GEMINI|OPENAI|ANTHROPIC|MONGODB|(?:TOKEN|PASSWORD|SECRET|API_KEY)|^SANDEAL_|^NODE_OPTIONS$/i.test(name)));
Object.assign(env, { NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', CI: 'true', SHOPEE_AFFILIATE_ENABLED: 'false',
  ALLOW_PAID_AI: 'false', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false', SANDEAL_PRODUCTION_EXECUTION_ENABLED: 'false' });
const write = (name, value) => fs.writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
const unchanged = () => {
  assert.deepEqual(sourceManifest(), source, 'PREAUTH_SOURCE_DRIFT');
  assert.deepEqual(fs.readFileSync(path.join(root, 'docs/v6/LONG_RUN_STATE.json')), stateBytes, 'PREAUTH_STATE_CHANGED_DURING_VALIDATION');
  for (const [file, expected] of Object.entries(historyHashes)) assert.equal(hash(fs.readFileSync(path.join(root, file))), expected, `HISTORY_DRIFT_${file}`);
};
function run(name, binary, args) {
  console.log(`RUN ${name}`);
  const startedAt = new Date().toISOString();
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 24 * 1024 * 1024, env });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
  const log = `.test-tmp/phase10-preauth/${name}.log`;
  fs.writeFileSync(path.join(root, log), output);
  const count = [...output.matchAll(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/gi)].at(-1);
  const report = { name, command: [binary === process.execPath ? 'node' : binary, ...args].join(' '), startedAt,
    finishedAt: new Date().toISOString(), exit: result.status ?? 1, log, sha256: hash(output),
    passed: count ? Number(count[1]) : null, failed: count ? Number(count[2]) : null, skipped: count ? Number(count[3] ?? 0) : null };
  if (name === 'eslint' && report.exit === 0) {
    const files = JSON.parse(output); report.errors = files.reduce((sum, file) => sum + file.errorCount, 0);
    report.warnings = files.reduce((sum, file) => sum + file.warningCount, 0);
    report.newWarnings = files.filter(file => Object.hasOwn(source.files, path.relative(root, file.filePath).replaceAll('\\', '/'))
      && !Object.hasOwn(JSON.parse(fs.readFileSync(path.join(root, '.test-tmp/phase10/inventory.json'))).source.files, path.relative(root, file.filePath).replaceAll('\\', '/')))
      .reduce((sum, file) => sum + file.warningCount, 0);
  }
  console.log(JSON.stringify(report)); return report;
}
const suites = [
  ['phase9-5', 'scripts/phase-09-5-preproduction-tests.mjs'], ['phase9', 'scripts/phase-09-execution-control-plane-tests.cjs'],
  ['phase8-5', 'scripts/v6-content-lifecycle-tests.mjs'], ['phase8', 'scripts/v6-content-seo-tests.mjs'],
  ['phase7-5', 'scripts/v6-opportunity-experiments-tests.mjs'], ['phase7', 'scripts/v6-decision-os-tests.mjs'],
  ['phase6', 'scripts/v6-deal-intelligence-tests.cjs'], ['money', 'scripts/v6-money-engine-tests.cjs'],
  ['d1', 'scripts/v6-d1-tests.cjs'], ['migrations', 'scripts/v6-migration-tests.cjs'],
  ['queue', 'scripts/v6-cloudflare-queue-tests.cjs'], ['cron', 'scripts/v6-cloudflare-cron-tests.cjs'],
  ['runtime', 'scripts/v6-cloudflare-runtime-tests.cjs'], ['routing', 'scripts/v6-cloudflare-routing-tests.cjs'],
  ['autopilot', 'scripts/v6-cloudflare-autopilot-tests.cjs'], ['site', 'scripts/v6-cloudflare-site-tests.cjs'],
  ['accesstrade', 'scripts/accesstrade-link-safety-tests.cjs'], ['tiktok', 'scripts/accesstrade-tiktok-integration-tests.cjs'],
  ['publication', 'scripts/prompt10-autopublish-tests.cjs'], ['zero-vps', 'scripts/v6-zero-vps-storage-tests.cjs'],
  ['revenue', 'scripts/prompt10-revenue-integrity-tests.cjs'],
];
if (mode === 'focused' || mode === 'regressions' || mode === 'quality') {
  const commands = mode === 'quality' ? [
    ['typescript', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']],
    ['eslint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.', '--format', 'json']],
    ['secret-scan', process.execPath, ['scripts/release-validation.cjs', 'secret-scan']], ['diff-check', 'git', ['diff', '--check']],
  ] : (mode === 'focused' ? [['phase10', 'scripts/phase-10-preauth-tests.mjs']] : suites)
    .map(([name, file]) => [name, process.execPath, ['--import', './scripts/lib/phase10-evidence-isolation.mjs', file]]);
  const results = [];
  for (const [name, binary, args] of commands) {
    const result = run(name, binary, args); results.push(result); write(mode, { source, results, completed: false });
    assert.equal(result.exit, 0, `FAILED_${name}_SEE_${result.log}`);
    if (mode !== 'quality') { assert.ok(result.passed > 0); assert.equal(result.failed, 0); assert.equal(result.skipped, 0); }
    unchanged();
  }
  write(mode, { source, results, completed: true, completedAt: new Date().toISOString() });
}
if (mode === 'build') {
  const builder = load('../v6-cloudflare-build.cjs');
  const worker = await builder.buildWorker(); assert.equal(worker.fileStorageModules, 0); assert.equal(worker.filesystemSettingsModules, 0);
  const local = builder.buildSite(); assert.equal(local.exit, 0);
  const localArtifacts = captureArtifacts(source);
  const rehearsal = builder.buildSite({ environment: 'PRODUCTION_REHEARSAL', origin: 'https://production-contract.invalid' });
  assert.equal(rehearsal.exit, 0);
  const artifacts = captureArtifacts(source);
  const html = fs.readFileSync(path.join(root, 'cloudflare/site/out/index.html'), 'utf8');
  assert.match(html, /sandeal-environment/); assert.match(html, /PRODUCTION_REHEARSAL/); assert.doesNotMatch(html, /localhost:8787/);
  for (const file of ['index.html', '404.html', 'product/index.html', '_headers']) assert.ok(artifacts[1].files.some(item => item.path === file), file);
  assert.match(fs.readFileSync(path.join(root, 'cloudflare/site/out/_headers'), 'utf8'), /noindex, nofollow/);
  unchanged();
  write('build', { source, completed: true, completedAt: new Date().toISOString(), worker, local, rehearsal,
    localArtifacts, artifacts, fingerprint: executionFingerprint(artifacts), productionEquivalentContract: true,
    productionCertified: false, productionOriginKnown: false, deployments: 0 });
  console.log('BUILD_CLOUDFLARE=PASS_STATIC_AND_WORKER PRODUCTION_CERTIFIED=NO');
}
if (mode === 'final') {
  const reports = Object.fromEntries(['focused', 'regressions', 'quality', 'build'].map(name => {
    const file = `.test-tmp/phase10-preauth/${name}.json`, value = JSON.parse(fs.readFileSync(path.join(root, file)));
    assert.equal(value.completed, true); assert.deepEqual(value.source, source, `STALE_${name}_REPORT`);
    for (const result of value.results ?? []) { assert.equal(result.exit, 0); assert.equal(hash(fs.readFileSync(path.join(root, result.log))), result.sha256); }
    return [name, { path: file, sha256: hash(fs.readFileSync(path.join(root, file))), value }];
  }));
  assert.deepEqual(captureArtifacts(source), reports.build.value.artifacts, 'FINAL_LOCAL_ARTIFACT_DRIFT');
  const results = [...reports.focused.value.results, ...reports.regressions.value.results];
  assert.ok(results.every(item => item.passed > 0 && item.failed === 0 && item.skipped === 0));
  const prior = JSON.parse(fs.readFileSync(path.join(directory, 'prior-long-run-state.json'))), current = JSON.parse(stateBytes);
  for (const field of ['completedCheckpoints', 'verifiedTestEvidence']) assert.deepEqual(current[field].slice(0, prior[field].length), prior[field]);
  for (const field of Object.keys(prior).filter(name => /^phase/i.test(name) && name !== 'phase10')) assert.deepEqual(current[field], prior[field], `STATE_HISTORY_${field}`);
  if (current.phase10.previousCheckpoint) assert.deepEqual(current.phase10.previousCheckpoint, prior.phase10);
  const changed = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  for (const file of changed) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (!bytes.includes(0)) assert.equal(bytes.toString('utf8').split(/\r?\n/).some(line => /[\t ]+$/.test(line)), false, `UNTRACKED_WHITESPACE_${file}`);
  }
  const files = ['docs/v6/LONG_RUN_STATE.json', 'docs/v6/phase-10-production-launch.md', 'docs/v6/phase-10-preauth-contracts.md',
    'docs/v6/evidence/phase10-production-launch.json', 'docs/v6/evidence/phase10-preauth-remediation.json', 'docs/v6/evidence/phase9-5-precommit-audit.json'];
  write('final-check', { checkedAt: new Date().toISOString(), sourceFingerprint: source.fingerprint, sourceHead: source.head,
    uniqueTests: results.reduce((sum, item) => sum + item.passed, 0),
    failed: 0, skipped: 0, reused: 0, resumedRegressionTests: reports.regressions.value.results.length,
    migrationChecksRerunNotDoubleCounted: 0, finalQuality: 'PASS',
    stateParse: 'PASS', priorHistoryPreserved: true, checkpointConsistent: true,
    currentReleaseCandidateFingerprint: 'NONE_PRODUCTION_CANDIDATE_UNAVAILABLE',
    artifactInventoryFingerprint: reports.build.value.fingerprint, localArtifactInventoryFingerprint: executionFingerprint(reports.build.value.localArtifacts), documentHashes: Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
    gitStatus: git('status', '--short'), sourceChanged: false,
    productionMutations: 0, productionAuthorization: false });
  console.log(`FINAL_VERIFIED_TESTS=${results.reduce((sum, item) => sum + item.passed, 0)} LONG_RUN_STATE_PARSE=PASS HISTORY_PRESERVED=YES`);
}
