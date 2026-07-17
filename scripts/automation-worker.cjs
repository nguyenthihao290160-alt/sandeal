/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const { processAutomationBatch } = require('../src/lib/automation/worker.ts');
const { acquireRuntimeRole, heartbeatRuntimeRole, releaseRuntimeRole } = require('../src/lib/automation/runtimeRoles.ts');
const workerId = `worker-${process.pid}`;
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

(async () => {
  const role = await acquireRuntimeRole({ role: 'WORKER', holderId: workerId, pid: process.pid });
  if (!role.acquired) throw new Error(`WORKER_ROLE_ALREADY_ACTIVE:${role.lease.holderId}`);
  const roleHeartbeat = setInterval(() => { void heartbeatRuntimeRole('WORKER', workerId); }, 15_000);
  let lastIdleLogAt = 0;
  try {
    do {
      const result = await processAutomationBatch(workerId, 2);
      const now = Date.now();
      if (once || result.claimed > 0 || now - lastIdleLogAt >= 60_000) {
        console.log(JSON.stringify({ type: result.claimed ? 'worker_tick' : 'worker_idle', ...result }));
        if (!result.claimed) lastIdleLogAt = now;
      }
      if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, result.claimed ? 500 : 2_000));
    } while (!once && !stopping);
  } finally {
    clearInterval(roleHeartbeat);
    await releaseRuntimeRole('WORKER', workerId);
  }
})().catch(error => { console.error('Worker failed:', error instanceof Error ? error.message : 'unknown_error'); process.exitCode = 1; });
