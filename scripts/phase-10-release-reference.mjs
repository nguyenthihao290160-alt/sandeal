import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { load, root, artifactFiles, domain } from './lib/release-rehearsal.mjs';
import { canonicalJson, sha256, compareText } from './lib/d1-schema-canonical.mjs';

export const operationalNames = [...load('../../src/lib/execution-control-plane/production.ts').PRODUCTION_REQUIREMENTS,
  'killSwitch', 'emergencyStop', 'approvalTrust', 'abortOwnership', 'executionEnablement', 'queueConsumer', 'cron'];
const digest = value => sha256(canonicalJson(value));
const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trimEnd();
const hashPattern = /^[a-f0-9]{64}$/;
const bundleName = 'phase10-production-release-bundle.json';
const verificationName = 'phase10-production-release-bundle-verification.json';
const fingerprintMethod = 'SHA-256 of canonicalJson(bundle excluding bundleFingerprint and bundleFingerprintMethod); sorted object keys, ordered arrays, UTF-8, one LF';

function exactKeys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...names].sort().join(','), 'REFERENCE_INPUT_FIELDS_INVALID');
}
function safePath(relative) {
  assert.ok(typeof relative === 'string' && /^[a-zA-Z0-9_.$/@()[\]-]{1,240}$/.test(relative)
    && !path.isAbsolute(relative) && !relative.split('/').some(part => ['', '.', '..', '.git'].includes(part))
    && !/(^|\/)(?:\.env(?!\.example$)|credentials\.json$|auth\.json$)|\.(?:key|pem|p12|pfx)$/i.test(relative), 'REFERENCE_PATH_INVALID');
  const absolute = path.resolve(root, relative);
  assert.ok(absolute.startsWith(`${root}${path.sep}`), 'REFERENCE_PATH_OUTSIDE_REPOSITORY');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'REFERENCE_SYMLINK_FORBIDDEN');
  }
  return absolute;
}
export function fileReference(relative) {
  const absolute = safePath(relative);
  assert.ok(fs.lstatSync(absolute).isFile(), 'REFERENCE_REGULAR_FILE_REQUIRED');
  const bytes = fs.readFileSync(absolute);
  return { path: relative, sha256: sha256(bytes), bytes: bytes.length };
}
const readJson = relative => JSON.parse(fs.readFileSync(safePath(relative), 'utf8').replace(/^\uFEFF/, ''));
function writeJson(relative, value) {
  const serialized = JSON.stringify(value, null, 2);
  assert.ok(!/"(?:oauth_token|refresh_token|authorization|accessToken|apiBearer|authFile|privateKey|signature)"\s*:/i.test(serialized), 'CREDENTIAL_FIELD_FORBIDDEN');
  assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(serialized), 'PRIVATE_KEY_FORBIDDEN');
  fs.writeFileSync(safePath(relative), `${serialized}\n`, { flag: 'wx' });
  return fileReference(relative);
}
function ignoredDirectory(relative) {
  const absolute = safePath(relative);
  assert.ok(relative.startsWith('.test-tmp/') && relative.split('/').length === 2, 'NEW_IGNORED_OUTPUT_REQUIRED');
  assert.equal(git('check-ignore', '--', `${relative}/probe.json`).replaceAll('\\', '/'), `${relative}/probe.json`, 'OUTPUT_MUST_BE_IGNORED');
  return absolute;
}
export function captureSource() {
  const names = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort(compareText);
  assert.ok(names.length > 0 && names.length <= 5000, 'SOURCE_INVENTORY_BOUND');
  const files = names.map(name => fs.existsSync(safePath(name)) ? fileReference(name) : { path: name, deleted: true });
  return { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), gitTree: git('rev-parse', 'HEAD^{tree}'),
    worktreeClean: git('status', '--porcelain=v1', '--untracked-files=all') === '', indexClean: git('diff', '--cached', '--name-only') === '',
    fingerprint: digest(files), fingerprintMethod: 'SHA-256 canonicalJson of sorted tracked and nonignored untracked checkout file references, including deletions', files };
}
export function validateInputs(input) {
  exactKeys(input, ['schema', 'expectedHead', 'expectedBranch', 'allowDirtySource', 'origin', 'originSource', 'configPath', 'target', 'routing', 'operations', 'evidencePaths']);
  assert.equal(input.schema, 'sandeal-phase10-release-reference-input-v1', 'INPUT_SCHEMA_INVALID');
  assert.match(input.expectedHead, /^[a-f0-9]{40}$/, 'EXPECTED_HEAD_REQUIRED');
  assert.ok(typeof input.expectedBranch === 'string' && /^[a-zA-Z0-9_./-]{1,120}$/.test(input.expectedBranch), 'EXPECTED_BRANCH_REQUIRED');
  assert.equal(typeof input.allowDirtySource, 'boolean', 'DIRTY_SOURCE_DECISION_REQUIRED');
  load('../v6-cloudflare-build.cjs').siteBuildEnvironment({ environment: 'PRODUCTION', origin: input.origin });
  assert.ok(['USER_SELECTED_APPLICATION_ORIGIN', 'REVIEWED_REPOSITORY_CONTRACT'].includes(input.originSource), 'ORIGIN_DECISION_REQUIRED');
  safePath(input.configPath);
  exactKeys(input.target, ['accountId', 'workerName', 'databaseId', 'databaseName', 'queueName', 'queueId']);
  for (const value of Object.values(input.target)) assert.ok(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value), 'TARGET_REFERENCE_REQUIRED');
  for (const name of ['accountId', 'queueId']) assert.ok(/^[a-f0-9]{32}$/.test(input.target[name]) && !/^0+$/.test(input.target[name]), 'TARGET_IDENTIFIER_INVALID');
  assert.match(input.target.databaseId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, 'DATABASE_REFERENCE_INVALID');
  assert.ok(!/^0+(?:-0+)+$/.test(input.target.databaseId), 'DATABASE_PLACEHOLDER_FORBIDDEN');
  exactKeys(input.routing, ['domain', 'domainState', 'route', 'routeState', 'assetsRemoteState']);
  assert.equal(input.routing.domain, new URL(input.origin).hostname, 'DOMAIN_ORIGIN_MISMATCH');
  assert.ok(['USER_SELECTED_NOT_LIVE_VERIFIED', 'REFERENCE_ONLY'].includes(input.routing.domainState), 'DOMAIN_STATE_INVALID');
  assert.ok(input.routing.route === null || input.routing.route === `${input.routing.domain}/*`, 'ROUTE_SCOPE_INVALID');
  for (const name of ['routeState', 'assetsRemoteState']) assert.ok(['UNKNOWN', 'NOT_CONFIGURED', 'REFERENCE_ONLY'].includes(input.routing[name]), 'REMOTE_STATE_CANNOT_CERTIFY');
  exactKeys(input.operations, operationalNames);
  for (const value of Object.values(input.operations)) assert.ok(['UNKNOWN', 'BLOCKED', 'REFERENCE_ONLY'].includes(value), 'OPERATIONAL_PROOF_CANNOT_BE_PROMOTED');
  assert.ok(Array.isArray(input.evidencePaths) && input.evidencePaths.length > 0 && input.evidencePaths.length <= 30
    && new Set(input.evidencePaths).size === input.evidencePaths.length, 'EVIDENCE_REFERENCES_REQUIRED');
  input.evidencePaths.forEach(safePath);
  return input;
}
export function validateConfiguration(input, config) {
  assert.equal(config.name, input.target.workerName, 'WORKER_NAME_MISMATCH');
  if (config.account_id) assert.equal(config.account_id, input.target.accountId, 'ACCOUNT_REFERENCE_MISMATCH');
  assert.equal(path.resolve(config.main), safePath('.test-tmp/v6-cloudflare-worker/worker.mjs'), 'WORKER_PATH_MISMATCH');
  const databases = config.d1_databases.filter(binding => binding.binding === 'DB');
  const queues = config.queues.producers.filter(binding => binding.binding === 'JOB_QUEUE');
  assert.equal(databases.length, 1, 'DB_BINDING_REQUIRED'); assert.equal(queues.length, 1, 'QUEUE_BINDING_REQUIRED');
  assert.equal(databases[0].database_id, input.target.databaseId, 'DATABASE_REFERENCE_MISMATCH');
  assert.equal(databases[0].database_name, input.target.databaseName, 'DATABASE_NAME_MISMATCH');
  assert.equal(queues[0].queue, input.target.queueName, 'QUEUE_REFERENCE_MISMATCH');
  assert.equal(config.assets?.binding, 'ASSETS', 'ASSETS_BINDING_REQUIRED');
  assert.equal(path.resolve(root, config.assets.directory), safePath('cloudflare/site/out'), 'ASSETS_DIRECTORY_MISMATCH');
  assert.equal(config.assets.run_worker_first, true, 'ALL_REQUESTS_WORKER_FIRST_REQUIRED');
  assert.ok(!config.queues.consumers?.length && !config.triggers?.crons?.length, 'QUEUE_CRON_MUST_STAY_DISABLED');
  assert.ok(!config.vars?.SANDEAL_PRODUCTION_EXECUTION_ENABLED || config.vars.SANDEAL_PRODUCTION_EXECUTION_ENABLED === 'false', 'EXECUTION_MUST_STAY_DISABLED');
  const routes = [...(config.routes ?? []), ...(config.route ? [config.route] : [])];
  assert.ok(routes.every(route => (typeof route === 'string' ? route : route.pattern) === input.routing.route), 'CONFIGURED_ROUTE_MISMATCH');
  return { reference: fileReference(input.configPath), workerName: config.name, accountReferenceInConfig: config.account_id ?? null,
    DB: { binding: 'DB', id: databases[0].database_id, name: databases[0].database_name },
    JOB_QUEUE: { binding: 'JOB_QUEUE', name: queues[0].queue },
    ASSETS: { binding: 'ASSETS', directory: 'cloudflare/site/out', runWorkerFirst: true, state: 'PRESENT_LOCAL_CONFIG_ONLY' },
    routes: routes.map(route => typeof route === 'string' ? { pattern: route, customDomain: false }
      : { pattern: route.pattern, customDomain: route.custom_domain === true }), queueConsumers: 0, crons: 0, executionEnabled: false };
}
function configuration(input) {
  return validateConfiguration(input, load('wrangler').unstable_readConfig({ config: safePath(input.configPath) }, { hideWarnings: true }));
}
function assertSource(input, source) {
  assert.equal(source.head, input.expectedHead, 'CURRENT_HEAD_MISMATCH');
  assert.equal(source.branch, input.expectedBranch, 'CURRENT_BRANCH_MISMATCH');
  assert.equal(source.indexClean, true, 'INDEX_MUST_BE_CLEAN');
  assert.ok(source.worktreeClean || input.allowDirtySource, 'DIRTY_SOURCE_NOT_ACKNOWLEDGED');
  assert.equal(source.fingerprint, digest(source.files), 'SOURCE_FINGERPRINT_INVALID');
}
function artifacts() {
  return [{ kind: 'WORKER', files: [{ ...fileReference('.test-tmp/v6-cloudflare-worker/worker.mjs'), path: 'worker.mjs' }] },
    { kind: 'STATIC', files: artifactFiles(safePath('cloudflare/site/out')) }]
    .map(artifact => ({ ...artifact, fingerprint: domain('manifest').artifactFingerprint(artifact) }));
}
function toolchain() {
  return { node: process.version, platform: process.platform, arch: process.arch,
    next: load('next/package.json').version, esbuild: load('esbuild/package.json').version, wrangler: load('wrangler/package.json').version };
}
export function validateBuildPair(input, source, builds) {
  assert.equal(builds.length, 2, 'TWO_BUILDS_REQUIRED');
  for (const report of builds) {
    assert.equal(report.exit, 0, 'BUILD_FAILED'); assert.equal(report.sourceHead, source.head, 'BUILD_HEAD_MISMATCH');
    assert.equal(report.sourceFingerprint, source.fingerprint, 'BUILD_SOURCE_MISMATCH');
    assert.equal(report.buildId, source.head, 'STATIC_BUILD_ID_MISMATCH');
    assert.ok(typeof report.nextBuildId === 'string' && report.nextBuildId.length > 0 && report.nextBuildId !== 'missing-release-id', 'NEXT_INTERNAL_BUILD_ID_MISSING');
    assert.equal(report.environment, 'PRODUCTION', 'STATIC_ENVIRONMENT_MISMATCH');
    assert.equal(report.origin, input.origin, 'STATIC_ORIGIN_MISMATCH');
    assert.equal(report.cleanBuild, true, 'CLEAN_BUILD_REQUIRED');
    exactKeys(report.toolchain, ['node', 'platform', 'arch', 'next', 'esbuild', 'wrangler']);
    assert.deepEqual(report.artifacts.map(artifact => artifact.kind), ['WORKER', 'STATIC'], 'ARTIFACT_KINDS_INVALID');
    for (const artifact of report.artifacts) {
      assert.ok(artifact.files.length > 0 && artifact.files.every(file => hashPattern.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0), 'ARTIFACT_INVENTORY_INVALID');
      assert.equal(artifact.fingerprint, domain('manifest').artifactFingerprint(artifact), 'ARTIFACT_FINGERPRINT_INVALID');
    }
  }
  assert.deepEqual(builds[0].artifacts, builds[1].artifacts, 'NONDETERMINISTIC_BUILD_STOP');
  assert.deepEqual(builds[0].toolchain, builds[1].toolchain, 'BUILD_TOOLCHAIN_DRIFT');
  assert.equal(builds[0].nextBuildId, builds[1].nextBuildId, 'NEXT_INTERNAL_BUILD_ID_DRIFT');
}
export function createReference(input, source, config, builds, references) {
  validateInputs(input); assertSource(input, source); validateBuildPair(input, source, builds);
  const [worker, site] = builds[1].artifacts;
  const bundle = { schema: 'sandeal-phase10-production-release-reference-v2', status: 'BLOCKED_NOT_A_DEPLOYABLE_PRODUCTION_BUNDLE',
    executable: false, environment: 'PRODUCTION', productionMutationMode: 'BLOCKED', approval: null,
    readyForFinalProductionDeploymentPreauth: false,
    source: { ...source, files: undefined },
    target: { ...input.target, staticTarget: input.target.workerName, origin: input.origin, originSource: input.originSource, ...input.routing },
    configuration: config, activeProductionBaseline: null, nonDeployedSecretVersion: null,
    artifacts: { worker: { fingerprint: worker.fingerprint, moduleSha256: worker.files[0].sha256, remoteVersion: null },
      static: { fingerprint: site.fingerprint, fileCount: site.files.length, buildId: builds[1].buildId, nextBuildId: builds[1].nextBuildId, environment: 'PRODUCTION', origin: input.origin,
        state: 'PRODUCTION_SHAPED', deterministic: true, localBuildProvenanceVerified: true, productionProvenanceVerified: false,
        productionCertified: false, productionReleaseFingerprint: null, productionVersion: null } },
    operationalStates: input.operations,
    blockers: [...(!source.worktreeClean ? ['UNCOMMITTED_SOURCE_REQUIRES_CLEAN_COMMIT_REBUILD_AND_REBIND'] : []),
      'PRODUCTION_PROVENANCE_AND_REMOTE_TARGET_STATE_NOT_REVALIDATED', 'LIVE_DOMAIN_ROUTE_AND_ASSET_VERSION_UNVERIFIED',
      ...operationalNames.map(name => `OPERATIONAL_${name}_${input.operations[name]}`), 'FRESH_HUMAN_DEPLOYMENT_PREAUTH_REQUIRED'],
    evidenceReferences: references,
    authorizationBoundary: { deploymentAuthorized: false, activationAuthorized: false, trafficShiftAuthorized: false,
      additionalSecretWritesAuthorized: false, productionDataWritesAuthorized: false, validRuntimeProductionBundle: false,
      freshApprovalIssued: false, observationIsNotFreshRuntimeProof: true, commitOrRebuildRequiresRevalidation: true },
    effects: { cloudflareDeployments: 0, workerVersionUploads: 0, productionTrafficShift: 0, productionD1Mutations: 0,
      queueMessagesSent: 0, dnsChanges: 0, customDomainChanges: 0, productionSecretWrites: 0, rawSecretOutput: 0, commits: 0, pushes: 0 },
    nextStep: 'Review the local non-executable reference. Rebuild and rebind a clean reviewed commit, validate target-bound operational proofs, and obtain separate fresh deployment preauthorization. STOP.' };
  delete bundle.source.files;
  bundle.bundleFingerprint = digest(bundle); bundle.bundleFingerprintMethod = fingerprintMethod;
  return bundle;
}
function buildOnce(input, source, directory, number) {
  assert.deepEqual(captureSource(), source, 'SOURCE_CHANGED_BEFORE_BUILD');
  const dotenv = fs.readdirSync(safePath('cloudflare/site')).filter(name => /^\.env(?:\.|$)/.test(name));
  assert.equal(dotenv.length, 0, 'STATIC_DOTENV_INPUT_FORBIDDEN');
  for (const relative of ['cloudflare/site/.next', 'cloudflare/site/out']) {
    const absolute = safePath(relative);
    assert.equal(path.dirname(absolute), safePath('cloudflare/site'), 'CLEAN_TARGET_OUTSIDE_STATIC_SITE');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
  const env = load('../v6-cloudflare-build.cjs').siteBuildProcessEnvironment({ environment: 'PRODUCTION', origin: input.origin },
    { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|COMSPEC|NUMBER_OF_PROCESSORS)$/i.test(name))),
      SANDEAL_RELEASE_ID: source.head, GIT_COMMIT_SHA: source.head, NEXT_PUBLIC_SANDEAL_RELEASE_ID: source.head });
  const script = "const builder = require('./scripts/v6-cloudflare-build.cjs'); builder.buildWorker().then(() => builder.buildSite(JSON.parse(process.argv[1]))).catch(() => { console.error('REFERENCE_BUILD_FAILED'); process.exitCode = 1; });";
  const result = spawnSync(process.execPath, ['-e', script, JSON.stringify({ environment: 'PRODUCTION', origin: input.origin })],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 600000, maxBuffer: 24 * 1024 * 1024 });
  const log = `${directory}/build-${number}.log`;
  fs.writeFileSync(safePath(log), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' });
  assert.equal(result.status, 0, 'REFERENCE_BUILD_FAILED_SEE_LOCAL_LOG');
  assert.deepEqual(captureSource(), source, 'SOURCE_CHANGED_DURING_BUILD');
  const exported = artifacts();
  for (const required of ['index.html', '404.html', 'product/index.html', '_headers']) assert.ok(exported[1].files.some(file => file.path === required), 'STATIC_REQUIRED_FILE_MISSING');
  const texts = exported[1].files.filter(file => /\.(?:html|js|txt)$/.test(file.path)).map(file => fs.readFileSync(safePath(`cloudflare/site/out/${file.path}`), 'utf8'));
  assert.ok(texts.some(text => text.includes(input.origin)), 'BUILT_ORIGIN_MISSING');
  assert.ok(texts.some(text => text.includes(source.head)), 'BUILT_RELEASE_ID_MISSING');
  const html = fs.readFileSync(safePath('cloudflare/site/out/index.html'), 'utf8');
  assert.match(html, /name="sandeal-environment" content="PRODUCTION"/, 'BUILT_ENVIRONMENT_MISSING');
  assert.ok(texts.every(text => !text.includes('missing-release-id') && !text.includes('production-contract.invalid')), 'PLACEHOLDER_STATIC_PROVENANCE');
  assert.match(fs.readFileSync(safePath('cloudflare/site/out/_headers'), 'utf8'), /noindex, nofollow/, 'NOINDEX_POLICY_MISSING');
  const identity = load('../v6-cloudflare-build.cjs').siteBuildIdentity();
  assert.equal(identity.buildId, source.head, 'STATIC_BUILT_RELEASE_MISMATCH');
  assert.equal(identity.environment, 'PRODUCTION', 'STATIC_BUILT_ENVIRONMENT_MISMATCH');
  assert.equal(identity.origin, input.origin, 'STATIC_BUILT_ORIGIN_MISMATCH');
  const report = { exit: 0, sourceHead: source.head, sourceFingerprint: source.fingerprint, cleanBuild: true, ...identity, toolchain: toolchain(),
    log: fileReference(log), artifacts: exported };
  writeJson(`${directory}/build-${number}.json`, report);
  console.log(`STATIC_BUILD_${number}=PASS ID=${report.buildId} FINGERPRINT=${exported[1].fingerprint}`);
  return report;
}
export function verifyReference(directory) {
  ignoredDirectory(directory);
  const input = validateInputs(readJson(`${directory}/inputs.json`)), source = readJson(`${directory}/source-inventory.json`);
  const bundle = readJson(`${directory}/${bundleName}`), builds = [1, 2].map(number => readJson(`${directory}/build-${number}.json`));
  assert.deepEqual(captureSource(), source, 'CURRENT_SOURCE_DRIFT');
  assert.deepEqual(artifacts(), builds[1].artifacts, 'CURRENT_ARTIFACT_DRIFT');
  assert.deepEqual(toolchain(), builds[1].toolchain, 'CURRENT_TOOLCHAIN_DRIFT');
  const identity = load('../v6-cloudflare-build.cjs').siteBuildIdentity();
  for (const [key, value] of Object.entries(identity)) assert.equal(value, builds[1][key], 'CURRENT_STATIC_IDENTITY_DRIFT');
  assert.deepEqual(bundle.evidenceReferences.map(reference => reference.path), [...input.evidencePaths,
    `${directory}/inputs.json`, `${directory}/source-inventory.json`, `${directory}/build-1.json`, `${directory}/build-2.json`, input.configPath], 'EVIDENCE_REFERENCES_INCOMPLETE');
  for (const reference of bundle.evidenceReferences) assert.deepEqual(fileReference(reference.path), reference, 'EVIDENCE_REFERENCE_DRIFT');
  for (const report of builds) assert.deepEqual(fileReference(report.log.path), report.log, 'BUILD_LOG_DRIFT');
  assert.deepEqual(bundle, createReference(input, source, configuration(input), builds, bundle.evidenceReferences), 'REFERENCE_BUNDLE_INVALID');
  return { schema: 'sandeal-phase10-release-reference-verification-v1', status: 'PASS_LOCAL_ONLY', head: source.head,
    bundleFingerprint: bundle.bundleFingerprint, staticDeterministic: true, currentSourceAndArtifactsMatch: true,
    productionProvenanceVerified: false, productionCertified: false, executable: false, approval: null, productionMutationMode: 'BLOCKED' };
}
export function generateReference(inputPath, directory) {
  const input = validateInputs(readJson(inputPath)), source = captureSource(); assertSource(input, source);
  const config = configuration(input);
  const references = input.evidencePaths.map(fileReference);
  fs.mkdirSync(ignoredDirectory(directory));
  references.push(writeJson(`${directory}/inputs.json`, input), writeJson(`${directory}/source-inventory.json`, source));
  const builds = [1, 2].map(number => buildOnce(input, source, directory, number));
  references.push(...[1, 2].map(number => fileReference(`${directory}/build-${number}.json`)), config.reference);
  const bundle = createReference(input, source, config, builds, references);
  writeJson(`${directory}/${bundleName}`, bundle);
  const verification = verifyReference(directory);
  writeJson(`${directory}/${verificationName}`, verification);
  return { directory, ...verification };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, first, second, ...extra] = process.argv.slice(2);
    assert.ok(extra.length === 0 && (mode === 'generate' && first && second || mode === 'verify' && first && !second), 'USE_GENERATE_INPUT_NEW_DIRECTORY_OR_VERIFY_DIRECTORY');
    console.log(JSON.stringify(mode === 'generate' ? generateReference(first, second) : verifyReference(first)));
  } catch (error) { console.error(`PHASE10_REFERENCE_FAILED: ${error.message}`); process.exitCode = 1; }
}
