/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}

async function main() {
  const release = require('../src/lib/releaseIdentity.ts');
  const systemCapability = require('../src/lib/health/systemCapability.ts');
  const current = 'a'.repeat(40);
  const stale = 'b'.repeat(40);
  const base = {
    embeddedManifestId: current,
    embeddedEnvironmentId: current,
    runtimeReleaseId: current,
    gitCommitSha: current,
    publicBuildId: current,
    nodeEnv: 'production',
  };

  await test('matching build and runtime identities report one reviewed release', () => {
    const identity = release.deriveReleaseIdentity(base);
    assert.equal(identity.buildId, current);
    assert.equal(identity.embeddedBuildId, current);
    assert.equal(identity.runtimeReleaseId, current);
    assert.equal(identity.gitCommitSha, current);
    assert.equal(identity.publicBuildId, current);
    assert.equal(identity.releaseMismatch, false);
    assert.deepEqual(identity.releaseMismatchReasons, []);
    assert.equal(identity.releaseSource, 'immutable_build_manifest');
  });

  await test('a stale embedded environment cannot relabel the immutable artifact', () => {
    const identity = release.deriveReleaseIdentity({ ...base, embeddedEnvironmentId: stale });
    assert.equal(identity.buildId, current);
    assert.equal(identity.embeddedBuildId, current);
    assert.equal(identity.releaseMismatch, true);
    assert.ok(identity.releaseMismatchReasons.includes('BUILD_MANIFEST_ENVIRONMENT_MISMATCH'));
  });

  await test('a runtime-only mismatch is reported without changing artifact identity', () => {
    const identity = release.deriveReleaseIdentity({ ...base, runtimeReleaseId: stale });
    assert.equal(identity.buildId, current);
    assert.equal(identity.runtimeReleaseId, stale);
    assert.equal(identity.releaseMismatch, true);
    assert.ok(identity.releaseMismatchReasons.includes('EMBEDDED_RUNTIME_RELEASE_MISMATCH'));
    assert.ok(identity.releaseMismatchReasons.includes('RUNTIME_GIT_COMMIT_MISMATCH'));
  });

  await test('a public build mismatch is reported explicitly', () => {
    const identity = release.deriveReleaseIdentity({ ...base, publicBuildId: stale });
    assert.equal(identity.releaseMismatch, true);
    assert.ok(identity.releaseMismatchReasons.includes('EMBEDDED_PUBLIC_BUILD_MISMATCH'));
    assert.ok(identity.releaseMismatchReasons.includes('RUNTIME_PUBLIC_BUILD_MISMATCH'));
  });

  await test('invalid production release values fail the identity check', () => {
    const identity = release.deriveReleaseIdentity({ ...base, gitCommitSha: 'invalid-sha' });
    assert.equal(identity.releaseMismatch, true);
    assert.ok(identity.releaseMismatchReasons.includes('GIT_COMMIT_SHA_INVALID'));
  });

  await test('missing stale PM2 environment values are not inferred from the build', () => {
    const identity = release.deriveReleaseIdentity({
      ...base,
      runtimeReleaseId: undefined,
      gitCommitSha: undefined,
    });
    assert.equal(identity.runtimeReleaseId, 'unavailable');
    assert.equal(identity.gitCommitSha, null);
    assert.equal(identity.releaseMismatch, true);
    assert.ok(identity.releaseMismatchReasons.includes('SANDEAL_RELEASE_ID_MISSING'));
    assert.ok(identity.releaseMismatchReasons.includes('GIT_COMMIT_SHA_MISSING'));
  });

  await test('health capability remains blocked when release mismatch is reported', () => {
    const status = systemCapability.deriveSystemCapabilityStatus({
      web: { status: 'ready' },
      worker: { status: 'active' },
      scheduler: { status: 'active' },
      queue: { pending: 0, running: 0, stuck: 0, staleJobs: 0 },
      control: {
        publishPaused: false,
        publishPausedByOperator: false,
        publishBlockedByRuntime: false,
        publishBlockedByPolicy: false,
        publishRuntimeReasons: [],
        publishPolicyReasons: [],
        workerPaused: false,
        schedulerPaused: false,
        ingestionPaused: false,
        killSwitch: false,
      },
      runtime: { publishSafe: true, reasons: [] },
      release: { releaseMismatch: true },
      ai: { providerStatus: 'ready', budgetAvailable: true, policyAllowed: true },
    });
    assert.equal(status.operationalStatus, 'DEGRADED');
    assert.equal(status.publishingStatus, 'BLOCKED');
    assert.equal(status.overallStatus, 'LIMITED');
  });

  await test('guarded PM2 verification reads only selected release identities', () => {
    const pm2 = ['sandeal', 'sandeal-worker', 'sandeal-scheduler'].map((name, index) => ({
      name,
      pid: 100 + index,
      pm2_env: {
        status: 'online',
        SANDEAL_DATA_DIR: path.resolve('.test-tmp', 'guarded-release-data'),
        SANDEAL_BUILD_MANIFEST_COMMIT: current,
        SANDEAL_BUILD_COMMIT: current,
        SANDEAL_RELEASE_ID: current,
        GIT_COMMIT_SHA: current,
        NEXT_PUBLIC_SANDEAL_RELEASE_ID: current,
        TOKEN_VAULT_SECRET_KEY: 'must-not-appear',
      },
    }));
    const verified = spawnSync(
      process.execPath,
      ['scripts/guarded-release-verify.cjs', 'processes', current],
      { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(pm2) },
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /"status": "PASS"/);
    assert.equal(verified.stdout.includes('must-not-appear'), false);

    pm2[1].pm2_env.SANDEAL_RELEASE_ID = stale;
    const mismatch = spawnSync(
      process.execPath,
      ['scripts/guarded-release-verify.cjs', 'processes', current],
      { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(pm2) },
    );
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /GUARDED_RELEASE_PM2_IDENTITY_MISMATCH/);
  });

  await test('operational log output masks common credential forms', () => {
    const raw = [
      'authorization=Bearer fixture-token',
      '{"api_key":"fixture-key","message":"safe"}',
      'TOKEN_VAULT_SECRET_KEY=fixture-vault-secret',
      'https://example.test/?access_token=fixture-query-token',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['scripts/redact-operational-output.cjs'],
      { cwd: process.cwd(), encoding: 'utf8', input: raw },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes('fixture-token'), false);
    assert.equal(result.stdout.includes('fixture-key'), false);
    assert.equal(result.stdout.includes('fixture-vault-secret'), false);
    assert.equal(result.stdout.includes('fixture-query-token'), false);
    assert.match(result.stdout, /\[REDACTED\]/);
  });

  await test('guarded deployment and rollback scripts keep PM2 save behind verification', () => {
    const deploy = fs.readFileSync('scripts/guarded-production-deploy.sh', 'utf8');
    const rollback = fs.readFileSync('scripts/guarded-production-rollback.sh', 'utf8');
    for (const variable of [
      'SANDEAL_BUILD_MANIFEST_COMMIT',
      'SANDEAL_BUILD_COMMIT',
      'SANDEAL_RELEASE_ID',
      'GIT_COMMIT_SHA',
      'NEXT_PUBLIC_SANDEAL_RELEASE_ID',
    ]) {
      assert.ok(deploy.includes(`export ${variable}="$RELEASE"`), variable);
      assert.ok(rollback.includes(`export ${variable}="$ROLLBACK_RELEASE"`), variable);
    }
    for (const forbidden of ['rm -rf', 'git reset', 'git clean', 'lease files', '.data/']) {
      assert.equal(deploy.includes(forbidden), false, forbidden);
      assert.equal(rollback.includes(forbidden), false, forbidden);
    }
    assert.ok(deploy.indexOf('npm run build') < deploy.indexOf('pm2 restart'));
    assert.ok(deploy.indexOf('guarded-release-verify.cjs health') < deploy.lastIndexOf('pm2 save'));
    assert.ok(rollback.indexOf('guarded-release-verify.cjs health') < rollback.lastIndexOf('pm2 save'));
    assert.match(deploy, /SANDEAL_DEPLOY_DEFER_PM2_SAVE/);
    assert.match(deploy, /unset SANDEAL_DEPLOY_DEFER_PM2_SAVE/);
    assert.match(deploy, /GUARDED_DEPLOYMENT_VERIFIED_PENDING_PM2_SAVE/);
    assert.match(deploy, /must be true or false/);
    const verifier = fs.readFileSync('scripts/guarded-release-verify.cjs', 'utf8');
    assert.match(verifier, /GUARDED_RELEASE_LEASE_PID_MISMATCH/);
    assert.match(verifier, /pm2Pid: expectedPid/);
    assert.equal(rollback.includes('npm run build'), false);
  });

  console.log(`\nMaster M1 release identity: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
