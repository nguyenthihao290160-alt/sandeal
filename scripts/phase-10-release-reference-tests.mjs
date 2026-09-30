import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, domain, load } from './lib/release-rehearsal.mjs';
import { canonicalJson, sha256 } from './lib/d1-schema-canonical.mjs';
import { operationalNames, captureSource, validateInputs, validateConfiguration, validateBuildPair, createReference, fileReference } from './phase-10-release-reference.mjs';

let passed = 0, failed = 0;
function test(name, work) {
  try { work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
function fixture() {
  const input = { schema: 'sandeal-phase10-release-reference-input-v1', expectedHead: '1'.repeat(40), expectedBranch: 'master', allowDirtySource: true,
    origin: 'https://synthetic.sandeal.tech', originSource: 'USER_SELECTED_APPLICATION_ORIGIN', configPath: 'wrangler.bootstrap.toml',
    target: { accountId: '1'.repeat(32), workerName: 'synthetic-worker', databaseId: '11111111-1111-1111-1111-111111111111',
      databaseName: 'synthetic-database', queueName: 'synthetic-queue', queueId: '2'.repeat(32) },
    routing: { domain: 'synthetic.sandeal.tech', domainState: 'USER_SELECTED_NOT_LIVE_VERIFIED', route: null, routeState: 'UNKNOWN', assetsRemoteState: 'UNKNOWN' },
    operations: Object.fromEntries(operationalNames.map(name => [name, 'UNKNOWN'])), evidencePaths: ['config/cloudflare/production.contract.json'] };
  const files = [{ path: 'synthetic.js', sha256: sha256('synthetic-source'), bytes: 16 }];
  const source = { head: input.expectedHead, branch: input.expectedBranch, gitTree: '2'.repeat(40),
    worktreeClean: false, indexClean: true, fingerprint: sha256(canonicalJson(files)), files };
  const artifacts = ['WORKER', 'STATIC'].map(kind => {
    const artifact = { kind, files: [{ path: kind === 'WORKER' ? 'worker.mjs' : 'index.html', sha256: sha256(kind), bytes: kind.length }] };
    return { ...artifact, fingerprint: domain('manifest').artifactFingerprint(artifact) };
  });
  const build = { exit: 0, sourceHead: source.head, sourceFingerprint: source.fingerprint, cleanBuild: true,
    buildId: source.head, nextBuildId: 'opaque-next-internal-id', environment: 'PRODUCTION', origin: input.origin, artifacts,
    toolchain: { node: process.version, platform: process.platform, arch: process.arch, next: 'synthetic', esbuild: 'synthetic', wrangler: 'synthetic' } };
  const config = { name: input.target.workerName, main: path.join(root, '.test-tmp/v6-cloudflare-worker/worker.mjs'),
    d1_databases: [{ binding: 'DB', database_id: input.target.databaseId, database_name: input.target.databaseName }],
    queues: { producers: [{ binding: 'JOB_QUEUE', queue: input.target.queueName }], consumers: [] }, triggers: { crons: [] },
    assets: { directory: 'cloudflare/site/out', binding: 'ASSETS', run_worker_first: true }, routes: [], vars: {} };
  return { input, source, config, builds: [build, structuredClone(build)] };
}
const make = fixture => createReference(fixture.input, fixture.source, validateConfiguration(fixture.input, fixture.config), fixture.builds, []);
test('current checkout inventory includes authentication source but no ignored artifacts', () => {
  const source = captureSource();
  assert.ok(source.files.some(file => file.path === 'src/lib/auth.ts'));
  assert.ok(source.files.every(file => !file.path.startsWith('.test-tmp/') && !file.path.startsWith('node_modules/')));
  assert.equal(source.fingerprint, sha256(canonicalJson(source.files)));
});
test('reference binds current inputs, not remote historical versions or authority', () => {
  const sample = fixture(), bundle = make(sample);
  assert.equal(bundle.source.head, sample.input.expectedHead); assert.equal(bundle.target.workerName, sample.input.target.workerName);
  assert.equal(bundle.executable, false); assert.equal(bundle.approval, null); assert.equal(bundle.productionMutationMode, 'BLOCKED');
  assert.equal(bundle.artifacts.static.productionCertified, false); assert.equal(bundle.artifacts.static.productionProvenanceVerified, false);
  assert.equal(bundle.artifacts.static.productionReleaseFingerprint, null); assert.equal(bundle.artifacts.static.localBuildProvenanceVerified, true);
  assert.equal(bundle.activeProductionBaseline, null); assert.equal(bundle.nonDeployedSecretVersion, null);
  assert.equal(bundle.configuration.ASSETS.state, 'PRESENT_LOCAL_CONFIG_ONLY');
  assert.ok(bundle.blockers.includes('UNCOMMITTED_SOURCE_REQUIRES_CLEAN_COMMIT_REBUILD_AND_REBIND'));
  assert.ok(Object.values(bundle.effects).every(value => value === 0));
  assert.equal(load('../../src/lib/execution-control-plane/production.ts').validProductionIdentity(bundle), false);
});
test('canonical bundle fingerprint is reproducible and binds changed candidate input', () => {
  const sample = fixture(), bundle = make(sample), { bundleFingerprint, bundleFingerprintMethod, ...body } = bundle;
  assert.ok(bundleFingerprintMethod.includes('canonicalJson')); assert.equal(bundleFingerprint, sha256(canonicalJson(body)));
  assert.equal(make(sample).bundleFingerprint, bundleFingerprint);
  sample.input.operations.changeWindow = 'BLOCKED'; assert.notEqual(make(sample).bundleFingerprint, bundleFingerprint);
});
test('another current source HEAD can be bound without editing the generator', () => {
  const sample = fixture(), previous = make(sample).bundleFingerprint;
  sample.input.expectedHead = '3'.repeat(40); sample.source.head = sample.input.expectedHead;
  for (const build of sample.builds) { build.sourceHead = sample.source.head; build.buildId = sample.source.head; }
  assert.equal(make(sample).source.head, sample.source.head); assert.notEqual(make(sample).bundleFingerprint, previous);
});
for (const [name, mutate] of [
  ['missing identity', sample => { delete sample.input.expectedHead; }],
  ['missing account', sample => { sample.input.target.accountId = null; }],
  ['placeholder account', sample => { sample.input.target.accountId = '0'.repeat(32); }],
  ['placeholder database', sample => { sample.input.target.databaseId = '00000000-0000-0000-0000-000000000000'; }],
  ['missing queue', sample => { delete sample.input.target.queueName; }],
  ['missing origin decision', sample => { delete sample.input.originSource; }],
  ['missing production origin', sample => { delete sample.input.origin; }],
  ['rehearsal origin', sample => { sample.input.origin = 'https://synthetic.invalid'; }],
  ['domain conflict', sample => { sample.input.routing.domain = 'different.sandeal.tech'; }],
  ['route conflict', sample => { sample.input.routing.route = 'different.sandeal.tech/*'; }],
  ['unverified remote promoted', sample => { sample.input.routing.assetsRemoteState = 'VERIFIED'; }],
  ['missing operational state', sample => { delete sample.input.operations.changeWindow; }],
  ['manufactured operational proof', sample => { sample.input.operations.changeWindow = 'VERIFIED'; }],
  ['approval supplied', sample => { sample.input.approval = { status: 'APPROVED' }; }],
  ['executable supplied', sample => { sample.input.executable = true; }],
  ['credential supplied', sample => { sample.input.privateKey = 'synthetic-test-only'; }],
  ['secret reference path', sample => { sample.input.evidencePaths = ['.env.local']; }],
  ['parent traversal', sample => { sample.input.evidencePaths = ['../outside.json']; }],
  ['absolute path', sample => { sample.input.evidencePaths = ['C:/outside.json']; }],
  ['wrong source HEAD', sample => { sample.source.head = '4'.repeat(40); }],
  ['wrong source branch', sample => { sample.source.branch = 'other'; }],
  ['dirty source not acknowledged', sample => { sample.input.allowDirtySource = false; }],
  ['staged source', sample => { sample.source.indexClean = false; }],
  ['incorrect source fingerprint', sample => { sample.source.fingerprint = '5'.repeat(64); }],
  ['missing ASSETS', sample => { delete sample.config.assets; }],
  ['partial worker-first routing', sample => { sample.config.assets.run_worker_first = ['/api/*']; }],
  ['wrong ASSETS directory', sample => { sample.config.assets.directory = 'public'; }],
  ['wrong DB', sample => { sample.config.d1_databases[0].database_id = '22222222-2222-2222-2222-222222222222'; }],
  ['wrong Queue', sample => { sample.config.queues.producers[0].queue = 'other'; }],
  ['enabled Queue consumer', sample => { sample.config.queues.consumers.push({ queue: 'synthetic-queue' }); }],
  ['enabled Cron', sample => { sample.config.triggers.crons.push('* * * * *'); }],
  ['enabled execution', sample => { sample.config.vars.SANDEAL_PRODUCTION_EXECUTION_ENABLED = 'true'; }],
  ['missing second build', sample => { sample.builds.pop(); }],
  ['failed build', sample => { sample.builds[0].exit = 1; }],
  ['unbound build source', sample => { sample.builds[0].sourceFingerprint = '6'.repeat(64); }],
  ['placeholder build ID', sample => { sample.builds[0].buildId = 'missing-release-id'; }],
  ['missing internal build ID', sample => { delete sample.builds[0].nextBuildId; }],
  ['local environment', sample => { sample.builds[0].environment = 'LOCAL'; }],
  ['rehearsal environment', sample => { sample.builds[0].environment = 'PRODUCTION_REHEARSAL'; }],
  ['wrong build origin', sample => { sample.builds[0].origin = 'https://other.sandeal.tech'; }],
  ['warm cache build', sample => { sample.builds[0].cleanBuild = false; }],
  ['missing toolchain', sample => { delete sample.builds[0].toolchain; }],
  ['changed toolchain', sample => { sample.builds[0].toolchain.node = 'different'; }],
  ['empty inventory', sample => { sample.builds[0].artifacts[1].files = []; }],
  ['tampered artifact fingerprint', sample => { sample.builds[0].artifacts[1].fingerprint = '7'.repeat(64); }],
]) {
  test(`fail closed: ${name}`, () => { const sample = fixture(); mutate(sample); assert.throws(() => make(sample)); });
}
test('different static bytes stop finalization even with internally valid hashes', () => {
  const sample = fixture(), site = sample.builds[1].artifacts[1];
  site.files[0].sha256 = sha256('other-output'); site.fingerprint = domain('manifest').artifactFingerprint(site);
  assert.throws(() => validateBuildPair(sample.input, sample.source, sample.builds), /NONDETERMINISTIC_BUILD_STOP/);
});
test('missing referenced file fails closed', () => assert.throws(() => fileReference('.test-tmp/phase10-nonexistent-reference.json')));
test('Next dynamic-segment dollar filenames are valid artifact references', () => {
  const directory = '.test-tmp/phase10-reference-path-tests';
  fs.mkdirSync(path.join(root, directory), { recursive: true });
  const file = `${directory}/$segment.txt`;
  fs.writeFileSync(path.join(root, file), 'synthetic-artifact');
  assert.equal(fileReference(file).sha256, sha256('synthetic-artifact'));
});
test('CLI rejects durable output, unknown modes and deployment arguments without effects', () => {
  const durable = ['docs/v6/evidence/phase10-production-release-bundle.json', 'docs/v6/evidence/phase10-production-release-bundle-verification.json'];
  const before = durable.map(fileReference);
  for (const args of [['deploy'], ['verify', 'docs/v6/evidence'], ['verify', '.test-tmp/unused', '--deploy']]) {
    const result = spawnSync(process.execPath, ['scripts/phase-10-release-reference.mjs', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /PHASE10_REFERENCE_FAILED/);
  }
  assert.deepEqual(durable.map(fileReference), before);
});
test('generator source has no historical immutable identities or bundle fingerprint', () => {
  const historical = JSON.parse(fs.readFileSync(path.join(root, 'docs/v6/evidence/phase10-production-release-bundle.json'), 'utf8'));
  const text = fs.readFileSync(path.join(root, 'scripts/phase-10-release-reference.mjs'), 'utf8');
  for (const value of [historical.source.head, historical.activeProductionBaseline.id, historical.nonDeployedSecretVersion.id, historical.bundleFingerprint]) {
    assert.ok(value); assert.equal(text.includes(value), false);
  }
  assert.equal(validateInputs(fixture().input).schema, 'sandeal-phase10-release-reference-input-v1');
});
console.log(`Phase 10 release reference: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
