/* eslint-disable @typescript-eslint/no-require-imports */
// Run only explicitly selected suites. Persist results after every command.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, recordEvidence, writeState } = require('./v6-run-state.cjs');
const names = process.argv.slice(2);
if (!names.length || names.some(name => !/^[a-z0-9-]+$/.test(name))) throw new Error('EXPLICIT_SUITE_NAMES_REQUIRED');
const directory = fs.mkdtempSync(path.join(root, '.test-tmp/v6-resume-3-'));
const results = [];
for (const name of names) {
  const args = [...(name.includes('bounded-accesstrade') ? ['--expose-gc'] : []), `scripts/${name}-tests.cjs`];
  writeState({ currentStep: `Validation: ${name}`, result: 'RUNNING', nextStep: 'Inspect persisted suite result; continue selected checks' });
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 360000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const log = path.relative(root, path.join(directory, `${name}.log`)).replaceAll('\\', '/');
  fs.writeFileSync(path.join(root, log), output);
  const row = { command: `node ${args.join(' ')}`, exit: run.status, passed: (output.match(/^\s*(?:PASS\b|✓|✅)/gm) || []).length,
    failed: (output.match(/^\s*(?:FAIL\b|✗|❌)/gm) || []).length, skipped: (output.match(/^\s*(?:SKIP\b|# SKIP)/gm) || []).length, log };
  results.push(row);
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
  recordEvidence(name, row);
  console.log(JSON.stringify(row));
  if (run.status !== 0 || row.failed || row.skipped) { process.exitCode = 1; console.error(output.slice(-10000)); break; }
}
console.log(`RESULT_DIRECTORY=${directory}`);
