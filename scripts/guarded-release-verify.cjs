/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_APPS = ['sandeal', 'sandeal-worker', 'sandeal-scheduler'];
const RELEASE_VARIABLES = [
  'SANDEAL_BUILD_MANIFEST_COMMIT',
  'SANDEAL_BUILD_COMMIT',
  'SANDEAL_RELEASE_ID',
  'GIT_COMMIT_SHA',
  'NEXT_PUBLIC_SANDEAL_RELEASE_ID',
];
const SHA = /^[0-9a-f]{40}$/;

function fail(code, details) {
  const suffix = details ? `:${String(details).slice(0, 240)}` : '';
  throw new Error(`${code}${suffix}`);
}

function expectedRelease(value) {
  const release = String(value || '').trim().toLowerCase();
  if (!SHA.test(release)) fail('GUARDED_RELEASE_SHA_INVALID');
  return release;
}

async function readStandardInput() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function readPm2Processes() {
  let parsed;
  try {
    parsed = JSON.parse(await readStandardInput());
  } catch {
    fail('GUARDED_RELEASE_PM2_JSON_INVALID');
  }
  if (!Array.isArray(parsed)) fail('GUARDED_RELEASE_PM2_LIST_REQUIRED');
  return parsed;
}

function selectedProcesses(processes) {
  const selected = EXPECTED_APPS.map(name => {
    const matches = processes.filter(processItem => processItem?.name === name);
    if (matches.length !== 1) fail('GUARDED_RELEASE_PM2_PROCESS_COUNT_INVALID', name);
    return matches[0];
  });
  return selected;
}

function processEnvironment(processItem) {
  const environment = processItem?.pm2_env;
  if (!environment || typeof environment !== 'object') {
    fail('GUARDED_RELEASE_PM2_ENVIRONMENT_MISSING', processItem?.name);
  }
  return environment;
}

function verifyPm2Processes(processes, release, requireOnline) {
  const selected = selectedProcesses(processes);
  const safeSummary = [];
  for (const processItem of selected) {
    const environment = processEnvironment(processItem);
    if (requireOnline && environment.status !== 'online') {
      fail('GUARDED_RELEASE_PM2_PROCESS_NOT_ONLINE', processItem.name);
    }
    const identities = {};
    for (const variable of RELEASE_VARIABLES) {
      const value = String(environment[variable] || '').trim().toLowerCase();
      if (value !== release) fail('GUARDED_RELEASE_PM2_IDENTITY_MISMATCH', `${processItem.name}:${variable}`);
      identities[variable] = value;
    }
    safeSummary.push({
      name: processItem.name,
      status: String(environment.status || 'unknown'),
      pid: Number(processItem.pid || 0),
      identities,
    });
  }
  return { selected, safeSummary };
}

function sharedDataDirectory(processes) {
  const directories = selectedProcesses(processes).map(processItem => {
    const dataDirectory = String(processEnvironment(processItem).SANDEAL_DATA_DIR || '').trim();
    if (!dataDirectory || !path.isAbsolute(dataDirectory)) {
      fail('GUARDED_RELEASE_DATA_DIRECTORY_INVALID', processItem.name);
    }
    return path.resolve(dataDirectory);
  });
  if (new Set(directories).size !== 1) fail('GUARDED_RELEASE_DATA_DIRECTORY_MISMATCH');
  return directories[0];
}

async function verifyRuntime(processes, release) {
  const processResult = verifyPm2Processes(processes, release, true);
  const processByRole = {
    WORKER: processResult.selected.find(processItem => processItem.name === 'sandeal-worker'),
    SCHEDULER: processResult.selected.find(processItem => processItem.name === 'sandeal-scheduler'),
  };
  process.env.SANDEAL_DATA_DIR = sharedDataDirectory(processes);
  require('./register-typescript.cjs');
  const { listRuntimeRoleLeases } = require('../src/lib/automation/runtimeRoles.ts');
  const { DEFAULT_ROLE_HEARTBEAT_FRESHNESS_MS } = require('../src/lib/automation/currentReasonReconciler.ts');
  const leases = await listRuntimeRoleLeases();
  const now = Date.now();
  const leaseSummary = [];
  for (const role of ['WORKER', 'SCHEDULER']) {
    const matches = leases.filter(lease => lease.role === role && lease.status === 'ACTIVE');
    if (matches.length !== 1) fail('GUARDED_RELEASE_ACTIVE_LEASE_COUNT_INVALID', role);
    const lease = matches[0];
    if (Date.parse(lease.expiresAt || lease.leaseExpiresAt || '') <= now) {
      fail('GUARDED_RELEASE_LEASE_STALE', role);
    }
    const heartbeatAt = Date.parse(lease.heartbeatAt || '');
    if (!Number.isFinite(heartbeatAt)) {
      fail('GUARDED_RELEASE_LEASE_HEARTBEAT_INVALID', role);
    }
    const heartbeatAgeMs = Math.max(0, now - heartbeatAt);
    if (heartbeatAgeMs > DEFAULT_ROLE_HEARTBEAT_FRESHNESS_MS) {
      fail('GUARDED_RELEASE_LEASE_HEARTBEAT_STALE', role);
    }
    if (String(lease.releaseId || '').toLowerCase() !== release) {
      fail('GUARDED_RELEASE_LEASE_IDENTITY_MISMATCH', role);
    }
    if (!Number.isInteger(lease.fencingToken) || lease.fencingToken <= 0) {
      fail('GUARDED_RELEASE_LEASE_FENCE_INVALID', role);
    }
    const expectedProcess = processByRole[role];
    const expectedPid = Number(expectedProcess?.pid || 0);
    const leasePid = Number(lease.pid || 0);
    if (!Number.isInteger(leasePid) || leasePid <= 0) {
      fail('GUARDED_RELEASE_LEASE_PID_INVALID', role);
    }
    if (!Number.isInteger(expectedPid) || expectedPid <= 0 || leasePid !== expectedPid) {
      fail('GUARDED_RELEASE_LEASE_PID_MISMATCH', `${role}:${leasePid}:${expectedPid}`);
    }
    leaseSummary.push({
      role,
      status: lease.status,
      pid: leasePid,
      pm2Pid: expectedPid,
      releaseId: lease.releaseId,
      heartbeatAt: lease.heartbeatAt,
      heartbeatAgeMs,
      expiresAt: lease.expiresAt,
      fencingToken: lease.fencingToken,
    });
  }
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    release,
    processes: processResult.safeSummary,
    leases: leaseSummary,
  }, null, 2)}\n`);
}

async function verifyHealth(release, urls) {
  if (urls.length !== 2) fail('GUARDED_RELEASE_HEALTH_URLS_REQUIRED');
  const results = [];
  for (const urlValue of urls) {
    let url;
    try {
      url = new URL(urlValue);
    } catch {
      fail('GUARDED_RELEASE_HEALTH_URL_INVALID');
    }
    if (!['http:', 'https:'].includes(url.protocol)) fail('GUARDED_RELEASE_HEALTH_PROTOCOL_INVALID');
    const response = await fetch(url, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) fail('GUARDED_RELEASE_HEALTH_HTTP_STATUS', `${url.origin}:${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      fail('GUARDED_RELEASE_HEALTH_JSON_INVALID', url.origin);
    }
    if (body.releaseMismatch !== false) fail('GUARDED_RELEASE_HEALTH_MISMATCH_REPORTED', url.origin);
    const identities = {
      embeddedBuildId: body.embeddedBuildId,
      runtimeReleaseId: body.runtimeReleaseId,
      gitCommitSha: body.gitCommitSha,
      publicBuildId: body.publicBuildId,
    };
    for (const [field, value] of Object.entries(identities)) {
      if (String(value || '').toLowerCase() !== release) {
        fail('GUARDED_RELEASE_HEALTH_IDENTITY_MISMATCH', `${url.origin}:${field}`);
      }
    }
    results.push({
      origin: url.origin,
      status: response.status,
      releaseMismatch: body.releaseMismatch,
      identities,
    });
  }
  process.stdout.write(`${JSON.stringify({ status: 'PASS', release, health: results }, null, 2)}\n`);
}

function verifyManifest(release) {
  const manifestPath = path.join(process.cwd(), '.sandeal-build-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('GUARDED_RELEASE_BUILD_MANIFEST_MISSING');
  }
  if (manifest.schemaVersion !== 1 || String(manifest.commitSha || '').toLowerCase() !== release) {
    fail('GUARDED_RELEASE_BUILD_MANIFEST_MISMATCH');
  }
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    release,
    buildManifest: {
      schemaVersion: manifest.schemaVersion,
      commitSha: manifest.commitSha,
    },
  }, null, 2)}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'manifest') {
    verifyManifest(expectedRelease(process.argv[3]));
    return;
  }
  if (command === 'health') {
    await verifyHealth(expectedRelease(process.argv[3]), process.argv.slice(4));
    return;
  }
  if (command === 'data-directory') {
    const processes = await readPm2Processes();
    process.stdout.write(`${sharedDataDirectory(processes)}\n`);
    return;
  }
  if (command === 'processes') {
    const processes = await readPm2Processes();
    const result = verifyPm2Processes(processes, expectedRelease(process.argv[3]), true);
    process.stdout.write(`${JSON.stringify({ status: 'PASS', processes: result.safeSummary }, null, 2)}\n`);
    return;
  }
  if (command === 'runtime') {
    await verifyRuntime(await readPm2Processes(), expectedRelease(process.argv[3]));
    return;
  }
  fail('GUARDED_RELEASE_VERIFY_COMMAND_INVALID');
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'GUARDED_RELEASE_VERIFICATION_FAILED'}\n`);
  process.exitCode = 1;
});
