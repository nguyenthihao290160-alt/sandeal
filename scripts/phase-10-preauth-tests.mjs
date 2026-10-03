import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { load, root, hash, sourceManifest, executionFingerprint, migrationFiles } from './lib/release-rehearsal.mjs';

const production = load('../../src/lib/execution-control-plane/production.ts');
const { cloudflareFetch } = load('../../src/lib/runtime/cloudflare/http.ts');
const { cloudflareQueue, cloudflareScheduled } = load('../../src/lib/runtime/cloudflare/autopilot.ts');
const { productionMigrationDiscoveryPlan } = load('../../src/lib/release-rehearsal/productionDiscovery.ts');
const builder = load('../v6-cloudflare-build.cjs');
const cases = [], source = sourceManifest();
const keys = generateKeyPairSync('ed25519');
const trusted = [{ approverId: 'synthetic-fixture-operator', keyId: 'synthetic-memory-only', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }];
const signApproval = claims => ({ ...claims, signature: sign(null, Buffer.from(production.productionApprovalMessage(claims)), keys.privateKey).toString('base64') });
function fixture(now = Date.now()) {
  const identity = { head: '1'.repeat(40), candidateFingerprint: hash('synthetic-candidate'), workerFingerprint: hash('synthetic-worker'),
    staticFingerprint: hash('synthetic-static'), environment: 'PRODUCTION', configFingerprint: hash('synthetic-config'),
    targets: { accountId: '1'.repeat(32), workerName: 'synthetic-worker', staticTarget: 'synthetic-worker',
      databaseId: '11111111-1111-1111-1111-111111111111', queueName: 'synthetic-queue', domain: 'synthetic.invalid', route: 'synthetic.invalid/*' },
    migrations: migrationFiles().map(item => ({ name: item.name, sha256: hash(item.sql) })),
    capabilities: ['READ_PRODUCTION_HEALTH'], secretReferences: [...production.PRODUCTION_SECRET_REFERENCES].sort() };
  const requirements = Object.fromEntries(production.PRODUCTION_REQUIREMENTS.map(name => [name, { state: 'VERIFIED', environment: 'PRODUCTION',
    targetsFingerprint: executionFingerprint(identity.targets), candidateFingerprint: identity.candidateFingerprint,
    reportFingerprint: hash(`synthetic-${name}`), reference: `synthetic-${name}`, observedAt: now - 1000, expiresAt: now + 120000 }]));
  const bundle = { schema: 'sandeal-production-release-v1', identity, requirements };
  const controls = { environment: 'PRODUCTION', targetsFingerprint: executionFingerprint(identity.targets), bundleFingerprint: executionFingerprint(bundle),
    killSwitch: { state: 'INACTIVE', domains: Object.fromEntries(load('../../src/lib/execution-control-plane/killSwitch.ts').KILL_SWITCH_DOMAINS.map(name => [name, false])),
      revision: 1, observedAt: now - 1000, expiresAt: now + 120000 },
    emergencyStop: { state: 'AVAILABLE', environment: 'PRODUCTION', revision: 1, observedAt: now - 1000, expiresAt: now + 120000,
      procedureReference: 'synthetic-stop-procedure', verificationFingerprint: hash('synthetic-stop-drill') } };
  const approval = signApproval({ schema: 'sandeal-production-approval-v1', status: 'APPROVED', environment: 'PRODUCTION', identity,
    bundleFingerprint: executionFingerprint(bundle), approverId: trusted[0].approverId, keyId: trusted[0].keyId, issuedAt: now - 500, expiresAt: now + 120000 });
  return { enabled: true, bundle, current: structuredClone(identity), approval, trusted, controls, now, capability: 'READ_PRODUCTION_HEALTH',
    bindings: { DB: true, JOB_QUEUE: true, ASSETS: true }, availableSecretReferences: [...production.PRODUCTION_SECRET_REFERENCES] };
}
function resign(input) {
  const { signature, ...claims } = input.approval;
  assert.ok(signature);
  input.approval = signApproval({ ...claims, bundleFingerprint: executionFingerprint(input.bundle) });
  input.controls.bundleFingerprint = executionFingerprint(input.bundle);
}
async function test(name, work) {
  try { await work(); cases.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, status: 'FAIL', error: String(error.message) }); console.error(`FAIL ${name}`, error); }
}
function blocked(input, reason) {
  const result = production.productionPreflight(input);
  assert.equal(result.allowed, false); assert.equal(result.mutationAllowed, false);
  if (reason) assert.ok(result.blockers.includes(reason), JSON.stringify(result.blockers));
}
function runtimeFixture(input = fixture()) {
  const effects = { writes: 0, queue: 0, assets: 0, healthReads: 0, controlReads: 0, releaseReads: 0 };
  let afterControl = null, afterRelease = null;
  const env = { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'false', SANDEAL_PRODUCTION: 'true', SANDEAL_PRODUCTION_EXECUTION_ENABLED: 'true',
    SHOPEE_AFFILIATE_ENABLED: 'false', SANDEAL_AUTOPILOT_ENABLED: 'false', SANDEAL_MONEY_ENGINE_ENABLED: 'false', SANDEAL_DEAL_INTELLIGENCE_ENABLED: 'false',
    SANDEAL_DECISION_OS_ENABLED: 'false', SANDEAL_DECISION_EXECUTION_MODE: 'DISABLED', SANDEAL_OPPORTUNITY_ENABLED: 'false', SANDEAL_CONTENT_LIFECYCLE_ENABLED: 'false',
    SANDEAL_PRODUCTION_IDENTITY: JSON.stringify(input.current), SANDEAL_PRODUCTION_BUNDLE_FINGERPRINT: executionFingerprint(input.bundle),
    SANDEAL_PRODUCTION_APPROVAL_KEYS: JSON.stringify(trusted), BASIC_AUTH_USER: 'synthetic-admin', BASIC_AUTH_PASSWORD: 'synthetic-test-only',
    ASSETS: { async fetch() { effects.assets++; return new Response('not-authorized'); } }, JOB_QUEUE: { async send() { effects.queue++; } },
    DB: { async batch() { effects.writes++; throw new Error('WRITE_FORBIDDEN'); }, prepare(sql) {
      assert.match(sql, /^SELECT /); assert.match(sql, /LIMIT 1$/);
      if (/release_bundles/.test(sql)) assert.match(sql, /WHERE id=\? AND environment='PRODUCTION'/);
      return { bind(identifier) { assert.equal(identifier, `prod-${executionFingerprint(input.bundle)}`); return this; }, async all() {
        if (/release_bundles/.test(sql)) {
          effects.releaseReads++;
          if (effects.releaseReads > 1) afterRelease?.(input);
          return { success: true, results: [{ payload: JSON.stringify({ bundle: input.bundle, approval: input.approval }) }] };
        }
        if (/execution_controls/.test(sql)) {
          effects.controlReads++;
          if (effects.controlReads > 1) afterControl?.(input);
          return { success: true, results: [{ state: input.controls.killSwitch.state, revision: input.controls.killSwitch.revision,
            observed_at: input.controls.killSwitch.observedAt, expires_at: input.controls.killSwitch.expiresAt, payload: JSON.stringify(input.controls) }] };
        }
        effects.healthReads++; return { success: true, results: [{ name: input.current.migrations.at(-1).name }] };
      } };
    } } };
  return { input, env, effects, onControlChange: callback => { afterControl = callback; }, onReleaseChange: callback => { afterRelease = callback; } };
}
const request = (route = '/api/health/ready', options) => new Request(`https://synthetic.invalid${route}`, options);

await test('signed synthetic approval permits only the bounded read-only capability', () => {
  const input = fixture(); assert.deepEqual(production.productionPreflight(input), { allowed: true, blockers: [], mutationAllowed: false });
});
const matrix = [
  ['missing Cloudflare authentication', input => { input.bundle.requirements.authentication = null; resign(input); }, 'UNVERIFIED_authentication'],
  ['missing Worker target', input => { input.current.targets.workerName = ''; }, 'UNKNOWN_ENVIRONMENT_OR_TARGET'],
  ['missing D1 binding', input => { input.bindings.DB = false; }, 'MISSING_DB'],
  ['missing Queue binding', input => { input.bindings.JOB_QUEUE = false; }, 'MISSING_JOB_QUEUE'],
  ['missing assets binding', input => { input.bindings.ASSETS = false; }, 'MISSING_ASSETS'],
  ['missing secret reference', input => { input.availableSecretReferences = ['BASIC_AUTH_USER']; }, 'MISSING_SECRET_REFERENCE'],
  ['unknown environment', input => { input.current.environment = 'UNKNOWN'; }, 'UNKNOWN_ENVIRONMENT_OR_TARGET'],
  ['stale approval', input => { input.approval.expiresAt = input.now; const { signature, ...claims } = input.approval; assert.ok(signature); input.approval = signApproval(claims); }, 'PRODUCTION_APPROVAL_INVALID'],
  ['wrong environment approval', input => { input.approval.environment = 'LOCAL'; resign(input); }, 'PRODUCTION_APPROVAL_INVALID'],
  ['wrong release approval', input => { input.current.candidateFingerprint = hash('other-release'); }, 'PRODUCTION_APPROVAL_INVALID'],
  ['kill switch ACTIVE', input => { input.controls.killSwitch.state = 'ACTIVE'; }, 'PRODUCTION_CONTROLS_UNAVAILABLE_OR_STOPPED'],
  ['kill switch UNKNOWN', input => { input.controls.killSwitch.state = 'UNKNOWN'; }, 'PRODUCTION_CONTROLS_UNAVAILABLE_OR_STOPPED'],
  ['kill switch STALE', input => { input.controls.killSwitch.expiresAt = input.now; }, 'PRODUCTION_CONTROLS_UNAVAILABLE_OR_STOPPED'],
  ['kill switch UNAVAILABLE', input => { input.controls = null; }, 'PRODUCTION_CONTROLS_UNAVAILABLE_OR_STOPPED'],
  ['emergency stop unavailable', input => { input.controls.emergencyStop.state = 'UNAVAILABLE'; }, 'PRODUCTION_CONTROLS_UNAVAILABLE_OR_STOPPED'],
  ['migration baseline unknown', input => { input.bundle.requirements.migrationBaseline = null; resign(input); }, 'UNVERIFIED_migrationBaseline'],
  ['recovery unknown', input => { input.bundle.requirements.recovery = null; resign(input); }, 'UNVERIFIED_recovery'],
  ['canary routing unknown', input => { input.bundle.requirements.canaryRouting = null; resign(input); }, 'UNVERIFIED_canaryRouting'],
  ['observability unavailable', input => { input.bundle.requirements.observability = null; resign(input); }, 'UNVERIFIED_observability'],
  ['change window not configured', input => { input.bundle.requirements.changeWindow = null; resign(input); }, 'UNVERIFIED_changeWindow'],
  ['rollback targets unknown', input => { input.bundle.requirements.rollbackTargets = null; resign(input); }, 'UNVERIFIED_rollbackTargets'],
  ['production disabled by default', input => { input.enabled = false; }, 'PRODUCTION_EXECUTION_DISABLED'],
  ['unknown capability', input => { input.capability = 'MOVE_REAL_MONEY'; }, 'CAPABILITY_DEFAULT_DENY'],
];
for (const [name, change, reason] of matrix) await test(`failure matrix: ${name}`, () => { const input = fixture(); change(input); blocked(input, reason); });
for (const field of ['head', 'candidateFingerprint', 'workerFingerprint', 'staticFingerprint', 'configFingerprint', 'targets', 'migrations', 'capabilities', 'secretReferences']) {
  await test(`approval binds ${field} against current release identity`, () => {
    const input = fixture();
    if (field === 'head') input.current.head = '2'.repeat(40);
    else if (field === 'targets') input.current.targets.queueName = 'other-queue';
    else if (field === 'migrations') input.current.migrations[0].sha256 = hash('changed-sql');
    else if (field === 'capabilities') input.current.capabilities = ['PUBLISH_CONTENT'];
    else if (field === 'secretReferences') input.current.secretReferences = [];
    else input.current[field] = hash('changed');
    blocked(input, 'PRODUCTION_APPROVAL_INVALID');
  });
}
for (const [name, change] of [
  ['missing approval', input => { input.approval = null; }],
  ['unsigned prose approval', input => { input.approval.signature = ''; }],
  ['forged signature', input => { input.approval.signature = Buffer.alloc(64).toString('base64'); }],
  ['untrusted human', input => { input.trusted = []; }],
  ['duplicate trusted key', input => { input.trusted = [...trusted, ...trusted]; }],
  ['tampered bundle', input => { input.bundle.requirements.resources.reference = 'different-report'; }],
  ['future approval', input => { input.approval.issuedAt = input.now + 1; }],
  ['overlong approval', input => { input.approval.expiresAt = input.now + 600000; }],
  ['revoked approval', input => { input.approval.status = 'REVOKED'; }],
  ['extra raw credential field', input => { input.approval.password = 'synthetic'; }],
]) await test(`approval rejects ${name}`, () => {
  const input = fixture(); change(input);
  if (['future approval', 'overlong approval', 'revoked approval', 'extra raw credential field'].includes(name)) resign(input);
  blocked(input, 'PRODUCTION_APPROVAL_INVALID');
});
for (const [name, change] of [
  ['cross environment controls', input => { input.controls.environment = 'LOCAL'; }],
  ['cross target controls', input => { input.controls.targetsFingerprint = hash('other-target'); }],
  ['cross bundle controls', input => { input.controls.bundleFingerprint = hash('other-bundle'); }],
  ['emergency stop stale', input => { input.controls.emergencyStop.expiresAt = input.now; }],
  ['emergency stop revision mismatch', input => { input.controls.emergencyStop.revision++; }],
  ['emergency stop unverified', input => { input.controls.emergencyStop.verificationFingerprint = null; }],
  ['domain switch active', input => { input.controls.killSwitch.domains.DEPLOYMENT_DISABLED = true; }],
  ['kill snapshot future', input => { input.controls.killSwitch.observedAt = input.now + 1; }],
]) await test(`controls reject ${name}`, () => { const input = fixture(); change(input); blocked(input, 'PRODUCTION_CONTROLS_UNAVAILABLE_OR_STOPPED'); });
for (const name of production.PRODUCTION_REQUIREMENTS) await test(`proof ${name} cannot reuse local evidence`, () => {
  const input = fixture(); input.bundle.requirements[name].environment = 'LOCAL'; resign(input); blocked(input, `UNVERIFIED_${name}`);
});
await test('malformed preflight inputs fail closed without throwing', () => { for (const input of [null, {}, { bundle: null }]) blocked(input); });
await test('real production configuration contract preserves discovered targets without authorizing production', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'config/cloudflare/production.contract.json')));
  assert.equal(contract.deployable, false); assert.equal(contract.productionExecutionEnabled, false);
  assert.equal(contract.worker.runWorkerFirst, true); assert.equal(contract.productionVerified, false);
  const expectedContractTargets = {
    accountId: '88d3839bee4ac092d39fbb293e3eb426',
    workerName: 'sandeal-production',
    staticTarget: 'sandeal-production',
    databaseId: 'bdf42c22-190d-4cdf-a166-a9e07ade57f2',
    queueName: 'sandeal-production-jobs',
    domain: null,
    route: null,
    zoneId: null,
  };
  assert.deepEqual(Object.fromEntries(Object.keys(expectedContractTargets).map(name => [name, contract.resources[name].value])), expectedContractTargets);
  assert.equal(contract.resources.staticTarget.value, contract.resources.workerName.value);
  assert.equal(contract.resources.accountId.source, 'AUTHENTICATED_DISCOVERY');
  assert.equal(contract.resources.workerName.source, 'AUTHENTICATED_DISCOVERY');
  assert.deepEqual(contract.worker.capabilitiesImplemented, ['READ_PRODUCTION_HEALTH']);
  for (const name of ['SANDEAL_PRODUCTION_APPROVAL_KEYS', 'SANDEAL_PRODUCTION_IDENTITY', 'SANDEAL_PRODUCTION_BUNDLE_FINGERPRINT']) assert.equal(contract.variables[name].value, null);
  assert.equal(contract.queue.productionProducerEnabled, false); assert.equal(contract.queue.productionConsumerEnabled, false);
  assert.equal(contract.cron.productionEnabled, false);
  assert.deepEqual(contract.secretReferences.requiredNames, [...production.PRODUCTION_SECRET_REFERENCES].sort());
  assert.equal(contract.secretReferences.valuesAllowed, false); assert.deepEqual(contract.secretReferences.directShopeeReferences, []);
  assert.equal(contract.changeWindow.policy, null); assert.equal(contract.changeWindow.status, 'REVIEW_REQUIRED_NOT_CONFIGURED');
});
await test('production draft bundle cannot be approved or executed', () => {
  const draft = JSON.parse(fs.readFileSync(path.join(root, 'config/cloudflare/production-release-bundle.contract.json')));
  assert.equal(draft.executable, false); assert.equal(draft.approval, null); assert.ok(Object.values(draft.requirements).every(value => value === null));
  const input = fixture(); input.bundle = draft; blocked(input);
});
await test('read-only migration discovery is bounded inert SQL with unknown baseline', () => {
  const plan = productionMigrationDiscoveryPlan(); assert.equal(plan.executable, false); assert.equal(plan.pendingSet, null);
  assert.equal(plan.baseline, 'UNKNOWN_UNTIL_AUTHENTICATED_DISCOVERY'); assert.equal(plan.productionMigrations, 0);
  for (const sql of plan.queries) { assert.match(sql, /^SELECT /); assert.match(sql, /LIMIT (?:1|51|201)$/); assert.doesNotMatch(sql, /;|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA/i); }
});
await test('observability signal contract covers each required mechanism', () => {
  assert.deepEqual(production.PRODUCTION_SIGNALS, ['WORKER_ERRORS', 'HTTP_FAILURES', 'D1_FAILURES', 'QUEUE_FAILURES', 'CRON_FAILURES', 'PROVIDER_FAILURES',
    'UNEXPECTED_WRITES', 'MONEY_INVARIANT_FAILURES', 'KILL_SWITCH_EVENTS', 'DEPLOYMENT_HEALTH', 'LATENCY', 'RATE_LIMITING']);
});
await test('static profile distinguishes local production and reserved-domain rehearsal', () => {
  assert.equal(builder.siteBuildEnvironment().NEXT_PUBLIC_SITE_URL, 'http://localhost:8787');
  const rehearsal = builder.siteBuildEnvironment({ environment: 'PRODUCTION_REHEARSAL', origin: 'https://synthetic.invalid' });
  assert.equal(rehearsal.NEXT_PUBLIC_SANDEAL_ENVIRONMENT, 'PRODUCTION_REHEARSAL');
  assert.equal(builder.siteBuildEnvironment({ environment: 'PRODUCTION', origin: 'https://www.cloudflare.com' }).NEXT_PUBLIC_SITE_URL, 'https://www.cloudflare.com');
});
for (const options of [{ environment: 'UNKNOWN' }, { environment: 'PRODUCTION' }, { environment: 'PRODUCTION', origin: 'http://localhost:8787' },
  { environment: 'PRODUCTION', origin: 'https://synthetic.invalid' }, { environment: 'PRODUCTION', origin: 'https://operator:synthetic@example.com' },
  { environment: 'PRODUCTION', origin: 'https://example.com/subpath' }, { environment: 'PRODUCTION_REHEARSAL', origin: 'https://example.com' }]) {
  await test(`invalid static profile ${JSON.stringify(options)}`, () => assert.throws(() => builder.siteBuildEnvironment(options)));
}
await test('production path executes a fully authorized synthetic health read with zero writes', async () => {
  const runtime = runtimeFixture(); const response = await cloudflareFetch(request(), runtime.env);
  assert.equal(response.status, 200); assert.equal((await response.json()).mutationAllowed, false);
  assert.deepEqual(runtime.effects, { writes: 0, queue: 0, assets: 0, healthReads: 1, controlReads: 2, releaseReads: 2 });
});
await test('HTTP HEAD authorizes without a response body', async () => {
  const runtime = runtimeFixture(); const response = await cloudflareFetch(request('/api/health/ready', { method: 'HEAD' }), runtime.env);
  assert.equal(response.status, 200); assert.equal(await response.text(), '');
});
for (const [name, change] of [
  ['disabled', env => { delete env.SANDEAL_PRODUCTION_EXECUTION_ENABLED; }],
  ['unknown environment', env => { env.SANDEAL_PRODUCTION = 'unknown'; }],
  ['conflicting local mode', env => { env.SANDEAL_LOCAL_ONLY = 'true'; }],
  ['legacy runtime', env => { env.SANDEAL_RUNTIME = 'legacy'; }],
  ['direct Shopee enabled', env => { env.SHOPEE_AFFILIATE_ENABLED = 'true'; }],
  ['money enabled', env => { env.SANDEAL_MONEY_ENGINE_ENABLED = 'true'; }],
  ['autopilot enabled', env => { env.SANDEAL_AUTOPILOT_ENABLED = 'true'; }],
  ['missing identity', env => { delete env.SANDEAL_PRODUCTION_IDENTITY; }],
  ['missing DB', env => { delete env.DB; }],
  ['missing queue', env => { delete env.JOB_QUEUE; }],
]) await test(`runtime rejects ${name} before any dependency calls`, async () => {
  const runtime = runtimeFixture(); change(runtime.env); assert.equal((await cloudflareFetch(request(), runtime.env)).status, 503);
  assert.ok(Object.values(runtime.effects).every(value => value === 0));
});
for (const [name, change] of [
  ['expired approval', input => { input.approval.expiresAt = input.now - 1; }],
  ['forged approval', input => { input.approval.signature = ''; }],
  ['active kill switch', input => { input.controls.killSwitch.state = 'ACTIVE'; }],
  ['unknown stop', input => { input.controls.emergencyStop.state = 'UNKNOWN'; }],
]) await test(`runtime ${name} has no health execution or mutations`, async () => {
  const runtime = runtimeFixture(); change(runtime.input); const response = await cloudflareFetch(request(), runtime.env);
  assert.equal(response.status, 503); assert.equal(runtime.effects.healthReads + runtime.effects.writes + runtime.effects.assets + runtime.effects.queue, 0);
});
await test('control revision changed during request blocks response', async () => {
  const runtime = runtimeFixture(); runtime.onControlChange(input => { input.controls.killSwitch.revision++; });
  assert.equal((await cloudflareFetch(request(), runtime.env)).status, 503); assert.equal(runtime.effects.writes, 0);
});
await test('approval revoked during request blocks response', async () => {
  const runtime = runtimeFixture(); runtime.onReleaseChange(input => { input.approval.status = 'REVOKED'; });
  assert.equal((await cloudflareFetch(request(), runtime.env)).status, 503); assert.equal(runtime.effects.writes, 0);
});
for (const route of ['/', '/_next/static/test.js', '/api/public/products', '/api/admin/settings/automation', '/go/product', '/api/health/ready?override=true']) {
  await test(`production unsupported route stays blocked: ${route}`, async () => {
    const runtime = runtimeFixture(); assert.equal((await cloudflareFetch(request(route), runtime.env)).status, 503);
    assert.ok(Object.values(runtime.effects).every(value => value === 0));
  });
}
await test('production write method never reaches a binding', async () => {
  const runtime = runtimeFixture(); assert.equal((await cloudflareFetch(request('/api/health/ready', { method: 'POST' }), runtime.env)).status, 503);
  assert.ok(Object.values(runtime.effects).every(value => value === 0));
});
await test('wrong origin never reaches a binding', async () => {
  const runtime = runtimeFixture(); assert.equal((await cloudflareFetch(new Request('https://other.invalid/api/health/ready'), runtime.env)).status, 503);
  assert.ok(Object.values(runtime.effects).every(value => value === 0));
});
await test('production Queue Cron and transport retries stay blocked', async () => {
  const runtime = runtimeFixture(); let retries = 0;
  await assert.rejects(() => cloudflareQueue({ queue: 'sandeal-local-jobs', messages: [{ retry() { retries++; } }] }, runtime.env));
  await assert.rejects(() => cloudflareScheduled({ scheduledTime: Date.now() }, runtime.env));
  assert.equal(retries, 0); assert.ok(Object.values(runtime.effects).every(value => value === 0));
});
await test('raw dependency details never escape HTTP errors', async () => {
  const runtime = runtimeFixture(); runtime.env.DB.prepare = () => { throw new Error('synthetic-private-detail'); };
  const response = await cloudflareFetch(request(), runtime.env); assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /synthetic-private-detail|synthetic-admin/); assert.equal(response.headers.get('cache-control'), 'no-store');
});
await test('compiled workerd verifies signed authority against ephemeral local D1 only', async () => {
  const { Miniflare, convertV4MiniflareOptions } = load('miniflare');
  const built = await builder.buildWorker(), input = fixture(), runtime = runtimeFixture(input);
  const bindings = Object.fromEntries(Object.entries(runtime.env).filter(([, value]) => typeof value === 'string'));
  const worker = new Miniflare(convertV4MiniflareOptions({ name: 'phase10-synthetic-only', host: '127.0.0.1', port: 0,
    modules: true, scriptPath: built.file, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], bindings,
    d1Databases: ['DB'], queueProducers: { JOB_QUEUE: 'synthetic-queue' },
    assets: { directory: path.join(root, 'cloudflare/site/out'), binding: 'ASSETS', run_worker_first: true,
      routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: '404-page' } } }));
  try {
    await worker.ready; const db = (await worker.getBindings()).DB;
    await db.batch([
      db.prepare('CREATE TABLE release_bundles(id TEXT PRIMARY KEY, environment TEXT, payload TEXT)'),
      db.prepare('CREATE TABLE execution_controls(id TEXT PRIMARY KEY, state TEXT, revision INTEGER, observed_at INTEGER, expires_at INTEGER, payload TEXT)'),
      db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT)'),
    ]);
    await db.prepare('INSERT INTO release_bundles VALUES(?,?,?)').bind(`prod-${executionFingerprint(input.bundle)}`, 'PRODUCTION', JSON.stringify({ bundle: input.bundle, approval: input.approval })).run();
    const control = input.controls.killSwitch;
    await db.prepare('INSERT INTO execution_controls VALUES(?,?,?,?,?,?)').bind('global', control.state, control.revision, control.observedAt, control.expiresAt, JSON.stringify(input.controls)).run();
    await db.prepare('INSERT INTO d1_migrations VALUES(?,?)').bind(10, input.current.migrations.at(-1).name).run();
    assert.equal((await worker.dispatchFetch(request().url)).status, 200);
    assert.equal((await worker.dispatchFetch('https://synthetic.invalid/')).status, 503);
    assert.equal((await worker.dispatchFetch('https://synthetic.invalid/_next/static/missing.js')).status, 503);
    await db.prepare("UPDATE execution_controls SET state='ACTIVE',revision=2 WHERE id='global'").run();
    assert.equal((await worker.dispatchFetch(request().url)).status, 503);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM release_bundles').first()).count, 1);
  } finally { await worker.dispose(); }
});
await test('final focused source unchanged', () => assert.deepEqual(sourceManifest(), source));
const passed = cases.filter(item => item.status === 'PASS').length, failed = cases.filter(item => item.status === 'FAIL').length;
fs.mkdirSync(path.join(root, '.test-tmp/phase10-preauth'), { recursive: true });
fs.writeFileSync(path.join(root, '.test-tmp/phase10-preauth/focused-results.json'), `${JSON.stringify({ source, scope: 'SYNTHETIC_OFFLINE_ONLY_NO_REAL_APPROVAL',
  passed, failed, skipped: 0, cases, productionEffects: 0, realApprovalsIssued: 0, generatedAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`${passed} passed, ${failed} failed, 0 skipped`);
if (failed || !passed) process.exitCode = 1;
