import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, domain, load, executionFingerprint, migrationFiles } from './lib/release-rehearsal.mjs';
import { canonicalJson, sha256, compareText } from './lib/d1-schema-canonical.mjs';
import { createReference, operationalNames } from './phase-10-release-reference.mjs';
import { readReviewPolicy, validateCheckout, verifyCandidate, prepareCandidate, futurePhaseReadiness, parseLocalArguments } from './phase-10-exact-candidate.mjs';

fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(root, '.test-tmp/gate2-fixtures-'));
const digest = value => sha256(canonicalJson(value));
let passed = 0, failed = 0, fixtureNumber = 0;
async function test(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
function write(directory, relative, contents) {
  const absolute = path.join(directory, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  return { path: relative, sha256: sha256(contents), bytes: Buffer.byteLength(contents) };
}
const writeJson = (directory, relative, value) => write(directory, relative, `${JSON.stringify(value, null, 2)}\n`);
function fixture() {
  const directory = path.join(fixtureRoot, String(++fixtureNumber)), candidateDirectory = '.test-tmp/reviewed';
  const sourceSha = '1'.repeat(40), tree = '2'.repeat(40), now = 1_800_000_000_000;
  const sourceFiles = [{ path: 'synthetic-source.js', sha256: sha256('synthetic-source'), bytes: 16 }];
  const source = { head: sourceSha, branch: 'master', gitTree: tree, worktreeClean: true, indexClean: true,
    fingerprint: digest(sourceFiles), files: sourceFiles };
  const input = { schema: 'sandeal-phase10-release-reference-input-v1', expectedHead: sourceSha, expectedBranch: 'master',
    allowDirtySource: false, origin: 'https://synthetic.sandeal.tech', originSource: 'USER_SELECTED_APPLICATION_ORIGIN',
    configPath: 'wrangler.bootstrap.toml',
    target: { accountId: '1'.repeat(32), workerName: 'synthetic-worker', databaseId: '11111111-1111-1111-1111-111111111111',
      databaseName: 'synthetic-database', queueName: 'synthetic-queue', queueId: '2'.repeat(32) },
    routing: { domain: 'synthetic.sandeal.tech', domainState: 'REFERENCE_ONLY', route: null, routeState: 'UNKNOWN', assetsRemoteState: 'UNKNOWN' },
    operations: Object.fromEntries(operationalNames.map(name => [name, 'UNKNOWN'])), evidencePaths: ['config/cloudflare/production.contract.json'] };
  const workerFile = write(directory, '.test-tmp/v6-cloudflare-worker/worker.mjs', 'export default {};\n');
  const staticFiles = ['index.html', '404.html', 'product/index.html', '_headers'].sort(compareText)
    .map(name => ({ ...write(directory, `cloudflare/site/out/${name}`, `synthetic-static-${name}`), path: name }));
  const artifacts = [{ kind: 'WORKER', files: [{ ...workerFile, path: 'worker.mjs' }] }, { kind: 'STATIC', files: staticFiles }]
    .map(artifact => ({ ...artifact, fingerprint: domain('manifest').artifactFingerprint(artifact) }));
  const config = { reference: write(directory, 'wrangler.bootstrap.toml', 'synthetic-local-fixture\n'),
    workerName: input.target.workerName, accountReferenceInConfig: null,
    ASSETS: { binding: 'ASSETS', directory: 'cloudflare/site/out', runWorkerFirst: true, state: 'PRESENT_LOCAL_CONFIG_ONLY' },
    queueConsumers: 0, crons: 0, executionEnabled: false };
  const builds = [1, 2].map(number => ({ exit: 0, sourceHead: sourceSha, sourceFingerprint: source.fingerprint,
    cleanBuild: true, buildId: sourceSha, nextBuildId: 'synthetic-internal-id', environment: 'PRODUCTION', origin: input.origin,
    toolchain: { node: 'synthetic', platform: 'synthetic', arch: 'synthetic', next: 'synthetic', esbuild: 'synthetic', wrangler: 'synthetic' },
    log: write(directory, `${candidateDirectory}/build-${number}.log`, 'synthetic-local-build\n'), artifacts: structuredClone(artifacts) }));
  const references = [writeJson(directory, 'config/cloudflare/production.contract.json', { fixture: true }),
    writeJson(directory, `${candidateDirectory}/inputs.json`, input), writeJson(directory, `${candidateDirectory}/source-inventory.json`, source),
    ...builds.map((build, index) => writeJson(directory, `${candidateDirectory}/build-${index + 1}.json`, build)), config.reference];
  const bundle = createReference(input, source, config, builds, references);
  const policy = { schema: 'sandeal-gate2-review-pins-v1', sourceSha, branch: 'master', remoteRef: 'refs/remotes/origin/master',
    candidateIdentifier: bundle.bundleFingerprint, candidateReference: writeJson(directory, `${candidateDirectory}/reference.json`, bundle),
    reviewedAtUtc: new Date(now - 1000).toISOString(), localEvidenceMaxAgeMs: 604800000, artifactCount: 5, staticFileCount: 4,
    target: { accountId: input.target.accountId, workerName: input.target.workerName, staticTarget: input.target.workerName, environment: 'PRODUCTION' },
    productionMutationMode: 'BLOCKED' };
  const review = { status: 'PASS_LOCAL_ONLY', sourceHead: sourceSha, sourceFingerprint: source.fingerprint,
    candidateIdentifier: policy.candidateIdentifier, artifactCount: 5, completedAtUtc: policy.reviewedAtUtc, twoBuildInventoryMatch: true,
    artifacts: [workerFile, ...staticFiles.map(file => ({ ...file, path: `cloudflare/site/out/${file.path}` }))] };
  policy.reviewEvidence = writeJson(directory, '.test-tmp/reviewed-control/final-integrity.json', review);
  const checkout = { head: sourceSha, remoteHead: sourceSha, branch: 'master', tree, indexClean: true };
  return { directory, inputPath: policy.candidateReference.path, policy, checkout, now, bundle, builds, review };
}
const verify = sample => verifyCandidate(sample.inputPath, sample);
function packageFixture() {
  const sample = fixture();
  prepareCandidate(sample.inputPath, '.test-tmp/package', sample);
  sample.inputPath = '.test-tmp/package/handoff.json';
  sample.handoff = verify(sample).handoff;
  return sample;
}
function tamperHandoff(sample, mutate) {
  mutate(sample.handoff);
  const { handoffFingerprint, ...body } = sample.handoff;
  assert.ok(handoffFingerprint);
  sample.handoff.handoffFingerprint = digest(body);
  writeJson(sample.directory, sample.inputPath, sample.handoff);
}

await test('exact valid candidate verifies and preparation preserves every reviewed byte', () => {
  const sample = fixture(), original = verify(sample).handoff;
  const prepared = prepareCandidate(sample.inputPath, '.test-tmp/package', sample);
  assert.deepEqual(prepared.handoff, original);
  assert.deepEqual(verify(sample).handoff, original);
  assert.equal(prepared.packaged, true);
  assert.equal(original.artifactCount, 5);
  assert.equal(original.worker.sha256, sample.bundle.artifacts.worker.moduleSha256);
  assert.equal(original.assets.fileCount, 4);
  assert.equal(original.assets.binding, 'ASSETS');
  assert.equal(original.assets.association, 'SAME_INACTIVE_WORKER_VERSION');
});
await test('prepared package is self-contained, without reading or rebuilding original outputs', () => {
  const sample = packageFixture();
  fs.unlinkSync(path.join(sample.directory, sample.policy.candidateReference.path));
  write(sample.directory, '.test-tmp/v6-cloudflare-worker/worker.mjs', 'unreviewed-rebuild');
  write(sample.directory, 'cloudflare/site/out/new-rebuild.js', 'unreviewed-rebuild');
  assert.deepEqual(verify(sample).handoff, sample.handoff);
});
for (const [name, mutate] of [
  ['wrong checkout SHA', sample => { sample.checkout.head = '3'.repeat(40); }],
  ['wrong remote-tracking SHA', sample => { sample.checkout.remoteHead = '3'.repeat(40); }],
  ['wrong branch', sample => { sample.checkout.branch = 'other'; }],
  ['wrong Git tree', sample => { sample.checkout.tree = '3'.repeat(40); }],
  ['staged changes', sample => { sample.checkout.indexClean = false; }],
  ['wrong approved source SHA', sample => { sample.policy.sourceSha = '3'.repeat(40); }],
  ['wrong candidate identifier', sample => { sample.policy.candidateIdentifier = '3'.repeat(64); }],
  ['wrong artifact count', sample => { sample.policy.artifactCount++; }],
  ['wrong static count', sample => { sample.policy.staticFileCount++; }],
  ['wrong account', sample => { sample.policy.target.accountId = '3'.repeat(32); }],
  ['wrong Worker', sample => { sample.policy.target.workerName = 'other'; sample.policy.target.staticTarget = 'other'; }],
  ['wrong environment', sample => { sample.policy.target.environment = 'LOCAL'; }],
  ['unspecified account', sample => { delete sample.policy.target.accountId; }],
  ['unspecified Worker', sample => { delete sample.policy.target.workerName; }],
  ['stale candidate review', sample => { sample.now += sample.policy.localEvidenceMaxAgeMs; }],
  ['future-dated review', sample => { sample.now -= 2000; }],
  ['non-finite clock', sample => { sample.now = NaN; }],
  ['changed Worker bytes', sample => { write(sample.directory, '.test-tmp/v6-cloudflare-worker/worker.mjs', 'substituted-worker'); }],
  ['changed static bytes', sample => { write(sample.directory, 'cloudflare/site/out/index.html', 'substituted-static'); }],
  ['missing static file', sample => { fs.unlinkSync(path.join(sample.directory, 'cloudflare/site/out/index.html')); }],
  ['extra static file', sample => { write(sample.directory, 'cloudflare/site/out/extra.js', 'extra-deployable'); }],
  ['missing Worker', sample => { fs.unlinkSync(path.join(sample.directory, '.test-tmp/v6-cloudflare-worker/worker.mjs')); }],
  ['modified evidence', sample => { write(sample.directory, sample.policy.reviewEvidence.path, '{}'); }],
  ['changed configuration', sample => { write(sample.directory, 'wrangler.bootstrap.toml', 'changed-config'); }],
]) {
  await test(`fail closed before preparation: ${name}`, () => {
    const sample = fixture(); mutate(sample);
    assert.throws(() => prepareCandidate(sample.inputPath, '.test-tmp/package', sample));
    assert.equal(fs.existsSync(path.join(sample.directory, '.test-tmp/package')), false);
  });
}
for (const [name, mutate] of [
  ['source SHA', handoff => { handoff.source.sha = '3'.repeat(40); }],
  ['candidate ID', handoff => { handoff.candidateIdentifier = '3'.repeat(64); }],
  ['account', handoff => { handoff.target.accountId = '3'.repeat(32); }],
  ['Worker name', handoff => { handoff.target.workerName = 'other'; }],
  ['environment', handoff => { handoff.target.environment = 'PREVIEW'; }],
  ['artifact count', handoff => { handoff.artifactCount++; }],
  ['ASSETS declaration', handoff => { delete handoff.assets.binding; }],
  ['Worker-first gate', handoff => { handoff.assets.runWorkerFirst = false; }],
  ['asset association', handoff => { handoff.assets.association = 'OTHER_VERSION'; }],
  ['static inventory', handoff => { handoff.assets.files.pop(); }],
  ['Worker path traversal', handoff => { handoff.worker.path = '../worker.mjs'; }],
  ['extended review expiry', handoff => { handoff.review.expiresAtUtc = '2099-01-01T00:00:00.000Z'; }],
  ['invented certification', handoff => { handoff.authority.productionCertification = { status: 'PASS_LOCAL_ONLY' }; }],
  ['invented deployment approval', handoff => { handoff.authority.deploymentAuthorization = true; }],
  ['implicit runtime activation', handoff => { handoff.authority.runtimeActivationAuthorized = true; }],
  ['invented rollback version', handoff => { handoff.rollback.workerVersionId = 'unverified-version'; }],
  ['invented previous release', handoff => { handoff.rollback.previousCompatibleRelease = 'unverified-release'; }],
  ['credential field', handoff => { handoff.apiToken = 'synthetic-test-only'; }],
  ['Basic Auth value', handoff => { handoff.BASIC_AUTH_PASSWORD = 'synthetic-test-only'; }],
]) {
  await test(`rehashing handoff cannot substitute ${name}`, () => {
    const sample = packageFixture(); tamperHandoff(sample, mutate);
    assert.throws(() => verify(sample), /HANDOFF_SUBSTITUTION/);
  });
}
for (const [name, mutate] of [
  ['modified packaged Worker', sample => { write(sample.directory, '.test-tmp/package/artifacts/worker.mjs', 'changed'); }],
  ['modified packaged static file', sample => { write(sample.directory, '.test-tmp/package/artifacts/assets/index.html', 'changed'); }],
  ['missing packaged static file', sample => { fs.unlinkSync(path.join(sample.directory, '.test-tmp/package/artifacts/assets/index.html')); }],
  ['extra packaged static file', sample => { write(sample.directory, '.test-tmp/package/artifacts/assets/extra.js', 'extra'); }],
  ['extra package Worker module', sample => { write(sample.directory, '.test-tmp/package/artifacts/extra.mjs', 'extra'); }],
  ['extra package metadata', sample => { write(sample.directory, '.test-tmp/package/unknown.json', '{}'); }],
]) {
  await test(`packaged inventory rejects ${name}`, () => {
    const sample = packageFixture(); mutate(sample); assert.throws(() => verify(sample));
  });
}
await test('candidate/reference self-rehash cannot replace independently reviewed pins', () => {
  const sample = fixture();
  sample.bundle.source.head = '3'.repeat(40);
  const { bundleFingerprint, bundleFingerprintMethod, ...body } = sample.bundle;
  assert.ok(bundleFingerprint && bundleFingerprintMethod);
  sample.bundle.bundleFingerprint = digest(body);
  sample.policy.candidateReference = writeJson(sample.directory, sample.inputPath, sample.bundle);
  assert.throws(() => verify(sample), /CANDIDATE_ID_MISMATCH/);
});
await test('a rebuilt Worker with internally recomputed inventory hashes is not the reviewed candidate', () => {
  const sample = fixture();
  const substituted = write(sample.directory, '.test-tmp/v6-cloudflare-worker/worker.mjs', 'unreviewed-rebuild');
  for (const build of sample.builds) {
    build.artifacts[0].files[0] = { ...substituted, path: 'worker.mjs' };
    build.artifacts[0].fingerprint = domain('manifest').artifactFingerprint(build.artifacts[0]);
  }
  sample.builds.forEach((build, index) => writeJson(sample.directory, `.test-tmp/reviewed/build-${index + 1}.json`, build));
  assert.throws(() => verify(sample), /EVIDENCE_OR_ARTIFACT_HASH_MISMATCH/);
});
await test('symlink/junction roots cannot redirect assets outside the candidate', () => {
  const sample = fixture();
  const other = path.join(sample.directory, 'other'); fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(sample.directory, 'cloudflare/site/out/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verify(sample), /SYMLINK/);
});
await test('symlink/junction parent cannot redirect the handoff', () => {
  const sample = packageFixture();
  fs.symlinkSync(path.join(sample.directory, '.test-tmp/package'), path.join(sample.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  sample.inputPath = 'linked/handoff.json';
  assert.throws(() => verify(sample), /SYMLINK/);
});
await test('output cannot overwrite a package, escape the workspace or overwrite reviewed artifacts', () => {
  const sample = packageFixture(), before = fs.readFileSync(path.join(sample.directory, sample.inputPath));
  for (const output of ['.test-tmp/package', '../outside', 'cloudflare/site/out', '.test-tmp/reviewed', 'C:/outside']) {
    assert.throws(() => prepareCandidate(sample.inputPath, output, sample));
  }
  assert.deepEqual(fs.readFileSync(path.join(sample.directory, sample.inputPath)), before);
});
await test('stale package cannot refresh its review by preparing another copy', () => {
  const sample = packageFixture(); sample.now += sample.policy.localEvidenceMaxAgeMs;
  assert.throws(() => prepareCandidate(sample.inputPath, '.test-tmp/refreshed', sample), /STALE_CANDIDATE_REVIEW/);
  assert.equal(fs.existsSync(path.join(sample.directory, '.test-tmp/refreshed')), false);
});
await test('verification is the default and only local modes parse', () => {
  assert.equal(parseLocalArguments(['candidate.json']).mode, 'verify');
  assert.equal(parseLocalArguments(['prepare', 'candidate.json', '.test-tmp/output']).mode, 'prepare');
  for (const args of [[], ['verify'], ['prepare', 'candidate.json'], ['verify', 'candidate.json', '--force'],
    ['verify', 'candidate.json', '--authorize-deploy'], ['upload_inactive', 'candidate.json'], ['promote', 'candidate.json'],
    ['verify_remote_version', 'candidate.json'], ['deploy', 'candidate.json'], ['--policy', 'unreviewed.json']]) {
    assert.throws(() => parseLocalArguments(args));
  }
});
await test('missing certification fails closed despite valid candidate', () => {
  const handoff = verify(fixture()).handoff, gate = futurePhaseReadiness(handoff, 'UPLOAD_INACTIVE');
  assert.equal(handoff.authority.productionCertification, null);
  assert.equal(gate.allowed, false); assert.equal(gate.mutationAllowed, false);
  assert.ok(gate.blockers.includes('PRODUCTION_CERTIFICATION_REQUIRED'));
});
await test('missing explicit deployment authorization fails closed independently', () => {
  const handoff = verify(fixture()).handoff;
  handoff.authority.productionCertification = { status: 'PASS' };
  const gate = futurePhaseReadiness(handoff, 'UPLOAD_INACTIVE');
  assert.equal(gate.allowed, false);
  assert.ok(gate.blockers.includes('EXPLICIT_DEPLOYMENT_AUTHORIZATION_REQUIRED'));
  assert.ok(gate.blockers.includes('CERTIFICATION_NOT_AUTHENTICATED'));
});
await test('upload authorization never grants promotion, rollback or runtime activation', () => {
  const handoff = verify(fixture()).handoff;
  handoff.authority.deploymentAuthorization = true;
  const gate = futurePhaseReadiness(handoff, 'PROMOTE');
  assert.equal(gate.allowed, false); assert.equal(gate.runtimeActivationAuthorized, false);
  for (const blocker of ['REMOTE_VERSION_UNVERIFIED', 'ROLLBACK_UNVERIFIED', 'SEPARATE_PROMOTION_AUTHORIZATION_REQUIRED']) {
    assert.ok(gate.blockers.includes(blocker));
  }
  assert.equal(handoff.rollback.previousCompatibleRelease, null);
  assert.equal(handoff.rollback.workerVersionId, null);
  assert.equal(handoff.rollback.staticVersionId, null);
  assert.equal(handoff.rollback.deploymentId, null);
});
await test('even affirmative certification and authorization cannot unblock any remote phase', () => {
  const handoff = verify(fixture()).handoff;
  handoff.authority.productionCertification = { status: 'PASS' };
  handoff.authority.deploymentAuthorization = { authorized: true };
  handoff.authority.promotionAuthorization = { authorized: true };
  for (const phase of ['UPLOAD_INACTIVE', 'VERIFY_REMOTE_VERSION', 'PROMOTE']) {
    const gate = futurePhaseReadiness(handoff, phase);
    assert.equal(gate.allowed, false); assert.equal(gate.mutationAllowed, false);
    assert.ok(gate.blockers.includes('REMOTE_IMPLEMENTATION_ABSENT'));
    assert.ok(gate.blockers.includes('DEPLOYMENT_AUTHORIZATION_NOT_AUTHENTICATED'));
  }
});
await test('environment approval flags are neither read nor persisted', () => {
  const names = ['SANDEAL_DEPLOY_AUTHORIZED', 'CLOUDFLARE_API_TOKEN', 'BASIC_AUTH_PASSWORD'];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = 'synthetic-test-only';
    const handoff = verify(fixture()).handoff;
    assert.equal(handoff.authority.deploymentAuthorized, false);
    assert.equal(JSON.stringify(handoff).includes('synthetic-test-only'), false);
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});
await test('tracked review pins agree with the non-secret production contract', () => {
  const policy = readReviewPolicy(), contract = JSON.parse(fs.readFileSync(path.join(root, 'config/cloudflare/production.contract.json'), 'utf8'));
  assert.equal(policy.target.accountId, contract.resources.accountId.value);
  assert.equal(policy.target.workerName, contract.resources.workerName.value);
  assert.equal(contract.deployable, false); assert.equal(contract.productionExecutionEnabled, false);
  assert.equal(contract.worker.productionMutationExecutor, 'ABSENT');
  assert.throws(() => validateCheckout(policy, { head: '0'.repeat(40) }));
});
await test('driver has no deploy SDK, network, build, signing or mutation executor', () => {
  const driver = fs.readFileSync(path.join(root, 'scripts/phase-10-exact-candidate.mjs'), 'utf8');
  assert.doesNotMatch(driver, /\b(?:fetch|spawnSync|spawn|buildWorker|buildSite|generateReference|sign|generateKeyPairSync)\s*\(/);
  assert.doesNotMatch(driver, /(?:from|import\()\s*['"](?:wrangler|https?|node:https?|net|node:net)/);
  assert.equal((driver.match(/execFileSync\(/g) ?? []).length, 1);
  assert.match(driver, /execFileSync\('git', \['--no-optional-locks'/);
});
await test('CLI rejects missing inputs without reflecting secret-shaped input', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP)$/i.test(name)));
  const result = spawnSync(process.execPath, ['scripts/phase-10-exact-candidate.mjs', 'synthetic-test-only'],
    { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GATE2_HANDOFF_FAILED/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-test-only/);
});
const production = load('../../src/lib/execution-control-plane/production.ts');
const { productionFetch } = load('../../src/lib/runtime/cloudflare/production.ts');
for (const absentRecord of ['release_bundles', 'execution_controls']) {
  await test(`existing runtime stays fail-closed with absent ${absentRecord}, without D1 or signing`, async () => {
    const identity = { head: '1'.repeat(40), candidateFingerprint: sha256('synthetic-candidate'), workerFingerprint: sha256('synthetic-worker'),
      staticFingerprint: sha256('synthetic-static'), environment: 'PRODUCTION', configFingerprint: sha256('synthetic-config'),
      targets: { accountId: '1'.repeat(32), workerName: 'synthetic-worker', staticTarget: 'synthetic-worker',
        databaseId: '11111111-1111-1111-1111-111111111111', queueName: 'synthetic-queue', domain: 'synthetic.invalid', route: 'synthetic.invalid/*' },
      migrations: migrationFiles().map(file => ({ name: file.name, sha256: sha256(file.sql) })),
      capabilities: ['READ_PRODUCTION_HEALTH'], secretReferences: [...production.PRODUCTION_SECRET_REFERENCES].sort() };
    assert.equal(production.validProductionIdentity(identity), true);
    const bundle = { schema: 'sandeal-production-release-v1', identity,
      requirements: Object.fromEntries(production.PRODUCTION_REQUIREMENTS.map(name => [name, null])) };
    const queries = [], effects = { writes: 0, assets: 0, queue: 0 };
    const env = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'false', SANDEAL_PRODUCTION: 'true',
      SANDEAL_PRODUCTION_EXECUTION_ENABLED: 'true', SHOPEE_AFFILIATE_ENABLED: 'false', SANDEAL_AUTOPILOT_ENABLED: 'false',
      SANDEAL_MONEY_ENGINE_ENABLED: 'false', SANDEAL_DEAL_INTELLIGENCE_ENABLED: 'false', SANDEAL_DECISION_OS_ENABLED: 'false',
      SANDEAL_OPPORTUNITY_ENABLED: 'false', SANDEAL_CONTENT_LIFECYCLE_ENABLED: 'false',
      SANDEAL_PRODUCTION_IDENTITY: JSON.stringify(identity), SANDEAL_PRODUCTION_BUNDLE_FINGERPRINT: executionFingerprint(bundle),
      SANDEAL_PRODUCTION_APPROVAL_KEYS: '[]',
      DB: { async batch() { effects.writes++; throw new Error('FORBIDDEN'); }, prepare(sql) {
        assert.match(sql, /^SELECT /); queries.push(sql);
        return { bind() { return this; }, async all() {
          return { success: true, results: absentRecord === 'execution_controls' && sql.includes('release_bundles')
            ? [{ payload: JSON.stringify({ bundle, approval: null }) }] : [] };
        } };
      } }, ASSETS: { async fetch() { effects.assets++; throw new Error('FORBIDDEN'); } },
      JOB_QUEUE: { async send() { effects.queue++; throw new Error('FORBIDDEN'); } } };
    const response = await productionFetch(new Request('https://synthetic.invalid/api/health/ready'), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'PRODUCTION_EXECUTION_BLOCKED');
    assert.deepEqual(effects, { writes: 0, assets: 0, queue: 0 });
    assert.ok(queries.some(sql => sql.includes(absentRecord)));
    const handoff = verify(fixture()).handoff;
    assert.equal(production.validProductionIdentity(handoff), false);
    assert.equal(handoff.runtime.absentRecords, 'FAIL_CLOSED');
    assert.equal(handoff.authority.runtimeActivationAuthorized, false);
  });
}
console.log(`Gate 2 exact candidate: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
