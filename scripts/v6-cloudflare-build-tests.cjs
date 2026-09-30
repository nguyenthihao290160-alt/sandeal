/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { root } = require('./v6-run-state.cjs');
const { siteBuildProcessEnvironment } = require('./v6-cloudflare-build.cjs');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const profile = { environment: 'PRODUCTION', origin: 'https://app.sandeal.tech' };
const system = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|COMSPEC|NUMBER_OF_PROCESSORS)$/i.test(name)));
let passed = 0, failed = 0;
function test(name, work) {
  try { work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
function config(identity = {}, options = profile) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', "const {default: config} = await import('./cloudflare/site/next.config.mjs'); console.log(JSON.stringify({buildId: config.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID, deploymentId: config.deploymentId, env: config.env}));"],
    { cwd: root, encoding: 'utf8', env: siteBuildProcessEnvironment(options, { ...system, ...identity }), windowsHide: true });
}
test('child environment preserves only approved release identities and system variables', () => {
  const identity = { SANDEAL_RELEASE_ID: head, GIT_COMMIT_SHA: head, NEXT_PUBLIC_SANDEAL_RELEASE_ID: head };
  const env = siteBuildProcessEnvironment(profile, { ...identity, PATH: 'synthetic-path', PRIVATE_TEST_VALUE: 'not-forwarded',
    NODE_OPTIONS: '--inspect', NEXT_PUBLIC_UNAPPROVED_VALUE: 'not-forwarded', SANDEAL_PRODUCTION_EXECUTION_ENABLED: 'true' });
  for (const [name, value] of Object.entries(identity)) assert.equal(env[name], value);
  for (const name of ['PRIVATE_TEST_VALUE', 'NODE_OPTIONS', 'NEXT_PUBLIC_UNAPPROVED_VALUE', 'SANDEAL_PRODUCTION_EXECUTION_ENABLED']) assert.equal(env[name], undefined);
  assert.equal(env.NODE_ENV, 'production'); assert.equal(env.NEXT_PUBLIC_SITE_URL, profile.origin);
});
for (const identity of [{ SANDEAL_RELEASE_ID: head }, { GIT_COMMIT_SHA: head },
  { SANDEAL_RELEASE_ID: head, GIT_COMMIT_SHA: head, NEXT_PUBLIC_SANDEAL_RELEASE_ID: head }]) {
  test(`deterministic config accepts ${Object.keys(identity).join('+')}`, () => {
    const result = config(identity); assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.buildId, head); assert.equal(value.deploymentId, head);
    assert.equal(value.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID, head);
    assert.equal(value.env.NEXT_PUBLIC_SANDEAL_ENVIRONMENT, 'PRODUCTION');
    assert.equal(value.env.NEXT_PUBLIC_SITE_URL, profile.origin);
  });
}
for (const [name, identity, error] of [
  ['missing identity', {}, 'SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED'],
  ['public identity is not an authoritative fallback', { NEXT_PUBLIC_SANDEAL_RELEASE_ID: head }, 'SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED'],
  ['invalid release', { SANDEAL_RELEASE_ID: 'missing-release-id' }, 'SANDEAL_RELEASE_ID_GIT_SHA_REQUIRED'],
  ['conflicting identities', { SANDEAL_RELEASE_ID: head, GIT_COMMIT_SHA: '0'.repeat(40) }, 'CONFLICTING_RELEASE_IDS'],
  ['stale release', { SANDEAL_RELEASE_ID: '0'.repeat(40) }, 'SANDEAL_RELEASE_ID_GIT_HEAD_MISMATCH'],
  ['stale public identity', { GIT_COMMIT_SHA: head, NEXT_PUBLIC_SANDEAL_RELEASE_ID: '0'.repeat(40) }, 'NEXT_PUBLIC_SANDEAL_RELEASE_ID_GIT_HEAD_MISMATCH'],
]) {
  test(`production rejects ${name}`, () => {
    const result = config(identity); assert.notEqual(result.status, 0); assert.ok(result.stderr.includes(error));
  });
}
test('production does not infer missing identity from Git', () => {
  assert.equal(siteBuildProcessEnvironment(profile, {}).SANDEAL_RELEASE_ID, undefined);
});
test('production origin is required and reserved origins fail closed', () => {
  for (const options of [{ environment: 'PRODUCTION' }, { ...profile, origin: 'https://production-contract.invalid' },
    { ...profile, origin: 'http://localhost:8787' }]) assert.throws(() => siteBuildProcessEnvironment(options, {}));
});
for (const options of [{}, { environment: 'PRODUCTION_REHEARSAL', origin: 'https://production-contract.invalid' }]) {
  test(`${options.environment ?? 'LOCAL'} retains explicit profile and Git-derived local fallback`, () => {
    const result = config({}, options); assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout); assert.equal(value.buildId, head);
    assert.equal(value.env.NEXT_PUBLIC_SANDEAL_ENVIRONMENT, options.environment ?? 'LOCAL');
  });
}
console.log(`V6 Cloudflare build: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
