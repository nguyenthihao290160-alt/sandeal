/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const environment = {
  ...process.env,
  SANDEAL_BUILD_VALIDATION_ONLY: 'true',
};

// Do not let a release environment label a review-only artifact. next.config
// embeds an explicit non-release identity that remains fail-closed at runtime.
for (const variable of [
  'SANDEAL_BUILD_MANIFEST_COMMIT',
  'SANDEAL_BUILD_COMMIT',
  'SANDEAL_RELEASE_ID',
  'GIT_COMMIT_SHA',
  'NEXT_PUBLIC_SANDEAL_RELEASE_ID',
]) delete environment[variable];

const nextBin = require.resolve('next/dist/bin/next');
const result = spawnSync(process.execPath, [nextBin, 'build'], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.signal) {
  process.stderr.write(`Build validation terminated by ${result.signal}.\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
