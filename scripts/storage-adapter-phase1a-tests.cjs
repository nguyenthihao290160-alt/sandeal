/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-storage-phase1a-'));
const previousDataDir = process.env.SANDEAL_DATA_DIR;
const hadStorageDriver = Object.prototype.hasOwnProperty.call(process.env, 'SANDEAL_STORAGE_DRIVER');
const previousStorageDriver = process.env.SANDEAL_STORAGE_DRIVER;
const hadMongoUri = Object.prototype.hasOwnProperty.call(process.env, 'MONGODB_URI');
const previousMongoUri = process.env.MONGODB_URI;

process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = tempDir;
delete process.env.SANDEAL_STORAGE_DRIVER;
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
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

function assertErrorCode(work, expectedCode) {
  assert.throws(work, error => error instanceof Error && error.code === expectedCode);
}

async function main() {
  const facade = require('../src/lib/storage/adapter.ts');
  const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');
  const { getStorageConfig } = require('../src/lib/storage/storageConfig.ts');
  const { getStorageAdapter } = require('../src/lib/storage/storageFactory.ts');

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_STORAGE_PHASE1A_TESTS'); };

  await test('the compatibility facade keeps every existing named export', () => {
    for (const name of [
      'getDataDir', 'ensureDataDir', 'readCollection', 'writeCollection', 'runTransaction',
      'findById', 'insertOne', 'updateOne', 'deleteOne', 'generateId',
    ]) {
      assert.equal(typeof facade[name], 'function', `${name} must remain exported`);
    }
  });

  await test('missing SANDEAL_STORAGE_DRIVER selects the file adapter', () => {
    delete process.env.SANDEAL_STORAGE_DRIVER;
    const selected = getStorageAdapter();
    assert.equal(selected.driver, 'file');
    assert.equal(selected, fileStorageAdapter);
  });

  await test('SANDEAL_STORAGE_DRIVER=file selects the file adapter', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    const selected = getStorageAdapter();
    assert.equal(selected.driver, 'file');
    assert.equal(selected, fileStorageAdapter);
  });

  await test('an invalid storage driver fails with a stable code', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'invalid';
    assertErrorCode(() => getStorageAdapter(), 'INVALID_STORAGE_DRIVER');
  });

  await test('storage config rejects a client runtime', () => {
    const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
    const previousWindow = global.window;
    global.window = {};
    try {
      assertErrorCode(() => getStorageConfig(), 'STORAGE_CONFIG_SERVER_ONLY');
    } finally {
      if (hadWindow) global.window = previousWindow;
      else delete global.window;
    }
  });

  await test('mongo selection without a URI fails without file fallback', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'mongo';
    delete process.env.MONGODB_URI;
    assertErrorCode(() => getStorageAdapter(), 'MONGO_URI_REQUIRED');
  });

  await test('the facade preserves missing, read, write, and undefined transaction behavior', async () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    assert.equal(path.resolve(facade.getDataDir()), path.resolve(tempDir));
    assert.deepEqual(await facade.readCollection('facade-fixture'), []);

    await facade.writeCollection('facade-fixture', [{ id: 'first', value: 1 }]);
    assert.deepEqual(await facade.readCollection('facade-fixture'), [{ id: 'first', value: 1 }]);
    const collectionPath = path.join(tempDir, 'facade-fixture.json');
    const beforeNoWrite = fs.readFileSync(collectionPath, 'utf8');

    await facade.runTransaction('facade-fixture', items => {
      items.push({ id: 'not-persisted', value: 2 });
      return undefined;
    });

    assert.equal(fs.readFileSync(collectionPath, 'utf8'), beforeNoWrite);
    assert.deepEqual(await facade.readCollection('facade-fixture'), [{ id: 'first', value: 1 }]);

    await facade.runTransaction('facade-fixture', items => [...items, { id: 'second', value: 2 }]);
    assert.deepEqual(await facade.readCollection('facade-fixture'), [
      { id: 'first', value: 1 },
      { id: 'second', value: 2 },
    ]);
    assert.equal(fs.readdirSync(tempDir).some(name => name.includes('.tmp.')), false);
  });

  await test('the facade preserves backup fallback, root validation, and updatedAt', async () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    await facade.writeCollection('backup-fixture', [{ id: 'version-one' }]);
    await facade.writeCollection('backup-fixture', [{ id: 'version-two' }]);
    fs.writeFileSync(path.join(tempDir, 'backup-fixture.json'), '{broken-main', 'utf8');
    assert.deepEqual(await facade.readCollection('backup-fixture'), [{ id: 'version-one' }]);

    fs.writeFileSync(path.join(tempDir, 'invalid-root.json'), '{"id":"not-an-array"}', 'utf8');
    await assert.rejects(() => facade.readCollection('invalid-root'), /collection_root_must_be_array/);

    await facade.writeCollection('update-fixture', [{ id: 'item', value: 1, updatedAt: '2020-01-01T00:00:00.000Z' }]);
    const updated = await facade.updateOne('update-fixture', 'item', { value: 2 });
    assert.equal(updated.value, 2);
    assert.notEqual(updated.updatedAt, '2020-01-01T00:00:00.000Z');
  });

  await test('file transactions remain serialized under concurrency', async () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    await facade.writeCollection('counter-fixture', [{ id: 'counter', value: 0 }]);
    await Promise.all(Array.from({ length: 6 }, () => facade.runTransaction('counter-fixture', async items => {
      const current = items[0].value;
      await new Promise(resolve => setImmediate(resolve));
      return [{ ...items[0], value: current + 1 }];
    })));
    assert.equal((await facade.readCollection('counter-fixture'))[0].value, 6);
  });

  await test('file storage health checks the isolated directory without changing data', async () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    const before = fs.readdirSync(tempDir).sort();
    const health = await fileStorageAdapter.checkHealth();
    assert.equal(health.driver, 'file');
    assert.equal(health.reachable, true);
    assert.equal(health.healthy, true);
    assert.deepEqual(fs.readdirSync(tempDir).sort(), before);
  });

  await test('all storage artifacts stay inside the temporary data directory', () => {
    assert.equal(path.resolve(process.env.SANDEAL_DATA_DIR), path.resolve(tempDir));
    for (const name of fs.readdirSync(tempDir)) {
      assert.equal(path.dirname(path.resolve(tempDir, name)), path.resolve(tempDir));
    }
  });

  console.log(`\nStorage adapter Phase 1A: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  failed += 1;
  console.error(`FAIL setup\n${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
}).finally(() => {
  if (previousDataDir === undefined) delete process.env.SANDEAL_DATA_DIR;
  else process.env.SANDEAL_DATA_DIR = previousDataDir;

  if (hadStorageDriver) process.env.SANDEAL_STORAGE_DRIVER = previousStorageDriver;
  else delete process.env.SANDEAL_STORAGE_DRIVER;

  if (hadMongoUri) process.env.MONGODB_URI = previousMongoUri;
  else delete process.env.MONGODB_URI;

  fs.rmSync(tempDir, { recursive: true, force: true });
});
