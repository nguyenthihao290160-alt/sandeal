/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');

const cwd = __dirname;
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
