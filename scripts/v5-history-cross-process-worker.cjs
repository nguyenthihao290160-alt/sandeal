/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !['--input', '--ready', '--start'].includes(option)
      || value === undefined
      || value.startsWith('--')
      || values.has(option)
    ) throw new Error('V5_HISTORY_CHILD_ARGUMENT_INVALID');
    values.set(option, value);
  }
  for (const option of ['--input', '--ready', '--start']) {
    if (!values.has(option)) throw new Error('V5_HISTORY_CHILD_ARGUMENT_REQUIRED');
  }
  return Object.fromEntries(values);
}

function assertInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('V5_HISTORY_CHILD_PATH_INVALID');
  }
  return path.resolve(target);
}

async function waitForFile(target, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (!fs.existsSync(target)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('V5_HISTORY_CHILD_BARRIER_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function main() {
  if (process.env.NODE_ENV !== 'test' || !process.env.SANDEAL_DATA_DIR) {
    throw new Error('V5_HISTORY_CHILD_TEST_ENV_REQUIRED');
  }
  const args = parseArguments(process.argv.slice(2));
  const testRoot = path.dirname(path.resolve(process.env.SANDEAL_DATA_DIR));
  const inputPath = assertInside(testRoot, args['--input']);
  const readyPath = assertInside(testRoot, args['--ready']);
  const startPath = assertInside(testRoot, args['--start']);
  const inputStat = fs.statSync(inputPath);
  if (!inputStat.isFile() || inputStat.size > 2 * 1024 * 1024) {
    throw new Error('V5_HISTORY_CHILD_INPUT_INVALID');
  }
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!input || !Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 250) {
    throw new Error('V5_HISTORY_CHILD_INPUT_INVALID');
  }
  fs.writeFileSync(readyPath, `${process.pid}\n`, { flag: 'wx' });
  await waitForFile(startPath);
  require('./register-typescript.cjs');
  const {
    archiveAutomationJobHistoryBatch,
  } = require('../src/lib/automation/jobHistoryArchive.ts');
  const result = await archiveAutomationJobHistoryBatch(input.jobs, {
    nowMs: Number.isSafeInteger(input.nowMs) ? input.nowMs : Date.now(),
  });
  process.stdout.write(`${JSON.stringify({
    result: 'PASS',
    archived: result.length,
    created: result.filter(item => item.created).length,
  })}\n`);
}

main().catch(error => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.message)
    ? error.message
    : 'V5_HISTORY_CHILD_FAILED';
  process.stderr.write(`${JSON.stringify({ result: 'ERROR', errorCode: code })}\n`);
  process.exitCode = 1;
});
