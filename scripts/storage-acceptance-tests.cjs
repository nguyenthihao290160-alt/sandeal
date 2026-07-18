/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-storage-acceptance-'));
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
process.env.SANDEAL_DATA_DIR = tempDir;
delete process.env.SANDEAL_STORAGE_DRIVER;
delete process.env.MONGODB_URI;
delete process.env.MONGODB_DATABASE;

require('./register-typescript.cjs');

const mongoClientPath = require.resolve('../src/lib/storage/mongoClient.ts');
const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');
const { checksumCollection } = require('../src/lib/storage/migrationChecksum.ts');
const { createMigrationManifest } = require('../src/lib/storage/migrationManifest.ts');
const { evaluateMongoAcceptanceSafety } = require('../src/lib/storage/mongoAcceptanceSafety.ts');
const { createMongoLogicalBackup } = require('../src/lib/storage/mongoLogicalBackup.ts');
const { getStorageConfig } = require('../src/lib/storage/storageConfig.ts');
const { getStorageAdapter } = require('../src/lib/storage/storageFactory.ts');
const { validateShadow } = require('../src/lib/storage/shadowValidation.ts');

let passed = 0;
let failed = 0;
let networkCalls = 0;
global.fetch = async () => {
  networkCalls += 1;
  throw new Error('NETWORK_FORBIDDEN_IN_ACCEPTANCE_TESTS');
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

function storageSource() {
  return fs.readdirSync(path.join(root, 'src', 'lib', 'storage'))
    .filter(name => name.endsWith('.ts'))
    .sort()
    .map(name => fs.readFileSync(path.join(root, 'src', 'lib', 'storage', name), 'utf8'))
    .join('\n');
}

function minimalInventory() {
  return {
    dataDirectory: tempDir,
    records: [{
      logicalCollection: 'products', sourceFile: 'products.json', classification: 'empty',
      recordCount: 0, byteSize: 2, checksum: checksumCollection([]), reasonCode: 'EMPTY_COLLECTION', blocking: false,
    }],
    sourceCollections: ['products'],
    schemaCollections: ['products'],
    comparison: { fileWithoutSchema: [], schemaWithoutFile: [], sourceWithoutSchema: [], schemaWithoutSource: [] },
    blockers: [],
    warnings: [],
  };
}

async function main() {
  await test('Mode A defaults to file without driver or Mongo URI', () => {
    delete process.env.SANDEAL_STORAGE_DRIVER;
    delete process.env.MONGODB_URI;
    assert.deepEqual(getStorageConfig(), { driver: 'file' });
    assert.equal(getStorageAdapter(), fileStorageAdapter);
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  await test('Mode A file adapter health and CRUD work in isolated SANDEAL_DATA_DIR', async () => {
    delete process.env.SANDEAL_STORAGE_DRIVER;
    await fileStorageAdapter.writeCollection('acceptance-file', [{ id: 'one', value: 1 }]);
    assert.deepEqual(await fileStorageAdapter.readCollection('acceptance-file'), [{ id: 'one', value: 1 }]);
    const health = await fileStorageAdapter.checkHealth();
    assert.equal(health.healthy, true);
    assert.equal(path.resolve(fileStorageAdapter.getDataDir()), path.resolve(tempDir));
  });

  await test('Mode B explicit file needs no Mongo URI and does not load Mongo client', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    delete process.env.MONGODB_URI;
    assert.equal(getStorageAdapter(), fileStorageAdapter);
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  await test('Mode C explicit Mongo without URI fails MONGO_URI_REQUIRED without fallback', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'mongo';
    delete process.env.MONGODB_URI;
    assert.throws(() => getStorageAdapter(), error => error && error.code === 'MONGO_URI_REQUIRED');
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  await test('M3-M5 tooling modules import without initializing MongoClient', () => {
    for (const moduleName of [
      'migrationChecksum.ts', 'migrationExecutor.ts', 'migrationInventory.ts', 'migrationManifest.ts',
      'shadowValidation.ts', 'rollbackReadiness.ts', 'mongoLogicalBackup.ts', 'mongoRestore.ts',
      'mongoAcceptanceSafety.ts',
    ]) require(path.join(root, 'src', 'lib', 'storage', moduleName));
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  await test('Mode E validator returns NOT_RUN when opt-ins are absent', () => {
    const result = evaluateMongoAcceptanceSafety({}, false);
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.ready, false);
    assert.equal(result.realIsolatedMongoAcceptance, 'NOT_RUN');
    assert.ok(result.blockers.includes('USER_CONFIRMATION_REQUIRED'));
  });

  await test('Mode E validator accepts only fully explicit isolated configuration without exposing URI', () => {
    const privateUri = 'mongodb://fixture-user:fixture-password@fixture.invalid:27017';
    const result = evaluateMongoAcceptanceSafety({
      SANDEAL_MONGO_INTEGRATION_TEST: 'true',
      SANDEAL_STORAGE_DRIVER: 'mongo',
      MONGODB_URI: privateUri,
      MONGODB_DATABASE: 'sandeal_acceptance',
      SANDEAL_ALLOW_ISOLATED_MONGO_WRITE: 'true',
    }, true);
    assert.equal(result.status, 'READY_FOR_ISOLATED_CHECK');
    assert.equal(result.ready, true);
    assert.equal(result.requiresEmptyTargetCheck, true);
    assert.equal(result.realIsolatedMongoAcceptance, 'NOT_RUN');
    assert.equal(JSON.stringify(result).includes(privateUri), false);
    assert.equal(JSON.stringify(result).includes('fixture-password'), false);
  });

  await test('Mode E validator rejects production and unsuffixed databases', () => {
    const base = {
      SANDEAL_MONGO_INTEGRATION_TEST: 'true', SANDEAL_STORAGE_DRIVER: 'mongo',
      MONGODB_URI: 'mongodb://fixture.invalid:27017', SANDEAL_ALLOW_ISOLATED_MONGO_WRITE: 'true',
    };
    const production = evaluateMongoAcceptanceSafety({ ...base, MONGODB_DATABASE: 'sandeal' }, true);
    const development = evaluateMongoAcceptanceSafety({ ...base, MONGODB_DATABASE: 'sandeal_dev' }, true);
    assert.ok(production.blockers.includes('MIGRATION_DATABASE_FORBIDDEN'));
    assert.ok(development.blockers.includes('MIGRATION_DATABASE_NOT_ISOLATED'));
  });

  await test('acceptance check CLI never connects and reports NOT_RUN by default', () => {
    const environment = { ...process.env };
    delete environment.MONGODB_URI;
    delete environment.MONGODB_DATABASE;
    delete environment.SANDEAL_MONGO_INTEGRATION_TEST;
    delete environment.SANDEAL_ALLOW_ISOLATED_MONGO_WRITE;
    environment.SANDEAL_STORAGE_DRIVER = 'file';
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'storage-mongo-acceptance-check.cjs')], {
      cwd: root, encoding: 'utf8', env: environment,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.realIsolatedMongoAcceptance, 'NOT_RUN');
    assert.equal(report.uriConfigured, false);
  });

  await test('migration batch-size hard limit rejects more than 1000', () => {
    assert.throws(
      () => createMigrationManifest(minimalInventory(), { batchSize: 1_001 }),
      /MIGRATION_BATCH_SIZE_INVALID/
    );
  });

  await test('shadow bounds reject unbounded differences and timeout', async () => {
    const reader = {
      inspectCollection: async () => ({ exists: true, items: [] }),
      inspectSchema: async () => ({ version: 1, expectedVersion: 1, ready: true, indexReady: true, missingIndexes: [] }),
    };
    await assert.rejects(
      () => validateShadow({ source: reader, target: reader, collections: [], maxDifferences: 1_001 }),
      /SHADOW_MAX_DIFFERENCES_INVALID/
    );
    await assert.rejects(
      () => validateShadow({ source: reader, target: reader, collections: [], timeoutMs: 60_001 }),
      /SHADOW_TIMEOUT_INVALID/
    );
  });

  await test('logical backup rejects an excessive configured size bound before reading', async () => {
    let reads = 0;
    await assert.rejects(() => createMongoLogicalBackup({
      reader: { inspectCollection: async () => { reads += 1; return { exists: true, items: [] }; } },
      sourceDatabase: 'sandeal_test', collections: ['products'], outputDir: tempDir,
      maxBytes: 257 * 1024 * 1024,
    }), /MONGO_BACKUP_SIZE_LIMIT_INVALID/);
    assert.equal(reads, 0);
  });

  await test('static security excludes public URI, URI logging, destructive drops, and automatic schema apply', () => {
    const source = storageSource();
    assert.equal(source.includes('NEXT_PUBLIC_MONGODB_URI'), false);
    assert.equal(/console\.(?:log|info|warn|error)\s*\([^)]*MONGODB_URI/.test(source), false);
    assert.equal(/\.dropDatabase\s*\(/.test(source), false);
    assert.equal(/\.dropCollection\s*\(/.test(source), false);
    assert.equal(/\.dropIndex(?:es)?\s*\(/.test(source), false);
    assert.equal((source.match(/applyMongoSchema\s*\(/g) || []).length, 1);
    assert.equal(source.includes('expireAfterSeconds'), false);
  });

  await test('Mongo adapter has no file fallback or file write path', () => {
    const mongo = fs.readFileSync(path.join(root, 'src', 'lib', 'storage', 'mongoStorageAdapter.ts'), 'utf8');
    const factory = fs.readFileSync(path.join(root, 'src', 'lib', 'storage', 'storageFactory.ts'), 'utf8');
    assert.equal(mongo.includes('fileStorageAdapter'), false);
    assert.equal(mongo.includes("from 'fs'"), false);
    assert.match(factory, /config\.driver === 'file' \? fileStorageAdapter : loadMongoAdapter\(config\)/);
  });

  await test('migration, shadow, backup, and restore are not imported by application startup', () => {
    const appFiles = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) appFiles.push(fs.readFileSync(target, 'utf8'));
      }
    };
    visit(path.join(root, 'src', 'app'));
    const source = appFiles.join('\n');
    for (const moduleName of ['migrationExecutor', 'migrationInventory', 'shadowValidation', 'mongoLogicalBackup', 'mongoRestore']) {
      assert.equal(source.includes(moduleName), false, `${moduleName} must not be a startup/app import`);
    }
  });

  await test('checkpoint fencing, retry bounds, backup bounds, and shadow bounds remain present', () => {
    const migration = fs.readFileSync(path.join(root, 'src', 'lib', 'storage', 'migrationExecutor.ts'), 'utf8');
    const backup = fs.readFileSync(path.join(root, 'src', 'lib', 'storage', 'mongoLogicalBackup.ts'), 'utf8');
    const shadow = fs.readFileSync(path.join(root, 'src', 'lib', 'storage', 'shadowValidation.ts'), 'utf8');
    assert.match(migration, /checkpointRevision/);
    assert.match(migration, /leaseExpiresAt/);
    assert.match(migration, /maxBatchRetries > 5/);
    assert.match(backup, /DEFAULT_MAX_BACKUP_BYTES/);
    assert.match(shadow, /maxDifferences > 1_000/);
  });

  await test('environment example keeps file default and contains only empty Mongo URI', () => {
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    assert.match(example, /^SANDEAL_STORAGE_DRIVER=file$/m);
    assert.match(example, /^MONGODB_URI=$/m);
    assert.equal(/mongodb(?:\+srv)?:\/\//i.test(example), false);
    assert.match(example, /^SANDEAL_MONGO_INTEGRATION_TEST=$/m);
    assert.match(example, /^SANDEAL_ALLOW_ISOLATED_MONGO_WRITE=$/m);
  });

  await test('required runbooks state file default, no production cutover, and Prompt 12 exclusion', () => {
    const files = [
      'MONGODB_STORAGE_ADAPTER.md', 'MONGODB_MIGRATION_RUNBOOK.md',
      'MONGODB_ROLLBACK_RUNBOOK.md', 'MONGODB_ACCEPTANCE_REPORT.md',
    ];
    for (const file of files) assert.equal(fs.existsSync(path.join(root, 'docs', 'operations', file)), true);
    const docs = files.map(file => fs.readFileSync(path.join(root, 'docs', 'operations', file), 'utf8')).join('\n');
    assert.match(docs, /file driver remains the default|file is the default/i);
    assert.match(docs, /production (?:cutover|migration)/i);
    assert.match(docs, /Prompt 12/i);
    assert.match(docs, /REAL_ISOLATED_MONGO_ACCEPTANCE \| NOT_RUN|REAL_ISOLATED_MONGO_ACCEPTANCE.*NOT_RUN/i);
  });

  await test('generated and backup artifact roots remain gitignored', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const pattern of ['/.test-tmp/', '/.backups/', '/.release/']) assert.ok(ignore.includes(pattern));
  });

  await test('acceptance work leaves real .data unchanged and uses no network/provider', () => {
    if (actualDataMetadata) {
      assert.equal(fs.statSync(actualDataDir).mtimeMs, actualDataMetadata.mtimeMs);
      assert.equal(fs.readdirSync(actualDataDir).length, actualDataMetadata.count);
    }
    assert.equal(networkCalls, 0);
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  console.log(`\nStorage acceptance M5: ${passed} passed, ${failed} failed`);
  console.log('REAL_ISOLATED_MONGO_ACCEPTANCE: NOT_RUN');
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
  fs.rmSync(tempDir, { recursive: true, force: true });
});
