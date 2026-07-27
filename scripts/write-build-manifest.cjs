/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, '.sandeal-build-manifest.json');
const GIT_SHA = /^[0-9a-f]{40}$/i;
const releaseVariables = [
  'SANDEAL_BUILD_MANIFEST_COMMIT',
  'SANDEAL_BUILD_COMMIT',
  'SANDEAL_RELEASE_ID',
  'GIT_COMMIT_SHA',
  'NEXT_PUBLIC_SANDEAL_RELEASE_ID',
];

function currentGitHead() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().toLowerCase();
  if (!GIT_SHA.test(commit)) throw new Error('BUILD_MANIFEST_GIT_HEAD_INVALID');
  return commit;
}

function validateReleaseEnvironment(commitSha) {
  for (const variable of releaseVariables) {
    const value = String(process.env[variable] || '').trim().toLowerCase();
    if (!value) continue;
    if (!GIT_SHA.test(value)) throw new Error(`BUILD_MANIFEST_${variable}_SHA_INVALID`);
    if (value !== commitSha) throw new Error(`BUILD_MANIFEST_${variable}_GIT_HEAD_MISMATCH`);
  }
}

const commitSha = currentGitHead();
validateReleaseEnvironment(commitSha);
const manifest = {
  schemaVersion: 1,
  application: 'sandeal',
  commitSha,
  buildTimestamp: new Date().toISOString(),
  nodeVersion: process.version,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o644,
});
console.log(`Build manifest prepared for ${commitSha}.`);
