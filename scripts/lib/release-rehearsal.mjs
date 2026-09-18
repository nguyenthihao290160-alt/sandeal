import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export const load = createRequire(import.meta.url);
load('../register-typescript.cjs');
export const root = path.resolve(import.meta.dirname, '../..');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const domain = name => load(`../../src/lib/release-rehearsal/${name}.ts`);
export const { executionFingerprint, proposalFingerprint } = load('../../src/lib/execution-control-plane/fingerprint.ts');
export const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' }).trim();
export function sourceManifest() {
  const names = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0'))]
    .filter(name => name && !name.startsWith('docs/') && (!/(^|\/)\.env(\.|$)/.test(name) || name === '.env.example')).sort();
  assert.ok(names.length > 0 && names.length <= domain('contracts').RELEASE_LIMITS.sourceFiles, 'SOURCE_BOUND');
  const files = Object.fromEntries(names.map(name => {
    assert.ok(fs.lstatSync(path.join(root, name)).isFile(), 'SOURCE_REGULAR_FILE_REQUIRED');
    return [name, hash(fs.readFileSync(path.join(root, name)))];
  }));
  return { head: git('rev-parse', 'HEAD'), fingerprint: executionFingerprint(files), files };
}
export function migrationFiles() {
  const directory = path.join(root, 'src/lib/storage/d1/migrations');
  const names = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  assert.ok(names.length <= domain('contracts').RELEASE_LIMITS.migrations, 'MIGRATION_BOUND');
  return names.map(name => ({ name, sql: fs.readFileSync(path.join(directory, name), 'utf8') }));
}
export function runtimeConfiguration(config = JSON.parse(fs.readFileSync(path.join(root, 'config/cloudflare/wrangler.runtime.local.jsonc'), 'utf8'))) {
  const expectedVars = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false',
    SHOPEE_AFFILIATE_ENABLED: 'false', SANDEAL_AUTOPILOT_ENABLED: 'false', SANDEAL_MONEY_ENGINE_ENABLED: 'false', AFFILIATE_REDIRECT_HOSTS: '' };
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'name', 'main', 'no_bundle', 'compatibility_date', 'compatibility_flags', 'workers_dev',
    'preview_urls', 'send_metrics', 'vars', 'assets', 'd1_databases', 'queues', 'triggers', 'env'].sort(), 'UNKNOWN_CONFIGURATION_FIELD');
  assert.deepEqual(config.vars, expectedVars, 'LOCAL_CONFIGURATION_CONFLICT');
  assert.equal(config.name, 'sandeal-runtime-local-only');
  assert.equal(config.main, '../../.test-tmp/v6-cloudflare-worker/worker.mjs');
  assert.equal(config.no_bundle, true); assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false); assert.equal(config.send_metrics, false);
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/); assert.deepEqual(config.compatibility_flags, ['nodejs_compat']);
  assert.equal(config.$schema, '../../node_modules/wrangler/config-schema.json');
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'sandeal-runtime-local', database_id: '00000000-0000-0000-0000-000000000000',
    migrations_dir: '../../src/lib/storage/d1/migrations', remote: false }]);
  assert.deepEqual(config.queues, { producers: [{ binding: 'JOB_QUEUE', queue: 'sandeal-local-jobs' }],
    consumers: [{ queue: 'sandeal-local-jobs', max_batch_size: 10, max_batch_timeout: 1, max_retries: 3 }] });
  assert.deepEqual(config.triggers, { crons: ['*/5 * * * *'] });
  assert.deepEqual(config.assets, { directory: '../../cloudflare/site/out', binding: 'ASSETS',
    run_worker_first: ['/api', '/api/*', '/go', '/go/*', '/dashboard', '/dashboard/*', '/deals/*'], not_found_handling: '404-page' });
  assert.deepEqual(config.env, { production: { vars: { SANDEAL_PRODUCTION: 'true' }, d1_databases: [],
    queues: { producers: [], consumers: [] }, triggers: { crons: [] } } });
  return { version: 'cloudflare-local-contract-v1', configFingerprint: executionFingerprint(config), runtime: 'cloudflare', localOnly: true,
    production: false, executionMode: 'SHADOW', directShopeeEnabled: false, aiExecutionEnabled: false, autopilotEnabled: false,
    moneyEngineEnabled: false, budget: { ...domain('contracts').DEFAULT_BUDGET } };
}
export function artifactFiles(directory) {
  const files = [], limits = domain('contracts').RELEASE_LIMITS;
  let totalBytes = 0, entries = 0;
  function visit(relative, depth) {
    assert.ok(depth <= 20, 'ARTIFACT_DEPTH_BOUND');
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      assert.ok(++entries <= limits.artifactFiles * 2, 'ARTIFACT_ENTRY_BOUND');
      assert.equal(entry.isSymbolicLink(), false, 'ARTIFACT_SYMLINK_FORBIDDEN');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name, depth + 1);
      else {
        assert.ok(entry.isFile() && files.length < limits.artifactFiles, 'ARTIFACT_FILE_BOUND');
        const contents = fs.readFileSync(path.join(directory, name));
        totalBytes += contents.length; assert.ok(totalBytes <= limits.artifactBytes, 'ARTIFACT_BYTE_BOUND');
        files.push({ path: name, sha256: hash(contents), bytes: contents.length });
      }
    }
  }
  visit('', 0);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
export function captureArtifacts(source) {
  const worker = fs.readFileSync(path.join(root, '.test-tmp/v6-cloudflare-worker/worker.mjs'));
  return [{ kind: 'WORKER', files: [{ path: 'worker.mjs', sha256: hash(worker), bytes: worker.length }] },
    { kind: 'STATIC', files: artifactFiles(path.join(root, 'cloudflare/site/out')) }].map(artifact => ({ ...artifact,
    sourceHead: source.head, sourceFingerprint: source.fingerprint, fingerprint: domain('manifest').artifactFingerprint(artifact) }));
}
export async function buildArtifacts(source) {
  assert.deepEqual(sourceManifest(), source, 'SOURCE_CHANGED_BEFORE_BUILD');
  const builder = load('../v6-cloudflare-build.cjs');
  const worker = await builder.buildWorker(), site = builder.buildSite();
  assert.equal(worker.fileStorageModules, 0); assert.equal(worker.filesystemSettingsModules, 0); assert.equal(site.exit, 0);
  assert.deepEqual(sourceManifest(), source, 'SOURCE_CHANGED_DURING_BUILD');
  return captureArtifacts(source);
}
