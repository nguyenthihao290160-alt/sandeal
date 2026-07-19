/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');

const apply = process.argv.includes('--apply');
const confirmed = process.argv.includes('--confirm-local-fixture');
if (apply && (!confirmed || process.env.NODE_ENV !== 'test' || !process.env.SANDEAL_DATA_DIR)) {
  console.error('APPLY_REQUIRES_TEST_TEMP_DATA_AND_CONFIRMATION');
  process.exit(2);
}
require('./register-typescript.cjs');
const { cleanupAccessTradeRecords } = require(path.join(process.cwd(), 'src/lib/product-intelligence/accessTradeCleanup.ts'));
const limitArg = process.argv.find(value => value.startsWith('--limit='));
const cursorArg = process.argv.find(value => value.startsWith('--cursor='));
cleanupAccessTradeRecords({
  apply,
  dryRun: !apply,
  limit: limitArg ? Number(limitArg.slice('--limit='.length)) : 100,
  cursor: cursorArg ? cursorArg.slice('--cursor='.length) : undefined,
  actor: 'prompt12-local-cleanup',
}).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
  console.error(error instanceof Error ? error.message : 'CLEANUP_FAILED');
  process.exitCode = 1;
});
