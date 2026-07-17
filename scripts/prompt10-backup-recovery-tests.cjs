/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const testRoot = path.join(root, '.test-tmp', `prompt10-backup-recovery-${runId}`);
const dataDir = path.join(testRoot, 'data');
const snapshotSource = path.join(testRoot, 'snapshot-source');
const snapshotOutput = path.join(testRoot, 'snapshot-output');
const restoreDir = path.join(testRoot, 'restore-empty');
const nonEmptyRestoreDir = path.join(testRoot, 'restore-non-empty');
const guardianRecoverableDir = path.join(testRoot, 'guardian-recoverable');
const guardianBlockedDir = path.join(testRoot, 'guardian-blocked');
const modeDataDir = path.join(testRoot, 'mode-data');
const modeBackupDir = path.join(testRoot, 'mode-backups');
for (const directory of [testRoot, dataDir, snapshotSource, snapshotOutput, guardianRecoverableDir, guardianBlockedDir, modeDataDir, modeBackupDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.SANDEAL_DATA_DIR = dataDir;
process.env.SANDEAL_BACKUP_DIR = modeBackupDir;
process.env.NODE_ENV = 'test';
process.env.ALLOW_PAID_AI = 'false';
process.env.BASIC_AUTH_ENABLED = 'true';
process.env.BASIC_AUTH_USER = 'prompt10-backup-test';
process.env.BASIC_AUTH_PASSWORD = 'fixture-not-a-real-secret-1';
process.env.SANDEAL_ADMIN_PERMISSIONS = '*';
require('./register-typescript.cjs');

const auth = `Basic ${Buffer.from('prompt10-backup-test:fixture-not-a-real-secret-1').toString('base64')}`;
let passed = 0;
let failed = 0;
async function test(name, work) {
  try { await work(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
}

function writeJson(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const backups = require('../src/lib/autonomous/backupManager.ts');
  const guardian = require('../src/lib/automation/runtimeGuardian.ts');
  const roles = require('../src/lib/automation/runtimeRoles.ts');
  const store = require('../src/lib/automation/store.ts');
  const controlRoute = require('../src/app/api/automation/control/route.ts');
  const { NextRequest } = require('next/server');
  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_PROMPT10_BACKUP_TESTS'); };

  async function initializeRuntime(directory, now) {
    process.env.SANDEAL_DATA_DIR = directory;
    for (const collection of [
      'products', 'automation-jobs', 'automation-control', 'automation-audit', 'candidate-queue', 'operation-journal',
      'publication-audit', 'automation-outbound-events', 'evidence-facts', 'automation-canary', 'runtime-health',
      'runtime-role-leases', 'runtime-role-conflicts', 'automation-slo-snapshots',
    ]) await adapter.writeCollection(collection, []);
    await store.updateAutomationControl({
      mode: 'AUTONOMOUS', effectiveMode: 'AUTONOMOUS', publishPaused: false, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false,
    }, 'backup-recovery-test');
    await roles.acquireRuntimeRole({ role: 'WORKER', holderId: `worker-${path.basename(directory)}`, now });
    await roles.acquireRuntimeRole({ role: 'SCHEDULER', holderId: `scheduler-${path.basename(directory)}`, now });
  }

  async function guardianProbe(directory, corruptBackup, now) {
    await initializeRuntime(directory, now);
    await adapter.writeCollection('products', [{ id: 'backup-version-one', status: 'draft' }]);
    await adapter.writeCollection('products', [{ id: 'backup-version-two', status: 'draft' }]);
    const mainFile = path.join(directory, 'products.json');
    const backupFile = `${mainFile}.bak`;
    fs.writeFileSync(mainFile, '{broken-main', 'utf8');
    if (corruptBackup) fs.writeFileSync(backupFile, '{broken-backup', 'utf8');
    const snapshot = await guardian.runRuntimeGuardian({
      apply: true,
      now: now + 1_000,
      webAlive: true,
      publicRouteHealthy: true,
      schedulerEnabled: true,
      providers: { accessTrade: 'ready' },
    });
    return { snapshot, control: await store.getAutomationControl() };
  }

  function modeRequest(mode) {
    return new NextRequest('http://localhost/api/automation/control', {
      method: 'PATCH',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_mode', mode, confirmed: true, reason: `Controlled ${mode} backup verification` }),
    });
  }

  await test('missing files in a fresh isolated data directory are healthy empty collections', async () => {
    const freshDir = path.join(testRoot, 'fresh-empty');
    fs.mkdirSync(freshDir, { recursive: true });
    assert.equal(await backups.verifyCollectionRecovery('products', freshDir), 'FRESH_EMPTY');
    const inspection = await backups.inspectCriticalStorage(freshDir, undefined, Date.now());
    assert.equal(inspection.status, 'healthy');
    assert.equal(inspection.blocked.length, 0); assert.equal(inspection.recoverable.length, 0);
    assert.ok(inspection.freshEmpty.includes('products'));
  });

  await test('snapshot checksum manifest, empty-target restore, and retention index preserve evidence without deletion', async () => {
    writeJson(snapshotSource, 'products.json', [{ id: 'snapshot-product' }]);
    writeJson(snapshotSource, 'automation-jobs.json', [{ id: 'snapshot-job', status: 'PENDING' }]);
    writeJson(snapshotSource, 'automation-settings.json', { enabled: true, intervalMinutes: 15 });
    writeJson(snapshotSource, 'token-vault.json', [{ id: 'excluded-sensitive-fixture' }]);
    const base = Date.parse('2026-07-16T05:00:00.000Z');
    const snapshots = [];
    for (let index = 0; index < 3; index += 1) {
      snapshots.push(await backups.createStorageSnapshot({
        sourceDir: snapshotSource,
        outputDir: snapshotOutput,
        reason: 'test',
        retention: 1,
        now: base + index * 60_000,
      }));
    }
    const latest = snapshots[2];
    const manifest = await backups.verifyStorageSnapshot(latest.directory);
    assert.equal(manifest.files.length, 3); assert.ok(manifest.excluded.includes('token-vault.json'));
    assert.equal(manifest.files.find(file => file.name === 'automation-settings.json').records, null);
    assert.equal(fs.existsSync(path.join(latest.directory, 'data', 'token-vault.json')), false);
    const restored = await backups.restoreSnapshotToIsolatedDirectory(latest.directory, restoreDir);
    assert.equal(restored.restored, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restoreDir, 'products.json'), 'utf8')), [{ id: 'snapshot-product' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restoreDir, 'automation-settings.json'), 'utf8')), { enabled: true, intervalMinutes: 15 });

    const retention = JSON.parse(fs.readFileSync(path.join(snapshotOutput, 'retention-index.json'), 'utf8'));
    assert.equal(retention.keep.length, 1); assert.equal(retention.expiredCandidates.length, 2);
    for (const item of retention.expiredCandidates) assert.equal(fs.existsSync(path.join(snapshotOutput, item)), true, 'retention must not delete snapshots');
    fs.mkdirSync(nonEmptyRestoreDir, { recursive: true });
    fs.writeFileSync(path.join(nonEmptyRestoreDir, 'existing.txt'), 'do-not-overwrite', 'utf8');
    await assert.rejects(() => backups.restoreSnapshotToIsolatedDirectory(latest.directory, nonEmptyRestoreDir), /RESTORE_TARGET_NOT_EMPTY/);

    const tamperedFile = path.join(snapshots[0].directory, 'data', 'products.json');
    fs.writeFileSync(tamperedFile, '[]\n', 'utf8');
    await assert.rejects(() => backups.verifyStorageSnapshot(snapshots[0].directory), /BACKUP_FILE_CHECKSUM_MISMATCH/);
  });

  await test('corrupt main with valid backup is recoverable; corruption of both copies is blocked', async () => {
    process.env.SANDEAL_DATA_DIR = dataDir;
    await adapter.writeCollection('recovery-fixture', [{ id: 'first' }]);
    await adapter.writeCollection('recovery-fixture', [{ id: 'second' }]);
    const mainFile = path.join(dataDir, 'recovery-fixture.json');
    const backupFile = `${mainFile}.bak`;
    fs.writeFileSync(mainFile, '{broken-main', 'utf8');
    const recoverable = await backups.inspectCollectionRecovery('recovery-fixture', dataDir);
    assert.equal(recoverable.status, 'RECOVERABLE_FROM_BACKUP');
    assert.equal(recoverable.main, 'INVALID'); assert.equal(recoverable.backup, 'VALID');
    fs.writeFileSync(backupFile, '{broken-backup', 'utf8');
    assert.equal(await backups.verifyCollectionRecovery('recovery-fixture', dataDir), 'BLOCKED');
  });

  await test('Guardian marks recoverable critical storage degraded and fail-closes only publishing', async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
    const { snapshot, control } = await guardianProbe(guardianRecoverableDir, false, now);
    assert.equal(snapshot.storage.status, 'degraded');
    assert.ok(snapshot.storage.criticalCollections.recoverable.includes('products'));
    assert.ok(snapshot.reasons.includes('STORAGE_DEGRADED'));
    assert.equal(control.mode, 'AUTONOMOUS'); assert.equal(control.effectiveMode, 'CANARY');
    assert.equal(control.publishPaused, true); assert.equal(control.ingestionPaused, false);
  });

  await test('Guardian reports both corrupt copies BLOCKED and SLO fail-closes publishing', async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
    const { snapshot, control } = await guardianProbe(guardianBlockedDir, true, now);
    assert.equal(snapshot.storage.status, 'blocked');
    assert.ok(snapshot.storage.criticalCollections.blocked.includes('products'));
    assert.ok(snapshot.reasons.includes('STORAGE_BLOCKED'));
    assert.equal(control.mode, 'AUTONOMOUS'); assert.equal(control.effectiveMode, 'CANARY');
    assert.equal(control.publishPaused, true); assert.equal(control.ingestionPaused, false);
    const sloSnapshots = JSON.parse(fs.readFileSync(path.join(guardianBlockedDir, 'automation-slo-snapshots.json'), 'utf8'));
    assert.ok(sloSnapshots[0].evaluation.reasons.includes('RUNTIME_GUARDIAN_UNSAFE'));
  });

  await test('pre-CANARY snapshot is verified, source-state idempotent, and repeated mode PATCH does not create backup spam', async () => {
    process.env.SANDEAL_DATA_DIR = modeDataDir;
    process.env.SANDEAL_BACKUP_DIR = modeBackupDir;
    for (const collection of ['products', 'automation-control', 'automation-audit']) await adapter.writeCollection(collection, []);
    await adapter.writeCollection('products', [{ id: 'mode-product', status: 'draft' }]);
    await store.updateAutomationControl({
      mode: 'OBSERVE', effectiveMode: 'OBSERVE', publishPaused: true, ingestionPaused: false,
      workerPaused: false, schedulerPaused: false, killSwitch: false,
    }, 'backup-mode-test');
    const first = await backups.ensurePreCanarySnapshot({ sourceDir: modeDataDir, outputDir: modeBackupDir, targetMode: 'CANARY', now: Date.now() });
    const replay = await backups.ensurePreCanarySnapshot({ sourceDir: modeDataDir, outputDir: modeBackupDir, targetMode: 'CANARY', now: Date.now() + 1_000 });
    assert.equal(first.created, true); assert.equal(replay.created, false); assert.equal(replay.manifest.id, first.manifest.id);

    const response = await controlRoute.PATCH(modeRequest('CANARY'));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal((await response.json()).data.mode, 'CANARY');
    assert.equal((await controlRoute.PATCH(modeRequest('CANARY'))).status, 200);
    const snapshotDirectories = fs.readdirSync(modeBackupDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('snapshot-'));
    assert.equal(snapshotDirectories.length, 1);
  });

  await test('CANARY or AUTONOMOUS mode mutation returns 503 and leaves control unchanged when backup fails', async () => {
    process.env.SANDEAL_DATA_DIR = modeDataDir;
    process.env.SANDEAL_BACKUP_DIR = modeBackupDir;
    await store.updateAutomationControl({ mode: 'OBSERVE', effectiveMode: 'OBSERVE', publishPaused: true, ingestionPaused: false }, 'backup-failure-test');
    const before = await store.getAutomationControl();
    const mainFile = path.join(modeDataDir, 'products.json');
    fs.writeFileSync(mainFile, '{corrupt-pre-canary-source', 'utf8');
    fs.writeFileSync(`${mainFile}.bak`, '{corrupt-pre-canary-backup', 'utf8');
    const response = await controlRoute.PATCH(modeRequest('AUTONOMOUS'));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'PRE_CANARY_BACKUP_FAILED');
    const after = await store.getAutomationControl();
    assert.equal(after.mode, before.mode); assert.equal(after.effectiveMode, before.effectiveMode);
    assert.equal(after.updatedAt, before.updatedAt);
  });

  console.log(`\nPROMPT10 Gate 6 backup/recovery: ${passed} passed, ${failed} failed`);
  console.log(`Isolated artifacts: ${path.relative(root, testRoot)}`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
