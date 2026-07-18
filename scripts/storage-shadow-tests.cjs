/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-storage-shadow-'));
const actualDataDir = path.join(root, '.data');
const actualDataMetadata = fs.existsSync(actualDataDir)
  ? { mtimeMs: fs.statSync(actualDataDir).mtimeMs, count: fs.readdirSync(actualDataDir).length }
  : null;

process.env.NODE_ENV = 'test';
require('./register-typescript.cjs');

const mongoClientPath = require.resolve('../src/lib/storage/mongoClient.ts');
const { checksumCollection } = require('../src/lib/storage/migrationChecksum.ts');
const {
  createMongoLogicalBackup,
  readMongoLogicalBackup,
  verifyMongoLogicalBackup,
} = require('../src/lib/storage/mongoLogicalBackup.ts');
const { MongoRestoreError, restoreMongoLogicalBackup } = require('../src/lib/storage/mongoRestore.ts');
const { evaluateRollbackReadiness } = require('../src/lib/storage/rollbackReadiness.ts');
const { validateShadow } = require('../src/lib/storage/shadowValidation.ts');

let passed = 0;
let failed = 0;
let fixtureCounter = 0;
let networkCalls = 0;
global.fetch = async () => {
  networkCalls += 1;
  throw new Error('NETWORK_FORBIDDEN_IN_SHADOW_TESTS');
};

async function test(name, work) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function fixture(files) {
  const directory = path.join(tempRoot, `fixture-${fixtureCounter++}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  }
  return directory;
}

class FakeShadowReader {
  constructor(collections = {}, schema = {}) {
    this.collections = new Map(Object.entries(collections).map(([name, value]) => [name, structuredClone(value)]));
    this.schema = {
      version: 1,
      expectedVersion: 1,
      ready: true,
      indexReady: true,
      missingIndexes: [],
      ...schema,
    };
    this.collectionReads = 0;
    this.schemaReads = 0;
  }
  async inspectCollection(collection) {
    this.collectionReads += 1;
    if (this.collectionError) throw this.collectionError;
    return {
      exists: this.collections.has(collection),
      items: structuredClone(this.collections.get(collection) || []),
    };
  }
  async inspectSchema() {
    this.schemaReads += 1;
    if (this.schemaError) throw this.schemaError;
    return structuredClone(this.schema);
  }
}

async function shadow(sourceCollections, targetCollections, options = {}) {
  const source = options.source || new FakeShadowReader(sourceCollections);
  const target = options.target || new FakeShadowReader(targetCollections, options.schema);
  const report = await validateShadow({
    source,
    target,
    collections: options.collections || [{ collection: 'products' }],
    maxDifferences: options.maxDifferences,
    timeoutMs: options.timeoutMs,
    now: () => new Date('2026-07-18T00:00:00.000Z'),
  });
  return { report, source, target };
}

class FakeRestoreTarget {
  constructor(database) {
    this.database = database;
    this.collections = new Map();
    this.batchKeys = new Set();
    this.writeCalls = 0;
    this.failWrites = 0;
    this.corruptAfterWrite = false;
  }
  async inspectCollection(collection) {
    return { exists: this.collections.has(collection), count: (this.collections.get(collection) || []).length };
  }
  async readCollection(collection) {
    const result = structuredClone(this.collections.get(collection) || []);
    if (this.corruptAfterWrite && result.length > 0) result[0] = { id: 'corrupted' };
    return result;
  }
  async writeBatch(batch) {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error('FAKE_RESTORE_WRITE_FAILED');
    }
    if (this.batchKeys.has(batch.batchKey)) return 'already_applied';
    const current = this.collections.get(batch.collection) || [];
    if (current.length !== batch.startIndex) throw new Error('FAKE_RESTORE_CURSOR_CONFLICT');
    current.push(...structuredClone(batch.items));
    this.collections.set(batch.collection, current);
    this.batchKeys.add(batch.batchKey);
    this.writeCalls += 1;
    return 'written';
  }
}

async function createBackupFixture(options = {}) {
  const reader = options.reader || new FakeShadowReader({
    products: [{ id: 'one', nested: [null, false] }, { id: 'two', value: 2 }],
    'token-vault': [{ id: 'credential', secret: 'test-must-never-be-read' }],
  });
  const outputDir = options.outputDir || path.join(tempRoot, `backup-${fixtureCounter++}`);
  const result = await createMongoLogicalBackup({
    reader,
    sourceDatabase: 'sandeal_migration_test',
    collections: options.collections || ['products', 'token-vault'],
    outputDir,
    createdAt: options.createdAt || '2026-07-18T00:00:00.000Z',
    backupId: options.backupId,
    maxBytes: options.maxBytes,
  });
  return { ...result, reader, outputDir };
}

function spawnTool(args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'storage-shadow-tools.cjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MONGODB_URI: '', SANDEAL_STORAGE_DRIVER: 'file' },
  });
}

async function main() {
  await test('count and checksum match produces MATCH', async () => {
    const items = [{ id: 'one', value: 1 }, { id: 'two', value: 2 }];
    const { report } = await shadow({ products: items }, { products: structuredClone(items) });
    assert.equal(report.status, 'MATCH');
    assert.equal(report.collections[0].countMatches, true);
    assert.equal(report.collections[0].checksumMatches, true);
  });

  await test('equal counts with different checksums produce MISMATCH', async () => {
    const { report } = await shadow(
      { products: [{ id: 'one', value: 1 }] },
      { products: [{ id: 'one', value: 2 }] }
    );
    assert.equal(report.status, 'MISMATCH');
    assert.equal(report.collections[0].countMatches, true);
    assert.equal(report.collections[0].checksumMatches, false);
    assert.ok(report.differences.some(item => item.kind === 'CHECKSUM_MISMATCH'));
  });

  await test('missing record is detected by stable identity', async () => {
    const { report } = await shadow(
      { products: [{ id: 'one' }, { id: 'two' }] },
      { products: [{ id: 'one' }] }
    );
    assert.ok(report.differences.some(item => item.kind === 'RECORD_MISSING' && item.identity === 'id:two'));
  });

  await test('extra record is detected by stable identity', async () => {
    const { report } = await shadow(
      { products: [{ id: 'one' }] },
      { products: [{ id: 'one' }, { id: 'extra' }] }
    );
    assert.ok(report.differences.some(item => item.kind === 'RECORD_EXTRA' && item.identity === 'id:extra'));
  });

  await test('order mismatch is reported independently', async () => {
    const source = [{ id: 'one' }, { id: 'two' }];
    const target = [{ id: 'two' }, { id: 'one' }];
    const { report } = await shadow({ products: source }, { products: target });
    assert.equal(report.collections[0].orderMatches, false);
    assert.ok(report.differences.some(item => item.kind === 'ORDER_MISMATCH'));
  });

  await test('Mongo wrapper metadata does not create a false mismatch', async () => {
    const source = [{ id: 'one', value: 1 }, { label: 'ordinal' }];
    const target = source.map((item, order) => ({
      _id: `internal-${order}`, revision: 9, order, itemId: item.id || null, item: structuredClone(item),
    }));
    const { report } = await shadow({ products: source }, { products: target });
    assert.equal(report.status, 'MATCH');
  });

  await test('domain fields named revision and order are preserved inside the wrapper namespace', async () => {
    const source = [{ id: 'one', revision: 'domain', order: 'domain-order' }];
    const target = [{ _id: 'internal', revision: 2, order: 0, itemId: 'one', item: structuredClone(source[0]) }];
    const { report } = await shadow({ products: source }, { products: target });
    assert.equal(report.status, 'MATCH');
  });

  await test('sensitive values never appear in mismatch reports', async () => {
    const beforeSecret = 'test-before-secret-marker';
    const afterSecret = 'test-after-secret-marker';
    const { report } = await shadow(
      { products: [{ id: 'one', credential: { secret: beforeSecret } }] },
      { products: [{ id: 'one', credential: { secret: afterSecret } }] }
    );
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(beforeSecret), false);
    assert.equal(serialized.includes(afterSecret), false);
    assert.ok(report.differences.some(item => item.path === 'credential.secret' && item.redacted));
  });

  await test('default sensitive collection policy excludes token-vault without reading it', async () => {
    const source = new FakeShadowReader({ 'token-vault': [{ id: 'secret' }] });
    const target = new FakeShadowReader({ 'token-vault': [{ id: 'different' }] });
    const { report } = await shadow({}, {}, {
      source,
      target,
      collections: [{ collection: 'token-vault' }],
    });
    assert.equal(report.status, 'MATCH');
    assert.equal(report.collections[0].status, 'EXCLUDED');
    assert.equal(source.collectionReads, 0);
    assert.equal(target.collectionReads, 0);
  });

  await test('maxDifferences bounds samples while preserving total mismatch count', async () => {
    const source = Array.from({ length: 10 }, (_, index) => ({ id: `id-${index}`, value: index }));
    const target = source.map(item => ({ ...item, value: item.value + 100 }));
    const { report } = await shadow({ products: source }, { products: target }, { maxDifferences: 3 });
    assert.equal(report.differences.length, 3);
    assert.equal(report.truncated, true);
    assert.ok(report.differenceCount > report.differences.length);
  });

  await test('shadow validator exposes no write API and performs only reads', async () => {
    const { report, source, target } = await shadow({ products: [] }, { products: [] });
    assert.equal(report.status, 'MATCH');
    assert.equal(source.collectionReads, 1);
    assert.equal(target.collectionReads, 1);
    assert.equal(typeof source.writeCollection, 'undefined');
    assert.equal(typeof target.writeCollection, 'undefined');
  });

  await test('target unreachable returns UNREACHABLE without fallback', async () => {
    const target = new FakeShadowReader({});
    target.schemaError = new Error('fake unreachable with private details');
    const { report, source } = await shadow({ products: [] }, {}, { target });
    assert.equal(report.status, 'UNREACHABLE');
    assert.equal(report.errorCode, 'TARGET_UNREACHABLE');
    assert.equal(source.collectionReads, 0);
  });

  await test('schema mismatch returns BLOCKED before collection reads', async () => {
    const target = new FakeShadowReader({}, { version: 2, ready: false, indexReady: false });
    const { report } = await shadow({ products: [] }, {}, { target });
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.errorCode, 'SCHEMA_NOT_READY');
    assert.equal(target.collectionReads, 0);
  });

  await test('shadow timeout is bounded and reported without values', async () => {
    const target = new FakeShadowReader({ products: [] });
    target.inspectSchema = () => new Promise(() => undefined);
    const { report } = await shadow({ products: [] }, {}, { target, timeoutMs: 50 });
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.errorCode, 'SHADOW_TIMEOUT');
  });

  await test('rollback check marks healthy unchanged file source safe', () => {
    const checksum = checksumCollection([{ id: 'one' }]);
    const report = evaluateRollbackReadiness({
      configuredDriver: 'file', fileReachable: true,
      snapshotSourceChecksum: checksum, currentSourceChecksum: checksum,
      mongoWriteDetectedAfterSnapshot: false,
    });
    assert.equal(report.rollbackSafe, true);
    assert.deepEqual(report.blockers, []);
  });

  await test('missing driver configuration still means the default file driver', () => {
    const checksum = checksumCollection([]);
    const report = evaluateRollbackReadiness({
      configuredDriver: undefined, fileReachable: true,
      snapshotSourceChecksum: checksum, currentSourceChecksum: checksum,
      mongoWriteDetectedAfterSnapshot: false,
    });
    assert.equal(report.fileConfigured, true);
    assert.equal(report.rollbackSafe, true);
  });

  await test('changed file checksum blocks rollback', () => {
    const report = evaluateRollbackReadiness({
      configuredDriver: 'file', fileReachable: true,
      snapshotSourceChecksum: checksumCollection([]), currentSourceChecksum: checksumCollection([1]),
      mongoWriteDetectedAfterSnapshot: false,
    });
    assert.equal(report.rollbackSafe, false);
    assert.ok(report.blockers.includes('FILE_SOURCE_CHECKSUM_CHANGED'));
  });

  await test('Mongo writes after snapshot block rollback', () => {
    const checksum = checksumCollection([]);
    const report = evaluateRollbackReadiness({
      configuredDriver: 'file', fileReachable: true,
      snapshotSourceChecksum: checksum, currentSourceChecksum: checksum,
      mongoWriteDetectedAfterSnapshot: true,
    });
    assert.equal(report.rollbackSafe, false);
    assert.ok(report.blockers.includes('MONGO_WRITES_AFTER_FILE_SNAPSHOT'));
  });

  await test('Mongo logical backup preserves count, order, checksum, and strips wrapper metadata', async () => {
    const domain = [{ id: 'one' }, { id: 'two', nested: [false, null] }];
    const wrapped = domain.map((item, order) => ({ _id: `internal-${order}`, revision: 3, order, itemId: item.id, item }));
    const backup = await createBackupFixture({ reader: new FakeShadowReader({ products: wrapped }), collections: ['products'] });
    assert.equal(backup.backup.collections[0].recordCount, 2);
    assert.deepEqual(backup.backup.collections[0].records, domain);
    assert.equal(backup.backup.collections[0].checksum, checksumCollection(domain));
    assert.equal(JSON.stringify(backup.backup.collections[0].records).includes('_id'), false);
  });

  await test('backup excludes sensitive collections before reader access', async () => {
    const backup = await createBackupFixture();
    assert.deepEqual(backup.backup.excludedCollections, [
      { logicalName: 'token-vault', reasonCode: 'SENSITIVE_COLLECTION_EXCLUDED' },
    ]);
    assert.equal(backup.reader.collectionReads, 1);
    assert.equal(backup.backup.collections.some(item => item.logicalName === 'token-vault'), false);
  });

  await test('backup contains no URI or password material', async () => {
    const backup = await createBackupFixture();
    const serialized = fs.readFileSync(backup.filePath, 'utf8');
    assert.equal(/mongodb(?:\+srv)?:\/\//i.test(serialized), false);
    assert.equal(/"password"\s*:/i.test(serialized), false);
    assert.equal(serialized.includes('test-must-never-be-read'), false);
  });

  await test('backup atomic write verifies roundtrip and refuses overwrite', async () => {
    const outputDir = path.join(tempRoot, `backup-overwrite-${fixtureCounter++}`);
    const first = await createBackupFixture({ outputDir, backupId: 'fixed-backup' });
    const verified = await readMongoLogicalBackup(first.filePath);
    assert.equal(verified.snapshotChecksum, first.backup.snapshotChecksum);
    await assert.rejects(
      () => createBackupFixture({ outputDir, backupId: 'fixed-backup' }),
      /MONGO_BACKUP_ALREADY_EXISTS/
    );
    assert.equal(fs.readdirSync(outputDir).filter(name => name.includes('.tmp.')).length, 0);
  });

  await test('tampered backup fails verification', async () => {
    const { backup } = await createBackupFixture();
    const tampered = structuredClone(backup);
    tampered.collections[0].records[0].id = 'tampered';
    assert.throws(() => verifyMongoLogicalBackup(tampered), /MONGO_BACKUP_CHECKSUM_MISMATCH/);
  });

  await test('backup size limits are enforced before publishing an artifact', async () => {
    const reader = new FakeShadowReader({ products: [{ id: 'large', value: 'x'.repeat(2_000) }] });
    await assert.rejects(
      () => createBackupFixture({ reader, collections: ['products'], maxBytes: 1_024 }),
      /MONGO_BACKUP_SIZE_LIMIT_EXCEEDED/
    );
  });

  await test('backup refuses a production database name before reading', async () => {
    let reads = 0;
    await assert.rejects(() => createMongoLogicalBackup({
      reader: { inspectCollection: async () => { reads += 1; return { exists: true, items: [] }; } },
      sourceDatabase: 'sandeal',
      collections: ['products'],
      outputDir: path.join(tempRoot, `backup-forbidden-${fixtureCounter++}`),
    }), error => error && error.code === 'MIGRATION_DATABASE_FORBIDDEN');
    assert.equal(reads, 0);
  });

  await test('restore refuses database sandeal', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal');
    await assert.rejects(() => restoreMongoLogicalBackup({
      mode: 'apply-isolated', backup, target, restoreId: 'restore-forbidden', allowIsolatedWrite: true,
    }), error => error && error.code === 'MIGRATION_DATABASE_FORBIDDEN');
    assert.equal(target.writeCalls, 0);
  });

  await test('restore refuses missing explicit write flag', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal_restore_test');
    await assert.rejects(() => restoreMongoLogicalBackup({
      mode: 'apply-isolated', backup, target, restoreId: 'restore-no-flag',
    }), error => error instanceof MongoRestoreError && error.code === 'MONGO_RESTORE_FLAG_REQUIRED');
    assert.equal(target.writeCalls, 0);
  });

  await test('restore refuses nonempty target without deleting it', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal_restore_test');
    target.collections.set('products', [{ id: 'existing' }]);
    await assert.rejects(() => restoreMongoLogicalBackup({
      mode: 'apply-isolated', backup, target, restoreId: 'restore-nonempty', allowIsolatedWrite: true,
    }), error => error instanceof MongoRestoreError && error.code === 'MONGO_RESTORE_TARGET_NOT_EMPTY');
    assert.deepEqual(await target.readCollection('products'), [{ id: 'existing' }]);
  });

  await test('restore verifies target count and checksum', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal_restore_test');
    const summary = await restoreMongoLogicalBackup({
      mode: 'apply-isolated', backup, target, restoreId: 'restore-verified', allowIsolatedWrite: true, batchSize: 1,
    });
    assert.equal(summary.success, true);
    assert.equal(summary.collections[0].status, 'RESTORED');
    assert.equal(checksumCollection(await target.readCollection('products')), backup.collections[0].checksum);
    assert.equal(target.collections.has('token-vault'), false);
  });

  await test('restore verification catches corrupted target data', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal_restore_test');
    target.corruptAfterWrite = true;
    await assert.rejects(() => restoreMongoLogicalBackup({
      mode: 'apply-isolated', backup, target, restoreId: 'restore-corrupt', allowIsolatedWrite: true,
    }), error => error instanceof MongoRestoreError && error.code === 'MONGO_RESTORE_VERIFY_FAILED');
  });

  await test('restore batch failure never returns a success result', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal_restore_test');
    target.failWrites = 1;
    let returned = false;
    await assert.rejects(async () => {
      await restoreMongoLogicalBackup({
        mode: 'apply-isolated', backup, target, restoreId: 'restore-failure', allowIsolatedWrite: true,
      });
      returned = true;
    }, error => error instanceof MongoRestoreError && error.code === 'MONGO_RESTORE_BATCH_FAILED');
    assert.equal(returned, false);
  });

  await test('restore dry-run performs zero writes', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal_restore_test');
    const summary = await restoreMongoLogicalBackup({
      mode: 'dry-run', backup, target, restoreId: 'restore-dry-run',
    });
    assert.equal(summary.writesPerformed, 0);
    assert.equal(target.writeCalls, 0);
  });

  await test('restore rerun fails clearly on the now-nonempty target', async () => {
    const { backup } = await createBackupFixture();
    const target = new FakeRestoreTarget('sandeal_restore_test');
    const options = {
      mode: 'apply-isolated', backup, target, restoreId: 'restore-rerun', allowIsolatedWrite: true,
    };
    await restoreMongoLogicalBackup(options);
    await assert.rejects(
      () => restoreMongoLogicalBackup(options),
      error => error instanceof MongoRestoreError && error.code === 'MONGO_RESTORE_TARGET_NOT_EMPTY'
    );
  });

  await test('shadow CLI is read-only and leaves source and target mtimes unchanged', () => {
    const items = [{ id: 'cli-match', value: 1 }];
    const sourceDir = fixture({ 'products.json': items });
    const targetDir = fixture({ 'products.json': items });
    const sourceFile = path.join(sourceDir, 'products.json');
    const targetFile = path.join(targetDir, 'products.json');
    const before = [fs.statSync(sourceFile).mtimeMs, fs.statSync(targetFile).mtimeMs];
    const result = spawnTool([
      'shadow', '--source-dir', sourceDir, '--target-dir', targetDir, '--collections', 'products',
      '--max-differences', '5', '--timeout-ms', '1000',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'MATCH');
    assert.deepEqual([fs.statSync(sourceFile).mtimeMs, fs.statSync(targetFile).mtimeMs], before);
  });

  await test('rollback CLI evaluates fixture checksum without Mongo access', () => {
    const items = [{ id: 'rollback-cli' }];
    const dataDir = fixture({ 'products.json': items });
    const result = spawnTool([
      'rollback', '--data-dir', dataDir, '--collection', 'products',
      '--snapshot-checksum', checksumCollection(items), '--driver', 'file',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).rollbackSafe, true);
  });

  await test('backup and restore CLIs use only fake injected targets', () => {
    const dataDir = fixture({ 'products.json': [{ id: 'backup-cli' }] });
    const outputDir = path.join(tempRoot, `cli-backup-${fixtureCounter++}`);
    const backupResult = spawnTool([
      'backup', '--fake-target', '--allow-backup-write', '--data-dir', dataDir, '--collections', 'products',
      '--database', 'sandeal_migration_test', '--output-dir', outputDir,
      '--created-at', '2026-07-18T00:00:00.000Z', '--backup-id', 'cli-backup',
    ]);
    assert.equal(backupResult.status, 0, backupResult.stderr);
    const backupReport = JSON.parse(backupResult.stdout);
    assert.equal(backupReport.mode, 'fake-injected');
    const snapshot = path.join(outputDir, 'cli-backup.mongo-logical-backup.json');
    const restoreResult = spawnTool([
      'restore', '--fake-target', '--allow-isolated-write', '--snapshot', snapshot,
      '--database', 'sandeal_restore_test', '--restore-id', 'cli-restore', '--batch-size', '1',
    ]);
    assert.equal(restoreResult.status, 0, restoreResult.stderr);
    const restoreReport = JSON.parse(restoreResult.stdout);
    assert.equal(restoreReport.success, true);
    assert.equal(restoreReport.targetMode, 'fake-injected');
  });

  await test('backup CLI dry-run is zero-write and write mode requires an explicit flag', () => {
    const dataDir = fixture({ 'products.json': [{ id: 'backup-guard' }] });
    const outputDir = path.join(tempRoot, `cli-backup-guard-${fixtureCounter++}`);
    const dryRun = spawnTool([
      'backup', '--fake-target', '--dry-run', '--data-dir', dataDir, '--collections', 'products',
      '--database', 'sandeal_migration_test', '--output-dir', outputDir,
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).writesPerformed, 0);
    assert.equal(fs.existsSync(outputDir), false);

    const blocked = spawnTool([
      'backup', '--fake-target', '--data-dir', dataDir, '--collections', 'products',
      '--database', 'sandeal_migration_test', '--output-dir', outputDir,
    ]);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stderr).errorCode, 'MONGO_BACKUP_WRITE_FLAG_REQUIRED');
    assert.equal(fs.existsSync(outputDir), false);
  });

  await test('M4 code has no drop database, collection, or index operation', () => {
    const files = [
      'shadowValidation.ts', 'rollbackReadiness.ts', 'mongoLogicalBackup.ts', 'mongoRestore.ts',
    ];
    const source = files.map(file => fs.readFileSync(path.join(root, 'src', 'lib', 'storage', file), 'utf8')).join('\n');
    assert.equal(/\.dropDatabase\s*\(/.test(source), false);
    assert.equal(/\.dropCollection\s*\(/.test(source), false);
    assert.equal(/\.dropIndex(?:es)?\s*\(/.test(source), false);
    assert.equal(/\.deleteMany\s*\(/.test(source), false);
  });

  await test('M4 tests do not change real .data or create tracked artifacts', () => {
    if (actualDataMetadata) {
      assert.equal(fs.statSync(actualDataDir).mtimeMs, actualDataMetadata.mtimeMs);
      assert.equal(fs.readdirSync(actualDataDir).length, actualDataMetadata.count);
    }
    const status = spawnSync('git', ['-c', 'safe.directory=C:/duan/sandeal', 'status', '--porcelain', '--', '.test-tmp', '.backups'], {
      cwd: root, encoding: 'utf8', shell: false,
    });
    assert.equal(status.status, 0);
    assert.equal(status.stdout.trim(), '');
  });

  await test('M4 tests make no network call and never initialize MongoClient', () => {
    assert.equal(networkCalls, 0);
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  console.log(`\nStorage shadow/rollback/backup M4: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  failed += 1;
  console.error(`FAIL setup\n${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
