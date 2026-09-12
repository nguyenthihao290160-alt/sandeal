/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');

const IMPLEMENTED_GROUPS = new Set(['history']);
const KNOWN_GROUPS = new Set([
  'history',
  'projection',
  'runtime',
  'publication',
  'source',
]);

function safeErrorCode(error) {
  const explicit = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{1,95}$/.test(explicit)
    ? explicit
    : 'V5_INVARIANT_VERIFIER_FAILED';
}

function parseArguments(argv) {
  const groups = [];
  let dataDir;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--data-dir') {
      if (dataDir !== undefined || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error('V5_INVARIANT_ARGUMENT_INVALID');
      }
      dataDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (item.startsWith('--') || !KNOWN_GROUPS.has(item) || groups.includes(item)) {
      throw new Error('V5_INVARIANT_ARGUMENT_INVALID');
    }
    groups.push(item);
  }
  if (!groups.length) groups.push('history');
  if (groups.some(group => !IMPLEMENTED_GROUPS.has(group))) {
    throw new Error('V5_INVARIANT_GROUP_NOT_IMPLEMENTED');
  }
  return { groups, dataDir };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.dataDir !== undefined) {
    if (!options.dataDir.trim()) throw new Error('V5_INVARIANT_DATA_DIR_INVALID');
    process.env.SANDEAL_DATA_DIR = path.resolve(options.dataDir);
  }
  require('./register-typescript.cjs');
  const {
    verifyV5HistoryInvariants,
  } = require('../src/lib/automation/jobHistoryMaintenance.ts');
  const report = await verifyV5HistoryInvariants();
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    program: 'SANDEAL_V5_2_ZERO_TOUCH',
    groups: options.groups,
    ...report,
  }, null, 2)}\n`);
  if (report.result !== 'PASS') process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    program: 'SANDEAL_V5_2_ZERO_TOUCH',
    result: 'ERROR',
    errorCode: safeErrorCode(error),
  })}\n`);
  process.exitCode = 1;
});
