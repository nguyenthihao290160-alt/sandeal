/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openLocalD1, applyLocalMigrations } = require('./lib/local-d1.cjs');
require('./register-typescript.cjs');
const { runDomainContract, fixture } = require('./fixtures/v6-domain-contract.cjs');
const { createStorage, withStorageAdapter } = require('../src/lib/storage/storageFactory.ts');
const { createD1StorageAdapter } = require('../src/lib/storage/d1/d1StorageAdapter.ts');
const products = require('../src/lib/storage/products.ts');
const history = require('../src/lib/product-intelligence/priceHistory.ts');
let passed = 0; let failed = 0;
async function test(name, work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  const handle = await openLocalD1();
  try {
    const db = handle.db;
    await test('fresh local D1 has no product schema', async () => {
      assert.deepEqual((await db.prepare("SELECT name FROM sqlite_schema WHERE name='products'").all()).results, []);
    });
    await test('migration plan, atomic apply and second-run ledger are repeatable', async () => {
      const plan = await applyLocalMigrations(handle, { dryRun: true }); assert.equal(plan[0].action, 'PENDING');
      assert.equal(await db.prepare("SELECT name FROM sqlite_schema WHERE name='d1_migrations'").first(), null);
      assert.equal((await applyLocalMigrations(handle))[0].action, 'APPLIED');
      assert.equal((await applyLocalMigrations(handle))[0].action, 'ALREADY_APPLIED');
      assert.deepEqual((await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(row => row.name), ['0001_product_storage.sql', '0002_event_jobs.sql', '0003_affiliate_money.sql', '0004_money_snapshot_jobs.sql', '0005_money_platform.sql', '0006_deal_intelligence.sql', '0007_decision_os.sql', '0008_opportunity_experiments.sql', '0009_content_lifecycle.sql']);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first()).count, 9);
    });
    const observations = [];
    const adapter = createD1StorageAdapter(db, value => observations.push(value));
    await runDomainContract('d1', adapter, test);
    await test('all required indexes and projection triggers exist', async () => {
      const names = (await db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('index','trigger')").all()).results.map(row => row.name);
      for (const name of ['products_status_id','product_source_identity_unique','product_identity_lookup','product_identity_owner','price_history_product_time','products_insert_projections','products_update_projections']) assert.equal(names.includes(name), true, name);
    });
    await test('schema constraints reject null identity, bad status, or orphan price', async () => {
      await assert.rejects(() => db.prepare("INSERT INTO system_settings(id,updated_at,payload) VALUES(NULL,'2026-09-01T00:00:00.000Z','{}')").run());
      await assert.rejects(() => db.prepare("UPDATE products SET status='invalid' WHERE id='d1-product'").run());
      await assert.rejects(() => db.prepare("INSERT INTO price_history(id,product_id,captured_at,source_hash,operation_id,payload) VALUES('orphan','missing','2026-09-01T00:00:00.000Z','fixture','fixture','{}')").run());
    });
    await test('actual source ingestion converges; distinct and conflicting evidence remain protected', async () => {
      await withStorageAdapter(adapter, async () => {
        const a = await products.upsertSourceCandidateProduct(fixture('ingest-a'));
        const b = await products.upsertSourceCandidateProduct(fixture('ingest-a'));
        const c = await products.upsertSourceCandidateProduct({ ...fixture('ingest-b'), title: a.product.title });
        assert.equal(a.product.id, b.product.id); assert.notEqual(a.product.id, c.product.id);
        await assert.rejects(() => products.upsertSourceCandidateProduct({ ...fixture('ingest-a'), originalUrl: c.product.originalUrl }), error => error.code === 'SOURCE_CANDIDATE_MAPPING_CONFLICT');
      });
    });
    await test('source uniqueness conflicts roll back parent and every child projection', async () => {
      const p = fixture('d1-product');
      const duplicate = { ...fixture('uncommitted-parent'), sourceId: p.sourceId, originalUrl: 'https://fixture.invalid/distinct' };
      const result = await adapter.domain.createProduct(duplicate);
      assert.deepEqual(result, { status: 'CONFLICT', reason: 'IDENTITY' });
      assert.equal(await adapter.domain.getProduct(duplicate.id), null);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM product_identities WHERE product_id=?').bind(duplicate.id).first()).count, 0);
    });
    await test('offer aggregate updates replace one projection; identical replay is idempotent', async () => {
      const offer = { id: 'offer-fixture', source: 'accesstrade', merchant: 'Fixture', price: 120, affiliateUrl: 'https://fixture.invalid/link', health: 'UNKNOWN', observedAt: '2026-09-01T00:00:00.000Z', confidence: 0, primary: true };
      await withStorageAdapter(adapter, async () => {
        await products.saveCanonicalProduct('d1-product', { offers: [offer] });
        await products.saveCanonicalProduct('d1-product', { offers: [{ ...offer, price: 125 }] });
        await products.saveCanonicalProduct('d1-product', { offers: [{ ...offer, price: 125 }] });
      });
      const rows = (await db.prepare('SELECT id,price FROM product_offers WHERE product_id=?').bind('d1-product').all()).results;
      assert.deepEqual(rows, [{ id: 'offer-fixture', price: 125 }]);
    });
    await test('concurrent stale writes apply exactly one update and preserve coherent projections', async () => {
      const record = await adapter.domain.getProduct('d1-product');
      const results = await Promise.all([140, 145].map(price => adapter.domain.replaceProduct({ ...record.value, price }, record.version)));
      assert.equal(results.filter(result => result.status === 'APPLIED').length, 1);
      assert.equal(results.filter(result => result.status === 'CONFLICT').length, 1);
      assert.equal((await adapter.domain.getProduct('d1-product')).version.revision, record.version.revision + 1);
    });
    await test('bounded history returns exactly 100 of 105 and never scans global history', async () => {
      const record = (await adapter.domain.getProduct('d1-product')).value;
      for (let i = 0; i < 105; i++) await history.capturePriceSnapshot({ ...record, price: 1000 + i }, `fixture-${i}`, { capturedAt: new Date(Date.UTC(2026, 8, 4, 0, i)).toISOString() }, adapter.domain);
      const rows = await history.listPriceHistory(record.id, 100, adapter.domain);
      assert.equal(rows.length, 100); assert.equal(rows[0].price, 1005); assert.equal(rows[99].price, 1104);
      const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM price_history WHERE product_id=? ORDER BY captured_at DESC,id DESC LIMIT 100').bind(record.id).all();
      assert.equal(plan.results.some(row => String(row.detail).includes('price_history_product_time')), true);
    });
    await test('settings are persisted without secrets and reject credentials before any write', async () => {
      await adapter.settingsStore.write('scheduler', { enabled: false, intervalMinutes: 30 });
      assert.deepEqual(await adapter.settingsStore.read('scheduler'), { enabled: false, intervalMinutes: 30 });
      await assert.rejects(() => adapter.settingsStore.write('scheduler', { token: 'test-only-not-a-real-credential' }));
      await assert.rejects(() => adapter.domain.createProduct({ ...fixture('secret-reject'), secret: 'test-only-not-a-real-credential' }), error => error.code === 'D1_SECRET_FORBIDDEN');
      assert.equal(await adapter.domain.getProduct('secret-reject'), null);
      const serialized = JSON.stringify((await db.prepare('SELECT payload FROM system_settings').all()).results);
      assert.equal(serialized.includes('test-only-not-a-real-credential'), false);
    });
    await test('runtime missing binding, invalid runtime and collection methods fail closed', async () => {
      assert.equal(createStorage({ runtime: 'cloudflare', bindings: { DB: db } }).driver, 'd1');
      assert.throws(() => createStorage({ runtime: 'cloudflare' }), /CLOUDFLARE_STORAGE_BINDING_UNAVAILABLE/);
      assert.throws(() => createStorage({ runtime: 'unknown' }), error => error.code === 'SANDEAL_RUNTIME_UNSUPPORTED');
      assert.throws(() => adapter.readCollection('products'), error => error.code === 'D1_COLLECTION_OPERATION_UNSUPPORTED');
      assert.throws(() => adapter.getDataDir(), error => error.code === 'D1_COLLECTION_OPERATION_UNSUPPORTED');
    });
    await test('SQL failures surface as bounded codes without driver text or fallback', async () => {
      const faulty = createD1StorageAdapter({ prepare() { throw new Error('driver detail fixture-only'); }, async batch() { throw new Error('driver detail fixture-only'); } });
      await assert.rejects(() => faulty.domain.getProduct('fixture'), error => error.code === 'D1_OPERATION_FAILED' && error.message === 'D1_OPERATION_FAILED' && error.cause === undefined);
    });
    await test('test reset rejects missing guard and all remote/config arguments', () => {
      for (const args of [['reset-test'], ['init', '--remote'], ['migrate','--env','production']]) {
        const result = spawnSync(process.execPath, ['scripts/d1-local.cjs', ...args], { encoding: 'utf8' }); assert.equal(result.status, 1);
      }
    });
    await test('query observations report actual metadata and reads do not write', async () => {
      observations.length = 0; await adapter.domain.getProduct('d1-product');
      assert.equal(observations.length, 1); assert.equal(observations[0].rowsWritten, 0);
      assert.equal(typeof observations[0].rowsRead, 'number');
    });
    await test('legacy and D1 shadow fixture results agree on domain truth', async () => {
      const { fileStorageAdapter } = require('../src/lib/storage/fileStorageAdapter.ts');
      const savedData = process.env.SANDEAL_DATA_DIR;
      process.env.SANDEAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sandeal-d1-parity-'));
      async function scenario(storage) {
        const domain = storage.domain;
        const first = await domain.createProduct(fixture('parity-product'));
        assert.equal(first.status, 'APPLIED');
        const offer = { id: 'parity-offer', source: 'accesstrade', merchant: 'Fixture', price: 100, affiliateUrl: 'https://fixture.invalid/link', health: 'UNKNOWN', observedAt: '2026-09-01T00:00:00.000Z', confidence: 0, primary: true };
        const update = await domain.replaceProduct({ ...first.record.value, offers: [offer], status: 'approved', price: 105 }, first.record.version);
        assert.equal(update.status, 'APPLIED');
        const stale = await domain.replaceProduct({ ...first.record.value, price: 1 }, first.record.version);
        const identity = await domain.findProductIdentity({ source: 'accesstrade', sourceId: 'parity-product' });
        const snapshots = [100, 120, 105];
        for (let i = 0; i < snapshots.length; i++) await history.capturePriceSnapshot({ ...update.record.value, price: snapshots[i] }, `parity-${i}`, { capturedAt: new Date(Date.UTC(2026, 8, i + 1)).toISOString() }, domain);
        await storage.settingsStore.write('scheduler', { enabled: false, intervalMinutes: 30 });
        const product = (await domain.getProduct('parity-product')).value;
        return { product: { id: product.id, title: product.title, price: product.price, status: product.status, offers: product.offers, revision: product.storageRevision },
          identity: identity.map(row => row.value.id), stale: stale.status, setting: await storage.settingsStore.read('scheduler'),
          history: (await domain.getPriceHistory({ productId: product.id, limit: 2 })).map(row => ({ price: row.price, capturedAt: row.capturedAt })) };
      }
      try { assert.deepEqual(await scenario(adapter), await scenario(fileStorageAdapter)); }
      finally { if (savedData === undefined) delete process.env.SANDEAL_DATA_DIR; else process.env.SANDEAL_DATA_DIR = savedData; }
    });
  } finally { await handle.dispose(); }
}
main().catch(error => { failed++; console.error('FAIL setup', error); }).finally(() => {
  console.log(`V6 local D1: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
});
