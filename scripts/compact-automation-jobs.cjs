/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');
const { compactAutomationJobs } = require('../src/lib/automation/store.ts');

const apply = process.argv.includes('--apply');
const readNumber = (name, fallback) => {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

(async () => {
  const plan = await compactAutomationJobs({
    apply,
    retentionDays: readNumber('retention-days', undefined),
    minimumTerminalJobs: readNumber('minimum-terminal-jobs', undefined),
    actor: apply ? 'operator:queue-compaction' : 'operator:queue-compaction-preview',
  });
  console.log(JSON.stringify({ type: apply ? 'automation_queue_compacted' : 'automation_queue_compaction_preview', ...plan }, null, 2));
})().catch(error => {
  console.error(JSON.stringify({ type: 'automation_queue_compaction_failed', reasonCode: error instanceof Error ? error.message : 'UNKNOWN_ERROR' }));
  process.exitCode = 1;
});
