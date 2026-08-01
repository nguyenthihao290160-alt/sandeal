/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const release = 'f'.repeat(40);
process.env.NODE_ENV = 'production';
process.env.SANDEAL_BUILD_MANIFEST_COMMIT = release;
process.env.SANDEAL_BUILD_COMMIT = release;
process.env.SANDEAL_RELEASE_ID = release;
process.env.GIT_COMMIT_SHA = release;
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = release;
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    failed += 1;
    console.error('FAIL ' + name + '\n' + (error instanceof Error ? error.stack : error));
  }
}

function runGuard(args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/guarded-release-verify.cjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input || '');
  });
}

function pm2Fixture(dataDirectory) {
  return ['sandeal', 'sandeal-worker', 'sandeal-scheduler'].map((name, index) => ({
    name,
    pid: 4_201 + index,
    pm2_env: {
      status: 'online',
      SANDEAL_DATA_DIR: dataDirectory,
      SANDEAL_BUILD_MANIFEST_COMMIT: release,
      SANDEAL_BUILD_COMMIT: release,
      SANDEAL_RELEASE_ID: release,
      GIT_COMMIT_SHA: release,
      NEXT_PUBLIC_SANDEAL_RELEASE_ID: release,
    },
  }));
}

function activeLease(role, pid, heartbeatAt = Date.now()) {
  const timestamp = new Date(heartbeatAt).toISOString();
  const expiresAt = new Date(Date.now() + 45_000).toISOString();
  return {
    schemaVersion: 3,
    id: role,
    role,
    ownerId: `${role.toLowerCase()}:fixture`,
    holderId: `${role.toLowerCase()}:fixture`,
    instanceId: `${role.toLowerCase()}:fixture:${pid}`,
    pid,
    releaseId: release,
    status: 'ACTIVE',
    acquiredAt: timestamp,
    startedAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt,
    leaseExpiresAt: expiresAt,
    fencingToken: 1,
    takeoverCount: 0,
    updatedAt: timestamp,
  };
}

async function main() {
  const route = require('../src/app/api/health/live/route.ts');

  await test('live health exposes the full public release identity without secrets', async () => {
    const response = await route.GET();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'PASS');
    assert.equal(body.embeddedBuildId, release);
    assert.equal(body.runtimeReleaseId, release);
    assert.equal(body.gitCommitSha, release);
    assert.equal(body.publicBuildId, release);
    assert.equal(body.releaseMismatch, false);
    assert.equal(body.buildId, release);
    assert.equal(typeof body.timestamp, 'string');
    assert.equal(JSON.stringify(body).includes('SANDEAL_'), false);
  });

  await test('guarded health verifier accepts local and public-compatible live health payloads', async () => {
    const server = http.createServer(async (_request, response) => {
      const routeResponse = await route.GET();
      response.writeHead(routeResponse.status, {
        'content-type': routeResponse.headers.get('content-type') || 'application/json',
      });
      response.end(await routeResponse.text());
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const url = 'http://127.0.0.1:' + address.port + '/api/health/live';
      const result = await runGuard(['health', release, url, url]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /"status": "PASS"/);
      assert.match(result.stdout, new RegExp(release));
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  await test('runtime verifier rejects stale or PID-mismatched role leases', async () => {
    const dataDirectory = path.resolve('.test-tmp', `m3-1-3-runtime-verifier-${Date.now()}-${process.pid}`);
    fs.mkdirSync(dataDirectory, { recursive: true });
    const pm2 = pm2Fixture(dataDirectory);
    const writeLeases = leases => fs.writeFileSync(
      path.join(dataDirectory, 'runtime-role-leases.json'),
      `${JSON.stringify(leases, null, 2)}\n`,
      'utf8',
    );
    const currentLeases = [activeLease('WORKER', 4_202), activeLease('SCHEDULER', 4_203)];
    writeLeases(currentLeases);
    const passing = await runGuard(['runtime', release], {
      input: JSON.stringify(pm2),
      env: { SANDEAL_DATA_DIR: dataDirectory, SANDEAL_STORAGE_DRIVER: 'file' },
    });
    assert.equal(passing.code, 0, passing.stderr);
    assert.match(passing.stdout, /"pm2Pid": 4202/);
    assert.match(passing.stdout, /"heartbeatAgeMs":/);

    writeLeases([activeLease('WORKER', 9_999), activeLease('SCHEDULER', 4_203)]);
    const pidMismatch = await runGuard(['runtime', release], {
      input: JSON.stringify(pm2),
      env: { SANDEAL_DATA_DIR: dataDirectory, SANDEAL_STORAGE_DRIVER: 'file' },
    });
    assert.notEqual(pidMismatch.code, 0);
    assert.match(pidMismatch.stderr, /GUARDED_RELEASE_LEASE_PID_MISMATCH/);

    writeLeases([activeLease('WORKER', 4_202, Date.now() - 91_000), activeLease('SCHEDULER', 4_203)]);
    const staleHeartbeat = await runGuard(['runtime', release], {
      input: JSON.stringify(pm2),
      env: { SANDEAL_DATA_DIR: dataDirectory, SANDEAL_STORAGE_DRIVER: 'file' },
    });
    assert.notEqual(staleHeartbeat.code, 0);
    assert.match(staleHeartbeat.stderr, /GUARDED_RELEASE_LEASE_HEARTBEAT_STALE/);
  });

  console.log('\nM3.1.3 release live-health tests: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
