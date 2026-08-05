/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');

require('./register-typescript.cjs');

const { reconcileUnhealthySources } = require('../src/lib/commerce/sourceReconciliation.ts');
const { restoreSnapshotToIsolatedDirectory, verifyStorageSnapshot } = require('../src/lib/autonomous/backupManager.ts');

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length).trim() || '';
}

async function main() {
  const verifySnapshot = option('verify-snapshot');
  const restoreSnapshot = option('restore-snapshot');
  if (verifySnapshot || restoreSnapshot) {
    if (process.argv.includes('--apply')) throw new Error('SNAPSHOT_UTILITY_REJECTS_APPLY_FLAG');
    const snapshot = path.resolve(verifySnapshot || restoreSnapshot);
    if (restoreSnapshot) {
      const targetValue = option('target');
      if (!targetValue) throw new Error('SNAPSHOT_RESTORE_REQUIRES_EMPTY_TARGET');
      const restored = await restoreSnapshotToIsolatedDirectory(snapshot, path.resolve(targetValue));
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        type: 'source_reliability_snapshot_restored_isolated',
        snapshot,
        target: path.resolve(targetValue),
        files: restored.restored,
        checksum: restored.manifest.checksum,
        liveStorageOverwritten: false,
      }, null, 2)}\n`);
      return;
    }
    const manifest = await verifyStorageSnapshot(snapshot);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      type: 'source_reliability_snapshot_verified',
      snapshot,
      id: manifest.id,
      files: manifest.files.length,
      checksum: manifest.checksum,
    }, null, 2)}\n`);
    return;
  }

  const expectedReleaseId = option('expected-release');
  if (!expectedReleaseId) throw new Error('SOURCE_RECONCILIATION_EXPECTED_RELEASE_REQUIRED');
  const result = await reconcileUnhealthySources({
    apply: process.argv.includes('--apply'),
    expectedReleaseId,
    repositoryRoot: path.resolve(__dirname, '..'),
    backupDir: option('backup-dir') || undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    type: 'source_reliability_reconciliation_blocked',
    reasonCode: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
  })}\n`);
  process.exitCode = 1;
});
