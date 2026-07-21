/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cwd = __dirname;
const GIT_SHA = /^[0-9a-f]{40}$/i;

function resolveReleaseId() {
  const explicit = String(process.env.SANDEAL_RELEASE_ID || '').trim().toLowerCase();
  let gitCommit = '';
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim().toLowerCase(); } catch { /* an artifact without .git must inject the release id */ }
  if (explicit && !GIT_SHA.test(explicit)) throw new Error('SANDEAL_RELEASE_ID must be a full Git SHA.');
  if (gitCommit && !GIT_SHA.test(gitCommit)) throw new Error('Cannot resolve a valid Git SHA for this checkout.');
  if (explicit && gitCommit && explicit !== gitCommit) throw new Error('SANDEAL_RELEASE_ID does not match the checked-out Git commit.');
  const releaseId = explicit || gitCommit;
  if (!releaseId) throw new Error('SANDEAL_RELEASE_ID is required when .git is unavailable.');
  return releaseId;
}

const releaseId = resolveReleaseId();
const dataDir = path.resolve(cwd, process.env.SANDEAL_DATA_DIR || '.data');
const prompt10RuntimeEnabled = process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME === 'true';
const shared = {
  cwd,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  restart_delay: 5_000,
  min_uptime: '10s',
  max_restarts: 10,
  kill_timeout: 15_000,
  max_memory_restart: '512M',
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  merge_logs: true,
  env: {
    NODE_ENV: 'production',
    SANDEAL_DATA_DIR: dataDir,
    SANDEAL_RELEASE_ID: releaseId,
    SANDEAL_BUILD_COMMIT: releaseId,
    NEXT_PUBLIC_SANDEAL_RELEASE_ID: releaseId,
    NEXT_DEPLOYMENT_ID: releaseId,
    GIT_COMMIT_SHA: releaseId,
  },
};

module.exports = {
  apps: [
    {
      ...shared,
      name: 'sandeal',
      script: path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: 'start',
    },
    ...(prompt10RuntimeEnabled ? [
      {
        ...shared,
        name: 'sandeal-worker',
        script: path.join(cwd, 'scripts', 'automation-worker.cjs'),
      },
      {
        ...shared,
        name: 'sandeal-scheduler',
        script: path.join(cwd, 'scripts', 'automation-scheduler.cjs'),
      },
    ] : []),
  ],
};
