import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { root, artifactFiles, domain } from './lib/release-rehearsal.mjs';
import { canonicalJson, sha256, compareText } from './lib/d1-schema-canonical.mjs';
import { validateBuildPair } from './phase-10-release-reference.mjs';

const contractPath = 'config/cloudflare/gate2-exact-candidate.contract.json';
const handoffSchema = 'sandeal-exact-candidate-handoff-v1';
const workerPath = '.test-tmp/v6-cloudflare-worker/worker.mjs';
const staticPath = 'cloudflare/site/out';
const digest = value => sha256(canonicalJson(value));
const check = (condition, code) => { if (!condition) throw new Error(code); };
const same = (actual, expected, code) => check(canonicalJson(actual) === canonicalJson(expected), code);
const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], {
  cwd: root, encoding: 'utf8', windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(name))),
}).trimEnd();

function localPath(directory, relative) {
  check(typeof relative === 'string' && /^[a-zA-Z0-9_.$/@()[\]-]{1,240}$/.test(relative)
    && !path.isAbsolute(relative) && !relative.split('/').some(part => ['', '.', '..', '.git'].includes(part))
    && !/(^|\/)(?:\.env(?:\.|$)|credentials\.json$|auth\.json$)|\.(?:key|pem|p12|pfx)$/i.test(relative), 'UNSAFE_LOCAL_PATH');
  const base = path.resolve(directory), absolute = path.resolve(base, relative);
  check(absolute.startsWith(`${base}${path.sep}`), 'PATH_OUTSIDE_LOCAL_ROOT');
  for (let current = absolute; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) check(!fs.lstatSync(current).isSymbolicLink(), 'SYMLINK_FORBIDDEN');
    if (path.dirname(current) === current) break;
  }
  return absolute;
}
function bytesAt(directory, relative) {
  const absolute = localPath(directory, relative), stat = fs.lstatSync(absolute);
  check(stat.isFile() && stat.size <= 64 * 1024 * 1024, 'REGULAR_BOUNDED_FILE_REQUIRED');
  return fs.readFileSync(absolute);
}
const jsonAt = (directory, relative) => JSON.parse(bytesAt(directory, relative).toString('utf8').replace(/^\uFEFF/, ''));
function checkedBytes(directory, reference) {
  const contents = bytesAt(directory, reference.path);
  check(contents.length === reference.bytes && sha256(contents) === reference.sha256, 'EVIDENCE_OR_ARTIFACT_HASH_MISMATCH');
  return contents;
}
export function readReviewPolicy() { return jsonAt(root, contractPath); }
export function readCheckout() {
  return { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
    remoteHead: git('rev-parse', 'refs/remotes/origin/master'), tree: git('rev-parse', 'HEAD^{tree}'),
    indexClean: git('diff', '--cached', '--name-only') === '' };
}
export function validateCheckout(policy, checkout) {
  check(policy.schema === 'sandeal-gate2-review-pins-v1' && policy.productionMutationMode === 'BLOCKED', 'REVIEW_POLICY_INVALID');
  check(policy.remoteRef === 'refs/remotes/origin/master' && policy.branch === 'master', 'REVIEW_BRANCH_REQUIRED');
  check(/^[a-f0-9]{40}$/.test(policy.sourceSha) && /^[a-f0-9]{64}$/.test(policy.candidateIdentifier), 'REVIEW_IDENTITY_REQUIRED');
  check(checkout.head === policy.sourceSha && checkout.remoteHead === policy.sourceSha, 'CHECKOUT_SHA_MISMATCH');
  check(checkout.branch === policy.branch && checkout.indexClean === true, 'CHECKOUT_BRANCH_OR_INDEX_MISMATCH');
  check(policy.target?.accountId && policy.target.workerName && policy.target.staticTarget === policy.target.workerName
    && policy.target.environment === 'PRODUCTION', 'EXPLICIT_PRODUCTION_TARGET_REQUIRED');
}
function evidenceReference(bundle, relative) {
  const matches = bundle.evidenceReferences.filter(reference => reference.path === relative);
  check(matches.length === 1, 'UNIQUE_EVIDENCE_REFERENCE_REQUIRED');
  return matches[0];
}
function inventory(worker, assets) {
  return [{ kind: 'WORKER', files: [worker] }, { kind: 'STATIC', files: assets }]
    .map(artifact => ({ ...artifact, fingerprint: domain('manifest').artifactFingerprint(artifact) }));
}
function localHandoff(policy, bundle, builds, evidenceFiles) {
  const worker = builds[1].artifacts[0], assets = builds[1].artifacts[1];
  const configurationFingerprint = digest({ target: policy.target, configuration: bundle.configuration,
    deploymentMode: 'UPLOAD_INACTIVE', noBundle: true });
  const releaseIdentity = { sourceSha: policy.sourceSha, candidateIdentifier: policy.candidateIdentifier,
    workerSha256: worker.files[0].sha256, staticFingerprint: assets.fingerprint, configurationFingerprint };
  const body = { schema: handoffSchema, status: 'PASS_LOCAL_ONLY_NOT_DEPLOYMENT_AUTHORIZATION',
    source: { sha: policy.sourceSha, branch: policy.branch, remoteRef: policy.remoteRef, tree: bundle.source.gitTree,
      fingerprint: bundle.source.fingerprint }, candidateIdentifier: policy.candidateIdentifier, target: policy.target,
    review: { evidence: policy.reviewEvidence, reviewedAtUtc: policy.reviewedAtUtc,
      expiresAtUtc: new Date(Date.parse(policy.reviewedAtUtc) + policy.localEvidenceMaxAgeMs).toISOString() },
    artifactCount: worker.files.length + assets.files.length,
    worker: { path: 'artifacts/worker.mjs', sha256: worker.files[0].sha256, bytes: worker.files[0].bytes, fingerprint: worker.fingerprint },
    assets: { directory: 'artifacts/assets', binding: 'ASSETS', runWorkerFirst: true, association: 'SAME_INACTIVE_WORKER_VERSION',
      staticTarget: policy.target.workerName, fileCount: assets.files.length, fingerprint: assets.fingerprint, files: assets.files },
    configuration: { reference: bundle.configuration.reference, fingerprint: configurationFingerprint, noBundle: true },
    deploymentMode: 'UPLOAD_INACTIVE', productionMutationMode: 'BLOCKED',
    requirements: { productionCertification: 'FRESH_TARGET_AND_HANDOFF_BOUND_EXTERNAL_PROOF',
      deploymentAuthorization: 'SEPARATE_EXPLICIT_HUMAN_AUTHORIZATION_FOR_UPLOAD_INACTIVE',
      remoteVersionVerification: 'EXACT_WORKER_ASSETS_AND_CONFIGURATION_WITHOUT_TRAFFIC_SHIFT',
      promotionAuthorization: 'SEPARATE_EXPLICIT_HUMAN_AUTHORIZATION_FOR_VERIFIED_REMOTE_VERSION',
      runtimeActivationAuthorization: 'SEPARATE_FROM_DEPLOYMENT_AND_PROMOTION' },
    authority: { productionCertification: null, deploymentAuthorization: null, promotionAuthorization: null,
      deploymentAuthorized: false, runtimeActivationAuthorized: false, remoteMutationAllowed: false },
    runtime: { requiredRecords: ['release_bundles', 'execution_controls'], readiness: 'UNVERIFIED',
      absentRecords: 'FAIL_CLOSED', executionEnabled: false, queueEnabled: false, cronEnabled: false },
    rollback: { ...releaseIdentity, releaseFingerprint: digest(releaseIdentity), workerVersionId: null, deploymentId: null,
      staticVersionId: null, previousCompatibleRelease: null, status: 'UNVERIFIED' },
    phases: { VERIFY: 'LOCAL_ONLY', PREPARE: 'LOCAL_ONLY', UPLOAD_INACTIVE: 'BLOCKED_NOT_IMPLEMENTED',
      VERIFY_REMOTE_VERSION: 'BLOCKED_NOT_IMPLEMENTED', PROMOTE: 'BLOCKED_NOT_IMPLEMENTED' },
    evidenceFiles };
  return structuredClone({ ...body, handoffFingerprint: digest(body) });
}
export function futurePhaseReadiness(handoff, phase) {
  check(['UPLOAD_INACTIVE', 'VERIFY_REMOTE_VERSION', 'PROMOTE'].includes(phase), 'UNKNOWN_FUTURE_PHASE');
  const blockers = ['REMOTE_IMPLEMENTATION_ABSENT'];
  blockers.push(handoff.authority.productionCertification === null ? 'PRODUCTION_CERTIFICATION_REQUIRED' : 'CERTIFICATION_NOT_AUTHENTICATED');
  blockers.push(handoff.authority.deploymentAuthorization === null ? 'EXPLICIT_DEPLOYMENT_AUTHORIZATION_REQUIRED' : 'DEPLOYMENT_AUTHORIZATION_NOT_AUTHENTICATED');
  if (phase !== 'UPLOAD_INACTIVE') blockers.push('REMOTE_VERSION_UNVERIFIED');
  if (phase === 'PROMOTE') blockers.push('SEPARATE_PROMOTION_AUTHORIZATION_REQUIRED', 'ROLLBACK_UNVERIFIED');
  return { phase, allowed: false, mutationAllowed: false, runtimeActivationAuthorized: false, blockers };
}
export function verifyCandidate(inputPath, options = {}) {
  const directory = options.directory ?? root, policy = options.policy ?? readReviewPolicy();
  const checkout = options.checkout ?? readCheckout(), now = options.now ?? Date.now();
  validateCheckout(policy, checkout);
  const reviewedAt = Date.parse(policy.reviewedAtUtc);
  check(Number.isSafeInteger(now) && Number.isFinite(reviewedAt) && policy.localEvidenceMaxAgeMs > 0
    && policy.localEvidenceMaxAgeMs <= 604800000 && reviewedAt <= now
    && now < reviewedAt + policy.localEvidenceMaxAgeMs, 'STALE_CANDIDATE_REVIEW');
  const supplied = jsonAt(directory, inputPath), packaged = supplied.schema === handoffSchema;
  const packageRoot = path.dirname(localPath(directory, inputPath));
  if (packaged) check(path.basename(inputPath) === 'handoff.json', 'HANDOFF_FILENAME_REQUIRED');
  else check(inputPath === policy.candidateReference.path, 'EXPLICIT_REVIEWED_MANIFEST_REQUIRED');
  const evidenceRoot = packaged ? localPath(packageRoot, 'evidence') : directory;
  const bundle = JSON.parse(checkedBytes(evidenceRoot, policy.candidateReference).toString('utf8'));
  const { bundleFingerprint, bundleFingerprintMethod, ...body } = bundle;
  check(bundleFingerprintMethod && bundleFingerprint === policy.candidateIdentifier && digest(body) === policy.candidateIdentifier, 'CANDIDATE_ID_MISMATCH');
  check(bundle.schema === 'sandeal-phase10-production-release-reference-v2' && bundle.executable === false
    && bundle.approval === null && bundle.productionMutationMode === 'BLOCKED', 'REFERENCE_MUST_REMAIN_NON_EXECUTABLE');
  check(bundle.source.head === policy.sourceSha && bundle.source.branch === policy.branch && bundle.source.gitTree === checkout.tree
    && bundle.source.worktreeClean === true && bundle.source.indexClean === true, 'REVIEWED_SOURCE_MISMATCH');
  same({ accountId: bundle.target.accountId, workerName: bundle.target.workerName, staticTarget: bundle.target.staticTarget,
    environment: bundle.environment }, policy.target, 'TARGET_MISMATCH');
  same(bundle.configuration.ASSETS, { binding: 'ASSETS', directory: staticPath, runWorkerFirst: true,
    state: 'PRESENT_LOCAL_CONFIG_ONLY' }, 'ASSETS_DECLARATION_REQUIRED');
  check(bundle.configuration.workerName === policy.target.workerName && bundle.configuration.queueConsumers === 0
    && bundle.configuration.crons === 0 && bundle.configuration.executionEnabled === false, 'CONFIGURATION_NOT_STOPPED');
  const candidateDirectory = path.posix.dirname(policy.candidateReference.path);
  const input = jsonAt(evidenceRoot, evidenceReference(bundle, `${candidateDirectory}/inputs.json`).path);
  const source = jsonAt(evidenceRoot, evidenceReference(bundle, `${candidateDirectory}/source-inventory.json`).path);
  const builds = [1, 2].map(number => jsonAt(evidenceRoot, evidenceReference(bundle, `${candidateDirectory}/build-${number}.json`).path));
  check(input.expectedHead === policy.sourceSha && input.expectedBranch === policy.branch
    && source.head === policy.sourceSha && source.fingerprint === digest(source.files)
    && source.fingerprint === bundle.source.fingerprint, 'SOURCE_PROVENANCE_MISMATCH');
  validateBuildPair(input, source, builds);
  const evidenceFiles = [policy.candidateReference, policy.reviewEvidence, ...bundle.evidenceReferences, ...builds.map(build => build.log)]
    .sort((left, right) => compareText(left.path, right.path));
  check(new Set(evidenceFiles.map(file => file.path)).size === evidenceFiles.length, 'DUPLICATE_EVIDENCE');
  for (const reference of evidenceFiles) checkedBytes(evidenceRoot, reference);
  const review = jsonAt(evidenceRoot, policy.reviewEvidence.path);
  check(review.status === 'PASS_LOCAL_ONLY' && review.completedAtUtc === policy.reviewedAtUtc
    && review.sourceHead === policy.sourceSha && review.sourceFingerprint === source.fingerprint
    && review.candidateIdentifier === policy.candidateIdentifier && review.twoBuildInventoryMatch === true, 'REVIEW_EVIDENCE_MISMATCH');
  const workerContents = bytesAt(packaged ? packageRoot : directory, packaged ? 'artifacts/worker.mjs' : workerPath);
  const assets = artifactFiles(localPath(packaged ? packageRoot : directory, packaged ? 'artifacts/assets' : staticPath));
  for (const file of assets) localPath(packaged ? packageRoot : directory, `${packaged ? 'artifacts/assets' : staticPath}/${file.path}`);
  const actual = inventory({ path: 'worker.mjs', sha256: sha256(workerContents), bytes: workerContents.length }, assets);
  same(actual, builds[1].artifacts, 'EXACT_ARTIFACT_INVENTORY_MISMATCH');
  check(assets.length === policy.staticFileCount && assets.length + 1 === policy.artifactCount
    && bundle.artifacts.static.fileCount === assets.length && review.artifactCount === policy.artifactCount, 'ARTIFACT_COUNT_MISMATCH');
  check(bundle.artifacts.worker.moduleSha256 === actual[0].files[0].sha256 && bundle.artifacts.worker.fingerprint === actual[0].fingerprint
    && bundle.artifacts.static.fingerprint === actual[1].fingerprint, 'ARTIFACT_IDENTITY_MISMATCH');
  const originalInventory = [{ ...actual[0].files[0], path: workerPath }, ...assets.map(file => ({ ...file, path: `${staticPath}/${file.path}` }))];
  same(originalInventory, review.artifacts, 'REVIEWED_ARTIFACT_SET_MISMATCH');
  for (const required of ['index.html', '404.html', 'product/index.html', '_headers']) {
    check(assets.some(file => file.path === required), 'REQUIRED_STATIC_FILE_MISSING');
  }
  const handoff = localHandoff(policy, bundle, builds, evidenceFiles);
  if (packaged) {
    same(supplied, handoff, 'HANDOFF_SUBSTITUTION');
    const expectedNames = ['handoff.json', 'artifacts/worker.mjs', ...assets.map(file => `artifacts/assets/${file.path}`),
      ...evidenceFiles.map(file => `evidence/${file.path}`)].sort(compareText);
    same(artifactFiles(packageRoot).map(file => file.path), expectedNames, 'EXTRA_OR_MISSING_PACKAGE_FILE');
  }
  return { handoff, packaged, evidenceRoot, artifactRoot: packaged ? packageRoot : directory };
}
export function prepareCandidate(inputPath, outputDirectory, options = {}) {
  const verified = verifyCandidate(inputPath, options), directory = options.directory ?? root;
  check(/^\.test-tmp\/[a-zA-Z0-9_-]+$/.test(outputDirectory), 'NEW_LOCAL_OUTPUT_REQUIRED');
  if (directory === root) check(git('check-ignore', '--', `${outputDirectory}/handoff.json`) === `${outputDirectory}/handoff.json`, 'IGNORED_OUTPUT_REQUIRED');
  const output = localPath(directory, outputDirectory);
  check(!fs.existsSync(output), 'OUTPUT_ALREADY_EXISTS');
  fs.mkdirSync(output, { recursive: true });
  function write(relative, contents) {
    const destination = localPath(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents, { flag: 'wx' });
  }
  const { handoff } = verified;
  const worker = { path: verified.packaged ? handoff.worker.path : workerPath, sha256: handoff.worker.sha256, bytes: handoff.worker.bytes };
  write(handoff.worker.path, checkedBytes(verified.artifactRoot, worker));
  for (const file of handoff.assets.files) {
    const source = { ...file, path: `${verified.packaged ? handoff.assets.directory : staticPath}/${file.path}` };
    write(`${handoff.assets.directory}/${file.path}`, checkedBytes(verified.artifactRoot, source));
  }
  for (const reference of handoff.evidenceFiles) write(`evidence/${reference.path}`, checkedBytes(verified.evidenceRoot, reference));
  write('handoff.json', Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`));
  return verifyCandidate(`${outputDirectory}/handoff.json`, options);
}
export function parseLocalArguments(args) {
  const explicitMode = ['verify', 'prepare'].includes(args[0]);
  const mode = explicitMode ? args[0] : 'verify', rest = explicitMode ? args.slice(1) : args;
  check(rest.length === (mode === 'verify' ? 1 : 2) && rest[0]?.endsWith('.json'), 'ONLY_VERIFY_OR_PREPARE_WITH_EXPLICIT_MANIFEST');
  return { mode, inputPath: rest[0], outputDirectory: rest[1] };
}
export function runLocalDriver(args) {
  const { mode, inputPath, outputDirectory } = parseLocalArguments(args);
  const verified = mode === 'prepare' ? prepareCandidate(inputPath, outputDirectory) : verifyCandidate(inputPath);
  return { mode: mode.toUpperCase(), status: verified.handoff.status, candidateIdentifier: verified.handoff.candidateIdentifier,
    handoffFingerprint: verified.handoff.handoffFingerprint, artifactCount: verified.handoff.artifactCount,
    productionMutationMode: 'BLOCKED', productionCertified: false, deploymentAuthorized: false, runtimeActivationAuthorized: false,
    futurePhases: ['UPLOAD_INACTIVE', 'VERIFY_REMOTE_VERSION', 'PROMOTE'].map(phase => futurePhaseReadiness(verified.handoff, phase)) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runLocalDriver(process.argv.slice(2)), null, 2)); }
  catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'INVALID_LOCAL_INPUT';
    console.error(`GATE2_HANDOFF_FAILED: ${code}; no production action is available.`); process.exitCode = 1;
  }
}
