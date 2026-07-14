/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const {
  runAutomationSchedulerTick,
  runProductIntelligenceSchedulerTick,
} = require('../src/lib/automation/scheduler.ts');
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

(async () => {
  do {
    const result = await runAutomationSchedulerTick();
    console.log(JSON.stringify({ type: 'scheduler_tick', ...result }));
    const productIntelligenceResult = await runProductIntelligenceSchedulerTick();
    console.log(JSON.stringify({ type: 'product_intelligence_scheduler_tick', ...productIntelligenceResult }));
    if (!once && !stopping) await new Promise(resolve => setTimeout(resolve, 30_000));
  } while (!once && !stopping);
})().catch(error => { console.error('Scheduler failed:', error instanceof Error ? error.message : 'unknown_error'); process.exitCode = 1; });
