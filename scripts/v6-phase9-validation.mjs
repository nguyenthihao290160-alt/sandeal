import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const load = createRequire(import.meta.url), { fingerprint } = load('./v6-run-state.cjs');
const modes = {
  focused: [['phase9', ['scripts/phase-09-execution-control-plane-tests.cjs']]],
  regressions: [
    ['d1', ['scripts/v6-d1-tests.cjs']],
    ['queue', ['scripts/v6-cloudflare-queue-tests.cjs']],
    ['cron', ['scripts/v6-cloudflare-cron-tests.cjs']],
    ['phase8-5-lifecycle', ['scripts/v6-content-lifecycle-tests.mjs']],
    ['phase8-content', ['scripts/v6-content-seo-tests.mjs']],
    ['phase7-5-opportunity', ['scripts/v6-opportunity-experiments-tests.mjs']],
    ['phase7-decision', ['scripts/v6-decision-os-tests.mjs']],
    ['phase6-deal', ['scripts/v6-deal-intelligence-tests.cjs']],
    ['phase5-money', ['scripts/v6-money-engine-tests.cjs']],
    ['autopilot', ['scripts/v6-cloudflare-autopilot-tests.cjs']],
    ['runtime', ['scripts/v6-cloudflare-runtime-tests.cjs']],
    ['routing', ['scripts/v6-cloudflare-routing-tests.cjs']],
    ['site', ['scripts/v6-cloudflare-site-tests.cjs']],
    ['accesstrade', ['scripts/accesstrade-link-safety-tests.cjs']],
    ['tiktok', ['scripts/accesstrade-tiktok-integration-tests.cjs']],
    ['publication', ['scripts/prompt10-autopublish-tests.cjs']],
    ['zero-vps', ['scripts/v6-zero-vps-storage-tests.cjs']],
    ['revenue', ['scripts/prompt10-revenue-integrity-tests.cjs']],
  ],
  final: [
    ['typescript', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']],
    ['eslint', ['node_modules/eslint/bin/eslint.js', '.']],
    ['secret-scan', ['scripts/release-validation.cjs', 'secret-scan']],
    ['cloudflare-worker', ['-e', "require('./scripts/v6-cloudflare-build.cjs').buildWorker().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1})"]],
    ['cloudflare-site', ['-e', "console.log(JSON.stringify(require('./scripts/v6-cloudflare-build.cjs').buildSite()))"]],
    ['diff-check', null],
  ],
};
const mode = process.argv[2] || 'all';
if (!['all', ...Object.keys(modes)].includes(mode)) throw new Error('PHASE9_VALIDATION_MODE_INVALID');
const steps = mode === 'all' ? Object.values(modes).flat() : modes[mode];
const parent = '.test-tmp/phase9'; fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, `${mode}-`)), results = [];
function sourceFingerprint() {
  const files = Object.fromEntries(Object.entries(fingerprint().files).filter(([name]) => !name.startsWith('docs/')));
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
const initialSource = sourceFingerprint();
for (const [name, args] of steps) {
  console.log(`RUN ${name}`);
  const started = Date.now(), command = args ? process.execPath : 'git', argumentsList = args || ['diff', '--check'];
  const result = spawnSync(command, argumentsList, { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' } });
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? `\n${result.error.message}` : ''}`, log = path.join(directory, `${name}.log`);
  fs.writeFileSync(log, output);
  const counts = [...output.matchAll(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/gi)].at(-1);
  const item = { name, command: [args ? 'node' : 'git', ...argumentsList].join(' '), exit: result.status ?? 1, elapsedMs: Date.now() - started, log,
    ...(counts ? { passed: Number(counts[1]), failed: Number(counts[2]), skipped: Number(counts[3] || 0) } : {}) };
  results.push(item); console.log(JSON.stringify(item));
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), initialSource, finalSource: sourceFingerprint(), results }, null, 2) + '\n');
  if (item.exit !== 0 || item.failed > 0) { console.error(output.slice(-6000)); process.exitCode = 1; break; }
}
const finalSource = sourceFingerprint();
if (initialSource.sha256 !== finalSource.sha256) { console.error('PHASE9_SOURCE_CHANGED_DURING_VALIDATION'); process.exitCode = 1; }
console.log(`PHASE9_VALIDATION_REPORT=${path.join(directory, 'results.json')}`);
