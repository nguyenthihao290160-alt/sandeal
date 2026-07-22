/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const tempDir = path.join(root, '.test-tmp', `prompt10-runtime-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
process.env.SANDEAL_DATA_DIR = tempDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0; let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const guardian = require('../src/lib/automation/runtimeGuardian.ts');
  const store = require('../src/lib/automation/store.ts');
  const scheduler = require('../src/lib/automation/scheduler.ts');
  const worker = require('../src/lib/automation/worker.ts');
  const settings = require('../src/lib/storage/automationSettings.ts');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_RUNTIME'); };

  async function reset() {
    for (const collection of [
      'runtime-role-leases', 'runtime-role-conflicts', 'runtime-health', 'automation-jobs', 'automation-control', 'automation-audit',
      'automation-slo-snapshots', 'automation-canary', 'publication-audit', 'automation-outbound-events', 'products',
    ]) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({ mode: 'SHADOW', effectiveMode: 'SHADOW', publishPaused: false, ingestionPaused: false, workerPaused: false, schedulerPaused: false, killSwitch: false }, 'runtime-test');
  }

  await test('PM2 keeps Prompt 10 runtime disabled by default and enables exactly one opt-in worker and scheduler', () => {
    const configPath = require.resolve('../ecosystem.config.cjs');
    const previous = process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME;
    delete process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME;
    delete require.cache[configPath];
    const safeConfig = require(configPath);
    assert.deepEqual(safeConfig.apps.map(app => app.name), ['sandeal']);
    process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME = 'true';
    delete require.cache[configPath];
    const config = require(configPath);
    if (previous === undefined) delete process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME;
    else process.env.SANDEAL_ENABLE_PROMPT10_RUNTIME = previous;
    delete require.cache[configPath];
    assert.deepEqual(config.apps.map(app => app.name), ['sandeal', 'sandeal-worker', 'sandeal-scheduler']);
    assert.equal(new Set(config.apps.map(app => app.cwd)).size, 1);
    assert.equal(new Set(config.apps.map(app => app.env.SANDEAL_DATA_DIR)).size, 1);
    for (const app of config.apps) {
      assert.equal(app.exec_mode, 'fork'); assert.equal(app.instances, 1); assert.equal(app.autorestart, true);
      assert.ok(app.restart_delay >= 1000); assert.ok(app.min_uptime); assert.ok(app.max_restarts > 0);
      assert.ok(app.kill_timeout >= 5000); assert.ok(app.max_memory_restart); assert.ok(app.log_date_format);
      assert.equal(Object.keys(app.env).some(key => /secret|token|password|api.?key/i.test(key)), false);
    }
  });

  await test('worker role lease rejects a concurrent holder and permits stale takeover', async () => {
    await reset(); const base = Date.now();
    const first = await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'worker-a', instanceId: 'worker-a:instance-1', now: base, leaseMs: 5000 });
    assert.equal(first.acquired, true); assert.equal(first.event, 'ACQUIRED'); assert.ok(first.ownership);
    const duplicate = await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'worker-b', instanceId: 'worker-b:instance-1', now: base + 1, leaseMs: 5000 });
    assert.equal(duplicate.acquired, false); assert.equal(duplicate.reason, 'ROLE_ALREADY_ACTIVE');
    assert.equal(await roles.heartbeatRuntimeRole('WORKER', { ownerId: 'worker-b', instanceId: 'worker-b:instance-1', fencingToken: 1 }, 5000, base + 2), false);
    const takeover = await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'worker-b', instanceId: 'worker-b:instance-1', now: base + 5001, leaseMs: 5000 });
    assert.equal(takeover.acquired, true); assert.equal(takeover.event, 'TAKEN_OVER');
    assert.equal(takeover.lease.previousHolderId, 'worker-a'); assert.equal(takeover.lease.takeoverCount, 1);
    assert.ok(takeover.lease.fencingToken > first.lease.fencingToken);
    assert.equal(await roles.heartbeatRuntimeRole('WORKER', first.ownership, 5000, base + 5002), false);
    assert.equal(await roles.releaseRuntimeRole('WORKER', first.ownership, base + 5002), false);
    assert.equal(await roles.releaseRuntimeRole('WORKER', takeover.ownership, base + 5002), true);
  });

  await test('scheduler role lease independently enforces one JSON-storage scheduler', async () => {
    await reset(); const now = Date.now();
    assert.equal((await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'scheduler-a', instanceId: 'scheduler-a:1', now })).acquired, true);
    assert.equal((await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'scheduler-b', instanceId: 'scheduler-b:1', now: now + 1 })).acquired, false);
  });

  await test('near-concurrent scheduler acquire elects exactly one fenced leader', async () => {
    await reset(); const now = Date.now();
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => roles.acquireRuntimeRole({
      role: 'SCHEDULER', ownerId: `scheduler-${index}`, instanceId: `scheduler-${index}:instance`, now,
    })));
    assert.equal(attempts.filter(item => item.acquired).length, 1);
    assert.equal(new Set(attempts.filter(item => item.acquired).map(item => item.lease.fencingToken)).size, 1);
  });

  await test('worker backs off from a live role without PM2 restart spam and scheduler rejects its duplicate', async () => {
    await reset(); const now = Date.now();
    await roles.acquireRuntimeRole({ role: 'WORKER', ownerId: 'held-worker', instanceId: 'held-worker:1', now, leaseMs: 45_000 });
    await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'held-scheduler', instanceId: 'held-scheduler:1', now, leaseMs: 45_000 });
    const env = { ...process.env, SANDEAL_DATA_DIR: tempDir, NODE_ENV: 'test' };
    const workerResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'automation-worker.cjs'), '--once'], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const schedulerResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'automation-scheduler.cjs'), '--once'], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(workerResult.status, 0, workerResult.stderr); assert.match(workerResult.stderr, /worker_role_wait/); assert.match(workerResult.stderr, /ROLE_ALREADY_ACTIVE/);
    assert.equal(workerResult.stdout.includes('worker_tick'), false);
    assert.notEqual(schedulerResult.status, 0); assert.match(schedulerResult.stderr, /scheduler_role_rejected/); assert.match(schedulerResult.stderr, /SCHEDULER_ROLE_ALREADY_ACTIVE/);
    assert.equal(schedulerResult.stdout.includes('scheduler_tick'), false);
  });

  await test('one-shot entrypoints acquire and release their roles cleanly', async () => {
    await reset();
    const env = { ...process.env, SANDEAL_DATA_DIR: tempDir, NODE_ENV: 'test' };
    const workerResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'automation-worker.cjs'), '--once'], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(workerResult.status, 0, workerResult.stderr); assert.match(workerResult.stdout, /worker_idle/);
    const schedulerResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'automation-scheduler.cjs'), '--once'], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(schedulerResult.status, 0, schedulerResult.stderr); assert.match(schedulerResult.stdout, /scheduler_role_acquired/); assert.match(schedulerResult.stdout, /scheduler_tick/); assert.match(schedulerResult.stdout, /scheduler_role_released/); assert.match(schedulerResult.stdout, /scheduler_shutdown/);
    const leases = await roles.listRuntimeRoleLeases();
    assert.equal(leases.find(item => item.role === 'WORKER').status, 'RELEASED');
    assert.equal(leases.find(item => item.role === 'SCHEDULER').status, 'RELEASED');
  });

  await test('SIGTERM wakes scheduler wait, stops new ticks, and releases the owned lease', async () => {
    await reset();
    const env = { ...process.env, SANDEAL_DATA_DIR: tempDir, NODE_ENV: 'test' };
    const entry = path.join(root, 'scripts', 'automation-scheduler.cjs');
    const wrapper = `setTimeout(() => process.emit('SIGTERM'), 250); require(${JSON.stringify(entry)});`;
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ['-e', wrapper], { cwd: root, env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.ok(Date.now() - startedAt < 10_000);
    assert.match(result.stdout, /"type":"scheduler_shutdown".*"phase":"requested".*"signal":"SIGTERM"/);
    assert.match(result.stdout, /"type":"scheduler_role_released"/);
    assert.match(result.stdout, /"type":"scheduler_shutdown".*"phase":"completed".*"signal":"SIGTERM".*"released":true/);
  });

  await test('scheduler without current ownership cannot enqueue any job', async () => {
    await reset(); const now = Date.now();
    await roles.acquireRuntimeRole({ role: 'SCHEDULER', ownerId: 'scheduler-leader', instanceId: 'scheduler-leader:1', now });
    const result = await scheduler.runOwnedSchedulerCycle({ ownerId: 'scheduler-contender', instanceId: 'scheduler-contender:1', fencingToken: 99 }, now + 1);
    assert.equal(result.status, 'role_lost'); assert.equal((await store.getAllAutomationJobs()).length, 0);
  });

  await test('Guardian reports healthy active roles without pausing ingestion', async () => {
    await reset(); const now = Date.now();
    await roles.acquireRuntimeRole({ role: 'WORKER', holderId: 'worker-healthy', now });
    await roles.acquireRuntimeRole({ role: 'SCHEDULER', holderId: 'scheduler-healthy', now });
    await store.updateAutomationControl({ workerHeartbeatAt: new Date(now).toISOString(), schedulerHeartbeatAt: new Date(now).toISOString() }, 'runtime-test');
    const snapshot = await guardian.runRuntimeGuardian({ apply: false, now: now + 100, webAlive: true, publicRouteHealthy: true, schedulerEnabled: true, providers: { accessTrade: 'ready', gemini: 'not_configured' } });
    assert.equal(snapshot.worker.status, 'active'); assert.equal(snapshot.scheduler.status, 'active'); assert.equal(snapshot.web.status, 'ready');
    assert.equal(snapshot.publishSafe, true, JSON.stringify(snapshot.reasons)); assert.equal(snapshot.recommendation.pauseIngestion, false);
  });

  await test('duplicate role conflict degrades only publish lane', async () => {
    await reset(); const now = Date.now();
    await roles.acquireRuntimeRole({ role: 'WORKER', holderId: 'worker-a', now });
    await roles.acquireRuntimeRole({ role: 'SCHEDULER', holderId: 'scheduler-a', now });
    await roles.acquireRuntimeRole({ role: 'WORKER', holderId: 'worker-duplicate', now: now + 1 });
    const snapshot = await guardian.runRuntimeGuardian({ apply: true, now: now + 2, webAlive: true, publicRouteHealthy: true, schedulerEnabled: true });
    assert.ok(snapshot.reasons.includes('DUPLICATE_PROCESS_ROLE'));
    const control = await store.getAutomationControl();
    assert.equal(control.publishPaused, true); assert.equal(control.ingestionPaused, false); assert.equal(control.effectiveMode, 'SHADOW');
  });

  await test('Guardian apply delegates one persisted downgrade per SLO time bucket', async () => {
    await reset();
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
    await store.updateAutomationControl({ mode: 'AUTONOMOUS', effectiveMode: 'AUTONOMOUS', publishPaused: false }, 'runtime-integration-test');
    await roles.acquireRuntimeRole({ role: 'WORKER', holderId: 'worker-slo-integration', now });
    await roles.acquireRuntimeRole({ role: 'SCHEDULER', holderId: 'scheduler-slo-integration', now });

    const first = await guardian.runRuntimeGuardian({
      apply: true,
      now: now + 1_000,
      webAlive: true,
      publicRouteHealthy: true,
      schedulerEnabled: true,
      providers: { accessTrade: 'degraded' },
    });
    assert.ok(first.reasons.includes('PROVIDER_DEGRADED'));
    const afterFirst = await store.getAutomationControl();
    assert.equal(afterFirst.mode, 'AUTONOMOUS'); assert.equal(afterFirst.effectiveMode, 'CANARY');
    assert.equal(afterFirst.publishPaused, true); assert.equal(afterFirst.ingestionPaused, false);

    await guardian.runRuntimeGuardian({
      apply: true,
      now: now + 2_000,
      webAlive: true,
      publicRouteHealthy: true,
      schedulerEnabled: true,
      providers: { accessTrade: 'degraded' },
    });
    const afterSecond = await store.getAutomationControl();
    assert.equal(afterSecond.effectiveMode, 'CANARY', 'same persisted SLO bucket must not downgrade twice');
    const snapshots = await adapter.readCollection('automation-slo-snapshots');
    assert.equal(snapshots.length, 1); assert.equal(snapshots[0].evaluation.status, 'BREACH');
    assert.ok(snapshots[0].evaluation.reasons.includes('RUNTIME_GUARDIAN_UNSAFE'));
    assert.equal(snapshots[0].application.status, 'APPLIED'); assert.equal(snapshots[0].application.nextEffectiveMode, 'CANARY');
    const guardianControlWrites = (await adapter.readCollection('automation-audit'))
      .filter(event => event.operationType === 'CONTROL_CHANGED' && event.actor === 'runtime-guardian');
    assert.equal(guardianControlWrites.length, 1);
  });

  await test('expired role heartbeats are stale rather than falsely active', async () => {
    await reset(); const now = Date.now();
    await roles.acquireRuntimeRole({ role: 'WORKER', holderId: 'worker-stale', now, leaseMs: 5000 });
    await roles.acquireRuntimeRole({ role: 'SCHEDULER', holderId: 'scheduler-stale', now, leaseMs: 5000 });
    const snapshot = await guardian.runRuntimeGuardian({ apply: false, now: now + 5001, webAlive: true, publicRouteHealthy: true, schedulerEnabled: true });
    assert.equal(snapshot.worker.status, 'stale'); assert.equal(snapshot.scheduler.status, 'stale'); assert.equal(snapshot.publishSafe, false);
  });

  await test('provider configured state is never presented as ready', () => {
    assert.equal(guardian.providerHealth({ configured: false, adapterAvailable: true }), 'not_configured');
    assert.equal(guardian.providerHealth({ configured: true, adapterAvailable: true }), 'configured');
    assert.equal(guardian.providerHealth({ configured: true, adapterAvailable: false }), 'adapter_unavailable');
    assert.equal(guardian.providerHealth({ configured: true, adapterAvailable: true, ready: true }), 'ready');
  });

  await test('scheduler control-plane bucket creates one Guardian job across restarts', async () => {
    await reset(); const now = Date.parse('2026-07-16T03:00:00.000Z');
    const first = await scheduler.runRuntimeControlSchedulerTick(now);
    const second = await scheduler.runRuntimeControlSchedulerTick(now + 10_000);
    assert.equal(first.status, 'scheduled'); assert.equal(second.status, 'duplicate'); assert.equal(first.jobId, second.jobId);
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'RUNTIME_GUARDIAN').length, 1);
  });

  await test('automation scheduler is idempotent for a time bucket and has bounded catch-up', async () => {
    await reset(); const now = Date.parse('2026-07-16T04:00:00.000Z');
    await settings.updateAutomationSettings({ enabled: true, intervalHours: 6 });
    await store.updateAutomationControl({ workerHeartbeatAt: new Date(now).toISOString(), schedulerPaused: false, schedulerNextRunAt: undefined }, 'runtime-test');
    const first = await scheduler.runAutomationSchedulerTick(now);
    const notDue = await scheduler.runAutomationSchedulerTick(now + 1000);
    await store.updateAutomationControl({ schedulerNextRunAt: new Date(0).toISOString() }, 'runtime-restart');
    const replay = await scheduler.runAutomationSchedulerTick(now + 2000);
    assert.equal(first.status, 'scheduled'); assert.equal(notDue.status, 'not_due'); assert.equal(replay.status, 'duplicate');
    assert.equal((await store.getAllAutomationJobs()).filter(job => job.type === 'AUTO_PILOT').length, 1);
  });

  await test('alive scheduler records heartbeat even when worker is missing', async () => {
    await reset(); const now = Date.now();
    const result = await scheduler.runAutomationSchedulerTick(now);
    assert.equal(result.status, 'worker_stale');
    assert.equal((await store.getAutomationControl()).schedulerHeartbeatAt, new Date(now).toISOString());
  });

  await test('Emergency Stop keeps diagnostic Guardian jobs executable', async () => {
    await reset();
    await store.updateAutomationControl({ killSwitch: true, mode: 'EMERGENCY_STOP', effectiveMode: 'SHADOW', workerPaused: false }, 'runtime-test');
    const job = await store.createAutomationJob({ type: 'RUNTIME_GUARDIAN', payload: {}, idempotencyKey: 'runtime-emergency-diagnostics', requestedBy: 'scheduler' });
    const result = await worker.processAutomationBatch('runtime-emergency-worker', 1);
    assert.equal(result.succeeded, 1, JSON.stringify(await store.getAutomationJob(job.job.id)));
    assert.equal((await store.getAutomationJob(job.job.id)).status, 'SUCCEEDED');
  });

  await test('idle claim does not rewrite the durable job collection', async () => {
    await reset();
    const jobsPath = path.join(tempDir, 'automation-jobs.json');
    const before = fs.statSync(jobsPath).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await store.claimAutomationJobs('idle-worker', 2), []);
    const after = fs.statSync(jobsPath).mtimeMs;
    assert.equal(after, before);
  });

  console.log(`\nPROMPT10 Gate 2 runtime: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, tempDir)}`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
