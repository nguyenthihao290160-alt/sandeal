/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { build } = require('esbuild');
const { root, recordEvidence, writeState } = require('./v6-run-state.cjs');
const outputDirectory = path.join(root, '.test-tmp/v6-cloudflare-worker');
async function buildWorker() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: ['cloudflare/worker.ts'], outfile: path.join(outputDirectory, 'worker.mjs'),
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', metafile: true, conditions: ['workerd', 'worker'],
    plugins: [{ name: 'cloudflare-explicit-storage', setup(builder) {
      builder.onResolve({ filter: /(^|[\\/])storageFactory(?:\.ts)?$/ }, () => ({ path: path.join(root, 'src/lib/runtime/cloudflare/storageFactory.ts') }));
      builder.onResolve({ filter: /^(?:node:)?(?:crypto|async_hooks)$/ }, args => ({ path: args.path.startsWith('node:') ? args.path : `node:${args.path}`, external: true }));
    } }],
  });
  const forbidden = Object.keys(result.metafile.inputs).filter(name => /fileStorageAdapter|legacySettingsStore|mongoStorageAdapter|automation-worker|automation-scheduler/.test(name));
  const imports = Object.values(result.metafile.outputs).flatMap(value => value.imports.map(item => item.path));
  if (forbidden.length || imports.some(name => !['node:crypto', 'node:async_hooks'].includes(name))) throw new Error('CLOUDFLARE_FORBIDDEN_DEPENDENCY');
  fs.writeFileSync(path.join(outputDirectory, 'metafile.json'), JSON.stringify(result.metafile, null, 2));
  return { file: path.join(outputDirectory, 'worker.mjs'), bytes: fs.statSync(path.join(outputDirectory, 'worker.mjs')).size,
    fileStorageModules: 0, filesystemSettingsModules: 0 };
}
function siteBuildEnvironment(options = {}) {
  const environment = options.environment ?? 'LOCAL';
  if (!['LOCAL', 'PRODUCTION_REHEARSAL', 'PRODUCTION'].includes(environment)) throw new Error('STATIC_ENVIRONMENT_INVALID');
  const origin = options.origin ?? (environment === 'LOCAL' ? 'http://localhost:8787' : null);
  if (typeof origin !== 'string') throw new Error('STATIC_ORIGIN_REQUIRED');
  const address = new URL(origin);
  if (address.origin !== origin || address.username || address.password || address.port && environment !== 'LOCAL'
    || (environment === 'LOCAL' ? !['localhost', '127.0.0.1'].includes(address.hostname)
      : address.protocol !== 'https:' || !address.hostname.includes('.') || ['localhost', '127.0.0.1'].includes(address.hostname))
    || environment === 'PRODUCTION_REHEARSAL' && !address.hostname.endsWith('.invalid')
    || environment === 'PRODUCTION' && /\.(?:invalid|test|example)$/.test(address.hostname)) throw new Error('STATIC_ORIGIN_INVALID');
  return { NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production', SANDEAL_RUNTIME: 'cloudflare',
    SANDEAL_SITE_ENVIRONMENT: environment, NEXT_PUBLIC_SANDEAL_ENVIRONMENT: environment, NEXT_PUBLIC_SITE_URL: origin };
}
function siteBuildProcessEnvironment(options = {}, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|COMSPEC|NUMBER_OF_PROCESSORS)$/i.test(name)));
  Object.assign(env, siteBuildEnvironment(options));
  for (const name of ['SANDEAL_RELEASE_ID', 'GIT_COMMIT_SHA', 'NEXT_PUBLIC_SANDEAL_RELEASE_ID']) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  if (env.SANDEAL_SITE_ENVIRONMENT !== 'PRODUCTION' && !env.SANDEAL_RELEASE_ID?.trim() && !env.GIT_COMMIT_SHA?.trim()) {
    env.SANDEAL_RELEASE_ID = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  }
  return env;
}
function siteBuildIdentity() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'cloudflare/site/.next/required-server-files.json'), 'utf8')).config;
  const buildId = config.env?.NEXT_PUBLIC_SANDEAL_RELEASE_ID;
  if (!/^[a-f0-9]{40}$/.test(buildId) || config.deploymentId !== buildId) throw new Error('STATIC_BUILT_RELEASE_ID_INVALID');
  return { buildId, nextBuildId: fs.readFileSync(path.join(root, 'cloudflare/site/.next/BUILD_ID'), 'utf8').trim(),
    environment: config.env.NEXT_PUBLIC_SANDEAL_ENVIRONMENT, origin: config.env.NEXT_PUBLIC_SITE_URL };
}
function buildSite(options = {}) {
  const env = siteBuildProcessEnvironment(options);
  const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build', 'cloudflare/site', '--webpack'],
    { cwd: root, env, encoding: 'utf8', timeout: 360000, maxBuffer: 16 * 1024 * 1024 });
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'site-build.log'), `${result.stdout || ''}${result.stderr || ''}`);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.status !== 0) throw new Error('CLOUDFLARE_STATIC_BUILD_FAILED');
  const headers = '/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src \'self\'; base-uri \'self\'; object-src \'none\'; frame-ancestors \'none\'; form-action \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: https:; connect-src \'self\'; font-src \'self\' data:\n  X-Robots-Tag: noindex, nofollow\n\n/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n';
  fs.writeFileSync(path.join(root, 'cloudflare/site/out/_headers'), headers);
  return { exit: 0, log: '.test-tmp/v6-cloudflare-worker/site-build.log', ...siteBuildIdentity() };
}
async function main() {
  const mode = process.argv[2] || 'all';
  if (!['all', 'worker', 'site'].includes(mode)) throw new Error('LOCAL_BUILD_MODE_INVALID');
  writeState({ currentStep: `Cloudflare local build: ${mode}`, result: 'RUNNING' });
  if (mode !== 'site') { const worker = await buildWorker(); recordEvidence('build-cloudflare-worker', { exit: 0, ...worker }); console.log(JSON.stringify(worker)); }
  if (mode !== 'worker') recordEvidence('build-cloudflare-site', buildSite());
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildWorker, buildSite, siteBuildEnvironment, siteBuildProcessEnvironment, siteBuildIdentity, outputDirectory };
