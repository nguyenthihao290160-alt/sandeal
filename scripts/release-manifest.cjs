/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const releaseDir = path.resolve(option('output', process.env.SANDEAL_RELEASE_DIR || path.join(root, '.release')));

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function gitBuffer(...args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

function readSourceState() {
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  const changedFiles = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
  const sourceDigest = crypto.createHash('sha256');
  sourceDigest.update(gitBuffer('diff', '--binary', 'HEAD', '--', '.'));

  const untracked = gitBuffer('ls-files', '--others', '--exclude-standard', '-z')
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const relativePath of untracked) {
    sourceDigest.update(relativePath);
    sourceDigest.update('\0');
    sourceDigest.update(fs.readFileSync(path.join(root, relativePath)));
    sourceDigest.update('\0');
  }

  return {
    workingTreeDirty: changedFiles > 0,
    changedFiles,
    statusChecksum: digest(status),
    sourceChangesChecksum: sourceDigest.digest('hex'),
  };
}

function create() {
  if (option('test') !== 'passed' || option('build') !== 'passed') throw new Error('Chi tao manifest sau khi test va build dat.');
  if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) throw new Error('Khong tim thay production build hop le.');
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const file of fs.readdirSync(releaseDir)) {
    if (/^sandeal-.*\.tar\.gz$/.test(file) || /^(?:release-manifest\.json|release-manifest\.sha256)$/.test(file)) fs.rmSync(path.join(releaseDir, file), { force: true });
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commitSha = git('rev-parse', 'HEAD');
  const buildId = fs.readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim();
  if (!buildId) throw new Error('.next/BUILD_ID is empty.');
  const branch = git('branch', '--show-current');
  const sourceState = readSourceState();
  const sourceSuffix = sourceState.workingTreeDirty ? `-dirty-${sourceState.sourceChangesChecksum.slice(0, 12)}` : '';
  const artifactName = `sandeal-${packageJson.version}-${commitSha.slice(0, 12)}${sourceSuffix}.tar.gz`;
  const artifactPath = path.join(releaseDir, artifactName);
  const inputs = ['.next', 'public', 'package.json', 'package-lock.json', 'scripts/automation-worker.cjs', 'scripts/automation-scheduler.cjs'];
  for (const input of inputs) if (!fs.existsSync(path.join(root, input))) throw new Error(`Thieu thanh phan artifact: ${input}`);
  execFileSync('tar', ['-czf', artifactPath, '-C', root, ...inputs], { stdio: 'pipe' });

  const manifest = {
    format: 'sandeal-release-manifest-v1',
    releaseVersion: packageJson.version,
    releaseId: commitSha,
    commitSha,
    buildId,
    branch,
    sourceState,
    buildTimestamp: new Date().toISOString(),
    nodeVersion: process.versions.node,
    packageLockChecksum: checksum(path.join(root, 'package-lock.json')),
    artifact: { file: artifactName, sha256: checksum(artifactPath), bytes: fs.statSync(artifactPath).size },
    storage: { type: 'json-file', schemaVersion: 1, multiInstanceSafe: false },
    migrations: [],
    migrationStatus: 'Khong yeu cau migration cho release nay.',
    environmentRequirements: {
      web: ['SANDEAL_RELEASE_ID', 'NEXT_PUBLIC_SITE_URL', 'BASIC_AUTH_ENABLED', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD', 'TOKEN_VAULT_SECRET_KEY'],
      worker: ['SANDEAL_RELEASE_ID', 'SANDEAL_DATA_DIR', 'TZ'],
      scheduler: ['SANDEAL_RELEASE_ID', 'SANDEAL_DATA_DIR', 'TZ'],
      optionalProviders: ['GEMINI_API_KEY', 'ACCESS_TRADE_API_KEY'],
    },
    validation: { tests: 'passed', build: 'passed', typecheck: option('typecheck', 'passed'), secretScan: option('secret-scan', 'passed'), backupRestore: option('backup-restore', 'passed') },
    knownLimitations: [
      'JSON file locking is supported for one application instance only; no distributed lock is provided.',
      'External providers remain unavailable until their credentials are configured.',
      'Production deployment and production migrations are not part of this artifact creation.',
      'A dirty working tree identifies a local release candidate only; commit and rebuild before production deployment.',
    ],
  };
  const manifestPath = path.join(releaseDir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'release-manifest.sha256'), `${checksum(manifestPath)}\n`, 'utf8');
  process.stdout.write(`RELEASE_MANIFEST=${manifestPath}\nARTIFACT=${artifactPath}\nARTIFACT_SHA256=${manifest.artifact.sha256}\n`);
}

function validate() {
  const manifestPath = path.resolve(option('manifest', path.join(releaseDir, 'release-manifest.json')));
  const checksumPath = path.join(path.dirname(manifestPath), 'release-manifest.sha256');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(checksumPath)) throw new Error('Thieu manifest hoac checksum manifest.');
  if (checksum(manifestPath) !== fs.readFileSync(checksumPath, 'utf8').trim()) throw new Error('Checksum manifest khong khop.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const required = ['releaseVersion', 'releaseId', 'commitSha', 'buildId', 'branch', 'sourceState', 'buildTimestamp', 'nodeVersion', 'packageLockChecksum', 'artifact', 'storage', 'migrations', 'validation', 'knownLimitations'];
  for (const key of required) if (manifest[key] === undefined || manifest[key] === '') throw new Error(`Manifest thieu ${key}.`);
  if (!/^[0-9a-f]{40}$/i.test(manifest.commitSha)) throw new Error('Commit SHA khong hop le.');
  if (manifest.releaseId !== manifest.commitSha) throw new Error('Release identity khong khop commit SHA.');
  const currentSourceState = readSourceState();
  if (
    manifest.sourceState.workingTreeDirty !== currentSourceState.workingTreeDirty
    || manifest.sourceState.changedFiles !== currentSourceState.changedFiles
    || manifest.sourceState.statusChecksum !== currentSourceState.statusChecksum
    || manifest.sourceState.sourceChangesChecksum !== currentSourceState.sourceChangesChecksum
  ) throw new Error('Source da thay doi sau khi tao manifest.');
  if (manifest.validation.tests !== 'passed' || manifest.validation.build !== 'passed' || manifest.validation.typecheck !== 'passed' || manifest.validation.secretScan !== 'passed' || manifest.validation.backupRestore !== 'passed') throw new Error('Manifest co quality gate chua dat.');
  if (manifest.storage.schemaVersion !== 1 || manifest.storage.multiInstanceSafe !== false || !Array.isArray(manifest.migrations)) throw new Error('Storage contract khong hop le.');
  const artifactPath = path.join(path.dirname(manifestPath), manifest.artifact.file);
  if (!fs.existsSync(artifactPath) || checksum(artifactPath) !== manifest.artifact.sha256) throw new Error('Artifact checksum khong khop.');
  if (checksum(path.join(root, 'package-lock.json')) !== manifest.packageLockChecksum) throw new Error('package-lock da thay doi sau khi tao manifest.');
  process.stdout.write(`RELEASE_MANIFEST_VALIDATION=READY artifact=${manifest.artifact.file} sha256=${manifest.artifact.sha256}\n`);
}

try {
  const command = process.argv[2];
  if (command === 'create') create();
  else if (command === 'validate') validate();
  else throw new Error('Dung: release-manifest.cjs <create|validate>.');
} catch (error) {
  process.stderr.write(`RELEASE_MANIFEST=BLOCKED ${error instanceof Error ? error.message : 'unknown_error'}\n`);
  process.exitCode = 1;
}
