/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-storage-migration-'));
const actualDataDir = path.join(root, '.data');
const actualDataMetadata = fs.existsSync(actualDataDir)
  ? { mtimeMs: fs.statSync(actualDataDir).mtimeMs, count: fs.readdirSync(actualDataDir).length }
  : null;
const savedEnv = {
  SANDEAL_DATA_DIR: process.env.SANDEAL_DATA_DIR,
  SANDEAL_STORAGE_DRIVER: process.env.SANDEAL_STORAGE_DRIVER,
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,
};
const savedPresence = Object.fromEntries(Object.keys(savedEnv).map(key => [key, Object.prototype.hasOwnProperty.call(process.env, key)]));

process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = tempRoot;
delete process.env.SANDEAL_STORAGE_DRIVER;
delete process.env.MONGODB_URI;
delete process.env.MONGODB_DATABASE;

require('./register-typescript.cjs');

const mongoClientPath = require.resolve('../src/lib/storage/mongoClient.ts');
const {
  canonicalJson,
  checksumCollection,
  checksumCollectionRecords,
  checksumJson,
} = require('../src/lib/storage/migrationChecksum.ts');
const {
  MigrationExecutionError,
  assertIsolatedDatabase,
  executeMigration,
} = require('../src/lib/storage/migrationExecutor.ts');
const {
  discoverStorageCollections,
  inventoryFileCollections,
} = require('../src/lib/storage/migrationInventory.ts');
const {
  checksumMigrationManifest,
  createMigrationManifest,
  validateMigrationManifest,
} = require('../src/lib/storage/migrationManifest.ts');

let passed = 0;
let failed = 0;
let networkCalls = 0;
global.fetch = async () => {
  networkCalls += 1;
  throw new Error('NETWORK_FORBIDDEN_IN_MIGRATION_TESTS');
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

function errorCode(expected) {
  return error => error instanceof MigrationExecutionError && error.code === expected;
}

let fixtureCounter = 0;
function fixture(files) {
  const directory = path.join(tempRoot, `fixture-${fixtureCounter++}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    fs.writeFileSync(path.join(directory, name), content, 'utf8');
  }
  return directory;
}

async function inventoryFor(dataDir, options = {}) {
  return inventoryFileCollections({
    dataDir,
    schemaCollections: options.schemaCollections || ['jobs', 'products', 'token-vault'],
    sourceCollections: options.sourceCollections || ['jobs', 'products', 'token-vault'],
  });
}

async function manifestFixture(items = [{ id: 'one', value: 1 }, { id: 'two', value: 2 }], database = 'sandeal_migration_test') {
  const dataDir = fixture({ 'products.json': items });
  const inventory = await inventoryFileCollections({
    dataDir,
    schemaCollections: ['products'],
    sourceCollections: ['products'],
  });
  const manifest = createMigrationManifest(inventory, {
    database,
    batchSize: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
  });
  return { dataDir, inventory, manifest, items };
}

class FakeMigrationTarget {
  constructor(database) {
    this.database = database;
    this.collections = new Map();
    this.owners = new Map();
    this.checkpoints = new Map();
    this.batchKeys = new Set();
    this.writeCalls = 0;
    this.checkpointWrites = 0;
    this.batchFailures = 0;
    this.failCheckpointRevisionOnce = null;
  }
  key(migrationId, collection) { return `${migrationId}:${collection}`; }
  async inspectCollection(collection) {
    return {
      exists: this.collections.has(collection),
      count: (this.collections.get(collection) || []).length,
      migrationId: this.owners.get(collection) || null,
    };
  }
  async readCollection(collection) {
    return structuredClone(this.collections.get(collection) || []);
  }
  async readCheckpoint(migrationId, collection) {
    return structuredClone(this.checkpoints.get(this.key(migrationId, collection)) || null);
  }
  async compareAndSetCheckpoint(migrationId, collection, expectedRevision, next) {
    const key = this.key(migrationId, collection);
    const current = this.checkpoints.get(key) || null;
    const currentRevision = current ? current.checkpointRevision : null;
    if (currentRevision !== expectedRevision) return false;
    if (this.failCheckpointRevisionOnce === next.checkpointRevision) {
      this.failCheckpointRevisionOnce = null;
      return false;
    }
    this.checkpoints.set(key, structuredClone(next));
    this.checkpointWrites += 1;
    return true;
  }
  async writeBatch(batch) {
    if (this.batchFailures > 0) {
      this.batchFailures -= 1;
      const error = new Error('FAKE_BATCH_FAILURE');
      error.retryable = true;
      throw error;
    }
    if (this.batchKeys.has(batch.batchKey)) return 'already_applied';
    const currentOwner = this.owners.get(batch.collection);
    if (currentOwner && currentOwner !== batch.migrationId) throw new Error('FAKE_TARGET_OWNER_CONFLICT');
    const items = this.collections.get(batch.collection) || [];
    if (batch.startIndex !== items.length) throw new Error('FAKE_BATCH_CURSOR_CONFLICT');
    items.push(...structuredClone(batch.items));
    this.collections.set(batch.collection, items);
    this.owners.set(batch.collection, batch.migrationId);
    this.batchKeys.add(batch.batchKey);
    this.writeCalls += 1;
    return 'written';
  }
  seedCheckpoint(checkpoint) {
    this.checkpoints.set(this.key(checkpoint.migrationId, checkpoint.collection), structuredClone(checkpoint));
  }
}

function checkpointFor(manifest, changes = {}) {
  const collection = manifest.collections.find(item => item.logicalName === 'products');
  return {
    migrationId: 'migration-fixture',
    manifestChecksum: manifest.manifestChecksum,
    collection: 'products',
    sourceChecksum: collection.sourceChecksum,
    sourceCount: collection.sourceCount,
    processedCount: 0,
    batchCursor: 0,
    status: 'FAILED',
    updatedAt: '2026-07-18T00:00:00.000Z',
    checkpointRevision: 1,
    executorId: null,
    leaseExpiresAt: null,
    ...changes,
  };
}

async function main() {
  await test('inventory detects a valid logical JSON collection', async () => {
    const result = await inventoryFor(fixture({ 'products.json': [{ id: 'p1' }] }));
    const record = result.records.find(item => item.sourceFile === 'products.json');
    assert.equal(record.classification, 'migratable');
    assert.equal(record.recordCount, 1);
    assert.match(record.checksum, /^[a-f0-9]{64}$/);
  });

  await test('inventory reports empty and absent planned collections separately', async () => {
    const result = await inventoryFor(fixture({ 'products.json': [] }));
    assert.equal(result.records[0].classification, 'empty');
    assert.equal(result.records[0].recordCount, 0);
    assert.ok(result.comparison.schemaWithoutFile.includes('jobs'));
  });

  await test('token-vault is excluded by filename without parsing its invalid contents', async () => {
    const result = await inventoryFor(fixture({ 'token-vault.json': '{this-is-not-json-and-must-not-be-parsed' }));
    const record = result.records[0];
    assert.equal(record.classification, 'sensitive_excluded');
    assert.equal(record.recordCount, null);
    assert.equal(record.checksum, null);
    assert.equal(result.blockers.length, 0);
  });

  await test('lock, temp, backup, and generated reports are ignored artifacts', async () => {
    const result = await inventoryFor(fixture({
      'products.json.lock': 'lock',
      'products.json.tmp.abcd': 'temp',
      'products.json.bak': '[]',
      'migration-report.json': '{broken',
    }));
    assert.equal(result.records.every(record => record.classification === 'ignored_artifact'), true);
    assert.equal(result.blockers.length, 0);
  });

  await test('invalid JSON is a blocker without exposing source content', async () => {
    const marker = 'PRIVATE_RECORD_VALUE_MUST_NOT_APPEAR';
    const result = await inventoryFor(fixture({ 'products.json': `{broken-${marker}` }));
    assert.equal(result.records[0].classification, 'invalid_json');
    assert.equal(result.blockers.length, 1);
    assert.equal(JSON.stringify(result).includes(marker), false);
  });

  await test('a non-array JSON root is a blocker', async () => {
    const result = await inventoryFor(fixture({ 'products.json': { id: 'not-an-array' } }));
    assert.equal(result.records[0].classification, 'invalid_root');
    assert.equal(result.records[0].reasonCode, 'COLLECTION_ROOT_MUST_BE_ARRAY');
    assert.equal(result.blockers.length, 1);
  });

  await test('invalid collection names are rejected before parsing', async () => {
    const result = await inventoryFor(fixture({ 'bad$name.json': '[{"private":"hidden"}]' }));
    assert.equal(result.records[0].classification, 'unsupported');
    assert.equal(result.records[0].reasonCode, 'INVALID_COLLECTION_NAME');
    assert.equal(result.records[0].checksum, null);
  });

  await test('non-JSON files are classified unsupported without blocking logical data', async () => {
    const result = await inventoryFor(fixture({ 'notes.txt': 'not a collection' }));
    assert.equal(result.records[0].classification, 'unsupported');
    assert.equal(result.records[0].blocking, false);
  });

  await test('file collections absent from the Mongo schema are reported as blockers', async () => {
    const result = await inventoryFileCollections({
      dataDir: fixture({ 'unplanned.json': [] }),
      schemaCollections: ['products'],
      sourceCollections: ['products'],
    });
    assert.deepEqual(result.comparison.fileWithoutSchema, ['unplanned']);
    assert.ok(result.blockers.includes('unplanned:FILE_COLLECTION_NOT_IN_SCHEMA'));
  });

  await test('source collection discovery agrees with the M2 schema inventory', async () => {
    const discovered = await discoverStorageCollections(path.join(root, 'src'));
    for (const required of ['automation-jobs', 'products', 'token-vault']) assert.ok(discovered.includes(required));
    assert.equal(discovered.includes('sandeal_storage_metadata'), false);
  });

  await test('manifest logic and checksum are deterministic across timestamps', async () => {
    const dataDir = fixture({ 'products.json': [{ b: 2, a: 1 }] });
    const inventory = await inventoryFileCollections({ dataDir, schemaCollections: ['products'], sourceCollections: ['products'] });
    const first = createMigrationManifest(inventory, { createdAt: '2026-07-18T00:00:00.000Z' });
    const second = createMigrationManifest(inventory, { createdAt: '2026-07-19T00:00:00.000Z' });
    assert.equal(first.manifestChecksum, second.manifestChecksum);
    assert.deepEqual(first.collections, second.collections);
    assert.equal(checksumMigrationManifest(first), first.manifestChecksum);
  });

  await test('manifest schema validation detects tampering', async () => {
    const { manifest } = await manifestFixture();
    const tampered = structuredClone(manifest);
    tampered.collections[0].sourceCount += 1;
    const result = validateMigrationManifest(tampered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('MANIFEST_CHECKSUM_MISMATCH'));
  });

  await test('manifest contains no URI, password, or record payload', async () => {
    const privateValue = 'fixture-password-value-never-report';
    const { manifest } = await manifestFixture([{ id: 'one', password: privateValue, uri: 'fixture-private-value' }]);
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes(privateValue), false);
    assert.equal(serialized.includes('fixture-private-value'), false);
    assert.equal(serialized.includes('mongodb://'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'uri'), false);
  });

  await test('manifest collections remain stably sorted with exact counts', async () => {
    const dataDir = fixture({ 'products.json': [{ id: 'p1' }, { id: 'p2' }], 'jobs.json': [] });
    const inventory = await inventoryFileCollections({ dataDir, schemaCollections: ['jobs', 'products'], sourceCollections: ['jobs', 'products'] });
    const manifest = createMigrationManifest(inventory, { createdAt: '2026-07-18T00:00:00.000Z' });
    assert.deepEqual(manifest.collections.map(item => item.logicalName), ['jobs', 'products']);
    assert.equal(manifest.collections.find(item => item.logicalName === 'products').sourceCount, 2);
  });

  await test('canonical checksum is deterministic', () => {
    const value = [{ id: 'one', nested: { enabled: false } }];
    assert.equal(checksumCollection(value), checksumCollection(structuredClone(value)));
    assert.equal(canonicalJson(value), canonicalJson(structuredClone(value)));
  });

  await test('object key order does not affect canonical checksum', () => {
    assert.equal(checksumCollection([{ a: 1, b: 2 }]), checksumCollection([{ b: 2, a: 1 }]));
  });

  await test('array order remains checksum-significant', () => {
    assert.notEqual(checksumCollection([1, 2, 3]), checksumCollection([3, 2, 1]));
  });

  await test('nested null, boolean, zero, empty string, and array semantics are distinct', () => {
    const baseline = checksumJson({ nested: [null, false, 0, '', [true, null]] });
    assert.notEqual(baseline, checksumJson({ nested: [null, false, '', 0, [true, null]] }));
    assert.notEqual(checksumJson(null), checksumJson(false));
    assert.notEqual(checksumJson(0), checksumJson(''));
  });

  await test('undefined and non-finite numbers are not accepted as JSON checksum input', () => {
    assert.throws(() => checksumJson({ value: undefined }), error => error && error.code === 'INVALID_STORAGE_PAYLOAD');
    assert.throws(() => checksumJson({ value: Number.NaN }), error => error && error.code === 'INVALID_STORAGE_PAYLOAD');
  });

  await test('record checksums use ids or ordinals without mutating domain objects', () => {
    const input = [{ id: 'stable', value: 1 }, { value: 2 }];
    const before = structuredClone(input);
    const records = checksumCollectionRecords(input);
    assert.deepEqual(records.map(item => item.identity), ['id:stable', 'ordinal:1']);
    assert.deepEqual(input, before);
  });

  await test('dry-run performs no target or Mongo write', async () => {
    const { manifest, items } = await manifestFixture();
    const summary = await executeMigration({
      mode: 'dry-run',
      manifest,
      migrationId: 'dry-run-fixture',
      sourceCollections: { products: items },
      target: {
        database: 'must-not-be-used',
        inspectCollection: async () => { throw new Error('TARGET_USED'); },
        readCollection: async () => { throw new Error('TARGET_USED'); },
        readCheckpoint: async () => { throw new Error('TARGET_USED'); },
        compareAndSetCheckpoint: async () => { throw new Error('TARGET_USED'); },
        writeBatch: async () => { throw new Error('TARGET_USED'); },
      },
    });
    assert.equal(summary.writesPerformed, 0);
    assert.equal(summary.collections[0].status, 'DRY_RUN');
  });

  await test('dry-run and inventory leave source content and mtime unchanged', async () => {
    const { dataDir, manifest, items } = await manifestFixture();
    const source = path.join(dataDir, 'products.json');
    const before = { content: fs.readFileSync(source, 'utf8'), mtimeMs: fs.statSync(source).mtimeMs };
    await inventoryFileCollections({ dataDir, schemaCollections: ['products'], sourceCollections: ['products'] });
    await executeMigration({ mode: 'dry-run', manifest, migrationId: 'mtime-check', sourceCollections: { products: items } });
    const after = { content: fs.readFileSync(source, 'utf8'), mtimeMs: fs.statSync(source).mtimeMs };
    assert.deepEqual(after, before);
  });

  await test('source-only modules never initialize MongoClient', () => {
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  await test('the source-only CLI reports zero writes and preserves source mtime', async () => {
    const dataDir = fixture({ 'products.json': [{ id: 'cli' }] });
    const source = path.join(dataDir, 'products.json');
    const before = fs.statSync(source).mtimeMs;
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'storage-migration.cjs'),
      'dry-run', '--source-only', '--data-dir', dataDir, '--no-output',
      '--created-at', '2026-07-18T00:00:00.000Z',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SANDEAL_DATA_DIR: dataDir, SANDEAL_STORAGE_DRIVER: 'file', MONGODB_URI: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mongoClientInitialized, false);
    assert.equal(report.mongoWrites, 0);
    assert.equal(report.sourceWrites, 0);
    assert.equal(fs.statSync(source).mtimeMs, before);
  });

  await test('apply-isolated rejects the production database name sandeal', async () => {
    const { manifest, items } = await manifestFixture([{ id: 'one' }], 'sandeal');
    const target = new FakeMigrationTarget('sandeal');
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'reject-production', sourceCollections: { products: items },
      target, allowIsolatedWrite: true,
    }), errorCode('MIGRATION_DATABASE_FORBIDDEN'));
    assert.equal(target.writeCalls, 0);
  });

  await test('isolated database validator rejects admin, local, config, and unsafe suffixes', () => {
    for (const database of ['admin', 'local', 'config', 'sandeal_dev']) {
      assert.throws(() => assertIsolatedDatabase(database), error => error instanceof MigrationExecutionError);
    }
    assert.doesNotThrow(() => assertIsolatedDatabase('sandeal_migration_test'));
  });

  await test('apply-isolated requires the explicit write flag', async () => {
    const { manifest, items } = await manifestFixture();
    const target = new FakeMigrationTarget(manifest.database);
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'missing-flag', sourceCollections: { products: items }, target,
    }), errorCode('MIGRATION_ISOLATED_WRITE_FLAG_REQUIRED'));
    assert.equal(target.writeCalls, 0);
  });

  await test('apply-isolated refuses a nonempty unowned target without deleting it', async () => {
    const { manifest, items } = await manifestFixture();
    const target = new FakeMigrationTarget(manifest.database);
    target.collections.set('products', [{ id: 'existing' }]);
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'nonempty-target', sourceCollections: { products: items },
      target, allowIsolatedWrite: true,
    }), errorCode('MIGRATION_TARGET_NOT_EMPTY'));
    assert.deepEqual(await target.readCollection('products'), [{ id: 'existing' }]);
  });

  await test('resume rejects a manifest checksum mismatch', async () => {
    const { manifest, items } = await manifestFixture();
    const target = new FakeMigrationTarget(manifest.database);
    target.seedCheckpoint(checkpointFor(manifest, { manifestChecksum: '0'.repeat(64) }));
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'migration-fixture', sourceCollections: { products: items },
      target, allowIsolatedWrite: true,
    }), errorCode('MIGRATION_MANIFEST_CHECKSUM_MISMATCH'));
  });

  await test('resume rejects a checkpoint source checksum mismatch', async () => {
    const { manifest, items } = await manifestFixture();
    const target = new FakeMigrationTarget(manifest.database);
    target.seedCheckpoint(checkpointFor(manifest, { sourceChecksum: 'f'.repeat(64) }));
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'migration-fixture', sourceCollections: { products: items },
      target, allowIsolatedWrite: true,
    }), errorCode('MIGRATION_SOURCE_CHECKSUM_MISMATCH'));
  });

  await test('execution rejects source changes after manifest creation', async () => {
    const { manifest } = await manifestFixture();
    const target = new FakeMigrationTarget(manifest.database);
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'changed-source',
      sourceCollections: { products: [{ id: 'changed' }, { id: 'two', value: 2 }] },
      target, allowIsolatedWrite: true,
    }), errorCode('MIGRATION_SOURCE_CHECKSUM_MISMATCH'));
  });

  await test('isolated rerun is idempotent and completed batches do not duplicate records', async () => {
    const { manifest, items } = await manifestFixture();
    const target = new FakeMigrationTarget(manifest.database);
    const options = {
      mode: 'apply-isolated', manifest, migrationId: 'idempotent-run', sourceCollections: { products: items },
      target, allowIsolatedWrite: true,
    };
    const first = await executeMigration(options);
    const writes = target.writeCalls;
    const second = await executeMigration(options);
    assert.equal(first.collections[0].status, 'COMPLETED');
    assert.equal(second.collections[0].status, 'SKIPPED_COMPLETED');
    assert.equal(target.writeCalls, writes);
    assert.deepEqual(await target.readCollection('products'), items);
  });

  await test('crash-window resume replays an idempotency key without duplicating a batch', async () => {
    const { manifest, items } = await manifestFixture([{ id: 'only' }]);
    const target = new FakeMigrationTarget(manifest.database);
    target.failCheckpointRevisionOnce = 3;
    const options = {
      mode: 'apply-isolated', manifest, migrationId: 'crash-window', sourceCollections: { products: items },
      target, allowIsolatedWrite: true,
    };
    await assert.rejects(() => executeMigration(options), errorCode('MIGRATION_CHECKPOINT_CONFLICT'));
    assert.deepEqual(await target.readCollection('products'), items);
    const resumed = await executeMigration(options);
    assert.equal(resumed.collections[0].status, 'COMPLETED');
    assert.deepEqual(await target.readCollection('products'), items);
    assert.equal(target.writeCalls, 1);
  });

  await test('batch failure is bounded and never records COMPLETED', async () => {
    const { manifest, items } = await manifestFixture([{ id: 'failure' }]);
    const target = new FakeMigrationTarget(manifest.database);
    target.batchFailures = 3;
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'failed-batch', sourceCollections: { products: items },
      target, allowIsolatedWrite: true, maxBatchRetries: 1, isRetryable: error => error.retryable === true,
    }), errorCode('MIGRATION_BATCH_FAILED'));
    const checkpoint = await target.readCheckpoint('failed-batch', 'products');
    assert.equal(checkpoint.status, 'FAILED');
    assert.notEqual(checkpoint.status, 'COMPLETED');
    assert.equal(target.writeCalls, 0);
  });

  await test('an active checkpoint lease fences a second executor', async () => {
    const { manifest, items } = await manifestFixture([{ id: 'lease' }]);
    const target = new FakeMigrationTarget(manifest.database);
    target.seedCheckpoint(checkpointFor(manifest, {
      migrationId: 'leased-run', status: 'RUNNING', executorId: 'first-executor',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    }));
    await assert.rejects(() => executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'leased-run', sourceCollections: { products: items },
      target, allowIsolatedWrite: true, executorId: 'second-executor',
    }), errorCode('MIGRATION_ALREADY_RUNNING'));
  });

  await test('checkpoint records contain no URI, password, or record payload', async () => {
    const { manifest, items } = await manifestFixture([{ id: 'safe', password: 'test-not-in-checkpoint' }]);
    const target = new FakeMigrationTarget(manifest.database);
    await executeMigration({
      mode: 'apply-isolated', manifest, migrationId: 'safe-checkpoint', sourceCollections: { products: items },
      target, allowIsolatedWrite: true,
    });
    const serialized = JSON.stringify(await target.readCheckpoint('safe-checkpoint', 'products'));
    assert.equal(serialized.includes('test-not-in-checkpoint'), false);
    assert.equal(serialized.includes('mongodb://'), false);
  });

  await test('test artifacts use SANDEAL_DATA_DIR temp and .test-tmp is ignored', () => {
    assert.equal(path.resolve(process.env.SANDEAL_DATA_DIR), path.resolve(tempRoot));
    assert.equal(path.resolve(tempRoot).startsWith(path.resolve(root, '.data')), false);
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /\/\.test-tmp\//);
  });

  await test('real .data metadata remains unchanged and was never used as a fixture', () => {
    if (!actualDataMetadata) {
      assert.equal(fs.existsSync(actualDataDir), false);
      return;
    }
    assert.equal(fs.statSync(actualDataDir).mtimeMs, actualDataMetadata.mtimeMs);
    assert.equal(fs.readdirSync(actualDataDir).length, actualDataMetadata.count);
  });

  await test('migration tests make no network/provider calls and use no credential', () => {
    assert.equal(networkCalls, 0);
    assert.equal(process.env.MONGODB_URI, undefined);
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  console.log(`\nStorage migration M3: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  failed += 1;
  console.error(`FAIL setup\n${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
}).finally(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (savedPresence[key]) process.env[key] = value;
    else delete process.env[key];
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
