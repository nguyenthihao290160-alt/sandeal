/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const { processAutomationBatch } = require('../src/lib/automation/worker.ts');
const workerId = `worker-${process.pid}`;
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

(async () => {
  do {
    const result = await processAutomationBatch(workerId, 2);
    console.log(JSON.stringify({ type: 'worker_tick', ...result }));
    if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, result.claimed ? 500 : 2_000));
  } while (!once && !stopping);
})().catch(error => { console.error('Worker failed:', error instanceof Error ? error.message : 'unknown_error'); process.exitCode = 1; });
