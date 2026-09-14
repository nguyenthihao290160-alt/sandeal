import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tests = [
  ['content-phase8', ['scripts/v6-content-seo-tests.mjs']],
  ['opportunities', ['scripts/v6-opportunity-experiments-tests.mjs']],
  ['decisions', ['scripts/v6-decision-os-tests.mjs']],
  ['deals', ['scripts/v6-deal-intelligence-tests.cjs']],
  ['money', ['scripts/v6-money-engine-tests.cjs']],
  ['d1', ['scripts/v6-d1-tests.cjs']],
  ['queue', ['scripts/v6-cloudflare-queue-tests.cjs']],
  ['cron', ['scripts/v6-cloudflare-cron-tests.cjs']],
  ['autopilot', ['scripts/v6-cloudflare-autopilot-tests.cjs']],
  ['runtime', ['scripts/v6-cloudflare-runtime-tests.cjs']],
  ['routing', ['scripts/v6-cloudflare-routing-tests.cjs']],
  ['accesstrade', ['scripts/accesstrade-link-safety-tests.cjs']],
  ['tiktok', ['scripts/accesstrade-tiktok-integration-tests.cjs']],
  ['publication', ['scripts/prompt10-autopublish-tests.cjs']],
  ['zero-vps', ['scripts/v6-zero-vps-storage-tests.cjs']],
  ['revenue', ['scripts/prompt10-revenue-integrity-tests.cjs']],
];
const quality = [
  ['typescript', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']],
  ['eslint', ['node_modules/eslint/bin/eslint.js', '.']],
  ['secret-scan', ['scripts/release-validation.cjs', 'secret-scan']],
  ['cloudflare-build', ['scripts/v6-cloudflare-build.cjs', 'all']],
];
const mode = process.argv[2];
if (!['tests', 'quality'].includes(mode)) throw new Error('LIFECYCLE_VALIDATION_MODE_REQUIRED');
const available = mode === 'tests' ? tests : quality, requested = process.argv.slice(3);
if (new Set(requested).size !== requested.length || requested.some(name => !available.some(([suite]) => suite === name)))
  throw new Error('LIFECYCLE_VALIDATION_SUITE_INVALID');
const selected = requested.length ? available.filter(([name]) => requested.includes(name)) : available;
const parent = path.join('.test-tmp', 'phase8-5'); fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, `${mode}-resume-`));
const results = [];
for (const [name, args] of selected) {
  console.log(`RUN ${name}`); const started = Date.now();
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' } });
  const output = `${result.stdout || ''}${result.stderr || ''}`, log = path.join(directory, `${name}.log`);
  fs.writeFileSync(log, output);
  const counts = [...output.matchAll(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/gi)].at(-1);
  const item = { name, command: ['node', ...args].join(' '), exit: result.status ?? 1, elapsedMs: Date.now() - started, log,
    ...(counts ? { passed: Number(counts[1]), failed: Number(counts[2]), skipped: Number(counts[3] || 0) } : {}) };
  results.push(item); console.log(JSON.stringify(item));
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n');
  if (item.exit !== 0) console.error(output.slice(-6000));
}
process.exitCode = results.some(result => result.exit !== 0 || result.failed > 0) ? 1 : 0;
