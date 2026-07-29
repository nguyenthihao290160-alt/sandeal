/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-bounded-storage-parity-'));
const previousDataDir = process.env.SANDEAL_DATA_DIR;
const hadDataDir = Object.prototype.hasOwnProperty.call(process.env, 'SANDEAL_DATA_DIR');
process.env.NODE_ENV = 'test';
process.env.SANDEAL_DATA_DIR = tempDir;
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

function valueAt(document, dotted) {
  return dotted.split('.').reduce((value, key) => value?.[key], document);
}

function matches(document, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    const actual = valueAt(document, key);
    if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, '$ne')) {
      return actual !== expected.$ne;
    }
    return actual === expected;
  });
}

function sortDocuments(documents, specification) {
  const entries = Object.entries(specification);
  return documents.sort((left, right) => {
    for (const [field, direction] of entries) {
      const leftValue = valueAt(left, field);
      const rightValue = valueAt(right, field);
      const compared = String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
      if (compared) return compared * direction;
    }
    return 0;
  });
}

class FakeCursor {
  constructor(documents, metrics) {
    this.documents = documents;
    this.metrics = metrics;
    this.index = 0;
    this.maximumDocuments = documents.length;
  }
  sort(specification) {
    sortDocuments(this.documents, specification);
    return this;
  }
  limit(count) {
    this.maximumDocuments = Math.min(this.documents.length, count);
    return this;
  }
  async hasNext() {
    return this.index < this.maximumDocuments;
  }
  async next() {
    if (!await this.hasNext()) return null;
    const document = structuredClone(this.documents[this.index]);
    this.index += 1;
    if (this.metrics) this.metrics.documentsRead += 1;
    return document;
  }
  async close() {
    if (this.metrics) this.metrics.closed = true;
  }
  async toArray() {
    const documents = structuredClone(this.documents.slice(this.index, this.maximumDocuments));
    this.index = this.maximumDocuments;
    if (this.metrics) {
      this.metrics.documentsRead += documents.length;
      this.metrics.materializedByToArray = true;
    }
    return documents;
  }
}

class FakeSession {
  constructor(database) {
    this.database = database;
    this.active = false;
  }
  startTransaction() {
    this.active = true;
    this.working = new Map(
      [...this.database.collections].map(([name, rows]) => [name, structuredClone(rows)]),
    );
  }
  inTransaction() {
    return this.active;
  }
  markWrite() {}
  async commitTransaction() {
    this.database.collections = this.working;
    this.active = false;
  }
  async abortTransaction() {
    this.active = false;
  }
  async endSession() {}
}

class FakeCollection {
  constructor(database, name) {
    this.database = database;
    this.name = name;
  }
  storage(session, create = false) {
    const collections = session?.active ? session.working : this.database.collections;
    if (!collections.has(this.name) && create) collections.set(this.name, []);
    return collections.get(this.name) || [];
  }
  async findOne(filter, options = {}) {
    return structuredClone(this.storage(options.session).find(row => matches(row, filter)) || null);
  }
  find(filter, options = {}) {
    const documents = this.storage(options.session).filter(row => matches(row, filter));
    const metrics = {
      collection: this.name,
      matchingDocuments: documents.length,
      documentsRead: 0,
      materializedByToArray: false,
      closed: false,
    };
    this.database.cursorMetrics.push(metrics);
    return new FakeCursor(documents, metrics);
  }
  aggregate(pipeline, options = {}) {
    let rows = structuredClone(this.storage(options.session));
    let output = [];
    for (const stage of pipeline) {
      if (stage.$match) rows = rows.filter(row => matches(row, stage.$match));
      if (stage.$sort) rows = sortDocuments(rows, stage.$sort);
      if (stage.$facet) {
        let page = rows;
        for (const operation of stage.$facet.rows) {
          if (operation.$skip !== undefined) page = page.slice(operation.$skip);
          if (operation.$limit !== undefined) page = page.slice(0, operation.$limit);
        }
        output = [{ rows: page, count: rows.length ? [{ total: rows.length }] : [] }];
      }
    }
    return new FakeCursor(output);
  }
  async insertOne(document, options = {}) {
    this.storage(options.session, true).push(structuredClone(document));
    return { acknowledged: true };
  }
  async insertMany(documents, options = {}) {
    this.storage(options.session, true).push(...structuredClone(documents));
    return { acknowledged: true };
  }
  async updateOne(filter, update, options = {}) {
    const target = this.storage(options.session, Boolean(options.upsert));
    const index = target.findIndex(row => matches(row, filter));
    if (index >= 0) {
      target[index] = { ...target[index], ...structuredClone(update.$set || {}) };
      return { matchedCount: 1 };
    }
    if (options.upsert) {
      target.push({ ...filter, ...structuredClone(update.$set || {}) });
      return { matchedCount: 0 };
    }
    return { matchedCount: 0 };
  }
  async deleteMany(filter, options = {}) {
    const collections = options.session?.active ? options.session.working : this.database.collections;
    collections.set(this.name, this.storage(options.session).filter(row => !matches(row, filter)));
    return { acknowledged: true };
  }
}

class FakeDatabase {
  constructor() {
    this.cursorMetrics = [];
    this.collections = new Map([[
      'sandeal_storage_metadata',
      [{ _id: 'storage_schema', kind: 'schema', version: 1, updatedAt: new Date(0).toISOString() }],
    ]]);
  }
  collection(name) {
    return new FakeCollection(this, name);
  }
}

class FakeConnection {
  constructor(database) {
    this.database = database;
  }
  async getDatabase() {
    return this.database;
  }
  async startSession() {
    return new FakeSession(this.database);
  }
}

async function main() {
  const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');
  const { createMongoStorageAdapter } = require('../src/lib/storage/mongoStorageAdapter.ts');
  const fakeDatabase = new FakeDatabase();
  const mongo = createMongoStorageAdapter(
    { driver: 'mongo', database: 'sandeal' },
    new FakeConnection(fakeDatabase),
  );
  const fixtures = [
    { id: 'first', status: 'PENDING', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'second', status: 'PENDING', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'third', status: 'FAILED', createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'fourth', status: 'PENDING', createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  await fileStorageAdapter.writeCollection('page-parity-fixture', fixtures);
  await mongo.writeCollection('page-parity-fixture', fixtures);

  await test('file and Mongo pagination use the same filtering, ordering, and totals', async () => {
    const options = {
      page: 1,
      pageSize: 2,
      filters: { status: 'PENDING' },
      sort: { field: 'createdAt', direction: 'desc' },
    };
    const [filePage, mongoPage] = await Promise.all([
      fileStorageAdapter.readCollectionPage('page-parity-fixture', options),
      mongo.readCollectionPage('page-parity-fixture', options),
    ]);
    assert.deepEqual(filePage.items, mongoPage.items);
    assert.equal(filePage.totalItems, mongoPage.totalItems);
    assert.deepEqual(filePage.items.map(item => item.id), ['first', 'second']);
    assert.equal(filePage.queryCount, 1);
    assert.equal(mongoPage.queryCount, 3);
  });

  await test('file and Mongo reject the same invalid page bounds', async () => {
    for (const adapter of [fileStorageAdapter, mongo]) {
      await assert.rejects(
        () => adapter.readCollectionPage('page-parity-fixture', { page: 0, pageSize: 1 }),
        error => error instanceof Error && error.code === 'INVALID_STORAGE_QUERY',
      );
      await assert.rejects(
        () => adapter.readCollectionPage('page-parity-fixture', { page: 1, pageSize: 10_001 }),
        error => error instanceof Error && error.code === 'INVALID_STORAGE_QUERY',
      );
    }
  });

  await test('Mongo bounded snapshots preserve specific limit classifications', async () => {
    const snapshot = await mongo.readBoundedCollectionSnapshot('page-parity-fixture', {
      maximumItems: 4,
      maximumBytes: 4_096,
    });
    assert.equal(snapshot.metadata.driver, 'mongo');
    assert.equal(snapshot.metadata.collectionPresent, true);
    assert.equal(snapshot.metadata.itemCount, 4);
    assert.equal(snapshot.metadata.queryCount, 3);
    assert.equal(snapshot.metadata.observedBytes, Buffer.byteLength(JSON.stringify(fixtures), 'utf8'));
    assert.deepEqual(snapshot.items.map(item => item.id), fixtures.map(item => item.id));
    await assert.rejects(
      () => mongo.readBoundedCollection('page-parity-fixture', { maximumItems: 3, maximumBytes: 4_096 }),
      error => error instanceof Error && error.code === 'BOUNDED_COLLECTION_ITEM_LIMIT_EXCEEDED',
    );
    await assert.rejects(
      () => mongo.readBoundedCollection('page-parity-fixture', { maximumItems: 4, maximumBytes: 8 }),
      error => error instanceof Error && error.code === 'BOUNDED_COLLECTION_BYTE_LIMIT_EXCEEDED',
    );
    await assert.rejects(
      () => mongo.readBoundedCollection('page-parity-fixture', { maximumItems: Number.NaN, maximumBytes: 4_096 }),
      error => error instanceof Error && error.code === 'BOUNDED_COLLECTION_OPTIONS_INVALID',
    );
  });

  await test('Mongo bounded snapshots distinguish missing from present empty collections', async () => {
    const missing = await mongo.readBoundedCollectionSnapshot('missing-parity-fixture', {
      maximumItems: 4,
      maximumBytes: 4_096,
    });
    assert.equal(missing.metadata.collectionPresent, false);
    assert.equal(missing.metadata.queryCount, 2);
    await mongo.writeCollection('empty-parity-fixture', []);
    const empty = await mongo.readBoundedCollectionSnapshot('empty-parity-fixture', {
      maximumItems: 4,
      maximumBytes: 4_096,
    });
    assert.equal(empty.metadata.collectionPresent, true);
    assert.deepEqual(empty.items, []);
  });

  await test('Mongo byte bounds stop a production-sized cursor before materializing its result', async () => {
    const collection = 'oversized-stream-fixture';
    const itemCount = 10_000;
    const revision = 1;
    const payload = 'x'.repeat(512);
    const items = Array.from({ length: itemCount }, (_, order) => ({
      id: `large-${order}`,
      payload,
    }));
    fakeDatabase.collections.get('sandeal_storage_metadata').push({
      _id: collection,
      kind: 'collection',
      revision,
      itemCount,
      serializedBytes: Buffer.byteLength(JSON.stringify(items), 'utf8'),
      updatedAt: new Date().toISOString(),
    });
    fakeDatabase.collections.set(collection, items.map((item, order) => ({
      revision,
      order,
      itemId: `large-${order}`,
      item,
    })));

    const metricStart = fakeDatabase.cursorMetrics.length;
    const startedAt = performance.now();
    await assert.rejects(
      () => mongo.readBoundedCollection(collection, {
        maximumItems: itemCount,
        maximumBytes: 2_048,
      }),
      error => error instanceof Error && error.code === 'BOUNDED_COLLECTION_BYTE_LIMIT_EXCEEDED',
    );
    const elapsedMs = performance.now() - startedAt;
    const metrics = fakeDatabase.cursorMetrics.slice(metricStart)
      .filter(item => item.collection === collection);
    assert.equal(metrics.length, 0, 'oversized revision must be rejected before opening a data cursor');
    console.log(
      `BENCHMARK mongoBoundedItems=${itemCount} documentsRead=0 `
      + `elapsedMs=${elapsedMs.toFixed(1)}`,
    );
  });

  await test('Mongo bounded reads reject legacy revisions without exact byte metadata', async () => {
    const collection = 'legacy-metadata-fixture';
    fakeDatabase.collections.get('sandeal_storage_metadata').push({
      _id: collection,
      kind: 'collection',
      revision: 1,
      updatedAt: new Date().toISOString(),
    });
    fakeDatabase.collections.set(collection, [{
      revision: 1,
      order: 0,
      itemId: 'legacy-item',
      item: { id: 'legacy-item' },
    }]);
    await assert.rejects(
      () => mongo.readBoundedCollection(collection, {
        maximumItems: 10,
        maximumBytes: 4_096,
      }),
      error => error instanceof Error && error.code === 'BOUNDED_COLLECTION_METADATA_INCOMPLETE',
    );
  });

  console.log(`\nBounded storage parity: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  failed += 1;
  console.error(`FAIL setup\n${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
}).finally(() => {
  if (hadDataDir) process.env.SANDEAL_DATA_DIR = previousDataDir;
  else delete process.env.SANDEAL_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
