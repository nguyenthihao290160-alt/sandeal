/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const crypto = require('node:crypto');
const os = require('node:os');
const { processAutomationBatch } = require('../src/lib/automation/worker.ts');
const { getAutomationSettings } = require('../src/lib/storage/automationSettings.ts');
const { acquireRuntimeRole, heartbeatRuntimeRole, releaseRuntimeRole } = require('../src/lib/automation/runtimeRoles.ts');
const hostname = os.hostname();
const workerId = `worker:${hostname}`;
const instanceId = `${workerId}:${process.pid}:${crypto.randomUUID()}`;
const processStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

(async () => {
  const role = await acquireRuntimeRole({ role: 'WORKER', ownerId: workerId, instanceId, hostname, pid: process.pid, processStartedAt });
  if (!role.acquired) throw new Error(`WORKER_ROLE_ALREADY_ACTIVE:${role.lease.holderId}`);
  if (!role.ownership) throw new Error('WORKER_ROLE_OWNERSHIP_MISSING');
  const ownership = role.ownership;
  const roleHeartbeat = setInterval(() => { void heartbeatRuntimeRole('WORKER', ownership); }, 15_000);
  let lastIdleLogAt = 0;
  try {
    do {
      const settings = await getAutomationSettings();
      const concurrency = Math.max(1, Math.min(4, Number(settings.maxConcurrency) || 1));
      const result = await processAutomationBatch(instanceId, concurrency);
      const now = Date.now();
      if (once || result.claimed > 0 || now - lastIdleLogAt >= 60_000) {
        console.log(JSON.stringify({ type: result.claimed ? 'worker_tick' : 'worker_idle', ...result }));
        if (!result.claimed) lastIdleLogAt = now;
      }
      if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, result.claimed ? 500 : 2_000));
    } while (!once && !stopping);
  } finally {
    clearInterval(roleHeartbeat);
    await releaseRuntimeRole('WORKER', ownership);
  }
})().catch(error => { console.error('Worker failed:', error instanceof Error ? error.message : 'unknown_error'); process.exitCode = 1; });
