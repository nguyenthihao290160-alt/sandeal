/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const {
  runAutomationSchedulerTick,
  runProductIntelligenceSchedulerTick,
  runRuntimeControlSchedulerTick,
} = require('../src/lib/automation/scheduler.ts');
const { acquireRuntimeRole, heartbeatRuntimeRole, releaseRuntimeRole } = require('../src/lib/automation/runtimeRoles.ts');
const schedulerId = `scheduler-${process.pid}`;
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

(async () => {
  const role = await acquireRuntimeRole({ role: 'SCHEDULER', holderId: schedulerId, pid: process.pid });
  if (!role.acquired) throw new Error(`SCHEDULER_ROLE_ALREADY_ACTIVE:${role.lease.holderId}`);
  const roleHeartbeat = setInterval(() => { void heartbeatRuntimeRole('SCHEDULER', schedulerId); }, 15_000);
  let lastLogAt = 0;
  let previousState = '';
  try {
    do {
      const guardian = await runRuntimeControlSchedulerTick();
      const result = await runAutomationSchedulerTick();
      const intelligence = await runProductIntelligenceSchedulerTick();
      const state = `${guardian.status}:${result.status}:${intelligence.status}`;
      const now = Date.now();
      if (once || state !== previousState || guardian.status === 'scheduled' || result.status === 'scheduled' || intelligence.scheduled > 0 || now - lastLogAt >= 5 * 60_000) {
        console.log(JSON.stringify({ type: 'scheduler_tick', guardian, automation: result, intelligence }));
        lastLogAt = now;
        previousState = state;
      }
      if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, 30_000));
    } while (!once && !stopping);
  } finally {
    clearInterval(roleHeartbeat);
    await releaseRuntimeRole('SCHEDULER', schedulerId);
  }
})().catch(error => { console.error('Scheduler failed:', error instanceof Error ? error.message : 'unknown_error'); process.exitCode = 1; });
