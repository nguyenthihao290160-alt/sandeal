/* eslint-disable @typescript-eslint/no-require-imports */
// Local regression orchestration only. Each existing suite owns isolated data.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const suites = [
  'v6-migration', 'storage-migration',
  'v6-storage-architecture', 'v6-architecture-remediation', 'v6-settings-seam', 'v6-d1', 'v6-zero-vps-storage',
  'production-health-readiness-regression', 'operator-intelligence-regression',
  'prompt10-lifecycle-storage', 'prompt08-product-intelligence',
  'v6-phase1-foundation', 'v6-stabilization',
  'scheduler-incumbent-regression', 'scheduler-role-heartbeat-regression',
  'accesstrade-link-safety', 'accesstrade-tiktok-integration',
  'product-first-bounded-accesstrade', 'product-first-pipeline-worker',
  'storage-adapter-phase1a', 'storage-adapter-mongo', 'storage-acceptance',
  'source-reliability', 'source-discovery-identity',
  'prompt10-zero-touch', 'prompt10-foundation', 'prompt10-runtime',
  'prompt10-business-source', 'prompt09-seo-analytics', 'prompt10-revenue-integrity',
  'prompt13-production-readiness', 'prompt10-self-healing', 'runtime-fence-commit-window',
  'master-m2-worker-pool', 'active-job-history-archive',
  'master-m1-runtime-recovery', 'master-m4-intelligence', 'master-m5-platform-seo',
  'm3-1-3-gate-b-worker-scheduling', 'prompt10-autopublish', 'prompt10-slo-error-budget',
  'gemini-provider-diagnostics', 'master-m2-slo-runnable', 'master-m2-operational-health',
];
const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp', 'v6-validation-'));
const results = [];
for (const name of suites) {
  const args = [...(name === 'product-first-bounded-accesstrade' ? ['--expose-gc'] : []), `scripts/${name}-tests.cjs`];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(path.join(directory, `${name}.log`), output);
  const row = { command: `node ${args.join(' ')}`, exit: result.status,
    passed: (output.match(/^\s*(?:PASS\b|✓|✅)/gm) || []).length,
    failed: (output.match(/^\s*(?:FAIL\b|✗|❌)/gm) || []).length,
    error: result.error?.code };
  results.push(row);
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(row));
}
console.log(`RESULT_DIRECTORY=${directory}`);
process.exitCode = results.some(row => row.exit !== 0) ? 1 : 0;
