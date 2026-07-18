/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-storage-mongo-'));
const savedEnv = {
  SANDEAL_STORAGE_DRIVER: process.env.SANDEAL_STORAGE_DRIVER,
  SANDEAL_DATA_DIR: process.env.SANDEAL_DATA_DIR,
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

function errorCode(expected) {
  return error => error instanceof Error && error.code === expected;
}

class FakeMongoError extends Error {
  constructor(message, labels = [], code) {
    super(message);
    this.labels = new Set(labels);
    this.code = code;
  }
  hasErrorLabel(label) { return this.labels.has(label); }
}

function cloneCollections(collections) {
  return new Map([...collections].map(([name, documents]) => [name, structuredClone(documents)]));
}

function matches(document, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, '$ne')) {
      return document[key] !== expected.$ne;
    }
    return document[key] === expected;
  });
}

class FakeSession {
  constructor(database) {
    this.database = database;
    this.active = false;
    this.ended = false;
    this.wrote = false;
  }
  startTransaction() {
    this.active = true;
    this.baseGeneration = this.database.generation;
    this.workingCollections = cloneCollections(this.database.collections);
    this.database.transactionStarts += 1;
  }
  inTransaction() { return this.active; }
  markWrite() { this.wrote = true; }
  async commitTransaction() {
    this.database.commitAttempts += 1;
    if (this.database.unknownCommitFailures > 0) {
      this.database.unknownCommitFailures -= 1;
      throw new FakeMongoError('mongodb://secret-host/unknown', ['UnknownTransactionCommitResult']);
    }
    if (this.database.commitFailures > 0) {
      this.database.commitFailures -= 1;
      throw new FakeMongoError('mongodb://secret-host/transient', ['TransientTransactionError']);
    }
    if (this.wrote && this.baseGeneration !== this.database.generation) {
      throw new FakeMongoError('write conflict at mongodb://secret-host', ['TransientTransactionError']);
    }
    if (this.wrote) {
      this.database.collections = this.workingCollections;
      this.database.generation += 1;
      this.database.commits += 1;
    }
    this.active = false;
  }
  async abortTransaction() {
    this.database.aborts += 1;
    this.active = false;
  }
  async endSession() {
    this.ended = true;
    this.database.sessionsEnded += 1;
  }
}

class FakeCursor {
  constructor(documents) { this.documents = documents; }
  sort(specification) {
    const [[key, direction]] = Object.entries(specification);
    this.documents.sort((left, right) => (left[key] - right[key]) * direction);
    return this;
  }
  async toArray() { return structuredClone(this.documents); }
}

class FakeCollection {
  constructor(database, name) {
    this.database = database;
    this.name = name;
  }
  storage(session, create = false) {
    const collections = session?.active ? session.workingCollections : this.database.collections;
    if (!collections.has(this.name) && create) {
      collections.set(this.name, []);
      this.database.collectionCreates += 1;
    }
    return collections.get(this.name) || [];
  }
  async findOne(filter, options = {}) {
    return structuredClone(this.storage(options?.session).find(document => matches(document, filter)) || null);
  }
  find(filter, options = {}) {
    return new FakeCursor(this.storage(options?.session).filter(document => matches(document, filter)));
  }
  async insertOne(document, options = {}) {
    const target = this.storage(options?.session, true);
    if (document._id !== undefined && target.some(item => item._id === document._id)) {
      throw new FakeMongoError('duplicate key', [], 11000);
    }
    options?.session?.markWrite();
    target.push(structuredClone(document));
    this.database.writeOperations += 1;
    return { acknowledged: true, insertedId: document._id };
  }
  async insertMany(documents, options = {}) {
    if (this.database.insertManyFailures > 0) {
      this.database.insertManyFailures -= 1;
      throw new FakeMongoError('insert failed with mongodb://user:password@host', this.database.insertFailureLabels);
    }
    const target = this.storage(options?.session, true);
    options?.session?.markWrite();
    for (const document of documents) target.push({ _id: `fake-${this.database.nextId++}`, ...structuredClone(document) });
    this.database.writeOperations += 1;
    return { acknowledged: true, insertedCount: documents.length };
  }
  async updateOne(filter, update, options = {}) {
    const target = this.storage(options?.session, Boolean(options?.upsert));
    const index = target.findIndex(document => matches(document, filter));
    if (index === -1) {
      if (!options?.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      const inserted = { ...Object.fromEntries(Object.entries(filter).filter(([, value]) => !value || typeof value !== 'object')), ...structuredClone(update.$set || {}) };
      target.push(inserted);
      options?.session?.markWrite();
      this.database.writeOperations += 1;
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: inserted._id };
    }
    target[index] = { ...target[index], ...structuredClone(update.$set || {}) };
    options?.session?.markWrite();
    this.database.writeOperations += 1;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  }
  async deleteMany(filter, options = {}) {
    const target = this.storage(options?.session, true);
    const kept = target.filter(document => !matches(document, filter));
    const deletedCount = target.length - kept.length;
    const collections = options?.session?.active ? options.session.workingCollections : this.database.collections;
    collections.set(this.name, kept);
    options?.session?.markWrite();
    this.database.writeOperations += 1;
    return { acknowledged: true, deletedCount };
  }
  listIndexes() {
    const names = this.database.indexes.get(this.name) || new Set(['_id_']);
    return new FakeCursor([...names].map(name => ({ name })));
  }
  async createIndex(keys, options = {}) {
    if (!this.database.collections.has(this.name)) {
      this.database.collections.set(this.name, []);
      this.database.collectionCreates += 1;
    }
    const names = this.database.indexes.get(this.name) || new Set(['_id_']);
    names.add(options.name);
    this.database.indexes.set(this.name, names);
    this.database.indexCreates += 1;
    return options.name;
  }
}

class FakeDatabase {
  constructor(schemaVersion = 1) {
    this.collections = new Map();
    this.indexes = new Map();
    this.generation = 0;
    this.nextId = 1;
    this.transactionStarts = 0;
    this.commitAttempts = 0;
    this.commits = 0;
    this.aborts = 0;
    this.sessionsEnded = 0;
    this.writeOperations = 0;
    this.collectionCreates = 0;
    this.indexCreates = 0;
    this.insertManyFailures = 0;
    this.insertFailureLabels = [];
    this.commitFailures = 0;
    this.unknownCommitFailures = 0;
    if (schemaVersion !== null) {
      this.collections.set('sandeal_storage_metadata', [{
        _id: 'storage_schema', kind: 'schema', version: schemaVersion, updatedAt: new Date(0).toISOString(),
      }]);
      this.indexes.set('sandeal_storage_metadata', new Set(['_id_']));
    }
  }
  collection(name) { return new FakeCollection(this, name); }
  listCollections() {
    return new FakeCursor([...this.collections.keys()].map(name => ({ name, type: 'collection' })));
  }
  async command() {
    if (this.pingError) throw this.pingError;
    return { ok: 1 };
  }
}

class FakeConnection {
  constructor(database = new FakeDatabase()) {
    this.database = database;
    this.databaseCalls = 0;
    this.sessionCalls = 0;
    this.closed = 0;
  }
  async getDatabase() {
    this.databaseCalls += 1;
    if (this.connectionError) throw this.connectionError;
    return this.database;
  }
  async startSession() {
    this.sessionCalls += 1;
    if (this.sessionError) throw this.sessionError;
    return new FakeSession(this.database);
  }
  async close() { this.closed += 1; }
}

async function main() {
  const factoryPath = require.resolve('../src/lib/storage/storageFactory.ts');
  const mongoClientPath = require.resolve('../src/lib/storage/mongoClient.ts');
  const { getStorageConfig } = require('../src/lib/storage/storageConfig.ts');
  const { getStorageAdapter } = require(factoryPath);
  const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');

  global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_MONGO_STORAGE_TESTS'); };

  await test('config defaults to file without Mongo configuration', () => {
    delete process.env.SANDEAL_STORAGE_DRIVER;
    delete process.env.MONGODB_URI;
    assert.deepEqual(getStorageConfig(), { driver: 'file' });
    assert.equal(getStorageAdapter(), fileStorageAdapter);
  });

  await test('explicit file does not load Mongo client or require a URI', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'file';
    delete process.env.MONGODB_URI;
    assert.equal(getStorageAdapter(), fileStorageAdapter);
    assert.equal(require.cache[mongoClientPath], undefined);
  });

  await test('mongo requires a URI and never falls back to file', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'mongo';
    delete process.env.MONGODB_URI;
    assert.throws(() => getStorageAdapter(), errorCode('MONGO_URI_REQUIRED'));
  });

  await test('mongo URI and database validation use stable sanitized errors', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'mongo';
    process.env.MONGODB_URI = 'not-a-mongo-uri-with-password';
    assert.throws(() => getStorageConfig(), errorCode('MONGO_URI_INVALID'));
    process.env.MONGODB_URI = 'mongodb://fixture-user:fixture-password@fixture.invalid:27017';
    process.env.MONGODB_DATABASE = 'bad/name';
    let caught;
    try { getStorageConfig(); } catch (error) { caught = error; }
    assert.equal(caught.code, 'MONGO_DATABASE_INVALID');
    assert.equal(JSON.stringify(caught).includes('fixture-password'), false);
    assert.equal(caught.message.includes('mongodb://'), false);
  });

  await test('mongo database defaults to sandeal and explicit blank is invalid', () => {
    process.env.MONGODB_URI = 'mongodb://fixture.invalid:27017';
    delete process.env.MONGODB_DATABASE;
    assert.equal(getStorageConfig().database, 'sandeal');
    process.env.MONGODB_DATABASE = '';
    assert.throws(() => getStorageConfig(), errorCode('MONGO_DATABASE_INVALID'));
  });

  await test('invalid driver fails instead of silently using file', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'other';
    assert.throws(() => getStorageConfig(), errorCode('INVALID_STORAGE_DRIVER'));
  });

  await test('selecting mongo lazily constructs an adapter without connecting', () => {
    process.env.SANDEAL_STORAGE_DRIVER = 'mongo';
    process.env.MONGODB_URI = 'mongodb://fixture.invalid:27017';
    process.env.MONGODB_DATABASE = 'sandeal';
    const selected = getStorageAdapter();
    assert.equal(selected.driver, 'mongo');
    assert.ok(require.cache[mongoClientPath]);
  });

  const { createMongoStorageAdapter } = require('../src/lib/storage/mongoStorageAdapter.ts');
  const { validateCollectionName, normalizeCollectionPayload } = require('../src/lib/storage/mongoSerialization.ts');
  const {
    MONGO_LOGICAL_COLLECTIONS,
    MONGO_STORAGE_METADATA_COLLECTION,
    planMongoSchema,
    inspectMongoSchema,
    applyMongoSchema,
  } = require('../src/lib/storage/mongoSchema.ts');
  const config = { driver: 'mongo', database: 'sandeal' };

  await test('all repository collection names pass the bounded validator', () => {
    for (const name of MONGO_LOGICAL_COLLECTIONS) assert.equal(validateCollectionName(name), name);
    const discovered = new Set();
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const source = fs.readFileSync(target, 'utf8');
          const pattern = /\b(?:[A-Z_]*COLLECTION[A-Z_]*|JOBS|CONTROL|AUDIT|USAGE|CIRCUITS|EVENTS|DAILY|ALERTS|ACTIONS|CHECKPOINTS)\s*=\s*['"]([^'"]+)['"]/g;
          for (const match of source.matchAll(pattern)) discovered.add(match[1]);
        }
      }
    };
    visit(path.join(root, 'src'));
    for (const name of discovered) {
      if (name !== MONGO_STORAGE_METADATA_COLLECTION) {
        assert.ok(MONGO_LOGICAL_COLLECTIONS.includes(name), `schema manifest is missing ${name}`);
      }
    }
    for (const invalid of ['', 'system.users', 'bad$name', `bad\0name`, 'x'.repeat(121), '../products']) {
      assert.throws(() => validateCollectionName(invalid), errorCode('INVALID_COLLECTION_NAME'));
    }
  });

  await test('serialization rejects non-array and unsafe values before database access', async () => {
    const connection = new FakeConnection();
    const adapter = createMongoStorageAdapter(config, connection);
    await assert.rejects(() => adapter.writeCollection('products', {}), errorCode('INVALID_STORAGE_PAYLOAD'));
    await assert.rejects(() => adapter.writeCollection('products', [{ value: undefined }]), errorCode('INVALID_STORAGE_PAYLOAD'));
    await assert.rejects(() => adapter.writeCollection('products', [{ value() {} }]), errorCode('INVALID_STORAGE_PAYLOAD'));
    assert.equal(connection.databaseCalls, 0);
    assert.throws(() => normalizeCollectionPayload([1n]), errorCode('INVALID_STORAGE_PAYLOAD'));
  });

  await test('missing logical collection reads empty without creating it', async () => {
    const database = new FakeDatabase();
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    assert.deepEqual(await adapter.readCollection('products'), []);
    assert.equal(database.collections.has('products'), false);
    assert.equal(database.collectionCreates, 0);
  });

  await test('round trip preserves order, nested JSON values, missing ids, and Date string semantics', async () => {
    const database = new FakeDatabase();
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    const date = new Date('2026-07-18T00:00:00.000Z');
    await adapter.writeCollection('products', [
      { id: 'second', nested: { array: [1, null, true, { value: 'ok' }] }, createdAt: date },
      { label: 'without-domain-id', enabled: false },
      null,
    ]);
    const result = await adapter.readCollection('products');
    assert.deepEqual(result, [
      { id: 'second', nested: { array: [1, null, true, { value: 'ok' }] }, createdAt: date.toISOString() },
      { label: 'without-domain-id', enabled: false },
      null,
    ]);
    assert.equal(JSON.stringify(result).includes('itemId'), false);
    assert.equal(JSON.stringify(result).includes('revision'), false);
    assert.equal(JSON.stringify(result).includes('_id'), false);
  });

  await test('write uses one atomic fake transaction and advances revision', async () => {
    const database = new FakeDatabase();
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    await adapter.writeCollection('products', [{ id: 'one' }]);
    const metadata = database.collections.get('sandeal_storage_metadata').find(item => item._id === 'products');
    assert.equal(metadata.revision, 1);
    assert.equal(database.commits, 1);
    assert.equal(database.sessionsEnded, 1);
  });

  await test('write failure aborts without a partial visible state or file fallback', async () => {
    const database = new FakeDatabase();
    database.insertManyFailures = 1;
    database.insertFailureLabels = [];
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    await assert.rejects(() => adapter.writeCollection('products', [{ id: 'broken' }]), errorCode('MONGO_TRANSACTION_FAILED'));
    assert.equal(database.collections.get('sandeal_storage_metadata').some(item => item._id === 'products'), false);
    assert.equal(database.collections.has('products'), false);
    assert.deepEqual(fs.readdirSync(tempDir), []);
    assert.equal(database.aborts, 1);
    assert.equal(database.sessionsEnded, 1);
  });

  await test('undefined transaction result aborts without write, revision, or collection creation', async () => {
    const database = new FakeDatabase();
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    await adapter.runTransaction('products', items => { items.push({ id: 'local-only' }); return undefined; });
    assert.equal(database.collections.has('products'), false);
    assert.equal(database.collections.get('sandeal_storage_metadata').some(item => item._id === 'products'), false);
    assert.equal(database.commits, 0);
    assert.equal(database.aborts, 1);
    assert.equal(database.sessionsEnded, 1);
  });

  await test('transaction array result commits exactly once', async () => {
    const database = new FakeDatabase();
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    let callbacks = 0;
    await adapter.runTransaction('products', items => { callbacks += 1; return [...items, { id: 'committed' }]; });
    assert.equal(callbacks, 1);
    assert.deepEqual(await adapter.readCollection('products'), [{ id: 'committed' }]);
    assert.equal(database.commits, 1);
  });

  await test('callback throw aborts and preserves the original callback error', async () => {
    const database = new FakeDatabase();
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    const callbackError = new Error('domain-callback-failed');
    await assert.rejects(() => adapter.runTransaction('products', () => { throw callbackError; }), error => error === callbackError);
    assert.equal(database.aborts, 1);
    assert.equal(database.writeOperations, 0);
    assert.equal(database.sessionsEnded, 1);
  });

  await test('transient database failure retries prepared writes without rerunning callback', async () => {
    const database = new FakeDatabase();
    database.insertManyFailures = 1;
    database.insertFailureLabels = ['TransientTransactionError'];
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    let callbacks = 0;
    await adapter.runTransaction('products', items => { callbacks += 1; return [...items, { id: 'once' }]; });
    assert.equal(callbacks, 1);
    assert.deepEqual(await adapter.readCollection('products'), [{ id: 'once' }]);
    assert.equal(database.transactionStarts, 3);
    assert.equal(database.sessionsEnded, 3);
  });

  await test('unknown commit result retries commit only and remains bounded', async () => {
    const database = new FakeDatabase();
    database.unknownCommitFailures = 1;
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    let callbacks = 0;
    await adapter.runTransaction('products', items => { callbacks += 1; return [...items, { id: 'commit-once' }]; });
    assert.equal(callbacks, 1);
    assert.equal(database.commitAttempts, 2);
    assert.equal(database.commits, 1);
  });

  await test('transient transaction retries are bounded and never replay the callback', async () => {
    const database = new FakeDatabase();
    database.insertManyFailures = 3;
    database.insertFailureLabels = ['TransientTransactionError'];
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    let callbacks = 0;
    await assert.rejects(
      () => adapter.runTransaction('products', items => { callbacks += 1; return [...items, { id: 'bounded' }]; }),
      errorCode('MONGO_TRANSACTION_FAILED')
    );
    assert.equal(callbacks, 1);
    assert.equal(database.transactionStarts, 3);
    assert.equal(database.sessionsEnded, 3);
  });

  await test('revision conflict is explicit and callbacks are never replayed', async () => {
    const database = new FakeDatabase();
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    await adapter.writeCollection('products', [{ id: 'base', value: 0 }]);
    let firstEntered;
    const entered = new Promise(resolve => { firstEntered = resolve; });
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    let firstCallbacks = 0;
    let secondCallbacks = 0;
    const first = adapter.runTransaction('products', async items => {
      firstCallbacks += 1;
      firstEntered();
      await gate;
      return [{ ...items[0], value: 1 }];
    });
    await entered;
    await adapter.runTransaction('products', items => {
      secondCallbacks += 1;
      return [{ ...items[0], value: 2 }];
    });
    releaseFirst();
    await assert.rejects(() => first, errorCode('MONGO_TRANSACTION_CONFLICT'));
    assert.equal(firstCallbacks, 1);
    assert.equal(secondCallbacks, 1);
    assert.equal((await adapter.readCollection('products'))[0].value, 2);
  });

  await test('health distinguishes reachable, schema-ready, and schema-mismatch states without secrets', async () => {
    const ready = createMongoStorageAdapter(config, new FakeConnection(new FakeDatabase(1)));
    const readyHealth = await ready.checkHealth();
    assert.equal(readyHealth.configured, true);
    assert.equal(readyHealth.reachable, true);
    assert.equal(readyHealth.healthy, true);
    assert.equal(readyHealth.schemaVersion, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(readyHealth, 'uri'), false);

    const mismatch = createMongoStorageAdapter(config, new FakeConnection(new FakeDatabase(2)));
    const mismatchHealth = await mismatch.checkHealth();
    assert.equal(mismatchHealth.reachable, true);
    assert.equal(mismatchHealth.healthy, false);
    assert.equal(mismatchHealth.errorCode, 'MONGO_SCHEMA_VERSION_MISMATCH');
  });

  await test('failed ping health is sanitized and never falls back', async () => {
    const database = new FakeDatabase();
    database.pingError = new Error('mongodb://user:fixture-password@private-host/db?authSource=admin');
    const adapter = createMongoStorageAdapter(config, new FakeConnection(database));
    const health = await adapter.checkHealth();
    const serialized = JSON.stringify(health);
    assert.equal(health.reachable, false);
    assert.equal(health.errorCode, 'MONGO_CONNECTION_FAILED');
    assert.equal(serialized.includes('fixture-password'), false);
    assert.equal(serialized.includes('mongodb://'), false);
    assert.deepEqual(fs.readdirSync(tempDir), []);
  });

  await test('schema plan is stable, generic, and dry-run has no database side effects', async () => {
    const database = new FakeDatabase();
    const before = JSON.stringify([...database.collections]);
    const first = planMongoSchema();
    const second = planMongoSchema();
    assert.deepEqual(first, second);
    assert.ok(first.some(index => index.name === 'sandeal_revision_order_unique'));
    assert.ok(first.every(index => index.action === 'ensure'));
    assert.equal(JSON.stringify(first).includes('fixture-password'), false);
    assert.equal(JSON.stringify([...database.collections]), before);
    assert.equal(database.indexCreates, 0);
  });

  await test('schema inspection reports mismatch without applying indexes or creating collections', async () => {
    const database = new FakeDatabase();
    const beforeCollections = [...database.collections.keys()];
    const inspection = await inspectMongoSchema(database);
    assert.equal(inspection.version, 1);
    assert.equal(inspection.ready, false);
    assert.ok(inspection.missingIndexes.length > 0);
    assert.deepEqual([...database.collections.keys()], beforeCollections);
    assert.equal(database.indexCreates, 0);
    assert.equal(database.writeOperations, 0);
  });

  await test('explicit schema apply is idempotent in fake storage and never runs implicitly', async () => {
    const database = new FakeDatabase();
    assert.equal(database.indexCreates, 0);
    const first = await applyMongoSchema(database);
    assert.equal(first.ready, true);
    const collectionCount = database.collections.size;
    const indexState = JSON.stringify([...database.indexes].map(([name, values]) => [name, [...values].sort()]).sort());
    const second = await applyMongoSchema(database);
    assert.equal(second.ready, true);
    assert.equal(database.collections.size, collectionCount);
    assert.equal(JSON.stringify([...database.indexes].map(([name, values]) => [name, [...values].sort()]).sort()), indexState);

    const mismatch = new FakeDatabase(2);
    await assert.rejects(() => applyMongoSchema(mismatch), errorCode('MONGO_SCHEMA_VERSION_MISMATCH'));
    assert.equal(mismatch.indexCreates, 0);
  });

  await test('static safety excludes public URI, destructive calls, auto apply, dual write, and withTransaction', () => {
    const storageDir = path.join(root, 'src', 'lib', 'storage');
    const files = ['mongoClient.ts', 'mongoStorageAdapter.ts', 'mongoSchema.ts', 'storageFactory.ts', 'storageConfig.ts'];
    const source = files.map(file => fs.readFileSync(path.join(storageDir, file), 'utf8')).join('\n');
    assert.equal(source.includes('NEXT_PUBLIC_MONGODB_URI'), false);
    assert.equal(/console\.(?:log|info|warn|error)\s*\(/.test(source), false);
    assert.equal(/\.dropDatabase\s*\(/.test(source), false);
    assert.equal(/\.dropCollection\s*\(/.test(source), false);
    assert.equal(/\.dropIndex(?:es)?\s*\(/.test(source), false);
    assert.equal(/\.withTransaction\s*\(/.test(source), false);
    const mongoAdapterSource = fs.readFileSync(path.join(storageDir, 'mongoStorageAdapter.ts'), 'utf8');
    assert.equal(mongoAdapterSource.includes("from './fileStorageAdapter'"), false);
    assert.equal((source.match(/applyMongoSchema\s*\(/g) || []).length, 1);
    const factorySource = fs.readFileSync(path.join(storageDir, 'storageFactory.ts'), 'utf8');
    assert.match(factorySource, /function loadMongoAdapter[\s\S]+require\('\.\/mongoStorageAdapter'\)/);
    assert.match(factorySource, /return config\.driver === 'file' \? fileStorageAdapter : loadMongoAdapter\(config\)/);
    const clientSource = fs.readFileSync(path.join(storageDir, 'mongoClient.ts'), 'utf8');
    assert.ok(clientSource.indexOf('async function connectedClient') < clientSource.indexOf('client.connect()'));
  });

  await test('Mongo adapter file-path compatibility methods fail closed without touching SANDEAL_DATA_DIR', async () => {
    const adapter = createMongoStorageAdapter(config, new FakeConnection());
    assert.throws(() => adapter.getDataDir(), errorCode('MONGO_OPERATION_FAILED'));
    await assert.rejects(() => adapter.ensureDataDir(), errorCode('MONGO_OPERATION_FAILED'));
    assert.deepEqual(fs.readdirSync(tempDir), []);
  });

  console.log(`\nMongo storage M2: ${passed} passed, ${failed} failed`);
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
