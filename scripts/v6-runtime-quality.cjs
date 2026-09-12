/* eslint-disable @typescript-eslint/no-require-imports */
// Explicit local quality commands, with durable exit records and isolated build data.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, recordEvidence } = require('./v6-run-state.cjs');
const commands = {
  typecheck: [require.resolve('typescript/bin/tsc'), '--noEmit'],
  lint: [path.join(root, 'node_modules/eslint/bin/eslint.js')],
  'secret-scan': ['scripts/release-validation.cjs', 'secret-scan'],
  'build-legacy': ['scripts/validate-dirty-build.cjs'],
  'build-worker': ['scripts/v6-cloudflare-build.cjs', 'worker'],
};
const names = process.argv.slice(2);
if (!names.length || names.some(name => !Object.hasOwn(commands, name))) throw new Error('EXPLICIT_QUALITY_COMMAND_REQUIRED');
const directory = fs.mkdtempSync(path.join(root, '.test-tmp/v6-runtime-quality-'));
for (const name of names) {
  const env = { ...process.env };
  if (name === 'build-legacy') Object.assign(env, { SANDEAL_RUNTIME: 'legacy', SANDEAL_STORAGE_DRIVER: 'file',
    SANDEAL_DATA_DIR: path.join(directory, 'legacy-data'), SHOPEE_AFFILIATE_ENABLED: 'false', NEXT_TELEMETRY_DISABLED: '1' });
  const run = spawnSync(process.execPath, commands[name], { cwd: root, env, encoding: 'utf8', timeout: 360000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const log = path.relative(root, path.join(directory, `${name}.log`)).replaceAll('\\', '/');
  fs.writeFileSync(path.join(root, log), output);
  const result = { command: `node ${commands[name].join(' ')}`, exit: run.status, log };
  recordEvidence(`phase4-${name}`, result); console.log(JSON.stringify({ name, ...result }));
  if (run.status !== 0) { console.error(output.slice(-10000)); process.exitCode = 1; break; }
}
