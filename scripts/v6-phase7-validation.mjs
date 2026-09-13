import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const suites = [
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
  ['provider-foundation', ['scripts/prompt10-foundation-tests.cjs']],
  ['gemini-provider', ['scripts/gemini-provider-diagnostics-tests.cjs']],
  ['self-healing', ['scripts/prompt10-self-healing-tests.cjs']],
  ['health', ['scripts/production-health-readiness-regression-tests.cjs']],
  ['rollout', ['scripts/v6-stabilization-tests.cjs']],
  ['zero-vps', ['scripts/v6-zero-vps-storage-tests.cjs']],
  ['revenue', ['scripts/prompt10-revenue-integrity-tests.cjs']],
];
const quality = [
  ['typescript', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']],
  ['eslint', ['node_modules/eslint/bin/eslint.js', '.']],
  ['secret-scan', ['scripts/release-validation.cjs', 'secret-scan']],
  ['cloudflare-build', ['scripts/v6-cloudflare-build.cjs', 'all']],
];
const mode = process.argv[2] || 'all';
const phase = process.argv[3] || 'phase7';
if (!['phase7', 'phase7-5'].includes(phase)) throw new Error('VALIDATION_PHASE_INVALID');
if (phase === 'phase7-5') suites.unshift(['opportunities', ['scripts/v6-opportunity-experiments-tests.mjs']]);
if (!['all', 'tests', 'quality'].includes(mode)) throw new Error('PHASE7_VALIDATION_MODE_INVALID');
const selected = mode === 'tests' ? suites : mode === 'quality' ? quality : [...suites, ...quality];
const directory = path.join('.test-tmp', phase, mode);
fs.mkdirSync(directory, { recursive: true });
const results = [];
for (const [name, args] of selected) {
  console.log(`RUN ${name}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' } });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const log = path.join(directory, `${name}.log`);
  fs.writeFileSync(log, output);
  const counts = [...output.matchAll(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/g)].at(-1);
  const item = { name, command: [process.execPath, ...args].map(value => path.isAbsolute(value) ? path.basename(value) : value).join(' '),
    exit: result.status ?? 1, elapsedMs: Date.now() - started, log,
    ...(counts ? { passed: Number(counts[1]), failed: Number(counts[2]), skipped: Number(counts[3] || 0) } : {}) };
  results.push(item); console.log(JSON.stringify(item));
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n');
  if (item.exit !== 0) console.error(output.slice(-6000));
}
process.exitCode = results.some(result => result.exit !== 0 || result.failed > 0) ? 1 : 0;
